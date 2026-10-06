import { describe, expect, it } from 'vitest';
import { PetriNet, PrecompiledNet, Transition, all, and, delayed, one, outPlace, place, xor, type In, type Out, type Place } from 'libpetri';
import { compile, ladderLevel } from '../../src/compiler/index.js';
import type { CompensationSite, CompiledWorkflow, EntryDescription, StepDescription, WorkflowDescription } from '../../src/compiler/types.js';
import type { CompileOptions } from '../../src/compiler/compile.js';
import {
  FAMILIES,
  compensateStructureViolations,
  compensatorAttempts,
  describeClaim,
  segmentInitialMarking,
  segmentLabel,
  suspensionCoverageViolations,
  verify,
  type VerificationReport,
} from '../../src/verify/index.js';
import { completionProperties, restartSegment, segmentsFor, verifyWorkflow } from '../../src/verify/properties.js';

/**
 * The compensation ladder's claims ([ADR 0017], amended by the W0 spike), M7b W1 claims.
 *
 * Three halves. **The arc rules** (`compensateStructureViolations`, S1–S8): empty on every compiled
 * shape — m = 1, 2, 3, beside a `foreach(2)` and a `parallel(3)`, retrying, timed, under a run budget
 * and a `limit` used only by a compensator, with a checkpoint before `k_1` — and hand-edited mutants:
 * one per rule, each run through `verify(…, { structure: 'skip' })` too with what the behavioural
 * claims make of it asserted (MUT5, S5, S6, S6t and the retry that skips arming pass every one:
 * structure is their only guard), and one per clause, each asserting its exact line — every clause
 * deletion in `compensate.ts` but the two equivalent ones it names is killed by one.
 * With them the suspension-coverage exemption (`compensatorAttempts`): exactly the compensators'
 * attempts, and not vacuous. **The seed**: `initialCounts` adds `ladderLevel`'s place, one token, in
 * every default segment, and `segmentInitialMarking` refuses a segment where it does not; C1 refuses a
 * site whose levels it cannot count. **The claims**: `verify()` on m1, m2, m3 and m2 beside
 * `foreach(2)`, every family in every default segment, C1 (`rolledBack`) in the completion set, C2–C4
 * as exclusions, each counted, the state classes and the slowest query recorded.
 *
 * Proof environment: libpetri 8.0.0 from the registry (not linked; `scripts/link-libpetri.sh --check`:
 * "not linked"), z3 4.13.0, environment mode none (one closed net, the arrival modelled by
 * `t.cancel.arrive`). Segments: `verify`'s defaults — `closed`, `cancel`, `resume@s[+cancel]` per
 * site, `restart@p[+cancel]` per top-level boundary — each seeded with `level.a`. 30 s a query.
 *
 * Proofs are judged by verdict string, never by `isViolated()` — `unknown` fails.
 */

const BUDGET_MS = 30_000;

const step = (id: string, extra: Omit<StepDescription, 'kind' | 'id'> = {}): StepDescription => ({ kind: 'step', id, ...extra });
/** A compensated step `id`, undone by `undo-<id>`. */
const comp = (id: string, extra: Omit<StepDescription, 'kind' | 'id'> = {}, undo: Omit<StepDescription, 'kind' | 'id'> = {}): StepDescription =>
  step(id, { ...extra, compensate: step(`undo-${id}`, undo) });
const each2: EntryDescription = { kind: 'foreach', id: 'items', body: step('item'), concurrency: 2 };

const M1: WorkflowDescription = { id: 'm1', entries: [comp('a'), step('x'), step('z')] };
const M2: WorkflowDescription = { id: 'm2', entries: [comp('a'), step('x'), comp('b'), step('z')] };
const M3: WorkflowDescription = { id: 'm3', entries: [comp('a'), step('x'), comp('b'), step('y'), comp('c'), step('z')] };
const M2F: WorkflowDescription = { id: 'm2f', entries: [comp('a'), each2, comp('b'), step('z')] };

const siteOf = (compiled: CompiledWorkflow): CompensationSite => {
  const site = compiled.compensations;
  if (site === undefined) throw new Error(`'${compiled.net.name}' has no ladder`);
  return site;
};

// --- hand edits ----------------------------------------------------------------------------------

interface Rebuild {
  readonly inputs?: readonly In[];
  readonly output?: Out | null;
  readonly reads?: readonly Place<unknown>[];
  readonly resets?: readonly Place<unknown>[];
  readonly inhibitors?: readonly Place<unknown>[];
}

/** A copy of `t` with some arcs replaced; action, timing and priority kept. */
function rebuild(t: Transition, change: Rebuild): Transition {
  const b = Transition.builder(t.name).inputs(...(change.inputs ?? t.inputSpecs)).timing(t.timing).priority(t.priority).action(t.action);
  const output = change.output === undefined ? t.outputSpec : change.output;
  if (output !== null) b.outputs(output);
  for (const p of change.inhibitors ?? t.inhibitors.map((a) => a.place)) b.inhibitor(p);
  for (const p of change.resets ?? t.resets.map((a) => a.place)) b.reset(p);
  for (const p of change.reads ?? t.reads.map((a) => a.place)) b.read(p);
  return b.build();
}

/** `out` with every leaf on place `from` moved to place `to`. */
function retarget(out: Out, from: string, to: Place<unknown>): Out {
  switch (out.type) {
    case 'place': return out.place.name === from ? outPlace(to) : out;
    case 'and': return { type: 'and', children: out.children.map((c) => retarget(c, from, to)) };
    case 'xor': return { type: 'xor', children: out.children.map((c) => retarget(c, from, to)) };
    case 'timeout': return { ...out, child: retarget(out.child, from, to) };
    case 'forward-input': return out.to.name === from ? { ...out, to } : out;
  }
}

/**
 * The compiled workflow with transitions replaced by name (null drops one), others and places added,
 * and the site edited. The program is recompiled, so a witness runs the mutant.
 */
function edited(
  compiled: CompiledWorkflow,
  replace: Record<string, (t: Transition) => Transition | null>,
  {
    add = [],
    places = [],
    site = (s) => s,
    mapped = {},
  }: {
    add?: readonly Transition[];
    places?: readonly Place<unknown>[];
    site?: (s: CompensationSite) => CompensationSite;
    /** Added transitions to put in the net map, at an entry path. */
    mapped?: Readonly<Record<string, { readonly path: readonly number[]; readonly id: string }>>;
  } = {},
): CompiledWorkflow {
  const seen = new Set<string>();
  const transitions = [...compiled.net.transitions].flatMap((t) => {
    const change = replace[t.name];
    if (change === undefined) return [t];
    seen.add(t.name);
    const r = change(t);
    return r === null ? [] : [r];
  });
  const missing = Object.keys(replace).filter((name) => !seen.has(name));
  if (missing.length > 0) throw new Error(`the edit names no transition ${missing.join(', ')}`);
  const net = PetriNet.builder(compiled.net.name).places(...compiled.net.places, ...places).transitions(...transitions, ...add).build();
  const transitionToEntry = new Map([...compiled.netMap.transitionToEntry, ...Object.entries(mapped)]);
  return { ...compiled, net, program: PrecompiledNet.compile(net), netMap: { ...compiled.netMap, transitionToEntry }, compensations: site(siteOf(compiled)) };
}

const placeOf = (compiled: CompiledWorkflow, name: string): Place<unknown> => {
  const p = [...compiled.net.places].find((x) => x.name === name);
  if (p === undefined) throw new Error(`no place '${name}'`);
  return p;
};
const outs = (compiled: CompiledWorkflow, ...names: string[]): Out => {
  const leaves = names.map((n) => outPlace(placeOf(compiled, n)));
  return leaves.length === 1 ? leaves[0]! : and(...leaves);
};
/** Every transition the net map puts at top-level path `i`. */
const transitionsAt = (compiled: CompiledWorkflow, i: number): string[] =>
  [...compiled.net.transitions].filter((t) => compiled.netMap.transitionToEntry.get(t.name)?.path[0] === i).map((t) => t.name);
/** A replace map retargeting `from` to `to` in the outputs of every transition named. */
const retargeting = (compiled: CompiledWorkflow, names: readonly string[], from: string, to: string): Record<string, (t: Transition) => Transition> =>
  Object.fromEntries(
    [...compiled.net.transitions]
      .filter((t) => names.includes(t.name) && [...t.outputPlaces()].some((p) => p.name === from))
      .map((t) => [t.name, (u: Transition) => rebuild(u, { output: retarget(u.outputSpec!, from, placeOf(compiled, to)) })]),
  );
/** The same lines, in any order. */
const sorted = (lines: readonly string[]): string[] => [...lines].sort();

/** What the behavioural claims make of a mutant: every failing property, with its segments. */
async function behaviour(compiled: CompiledWorkflow): Promise<{ readonly holds: boolean; readonly failing: ReadonlySet<string> }> {
  const report = await verify(compiled, { structure: 'skip' });
  for (const c of report.claims) expect(c.result.verdict.type, describeClaim(c)).not.toBe('unknown');
  return { holds: report.holds, failing: new Set(report.claims.filter((c) => !c.holds).map((c) => c.property)) };
}

// --------------------------------------------------------------------------------------------------
// The arc rules
// --------------------------------------------------------------------------------------------------

describe('compensateStructureViolations: every compiled shape is sound', () => {
  const shapes: readonly (readonly [string, WorkflowDescription, CompileOptions?])[] = [
    ['m1 [a*,x,z]', M1],
    ['m2 [a*,x,b*,z]', M2],
    ['m3 [a*,x,b*,y,c*,z]', M3],
    ['m2 adjacent [a*,b*,c]', { id: 'adj', entries: [comp('a'), comp('b'), step('c')] }],
    ['m2 beside foreach(2) [a*,each(2),b*,z]', M2F],
    ['m2 beside parallel(3) [a*,par(3),c*,d]', { id: 'par', entries: [comp('a'), { kind: 'parallel', id: 'p', arms: [step('b1'), step('b2'), step('b3')] }, comp('c'), step('d')] }],
    ['m2, retries 2 on everything', { id: 'm2r', entries: [comp('a', { retries: 2 }, { retries: 2 }), step('x', { retries: 2 }), comp('b', {}, { retries: 2 }), step('z')] }],
    ['m2, timed: retry delay 5 ms on x and undo-b', { id: 'm2t', entries: [comp('a'), step('x', { retries: 1, retryDelayMs: 5 }), comp('b', {}, { retries: 1, retryDelayMs: 5 }), step('z')] }],
    ['m2, timeoutMs 50 on b and undo-a', { id: 'm2o', entries: [comp('a', {}, { timeoutMs: 50 }), step('x'), comp('b', { timeoutMs: 50 }), step('z')] }],
    ['m2, run budget 1', M2, { concurrency: 1 }],
    ['m2, a limit(1) used only by undo-b', { id: 'm2q', entries: [comp('a'), step('x'), comp('b', {}, { quotas: [{ id: 'q', kind: 'limit', n: 1 }] }), step('z')] }],
    ['m2, checkpoint at 0 before k_1 [w,a*,x,b*,z]', { id: 'm2c', checkpoints: [0], entries: [step('w'), comp('a'), step('x'), comp('b'), step('z')] }],
  ];
  // Breaks if: any rule misreads the compiled ladder — a pool place, a retry hop, a timeout funnel or
  // a checkpoint read as an escape, a foreach or parallel sweep read as un-intercepted, a level's
  // producer or consumer left out, or the seed fixpoint missing a segment's start.
  it.each(shapes.map(([name, description, options]) => ({ name, description, options })))('$name', ({ description, options }) => {
    const compiled = compile(description, options);
    siteOf(compiled);
    expect(compensateStructureViolations(compiled)).toEqual([]);
    expect(suspensionCoverageViolations(compiled)).toEqual([]);
  });

  // Breaks if: the check throws or reports on a net with no ladder, or misses ladder vocabulary there.
  it('is empty on a net with no ladder, and S0 names ladder vocabulary without a site', () => {
    const plain = compile({ id: 'w', entries: [step('a'), step('b')] });
    expect(plain.compensations).toBeUndefined();
    expect(compensateStructureViolations(plain)).toEqual([]);
    expect(compensatorAttempts(plain).size).toBe(0);
    const m2 = compile(M2);
    const stripped: CompiledWorkflow = { ...m2 };
    delete (stripped as { compensations?: CompensationSite }).compensations;
    const lines = compensateStructureViolations(stripped);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^S0: \[.*t\.comp\.raise.*wf\.comp\.fault.*\] in a net with no compensation site$/);
  });
});

describe('compensatorAttempts: the coverage exemption', () => {
  // Breaks if: the exemption takes anything but the compensators' attempts (a forward step's would
  // hide a real coverage hole), misses a retry, or is vacuous.
  it('is exactly every compensator attempt, retries included, and nothing forward', () => {
    const compiled = compile({ id: 'm2r', entries: [comp('a', { retries: 1 }, { retries: 2 }), step('x'), comp('b'), step('z')] });
    const site = siteOf(compiled);
    const chains = compiled.steps.filter((s) => s.stepId.startsWith('undo-'));
    expect(chains.map((s) => s.stepId)).toEqual(['undo-a', 'undo-b']);
    expect(chains[0]!.attempts).toHaveLength(3);
    expect([...compensatorAttempts(compiled)].sort()).toEqual(chains.flatMap((s) => s.attempts).sort());
    expect(site.compensators.map((c) => c.attempts)).toEqual(chains.map((s) => s.attempts));
  });

  // Breaks if: the exemption is not load-bearing — without it the compensators' suspended exits,
  // which no resume site covers, are reported by suspension coverage.
  it('is not vacuous: without the site, suspension coverage reports every compensator attempt', () => {
    const compiled = compile(M2);
    const stripped: CompiledWorkflow = { ...compiled };
    delete (stripped as { compensations?: CompensationSite }).compensations;
    const reported = suspensionCoverageViolations(stripped).join('\n');
    for (const a of compensatorAttempts(compiled)) expect(reported).toContain(a);
    expect(suspensionCoverageViolations(compiled)).toEqual([]);
  });

  // Breaks if: an attempt the net map does not know is exempted.
  it('never exempts an attempt with no net-map entry', () => {
    const compiled = compile(M2);
    const ghost = edited(compiled, {}, { site: (s) => ({ ...s, compensators: s.compensators.map((c, x) => (x === 0 ? { ...c, attempts: [...c.attempts, 't.ghost'] } : c)) }) });
    expect(compensatorAttempts(ghost).has('t.ghost')).toBe(false);
  });
});

describe('compensateStructureViolations: one mutant per rule', () => {
  const m2 = compile(M2);
  const site = siteOf(m2);
  const [u1, u2] = site.compensators as [CompensationSite['compensators'][number], CompensationSite['compensators'][number]];
  const L = site.levels;

  // S1 (MUT6). Breaks if: arm's inputs are not compared exactly — arm_2 without level.1 duplicates
  // the token, and the rollback can finish while level.1 is still armed.
  it('S1 (MUT6): arm_2 skips the lower level', async () => {
    const mutant = edited(m2, { [u2.arm]: (t) => rebuild(t, { inputs: [one(placeOf(m2, u2.arming))] }) });
    expect(compensateStructureViolations(mutant)).toEqual([
      `S1: '${u2.arm}' takes [${u2.arming}]; it takes exactly one each of [${u2.arming}, ${L[1]}]`,
    ]);
    const b = await behaviour(mutant);
    expect(b.holds).toBe(false);
    for (const p of ['deadlockFree', 'rolledBack', `exclusive(${L[1]},wf.settle.failed)`]) expect(b.failing.has(p), p).toBe(true);
  });

  // S1, arming. Breaks if: arming_j's producer is not held to entry k_j — k_1's success bypassing
  // the arming leaves level.0 armed with nothing.
  it("S1: k_1's success bypasses arming", async () => {
    const successor = m2.entries[u1.k]!.next;
    const bypass = retargeting(m2, transitionsAt(m2, u1.k), u1.arming, successor);
    const mutant = edited(m2, bypass);
    expect(compensateStructureViolations(mutant)).toEqual([
      `S1: '${u1.arming}' has no producer; entry ${u1.k}'s success arms level 1`,
      `S1: '${successor}' is produced by [${[...Object.keys(bypass), u1.arm].sort().join(', ')}]; only by '${u1.arm}' — entry ${u1.k} reaches its successor only through arming`,
      `S8: ladder place '${u1.arming}' has no producer`,
      `S8: ladder transition '${u1.arm}' is dead from the arcs: [${u1.arming}] never marked`,
    ]);
    const b = await behaviour(mutant);
    for (const p of ['deadlockFree', 'terminatesAtSink', 'exactlyOneTerminal']) expect(b.failing.has(p), p).toBe(true);
  });

  // S1 + S3 (MUT5). Breaks if: a settle's level is not held to the one directly below — the last
  // compensator settling back to its own level runs again, forever, and no behavioural claim sees it.
  it('S1 + S3 (MUT5): the last settle returns to its own level; every behavioural claim holds', async () => {
    const mutant = edited(
      m2,
      Object.fromEntries(Object.values(u2.settles).map((name) => [name, (t: Transition) => rebuild(t, { output: outs(m2, L[2]!, site.pending) })])),
    );
    expect(sorted(compensateStructureViolations(mutant))).toEqual(sorted([
      ...Object.values(u2.settles).map((s) => `S1: '${s}' produces '${L[2]}'; only arm_2 and settle_3.* do`),
      ...Object.values(u2.settles).map((s) => `S3: '${s}' gives [${L[2]} + ${site.pending}]; it gives exactly [${L[1]}, ${site.pending}] on every firing`),
    ]));
    expect((await behaviour(mutant)).holds).toBe(true);
  });

  // S2. Breaks if: a top-level entry's outputs are not held to the ladder — the last entry's failure
  // straight to the failed settle skips every compensator.
  it("S2: the last entry's failure goes straight to wf.settle.failed", async () => {
    const z = m2.entries.length - 1;
    const mutant = edited(m2, retargeting(m2, transitionsAt(m2, z), site.failure, 'wf.settle.failed'));
    const lines = compensateStructureViolations(mutant);
    expect(lines.every((l) => l.startsWith('S2: ') || l.startsWith('S4: '))).toBe(true);
    expect(lines.filter((l) => l.startsWith('S2: '))).not.toEqual([]);
    expect(lines.filter((l) => l.startsWith('S4: '))).toHaveLength(1);
    const b = await behaviour(mutant);
    for (const p of ['deadlockFree', 'rolledBack', `exclusive(${L[2]},wf.settle.failed)`]) expect(b.failing.has(p), p).toBe(true);
  });

  // S2 (MUT8). Breaks if: raise is not the only consumer of the failure place.
  it('S2 + S4 (MUT8): a failure bypasses raise', async () => {
    const bypass = Transition.builder('t.comp.bypass')
      .inputs(one(placeOf(m2, site.failure)))
      .outputs(outs(m2, 'wf.settle.failed'))
      .action(async () => {})
      .build();
    const mutant = edited(m2, {}, { add: [bypass] });
    expect(compensateStructureViolations(mutant)).toEqual([
      `S2: '${site.failure}' is consumed by [t.comp.bypass, ${site.raise}]; only by '${site.raise}'`,
      `S4: 'wf.settle.failed' is produced by [t.comp.bypass, ${site.finish}]; only by '${site.finish}'`,
    ]);
    const b = await behaviour(mutant);
    for (const p of ['deadlockFree', 'rolledBack', `exclusive(${L[1]},wf.settle.failed)`]) expect(b.failing.has(p), p).toBe(true);
  });

  // S3. Breaks if: start's inputs are not compared exactly — start_2 without pending could begin a
  // second compensator beside a running one.
  it('S3: start_2 does not take pending', () => {
    const mutant = edited(m2, { [u2.start]: (t) => rebuild(t, { inputs: [one(placeOf(m2, L[2]!))] }) });
    expect(compensateStructureViolations(mutant)).toEqual([
      `S3: '${u2.start}' takes [${L[2]}]; it takes exactly one each of [${L[2]}, ${site.pending}]`,
    ]);
  });

  // S3, every firing. Breaks if: a settle's output is compared as a place set only — an xor that
  // gives the level or `pending`, not both, has the same places and loses one of the two tokens.
  it('S3: settle_1.failed gives level.0 or pending, not both', () => {
    const name = u1.settles.failed;
    const mutant = edited(m2, { [name]: (t) => rebuild(t, { output: xor(outPlace(placeOf(m2, L[0]!)), outPlace(placeOf(m2, site.pending))) }) });
    expect(compensateStructureViolations(mutant)).toEqual([
      `S3: '${name}' gives [xor(${L[0]} | ${site.pending})]; it gives exactly [${L[0]}, ${site.pending}] on every firing`,
    ]);
  });

  // S2, immediacy. Breaks if: a ladder transition's timing goes unchecked — a delayed raise holds the
  // rollback back by a clock no claim names, and moves the whole net to SMT.
  it('S2: a delayed raise', () => {
    const mutant = edited(m2, { [site.raise]: (t) => Transition.builder(t.name).inputs(...t.inputSpecs).outputs(t.outputSpec!).timing(delayed(5)).action(t.action).build() });
    expect(compensateStructureViolations(mutant)).toEqual([`S2: '${site.raise}' is delayed; it is immediate`]);
  });

  // S4 (MUT7). Breaks if: finish's inputs are not compared exactly — without level.0 the failed run
  // settles while compensated steps are still armed.
  it('S4 (MUT7): finish without level.0', async () => {
    const mutant = edited(m2, { [site.finish]: (t) => rebuild(t, { inputs: [one(placeOf(m2, site.pending)), one(placeOf(m2, site.fault))] }) });
    expect(compensateStructureViolations(mutant)).toEqual([
      `S4: '${site.finish}' takes [${site.pending}, ${site.fault}]; it takes exactly one each of [${site.fault}, ${L[0]}, ${site.pending}]`,
    ]);
    const b = await behaviour(mutant);
    for (const p of ['deadlockFree', 'rolledBack', `exclusive(${L[1]},wf.settle.failed)`]) expect(b.failing.has(p), p).toBe(true);
  });

  // S5. Breaks if: a compensator's arcs on wf.cancel go unchecked — a gated compensator, swept on a
  // cancel, skips its undo, and every behavioural claim still holds: the sweep settles it unresolved
  // and the rollback goes on.
  it('S5: a compensator emitted with the signal (gated, swept); every behavioural claim holds', async () => {
    const attempt = u1.attempts[0]!;
    const sweep = Transition.builder(`t.${u1.path[0]}.${u1.stepId}.cancel`)
      .inputs(one(placeOf(m2, u1.inPlace)))
      .read(m2.cancel)
      .outputs(outs(m2, u1.exits.failed))
      .action(async () => {})
      .build();
    const mutant = edited(
      m2,
      { [attempt]: (t) => rebuild(t, { inhibitors: [...t.inhibitors.map((a) => a.place), m2.cancel] }) },
      { add: [sweep], mapped: { [sweep.name]: { path: u1.path, id: u1.stepId } } },
    );
    expect(compensateStructureViolations(mutant)).toEqual([
      `S5: '${attempt}' has an arc on 'wf.cancel'; no transition of u_1 does`,
      `S5: '${attempt}' reads or is inhibited by 'wf.cancel' and consumes '${u1.inPlace}'; no cancel-gated transition takes a ladder or compensator place`,
      `S5: '${sweep.name}' has an arc on 'wf.cancel'; no transition of u_1 does`,
      `S5: '${sweep.name}' reads or is inhibited by 'wf.cancel' and consumes '${u1.inPlace}'; no cancel-gated transition takes a ladder or compensator place`,
    ]);
    expect((await behaviour(mutant)).holds).toBe(true);
  });

  // S6. Breaks if: a discharge's target is not checked — a bail settling as done, and every
  // behavioural claim still holds (exactly one terminal, only the wrong one).
  it('S6: discharge_1.bailed lands in wf.settle.done; every behavioural claim holds', async () => {
    const d = site.discharges[1]!.bailed;
    const mutant = edited(m2, { [d]: (t) => rebuild(t, { output: outs(m2, 'wf.settle.done') }) });
    const row = (kind: 'done' | 'bailed'): string[] => site.discharges.map((r) => r[kind]);
    expect(compensateStructureViolations(mutant)).toEqual([
      `S6: 'wf.settle.done' is produced by [${[...row('done'), d].sort().join(', ')}]; only by its discharges [${row('done').sort().join(', ')}]`,
      `S6: 'wf.settle.bailed' is produced by [${row('bailed').filter((x) => x !== d).sort().join(', ')}]; only by its discharges [${row('bailed').sort().join(', ')}]`,
      `S6: '${d}' gives [wf.settle.done]; it gives exactly [wf.settle.bailed] on every firing`,
    ]);
    expect((await behaviour(mutant)).holds).toBe(true);
  });

  // S6 (S6t). Breaks if: ladder arcs on a terminal go unchecked — the design round's consume-and-
  // reproduce release, which every behavioural claim accepts.
  it('S6 (S6t): a terminal release consuming and reproducing wf.canceled; every behavioural claim holds', async () => {
    const canceled = m2.terminals.canceled as Place<unknown>;
    const release = Transition.builder('t.comp.0.release.canceled')
      .inputs(one(placeOf(m2, L[0]!)), one(canceled))
      .outputs(outPlace(canceled))
      .action(async () => {})
      .build();
    const mutant = edited(m2, {}, { add: [release] });
    expect(compensateStructureViolations(mutant)).toEqual([
      `S1: 't.comp.0.release.canceled' consumes '${L[0]}'; only arm_1, finish, and level 0's discharges do`,
      "S6: 't.comp.0.release.canceled' takes, reads, inhibits or resets terminal 'wf.canceled'; nothing in the ladder does",
      "S6: 't.comp.0.release.canceled' gives terminal 'wf.canceled'; only the canceled discharges give one, 'wf.canceled'",
      "S6: 't.comp.0.release.canceled' gives 'wf.canceled'; only the settle stage's cancel-settles and the canceled discharges do — every sweep feeds 'wf.comp.exit.canceled'",
    ]);
    expect((await behaviour(mutant)).holds).toBe(true);
  });

  // S6, interception. Breaks if: wf.canceled's producers go unchecked — a foreach sweep feeding
  // wf.canceled directly strands the level token beside the terminal.
  it("S2 + S6: the foreach's cancel sweeps bypass wf.comp.exit.canceled", () => {
    const m2f = compile(M2F);
    const exitCanceled = siteOf(m2f).exits.canceled;
    const swept = transitionsAt(m2f, 1).filter((name) => [...[...m2f.net.transitions].find((t) => t.name === name)!.outputPlaces()].some((p) => p.name === exitCanceled));
    expect(swept.length).toBeGreaterThan(0);
    const mutant = edited(m2f, retargeting(m2f, swept, exitCanceled, 'wf.canceled'));
    expect(sorted(compensateStructureViolations(mutant))).toEqual(sorted([
      ...swept.map((t) => `S2: '${t}' (entry 1) gives 'wf.canceled'; a top-level entry gives only into its interior, its next, its arming, the ladder's exits or pools`),
      ...swept.map((t) => `S6: '${t}' gives 'wf.canceled'; only the settle stage's cancel-settles and the canceled discharges do — every sweep feeds 'wf.comp.exit.canceled'`),
    ]));
  });

  // S7. Breaks if: a compensator's outputs are not held to its own exits — its suspension escaping
  // to the ladder's top-level suspended exit is exempt from coverage and reaches a terminal unsettled.
  it("S7: a compensator attempt's suspended branch escapes to wf.comp.exit.suspended", async () => {
    const mutant = edited(m2, retargeting(m2, u2.attempts, u2.exits.suspended, site.exits.suspended));
    expect(compensateStructureViolations(mutant)).toEqual([
      ...u2.attempts.map((a) => `S7: '${a}' (u_2) gives '${site.exits.suspended}'; a compensator leaves only by its own exits`),
      `S8: ladder place '${u2.exits.suspended}' has no producer`,
      `S8: ladder transition '${u2.settles.suspended}' is dead from the arcs: [${u2.exits.suspended}] never marked`,
    ]);
    const b = await behaviour(mutant);
    for (const p of ['deadlockFree', 'terminatesAtSink', 'exactlyOneTerminal']) expect(b.failing.has(p), p).toBe(true);
  });

  // S7, the declared chain. Breaks if: the site's attempts are not compared with the registered
  // chain — a retry left out of the site is a forward-looking attempt no rule exempts or checks.
  it("S7: the site leaves a compensator's retry out", () => {
    const m2r = compile({ id: 'm2r', entries: [comp('a'), step('x'), comp('b', {}, { retries: 1 }), step('z')] });
    const v2 = siteOf(m2r).compensators[1]!;
    const short = v2.attempts.slice(0, 1);
    const mutant = edited(m2r, {}, { site: (s) => ({ ...s, compensators: s.compensators.map((c) => (c.j === 2 ? { ...c, attempts: short } : c)) }) });
    expect(compensateStructureViolations(mutant)).toEqual([
      `S7: u_2's attempts [${short.join(', ')}] are not the registered chain of 'undo-b' at '${v2.inPlace}' ([${[...v2.attempts].sort().join(', ')}] of 'undo-b' at ${v2.path.join('-')})`,
    ]);
  });

  // S8. Breaks if: a dead ladder transition passes silently — the W0 six-kind ladder's
  // settle_1.canceled, whose exit no compensator leaf without the signal ever produces.
  it('S8: the six-kind ladder (settle_1.canceled)', () => {
    const exit = place<unknown>('wf.comp.1.canceled');
    const settle = Transition.builder('t.comp.1.settle.canceled')
      .inputs(one(exit), one(placeOf(m2, u1.undoing)))
      .outputs(outs(m2, L[0]!, site.pending))
      .action(async () => {})
      .build();
    const mutant = edited(m2, {}, {
      add: [settle],
      places: [exit],
      site: (s) => ({
        ...s,
        compensators: s.compensators.map((c) =>
          c.j === 1 ? { ...c, exits: { ...c.exits, canceled: exit.name }, settles: { ...c.settles, canceled: settle.name } } : c,
        ),
      }),
    });
    expect(compensateStructureViolations(mutant)).toEqual([
      "S8: ladder place 'wf.comp.1.canceled' has no producer",
      "S8: ladder transition 't.comp.1.settle.canceled' is dead from the arcs: [wf.comp.1.canceled] never marked",
    ]);
  });

  // Breaks if: verify() runs proofs on a mutant the ladder rules refuse.
  it('verifyWorkflow refuses a mutant before any proof, naming "compensate structure"', async () => {
    const mutant = edited(m2, { [site.finish]: (t) => rebuild(t, { inputs: [one(placeOf(m2, site.pending)), one(placeOf(m2, site.fault))] }) });
    await expect(verifyWorkflow(mutant, { segments: [] })).rejects.toThrow(/^compensate structure is unsound:\n {2}S4: /);
  });
});

/**
 * A stray transition `name` taking one token from each of `takes` (or a fresh `x.<name>.in`), giving
 * `gives` (or a fresh `x.<name>.out`), reading `wf.cancel` when `cancel` is set — with any fresh
 * places. Unmapped unless `edited`'s `mapped` puts it at a path.
 */
function leak(compiled: CompiledWorkflow, name: string, { takes = [], gives = [], cancel = false }: { takes?: readonly string[]; gives?: readonly string[]; cancel?: boolean } = {}) {
  const source = place<unknown>(`x.${name}.in`);
  const sink = place<unknown>(`x.${name}.out`);
  const b = Transition.builder(name)
    .inputs(...(takes.length > 0 ? takes.map((n) => one(placeOf(compiled, n))) : [one(source)]))
    .outputs(gives.length > 0 ? outs(compiled, ...gives) : outPlace(sink))
    .action(async () => {});
  if (cancel) b.read(compiled.cancel);
  return { add: [b.build()], places: [...(takes.length > 0 ? [] : [source]), ...(gives.length > 0 ? [] : [sink])] };
}

type Rung = CompensationSite['compensators'][number];
/** The site with rung `j` changed. */
const rung = (j: number, change: (c: Rung) => Rung) => (s: CompensationSite): CompensationSite => ({ ...s, compensators: s.compensators.map((c) => (c.j === j ? change(c) : c)) });
/** `r` without the key `kind`. */
const without = <T extends Readonly<Record<string, string>>>(r: T, kind: string): T => Object.fromEntries(Object.entries(r).filter(([k]) => k !== kind)) as T;

describe('compensateStructureViolations: one mutant per clause', () => {
  const m2 = compile(M2);
  const site = siteOf(m2);
  const u1 = site.compensators[0]!;

  // S1, successor (the W1 review's partial bypass). Breaks if: successor(k_j)'s producers are not
  // held to arm_j — one retry of a compensated step giving its successor directly, while its first
  // attempt still arms. Every behavioural claim holds: level.0 is never armed (C1, C2 hold) and
  // undo-a stays live through the first attempt, so a run whose step succeeds on its retry fails
  // later without its compensator, and only this clause sees it.
  it('S1: one retry of the compensated step skips arming; every behavioural claim holds', async () => {
    const m1r = compile({ id: 'm1r', entries: [comp('a', { retries: 1 }), step('x'), step('z')] });
    const v1 = siteOf(m1r).compensators[0]!;
    const retry = m1r.steps.find((s) => s.stepId === 'a')!.attempts[1]!;
    const successor = m1r.entries[v1.k]!.next;
    const mutant = edited(m1r, retargeting(m1r, [retry], v1.arming, successor));
    expect(compensateStructureViolations(mutant)).toEqual([
      `S1: '${successor}' is produced by [${retry}, ${v1.arm}]; only by '${v1.arm}' — entry ${v1.k} reaches its successor only through arming`,
    ]);
    expect((await behaviour(mutant)).holds).toBe(true);
  });

  // S1, the site's shape. Breaks if: a site with a discharge row missing is read as complete.
  it('S1: a site with a discharge row missing', () => {
    const mutant = edited(m2, {}, { site: (s) => ({ ...s, discharges: s.discharges.slice(0, site.m) }) });
    expect(compensateStructureViolations(mutant)).toContain(
      `S1: the site has m = 2, 3 levels, 2 rungs and 2 discharge rows; it has m ≥ 1, m + 1 levels, m rungs and m + 1 rows`,
    );
  });

  // S1, the rung numbers. Breaks if: a rung's j is not checked against its position.
  it('S1: rung 2 says j = 3', () => {
    const mutant = edited(m2, {}, { site: rung(2, (c) => ({ ...c, j: 3 })) });
    expect(compensateStructureViolations(mutant)).toContain('S1: rung 2 says j = 3');
  });

  // S1, k before the last entry. Breaks if: the last entry may be compensated — its success is the
  // run's, with no successor to arm into.
  it('S1: u_1 compensating the last entry', () => {
    const m1 = compile(M1);
    const mutant = edited(m1, {}, { site: rung(1, (c) => ({ ...c, k: m1.entries.length - 1 })) });
    expect(compensateStructureViolations(mutant)).toContain(`S1: u_1 compensates entry 2; the k_j ascend strictly, each a top-level index before the last (2)`);
  });

  // S1, strict ascent. Breaks if: two rungs may compensate the same entry.
  it('S1: u_2 compensating the same entry as u_1', () => {
    const mutant = edited(m2, {}, { site: rung(2, (c) => ({ ...c, k: u1.k })) });
    expect(compensateStructureViolations(mutant)).toContain(`S1: u_2 compensates entry ${u1.k}; the k_j ascend strictly, each a top-level index before the last (3)`);
  });

  // S1, arming's consumer. Breaks if: something but arm_j may take the arming token.
  it('S1: a second consumer of arming', () => {
    const mutant = edited(m2, {}, leak(m2, 't.leak', { takes: [u1.arming] }));
    expect(compensateStructureViolations(mutant)).toEqual([`S1: '${u1.arming}' is consumed by [${u1.arm}, t.leak]; only by '${u1.arm}'`]);
  });

  // S2, the failure's producers. Breaks if: an unmapped transition may raise a failure.
  it('S2: an unmapped producer of the failure place', () => {
    const mutant = edited(m2, {}, leak(m2, 't.leak', { gives: [site.failure] }));
    expect(compensateStructureViolations(mutant)).toEqual([`S2: 't.leak' produces '${site.failure}' and is not a top-level entry's`]);
  });

  // S1, S2, S3: a ladder-named transition the net map puts at an entry's or a compensator's path is
  // still not that entry's. Breaks if: `ladderTransitions` is dropped from the arming, failure or
  // compensator-exit producer checks.
  it('S1 + S2 + S3: a ladder-named transition at an entry path is not the entry', () => {
    const atK = leak(m2, 't.comp.leak.0', { gives: [u1.arming, site.failure] });
    const atU = leak(m2, 't.comp.leak.1', { gives: [u1.exits.failed] });
    const mutant = edited(m2, {}, {
      add: [...atK.add, ...atU.add],
      places: [...atK.places, ...atU.places],
      mapped: { 't.comp.leak.0': { path: [u1.k], id: 'a' }, 't.comp.leak.1': { path: u1.path, id: u1.stepId } },
    });
    expect(compensateStructureViolations(mutant)).toEqual([
      `S1: 't.comp.leak.0' produces '${u1.arming}'; only entry ${u1.k}'s transitions do`,
      `S2: 't.comp.leak.0' produces '${site.failure}' and is not a top-level entry's`,
      `S3: 't.comp.leak.1' produces '${u1.exits.failed}' and is not u_1's`,
      "S8: ladder transition 't.comp.leak.0' is dead from the arcs: [x.t.comp.leak.0.in] never marked",
      "S8: ladder transition 't.comp.leak.1' is dead from the arcs: [x.t.comp.leak.1.in] never marked",
    ]);
  });

  // S2, done only for the last entry. Breaks if: a mid entry may settle the run as done.
  it('S2: a mid entry gives wf.comp.exit.done', () => {
    const bypass = retargeting(m2, transitionsAt(m2, 1), m2.entries[1]!.next, site.exits.done);
    expect(Object.keys(bypass).length).toBeGreaterThan(0);
    expect(compensateStructureViolations(edited(m2, bypass))).toEqual(
      Object.keys(bypass).map((t) => `S2: '${t}' (entry 1) gives '${site.exits.done}'; a top-level entry gives only into its interior, its next, its arming, the ladder's exits or pools`),
    );
  });

  // pureMove, the arc type. Breaks if: an `all` input on a ladder transition passes as `one`.
  it('S2: raise takes all of the failure place', () => {
    const mutant = edited(m2, { [site.raise]: (t) => rebuild(t, { inputs: [all(placeOf(m2, site.failure))] }) });
    expect(compensateStructureViolations(mutant)).toEqual([`S2: '${site.raise}' takes [all(${site.failure})]; it takes exactly one each of [${site.failure}]`]);
  });

  // pureMove, other arcs. Breaks if: a ladder transition's read, inhibitor or reset arcs go unchecked.
  it('S2: raise inhibited by the fault', () => {
    const mutant = edited(m2, { [site.raise]: (t) => rebuild(t, { inhibitors: [placeOf(m2, site.fault)] }) });
    expect(compensateStructureViolations(mutant)).toEqual([`S2: '${site.raise}' has read [], inhibitor [${site.fault}] or reset [] arcs; it has none`]);
  });

  // S3, the five exits. Breaks if: a compensator with a kind missing from both its exits and its
  // settles passes — its leaf's paused branch has nowhere declared to go.
  it("S3: u_1 declares no 'paused' exit or settle", () => {
    const mutant = edited(m2, {}, { site: rung(1, (c) => ({ ...c, exits: without(c.exits, 'paused'), settles: without(c.settles, 'paused') })) });
    expect(compensateStructureViolations(mutant)).toContain("S3: u_1 declares no 'paused' exit");
  });

  // S3, one settle per exit. Breaks if: an exit with no settle is skipped silently.
  it("S3: u_1 declares a 'paused' exit and no settle for it", () => {
    const mutant = edited(m2, {}, { site: rung(1, (c) => ({ ...c, settles: without(c.settles, 'paused') })) });
    expect(compensateStructureViolations(mutant)).toContain('S3: u_1 declares exits [bailed, done, failed, paused, suspended] and settles [bailed, done, failed, suspended]; one settle per exit');
  });

  // S3, the exits' producers. Breaks if: something but u_j may give u_j's exit.
  it("S3: an unmapped producer of u_1's failed exit", () => {
    const mutant = edited(m2, {}, leak(m2, 't.leak', { gives: [u1.exits.failed] }));
    expect(compensateStructureViolations(mutant)).toEqual([`S3: 't.leak' produces '${u1.exits.failed}' and is not u_1's`]);
  });

  // S3, undoing's consumers. Breaks if: something but u_j's settles may take the held stack.
  it('S3: a second consumer of undoing', () => {
    const mutant = edited(m2, {}, leak(m2, 't.leak', { takes: [u1.undoing] }));
    expect(compensateStructureViolations(mutant)).toEqual([`S3: '${u1.undoing}' is consumed by [${Object.values(u1.settles).sort().join(', ')}, t.leak]; only by u_1's settles [${Object.values(u1.settles).sort().join(', ')}]`]);
  });

  // S3, pending's producers (at most once). Breaks if: a second rollback token may appear.
  it('S3: a stray producer of pending', () => {
    const mutant = edited(m2, {}, leak(m2, 't.leak', { gives: [site.pending] }));
    expect(compensateStructureViolations(mutant)).toEqual([`S3: 't.leak' produces '${site.pending}'; only raise and the settles do`]);
  });

  // S3, pending's consumers (termination). Breaks if: something may take the rollback token and
  // leave the run neither rolling back nor finished.
  it('S3: an extra start consuming pending', () => {
    const mutant = edited(m2, {}, leak(m2, 't.leak', { takes: [site.pending] }));
    expect(compensateStructureViolations(mutant)).toEqual([`S3: 't.leak' consumes '${site.pending}'; only the starts and finish do`]);
  });

  // S4, the fault's producer and consumer. Breaks if: a second fault may be held, or the held one taken.
  it('S4: a stray producer and a stray consumer of the fault', () => {
    const p = leak(m2, 't.leak.p', { gives: [site.fault] });
    const c = leak(m2, 't.leak.c', { takes: [site.fault] });
    const mutant = edited(m2, {}, { add: [...p.add, ...c.add], places: [...p.places, ...c.places] });
    expect(compensateStructureViolations(mutant)).toEqual([
      `S4: '${site.fault}' is produced by [${site.raise}, t.leak.p]; only by '${site.raise}'`,
      `S4: '${site.fault}' is consumed by [${site.finish}, t.leak.c]; only by '${site.finish}'`,
    ]);
  });

  // S5, ladder places. Breaks if: a cancel-gated transition may take a ladder place (not only a chain's).
  it('S5: a cancel-gated transition takes pending', () => {
    const mutant = edited(m2, {}, leak(m2, 't.leak', { takes: [site.pending], cancel: true }));
    expect(compensateStructureViolations(mutant)).toEqual([
      `S3: 't.leak' consumes '${site.pending}'; only the starts and finish do`,
      `S5: 't.leak' reads or is inhibited by 'wf.cancel' and consumes '${site.pending}'; no cancel-gated transition takes a ladder or compensator place`,
    ]);
  });

  // S6, the settle stage's inputs. Breaks if: an unmapped transition may give wf.settle.<kind> with a
  // level still held — no other rule sees it.
  it('S6: an unmapped producer of wf.settle.paused', () => {
    const mutant = edited(m2, {}, leak(m2, 't.leak', { gives: ['wf.settle.paused'] }));
    const row = site.discharges.map((r) => r.paused).sort();
    expect(compensateStructureViolations(mutant)).toEqual([`S6: 'wf.settle.paused' is produced by [${row.join(', ')}, t.leak]; only by its discharges [${row.join(', ')}]`]);
  });

  // S7, the chain's producers. Breaks if: an outsider may enter a compensator's chain past start_j.
  it("S7: an outsider gives into u_2's retry place", () => {
    const m2r = compile({ id: 'm2r', entries: [comp('a'), step('x'), comp('b', {}, { retries: 1 }), step('z')] });
    const v2 = siteOf(m2r).compensators[1]!;
    const inner = [...m2r.net.places].map((p) => p.name).find((n) => n.startsWith(`s.${v2.path[0]}.`) && n !== v2.inPlace)!;
    const mutant = edited(m2r, {}, leak(m2r, 't.leak', { gives: [inner] }));
    expect(compensateStructureViolations(mutant)).toEqual([`S7: 't.leak' gives '${inner}', inside u_2's chain; only '${v2.start}' enters it`]);
  });

  // S7, the path. Breaks if: a compensator's naming path is not held to [n + j - 1].
  it('S7: u_1 at a nested path', () => {
    const mutant = edited(m2, {}, { site: rung(1, (c) => ({ ...c, path: [...c.path, 0] })) });
    expect(compensateStructureViolations(mutant)).toEqual([`S7: u_1 is at path ${u1.path[0]}-0; it is at ${u1.path[0]}`]);
  });

  // S7, the view path. Breaks if: a compensator's events may be attributed to another entry.
  it('S7: u_1 viewed at the wrong entry', () => {
    const mutant = edited(m2, {}, { site: rung(1, (c) => ({ ...c, viewPath: [1] })) });
    expect(compensateStructureViolations(mutant)).toEqual([`S7: u_1 is viewed at 1; it is viewed at the entry it compensates, ${u1.k}`]);
  });

  // S1, a level with no producer. Breaks if: a site level nothing marks passes S1 (S8 says so as
  // well, from its own clause).
  it('S1: a site level no transition gives', () => {
    const ghost = place<unknown>('wf.comp.level.ghost');
    const mutant = edited(m2, {}, { places: [ghost], site: (s) => ({ ...s, levels: [s.levels[0]!, s.levels[1]!, ghost.name] }) });
    expect(compensateStructureViolations(mutant)).toContain(`S1: '${ghost.name}' has no producer`);
  });

  // S3, start's places. Breaks if: something but start_j may give the compensator's input or undoing —
  // a second compensator run, or a stack with no rung behind it.
  it("S3: stray producers of u_1's input and undoing", () => {
    const a = leak(m2, 't.leak.in', { gives: [u1.inPlace] });
    const b = leak(m2, 't.leak.undoing', { gives: [u1.undoing] });
    const mutant = edited(m2, {}, { add: [...a.add, ...b.add], places: [...a.places, ...b.places] });
    expect(compensateStructureViolations(mutant)).toEqual([
      `S3: '${u1.inPlace}' is produced by [${u1.start}, t.leak.in]; only by '${u1.start}'`,
      `S3: '${u1.undoing}' is produced by [${u1.start}, t.leak.undoing]; only by '${u1.start}'`,
      `S7: 't.leak.in' gives '${u1.inPlace}', inside u_1's chain; only '${u1.start}' enters it`,
    ]);
  });

  // S3 and S6, the exits' consumers. Breaks if: something but settle_j.<kind> may take u_j's exit, or
  // something but the discharges a ladder exit — an outcome leaving with its level still held.
  it("S3 + S6: stray consumers of u_1's failed exit and the ladder's bailed exit", () => {
    const a = leak(m2, 't.leak.u', { takes: [u1.exits.failed] });
    const b = leak(m2, 't.leak.x', { takes: [site.exits.bailed] });
    const mutant = edited(m2, {}, { add: [...a.add, ...b.add], places: [...a.places, ...b.places] });
    const row = site.discharges.map((r) => r.bailed).sort();
    expect(compensateStructureViolations(mutant)).toEqual([
      `S3: '${u1.exits.failed}' is consumed by [${u1.settles.failed}, t.leak.u]; only by '${u1.settles.failed}'`,
      `S6: '${site.exits.bailed}' is consumed by [${row.join(', ')}, t.leak.x]; only by its discharges [${row.join(', ')}]`,
    ]);
  });

  // S7, the attempts' path. Breaks if: a declared compensator attempt elsewhere in the net — a forward
  // step's attempt, exempted from coverage — passes.
  it("S7: u_1's attempts include the forward step's", () => {
    const forward = m2.steps.find((s) => s.stepId === 'a')!.attempts[0]!;
    const mutant = edited(m2, {}, { site: rung(1, (c) => ({ ...c, attempts: [...c.attempts, forward] })) });
    expect(compensateStructureViolations(mutant)).toContain(`S7: exempt attempt '${forward}' is not at u_1's path ${u1.path[0]}`);
  });

  // S8, the ladder's places. Breaks if: a site naming a place the net does not have passes.
  it('S8: a site naming a place the net does not have', () => {
    const mutant = edited(m2, {}, { site: (s) => ({ ...s, fault: 'wf.comp.ghost' }) });
    expect(compensateStructureViolations(mutant)).toContain("S8: ladder place 'wf.comp.ghost' is not a place of the net");
  });

  // S8, the seed. Breaks if: the fixpoint seeds every level instead of ladderLevel's — with no
  // boundary or resume site past k_1 and arming bypassed, level.1 is never marked, and its rung dead.
  it('S8: seeds only ladderLevel, so a level no seed and no arm reaches is dead', () => {
    const m1 = compile(M1);
    const v1 = siteOf(m1).compensators[0]!;
    const bypass = edited(m1, retargeting(m1, transitionsAt(m1, v1.k), v1.arming, m1.entries[v1.k]!.next));
    const mutant: CompiledWorkflow = { ...bypass, boundaries: [], resumeSites: new Map() };
    const lines = compensateStructureViolations(mutant);
    expect(lines).toContain(`S8: ladder transition '${v1.start}' is dead from the arcs: [${siteOf(m1).levels[1]}] never marked`);
  });
});

// --------------------------------------------------------------------------------------------------
// The seed
// --------------------------------------------------------------------------------------------------

describe('segmentInitialMarking: the ladder level is ladderLevel, in every default segment', () => {
  // Breaks if: the verifier seeds a different level than the shared formula — `restart@p` proven
  // from level.0 after a compensated entry would claim a rollback that skips it — or seeds two, or
  // none.
  it.each([['m2', M2], ['m3', M3], ['m2 beside foreach(2)', M2F]] as const)('%s', (_, description) => {
    const compiled = compile(description);
    const site = siteOf(compiled);
    const ks = site.compensators.map((c) => c.k);
    for (const segment of segmentsFor(compiled)) {
      const marking = segmentInitialMarking(compiled, segment);
      const levels = [...marking].filter(([p]) => site.levels.includes(p.name));
      const at = typeof segment === 'string' ? 0 : 'restart' in segment ? segment.restart : Number(segment.resume.split('.')[0]);
      const seed = ladderLevel(site, at);
      expect(seed.level, segmentLabel(segment)).toBe(ks.filter((k) => k < at).length);
      expect(levels.map(([p, n]) => [p.name, n]), segmentLabel(segment)).toEqual([[seed.place, 1]]);
    }
  });
});

describe('segmentInitialMarking and completionProperties refuse a ladder they cannot seed or count', () => {
  // Breaks if: segmentInitialMarking's own ladderLevel check is gone — a restart boundary whose place
  // is the entry place gets level.0 from initialCounts, where ladderLevel for index 2 says level.1.
  it('segmentInitialMarking throws when the seeded level is not ladderLevel at the segment index', () => {
    const m2 = compile(M2);
    const L = siteOf(m2).levels;
    const mutant: CompiledWorkflow = { ...m2, boundaries: m2.boundaries.map((b) => (b.index === 2 ? { ...b, place: m2.entryPlace } : b)) };
    expect(() => segmentInitialMarking(mutant, restartSegment(2, false))).toThrow(`segment restart@2 of 'm2' seeds the ladder with [${L[0]}=1]; ladderLevel says ${L[1]}=1`);
  });

  // Breaks if: C1 silently drops a level name the net does not have — vacuous when none resolve.
  it.each([
    ['one level renamed', (l: readonly string[]) => [l[0]!, 'wf.comp.level.9', l[2]!], '[wf.comp.level.0, wf.comp.level.9, wf.comp.level.2]', '[wf.comp.level.2]'],
    ['levels 1..m all missing', (l: readonly string[]) => [l[0]!, 'x.1', 'x.2'], '[wf.comp.level.0, x.1, x.2]', '[]'],
    ['a level named twice', (l: readonly string[]) => [l[0]!, l[1]!, l[1]!], '', ''],
  ] as const)('completionProperties throws: %s', (_, levels, __, found) => {
    const m2 = compile(M2);
    const site = siteOf(m2);
    const mutant: CompiledWorkflow = { ...m2, compensations: { ...site, levels: levels(site.levels) } };
    const named = levels(site.levels).slice(1);
    expect(() => completionProperties(mutant, 'closed')).toThrow(`'m2': rolledBack counts levels 1..2; the site names [${named.join(', ')}] and the net has ${found === '' ? `[${named.join(', ')}]` : found}`);
  });
});

// --------------------------------------------------------------------------------------------------
// The claims
// --------------------------------------------------------------------------------------------------

function expectHolds(report: VerificationReport): void {
  expect(report.families).toEqual([...FAMILIES]);
  for (const family of FAMILIES) expect(report.claims.some((c) => c.family === family), family).toBe(true);
  for (const c of report.claims) {
    const line = describeClaim(c);
    if (c.kind === 'proof') expect(c.result.verdict.type, line).toBe('proven');
    else {
      expect(c.result.verdict.type, line).toBe('violated');
      expect(c.result.counterexampleConfirmed, line).toBe(true);
    }
    expect(c.holds, line).toBe(true);
    expect(c.result.elapsedMs, line).toBeLessThan(BUDGET_MS);
  }
  expect(report.holds).toBe(true);
}

/** `State classes: N` from a `deadlockFree` report on the enumeration route. */
const classes = (report: VerificationReport, segment: string): number => {
  const c = report.claims.find((x) => x.property === 'deadlockFree' && segmentLabel(x.segment) === segment);
  expect(c?.result.route, segment).toBe('enumeration');
  const m = /State classes: (\d+)/.exec((c!.result as { readonly report?: string }).report ?? '');
  if (m === null) throw new Error(`no class count on deadlockFree@${segment}`);
  return Number(m[1]);
};

describe('verify: every family in every default segment, C1–C4', () => {
  // Breaks if: any claim fails to prove (a bound, an exclusion, a compensator attempt dead), a query
  // exceeds 30 s, C1 leaves the completion set or C2–C4 the exclusions, a segment loses its level
  // seed (finish dead: deadlockFree fails in restart@p), or the state space grows unnoticed.
  // Expected classes are the W0 Amendment's (closed / cancel), libpetri 8.0.0 from npm.
  it.each([
    ['m1 [a*,x,z]', M1, 14, [31, 96]],
    ['m2 [a*,x,b*,z]', M2, 18, [44, 136]],
    ['m3 [a*,x,b*,y,c*,z]', M3, 26, [58, 179]],
    ['m2 beside foreach(2) [a*,each(2),b*,z]', M2F, 18, [184, 556]],
  ] as const)('%s: every claim holds', async (name, description, segments, [closed, cancel]) => {
    const compiled = compile(description);
    const site = siteOf(compiled);
    const started = performance.now();
    const report = await verify(compiled);
    const ms = performance.now() - started;
    expectHolds(report);
    expect(report.segments).toHaveLength(segments);
    const labels = report.segments.map(segmentLabel);

    // C1 in every segment, from the completion set.
    for (const segment of report.segments) {
      const c1 = completionProperties(compiled, segment).find(([p]) => p === 'rolledBack')?.[1];
      expect(c1, segmentLabel(segment)).toBeDefined();
      // Exactly level.1..m, none at rest: level.0 is the empty stack, a level left out an unchecked rung.
      expect(c1!.type === 'quiescent-count' && { places: c1!.places.map((p) => p.name).sort(), min: c1!.min, max: c1!.max }).toEqual({
        places: site.levels.slice(1).sort(),
        min: 0,
        max: 0,
      });
    }
    const count = (re: RegExp): number => report.claims.filter((c) => re.test(c.property) && c.result.verdict.type === 'proven').length;
    const C1 = count(/^rolledBack$/);
    const C2 = count(/^exclusive\(wf\.comp\.level\.[1-9]\d*,wf\.settle\.failed\)$/);
    const C3 = count(/^exclusive\(wf\.comp\.fault,/);
    const C4 = count(/^exclusive\(wf\.canceled,wf\.comp\.(failure|pending)\)$/);
    expect(C1).toBe(segments);
    expect(C2).toBe(segments * site.m);
    // C3: the fault against every top-level entry input, the five settle places and the six terminals.
    expect(C3).toBe(segments * (compiled.entries.length + 5 + 6));
    expect(C4).toBe(segments * 2);
    for (const label of labels) {
      for (const p of ['rolledBack', `exclusive(wf.canceled,${site.failure})`, `exclusive(wf.canceled,${site.pending})`, ...site.levels.slice(1).map((l) => `exclusive(${l},wf.settle.failed)`)]) {
        expect(report.claims.some((c) => c.property === p && segmentLabel(c.segment) === label), `${p}@${label}`).toBe(true);
      }
    }
    // Every ladder place 1-bounded, every compensator attempt live.
    const properties = new Set(report.claims.map((c) => c.property));
    for (const p of [...compiled.net.places].map((x) => x.name).filter((x) => x.startsWith('wf.comp.'))) expect(properties.has(`bound(${p}<=1)`), p).toBe(true);
    for (const a of compensatorAttempts(compiled)) expect(properties.has(`live(${a})`), a).toBe(true);

    expect([classes(report, 'closed'), classes(report, 'cancel')]).toEqual([closed, cancel]);
    const slowest = [...report.claims].sort((a, b) => b.result.elapsedMs - a.result.elapsedMs)[0]!;
    // The figure the ADR's Evidence cites (libpetri 8.0.0 from npm, not linked).
    console.log(
      `${name}: P/T ${compiled.net.places.size}/${compiled.net.transitions.size}; ${report.segments.length} segments, ${report.claims.length} claims in ${Math.round(ms)} ms wall; ` +
        `classes ${closed}/${cancel}; C1–C4 ${C1} + ${C2} + ${C3} + ${C4}; slowest ${describeClaim(slowest)}`,
    );
  });
});

import { describe, expect, it } from 'vitest';
import { PetriNet, Transition, and, one, outPlace, xor, type In, type Out, type Place } from 'libpetri';
import { SmtVerifier, StateSpaceCache, mutualExclusion, unreachable, type SmtProperty, type SmtVerificationResult } from 'libpetri/verification';
import { compile } from '../../src/compiler/index.js';
import type { CompiledWorkflow, PipelineSite, StepDescription, WorkflowDescription } from '../../src/compiler/types.js';
import type { CompileOptions } from '../../src/compiler/compile.js';
import {
  FAMILIES,
  boundClaims,
  describeClaim,
  exclusions,
  pipelineLaneAttempts,
  pipelineStructureViolations,
  poolSinks,
  segmentInitialMarking,
  segmentLabel,
  suspensionCoverageViolations,
  verify,
  type Segment,
  type VerificationReport,
} from '../../src/verify/index.js';
import { pipelineOverlaps } from '../../src/verify/claims.js';
import { sitePlaces, siteTransitions } from '../../src/verify/pipeline.js';
import { verifyWorkflow } from '../../src/verify/properties.js';

/**
 * The pipeline's claims ([ADR 0015], amended by the W0 spike), M7b W1 D.
 *
 * Three halves. **The arc rules** (`pipelineStructureViolations`): empty on every compiled shape —
 * one to three stages, up to four lanes, the pipeline as a later entry, a retrying, a timed, a
 * `limit`ed and a rate-quota'd stage, under a run budget — and hand-edited mutants, several a rule
 * (one per clause the review found surviving), each asserting the rule's own line. With them the
 * suspension-coverage exemption (`pipelineLaneAttempts`): exactly the lane attempts, and not vacuous. **The claims** (`boundClaims`, `exclusions`,
 * `pipelineOverlaps`) derived from `CompiledWorkflow.pipelines`, and `verify()` on (1,1), (1,1,1),
 * (2,2) and (2,1) with a `limit(1)` on stage 1, all four families in every default segment, every
 * claim holding by verdict. **The two reachability tests**: the overlap — `mutualExclusion(stage j
 * lane0 slot, stage j+1 lane0 slot)` a definitive, confirmed `violated` for each adjacent pair — and
 * the amendment's rule 8: no pipeline transition is unreachable from the arcs (`unreachable(inputs ∪
 * reads)` a confirmed `violated` for every one), with the dead open-queue `.again` settle as its
 * mutant, proven unreachable; on one lane, exactly the `.again` settles and the finishers taking
 * both flags are dead, as the one-lane foreach's `.again` is.
 *
 * Proof environment: libpetri 8.0.0 from the registry (not linked), z3 on PATH, environment mode
 * none (one closed net). Segments: `verify`'s defaults — `closed`, `cancel`, `resume@1[+cancel]` (the
 * report step's site; the pipeline registers none), `restart@p[+cancel]` per top-level boundary. Bounds and exclusion in
 * every segment, liveness in `closed`. 30 s a query; every test under 60 s.
 *
 * Proofs are judged by verdict string, never by `isViolated()` — `unknown` fails.
 */

const BUDGET_MS = 30_000;

const step = (id: string, extra: Omit<StepDescription, 'kind' | 'id'> = {}): StepDescription => ({ kind: 'step', id, ...extra });
const sum = (bounds: readonly number[]): number => bounds.reduce((a, b) => a + b, 0);

/** `[before…, pipeline 'per-doc' over s0..s{n-1}, step 'report']` — the W0 spike's workflow. */
function piped(
  bounds: readonly number[],
  { stages = bounds.map((_, j) => step(`s${j}`)), before = [] }: { stages?: readonly StepDescription[]; before?: readonly StepDescription[] } = {},
): WorkflowDescription {
  return {
    id: 'ingest',
    entries: [
      ...before,
      { kind: 'foreach', id: 'per-doc', body: step('per-doc', { source: 'workflow' }), concurrency: sum(bounds), pipeline: { stages, bounds } },
      step('report'),
    ],
  };
}
const build = (bounds: readonly number[], options?: CompileOptions): CompiledWorkflow => compile(piped(bounds), options);

const siteOf = (compiled: CompiledWorkflow): PipelineSite => {
  expect(compiled.pipelines).toHaveLength(1);
  return compiled.pipelines[0]!;
};

// --- hand edits ----------------------------------------------------------------------------------

interface Rebuild {
  readonly inputs?: readonly In[];
  readonly output?: Out;
  readonly reads?: readonly Place<unknown>[];
  readonly resets?: readonly Place<unknown>[];
  readonly inhibitors?: readonly Place<unknown>[];
  readonly priority?: number;
}

/** A copy of `t` with some arcs (or its priority) replaced; action and timing kept. */
function rebuild(t: Transition, change: Rebuild): Transition {
  const b = Transition.builder(t.name).inputs(...(change.inputs ?? t.inputSpecs)).timing(t.timing).priority(change.priority ?? t.priority).action(t.action);
  const output = change.output ?? t.outputSpec;
  if (output !== null) b.outputs(output);
  for (const p of change.inhibitors ?? t.inhibitors.map((a) => a.place)) b.inhibitor(p);
  for (const p of change.resets ?? t.resets.map((a) => a.place)) b.reset(p);
  for (const p of change.reads ?? t.reads.map((a) => a.place)) b.read(p);
  return b.build();
}

/** The compiled workflow with transitions replaced by name (null drops one), others added, and the site edited. */
function edited(
  compiled: CompiledWorkflow,
  replace: Record<string, (t: Transition) => Transition | null>,
  add: readonly Transition[] = [],
  siteEdit: (s: PipelineSite) => PipelineSite = (s) => s,
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
  const net = PetriNet.builder(compiled.net.name).places(...compiled.net.places).transitions(...transitions, ...add).build();
  return { ...compiled, net, pipelines: compiled.pipelines.map(siteEdit) };
}

const placeOf = (compiled: CompiledWorkflow, name: string): Place<unknown> => {
  const p = [...compiled.net.places].find((x) => x.name === name);
  if (p === undefined) throw new Error(`no place '${name}'`);
  return p;
};
const transitionOf = (compiled: CompiledWorkflow, name: string): Transition => {
  const t = [...compiled.net.transitions].find((x) => x.name === name);
  if (t === undefined) throw new Error(`no transition '${name}'`);
  return t;
};
const outs = (compiled: CompiledWorkflow, ...names: string[]): Out => {
  const places = names.map((n) => outPlace(placeOf(compiled, n)));
  return places.length === 1 ? places[0]! : and(...places);
};

/** The lines of one rule. */
const ruleLines = (lines: readonly string[], rule: number): string[] => lines.filter((l) => l.includes(`: rule ${rule}: `));

// --------------------------------------------------------------------------------------------------
// The arc rules
// --------------------------------------------------------------------------------------------------

describe('pipelineStructureViolations: every compiled shape is sound', () => {
  const shapes: readonly (readonly [string, () => CompiledWorkflow])[] = [
    ...([[1], [1, 1], [2, 1], [1, 2], [2, 2], [1, 1, 1], [1, 2, 1], [3, 1, 2]] as const).map((b) => [`(${b.join(',')})`, () => build(b)] as const),
    ['(1,1) after a step', () => compile(piped([1, 1], { before: [step('pre')] }))],
    ['(2,1), run budget 1', () => build([2, 1], { concurrency: 1 })],
    ['(2,1), stage 1 retrying 2 × 5 ms', () => compile(piped([2, 1], { stages: [step('s0'), step('s1', { retries: 2, retryDelayMs: 5 })] }))],
    ['(2,1), stage 1 timed and retrying', () => compile(piped([2, 1], { stages: [step('s0'), step('s1', { retries: 1, timeoutMs: 100 })] }))],
    ['(2,1), a limit(1) on stage 1', () => compile(piped([2, 1], { stages: [step('s0'), step('s1', { quotas: [{ id: 'gpu', kind: 'limit', n: 1 }] })] }))],
    ['(1,1), a rate quota on stage 1', () => compile(piped([1, 1], { stages: [step('s0'), step('s1', { quotas: [{ id: 'r', kind: 'rate', burst: 2, perMs: 100 }] })] }))],
  ];
  // Breaks if: any rule misreads the compiled gadget — a pool place counted as a lane outcome, a
  // retry hop, a timeout funnel or a bucket's request read as an escape from the lane, the open-queue
  // settles left out of queue.open's takers, or the site's counts misread.
  it.each(shapes)('%s', (_, make) => {
    const compiled = make();
    siteOf(compiled);
    expect(pipelineStructureViolations(compiled)).toEqual([]);
    expect(suspensionCoverageViolations(compiled)).toEqual([]);
  });

  // Breaks if: the check throws or reports on a net with no pipeline.
  it('is empty on a net with no pipeline', () => {
    const plain = compile({ id: 'w', entries: [{ kind: 'foreach', id: 'f', body: step('b'), concurrency: 2 }, step('next')] });
    expect(plain.pipelines).toEqual([]);
    expect(pipelineStructureViolations(plain)).toEqual([]);
    expect(pipelineLaneAttempts(plain).size).toBe(0);
  });
});

describe('pipelineStructureViolations: one mutant per rule', () => {
  // Rule 0. Breaks if: the site is trusted without resolving its names (every later rule would then
  // read `undefined` as a place), or its counts go unchecked.
  it('rule 0: a site naming a finisher not in the net, or one lane short, is refused before the rules', () => {
    const compiled = build([1, 1]);
    const ghost = edited(compiled, {}, [], (s) => ({ ...s, finishers: [...s.finishers.slice(0, -1), 't.0.per-doc.ghost'] }));
    expect(pipelineStructureViolations(ghost)).toEqual([
      "pipeline 'per-doc' at 0: rule 0: names transition(s) 't.0.per-doc.ghost', not in the net",
    ]);
    const short = edited(compiled, {}, [], (s) => ({ ...s, lanes: s.lanes.slice(0, 1) }));
    expect(pipelineStructureViolations(short)).toEqual(["pipeline 'per-doc' at 0: rule 0: declares 1 lane(s); the bounds [1, 1] make 2"]);
  });

  // Rule 1. Breaks if: a hand-off's inputs are not compared exactly — without the next permit the
  // handed item runs at stage 1 beside the item already there, past c_1.
  it('rule 1: a hand-off without the next permit', () => {
    const compiled = build([1, 1]);
    const site = siteOf(compiled);
    const [from, to] = site.lanes;
    const handoff = from!.handoffs[0]!;
    const mutant = edited(compiled, {
      [handoff]: (t) => rebuild(t, { inputs: [one(placeOf(compiled, from!.done)), one(placeOf(compiled, from!.slot))] }),
    });
    expect(ruleLines(pipelineStructureViolations(mutant), 1)).toEqual([
      `pipeline 'per-doc' at 0: rule 1: '${handoff}' consumes [one() ${from!.done}, one() ${from!.slot}]; a hand-off takes exactly one each of '${from!.done}', '${from!.slot}' and '${to!.permit}'`,
    ]);
  });

  // Rule 2. Breaks if: a stage body's producers are not held to the hand-offs into it.
  it('rule 2: a stage-1 body given by something other than a hand-off', () => {
    const compiled = build([1, 1]);
    const site = siteOf(compiled);
    const [first, second] = site.lanes;
    const rogue = Transition.builder('t.0.per-doc.rogue')
      .inputs(one(placeOf(compiled, first!.exits.bailed)))
      .outputs(outPlace(placeOf(compiled, second!.body)))
      .action(async () => {})
      .build();
    const lines = pipelineStructureViolations(edited(compiled, {}, [rogue]));
    expect(ruleLines(lines, 2)).toEqual([
      `pipeline 'per-doc' at 0: rule 2: lane body '${second!.body}' is produced by [t.0.per-doc.rogue, ${first!.handoffs[0]}]; only [${first!.handoffs[0]}] may`,
    ]);
  });

  // Rule 3. Breaks if: a slot-consuming transition is not held to one slot per branch — a hand-off
  // that keeps its own slot as well as the next makes one item two.
  it('rule 3: a hand-off that gives the item two slots', () => {
    const compiled = build([1, 1]);
    const site = siteOf(compiled);
    const [from, to] = site.lanes;
    const handoff = from!.handoffs[0]!;
    const mutant = edited(compiled, { [handoff]: (t) => rebuild(t, { output: outs(compiled, to!.body, to!.slot, from!.slot) }) });
    const lines = pipelineStructureViolations(mutant);
    expect(ruleLines(lines, 3)).toEqual([
      `pipeline 'per-doc' at 0: rule 3: '${handoff}' consumes a slot and branch 0 (${to!.body} + ${to!.slot} + ${from!.slot}) gives 2 slots; at most one`,
      `pipeline 'per-doc' at 0: rule 3: slot '${from!.slot}' is produced by [${from!.start}, ${handoff}]; only [${from!.start}] may`,
    ]);
  });

  // Rule 4. Breaks if: an exit's cancel-reading consumers are not required — a last-stage `done`
  // nothing drops strands under a cancel, and the run never finishes.
  it('rule 4: a collect without its drop', () => {
    const compiled = build([1, 1]);
    const lane = siteOf(compiled).lanes[1]!;
    const drop = lane.drops!.done;
    const mutant = edited(compiled, { [drop]: (t) => rebuild(t, { inputs: [one(placeOf(compiled, lane.slot))] }) });
    const lines = ruleLines(pipelineStructureViolations(mutant), 4);
    expect(lines).toContain(`pipeline 'per-doc' at 0: rule 4: lane exit '${lane.done}' (done) has no drop reading 'wf.cancel'; '${drop}' must take it`);
    expect(lines).toContain(`pipeline 'per-doc' at 0: rule 4: '${drop}' consumes [one() ${lane.slot}]; a drop takes exactly one each of '${lane.done}' and '${lane.slot}'`);
  });

  // Rule 5. Breaks if: a finisher is not required to take every permit — `join` firing with a
  // stage-1 item still in flight reports the array without it, and its collect then strands.
  it('rule 5: a finisher missing a stage-1 permit', () => {
    const compiled = build([1, 1]);
    const site = siteOf(compiled);
    const join = site.finishers[0]!;
    const stage1 = site.lanes[1]!.permit;
    const mutant = edited(compiled, { [join]: (t) => rebuild(t, { inputs: t.inputSpecs.filter((s) => s.place.name !== stage1) }) });
    expect(ruleLines(pipelineStructureViolations(mutant), 5)).toEqual([
      `pipeline 'per-doc' at 0: rule 5: finisher '${join}' does not take one of each of [${stage1}]; a finisher takes every permit of every stage, '${site.queueClosed}' and '${site.frame}'`,
    ]);
  });

  // Rule 6. Breaks if: a test arc on a pipeline place goes unseen — an inhibitor on `fault` makes a
  // hand-off non-monotone, so VER-004 splits every firing that raises it, and the failure drain
  // the ADR promises (items in flight finish every stage) is gone.
  it('rule 6: an inhibitor on fault added to a hand-off', () => {
    const compiled = build([1, 1]);
    const site = siteOf(compiled);
    const handoff = site.lanes[0]!.handoffs[0]!;
    const mutant = edited(compiled, { [handoff]: (t) => rebuild(t, { inhibitors: [...t.inhibitors.map((a) => a.place), placeOf(compiled, site.fault)] }) });
    const lines = pipelineStructureViolations(mutant);
    expect(ruleLines(lines, 6)).toEqual([`pipeline 'per-doc' at 0: rule 6: '${handoff}' has an inhibitor on pipeline place '${site.fault}'; every pipeline place is monotone`]);
    // Rule 1 sees it too: a hand-off is inhibited by the signal alone.
    expect(ruleLines(lines, 1)).toHaveLength(1);
  });

  // Rule 7. Breaks if: a lane attempt's outcomes are not held to its lane — a stage suspension sent
  // straight to the run's suspended settle ends the run suspended at a step no resume site covers,
  // and the coverage exemption would hide it.
  it('rule 7: a lane attempt suspending straight into the run', () => {
    const compiled = build([1, 1]);
    const lane = siteOf(compiled).lanes[1]!;
    const attempt = compiled.steps.find((c) => c.path.join('.') === `0.${lane.flat}`)!.attempts[0]!;
    const run = transitionOf(compiled, attempt);
    const branches = [...run.outputPlaces()].map((p) => outPlace(p.name === lane.exits.suspended ? placeOf(compiled, 'wf.settle.suspended') : p));
    const mutant = edited(compiled, { [attempt]: (t) => rebuild(t, { output: xor(...branches) }) });
    expect(pipelineLaneAttempts(mutant).has(attempt)).toBe(true);
    expect(suspensionCoverageViolations(mutant)).toEqual([]);
    expect(ruleLines(pipelineStructureViolations(mutant), 7)).toEqual([
      `pipeline 'per-doc' at 0: rule 7: lane 1's '${attempt}' gives into 'wf.settle.suspended', consumed by [t.settle.suspended, t.settle.suspended.canceled]; a lane step's outcome goes to its lane's exits or its own chain`,
    ]);
  });

  // Rule 1, gating. Breaks if: a hand-off's own cancel gate goes unchecked — rule 6 sees only a
  // test arc added, never the signal's inhibitor removed, so a hand-off without it keeps moving
  // items into the next stage after a cancel, past the drops that were to settle them.
  it('rule 1: a hand-off no longer inhibited by the signal', () => {
    const compiled = build([1, 1]);
    const handoff = siteOf(compiled).lanes[0]!.handoffs[0]!;
    const mutant = edited(compiled, { [handoff]: (t) => rebuild(t, { inhibitors: [] }) });
    expect(pipelineStructureViolations(mutant)).toEqual([
      `pipeline 'per-doc' at 0: rule 1: '${handoff}' is inhibited by []; it is inhibited by 'wf.cancel' alone`,
    ]);
  });

  // Rule 2, the queue's takers. Breaks if: `queue.open`'s consumers are not held to the starts, the
  // refuses and the open-queue settles — a refuse that leaves the queue open under a cancel never
  // closes it, and no finisher, which takes `queue.closed`, can fire.
  it('rule 2: a refuse that does not take queue.open', () => {
    const compiled = build([1, 1]);
    const site = siteOf(compiled);
    const lane = site.lanes[0]!;
    const mutant = edited(compiled, {
      [lane.refuse!]: (t) => rebuild(t, { inputs: t.inputSpecs.filter((s) => s.place.name !== site.queueOpen) }),
    });
    const want = [lane.start!, lane.refuse!, lane.settles.fail[0], lane.settles.suspend[0], site.lanes[1]!.settles.fail[0], site.lanes[1]!.settles.suspend[0]].sort();
    const got = want.filter((name) => name !== lane.refuse);
    expect(pipelineStructureViolations(mutant)).toEqual([
      `pipeline 'per-doc' at 0: rule 2: '${site.queueOpen}' is consumed by [${got.join(', ')}]; exactly the starts, the refuses and the open-queue settles [${want.join(', ')}] take it`,
    ]);
  });

  // Rule 4, priority. Breaks if: a settle's priority goes unchecked — at priority 0 a fail settle
  // races the stage-0 `start`, which admits a further item after the failure the ADR promises closes
  // the queue.
  it('rule 4: a fail settle at priority 0', () => {
    const compiled = build([1, 1]);
    const settle = siteOf(compiled).lanes[1]!.settles.fail[0];
    const mutant = edited(compiled, { [settle]: (t) => rebuild(t, { priority: 0 }) });
    expect(pipelineStructureViolations(mutant)).toEqual([
      `pipeline 'per-doc' at 0: rule 4: settle '${settle}' has priority 0; a failure or suspension settles at priority 1`,
    ]);
  });

  // Rule 4, its own cancel gate on each declared ¬cancel consumer. Breaks if: rule 4 stops gating a
  // collect, a bail or pause settle (`quietSettle`), or a fail or suspend variant — a settle that
  // fires under a cancel writes the frame the cancel finisher is to report without it.
  it.each([
    ['collect', (s: PipelineSite) => s.lanes[1]!.collect!],
    ['bail', (s: PipelineSite) => s.lanes[0]!.settles.bail],
    ['pause', (s: PipelineSite) => s.lanes[1]!.settles.pause],
    ['fail (open queue)', (s: PipelineSite) => s.lanes[0]!.settles.fail[0]],
    ['suspend (closed queue, again)', (s: PipelineSite) => s.lanes[1]!.settles.suspend[2]],
  ] as const)('rule 4: a %s no longer inhibited by the signal', (_, pick) => {
    const compiled = build([1, 1]);
    const name = pick(siteOf(compiled));
    const mutant = edited(compiled, { [name]: (t) => rebuild(t, { inhibitors: [] }) });
    expect(pipelineStructureViolations(mutant)).toEqual([
      `pipeline 'per-doc' at 0: rule 4: '${name}' is inhibited by []; it is inhibited by 'wf.cancel' alone`,
    ]);
  });

  // Rule 5, the flags. Breaks if: a finisher is not held to one place of each flag pair — a `join`
  // taking neither `no-fault` nor `fault` fires after a failure too, and reports success.
  it('rule 5: a join that takes no place of the fault pair', () => {
    const compiled = build([1, 1]);
    const site = siteOf(compiled);
    const join = site.finishers[0]!;
    const mutant = edited(compiled, { [join]: (t) => rebuild(t, { inputs: t.inputSpecs.filter((s) => s.place.name !== site.noFault) }) });
    expect(pipelineStructureViolations(mutant)).toEqual([
      `pipeline 'per-doc' at 0: rule 5: finisher '${join}' takes 0 of [${site.fault}, ${site.noFault}]; exactly one`,
    ]);
  });

  // Rule 7, the suspended exit's reach. Breaks if: a consumer of a lane's `suspended` exit outside
  // its own settle and drop goes unseen by rule 7 — the clause the coverage exemption rests on: a
  // stage suspension carried to the run's suspended settle ends the run at a step no resume site
  // covers. (Rule 4 sees the stray consumer too; rule 7 must say it on its own.)
  it('rule 7: a lane suspension taken out of the pipeline', () => {
    const compiled = build([1, 1]);
    const lane = siteOf(compiled).lanes[1]!;
    const escape = Transition.builder('t.0.per-doc.escape')
      .inputs(one(placeOf(compiled, lane.exits.suspended)))
      .outputs(outPlace(placeOf(compiled, 'wf.settle.suspended')))
      .inhibitor(compiled.cancel)
      .action(async () => {})
      .build();
    const own = [...lane.settles.suspend, lane.drops!.suspended].sort().join(', ');
    expect(ruleLines(pipelineStructureViolations(edited(compiled, {}, [escape])), 7)).toEqual([
      `pipeline 'per-doc' at 0: rule 7: lane exit '${lane.exits.suspended}' reaches [t.0.per-doc.escape]; only its own settle or drop [${own}] may take it`,
    ]);
  });

  // Breaks if: "pipeline structure" leaves verifyWorkflow's structural checks.
  it('verifyWorkflow refuses a mutant before any proof, naming "pipeline structure"', async () => {
    const compiled = build([1, 1]);
    const site = siteOf(compiled);
    const join = site.finishers[0]!;
    const mutant = edited(compiled, { [join]: (t) => rebuild(t, { inputs: t.inputSpecs.filter((s) => s.place.name !== site.lanes[1]!.permit) }) });
    await expect(verifyWorkflow(mutant, { segments: [] })).rejects.toThrow(/^pipeline structure is unsound:/);
  });
});

describe('pipelineLaneAttempts: the suspension-coverage exemption', () => {
  // Breaks if: the exemption takes attempts outside the lanes (the report step) or misses a retry.
  it('is exactly every lane attempt, retries included, at [i, L]', () => {
    const compiled = compile(piped([2, 1], { before: [step('pre')], stages: [step('s0'), step('s1', { retries: 1 })] }));
    const site = siteOf(compiled);
    const want = compiled.steps.filter((c) => c.path.length === 2 && c.path[0] === site.path[0]).flatMap((c) => c.attempts);
    expect(want).toHaveLength(4);
    expect([...pipelineLaneAttempts(compiled)].sort()).toEqual([...want].sort());
    for (const name of ['t.0.pre.run', 't.2.report.run']) expect(pipelineLaneAttempts(compiled).has(name), name).toBe(false);
  });

  // Breaks if: suspensionCoverageViolations stops consulting the exemption, or the exemption keys
  // on something other than the site's path.
  it('is not vacuous: without it every lane attempt is uncovered', () => {
    const compiled = build([1, 2]);
    const moved = { ...compiled, pipelines: compiled.pipelines.map((s) => ({ ...s, path: [7] })) };
    expect(pipelineLaneAttempts(moved).size).toBe(0);
    expect(suspensionCoverageViolations(moved)).toEqual([
      "step 's0' at [0, 0] ('t.0-0.s0.run') can suspend, and no resume site covers it",
      "step 's1' at [0, 1] ('t.0-1.s1.run') can suspend, and no resume site covers it",
      "step 's1' at [0, 2] ('t.0-2.s1.run') can suspend, and no resume site covers it",
    ]);
  });
});

// --------------------------------------------------------------------------------------------------
// The claims
// --------------------------------------------------------------------------------------------------

describe('the pipeline claims, derived from CompiledWorkflow.pipelines', () => {
  // Breaks if: a pipeline place loses its derived bound, or an exclusion is dropped or listed twice.
  it('bounds every site place at 1, and lists each lane and queue exclusion once, as pipeline', () => {
    const compiled = build([1, 2]);
    const site = siteOf(compiled);
    const { claimed } = boundClaims(compiled);
    for (const name of sitePlaces(site)) {
      const claim = claimed.find((c) => c.place.name === name);
      expect(claim, name).toBeDefined();
      expect(claim!.bound, name).toBe(1);
      expect(claim!.why, name).toContain(`pipeline 'per-doc'`);
    }
    const pairs = exclusions(compiled).filter((e) => e.source === 'pipeline').map((e) => `${e.a.name}|${e.b.name}`);
    expect(pairs).toEqual([
      `${site.queueOpen}|${site.queueClosed}`,
      `${site.queueOpen}|${site.fault}`,
      `${site.queueOpen}|${site.susp}`,
      `${site.noFault}|${site.fault}`,
      `${site.noSusp}|${site.susp}`,
      ...site.lanes.map((l) => `${l.permit}|${l.slot}`),
    ]);
    const all = exclusions(compiled).map((e) => [e.a.name, e.b.name].sort().join('|'));
    expect(new Set(all).size).toBe(all.length);
  });

  // Breaks if: the overlap pairs stop being the lane-0 slots of adjacent stages, or become a claim.
  it('names one overlap query per adjacent stage pair, never as an exclusion', () => {
    const compiled = build([1, 2, 1]);
    const site = siteOf(compiled);
    const overlaps = pipelineOverlaps(compiled);
    expect(overlaps.map((o) => [o.stage, o.a.name, o.b.name])).toEqual([
      [0, site.lanes[0]!.slot, site.lanes[1]!.slot],
      [1, site.lanes[1]!.slot, site.lanes[3]!.slot],
    ]);
    const claimed = new Set(exclusions(compiled).map((e) => `${e.a.name}|${e.b.name}`));
    for (const o of overlaps) expect(claimed.has(`${o.a.name}|${o.b.name}`)).toBe(false);
    expect(pipelineOverlaps(build([2]))).toEqual([]);
  });
});

/** Every claim holds, by verdict: `proven` for a proof, a confirmed witness for liveness. */
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

describe('verify: every family in every default segment', () => {
  // Breaks if: any pipeline claim fails to prove (a bound or exclusion lost, a lane attempt dead),
  // any query exceeds 30 s (`unknown` is not `proven`), a resume segment appears, or the pipeline's
  // claims stop reaching `verify`.
  it.each([[[1, 1]], [[1, 1, 1]], [[2, 2]]] as const)('(%s): every claim holds', async (bounds) => {
    const compiled = build(bounds);
    const site = siteOf(compiled);
    const started = performance.now();
    const report = await verify(compiled);
    const ms = performance.now() - started;
    expectHolds(report);
    // `resume@1` is the report step's own site; the pipeline at 0 registers none.
    expect(report.segments.map(segmentLabel)).toEqual(['closed', 'cancel', 'resume@1', 'resume@1+cancel', 'restart@0', 'restart@0+cancel', 'restart@1', 'restart@1+cancel']);
    const properties = new Set(report.claims.map((c) => c.property));
    for (const p of [
      ...sitePlaces(site).map((name) => `bound(${name}<=1)`),
      ...site.lanes.map((l) => `exclusive(${l.permit},${l.slot})`),
      `exclusive(${site.queueOpen},${site.fault})`,
      `exclusive(${site.queueOpen},${site.susp})`,
      `exclusive(${site.queueOpen},${site.queueClosed})`,
      `exclusive(${site.noFault},${site.fault})`,
      `exclusive(${site.noSusp},${site.susp})`,
      ...[...pipelineLaneAttempts(compiled)].map((t) => `live(${t})`),
    ]) {
      expect(properties.has(p), p).toBe(true);
    }
    const slowest = [...report.claims].sort((a, b) => b.result.elapsedMs - a.result.elapsedMs)[0]!;
    // The figure the ADR's Evidence cites (libpetri 8.0.0 from npm).
    console.log(`(${bounds.join(',')}): ${report.claims.length} claims in ${Math.round(ms)} ms wall; slowest ${describeClaim(slowest)}`);
  });
});

describe('verify: a pipeline composed with a pool', () => {
  // Breaks if: a quota inside a lane loses its claims beside the pipeline's — its bound (or its
  // derivation from the pool) or its quiescence dropped from a segment, or unprovable there (a lane
  // attempt that takes the quota and a settle or drop that strands it) — or any query exceeds 30 s.
  it('(2,1), a limit(1) on stage 1: the quota bounded and returned in every segment', async () => {
    const compiled = compile(piped([2, 1], { stages: [step('s0'), step('s1', { quotas: [{ id: 'gpu', kind: 'limit', n: 1 }] })] }));
    siteOf(compiled);
    const limits = compiled.pools.filter((p) => p.kind === 'limit');
    expect(limits.map((p) => p.place.name)).toEqual(['wf.quota.gpu']);
    const gpu = limits[0]!.place.name;
    // At n = 1 the fallback (`no gadget claims more`) names the same property: the bound must be the quota's.
    expect(boundClaims(compiled).claimed.find((c) => c.place.name === gpu)?.why).toBe(`limit quota 'gpu' seeded 1, conserved with its holders`);
    const started = performance.now();
    const report = await verify(compiled);
    const ms = performance.now() - started;
    expectHolds(report);
    expect(report.segments.map(segmentLabel)).toEqual(['closed', 'cancel', 'resume@1', 'resume@1+cancel', 'restart@0', 'restart@0+cancel', 'restart@1', 'restart@1+cancel']);
    for (const seg of report.segments.map(segmentLabel)) {
      const at = report.claims.filter((c) => segmentLabel(c.segment) === seg).map((c) => c.property);
      expect(at, seg).toContain(`bound(${gpu}<=1)`);
      expect(at, seg).toContain(`poolReturned(${gpu})`);
    }
    const slowest = [...report.claims].sort((a, b) => b.result.elapsedMs - a.result.elapsedMs)[0]!;
    console.log(`(2,1) + limit(1): ${report.claims.length} claims in ${Math.round(ms)} ms wall; slowest ${describeClaim(slowest)}`);
  });
});

// --------------------------------------------------------------------------------------------------
// Reachability: the overlap, and rule 8
// --------------------------------------------------------------------------------------------------

/** One query from a segment's initial marking, as `verify` asks it, through a shared cache. */
function ask(compiled: CompiledWorkflow, segment: Segment, property: SmtProperty, cache: StateSpaceCache): Promise<SmtVerificationResult> {
  const t = compiled.terminals;
  const initial = segmentInitialMarking(compiled, segment);
  return SmtVerifier.forNet(compiled.net)
    .initialMarking((m) => {
      for (const [p, n] of initial) m.tokens(p, n);
    })
    .sinkPlaces(t.done, t.failed, t.bailed, t.suspended, t.paused, t.canceled, compiled.cancel, ...poolSinks(compiled))
    .semiflowInvariants(true)
    .stateSpaceCache(cache)
    .enumerationMaxClasses(50_000)
    .timeout(BUDGET_MS)
    .totalBudget(BUDGET_MS)
    .property(property)
    .verify();
}

const describeResult = (what: string, r: SmtVerificationResult): string =>
  `${what}: ${r.verdict.type} via ${r.route} in ${Math.round(r.elapsedMs)}ms, confirmed ${String(r.counterexampleConfirmed)}`;

describe('the overlap: stage j+1 of one item while stage j of another', () => {
  // Breaks if: hand-offs serialize the stages (a hand-off taking the frame, or a stage waiting for
  // the queue to close) — the pair then becomes exclusive, `proven`, and the pipeline is a foreach.
  // Only a definitive, confirmed `violated` passes; `unknown` fails.
  it.each([[[1, 1]], [[1, 1, 1]], [[2, 2]], [[1, 2, 1]]] as const)('(%s): every adjacent pair is a confirmed violated', async (bounds) => {
    const compiled = build(bounds);
    const overlaps = pipelineOverlaps(compiled);
    expect(overlaps).toHaveLength(bounds.length - 1);
    const cache = new StateSpaceCache();
    for (const o of overlaps) {
      const r = await ask(compiled, 'closed', mutualExclusion(o.a, o.b), cache);
      const line = describeResult(`exclusive(${o.a.name},${o.b.name})`, r);
      expect(r.verdict.type, line).toBe('violated');
      expect(r.counterexampleConfirmed, line).toBe(true);
      expect(r.elapsedMs, line).toBeLessThan(BUDGET_MS);
    }
  });
});

describe('rule 8: no pipeline transition is unreachable from the arcs', () => {
  /** `unreachable(inputs ∪ reads)` of `t`, in `closed` — or in `cancel` when `t` reads the signal. */
  const reachability = async (compiled: CompiledWorkflow, names: readonly string[]): Promise<readonly (readonly [string, SmtVerificationResult])[]> => {
    const caches = { closed: new StateSpaceCache(), cancel: new StateSpaceCache() };
    const out: (readonly [string, SmtVerificationResult])[] = [];
    for (const name of names) {
      const t = transitionOf(compiled, name);
      const segment = t.reads.some((a) => a.place.name === compiled.cancel.name) ? 'cancel' : 'closed';
      const places = new Set<Place<unknown>>([...t.inputSpecs.map((s) => s.place as Place<unknown>), ...t.reads.map((a) => a.place as Place<unknown>)]);
      out.push([name, await ask(compiled, segment, unreachable(places), caches[segment])]);
    }
    return out;
  };

  // Breaks if: the gadget emits a transition no run can enable — the W0 spike's dead open-queue
  // `.again` settles were found by exactly this query, and no family catches one (they are not step
  // attempts). Each needs ≥ 2 lanes: one lane cannot record a failure beside another in flight.
  it.each([[[1, 1]], [[2, 1]], [[1, 1, 1]], [[2, 2]]] as const)('(%s): every declared transition is reachable, confirmed', async (bounds) => {
    const compiled = build(bounds);
    const names = siteTransitions(siteOf(compiled));
    const results = await reachability(compiled, names);
    expect(results).toHaveLength(names.length);
    for (const [name, r] of results) {
      const line = describeResult(`reachable(${name})`, r);
      expect(r.verdict.type, line).toBe('violated');
      expect(r.counterexampleConfirmed, line).toBe(true);
      expect(r.elapsedMs, line).toBeLessThan(BUDGET_MS);
    }
  });

  // Breaks if: the reachability query cannot tell a dead transition — it is the W0 amendment's own
  // finding: an open-queue `.again` fail settle (`queue.open + fault`) is dead, since
  // `exclusive(queue.open, fault)` is proven.
  // Breaks if: the one-lane gadget changes beyond its known dead transitions (ADR 0015, amended: the
  // maintainer keeps the gadget, as the one-lane foreach keeps its dead `.again`). One lane cannot
  // record a failure or suspension beside another, so the first sets a flag and closes the queue
  // with no item left to raise the other: each lane's closed-queue `.again` variants are dead, and so
  // are the two finishers taking both `fault` and `susp` — all four proven unreachable, every other
  // declared transition reachable, confirmed.
  it('(1): exactly the .again settles and the fault-and-susp finishers are dead, every other reachable', async () => {
    const compiled = build([1]);
    const site = siteOf(compiled);
    const names = siteTransitions(site);
    const bothFlags = site.finishers.filter((f) => {
      const inputs = transitionOf(compiled, f).inputSpecs.map((spec) => spec.place.name);
      return inputs.includes(site.fault) && inputs.includes(site.susp);
    });
    const dead = new Set([...site.lanes.flatMap((l) => [l.settles.fail[2], l.settles.suspend[2]]), ...bothFlags]);
    expect([...dead].sort()).toEqual([
      't.0.per-doc.canceled.fs',
      't.0.per-doc.fail.s',
      't.0.per-doc.stage0.lane0.fail.queue-closed.again',
      't.0.per-doc.stage0.lane0.suspend.queue-closed.again',
    ]);
    const results = await reachability(compiled, names);
    expect(results).toHaveLength(names.length);
    for (const [name, r] of results) {
      const line = describeResult(`reachable(${name})`, r);
      expect(r.elapsedMs, line).toBeLessThan(BUDGET_MS);
      if (dead.has(name)) expect(r.verdict.type, line).toBe('proven');
      else {
        expect(r.verdict.type, line).toBe('violated');
        expect(r.counterexampleConfirmed, line).toBe(true);
      }
    }
  });

  it('is not vacuous: the dead open-queue fail.again, added back, is proven unreachable', async () => {
    const compiled = build([1, 1]);
    const site = siteOf(compiled);
    const lane = site.lanes[1]!;
    const open = transitionOf(compiled, lane.settles.fail[0]);
    const again = rebuild(open, {
      inputs: open.inputSpecs.map((s) => (s.place.name === site.noFault ? one(placeOf(compiled, site.fault)) : s)),
    });
    const dead = Transition.builder(`${lane.settles.fail[0]}.again`)
      .inputs(...again.inputSpecs)
      .outputs(again.outputSpec!)
      .priority(again.priority)
      .action(again.action)
      .inhibitor(compiled.cancel)
      .build();
    const mutant = edited(compiled, {}, [dead]);
    const [[, r]] = (await reachability(mutant, [dead.name])) as [[string, SmtVerificationResult]];
    expect(r.verdict.type, describeResult(`reachable(${dead.name})`, r)).toBe('proven');
  });
});

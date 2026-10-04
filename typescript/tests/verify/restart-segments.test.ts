import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PetriNet, Transition, one, outPlace, place, type Out, type Place } from 'libpetri';
import { compile } from '../../src/compiler/index.js';
import {
  checkpointStructureViolations,
  describeClaim,
  describeReport,
  markingKey,
  resumeSegment,
  restartSegment,
  segmentInitialMarking,
  segmentLabel,
  segmentsFor,
  verify,
  verifyWorkflow,
  type Segment,
} from '../../src/verify/index.js';
import type { CompiledWorkflow, EntryDescription, StepDescription, WorkflowDescription } from '../../src/compiler/types.js';

/**
 * Restart segments ([ADR 0010]): every top-level boundary `p` proven as `restart@p` and
 * `restart@p+cancel`, the dedupe that proves a marking once and cites it under every label that
 * shares it, and the checkpoint structure check.
 *
 * **What is claimed, and from where.** For each compiled workflow below at budget `k` (1, 2, 4 and
 * unbounded), every completion property is `proven` — asserted as `verdict.type === 'proven'`, never
 * "not violated" — in `restart@p`, from `{in_p: 1[, wf.permits: k]}`, and `restart@p+cancel`, from
 * that plus `{wf.cancel.request: 1}`, whose immediate arrival may fire at every reachable point:
 * `deadlockFree` (strict; the six terminals, `wf.cancel` and the permits are sinks),
 * `terminatesAtSink`, `exactlyOneTerminal`, `neverCanceled` without a cancel, and with a budget
 * `permitsBounded(k)` and `permitsReturned(k)`. Environment: closed (the arrival is a transition).
 * Untimed, value-blind; each report names its route. Set `PROOF_LOG` to a file to record every line.
 * Figures come from libpetri 8.0.0 as installed from npm (not linked).
 *
 * The workflows that **mark** checkpoints need M4b W1's compiler (`compile({checkpoints})`); those
 * blocks are skipped, and say so, on a tree where it refuses them.
 *
 * **Not claimed here.** That a boundary marking is reachable from the fresh one (a restart segment is
 * proven from its seed); the decoder's mapping from a stored row to `p` (`restart-seed.test.ts`);
 * timing; loop termination (VER-002).
 */

const step = (id: string, extra: Partial<Omit<StepDescription, 'kind' | 'id'>> = {}): StepDescription => ({ kind: 'step', id, ...extra });
const fan = (id: string, arms: readonly StepDescription[]): EntryDescription => ({ kind: 'parallel', id, arms });
const branch = (id: string, arms: readonly StepDescription[]): EntryDescription => ({ kind: 'branch', id, arms });
const loop = (id: string, body: StepDescription, iterationBound = 2): EntryDescription => ({ kind: 'loop', id, loopType: 'dowhile', iterationBound, body });
const foreach = (id: string, body: StepDescription, concurrency = 2): EntryDescription => ({ kind: 'foreach', id, concurrency, body });
const sleep = (id: string, ms: number): EntryDescription => ({ kind: 'sleep', id, duration: { fixed: ms } });
const wf = (entries: readonly EntryDescription[], checkpoints?: readonly number[]): WorkflowDescription =>
  ({ id: 'w', entries, ...(checkpoints === undefined ? {} : { checkpoints }) });
const ids = (...names: string[]): StepDescription[] => names.map((n) => step(n));
const noop = async (): Promise<void> => {};

const proofLog = (line: string): void => {
  const file = process.env['PROOF_LOG'];
  if (file) appendFileSync(file, `${line}\n`);
};
const names = (c: CompiledWorkflow, seg: Segment): Record<string, number> =>
  Object.fromEntries([...segmentInitialMarking(c, seg)].map(([p, n]) => [p.name, n]));
const cancels = (seg: Segment): boolean => (typeof seg === 'string' ? seg === 'cancel' : seg.cancel);

/** Whether this tree's compiler emits checkpoints (M4b W1). */
const checkpointsCompile = ((): boolean => {
  try {
    compile({ id: 'probe', entries: ids('a', 'b'), checkpoints: [0] });
    return true;
  } catch {
    return false;
  }
})();

const series: readonly EntryDescription[] = [step('s'), fan('fan', ids('a', 'b')), branch('br', ids('c', 'd')), loop('l', step('e')), sleep('z', 5), foreach('each', step('x')), step('t')];

describe('segments', () => {
  const c = compile(wf(series), { concurrency: 2 });

  it('by default: closed, cancel, every resume site, then restart@p and restart@p+cancel for every boundary', () => {
    const labels = segmentsFor(c).map(segmentLabel);
    const resumes = [...c.resumeSites.keys()].flatMap((k) => [`resume@${k}`, `resume@${k}+cancel`]);
    const restarts = c.boundaries.flatMap((b) => [`restart@${b.index}`, `restart@${b.index}+cancel`]);
    expect(c.boundaries.map((b) => b.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(labels.slice(0, 2)).toEqual(['closed', 'cancel']);
    expect(new Set(labels.slice(2, 2 + resumes.length))).toEqual(new Set(resumes));
    expect(labels.slice(2 + resumes.length)).toEqual(restarts);
  });

  it("selects boundaries like 'resume' selects sites; an unknown index throws", () => {
    expect(segmentsFor(c, { resume: 'none', restart: 'none' })).toEqual(['closed', 'cancel']);
    expect(segmentsFor(c, { resume: 'none', restart: [3, 1] }).map(segmentLabel)).toEqual(['closed', 'cancel', 'restart@3', 'restart@3+cancel', 'restart@1', 'restart@1+cancel']);
    expect(() => segmentsFor(c, { restart: [7] })).toThrow("no top-level boundary 7 in workflow 'w' (boundaries: 0..6)");
    expect(() => segmentInitialMarking(c, restartSegment(1.5, false))).toThrow('no top-level boundary 1.5');
  });

  it('a restart segment prints as its label and compares by its fields', () => {
    const s = restartSegment(2, true);
    expect(`${s}`).toBe('restart@2+cancel');
    expect(s).toEqual({ restart: 2, cancel: true });
    expect(Object.keys(s)).toEqual(['restart', 'cancel']);
  });

  it('the initial marking is {in_p: 1, permits: k[, cancel request: 1]}; equal markings share a key', () => {
    expect(names(c, restartSegment(1, false))).toEqual({ 's.1.fan.in': 1, 'wf.permits': 2 });
    expect(names(c, restartSegment(1, true))).toEqual({ 's.1.fan.in': 1, 'wf.cancel.request': 1, 'wf.permits': 2 });
    const key = (seg: Segment) => markingKey(segmentInitialMarking(c, seg));
    expect(key(restartSegment(0, false))).toBe(key('closed'));
    expect(key(restartSegment(0, true))).toBe(key('cancel'));
    // A step's and a loop's resume site is its own input place; a block's is not.
    expect(key(restartSegment(3, false))).toBe(key(resumeSegment('3', false)));
    expect(key(restartSegment(6, true))).toBe(key(resumeSegment('6', true)));
    expect(key(restartSegment(1, false))).not.toBe(key(resumeSegment('1.0', false)));
    expect(key(restartSegment(5, false))).not.toBe(key(resumeSegment('5', false)));
  });
});

// =============================================================================================
// Proofs. Every restart segment of every shape, every property proven.
// =============================================================================================

const shapes: ReadonlyArray<readonly [string, readonly EntryDescription[]]> = [
  ['a chain with a timed retry', [step('a', { retries: 1, retryDelayMs: 5 }), step('b'), step('c')]],
  ['a parallel then a step', [step('a'), fan('fan', ids('x', 'y', 'z')), step('t')]],
  ['a branch then a loop', [branch('br', ids('c', 'd')), loop('l', step('e', { retries: 1 })), step('t')]],
  ['a sleep then a foreach', [sleep('z', 5), foreach('each', step('x')), step('t')]],
];

async function expectRestartsProven(label: string, c: CompiledWorkflow): Promise<number> {
  const segments = c.boundaries.flatMap((b) => [restartSegment(b.index, false), restartSegment(b.index, true)]);
  const t0 = performance.now();
  const reports = await verifyWorkflow(c, { segments, timeoutMs: 30_000 });
  const ms = performance.now() - t0;
  for (const r of reports) proofLog(`${label} ${describeReport(r)}`);
  expect(reports.map((r) => `${segmentLabel(r.segment)}/${r.property}`), label).toStrictEqual(
    segments.flatMap((seg) =>
      ['deadlockFree', 'terminatesAtSink', 'exactlyOneTerminal', ...(cancels(seg) ? [] : ['neverCanceled']), ...(c.budget ? ['permitsBounded', 'permitsReturned'] : [])].map(
        (property) => `${segmentLabel(seg)}/${property}`,
      ),
    ),
  );
  for (const r of reports) expect(r.result.verdict.type, `${label}: ${describeReport(r)}`).toBe('proven');
  return ms;
}

describe('restart@p and restart@p+cancel are proven at every boundary', () => {
  for (const [label, entries] of shapes) {
    for (const k of [1, 2, 4, undefined]) {
      it(`${label}, k=${k ?? 'unbounded'}`, async () => {
        const c = compile(wf(entries), k === undefined ? {} : { concurrency: k });
        await expectRestartsProven(`${label} k=${k ?? 'unbounded'}`, c);
      });
    }
  }
});

describe.skipIf(!checkpointsCompile)('marked workflows (needs M4b W1: compile({checkpoints}))', () => {
  for (const [label, entries] of shapes) {
    const marks = entries.map((_, i) => i).slice(0, -1);
    for (const k of [1, 2, 4, undefined]) {
      it(`${label}, a checkpoint after every entry, k=${k ?? 'unbounded'}: every segment proven`, async () => {
        const c = compile(wf(entries, marks), k === undefined ? {} : { concurrency: k });
        expect(checkpointStructureViolations(c)).toEqual([]);
        const reports = await verifyWorkflow(c, { timeoutMs: 30_000 });
        for (const r of reports) proofLog(`marked ${label} k=${k ?? 'unbounded'} ${describeReport(r)}`);
        expect(reports.map((r) => segmentLabel(r.segment))).toEqual(expect.arrayContaining(c.boundaries.map((b) => `restart@${b.index}+cancel`)));
        for (const r of reports) expect(r.result.verdict.type, describeReport(r)).toBe('proven');
      });
    }
  }

  it('verify: all four families hold on a marked workflow, restart segments included', async () => {
    const c = compile(wf([step('a'), fan('fan', ids('x', 'y')), step('t')], [0, 1]), { concurrency: 2 });
    const report = await verify(c, { timeoutMs: 30_000 });
    for (const claim of report.claims) proofLog(`marked verify ${describeClaim(claim)}`);
    for (const claim of report.claims) expect(claim.holds, describeClaim(claim)).toBe(true);
    expect(report.claims.filter((x) => x.kind === 'proof').every((x) => x.result.verdict.type === 'proven')).toBe(true);
    expect(report.segments.map(segmentLabel)).toContain('restart@2+cancel');
  });
});

// =============================================================================================
// Dedupe: one proof, cited under every label whose marking it is.
// =============================================================================================

describe('a marking shared by two segments is proven once and cited under both', () => {
  const c = compile(wf([step('a'), fan('fan', ids('x', 'y')), step('t')]), { concurrency: 2 });

  it('verifyWorkflow: restart@0 cites closed, restart@2 cites resume@2; restart@1 is asked', async () => {
    const reports = await verifyWorkflow(c, { timeoutMs: 30_000 });
    const at = (label: string, property: string) => {
      const r = reports.find((x) => segmentLabel(x.segment) === label && x.property === property);
      if (r === undefined) throw new Error(`no ${label}/${property}`);
      return r;
    };
    for (const r of reports) expect(r.result.verdict.type, describeReport(r)).toBe('proven');
    for (const [later, earlier] of [['restart@0', 'closed'], ['restart@0+cancel', 'cancel'], ['restart@2', 'resume@2'], ['restart@2+cancel', 'resume@2+cancel']] as const) {
      const cited = at(later, 'exactlyOneTerminal');
      const source = at(earlier, 'exactlyOneTerminal');
      expect(cited.result).toBe(source.result);
      expect(segmentLabel(cited.sameProofAs!)).toBe(earlier);
      expect(source.sameProofAs).toBeUndefined();
      expect(cited.marking).toBe(source.marking);
      expect(describeReport(cited)).toContain(`(the proof of ${earlier}, same marking)`);
    }
    expect(at('restart@1', 'deadlockFree').sameProofAs).toBeUndefined();
    expect(at('restart@1', 'deadlockFree').marking).toBe('{s.1.fan.in: 1, wf.permits: 2}');
  });

  it('verify: every family cites the same result; liveness stays closed-only', async () => {
    const report = await verify(c, { families: ['completion', 'bounds', 'exclusion', 'liveness'], timeoutMs: 30_000 });
    for (const claim of report.claims) expect(claim.holds, describeClaim(claim)).toBe(true);
    const of = (label: string) => report.claims.filter((x) => segmentLabel(x.segment) === label);
    const closed = of('closed').filter((x) => x.family !== 'liveness');
    const restart0 = of('restart@0');
    expect(restart0.map((x) => `${x.family}/${x.property}`)).toEqual(closed.map((x) => `${x.family}/${x.property}`));
    restart0.forEach((x, i) => {
      expect(x.result).toBe(closed[i]!.result);
      expect(segmentLabel(x.sameProofAs!)).toBe('closed');
    });
    expect(report.claims.filter((x) => x.family === 'liveness').every((x) => x.segment === 'closed')).toBe(true);
    expect(of('restart@1').every((x) => x.sameProofAs === undefined)).toBe(true);
    // One query set per distinct marking. Six of the sixteen segments repeat one: restart@0 (closed),
    // restart@2 (resume@2), and resume@0 (closed — a step's site at entry 0 is the entry place), each
    // with its +cancel twin.
    const distinct = new Set(report.segments.map((s) => markingKey(segmentInitialMarking(c, s))));
    expect(report.segments).toHaveLength(16);
    expect(distinct.size).toBe(10);
    const citing = new Set(report.claims.filter((x) => x.sameProofAs !== undefined).map((x) => `${segmentLabel(x.segment)}>${segmentLabel(x.sameProofAs!)}`));
    expect([...citing].sort()).toEqual([
      'restart@0+cancel>cancel', 'restart@0>closed', 'restart@2+cancel>resume@2+cancel', 'restart@2>resume@2', 'resume@0+cancel>cancel', 'resume@0>closed',
    ]);
  });
});

// =============================================================================================
// The checkpoint structure check. Negative controls on every compiled shape; mutants by hand.
// =============================================================================================

/** `c` with its transitions edited (a `null` drops one), `extra` added. */
function edited(c: CompiledWorkflow, edit: (t: Transition) => Transition | null = (t) => t, extra: readonly Transition[] = [], extraPlaces: readonly Place<unknown>[] = []): CompiledWorkflow {
  const transitions = [...[...c.net.transitions].map(edit).filter((t): t is Transition => t !== null), ...extra];
  return { ...c, net: PetriNet.builder(c.net.name).places(...c.net.places, ...extraPlaces).transitions(...transitions).build() };
}
function rebuild(t: Transition, change: { readonly output?: Out; readonly inhibitors?: readonly Place<unknown>[]; readonly reads?: readonly Place<unknown>[] } = {}): Transition {
  const b = Transition.builder(t.name).inputs(...t.inputSpecs).outputs(change.output ?? t.outputSpec!).action(t.action).timing(t.timing).priority(t.priority);
  for (const p of change.reads ?? t.reads.map((a) => a.place)) b.read(p);
  for (const arc of t.resets) b.reset(arc.place);
  for (const p of change.inhibitors ?? t.inhibitors.map((a) => a.place)) b.inhibitor(p);
  return b.build();
}

/**
 * A checkpoint after entry 0 added by hand to an unmarked compile, as ADR 0010 draws it: the write
 * inhibited by `wf.cancel` into entry 1's input, the sweep reading it into `wf.canceled`. Entry 0 is not re-wired
 * to the checkpoint place, which the structure check does not look at — it is a unit test of the
 * check, independent of W1's compiler.
 */
function handMarked(): CompiledWorkflow {
  const c = compile(wf([step('a'), step('b')]));
  const waiting = place<unknown>('s.0.checkpoint');
  const next = c.boundaries[1]!.place;
  const write = Transition.builder('t.0.checkpoint').inputs(one(waiting)).inhibitor(c.cancel).outputs(outPlace(next)).action(noop).build();
  const sweep = Transition.builder('t.0.checkpoint-cancel').inputs(one(waiting)).read(c.cancel).outputs(outPlace(c.terminals.canceled)).action(noop).build();
  return { ...edited(c, undefined, [write, sweep], [waiting]), checkpoints: [0] };
}

describe('checkpointStructureViolations', () => {
  const cleanShapes: ReadonlyArray<readonly [string, readonly EntryDescription[]]> = [...shapes, ['everything in series', series]];

  it.each(cleanShapes)('is clean on an unmarked compile: %s', (_label, entries) => {
    for (const k of [undefined, 1, 2]) expect(checkpointStructureViolations(compile(wf(entries), k === undefined ? {} : { concurrency: k }))).toEqual([]);
  });

  it('is clean on the hand-built checkpoint', () => {
    expect(checkpointStructureViolations(handMarked())).toEqual([]);
  });

  it('flags a checkpoint without its inhibitor on wf.cancel', async () => {
    const mutant = edited(handMarked(), (t) => (t.name === 't.0.checkpoint' ? rebuild(t, { inhibitors: [] }) : t));
    expect(checkpointStructureViolations(mutant)).toEqual(["checkpoint 't.0.checkpoint' is not inhibited by 'wf.cancel'"]);
    // The cancel check sees this one as well (an ungated start beside a sweep), and runs first.
    await expect(verifyWorkflow(mutant, { resume: 'none', restart: 'none' })).rejects.toThrow(/^cancellation structure is unsound/);
  });

  it('flags a checkpoint whose sweep was removed — which the cancel check cannot see', async () => {
    const mutant = edited(handMarked(), (t) => (t.name === 't.0.checkpoint-cancel' ? null : t));
    const line = "checkpoint 't.0.checkpoint' has no sweep 't.0.checkpoint-cancel'";
    expect(checkpointStructureViolations(mutant)).toEqual([line]);
    await expect(verifyWorkflow(mutant, { resume: 'none', restart: 'none' })).rejects.toThrow(`checkpoint structure is unsound:\n  ${line}`);
  });

  it('flags a sweep re-routed to wf.done, and one that lost its read arc', () => {
    const c = handMarked();
    const rerouted = edited(c, (t) => (t.name === 't.0.checkpoint-cancel' ? rebuild(t, { output: outPlace(c.terminals.done) }) : t));
    expect(checkpointStructureViolations(rerouted)).toEqual([
      "sweep 't.0.checkpoint-cancel' outputs into [wf.done]; its only output is 'wf.canceled'",
    ]);
    const blind = edited(c, (t) => (t.name === 't.0.checkpoint-cancel' ? rebuild(t, { reads: [] }) : t));
    expect(checkpointStructureViolations(blind)).toEqual(["sweep 't.0.checkpoint-cancel' does not read 'wf.cancel'"]);
  });

  it('flags a marked checkpoint with no transition, and a checkpoint transition after an unmarked entry', () => {
    const c = handMarked();
    expect(checkpointStructureViolations({ ...c, checkpoints: [] })).toEqual([
      "'t.0.checkpoint' is a checkpoint after an entry that is not marked",
      "'t.0.checkpoint-cancel' is a checkpoint after an entry that is not marked",
    ]);
    expect(checkpointStructureViolations({ ...compile(wf([step('a'), step('b')])), checkpoints: [0] })).toEqual([
      "checkpoint after entry 0 ('a') has no transition 't.0.checkpoint'",
    ]);
    expect(checkpointStructureViolations({ ...c, checkpoints: [1] })).toContain(
      'checkpoint after entry 1: a checkpoint is taken after a top-level entry other than the last (0..0)',
    );
  });

  it('flags a boundary that is not its entry’s input place', () => {
    const c = compile(wf([step('a'), step('b')]));
    const swapped = { ...c, boundaries: [c.boundaries[0]!, { ...c.boundaries[1]!, place: c.boundaries[0]!.place }] };
    expect(checkpointStructureViolations(swapped)).toEqual(["boundary 1 ('s.0.a.in') is not the input place of entry 1"]);
  });
});

describe.skipIf(!checkpointsCompile)('checkpointStructureViolations on compiled marked workflows (needs M4b W1)', () => {
  it.each(shapes)('is clean: %s, every entry marked', (_label, entries) => {
    const marks = entries.map((_, i) => i).slice(0, -1);
    for (const k of [undefined, 1, 2]) expect(checkpointStructureViolations(compile(wf(entries, marks), k === undefined ? {} : { concurrency: k }))).toEqual([]);
  });

  it('refutes the compiled sweep removed and the compiled inhibitor removed', () => {
    const c = compile(wf([step('a'), fan('fan', ids('x', 'y')), step('t')], [1]));
    expect(checkpointStructureViolations(edited(c, (t) => (t.name === 't.1.checkpoint-cancel' ? null : t)))).toEqual([
      "checkpoint 't.1.checkpoint' has no sweep 't.1.checkpoint-cancel'",
    ]);
    expect(checkpointStructureViolations(edited(c, (t) => (t.name === 't.1.checkpoint' ? rebuild(t, { inhibitors: [] }) : t)))).toEqual([
      "checkpoint 't.1.checkpoint' is not inhibited by 'wf.cancel'",
    ]);
  });
});

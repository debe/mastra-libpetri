import {
  Transition,
  and,
  enumerateBranches,
  one,
  outPlace,
  place,
  xor,
  type Out,
  type Place,
  type TransitionAction,
} from 'libpetri';
import { afterAll, describe, expect, it } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { branchGadget, type ArmArrival, type GateToken } from '../../src/compiler/gadgets/branch.js';
import type { Gadget } from '../../src/compiler/gadgets/types.js';
import type {
  CompiledWorkflow,
  EntryDescription,
  FailureToken,
  FlowToken,
  StepDescription,
  WorkflowDescription,
} from '../../src/compiler/types.js';
import { runWorkflow } from '../../src/engine/index.js';
import {
  cancelStructureViolations,
  describeReport,
  resumeGateViolations,
  segmentLabel,
  segmentsFor,
  verifyWorkflow,
  type PropertyReport,
  type Segment,
} from '../../src/verify/index.js';
import { RecordingRunner } from '../fixtures/runner.js';
import { ManualClock } from '../support/manual-clock.js';

const step = (id: string, extra: Omit<StepDescription, 'kind' | 'id'> = {}): StepDescription => ({
  kind: 'step',
  id,
  ...extra,
});
const branch = (id: string, ...arms: StepDescription[]): EntryDescription => ({ kind: 'branch', id, arms });
const workflow = (...entries: EntryDescription[]): WorkflowDescription => ({ id: 'triage', entries });
const arms = (k: number): StepDescription[] => Array.from({ length: k }, (_, i) => step(`arm${i}`));

/** The property set `verifyWorkflow` proves in a segment with no cancel arriving, and in one with. */
const UNCANCELED = ['deadlockFree', 'terminatesAtSink', 'exactlyOneTerminal', 'neverCanceled'] as const;
const CANCELED = ['deadlockFree', 'terminatesAtSink', 'exactlyOneTerminal'] as const;
const cancels = (segment: Segment): boolean => (typeof segment === 'string' ? segment === 'cancel' : segment.cancel);
const keyOf = (r: PropertyReport): string => `${segmentLabel(r.segment)}/${r.property}`;

/**
 * Every `segment/property` key `verifyWorkflow` proves by default, in its order: `closed`,
 * `cancel`, then `resume@s` and `resume@s+cancel` for every resume site ([ADR 0007]).
 */
const everyReport = (compiled: CompiledWorkflow): string[] =>
  segmentsFor(compiled).flatMap((segment) => (cancels(segment) ? CANCELED : UNCANCELED).map((p) => `${segmentLabel(segment)}/${p}`));

/**
 * Proves a compiled net through `verifyWorkflow`'s default — the structural checks, then every
 * segment on the same closed net: `closed` (no cancel ever arrives, so `wf.canceled` is never
 * marked either), `cancel` (one cancel request seeded, and its arrival free to fire at every
 * reachable point), and `resume@s` / `resume@s+cancel` from each resume site — every arm of a
 * branch, and every top-level step ([ADR 0007]). Every report `proven`, asserted explicitly:
 * `isViolated()` is false on `unknown` too.
 */
async function expectProvenBoth(compiled: CompiledWorkflow, timeoutMs = 30_000): Promise<readonly PropertyReport[]> {
  const reports = await verifyWorkflow(compiled, { timeoutMs });
  expect(reports.map(keyOf)).toEqual(everyReport(compiled));
  for (const report of reports) expect(report.result.verdict.type, describeReport(report)).toBe('proven');
  return reports;
}

const verdictOf = (reports: readonly PropertyReport[], segment: Segment, property: string): string => {
  const report = reports.find((r) => r.segment === segment && r.property === property);
  if (report === undefined) throw new Error(`no ${segment}/${property} report`);
  return report.result.verdict.type;
};

const inSegment = (reports: readonly PropertyReport[], segment: Segment): readonly PropertyReport[] =>
  reports.filter((r) => r.segment === segment);

/**
 * Every proof below is over the net `compile()` builds, from one token in the entry place, with
 * all six workflow terminals and the cancel place declared as sinks (`verifyWorkflow`), proved in
 * both segments: `closed`, and `cancel` with one request seeded whose arrival may fire at every
 * reachable point. Verification is value-blind, so each gate's run *and* skip legs, and each
 * arm's five outcomes, are all explored — the proofs cover every subset of truthy arms, every mix
 * of arm outcomes and, under cancel, every point at which the abort can land.
 */
const shapes: ReadonlyArray<readonly [string, WorkflowDescription]> = [
  ['one arm, last entry', workflow(branch('route', ...arms(1)))],
  ['two arms, last entry', workflow(branch('route', ...arms(2)))],
  ['three arms, last entry', workflow(branch('route', ...arms(3)))],
  ['four arms, last entry', workflow(branch('route', ...arms(4)))],
  ['two arms, middle entry', workflow(step('validate'), branch('route', ...arms(2)), step('audit'))],
  ['two branches in sequence', workflow(branch('first', ...arms(2)), branch('second', step('x'), step('y')))],
  ['empty branch, middle entry', workflow(step('validate'), branch('route'), step('audit'))],
  ['empty branch, last entry', workflow(branch('route'))],
  [
    // A delayed retry makes the net timed, which rules out the enumeration route ([VER-017] is
    // untimed-only) and forces the SMT pipeline, so both routes are exercised.
    'arms with delayed retries (timed, SMT route)',
    workflow(branch('route', step('a', { retries: 1, retryDelayMs: 50 }), step('b', { retries: 2 }))),
  ],
];

describe('compiled branch, proved', () => {
  for (const [label, description] of shapes) {
    it(`every property, both segments: ${label}`, async () => {
      await expectProvenBoth(compile(description));
    }, 600_000);
  }

  it('takes the SMT route for the timed shape in both segments, and enumerates the untimed one', async () => {
    const timed = await expectProvenBoth(compile(shapes[shapes.length - 1]![1]));
    for (const report of timed) expect(report.result.route, describeReport(report)).toBe('smt');
    // The cancel segment of an untimed block is a closed net too, so it enumerates.
    const untimed = await expectProvenBoth(compile(shapes[1]![1]));
    for (const report of untimed) expect(report.result.route, describeReport(report)).toBe('enumeration');
  }, 600_000);
});

// ===================== scaling in the number of arms =====================

interface SizeRow {
  readonly arms: number;
  readonly transitions: number;
  readonly branches: number;
  readonly places: number;
  readonly closed: string;
  readonly cancel: string;
}
const sizeRows: SizeRow[] = [];

/**
 * Measured, so the IO-016 split threshold can be chosen from numbers rather than assumed. No
 * transition here declares an `and` of `xor`s, so the enumerated branch count is linear in the
 * number of arms; what grows exponentially is the reachable state space, because every subset of
 * arms and every interleaving is genuinely reachable.
 */
describe('compiled branch, scaling in the number of arms', () => {
  for (const k of [1, 2, 3, 4, 5, 6]) {
    it(`proves every property of both segments with ${k} arm(s), and counts the net`, async () => {
      const compiled = compile(workflow(branch('route', ...arms(k))));
      const transitions = [...compiled.net.transitions];
      const branches = transitions.reduce((sum, t) => sum + enumerateBranches(t.outputSpec!).length, 0);

      const reports = await expectProvenBoth(compiled, 30_000);

      // Block: decide, its sweep, four exit collects, three joins — 9; per arm gate-i, collect-i,
      // the arm's run, and the resume trio replay-i, re-enter-i and its sweep re-enter-i.cancel
      // ([ADR 0007]) — 6k; ten for the settle stage and one for the cancel arrival. Branches:
      // decide 2, each gate 2, each arm 5, each replay 3, each re-enter 2, every other transition 1.
      expect(transitions).toHaveLength(6 * k + 9 + 11);
      expect(branches).toBe(14 * k + 10 + 11);
      const cell = (segment: Segment) => {
        const rs = inSegment(reports, segment);
        return `${[...new Set(rs.map((r) => r.result.route))].join('/')} ${rs.map((r) => Math.round(r.result.elapsedMs)).join('+')}ms`;
      };
      sizeRows.push({
        arms: k,
        transitions: transitions.length,
        branches,
        places: compiled.net.places.size,
        closed: cell('closed'),
        cancel: cell('cancel'),
      });
    }, 1_800_000);
  }

  afterAll(() => {
    if (sizeRows.length > 0) console.table([...sizeRows].sort((a, b) => a.arms - b.arms));
  });
});

// ===================== non-vacuity: every safeguard is load-bearing =====================

/**
 * A copy of `branchGadget` with one of its transitions rebuilt. The mutation lives in the test,
 * through the `gadgets` override, so the source is never edited to demonstrate a failure.
 */
function mutating(role: string, rebuild: (t: Transition, places: PlaceIndex) => readonly Transition[]): Gadget {
  return (entry, next, ctx) => {
    const result = branchGadget(entry, next, ctx);
    const index = placeIndex(result.transitions);
    let hit = 0;
    const transitions = result.transitions.flatMap((t) => {
      if (!t.name.endsWith(`.${role}`)) return [t];
      hit += 1;
      return rebuild(t, index);
    });
    expect(hit, `mutation target '${role}'`).toBe(1);
    return { ...result, transitions };
  };
}

type PlaceIndex = (role: string) => Place<unknown>;

/** Finds a place of the branch block by its role suffix, from the arcs of its transitions. */
function placeIndex(transitions: readonly Transition[]): PlaceIndex {
  const all = new Map<string, Place<unknown>>();
  for (const t of transitions) {
    for (const spec of t.inputSpecs) all.set(spec.place.name, spec.place);
    for (const arc of [...t.inhibitors, ...t.resets, ...t.reads]) all.set(arc.place.name, arc.place);
    for (const p of t.outputPlaces()) all.set(p.name, p);
  }
  return (role) => {
    const found = [...all.values()].find((p) => p.name.startsWith('s.0.') && p.name.endsWith(`.${role}`));
    if (found === undefined) throw new Error(`no place with role '${role}'`);
    return found;
  };
}

interface Change {
  readonly inputs?: Transition['inputSpecs'];
  readonly outputs?: Out;
  readonly dropInhibitor?: string;
  readonly dropReset?: string;
  readonly action?: TransitionAction;
}

/** The same transition with one arc changed, or its outputs and action replaced as a pair. */
function rebuilt(t: Transition, change: Change): Transition {
  const builder = Transition.builder(t.name)
    .inputs(...(change.inputs ?? t.inputSpecs))
    .outputs(change.outputs ?? t.outputSpec!)
    .timing(t.timing)
    .priority(t.priority)
    .action(change.action ?? t.action);
  for (const arc of t.inhibitors) if (!arc.place.name.endsWith(`.${change.dropInhibitor}`)) builder.inhibitor(arc.place);
  for (const arc of t.resets) if (!arc.place.name.endsWith(`.${change.dropReset}`)) builder.reset(arc.place);
  for (const arc of t.reads) builder.read(arc.place);
  return builder.build();
}

const twoArms = workflow(branch('route', step('a'), step('b')));

/** A join mutant is a closed-segment defect: it shows without any cancel arriving. */
async function verifyMutant(gadget: Gadget): Promise<readonly PropertyReport[]> {
  return verifyWorkflow(compile(twoArms, { gadgets: { branch: gadget } }), { timeoutMs: 30_000, segments: ['closed'] });
}

describe('compiled branch, non-vacuity', () => {
  it('the unmutated two-arm block is the baseline: every property of both segments proven', async () => {
    await expectProvenBoth(compile(twoArms));
  }, 300_000);

  it("join-ok's inhibitor on the failure marker: without it a failed block can succeed and strand the marker", async () => {
    const reports = await verifyMutant(mutating('join-ok', (t) => [rebuilt(t, { dropInhibitor: 'err-seen' })]));
    expect(verdictOf(reports, 'closed', 'deadlockFree')).toBe('violated');
  });

  it("join-ok's inhibitor on the suspension marker: without it a suspended block can succeed", async () => {
    const reports = await verifyMutant(mutating('join-ok', (t) => [rebuilt(t, { dropInhibitor: 'susp-seen' })]));
    expect(verdictOf(reports, 'closed', 'deadlockFree')).toBe('violated');
  });

  it("join-susp's inhibitor on the failure marker: without it failed no longer outranks suspended", async () => {
    const reports = await verifyMutant(mutating('join-susp', (t) => [rebuilt(t, { dropInhibitor: 'err-seen' })]));
    expect(verdictOf(reports, 'closed', 'deadlockFree')).toBe('violated');
  });

  it("join-fail's reset of the suspension marker: without it a failure beside a suspension strands a token", async () => {
    const mutant = mutating('join-fail', (t) => [rebuilt(t, { dropReset: 'susp-seen' })]);

    const reports = await verifyMutant(mutant);
    expect(verdictOf(reports, 'closed', 'deadlockFree')).toBe('violated');

    const runner = new RecordingRunner({
      steps: { a: () => ({ status: 'failed', error: 'down' }), b: () => ({ status: 'suspended', suspendPayload: 'wait' }) },
      branches: { route: () => [0, 1] },
    });
    const outcome = await runWorkflow(compile(twoArms, { gadgets: { branch: mutant } }), 'x', { runner });
    expect(outcome).toEqual({ status: 'failed', stepId: 'a', path: [0, 0], error: 'down', residue: ['s.0.route.susp-seen'] });
  });

  it("join-fail's all() on the failure marker: consuming one leaves the others behind", async () => {
    const mutant = mutating('join-fail', (t, p) => [
      rebuilt(t, { inputs: t.inputSpecs.map((spec) => (spec.type === 'all' ? one(p('err-seen')) : spec)) }),
    ]);

    const reports = await verifyMutant(mutant);
    expect(verdictOf(reports, 'closed', 'deadlockFree')).toBe('violated');

    const runner = new RecordingRunner({
      steps: { a: () => ({ status: 'failed', error: 'a' }), b: () => ({ status: 'failed', error: 'b' }) },
      branches: { route: () => [0, 1] },
    });
    const outcome = await runWorkflow(compile(twoArms, { gadgets: { branch: mutant } }), 'x', { runner });
    expect(outcome).toHaveProperty('residue', ['s.0.route.err-seen']);
  });

  it("join-susp's all() on the suspension marker: consuming one leaves the others behind", async () => {
    const mutant = mutating('join-susp', (t, p) => [
      rebuilt(t, { inputs: t.inputSpecs.map((spec) => (spec.type === 'all' ? one(p('susp-seen')) : spec)) }),
    ]);

    const reports = await verifyMutant(mutant);
    expect(verdictOf(reports, 'closed', 'deadlockFree')).toBe('violated');
  });

  it("collect-err's arrival deposit: without it a failing arm never counts and the join never fires", async () => {
    const mutant = mutating('collect-err', (t, p) => {
      const armErr = p('arm-err') as Place<FailureToken>;
      const errSeen = p('err-seen') as Place<FailureToken>;
      return [
        rebuilt(t, {
          outputs: outPlace(errSeen),
          action: async (tctx) => {
            tctx.output(errSeen, tctx.input(armErr));
          },
        }),
      ];
    });

    const reports = await verifyMutant(mutant);
    expect(verdictOf(reports, 'closed', 'deadlockFree')).toBe('violated');
    expect(verdictOf(reports, 'closed', 'terminatesAtSink')).toBe('violated');

    const runner = new RecordingRunner({
      steps: { a: () => ({ status: 'failed', error: 'down' }) },
      branches: { route: () => [0, 1] },
    });
    const outcome = await runWorkflow(compile(twoArms, { gadgets: { branch: mutant } }), 'x', { runner });
    expect(outcome.status).toBe('stranded');
  });

  it("a skip's arrival deposit: a skipped arm that does not arrive stalls the join", async () => {
    const mutant = mutating('gate-1', (t) => {
      const gateIn = t.inputSpecs[0]!.place as Place<GateToken>;
      const armIn = [...t.outputPlaces()].find((p) => p.name.startsWith('s.0-1.'))! as Place<FlowToken>;
      const nowhere = place<ArmArrival>('s.0.route.skipped-nowhere');
      return [
        rebuilt(t, {
          outputs: xor(outPlace(armIn), outPlace(nowhere)),
          action: async (tctx) => {
            const gate = tctx.input(gateIn);
            if (gate.decision === 'run') tctx.output(armIn, { data: gate.data });
            else tctx.output(nowhere, { status: 'skipped' });
          },
        }),
      ];
    });

    const reports = await verifyMutant(mutant);
    expect(verdictOf(reports, 'closed', 'deadlockFree')).toBe('violated');

    const runner = new RecordingRunner({ branches: { route: () => [0] } });
    const outcome = await runWorkflow(compile(twoArms, { gadgets: { branch: mutant } }), 'x', { runner });
    expect(outcome.status).toBe('stranded');
  });

  it('one firing for the arrival and the failure marker: split in two, join-ok can win the race', async () => {
    // The race-freedom argument is that `collect-err` deposits both in one firing. Splitting it
    // opens a marking with n arrivals and the failure marker still pending, where `join-ok`
    // fires and the marker then lands in an empty block.
    const mutant = mutating('collect-err', (t, p) => {
      const armErr = p('arm-err') as Place<FailureToken>;
      const arrived = p('arrived') as Place<ArmArrival>;
      const errSeen = p('err-seen') as Place<FailureToken>;
      const pending = place<FailureToken>('s.0.route.err-pending');
      return [
        rebuilt(t, {
          outputs: and(outPlace(arrived), outPlace(pending)),
          action: async (tctx) => {
            tctx.output(arrived, { status: 'failed' });
            tctx.output(pending, tctx.input(armErr));
          },
        }),
        Transition.builder('t.0.route.relay-err')
          .inputs(one(pending))
          .outputs(outPlace(errSeen))
          .action(async (tctx) => {
            tctx.output(errSeen, tctx.input(pending));
          })
          .build(),
      ];
    });

    const reports = await verifyMutant(mutant);
    expect(verdictOf(reports, 'closed', 'deadlockFree')).toBe('violated');
  });
});

// ===================== non-vacuity of the cancellation safeguards =====================

/** The block without one transition, by role. */
function dropping(role: string): Gadget {
  return (entry, next, ctx) => {
    const result = branchGadget(entry, next, ctx);
    // By the block's own name: an arm's resume sweep also ends in `.cancel` ([ADR 0007]).
    const transitions = result.transitions.filter((t) => !t.name.endsWith(`.${entry.id}.${role}`));
    expect(result.transitions.length - transitions.length, `drop target '${role}'`).toBe(1);
    return { ...result, transitions };
  };
}

/**
 * The block with **every** inhibitor on the cancel signal stripped from its own transitions — the
 * pattern each gadget is held to: whatever the block gates, stripping it must be flagged by the
 * structural check, naming the transition.
 */
const ungatedEverywhere: Gadget = (entry, next, ctx) => {
  const result = branchGadget(entry, next, ctx);
  const cancel = ctx.cancel;
  if (cancel === undefined) return result;
  const transitions = result.transitions.map((t) =>
    t.inhibitors.some((arc) => arc.place.name === cancel.name) ? rebuilt(t, { dropInhibitor: 'cancel' }) : t,
  );
  return { ...result, transitions };
};

/**
 * The gated-arms mutant: every arm emitted **with** the cancel signal, so each arm's first attempt
 * is inhibited by it and gets a sweep of its own. That is a check Mastra does not make — once the
 * conditions are evaluated every truthy arm runs (`handlers/control-flow.ts:497-593`, no abort
 * check between the filter and `Promise.all`).
 */
const gatedArms: Gadget = (entry, next, ctx) =>
  branchGadget(entry, next, {
    ...ctx,
    emitNested: (s, path, armNext, exits, options) =>
      ctx.emitNested(s, path, armNext, exits, { ...options, ...(ctx.cancel === undefined ? {} : { cancel: ctx.cancel }) }),
  });

const verdicts = (reports: readonly PropertyReport[]): Record<string, string> =>
  Object.fromEntries(reports.map((r) => [keyOf(r), r.result.verdict.type]));

/**
 * Each cancellation safeguard the block adds, removed in turn through the `gadgets` override,
 * with what catches its removal: a proof, the structural check, or only a run.
 */
describe('compiled branch, cancellation safeguards are load-bearing', () => {
  const prepThen = (b: EntryDescription) => workflow(step('prep'), b);

  for (const [label, description, blockAfterPrep] of [
    ['two arms', twoArms, branch('route', step('a'), step('b'))],
    ['empty block', workflow(branch('route'), step('audit')), branch('route')],
  ] as const) {
    it(`the sweep: without it a cancel strands the waiting input (${label})`, async () => {
      const mutant = compile(description, { gadgets: { branch: dropping('cancel') } });

      // Not a structural violation — the check is about a start that *competes* with a sweep, and
      // there is no sweep left. The cancel segment is what refutes it.
      expect(cancelStructureViolations(mutant)).toEqual([]);
      const reports = await verifyWorkflow(mutant, { timeoutMs: 30_000 });
      expect(verdicts(reports), reports.map(describeReport).join('; ')).toMatchObject({
        'closed/deadlockFree': 'proven',
        'closed/terminatesAtSink': 'proven',
        'closed/exactlyOneTerminal': 'proven',
        'closed/neverCanceled': 'proven',
        'cancel/deadlockFree': 'violated',
        'cancel/exactlyOneTerminal': 'violated',
      });

      // And in a run: aborted by the entry before the block, the input waits forever behind the
      // inhibitor, no terminal is marked, and the run ends only at the harness timeout. (Aborted
      // mid-run rather than before it: a pre-aborted run currently races the arrival against the
      // first entry's start — see the kernel note in the compiler tests.)
      const run = (compiled: CompiledWorkflow) => {
        const ac = new AbortController();
        const runner = new RecordingRunner({
          steps: { prep: (x) => { ac.abort(); return { status: 'success', output: x }; } },
          branches: { route: () => [0] },
        });
        return { runner, done: runWorkflow(compiled, 'x', { runner, signal: ac.signal, timeoutMs: 300 }) };
      };
      const real = run(compile(prepThen(blockAfterPrep)));
      expect(await real.done).toEqual({ status: 'canceled', origin: { stepId: 'route', path: [1] }, started: false });
      const swept = run(compile(prepThen(blockAfterPrep), { gadgets: { branch: dropping('cancel') } }));
      await expect(swept.done).rejects.toThrow();
      expect(swept.runner.calls).toEqual(['prep']);
    }, 300_000);
  }

  for (const [label, description, role, expectedCalls] of [
    ['decide', prepThen(branch('route', step('a'), step('b'))), 'decide', ['prep', 'a']],
    ['pass (empty block)', workflow(step('prep'), branch('route'), step('audit')), 'pass', ['prep']],
  ] as const) {
    it(`${label}'s inhibitor: without it the block starts after the abort — flagged structurally, flipped in a run`, async () => {
      const ungated: Gadget = mutating(role, (t) => [rebuilt(t, { dropInhibitor: 'cancel' })]);
      const mutant = compile(description, { gadgets: { branch: ungated } });

      // No quiescence property can see this — an ungated start still ends in exactly one terminal,
      // re-stamped canceled after the block — so the structural check is what refuses it, and
      // `verifyWorkflow` refuses to prove it at all.
      const violations = cancelStructureViolations(mutant);
      expect(violations).toEqual([
        `'t.1.route.${role}' competes with sweep 't.1.route.cancel' for [s.1.route.in] without an inhibitor on 'wf.cancel'`,
      ]);
      await expect(verifyWorkflow(mutant, { timeoutMs: 1_000 })).rejects.toThrow(/t\.1\.route\.\w+' competes with sweep/);
      expect(cancelStructureViolations(compile(description))).toEqual([]);

      const runOnce = async (compiled: CompiledWorkflow) => {
        const ac = new AbortController();
        const runner = new RecordingRunner({
          steps: { prep: (x) => { ac.abort(); return { status: 'success', output: x }; } },
          branches: { route: () => [0] },
        });
        const outcome = await runWorkflow(compiled, 'x', { runner, signal: ac.signal, clock: new ManualClock(), timeoutMs: 5_000 });
        return { outcome, calls: runner.calls };
      };

      // The real block stops at its own check; the mutant starts and runs what it selected.
      expect(await runOnce(compile(description))).toEqual({
        outcome: { status: 'canceled', origin: { stepId: 'route', path: [1] }, started: false },
        calls: ['prep'],
      });
      const flipped = await runOnce(mutant);
      expect(flipped.calls).toEqual(expectedCalls);
      // `not.toMatchObject`, not `not.toEqual` with the new `started` key: an extra or missing key
      // must not make this negative pass on its own — the claim is the block's own check never fired.
      expect(flipped.outcome).not.toMatchObject({ status: 'canceled', origin: { stepId: 'route', path: [1] } });
    }, 600_000);
  }

  it('every cancel inhibitor the block adds is structurally load-bearing: stripped, each is named', () => {
    // The block gates exactly its start — `decide`, or `pass` when it has no arms — and each arm's
    // resume gate `re-enter-i` ([ADR 0007]), which competes with its own sweep. The join's
    // inhibitors are on its own markers, not on the signal, and the arms are ungated by design.
    for (const [description, expected] of [
      [twoArms, ['t.0.route.decide', 't.0.route.re-enter-0', 't.0.route.re-enter-1']],
      [
        prepThen(branch('route', step('a'), step('b'), step('c'))),
        ['t.1.route.decide', 't.1.route.re-enter-0', 't.1.route.re-enter-1', 't.1.route.re-enter-2'],
      ],
      [workflow(branch('route'), step('audit')), ['t.0.route.pass']],
    ] as const) {
      const real = compile(description);
      const gatedByBlock = [...real.net.transitions]
        .filter((t) => /^t\.\d+\.route\./.test(t.name) && t.inhibitors.some((arc) => arc.place.name === real.cancel.name))
        .map((t) => t.name);
      expect(gatedByBlock).toEqual(expected);

      const stripped = cancelStructureViolations(compile(description, { gadgets: { branch: ungatedEverywhere } }));
      expect(stripped).toHaveLength(expected.length);
      for (const name of expected) expect(stripped.some((line) => line.startsWith(`'${name}' competes with sweep`)), name).toBe(true);
    }
  });

  describe('the gated-arms mutant (arms given the cancel signal)', () => {
    const middle = workflow(step('prep'), branch('route', step('a'), step('b')), step('audit'));
    const last = workflow(branch('route', step('a'), step('b')));

    /** A condition that aborts the run and then selects both arms — Mastra's `abort()` in a condition. */
    const abortingCondition = async (compiled: CompiledWorkflow) => {
      const ac = new AbortController();
      const runner = new RecordingRunner({ branches: { route: () => { ac.abort(); return [0, 1]; } } });
      const report = await runWorkflow(compiled, 'x', { runner, signal: ac.signal, clock: new ManualClock(), timeoutMs: 5_000 });
      return { outcome: report, calls: [...runner.calls].sort() };
    };

    it('passes the structural check: gating the arms adds inhibitors, it removes none', () => {
      for (const description of [middle, last, twoArms]) {
        const mutant = compile(description, { gadgets: { branch: gatedArms } });
        // The mutant really is gated: each arm's first attempt now carries the inhibitor.
        const gatedArmStarts = [...mutant.net.transitions].filter(
          (t) => /^t\.\d+-\d\./.test(t.name) && t.inhibitors.some((arc) => arc.place.name === mutant.cancel.name),
        );
        expect(gatedArmStarts.length).toBeGreaterThanOrEqual(2);
        expect(cancelStructureViolations(mutant)).toEqual([]);
        expect(resumeGateViolations(mutant)).toEqual([]);
      }
    });

    it('flips the run in which a condition aborts, as a middle and as a last entry', async () => {
      const realMiddle = await abortingCondition(compile(middle));
      expect(realMiddle).toEqual({
        outcome: { status: 'canceled', origin: { stepId: 'audit', path: [2] }, started: false },
        calls: ['a', 'b', 'prep'],
      });
      const realLast = await abortingCondition(compile(last));
      expect(realLast).toEqual({ outcome: { status: 'canceled', started: true }, calls: ['a', 'b'] });

      // The mutant sweeps both arms: neither runs, and the swept arms never arrive at the join.
      const mutantMiddle = await abortingCondition(compile(middle, { gadgets: { branch: gatedArms } }));
      expect(mutantMiddle.calls).toEqual(['prep']);
      expect(mutantMiddle.outcome).not.toEqual(realMiddle.outcome);
      const mutantLast = await abortingCondition(compile(last, { gadgets: { branch: gatedArms } }));
      expect(mutantLast.calls).toEqual([]);
      expect(mutantLast.outcome).not.toEqual(realLast.outcome);
    });

    it('is refuted by the cancel segment, and invisible to the closed one', async () => {
      // A swept arm writes the enclosing `canceled` exit and never reaches `arrived`: two
      // terminals (or one beside a stuck join) at quiescence. With no cancel arriving, the gate
      // never matters, so every closed report stays proven.
      // Measured last phase at 152s-243s via SMT, `unknown` on some properties; the cancel segment
      // now enumerates and refutes it in milliseconds, so the proof is a flip of its own.
      // Resumed at an arm: with no cancel the gate never matters either. With one, a cancel
      // landing after `re-enter-i` sweeps the gated arm to `canceled` and it never arrives, so the
      // sibling's replayed arrival is stranded beside the one terminal — deadlockFree sees it,
      // exactlyOneTerminal (still one terminal) does not. Resumed at `prep`, the entry place
      // itself, the segment starts where the fresh one does and sees what it sees; resumed at
      // `audit`, past the block, nothing gated by the mutant is left to run.
      const armSegments = (site: string) => ({
        [`resume@${site}/deadlockFree`]: 'proven',
        [`resume@${site}/terminatesAtSink`]: 'proven',
        [`resume@${site}/exactlyOneTerminal`]: 'proven',
        [`resume@${site}/neverCanceled`]: 'proven',
        [`resume@${site}+cancel/deadlockFree`]: 'violated',
        [`resume@${site}+cancel/terminatesAtSink`]: 'proven',
        [`resume@${site}+cancel/exactlyOneTerminal`]: 'proven',
      });
      const asFresh = (site: string) => ({
        [`resume@${site}/deadlockFree`]: 'proven',
        [`resume@${site}/terminatesAtSink`]: 'proven',
        [`resume@${site}/exactlyOneTerminal`]: 'proven',
        [`resume@${site}/neverCanceled`]: 'proven',
        [`resume@${site}+cancel/deadlockFree`]: 'violated',
        [`resume@${site}+cancel/terminatesAtSink`]: 'proven',
        [`resume@${site}+cancel/exactlyOneTerminal`]: 'violated',
      });
      const allProven = (site: string) => ({
        [`resume@${site}/deadlockFree`]: 'proven',
        [`resume@${site}/terminatesAtSink`]: 'proven',
        [`resume@${site}/exactlyOneTerminal`]: 'proven',
        [`resume@${site}/neverCanceled`]: 'proven',
        [`resume@${site}+cancel/deadlockFree`]: 'proven',
        [`resume@${site}+cancel/terminatesAtSink`]: 'proven',
        [`resume@${site}+cancel/exactlyOneTerminal`]: 'proven',
      });
      for (const [description, resumed] of [
        [twoArms, { ...armSegments('0.0'), ...armSegments('0.1') }],
        [middle, { ...asFresh('0'), ...armSegments('1.0'), ...armSegments('1.1'), ...allProven('2') }],
      ] as const) {
        const reports = await verifyWorkflow(compile(description, { gadgets: { branch: gatedArms } }), { timeoutMs: 30_000 });
        expect(verdicts(reports), reports.map(describeReport).join('; ')).toEqual({
          'closed/deadlockFree': 'proven',
          'closed/terminatesAtSink': 'proven',
          'closed/exactlyOneTerminal': 'proven',
          'closed/neverCanceled': 'proven',
          'cancel/deadlockFree': 'violated',
          // A marked `wf.cancel` is a sink, so a stuck join beside it still "terminates at a sink".
          'cancel/terminatesAtSink': 'proven',
          'cancel/exactlyOneTerminal': 'violated',
          ...resumed,
        });
        for (const r of reports) expect(r.result.route, describeReport(r)).toBe('enumeration');
      }
    }, 300_000);
  });
});

describe('compiled branch, a compiled net serves any runner', () => {
  it('verifies the same net it runs: one CompiledWorkflow, proved and then executed', async () => {
    const compiled: CompiledWorkflow = compile(workflow(step('validate'), branch('route', ...arms(3)), step('audit')));
    await expectProvenBoth(compiled);

    const runner = new RecordingRunner({ branches: { route: () => [0, 2] } });
    const outcome = await runWorkflow(compiled, 'in', { runner });
    expect(outcome).toStrictEqual({ status: 'success', output: { arm0: 'in', arm1: undefined, arm2: 'in' } });
  }, 300_000);
});

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
import { describeReport, verifyWorkflow, type PropertyReport } from '../../src/verify/index.js';
import { RecordingRunner } from '../fixtures/runner.js';

const step = (id: string, extra: Omit<StepDescription, 'kind' | 'id'> = {}): StepDescription => ({
  kind: 'step',
  id,
  ...extra,
});
const branch = (id: string, ...arms: StepDescription[]): EntryDescription => ({ kind: 'branch', id, arms });
const workflow = (...entries: EntryDescription[]): WorkflowDescription => ({ id: 'triage', entries });
const arms = (k: number): StepDescription[] => Array.from({ length: k }, (_, i) => step(`arm${i}`));

/** Both properties, `proven` asserted explicitly: `isViolated()` is false on `unknown` too. */
function expectProven(reports: readonly PropertyReport[]): void {
  expect(reports.map((r) => r.property)).toEqual(['deadlockFree', 'terminatesAtSink', 'exactlyOneTerminal']);
  for (const report of reports) expect(report.result.verdict.type, describeReport(report)).toBe('proven');
}

const verdictOf = (reports: readonly PropertyReport[], property: string): string =>
  reports.find((r) => r.property === property)!.result.verdict.type;

/**
 * Every proof below is over the net `compile()` builds, from one token in the entry place, with
 * all five workflow terminals declared as sinks (`verifyWorkflow`). Verification is value-blind,
 * so each gate's run *and* skip legs, and each arm's five outcomes, are all explored — the proofs
 * cover every subset of truthy arms and every mix of arm outcomes.
 */
const shapes: ReadonlyArray<readonly [string, WorkflowDescription]> = [
  ['one arm, last entry', workflow(branch('route', ...arms(1)))],
  ['two arms, last entry', workflow(branch('route', ...arms(2)))],
  ['three arms, last entry', workflow(branch('route', ...arms(3)))],
  ['four arms, last entry', workflow(branch('route', ...arms(4)))],
  ['two arms, middle entry', workflow(step('validate'), branch('route', ...arms(2)), step('audit'))],
  ['two branches in sequence', workflow(branch('first', ...arms(2)), branch('second', step('x'), step('y')))],
  ['empty branch, middle entry', workflow(step('validate'), branch('route'), step('audit'))],
  [
    // A delayed retry makes the net timed, which rules out the enumeration route ([VER-017] is
    // untimed-only) and forces the SMT pipeline, so both routes are exercised.
    'arms with delayed retries (timed, SMT route)',
    workflow(branch('route', step('a', { retries: 1, retryDelayMs: 50 }), step('b', { retries: 2 }))),
  ],
];

describe('compiled branch, proved', () => {
  for (const [label, description] of shapes) {
    it(`is deadlock-free and terminates at a declared sink: ${label}`, async () => {
      expectProven(await verifyWorkflow(compile(description), { timeoutMs: 120_000 }));
    }, 300_000);
  }

  it('takes the SMT route for the timed shape', async () => {
    const reports = await verifyWorkflow(compile(shapes[shapes.length - 1]![1]), { timeoutMs: 120_000 });
    expectProven(reports);
    for (const report of reports) expect(report.result.route).toBe('smt');
  }, 300_000);
});

// ===================== scaling in the number of arms =====================

interface SizeRow {
  readonly arms: number;
  readonly transitions: number;
  readonly branches: number;
  readonly places: number;
  readonly deadlockFree: string;
  readonly terminatesAtSink: string;
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
    it(`proves both properties with ${k} arm(s) and counts the net`, async () => {
      const compiled = compile(workflow(branch('route', ...arms(k))));
      const transitions = [...compiled.net.transitions];
      const branches = transitions.reduce((sum, t) => sum + enumerateBranches(t.outputSpec!).length, 0);

      const reports = await verifyWorkflow(compiled, { timeoutMs: 240_000 });

      expectProven(reports);
      // 2k + 8 transitions of the block's own, one per arm; decide 2 branches, each gate 2, each
      // arm 5, every collect and join 1.
      expect(transitions).toHaveLength(3 * k + 8);
      expect(branches).toBe(8 * k + 9);
      const cell = (p: string) => {
        const r = reports.find((x) => x.property === p)!.result;
        return `${r.verdict.type} via ${r.route} in ${Math.round(r.elapsedMs)}ms`;
      };
      sizeRows.push({
        arms: k,
        transitions: transitions.length,
        branches,
        places: compiled.net.places.size,
        deadlockFree: cell('deadlockFree'),
        terminatesAtSink: cell('terminatesAtSink'),
      });
    }, 600_000);
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

async function verifyMutant(gadget: Gadget): Promise<readonly PropertyReport[]> {
  return verifyWorkflow(compile(twoArms, { gadgets: { branch: gadget } }), { timeoutMs: 120_000 });
}

describe('compiled branch, non-vacuity', () => {
  it('the unmutated two-arm block is the baseline: both properties proven', async () => {
    expectProven(await verifyWorkflow(compile(twoArms), { timeoutMs: 120_000 }));
  });

  it("join-ok's inhibitor on the failure marker: without it a failed block can succeed and strand the marker", async () => {
    const reports = await verifyMutant(mutating('join-ok', (t) => [rebuilt(t, { dropInhibitor: 'err-seen' })]));
    expect(verdictOf(reports, 'deadlockFree')).toBe('violated');
  });

  it("join-ok's inhibitor on the suspension marker: without it a suspended block can succeed", async () => {
    const reports = await verifyMutant(mutating('join-ok', (t) => [rebuilt(t, { dropInhibitor: 'susp-seen' })]));
    expect(verdictOf(reports, 'deadlockFree')).toBe('violated');
  });

  it("join-susp's inhibitor on the failure marker: without it failed no longer outranks suspended", async () => {
    const reports = await verifyMutant(mutating('join-susp', (t) => [rebuilt(t, { dropInhibitor: 'err-seen' })]));
    expect(verdictOf(reports, 'deadlockFree')).toBe('violated');
  });

  it("join-fail's reset of the suspension marker: without it a failure beside a suspension strands a token", async () => {
    const mutant = mutating('join-fail', (t) => [rebuilt(t, { dropReset: 'susp-seen' })]);

    const reports = await verifyMutant(mutant);
    expect(verdictOf(reports, 'deadlockFree')).toBe('violated');

    const runner = new RecordingRunner({
      steps: { a: () => ({ status: 'failed', error: 'down' }), b: () => ({ status: 'suspended', payload: 'wait' }) },
      branches: { route: () => [0, 1] },
    });
    const outcome = await runWorkflow(compile(twoArms, { gadgets: { branch: mutant } }), 'x', { runner });
    expect(outcome).toEqual({ status: 'failed', stepId: 'a', error: 'down', residue: ['s.0.route.susp-seen'] });
  });

  it("join-fail's all() on the failure marker: consuming one leaves the others behind", async () => {
    const mutant = mutating('join-fail', (t, p) => [
      rebuilt(t, { inputs: t.inputSpecs.map((spec) => (spec.type === 'all' ? one(p('err-seen')) : spec)) }),
    ]);

    const reports = await verifyMutant(mutant);
    expect(verdictOf(reports, 'deadlockFree')).toBe('violated');

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
    expect(verdictOf(reports, 'deadlockFree')).toBe('violated');
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
    expect(verdictOf(reports, 'deadlockFree')).toBe('violated');
    expect(verdictOf(reports, 'terminatesAtSink')).toBe('violated');

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
    expect(verdictOf(reports, 'deadlockFree')).toBe('violated');

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
    expect(verdictOf(reports, 'deadlockFree')).toBe('violated');
  });
});

describe('compiled branch, a compiled net serves any runner', () => {
  it('verifies the same net it runs: one CompiledWorkflow, proved and then executed', async () => {
    const compiled: CompiledWorkflow = compile(workflow(step('validate'), branch('route', ...arms(3)), step('audit')));
    expectProven(await verifyWorkflow(compiled, { timeoutMs: 120_000 }));

    const runner = new RecordingRunner({ branches: { route: () => [0, 2] } });
    const outcome = await runWorkflow(compiled, 'in', { runner });
    expect(outcome).toStrictEqual({ status: 'success', output: { arm0: 'in', arm1: undefined, arm2: 'in' } });
  }, 300_000);
});

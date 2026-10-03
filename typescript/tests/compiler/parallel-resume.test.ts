import { afterAll, describe, expect, it } from 'vitest';
import { Transition, and, outPlace, xor, type Place } from 'libpetri';
import { compile, parallelGadget, type Gadget } from '../../src/compiler/index.js';
import { runWorkflowDetailed, type RunReport } from '../../src/engine/index.js';
import {
  budgetStructureViolations,
  cancelStructureViolations,
  describeReport,
  resumeGateViolations,
  resumeTimingViolations,
  segmentLabel,
  suspensionCoverageViolations,
  verifyWorkflow,
  type PropertyReport,
} from '../../src/verify/index.js';
import type {
  ArmResume,
  ArmSite,
  CompiledWorkflow,
  EntryDescription,
  FailureToken,
  SiblingVerdict,
  StepCall,
  StepDescription,
  StepOutcome,
  StepRecord,
  SuspendToken,
  WorkflowDescription,
} from '../../src/compiler/types.js';
import { RecordingRunner, type Behaviour } from '../fixtures/runner.js';
import { ManualClock } from '../support/manual-clock.js';

/**
 * `.parallel()` resumed at one arm ([ADR 0007], contract C10/C11).
 *
 * Every run here is a **hand-seeded segment**: one `ArmResume` token at a registered arm site,
 * through `runWorkflowDetailed({ resume })`, never a marking written by hand. The seed says what
 * each sibling's stored record was; `re-enter-j` runs arm *j* alone and `replay-i` re-deposits each
 * sibling's arrival, and the block's unchanged join decides — failed > suspended > ok, as Mastra's
 * `buildResumedBlockResult` (`handlers/entry.ts:38-109`).
 *
 * Every outcome is asserted whole with `toStrictEqual`, so a `residue` key — a token left anywhere
 * but the one terminal, the cancel signal and `k` permits — fails the test.
 *
 * Proofs name the property, the segment (initial marking), the environment mode and the route, and
 * assert `verdict.type === 'proven'` — never `!isViolated()`, which passes on `unknown`.
 */

const EPOCH = 1_700_000_000_000;
const step = (id: string, extra: Partial<Omit<StepDescription, 'kind' | 'id'>> = {}): StepDescription =>
  ({ kind: 'step', id, ...extra });
const fan = (id: string, arms: readonly StepDescription[]): EntryDescription => ({ kind: 'parallel', id, arms });
const wf = (...entries: EntryDescription[]): WorkflowDescription => ({ id: 'w', entries });
const ok = (output: unknown): StepOutcome => ({ status: 'success', output });
const after = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A runner that also records every call it received, `resumed` flag included. */
class Recorder extends RecordingRunner {
  readonly seen: { readonly stepId: string; readonly input: unknown; readonly resumed: boolean; readonly path: readonly number[] }[] = [];
  constructor(steps: Record<string, Behaviour> = {}) {
    super({ steps });
  }
  override async run(stepId: string, input: unknown, call: StepCall): Promise<StepOutcome> {
    this.seen.push({ stepId, input, resumed: call.resumed === true, path: call.path });
    return super.run(stepId, input, call);
  }
}

const siteOf = (compiled: CompiledWorkflow, key: string): ArmSite => {
  const site = compiled.resumeSites.get(key);
  if (site === undefined || site.kind !== 'arm') throw new Error(`no arm site at ${key}`);
  return site;
};

/** The stored suspended record of an arm, as the leaf wrote it. */
const suspendedRecord = (payload: unknown, suspendPayload: unknown): StepRecord =>
  ({ status: 'suspended', payload, suspendPayload, startedAt: EPOCH, suspendedAt: EPOCH });

const suspendedAt = (stepId: string, path: readonly number[], payload: unknown): SuspendToken =>
  ({ stepId, path, payload, suspendedAt: EPOCH });
const failedAt = (stepId: string, path: readonly number[], error: unknown): FailureToken => ({ stepId, path, error });

interface Resume {
  readonly compiled: CompiledWorkflow;
  readonly site: string;
  readonly seed: ArmResume;
  readonly runner: RecordingRunner;
  readonly records?: ReadonlyMap<string, StepRecord>;
  readonly aborted?: boolean;
}

/** One resumed segment: the seed at the site, the stored records, a manual clock. */
const resume = (r: Resume): Promise<RunReport> => {
  const controller = new AbortController();
  if (r.aborted === true) controller.abort();
  return runWorkflowDetailed(r.compiled, 'init', {
    runner: r.runner,
    clock: new ManualClock(EPOCH),
    resume: { site: siteOf(r.compiled, r.site), value: r.seed },
    ...(r.records ? { stepResults: r.records } : {}),
    ...(r.aborted === true ? { signal: controller.signal } : {}),
    timeoutMs: 10_000,
  });
};

// ---------------------------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------------------------

describe('parallel resume: structure', () => {
  it('registers one gated, swept arm site per arm, keyed by Mastra\'s resume path', () => {
    const compiled = compile(wf(step('s'), fan('fan', [step('a'), step('b'), step('c')])));
    const arms = [...compiled.resumeSites.values()].filter((s): s is ArmSite => s.kind === 'arm');
    expect(arms.map((s) => [s.path, s.block, s.stepId, s.place.name])).toStrictEqual([
      [[1, 0], 'parallel', 'a', 's.1.fan.resume-0'],
      [[1, 1], 'parallel', 'b', 's.1.fan.resume-1'],
      [[1, 2], 'parallel', 'c', 's.1.fan.resume-2'],
    ]);
    expect([...compiled.resumeSites.keys()].sort()).toStrictEqual(['0', '1.0', '1.1', '1.2']);

    const byName = new Map([...compiled.net.transitions].map((t) => [t.name, t]));
    for (let j = 0; j < 3; j++) {
      const gate = byName.get(`t.1.fan.re-enter-${j}`)!;
      const sweep = byName.get(`t.1.fan.re-enter-${j}.cancel`)!;
      expect(gate.inhibitors.map((a) => a.place.name)).toStrictEqual(['wf.cancel']);
      expect(gate.inputSpecs.map((i) => [i.type, i.place.name])).toStrictEqual([['one', `s.1.fan.resume-${j}`]]);
      // The gate's one run branch is the arm's input plus every other arm's replay; its other
      // branch refuses a seed that does not fit, by name.
      const outs = [...gate.outputPlaces()].map((p) => p.name).sort();
      expect(outs).toStrictEqual(
        [`s.1-${j}.${['a', 'b', 'c'][j]}.in`, ...[0, 1, 2].filter((i) => i !== j).map((i) => `s.1.fan.replay-${i}`), 'wf.settle.failed'].sort(),
      );
      expect(sweep.reads.map((a) => a.place.name)).toStrictEqual(['wf.cancel']);
      expect([...sweep.outputPlaces()].map((p) => p.name)).toStrictEqual(['wf.canceled']);
      expect(byName.has(`t.1.fan.replay-${j}`)).toBe(true);
    }
    // Nothing but the seed marks a site: no transition produces into one.
    for (const t of compiled.net.transitions) {
      expect([...t.outputPlaces()].some((p) => p.name.includes('.resume-'))).toBe(false);
    }
  });

  it('passes every structural check: cancel, budget, resume gates, threshold arcs, coverage, timing', () => {
    for (const k of [undefined, 1, 2]) {
      const compiled = compile(wf(step('s'), fan('fan', [step('a'), step('b', { retries: 1 })]), step('z')), k === undefined ? {} : { concurrency: k });
      expect(cancelStructureViolations(compiled)).toStrictEqual([]);
      expect(budgetStructureViolations(compiled)).toStrictEqual([]);
      expect(resumeGateViolations(compiled)).toStrictEqual([]);
      expect(suspensionCoverageViolations(compiled)).toStrictEqual([]);
      expect(resumeTimingViolations(compiled)).toStrictEqual([]);
    }
  });

  it('gives an empty block no site: it has no arm to suspend', () => {
    const compiled = compile(wf(fan('fan', [])));
    expect([...compiled.resumeSites.keys()]).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// join-susp carries the losing suspensions
// ---------------------------------------------------------------------------------------------

describe('parallel: the join carries every losing suspension as pending (row 34)', () => {
  const fresh = (description: WorkflowDescription, runner: RecordingRunner) =>
    runWorkflowDetailed(compile(description), 'x', { runner, clock: new ManualClock(EPOCH), timeoutMs: 10_000 });

  it('two suspended arms: the lower is reported, the other rides along as pending', async () => {
    const runner = new Recorder({
      a: async () => { await after(15); return { status: 'suspended', suspendPayload: 'pa' }; },
      b: () => ({ status: 'suspended', suspendPayload: 'pb' }),
    });
    const { outcome } = await fresh(wf(fan('fan', [step('a'), step('b')])), runner);
    expect(outcome).toStrictEqual({
      status: 'suspended',
      stepId: 'a',
      path: [0, 0],
      payload: 'pa',
      pending: [suspendedAt('b', [0, 1], 'pb')],
    });
  });

  it('three suspended arms settling in reverse: pending is in arm order, not time order', async () => {
    const settled: string[] = [];
    const at = (ms: number, id: string): Behaviour => async () => {
      await after(ms);
      settled.push(id);
      return { status: 'suspended', suspendPayload: `p${id}` };
    };
    const runner = new Recorder({ a: at(30, 'a'), b: at(15, 'b'), c: at(0, 'c') });
    const { outcome } = await fresh(wf(fan('fan', [step('a'), step('b'), step('c')])), runner);
    expect(settled).toStrictEqual(['c', 'b', 'a']);
    expect(outcome).toStrictEqual({
      status: 'suspended',
      stepId: 'a',
      path: [0, 0],
      payload: 'pa',
      pending: [suspendedAt('b', [0, 1], 'pb'), suspendedAt('c', [0, 2], 'pc')],
    });
  });

  it('one suspension carries no pending key, and a failure still drops every suspension', async () => {
    const one = await fresh(wf(fan('fan', [step('a'), step('b')])), new Recorder({ b: () => ({ status: 'suspended', suspendPayload: 'pb' }) }));
    expect(one.outcome).toStrictEqual({ status: 'suspended', stepId: 'b', path: [0, 1], payload: 'pb' });

    const failed = await fresh(
      wf(fan('fan', [step('a'), step('b')])),
      new Recorder({ a: () => ({ status: 'suspended', suspendPayload: 'pa' }), b: () => ({ status: 'failed', error: 'boom' }) }),
    );
    expect(failed.outcome).toStrictEqual({ status: 'failed', stepId: 'b', path: [0, 1], error: 'boom' });
  });
});

// ---------------------------------------------------------------------------------------------
// Resumed runs, hand-seeded
// ---------------------------------------------------------------------------------------------

describe('parallel resume: runs only the resumed arm and replays the siblings', () => {
  const three = compile(wf(fan('fan', [step('a'), step('b'), step('c')])));

  it('3 arms, 3 suspended: resuming b re-runs b alone on its stored input and re-suspends at a, c pending', async () => {
    const runner = new Recorder({ b: (input) => ok(`${String(input)}/b`) });
    const { outcome, stepResults } = await resume({
      compiled: three,
      site: '0.1',
      runner,
      seed: {
        data: 'stored-b',
        siblings: [
          { kind: 'suspended', index: 0, token: suspendedAt('a', [0, 0], 'pa') },
          { kind: 'suspended', index: 2, token: suspendedAt('c', [0, 2], 'pc') },
        ],
      },
      records: new Map([
        ['a', suspendedRecord('x', 'pa')],
        ['b', suspendedRecord('stored-b', 'pb')],
        ['c', suspendedRecord('x', 'pc')],
      ]),
    });
    expect(runner.seen).toStrictEqual([{ stepId: 'b', input: 'stored-b', resumed: true, path: [0, 1] }]);
    expect(outcome).toStrictEqual({
      status: 'suspended',
      stepId: 'a',
      path: [0, 0],
      payload: 'pa',
      pending: [suspendedAt('c', [0, 2], 'pc')],
    });
    expect(stepResults.get('b')).toMatchObject({ status: 'success', output: 'stored-b/b', payload: 'stored-b' });
  });

  it('2 arms, 2 suspended: resuming the non-lowest arm reports the lowest, still suspended, with no pending', async () => {
    const two = compile(wf(fan('fan', [step('a'), step('b')])));
    const runner = new Recorder();
    const { outcome } = await resume({
      compiled: two,
      site: '0.1',
      runner,
      seed: { data: 'x', siblings: [{ kind: 'suspended', index: 0, token: suspendedAt('a', [0, 0], 'pa') }] },
    });
    expect(runner.seen.map((c) => c.stepId)).toStrictEqual(['b']);
    expect(outcome).toStrictEqual({ status: 'suspended', stepId: 'a', path: [0, 0], payload: 'pa' });
  });

  it('the last suspended arm resumed: the block succeeds with every arm, in arm order', async () => {
    const runner = new Recorder({ c: () => ok('C') });
    const { outcome } = await resume({
      compiled: three,
      site: '0.2',
      runner,
      seed: { data: 'x', siblings: [{ kind: 'ok', index: 0, output: 'A' }, { kind: 'ok', index: 1, output: 'B' }] },
    });
    expect(runner.seen.map((c) => c.stepId)).toStrictEqual(['c']);
    expect(outcome).toStrictEqual({ status: 'success', output: { a: 'A', b: 'B', c: 'C' } });
    expect(Object.keys((outcome as { output: object }).output)).toStrictEqual(['a', 'b', 'c']);
  });

  it('a block that is not last hands the next entry every declared arm, read from the step results', async () => {
    const compiled = compile(wf(fan('fan', [step('a'), step('b')]), step('after')));
    const runner = new Recorder({ b: () => ok('B'), after: (input) => ok({ saw: input }) });
    const { outcome } = await resume({
      compiled,
      site: '0.1',
      runner,
      seed: { data: 'x', siblings: [{ kind: 'ok', index: 0, output: 'A' }] },
      records: new Map<string, StepRecord>([['a', { status: 'success', output: 'A', payload: 'x' }], ['b', suspendedRecord('x', 'pb')]]),
    });
    expect(runner.seen.map((c) => [c.stepId, c.resumed])).toStrictEqual([['b', true], ['after', false]]);
    expect(outcome).toStrictEqual({ status: 'success', output: { saw: { a: 'A', b: 'B' } } });
  });

  it('the resumed arm suspends again: the block re-suspends at that arm', async () => {
    const runner = new Recorder({ a: () => ({ status: 'suspended', suspendPayload: 'again' }) });
    const { outcome } = await resume({
      compiled: three,
      site: '0.0',
      runner,
      seed: { data: 'x', siblings: [{ kind: 'ok', index: 1, output: 'B' }, { kind: 'ok', index: 2, output: 'C' }] },
    });
    expect(outcome).toStrictEqual({ status: 'suspended', stepId: 'a', path: [0, 0], payload: 'again' });
  });

  it('a retry of the resumed arm is still the resumed attempt', async () => {
    const compiled = compile(wf(fan('fan', [step('a', { retries: 1 }), step('b')])));
    let n = 0;
    const runner = new Recorder({ a: () => (n++ === 0 ? { status: 'failed', error: 'flaky' } : ok('A')) });
    const { outcome } = await resume({
      compiled,
      site: '0.0',
      runner,
      seed: { data: 'x', siblings: [{ kind: 'ok', index: 1, output: 'B' }] },
    });
    expect(runner.seen.map((c) => [c.stepId, c.resumed])).toStrictEqual([['a', true], ['a', true]]);
    expect(outcome).toStrictEqual({ status: 'success', output: { a: 'A', b: 'B' } });
  });
});

describe('parallel resume: every sibling verdict kind, through the unchanged join', () => {
  const three = compile(wf(fan('fan', [step('a'), step('b'), step('c')])));
  const bSusp: SiblingVerdict = { kind: 'suspended', index: 1, token: suspendedAt('b', [0, 1], 'pb') };
  const bFail: SiblingVerdict = { kind: 'failed', index: 1, token: failedAt('b', [0, 1], 'b broke') };
  const bOk: SiblingVerdict = { kind: 'ok', index: 1, output: 'B' };
  const bSettled: SiblingVerdict = { kind: 'settled', index: 1 };
  const cOk: SiblingVerdict = { kind: 'ok', index: 2, output: 'C' };
  const cSusp: SiblingVerdict = { kind: 'suspended', index: 2, token: suspendedAt('c', [0, 2], 'pc') };
  const cFail: SiblingVerdict = { kind: 'failed', index: 2, token: failedAt('c', [0, 2], 'c broke') };

  const resumedA: Record<string, Behaviour> = {
    ok: () => ok('A'),
    suspended: () => ({ status: 'suspended', suspendPayload: 'pa' }),
    failed: () => ({ status: 'failed', error: 'a broke' }),
  };

  const cases: readonly (readonly [string, keyof typeof resumedA, readonly SiblingVerdict[], unknown])[] = [
    ['ok + ok', 'ok', [bOk, cOk], { status: 'success', output: { a: 'A', b: 'B', c: 'C' } }],
    ['ok + suspended', 'ok', [bSusp, cOk], { status: 'suspended', stepId: 'b', path: [0, 1], payload: 'pb' }],
    ['ok + failed', 'ok', [bFail, cOk], { status: 'failed', stepId: 'b', path: [0, 1], error: 'b broke' }],
    // A bailed or paused sibling is swallowed, as in a fresh block: the block succeeds without it.
    // Mastra re-suspends with {} and no path here (`handlers/entry.ts:44-96`) — a divergence.
    ['ok + settled', 'ok', [bSettled, cOk], { status: 'success', output: { a: 'A', c: 'C' } }],
    ['failed outranks suspended', 'ok', [bSusp, cFail], { status: 'failed', stepId: 'c', path: [0, 2], error: 'c broke' }],
    ['lowest failure wins: the resumed arm', 'failed', [bFail, cOk], { status: 'failed', stepId: 'a', path: [0, 0], error: 'a broke' }],
    ['lowest suspension wins: the resumed arm, with both siblings pending', 'suspended', [bSusp, cSusp], {
      status: 'suspended', stepId: 'a', path: [0, 0], payload: 'pa',
      pending: [suspendedAt('b', [0, 1], 'pb'), suspendedAt('c', [0, 2], 'pc')],
    }],
    ['resumed arm fails over suspended siblings', 'failed', [bSusp, cSusp], { status: 'failed', stepId: 'a', path: [0, 0], error: 'a broke' }],
  ];

  for (const [name, behaviour, siblings, expected] of cases) {
    it(name, async () => {
      const runner = new Recorder({ a: resumedA[behaviour]! });
      const { outcome } = await resume({ compiled: three, site: '0.0', runner, seed: { data: 'x', siblings } });
      expect(runner.seen.map((c) => c.stepId)).toStrictEqual(['a']);
      expect(outcome).toStrictEqual(expected);
    });
  }
});

describe('parallel resume: a seed that does not fit is refused by name, before any step runs', () => {
  const three = compile(wf(fan('fan', [step('a'), step('b'), step('c')])));
  const refusals: readonly (readonly [string, ArmResume, RegExp])[] = [
    ['a skipped sibling', { data: 'x', siblings: [{ kind: 'skipped', index: 1 }, { kind: 'ok', index: 2, output: 1 }] }, /sibling 1 is 'skipped'/],
    ['too few siblings', { data: 'x', siblings: [{ kind: 'ok', index: 1, output: 1 }] }, /names 1 sibling\(s\); the block has 2/],
    ['a repeated sibling', { data: 'x', siblings: [{ kind: 'ok', index: 1, output: 1 }, { kind: 'ok', index: 1, output: 1 }] }, /sibling 1 is named twice/],
    ['the resumed arm as its own sibling', { data: 'x', siblings: [{ kind: 'ok', index: 0, output: 1 }, { kind: 'ok', index: 2, output: 1 }] }, /sibling index 0 names no other arm/],
    ['a suspension carrying another arm\'s path', {
      data: 'x',
      siblings: [{ kind: 'suspended', index: 1, token: suspendedAt('c', [0, 2], 'p') }, { kind: 'ok', index: 2, output: 1 }],
    }, /sibling 1's suspended token carries the path of arm 2/],
    ['a suspension whose path is the block\'s, not [top, arm]', {
      data: 'x',
      siblings: [{ kind: 'suspended', index: 1, token: suspendedAt('b', [0], 'p') }, { kind: 'ok', index: 2, output: 1 }],
    }, /sibling 1's suspended token carries a path of length 1, not \[top, arm\]$/],
    ['a suspension whose path runs deeper than [top, arm]', {
      data: 'x',
      siblings: [{ kind: 'suspended', index: 1, token: suspendedAt('b', [0, 1, 0], 'p') }, { kind: 'ok', index: 2, output: 1 }],
    }, /sibling 1's suspended token carries a path of length 3, not \[top, arm\]$/],
    ['a suspension from another entry', {
      data: 'x',
      siblings: [{ kind: 'suspended', index: 1, token: suspendedAt('b', [3, 1], 'p') }, { kind: 'ok', index: 2, output: 1 }],
    }, /sibling 1's suspended token carries the path of the entry at \[3\], not \[0\]$/],
    ['a suspension naming another arm\'s step at the right path', {
      data: 'x',
      siblings: [{ kind: 'suspended', index: 1, token: suspendedAt('c', [0, 1], 'p') }, { kind: 'ok', index: 2, output: 1 }],
    }, /sibling 1's suspended token names step 'c', but arm 1 is 'b'$/],
    ['a failure naming another arm\'s step at the right path', {
      data: 'x',
      siblings: [{ kind: 'ok', index: 1, output: 1 }, { kind: 'failed', index: 2, token: failedAt('a', [0, 2], 'e') }],
    }, /sibling 2's failed token names step 'a', but arm 2 is 'c'$/],
  ];
  for (const [name, seed, message] of refusals) {
    it(name, async () => {
      const runner = new Recorder();
      const { outcome } = await resume({ compiled: three, site: '0.0', runner, seed });
      expect(runner.seen).toStrictEqual([]);
      expect(outcome).toMatchObject({ status: 'failed', stepId: 'fan', path: [0] });
      expect(Object.keys(outcome).sort()).toStrictEqual(['error', 'path', 'status', 'stepId']);
      const error = (outcome as { error: Error }).error;
      expect(error.message).toMatch(/^parallel 'fan': cannot resume arm 0 \(a\): /);
      expect(error.message).toMatch(message);
    });
  }
});

describe('parallel resume: a resume that was already aborted is swept at the gate', () => {
  for (const k of [undefined, 1]) {
    for (const site of ['0.0', '0.1']) {
      it(`site ${site}${k === undefined ? '' : `, k=${k}`}: canceled unstarted, nothing run, nothing stranded`, async () => {
        const compiled = compile(wf(fan('fan', [step('a'), step('b')]), step('z')), k === undefined ? {} : { concurrency: k });
        const runner = new Recorder();
        const { outcome } = await resume({
          compiled,
          site,
          runner,
          aborted: true,
          seed: { data: 'x', siblings: [site === '0.0' ? { kind: 'ok', index: 1, output: 'B' } : { kind: 'ok', index: 0, output: 'A' }] },
        });
        expect(runner.seen).toStrictEqual([]);
        expect(outcome).toStrictEqual({ status: 'canceled', origin: { stepId: 'fan', path: [0] }, started: false });
      });
    }
  }

  it('under a budget of one, a resumed arm and the next entry run and every permit comes back', async () => {
    const compiled = compile(wf(fan('fan', [step('a'), step('b')]), step('z')), { concurrency: 1 });
    const runner = new Recorder({ z: (input) => ok(input) });
    const { outcome } = await resume({
      compiled,
      site: '0.0',
      runner,
      seed: { data: 'x', siblings: [{ kind: 'ok', index: 1, output: 'B' }] },
      records: new Map<string, StepRecord>([['b', { status: 'success', output: 'B', payload: 'x' }]]),
    });
    expect(runner.seen.map((c) => c.stepId)).toStrictEqual(['a', 'z']);
    expect(outcome).toStrictEqual({ status: 'success', output: { a: 'x', b: 'B' } });
  });
});

// ---------------------------------------------------------------------------------------------
// Proofs
// ---------------------------------------------------------------------------------------------

const proofLines: string[] = [];
afterAll(() => {
  if (proofLines.length > 0) console.info(`parallel-resume proofs (libpetri 6.1.0 from npm):\n  ${proofLines.join('\n  ')}`);
});

const PROPERTIES_CLOSED = ['deadlockFree', 'terminatesAtSink', 'exactlyOneTerminal', 'neverCanceled'];
const PROPERTIES_CANCEL = ['deadlockFree', 'terminatesAtSink', 'exactlyOneTerminal'];
const BUDGET = ['permitsBounded', 'permitsReturned'];

/** Every property of every segment — fresh ±cancel and each site ±cancel — must be `proven`. */
async function expectAllProven(name: string, compiled: CompiledWorkflow, sites: readonly string[]): Promise<readonly PropertyReport[]> {
  expect([...compiled.resumeSites.keys()].sort()).toStrictEqual([...sites].sort());
  const reports = await verifyWorkflow(compiled, { timeoutMs: 30_000 });
  const budget = compiled.budget ? BUDGET : [];
  const expected = ['closed', 'cancel', ...sites.flatMap((s) => [`resume@${s}`, `resume@${s}+cancel`])].flatMap((segment) =>
    (segment.endsWith('cancel') ? PROPERTIES_CANCEL : PROPERTIES_CLOSED).concat(budget).map((p) => `${segment}/${p}`),
  );
  expect(reports.map((r) => `${segmentLabel(r.segment)}/${r.property}`).sort()).toStrictEqual(expected.sort());
  for (const r of reports) {
    proofLines.push(`${name}: ${describeReport(r)}`);
    expect(r.result.verdict.type, describeReport(r)).toBe('proven');
  }
  return reports;
}

describe('parallel resume: every site is proven as its own segment, with and without a cancel', () => {
  it('fan(a, b) — sites 0.0, 0.1', async () => {
    await expectAllProven('fan2', compile(wf(fan('fan', [step('a'), step('b')]))), ['0.0', '0.1']);
  }, 600_000);

  it('s; fan(a, b, c); z — sites 0, 1.0, 1.1, 1.2, 2', async () => {
    await expectAllProven('s-fan3-z', compile(wf(step('s'), fan('fan', [step('a'), step('b'), step('c')]), step('z'))), ['0', '1.0', '1.1', '1.2', '2']);
  }, 600_000);

  for (const k of [1, 2]) {
    it(`fan(a, b); z at k=${k} — permits bounded and returned in every segment`, async () => {
      await expectAllProven(`fan2-z-k${k}`, compile(wf(fan('fan', [step('a'), step('b')]), step('z')), { concurrency: k }), ['0.0', '0.1', '1']);
    }, 600_000);
  }

  it('non-vacuity: a replay whose failure branch loses its arrival is caught at the resume segment', async () => {
    // The join counts arrivals; a replayed failure that marks `errSeen` without arriving leaves the
    // count one short forever. The fresh segments cannot see it — the replay is dead there — so the
    // proof must come from the site's own marking.
    const mutant: Gadget = (entry, next, ctx) => {
      const result = parallelGadget(entry, next, ctx);
      let hit = 0;
      const transitions = result.transitions.map((t) => {
        if (!t.name.endsWith('.replay-1')) return t;
        hit++;
        const [arrived, suspSeen, errSeen] = ['arrived', 'susp-seen', 'err-seen'].map((role) =>
          [...t.outputPlaces()].find((p) => p.name.endsWith(`.${role}`))!,
        ) as [Place<unknown>, Place<unknown>, Place<unknown>];
        return Transition.builder(t.name)
          .inputs(...t.inputSpecs)
          .outputs(xor(outPlace(arrived), and(outPlace(arrived), outPlace(suspSeen)), outPlace(errSeen)))
          .action(async (tctx) => {
            const v = tctx.input(t.inputSpecs[0]!.place as Place<SiblingVerdict>);
            if (v.kind === 'failed') tctx.output(errSeen, v.token);
            else tctx.output(arrived, { status: 'settled' });
          })
          .build();
      });
      expect(hit).toBe(1);
      return { ...result, transitions };
    };
    const compiled = compile(wf(fan('fan', [step('a'), step('b')])), { gadgets: { parallel: mutant } });
    const reports = await verifyWorkflow(compiled, { timeoutMs: 30_000 });
    const verdict = (key: string) => reports.find((r) => `${segmentLabel(r.segment)}/${r.property}` === key)!.result.verdict.type;
    for (const r of reports) proofLines.push(`mutant replay-1 drops arrival: ${describeReport(r)}`);
    // Fresh segments never fire a replay, so they stay proven; the site that replays arm 1 does not.
    expect(verdict('closed/deadlockFree')).toBe('proven');
    expect(verdict('resume@0.0/deadlockFree')).toBe('violated');
    expect(verdict('resume@0.1/deadlockFree')).toBe('proven');
  }, 600_000);
});

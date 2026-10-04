import { afterAll, describe, expect, it } from 'vitest';
import type { Place } from 'libpetri';
import {
  SmtVerifier,
  deadlockFree,
  placeBound,
  quiescentCount,
  terminatesAtSink,
  type SmtVerificationResult,
} from 'libpetri/verification';
import { compile } from '../../src/compiler/index.js';
import { runWorkflowDetailed, type RunReport } from '../../src/engine/kernel.js';
import { describeReport, verifyWorkflow, type PropertyReport } from '../../src/verify/index.js';
import type {
  CompiledWorkflow,
  EntryDescription,
  EntrySite,
  FlowToken,
  ResumeSite,
  RunView,
  StepCall,
  StepDescription,
  StepOutcome,
  StepRecord,
  StepRunner,
} from '../../src/compiler/types.js';
import { ManualClock } from '../support/manual-clock.js';

/**
 * The loop's half of a resume ([ADR 0007], contract C13), against Mastra's `executeLoop`
 * (`.mastra/src-extracted/src/workflows/handlers/control-flow.ts`):
 *
 * - `:727-735` — a loop re-entered with a record under its body's id restarts at that record's
 *   `iterationCount` from its `payload`. `start` already does that for any entry; a resumed seed
 *   changes nothing about where the loop starts, so the seed's own data is ignored when a record
 *   exists.
 * - `:760-790` — the resumed iteration is the one fed the resume (`resume.steps[0]` is the body),
 *   and `currentResume` is cleared once the body stops suspending (`:785-788`), so iteration n + 1
 *   onward runs fresh. Here `LoopState.resumed` rides `start -> ready -> enter -> bodyIn` once and
 *   `check`'s next `ready` never carries it. No arc reads it: it is colour.
 * - The iteration allowance restarts at `iterationBound` on a resume — the bound is this engine's,
 *   not Mastra's (`docs/divergences.md` row 13), and a resumed loop is an entry of this loop.
 *
 * **How a resume is started here.** Through the kernel's `RunOptions.resume`, at the loop's own
 * input place `loop-in` — the site a top-level loop resumes at (ADR 0007, "Sites"). Until the
 * compiler registers entry sites itself, {@link loopSite} registers that place on a copy of the
 * compiled workflow (net, program and places unchanged), which is what the kernel checks by
 * identity.
 *
 * **Proofs.** Every composite asserts every `verifyWorkflow` report `proven`, and proves
 * `resume@[i]` from `{loop-in: 1, permits: k}` and `resume@[i]+cancel` with the cancel request
 * seeded too, with the same property set, each asserted `proven` by name. [IO-016] applies exactly
 * as in the fresh segment: `start` deposits the allowance into a place its branch names once, so
 * the proof covers the topology at an allowance of one (the genuine-allowance proofs seeded at
 * `ready` + `budget` are `tests/verify/loop.test.ts`'s, and the seed is the same entry place).
 * Environment closed, untimed, value-blind; libpetri 6.1.0 from npm.
 */

const EPOCH = 1_700_000_000_000;
const proofLog: string[] = [];
afterAll(() => {
  if (proofLog.length > 0) console.info(`loop-resume proofs (libpetri 6.1.0 from npm):\n  ${proofLog.join('\n  ')}`);
});

const tick: StepDescription = { kind: 'step', id: 'tick' };
const loop = (loopType: 'dowhile' | 'dountil', iterationBound: number, body: StepDescription = tick): EntryDescription => ({
  kind: 'loop',
  id: 'poll',
  loopType,
  iterationBound,
  body,
});
/** `prime; poll(tick); ship` — the loop at [1]. */
const between = (entry: EntryDescription): readonly EntryDescription[] => [{ kind: 'step', id: 'prime' }, entry, { kind: 'step', id: 'ship' }];
const build = (entries: readonly EntryDescription[], k?: number): CompiledWorkflow =>
  compile({ id: 'poller', entries }, k === undefined ? {} : { concurrency: k });

/** The top-level loop at `index` as a registered entry site (see the file note). */
function loopSite(compiled: CompiledWorkflow, index: number): { compiled: CompiledWorkflow; site: EntrySite } {
  const key = String(index);
  const registered = compiled.resumeSites.get(key);
  if (registered !== undefined) {
    if (registered.kind !== 'entry' || registered.construct !== 'loop') throw new Error(`site ${key} is not a loop entry site`);
    return { compiled, site: registered };
  }
  const entry = compiled.netMap.pathToEntry.get(key);
  if (entry === undefined || entry.kind !== 'loop') throw new Error(`no top-level loop at ${key}`);
  const inPlace = [...compiled.net.places].find((p) => p.name === `s.${index}.${entry.entryId}.loop-in`);
  if (inPlace === undefined) throw new Error(`no loop-in place for entry ${key}`);
  // The site names the loop's body id: that is where Mastra keeps the loop's record and the id
  // `suspendedPaths` names.
  const site: EntrySite = { kind: 'entry', path: [index], stepId: 'tick', construct: 'loop', place: inPlace as Place<FlowToken> };
  return { compiled: { ...compiled, resumeSites: new Map<string, ResumeSite>([...compiled.resumeSites, [key, site]]) }, site };
}

interface Call {
  readonly stepId: string;
  readonly attempt: number;
  readonly input: unknown;
  readonly resumed: boolean;
}

/**
 * Records every step call with its `resumed` flag and input, and every condition call with the
 * body's record at that moment — which is the record the resumed iteration wrote, before the next
 * iteration overwrites it.
 */
class LoopRunner implements StepRunner {
  readonly calls: Call[] = [];
  readonly conditions: { readonly iteration: number; readonly output: unknown; readonly body: StepRecord | undefined }[] = [];
  constructor(
    private readonly body: (input: unknown, call: StepCall) => StepOutcome,
    private readonly condition: (output: unknown, iteration: number) => boolean,
  ) {}
  async run(stepId: string, input: unknown, call: StepCall): Promise<StepOutcome> {
    // `in`, not a truthiness test: the flag is absent on a fresh call, never `false`.
    this.calls.push({ stepId, attempt: call.attempt, input, resumed: 'resumed' in call && call.resumed === true });
    const outcome: StepOutcome = stepId === 'tick' ? this.body(input, call) : { status: 'success', output: input };
    // Truthy resume data, as Mastra's runner reports it (`handlers/step.ts:166-175`): the leaf keeps
    // the prior record's start. The value itself is never recorded.
    return 'resumed' in call && call.resumed === true ? { ...outcome, resumedAt: 0 } : outcome;
  }
  async evaluateLoopCondition(_entryId: string, output: unknown, iteration: number, view: RunView): Promise<boolean> {
    this.conditions.push({ iteration, output, body: view.getStepResult('tick') });
    return this.condition(output, iteration);
  }
}

const increment = (input: unknown): StepOutcome => ({ status: 'success', output: (input as number) + 1 });

/** The body's suspended record: iteration 3 suspended on input 7. */
const SUSPENDED_AT_3: StepRecord = {
  status: 'suspended',
  payload: 7,
  suspendPayload: { ask: 'continue?' },
  startedAt: EPOCH - 500,
  suspendedAt: EPOCH - 400,
  metadata: { iterationCount: 3 },
};

async function resume(
  compiled: CompiledWorkflow,
  runner: StepRunner,
  records: ReadonlyMap<string, StepRecord>,
  extra: { clock?: ManualClock; signal?: AbortSignal; data?: unknown } = {},
): Promise<RunReport> {
  const { compiled: withSite, site } = loopSite(compiled, 1);
  return runWorkflowDetailed(withSite, { init: true }, {
    runner,
    clock: extra.clock ?? new ManualClock(EPOCH),
    stepResults: records,
    ...(extra.signal === undefined ? {} : { signal: extra.signal }),
    resume: { site, value: { data: extra.data ?? 'seed data, ignored when a record exists', resumed: true } satisfies FlowToken },
  });
}

// ---------------------------------------------------------------------------------------------
// Proofs

type Verdicts = Record<string, SmtVerificationResult>;

async function proveSegment(compiled: CompiledWorkflow, sitePlace: Place<unknown>, cancel: boolean): Promise<Verdicts> {
  const t = compiled.terminals;
  const terminals = [t.done, t.failed, t.bailed, t.suspended, t.paused, t.canceled] as const;
  const base = () =>
    SmtVerifier.forNet(compiled.net)
      .initialMarking((m) => {
        m.tokens(sitePlace, 1);
        if (cancel) m.tokens(compiled.cancelRequest, 1);
        if (compiled.budget) m.tokens(compiled.budget.permits, compiled.budget.k);
      })
      .sinkPlaces(...terminals, compiled.cancel, ...(compiled.budget ? [compiled.budget.permits] : []))
      .semiflowInvariants(true)
      .timeout(30_000);
  const out: Verdicts = {};
  out.deadlockFree = await base().property(deadlockFree()).verify();
  out.terminatesAtSink = await base().property(terminatesAtSink()).verify();
  out.exactlyOneTerminal = await base().property(quiescentCount(terminals, 1, 1)).verify();
  if (!cancel) out.neverCanceled = await base().property(placeBound(t.canceled, 0)).verify();
  if (compiled.budget) {
    out.permitsBounded = await base().property(placeBound(compiled.budget.permits, compiled.budget.k)).verify();
    out.permitsReturned = await base()
      .property(quiescentCount([compiled.budget.permits], compiled.budget.k, compiled.budget.k))
      .verify();
  }
  return out;
}

async function expectAllProven(label: string, compiled: CompiledWorkflow): Promise<void> {
  const reports: readonly PropertyReport[] = await verifyWorkflow(compiled);
  proofLog.push(`${label} fresh: ${reports.map(describeReport).join('; ')}`);
  const keys = reports.map((r) => `${r.segment}/${r.property}`);
  const expected = [
    'closed/deadlockFree',
    'closed/terminatesAtSink',
    'closed/exactlyOneTerminal',
    'closed/neverCanceled',
    'cancel/deadlockFree',
    'cancel/terminatesAtSink',
    'cancel/exactlyOneTerminal',
    ...(compiled.budget ? ['closed/permitsBounded', 'closed/permitsReturned', 'cancel/permitsBounded', 'cancel/permitsReturned'] : []),
  ];
  for (const key of expected) expect(keys, `${label}: ${key} reported`).toContain(key);
  for (const r of reports) expect(r.result.verdict.type, `${label}: ${describeReport(r)}`).toBe('proven');

  const { site } = loopSite(compiled, 1);
  for (const cancel of [false, true]) {
    const segment = `resume@[1]${cancel ? '+cancel' : ''}`;
    const verdicts = await proveSegment(compiled, site.place, cancel);
    proofLog.push(
      `${label} ${segment}${compiled.budget ? ` k=${compiled.budget.k}` : ''} from {${site.place.name}: 1}: ${Object.entries(verdicts)
        .map(([p, r]) => `${p}=${r.verdict.type} via ${r.route} in ${r.elapsedMs}ms`)
        .join('; ')}`,
    );
    const names = [
      'deadlockFree',
      'terminatesAtSink',
      'exactlyOneTerminal',
      ...(cancel ? [] : ['neverCanceled']),
      ...(compiled.budget ? ['permitsBounded', 'permitsReturned'] : []),
    ];
    expect(Object.keys(verdicts), `${label} ${segment}`).toEqual(names);
    for (const [p, r] of Object.entries(verdicts)) expect(r.verdict.type, `${label} ${segment}/${p} via ${r.route}`).toBe('proven');
  }
}

// ---------------------------------------------------------------------------------------------

describe('loop resume: proofs', () => {
  it.each(['dowhile', 'dountil'] as const)('proves prime;%s(tick);ship fresh and resumed at [1]', async (loopType) => {
    await expectAllProven(`prime;${loopType}(tick, bound 3);ship`, build(between(loop(loopType, 3))));
  });

  it.each([1, 2])('proves it at k=%i', async (k) => {
    await expectAllProven(`prime;dowhile(tick, bound 3);ship at k=${k}`, build(between(loop('dowhile', 3)), k));
  });

  it('proves a retrying body (a timed retry hop behind the site)', async () => {
    await expectAllProven('prime;dowhile(tick retries 1 10ms, bound 3);ship', build(between(loop('dowhile', 3, { ...tick, retries: 1, retryDelayMs: 10 }))));
  });
});

describe('loop resume: only the resumed iteration is resumed (control-flow.ts:785-788)', () => {
  it('re-runs iteration n from the stored payload, resumed; n + 1 onward and the next entry run fresh', async () => {
    const clock = new ManualClock(EPOCH);
    const runner = new LoopRunner(increment, (_o, iteration) => iteration < 5);
    const report = await resume(build(between(loop('dowhile', 10))), runner, new Map([['tick', SUSPENDED_AT_3]]), { clock });

    expect(report.outcome).toEqual({ status: 'success', output: 10 });
    expect(runner.calls.map(({ stepId, input, resumed }) => ({ stepId, input, resumed }))).toEqual([
      // The seed's data is ignored: the record is the state (`:729-733`).
      { stepId: 'tick', input: 7, resumed: true },
      { stepId: 'tick', input: 8, resumed: false },
      { stepId: 'tick', input: 9, resumed: false },
      { stepId: 'ship', input: 10, resumed: false },
    ]);
    // The condition counts on from the stored iteration (`:727-728`, `:847`).
    expect(runner.conditions.map((c) => [c.iteration, c.output])).toEqual([
      [3, 8],
      [4, 9],
      [5, 10],
    ]);
  });

  it("writes the resumed iteration's record from the suspended one: payload and start kept, the iteration stamped", async () => {
    const clock = new ManualClock(EPOCH);
    const runner = new LoopRunner(increment, (_o, iteration) => iteration < 4);
    await resume(build(between(loop('dowhile', 10))), runner, new Map([['tick', SUSPENDED_AT_3]]), { clock });

    // What the condition of iteration 3 saw under the body's id — the resumed call's record.
    expect(runner.conditions[0]?.body).toEqual({
      status: 'success',
      output: 8,
      payload: 7,
      startedAt: EPOCH - 500,
      endedAt: EPOCH,
      metadata: { iterationCount: 3 },
    });
    // Iteration 4 is fresh: its own payload and its own start.
    expect(runner.conditions[1]?.body).toEqual({
      status: 'success',
      output: 9,
      payload: 8,
      startedAt: EPOCH,
      endedAt: EPOCH,
      metadata: { iterationCount: 4 },
    });
  });

  it.each(['dowhile', 'dountil'] as const)('%s: a resumed loop whose condition settles at once runs one resumed iteration', async (loopType) => {
    const runner = new LoopRunner(increment, () => loopType === 'dountil');
    const report = await resume(build(between(loop(loopType, 10))), runner, new Map([['tick', SUSPENDED_AT_3]]));
    expect(report.outcome).toEqual({ status: 'success', output: 8 });
    expect(runner.calls.map((c) => [c.stepId, c.resumed])).toEqual([
      ['tick', true],
      ['ship', false],
    ]);
  });

  it('keeps resumed on every retry of the resumed iteration, and gives the next iteration none', async () => {
    let attempts = 0;
    const runner = new LoopRunner(
      (input, call) => (call.attempt === 0 && ++attempts === 1 ? { status: 'failed', error: 'flaky' } : increment(input)),
      (_o, iteration) => iteration < 4,
    );
    const report = await resume(build(between(loop('dowhile', 10, { ...tick, retries: 1, retryDelayMs: 10 }))), runner, new Map([['tick', SUSPENDED_AT_3]]));
    expect(report.outcome).toEqual({ status: 'success', output: 9 });
    expect(runner.calls.map(({ stepId, attempt, resumed }) => [stepId, attempt, resumed])).toEqual([
      ['tick', 0, true],
      ['tick', 1, true],
      ['tick', 0, false],
      ['ship', 0, false],
    ]);
  });

  it('a fresh loop marks no call resumed', async () => {
    const runner = new LoopRunner(increment, (_o, iteration) => iteration < 3);
    const report = await runWorkflowDetailed(build(between(loop('dowhile', 10))), 0, { runner, clock: new ManualClock(EPOCH) });
    expect(report.outcome).toEqual({ status: 'success', output: 3 });
    expect(runner.calls.map((c) => [c.stepId, c.resumed])).toEqual([
      ['prime', false],
      ['tick', false],
      ['tick', false],
      ['tick', false],
      ['ship', false],
    ]);
  });

  it('with no record under the body, starts from the seed at iteration 1, and that first run is the resumed one', async () => {
    const runner = new LoopRunner(increment, (_o, iteration) => iteration < 2);
    const report = await resume(build(between(loop('dowhile', 10))), runner, new Map(), { data: 40 });
    expect(report.outcome).toEqual({ status: 'success', output: 42 });
    expect(runner.calls.map(({ stepId, input, resumed }) => [stepId, input, resumed])).toEqual([
      ['tick', 40, true],
      ['tick', 41, false],
      ['ship', 42, false],
    ]);
    expect(runner.conditions.map((c) => c.iteration)).toEqual([1, 2]);
  });
});

describe('loop resume: suspending again', () => {
  it('the resumed iteration suspends again: the loop leaves suspended at its own path, the record keeps payload and start', async () => {
    const clock = new ManualClock(EPOCH + 1_000);
    const runner = new LoopRunner(() => ({ status: 'suspended', suspendPayload: { ask: 'still?' } }), () => true);
    const report = await resume(build(between(loop('dowhile', 10))), runner, new Map([['tick', SUSPENDED_AT_3]]), { clock });

    // The body shares the loop's path, so a suspension names [1] — the site the next resume decodes.
    expect(report.outcome).toEqual({ status: 'suspended', stepId: 'tick', path: [1], payload: { ask: 'still?' } });
    expect(report.stepResults.get('tick')).toEqual({
      status: 'suspended',
      suspendPayload: { ask: 'still?' },
      payload: 7,
      startedAt: EPOCH - 500,
      suspendedAt: EPOCH + 1_000,
      metadata: { iterationCount: 3 },
    });
    expect(runner.calls.map((c) => [c.stepId, c.resumed])).toEqual([['tick', true]]);
    expect(runner.conditions).toEqual([]);
  });

  it('a later iteration suspends fresh: not resumed, its own payload, start and iteration', async () => {
    const clock = new ManualClock(EPOCH);
    let n = 0;
    const runner = new LoopRunner(
      (input) => (++n === 2 ? { status: 'suspended', suspendPayload: 'second' } : increment(input)),
      () => true,
    );
    const report = await resume(build(between(loop('dowhile', 10))), runner, new Map([['tick', SUSPENDED_AT_3]]), { clock });

    expect(report.outcome).toEqual({ status: 'suspended', stepId: 'tick', path: [1], payload: 'second' });
    expect(runner.calls.map(({ input, resumed }) => [input, resumed])).toEqual([
      [7, true],
      [8, false],
    ]);
    expect(report.stepResults.get('tick')).toEqual({
      status: 'suspended',
      suspendPayload: 'second',
      payload: 8,
      startedAt: EPOCH,
      suspendedAt: EPOCH,
      metadata: { iterationCount: 4 },
    });
  });
});

describe('loop resume: the allowance restarts at the bound (docs/divergences.md row 13)', () => {
  it('a resumed loop gets the full bound again, counted in body runs of this segment', async () => {
    const runner = new LoopRunner(increment, () => true);
    const report = await resume(build(between(loop('dowhile', 2))), runner, new Map([['tick', SUSPENDED_AT_3]]));

    // Iterations 3 and 4 — two body runs, the bound — then the bound fails the run.
    expect(runner.calls.map((c) => [c.stepId, c.input, c.resumed])).toEqual([
      ['tick', 7, true],
      ['tick', 8, false],
    ]);
    expect(runner.conditions.map((c) => c.iteration)).toEqual([3, 4]);
    expect(report.outcome).toEqual({ status: 'failed', stepId: 'tick', path: [1], error: expect.any(Error) });
    expect(String((report.outcome as { error: unknown }).error)).toMatch(/iterationBound of 2.*iterationCount 4/);
  });

  it('at a bound of one the resumed iteration is the only one', async () => {
    const runner = new LoopRunner(increment, () => true);
    const report = await resume(build(between(loop('dowhile', 1))), runner, new Map([['tick', SUSPENDED_AT_3]]));
    expect(runner.calls.map((c) => [c.stepId, c.resumed])).toEqual([['tick', true]]);
    expect(report.outcome).toEqual({ status: 'failed', stepId: 'tick', path: [1], error: expect.any(Error) });
  });
});

describe('loop resume: cancellation', () => {
  it('a resume already aborted is swept at loop-in: nothing runs, the suspended record stays', async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = new LoopRunner(increment, () => true);
    const report = await resume(build(between(loop('dowhile', 3))), runner, new Map([['tick', SUSPENDED_AT_3]]), { signal: controller.signal });

    expect(report.outcome).toEqual({ status: 'canceled', origin: { stepId: 'tick', path: [1] }, started: false });
    expect(runner.calls).toEqual([]);
    expect(report.stepResults.get('tick')).toEqual(SUSPENDED_AT_3);
  });

  it('at k=1 a resumed loop runs to its end and every permit comes back', async () => {
    const runner = new LoopRunner(increment, (_o, iteration) => iteration < 4);
    const report = await resume(build(between(loop('dowhile', 3)), 1), runner, new Map([['tick', SUSPENDED_AT_3]]));
    // `classify` reports any permit count other than k at rest as residue.
    expect(report.outcome).toEqual({ status: 'success', output: 9 });
    expect(runner.calls.map((c) => c.resumed)).toEqual([true, false, false]);
  });
});

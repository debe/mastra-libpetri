import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Transition, enumerateBranches, one, outPlace, place } from 'libpetri';
import { compile, stepGadget, StepPreemptedError, type Gadget } from '../../src/compiler/index.js';
import type { EntryPath } from '../../src/compiler/names.js';
import { KernelRunScope, runWorkflowDetailed } from '../../src/engine/index.js';
import type {
  CompiledWorkflow,
  EntryDescription,
  LifecycleEvent,
  PreemptedToken,
  QuotaRef,
  StepCall,
  StepDescription,
  StepOutcome,
  StepRunner,
  WorkflowDescription,
} from '../../src/compiler/types.js';
import { ManualClock } from '../support/manual-clock.js';
import { attemptGate, reportedVerdict } from '../../src/mastra/attempt-gate.js';

/**
 * The leaf's `preempted` branch ([ADR 0014]): on every attempt of an arm of a deciding block, the
 * permit and quotas back; `StepCall.preempt` on every attempt, passed on and never read; the branch
 * taken exactly when the runner's frozen verdict (`StepOutcome.verdict`) is `preempted`, the record
 * then `canceled` with the verdict's `StepPreemptedError` and, when the host never started the step,
 * no start of its own; an `own` verdict stands whatever the block decides afterwards; a `timedOut`
 * verdict is a timeout, and a preemption that fired first is never one.
 *
 * The decision gadget (`blueprints/first-k.ts`) is not in this file's scope, so an arm is made by a
 * test gadget that hands the leaf `ctx.preempt` and forwards the `preempted` token to `next` as data,
 * where the run's outcome shows it. The run scope's `preempt` / `preemption` are replaced by a fake
 * (one `AbortController` per block path), so these tests depend on the leaf alone. The scripted
 * runner freezes its verdicts with the Mastra runner's own `attemptGate` (host side, where reading a
 * signal is allowed); `tests/engine/race.test.ts` runs the real runner end to end.
 *
 * Environment: the kernel (`runWorkflowDetailed`) with a scripted runner and the tests'
 * `ManualClock`, libpetri 8.0.0 from the registry (not linked). Everything here is tested, not proven.
 */

const EPOCH = 1_700_000_000_000;
const BLOCK: EntryPath = [7];
const wf = (...entries: EntryDescription[]): WorkflowDescription => ({ id: 'preempt', entries });
const step = (id: string, extra: Omit<StepDescription, 'kind' | 'id'> = {}): StepDescription => ({ kind: 'step', id, ...extra });
const L1: QuotaRef = { id: 'L', kind: 'limit', n: 1 };

// --- the fake scope: one controller per block path, as `RunScope.preemption` promises -------------

let controllers = new Map<string, AbortController>();
const controllerOf = (path: EntryPath): AbortController => {
  const key = path.join('.');
  let c = controllers.get(key);
  if (c === undefined) {
    c = new AbortController();
    controllers.set(key, c);
  }
  return c;
};
/** The block decides: what its `met` / `short` action does through `scope.preempt`. */
const decide = (outcome: 'met' | 'short' = 'met'): StepPreemptedError => {
  const reason = new StepPreemptedError('blk', BLOCK, outcome);
  controllerOf(BLOCK).abort(reason);
  return reason;
};

beforeEach(() => {
  controllers = new Map();
  vi.spyOn(KernelRunScope.prototype, 'preemption').mockImplementation((path: EntryPath) => controllerOf(path).signal);
  vi.spyOn(KernelRunScope.prototype, 'preempt').mockImplementation((path: EntryPath, reason: StepPreemptedError) => {
    const c = controllerOf(path);
    if (!c.signal.aborted) c.abort(reason);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

// --- the arm wrapper --------------------------------------------------------------------------------

/**
 * Compiles the steps named in `arms` as arms of the deciding block `BLOCK`; every other step as
 * usual. The `preempted` token is forwarded to `next` as `{ exit: 'preempted', token }`.
 */
function armsOf(...arms: string[]): Gadget {
  const ids = new Set(arms);
  return (entry, next, ctx) => {
    if (entry.kind !== 'step' || !ids.has(entry.id)) return stepGadget(entry, next, ctx);
    const preempted = place<PreemptedToken>(ctx.names.entryPlace(ctx.path, entry.id, 'preempted'));
    const result = stepGadget(entry, next, { ...ctx, preempt: { place: preempted, block: BLOCK, blockId: 'blk' } });
    const collect = Transition.builder(ctx.names.entryTransition(ctx.path, entry.id, 'collect-preempted'))
      .inputs(one(preempted))
      .outputs(outPlace(next))
      .action(async (tctx) => {
        tctx.output(next, { data: { exit: 'preempted', token: tctx.input(preempted) } });
      })
      .build();
    return { ...result, transitions: [...result.transitions, collect] };
  };
}

// --- runner and helpers -----------------------------------------------------------------------------

type Script = (input: unknown, call: StepCall) => StepOutcome | Promise<StepOutcome>;
/**
 * A host-side runner: the verdict is frozen as `MastraStepRunner` freezes it, through the same
 * `attemptGate` — a fired gate before the attempt does not start the step; otherwise the step runs
 * and the verdict is frozen when it settles, after which `afterFreeze` runs (where the Mastra runner
 * applies state and awaits scorers). `plain` freezes nothing, as a runner unaware of M7b.
 */
class ScriptedRunner implements StepRunner {
  readonly calls: { readonly stepId: string; readonly call: StepCall }[] = [];
  /** The calls that started the step. */
  readonly ran: { readonly stepId: string; readonly attempt: number; readonly runAborted: boolean }[] = [];
  readonly events: LifecycleEvent[] = [];
  constructor(
    readonly script: Readonly<Record<string, Script>> = {},
    readonly options: { readonly plain?: boolean; readonly afterFreeze?: (stepId: string) => void | Promise<void> } = {},
  ) {}
  async run(stepId: string, input: unknown, call: StepCall): Promise<StepOutcome> {
    this.calls.push({ stepId, call });
    const fn = Object.hasOwn(this.script, stepId) ? this.script[stepId] : undefined;
    const body = async (): Promise<StepOutcome> => {
      this.ran.push({ stepId, attempt: call.attempt, runAborted: call.abortSignal.aborted });
      return fn === undefined ? { status: 'success', output: input } : fn(input, call);
    };
    if (this.options.plain === true) return body();
    const gate = attemptGate(stepId, call, new AbortController());
    try {
      if (gate.expired()) {
        const verdict = gate.freeze();
        return { status: 'failed', error: verdict.kind === 'own' ? undefined : verdict.reason, verdict: reportedVerdict(verdict, false) };
      }
      const outcome = await body();
      const verdict = gate.freeze();
      await this.options.afterFreeze?.(stepId);
      return gate.decisive ? { ...outcome, verdict: reportedVerdict(verdict, true) } : outcome;
    } finally {
      gate.release();
    }
  }
  observe(event: LifecycleEvent): void {
    this.events.push(event);
  }
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

/** A `ManualClock` that runs `onAdvance` the first time it jumps virtual time — inside a retry delay. */
class HookClock extends ManualClock {
  constructor(private readonly onAdvance: () => void) {
    super(EPOCH);
  }
  #fired = false;
  override async sleep(delayMs: number, ready: () => boolean, signal: AbortSignal): Promise<void> {
    if (!this.#fired && Number.isFinite(delayMs) && !signal.aborted && !ready()) {
      this.#fired = true;
      this.onAdvance();
    }
    return super.sleep(delayMs, ready, signal);
  }
}

const transitionNamed = (compiled: CompiledWorkflow, name: string): Transition => {
  const t = [...compiled.net.transitions].find((x) => x.name === name);
  if (t === undefined) throw new Error(`no transition '${name}'`);
  return t;
};
const branches = (t: Transition): string[][] =>
  enumerateBranches(t.outputSpec!)
    .map((b) => [...b].map((p) => p.name).sort())
    .sort((x, y) => x.join().localeCompare(y.join()));

// ---------------------------------------------------------------------------------------------------

describe('leaf preemption — arcs', () => {
  // Mutation: drop `outcomes.push(branch(preempt.place))` (or build it without `back`) -> fails.
  it('every attempt of an arm gains exactly one branch: preempted, with the permit and quota back', () => {
    const description = wf(step('a', { retries: 2, retryDelayMs: 5, timeoutMs: 100, quotas: [L1] }));
    const plain = compile(description, { concurrency: 1 });
    const arm = compile(description, { concurrency: 1, gadgets: { step: armsOf('a') } });
    const attempts = arm.steps[0]!.attempts;
    expect(attempts).toEqual(plain.steps[0]!.attempts);
    expect(attempts).toHaveLength(3);
    for (const name of attempts) {
      const added = ['s.0.a.preempted', 'wf.permits', 'wf.quota.L'];
      const expected = [...branches(transitionNamed(plain, name)), added].sort((x, y) => x.join().localeCompare(y.join()));
      expect(branches(transitionNamed(arm, name))).toEqual(expected);
    }
  });

  // Mutation: emit the branch whenever the leaf runs, preempt or not -> fails.
  it('a step that is not an arm compiles exactly as before', () => {
    const description = wf(step('a', { retries: 1 }), step('b'));
    const plain = compile(description);
    const other = compile(description, { gadgets: { step: armsOf('b') } });
    for (const name of other.steps.find((c) => c.stepId === 'a')!.attempts) {
      expect(branches(transitionNamed(other, name))).toEqual(branches(transitionNamed(plain, name)));
    }
    expect([...other.net.places].some((p) => p.name === 's.0.a.preempted')).toBe(false);
  });
});

describe('leaf preemption — runtime', () => {
  // Mutation: leave `preempt` out of the runner call -> `call.preempt` undefined -> fails.
  it('hands every attempt of an arm the block signal, and no signal to a step that is not an arm', async () => {
    const runner = new ScriptedRunner({ a: (_i, call) => (call.attempt === 0 ? { status: 'failed', error: 'once' } : { status: 'success', output: 1 }) });
    const report = await runWorkflowDetailed(compile(wf(step('a', { retries: 1 }), step('b')), { gadgets: { step: armsOf('a') } }), 'in', {
      runner,
      clock: new ManualClock(EPOCH),
    });
    expect(report.outcome.status).toBe('success');
    const signal = controllerOf(BLOCK).signal;
    expect(runner.calls.map((c) => [c.stepId, c.call.attempt, c.call.preempt === signal])).toEqual([
      ['a', 0, true],
      ['a', 1, true],
      ['b', 0, false],
    ]);
    expect(runner.calls[2]!.call).not.toHaveProperty('preempt');
  });

  // Mutation: ignore a `preempted` verdict (fall through to the status) -> the failure is retried.
  it('a preempted verdict while the step runs: outcome discarded, never retried, recorded canceled with the reason', async () => {
    let reason: StepPreemptedError | undefined;
    const runner = new ScriptedRunner({
      a: async (_i, call) => {
        reason = decide();
        await aborted(call.preempt!);
        return { status: 'failed', error: 'stopped', payload: 'validated' };
      },
    });
    const report = await runWorkflowDetailed(compile(wf(step('a', { retries: 2 })), { gadgets: { step: armsOf('a') } }), 'in', {
      runner,
      clock: new ManualClock(EPOCH),
    });
    expect(runner.calls).toHaveLength(1);
    expect(report.outcome).toEqual({
      status: 'success',
      output: { exit: 'preempted', token: { stepId: 'a', path: [0], reason, stepPayload: 'validated', stepStartedAt: EPOCH } },
    });
    const record = report.stepResults.get('a')!;
    expect(record).toEqual({ status: 'canceled', reason, payload: 'validated', startedAt: EPOCH, endedAt: EPOCH });
    expect((record as { reason: unknown }).reason).toBeInstanceOf(StepPreemptedError);
    const settled = runner.events.filter((e) => e.kind === 'step-settled');
    expect(settled).toEqual([{ kind: 'step-settled', stepId: 'a', path: [0], record }]);
  });

  // Mutation: take the preempted branch only for a failed outcome -> the success leaves by `next`.
  it('a step that ignores the decision and succeeds before the freeze is still discarded', async () => {
    const runner = new ScriptedRunner({
      a: () => {
        decide('short');
        return { status: 'success', output: 'late' };
      },
    });
    const report = await runWorkflowDetailed(compile(wf(step('a'), step('b'))), 'in', { runner, clock: new ManualClock(EPOCH) });
    expect(report.outcome).toEqual({ status: 'success', output: 'late' }); // sanity: not an arm, not discarded
    controllers = new Map();
    const armed = new ScriptedRunner(runner.script);
    const arm = await runWorkflowDetailed(compile(wf(step('a'), step('b')), { gadgets: { step: armsOf('a') } }), 'in', {
      runner: armed,
      clock: new ManualClock(EPOCH),
    });
    // `b` receives the forwarded preempted token, never `'late'`.
    expect(armed.calls.map((c) => c.stepId)).toEqual(['a', 'b']);
    expect((arm.outcome as { output: { exit: string } }).output.exit).toBe('preempted');
    expect(arm.stepResults.get('a')).toMatchObject({ status: 'canceled', payload: 'in' });
    expect(arm.stepResults.get('a')).not.toHaveProperty('output');
  });

  // R1, the leaf's half. Mutation: the leaf re-sampling the preemption at settle (or the gate not
  // freezing) -> the success applied before the decision is recorded canceled.
  it('decided after the verdict froze: the own outcome stands — a surplus success, not a loser', async () => {
    const runner = new ScriptedRunner({ a: () => ({ status: 'success', output: 'mine' }) }, { afterFreeze: () => void decide() });
    const report = await runWorkflowDetailed(compile(wf(step('a')), { gadgets: { step: armsOf('a') } }), 'in', {
      runner,
      clock: new ManualClock(EPOCH),
    });
    expect(controllerOf(BLOCK).signal.aborted).toBe(true); // the block did decide, before the leaf resumed
    expect(report.outcome).toEqual({ status: 'success', output: 'mine' });
    expect(report.stepResults.get('a')).toEqual({ status: 'success', output: 'mine', payload: 'in', startedAt: EPOCH, endedAt: EPOCH });
  });

  // The guard against reading the signal in the leaf. Mutation: the leaf testing
  // `preemption.aborted` at settle -> the outcome is replaced by the preempted branch.
  it('a runner that freezes no verdict: a preemption never reaches the branch, the outcome stands', async () => {
    const runner = new ScriptedRunner(
      {
        a: () => {
          decide();
          return { status: 'success', output: 'kept' };
        },
      },
      { plain: true },
    );
    const report = await runWorkflowDetailed(compile(wf(step('a')), { gadgets: { step: armsOf('a') } }), 'in', {
      runner,
      clock: new ManualClock(EPOCH),
    });
    expect(controllerOf(BLOCK).signal.aborted).toBe(true);
    expect(report.outcome).toEqual({ status: 'success', output: 'kept' });
  });

  // Mutation: drop the runner's pre-start check -> the step runs.
  it('decided before the attempt: the step is not started, and the record has no start', async () => {
    let reason: StepPreemptedError | undefined;
    const runner = new ScriptedRunner({
      p: (input) => {
        reason = decide();
        return { status: 'success', output: input };
      },
    });
    const report = await runWorkflowDetailed(compile(wf(step('p'), step('a', { timeoutMs: 50 })), { gadgets: { step: armsOf('a') } }), 'in', {
      runner,
      clock: new ManualClock(EPOCH),
    });
    expect(runner.ran.map((c) => c.stepId)).toEqual(['p']);
    expect(report.outcome).toEqual({ status: 'success', output: { exit: 'preempted', token: { stepId: 'a', path: [1], reason } } });
    expect(report.stepResults.get('a')).toEqual({ status: 'canceled', reason, payload: 'in', endedAt: EPOCH });
  });

  // Mutation: drop the runner's pre-start check -> attempt 1 runs after the delay.
  it('decided during a retry delay: the delay runs out, then the next attempt leaves by preempted without running', async () => {
    let reason: StepPreemptedError | undefined;
    const clock = new HookClock(() => {
      reason = decide();
    });
    const runner = new ScriptedRunner({ a: () => ({ status: 'failed', error: 'boom' }) });
    const report = await runWorkflowDetailed(
      compile(wf(step('a', { retries: 2, retryDelayMs: 50 })), { gadgets: { step: armsOf('a') } }),
      'in',
      { runner, clock },
    );
    expect(runner.calls.map((c) => c.call.attempt)).toEqual([0, 1]);
    expect(runner.ran.map((c) => c.attempt)).toEqual([0]);
    expect(clock.elapsed()).toBe(50); // the one delay, finished; no second
    expect(report.outcome).toEqual({
      status: 'success',
      output: { exit: 'preempted', token: { stepId: 'a', path: [0], reason, stepStartedAt: EPOCH } },
    });
    // The first attempt's start, carried on the retry token.
    expect(report.stepResults.get('a')).toEqual({ status: 'canceled', reason, payload: 'in', startedAt: EPOCH, endedAt: EPOCH + 50 });
  });

  // First fired wins. Mutation: the gate's pre-fix rule 2 (a run abort by the freeze -> own) -> the
  // failure stands and is recorded `failed`.
  it('preempted, then the run aborted before the freeze: the arm is preempted, recorded canceled, never retried', async () => {
    const run = new AbortController();
    let reason: StepPreemptedError | undefined;
    const runner = new ScriptedRunner({
      a: () => {
        reason = decide();
        run.abort();
        return { status: 'failed', error: 'stopped' };
      },
    });
    const report = await runWorkflowDetailed(compile(wf(step('a', { retries: 2 }), step('b')), { gadgets: { step: armsOf('a') } }), 'in', {
      runner,
      clock: new ManualClock(EPOCH),
      signal: run.signal,
    });
    expect(runner.ran.map((c) => c.attempt)).toEqual([0]);
    expect(report.stepResults.get('a')).toMatchObject({ status: 'canceled', reason });
    expect(reason).toBeInstanceOf(StepPreemptedError);
    expect(report.stepResults.get('a')).not.toHaveProperty('error');
  });

  // First fired wins. Mutation: the preemption ranked over a run abort whenever both fired -> `canceled`.
  it('the run aborted, then preempted before the freeze: the step outcome stands', async () => {
    const run = new AbortController();
    const runner = new ScriptedRunner({
      a: () => {
        run.abort();
        decide();
        return { status: 'failed', error: 'stopped' };
      },
    });
    const report = await runWorkflowDetailed(compile(wf(step('a'), step('b')), { gadgets: { step: armsOf('a') } }), 'in', {
      runner,
      clock: new ManualClock(EPOCH),
      signal: run.signal,
    });
    expect(report.outcome.status).toBe('canceled');
    expect(report.stepResults.get('a')).toMatchObject({ status: 'failed', error: 'stopped' });
    expect(report.stepResults.get('a')).not.toHaveProperty('reason');
  });

  // R3. Mutation: the runner's pre-start check ignoring the run's abort -> attempt 1 is not run and
  // leaves `preempted`, or (as before the fix) fails without running and is retried.
  it('run abort and preemption both fired before a retry: the step runs, signal aborted, and its outcome stands', async () => {
    const run = new AbortController();
    const clock = new HookClock(() => {
      decide();
      run.abort();
    });
    const runner = new ScriptedRunner({
      a: (_i, call) => (call.attempt === 0 ? { status: 'failed', error: 'boom' } : { status: 'success', output: 'ran-anyway' }),
    });
    const report = await runWorkflowDetailed(
      compile(wf(step('a', { retries: 1, retryDelayMs: 50 })), { gadgets: { step: armsOf('a') } }),
      'in',
      { runner, clock, signal: run.signal },
    );
    expect(runner.ran).toEqual([
      { stepId: 'a', attempt: 0, runAborted: false },
      { stepId: 'a', attempt: 1, runAborted: true },
    ]);
    expect(report.stepResults.get('a')).toMatchObject({ status: 'success', output: 'ran-anyway' });
    expect(report.stepResults.get('a')).not.toHaveProperty('reason');
  });

  // R4. Mutation: the gate taking the deadline whenever it has fired (the old precedence) -> the
  // loser times out, is retried, and the run fails with a StepTimeoutError.
  it('preempted first, then the deadline fires: preempted, never a timeout, never retried', async () => {
    let reason: StepPreemptedError | undefined;
    const runner = new ScriptedRunner({
      a: async (_i, call) => {
        reason = decide();
        await aborted(call.deadline!);
        return { status: 'success', output: 'ignored both' };
      },
    });
    const report = await runWorkflowDetailed(compile(wf(step('a', { timeoutMs: 100, retries: 2 })), { gadgets: { step: armsOf('a') } }), 'in', {
      runner,
      clock: new ManualClock(EPOCH),
    });
    expect(runner.calls).toHaveLength(1);
    expect(report.outcome).toEqual({
      status: 'success',
      output: { exit: 'preempted', token: { stepId: 'a', path: [0], reason, stepStartedAt: EPOCH } },
    });
    expect(report.stepResults.get('a')).toEqual({ status: 'canceled', reason, payload: 'in', startedAt: EPOCH, endedAt: EPOCH + 100 });
  });

  // Mutation: the gate taking the preemption whenever it has fired -> attempt 0 leaves preempted.
  it('the deadline first, then the preemption: a timeout, retried; the retry is preempted without running', async () => {
    let reason: StepPreemptedError | undefined;
    const runner = new ScriptedRunner({
      a: async (_i, call) => {
        await aborted(call.deadline!);
        reason = decide();
        return { status: 'success', output: 'late' };
      },
    });
    const report = await runWorkflowDetailed(compile(wf(step('a', { timeoutMs: 100, retries: 1 })), { gadgets: { step: armsOf('a') } }), 'in', {
      runner,
      clock: new ManualClock(EPOCH),
    });
    expect(runner.calls.map((c) => c.call.attempt)).toEqual([0, 1]);
    expect(runner.ran.map((c) => c.attempt)).toEqual([0]);
    expect(report.outcome).toEqual({
      status: 'success',
      output: { exit: 'preempted', token: { stepId: 'a', path: [0], reason, stepStartedAt: EPOCH } },
    });
  });

  // Mutation: a verdict the step cannot take recorded as the step's status -> success.
  it('a verdict off its step (a timeout without a deadline) fails the step by name', async () => {
    const runner = new ScriptedRunner({ a: () => ({ status: 'success', output: 1, verdict: { kind: 'timedOut' } }) }, { plain: true });
    const report = await runWorkflowDetailed(compile(wf(step('a'))), 'in', { runner, clock: new ManualClock(EPOCH) });
    expect(report.outcome.status).toBe('failed');
    expect(String((report.outcome as { error: unknown }).error)).toMatch(/'timedOut' verdict for step 'a', which has no timeout/);
  });

  // Mutation: leave `release()` out of the preempted branch -> `c` never gets the permit or the
  // quota token, and the run strands.
  it('row 110: a loser behind an exhausted limit enters after the decision, is not started, and gives the permit and quota back', async () => {
    const runner = new ScriptedRunner({
      holder: (input) => {
        decide();
        return { status: 'success', output: input };
      },
    });
    const description = wf({ kind: 'parallel', id: 'p', arms: [step('holder', { quotas: [L1] }), step('a', { quotas: [L1] })] }, step('c', { quotas: [L1] }));
    const report = await runWorkflowDetailed(compile(description, { concurrency: 1, gadgets: { step: armsOf('a') } }), 'in', {
      runner,
      clock: new ManualClock(EPOCH),
    });
    expect(runner.ran.map((c) => c.stepId)).toEqual(['holder', 'c']);
    expect(report.outcome.status).toBe('success');
    expect(report.stepResults.get('a')).toMatchObject({ status: 'canceled', reason: expect.any(StepPreemptedError) });
  });

  // Mutation: drop the runner's pre-start check -> `a` runs once its slot frees.
  it('row 110: a loser behind a block slot enters after the decision and is not started', async () => {
    const runner = new ScriptedRunner({
      holder: (input) => {
        decide();
        return { status: 'success', output: input };
      },
    });
    const description = wf({ kind: 'parallel', id: 'p', arms: [step('holder'), step('a')], concurrency: 1 });
    const report = await runWorkflowDetailed(compile(description, { gadgets: { step: armsOf('a') } }), 'in', {
      runner,
      clock: new ManualClock(EPOCH),
    });
    expect(runner.ran.map((c) => c.stepId)).toEqual(['holder']);
    expect(report.outcome.status).toBe('success');
    expect(report.stepResults.get('a')).toMatchObject({ status: 'canceled' });
  });
});

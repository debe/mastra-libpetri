import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createStep, createWorkflow, type ExecutionGraph } from '@mastra/core/workflows';
import { RequestContext } from '@mastra/core/di';
import { EventEmitterPubSub } from '@mastra/core/events';
import { StepExecutor } from '@mastra/core/workflows/evented';
import { PetriExecutionEngine } from '../../src/mastra/engine.js';
import { MastraStepRunner, type MastraStepRunnerOptions } from '../../src/mastra/runner.js';
import { attemptGate } from '../../src/mastra/attempt-gate.js';
import { StepPreemptedError } from '../../src/compiler/preempt.js';
import { StepTimeoutError } from '../../src/compiler/timeout.js';
import type { StepCall } from '../../src/compiler/types.js';

/**
 * The runner's half of [ADR 0014]: `StepCall.preempt` is one more source of the attempt's gate, and
 * the runner owns the attempt's **verdict**, frozen at one point (`AttemptGate.freeze`) and reported
 * as `StepOutcome.verdict`, first fired wins: a run abort that fired first lets the step's own outcome
 * stand, a deadline that fired first is `timedOut`, a preemption that fired first is `preempted`; a
 * later signal never re-decides, and nothing that fires after the freeze changes it. The step's signal aborts once, with the first source's reason. Effects
 * (state, resume labels, scorers) are applied iff the verdict is `own`; the writer drops chunks while
 * it is not. Called with the block already decided and the run live, the step is not started; with
 * the run aborted too it is run, as Mastra's default engine runs it. `forgetSuspension` drops a
 * suspended loser's resume labels. The preemption is a bare controller the test fires.
 *
 * Environment: `MastraStepRunner` on Mastra's `StepExecutor`, called directly; libpetri 8.0.0 from
 * the registry (not linked). Tested, not proven. Each case names the mutation that breaks it.
 */

type Wf = any;
type Ctx = Record<string, any>;

const wf = (id = 'w'): Wf =>
  createWorkflow({ id, inputSchema: z.any(), outputSchema: z.any(), stateSchema: z.any(), executionEngine: new PetriExecutionEngine({}) } as never);
const step = (id: string, fn: (ctx: Ctx) => unknown, extra: Record<string, unknown> = {}) =>
  createStep({ id, inputSchema: z.any(), outputSchema: z.any(), stateSchema: z.any(), execute: async (ctx: unknown) => fn(ctx as Ctx), ...extra } as never);

function direct(w: Wf, extra: Partial<MastraStepRunnerOptions> = {}) {
  const graph = w.buildExecutionGraph() as ExecutionGraph;
  const abortController = new AbortController();
  const runner = new MastraStepRunner({
    executor: new StepExecutor({ mastra: { pubsub: new EventEmitterPubSub() } as never }),
    graph,
    workflowId: graph.id,
    runId: 'run-1',
    requestContext: new RequestContext(),
    abortController,
    initialState: { k: 0 },
    validateInputs: true,
    resourceId: undefined,
    mastra: undefined,
    ...extra,
  });
  return { runner, abortController };
}

/** An arm's call at `path`, over the run's signal, with a block preemption the test fires. */
function arm(path: readonly number[], run: AbortController, extra: Partial<StepCall> = {}) {
  const block = new AbortController();
  const call: StepCall = {
    path,
    initData: 0,
    getStepResult: () => undefined,
    abortSignal: run.signal,
    source: 'step',
    attempt: 0,
    preempt: block.signal,
    ...extra,
  };
  const reason = new StepPreemptedError('pick', [path[0]!], 'met');
  const fire = () => block.abort(reason);
  return { call, fire, reason };
}

/** Resolves when `signal` aborts. */
const aborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener('abort', () => resolve(), { once: true })));
/** An already-aborted signal with `reason`. */
const fired = (reason: unknown): AbortSignal => {
  const c = new AbortController();
  c.abort(reason);
  return c.signal;
};

describe('the gate with a preemption', () => {
  it('is not transparent: the attempt signal aborts with the StepPreemptedError, the run does not', () => {
    // Mutation: keep the transparent branch when only `preempt` is given -> the controller is the run's.
    const run = new AbortController();
    const block = new AbortController();
    const gate = attemptGate('s', { path: [0, 1], attempt: 0, abortSignal: run.signal, preempt: block.signal }, run);
    expect(gate.controller).not.toBe(run);
    expect(gate.expired()).toBe(false);
    const reason = new StepPreemptedError('pick', [0], 'short');
    block.abort(reason);
    expect(gate.controller.signal.aborted).toBe(true);
    expect(gate.controller.signal.reason).toBe(reason);
    expect(gate.expired()).toBe(true);
    expect(run.signal.aborted).toBe(false);
    gate.release();
  });

  it('expired() holds on the preemption alone, without any deadline', () => {
    // Mutation: `expired = () => deadline?.aborted === true` -> false after the preemption.
    const run = new AbortController();
    const block = new AbortController();
    const gate = attemptGate('s', { path: [0, 0], attempt: 0, abortSignal: run.signal, preempt: block.signal }, run);
    block.abort(new StepPreemptedError('pick', [0], 'met'));
    expect(gate.expired()).toBe(true);
  });

  it('a run abort is not an expiry: the step reads the run reason and the gate stays open', () => {
    // Mutation: `expired()` true on the run's abort -> a cancel would be discarded like a preemption.
    const run = new AbortController();
    const block = new AbortController();
    const gate = attemptGate('s', { path: [0, 0], attempt: 0, abortSignal: run.signal, preempt: block.signal }, run);
    run.abort('cancel');
    expect(gate.controller.signal.reason).toBe('cancel');
    expect(gate.expired()).toBe(false);
  });

  it('live firing is first-come: a preemption then a deadline leaves the preemption as the reason', () => {
    // Mutation: re-abort on every source (a new controller per source) -> reason becomes the timeout.
    const run = new AbortController();
    const block = new AbortController();
    const deadline = new AbortController();
    const gate = attemptGate('s', { path: [0, 0], attempt: 0, abortSignal: run.signal, deadline: deadline.signal, preempt: block.signal }, run);
    const reason = new StepPreemptedError('pick', [0], 'met');
    block.abort(reason);
    deadline.abort(new StepTimeoutError('s', [0, 0], 5, 0));
    run.abort('cancel');
    expect(gate.controller.signal.reason).toBe(reason);
  });

  it('sources already fired at the call: precedence run abort, then deadline, then preemption', () => {
    // Mutation: list `preempt` before `deadline` / the run's signal in the gate's sources -> fails.
    const reason = new StepPreemptedError('pick', [0], 'met');
    const timeout = new StepTimeoutError('s', [0, 0], 5, 0);
    const fired = (r: unknown) => {
      const c = new AbortController();
      c.abort(r);
      return c.signal;
    };
    const run = new AbortController();
    run.abort('cancel');
    const all = attemptGate('s', { path: [0, 0], attempt: 0, abortSignal: run.signal, deadline: fired(timeout), preempt: fired(reason) }, run);
    expect(all.controller.signal.reason).toBe('cancel');
    const live = new AbortController();
    const two = attemptGate('s', { path: [0, 0], attempt: 0, abortSignal: live.signal, deadline: fired(timeout), preempt: fired(reason) }, live);
    expect(two.controller.signal.reason).toBe(timeout);
  });

  it('release() unlinks it from the shared block signal', () => {
    // Mutation: make release() a no-op -> the released gate's signal aborts with the block.
    const run = new AbortController();
    const block = new AbortController();
    const gate = attemptGate('s', { path: [0, 0], attempt: 0, abortSignal: run.signal, preempt: block.signal }, run);
    gate.release();
    block.abort(new StepPreemptedError('pick', [0], 'met'));
    expect(gate.controller.signal.aborted).toBe(false);
    expect(gate.expired()).toBe(true);
  });
});

describe('a running arm', () => {
  it('a cooperative step sees signal.reason as the StepPreemptedError; the run is not aborted', async () => {
    // Mutation: the transparent gate under `preempt` -> the step never sees an abort and hangs.
    let fire!: () => void;
    const w = wf()
      .parallel([
        step('a', async ({ abortSignal }) => {
          queueMicrotask(() => fire());
          await aborted(abortSignal as AbortSignal);
          return { reason: (abortSignal as AbortSignal).reason };
        }),
        step('b', () => 1),
      ])
      .commit();
    const { runner, abortController } = direct(w);
    const a = arm([0, 0], abortController);
    fire = a.fire;
    const outcome = await runner.run('a', 1, a.call);
    expect((outcome as { output?: { reason?: unknown } }).output?.reason).toBe(a.reason);
    expect(abortController.signal.aborted).toBe(false);
  });

  it("a step's own abort() still cancels the run", async () => {
    // Mutation: the gate controller's abort() aborting the attempt only -> the run stays live.
    const { runner, abortController } = direct(wf().parallel([step('quitter', ({ abort }) => (abort(), 1)), step('b', () => 1)]).commit());
    await runner.run('quitter', 1, arm([0, 0], abortController).call);
    expect(abortController.signal.aborted).toBe(true);
  });

  it('a preemption already fired when the attempt begins: the step is not started', async () => {
    // Mutation: drop the pre-start `gate.expired()` check -> the step runs.
    const execute = vi.fn(() => 1);
    const { runner, abortController } = direct(wf().parallel([step('never', execute), step('b', () => 1)]).commit());
    const a = arm([0, 0], abortController);
    a.fire();
    const outcome = await runner.run('never', 1, a.call);
    expect(execute).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: 'failed' });
    expect((outcome as { error?: unknown }).error).toBe(a.reason);
    // Not started: the leaf's record takes no start of its own.
    expect(outcome.verdict).toEqual({ kind: 'preempted', reason: a.reason, started: false });
  });
});

describe('the verdict, frozen once', () => {
  it('gate rule: deadline first is a timeout, a later preemption does not change it', () => {
    // Mutation: preemption ranked over the deadline -> 'preempted'.
    const run = new AbortController();
    const block = new AbortController();
    const deadline = new AbortController();
    const gate = attemptGate('s', { path: [0, 0], attempt: 0, abortSignal: run.signal, deadline: deadline.signal, preempt: block.signal }, run);
    const timeout = new StepTimeoutError('s', [0, 0], 5, 0);
    deadline.abort(timeout);
    block.abort(new StepPreemptedError('pick', [0], 'met'));
    expect(gate.freeze()).toEqual({ kind: 'timedOut', reason: timeout });
  });

  it('gate rule (R4): preemption first, then the deadline, is preempted', () => {
    // Mutation: the deadline ranked over the preemption whenever both fired -> 'timedOut'.
    const run = new AbortController();
    const block = new AbortController();
    const deadline = new AbortController();
    const gate = attemptGate('s', { path: [0, 0], attempt: 0, abortSignal: run.signal, deadline: deadline.signal, preempt: block.signal }, run);
    const reason = new StepPreemptedError('pick', [0], 'met');
    block.abort(reason);
    deadline.abort(new StepTimeoutError('s', [0, 0], 5, 0));
    expect(gate.freeze()).toEqual({ kind: 'preempted', reason });
  });

  it('gate rule: run abort first, then the preemption, is own — the step\'s outcome stands', () => {
    // Mutation: rank the preemption over a run abort whenever both fired -> 'preempted'.
    const run = new AbortController();
    const block = new AbortController();
    const gate = attemptGate('s', { path: [0, 0], attempt: 0, abortSignal: run.signal, preempt: block.signal }, run);
    run.abort('cancel');
    block.abort(new StepPreemptedError('pick', [0], 'met'));
    expect(gate.expired()).toBe(false);
    expect(gate.freeze()).toEqual({ kind: 'own' });
  });

  it('gate rule: preemption first, then a run abort, is preempted — a later signal never re-decides', () => {
    // Mutation: the pre-fix rule 2 (a run abort by the freeze -> own) -> 'own'.
    const run = new AbortController();
    const block = new AbortController();
    const gate = attemptGate('s', { path: [0, 0], attempt: 0, abortSignal: run.signal, preempt: block.signal }, run);
    const reason = new StepPreemptedError('pick', [0], 'met');
    block.abort(reason);
    expect(gate.expired()).toBe(true);
    run.abort('cancel');
    expect(gate.expired()).toBe(true);
    expect(gate.freeze()).toEqual({ kind: 'preempted', reason });
  });

  it('gate rule: deadline first, then a run abort, stays a timeout', () => {
    // Mutation: a run abort ranked over a deadline that fired before it -> 'own'.
    const run = new AbortController();
    const deadline = new AbortController();
    const gate = attemptGate('s', { path: [0, 0], attempt: 0, abortSignal: run.signal, deadline: deadline.signal }, run);
    const timeout = new StepTimeoutError('s', [0, 0], 5, 0);
    deadline.abort(timeout);
    run.abort('cancel');
    expect(gate.freeze()).toEqual({ kind: 'timedOut', reason: timeout });
  });

  it('frozen is frozen: nothing that fires afterwards changes the verdict or reopens the effects', () => {
    // Mutation: `freeze()` recomputing on every call (`frozen = current()`) -> 'preempted' after the fire.
    const run = new AbortController();
    const block = new AbortController();
    const gate = attemptGate('s', { path: [0, 0], attempt: 0, abortSignal: run.signal, preempt: block.signal }, run);
    expect(gate.freeze()).toEqual({ kind: 'own' });
    block.abort(new StepPreemptedError('pick', [0], 'met'));
    expect(gate.freeze()).toEqual({ kind: 'own' });
    expect(gate.verdict()).toEqual({ kind: 'own' });
    expect(gate.expired()).toBe(false);
  });

  it('an own outcome on a gated call carries verdict own; an ungated call carries none', async () => {
    // Mutation: report no verdict on an own outcome -> the leaf's deadline race could still override it.
    const w = wf().parallel([step('a', () => 1), step('b', () => 2)]).commit();
    const { runner, abortController } = direct(w);
    const gated = await runner.run('a', 1, arm([0, 0], abortController).call);
    expect(gated).toMatchObject({ status: 'success', output: 1, verdict: { kind: 'own' } });
    const { call } = arm([0, 1], abortController);
    const { preempt: _p, ...plain } = call;
    const ungated = await runner.run('b', 1, plain);
    expect(ungated).not.toHaveProperty('verdict');
  });

  it('R1: a decision that lands while async scorers run does not discard the attempt — state committed, verdict own', async () => {
    // Mutation: freeze after the scorers (or the old gate check after executor.execute only, with the
    // leaf re-sampling later) -> the verdict reads 'preempted' with the state already committed.
    let fire!: () => void;
    let attemptSignal: AbortSignal | undefined;
    let scorersAwaited = false;
    const w = wf()
      .parallel([
        step(
          'slowScore',
          async ({ setState, abortSignal }) => {
            attemptSignal = abortSignal as AbortSignal;
            await setState({ k: 42 });
            return 'done';
          },
          {
            scorers: async () => {
              // The block decides here, after the step returned and before the runner returns.
              fire();
              await aborted(attemptSignal!);
              scorersAwaited = true;
              return {};
            },
          },
        ),
        step('b', () => 1),
      ])
      .commit();
    const { runner, abortController } = direct(w);
    const a = arm([0, 0], abortController);
    fire = a.fire;
    const outcome = await runner.run('slowScore', 1, a.call);
    expect(scorersAwaited).toBe(true);
    expect(outcome).toMatchObject({ status: 'success', output: 'done', verdict: { kind: 'own' } });
    expect(runner.state).toEqual({ k: 42 });
  });

  it('R1 with a suspending arm: frozen own before the decision, its label is kept for the join to forget', async () => {
    // Mutation: withdrawing labels on any later preemption -> the label is gone while the verdict is own.
    let fire!: () => void;
    const w = wf()
      .parallel([
        step('susp', async ({ suspend, setState }) => {
          await setState({ k: 3 });
          await suspend({ q: 1 }, { resumeLabel: 'susp-label' });
        }, { scorers: async () => (fire(), {}) }),
        step('b', () => 1),
      ])
      .commit();
    const { runner, abortController } = direct(w);
    const a = arm([0, 0], abortController);
    fire = a.fire;
    const outcome = await runner.run('susp', 1, a.call);
    expect(outcome).toMatchObject({ status: 'suspended', verdict: { kind: 'own' } });
    expect(runner.state).toEqual({ k: 3 });
    expect(runner.resumeLabels).toEqual({ 'susp-label': { stepId: 'susp', foreachIndex: undefined } });
  });

  it('a suspension after the decision: verdict preempted, no state, no label', async () => {
    // Mutation: apply state or keep labels on a non-own verdict -> { k: 9 } / 'loser-label' remain.
    let fire!: () => void;
    const w = wf()
      .parallel([
        step('loser', async ({ suspend, setState, abortSignal }) => {
          fire();
          await aborted(abortSignal as AbortSignal);
          await setState({ k: 9 });
          await suspend({ q: 1 }, { resumeLabel: 'loser-label' });
        }),
        step('b', () => 1),
      ])
      .commit();
    const { runner, abortController } = direct(w);
    const a = arm([0, 0], abortController);
    fire = a.fire;
    const outcome = await runner.run('loser', 1, a.call);
    expect(outcome.verdict).toEqual({ kind: 'preempted', reason: a.reason, started: true });
    expect(runner.state).toEqual({ k: 0 });
    expect(runner.resumeLabels).toEqual({});
  });

  it('preempted, then the run canceled before the step settles: verdict preempted, no state, no label', async () => {
    // Mutation: the pre-fix rule 2 (a run abort by the freeze -> own) -> verdict own, { k: 4 } and 'pc' land.
    let fire!: () => void;
    let cancel!: () => void;
    const w = wf()
      .parallel([
        step('pc', async ({ suspend, setState, abortSignal }) => {
          fire();
          await aborted(abortSignal as AbortSignal);
          cancel();
          await setState({ k: 4 });
          await suspend({ q: 1 }, { resumeLabel: 'pc' });
        }),
        step('b', () => 1),
      ])
      .commit();
    const { runner, abortController } = direct(w);
    const a = arm([0, 0], abortController);
    fire = a.fire;
    cancel = () => abortController.abort('cancel');
    const outcome = await runner.run('pc', 1, a.call);
    expect(abortController.signal.aborted).toBe(true);
    expect(outcome.verdict).toEqual({ kind: 'preempted', reason: a.reason, started: true });
    expect(runner.state).toEqual({ k: 0 });
    expect(runner.resumeLabels).toEqual({});
  });

  it('the run canceled, then preempted, before the step settles: verdict own, its effects land', async () => {
    // Mutation: rank the preemption over a run abort whenever both fired -> verdict preempted, nothing lands.
    let fire!: () => void;
    const w = wf()
      .parallel([
        step('cp', async ({ suspend, setState, abortSignal }) => {
          await aborted(abortSignal as AbortSignal);
          fire();
          await setState({ k: 6 });
          await suspend({ q: 1 }, { resumeLabel: 'cp' });
        }),
        step('b', () => 1),
      ])
      .commit();
    const { runner, abortController } = direct(w);
    const a = arm([0, 0], abortController);
    fire = a.fire;
    queueMicrotask(() => abortController.abort('cancel'));
    const outcome = await runner.run('cp', 1, a.call);
    expect(outcome).toMatchObject({ status: 'suspended', verdict: { kind: 'own' } });
    expect(runner.state).toEqual({ k: 6 });
    expect(runner.resumeLabels).toEqual({ cp: { stepId: 'cp', foreachIndex: undefined } });
  });

  it('R3: run abort and preemption both fired before the call — the step runs, signal aborted, verdict own', async () => {
    // Mutation: the pre-start check ignoring the run's abort -> the step is not started.
    let saw: unknown;
    const execute = vi.fn(({ abortSignal }: Ctx) => {
      saw = { aborted: (abortSignal as AbortSignal).aborted, reason: (abortSignal as AbortSignal).reason };
      return 'ran';
    });
    const w = wf().parallel([step('retry', execute), step('b', () => 1)]).commit();
    const { runner, abortController } = direct(w);
    const a = arm([0, 0], abortController, { attempt: 1 });
    a.fire();
    abortController.abort('cancel');
    const outcome = await runner.run('retry', 1, a.call);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(saw).toEqual({ aborted: true, reason: 'cancel' });
    expect(outcome).toMatchObject({ status: 'success', output: 'ran', verdict: { kind: 'own' } });
  });

  it('R4: preempted, then the deadline: verdict preempted', async () => {
    // Mutation: the deadline ranked first whenever it fired -> 'timedOut', which the leaf retries.
    const deadline = new AbortController();
    let fire!: () => void;
    const w = wf()
      .parallel([
        step('both', async ({ abortSignal }) => {
          fire();
          await aborted(abortSignal as AbortSignal);
          deadline.abort(new StepTimeoutError('both', [0, 0], 5, 0));
          return 'late';
        }),
        step('b', () => 1),
      ])
      .commit();
    const { runner, abortController } = direct(w);
    const a = arm([0, 0], abortController, { deadline: deadline.signal });
    fire = a.fire;
    const outcome = await runner.run('both', 1, a.call);
    expect(outcome.verdict).toEqual({ kind: 'preempted', reason: a.reason, started: true });
  });

  it('a deadline already fired at the call: not started, verdict timedOut', async () => {
    // Mutation: report the verdict as own on the pre-start path -> the leaf would record a failure.
    const execute = vi.fn(() => 1);
    const { runner, abortController } = direct(wf().parallel([step('never', execute), step('b', () => 1)]).commit());
    const a = arm([0, 0], abortController, { deadline: fired(new StepTimeoutError('never', [0, 0], 5, 0)) });
    const outcome = await runner.run('never', 1, a.call);
    expect(execute).not.toHaveBeenCalled();
    expect(outcome.verdict).toEqual({ kind: 'timedOut' });
  });
});

describe('after the preemption, the attempt has no effect', () => {
  it('no state update, no resume label, no writer chunk, no scorers', async () => {
    // Mutation: `expired()` ignoring the preemption -> state becomes { k: 99 } and the label lands.
    let fire!: () => void;
    const scorers = vi.fn(() => ({}));
    const outputWriter = vi.fn(async (_chunk: unknown) => {});
    const w = wf()
      .parallel([
        step(
          'late',
          async ({ setState, writer, outputWriter: out, suspend, abortSignal }) => {
            await writer.write('before');
            fire();
            await aborted(abortSignal as AbortSignal);
            await setState({ k: 99 });
            await writer.write('after');
            await writer.custom({ type: 'data-after' });
            await out({ type: 'raw-after' });
            await suspend({ q: 1 }, { resumeLabel: 'late-label' });
          },
          { scorers },
        ),
        step('b', () => 1),
      ])
      .commit();
    const { runner, abortController } = direct(w, { outputWriter });
    const a = arm([0, 0], abortController);
    fire = a.fire;
    await runner.run('late', 1, a.call);
    expect(runner.state).toEqual({ k: 0 });
    expect(runner.resumeLabels).toEqual({});
    expect(outputWriter).toHaveBeenCalledTimes(1);
    expect(outputWriter.mock.calls[0]![0]).toMatchObject({ payload: { output: 'before' } });
    expect(scorers).not.toHaveBeenCalled();
  });

  it('a label named before the preemption is never committed when the attempt is discarded', async () => {
    // Mutation: commit the pending labels before the verdict check -> 'early' stays in resumeLabels.
    let fire!: () => void;
    const w = wf()
      .parallel([
        step('early', async ({ suspend }) => {
          await suspend({ q: 1 }, { resumeLabel: 'early' });
          fire();
        }),
        step('b', () => 1),
      ])
      .commit();
    const { runner, abortController } = direct(w);
    const a = arm([0, 0], abortController);
    fire = a.fire;
    await runner.run('early', 1, a.call);
    expect(runner.resumeLabels).toEqual({});
  });

  it('a reused label name: a discarded attempt neither erases nor keeps the label another step wrote', async () => {
    // Mutation: the pre-fix write-at-suspend with delete-on-withdrawal -> resumeLabels {}.
    let fire!: () => void;
    const w = wf()
      .parallel([
        step('a', async ({ suspend }) => {
          await suspend({ q: 1 }, { resumeLabel: 'approve' });
        }),
        step('b', async ({ suspend, abortSignal }) => {
          fire();
          await aborted(abortSignal as AbortSignal);
          await suspend({ q: 2 }, { resumeLabel: 'approve' });
        }),
      ])
      .commit();
    const { runner, abortController } = direct(w);
    const first = arm([0, 0], abortController);
    const { preempt: _p, ...plain } = first.call;
    await runner.run('a', 1, plain);
    expect(runner.resumeLabels).toEqual({ approve: { stepId: 'a', foreachIndex: undefined } });
    const b = arm([0, 1], abortController);
    fire = b.fire;
    const outcome = await runner.run('b', 1, b.call);
    expect(outcome.verdict).toMatchObject({ kind: 'preempted' });
    expect(runner.resumeLabels).toEqual({ approve: { stepId: 'a', foreachIndex: undefined } });
  });

  it('a reused label name: an own attempt behind a gate overwrites it when it settles', async () => {
    // Mutation: never commit the pending labels -> 'approve' still names 'a'.
    const w = wf()
      .parallel([
        step('a', async ({ suspend }) => {
          await suspend({ q: 1 }, { resumeLabel: 'approve' });
        }),
        step('b', async ({ suspend }) => {
          await suspend({ q: 2 }, { resumeLabel: 'approve' });
        }),
      ])
      .commit();
    const { runner, abortController } = direct(w);
    const { preempt: _p, ...plain } = arm([0, 0], abortController).call;
    await runner.run('a', 1, plain);
    const outcome = await runner.run('b', 1, arm([0, 1], abortController).call);
    expect(outcome).toMatchObject({ status: 'suspended', verdict: { kind: 'own' } });
    expect(runner.resumeLabels).toEqual({ approve: { stepId: 'b', foreachIndex: undefined } });
  });

  it('control: an arm whose block never decides keeps every effect', async () => {
    // Mutation: `expired()` always true under a preemption source -> nothing lands.
    const w = wf()
      .parallel([
        step('kept', async ({ setState, suspend }) => {
          await setState({ k: 5 });
          await suspend({ q: 1 }, { resumeLabel: 'kept' });
        }),
        step('b', () => 1),
      ])
      .commit();
    const { runner, abortController } = direct(w);
    const outcome = await runner.run('kept', 1, arm([0, 0], abortController).call);
    expect(outcome).toMatchObject({ status: 'suspended' });
    expect(runner.state).toEqual({ k: 5 });
    expect(runner.resumeLabels).toEqual({ kept: { stepId: 'kept', foreachIndex: undefined } });
  });
});

describe('forgetSuspension', () => {
  /** Two arms that suspend, each with its own label, and a third label `shared` that `b` wrote last. */
  async function twoSuspended() {
    const w = wf()
      .parallel([
        step('a', async ({ suspend }) => suspend({ q: 'a' }, { resumeLabel: ['a-1', 'a-2', 'shared'] })),
        step('b', async ({ suspend }) => suspend({ q: 'b' }, { resumeLabel: ['b-1', 'shared'] })),
      ])
      .commit();
    const { runner, abortController } = direct(w);
    await runner.run('a', 1, arm([0, 0], abortController).call);
    await runner.run('b', 1, arm([0, 1], abortController).call);
    return runner;
  }

  it("drops every label naming the step and keeps the others'", async () => {
    // Mutation: make forgetSuspension a no-op -> 'a-1' and 'a-2' stay.
    const runner = await twoSuspended();
    expect(Object.keys(runner.resumeLabels).sort()).toEqual(['a-1', 'a-2', 'b-1', 'shared']);
    runner.forgetSuspension('a');
    expect(runner.resumeLabels).toEqual({
      'b-1': { stepId: 'b', foreachIndex: undefined },
      shared: { stepId: 'b', foreachIndex: undefined },
    });
  });

  it('matches by the step a label resumes, not by label name', async () => {
    // Mutation: delete by label names the step once wrote -> 'shared', now b's, would go too.
    const runner = await twoSuspended();
    runner.forgetSuspension('b');
    expect(runner.resumeLabels).toEqual({
      'a-1': { stepId: 'a', foreachIndex: undefined },
      'a-2': { stepId: 'a', foreachIndex: undefined },
    });
  });

  it('a step with no label is a no-op', async () => {
    const runner = await twoSuspended();
    runner.forgetSuspension('nobody');
    expect(Object.keys(runner.resumeLabels)).toHaveLength(4);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createStep, createWorkflow, type ExecutionGraph } from '@mastra/core/workflows';
import { RequestContext } from '@mastra/core/di';
import { EventEmitterPubSub } from '@mastra/core/events';
import { StepExecutor } from '@mastra/core/workflows/evented';
import { PetriExecutionEngine } from '../../src/mastra/engine.js';
import { MastraStepRunner, type MastraStepRunnerOptions } from '../../src/mastra/runner.js';
import { attemptGate } from '../../src/mastra/attempt-gate.js';
import { StepTimeoutError } from '../../src/compiler/timeout.js';
import type { StepCall } from '../../src/compiler/types.js';

/**
 * The runner's half of [ADR 0013]: when a call carries `StepCall.deadline`, the step sees one
 * per-attempt signal linked to the run's and to the deadline, its own `abort()` still cancels the
 * run, and once the deadline has fired nothing the attempt does reaches the run — no state, no
 * resume labels, no writer chunks, no scorers. Without a deadline the runner is unchanged (the
 * whole of `runner.test.ts` and `runner-resume.test.ts`). The leaf's race, which decides the
 * outcome, is not exercised here: the deadline is a bare controller the test fires.
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

/** A call at `path`, over the run's signal, with a deadline the test fires. */
function timed(path: readonly number[], run: AbortController, extra: Partial<StepCall> = {}) {
  const deadline = new AbortController();
  const call: StepCall = {
    path,
    initData: 0,
    getStepResult: () => undefined,
    abortSignal: run.signal,
    source: 'step',
    attempt: 0,
    deadline: deadline.signal,
    ...extra,
  };
  const fire = (stepId: string) => deadline.abort(new StepTimeoutError(stepId, path, 10, call.attempt));
  return { call, fire };
}

/** Resolves when `signal` aborts. */
const aborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener('abort', () => resolve(), { once: true })));

describe('the attempt signal', () => {
  it('a cooperative step sees signal.reason as the StepTimeoutError; the run is not aborted', async () => {
    let fire!: (id: string) => void;
    const w = wf()
      .then(
        step('slow', async ({ abortSignal }) => {
          queueMicrotask(() => fire('slow'));
          await aborted(abortSignal as AbortSignal);
          return { reason: (abortSignal as AbortSignal).reason };
        }),
      )
      .commit();
    const { runner, abortController } = direct(w);
    const t = timed([0], abortController);
    fire = t.fire;
    const outcome = await runner.run('slow', 1, t.call);
    const reason = (outcome as { output?: { reason?: unknown } }).output?.reason;
    expect(reason).toBeInstanceOf(StepTimeoutError);
    expect(reason).toMatchObject({ stepId: 'slow', path: [0], attempt: 0 });
    expect(abortController.signal.aborted).toBe(false);
  });

  it('a run abort reaches the step with the run\'s reason, not a timeout', async () => {
    let seen: unknown;
    const { runner, abortController } = direct(
      wf()
        .then(
          step('slow', async ({ abortSignal }) => {
            queueMicrotask(() => abortController.abort('cancel'));
            await aborted(abortSignal as AbortSignal);
            seen = (abortSignal as AbortSignal).reason;
            return 1;
          }),
        )
        .commit(),
    );
    await runner.run('slow', 1, timed([0], abortController).call);
    expect(seen).toBe('cancel');
  });

  it('a step\'s own abort() still cancels the run under a deadline', async () => {
    const { runner, abortController } = direct(wf().then(step('quitter', ({ abort }) => (abort(), 1))).commit());
    await runner.run('quitter', 1, timed([0], abortController).call);
    expect(abortController.signal.aborted).toBe(true);
  });

  it('a nested workflow step gets the attempt signal: the child run is canceled on the deadline', async () => {
    let fire!: (id: string) => void;
    let childSaw: unknown;
    const inner = step('inner', async ({ abortSignal }) => {
      queueMicrotask(() => fire('child'));
      await aborted(abortSignal as AbortSignal);
      childSaw = 'aborted';
      return 1;
    });
    const child = createWorkflow({ id: 'child', inputSchema: z.any(), outputSchema: z.any() } as never).then(inner as never).commit();
    const { runner, abortController } = direct(wf().then(child).commit());
    const t = timed([0], abortController);
    fire = t.fire;
    await runner.run('child', 1, t.call);
    expect(childSaw).toBe('aborted');
    expect(abortController.signal.aborted).toBe(false);
  });

  it('the gate releases its listeners, and without a deadline is the run\'s own controller', () => {
    const run = new AbortController();
    const transparent = attemptGate('s', { path: [0], attempt: 0, abortSignal: run.signal }, run);
    expect(transparent.controller).toBe(run);
    expect(transparent.expired()).toBe(false);
    const stream = {};
    expect(transparent.writer(stream)).toBe(stream);

    const deadline = new AbortController();
    const gate = attemptGate('s', { path: [0], attempt: 0, abortSignal: run.signal, deadline: deadline.signal }, run);
    gate.release();
    deadline.abort(new StepTimeoutError('s', [0], 1, 0));
    expect(gate.controller.signal.aborted).toBe(false); // unlinked
    expect(gate.expired()).toBe(true);
  });
});

describe('after the deadline, the attempt has no effect', () => {
  it('no state update, no resume label, no writer chunk, no scorers', async () => {
    let fire!: (id: string) => void;
    const scorers = vi.fn(() => ({}));
    const outputWriter = vi.fn(async (_chunk: unknown) => {});
    const w = wf()
      .then(
        step(
          'late',
          async ({ setState, writer, outputWriter: out, suspend, abortSignal }) => {
            await writer.write('before');
            fire('late');
            await aborted(abortSignal as AbortSignal);
            await setState({ k: 99 });
            await writer.write('after');
            await writer.custom({ type: 'data-after' });
            await out({ type: 'raw-after' });
            await suspend({ q: 1 }, { resumeLabel: 'late-label' });
          },
          { scorers },
        ),
      )
      .commit();
    const { runner, abortController } = direct(w, { outputWriter });
    const t = timed([0], abortController);
    fire = t.fire;
    await runner.run('late', 1, t.call);
    expect(runner.state).toEqual({ k: 0 });
    expect(runner.resumeLabels).toEqual({});
    expect(outputWriter).toHaveBeenCalledTimes(1);
    expect(outputWriter.mock.calls[0]![0]).toMatchObject({ payload: { output: 'before' } });
    expect(scorers).not.toHaveBeenCalled();
  });

  it('a step that returns success after the deadline applies nothing either', async () => {
    let fire!: (id: string) => void;
    const scorers = vi.fn(() => ({}));
    const w = wf()
      .then(
        step(
          'ignores',
          async ({ setState }) => {
            await setState({ k: 7 });
            fire('ignores');
            return 'done';
          },
          { scorers },
        ),
      )
      .commit();
    const { runner, abortController } = direct(w);
    const t = timed([0], abortController);
    fire = t.fire;
    await runner.run('ignores', 1, t.call);
    expect(runner.state).toEqual({ k: 0 });
    expect(scorers).not.toHaveBeenCalled();
  });

  it('a deadline already fired when the attempt begins: the step is not started', async () => {
    const execute = vi.fn(() => 1);
    const { runner, abortController } = direct(wf().then(step('never', execute)).commit());
    const t = timed([0], abortController);
    t.fire('never');
    const outcome = await runner.run('never', 1, t.call);
    expect(execute).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: 'failed' });
    expect((outcome as { error?: unknown }).error).toBeInstanceOf(StepTimeoutError);
  });

  it('control: before the deadline every effect lands as without one', async () => {
    const scorers = vi.fn(() => ({}));
    const outputWriter = vi.fn(async (_chunk: unknown) => {});
    const w = wf()
      .then(
        step(
          'fast',
          async ({ setState, writer }) => {
            await setState({ k: 5 });
            await writer.write('chunk');
            return 'ok';
          },
          { scorers },
        ),
      )
      .commit();
    const { runner, abortController } = direct(w, { outputWriter });
    const outcome = await runner.run('fast', 1, timed([0], abortController).call);
    expect(outcome).toMatchObject({ status: 'success', output: 'ok' });
    expect(runner.state).toEqual({ k: 5 });
    expect(outputWriter).toHaveBeenCalledTimes(1);
    expect(scorers).toHaveBeenCalledTimes(1);
  });
});

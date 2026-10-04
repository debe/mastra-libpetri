/**
 * **A step timeout, end to end on the run's clock** ([ADR 0013]): workflows built with `init()`'s
 * factories, the petri `createStep({ timeout })`, run through Mastra's own `Run` over a real
 * `Mastra` and `InMemoryStore`, on the tests' `ManualClock` handed to the engine (`init({ clock })`,
 * [TIME-015]). Nothing here waits real time for a deadline: a deadline fires when the clock is asked
 * to sleep towards it, and the assertions read the virtual instant.
 *
 * - A cooperative step times out, is retried through its delayed hop, times out again and fails the
 *   run; the stored row's step record carries the `StepTimeoutError`.
 * - A hung step — one that ignores its signal — released by a latch: the run holds until it
 *   settles, its late success is discarded, and nothing it wrote after the deadline reaches the run
 *   (state, stream chunks).
 * - A timed step's own `abort()` still cancels the run.
 * - A nested workflow step timing out cancels its child run.
 * - A timeout inside a block-limited `.parallel()` keeps its slot until the step settles.
 *
 * Environment: `@mastra/core` from the pinned registry package, libpetri 8.0.0 (registry, not
 * linked), `ManualClock` (a finite `sleep` jumps virtual time). Tested, not proven: the timeout
 * branch and its funnel are proven in `tests/compiler/leaf-timeout.test.ts` and by `verify()`.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import type { WorkflowRunState } from '@mastra/core/workflows';
import { init } from '../../src/mastra/index.js';
import { attachResources } from '../../src/mastra/resources.js';
import { StepTimeoutError } from '../../src/compiler/timeout.js';
import { ManualClock } from '../support/manual-clock.js';

const N = z.object({ n: z.number() });
const TIMEOUT = 100;

/** A promise with its resolver, for a step the test releases by hand. */
function latch(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Resolves when `signal` aborts (at once if it already has). */
function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

/** Several macrotask turns: long enough for the executor and every armed deadline to move. */
async function turns(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function stored(storage: InMemoryStore, workflowName: string, runId: string): Promise<WorkflowRunState> {
  const store = await storage.getStore('workflows');
  if (!store) throw new Error('InMemoryStore has no workflows store');
  const snapshot = await store.loadWorkflowSnapshot({ workflowName, runId });
  if (snapshot === null) throw new Error(`no stored row for ${workflowName}/${runId}`);
  return snapshot;
}

/** Registers `workflows` on a fresh Mastra over a fresh store; `get` is Mastra's registered workflow, typed as the one given. */
function host<W extends Record<string, unknown>>(workflows: W) {
  const storage = new InMemoryStore();
  const mastra = new Mastra({ storage, workflows: workflows as never, logger: false });
  const get = <K extends keyof W & string>(id: K): W[K] => (mastra as unknown as { getWorkflow(id: string): W[K] }).getWorkflow(id);
  return { storage, get };
}

const errorOf = (record: unknown): { name?: string; message?: string } => {
  const e = (record as { error?: unknown }).error;
  return typeof e === 'object' && e !== null ? (e as { name?: string; message?: string }) : { message: String(e) };
};

describe('a cooperative step', () => {
  it('times out, is retried, times out again and fails the run with a StepTimeoutError in the stored row', async () => {
    const clock = new ManualClock();
    const { createWorkflow, createStep } = init({ clock });
    const seen: { attempt: number; at: number; reason: unknown }[] = [];
    let attempt = 0;
    const slow = createStep({
      id: 'slow',
      inputSchema: N,
      outputSchema: N,
      retries: 1,
      timeout: TIMEOUT,
      execute: async ({ inputData, abortSignal }) => {
        const mine = ++attempt;
        await aborted(abortSignal);
        seen.push({ attempt: mine, at: clock.now(), reason: abortSignal.reason });
        throw abortSignal.reason;
        return inputData;
      },
    });
    const workflow = createWorkflow({ id: 'coop', inputSchema: N, outputSchema: N }).then(slow).commit();
    const { storage, get } = host({ coop: workflow });
    const run = await get('coop').createRun({ runId: 'coop-run' });
    const result = await run.start({ inputData: { n: 1 } });

    expect(result.status).toBe('failed');
    // Two attempts, each aborted by its own deadline at exactly TIMEOUT after it began.
    expect(seen.map((s) => [s.attempt, s.at])).toEqual([
      [1, TIMEOUT],
      [2, 2 * TIMEOUT],
    ]);
    for (const s of seen) expect(s.reason).toBeInstanceOf(StepTimeoutError);
    expect(seen.map((s) => (s.reason as StepTimeoutError).attempt)).toEqual([0, 1]);
    expect(clock.now()).toBe(2 * TIMEOUT);

    // The run's own result and the stored row both name the timeout of the final attempt.
    const record = result.steps['slow'] as unknown as Record<string, unknown>;
    expect(record['status']).toBe('failed');
    expect(errorOf(record)).toMatchObject({ name: 'StepTimeoutError', message: `step 'slow' at [0] timed out after ${TIMEOUT} ms on attempt 2` });
    const row = await stored(storage, 'coop', 'coop-run');
    expect(row.status).toBe('failed');
    expect((row.context['slow'] as { status: string }).status).toBe('failed');
    expect(errorOf(row.context['slow'])).toMatchObject({ name: 'StepTimeoutError', message: `step 'slow' at [0] timed out after ${TIMEOUT} ms on attempt 2` });
  });

  it('control: a step that settles before its deadline is untouched, and moves no virtual time', async () => {
    const clock = new ManualClock();
    const { createWorkflow, createStep } = init({ clock });
    const quick = createStep({ id: 'quick', inputSchema: N, outputSchema: N, timeout: TIMEOUT, execute: async ({ inputData }) => ({ n: inputData.n + 1 }) });
    const workflow = createWorkflow({ id: 'quick', inputSchema: N, outputSchema: N }).then(quick).commit();
    const result = await (await workflow.createRun()).start({ inputData: { n: 1 } });
    expect(result.status).toBe('success');
    expect(result.status === 'success' ? result.result : undefined).toEqual({ n: 2 });
    expect(clock.now()).toBe(0);
  });
});

describe('a hung step, released by a latch', () => {
  it('holds the run until it settles; its late success, state and stream chunks are discarded', async () => {
    const clock = new ManualClock();
    const { createWorkflow, createStep } = init({ clock });
    const gate = latch();
    let signal: AbortSignal | undefined;
    let returned = false;
    const hung = createStep({
      id: 'hung',
      inputSchema: N,
      outputSchema: N,
      stateSchema: z.object({ k: z.number() }),
      timeout: TIMEOUT,
      execute: async ({ inputData, abortSignal, setState, writer }) => {
        signal = abortSignal;
        await setState({ k: 1 });
        await writer.write({ progress: 'before' });
        await gate.promise; // ignores its signal
        await setState({ k: 99 });
        await writer.write({ progress: 'after' });
        returned = true;
        return { n: inputData.n + 1000 };
      },
    });
    const workflow = createWorkflow({ id: 'hung', inputSchema: N, outputSchema: N, stateSchema: z.object({ k: z.number() }) }).then(hung).commit();
    const { storage, get } = host({ hung: workflow });
    const run = await get('hung').createRun({ runId: 'hung-run' });
    const output = run.stream({ inputData: { n: 1 }, initialState: { k: 0 }, closeOnSuspend: true });
    const chunks: unknown[] = [];
    const drained = (async () => {
      const reader = output.fullStream.getReader();
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        chunks.push(next.value);
      }
    })();
    let settled = false;
    void output.result.then(() => {
      settled = true;
    });

    // The deadline fires on the run's clock; the step ignores it and the run waits for it.
    await turns();
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBeInstanceOf(StepTimeoutError);
    expect(clock.now()).toBe(TIMEOUT);
    await turns();
    expect(settled).toBe(false);
    expect(returned).toBe(false);

    gate.release();
    await drained;
    const result = await output.result;
    expect(returned).toBe(true);
    expect(clock.now()).toBe(TIMEOUT);

    // The late success is discarded: the attempt is the timeout, the run fails.
    expect(result.status).toBe('failed');
    expect((result.steps['hung'] as { status: string }).status).toBe('failed');
    expect(errorOf(result.steps['hung'])).toMatchObject({ name: 'StepTimeoutError' });
    expect('output' in (result.steps['hung'] as object)).toBe(false);
    expect('result' in result ? result.result : undefined).toBeUndefined();

    // State: nothing it set reaches the run — not the 99 set after the deadline, and not the 1 set
    // before it either, since a failed attempt applies no state update in Mastra itself
    // (`handlers/step.ts:575-579`: the state is taken only from an `ok` attempt).
    const row = await stored(storage, 'hung', 'hung-run');
    expect(row.status).toBe('failed');
    expect(row.value).toEqual({ k: 0 });

    // Stream: the chunk written before the deadline arrives, the one after does not.
    const progress = chunks
      .filter((c) => (c as { type?: string }).type === 'workflow-step-output')
      .map((c) => JSON.stringify((c as { payload?: unknown }).payload));
    expect(progress.some((p) => p.includes('before'))).toBe(true);
    expect(progress.some((p) => p.includes('after'))).toBe(false);
    expect(JSON.stringify(chunks)).not.toContain('"after"');
  });
});

describe("a timed step's own abort()", () => {
  it('still cancels the run, before its deadline', async () => {
    const clock = new ManualClock();
    const { createWorkflow, createStep } = init({ clock });
    let after = false;
    const quitter = createStep({
      id: 'quitter',
      inputSchema: N,
      outputSchema: N,
      timeout: TIMEOUT,
      execute: async ({ inputData, abort }) => {
        abort();
        return inputData;
      },
    });
    const next = createStep({
      id: 'next',
      inputSchema: N,
      outputSchema: N,
      execute: async ({ inputData }) => {
        after = true;
        return inputData;
      },
    });
    const workflow = createWorkflow({ id: 'quit', inputSchema: N, outputSchema: N }).then(quitter).then(next).commit();
    const { storage, get } = host({ quit: workflow });
    const run = await get('quit').createRun({ runId: 'quit-run' });
    const result = await run.start({ inputData: { n: 1 } });
    expect(result.status).toBe('canceled');
    expect(after).toBe(false);
    expect(clock.now()).toBeLessThan(TIMEOUT);
    expect((await stored(storage, 'quit', 'quit-run')).status).toBe('canceled');
  });
});

describe('a nested workflow step', () => {
  it('timing out cancels its child run', async () => {
    const clock = new ManualClock();
    const { createWorkflow, createStep } = init({ clock });
    const childSaw: unknown[] = [];
    const inner = createStep({
      id: 'inner',
      inputSchema: N,
      outputSchema: N,
      execute: async ({ inputData, abortSignal }) => {
        await aborted(abortSignal);
        childSaw.push(abortSignal.reason);
        return inputData;
      },
    });
    const child = createWorkflow({ id: 'child', inputSchema: N, outputSchema: N }).then(inner).commit();
    // The nested step's own timeout: `createStep(workflow)` hands back the workflow itself, so the
    // resources are attached to it as the petri createStep attaches them to a Step.
    attachResources(child, { timeoutMs: TIMEOUT });
    const parent = createWorkflow({ id: 'parent', inputSchema: N, outputSchema: N }).then(createStep(child)).commit();
    const { storage, get } = host({ parent, child });
    const run = await get('parent').createRun({ runId: 'parent-run' });
    const result = await run.start({ inputData: { n: 1 } });

    expect(result.status).toBe('failed');
    expect(errorOf(result.steps['child'])).toMatchObject({ name: 'StepTimeoutError' });
    // The child run saw the cancel and ended canceled.
    expect(childSaw).toHaveLength(1);
    expect(clock.now()).toBe(TIMEOUT);
    const store = await storage.getStore('workflows');
    const { runs } = await store!.listWorkflowRuns({ workflowName: 'child' });
    expect(runs).toHaveLength(1);
    const childRow = typeof runs[0]!.snapshot === 'string' ? (JSON.parse(runs[0]!.snapshot) as WorkflowRunState) : runs[0]!.snapshot;
    expect(childRow.status).toBe('canceled');
  });
});

describe('a timeout inside a block-limited .parallel()', () => {
  it('keeps its slot until the step settles: the next arm waits for the hung one, not for its deadline', async () => {
    const clock = new ManualClock();
    const { createWorkflow, createStep } = init({ clock });
    const gate = latch();
    const order: string[] = [];
    let signal: AbortSignal | undefined;
    const hung = createStep({
      id: 'hung',
      inputSchema: N,
      outputSchema: N,
      timeout: TIMEOUT,
      execute: async ({ inputData, abortSignal }) => {
        order.push('hung:start');
        signal = abortSignal;
        await gate.promise;
        order.push('hung:end');
        return inputData;
      },
    });
    const arm = (id: string) =>
      createStep({
        id,
        inputSchema: N,
        outputSchema: N,
        execute: async ({ inputData }) => {
          order.push(`${id}:start`);
          return { n: inputData.n + 1 };
        },
      });
    const workflow = createWorkflow({ id: 'slots', inputSchema: N, outputSchema: z.any() })
      .parallel([hung, arm('x'), arm('y')], { metadata: { concurrency: 1 } })
      .commit();
    const { get } = host({ slots: workflow });
    const run = await get('slots').createRun({ runId: 'slots-run' });
    const pending = run.start({ inputData: { n: 1 } });

    await turns();
    // The deadline has fired; the slot is still the hung arm's, so no other arm has started.
    expect(signal?.aborted).toBe(true);
    expect(clock.now()).toBe(TIMEOUT);
    await turns();
    expect(order).toEqual(['hung:start']);

    gate.release();
    const result = await pending;
    expect(order).toEqual(['hung:start', 'hung:end', 'x:start', 'y:start']);
    // Every arm ran; the timed-out arm fails the block.
    expect(result.status).toBe('failed');
    expect(errorOf(result.steps['hung'])).toMatchObject({ name: 'StepTimeoutError' });
    expect((result.steps['x'] as { status: string }).status).toBe('success');
    expect((result.steps['y'] as { status: string }).status).toBe('success');
  });
});

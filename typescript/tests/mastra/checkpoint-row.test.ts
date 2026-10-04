import { Mastra } from '@mastra/core/mastra';
import { MASTRA_AUTH_TOKEN_KEY, RequestContext } from '@mastra/core/request-context';
import { InMemoryStore } from '@mastra/core/storage';
import { createStep, createWorkflow, type ExecutionEngine, type StepFlowEntry, type WorkflowRunState } from '@mastra/core/workflows';
import { vi } from 'vitest';
import { z } from 'zod';
import type { StepRecord } from '../../src/compiler/types.js';
import { PetriExecutionEngine } from '../../src/mastra/engine.js';
import { buildRunSnapshot, persistRun, type PersistContext, type PersistGuard } from '../../src/mastra/persist.js';
import { checkpointExecutionPath, type ResumedFrom } from '../../src/mastra/result.js';

/**
 * The checkpoint row ([ADR 0010]): a `running` write after an author-marked top-level entry, built
 * as the ADR's table says, under the default engine's `running`-write rules, awaited by its firing.
 *
 * - "the row" and "the rules" are unit tests of `buildRunSnapshot` / `persistRun` — no wave needed;
 * - "on the engine" runs real Mastra workflows marked with `metadata: { checkpoint: true }`, and
 *   needs W1's checkpoint transitions (adapter + compiler) and W2's kernel `checkpointError`.
 */

const num = z.object({ n: z.number() });
const graph = [{ type: 'step', step: { id: 'a' } }, { type: 'step', step: { id: 'b' } }, { type: 'step', step: { id: 'c' } }];
const recA: StepRecord = { status: 'success', payload: { n: 1 }, output: { n: 2 }, startedAt: 10, endedAt: 11 };

function base(extra: Partial<PersistContext> = {}) {
  const requestContext = new RequestContext();
  requestContext.set('tenant', 't1');
  requestContext.set(MASTRA_AUTH_TOKEN_KEY, 'secret');
  return {
    workflowId: 'wf',
    runId: 'r1',
    resourceId: 'res',
    input: { n: 1 },
    state: { s: 1 },
    serializedStepGraph: graph,
    requestContext,
    ...extra,
  };
}

describe('the checkpoint row', () => {
  it('is the ADR 0010 row, key for key, on a fresh run', () => {
    const row = buildRunSnapshot(
      { ...base(), phase: 'checkpoint', after: 0, records: new Map([['a', recA]]), stepExecutionPath: ['a'] },
      1234,
    );
    expect(row).toStrictEqual({
      runId: 'r1',
      value: { s: 1 },
      context: { input: { n: 1 }, a: { status: 'success', payload: { n: 1 }, output: { n: 2 }, startedAt: 10, endedAt: 11 } },
      serializedStepGraph: graph,
      waitingPaths: {},
      activeStepsPath: {},
      requestContext: { tenant: 't1' },
      timestamp: 1234,
      status: 'running',
      activePaths: [1],
      stepExecutionPath: ['a'],
      suspendedPaths: {},
      resumeLabels: {},
      result: undefined,
      error: undefined,
      tracingContext: undefined,
    });
    // Present with the value undefined, as Mastra's snapshot literal writes them.
    expect(Object.hasOwn(row, 'tracingContext')).toBe(true);
    expect(Object.hasOwn(row, 'result')).toBe(true);
    expect(Object.hasOwn(row, 'error')).toBe(true);
  });

  it('has the start row\'s key set, in the start row\'s key order', () => {
    const start = buildRunSnapshot({ ...base(), phase: 'start' }, 1);
    const checkpoint = buildRunSnapshot(
      { ...base(), phase: 'checkpoint', after: 1, records: new Map([['a', recA]]), stepExecutionPath: ['a', 'b'] },
      1,
    );
    expect(Object.keys(checkpoint)).toEqual(Object.keys(start));
  });

  it('on a restarted segment: the stored context first, verbatim and in order, then the records so far', () => {
    const stored = {
      input: { n: 1 },
      a: { status: 'success', payload: { n: 1 }, output: { n: 2 }, startedAt: 1, endedAt: 2 },
      b: { status: 'running', payload: { n: 2 }, startedAt: 3 },
    };
    const restart: ResumedFrom = { index: 1, carriedPath: ['a'], context: stored, restarted: true };
    const recB: StepRecord = { status: 'success', payload: { n: 2 }, output: { n: 3 }, startedAt: 20, endedAt: 21 };
    const row = buildRunSnapshot(
      {
        ...base({ resume: restart }),
        phase: 'checkpoint',
        after: 1,
        records: new Map([['b', recB]]),
        stepExecutionPath: checkpointExecutionPath(graph as unknown as StepFlowEntry[], 1, { index: 1, carried: ['a'], restarted: true }),
      },
      5,
    );
    expect(Object.keys(row.context)).toEqual(['input', 'a', 'b']);
    expect(row.context['a']).toStrictEqual(stored.a);
    expect(row.context['b']).toStrictEqual({ status: 'success', payload: { n: 2 }, output: { n: 3 }, startedAt: 20, endedAt: 21 });
    expect(row.activePaths).toEqual([2]);
    expect(row.stepExecutionPath).toEqual(['a', 'b']);
  });
});

describe('checkpointExecutionPath', () => {
  const entries = [
    { type: 'step', step: { id: 'a' } },
    { type: 'parallel', steps: [{ type: 'step', step: { id: 'p' } }] },
    { type: 'sleep', id: 'zz' },
    { type: 'step', step: { id: 'c' } },
  ] as unknown as StepFlowEntry[];

  it('a fresh run: every pushing entry through `after`', () => {
    expect(checkpointExecutionPath(entries, 0)).toEqual(['a']);
    expect(checkpointExecutionPath(entries, 1)).toEqual(['a']);
    expect(checkpointExecutionPath(entries, 2)).toEqual(['a', 'zz']);
  });

  it('a resumed run continues the carried list and does not push the resumed entry again', () => {
    expect(checkpointExecutionPath(entries, 2, { index: 0, carried: ['a'] })).toEqual(['a', 'zz']);
  });

  it('a restarted run continues the carried list and pushes its first entry, as Mastra\'s restart does', () => {
    expect(checkpointExecutionPath(entries, 3, { index: 2, carried: ['a'], restarted: true })).toEqual(['a', 'zz', 'c']);
    expect(checkpointExecutionPath(entries, 0, { index: 0, carried: [], restarted: true })).toEqual(['a']);
  });
});

describe('the checkpoint write, under the running-write rules', () => {
  function recordingEngine(options: Partial<ExecutionEngine['options']> = {}) {
    const writes: WorkflowRunState[] = [];
    const store = { persistWorkflowSnapshot: vi.fn(async ({ snapshot }: { snapshot: WorkflowRunState }) => void writes.push(snapshot)) };
    const engine = new PetriExecutionEngine({ options });
    (engine as unknown as { mastra: unknown }).mastra = { getStorage: () => ({ getStore: async () => store }) };
    return { engine, writes, store };
  }
  function guardWith(last: string | undefined): PersistGuard & { recorded: string[] } {
    const recorded: string[] = [];
    return { recorded, lastPersisted: () => last as never, persisted: (_id, status) => void recorded.push(status) };
  }
  const ctx = (): PersistContext => ({ ...base(), phase: 'checkpoint', after: 0, records: new Map([['a', recA]]), stepExecutionPath: ['a'] });

  it('is written and recorded as running', async () => {
    const { engine, writes } = recordingEngine();
    const guard = guardWith(undefined);
    await persistRun(engine, ctx(), guard);
    expect(writes.map((w) => [w.status, w.activePaths])).toEqual([['running', [1]]]);
    expect(guard.recorded).toEqual(['running']);
  });

  it.each(['suspended', 'paused'])('is suppressed in-process while the run was last written %s (entry.ts:195-205)', async (last) => {
    const { engine, writes } = recordingEngine();
    const guard = guardWith(last);
    await persistRun(engine, ctx(), guard);
    expect(writes).toEqual([]);
    expect(guard.recorded).toEqual([]);
  });

  it('asks shouldPersistSnapshot with the running status and the context, and writes nothing on no', async () => {
    const asked: unknown[] = [];
    const { engine, writes } = recordingEngine({
      shouldPersistSnapshot: (p) => {
        asked.push(p);
        return false;
      },
    });
    await persistRun(engine, ctx(), guardWith(undefined));
    expect(writes).toEqual([]);
    expect(asked).toEqual([{ workflowStatus: 'running', stepResults: expect.objectContaining({ input: { n: 1 }, a: expect.objectContaining({ status: 'success' }) }) }]);
  });

  it('goes through pruneSnapshot', async () => {
    const { engine, writes } = recordingEngine({
      pruneSnapshot: ({ snapshot, workflowStatus }) => ({ ...snapshot, value: { pruned: workflowStatus } }),
    });
    await persistRun(engine, ctx(), guardWith(undefined));
    expect(writes[0]?.value).toEqual({ pruned: 'running' });
  });

  it('rejects with the store\'s own error object', async () => {
    const { engine, store } = recordingEngine();
    const boom = new Error('disk full');
    store.persistWorkflowSnapshot.mockRejectedValueOnce(boom);
    const guard = guardWith(undefined);
    await expect(persistRun(engine, ctx(), guard)).rejects.toBe(boom);
    expect(guard.recorded).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// On the engine — needs W1 (checkpoint transitions) and W2 (kernel checkpointError).
// ---------------------------------------------------------------------------------------------

const marked = (id: string, mark: boolean, f: (n: number) => number) =>
  createStep({
    id,
    inputSchema: num,
    outputSchema: num,
    ...(mark ? { metadata: { checkpoint: true } } : {}),
    execute: async ({ inputData }) => ({ n: f(inputData.n) }),
  });

const gated = createStep({
  id: 'g',
  inputSchema: num,
  outputSchema: num,
  resumeSchema: z.object({ add: z.number() }),
  metadata: { checkpoint: true },
  execute: async ({ inputData, resumeData, suspend }) => {
    if (resumeData === undefined) return suspend({});
    return { n: inputData.n + resumeData.add };
  },
});

interface Recorded {
  readonly rows: WorkflowRunState[];
  readonly store: { persistWorkflowSnapshot: (...args: never[]) => Promise<void> };
}

async function recordedStore(storage: InMemoryStore, reject?: (snapshot: WorkflowRunState) => unknown): Promise<Recorded> {
  const store = (await storage.getStore('workflows'))!;
  const rows: WorkflowRunState[] = [];
  const real = store.persistWorkflowSnapshot.bind(store);
  vi.spyOn(store, 'persistWorkflowSnapshot').mockImplementation(async (args) => {
    const snapshot = structuredClone(args.snapshot);
    const error = reject?.(snapshot);
    if (error !== undefined) throw error;
    rows.push(snapshot);
    return real(args);
  });
  return { rows, store: store as never };
}

function registered<W>(wf: W, storage: InMemoryStore): W {
  const mastra = new Mastra({ storage, workflows: { wf } as never, logger: false });
  return (mastra as unknown as { getWorkflow(k: string): W }).getWorkflow('wf');
}

describe('checkpoint rows on the engine (needs W1 + W2)', () => {
  it('a checkpoint precedes the terminal row, and each is the row ADR 0010 describes', async () => {
    const storage = new InMemoryStore();
    const engine = new PetriExecutionEngine();
    const wf = registered(
      createWorkflow({ id: 'cp-linear', inputSchema: num, outputSchema: num, executionEngine: engine })
        .then(marked('a', true, (n) => n + 1))
        .then(marked('b', false, (n) => n * 10))
        .then(marked('c', false, (n) => n - 1))
        .commit(),
      storage,
    );
    const { rows } = await recordedStore(storage);
    const run = await wf.createRun({ runId: 'cp1' });
    const result = await run.start({ inputData: { n: 1 } });
    expect(result).toMatchObject({ status: 'success', result: { n: 19 } });

    // `pending` from createRun, `running` at start, the checkpoint after `a`, then `success`.
    expect(rows.map((r) => [r.status, r.activePaths])).toEqual([
      ['pending', []],
      ['running', [0]],
      ['running', [1]],
      ['success', [2]],
    ]);
    const [, start, checkpoint] = rows as [WorkflowRunState, WorkflowRunState, WorkflowRunState];
    expect(Object.keys(checkpoint)).toEqual(Object.keys(start));
    expect({ ...checkpoint, timestamp: 0, context: { ...checkpoint.context, a: { ...checkpoint.context['a'], startedAt: 0, endedAt: 0 } } }).toStrictEqual({
      runId: 'cp1',
      value: {},
      context: { input: { n: 1 }, a: { status: 'success', payload: { n: 1 }, output: { n: 2 }, startedAt: 0, endedAt: 0 } },
      serializedStepGraph: (wf as unknown as { serializedStepGraph: unknown }).serializedStepGraph,
      waitingPaths: {},
      activeStepsPath: {},
      requestContext: {},
      timestamp: 0,
      status: 'running',
      activePaths: [1],
      stepExecutionPath: ['a'],
      suspendedPaths: {},
      resumeLabels: {},
      result: undefined,
      error: undefined,
      tracingContext: undefined,
    });
  });

  it('a rejecting store rejects the run with that very error: no terminal row, no callbacks, span errored once', async () => {
    const storage = new InMemoryStore();
    const onFinish = vi.fn();
    const onError = vi.fn();
    const engine = new PetriExecutionEngine({ options: { onFinish, onError } });
    const ran: string[] = [];
    const wf = registered(
      createWorkflow({ id: 'cp-reject', inputSchema: num, outputSchema: num, executionEngine: engine })
        .then(marked('a', true, (n) => (ran.push('a'), n + 1)))
        .then(marked('b', false, (n) => (ran.push('b'), n)))
        .commit(),
      storage,
    );
    const boom = new Error('disk full');
    const { rows } = await recordedStore(storage, (s) => (s.status === 'running' && s.activePaths[0] === 1 ? boom : undefined));
    const run = await wf.createRun({ runId: 'cp2' });

    const spanCalls: string[] = [];
    const span = new Proxy({ end: () => spanCalls.push('end'), error: (a: { error: unknown }) => spanCalls.push(a.error === boom ? 'error(boom)' : 'error(other)') } as Record<string, unknown>, {
      get: (t, k) => (k in t ? t[k as string] : k === 'then' || typeof k === 'symbol' ? undefined : () => undefined),
    });
    const error = await engine
      .execute({
        workflowId: 'cp-reject',
        runId: 'cp2',
        graph: (wf as unknown as { buildExecutionGraph(): unknown }).buildExecutionGraph(),
        serializedStepGraph: (wf as unknown as { serializedStepGraph: unknown }).serializedStepGraph,
        input: { n: 1 },
        pubsub: (run as unknown as { pubsub: unknown }).pubsub,
        requestContext: new RequestContext(),
        abortController: new AbortController(),
        workflowSpan: span,
      } as never)
      .then(() => undefined, (e: unknown) => e);

    expect(error).toBe(boom);
    expect(ran).toEqual(['a']);
    expect(rows.map((r) => [r.status, r.activePaths])).toEqual([
      ['pending', []],
      ['running', [0]],
    ]);
    expect(spanCalls).toEqual(['error(boom)']);
    expect(onFinish).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('through Run.start too: start() rejects with the store\'s error', async () => {
    const storage = new InMemoryStore();
    const engine = new PetriExecutionEngine();
    const wf = registered(
      createWorkflow({ id: 'cp-reject2', inputSchema: num, outputSchema: num, executionEngine: engine })
        .then(marked('a', true, (n) => n + 1))
        .then(marked('b', false, (n) => n))
        .commit(),
      storage,
    );
    const boom = new Error('quota');
    await recordedStore(storage, (s) => (s.status === 'running' && s.activePaths[0] === 1 ? boom : undefined));
    const run = await wf.createRun({ runId: 'cp3' });
    await expect(run.start({ inputData: { n: 1 } })).rejects.toBe(boom);
  });

  it('in-process after a suspension, the checkpoint row is suppressed by the overwrite guard', async () => {
    const storage = new InMemoryStore();
    const engine = new PetriExecutionEngine();
    const wf = registered(
      createWorkflow({ id: 'cp-guard', inputSchema: num, outputSchema: num, executionEngine: engine })
        .then(gated)
        .then(marked('b', true, (n) => n * 10))
        .then(marked('c', false, (n) => n))
        .commit(),
      storage,
    );
    const { rows } = await recordedStore(storage);
    const run = await wf.createRun({ runId: 'cp4' });
    expect(await run.start({ inputData: { n: 1 } })).toMatchObject({ status: 'suspended' });
    const before = rows.length;
    const resumed = await run.resume({ step: 'g', resumeData: { add: 2 } } as never);
    expect(resumed).toMatchObject({ status: 'success', result: { n: 30 } });
    // The checkpoints after `g` and `b` are `running` writes; the engine last wrote the run
    // `suspended`, so both are skipped and the next row is the outcome.
    expect(rows.slice(before).map((r) => r.status).filter((s) => s !== 'running')).toEqual(rows.slice(before).map((r) => r.status));
    expect(rows.slice(before).map((r) => r.status).at(-1)).toBe('success');
  });

  it('the control: resumed on a fresh engine instance (another process), both checkpoint rows are written', async () => {
    const storage = new InMemoryStore();
    const build = () =>
      createWorkflow({ id: 'cp-guard', inputSchema: num, outputSchema: num, executionEngine: new PetriExecutionEngine() })
        .then(gated)
        .then(marked('b', true, (n) => n * 10))
        .then(marked('c', false, (n) => n))
        .commit();
    const first = registered(build(), storage);
    const { rows } = await recordedStore(storage);
    await (await first.createRun({ runId: 'cp5' })).start({ inputData: { n: 1 } });
    const before = rows.length;
    const second = registered(build(), storage);
    await (await second.createRun({ runId: 'cp5' })).resume({ step: 'g', resumeData: { add: 2 } } as never);
    expect(rows.slice(before).map((r) => [r.status, r.activePaths])).toEqual([
      ['running', [0]],
      ['running', [1]],
      ['running', [2]],
      ['success', [2]],
    ]);
    // The resumed segment's checkpoint continues the stored path and does not push `g` again.
    expect(rows[before + 1]?.stepExecutionPath).toEqual(['g']);
    expect(rows[before + 2]?.stepExecutionPath).toEqual(['g', 'b']);
  });
});

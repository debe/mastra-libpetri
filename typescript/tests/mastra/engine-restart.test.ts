import { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import { InMemoryStore } from '@mastra/core/storage';
import { createStep, createWorkflow, type WorkflowRunState } from '@mastra/core/workflows';
import { vi } from 'vitest';
import { z } from 'zod';
import { PetriExecutionEngine, UnsupportedRunModeError } from '../../src/mastra/engine.js';

/**
 * Restart on the petri engine ([ADR 0010]), through Mastra's own `Run.restart()` — a workflow
 * built with `createWorkflow({ executionEngine })` keeps Mastra's `'default'` engine type, so
 * `_restart` reaches `execute({ restart })` without the `init()` seam (W4's, tested apart).
 *
 * A crash is simulated by storing a row and restarting from it on a fresh engine and `Mastra`
 * (another process). Needs W1 (checkpoint transitions) and W2 (`restartSeed`, kernel seeding).
 */

const num = z.object({ n: z.number() });

function counted(id: string, f: (n: number) => number, ran: string[], mark = false) {
  return createStep({
    id,
    inputSchema: num,
    outputSchema: num,
    ...(mark ? { metadata: { checkpoint: true } } : {}),
    execute: async ({ inputData }) => {
      ran.push(id);
      return { n: f(inputData.n) };
    },
  });
}

type Engine = 'petri' | 'default';
interface Built {
  readonly wf: AnyWf;
  readonly ran: string[];
  readonly onFinish: ReturnType<typeof vi.fn>;
}
interface AnyWf {
  createRun(o: { runId: string }): Promise<{ start(a: object): Promise<unknown>; restart(a?: object): Promise<unknown>; pubsub?: unknown }>;
  readonly serializedStepGraph: unknown;
  buildExecutionGraph(): unknown;
}

/** a (checkpoint) -> b -> c on a fresh engine, registered on a fresh Mastra over `storage`. */
function linear(storage: InMemoryStore, engine: Engine, id = 'rs-linear', bId = 'b'): Built {
  const ran: string[] = [];
  const onFinish = vi.fn();
  const wf = createWorkflow({
    id,
    inputSchema: num,
    outputSchema: num,
    ...(engine === 'petri' ? { executionEngine: new PetriExecutionEngine({ options: { onFinish } }) } : { options: { onFinish } }),
  })
    .then(counted('a', (n) => n + 1, ran, true))
    .then(counted(bId, (n) => n * 10, ran))
    .then(counted('c', (n) => n - 1, ran))
    .commit();
  const mastra = new Mastra({ storage, workflows: { wf } as never, logger: false });
  return { wf: (mastra as unknown as { getWorkflow(k: string): AnyWf }).getWorkflow('wf'), ran, onFinish };
}

async function storeOf(storage: InMemoryStore) {
  return (await storage.getStore('workflows'))!;
}

/** Runs `wf` to the end on petri, keeping every row, then puts back the checkpoint row: the crash. */
async function crashAfterCheckpoint(storage: InMemoryStore, runId: string, id = 'rs-linear'): Promise<WorkflowRunState> {
  const store = await storeOf(storage);
  const real = store.persistWorkflowSnapshot.bind(store);
  const persisted: WorkflowRunState[] = [];
  const watch = vi.spyOn(store, 'persistWorkflowSnapshot').mockImplementation(async (args) => {
    persisted.push(structuredClone(args.snapshot));
    return real(args);
  });
  const { wf } = linear(storage, 'petri', id);
  await (await wf.createRun({ runId })).start({ inputData: { n: 1 } });
  watch.mockRestore();
  const checkpoint = persisted.find((r) => r.status === 'running' && r.activePaths[0] === 1);
  if (checkpoint === undefined) throw new Error(`no checkpoint row among ${persisted.map((r) => r.status).join(', ')}`);
  await real({ workflowName: id, runId, snapshot: checkpoint });
  return checkpoint;
}

/** Every write to the store from now on. */
async function recording(storage: InMemoryStore): Promise<WorkflowRunState[]> {
  const store = await storeOf(storage);
  const rows: WorkflowRunState[] = [];
  const real = store.persistWorkflowSnapshot.bind(store);
  vi.spyOn(store, 'persistWorkflowSnapshot').mockImplementation(async (args) => {
    rows.push(structuredClone(args.snapshot));
    return real(args);
  });
  return rows;
}

const MASKED = new Set(['timestamp', 'startedAt', 'endedAt', 'traceId', 'spanId']);
function comparable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, v: unknown) => (MASKED.has(key) ? '<masked>' : v)) ?? 'null');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('restart from a petri checkpoint', () => {
  it('re-runs only what follows the checkpoint, writes no start row, and continues the stored path', async () => {
    const storage = new InMemoryStore();
    await crashAfterCheckpoint(storage, 'run-1');
    const after = linear(storage, 'petri');
    const rows = await recording(storage);
    const result = (await (await after.wf.createRun({ runId: 'run-1' })).restart()) as Record<string, unknown>;

    expect(after.ran).toEqual(['b', 'c']);
    expect(result).toMatchObject({ status: 'success', result: { n: 19 }, input: { n: 1 }, stepExecutionPath: ['a', 'b', 'c'] });
    expect(Object.keys(result['steps'] as object)).toEqual(['input', 'a', 'b', 'c']);
    // No start row: the only write is the outcome.
    expect(rows.map((r) => [r.status, r.activePaths])).toEqual([['success', [2]]]);
    expect(rows[0]?.context['a']).toMatchObject({ status: 'success', output: { n: 2 } });
    expect(rows[0]?.stepExecutionPath).toEqual(['a', 'b', 'c']);
    // Mastra hands its callbacks `execute()`'s own `input` — none on a restart (default.ts:1112).
    expect(after.onFinish).toHaveBeenCalledTimes(1);
    const info = after.onFinish.mock.calls[0]?.[0] as { status: string; input?: unknown };
    expect(info.status).toBe('success');
    expect(info.input).toBeUndefined();
  });

  it('the default engine restarts the same row to the same result and the same terminal row', async () => {
    const outcomes: unknown[] = [];
    for (const engine of ['petri', 'default'] as const) {
      const storage = new InMemoryStore();
      await crashAfterCheckpoint(storage, 'run-2');
      const after = linear(storage, engine);
      const rows = await recording(storage);
      const result = await (await after.wf.createRun({ runId: 'run-2' })).restart();
      outcomes.push({ ran: after.ran, result: comparable(result), terminal: comparable(rows.at(-1)) });
    }
    expect(outcomes[0]).toEqual(outcomes[1]);
  });

  it('the stored workflow state is the restarted run\'s state', async () => {
    const storage = new InMemoryStore();
    const row = await crashAfterCheckpoint(storage, 'run-3');
    await (await storeOf(storage)).persistWorkflowSnapshot({ workflowName: 'rs-linear', runId: 'run-3', snapshot: { ...row, value: { kept: 1 } as never } });
    const after = linear(storage, 'petri');
    const rows = await recording(storage);
    await (await after.wf.createRun({ runId: 'run-3' })).restart();
    expect(rows.at(-1)?.value).toEqual({ kept: 1 });
  });
});

describe('restart refusals persist nothing', () => {
  async function refusal(mutate: (row: WorkflowRunState) => WorkflowRunState, build = (s: InMemoryStore) => linear(s, 'petri')) {
    const storage = new InMemoryStore();
    const row = await crashAfterCheckpoint(storage, 'run-r');
    const stored = mutate(structuredClone(row));
    await (await storeOf(storage)).persistWorkflowSnapshot({ workflowName: 'rs-linear', runId: 'run-r', snapshot: stored });
    const after = build(storage);
    const rows = await recording(storage);
    const error = await (await after.wf.createRun({ runId: 'run-r' })).restart().then(() => undefined, (e: unknown) => e);
    return { error, rows, ran: after.ran };
  }

  it('no-position: an empty activePaths', async () => {
    const { error, rows, ran } = await refusal((r) => ({ ...r, activePaths: [] }));
    expect(error).toBeInstanceOf(UnsupportedRunModeError);
    expect((error as UnsupportedRunModeError).mode).toBe('restart');
    expect((error as UnsupportedRunModeError).restart).toStrictEqual({ path: [], reason: 'no-position' });
    expect(rows).toEqual([]);
    expect(ran).toEqual([]);
  });

  it('no-position: past the last top-level entry', async () => {
    const { error, rows, ran } = await refusal((r) => ({ ...r, activePaths: [3] }));
    expect((error as UnsupportedRunModeError).restart).toStrictEqual({ path: [3], reason: 'no-position' });
    expect(rows).toEqual([]);
    expect(ran).toEqual([]);
  });

  it('workflow-changed: the stored step graph names a step the workflow no longer has', async () => {
    const { error, rows, ran } = await refusal(
      (r) => r,
      (s) => linear(s, 'petri', 'rs-linear', 'b2'),
    );
    expect(error).toBeInstanceOf(UnsupportedRunModeError);
    expect((error as UnsupportedRunModeError).restart).toStrictEqual({ path: [1], reason: 'workflow-changed' });
    expect(rows).toEqual([]);
    expect(ran).toEqual([]);
  });

  it('not workflow-changed: a stored graph that went through JSON, with another sleep id and other metadata', async () => {
    const { sameStepGraph } = await import('../../src/mastra/engine.js');
    const a = [
      { type: 'step', step: { id: 'a', description: 'x', metadata: { checkpoint: true } } },
      { type: 'sleep', id: 'sleep_1111', duration: 5 },
      { type: 'parallel', steps: [{ type: 'step', step: { id: 'p' } }] },
    ];
    const b = [
      { type: 'step', step: { id: 'a', description: 'y' } },
      { type: 'sleep', id: 'sleep_2222', duration: 6 },
      { type: 'parallel', steps: [{ type: 'step', step: { id: 'p' } }] },
    ];
    expect(sameStepGraph(JSON.parse(JSON.stringify(a)), b)).toBe(true);
    expect(sameStepGraph(a, [b[0], b[2], b[1]])).toBe(false);
    expect(sameStepGraph(a, [b[0], b[1], { type: 'conditional', steps: [{ type: 'step', step: { id: 'p' } }] }])).toBe(false);
    expect(sameStepGraph(a, [b[0], b[1], { type: 'parallel', steps: [{ type: 'step', step: { id: 'q' } }] }])).toBe(false);
    expect(sameStepGraph(a, b.slice(0, 2))).toBe(false);
  });
});

describe('restart, on execute() directly', () => {
  it('never mutates activePaths, which Mastra consumes with shift()', async () => {
    const storage = new InMemoryStore();
    const row = await crashAfterCheckpoint(storage, 'run-d');
    const { wf } = linear(storage, 'petri');
    const run = await wf.createRun({ runId: 'run-d' });
    const engine = (wf as unknown as { executionEngine: PetriExecutionEngine }).executionEngine;
    const activePaths = [1];
    const result = await engine.execute({
      workflowId: 'rs-linear',
      runId: 'run-d',
      graph: wf.buildExecutionGraph(),
      serializedStepGraph: wf.serializedStepGraph,
      restart: { activePaths, activeStepsPath: {}, stepResults: row.context, state: {}, stepExecutionPath: ['a'] },
      pubsub: (run as unknown as { pubsub: unknown }).pubsub,
      requestContext: new RequestContext(),
      abortController: new AbortController(),
    } as never);
    expect(activePaths).toEqual([1]);
    expect(result).toMatchObject({ status: 'success', result: { n: 19 } });
  });

  it('a nested workflow named in activeStepsPath gets restart: true on its first attempt only', async () => {
    const storage = new InMemoryStore();
    const ran: string[] = [];
    const inner = createWorkflow({ id: 'rs-inner', inputSchema: num, outputSchema: num }).then(counted('i', (n) => n, ran)).commit();
    const engine = new PetriExecutionEngine();
    const outer = createWorkflow({ id: 'rs-outer', inputSchema: num, outputSchema: num, executionEngine: engine })
      .then(counted('a', (n) => n + 1, ran))
      .then(inner)
      .then(counted('c', (n) => n, ran))
      .commit();
    const mastra = new Mastra({ storage, workflows: { outer } as never, logger: false });
    const wf = (mastra as unknown as { getWorkflow(k: string): AnyWf }).getWorkflow('outer');
    const graph = wf.buildExecutionGraph() as { steps: { type: string; step?: { id: string } }[] };
    const nested = graph.steps[1]!.step as unknown as { execute: (ctx: Record<string, unknown>) => Promise<unknown> };
    const seen: unknown[] = [];
    vi.spyOn(nested, 'execute').mockImplementation(async (ctx) => {
      seen.push(ctx['restart']);
      if (seen.length === 1) throw new Error('first attempt fails');
      return { n: 5 };
    });
    const run = await wf.createRun({ runId: 'run-n' });
    const result = await engine.execute({
      workflowId: 'rs-outer',
      runId: 'run-n',
      graph,
      serializedStepGraph: wf.serializedStepGraph,
      restart: {
        activePaths: [1],
        activeStepsPath: { 'rs-inner': [1] },
        stepResults: { input: { n: 1 }, a: { status: 'success', payload: { n: 1 }, output: { n: 2 }, startedAt: 1, endedAt: 2 } },
        state: {},
        stepExecutionPath: ['a', 'rs-inner'],
      },
      retryConfig: { attempts: 1, delay: 0 },
      pubsub: (run as unknown as { pubsub: unknown }).pubsub,
      requestContext: new RequestContext(),
      abortController: new AbortController(),
    } as never);
    expect(seen).toEqual([true, undefined]);
    expect(result).toMatchObject({ status: 'success', result: { n: 5 } });
    expect(ran).toEqual(['c']);
  });

  it('a nested workflow not named in activeStepsPath is started, not restarted', async () => {
    const storage = new InMemoryStore();
    const inner = createWorkflow({ id: 'rs-inner2', inputSchema: num, outputSchema: num }).then(counted('i', (n) => n, [])).commit();
    const engine = new PetriExecutionEngine();
    const outer = createWorkflow({ id: 'rs-outer2', inputSchema: num, outputSchema: num, executionEngine: engine }).then(inner).commit();
    const mastra = new Mastra({ storage, workflows: { outer } as never, logger: false });
    const wf = (mastra as unknown as { getWorkflow(k: string): AnyWf }).getWorkflow('outer');
    const graph = wf.buildExecutionGraph() as { steps: { step?: unknown }[] };
    const nested = graph.steps[0]!.step as { execute: (ctx: Record<string, unknown>) => Promise<unknown> };
    const seen: unknown[] = [];
    vi.spyOn(nested, 'execute').mockImplementation(async (ctx) => (seen.push(ctx['restart']), { n: 1 }));
    const run = await wf.createRun({ runId: 'run-n2' });
    await engine.execute({
      workflowId: 'rs-outer2',
      runId: 'run-n2',
      graph,
      serializedStepGraph: wf.serializedStepGraph,
      restart: { activePaths: [0], activeStepsPath: {}, stepResults: { input: { n: 1 } }, state: {}, stepExecutionPath: [] },
      pubsub: (run as unknown as { pubsub: unknown }).pubsub,
      requestContext: new RequestContext(),
      abortController: new AbortController(),
    } as never);
    expect(seen).toEqual([undefined]);
  });
});

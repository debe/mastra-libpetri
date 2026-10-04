import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import { InMemoryStore } from '@mastra/core/storage';
import type { ExecutionEngine } from '@mastra/core/workflows';
import { init, PETRI_ENGINE_TYPE } from '../../src/mastra/index.js';

/**
 * `Run.restart()` and `Workflow.restartAllActiveWorkflowRuns()` on a petri workflow reach the
 * petri engine ([ADR 0010], "The Run.restart seam"): Mastra no longer refuses them by engine type.
 * What the engine then does with a restart is the engine's own contract, so these tests stub
 * `execute` where they need a result and only assert what reached it.
 */

const num = z.object({ n: z.number() });

type Execute = ExecutionEngine['execute'];
type ExecuteParams = Parameters<Execute>[0];

const engineOf = (workflow: unknown): ExecutionEngine => (workflow as { executionEngine: ExecutionEngine }).executionEngine;

function stubExecute(workflow: unknown, impl: (params: ExecuteParams) => Promise<unknown>): ExecuteParams[] {
  const calls: ExecuteParams[] = [];
  engineOf(workflow).execute = (async (params: ExecuteParams) => {
    calls.push(params);
    return impl(params);
  }) as Execute;
  return calls;
}

const success = (params: ExecuteParams) => Promise.resolve({ status: 'success', result: { n: 7 }, steps: {}, input: params.input });

async function storeRunning(storage: InMemoryStore, workflowName: string, runId: string, firstStep: string): Promise<void> {
  const workflows = await storage.getStore('workflows');
  await workflows!.persistWorkflowSnapshot({
    workflowName,
    runId,
    snapshot: {
      runId,
      status: 'running',
      value: {},
      context: { input: { n: 1 } },
      activePaths: [0],
      activeStepsPath: { [firstStep]: [0] },
      serializedStepGraph: [],
      suspendedPaths: {},
      resumeLabels: {},
      waitingPaths: {},
      result: undefined,
      error: undefined,
      timestamp: Date.now(),
    } as never,
  });
}

function build() {
  const { createWorkflow, createStep } = init();
  const a = createStep({ id: 'a', inputSchema: num, outputSchema: num, execute: async ({ inputData }) => ({ n: inputData.n + 1 }) });
  const b = createStep({ id: 'b', inputSchema: num, outputSchema: num, execute: async ({ inputData }) => ({ n: inputData.n * 10 }) });
  const inner = createWorkflow({ id: 'inner', inputSchema: num, outputSchema: num }).then(a).commit();
  const outer = createWorkflow({ id: 'outer', inputSchema: num, outputSchema: num }).then(createStep(inner)).then(b).commit();
  const storage = new InMemoryStore();
  const mastra = new Mastra({ storage, workflows: { outer, inner }, logger: false });
  return { mastra, storage, outer: mastra.getWorkflow('outer'), inner: mastra.getWorkflow('inner') };
}

afterEach(() => vi.restoreAllMocks());

describe('Run.restart() on a petri run', () => {
  it("is no longer refused by Mastra's engine gate: the restart reaches the petri engine", async () => {
    const { storage, outer } = build();
    await storeRunning(storage, 'outer', 'r1', 'inner');
    const engine = engineOf(outer);
    const original = engine.execute.bind(engine);
    const seen: ExecuteParams[] = [];
    engine.execute = ((params: ExecuteParams) => {
      seen.push(params);
      return original(params);
    }) as Execute;

    const run = await outer.createRun({ runId: 'r1' });
    // Whatever the engine decides, it is the engine deciding — not Mastra's "restart() is not
    // supported on petri workflows". An engine refusal is an UnsupportedRunModeError.
    await run.restart().then(
      () => undefined,
      (error: unknown) => {
        expect(String(error)).not.toMatch(/restart\(\) is not supported on/);
        expect((error as Error).name).toBe('UnsupportedRunModeError');
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.restart).toMatchObject({ activePaths: [0] });
    expect(run.workflowEngineType).toBe(PETRI_ENGINE_TYPE);
  });

  it('hands back what the engine returns, and leaves the cached run marked petri', async () => {
    const { storage, outer } = build();
    await storeRunning(storage, 'outer', 'r2', 'inner');
    const calls = stubExecute(outer, success);
    const run = await outer.createRun({ runId: 'r2' });
    const result = await run.restart();
    expect(result.status).toBe('success');
    expect(calls).toHaveLength(1);
    expect(run.workflowEngineType).toBe(PETRI_ENGINE_TYPE);
  });

  it('wraps each run once: the cached run comes back with the same _restart', async () => {
    const { outer } = build();
    const first = await outer.createRun({ runId: 'same' });
    const wrapped = (first as unknown as { _restart: unknown })._restart;
    const again = await outer.createRun({ runId: 'same' });
    expect(again).toBe(first);
    expect((again as unknown as { _restart: unknown })._restart).toBe(wrapped);
    expect(Object.prototype.hasOwnProperty.call(first, '_restart')).toBe(true);
  });

  it("restarts a nested petri workflow: Mastra's Workflow.execute goes through the instance createRun", async () => {
    const { mastra, storage, inner } = build();
    await storeRunning(storage, 'inner', 'nested-run', 'a');
    const calls = stubExecute(inner, success);
    const createRun = vi.spyOn(inner, 'createRun');

    // The call a parent engine makes for a nested step on restart (`workflow.ts:2972-2974`, `3016-3017`).
    const output = await (inner as unknown as { execute(args: object): Promise<unknown> }).execute({
      runId: 'nested-run',
      inputData: { n: 1 },
      state: {},
      setState: async () => undefined,
      suspend: async () => undefined,
      restart: true,
      mastra,
      requestContext: new RequestContext(),
      abort: () => undefined,
      abortSignal: new AbortController().signal,
      bail: () => undefined,
      engine: {},
    });

    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 'nested-run' }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.runId).toBe('nested-run');
    expect(calls[0]!.restart).toBeDefined();
    expect(output).toEqual({ n: 7 });
  });
});

describe('Workflow.restartAllActiveWorkflowRuns() on a petri workflow', () => {
  it('restarts every active run, sequentially, instead of returning at the engine gate', async () => {
    const { storage, outer } = build();
    await storeRunning(storage, 'outer', 'x1', 'inner');
    await storeRunning(storage, 'outer', 'x2', 'inner');
    let inFlight = 0;
    let maxInFlight = 0;
    const calls = stubExecute(outer, async (params) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return success(params);
    });

    await outer.restartAllActiveWorkflowRuns();
    expect(calls.map((c) => c.runId).sort()).toEqual(['x1', 'x2']);
    expect(calls.every((c) => c.restart !== undefined)).toBe(true);
    expect(maxInFlight).toBe(1);
  });

  it('logs a failed restart and carries on with the next run', async () => {
    const { mastra, storage, outer } = build();
    await storeRunning(storage, 'outer', 'bad', 'inner');
    await storeRunning(storage, 'outer', 'good', 'inner');
    const error = vi.spyOn(mastra.getLogger(), 'error');
    const calls = stubExecute(outer, async (params) => {
      if (params.runId === 'bad') throw new Error('boom');
      return success(params);
    });

    await expect(outer.restartAllActiveWorkflowRuns()).resolves.toBeUndefined();
    expect(calls.map((c) => c.runId).sort()).toEqual(['bad', 'good']);
    expect(error).toHaveBeenCalledWith(
      'Failed to restart workflow run',
      expect.objectContaining({ workflowId: 'outer', runId: 'bad', error: expect.objectContaining({ message: 'boom' }) }),
    );
  });
});

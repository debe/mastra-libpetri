import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { createStep as mastraCreateStep, createWorkflow as mastraCreateWorkflow, type ExecutionEngine } from '@mastra/core/workflows';
import { init, restartActiveRuns } from '../../src/mastra/index.js';

/**
 * `restartActiveRuns` ([ADR 0010]): boot-time recovery for petri workflows, the counterpart of
 * Mastra's `restartAllActiveWorkflowRuns` (`mastra/index.ts:3967-3995`), which skips them. Each
 * engine's `execute` is stubbed: what a restart does is the engine's contract, tested elsewhere;
 * here it is which runs are restarted, in what order, and what is reported.
 */

const num = z.object({ n: z.number() });

type Execute = ExecutionEngine['execute'];
type ExecuteParams = Parameters<Execute>[0];

interface Trace {
  readonly events: string[];
  inFlight: number;
  maxInFlight: number;
}

function stub(workflow: unknown, trace: Trace, fail: ReadonlySet<string> = new Set()): void {
  (workflow as { executionEngine: ExecutionEngine }).executionEngine.execute = (async (params: ExecuteParams) => {
    trace.inFlight += 1;
    trace.maxInFlight = Math.max(trace.maxInFlight, trace.inFlight);
    trace.events.push(`start ${params.workflowId}/${params.runId}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
    trace.inFlight -= 1;
    trace.events.push(`end ${params.workflowId}/${params.runId}`);
    if (params.restart === undefined) throw new Error('not a restart');
    if (fail.has(params.runId)) throw new Error(`boom ${params.runId}`);
    return { status: 'success', result: { n: 1 }, steps: {}, input: params.input };
  }) as Execute;
}

async function storeRunning(storage: InMemoryStore, workflowName: string, runId: string, status: 'running' | 'waiting' = 'running') {
  const workflows = await storage.getStore('workflows');
  await workflows!.persistWorkflowSnapshot({
    workflowName,
    runId,
    snapshot: {
      runId,
      status,
      value: {},
      context: { input: { n: 1 } },
      activePaths: [0],
      activeStepsPath: { s: [0] },
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

async function build(fail: ReadonlySet<string> = new Set()) {
  const { createWorkflow, createStep } = init();
  const s = createStep({ id: 's', inputSchema: num, outputSchema: num, execute: async ({ inputData }) => inputData });
  const p1 = createWorkflow({ id: 'p1', inputSchema: num, outputSchema: num }).then(s).commit();
  const p2 = createWorkflow({ id: 'p2', inputSchema: num, outputSchema: num }).then(s).commit();
  const optOut = createWorkflow({ id: 'opt-out', inputSchema: num, outputSchema: num, options: { autoRestartActiveRuns: false } })
    .then(s)
    .commit();
  const ds = mastraCreateStep({ id: 's', inputSchema: num, outputSchema: num, execute: async ({ inputData }) => inputData });
  const plain = mastraCreateWorkflow({ id: 'plain', inputSchema: num, outputSchema: num }).then(ds).commit();

  const storage = new InMemoryStore();
  const mastra = new Mastra({ storage, workflows: { p1, p2, optOut, plain }, logger: false });
  const trace: Trace = { events: [], inFlight: 0, maxInFlight: 0 };
  for (const w of [p1, p2, optOut, plain]) stub(w, trace, fail);

  await storeRunning(storage, 'p1', 'a1');
  await storeRunning(storage, 'p1', 'a2', 'waiting');
  await storeRunning(storage, 'p2', 'b1');
  await storeRunning(storage, 'opt-out', 'o1');
  await storeRunning(storage, 'plain', 'd1');
  return { mastra, trace };
}

afterEach(() => vi.restoreAllMocks());

describe('restartActiveRuns', () => {
  it('restarts every running and waiting run of every petri workflow, one at a time', async () => {
    const { mastra, trace } = await build();
    const report = await restartActiveRuns(mastra);

    expect(report.failed).toEqual([]);
    expect(report.restarted.map((r) => `${r.workflowId}/${r.runId}`).sort()).toEqual(['p1/a1', 'p1/a2', 'p2/b1']);
    expect(report.restarted.every((r) => r.status === 'success')).toBe(true);
    // Sequential: each restart ends before the next starts.
    expect(trace.maxInFlight).toBe(1);
    expect(trace.events).toHaveLength(6);
    for (let i = 0; i < trace.events.length; i += 2) {
      expect(trace.events[i]!.replace('start ', '')).toBe(trace.events[i + 1]!.replace('end ', ''));
    }
    // Workflow by workflow, in registration order.
    expect(trace.events.map((e) => e.split(' ')[1]!.split('/')[0])).toEqual(['p1', 'p1', 'p1', 'p1', 'p2', 'p2']);
  });

  it('restricts to the named workflows', async () => {
    const { mastra, trace } = await build();
    const report = await restartActiveRuns(mastra, { workflows: ['p2'] });
    expect(report.restarted.map((r) => `${r.workflowId}/${r.runId}`)).toEqual(['p2/b1']);
    expect(trace.events).toEqual(['start p2/b1', 'end p2/b1']);
  });

  it('honours autoRestartActiveRuns === false, even when the workflow is named', async () => {
    const { mastra, trace } = await build();
    const debug = vi.spyOn(mastra.getLogger(), 'debug');
    const report = await restartActiveRuns(mastra, { workflows: ['opt-out'] });
    expect(report).toEqual({ restarted: [], failed: [] });
    expect(trace.events).toEqual([]);
    expect(debug).toHaveBeenCalledWith(
      'Skipping workflow run auto-restart; workflow opts out of generic recovery',
      expect.objectContaining({ workflowId: 'opt-out', runId: 'o1' }),
    );
  });

  it('skips workflows on other engines, even when named', async () => {
    const { mastra, trace } = await build();
    const report = await restartActiveRuns(mastra, { workflows: ['plain'] });
    expect(report).toEqual({ restarted: [], failed: [] });
    expect(trace.events).toEqual([]);
  });

  it('logs and reports a failed restart, and the others proceed', async () => {
    const { mastra, trace } = await build(new Set(['a1']));
    const error = vi.spyOn(mastra.getLogger(), 'error');
    const report = await restartActiveRuns(mastra);

    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toMatchObject({ workflowId: 'p1', runId: 'a1' });
    expect((report.failed[0]!.error as Error).message).toBe('boom a1');
    expect(report.restarted.map((r) => `${r.workflowId}/${r.runId}`).sort()).toEqual(['p1/a2', 'p2/b1']);
    expect(trace.maxInFlight).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      'Failed to restart workflow run',
      expect.objectContaining({ workflowId: 'p1', runId: 'a1', error: report.failed[0]!.error }),
    );
  });
});

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import type { ExecutionEngine } from '@mastra/core/workflows';
import { init, PETRI_ENGINE_TYPE } from '../../src/mastra/index.js';

/**
 * The guard that makes the restart seam safe ([ADR 0010], "The Run.restart seam"). `init()` lets a
 * petri run through Mastra's `Run._restart` by reporting `workflowEngineType = 'default'` for the
 * synchronous call and restoring `'petri'` in `finally`. That is sound only while Mastra reads the
 * field **before** `_restart`'s first `await` and never after (`workflow.ts:4872-4875`). An
 * upgrade that moves the read, or adds one, fails here instead of quietly running a petri run on
 * a path that believes it is the default engine's.
 */

const num = z.object({ n: z.number() });

function build() {
  const { createWorkflow, createStep } = init();
  const a = createStep({ id: 'a', inputSchema: num, outputSchema: num, execute: async ({ inputData }) => ({ n: inputData.n + 1 }) });
  const b = createStep({ id: 'b', inputSchema: num, outputSchema: num, execute: async ({ inputData }) => ({ n: inputData.n * 10 }) });
  const seam = createWorkflow({ id: 'seam', inputSchema: num, outputSchema: num }).then(a).then(b).commit();
  const storage = new InMemoryStore();
  const mastra = new Mastra({ storage, workflows: { seam }, logger: false });
  return { mastra, storage, seam: mastra.getWorkflow('seam') };
}

/** Stores a `running` snapshot for `runId`: a crash after `a` completed and before `b` did. */
async function storeRunning(storage: InMemoryStore, runId: string): Promise<void> {
  const workflows = await storage.getStore('workflows');
  await workflows!.persistWorkflowSnapshot({
    workflowName: 'seam',
    runId,
    snapshot: {
      runId,
      status: 'running',
      value: {},
      context: {
        input: { n: 1 },
        a: { status: 'success', payload: { n: 1 }, output: { n: 2 }, startedAt: 1, endedAt: 2 },
      },
      activePaths: [1],
      activeStepsPath: { b: [1] },
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

type Phase = 'before' | 'sync' | 'after';
interface Read {
  readonly phase: Phase;
  readonly value: string;
}

/** Replaces the run's own `workflowEngineType` field with an accessor that records every read. */
function instrument(run: object, phase: () => Phase): { reads: Read[]; peek: () => string } {
  const reads: Read[] = [];
  let value = (run as { workflowEngineType: string }).workflowEngineType;
  Object.defineProperty(run, 'workflowEngineType', {
    configurable: true,
    enumerable: true,
    get() {
      reads.push({ phase: phase(), value });
      return value;
    },
    set(v: string) {
      value = v;
    },
  });
  return { reads, peek: () => value };
}

describe('the Run.restart seam (upstream guard)', () => {
  it('workflowEngineType is a plain writable own field of a Run, as the seam assumes', async () => {
    const { seam } = build();
    const run = await seam.createRun();
    const descriptor = Object.getOwnPropertyDescriptor(run, 'workflowEngineType');
    expect(descriptor?.writable).toBe(true);
    expect(descriptor?.value).toBe(PETRI_ENGINE_TYPE);
  });

  it("Mastra's _restart checks the engine before its first await (source pin)", async () => {
    const { seam } = build();
    const run = await seam.createRun();
    const source = String((Object.getPrototypeOf(run) as { _restart: () => unknown })._restart);
    const check = source.indexOf('workflowEngineType');
    const firstAwait = source.indexOf('await');
    expect(check).toBeGreaterThan(-1);
    expect(firstAwait).toBeGreaterThan(check);
    // The only reads: the check and its message, both before the first await.
    expect(source.slice(firstAwait).includes('workflowEngineType')).toBe(false);
  });

  it("reads workflowEngineType only synchronously inside _restart, and never sees 'default' outside it", async () => {
    const { seam, storage } = build();
    await storeRunning(storage, 'crashed');
    const run = await seam.createRun({ runId: 'crashed' });

    let phase: Phase = 'before';
    const probe = instrument(run, () => phase);

    // Reach the engine, and record what the field holds once Mastra hands over.
    const engine = (seam as unknown as { executionEngine: ExecutionEngine }).executionEngine;
    const original = engine.execute.bind(engine);
    const atExecute: { restart: unknown; engineType: string }[] = [];
    engine.execute = (async (params: Parameters<ExecutionEngine['execute']>[0]) => {
      atExecute.push({ restart: params.restart, engineType: probe.peek() });
      return original(params);
    }) as ExecutionEngine['execute'];

    phase = 'sync';
    const pending = run.restart();
    phase = 'after';
    const afterReturn = probe.peek();
    await pending.catch((error: unknown) => {
      expect(String(error)).not.toMatch(/is not supported on/);
    });

    expect(afterReturn).toBe(PETRI_ENGINE_TYPE);
    expect(probe.peek()).toBe(PETRI_ENGINE_TYPE);
    expect(probe.reads.filter((r) => r.phase === 'after')).toEqual([]);
    expect(probe.reads.filter((r) => r.phase !== 'sync' && r.value !== PETRI_ENGINE_TYPE)).toEqual([]);
    // Mastra's own check ran, and saw the flip.
    expect(probe.reads.some((r) => r.phase === 'sync' && r.value === 'default')).toBe(true);
    // Mastra handed the restart to our engine, with the field already back to 'petri'.
    expect(atExecute).toHaveLength(1);
    expect(atExecute[0]!.restart).toBeDefined();
    expect(atExecute[0]!.engineType).toBe(PETRI_ENGINE_TYPE);
  });

  it("Mastra's terminal short-circuit still returns the stored result of a completed petri run", async () => {
    const { seam } = build();
    const started = await (await seam.createRun({ runId: 'done' })).start({ inputData: { n: 1 } });
    expect(started.status).toBe('success');

    const engine = (seam as unknown as { executionEngine: ExecutionEngine }).executionEngine;
    let executed = 0;
    const original = engine.execute.bind(engine);
    engine.execute = ((params: Parameters<ExecutionEngine['execute']>[0]) => {
      executed += 1;
      return original(params);
    }) as ExecutionEngine['execute'];

    const restarted = await (await seam.createRun({ runId: 'done' })).restart();
    expect(executed).toBe(0);
    expect(restarted.status).toBe('success');
    if (restarted.status !== 'success' || started.status !== 'success') throw new Error('unreachable');
    expect(restarted.result).toEqual(started.result);
    expect(restarted.result).toEqual({ n: 20 });
    expect(Object.keys(restarted.steps)).toEqual(expect.arrayContaining(['a', 'b']));
  });
});

/**
 * **An injected clock through Mastra ([TIME-015], M3 item 2c).**
 *
 * `new PetriExecutionEngine({ clock })` puts the net on a host clock: a fixed `.sleep()` and the
 * record stamps the engine owns follow it. Mastra's own code does not — step code, `StepExecutor`
 * (`evented/step-executor.ts:94,279,338`, `Date.now()`), the snapshot's `timestamp` and `Run`'s
 * own bookkeeping all read the machine clock. This file pins which is which, so the split is a
 * tested fact rather than a comment.
 *
 * It also pins run correlation: two concurrent Mastra runs of one workflow on one engine and one
 * clock start at the **same virtual instant**, and are told apart by Mastra's `runId` — never by
 * libpetri's `executionId()`, which the source does not call (`grep -rn executionId src/` is
 * empty; asserted below by reading the source).
 *
 * Environment: real `Mastra` with an `InMemoryStore`, `Run.start()`, libpetri 6.1.0 (registry).
 * Tested, not proven.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createStep, createWorkflow, DefaultExecutionEngine } from '@mastra/core/workflows';
import type { WorkflowRunState } from '@mastra/core/workflows';
import { InMemoryStore } from '@mastra/core/storage';
import { Mastra } from '@mastra/core/mastra';
import { PetriExecutionEngine } from '../../src/mastra/engine.js';
import { ManualClock } from '../support/manual-clock.js';

const EPOCH = 1_700_000_000_000; // 2023-11-14: far enough from the machine clock to tell apart
const DAY = 86_400_000;

const input = z.object({ n: z.number() });
const stamped = z.object({ n: z.number(), wall: z.number(), runId: z.string() });

/**
 * `a` -> `.sleep(60_000)` -> `b`. Each step reports the machine clock it saw (`wall`) and the
 * `runId` Mastra handed it, so both can be compared with what the engine recorded.
 */
function sleepy(id: string, clock: ManualClock) {
  const a = createStep({
    id: 'a',
    inputSchema: input,
    outputSchema: stamped,
    execute: async ({ inputData, runId }) => ({ n: inputData.n + 1, wall: Date.now(), runId }),
  });
  const b = createStep({
    id: 'b',
    inputSchema: stamped,
    outputSchema: stamped,
    execute: async ({ inputData, runId }) => ({ n: inputData.n * 10, wall: Date.now(), runId }),
  });
  return createWorkflow({
    id,
    inputSchema: input,
    outputSchema: stamped,
    executionEngine: new PetriExecutionEngine({ clock }),
  })
    .then(a)
    .sleep(60_000)
    .then(b)
    .commit();
}

type StepView = { status: string; startedAt?: number; endedAt?: number; payload?: unknown; output?: unknown };

/** The one `.sleep()` record: Mastra gives it a generated `sleep_<uuid>` id. */
function sleepRecord(steps: Record<string, unknown>): StepView {
  const ids = Object.keys(steps).filter((k) => k.startsWith('sleep_'));
  expect(ids).toHaveLength(1);
  return steps[ids[0]!] as StepView;
}

async function loadSnapshot(storage: InMemoryStore, workflowName: string, runId: string): Promise<WorkflowRunState | null> {
  const store = await storage.getStore('workflows');
  if (!store) throw new Error('InMemoryStore has no workflows store');
  return store.loadWorkflowSnapshot({ workflowName, runId });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PetriExecutionEngine({ clock }) through Mastra', () => {
  it('runs a .sleep(60_000) workflow instantly and records virtual timestamps', async () => {
    const clock = new ManualClock(EPOCH);
    const storage = new InMemoryStore();
    const mastra = new Mastra({ storage, workflows: { sleepy: sleepy('sleepy', clock) }, logger: false });
    const petri = vi.spyOn(PetriExecutionEngine.prototype, 'execute');
    const dflt = vi.spyOn(DefaultExecutionEngine.prototype, 'execute');

    const run = await mastra.getWorkflow('sleepy').createRun();
    const wall0 = Date.now();
    const result = await run.start({ inputData: { n: 1 } });
    const wall1 = Date.now();

    // The petri engine ran it, and only it — otherwise this would be a real minute on the default.
    expect(petri).toHaveBeenCalledTimes(1);
    expect(dflt).not.toHaveBeenCalled();
    expect(wall1 - wall0).toBeLessThan(5_000);
    expect(clock.elapsed()).toBe(60_000);

    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('unreachable');
    expect(result.result).toMatchObject({ n: 20, runId: run.runId });

    // Follow the injected clock: every record stamp the engine writes.
    const steps = result.steps as unknown as Record<string, StepView>;
    expect(steps['a']).toMatchObject({ status: 'success', startedAt: EPOCH, endedAt: EPOCH });
    expect(sleepRecord(steps)).toMatchObject({ status: 'success', startedAt: EPOCH, endedAt: EPOCH + 60_000 });
    expect(steps['b']).toMatchObject({ status: 'success', startedAt: EPOCH + 60_000, endedAt: EPOCH + 60_000 });

    // Do NOT follow it: Mastra's step code reads the machine clock. `b` ran "60s after" `a` in
    // virtual time and a few ms after it in real time — both far from the virtual epoch.
    const aWall = (steps['a']!.output as { wall: number }).wall;
    const bWall = (steps['b']!.output as { wall: number }).wall;
    for (const w of [aWall, bWall]) {
      expect(w).toBeGreaterThanOrEqual(wall0);
      expect(w).toBeLessThanOrEqual(wall1);
      expect(Math.abs(w - EPOCH)).toBeGreaterThan(DAY);
    }
    expect(bWall - aWall).toBeLessThan(60_000);

    // Nor does the snapshot: its `timestamp` is `Date.now()` (`persist.ts`, as `default.ts` stamps
    // it), while the context it carries holds the virtual record stamps.
    const snapshot = await loadSnapshot(storage, 'sleepy', run.runId);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.status).toBe('success');
    expect(snapshot!.timestamp).toBeGreaterThanOrEqual(wall0);
    expect(snapshot!.timestamp).toBeLessThanOrEqual(Date.now());
    const context = snapshot!.context as unknown as Record<string, StepView>;
    expect(context['a']).toMatchObject({ startedAt: EPOCH, endedAt: EPOCH });
    expect(context['b']).toMatchObject({ startedAt: EPOCH + 60_000, endedAt: EPOCH + 60_000 });
  });

  it('two concurrent runs of one workflow start at the same virtual instant and correlate by runId', async () => {
    const clock = new ManualClock(EPOCH);
    const storage = new InMemoryStore();
    const mastra = new Mastra({ storage, workflows: { twin: sleepy('twin', clock) }, logger: false });
    const wf = mastra.getWorkflow('twin');
    const [r1, r2] = [await wf.createRun(), await wf.createRun()];
    expect(r1.runId).not.toBe(r2.runId);

    const wall0 = Date.now();
    const [o1, o2] = await Promise.all([r1.start({ inputData: { n: 1 } }), r2.start({ inputData: { n: 2 } })]);
    expect(Date.now() - wall0).toBeLessThan(5_000);

    for (const [run, out, n] of [[r1, o1, 1], [r2, o2, 2]] as const) {
      expect(out.status).toBe('success');
      if (out.status !== 'success') throw new Error('unreachable');
      // Correlated by Mastra's runId end to end: the result, what each step was handed, the data.
      expect(out.result).toMatchObject({ n: (n + 1) * 10, runId: run.runId });
      const steps = out.steps as unknown as Record<string, StepView>;
      // (The returned result deduplicates payloads, as Mastra's does; the snapshot keeps them.)
      expect(steps['a']).toMatchObject({ output: { n: n + 1, runId: run.runId } });
      // The same virtual start for both runs: a clock reading cannot tell them apart.
      expect(steps['a']!.startedAt).toBe(EPOCH);
      const snapshot = await loadSnapshot(storage, 'twin', run.runId);
      expect(snapshot).toMatchObject({ runId: run.runId, status: 'success', result: { n: (n + 1) * 10, runId: run.runId } });
      expect((snapshot!.context as unknown as Record<string, StepView>)['a']).toMatchObject({ payload: { n }, startedAt: EPOCH });
    }
    // One clock shared by two runs is one virtual timeline, not two: `ManualClock` jumps on every
    // finite wait asked of it, so both 60s sleeps elapsed on it. Independence is per clock
    // (tests/engine/clock.test.ts (b)), never per run on a shared one.
    expect(clock.elapsed()).toBeGreaterThanOrEqual(60_000);
  });

  it('the source never correlates on libpetri\'s executionId()', () => {
    // The plan forbids it: under an injected clock two executors can start at one virtual instant.
    // libpetri 6.1.0 draws the id from a counter (its TIME-015 AC#14), but correlation is Mastra's
    // runId regardless.
    const root = fileURLToPath(new URL('../../src/', import.meta.url));
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.ts$/.test(name) && readFileSync(path, 'utf8').includes('executionId')) hits.push(path);
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});

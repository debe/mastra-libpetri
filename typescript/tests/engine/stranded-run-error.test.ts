import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { compile } from '../../src/compiler/index.js';
import * as kernel from '../../src/engine/kernel.js';
import type { TransitionFailure } from '../../src/engine/index.js';
import type { CheckpointEvent, EntryDescription } from '../../src/compiler/types.js';
import { PetriExecutionEngine, StrandedRunError } from '../../src/mastra/engine.js';
import { RecordingRunner } from '../fixtures/runner.js';

/**
 * A stranded run names the firing that stranded it. The kernel ends a run at once when a firing
 * fails — libpetri's `transition-failed` event ([EXEC-003]): an action's throw, or an
 * `OutViolationError` for an emission outside its `Out` spec ([IO-015]) — and reports the
 * transition and its error as `failure`. `StrandedRunError` carries that on to the caller, so a
 * stranded run says what went wrong, not only where its tokens rest.
 *
 * The failure here is a real one: a checkpoint write that rejects fails its transition's firing
 * ([ADR 0010]). The engine raises a checkpoint failure as the storage error itself, before it
 * reaches the stranded branch, so the engine test replays that real report with the checkpoint
 * error dropped — the shape any other failed firing has.
 */

vi.mock('../../src/engine/kernel.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/engine/kernel.js')>();
  return { ...actual, runWorkflowDetailed: vi.fn(actual.runWorkflowDetailed) };
});
const realRunWorkflowDetailed = vi.mocked(kernel.runWorkflowDetailed).getMockImplementation()!;

afterEach(() => {
  vi.mocked(kernel.runWorkflowDetailed).mockImplementation(realRunWorkflowDetailed);
});

const chain: readonly EntryDescription[] = [
  { kind: 'step', id: 'a' },
  { kind: 'step', id: 'b' },
];

class FailingCheckpointRunner extends RecordingRunner {
  async checkpoint(_event: CheckpointEvent): Promise<void> {
    this.calls.push('checkpoint');
    throw new Error('storage down');
  }
}

/** A real failed firing: the checkpoint after entry 0 rejects. */
async function failedFiringReport(): Promise<kernel.RunReport> {
  const compiled = compile({ id: 'marked', entries: chain, checkpoints: [0] });
  return realRunWorkflowDetailed(compiled, 'v', { runner: new FailingCheckpointRunner() });
}

describe('StrandedRunError names the failed firing', () => {
  it('the kernel reports the transition and its error on a stranded outcome', async () => {
    const report = await failedFiringReport();
    expect(report.outcome.status).toBe('stranded');
    if (report.outcome.status !== 'stranded') return;
    expect(report.outcome.failure).toStrictEqual({ transition: 't.0.checkpoint', exceptionType: 'Error', message: 'storage down' });
  });

  it('the constructor: a failure is named in the message and kept on the error; without one the message is as before', () => {
    const failure: TransitionFailure = { transition: 't.0.checkpoint', exceptionType: 'Error', message: 'storage down' };
    const named = new StrandedRunError('w', 'r', ['p.one'], failure);
    expect(named.failure).toStrictEqual(failure);
    expect(named.message).toBe(
      "PetriExecutionEngine: run 'r' of workflow 'w' came to rest with no outcome; " +
        "the firing of transition 't.0.checkpoint' failed (Error: storage down); tokens remain in p.one",
    );
    const bare = new StrandedRunError('w', 'r', []);
    expect(bare.failure).toBeUndefined();
    expect(bare.message).toBe("PetriExecutionEngine: run 'r' of workflow 'w' came to rest with no outcome; tokens remain in (no place)");
  });

  it('end to end: a Mastra run on the petri engine rejects with the transition and its error', async () => {
    const real = await failedFiringReport();
    if (real.outcome.status !== 'stranded') throw new Error(`expected a stranded report, got ${real.outcome.status}`);
    const stranded = real.outcome;
    // This run's own report, its outcome replaced by the real stranded one; no checkpoint error.
    vi.mocked(kernel.runWorkflowDetailed).mockImplementationOnce(async (...args) => {
      const { checkpointError: _none, ...own } = await realRunWorkflowDetailed(...args);
      return { ...own, outcome: stranded };
    });
    const num = z.object({ n: z.number() });
    const wf = createWorkflow({ id: 'stranded', inputSchema: num, outputSchema: num, executionEngine: new PetriExecutionEngine() })
      .then(createStep({ id: 'a', inputSchema: num, outputSchema: num, execute: async ({ inputData }) => inputData }))
      .commit();
    const run = await wf.createRun();
    const error = await run.start({ inputData: { n: 1 } }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(StrandedRunError);
    const e = error as StrandedRunError;
    expect(e.failure).toStrictEqual({ transition: 't.0.checkpoint', exceptionType: 'Error', message: 'storage down' });
    expect(e.places).toEqual(stranded.places);
    expect(e.message).toContain("the firing of transition 't.0.checkpoint' failed (Error: storage down)");
  });
});

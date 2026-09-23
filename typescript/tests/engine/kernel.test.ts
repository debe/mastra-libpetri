import { describe, expect, it } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { runWorkflow, runWorkflowDetailed } from '../../src/engine/index.js';
import type { StepRecord, WorkflowDescription } from '../../src/compiler/types.js';
import { RecordingRunner } from '../fixtures/runner.js';

const wf = (...ids: string[]): WorkflowDescription => ({
  id: 'k',
  entries: ids.map((id) => ({ kind: 'step', id }) as const),
});

describe('tripwire classification matches fmtReturnValue (default.ts:611-626)', () => {
  it.each([
    ['a TripWire-like Error', new Error('blocked')],
    ['serialized tripwire data', { reason: 'blocked', retry: false }],
  ])('%s makes the run a tripwire', async (_label, tripwire) => {
    const runner = new RecordingRunner({ a: () => ({ status: 'failed', error: 'x', tripwire }) });
    expect(await runWorkflow(compile(wf('a')), 1, { runner })).toEqual({ status: 'tripwire', stepId: 'a', path: [0], tripwire });
  });

  it.each([
    ['null', null],
    ['a string', 'blocked'],
    ['zero', 0],
    ['false', false],
    ['an object without reason', { retry: true }],
  ])('%s is an ordinary failure', async (_label, tripwire) => {
    const runner = new RecordingRunner({ a: () => ({ status: 'failed', error: 'x', tripwire }) });
    expect(await runWorkflow(compile(wf('a')), 1, { runner })).toEqual({ status: 'failed', stepId: 'a', path: [0], error: 'x' });
  });
});

describe('carried-in step results are checked at the boundary', () => {
  it.each([
    ['null', null],
    ['a string', 'done'],
    ['an unknown status', { status: 'waiting' }],
  ])('refuses %s before any step runs', async (_label, record) => {
    const runner = new RecordingRunner();
    const stepResults = new Map([['a', record as unknown as StepRecord]]);
    await expect(runWorkflow(compile(wf('a')), 1, { runner, stepResults })).rejects.toThrow(
      /carried-in step result for 'a' is not a recognised outcome/,
    );
    expect(runner.calls).toEqual([]);
  });

  it('accepts a well-formed record and a later step can read it', async () => {
    const runner = new RecordingRunner({ b: (_i, call) => ({ status: 'success', output: call.getStepResult('prior') }) });
    const prior: StepRecord = { status: 'success', output: 7, payload: 6, startedAt: 1, endedAt: 2, metadata: { iterationCount: 3 } };
    const stepResults = new Map<string, StepRecord>([['prior', prior]]);
    const report = await runWorkflowDetailed(compile(wf('b')), 1, { runner, stepResults });
    expect(report.outcome).toEqual({ status: 'success', output: prior });
    // The carried-in record is reported back untouched, first, beside the one this segment wrote.
    expect([...report.stepResults.keys()]).toEqual(['prior', 'b']);
    expect(report.stepResults.get('prior')).toEqual(prior);
  });

  it('accepts a carried-in canceled record — what Mastra persists for a canceled loop or foreach body', async () => {
    // `stepResults[getSingleStepEntryId(entry.step)] = execResults` with `{status: 'canceled'}`
    // (`handlers/entry.ts:810-813`); a foreach's carries its partial results as `output`.
    const canceled: StepRecord = { status: 'canceled', output: [1, 2] };
    const bare: StepRecord = { status: 'canceled' };
    const seen: unknown[] = [];
    const runner = new RecordingRunner({ b: (i, call) => (seen.push(call.getStepResult('body'), call.getStepResult('loopBody')), { status: 'success', output: i }) });
    const report = await runWorkflowDetailed(compile(wf('b')), 1, {
      runner,
      stepResults: new Map<string, StepRecord>([['body', canceled], ['loopBody', bare]]),
    });
    expect(report.outcome).toEqual({ status: 'success', output: 1 });
    expect(seen).toEqual([canceled, bare]);
    expect(report.stepResults.get('body')).toBe(canceled);
  });

  it('does not mutate the caller\'s map', async () => {
    const stepResults = new Map<string, StepRecord>([['prior', { status: 'success', output: 7, payload: 6 }]]);
    await runWorkflow(compile(wf('b')), 1, { runner: new RecordingRunner(), stepResults });
    expect([...stepResults.keys()]).toEqual(['prior']);
  });

  it('refuses a malformed record even when the run is already canceled', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      runWorkflow(compile(wf('a')), 1, {
        runner: new RecordingRunner(),
        signal: ac.signal,
        stepResults: new Map([['a', null as unknown as StepRecord]]),
      }),
    ).rejects.toThrow(/carried-in step result for 'a' is not a recognised outcome/);
  });
});

describe('the fixture runner resolves own properties only', () => {
  it.each(['toString', 'constructor', 'hasOwnProperty', 'valueOf'])('an unscripted step named %s echoes', async (id) => {
    const report = await runWorkflowDetailed(compile(wf(id)), 'in', { runner: new RecordingRunner() });
    expect(report.outcome).toEqual({ status: 'success', output: 'in' });
  });
});

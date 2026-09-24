import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrecompiledNet, PrecompiledNetExecutor } from 'libpetri';
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
    const error = new Error('x');
    const runner = new RecordingRunner({ a: () => ({ status: 'failed', error, tripwire }) });
    const outcome = await runWorkflow(compile(wf('a')), 1, { runner });
    // The failure's error rides beside the tripwire: a caller that finds no Mastra `TripWire`
    // in `tripwire` still has the step's error to report.
    expect(outcome).toEqual({ status: 'tripwire', stepId: 'a', path: [0], tripwire, error });
    expect(outcome.status === 'tripwire' ? outcome.error : undefined).toBe(error);
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
    ['a running record (a step in flight is not an outcome)', { status: 'running' }],
    ['a skipped record', { status: 'skipped' }],
    ['an unknown status', { status: 'done' }],
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

  it('accepts a carried-in waiting record — what Mastra leaves for a sleep canceled mid-wait', async () => {
    // `stepResults[entry.id] = {status: 'waiting', payload: prevOutput, startedAt}`
    // (`handlers/entry.ts:605-609`), never overwritten when the run is canceled mid-wait.
    const waiting: StepRecord = { status: 'waiting', payload: 'before', startedAt: 5 };
    const seen: unknown[] = [];
    const runner = new RecordingRunner({ b: (i, call) => (seen.push(call.getStepResult('nap')), { status: 'success', output: i }) });
    const report = await runWorkflowDetailed(compile(wf('b')), 1, { runner, stepResults: new Map([['nap', waiting]]) });
    expect(report.outcome).toEqual({ status: 'success', output: 1 });
    expect(seen).toEqual([waiting]);
    expect([...report.stepResults.keys()]).toEqual(['nap', 'b']);
    expect(report.stepResults.get('nap')).toBe(waiting);
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

describe('a bailed success names the step that bailed', () => {
  it.each([
    ['the first step', ['a', 'b', 'c'], 'a', [0]],
    ['a middle step', ['a', 'b', 'c'], 'b', [1]],
    ['the last step', ['a', 'b'], 'b', [1]],
  ] as const)('%s bails: success, bailed, and the bailing step\'s origin', async (_label, ids, bailer, path) => {
    const runner = new RecordingRunner({ [bailer]: () => ({ status: 'bailed', output: 'early' }) });
    const report = await runWorkflowDetailed(compile(wf(...ids)), 1, { runner });
    expect(report.outcome).toEqual({ status: 'success', output: 'early', bailed: true, stepId: bailer, path });
    // Nothing after the bailer runs; its record is rewritten to success (`default.ts:926-928`).
    expect(runner.calls).toEqual(ids.slice(0, path[0] + 1));
    expect(report.stepResults.get(bailer)).toMatchObject({ status: 'success', output: 'early' });
  });

  it('a bail followed by a sleep: the origin is the bailer, never the sleep after it', async () => {
    // The critic's probe B1: inferring the bail's position from the records counted the sleep.
    const description: WorkflowDescription = {
      id: 'bs',
      entries: [{ kind: 'step', id: 'a' }, { kind: 'step', id: 'bailer' }, { kind: 'sleep', id: 'nap', duration: { fixed: 10 } }],
    };
    const runner = new RecordingRunner({ bailer: () => ({ status: 'bailed', output: 'early' }) });
    const report = await runWorkflowDetailed(compile(description), 1, { runner });
    expect(report.outcome).toEqual({ status: 'success', output: 'early', bailed: true, stepId: 'bailer', path: [1] });
    expect([...report.stepResults.keys()]).toEqual(['a', 'bailer']);
  });

  it('a success that did not bail has no origin keys', async () => {
    const report = await runWorkflowDetailed(compile(wf('a', 'b')), 1, { runner: new RecordingRunner() });
    expect(report.outcome).toEqual({ status: 'success', output: 1 });
    expect(report.outcome).not.toHaveProperty('stepId');
    expect(report.outcome).not.toHaveProperty('bailed');
  });
});

describe('timeoutMs: null is no budget', () => {
  const timed: WorkflowDescription = {
    id: 'nb',
    entries: [{ kind: 'step', id: 'a' }, { kind: 'sleep', id: 'nap', duration: { fixed: 30 } }, { kind: 'step', id: 'b' }],
  };

  it('a run with no signal completes, timed transitions included', async () => {
    const runner = new RecordingRunner();
    const report = await runWorkflowDetailed(compile(timed), 'x', { runner, timeoutMs: null });
    expect(report.outcome).toEqual({ status: 'success', output: 'x' });
    expect(runner.calls).toEqual(['a', 'b']);
    expect(report.stepResults.get('nap')).toMatchObject({ status: 'success', output: 'x' });
  });

  it('a run with a signal that never fires completes at its terminal, not at a timer', async () => {
    const ac = new AbortController();
    const report = await runWorkflowDetailed(compile(timed), 'x', { runner: new RecordingRunner(), signal: ac.signal, timeoutMs: null });
    expect(report.outcome).toEqual({ status: 'success', output: 'x' });
  });

  it('a run with a signal that fires mid-sleep ends canceled', async () => {
    const ac = new AbortController();
    const runner = new RecordingRunner({ a: (x) => (setTimeout(() => ac.abort(), 5), { status: 'success', output: x }) });
    const long: WorkflowDescription = { ...timed, entries: [timed.entries[0]!, { kind: 'sleep', id: 'nap', duration: { fixed: 60_000 } }, timed.entries[2]!] };
    const t0 = performance.now();
    const report = await runWorkflowDetailed(compile(long), 'x', { runner, signal: ac.signal, timeoutMs: null });
    expect(report.outcome).toEqual({ status: 'canceled', origin: { stepId: 'nap', path: [1] }, started: true });
    expect(performance.now() - t0).toBeLessThan(2_000);
  });

  it('passes no budget to the executor: run(undefined, \'close\')', async () => {
    const run = vi.spyOn(PrecompiledNetExecutor.prototype, 'run');
    try {
      await runWorkflow(compile(wf('a')), 1, { runner: new RecordingRunner(), timeoutMs: null });
      await runWorkflow(compile(wf('a')), 1, { runner: new RecordingRunner() });
      await runWorkflow(compile(wf('a')), 1, { runner: new RecordingRunner(), timeoutMs: 1234 });
      expect(run.mock.calls).toEqual([
        [undefined, 'close'],
        [300_000, 'close'],
        [1234, 'close'],
      ]);
    } finally {
      run.mockRestore();
    }
  });
});

describe('the compiled program is built once and is what every run executes', () => {
  afterEach(() => vi.restoreAllMocks());

  it('compile() carries a PrecompiledNet of its own net', () => {
    const compiled = compile(wf('a', 'b'));
    expect(compiled.program).toBeInstanceOf(PrecompiledNet);
    expect(compiled.program.compiled.net).toBe(compiled.net);
  });

  it('runs never recompile, and each executor holds the one cached program', async () => {
    const compiled = compile(wf('a', 'b'));
    const recompile = vi.spyOn(PrecompiledNet, 'compile');
    const programs: unknown[] = [];
    const original = PrecompiledNetExecutor.prototype.run;
    vi.spyOn(PrecompiledNetExecutor.prototype, 'run').mockImplementation(function (this: PrecompiledNetExecutor, ...args) {
      programs.push(Reflect.get(this, 'program'));
      return original.apply(this, args);
    });

    const ac = new AbortController();
    for (const options of [{}, { signal: ac.signal }, { timeoutMs: null }]) {
      const outcome = await runWorkflow(compiled, 1, { runner: new RecordingRunner(), ...options });
      expect(outcome).toEqual({ status: 'success', output: 1 });
    }
    expect(recompile).not.toHaveBeenCalled();
    expect(programs).toHaveLength(3);
    for (const program of programs) expect(program).toBe(compiled.program);
  });
});

import { describe, expect, it } from 'vitest';
import { adaptStepFlow, fromMastraStepResult, getStepResultView, toMastraStepResult } from '../../src/mastra/index.js';
import type { AdaptOptions, StepFlowEntry, StoredStepResult } from '../../src/mastra/index.js';
import { compile } from '../../src/compiler/index.js';
import type { RunView, StepRecord } from '../../src/compiler/index.js';
import { runWorkflow, runWorkflowDetailed } from '../../src/engine/index.js';
import { RecordingRunner } from '../fixtures/runner.js';
import { ManualClock } from '../support/manual-clock.js';

const adapt = (entries: readonly StepFlowEntry[], options: Omit<AdaptOptions, 'workflowId'> = {}) =>
  adaptStepFlow(entries, { workflowId: 'orders', ...options });
const step = (id: string): StepFlowEntry => ({ type: 'step', step: { id } });

const T0 = 1_700_000_000_000;

describe("step records as Mastra's StepResult", () => {
  it('writes a success as Mastra records one, and reads it back to the same record', () => {
    const record: StepRecord = { status: 'success', output: { id: 7 }, payload: 'in', startedAt: T0, endedAt: T0 + 5 };
    const mastra = toMastraStepResult(record);

    expect(mastra).toEqual({ status: 'success', output: { id: 7 }, payload: 'in', startedAt: T0, endedAt: T0 + 5 });
    expect(fromMastraStepResult(mastra)).toEqual({ ...record, host: mastra });
  });

  it('writes a bail under the status Mastra actually stores, which its union does not declare', () => {
    // handlers/step.ts:524 — `{ status: 'bailed', output, endedAt }`, cast through `as StepResult`.
    expect(toMastraStepResult({ status: 'bailed', output: 'early', payload: 'in', startedAt: T0, endedAt: T0 })).toEqual({
      status: 'bailed',
      output: 'early',
      payload: 'in',
      startedAt: T0,
      endedAt: T0,
    });
  });

  it("writes a failure with Mastra's own flags, and flattens a TripWire as default.ts:496-504 does", () => {
    const wire = Object.assign(new Error('pii detected'), { options: { retry: false, metadata: { field: 'ssn' } }, processorId: 'pii' });
    const error = new Error('blocked');

    expect(
      toMastraStepResult({ status: 'failed', error, tripwire: wire, nonRetryable: true, payload: 'in', startedAt: T0, endedAt: T0 + 1 }),
    ).toEqual({
      status: 'failed',
      error,
      payload: 'in',
      startedAt: T0,
      endedAt: T0 + 1,
      tripwire: { reason: 'pii detected', retry: false, metadata: { field: 'ssn' }, processorId: 'pii' },
      nonRetryable: true,
    });
  });

  it('passes tripwire data through, and writes a tripwire that is none by Mastra’s test as an own undefined key', () => {
    const base = { status: 'failed', error: new Error('x'), payload: 'in', startedAt: T0, endedAt: T0 } as const;
    expect(toMastraStepResult({ ...base, tripwire: { reason: 'r', processorId: 'p' } })).toMatchObject({ tripwire: { reason: 'r', processorId: 'p' } });
    // `default.ts:497-506` writes `tripwire: tripwireData` on every failure, undefined when none —
    // the key exists, its value is not a tripwire.
    for (const none of ['no', undefined, null, 0, { retry: true }]) {
      const written: object = toMastraStepResult({ ...base, tripwire: none });
      expect(Object.hasOwn(written, 'tripwire'), String(none)).toBe(true);
      expect(Reflect.get(written, 'tripwire'), String(none)).toBeUndefined();
    }
  });

  it('writes the tripwire key as an own key in both directions', () => {
    // To Mastra: a record with no tripwire field at all still gets the key.
    const record: StepRecord = { status: 'failed', error: new Error('x'), payload: 'in', startedAt: T0, endedAt: T0 + 1 };
    const written = toMastraStepResult(record);
    expect(Object.keys(written)).toContain('tripwire');
    expect(written).toStrictEqual({ status: 'failed', error: record.error, payload: 'in', startedAt: T0, endedAt: T0 + 1, tripwire: undefined });

    // From Mastra and back: what Mastra holds in memory (own key, undefined) comes back identical,
    // key included — and what JSON storage gives back (key dropped) comes back as Mastra writes it.
    const inMemory = { status: 'failed', error: new Error('y'), payload: 'in', startedAt: T0, endedAt: T0, tripwire: undefined } as const;
    const back = toMastraStepResult(fromMastraStepResult(inMemory)!);
    expect(back).toStrictEqual(inMemory);
    expect(Object.keys(back)).toContain('tripwire');
    const { tripwire: _dropped, ...fromJson } = inMemory;
    const restored = toMastraStepResult(fromMastraStepResult(fromJson)!);
    expect(Object.keys(restored)).toContain('tripwire');
    expect(restored).toStrictEqual(inMemory);

    // And a real tripwire survives the round trip as data.
    const tripped = { ...inMemory, tripwire: { reason: 'pii', processorId: 'p' } };
    expect(toMastraStepResult(fromMastraStepResult(tripped)!)).toStrictEqual(tripped);
  });

  it('writes no tripwire key on any status but failed', () => {
    const at = { payload: 'in', startedAt: T0, endedAt: T0 } as const;
    for (const record of [
      { status: 'success', output: 1, ...at },
      { status: 'bailed', output: 1, ...at },
      { status: 'paused', ...at },
      { status: 'suspended', suspendPayload: 'p', suspendedAt: T0, ...at },
      { status: 'waiting', payload: 'in', startedAt: T0 },
      { status: 'canceled' },
    ] as const satisfies readonly StepRecord[]) {
      expect(Object.keys(toMastraStepResult(record)), record.status).not.toContain('tripwire');
    }
  });

  it("turns a failure that is not an Error into one, as getErrorFromUnknown's three branches do", () => {
    const at = { payload: 'in', startedAt: T0, endedAt: T0 } as const;
    const fromString = toMastraStepResult({ status: 'failed', error: 'card declined', ...at }) as { error: Error };
    expect(fromString.error).toBeInstanceOf(Error);
    expect(fromString.error.message).toBe('card declined');
    expect(fromString.error.stack).toBeUndefined();

    const fromObject = toMastraStepResult({ status: 'failed', error: { message: 'm', code: 42 }, ...at }) as { error: Error & { code?: number } };
    expect([fromObject.error.message, fromObject.error.code]).toEqual(['m', 42]);

    const fromNothing = toMastraStepResult({ status: 'failed', error: undefined, ...at }) as { error: Error };
    expect(fromNothing.error.message).toBe('Unknown step execution error');

    const custom = new Error('custom');
    expect(toMastraStepResult({ status: 'failed', error: 7, ...at }, { normalizeError: () => custom })).toMatchObject({ error: custom });
  });
});

describe('a suspension, as handlers/step.ts:516-521 records it', () => {
  it('writes suspendPayload, suspendOutput and suspendedAt from the record itself, with no endedAt', () => {
    const record: StepRecord = {
      status: 'suspended',
      payload: 'in',
      suspendPayload: { ask: 'approve' },
      suspendOutput: 'partial',
      startedAt: T0,
      suspendedAt: T0 + 3,
    };

    expect(toMastraStepResult(record)).toEqual({
      status: 'suspended',
      payload: 'in',
      suspendPayload: { ask: 'approve' },
      suspendOutput: 'partial',
      startedAt: T0,
      suspendedAt: T0 + 3,
    });
  });

  it('reads a stored suspension into those same fields, and gives it back unchanged', () => {
    const stored = {
      status: 'suspended',
      payload: 'in',
      suspendPayload: { reason: 'approve' },
      suspendOutput: { draft: 1 },
      startedAt: T0,
      suspendedAt: T0 + 3,
    } as const;
    const record = fromMastraStepResult(stored)!;

    expect(record).toEqual({
      status: 'suspended',
      payload: 'in',
      suspendPayload: { reason: 'approve' },
      suspendOutput: { draft: 1 },
      startedAt: T0,
      suspendedAt: T0 + 3,
      host: stored,
    });
    expect(toMastraStepResult(record)).toEqual(stored);
  });

  // `...(durableResult.output ? { suspendOutput: durableResult.output } : {})` — a truthiness test,
  // so a falsy output leaves the key off entirely rather than writing it as the falsy value.
  it.each([
    ['0', 0],
    ["''", ''],
    ['null', null],
    ['false', false],
    ['undefined', undefined],
  ])('writes no suspendOutput for a falsy output (%s), as Mastra tests truthiness', (_label, suspendOutput) => {
    const result = toMastraStepResult({ status: 'suspended', payload: 'in', suspendPayload: {}, suspendOutput, startedAt: T0, suspendedAt: T0 });
    expect(result).not.toHaveProperty('suspendOutput');
    expect(result).toEqual({ status: 'suspended', payload: 'in', suspendPayload: {}, startedAt: T0, suspendedAt: T0 });
  });

  it('requires suspendedAt, as a suspended StepResult does, and takes endedAt for none', () => {
    const record: StepRecord = { status: 'suspended', payload: 'in', suspendPayload: {}, startedAt: T0, endedAt: T0 + 1 };
    expect(() => toMastraStepResult(record)).toThrow(/has no suspendedAt/);
    expect(toMastraStepResult(record, { now: T0 + 9 })).toMatchObject({ suspendedAt: T0 + 9 });
    expect(toMastraStepResult(record, { now: T0 + 9 })).not.toHaveProperty('endedAt');
  });

  it('suspends a real run with its payload and output on the record, not its input', async () => {
    const clock = new ManualClock();
    const runner = new RecordingRunner({
      steps: { approve: () => ({ status: 'suspended', suspendPayload: { ask: 'sign' }, suspendOutput: 'draft' }) },
    });

    const report = await runWorkflowDetailed(compile(adapt([step('quote'), step('approve'), step('ship')])), 'order', { runner, clock });

    expect(report.outcome).toMatchObject({ status: 'suspended', stepId: 'approve', path: [1] });
    expect(toMastraStepResult(report.stepResults.get('approve')!)).toEqual({
      status: 'suspended',
      payload: 'order',
      suspendPayload: { ask: 'sign' },
      suspendOutput: 'draft',
      startedAt: clock.epochNow(),
      suspendedAt: clock.epochNow(),
    });
  });
});

describe("what host carries, and what the engine's record overrides", () => {
  it('round-trips the fields the engine does not model through host', () => {
    const host = {
      status: 'success',
      output: 'old',
      payload: 'in',
      resumePayload: { ok: true },
      startedAt: T0,
      resumedAt: T0 + 1,
      endedAt: T0 + 2,
      metadata: { nestedRunId: 'run-9', iterationCount: 1 },
    } as const;
    const record = fromMastraStepResult(host)!;
    expect(record).toMatchObject({ status: 'success', output: 'old', metadata: { iterationCount: 1 } });
    expect(toMastraStepResult(record)).toEqual(host);
  });

  it('takes every modelled field from the record, whatever host says', () => {
    const host = {
      status: 'failed',
      output: 'stale output',
      error: new Error('stale'),
      tripwire: { reason: 'stale' },
      nonRetryable: true,
      payload: 'stale input',
      startedAt: T0 - 100,
      endedAt: T0 - 50,
      resumedAt: T0 - 10,
    };
    const record: StepRecord = { status: 'success', output: 'new', payload: 'in', startedAt: T0, endedAt: T0 + 1, host };

    expect(toMastraStepResult(record)).toEqual({
      status: 'success',
      output: 'new',
      payload: 'in',
      startedAt: T0,
      endedAt: T0 + 1,
      resumedAt: T0 - 10,
    });

    // A top-level bail is rewritten to success in place (`default.ts:926-928`); the kernel does
    // the same to the record, whose host still says 'bailed'. The record's status wins.
    const bailed = { status: 'bailed', output: 'early', payload: 'in', startedAt: T0, endedAt: T0, metadata: { nestedRunId: 'n' } } as const;
    const rewritten = { ...fromMastraStepResult(bailed)!, status: 'success', output: 'early' } as StepRecord;
    expect(toMastraStepResult(rewritten)).toEqual({ ...bailed, status: 'success' });
  });

  it("drops a prior suspension's fields from a record no longer suspended, as omitPriorCompletionFields does", () => {
    // utils.ts:759-775, applied at handlers/step.ts:170-178: a resumed step's result loses
    // suspendedAt, suspendPayload and suspendOutput, and keeps resumePayload and resumedAt.
    const suspended = {
      status: 'suspended',
      payload: 'in',
      suspendPayload: { ask: 'approve' },
      suspendOutput: 'partial',
      startedAt: T0,
      suspendedAt: T0 + 1,
      resumePayload: { approved: true },
      resumedAt: T0 + 2,
    } as const;
    const resumed: StepRecord = { status: 'success', output: 'done', payload: 'in', startedAt: T0, endedAt: T0 + 3, host: suspended };

    expect(toMastraStepResult(resumed)).toEqual({
      status: 'success',
      output: 'done',
      payload: 'in',
      startedAt: T0,
      endedAt: T0 + 3,
      resumePayload: { approved: true },
      resumedAt: T0 + 2,
    });
  });

  it("merges the engine's iterationCount over the host metadata, and writes no foreachIndex", () => {
    // Mastra never writes metadata.foreachIndex into stepResults: a foreach's record is the
    // aggregate, whose metadata carries at most nestedRunId (handlers/control-flow.ts:1492).
    const record: StepRecord = {
      status: 'success',
      output: 1,
      payload: 0,
      startedAt: T0,
      endedAt: T0,
      metadata: { iterationCount: 3, foreachIndex: 2 },
      host: { metadata: { nestedRunId: 'r', iterationCount: 1 } },
    };
    expect(toMastraStepResult(record)).toEqual({
      status: 'success',
      output: 1,
      payload: 0,
      startedAt: T0,
      endedAt: T0,
      metadata: { nestedRunId: 'r', iterationCount: 3 },
    });
    expect(toMastraStepResult({ ...record, host: undefined, metadata: { foreachIndex: 2 } })).not.toHaveProperty('metadata');
  });

  it('refuses to invent a timestamp, unless told what now is', () => {
    const record: StepRecord = { status: 'success', output: 1, payload: 0 };
    expect(() => toMastraStepResult(record)).toThrow(/has no startedAt/);
    expect(toMastraStepResult(record, { now: T0 })).toMatchObject({ startedAt: T0, endedAt: T0 });
  });

  it('writes a pause without an end, as a paused step has none', () => {
    expect(toMastraStepResult({ status: 'paused', payload: 'in', startedAt: T0, endedAt: T0 + 9 })).toEqual({
      status: 'paused',
      payload: 'in',
      startedAt: T0,
    });
  });
});

describe('a canceled record, which only a loop or a foreach writes', () => {
  it("writes a loop's bare { status: 'canceled' } as exactly that, inventing no timestamp", () => {
    // handlers/control-flow.ts:752,817,899, stored under the body id by handlers/entry.ts:810-812.
    expect(toMastraStepResult({ status: 'canceled' })).toEqual({ status: 'canceled' });
    expect(toMastraStepResult({ status: 'canceled' }, { now: T0 })).toEqual({ status: 'canceled' });
  });

  it("writes a foreach's partial results with its own payload and times, and reads them back", () => {
    // handlers/control-flow.ts:1164-1169,1306: `{...stepInfo, status: 'canceled', output: results, endedAt}`.
    const record: StepRecord = { status: 'canceled', output: [1, null], payload: [1, 2], startedAt: T0, endedAt: T0 + 4 };
    const mastra = toMastraStepResult(record);

    expect(mastra).toEqual({ status: 'canceled', output: [1, null], payload: [1, 2], startedAt: T0, endedAt: T0 + 4 });
    expect(fromMastraStepResult(mastra as StoredStepResult)).toEqual({ ...record, host: mastra });
    expect(fromMastraStepResult({ status: 'canceled' })).toEqual({ status: 'canceled', host: { status: 'canceled' } });
  });

  it('is what a canceled loop leaves under its body id in a real run', async () => {
    const controller = new AbortController();
    const runner = new RecordingRunner({
      loops: {
        poll: () => {
          controller.abort();
          return true;
        },
      },
    });
    const loop: StepFlowEntry = {
      type: 'loop',
      step: { type: 'step', step: { id: 'poll' } },
      condition: () => true,
      serializedCondition: { id: 'poll-condition', fn: '() => true' },
      loopType: 'dowhile',
    };

    const report = await runWorkflowDetailed(compile(adapt([loop, step('ship')], { iterationBound: 5 })), 'order', {
      runner,
      signal: controller.signal,
    });

    expect(report.outcome.status).toBe('canceled');
    expect(runner.calls).toEqual(['poll']);
    expect(toMastraStepResult(report.stepResults.get('poll')!)).toEqual({ status: 'canceled' });
    expect(getStepResultView({ getStepResult: (id) => report.stepResults.get(id), initData: 'order' })('poll')).toBeNull();
  });
});

describe("a sleep's waiting record, as handlers/entry.ts:605-609 writes it", () => {
  const waiting: StepRecord = { status: 'waiting', payload: 'in', startedAt: T0 };
  const mastra = { status: 'waiting', payload: 'in', startedAt: T0 } as const;

  it("writes Mastra's StepWaiting: status, payload and startedAt, and nothing it did not write", () => {
    expect(toMastraStepResult(waiting)).toStrictEqual(mastra);
  });

  it('requires startedAt, as StepWaiting does, and takes now for a missing one', () => {
    expect(() => toMastraStepResult({ status: 'waiting', payload: 'in' })).toThrow(/'waiting' step record has no startedAt/);
    expect(toMastraStepResult({ status: 'waiting', payload: 'in' }, { now: T0 })).toStrictEqual(mastra);
  });

  it('keeps unmodelled host fields, and takes status, payload and startedAt from the record', () => {
    const record: StepRecord = { ...waiting, host: { status: 'running', payload: 'stale', startedAt: 1, note: 'kept' } };
    expect(toMastraStepResult(record)).toStrictEqual({ ...mastra, note: 'kept' });
  });

  it('reads a stored StepWaiting as a waiting record, keeping the original as host', () => {
    // A snapshot of a run canceled mid-sleep holds it; the kernel accepts it carried in.
    expect(fromMastraStepResult(mastra)).toEqual({ ...waiting, host: mastra });
  });

  it('round-trips: Mastra -> record -> Mastra is the identity, and record -> Mastra -> record keeps the record', () => {
    const record = fromMastraStepResult(mastra);
    expect(record).toBeDefined();
    expect(toMastraStepResult(record!)).toStrictEqual(mastra);
    expect(fromMastraStepResult(toMastraStepResult(waiting))).toMatchObject(waiting);
  });

  it('is what a run canceled mid-sleep leaves, translated as Mastra holds it', async () => {
    // A real 60s sleep, aborted 20ms in: the abort lands mid-wait. (A virtual clock jumps to the
    // wake, so it cannot hold a run mid-wait.)
    const ac = new AbortController();
    const compiled = compile(adapt([step('quote'), { type: 'sleep', id: 'nap', duration: 60_000 }, step('ship')]));
    const runner = new RecordingRunner({ steps: { quote: (x) => (setTimeout(() => ac.abort(), 20), { status: 'success', output: x }) } });
    const before = Date.now();
    const report = await runWorkflowDetailed(compiled, 'order', { runner, signal: ac.signal, timeoutMs: 10_000 });
    expect(report.outcome).toEqual({ status: 'canceled', origin: { stepId: 'nap', path: [1] }, started: true });
    const written = toMastraStepResult(report.stepResults.get('nap')!);
    expect(written).toStrictEqual({ status: 'waiting', payload: 'order', startedAt: expect.any(Number) });
    expect(written.startedAt).toBeGreaterThanOrEqual(before);
    // Mastra's accessor gives null for a waiting sleep, as for every status but success.
    expect(getStepResultView({ getStepResult: (id) => report.stepResults.get(id), initData: 'order' })('nap')).toBeNull();
  });
});

describe('reading what Mastra stored', () => {
  it('reads a failure from storage with its serialized error, and the non-outcome statuses as no record', () => {
    const stored = {
      status: 'failed',
      error: { name: 'Error', message: 'boom' },
      payload: 'in',
      startedAt: T0,
      endedAt: T0,
      nonRetryable: true,
      tripwire: { reason: 'r' },
    } as const;
    expect(fromMastraStepResult(stored)).toEqual({
      status: 'failed',
      error: stored.error,
      payload: 'in',
      startedAt: T0,
      endedAt: T0,
      nonRetryable: true,
      tripwire: { reason: 'r' },
      host: stored,
    });
    // A step in flight is not an outcome. (`waiting` is: a sleep canceled mid-wait keeps it — see
    // the waiting describe below.)
    expect(fromMastraStepResult({ status: 'running', payload: 'in', startedAt: T0 })).toBeUndefined();
    expect(fromMastraStepResult({ status: 'skipped', payload: {}, startedAt: T0, endedAt: T0 })).toBeUndefined();
    expect(() => fromMastraStepResult({ status: 'teleported' } as unknown as StoredStepResult)).toThrow(/teleported/);
  });

  it("keeps only iterationCount of Mastra's metadata on the record; the rest stays in host", () => {
    const stored = { status: 'success', output: 1, payload: 0, startedAt: T0, endedAt: T0, metadata: { foreachIndex: 4, nestedRunId: 'n' } } as const;
    expect(fromMastraStepResult(stored)).not.toHaveProperty('metadata');
    expect(toMastraStepResult(fromMastraStepResult(stored)!)).toEqual(stored);
  });

  it('turns a whole run’s records into the stepResults Mastra would hold, keyed by the user’s ids', async () => {
    const clock = new ManualClock();
    const report = await runWorkflowDetailed(compile(adapt([step('constructor'), step('__proto__')])), 'order', {
      runner: new RecordingRunner(),
      clock,
    });
    const stepResults = Object.fromEntries([...report.stepResults].map(([id, r]) => [id, toMastraStepResult(r)]));

    expect(Object.keys(stepResults)).toEqual(['constructor', '__proto__']);
    expect(Object.hasOwn(stepResults, '__proto__')).toBe(true);
    expect(stepResults['constructor']).toEqual({ status: 'success', output: 'order', payload: 'order', startedAt: clock.epochNow(), endedAt: clock.epochNow() });
  });
});

describe("getStepResult, as Mastra's step context has it", () => {
  const view = (records: Record<string, StepRecord>, initData: unknown = 'init'): Pick<RunView, 'getStepResult' | 'initData'> => ({
    initData,
    getStepResult: (id) => (Object.hasOwn(records, id) ? records[id] : undefined),
  });
  const records: Record<string, StepRecord> = {
    ok: { status: 'success', output: { total: 3 }, payload: 0 },
    none: { status: 'success', output: undefined, payload: 0 },
    bad: { status: 'failed', error: new Error('x'), payload: 0 },
    held: { status: 'suspended', payload: 0, suspendPayload: {}, suspendOutput: 'partial' },
    out: { status: 'bailed', output: 'early', payload: 0 },
    nested: { status: 'paused', payload: 0 },
    stopped: { status: 'canceled', output: ['partial'] },
  };

  it('returns the output of a success and null for every other status, as step.ts:179-193 does', () => {
    const get = getStepResultView(view(records));
    expect(['ok', 'none', 'bad', 'held', 'out', 'nested', 'stopped', 'never'].map(get)).toEqual([
      { total: 3 },
      undefined,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('accepts a step by its id, and returns null for one without an id', () => {
    const get = getStepResultView(view(records));
    expect(get({ id: 'ok' })).toEqual({ total: 3 });
    expect([get({}), get(null), get(undefined), get({ id: '' })]).toEqual([null, null, null, null]);
  });

  it("reads 'input' as the run's input, as Mastra's stepResults seeded with { input } does", () => {
    // default.ts:805-807. A run input shaped like a success reads as one; any other reads null;
    // a step actually named `input` takes the key over.
    expect(getStepResultView(view({}, { status: 'success', output: 'x' }))('input')).toBe('x');
    expect(getStepResultView(view({}, 'plain'))('input')).toBeNull();
    expect(getStepResultView(view({ input: { status: 'success', output: 'step', payload: 0 } }, 'plain'))('input')).toBe('step');
  });

  it('is what a step sees of an earlier step during a real run', async () => {
    const seen: unknown[] = [];
    const runner = new RecordingRunner({
      steps: {
        quote: () => ({ status: 'success', output: 42 }),
        ship: (_input, call) => {
          const get = getStepResultView(call);
          seen.push(get('quote'), get('audit'), get('ship'));
          return { status: 'success', output: 'shipped' };
        },
      },
    });
    // `audit` failed in an earlier segment and is carried in, as a resumed run's records are.
    const stepResults = new Map<string, StepRecord>([['audit', { status: 'failed', error: 'late', payload: 0 }]]);

    await runWorkflow(compile(adapt([step('quote'), step('ship')])), 'order', { runner, stepResults });

    expect(seen).toEqual([42, null, null]);
  });
});

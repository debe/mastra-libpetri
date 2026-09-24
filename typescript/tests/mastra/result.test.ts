import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createStep, createWorkflow, DefaultExecutionEngine } from '@mastra/core/workflows';
import type { StepFlowEntry } from '@mastra/core/workflows';
import { TripWire } from '@mastra/core/agent';
import type { RunOutcome, RunReport } from '../../src/engine/kernel.js';
import type { StepRecord } from '../../src/compiler/types.js';
import { PetriExecutionEngine } from '../../src/mastra/engine.js';
import {
  cleanStepResults,
  deduplicatePayloads,
  formatResultError,
  formatWorkflowResult,
  stepExecutionPath,
  suspension,
} from '../../src/mastra/result.js';

// ---------------------------------------------------------------------------------------------
// Unit tests over hand-built RunReports
// ---------------------------------------------------------------------------------------------

const T = 1_000;
const ok = (payload: unknown, output: unknown, extra: Partial<StepRecord> = {}): StepRecord =>
  ({ status: 'success', payload, output, startedAt: T, endedAt: T + 1, ...extra }) as StepRecord;

const stepEntry = (id: string): StepFlowEntry => ({ type: 'step', step: { id } }) as unknown as StepFlowEntry;
const sleepEntry = (id: string): StepFlowEntry => ({ type: 'sleep', id, duration: 10 }) as unknown as StepFlowEntry;
const parallelEntry = (...ids: string[]): StepFlowEntry =>
  ({ type: 'parallel', steps: ids.map((id) => ({ type: 'step', step: { id } })) }) as unknown as StepFlowEntry;
const loopEntry = (id: string): StepFlowEntry =>
  ({ type: 'loop', step: { id }, condition: () => false, loopType: 'dowhile' }) as unknown as StepFlowEntry;

function report(outcome: RunOutcome, records: Array<[string, StepRecord]>): RunReport {
  return { outcome, stepResults: new Map(records) };
}

describe('formatWorkflowResult over hand-built reports', () => {
  it('success: result, input, stepExecutionPath, payloads deduplicated along the path, runId', () => {
    const r = formatWorkflowResult({
      report: report({ status: 'success', output: { n: 3 } }, [
        ['a', ok({ n: 1 }, { n: 2 })],
        ['b', ok({ n: 2 }, { n: 3 })],
      ]),
      input: { n: 1 },
      state: { s: 1 },
      runId: 'r1',
      graph: { steps: [stepEntry('a'), stepEntry('b')] },
    });
    expect(r).toEqual({
      status: 'success',
      input: { n: 1 },
      result: { n: 3 },
      runId: 'r1',
      stepExecutionPath: ['a', 'b'],
      steps: {
        input: { n: 1 },
        a: { status: 'success', output: { n: 2 }, startedAt: T, endedAt: T + 1 },
        b: { status: 'success', output: { n: 3 }, startedAt: T, endedAt: T + 1 },
      },
    });
    expect('state' in r).toBe(false);
  });

  it('keeps a payload that differs from the previous output, and only a success advances it', () => {
    const steps = deduplicatePayloads(
      {
        input: 1,
        a: { status: 'success', payload: 1, output: 2 },
        b: { status: 'failed', payload: 7, error: new Error('x') },
        c: { status: 'success', payload: 2, output: 3 },
        off: { status: 'success', payload: 3, output: 3 },
      },
      ['a', 'b', 'c', 'missing'],
    );
    expect(steps['a']).toEqual({ status: 'success', output: 2 });
    expect(steps['b']).toHaveProperty('payload', 7);
    // `b` failed, so the previous output is still `a`'s: `c`'s payload 2 equals it.
    expect(steps['c']).toEqual({ status: 'success', output: 3 });
    // Off the path: untouched even though its payload equals the previous output.
    expect(steps['off']).toHaveProperty('payload', 3);
  });

  it('treats values deepEqual cannot compare as not matching', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const other: Record<string, unknown> = {};
    other['self'] = other;
    const steps = deduplicatePayloads({ input: cyclic, a: { status: 'success', payload: other, output: 1 } }, ['a']);
    expect(steps['a']).toHaveProperty('payload', other);
  });

  it('no graph: no stepExecutionPath and no deduplication, as fmtReturnValue without the argument', () => {
    const r = formatWorkflowResult({
      report: report({ status: 'success', output: 2 }, [['a', ok(1, 2)]]),
      input: 1,
      state: {},
    });
    expect('stepExecutionPath' in r).toBe(false);
    expect((r.steps['a'] as Record<string, unknown>)['payload']).toBe(1);
  });

  it('cleanStepResults strips metadata.nestedRunId, drops an emptied metadata, keeps user metadata', () => {
    expect(
      cleanStepResults({
        input: { metadata: { nestedRunId: 'x' }, v: 1 },
        a: { status: 'success', metadata: { nestedRunId: 'n' } },
        b: { status: 'success', metadata: { nestedRunId: 'n', iterationCount: 2 } },
        c: { status: 'success', metadata: null },
        d: [1, 2],
      }),
    ).toEqual({
      input: { v: 1 },
      a: { status: 'success' },
      b: { status: 'success', metadata: { iterationCount: 2 } },
      c: { status: 'success', metadata: null },
      d: [1, 2],
    });
  });

  it('state only with includeState', () => {
    const base = { report: report({ status: 'success', output: 1 }, []), input: 1, state: { k: 'v' } };
    expect(formatWorkflowResult({ ...base, outputOptions: { includeState: true } })['state']).toEqual({ k: 'v' });
    expect('state' in formatWorkflowResult({ ...base, outputOptions: { includeState: false } })).toBe(false);
  });

  it('failed: the error serialized by formatResultError, no stack', () => {
    const error = Object.assign(new Error('kaboom'), { code: 'E1' });
    const r = formatWorkflowResult({
      report: report({ status: 'failed', error, stepId: 'a', path: [0] }, [
        ['a', { status: 'failed', payload: 1, error, startedAt: T, endedAt: T } as StepRecord],
      ]),
      input: 1,
      state: {},
      graph: { steps: [stepEntry('a'), stepEntry('b')] },
    });
    expect(r['error']).toEqual({ message: 'kaboom', name: 'Error', code: 'E1' });
    expect(r['error']).not.toHaveProperty('stack');
    expect(r['stepExecutionPath']).toEqual(['a']);
    expect('result' in r).toBe(false);
  });

  it('formatResultError: a string, an object, and nothing', () => {
    expect(formatResultError('bad')).toEqual({ message: 'bad', name: 'Error' });
    expect(formatResultError({ message: 'obj', extra: 1 })).toMatchObject({ message: 'obj', extra: 1 });
    expect(formatResultError(undefined)).toEqual({ message: 'Unknown workflow error', name: 'Error' });
  });

  it('tripwire: a TripWire instance is flattened', () => {
    const wire = new TripWire('blocked', { retry: true, metadata: { m: 1 } }, 'proc');
    const r = formatWorkflowResult({
      report: report({ status: 'tripwire', tripwire: wire, error: wire, stepId: 'a', path: [0] }, []),
      input: 1,
      state: {},
    });
    expect(r['status']).toBe('tripwire');
    expect(r['tripwire']).toEqual({ reason: 'blocked', retry: true, metadata: { m: 1 }, processorId: 'proc' });
  });

  it('tripwire: data carrying reason passes through as it is', () => {
    const data = { reason: 'r', retry: undefined, extra: 'kept' };
    const r = formatWorkflowResult({
      report: report({ status: 'tripwire', tripwire: data, error: new Error('e'), stepId: 'a', path: [0] }, []),
      input: 1,
      state: {},
    });
    expect(r['tripwire']).toBe(data);
  });

  it('tripwire: a plain Error is not a TripWire to Mastra — failed, with the outcome\'s error', () => {
    const error = new Error('step error');
    const r = formatWorkflowResult({
      // The record's error differs on purpose: the result must come from the outcome, which is
      // what the kernel classified, not from whatever record happens to sit under the id.
      report: report({ status: 'tripwire', tripwire: new Error('not a wire'), error, stepId: 'a', path: [0] }, [
        ['a', { status: 'failed', payload: 1, error: new Error('stale record'), startedAt: T, endedAt: T } as StepRecord],
      ]),
      input: 1,
      state: {},
    });
    expect(r['status']).toBe('failed');
    expect(r['error']).toEqual({ message: 'step error', name: 'Error' });
  });

  it('suspended: every suspended record, in start order, __workflow_meta stripped from the list, nested path kept', () => {
    const suspendedRec = (payload: unknown): StepRecord =>
      ({ status: 'suspended', payload: 1, suspendPayload: payload, startedAt: T, suspendedAt: T }) as StepRecord;
    const r = formatWorkflowResult({
      report: report({ status: 'suspended', payload: {}, stepId: 'y', path: [0, 1] }, [
        // Recorded in completion order: y first. Mastra lists by start (declaration) order.
        ['y', suspendedRec({ ask: 'y', __workflow_meta: { runId: 'r1', path: ['inner'] } })],
        ['x', suspendedRec({ ask: 'x' })],
      ]),
      input: 1,
      state: {},
      runId: 'r1',
      graph: { steps: [parallelEntry('x', 'y')] },
      outputOptions: { includeResumeLabels: true },
      resumeLabels: { go: { stepId: 'x' } },
    });
    expect(r['suspended']).toEqual([['x'], ['y', 'inner']]);
    expect(r['suspendPayload']).toEqual({ x: { ask: 'x' }, y: { ask: 'y' } });
    expect(r['resumeLabels']).toEqual({ go: { stepId: 'x' } });
    // The step record keeps a nested workflow's meta, as Mastra's does (`default.ts:629-644`
    // strips it only from the top-level `suspendPayload`).
    expect((r.steps['y'] as Record<string, unknown>)['suspendPayload']).toHaveProperty('__workflow_meta');
    expect(r['stepExecutionPath']).toEqual([]);
  });

  it('suspension() on a missing suspendPayload lists the step with an empty payload', () => {
    expect(suspension({ input: 1, a: { status: 'suspended' } })).toEqual({ suspended: [['a']], suspendPayload: { a: {} } });
  });

  it('resumeLabels only when suspended and asked', () => {
    const base = { input: 1, state: {}, outputOptions: { includeResumeLabels: true } };
    expect('resumeLabels' in formatWorkflowResult({ ...base, report: report({ status: 'success', output: 1 }, []) })).toBe(false);
    const s = formatWorkflowResult({ ...base, report: report({ status: 'suspended', payload: 1, stepId: 'a', path: [0] }, []) });
    expect(s['resumeLabels']).toEqual({});
  });

  it('paused and canceled carry nothing beyond the base', () => {
    const p = formatWorkflowResult({ report: report({ status: 'paused', stepId: 'a', path: [0] }, []), input: 1, state: {} });
    expect(Object.keys(p).sort()).toEqual(['input', 'status', 'steps']);
    // Originless: only the settle stage after the last entry's success emits one, so started.
    const c = formatWorkflowResult({ report: report({ status: 'canceled', started: true }, []), input: 1, state: {} });
    expect(Object.keys(c).sort()).toEqual(['input', 'status', 'steps']);
  });

  it('stranded throws, naming the places', () => {
    expect(() =>
      formatWorkflowResult({ report: report({ status: 'stranded', places: ['p.x'] }, []), input: 1, state: {} }),
    ).toThrow(/p\.x/);
  });
});

describe('stepExecutionPath', () => {
  const graph = [stepEntry('a'), parallelEntry('p1', 'p2'), sleepEntry('zz'), loopEntry('body'), stepEntry('b')];
  /** A canceled outcome as the contract's `CanceledToken` describes it, `started` included. */
  const canceled = (path: number[], started: boolean, stepId = 'x'): Extract<RunOutcome, { status: 'canceled' }> =>
    ({ status: 'canceled', origin: { stepId, path }, started }) as Extract<RunOutcome, { status: 'canceled' }>;

  it('success: every top-level single step and sleep, never a combinator or its children', () => {
    expect(stepExecutionPath(graph, { status: 'success', output: 1 })).toEqual(['a', 'zz', 'b']);
  });

  it('a stop inside a combinator counts every entry before it', () => {
    expect(stepExecutionPath(graph, { status: 'failed', error: 1, stepId: 'body', path: [3] })).toEqual(['a', 'zz']);
  });

  it('a top-level step that ended the run is on the path', () => {
    expect(stepExecutionPath(graph, { status: 'suspended', payload: 1, stepId: 'b', path: [4] })).toEqual(['a', 'zz', 'b']);
  });

  it('canceled at a step\'s start gate (started: false): not on the path', () => {
    expect(stepExecutionPath(graph, canceled([4], false, 'b'))).toEqual(['a', 'zz']);
  });

  it('canceled after a step ran (started: true, the settle stage): on the path', () => {
    expect(stepExecutionPath(graph, canceled([4], true, 'b'))).toEqual(['a', 'zz', 'b']);
  });

  it('canceled mid-sleep (started: true): the sleep is on the path', () => {
    expect(stepExecutionPath(graph, canceled([2], true, 'zz'))).toEqual(['a', 'zz']);
  });

  it('canceled before a sleep began (started: false): the sleep is not on the path', () => {
    expect(stepExecutionPath(graph, canceled([2], false, 'zz'))).toEqual(['a']);
  });

  it('canceled inside a top-level combinator: everything before it, never the combinator', () => {
    expect(stepExecutionPath(graph, canceled([3, 0], false, 'body'))).toEqual(['a', 'zz']);
    expect(stepExecutionPath(graph, canceled([3], true, 'body'))).toEqual(['a', 'zz']);
  });

  it('canceled with no origin — the settle after the last entry — every entry ran', () => {
    expect(stepExecutionPath(graph, { status: 'canceled', started: true })).toEqual(['a', 'zz', 'b']);
  });

  it('a canceled outcome that does not carry started is read as not started', () => {
    // The type now requires `started`; `canceledStarted` in src/mastra/result.ts still guards its
    // absence (a kernel defect, read as not started). The cast builds that defective outcome on
    // purpose, to exercise the guard.
    const missing = { status: 'canceled', origin: { stepId: 'zz', path: [2] } } as unknown as Extract<
      RunOutcome,
      { status: 'canceled' }
    >;
    expect(stepExecutionPath(graph, missing)).toEqual(['a']);
  });

  it('a bail: from the outcome\'s origin, never past it — a sleep after it is not on the path', () => {
    const entries = [stepEntry('a'), stepEntry('bailer'), sleepEntry('zz'), stepEntry('c')];
    expect(stepExecutionPath(entries, { status: 'success', output: 1, bailed: true, stepId: 'bailer', path: [1] })).toEqual([
      'a',
      'bailer',
    ]);
  });

  it('a bail inside a top-level loop: everything before the loop, not the loop', () => {
    expect(stepExecutionPath(graph, { status: 'success', output: 1, bailed: true, stepId: 'body', path: [3] })).toEqual([
      'a',
      'zz',
    ]);
  });

  it('the same step twice at the top level is on the path twice, and a bail at its first use stops there', () => {
    const twice = [stepEntry('a'), stepEntry('a')];
    expect(stepExecutionPath(twice, { status: 'success', output: 1 })).toEqual(['a', 'a']);
    expect(stepExecutionPath(twice, { status: 'success', output: 1, bailed: true, stepId: 'a', path: [0] })).toEqual(['a']);
  });
});

describe('suspend metadata and resume labels', () => {
  const suspendedRec = (payload: unknown): StepRecord =>
    ({ status: 'suspended', payload: 1, suspendPayload: payload, startedAt: T, suspendedAt: T }) as StepRecord;

  it('a nested meta whose path equals the step\'s own id is a nested path, never mistaken for an executor stamp', () => {
    // A nested workflow `x` whose inner step is also `x`, sharing the parent's run id
    // (`handlers/step.ts:108-109`): Mastra lists [[x, x]] and keeps the meta on the record.
    const r = formatWorkflowResult({
      report: report({ status: 'suspended', payload: {}, stepId: 'x', path: [0] }, [
        ['x', suspendedRec({ q: 1, __workflow_meta: { runId: 'r1', path: ['x'] } })],
      ]),
      input: 1,
      state: {},
      runId: 'r1',
      graph: { steps: [stepEntry('x')] },
    });
    expect(r['suspended']).toEqual([['x', 'x']]);
    expect(r['suspendPayload']).toEqual({ x: { q: 1 } });
    expect((r.steps['x'] as Record<string, unknown>)['suspendPayload']).toEqual({ q: 1, __workflow_meta: { runId: 'r1', path: ['x'] } });
  });

  it('resumeLabels are the run\'s, as given, a copy', () => {
    const labels = { lx: { stepId: 'x' }, ly: { stepId: 'y', foreachIndex: 1 } };
    const r = formatWorkflowResult({
      report: report({ status: 'suspended', payload: {}, stepId: 'x', path: [0] }, [['x', suspendedRec({})]]),
      input: 1,
      state: {},
      outputOptions: { includeResumeLabels: true },
      resumeLabels: labels,
    });
    expect(r['resumeLabels']).toEqual(labels);
    expect(r['resumeLabels']).not.toBe(labels);
  });

  it('resumeLabels are left off unless asked, and off a run that did not suspend', () => {
    const labels = { l: { stepId: 'x' } };
    const suspended = report({ status: 'suspended', payload: {}, stepId: 'x', path: [0] }, [['x', suspendedRec({})]]);
    expect('resumeLabels' in formatWorkflowResult({ report: suspended, input: 1, state: {}, resumeLabels: labels })).toBe(false);
    const failed = report({ status: 'failed', error: new Error('x'), stepId: 'x', path: [0] }, []);
    const r = formatWorkflowResult({ report: failed, input: 1, state: {}, resumeLabels: labels, outputOptions: { includeResumeLabels: true } });
    expect('resumeLabels' in r).toBe(false);
  });
});

describe('waiting records', () => {
  it('a sleep canceled mid-wait keeps its waiting record, in Mastra\'s StepWaiting shape', () => {
    const r = formatWorkflowResult({
      report: report({ status: 'canceled', origin: { stepId: 'zz', path: [1] }, started: true } as RunOutcome, [
        ['a', ok(1, 2)],
        ['zz', { status: 'waiting', payload: 2, startedAt: T } as StepRecord],
      ]),
      input: 1,
      state: {},
      graph: { steps: [stepEntry('a'), sleepEntry('zz'), stepEntry('b')] },
    });
    expect(r['stepExecutionPath']).toEqual(['a', 'zz']);
    // On the path, so its payload — `a`'s output — is deduplicated away, as Mastra's is.
    expect(r.steps['zz']).toEqual({ status: 'waiting', startedAt: T });
  });
});

// ---------------------------------------------------------------------------------------------
// End to end: real Mastra workflows through Run.start() on both engines
// ---------------------------------------------------------------------------------------------

type Engine = 'default' | 'petri';
const num = z.object({ n: z.number() });
const TIME_KEYS = new Set(['startedAt', 'endedAt', 'suspendedAt', 'resumedAt']);
const ID_KEYS = new Set(['runId', 'traceId', 'spanId']);

/** Mastra mints `.sleep()` ids as `sleep_<uuid>` per build, so two builds never share one. */
const SLEEP_ID = /^(sleep|sleepUntil)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const anonymize = (s: string): string => (SLEEP_ID.test(s) ? s.replace(/_.*/, '_<id>') : s);

/** Removes timestamps anywhere, ids at the top level, and the uuid in a sleep's id — nothing else. */
function normalize(result: unknown): unknown {
  const strip = (v: unknown): unknown => {
    if (typeof v === 'string') return anonymize(v);
    if (Array.isArray(v)) return v.map(strip);
    if (v instanceof Error || typeof v !== 'object' || v === null) return v;
    return Object.fromEntries(Object.entries(v).filter(([k]) => !TIME_KEYS.has(k)).map(([k, x]) => [anonymize(k), strip(x)]));
  };
  const top = Object.fromEntries(Object.entries(result as Record<string, unknown>).filter(([k]) => !ID_KEYS.has(k)));
  return strip(top);
}

/**
 * Engine identity. Runs `run` with both engines' `execute()` spied on the prototype and asserts
 * that the side's own engine ran `workflowId` at least once and the other engine never did —
 * without it, a petri side that silently ran on `DefaultExecutionEngine` would compare the
 * default engine with itself and every oracle test here would pass vacuously. Only calls for
 * `workflowId` count: a nested workflow runs on its own engine.
 */
async function onEngine<T>(side: Engine, workflowId: string, run: () => Promise<T>): Promise<T> {
  const petri = vi.spyOn(PetriExecutionEngine.prototype, 'execute');
  const dflt = vi.spyOn(DefaultExecutionEngine.prototype, 'execute');
  try {
    const value = await run();
    const count = (spy: { mock: { calls: unknown[][] } }): number =>
      spy.mock.calls.filter(([params]) => (params as { workflowId?: unknown }).workflowId === workflowId).length;
    const own = side === 'petri' ? count(petri) : count(dflt);
    const other = side === 'petri' ? count(dflt) : count(petri);
    expect({ side, workflowId, ranOnOwnEngine: own >= 1, callsOnOtherEngine: other }).toEqual({
      side,
      workflowId,
      ranOnOwnEngine: true,
      callsOnOtherEngine: 0,
    });
    return value;
  } finally {
    petri.mockRestore();
    dflt.mockRestore();
  }
}

const workflowIdOf = (workflow: unknown): string => (workflow as { id: string }).id;

function cfg(engine: Engine): object {
  return engine === 'default' ? {} : { executionEngine: new PetriExecutionEngine({ iterationBound: 10 }) };
}

async function both(
  make: (engine: Engine) => { createRun: () => Promise<{ start: (args: never) => Promise<unknown>; runId: string }> },
  args: Record<string, unknown>,
): Promise<{
  oracle: Record<string, unknown>;
  petri: Record<string, unknown>;
  oracleRaw: Record<string, unknown>;
  petriRaw: Record<string, unknown>;
}> {
  const oracleWf = make('default');
  const oracleRun = await oracleWf.createRun();
  const oracle = await onEngine('default', workflowIdOf(oracleWf), async () => (await oracleRun.start(args as never)) as Record<string, unknown>);
  const petriWf = make('petri');
  const petriRun = await petriWf.createRun();
  const petriRaw = await onEngine('petri', workflowIdOf(petriWf), async () => (await petriRun.start(args as never)) as Record<string, unknown>);
  expect(petriRaw['runId']).toBe(petriRun.runId);
  expect(oracle['runId']).toBe(oracleRun.runId);
  return {
    oracle: normalize(oracle) as Record<string, unknown>,
    petri: normalize(petriRaw) as Record<string, unknown>,
    oracleRaw: oracle,
    petriRaw,
  };
}

const add = (id: string, by: number) =>
  createStep({ id, inputSchema: num, outputSchema: num, execute: async ({ inputData }) => ({ n: inputData.n + by }) });

/** A step that takes `ms` before it returns, so a cancel can land while it runs. */
const slow = (id: string, by: number, ms: number) =>
  createStep({
    id,
    inputSchema: num,
    outputSchema: num,
    execute: async ({ inputData }) => {
      await new Promise((r) => setTimeout(r, ms));
      return { n: inputData.n + by };
    },
  });

/** Starts a run on each engine and cancels it `afterMs` later. */
async function cancelBoth(
  make: (engine: Engine) => { createRun: () => Promise<{ start: (args: never) => Promise<unknown>; cancel: () => Promise<void> }> },
  afterMs: number,
): Promise<{ oracle: Record<string, unknown>; petri: Record<string, unknown> }> {
  const results: Record<string, unknown>[] = [];
  for (const engine of ['default', 'petri'] as const) {
    const workflow = make(engine);
    const run = await workflow.createRun();
    const result = await onEngine(engine, workflowIdOf(workflow), async () => {
      const pending = run.start({ inputData: { n: 1 } } as never);
      await new Promise((r) => setTimeout(r, afterMs));
      await run.cancel();
      return pending;
    });
    results.push(normalize(result) as Record<string, unknown>);
  }
  const [oracle, petri] = results as [Record<string, unknown>, Record<string, unknown>];
  return { oracle, petri };
}

describe('formatWorkflowResult end to end, default engine as the oracle', () => {
  it('linear success, state omitted', async () => {
    const stateSchema = z.object({ seen: z.array(z.string()).optional() });
    const tag = (id: string) =>
      createStep({
        id,
        inputSchema: num,
        outputSchema: num,
        stateSchema,
        execute: async ({ inputData, state, setState }) => {
          await setState({ ...state, seen: [...(state.seen ?? []), id] });
          return { n: inputData.n + 1 };
        },
      });
    const make = (e: Engine) =>
      createWorkflow({ id: 'lin', inputSchema: num, outputSchema: num, stateSchema, ...cfg(e) }).then(tag('a')).then(tag('b')).commit();
    const { oracle, petri } = await both(make, { inputData: { n: 1 } });
    expect(oracle['stepExecutionPath']).toEqual(['a', 'b']);
    expect(petri).toEqual(oracle);

    const withState = await both(make, { inputData: { n: 1 }, outputOptions: { includeState: true } });
    expect(withState.oracle['state']).toEqual({ seen: ['a', 'b'] });
    expect(withState.petri).toEqual(withState.oracle);
  });

  it('a payload differing from the previous output is kept (.map between steps)', async () => {
    const make = (e: Engine) =>
      createWorkflow({ id: 'mapped', inputSchema: num, outputSchema: num, ...cfg(e) })
        .then(add('a', 1))
        .map(async ({ inputData }) => ({ n: inputData.n * 100 }))
        .then(add('b', 1))
        .commit();
    const { oracle, petri } = await both(make, { inputData: { n: 1 } });
    expect(petri).toEqual(oracle);
  });

  it('failed: error serialized, path stops at the failing step', async () => {
    const boom = createStep({
      id: 'boom',
      inputSchema: num,
      outputSchema: num,
      execute: async () => {
        throw Object.assign(new Error('kaboom'), { code: 'E_BOOM' });
      },
    });
    const make = (e: Engine) =>
      createWorkflow({ id: 'fail', inputSchema: num, outputSchema: num, ...cfg(e) }).then(add('a', 1)).then(boom).then(add('c', 1)).commit();
    const { oracle, petri } = await both(make, { inputData: { n: 1 } });
    expect(oracle['status']).toBe('failed');
    expect(oracle['stepExecutionPath']).toEqual(['a', 'boom']);
    expect(petri).toEqual(oracle);
  });

  it('tripwire thrown by a step', async () => {
    const wire = createStep({
      id: 'wire',
      inputSchema: num,
      outputSchema: num,
      execute: async () => {
        throw new TripWire('blocked', { retry: false, metadata: { why: 'policy' } }, 'guard');
      },
    });
    const make = (e: Engine) => createWorkflow({ id: 'tw', inputSchema: num, outputSchema: num, ...cfg(e) }).then(wire).commit();
    const { oracle, petri } = await both(make, { inputData: { n: 1 } });
    expect(oracle['status']).toBe('tripwire');
    expect(petri).toEqual(oracle);
  });

  it('bail at the top level is a success, the rest of the path never started', async () => {
    const bailer = createStep({
      id: 'bailer',
      inputSchema: num,
      outputSchema: num,
      execute: async ({ inputData, bail }) => bail({ n: inputData.n + 42 }),
    });
    const make = (e: Engine) =>
      createWorkflow({ id: 'bail', inputSchema: num, outputSchema: num, ...cfg(e) }).then(add('a', 1)).then(bailer).then(add('c', 1)).commit();
    const { oracle, petri } = await both(make, { inputData: { n: 1 } });
    expect(oracle['status']).toBe('success');
    expect(oracle['stepExecutionPath']).toEqual(['a', 'bailer']);
    expect(petri).toEqual(oracle);
  });

  it('suspended with a resume label, with and without includeResumeLabels', async () => {
    const asker = createStep({
      id: 'asker',
      inputSchema: num,
      outputSchema: num,
      suspendSchema: z.object({ question: z.string() }),
      resumeSchema: z.object({ answer: z.number() }),
      execute: async ({ inputData, suspend, resumeData }) => {
        if (resumeData) return { n: resumeData.answer };
        await suspend({ question: `n=${inputData.n}?` }, { resumeLabel: 'approve' });
        return { n: -1 };
      },
    });
    const make = (e: Engine) =>
      createWorkflow({ id: 'susp', inputSchema: num, outputSchema: num, ...cfg(e) }).then(add('a', 1)).then(asker).commit();
    const plain = await both(make, { inputData: { n: 1 } });
    expect(plain.oracle['suspended']).toEqual([['asker']]);
    expect(plain.petri).toEqual(plain.oracle);

    const labelled = await both(make, { inputData: { n: 1 }, outputOptions: { includeResumeLabels: true } });
    expect(labelled.oracle['resumeLabels']).toEqual({ approve: { stepId: 'asker' } });
    expect(labelled.petri).toEqual(labelled.oracle);
  });

  it('two parallel arms suspend: both listed, in declaration order', async () => {
    const ask = (id: string, delayMs: number) =>
      createStep({
        id,
        inputSchema: num,
        outputSchema: num,
        suspendSchema: z.object({ who: z.string() }),
        execute: async ({ suspend }) => {
          await new Promise((r) => setTimeout(r, delayMs));
          await suspend({ who: id });
          return { n: 0 };
        },
      });
    const make = (e: Engine) =>
      createWorkflow({ id: 'par-susp', inputSchema: num, outputSchema: z.any(), ...cfg(e) })
        // The first arm finishes last, so completion order and declaration order differ.
        .parallel([ask('slow', 30), ask('fast', 1)])
        .commit();
    const { oracle, petri } = await both(make, { inputData: { n: 1 } });
    expect(oracle['suspended']).toEqual([['slow'], ['fast']]);
    expect(oracle['stepExecutionPath']).toEqual([]);
    expect(petri).toEqual(oracle);
  });

  it('sleep, parallel, foreach and a loop: only top-level single steps and sleeps on the path', async () => {
    const make = (e: Engine) =>
      createWorkflow({ id: 'mixed', inputSchema: num, outputSchema: z.any(), ...cfg(e) })
        .then(add('a', 1))
        .sleep(5)
        .parallel([add('p1', 1), add('p2', 2)])
        .map(async ({ inputData }) => [{ n: inputData.p1?.n ?? 0 }, { n: inputData.p2?.n ?? 0 }])
        .foreach(add('each', 1))
        .map(async ({ inputData }) => ({ n: inputData.length }))
        .dountil(add('inc', 1), async ({ inputData }) => inputData.n >= 4)
        .then(add('z', 0))
        .commit();
    const { oracle, petri } = await both(make, { inputData: { n: 1 } });
    expect(oracle['status']).toBe('success');
    const path = oracle['stepExecutionPath'] as string[];
    expect(path).toContain('a');
    expect(path).toContain('z');
    expect(path).not.toContain('p1');
    expect(path).not.toContain('each');
    expect(path).not.toContain('inc');
    expect(petri).toEqual(oracle);
  });

  it('canceled mid-sleep: equal, the interrupted sleep\'s waiting record included', async () => {
    const make = (e: Engine) =>
      createWorkflow({ id: 'cancel', inputSchema: num, outputSchema: num, ...cfg(e) }).then(add('a', 1)).sleep(500).then(add('b', 1)).commit();
    const { oracle, petri } = await cancelBoth(make, 50);
    expect(oracle['status']).toBe('canceled');
    const sleepId = (oracle['stepExecutionPath'] as string[])[1]!;
    expect(oracle['stepExecutionPath']).toEqual(['a', 'sleep_<id>']);
    // Mastra leaves the interrupted sleep's `waiting` record (`handlers/entry.ts:602-609`); its
    // payload, `a`'s output, is deduplicated away along the path.
    expect((oracle['steps'] as Record<string, unknown>)[sleepId]).toEqual({ status: 'waiting' });
    expect(petri).toEqual(oracle);
  });

  it('canceled while the entry before a sleep runs: the sleep never began, so it is not on the path', async () => {
    const make = (e: Engine) =>
      createWorkflow({ id: 'cancel-before-sleep', inputSchema: num, outputSchema: num, ...cfg(e) })
        .then(slow('a', 1, 40))
        .sleep(300)
        .then(add('z', 1))
        .commit();
    const { oracle, petri } = await cancelBoth(make, 10);
    expect(oracle['status']).toBe('canceled');
    expect(oracle['stepExecutionPath']).toEqual(['a']);
    expect(petri).toEqual(oracle);
  });

  it('canceled during a .parallel() followed by a sleep: nothing on the path', async () => {
    const make = (e: Engine) =>
      createWorkflow({ id: 'cancel-par-sleep', inputSchema: num, outputSchema: z.any(), ...cfg(e) })
        .parallel([slow('p1', 1, 40), slow('p2', 2, 40)])
        .sleep(300)
        .commit();
    const { oracle, petri } = await cancelBoth(make, 10);
    expect(oracle['status']).toBe('canceled');
    expect(oracle['stepExecutionPath']).toEqual([]);
    expect(petri).toEqual(oracle);
  });

  it('a step aborts the run and then throws: canceled, the step on the path (settle stage)', async () => {
    const aborter = createStep({
      id: 'aborter',
      inputSchema: num,
      outputSchema: num,
      execute: async ({ abort }) => {
        abort();
        throw new Error('after abort');
      },
    });
    const make = (e: Engine) =>
      createWorkflow({ id: 'abort-throw', inputSchema: num, outputSchema: num, ...cfg(e) }).then(aborter).then(add('z', 1)).commit();
    const { oracle, petri } = await both(make, { inputData: { n: 1 } });
    expect(oracle['status']).toBe('canceled');
    expect(oracle['stepExecutionPath']).toEqual(['aborter']);
    expect(petri).toEqual(oracle);
  });

  it('the last step aborts the run and returns: canceled, every entry on the path', async () => {
    const aborter = createStep({
      id: 'aborter',
      inputSchema: num,
      outputSchema: num,
      execute: async ({ inputData, abort }) => {
        abort();
        return { n: inputData.n + 1 };
      },
    });
    const make = (e: Engine) =>
      createWorkflow({ id: 'abort-last', inputSchema: num, outputSchema: num, ...cfg(e) }).then(add('a', 1)).then(aborter).commit();
    const { oracle, petri } = await both(make, { inputData: { n: 1 } });
    expect(oracle['status']).toBe('canceled');
    expect(oracle['stepExecutionPath']).toEqual(['a', 'aborter']);
    expect(petri).toEqual(oracle);
  });

  it('bail followed by a .sleep(): the sleep is not on the path', async () => {
    const bailer = createStep({
      id: 'bailer',
      inputSchema: num,
      outputSchema: num,
      execute: async ({ inputData, bail }) => bail({ n: inputData.n + 42 }),
    });
    const make = (e: Engine) =>
      createWorkflow({ id: 'bail-sleep', inputSchema: num, outputSchema: num, ...cfg(e) })
        .then(add('a', 1))
        .then(bailer)
        .sleep(10)
        .then(add('z', 1))
        .commit();
    const { oracle, petri } = await both(make, { inputData: { n: 1 } });
    expect(oracle['status']).toBe('success');
    expect(oracle['stepExecutionPath']).toEqual(['a', 'bailer']);
    expect(petri).toEqual(oracle);
  });

  it('a step named input replaces the run input in steps and in result.input', async () => {
    const make = (e: Engine) =>
      createWorkflow({ id: 'named-input', inputSchema: num, outputSchema: num, ...cfg(e) }).then(add('input', 1)).then(add('b', 1)).commit();
    const { oracle, petri } = await both(make, { inputData: { n: 1 } });
    expect(oracle['input']).toMatchObject({ status: 'success' });
    expect(petri).toEqual(oracle);
  });

  it('a suspend inside .foreach(): equal but for Mastra\'s foreach __workflow_meta on the step (divergence, row 35)', async () => {
    const ask = createStep({
      id: 'ask',
      inputSchema: num,
      outputSchema: num,
      suspendSchema: z.object({ i: z.number() }),
      execute: async ({ inputData, suspend }) => {
        await suspend({ i: inputData.n }, { resumeLabel: `l${inputData.n}` });
        return { n: 0 };
      },
    });
    const make = (e: Engine) =>
      createWorkflow({ id: 'fe-susp', inputSchema: z.array(num), outputSchema: z.any(), ...cfg(e) }).foreach(ask).commit();
    const { oracle, petri } = await both(make, { inputData: [{ n: 1 }, { n: 2 }], outputOptions: { includeResumeLabels: true } });
    expect(oracle['status']).toBe('suspended');
    const oracleSteps = oracle['steps'] as Record<string, Record<string, unknown>>;
    const { __workflow_meta: meta, ...userPayload } = oracleSteps['ask']!['suspendPayload'] as Record<string, unknown>;
    // What Mastra keeps and the kernel's aggregate record cannot rebuild: the per-item results.
    expect(meta).toMatchObject({ foreachIndex: 0, foreachOutput: expect.any(Array) });
    expect(petri).toEqual({ ...oracle, steps: { ...oracleSteps, ask: { ...oracleSteps['ask'], suspendPayload: userPayload } } });
  });

  it('a nested workflow suspends: the inner path and the nested meta are kept', async () => {
    const make = (e: Engine) => {
      const inner = createStep({
        id: 'inner',
        inputSchema: num,
        outputSchema: num,
        suspendSchema: z.object({ q: z.string() }),
        execute: async ({ suspend }) => {
          await suspend({ q: 'x' }, { resumeLabel: 'lbl' });
          return { n: 0 };
        },
      });
      const nested = createWorkflow({ id: 'nested', inputSchema: num, outputSchema: num }).then(inner).commit();
      return createWorkflow({ id: 'outer', inputSchema: num, outputSchema: num, ...cfg(e) }).then(nested).commit();
    };
    const { oracle, petri, oracleRaw, petriRaw } = await both(make, { inputData: { n: 1 }, outputOptions: { includeResumeLabels: true } });
    expect(oracle['suspended']).toEqual([['nested', 'inner']]);
    // The nested run shares the parent's run id (`handlers/step.ts:108-109`), which differs per run.
    const metaOf = (r: Record<string, unknown>) =>
      ((r['steps'] as Record<string, Record<string, unknown>>)['nested']!['suspendPayload'] as Record<string, Record<string, unknown>>)[
        '__workflow_meta'
      ]!;
    expect(metaOf(oracle)['runId']).toBe(oracleRaw['runId']);
    expect(metaOf(petri)['runId']).toBe(petriRaw['runId']);
    metaOf(oracle)['runId'] = '<run>';
    metaOf(petri)['runId'] = '<run>';
    expect(petri).toEqual(oracle);
  });
});

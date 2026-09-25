import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { fromMastraStepResult, toMastraStepResult } from '../../src/mastra/step-result.js';
import type { StoredStepResult } from '../../src/mastra/host.js';
import type { StepRecord } from '../../src/compiler/types.js';

/**
 * `fromMastraStepResult` is the inverse of `toMastraStepResult` (contract C19, ADR 0007): a resume
 * starts from the records Mastra stored, and a record that goes out through one and back through
 * the other must not change on the way.
 *
 * - **Mastra -> engine -> Mastra** is the identity, key for key (`toStrictEqual`), for every status
 *   that has a record — a stored failure's serialised `error` included. One key is restored, not
 *   kept: a failure stored through JSON lost its own `tripwire: undefined`, and gets it back as
 *   Mastra writes it (`default.ts:497-506`; `step-result.test.ts` pins that choice).
 * - **engine -> Mastra -> engine** is the identity on every field but `host`, which becomes the
 *   Mastra result, and the two fields Mastra never stores (`metadata.foreachIndex`, a thrown
 *   value that is not an `Error`) — each pinned below.
 */

const T0 = 1_700_000_000_000;

/** Mastra -> engine -> Mastra. */
const mastraRoundTrip = (r: StoredStepResult): unknown => {
  const record = fromMastraStepResult(r);
  if (record === undefined) throw new Error(`no record for status '${r.status}'`);
  return toMastraStepResult(record);
};

/** engine -> Mastra -> engine, without `host`. */
const engineRoundTrip = (rec: StepRecord): unknown => {
  const back = fromMastraStepResult(toMastraStepResult(rec) as StoredStepResult);
  if (back === undefined) throw new Error(`no record back for status '${rec.status}'`);
  const { host: _host, ...rest } = back as StepRecord & { host?: unknown };
  return rest;
};

const error = new Error('boom');

/** One Mastra `stepResults` entry per status, with the fields the engine does not model. */
const MASTRA: Record<string, StoredStepResult> = {
  success: { status: 'success', payload: { n: 1 }, output: { m: 2 }, startedAt: T0, endedAt: T0 + 5 },
  'success, resumed, in a loop, a nested run': {
    status: 'success',
    payload: { n: 1 },
    output: 3,
    startedAt: T0,
    endedAt: T0 + 9,
    resumePayload: { ok: true },
    resumedAt: T0 + 7,
    metadata: { iterationCount: 2, nestedRunId: 'child-1', author: 'x' },
  },
  bailed: { status: 'bailed', payload: 1, output: 'early', startedAt: T0, endedAt: T0 + 1 },
  failed: { status: 'failed', payload: 1, error, startedAt: T0, endedAt: T0 + 2, tripwire: undefined },
  'failed, nonRetryable, a tripwire': {
    status: 'failed',
    payload: 1,
    error,
    startedAt: T0,
    endedAt: T0 + 2,
    tripwire: { reason: 'pii', retry: false, metadata: { f: 1 }, processorId: 'p' },
    nonRetryable: true,
  },
  'failed .foreach() aggregate, its foreachOutput and labels (control-flow.ts:1355-1370)': {
    status: 'failed',
    payload: 2,
    error,
    startedAt: T0,
    endedAt: T0 + 2,
    tripwire: undefined,
    suspendPayload: {
      __workflow_meta: {
        foreachOutput: [{ status: 'success', output: 1, payload: 1, startedAt: T0, endedAt: T0 + 1, suspendPayload: {} }],
        resumeLabels: {},
      },
    },
  },
  'failed, through storage': {
    status: 'failed',
    payload: 1,
    error: { name: 'Error', message: 'boom', stack: 'Error: boom\n    at x' },
    startedAt: T0,
    endedAt: T0 + 2,
    tripwire: undefined,
  },
  suspended: { status: 'suspended', payload: 1, suspendPayload: { ask: 'why' }, startedAt: T0, suspendedAt: T0 + 3 },
  'suspended, with an output and a nested meta, after a resume': {
    status: 'suspended',
    payload: 1,
    suspendPayload: { ask: 'again', __workflow_meta: { runId: 'r', path: ['inner'] } },
    suspendOutput: { partial: true },
    startedAt: T0,
    suspendedAt: T0 + 8,
    resumePayload: 'first',
    resumedAt: T0 + 6,
  },
  paused: { status: 'paused', payload: 1, startedAt: T0 },
  waiting: { status: 'waiting', payload: 1, startedAt: T0 },
  'canceled (a loop: bare)': { status: 'canceled' },
  'canceled (a foreach: partial output)': { status: 'canceled', payload: [1, 2], startedAt: T0, output: [10, null], endedAt: T0 + 4 },
};

/** One engine record per status the engine produces. */
const ENGINE: Record<string, StepRecord> = {
  success: { status: 'success', output: { m: 2 }, payload: { n: 1 }, startedAt: T0, endedAt: T0 + 5 },
  'success in a loop': { status: 'success', output: 1, payload: 0, startedAt: T0, endedAt: T0 + 5, metadata: { iterationCount: 3 } },
  bailed: { status: 'bailed', output: 'early', payload: 1, startedAt: T0, endedAt: T0 + 1 },
  failed: { status: 'failed', error, payload: 1, startedAt: T0, endedAt: T0 + 2 },
  'failed, nonRetryable, a tripwire': {
    status: 'failed',
    error,
    tripwire: { reason: 'pii', processorId: 'p' },
    nonRetryable: true,
    payload: 1,
    startedAt: T0,
    endedAt: T0 + 2,
  },
  'failed .foreach() aggregate': {
    status: 'failed',
    error,
    payload: 2,
    startedAt: T0,
    endedAt: T0 + 2,
    suspendPayload: { __workflow_meta: { foreachOutput: [null, { status: 'failed', error: 'x', payload: 2, suspendPayload: {} }] } },
  },
  suspended: { status: 'suspended', suspendPayload: { ask: 1 }, payload: 1, startedAt: T0, suspendedAt: T0 + 3 },
  'suspended with an output': { status: 'suspended', suspendPayload: { ask: 1 }, suspendOutput: 'so far', payload: 1, startedAt: T0, suspendedAt: T0 + 3 },
  paused: { status: 'paused', payload: 1, startedAt: T0 },
  waiting: { status: 'waiting', payload: 1, startedAt: T0 },
  'canceled (bare)': { status: 'canceled' },
  'canceled (partial output)': { status: 'canceled', output: [1], payload: [1, 2], startedAt: T0, endedAt: T0 + 1 },
};

describe('Mastra -> engine -> Mastra is the identity', () => {
  for (const [name, r] of Object.entries(MASTRA)) {
    it(name, () => {
      expect(mastraRoundTrip(r)).toStrictEqual(r);
    });
  }

  it('the error of a live failure is the same object, not a copy', () => {
    expect((mastraRoundTrip(MASTRA['failed']!) as { error: unknown }).error).toBe(error);
  });

  it('a stored failure keeps its serialised error as it was stored, not rebuilt as an Error', () => {
    const back = mastraRoundTrip(MASTRA['failed, through storage']!) as { error: unknown };
    expect(back.error).not.toBeInstanceOf(Error);
    expect(back.error).toBe((MASTRA['failed, through storage'] as { error: unknown }).error);
  });

  it('a failure stored through JSON gets its tripwire key back, and nothing else changes', () => {
    const { tripwire: _dropped, ...stored } = MASTRA['failed, through storage'] as unknown as Record<string, unknown>;
    expect(Object.hasOwn(stored, 'tripwire')).toBe(false);
    expect(mastraRoundTrip(stored as unknown as StoredStepResult)).toStrictEqual({ ...stored, tripwire: undefined });
  });

  it('running and skipped have no record, so they have no round trip', () => {
    expect(fromMastraStepResult({ status: 'running', payload: 1, startedAt: T0 })).toBeUndefined();
    expect(fromMastraStepResult({ status: 'skipped', payload: 1, startedAt: T0, endedAt: T0 })).toBeUndefined();
  });
});

describe('engine -> Mastra -> engine is the identity on every field but host', () => {
  for (const [name, rec] of Object.entries(ENGINE)) {
    it(name, () => {
      const { host: _host, ...own } = rec as StepRecord & { host?: unknown };
      expect(engineRoundTrip(rec)).toStrictEqual(own);
      // And the Mastra side is stable: once through is the same as twice through.
      const once = toMastraStepResult(rec);
      expect(toMastraStepResult(fromMastraStepResult(once as StoredStepResult)!)).toStrictEqual(once);
    });
  }

  it('a record carrying a host keeps the fields only the host has', () => {
    const host = { status: 'success', payload: 0, output: 0, startedAt: T0, endedAt: T0, resumePayload: 'go', resumedAt: T0 + 1 };
    const rec: StepRecord = { status: 'success', output: 7, payload: 0, startedAt: T0, endedAt: T0 + 2, host };
    const mastra = toMastraStepResult(rec);
    expect(mastra).toStrictEqual({ status: 'success', output: 7, payload: 0, startedAt: T0, endedAt: T0 + 2, resumePayload: 'go', resumedAt: T0 + 1 });
    expect(engineRoundTrip(rec)).toStrictEqual({ status: 'success', output: 7, payload: 0, startedAt: T0, endedAt: T0 + 2 });
  });

  it('NOT INVERTED, by design: metadata.foreachIndex, which Mastra never puts in stepResults', () => {
    const rec: StepRecord = { status: 'success', output: 1, payload: 1, startedAt: T0, endedAt: T0, metadata: { foreachIndex: 2 } };
    expect(toMastraStepResult(rec)).not.toHaveProperty('metadata');
    expect(engineRoundTrip(rec)).toStrictEqual({ status: 'success', output: 1, payload: 1, startedAt: T0, endedAt: T0 });
  });

  it("NOT INVERTED, by design: a thrown value that is not an Error comes back as Mastra's normalised Error", () => {
    const rec: StepRecord = { status: 'failed', error: 'plain string', payload: 1, startedAt: T0, endedAt: T0 };
    const back = engineRoundTrip(rec) as { error: unknown };
    expect(back.error).toBeInstanceOf(Error);
    expect((back.error as Error).message).toBe('plain string');
  });
});

describe("the records Mastra's default engine actually stores", () => {
  const step = (id: string, fn: (ctx: any) => unknown) =>
    createStep({ id, inputSchema: z.any(), outputSchema: z.any(), execute: async (ctx: unknown) => fn(ctx) } as never);

  /** Every step record of the run's last snapshot, as the store hands it back. */
  async function stored(build: (w: any) => any, drive: (run: any) => Promise<unknown>): Promise<StoredStepResult[]> {
    const storage = new InMemoryStore();
    const w = build(createWorkflow({ id: 'rt', inputSchema: z.any(), outputSchema: z.any() } as never)).commit();
    new Mastra({ storage, workflows: { rt: w }, logger: false });
    const run = await w.createRun();
    await drive(run);
    const store = await storage.getStore('workflows');
    const snapshot = await store!.loadWorkflowSnapshot({ workflowName: 'rt', runId: run.runId });
    const { input: _input, ...context } = (snapshot as { context: Record<string, StoredStepResult> }).context;
    return Object.values(context);
  }

  it('success, bailed, failed, suspended, a loop body and a resumed step: live and through JSON', async () => {
    const records: StoredStepResult[] = [
      ...(await stored((w) => w.then(step('a', () => 1)).then(step('b', ({ bail }) => bail('out'))), (r) => r.start({ inputData: 0 }))),
      ...(await stored((w) => w.then(step('c', () => { throw new Error('no'); })), (r) => r.start({ inputData: 0 }))),
      ...(await stored((w) => w.then(step('d', ({ suspend }) => suspend({ q: 1 }))), (r) => r.start({ inputData: 0 }))),
      ...(await stored(
        (w) => w.dowhile(step('e', ({ inputData }) => inputData + 1), async ({ inputData }: any) => inputData < 3),
        (r) => r.start({ inputData: 0 }),
      )),
      ...(await stored(
        (w) => w.then(step('f', async ({ resumeData, suspend }) => (resumeData ? { got: resumeData } : suspend({ ask: 1 })))),
        async (r) => {
          await r.start({ inputData: 0 });
          await r.resume({ step: 'f', resumeData: { yes: true } });
        },
      )),
    ];
    const statuses = records.map((r) => r.status).sort();
    // A top-level bail is rewritten to success in place (default.ts:926-928).
    expect(statuses).toEqual(['failed', 'success', 'success', 'success', 'success', 'suspended']);
    const resumed = records.find((r) => 'resumePayload' in r);
    expect(resumed).toMatchObject({ status: 'success', resumePayload: { yes: true }, output: { got: { yes: true } } });
    expect(resumed).toHaveProperty('resumedAt');
    for (const r of records) {
      expect(mastraRoundTrip(r), r.status).toStrictEqual(r);
      const json = JSON.parse(JSON.stringify(r)) as StoredStepResult;
      const restored = json.status === 'failed' ? { ...json, tripwire: undefined } : json;
      expect(mastraRoundTrip(json), `${r.status} through JSON`).toStrictEqual(restored);
    }
  });

  it('a failed and a suspended .foreach() aggregate keep their __workflow_meta: live and through JSON', async () => {
    const records: StoredStepResult[] = [
      ...(await stored(
        (w) => w.foreach(step('g', ({ inputData }) => { if (inputData === 2) throw new Error('two'); return inputData; })),
        (r) => r.start({ inputData: [1, 2, 3] }),
      )),
      ...(await stored(
        (w) => w.foreach(step('h', ({ inputData, suspend }) => (inputData === 2 ? suspend({ at: 2 }, { resumeLabel: 'L' }) : inputData))),
        (r) => r.start({ inputData: [1, 2, 3] }),
      )),
    ];
    expect(records.map((r) => r.status)).toEqual(['failed', 'suspended']);
    for (const r of records) {
      const meta = (r as { suspendPayload?: { __workflow_meta?: Record<string, unknown> } }).suspendPayload?.__workflow_meta;
      expect(meta, r.status).toHaveProperty('foreachOutput');
      expect(meta, r.status).toHaveProperty('resumeLabels');
      expect(mastraRoundTrip(r), r.status).toStrictEqual(r);
      const json = JSON.parse(JSON.stringify(r)) as StoredStepResult;
      const restored = json.status === 'failed' ? { ...json, tripwire: undefined } : json;
      expect(mastraRoundTrip(json), `${r.status} through JSON`).toStrictEqual(restored);
    }
  });
});

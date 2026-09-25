import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createStep, createWorkflow, type ExecutionGraph } from '@mastra/core/workflows';
import { RequestContext } from '@mastra/core/di';
import { Mastra } from '@mastra/core/mastra';
import { EventEmitterPubSub } from '@mastra/core/events';
import { InMemoryStore } from '@mastra/core/storage';
import { StepExecutor } from '@mastra/core/workflows/evented';
import { MastraStepRunner, type MastraStepRunnerOptions } from '../../src/mastra/runner.js';
import { fromMastraStepResult, toMastraStepResult } from '../../src/mastra/step-result.js';
import type { StoredStepResult } from '../../src/mastra/host.js';
import { UnresumablePositionError } from '../../src/compiler/resume.js';
import { HostPreconditionError } from '../../src/compiler/gadgets/leaf.js';
import { PetriExecutionEngine } from '../../src/mastra/engine.js';
import type { StepCall, StepRecord } from '../../src/compiler/types.js';

/**
 * `MastraStepRunner` on a resumed segment (contract C18, ADR 0007), called directly: the engine's
 * resume path is another area's, and what is under test here is what one attempt is handed and
 * what it reports. Where the default engine is the oracle, it runs the same workflow through
 * Mastra's own `Run.start()` / `Run.resume()` with a store, and the runner is fed the records that
 * store holds.
 */

type Wf = any;
type Ctx = Record<string, any>;
const NOW = 1_800_000_000_000;

const wf = (id = 'w'): Wf => createWorkflow({ id, inputSchema: z.any(), outputSchema: z.any() } as never);
const step = (id: string, fn: (ctx: Ctx) => unknown) =>
  createStep({ id, inputSchema: z.any(), outputSchema: z.any(), execute: async (ctx: unknown) => fn(ctx as Ctx) } as never);

/** A runner over a committed workflow's own graph, as the engine builds it. */
function direct(w: Wf, extra: Partial<MastraStepRunnerOptions> = {}): MastraStepRunner {
  const graph = w.buildExecutionGraph() as ExecutionGraph;
  return new MastraStepRunner({
    executor: new StepExecutor({ mastra: { pubsub: new EventEmitterPubSub() } as never }),
    graph,
    workflowId: graph.id,
    runId: 'run-1',
    requestContext: new RequestContext(),
    abortController: new AbortController(),
    initialState: {},
    validateInputs: true,
    resourceId: undefined,
    mastra: undefined,
    now: () => NOW,
    ...extra,
  });
}

/** A call over a store holding `records`. */
const call = (path: readonly number[], records: ReadonlyMap<string, StepRecord>, extra: Partial<StepCall> = {}): StepCall => ({
  path,
  initData: 0,
  getStepResult: (id) => records.get(id),
  abortSignal: new AbortController().signal,
  source: 'step',
  attempt: 0,
  ...extra,
});

const recordsOf = (context: Record<string, unknown>): Map<string, StepRecord> => {
  const out = new Map<string, StepRecord>();
  for (const [id, r] of Object.entries(context)) {
    if (id === 'input') continue;
    const rec = fromMastraStepResult(r as StoredStepResult);
    if (rec !== undefined) out.set(id, rec);
  }
  return out;
};

/** The rejection of `promise`, or a failure when it resolves. */
async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => {
      throw new Error(`expected a rejection, got ${JSON.stringify(value)}`);
    },
    (error: unknown) => error,
  );
}

async function snapshotOf(storage: InMemoryStore, workflowName: string, runId: string): Promise<{ context: Record<string, unknown> }> {
  const store = await storage.getStore('workflows');
  const snap = await store!.loadWorkflowSnapshot({ workflowName, runId });
  if (!snap) throw new Error(`no snapshot for ${workflowName}/${runId}`);
  return snap as unknown as { context: Record<string, unknown> };
}

/**
 * The default engine suspends step `f` once and resumes it with `resumeData`: what `f` saw on the
 * resume, the stored suspended record, and the record the resume wrote.
 */
async function oracle(resumeData: unknown, suspendWith: unknown = { ask: 1 }) {
  const seen: Ctx[] = [];
  const storage = new InMemoryStore();
  const w = wf('o')
    .then(
      step('f', async (ctx) => {
        if (ctx['retryCount'] === 0 && seen.length === 0) {
          seen.push({ phase: 'start' });
          return ctx['suspend'](suspendWith);
        }
        seen.push({ resumeData: ctx['resumeData'], suspendData: ctx['suspendData'], resume: ctx['resume'], inputData: ctx['inputData'] });
        return { got: ctx['resumeData'] };
      }),
    )
    .commit();
  new Mastra({ storage, workflows: { o: w }, logger: false });
  const run = await w.createRun();
  await run.start({ inputData: { n: 1 } });
  const suspended = (await snapshotOf(storage, 'o', run.runId)).context;
  await run.resume({ step: 'f', resumeData });
  const after = (await snapshotOf(storage, 'o', run.runId)).context;
  return { saw: seen[1]!, suspended, after };
}

/** What the runner hands `f` and reports, resumed from the oracle's stored records. */
async function runnerSide(resumeData: unknown, suspended: Record<string, unknown>) {
  const seen: Ctx[] = [];
  const w = wf('o')
    .then(step('f', async (ctx) => {
      seen.push({ resumeData: ctx['resumeData'], suspendData: ctx['suspendData'], resume: ctx['resume'], inputData: ctx['inputData'] });
      return { got: ctx['resumeData'] };
    }))
    .commit();
  const records = recordsOf(suspended);
  const runner = direct(w, { resume: { payload: resumeData, steps: ['f'], records } });
  const prior = records.get('f') as StepRecord & { payload: unknown };
  const outcome = await runner.run('f', prior.payload, call([0], records, { resumed: true }));
  return { saw: seen[0]!, outcome, prior };
}

describe("a resumed step is handed what the default engine hands it (handlers/step.ts:132-175,423-435)", () => {
  it('resumeData, suspendData without __workflow_meta, the resume context and the stored input', async () => {
    const o = await oracle({ yes: true });
    const r = await runnerSide({ yes: true }, o.suspended);
    expect(o.saw).toMatchObject({ resumeData: { yes: true }, suspendData: { ask: 1 }, inputData: { n: 1 } });
    expect(r.saw).toStrictEqual(o.saw);
    expect(r.outcome).toMatchObject({ status: 'success', output: { got: { yes: true } } });
  });

  it("the record: the prior payload, resumePayload, and resumedAt on the run's clock", async () => {
    const o = await oracle({ yes: true });
    const r = await runnerSide({ yes: true }, o.suspended);
    const host = r.outcome.host as Record<string, unknown>;
    expect(host).toMatchObject({ resumePayload: { yes: true }, resumedAt: NOW });
    // Reported to the leaf too: this attempt is recorded as resumed, so it keeps the stored start.
    expect(r.outcome.resumedAt).toBe(NOW);
    expect(r.outcome.payload).toStrictEqual(r.prior.payload);
    // Record it as the leaf does on a resumed attempt (the prior startedAt kept), then compare the
    // Mastra record with the one the default engine wrote, clock fields aside.
    const rec: StepRecord = {
      status: 'success',
      output: (r.outcome as { output: unknown }).output,
      payload: r.outcome.payload,
      startedAt: r.prior.startedAt!,
      endedAt: NOW + 1,
      host,
    };
    const mask = (x: unknown) => JSON.parse(JSON.stringify(x, (k, v: unknown) => (k === 'endedAt' || k === 'resumedAt' ? '<t>' : v))) as unknown;
    expect(mask(toMastraStepResult(rec))).toStrictEqual(mask(o.after['f']));
  });

  for (const falsy of [0, '', false, null, undefined]) {
    it(`falsy resumeData ${JSON.stringify(falsy) ?? 'undefined'}: it reaches the step, and the record is a fresh start`, async () => {
      const o = await oracle(falsy);
      const r = await runnerSide(falsy, o.suspended);
      expect(o.saw['resumeData']).toBe(falsy);
      expect(r.saw).toStrictEqual(o.saw);
      // The default engine's record: no resumePayload, no resumedAt (handlers/step.ts:166-175).
      expect(o.after['f']).not.toHaveProperty('resumePayload');
      expect(o.after['f']).not.toHaveProperty('resumedAt');
      const host = r.outcome.host as Record<string, unknown>;
      expect(host).not.toHaveProperty('resumePayload');
      expect(host).not.toHaveProperty('resumedAt');
      // Not reported to the leaf either: it stamps a fresh start (row 82).
      expect(r.outcome).not.toHaveProperty('resumedAt');
      expect(r.outcome.payload).toStrictEqual({ n: 1 });
    });
  }

  it("a truthy primitive suspend payload: the resume rejects with the default engine's own TypeError", async () => {
    // handlers/step.ts:160 — `'__workflow_meta' in suspendDataToUse` on a string.
    const o = oracle('go', 'why?');
    await expect(o).rejects.toThrow(TypeError);
    const message = await o.then(() => '', (e: Error) => e.message);
    expect(message).toMatch(/Cannot use 'in' operator to search for '__workflow_meta' in why\?/);
    const records = new Map<string, StepRecord>([['f', { status: 'suspended', suspendPayload: 'why?', payload: 'in', startedAt: 1, suspendedAt: 2 }]]);
    const w = wf().then(step('f', () => 'never')).commit();
    // The runner marks it as the host's precondition, the default engine's own TypeError as the cause.
    const error = await caught(direct(w, { resume: { payload: 'go', steps: ['f'], records } }).run('f', 'in', call([0], records, { resumed: true })));
    expect(error).toBeInstanceOf(HostPreconditionError);
    expect(error).toMatchObject({ stepId: 'f', path: [0] });
    const cause = (error as HostPreconditionError).cause;
    expect(cause).toBeInstanceOf(TypeError);
    expect((cause as Error).message).toBe(message);
    expect((error as Error).message).toBe(`the host refused step 'f' at [0] before it ran: ${message}`);
  });
});

describe('position-exact: only the call the net marks resumed is fed (maintainer decision 4)', () => {
  const records = new Map<string, StepRecord>([['f', { status: 'suspended', suspendPayload: { ask: 1 }, payload: 'in', startedAt: 1, suspendedAt: 2 }]]);
  const capture = () => {
    const seen: Ctx[] = [];
    const w = wf().then(step('f', (ctx) => void seen.push({ resumeData: ctx['resumeData'], suspendData: ctx['suspendData'], resume: ctx['resume'] }))).commit();
    return { seen, w };
  };

  it('an unmarked call of the same id gets no resumeData, an empty resume, and is recorded fresh', async () => {
    const { seen, w } = capture();
    const outcome = await direct(w, { resume: { payload: 'go', steps: ['f'], records } }).run('f', 'in', call([0], records));
    // suspendData is Mastra's rule on every call: the prior record is suspended.
    expect(seen[0]).toStrictEqual({
      resumeData: undefined,
      suspendData: { ask: 1 },
      resume: { steps: [], resumePayload: undefined, runId: undefined, label: undefined, forEachIndex: undefined },
    });
    expect(outcome.host).not.toHaveProperty('resumePayload');
    expect(outcome.host).not.toHaveProperty('resumedAt');
    expect(outcome).not.toHaveProperty('resumedAt');
  });

  it("a call whose prior record is not suspended gets no resume at all", async () => {
    const { seen, w } = capture();
    await direct(w).run('f', 'in', call([0], new Map()));
    expect(seen[0]).toStrictEqual({ resumeData: undefined, suspendData: undefined, resume: undefined });
  });

  it('a resumed call on a runner given no resume is refused, not run with nothing', async () => {
    const { seen, w } = capture();
    const error = await caught(direct(w).run('f', 'in', call([0], records, { resumed: true })));
    expect(error).toBeInstanceOf(HostPreconditionError);
    expect(error).toMatchObject({ stepId: 'f', path: [0] });
    expect(((error as HostPreconditionError).cause as Error).message).toBe(
      "step 'f' at path 0 is a resumed call, but this run was given no resume",
    );
    expect(seen).toEqual([]);
  });

  it('a retry of the resumed attempt is fed again, as executeStepWithRetry re-calls with the same params', async () => {
    const seen: unknown[] = [];
    const w = wf().then(step('f', (ctx) => {
      seen.push(ctx['resumeData']);
      if (ctx['retryCount'] === 0) throw new Error('once');
      return 'ok';
    })).commit();
    const runner = direct(w, { resume: { payload: 'go', steps: ['f'], records } });
    expect((await runner.run('f', 'in', call([0], records, { resumed: true, attempt: 0 }))).status).toBe('failed');
    expect(await runner.run('f', 'in', call([0], records, { resumed: true, attempt: 1 }))).toMatchObject({ status: 'success', host: { resumePayload: 'go', resumedAt: NOW } });
    expect(seen).toEqual(['go', 'go']);
  });

  it('suspending again: the new suspension is recorded bare, with this resume on the record', async () => {
    const w = wf().then(step('f', (ctx) => ctx['suspend']({ ask: 2 }))).commit();
    const outcome = await direct(w, { resume: { payload: 'go', steps: ['f'], records } }).run('f', 'in', call([0], records, { resumed: true }));
    expect(outcome).toMatchObject({ status: 'suspended', suspendPayload: { ask: 2 }, payload: 'in', host: { resumePayload: 'go', resumedAt: NOW } });
  });
});

describe('a .foreach() item (handlers/step.ts:145-164; control-flow.ts:1101-1104)', () => {
  const aggregate: StepRecord = {
    status: 'suspended',
    payload: ['a', 'b', 'c', 'd'],
    startedAt: 1,
    suspendedAt: 2,
    suspendPayload: {
      first: true,
      __workflow_meta: {
        foreachIndex: 1,
        foreachOutput: [
          { status: 'success', output: 'A', payload: 'a', startedAt: 1, endedAt: 1 },
          { status: 'suspended', suspendPayload: { own: 1 }, payload: 'b', startedAt: 1, suspendedAt: 2 },
          { status: 'suspended', suspendPayload: { own: 2 }, payload: 'c', startedAt: 1, suspendedAt: 2 },
        ],
        resumeLabels: {
          la: { stepId: 'f', foreachIndex: 0 },
          lb: { stepId: 'f', foreachIndex: 1 },
          lc: { stepId: 'f', foreachIndex: 2 },
          // Another step's label at an index that did not succeed: only the stepId filter drops it.
          other: { stepId: 'g', foreachIndex: 2 },
        },
      },
    },
  };
  const carried = new Map<string, StepRecord>([['f', aggregate]]);
  const seen: Ctx[] = [];
  const w = wf().foreach(step('f', (ctx) => void seen.push({ i: ctx['inputData'], resumeData: ctx['resumeData'], suspendData: ctx['suspendData'] }))).commit();

  it("items that start together read the aggregate: each its own suspendData, a never-started one the aggregate's", async () => {
    seen.length = 0;
    // Three items dispatched before any completes (concurrency 3): each reads `stepResults[f]` as
    // the foreach was entered, the aggregate (control-flow.ts:1101-1104, handlers/step.ts:145-164).
    const live = new Map(carried);
    const runner = direct(w, { resume: { payload: 'go', steps: ['f'], records: carried, forEachIndex: 1 } });
    const pending = [
      runner.run('f', 'b', call([0], live, { foreachIndex: 1, resumed: true })),
      runner.run('f', 'c', call([0], live, { foreachIndex: 2 })),
      runner.run('f', 'd', call([0], live, { foreachIndex: 3 })),
    ];
    const [resumed] = await Promise.all(pending);
    // The resumed item's record starts from the aggregate, so its payload is the aggregate's
    // (handlers/step.ts:169-171).
    expect(resumed).toMatchObject({ payload: ['a', 'b', 'c', 'd'], host: { resumePayload: 'go', resumedAt: NOW } });
    expect(seen).toStrictEqual([
      { i: 'b', resumeData: 'go', suspendData: { own: 1 } },
      { i: 'c', resumeData: undefined, suspendData: { own: 2 } },
      { i: 'd', resumeData: undefined, suspendData: { first: true } },
    ]);
  });

  it('an item that starts after a sibling completed reads that sibling\'s record (control-flow.ts:1179)', async () => {
    seen.length = 0;
    const live = new Map(carried);
    const runner = direct(w, { resume: { payload: 'go', steps: ['f'], records: carried, forEachIndex: 1 } });
    await runner.run('f', 'b', call([0], live, { foreachIndex: 1, resumed: true }));
    // What the leaf writes when item 1 completes: its own success record under the body id.
    live.set('f', { status: 'success', output: undefined, payload: ['a', 'b', 'c', 'd'], startedAt: 1, endedAt: 3, metadata: { foreachIndex: 1 } });
    await runner.run('f', 'c', call([0], live, { foreachIndex: 2 }));
    expect(seen).toStrictEqual([
      { i: 'b', resumeData: 'go', suspendData: { own: 1 } },
      { i: 'c', resumeData: undefined, suspendData: undefined },
    ]);
  });

  it('every retry of an item reads what its first attempt read, whatever completed in between', async () => {
    const got: unknown[] = [];
    const w3 = wf().foreach(step('f', (ctx) => {
      got.push(ctx['suspendData']);
      if (ctx['retryCount'] === 0) throw new Error('once');
      return 'ok';
    })).commit();
    const live = new Map(carried);
    const runner = direct(w3, { resume: { payload: 'go', steps: ['f'], records: carried, forEachIndex: 1 } });
    expect((await runner.run('f', 'c', call([0], live, { foreachIndex: 2, attempt: 0 }))).status).toBe('failed');
    live.set('f', { status: 'success', output: 'B', payload: 'b', startedAt: 1, endedAt: 3, metadata: { foreachIndex: 1 } });
    expect((await runner.run('f', 'c', call([0], live, { foreachIndex: 2, attempt: 1 }))).status).toBe('success');
    // A later item's first attempt reads the store afresh.
    await runner.run('f', 'd', call([0], live, { foreachIndex: 3, attempt: 0 }));
    expect(got).toStrictEqual([{ own: 2 }, { own: 2 }, undefined]);
  });

  it("a sibling's suspension from this segment is never read: the item reads what the id held as the segment began", async () => {
    seen.length = 0;
    // Only an item held by a run budget can run after a sibling suspended (ADR 0006): Mastra kills
    // the queue on a suspension, so the item was dispatched before it.
    const sibling: StepRecord = { status: 'suspended', suspendPayload: { sibling: true }, payload: 'a', startedAt: 1, suspendedAt: 1, metadata: { foreachIndex: 0 } };
    await direct(w).run('f', 'b', call([0], new Map([['f', sibling]]), { foreachIndex: 1 }));
    const runner = direct(w, { resume: { payload: 'go', steps: ['f'], records: carried, forEachIndex: 1 } });
    await runner.run('f', 'c', call([0], new Map([['f', sibling]]), { foreachIndex: 2 }));
    expect(seen).toStrictEqual([
      { i: 'b', resumeData: undefined, suspendData: undefined },
      { i: 'c', resumeData: undefined, suspendData: { own: 2 } },
    ]);
  });

  it.each([
    ['failed', { status: 'failed', error: new Error('x'), payload: 'a', startedAt: 1, endedAt: 2, metadata: { foreachIndex: 1 } }],
    ['bailed', { status: 'bailed', output: 'B', payload: 'a', startedAt: 1, endedAt: 2, metadata: { foreachIndex: 1 } }],
  ] as const)("a sibling's %s result from this segment is never read either (control-flow.ts:1117-1142 kills the queue)", async (_status, record) => {
    seen.length = 0;
    const runner = direct(w, { resume: { payload: 'go', steps: ['f'], records: carried, forEachIndex: 1 } });
    await runner.run('f', 'c', call([0], new Map<string, StepRecord>([['f', record as StepRecord]]), { foreachIndex: 2 }));
    expect(seen).toStrictEqual([{ i: 'c', resumeData: undefined, suspendData: { own: 2 } }]);
  });

  it('a fresh run: an item that starts after a sibling succeeded gets no suspend data and no resume', async () => {
    seen.length = 0;
    const live = new Map<string, StepRecord>([['f', { status: 'success', output: 'A', payload: 'a', startedAt: 1, endedAt: 1, metadata: { foreachIndex: 0 } }]]);
    await direct(w).run('f', 'b', call([0], live, { foreachIndex: 1 }));
    expect(seen).toStrictEqual([{ i: 'b', resumeData: undefined, suspendData: undefined }]);
  });

  it("carried labels: less the items that succeeded before and in this segment, merged only while the foreach is suspended", async () => {
    const live = new Map<string, StepRecord>();
    const runner = direct(w, { resume: { payload: 'go', steps: ['f'], records: carried, forEachIndex: 1 } });
    // Per execute, a run starts with no labels of its own (default.ts:878-891).
    expect(runner.resumeLabels).toStrictEqual({});
    await runner.run('f', 'b', call([0], live, { foreachIndex: 1, resumed: true }));
    // The foreach has not ended suspended (no aggregate in the store): nothing carried yet.
    expect(runner.resumeLabels).toStrictEqual({});
    live.set('f', { ...aggregate });
    expect(runner.resumeLabels).toStrictEqual({ lc: { stepId: 'f', foreachIndex: 2 } });
    live.set('f', { status: 'failed', error: new Error('x'), payload: [], startedAt: 1, endedAt: 1 });
    expect(runner.resumeLabels).toStrictEqual({});
  });

  it("this segment's own label wins over a carried one of the same name", async () => {
    const w2 = wf().foreach(step('f', (ctx) => ctx['suspend']({ again: true }, { resumeLabel: 'lc' }))).commit();
    const live = new Map<string, StepRecord>();
    // Item 3 suspends under 'lc'; the carried 'lc' names item 2. The two differ, so the merge
    // order is visible: the segment's own label is written last (control-flow.ts:1433).
    const runner = direct(w2, { resume: { payload: 'go', steps: ['f'], records: carried, forEachIndex: 3 } });
    await runner.run('f', 'd', call([0], live, { foreachIndex: 3, resumed: true }));
    live.set('f', { ...aggregate });
    expect(runner.resumeLabels).toStrictEqual({ lb: { stepId: 'f', foreachIndex: 1 }, lc: { stepId: 'f', foreachIndex: 3 } });
  });
});

/**
 * The default engine on `.foreach(f)` over [0, 1, 2, 3], concurrency 1: item 1 suspends with
 * `{ ask: 1 }` under label `L1`, and the run is resumed with `forEachIndex: 1`. What each item saw
 * on the resume, and the stored snapshot the resume started from.
 */
async function foreachOracle(engine: 'default' | 'petri' = 'default') {
  const seen: Ctx[] = [];
  let phase = 0;
  const storage = new InMemoryStore();
  const w = (createWorkflow({
    id: 'fe',
    inputSchema: z.any(),
    outputSchema: z.any(),
    ...(engine === 'petri' ? { executionEngine: new PetriExecutionEngine() } : {}),
  } as never) as Wf)
    .foreach(
      step('f', async (ctx) => {
        seen.push({ phase, i: ctx['inputData'], resumeData: ctx['resumeData'], suspendData: ctx['suspendData'] });
        if (phase === 0 && ctx['inputData'] === 1) return ctx['suspend']({ ask: 1 }, { resumeLabel: 'L1' });
        return { i: ctx['inputData'] };
      }),
      { concurrency: 1 },
    )
    .commit();
  new Mastra({ storage, workflows: { fe: w }, logger: false });
  const run = await w.createRun();
  const first = await run.start({ inputData: [0, 1, 2, 3] });
  const suspended = (await snapshotOf(storage, 'fe', run.runId)).context;
  phase = 1;
  const resumed = await run.resume({ step: 'f', resumeData: { go: 1 }, forEachIndex: 1 });
  const after = (await snapshotOf(storage, 'fe', run.runId)).context;
  return { first: first.status as string, resumed: resumed.status as string, seen, suspended, after };
}

describe('a .foreach() item reads the record of the last item that completed before it started (control-flow.ts:1179)', () => {
  it('oracle [0..3], concurrency 1, item 1 resumed: items 2 and 3 get no suspend data; the runner matches', async () => {
    const o = await foreachOracle();
    expect(o.first).toBe('suspended');
    expect(o.resumed).toBe('success');
    const resumePhase = o.seen.filter((x) => x['phase'] === 1).map(({ phase: _p, ...rest }) => rest);
    expect(resumePhase).toStrictEqual([
      { i: 1, resumeData: { go: 1 }, suspendData: { ask: 1 } },
      { i: 2, resumeData: undefined, suspendData: undefined },
      { i: 3, resumeData: undefined, suspendData: undefined },
    ]);

    // The runner, fed the same stored records, with the store updated as the leaf updates it: each
    // item's record under the body id when the item completes.
    const seen: Ctx[] = [];
    const w = wf('fe').foreach(step('f', async (ctx) => {
      seen.push({ i: ctx['inputData'], resumeData: ctx['resumeData'], suspendData: ctx['suspendData'] });
      return { i: ctx['inputData'] };
    }), { concurrency: 1 }).commit();
    const records = recordsOf(o.suspended);
    const live = new Map(records);
    const runner = direct(w, { resume: { payload: { go: 1 }, steps: ['f'], records, forEachIndex: 1 } });
    for (const k of [1, 2, 3]) {
      const outcome = await runner.run('f', k, call([0], live, { foreachIndex: k, ...(k === 1 ? { resumed: true as const } : {}) }));
      expect(outcome.status).toBe('success');
      live.set('f', { ...(outcome as StepRecord & { status: 'success' }), startedAt: 1, endedAt: 2, metadata: { foreachIndex: k } } as StepRecord);
    }
    expect(seen).toStrictEqual(resumePhase);
  });

  it('end to end on the petri engine: every item is handed what the default engine hands it, on both phases', async () => {
    const o = await foreachOracle('default');
    const p = await foreachOracle('petri');
    expect([p.first, p.resumed]).toStrictEqual([o.first, o.resumed]);
    expect(p.seen).toStrictEqual(o.seen);
    // The resumed aggregate: the stored payload and start kept, this resume's payload and stamp
    // (control-flow.ts:987-996), output in input order.
    const agg = (side: typeof o) => side.after['f'] as Record<string, unknown>;
    for (const side of [o, p]) {
      expect(agg(side)).toMatchObject({ status: 'success', payload: [0, 1, 2, 3], resumePayload: { go: 1 }, output: [{ i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }] });
      expect(agg(side)['startedAt']).toBe((side.suspended['f'] as { startedAt: number }).startedAt);
      expect(typeof agg(side)['resumedAt']).toBe('number');
    }
    const mask = (x: unknown) => JSON.parse(JSON.stringify(x, (k, v: unknown) => (k === 'startedAt' || k === 'endedAt' || k === 'resumedAt' || k === 'suspendedAt' ? '<t>' : v))) as unknown;
    expect(mask(p.suspended)).toStrictEqual(mask(o.suspended));
    expect(mask(p.after)).toStrictEqual(mask(o.after));
  });
});

describe('a nested workflow (handlers/step.ts:423-435; workflow.ts:2951-3031)', () => {
  it("resumes the child's own run from its snapshot, and the inner step is fed", async () => {
    const storage = new InMemoryStore();
    const inner: Ctx[] = [];
    const child = wf('child')
      .then(step('pre', () => 'pre'))
      .then(step('i', async (ctx) => {
        inner.push({ resumeData: ctx['resumeData'], suspendData: ctx['suspendData'] });
        return ctx['resumeData'] ? { done: ctx['resumeData'] } : ctx['suspend']({ need: 'x' });
      }))
      .commit();
    const parent = wf('parent').then(child).commit();
    const mastra = new Mastra({ storage, workflows: { parent, child }, logger: false });
    const run = await parent.createRun();
    const first = await run.start({ inputData: 1 });
    expect(first.status).toBe('suspended');
    const records = recordsOf((await snapshotOf(storage, 'parent', run.runId)).context);
    const stored = records.get('child') as StepRecord & { payload: unknown; suspendPayload: { __workflow_meta: { runId: string } } };
    expect(stored.suspendPayload.__workflow_meta.runId).toBe(run.runId);

    const runner = direct(parent, { mastra, runId: run.runId, resume: { payload: { ok: 1 }, steps: ['child', 'i'], records } });
    const outcome = await runner.run('child', stored.payload, call([0], records, { resumed: true, source: 'workflow' }));
    expect(outcome).toMatchObject({ status: 'success', output: { done: { ok: 1 } }, host: { resumePayload: { ok: 1 }, resumedAt: NOW } });
    // `pre` did not run again: the child resumed at `i`, from its own records.
    expect(inner).toStrictEqual([
      { resumeData: undefined, suspendData: undefined },
      { resumeData: { ok: 1 }, suspendData: { need: 'x' } },
    ]);
  });

  it('inside a .foreach(), a nested workflow with a suspended record is refused by name', async () => {
    const child = wf('child').then(step('i', () => 1)).commit();
    const w = wf().foreach(child).commit();
    const records = new Map<string, StepRecord>([
      ['child', { status: 'suspended', suspendPayload: { __workflow_meta: { runId: 'r', foreachOutput: [] } }, payload: [1], startedAt: 1, suspendedAt: 1 }],
    ]);
    const runner = direct(w, { resume: { payload: 'go', steps: ['child', 'i'], records, forEachIndex: 0 } });
    // The live store holds the stored aggregate as the resumed segment starts.
    const error = await caught(runner.run('child', 1, call([0], records, { foreachIndex: 0, resumed: true, source: 'workflow' })));
    expect(error).toBeInstanceOf(HostPreconditionError);
    const cause = (error as HostPreconditionError).cause;
    expect(cause).toBeInstanceOf(UnresumablePositionError);
    expect(cause).toMatchObject({ reason: 'foreach-nested', path: [0] });
  });
});

/**
 * End to end, both engines through Mastra's own `Run.start()` / `Run.resume()` with a store: the
 * default engine is the oracle, and the petri engine runs the same workflow through the runner and
 * the leaf. Each run gets its own `Mastra` and store.
 */
type EngineName = 'default' | 'petri';

async function endToEnd(engine: EngineName, resumeData: unknown, suspendWith: unknown) {
  const storage = new InMemoryStore();
  const calls: Ctx[] = [];
  const w = createWorkflow({
    id: 'e2e',
    inputSchema: z.any(),
    outputSchema: z.any(),
    ...(engine === 'petri' ? { executionEngine: new PetriExecutionEngine() } : {}),
  } as never) as Wf;
  w.then(
    step('f', async (ctx) => {
      calls.push({ resumeData: ctx['resumeData'], inputData: ctx['inputData'] });
      if (calls.length === 1) return ctx['suspend'](suspendWith);
      return { got: ctx['resumeData'] };
    }),
  ).commit();
  new Mastra({ storage, workflows: { e2e: w }, logger: false });
  const run = await w.createRun();
  const first = await run.start({ inputData: { n: 1 } });
  const suspended = (await snapshotOf(storage, 'e2e', run.runId)).context;
  // Mastra's step start is `Date.now()` taken during resume (handlers/step.ts:166).
  await new Promise((r) => setTimeout(r, 15));
  const before = Date.now();
  const settled = await run.resume({ step: 'f', resumeData }).then(
    (result: { status: string }) => ({ resolved: result.status }),
    (error: unknown) => ({ rejected: error }),
  );
  const after = (await snapshotOf(storage, 'e2e', run.runId)).context;
  return { first: first.status as string, suspended, before, settled, after, calls };
}

describe('host preconditions on resume reject the run, as on the default engine (row 84)', () => {
  const message = "Cannot use 'in' operator to search for '__workflow_meta' in why?";

  it("oracle: the default engine's resume rejects with its own TypeError, and the step never runs", async () => {
    const o = await endToEnd('default', 'go', 'why?');
    expect(o.first).toBe('suspended');
    expect(o.settled).toHaveProperty('rejected');
    const error = (o.settled as { rejected: unknown }).rejected;
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe(message);
    expect(o.calls).toHaveLength(1);
  });

  it('petri: the same resume rejects with the same TypeError, and the step never runs', async () => {
    const p = await endToEnd('petri', 'go', 'why?');
    expect(p.first).toBe('suspended');
    expect(p.suspended['f']).toMatchObject({ status: 'suspended', suspendPayload: 'why?' });
    expect(p.settled).toHaveProperty('rejected');
    const error = (p.settled as { rejected: unknown }).rejected;
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe(message);
    expect(p.calls).toHaveLength(1);
  });
});

describe('host preconditions inside a .foreach() reject the run too (row 84)', () => {
  async function foreachPrimitive(engine: EngineName) {
    const storage = new InMemoryStore();
    const calls: unknown[] = [];
    const w = createWorkflow({
      id: 'fe-prim',
      inputSchema: z.any(),
      outputSchema: z.any(),
      ...(engine === 'petri' ? { executionEngine: new PetriExecutionEngine() } : {}),
    } as never) as Wf;
    w.foreach(
      step('f', async (ctx) => {
        calls.push(ctx['inputData']);
        return ctx['resumeData'] ? 'ok' : ctx['suspend']('why?');
      }),
    ).commit();
    new Mastra({ storage, workflows: { 'fe-prim': w }, logger: false });
    const run = await w.createRun();
    const first = await run.start({ inputData: [1] });
    const settled = await run.resume({ step: 'f', resumeData: 'go', forEachIndex: 0 }).then(
      (result: { status: string; error?: unknown }) => ({ resolved: result.status, error: result.error }),
      (error: unknown) => ({ rejected: error }),
    );
    const after = (await snapshotOf(storage, 'fe-prim', run.runId)).context;
    return { first: first.status as string, settled, calls, after };
  }

  it("an item whose own stored suspend payload is a truthy primitive: the foreach fails with the TypeError — Mastra's worker catches it (control-flow.ts:1200-1217)", async () => {
    const o = await foreachPrimitive('default');
    const p = await foreachPrimitive('petri');
    const message = "Cannot use 'in' operator to search for '__workflow_meta' in why?";
    for (const side of [o, p]) {
      expect(side.first).toBe('suspended');
      expect(side.settled).toStrictEqual({ resolved: 'failed', error: expect.objectContaining({ message }) });
      // The item never ran again, and its entry is the worker's thrownResult: no payload.
      expect(side.calls).toStrictEqual([1]);
      const agg = side.after['f'] as { status: string; payload?: unknown; suspendPayload: { __workflow_meta: { foreachOutput: Record<string, unknown>[] } } };
      expect(agg.status).toBe('failed');
      expect(Object.hasOwn(agg, 'payload') ? agg.payload : 'no key').toBeUndefined();
      const entry = agg.suspendPayload.__workflow_meta.foreachOutput[0]!;
      expect(entry['status']).toBe('failed');
      expect((entry['error'] as Error).message).toBe(message);
      expect(Object.hasOwn(entry, 'payload') && entry['payload'] === undefined).toBe(true);
    }
  });
});

describe("falsy resume data: the record is a fresh start on both engines (handlers/step.ts:166-175, row 82)", () => {
  const mask = (record: unknown) =>
    JSON.parse(JSON.stringify(record, (k, v: unknown) => (k === 'startedAt' || k === 'endedAt' ? '<t>' : v))) as unknown;

  for (const falsy of [0, false, null]) {
    it(`resumeData ${JSON.stringify(falsy)}: a new startedAt, the validated input as payload, no resumePayload or resumedAt`, async () => {
      const o = await endToEnd('default', falsy, { ask: 1 });
      const p = await endToEnd('petri', falsy, { ask: 1 });
      for (const side of [o, p]) {
        const stored = side.suspended['f'] as { startedAt: number };
        const record = side.after['f'] as Record<string, unknown>;
        expect(record).toMatchObject({ status: 'success', payload: { n: 1 }, output: { got: falsy } });
        expect(record).not.toHaveProperty('resumePayload');
        expect(record).not.toHaveProperty('resumedAt');
        expect(record['startedAt']).toBeGreaterThanOrEqual(side.before);
        expect(record['startedAt']).toBeGreaterThan(stored.startedAt);
      }
      expect(mask(p.after['f'])).toStrictEqual(mask(o.after['f']));
    });
  }

  it('truthy resumeData: the stored startedAt is kept, with resumePayload and a new resumedAt', async () => {
    const o = await endToEnd('default', { yes: true }, { ask: 1 });
    const p = await endToEnd('petri', { yes: true }, { ask: 1 });
    for (const side of [o, p]) {
      const stored = side.suspended['f'] as { startedAt: number };
      const record = side.after['f'] as Record<string, unknown>;
      expect(record).toMatchObject({ status: 'success', payload: { n: 1 }, resumePayload: { yes: true }, startedAt: stored.startedAt });
      expect(record['resumedAt']).toBeGreaterThanOrEqual(side.before);
    }
    const maskAll = (record: unknown) =>
      JSON.parse(JSON.stringify(record, (k, v: unknown) => (k === 'startedAt' || k === 'endedAt' || k === 'resumedAt' ? '<t>' : v))) as unknown;
    expect(maskAll(p.after['f'])).toStrictEqual(maskAll(o.after['f']));
  });
});

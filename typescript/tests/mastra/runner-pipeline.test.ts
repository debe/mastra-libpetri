import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createStep, createWorkflow, type ExecutionGraph } from '@mastra/core/workflows';
import { RequestContext } from '@mastra/core/di';
import { EventEmitterPubSub } from '@mastra/core/events';
import { StepExecutor } from '@mastra/core/workflows/evented';
import { MastraStepRunner, type MastraStepRunnerOptions } from '../../src/mastra/runner.js';
import type { StepEvents } from '../../src/mastra/events.js';
import type { StepSpans } from '../../src/mastra/spans.js';
import type { RunView, StepCall, StepRecord } from '../../src/compiler/types.js';

/**
 * `MastraStepRunner` for pipeline stage calls ([ADR 0015], W1 B): a call carrying `pipelineItem`
 * runs as a step of the twin's child run. Pinned here, against the runner alone (the pipeline gadget
 * is W1 A's): the stage is resolved by id inside the foreach's body, and the call's input is the item
 * itself (no `foreachIdx`, no sparse array); no fresh `nestedRunId`, no step start, no span; stage 0
 * validates against the body's input schema before its own, and only stage 0 does; the item's state
 * is a snapshot taken at `openItem`, `setState` inside the item reaches only the snapshot, and
 * `closeItem` merges it (`Object.assign`, last to leave wins) or drops it.
 *
 * The workflows are built with Mastra's own `createWorkflow` — the runner reads only the execution
 * graph — and the calls are made by hand, each with an item view the leaf would build. Tested, not
 * proven; no net is involved.
 */

type Wf = any;
type Ctx = Record<string, unknown> & {
  readonly inputData: unknown;
  readonly state: Record<string, unknown>;
  readonly setState: (s: Record<string, unknown>) => Promise<void>;
  readonly getInitData: () => unknown;
  readonly getStepResult: (id: string) => unknown;
  readonly retryCount: number;
  readonly runId: string;
};

const anyStep = (id: string, fn: (ctx: Ctx) => unknown, extra: Record<string, unknown> = {}) =>
  createStep({ id, inputSchema: z.any(), outputSchema: z.any(), stateSchema: z.any(), execute: async (ctx: unknown) => fn(ctx as Ctx), ...extra } as never);

/** `[pipeline body (a -> b) as a foreach, report]`, the body's input schema `bodyInput`. */
function build(a: unknown, b: unknown, bodyInput: z.ZodTypeAny = z.any()): Wf {
  const body = (createWorkflow({ id: 'per-doc', inputSchema: bodyInput, outputSchema: z.any() } as never) as Wf).then(a).then(b).commit();
  const report = anyStep('report', ({ inputData }) => inputData);
  return (createWorkflow({ id: 'ingest', inputSchema: z.array(z.any()), outputSchema: z.any() } as never) as Wf)
    .foreach(body, { concurrency: 2 })
    .then(report)
    .commit();
}

function direct(w: Wf, extra: Partial<MastraStepRunnerOptions> = {}) {
  const graph = w.buildExecutionGraph() as ExecutionGraph;
  const executor = new StepExecutor({ mastra: { pubsub: new EventEmitterPubSub() } as never });
  const runner = new MastraStepRunner({
    executor,
    graph,
    workflowId: graph.id,
    runId: 'run-1',
    requestContext: new RequestContext(),
    abortController: new AbortController(),
    initialState: { shared: 'run' },
    validateInputs: true,
    resourceId: undefined,
    mastra: undefined,
    ...extra,
  });
  return { runner, executor };
}

/** The item store a leaf would read through: the item as `initData`, the item's own records. */
function itemView(item: unknown, records: Map<string, StepRecord> = new Map()): RunView & { readonly records: Map<string, StepRecord> } {
  return {
    path: [0],
    initData: item,
    getStepResult: (id) => records.get(id),
    abortSignal: new AbortController().signal,
    records,
  };
}

const stage = (k: number, view: RunView, extra: Partial<StepCall> = {}): StepCall => ({
  ...view,
  path: view.path,
  initData: view.initData,
  getStepResult: view.getStepResult,
  abortSignal: view.abortSignal,
  source: 'step',
  attempt: 0,
  pipelineItem: k,
  ...extra,
});

describe('stage resolution and input', () => {
  it('resolves a stage by id inside the body and hands the item over as it is', async () => {
    const seen: unknown[] = [];
    const a = anyStep('a', ({ inputData, getInitData }) => {
      seen.push({ inputData, init: getInitData() });
      return { fetched: inputData };
    });
    const b = anyStep('b', ({ inputData, getStepResult, getInitData }) => {
      seen.push({ inputData, a: getStepResult('a'), init: getInitData() });
      return { stored: inputData };
    });
    const { runner, executor } = direct(build(a, b));
    const execute = vi.spyOn(executor, 'execute');
    runner.openItem([0], 3);
    const view = itemView({ url: 'u3' });

    const first = await runner.run('a', { url: 'u3' }, stage(3, view));
    expect(first).toMatchObject({ status: 'success', output: { fetched: { url: 'u3' } }, payload: { url: 'u3' } });
    view.records.set('a', { status: 'success', output: { fetched: { url: 'u3' } }, payload: { url: 'u3' } });
    const second = await runner.run('b', { fetched: { url: 'u3' } }, stage(3, view));
    expect(second).toMatchObject({ status: 'success', output: { stored: { fetched: { url: 'u3' } } } });

    // The item is the stage's `getInitData()`, and stage b reads the item's own `a`.
    expect(seen).toEqual([
      { inputData: { url: 'u3' }, init: { url: 'u3' } },
      { inputData: { fetched: { url: 'u3' } }, a: { fetched: { url: 'u3' } }, init: { url: 'u3' } },
    ]);
    // No foreach lookup of the input and the parent's run id: a stage is not a foreach item.
    for (const [params] of execute.mock.calls) {
      expect(params).not.toHaveProperty('foreachIdx');
      expect(params.runId).toBe('run-1');
    }
    expect(execute.mock.calls[0]![0].input).toEqual({ url: 'u3' });
  });

  it('records no nestedRunId on a stage, and refuses an id that is not a stage of the body', async () => {
    const a = anyStep('a', ({ inputData }) => inputData);
    const b = anyStep('b', ({ inputData }) => inputData);
    const { runner } = direct(build(a, b));
    const out = await runner.run('a', 1, stage(0, itemView(1)));
    expect(out.status).toBe('success');
    expect(JSON.stringify(out.host)).not.toContain('nestedRunId');
    // `report` is the run's own step, not a stage; `per-doc` is the body, not a stage.
    await expect(runner.run('report', 1, stage(0, itemView(1)))).rejects.toThrow(/no pipeline stage 'report' at path 0/);
    await expect(runner.run('per-doc', 1, stage(0, itemView(1)))).rejects.toThrow(/no pipeline stage 'per-doc'/);
  });
});

describe('stage-0 validation against the body', () => {
  it('fails stage 0 with the body schema error before the stage runs, every attempt', async () => {
    const ran = vi.fn();
    const a = anyStep('a', ran, { inputSchema: z.any() });
    const b = anyStep('b', ({ inputData }) => inputData);
    const { runner } = direct(build(a, b, z.object({ n: z.number() })));
    const view = itemView({ n: 'x' });
    const out0 = await runner.run('a', { n: 'x' }, stage(0, view));
    const out1 = await runner.run('a', { n: 'x' }, stage(0, view, { attempt: 1 }));
    for (const out of [out0, out1]) {
      expect(out.status).toBe('failed');
      expect(String((out as { error: unknown }).error)).toMatch(/Step input validation failed[\s\S]*n/);
    }
    expect(ran).not.toHaveBeenCalled();
  });

  it("applies the body's defaults, then the stage's own schema", async () => {
    const seen: unknown[] = [];
    const a = anyStep('a', ({ inputData }) => (seen.push(inputData), inputData), {
      inputSchema: z.object({ n: z.number(), tag: z.string().default('t') }),
    });
    const b = anyStep('b', ({ inputData }) => inputData);
    const { runner } = direct(build(a, b, z.object({ n: z.number().default(5) })));
    const out = await runner.run('a', {}, stage(0, itemView({})));
    expect(seen).toEqual([{ n: 5, tag: 't' }]);
    // The record keeps the input as validated by both.
    expect(out).toMatchObject({ status: 'success', payload: { n: 5, tag: 't' } });
  });

  it("validates a later stage against its own schema only, never the body's", async () => {
    const a = anyStep('a', ({ inputData }) => inputData);
    const b = anyStep('b', ({ inputData }) => inputData, { inputSchema: z.object({ v: z.number() }) });
    const { runner } = direct(build(a, b, z.object({ n: z.number() })));
    // `{v: 1}` would fail the body's schema; b takes it.
    expect((await runner.run('b', { v: 1 }, stage(0, itemView({ n: 1 })))).status).toBe('success');
    const bad = await runner.run('b', { v: 'x' }, stage(1, itemView({ n: 1 })));
    expect(bad.status).toBe('failed');
    expect(String((bad as { error: unknown }).error)).toMatch(/v/);
  });

  it('keeps one validation per item: a retry of item 1 does not reuse item 0', async () => {
    const seen: unknown[] = [];
    const a = anyStep('a', ({ inputData }) => (seen.push(inputData), inputData), { inputSchema: z.object({ n: z.number() }) });
    const b = anyStep('b', ({ inputData }) => inputData);
    const { runner } = direct(build(a, b));
    await runner.run('a', { n: 0 }, stage(0, itemView({ n: 0 })));
    await runner.run('a', { n: 1 }, stage(1, itemView({ n: 1 })));
    await runner.run('a', { n: 0 }, stage(0, itemView({ n: 0 }), { attempt: 1 }));
    await runner.run('a', { n: 1 }, stage(1, itemView({ n: 1 }), { attempt: 1 }));
    expect(seen).toEqual([{ n: 0 }, { n: 1 }, { n: 0 }, { n: 1 }]);
  });
});

describe('events and spans', () => {
  it('publishes no step start and opens no span for a stage', async () => {
    const a = anyStep('a', ({ inputData }) => inputData);
    const b = anyStep('b', ({ inputData }) => inputData);
    const stepStarted = vi.fn(async () => {});
    const callId = vi.fn(() => 'call');
    const events = { enabled: true, stepStarted, callId, keep: vi.fn() } as unknown as StepEvents;
    const step = vi.fn(async () => undefined);
    const spans = { step } as unknown as StepSpans;
    const { runner } = direct(build(a, b), { events, spans });
    expect((await runner.run('a', 1, stage(0, itemView(1)))).status).toBe('success');
    expect(stepStarted).not.toHaveBeenCalled();
    expect(callId).not.toHaveBeenCalled();
    expect(step).not.toHaveBeenCalled();
  });
});

describe('item state (maintainer decision 3)', () => {
  it('runs a stage against the snapshot taken at openItem, and merges it at closeItem', async () => {
    const seen: unknown[] = [];
    const a = anyStep('a', async ({ inputData, state, setState }) => {
      seen.push({ ...state });
      await setState({ [`item${String(inputData)}`]: true, shared: `item${String(inputData)}` });
      return inputData;
    });
    const b = anyStep('b', ({ state }) => (seen.push({ ...state }), null));
    const { runner } = direct(build(a, b));

    runner.openItem([0], 0);
    runner.openItem([0], 1);
    await runner.run('a', 0, stage(0, itemView(0)));
    await runner.run('a', 1, stage(1, itemView(1)));
    // Each item sees its own snapshot and its own update; the run's state is untouched so far.
    await runner.run('b', 0, stage(0, itemView(0)));
    expect(runner.state).toEqual({ shared: 'run' });
    expect(seen).toEqual([
      { shared: 'run' },
      { shared: 'run' },
      { shared: 'item0', item0: true },
    ]);

    // Item 1 leaves first, then item 0: last to leave wins each key it holds.
    runner.closeItem([0], 1, 'merge');
    expect(runner.state).toEqual({ shared: 'item1', item1: true });
    runner.closeItem([0], 0, 'merge');
    expect(runner.state).toEqual({ shared: 'item0', item0: true, item1: true });
  });

  it("an item opened after another's merge sees the merged state; one opened before does not", async () => {
    const seen: unknown[] = [];
    const a = anyStep('a', async ({ inputData, state, setState }) => {
      seen.push({ k: inputData, ...state });
      await setState({ last: inputData });
      return inputData;
    });
    const b = anyStep('b', ({ inputData }) => inputData);
    const { runner } = direct(build(a, b));
    runner.openItem([0], 0);
    runner.openItem([0], 1);
    await runner.run('a', 0, stage(0, itemView(0)));
    runner.closeItem([0], 0, 'merge');
    await runner.run('a', 1, stage(1, itemView(1)));
    runner.openItem([0], 2);
    await runner.run('a', 2, stage(2, itemView(2)));
    expect(seen).toEqual([
      { k: 0, shared: 'run' },
      { k: 1, shared: 'run' },
      { k: 2, shared: 'run', last: 0 },
    ]);
  });

  it("discards a failed item's state, and never applies a failed attempt's update", async () => {
    const a = anyStep('a', async ({ setState }) => {
      await setState({ fromA: true });
      return 1;
    });
    const b = anyStep('b', async ({ setState }) => {
      await setState({ fromB: true });
      throw new Error('b broke');
    });
    const { runner } = direct(build(a, b));
    runner.openItem([0], 0);
    expect((await runner.run('a', 0, stage(0, itemView(0)))).status).toBe('success');
    expect((await runner.run('b', 1, stage(0, itemView(0)))).status).toBe('failed');
    runner.closeItem([0], 0, 'discard');
    expect(runner.state).toEqual({ shared: 'run' });

    // The same item merged instead: a's update arrives, b's failed attempt's never does.
    const second = direct(build(a, b)).runner;
    second.openItem([0], 0);
    await second.run('a', 0, stage(0, itemView(0)));
    await second.run('b', 1, stage(0, itemView(0)));
    second.closeItem([0], 0, 'merge');
    expect(second.state).toEqual({ shared: 'run', fromA: true });
  });

  it("leaves the run's own steps on the run's state while items are open", async () => {
    const a = anyStep('a', async ({ setState }) => (await setState({ fromItem: true }), 1));
    const b = anyStep('b', ({ inputData }) => inputData);
    const w = build(a, b);
    const { runner } = direct(w);
    runner.openItem([0], 0);
    await runner.run('a', 0, stage(0, itemView(0)));
    // `report` at path [1] is a run step: it sees the run's state, not the open item's.
    const seen: unknown[] = [];
    const graph = w.buildExecutionGraph() as ExecutionGraph;
    const report = (graph.steps[1] as { step: { execute: unknown } }).step;
    const original = report.execute;
    report.execute = async (ctx: Ctx) => (seen.push({ ...ctx.state }), null);
    try {
      const run: StepCall = { path: [1], initData: [0], getStepResult: () => undefined, abortSignal: new AbortController().signal, source: 'step', attempt: 0 };
      await runner.run('report', [0], run);
    } finally {
      report.execute = original;
    }
    expect(seen).toEqual([{ shared: 'run' }]);
  });

  it('a closed item is gone: a later stage call for it snapshots afresh', async () => {
    const seen: unknown[] = [];
    const a = anyStep('a', async ({ state, setState }) => {
      seen.push({ ...state });
      await setState({ n: ((state['n'] as number | undefined) ?? 0) + 1 });
      return 1;
    });
    const b = anyStep('b', ({ inputData }) => inputData);
    const { runner } = direct(build(a, b));
    runner.openItem([0], 0);
    await runner.run('a', 0, stage(0, itemView(0)));
    runner.closeItem([0], 0, 'merge');
    // closeItem of an item never opened changes nothing.
    runner.closeItem([0], 9, 'merge');
    await runner.run('a', 0, stage(0, itemView(0)));
    expect(seen).toEqual([{ shared: 'run' }, { shared: 'run', n: 1 }]);
    expect(runner.state).toEqual({ shared: 'run', n: 1 });
  });
});

describe("the item's initData (the twin's child input)", () => {
  // Mutation: drop the stage view's `initData` override -> stages see the raw item.
  // Mutation: validate the body once -> stage a and every `getInitData()` see n + 1.
  it("is the item as the body's schema left it, twice applied as the child's start applies it, for every stage", async () => {
    const seen: unknown[] = [];
    const a = anyStep('a', ({ inputData, getInitData }) => (seen.push({ stage: 'a', inputData, init: getInitData() }), inputData));
    // `getInitData()` reads `stepResults.input` (`evented/step-executor.ts:199`): one override covers both.
    const b = anyStep('b', ({ getInitData }) => (seen.push({ stage: 'b', init: getInitData() }), null));
    const body = z.object({ n: z.number().transform((n) => n + 1), tag: z.string().default('t') });
    const { runner } = direct(build(a, b, body));
    runner.openItem([0], 0);
    const view = itemView({ n: 1 });
    await runner.run('a', { n: 1 }, stage(0, view));
    // A retry reads the same: kept, not validated a third time.
    await runner.run('a', { n: 1 }, stage(0, view, { attempt: 1 }));
    await runner.run('b', { n: 3, tag: 't' }, stage(0, view));
    const item = { n: 3, tag: 't' };
    expect(seen).toEqual([
      { stage: 'a', inputData: item, init: item },
      { stage: 'a', inputData: item, init: item },
      { stage: 'b', init: item },
    ]);
  });

  it('is the raw item when the run does not validate inputs, as the child then does not either', async () => {
    const seen: unknown[] = [];
    const a = anyStep('a', ({ inputData, getInitData }) => (seen.push({ inputData, init: getInitData() }), inputData));
    const b = anyStep('b', ({ getInitData }) => (seen.push({ init: getInitData() }), null));
    const { runner } = direct(build(a, b, z.object({ n: z.number().transform((n) => n + 1) })), { validateInputs: false });
    await runner.run('a', { n: 1 }, stage(0, itemView({ n: 1 })));
    await runner.run('b', { n: 1 }, stage(0, itemView({ n: 1 })));
    expect(seen).toEqual([{ inputData: { n: 1 }, init: { n: 1 } }, { init: { n: 1 } }]);
  });

  // Mutation: keep `#itemInit` or `#validated` past closeItem -> the reused index reads the closed item's.
  it("goes with its item at closeItem, with the item's kept validations", async () => {
    const seen: unknown[] = [];
    const a = anyStep('a', ({ inputData, getInitData }) => (seen.push({ inputData, init: getInitData() }), inputData));
    const b = anyStep('b', ({ getInitData }) => (seen.push({ init: getInitData() }), null));
    const { runner } = direct(build(a, b, z.object({ n: z.number().default(7) })));
    runner.openItem([0], 0);
    await runner.run('a', {}, stage(0, itemView({})));
    runner.closeItem([0], 0, 'merge');
    // A later call for index 0 is not the closed item's: no kept validation, no kept initData.
    await runner.run('a', { n: 2 }, stage(0, itemView({ n: 2 }), { attempt: 1 }));
    runner.closeItem([0], 0, 'merge');
    await runner.run('b', 'x', stage(0, itemView('raw')));
    expect(seen).toEqual([{ inputData: { n: 7 }, init: { n: 7 } }, { inputData: { n: 2 }, init: { n: 2 } }, { init: 'raw' }]);
  });
});

describe('resume labels from a stage', () => {
  // Mutation: name the stage (`{ stepId: step.id, foreachIndex }`) -> `Run.resume({ label })` resolves
  // to a stage id the parent does not know, and the engine's `pipeline` refusal is never reached.
  it('names the pipeline body at the item, as the twin re-suspends its nested step under the label', async () => {
    const a = anyStep('a', ({ inputData }) => inputData);
    const b = anyStep('b', async ({ suspend }) => (suspend as (d: unknown, o: unknown) => Promise<void>)({ why: 1 }, { resumeLabel: ['L', 'M'] }));
    const { runner } = direct(build(a, b));
    runner.openItem([0], 2);
    const out = await runner.run('b', 1, stage(2, itemView(1)));
    expect(out.status).toBe('suspended');
    expect(runner.resumeLabels).toEqual({ L: { stepId: 'per-doc', foreachIndex: 2 }, M: { stepId: 'per-doc', foreachIndex: 2 } });
  });
});

describe('a stage leaves the run-level bookkeeping alone', () => {
  // Mutation: let a stage call set `#lastView` -> a published event's prior reads the item's record.
  it("keeps the last run view for event priors, never a stage's item view", async () => {
    const a = anyStep('a', ({ inputData }) => inputData);
    const b = anyStep('b', ({ inputData }) => inputData);
    const priors: unknown[] = [];
    const events = {
      enabled: false,
      callId: () => 'call',
      keep: vi.fn(),
      observe: async (_event: unknown, prior: (id: string) => StepRecord | undefined) => void priors.push(prior('a')),
    } as unknown as StepEvents;
    const { runner } = direct(build(a, b), { events });
    const runRecord: StepRecord = { status: 'success', output: 'run', payload: 'run' };
    const itemRecord: StepRecord = { status: 'success', output: 'item', payload: 'item' };
    const runCall: StepCall = { path: [1], initData: [0], getStepResult: (id) => (id === 'a' ? runRecord : undefined), abortSignal: new AbortController().signal, source: 'step', attempt: 0 };
    await runner.run('report', [0], runCall);
    await runner.run('a', 0, stage(0, itemView(0, new Map([['a', itemRecord]]))));
    await runner.observe({ kind: 'step-settled', stepId: 'report', path: [1], record: runRecord } as never);
    expect(priors).toEqual([runRecord]);
  });

  // Mutation: a fresh `stepCallId` per attempt -> the retry's writer carries another call id.
  it("shares one stepCallId across a stage's retries, one per item and per call", async () => {
    const ids: unknown[] = [];
    const a = anyStep('a', ({ writer }) => (ids.push((writer as { callId?: unknown }).callId), null));
    const b = anyStep('b', ({ inputData }) => inputData);
    const { runner } = direct(build(a, b));
    runner.openItem([0], 0);
    runner.openItem([0], 1);
    await runner.run('a', 0, stage(0, itemView(0)));
    await runner.run('a', 0, stage(0, itemView(0), { attempt: 1 }));
    await runner.run('a', 1, stage(1, itemView(1)));
    runner.closeItem([0], 0, 'merge');
    await runner.run('a', 0, stage(0, itemView(0)));
    expect(typeof ids[0]).toBe('string');
    expect(ids[1]).toBe(ids[0]);
    expect(new Set([ids[0], ids[2], ids[3]]).size).toBe(3);
  });
});

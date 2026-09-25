import { TripWire } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { MASTRA_AUTH_TOKEN_KEY, RequestContext } from '@mastra/core/request-context';
import { InMemoryStore } from '@mastra/core/storage';
import { createStep, createWorkflow, DefaultExecutionEngine } from '@mastra/core/workflows';
import { vi } from 'vitest';
import type { WorkflowRunState, WorkflowRunStatus } from '@mastra/core/workflows';
import { z } from 'zod';
import type { RunOutcome, RunReport } from '../../src/engine/kernel.js';
import type { StepRecord } from '../../src/compiler/types.js';
import { PetriExecutionEngine } from '../../src/mastra/engine.js';
import { buildRunSnapshot, persistRun, type PersistContext } from '../../src/mastra/persist.js';
import type { FormattedResult } from '../../src/mastra/result.js';

/**
 * `persistRun` against the default engine as the oracle: the same workflow, registered on one real
 * `Mastra` with an `InMemoryStore`, run through Mastra's own `Run.start()` on each engine, and the
 * two stored `WorkflowRunState`s compared field by field. Only what the clock stamps (`timestamp`,
 * `startedAt`, `endedAt`, `suspendedAt`), run ids and the random suffix of a `.sleep()` id differ by
 * construction; they are masked, and nothing else is.
 */

const num = z.object({ n: z.number() });
const stateSchema = z.object({ c: z.number() });

type EngineKind = 'default' | 'petri';
type EngineOptions = ConstructorParameters<typeof PetriExecutionEngine>[0];

function engineFor(kind: EngineKind, options?: EngineOptions): { executionEngine?: PetriExecutionEngine } {
  return kind === 'petri' ? { executionEngine: new PetriExecutionEngine(options) } : {};
}

/**
 * Engine identity. Runs `run` with both engines' `execute()` spied on the prototype and asserts
 * that the side's own engine ran `workflowId` at least once and the other engine never did —
 * without it, a petri side that silently ran on `DefaultExecutionEngine` would store the default
 * engine's snapshot twice and every oracle test here would pass vacuously. Only calls for
 * `workflowId` count: a nested workflow runs on its own engine (`nestedSuspend`'s runs on the
 * default engine under both parents).
 */
async function onEngine<T>(side: EngineKind, workflowId: string, run: () => Promise<T>): Promise<T> {
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

/** Resolved by a step when it starts, so a test can cancel while it runs. */
interface Latch {
  readonly started: Promise<void>;
  readonly release: () => void;
}
function latch(): Latch {
  let release: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { started, release };
}

const untilAborted = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

const inc = createStep({
  id: 'inc',
  inputSchema: num,
  outputSchema: num,
  stateSchema,
  execute: async ({ inputData, state, setState }) => {
    await setState({ c: state.c + 1 });
    return { n: inputData.n + 1 };
  },
});
const dbl = createStep({
  id: 'dbl',
  inputSchema: num,
  outputSchema: num,
  execute: async ({ inputData }) => ({ n: inputData.n * 2 }),
});
const boom = createStep({
  id: 'boom',
  inputSchema: num,
  outputSchema: num,
  execute: async () => {
    throw new Error('kaput');
  },
});
const throwsString = createStep({
  id: 'throwsString',
  inputSchema: num,
  outputSchema: num,
  execute: async () => {
    throw 'not an error';
  },
});
const tripper = createStep({
  id: 'tripper',
  inputSchema: num,
  outputSchema: num,
  execute: async () => {
    throw new TripWire('blocked', { retry: false, metadata: { why: 'policy' } }, 'guard');
  },
});
const bailer = createStep({
  id: 'bailer',
  inputSchema: num,
  outputSchema: num,
  execute: async ({ inputData, bail }) => bail({ n: inputData.n + 100 }),
});
const waiter = createStep({
  id: 'waiter',
  inputSchema: num,
  outputSchema: num,
  suspendSchema: z.object({ why: z.string() }),
  resumeSchema: z.object({ ok: z.boolean() }),
  execute: async ({ inputData, suspend }) => {
    await suspend({ why: 'approval' });
    return inputData;
  },
});
const labelled = createStep({
  id: 'labelled',
  inputSchema: num,
  outputSchema: num,
  suspendSchema: z.object({ why: z.string() }),
  resumeSchema: z.object({ ok: z.boolean() }),
  execute: async ({ inputData, suspend }) => {
    await suspend({ why: 'label' }, { resumeLabel: 'L1' });
    return inputData;
  },
});
const left = createStep({ id: 'left', inputSchema: num, outputSchema: num, execute: async ({ inputData }) => ({ n: inputData.n + 1 }) });
/** Takes whatever a block hands on. */
const after = createStep({ id: 'after', inputSchema: z.any(), outputSchema: z.any(), execute: async ({ inputData }) => inputData });
const right = createStep({ id: 'right', inputSchema: num, outputSchema: num, execute: async ({ inputData }) => ({ n: inputData.n + 2 }) });

/** A step that signals it has started, then returns once the run is aborted. */
const waitsAbort = (l: Latch) =>
  createStep({
    id: 'waitsAbort',
    inputSchema: num,
    outputSchema: num,
    execute: async ({ inputData, abortSignal }) => {
      l.release();
      await untilAborted(abortSignal);
      return inputData;
    },
  });
/** A step that signals it has started and returns at once. */
const mark = (l: Latch) =>
  createStep({
    id: 'mark',
    inputSchema: num,
    outputSchema: num,
    execute: async ({ inputData }) => {
      l.release();
      return inputData;
    },
  });

type Shape =
  | 'chain'
  | 'fails'
  | 'throwsString'
  | 'tripwire'
  | 'parallelFails'
  | 'bails'
  | 'suspends'
  | 'resumeLabel'
  | 'nestedSuspend'
  | 'parallel'
  | 'cancelMidStep'
  | 'cancelFirstStep'
  | 'cancelMidParallel'
  | 'cancelLastStep'
  | 'cancelMidSleep'
  | 'cancelBeforeStart';

function build(shape: Shape, kind: EngineKind, id: string, l: Latch, engineOptions?: EngineOptions, workflowOptions?: object) {
  const base = createWorkflow({
    id,
    inputSchema: num,
    outputSchema: z.any(),
    stateSchema,
    ...engineFor(kind, engineOptions),
    ...(workflowOptions ? { options: workflowOptions } : {}),
  });
  switch (shape) {
    case 'chain':
    case 'cancelBeforeStart':
      return base.then(inc).then(dbl).commit();
    case 'fails':
      return base.then(inc).then(boom).then(dbl).commit();
    case 'throwsString':
      return base.then(inc).then(throwsString).then(dbl).commit();
    case 'tripwire':
      return base.then(inc).then(tripper).then(dbl).commit();
    case 'parallelFails':
      return base.then(inc).parallel([left, boom]).then(after).commit();
    case 'bails':
      return base.then(inc).then(bailer).then(dbl).commit();
    case 'suspends':
      return base.then(inc).then(waiter).then(dbl).commit();
    case 'resumeLabel':
      return base.then(inc).then(labelled).then(dbl).commit();
    case 'nestedSuspend': {
      // The nested workflow runs on the default engine under both parents: only the parent's
      // stored record of it is under test.
      const inner = createWorkflow({ id: 'inner', inputSchema: num, outputSchema: num }).then(dbl).then(waiter).commit();
      return base.then(inc).then(inner).then(left).commit();
    }
    case 'parallel':
      return base.then(inc).parallel([left, right]).commit();
    case 'cancelMidStep':
      return base.then(inc).then(waitsAbort(l)).then(dbl).commit();
    case 'cancelFirstStep':
      return base.then(waitsAbort(l)).then(dbl).then(inc).commit();
    case 'cancelMidParallel':
      return base.then(inc).parallel([waitsAbort(l), left]).then(after).commit();
    case 'cancelLastStep':
      return base.then(inc).then(waitsAbort(l)).commit();
    case 'cancelMidSleep':
      return base.then(inc).then(mark(l)).sleep(3000).then(dbl).commit();
  }
}

/** How a shape is driven: started, canceled while its latch step runs, or canceled before start. */
function driveOf(shape: Shape): 'start' | 'cancelOnLatch' | 'cancelAfterLatch' | 'cancelFirst' {
  switch (shape) {
    case 'cancelMidStep':
    case 'cancelFirstStep':
    case 'cancelMidParallel':
    case 'cancelLastStep':
      return 'cancelOnLatch';
    case 'cancelMidSleep':
      return 'cancelAfterLatch';
    case 'cancelBeforeStart':
      return 'cancelFirst';
    default:
      return 'start';
  }
}

async function loadSnapshot(storage: InMemoryStore, workflowName: string, runId: string): Promise<WorkflowRunState | null> {
  const store = await storage.getStore('workflows');
  if (!store) throw new Error('InMemoryStore has no workflows store');
  return store.loadWorkflowSnapshot({ workflowName, runId });
}

const MASKED_FIELDS = new Set(['timestamp', 'startedAt', 'endedAt', 'suspendedAt', 'runId', 'nestedRunId']);
const SLEEP_ID = /sleep_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** What a JSON-backed store would hand back, with the clock's, the run ids' and sleep ids' values masked. */
function comparable(snapshot: unknown): Record<string, unknown> {
  const json = JSON.stringify(snapshot, (key, value: unknown) => (MASKED_FIELDS.has(key) ? '<masked>' : value));
  return JSON.parse(json.replace(SLEEP_ID, 'sleep_<id>')) as Record<string, unknown>;
}

/** Field by field, so a failure names the field, then the whole object. */
function expectSameSnapshot(p: Record<string, unknown>, d: Record<string, unknown>): void {
  for (const field of new Set([...Object.keys(d), ...Object.keys(p)])) expect([field, p[field]]).toEqual([field, d[field]]);
  expect(Object.keys(p).sort()).toEqual(Object.keys(d).sort());
  expect(p).toEqual(d);
}

interface Pair {
  readonly byEngine: Record<EngineKind, WorkflowRunState | null>;
  readonly results: Record<EngineKind, { status: string }>;
}

async function runBoth(
  shape: Shape,
  opts: {
    engineOptions?: EngineOptions;
    workflowOptions?: object;
    createRun?: { shouldPersistSnapshot?: (p: { workflowStatus: WorkflowRunStatus }) => boolean };
    requestContext?: RequestContext;
  } = {},
): Promise<Pair> {
  const storage = new InMemoryStore();
  const latches: Record<EngineKind, Latch> = { default: latch(), petri: latch() };
  const workflows = {
    wfDefault: build(shape, 'default', 'wf-default', latches.default, undefined, opts.workflowOptions),
    wfPetri: build(shape, 'petri', 'wf-petri', latches.petri, opts.engineOptions, opts.workflowOptions),
  };
  const mastra = new Mastra({ storage, workflows, logger: false });
  const byEngine = {} as Record<EngineKind, WorkflowRunState | null>;
  const results = {} as Record<EngineKind, { status: string }>;
  for (const [kind, key, name] of [
    ['default', 'wfDefault', 'wf-default'],
    ['petri', 'wfPetri', 'wf-petri'],
  ] as const) {
    const run = await mastra.getWorkflow(key).createRun({ resourceId: 'res-1', ...(opts.createRun ?? {}) });
    const start = () =>
      run.start({
        inputData: { n: 1 },
        initialState: { c: 10 },
        ...(opts.requestContext ? { requestContext: opts.requestContext } : {}),
      });
    results[kind] = await onEngine(kind, name, async () => {
      switch (driveOf(shape)) {
        case 'start':
          return start();
        case 'cancelOnLatch': {
          const pending = start();
          await latches[kind].started;
          await run.cancel();
          return pending;
        }
        case 'cancelAfterLatch': {
          const pending = start();
          await latches[kind].started;
          await new Promise((resolve) => setTimeout(resolve, 50));
          await run.cancel();
          return pending;
        }
        case 'cancelFirst':
          await run.cancel();
          return start();
      }
    });
    byEngine[kind] = await loadSnapshot(storage, name, run.runId);
  }
  return { byEngine, results };
}

async function oracle(shape: Shape, status: string): Promise<{ p: Record<string, unknown>; d: Record<string, unknown> }> {
  const { byEngine, results } = await runBoth(shape);
  expect(results.default.status).toBe(status);
  expect(results.petri.status).toBe(status);
  return { d: comparable(byEngine.default), p: comparable(byEngine.petri) };
}

describe('persistRun — the terminal snapshot matches the default engine field by field', () => {
  it('a sequential chain with workflow state: every field', async () => {
    const { p, d } = await oracle('chain', 'success');
    expectSameSnapshot(p, d);
    expect(p['status']).toBe('success');
    expect(p['value']).toEqual({ c: 11 });
    expect(p['result']).toEqual({ n: 4 });
    expect(p['activePaths']).toEqual([1]);
    expect(p['stepExecutionPath']).toEqual(['inc', 'dbl']);
    // A run that ran to the end writes no tracing context (`default.ts:1081-1093`).
    expect('tracingContext' in p).toBe(false);
  });

  it('a failed step: status, error, context and paths', async () => {
    const { p, d } = await oracle('fails', 'failed');
    expectSameSnapshot(p, d);
    expect(p['error']).toMatchObject({ message: 'kaput', name: 'Error' });
    expect(p['error']).not.toHaveProperty('stack');
    expect(p['activePaths']).toEqual([1]);
    expect(p['tracingContext']).toEqual({});
  });

  it('a thrown non-Error: the error as getErrorFromUnknown serializes it', async () => {
    const { p, d } = await oracle('throwsString', 'failed');
    expectSameSnapshot(p, d);
  });

  it('a TripWire: persisted as tripwire, not failed', async () => {
    const { p, d } = await oracle('tripwire', 'tripwire');
    expectSameSnapshot(p, d);
    expect(p['status']).toBe('tripwire');
    expect(p['activePaths']).toEqual([1]);
  });

  it('a failing parallel arm: activePaths is the top-level entry, not the arm', async () => {
    const { p, d } = await oracle('parallelFails', 'failed');
    expectSameSnapshot(p, d);
    expect(p['activePaths']).toEqual([1]);
  });

  it('a bail: persisted as success with the bail payload as result, at the bailing entry', async () => {
    const { p, d } = await oracle('bails', 'success');
    expectSameSnapshot(p, d);
    expect(p['result']).toEqual({ n: 102 });
    expect(p['activePaths']).toEqual([1]);
    expect(p['tracingContext']).toEqual({});
  });

  it('a suspension: status, suspendedPaths and the suspended record, stored bare', async () => {
    const { p, d } = await oracle('suspends', 'suspended');
    expectSameSnapshot(p, d);
    expect(p['suspendedPaths']).toEqual({ waiter: [1] });
    expect(p['activePaths']).toEqual([1]);
    // `StepExecutor` stamps its own `__workflow_meta`; the default stores the payload as given.
    expect((p['context'] as Record<string, { suspendPayload?: unknown }>)['waiter']?.suspendPayload).toEqual({ why: 'approval' });
  });

  it('a suspension with a resume label: resumeLabels as the step context writes it', async () => {
    const { p, d } = await oracle('resumeLabel', 'suspended');
    expectSameSnapshot(p, d);
    expect(p['resumeLabels']).toEqual({ L1: { stepId: 'labelled' } });
  });

  it("a nested workflow's suspension keeps the inner step's path in __workflow_meta, as the default does", async () => {
    // `workflow.ts:3059-3090`: the nested step suspends with `{ ...payload, __workflow_meta: {
    // runId: <nested run>, path: [<inner step>] } }` and the default engine stores it as it is.
    const { p, d } = await oracle('nestedSuspend', 'suspended');
    const meta = (s: Record<string, unknown>) =>
      (s['context'] as Record<string, { suspendPayload?: { __workflow_meta?: { path?: unknown } } }>)['inner']?.suspendPayload?.__workflow_meta;
    expect(meta(d)?.path).toEqual(['waiter']);
    expect(meta(p)?.path).toEqual(meta(d)?.path);
    expectSameSnapshot(p, d);
  });

  it('a parallel block: context, stepExecutionPath and activePaths', async () => {
    const { p, d } = await oracle('parallel', 'success');
    expectSameSnapshot(p, d);
  });

  it('requestContext is serialized without the auth token', async () => {
    const requestContext = new RequestContext();
    requestContext.set('tenant', 'acme');
    requestContext.set(MASTRA_AUTH_TOKEN_KEY, 'secret');
    const { byEngine } = await runBoth('chain', { requestContext });
    expect(byEngine.petri?.requestContext).toEqual({ tenant: 'acme' });
    expect(byEngine.petri?.requestContext).toEqual(byEngine.default?.requestContext);
  });
});

describe('persistRun — a run canceled through Run.cancel()', () => {
  it('mid-step: activePaths is the entry that was running, with tracingContext {}', async () => {
    const { p, d } = await oracle('cancelMidStep', 'canceled');
    expect(d['activePaths']).toEqual([1]);
    expectSameSnapshot(p, d);
    expect(p['tracingContext']).toEqual({});
  });

  it('mid-step in the first entry: [0], with tracingContext {}', async () => {
    const { p, d } = await oracle('cancelFirstStep', 'canceled');
    expect(d['activePaths']).toEqual([0]);
    expectSameSnapshot(p, d);
  });

  it('mid-arm of a parallel block: the block entry', async () => {
    const { p, d } = await oracle('cancelMidParallel', 'canceled');
    expect(d['activePaths']).toEqual([1]);
    expectSameSnapshot(p, d);
  });

  it('mid-step in the last entry: the last entry', async () => {
    const { p, d } = await oracle('cancelLastStep', 'canceled');
    expect(d['activePaths']).toEqual([1]);
    expectSameSnapshot(p, d);
  });

  it("mid-sleep: the sleep's entry, and its waiting record in context", async () => {
    const { p, d } = await oracle('cancelMidSleep', 'canceled');
    expect(d['activePaths']).toEqual([2]);
    expectSameSnapshot(p, d);
    const sleep = (p['context'] as Record<string, unknown>)['sleep_<id>'];
    expect(sleep).toEqual({ status: 'waiting', payload: { n: 2 }, startedAt: '<masked>' });
  });

  it('before start: [0] and no tracingContext key, as the loop-top check persists', async () => {
    const { p, d } = await oracle('cancelBeforeStart', 'canceled');
    expect('tracingContext' in d).toBe(false);
    expectSameSnapshot(p, d);
  });
});

describe('persistRun — the persistence predicates', () => {
  it('the run override from createRun({ shouldPersistSnapshot }) wins: no row on either engine', async () => {
    const { byEngine } = await runBoth('chain', { createRun: { shouldPersistSnapshot: () => false } });
    expect(byEngine.default).toBeNull();
    expect(byEngine.petri).toBeNull();
  });

  it("the engine's shouldPersistSnapshot decides per status; refusing 'success' leaves the last written row", async () => {
    const seen: WorkflowRunStatus[] = [];
    const { byEngine } = await runBoth('chain', {
      engineOptions: {
        options: {
          shouldPersistSnapshot: ({ workflowStatus }) => {
            seen.push(workflowStatus);
            return workflowStatus !== 'success';
          },
        },
      },
    });
    // Asked at start ('running') and at the end ('success'); the start row is what remains.
    expect(seen).toEqual(['running', 'success']);
    expect(byEngine.petri?.status).toBe('running');
    expect(byEngine.default?.status).toBe('success');
  });

  it("the engine's pruneSnapshot transforms every write and sees the status", async () => {
    const statuses: WorkflowRunStatus[] = [];
    const { byEngine } = await runBoth('chain', {
      engineOptions: {
        options: {
          pruneSnapshot: ({ snapshot, workflowStatus }) => {
            statuses.push(workflowStatus);
            return { ...snapshot, context: { input: snapshot.context.input } as WorkflowRunState['context'] };
          },
        },
      },
    });
    expect(statuses).toEqual(['running', 'success']);
    expect(byEngine.petri?.status).toBe('success');
    expect(byEngine.petri?.context).toEqual({ input: { n: 1 } });
  });

  it("the workflow's own options reach only its pending row — Mastra never hands them to a supplied engine", async () => {
    // Both engines get the same workflow-level pruneSnapshot. The default engine is built from it;
    // a supplied engine is not (`workflow.ts:1819-1827`), so its writes are unpruned.
    const { byEngine } = await runBoth('chain', {
      workflowOptions: {
        pruneSnapshot: ({ snapshot }: { snapshot: WorkflowRunState }) => ({ ...snapshot, value: { pruned: 'yes' } }),
      },
    });
    expect(byEngine.default?.value).toEqual({ pruned: 'yes' });
    expect(byEngine.petri?.value).toEqual({ c: 11 });
  });
});

describe('persistRun — the start snapshot', () => {
  it('a step reading storage mid-run sees a running row carrying the input and the initial state', async () => {
    const storage = new InMemoryStore();
    const observed: Record<string, WorkflowRunState | null> = {};
    const probe = (name: string) =>
      createStep({
        id: 'probe',
        inputSchema: num,
        outputSchema: num,
        execute: async ({ inputData, runId }) => {
          observed[name] = await loadSnapshot(storage, name, runId);
          return inputData;
        },
      });
    const make = (kind: EngineKind, name: string) =>
      createWorkflow({ id: name, inputSchema: num, outputSchema: num, stateSchema, ...engineFor(kind) })
        .then(probe(name))
        .commit();
    const mastra = new Mastra({ storage, workflows: { d: make('default', 'wf-d'), p: make('petri', 'wf-p') }, logger: false });
    for (const [key, kind, name] of [
      ['d', 'default', 'wf-d'],
      ['p', 'petri', 'wf-p'],
    ] as const) {
      const run = await mastra.getWorkflow(key).createRun();
      await onEngine(kind, name, () => run.start({ inputData: { n: 1 }, initialState: { c: 3 } }));
    }
    const d = observed['wf-d'];
    const p = observed['wf-p'];
    expect(d?.status).toBe('running');
    expect(p?.status).toBe('running');
    expect(p?.value).toEqual(d?.value);
    expect(p?.context.input).toEqual(d?.context.input);
    expect(p?.activePaths).toEqual(d?.activePaths);
    // Divergence: the default engine's row already holds the probe's own `running` record, its
    // `activeStepsPath` and `stepExecutionPath` entry; the net's start row is written before any
    // step starts (docs/divergences.md).
    expect(d?.context['probe']).toMatchObject({ status: 'running', payload: { n: 1 } });
    expect(p?.context['probe']).toBeUndefined();
    expect(d?.activeStepsPath).toEqual({ probe: [0] });
    expect(p?.activeStepsPath).toEqual({});
    expect(d?.stepExecutionPath).toEqual(['probe']);
    expect(p?.stepExecutionPath).toEqual([]);
  });
});

describe('persistRun / buildRunSnapshot — direct calls', () => {
  const graph = [
    { type: 'step', step: { id: 'a' } },
    { type: 'step', step: { id: 'b' } },
    { type: 'step', step: { id: 'c' } },
  ];
  const recordA: StepRecord = { status: 'success', payload: { n: 1 }, output: { n: 2 }, startedAt: 1, endedAt: 2 };
  const result = (status: FormattedResult['status'], stepExecutionPath: string[]): FormattedResult =>
    ({ status, steps: {}, input: { n: 1 }, stepExecutionPath, ...(status === 'success' ? { result: { n: 2 } } : {}) }) as FormattedResult;
  const ctxOf = (outcome: RunOutcome, stepExecutionPath: string[] = ['a'], records: ReadonlyMap<string, StepRecord> = new Map([['a', recordA]])): Extract<PersistContext, { phase: 'terminal' }> => ({
    workflowId: 'w',
    runId: 'r',
    input: { n: 1 },
    state: {},
    phase: 'terminal',
    report: { outcome, stepResults: records } satisfies RunReport,
    result: result(outcome.status === 'stranded' ? 'failed' : outcome.status, stepExecutionPath),
    serializedStepGraph: graph,
    requestContext: new RequestContext(),
  });
  const success = ctxOf({ status: 'success', output: { n: 2 } });

  /** An engine with a registered Mastra whose store records what it is asked to write. */
  function recordingEngine(options?: EngineOptions): { engine: PetriExecutionEngine; writes: unknown[]; asked: WorkflowRunStatus[] } {
    const writes: unknown[] = [];
    const asked: WorkflowRunStatus[] = [];
    const engine = new PetriExecutionEngine(options);
    const store = { persistWorkflowSnapshot: async (args: unknown) => void writes.push(args) };
    engine.mastra = { getStorage: () => ({ getStore: async () => store }) } as unknown as Mastra;
    const predicate = engine.options.shouldPersistSnapshot;
    engine.options = {
      ...engine.options,
      shouldPersistSnapshot: (p) => {
        asked.push(p.workflowStatus);
        return predicate?.(p) ?? false;
      },
    };
    return { engine, writes, asked };
  }

  it('an engine with no registered Mastra asks the predicate, then writes nothing and does not throw', async () => {
    const { engine, asked } = recordingEngine();
    engine.mastra = undefined;
    await expect(persistRun(engine, success)).resolves.toBeUndefined();
    expect(asked).toEqual(['success']);
  });

  it('resourceId reaches persistWorkflowSnapshot, and is absent when the run has none', async () => {
    const { engine, writes } = recordingEngine();
    await persistRun(engine, { ...success, resourceId: 'res-9' });
    await persistRun(engine, success);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ workflowName: 'w', runId: 'r', resourceId: 'res-9' });
    expect(writes[1]).not.toHaveProperty('resourceId');
  });

  it('with no persistence predicate at all nothing is written (`handlers/entry.ts:187-192`)', async () => {
    const { engine, writes } = recordingEngine();
    const { shouldPersistSnapshot: _dropped, ...rest } = engine.options;
    engine.options = rest as typeof engine.options;
    await persistRun(engine, success);
    expect(writes).toEqual([]);
  });

  it('a stranded run has no Mastra status and is refused by name', async () => {
    const stranded = ctxOf({ status: 'stranded', places: ['p_x'] });
    expect(() => buildRunSnapshot(stranded, 0)).toThrow(/stranded run: tokens remain in p_x/);
    const { engine, writes } = recordingEngine();
    await expect(persistRun(engine, stranded)).rejects.toThrow(/stranded run/);
    expect(writes).toEqual([]);
  });

  it('stepExecutionPath is the formatted result’s, the single source', () => {
    const s = buildRunSnapshot(ctxOf({ status: 'success', output: 1 }, ['x', 'y', 'z']), 0);
    expect(s.stepExecutionPath).toEqual(['x', 'y', 'z']);
  });

  it('a requestContext without toJSON is read through forEach, without the auth token', () => {
    const rc = new Map<string, unknown>([
      ['tenant', 'acme'],
      [MASTRA_AUTH_TOKEN_KEY, 'secret'],
    ]);
    const s = buildRunSnapshot({ ...success, requestContext: rc }, 0);
    expect(s.requestContext).toEqual({ tenant: 'acme' });
  });

  it('a paused run writes tracingContext {} at the pausing entry', () => {
    const s = buildRunSnapshot(ctxOf({ status: 'paused', stepId: 'b', path: [1] }), 0);
    expect(s).toMatchObject({ status: 'paused', activePaths: [1], tracingContext: {} });
  });

  describe('a canceled run, read from CanceledToken.started', () => {
    type Canceled = Extract<RunOutcome, { status: 'canceled' }>;
    // Written as the kernel is to carry it: `started` beside `origin` (see the report's contract issue).
    const canceled = (origin: Canceled['origin'], started: boolean): RunOutcome => ({ status: 'canceled', ...(origin ? { origin } : {}), started }) as Canceled;

    it('started at entry i (settle stage, sleep mid-wait, loop between iterations): [i], tracingContext {}', () => {
      const s = buildRunSnapshot(ctxOf(canceled({ stepId: 'b', path: [1] }, true)), 7);
      expect(s).toMatchObject({ status: 'canceled', activePaths: [1], tracingContext: {}, timestamp: 7 });
      expect(s.result).toBeUndefined();
      expect(s.error).toBeUndefined();
    });

    it("not started, at the gate of entry i > 0: the previous entry, which ran and saw the abort", () => {
      const s = buildRunSnapshot(ctxOf(canceled({ stepId: 'c', path: [2] }, false)), 0);
      expect(s).toMatchObject({ activePaths: [1], tracingContext: {} });
    });

    it('not started, at the gate of entry 0: [0] and tracingContext undefined (the loop-top check writes the key with no value)', () => {
      const s = buildRunSnapshot(ctxOf(canceled({ stepId: 'a', path: [0] }, false)), 0);
      expect(s.activePaths).toEqual([0]);
      expect(Object.hasOwn(s, 'tracingContext')).toBe(true);
      expect(s.tracingContext).toBeUndefined();
    });

    it('a gate below the top level is inside a begun entry: that entry', () => {
      const s = buildRunSnapshot(ctxOf(canceled({ stepId: 'b', path: [1, 0] }, false)), 0);
      expect(s).toMatchObject({ activePaths: [1], tracingContext: {} });
    });

    it('no origin (the final settle, after the last entry): the last entry, tracingContext {}', () => {
      const s = buildRunSnapshot(ctxOf(canceled(undefined, true)), 0);
      expect(s).toMatchObject({ activePaths: [2], tracingContext: {} });
    });

    it("a sleep canceled mid-wait keeps its 'waiting' record in context", () => {
      const waiting: StepRecord = { status: 'waiting', payload: { n: 2 }, startedAt: 5 };
      const s = buildRunSnapshot(ctxOf(canceled({ stepId: 'b', path: [1] }, true), ['a', 'b'], new Map<string, StepRecord>([['a', recordA], ['b', waiting]])), 0);
      expect(s.context['b']).toEqual({ status: 'waiting', payload: { n: 2 }, startedAt: 5 });
    });
  });

  it("resumeLabels are the run's, as the runner collected them, and {} when none are given", () => {
    const labels = { L1: { stepId: 'b' } };
    const suspended = ctxOf({ status: 'suspended', stepId: 'b', path: [1], payload: {} });
    expect(buildRunSnapshot({ ...suspended, resumeLabels: labels }, 0).resumeLabels).toEqual(labels);
    expect(buildRunSnapshot(suspended, 0).resumeLabels).toEqual({});
  });
});

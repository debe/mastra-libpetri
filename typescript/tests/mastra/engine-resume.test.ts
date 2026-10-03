import { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import { InMemoryStore } from '@mastra/core/storage';
import { createStep, createWorkflow, DefaultExecutionEngine } from '@mastra/core/workflows';
import type { ExecutionEngine, WorkflowRunState } from '@mastra/core/workflows';
import { vi } from 'vitest';
import { z } from 'zod';
import { compile } from '../../src/compiler/compile.js';
import type { CompiledWorkflow } from '../../src/compiler/types.js';
import { adaptExecutionGraph } from '../../src/mastra/adapt.js';
import { PetriExecutionEngine, UnsupportedRunModeError } from '../../src/mastra/engine.js';
import * as persist from '../../src/mastra/persist.js';
import { describeReport, segmentLabel, segmentsFor, verifyWorkflow } from '../../src/verify/index.js';

// persistRun is observed, never replaced: every call goes through to persist.ts's implementation.
vi.mock('../../src/mastra/persist.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/mastra/persist.js')>();
  return { ...actual, persistRun: vi.fn(actual.persistRun) };
});

/**
 * Resume on the petri engine against the default engine as the oracle ([ADR 0007]): real Mastra
 * workflows, suspended with `run.start()` and continued with Mastra's own `run.resume({ step,
 * resumeData })`, through a real `Mastra` with an `InMemoryStore`. What is compared, phase by
 * phase: the value `start()` / `resume()` returns, and the `WorkflowRunState` stored after it.
 * Only what the clock stamps and the run id are masked.
 *
 * Four routes per shape: both phases on the default engine (the oracle), both on the petri engine,
 * and crossed both ways — the snapshot is the only thing handed across, so a run suspended under one
 * engine resumes under the other. Each phase runs on a **fresh** engine instance (another process,
 * as far as the engine can tell) unless a test says otherwise.
 *
 * Every shape's net is proven too: `verifyWorkflow` with its default segments — `closed`,
 * `cancel`, and `resume@s` / `resume@s+cancel` for every registered site — after its structural
 * checks (cancel, budget, resume gates, threshold arcs, suspension coverage, resume timing), each
 * property asserted `proven` by name.
 */

const num = z.object({ n: z.number() });
const resumeSchema = z.object({ add: z.number() });
const suspendSchema = z.object({ ask: z.string() });

const plus1 = createStep({ id: 'plus1', inputSchema: num, outputSchema: num, execute: async ({ inputData }) => ({ n: inputData.n + 1 }) });
const times10 = createStep({ id: 'times10', inputSchema: num, outputSchema: num, execute: async ({ inputData }) => ({ n: inputData.n * 10 }) });

/** Suspends until resumed, then adds the resume data to its input. */
const gate = (id: string) =>
  createStep({
    id,
    inputSchema: num,
    outputSchema: num,
    resumeSchema,
    suspendSchema,
    execute: async ({ inputData, resumeData, suspend }) => {
      if (!resumeData) return suspend({ ask: id });
      return { n: inputData.n + resumeData.add };
    },
  });

/** Suspends again unless resumed with `add: 2` — a resumed step that suspends a second time. */
const stubborn = createStep({
  id: 'stubborn',
  inputSchema: num,
  outputSchema: num,
  resumeSchema,
  suspendSchema,
  execute: async ({ inputData, resumeData, suspendData, suspend }) => {
    if (resumeData?.add !== 2) return suspend({ ask: `again after ${JSON.stringify(suspendData ?? null)}` });
    return { n: inputData.n + resumeData.add };
  },
});

type Engine = 'default' | 'petri';

interface EngineConfig {
  readonly iterationBound?: number;
  readonly concurrency?: number;
}

/** One workflow shape, buildable on either engine. The id is the storage key both engines share. */
interface Shape {
  readonly id: string;
  readonly engine?: EngineConfig;
  readonly build: (cfg: object) => { commit(): unknown } | unknown;
}

function workflowOn(shape: Shape, engine: Engine, config: EngineConfig = shape.engine ?? {}): AnyWorkflow {
  const cfg = engine === 'petri' ? { executionEngine: new PetriExecutionEngine({ ...config }) } : {};
  return shape.build(cfg) as AnyWorkflow;
}

type AnyWorkflow = ReturnType<typeof linearShape.build> & {
  id: string;
  buildExecutionGraph(): Parameters<typeof adaptExecutionGraph>[0];
};

const linearShape = {
  id: 'r-linear',
  build: (cfg: object) =>
    createWorkflow({ id: 'r-linear', inputSchema: num, outputSchema: num, ...cfg }).then(plus1).then(gate('g')).then(times10).commit(),
} satisfies Shape;

const lastShape: Shape = {
  id: 'r-last',
  build: (cfg) => createWorkflow({ id: 'r-last', inputSchema: num, outputSchema: num, ...cfg }).then(plus1).then(gate('g')).commit(),
};

/** What `.parallel()` hands the next step: each arm's output under its id. */
const armsOut = z.record(z.string(), num);
const sumOf = (id: string) =>
  createStep({
    id,
    inputSchema: armsOut,
    outputSchema: num,
    execute: async ({ inputData }) => ({ n: Object.values(inputData).reduce((acc, { n }) => acc + n, 0) }),
  });
const sumAB = sumOf('sum');

const parallelShape: Shape = {
  id: 'r-parallel',
  build: (cfg) =>
    createWorkflow({ id: 'r-parallel', inputSchema: num, outputSchema: num, ...cfg })
      .then(plus1)
      .parallel([gate('a'), gate('b')])
      .then(sumAB)
      .commit(),
};

const sumMixed = sumOf('sumMixed');
const mixedParallelShape: Shape = {
  id: 'r-mixed',
  build: (cfg) =>
    createWorkflow({ id: 'r-mixed', inputSchema: num, outputSchema: num, ...cfg })
      .parallel([times10, gate('g')])
      .then(sumMixed)
      .commit(),
};

const branchShape: Shape = {
  id: 'r-branch',
  build: (cfg) =>
    createWorkflow({ id: 'r-branch', inputSchema: num, outputSchema: z.any(), ...cfg })
      .then(plus1)
      .branch([
        [async ({ inputData }) => inputData.n > 0, gate('ba')],
        [async ({ inputData }) => inputData.n < 0, times10],
      ])
      .commit(),
};

/** Suspends on the iteration whose input is 2; every iteration adds one. */
const loopBody = createStep({
  id: 'body',
  inputSchema: num,
  outputSchema: num,
  resumeSchema,
  suspendSchema,
  execute: async ({ inputData, resumeData, suspend }) => {
    if (inputData.n === 2 && !resumeData) return suspend({ ask: 'body' });
    return { n: inputData.n + 1 + (resumeData?.add ?? 0) };
  },
});
const loopShape: Shape = {
  id: 'r-loop',
  engine: { iterationBound: 10 },
  build: (cfg) =>
    createWorkflow({ id: 'r-loop', inputSchema: num, outputSchema: num, ...cfg })
      .dountil(loopBody, async ({ inputData }) => inputData.n >= 6)
      .then(times10)
      .commit(),
};

const twiceShape: Shape = {
  id: 'r-twice',
  build: (cfg) => createWorkflow({ id: 'r-twice', inputSchema: num, outputSchema: num, ...cfg }).then(plus1).then(stubborn).then(times10).commit(),
};

/** A nested workflow whose inner step suspends; the inner workflow runs on the same kind of engine. */
const nestedShape: Shape = {
  id: 'r-nested',
  build: (cfg) => {
    const inner = createWorkflow({ id: 'r-inner', inputSchema: num, outputSchema: num, ...cfg }).then(gate('ig')).commit();
    return createWorkflow({ id: 'r-nested', inputSchema: num, outputSchema: num, ...cfg }).then(plus1).then(inner).then(times10).commit();
  },
};

// ---------------------------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------------------------

/** A run of a registered workflow, as these tests drive it: `start()` and `resume()`. */
interface AnyRun {
  readonly runId: string;
  start(args: object): Promise<unknown>;
  resume(args: object): Promise<unknown>;
}

/** A workflow registered on a `Mastra` over `storage`, as Mastra hands it back. */
interface Registered {
  createRun(options: { runId: string }): Promise<AnyRun>;
  readonly executionEngine: ExecutionEngine;
  readonly serializedStepGraph: unknown;
  buildExecutionGraph(): unknown;
}

/**
 * Registers `wf` on a new `Mastra` over `storage` — one per engine instance, so a new one stands
 * for another process. The workflow map's type is erased: the shapes here differ in their types.
 */
function register(storage: InMemoryStore, wf: AnyWorkflow): Registered {
  const mastra = new Mastra({ storage, workflows: { wf } as never, logger: false });
  return (mastra as unknown as { getWorkflow(key: string): Registered }).getWorkflow('wf');
}

interface ResumeCall {
  readonly step?: string | string[];
  readonly resumeData: unknown;
  readonly forEachIndex?: number;
}

interface Route {
  readonly suspendOn: Engine;
  readonly resumeOn: Engine;
  /** `same`: every phase on one engine instance (one process); `fresh`: a new instance per phase. */
  readonly process?: 'same' | 'fresh';
  readonly config?: EngineConfig;
}

interface Trace {
  readonly results: unknown[];
  readonly snapshots: (WorkflowRunState | null)[];
}

async function load(storage: InMemoryStore, workflowName: string, runId: string): Promise<WorkflowRunState | null> {
  const store = await storage.getStore('workflows');
  if (!store) throw new Error('InMemoryStore has no workflows store');
  return store.loadWorkflowSnapshot({ workflowName, runId });
}

/**
 * Runs `start()` then each `resume()` in turn, on the route's engines, recording what each returns
 * and the snapshot stored after it. Asserts per phase that the phase ran on its own engine and never
 * on the other: a petri side that silently fell back to the default engine would otherwise pass
 * every comparison here.
 */
async function drive(shape: Shape, route: Route, resumes: readonly ResumeCall[]): Promise<Trace> {
  const storage = new InMemoryStore();
  const runId = `${shape.id}-run`;
  const config = route.config ?? shape.engine ?? {};
  const same = route.process === 'same' && route.suspendOn === route.resumeOn;
  const shared = register(storage, workflowOn(shape, route.suspendOn, config));
  const mastraFor = (engine: Engine): Registered =>
    same ? shared : register(storage, workflowOn(shape, engine, config));

  const results: unknown[] = [];
  const snapshots: (WorkflowRunState | null)[] = [];
  const phase = async (engine: Engine, mastra: Registered, act: (run: AnyRun) => Promise<unknown>) => {
    const petri = vi.spyOn(PetriExecutionEngine.prototype, 'execute');
    const dflt = vi.spyOn(DefaultExecutionEngine.prototype, 'execute');
    try {
      const run = await mastra.createRun({ runId });
      results.push(await act(run));
      const own = (engine === 'petri' ? petri : dflt).mock.calls.filter(([p]) => p.workflowId === shape.id).length;
      const other = (engine === 'petri' ? dflt : petri).mock.calls.filter(([p]) => p.workflowId === shape.id).length;
      expect({ engine, own: own >= 1, other }).toEqual({ engine, own: true, other: 0 });
    } finally {
      petri.mockRestore();
      dflt.mockRestore();
    }
    snapshots.push(await load(storage, shape.id, runId));
  };

  await phase(route.suspendOn, shared, (run) => run.start({ inputData: { n: 1 } }));
  for (const call of resumes) {
    await phase(route.resumeOn, mastraFor(route.resumeOn), (run) =>
      run.resume({
        ...(call.step === undefined ? {} : { step: call.step }),
        resumeData: call.resumeData,
        ...(call.forEachIndex === undefined ? {} : { forEachIndex: call.forEachIndex }),
      } as never),
    );
  }
  return { results, snapshots };
}

const MASKED = new Set(['timestamp', 'startedAt', 'endedAt', 'suspendedAt', 'resumedAt', 'runId', 'traceId', 'spanId']);

/** What a JSON-backed store would hand back, with the clock's values and the run ids masked. */
function comparable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, v: unknown) => (MASKED.has(key) ? '<masked>' : v)) ?? 'null');
}

/** Phase by phase, field by field — a failure names the phase and the field — then whole. */
function expectSameTrace(actual: Trace, oracle: Trace): void {
  expect(actual.results.length).toBe(oracle.results.length);
  oracle.results.forEach((expected, i) => {
    const a = comparable(actual.results[i]) as Record<string, unknown>;
    const d = comparable(expected) as Record<string, unknown>;
    for (const field of new Set([...Object.keys(a), ...Object.keys(d)])) expect([`result ${i}`, field, a[field]]).toEqual([`result ${i}`, field, d[field]]);
    const sa = comparable(actual.snapshots[i]) as Record<string, unknown>;
    const sd = comparable(oracle.snapshots[i]) as Record<string, unknown>;
    for (const field of new Set([...Object.keys(sa), ...Object.keys(sd)])) expect([`snapshot ${i}`, field, sa[field]]).toEqual([`snapshot ${i}`, field, sd[field]]);
  });
  expect(comparable(actual)).toEqual(comparable(oracle));
}

/** Every route, compared with the oracle; the oracle is returned for shape-specific assertions. */
async function allRoutes(shape: Shape, resumes: readonly ResumeCall[], config?: EngineConfig): Promise<Trace> {
  const oracle = await drive(shape, { suspendOn: 'default', resumeOn: 'default' }, resumes);
  const withConfig = config === undefined ? {} : { config };
  for (const route of [
    { suspendOn: 'petri', resumeOn: 'petri' },
    { suspendOn: 'petri', resumeOn: 'petri', process: 'same' },
    { suspendOn: 'default', resumeOn: 'petri' },
    { suspendOn: 'petri', resumeOn: 'default' },
  ] as const) {
    const trace = await drive(shape, { ...route, ...withConfig }, resumes);
    expectSameTrace(trace, oracle);
  }
  return oracle;
}

// ---------------------------------------------------------------------------------------------
// Proofs
// ---------------------------------------------------------------------------------------------

function compiledFor(shape: Shape, config: EngineConfig = shape.engine ?? {}): CompiledWorkflow {
  const wf = workflowOn(shape, 'petri', config);
  const description = adaptExecutionGraph(wf.buildExecutionGraph(), config.iterationBound === undefined ? {} : { iterationBound: config.iterationBound });
  return compile(description, config.concurrency === undefined ? {} : { concurrency: config.concurrency });
}

/**
 * Every segment `verifyWorkflow` proves by default — `closed`, `cancel`, and both resume segments of
 * every site — with every property in it `proven`, asserted by name so `unknown` cannot pass.
 */
async function expectProven(compiled: CompiledWorkflow, sites: readonly string[]): Promise<void> {
  expect([...compiled.resumeSites.keys()].sort()).toEqual([...sites].sort());
  const reports = await verifyWorkflow(compiled, { timeoutMs: 30_000 });
  const routes = reports.map(describeReport).join('\n');
  console.log(`[proof] ${compiled.net.name} k=${compiled.budget?.k ?? 'unbounded'}:\n${routes}`);
  const labels = segmentsFor(compiled).map(segmentLabel);
  expect(labels).toEqual(['closed', 'cancel', ...[...sites].sort().flatMap((s) => [`resume@${s}`, `resume@${s}+cancel`])]);
  const properties = ['deadlockFree', 'terminatesAtSink', 'exactlyOneTerminal', ...(compiled.budget ? ['permitsBounded', 'permitsReturned'] : [])];
  const expected: Record<string, string> = {};
  for (const label of labels) {
    for (const p of properties) expected[`${label}/${p}`] = 'proven';
    if (!label.endsWith('cancel')) expected[`${label}/neverCanceled`] = 'proven';
  }
  const verdicts = Object.fromEntries(reports.map((r) => [`${segmentLabel(r.segment)}/${r.property}`, r.result.verdict.type]));
  expect(verdicts, routes).toEqual(expected);
}

afterEach(() => {
  vi.mocked(persist.persistRun).mockClear();
});

// ---------------------------------------------------------------------------------------------
// Constructs
// ---------------------------------------------------------------------------------------------

describe('resume on the petri engine, against the default engine, every route', () => {
  it('a top-level step: resumed with its stored input, the rest runs, stepExecutionPath continues', async () => {
    const oracle = await allRoutes(linearShape, [{ step: 'g', resumeData: { add: 5 } }]);
    expect(oracle.results[1]).toMatchObject({ status: 'success', result: { n: 70 }, stepExecutionPath: ['plus1', 'g', 'times10'] });
    expect(oracle.snapshots[1]).toMatchObject({ status: 'success', suspendedPaths: {} });
    await expectProven(compiledFor(linearShape), ['0', '1', '2']);
  }, 180_000);

  it('the last entry resumed: the result is its output', async () => {
    const oracle = await allRoutes(lastShape, [{ step: 'g', resumeData: { add: 5 } }]);
    expect(oracle.results[1]).toMatchObject({ status: 'success', result: { n: 7 }, stepExecutionPath: ['plus1', 'g'] });
    await expectProven(compiledFor(lastShape), ['0', '1']);
  }, 180_000);

  it('a resumed step that suspends again: the record and suspendedPaths are rewritten, and a second resume finishes', async () => {
    const oracle = await allRoutes(twiceShape, [
      { step: 'stubborn', resumeData: { add: 1 } },
      { step: 'stubborn', resumeData: { add: 2 } },
    ]);
    expect(oracle.results.map((r) => (r as { status: string }).status)).toEqual(['suspended', 'suspended', 'success']);
    expect(oracle.snapshots[1]).toMatchObject({ suspendedPaths: { stubborn: [1] } });
    expect(oracle.results[2]).toMatchObject({ result: { n: 40 } });
    await expectProven(compiledFor(twiceShape), ['0', '1', '2']);
  }, 180_000);

  it('a .parallel() with two suspended arms: resuming one re-suspends listing the other, resuming that one finishes', async () => {
    const oracle = await allRoutes(parallelShape, [
      { step: 'a', resumeData: { add: 1 } },
      { step: 'b', resumeData: { add: 2 } },
    ]);
    expect(oracle.results[0]).toMatchObject({ status: 'suspended', suspended: [['a'], ['b']] });
    expect(oracle.snapshots[0]).toMatchObject({ suspendedPaths: { a: [1, 0], b: [1, 1] } });
    expect(oracle.results[1]).toMatchObject({ status: 'suspended', suspended: [['b']] });
    expect(oracle.snapshots[1]).toMatchObject({ suspendedPaths: { b: [1, 1] } });
    expect(oracle.results[2]).toMatchObject({ status: 'success', result: { n: 7 } });
    await expectProven(compiledFor(parallelShape), ['0', '1.0', '1.1', '2']);
  }, 300_000);

  it('a .parallel() arm beside a finished sibling: the sibling is not re-run, its output is reused', async () => {
    const oracle = await allRoutes(mixedParallelShape, [{ step: 'g', resumeData: { add: 3 } }]);
    expect(oracle.results[1]).toMatchObject({ status: 'success', result: { n: 14 } });
    await expectProven(compiledFor(mixedParallelShape), ['0.0', '0.1', '1']);
  }, 300_000);

  it('a .branch() arm: the conditions are not re-evaluated, the untaken arm stays unrun', async () => {
    const oracle = await allRoutes(branchShape, [{ step: 'ba', resumeData: { add: 4 } }]);
    expect(oracle.results[1]).toMatchObject({ status: 'success', result: { ba: { n: 6 } } });
    await expectProven(compiledFor(branchShape), ['0', '1.0', '1.1']);
  }, 300_000);

  it('a loop body at iteration n: n re-runs with the resume data, n+1 onward fresh', async () => {
    const oracle = await allRoutes(loopShape, [{ step: 'body', resumeData: { add: 0 } }]);
    expect(oracle.results[1]).toMatchObject({ status: 'success', result: { n: 60 } });
    await expectProven(compiledFor(loopShape), ['0', '1']);
  }, 300_000);

  it('a nested workflow: the outer step resumes the child from its own snapshot', async () => {
    const oracle = await allRoutes(nestedShape, [{ step: ['r-inner', 'ig'], resumeData: { add: 5 } }]);
    expect(oracle.results[0]).toMatchObject({ status: 'suspended', suspended: [['r-inner', 'ig']] });
    expect(oracle.results[1]).toMatchObject({ status: 'success', result: { n: 70 } });
    await expectProven(compiledFor(nestedShape), ['0', '1', '2']);
  }, 180_000);

  it.each([1, 2])('under a run budget of %i the resumed runs are the default engine\'s, and the budgeted net is proven', async (k) => {
    await allRoutes(parallelShape, [
      { step: 'b', resumeData: { add: 2 } },
      { step: 'a', resumeData: { add: 1 } },
    ], { concurrency: k });
    await expectProven(compiledFor(parallelShape, { concurrency: k }), ['0', '1.0', '1.1', '2']);
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------
// A resume whose signal had already fired
// ---------------------------------------------------------------------------------------------

describe('a resume aborted before it began: the loop-top check at resumePath[0] (default.ts:811-835)', () => {
  type SpanCall = { readonly method: string; readonly args: unknown };

  /**
   * Suspends on `engine` through `Run.start()`, then calls that engine's `execute()` directly with
   * the parameter `Run._resume` builds (`workflow.ts:4807-4828`) and a controller already aborted —
   * `Run` offers no way to abort a resume before it begins. Returns what `execute()` resolved to,
   * the snapshot it left and every call on the run span.
   */
  async function abortedResume(shape: Shape, engine: Engine, step: string): Promise<{ result: unknown; snapshot: WorkflowRunState | null; span: SpanCall[] }> {
    const storage = new InMemoryStore();
    const wf = register(storage, workflowOn(shape, engine));
    const run = await wf.createRun({ runId: 'aborted' });
    await run.start({ inputData: { n: 1 } });
    const snap = (await load(storage, shape.id, 'aborted'))!;
    const span: SpanCall[] = [];
    const controller = new AbortController();
    controller.abort();
    const result = await wf.executionEngine.execute({
      workflowId: shape.id,
      runId: 'aborted',
      graph: wf.buildExecutionGraph(),
      serializedStepGraph: wf.serializedStepGraph,
      input: snap.context.input,
      initialState: snap.value,
      resume: {
        steps: [step],
        stepResults: { ...snap.context },
        resumePayload: { add: 1 },
        resumePath: [...(snap.suspendedPaths as Record<string, number[]>)[step]!],
        stepExecutionPath: snap.stepExecutionPath,
      },
      pubsub: (run as unknown as { pubsub: never }).pubsub,
      requestContext: new RequestContext(),
      abortController: controller,
      workflowSpan: {
        end: (args: unknown) => void span.push({ method: 'end', args }),
        error: (args: unknown) => void span.push({ method: 'error', args }),
      },
    } as never);
    return { result, snapshot: await load(storage, shape.id, 'aborted'), span };
  }

  it.each([
    ['an entry site', linearShape, 'g', 1],
    ['an arm site', parallelShape, 'a', 1],
    ['a loop site', loopShape, 'body', 0],
  ] as const)('at %s: canceled with nothing run, as the default engine', async (_what, shape, step, index) => {
    const oracle = await abortedResume(shape, 'default', step);
    const petri = await abortedResume(shape, 'petri', step);
    expect(oracle.result).toMatchObject({ status: 'canceled' });
    // Not vacuous: the oracle wrote the loop-top row — at the resumed index, no tracing context —
    // and the resumed step is still suspended.
    expect(oracle.snapshot).toMatchObject({ status: 'canceled', activePaths: [index], context: { [step]: { status: 'suspended' } } });
    expect(oracle.snapshot!.tracingContext).toBeUndefined();
    // Strict: the loop-top end passes no `output` key, where the terminal branch passes
    // `output: undefined` (default.ts:815-829 against :969-983) — toEqual cannot tell them apart.
    expect(oracle.span).toStrictEqual([{ method: 'end', args: { attributes: { status: 'canceled' } } }]);
    expect(comparable(petri.result)).toEqual(comparable(oracle.result));
    expect(comparable(petri.snapshot)).toEqual(comparable(oracle.snapshot));
    // Key for key as InMemoryStore holds it, before any serialisation: the loop-top write's
    // `tracingContext` is present and undefined on both engines (handlers/entry.ts:209-227).
    expect(Object.keys(petri.snapshot!).sort()).toStrictEqual(Object.keys(oracle.snapshot!).sort());
    expect(Object.hasOwn(oracle.snapshot!, 'tracingContext')).toBe(true);
    expect(petri.span).toStrictEqual(oracle.span);
  });
});

// ---------------------------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------------------------

describe('resume persistence', () => {
  const phases = () =>
    vi.mocked(persist.persistRun).mock.calls.map(([, ctx]) => ({ phase: ctx.phase, status: ctx.phase === 'terminal' ? ctx.result.status : 'running' }));

  /** Every snapshot written to storage for the run, in order, as the store received it. */
  async function writesDuring<T>(storage: InMemoryStore, act: () => Promise<T>): Promise<{ value: T; writes: WorkflowRunState[] }> {
    const store = (await storage.getStore('workflows'))!;
    const spy = vi.spyOn(store, 'persistWorkflowSnapshot');
    try {
      const value = await act();
      return { value, writes: spy.mock.calls.map(([arg]) => structuredClone(arg.snapshot)) };
    } finally {
      spy.mockRestore();
    }
  }

  it('same engine instance: the resume-start write is suppressed while the run was last written suspended (entry.ts:195-205)', async () => {
    const storage = new InMemoryStore();
    const mastra = register(storage, workflowOn(linearShape, 'petri'));
    const run = await mastra.createRun({ runId: 'guard' });
    await run.start({ inputData: { n: 1 } });
    vi.mocked(persist.persistRun).mockClear();
    const { writes } = await writesDuring(storage, () => run.resume({ step: 'g', resumeData: { add: 5 } }));

    expect(phases()).toEqual([
      { phase: 'resume-start', status: 'running' },
      { phase: 'terminal', status: 'success' },
    ]);
    // Only the terminal reaches the store: the `running` write was skipped by the guard.
    expect(writes.map((w) => w.status)).toEqual(['success']);
  });

  it('the oracle agrees: the default engine in one process writes no running row on resume either', async () => {
    const storage = new InMemoryStore();
    const mastra = register(storage, workflowOn(linearShape, 'default'));
    const run = await mastra.createRun({ runId: 'guard-default' });
    await run.start({ inputData: { n: 1 } });
    const { writes } = await writesDuring(storage, () => run.resume({ step: 'g', resumeData: { add: 5 } }));
    expect(writes.map((w) => w.status)).toEqual(['success']);
  });

  it('a fresh engine instance: the resume-start write carries the stored context whole, clears suspendedPaths, continues stepExecutionPath', async () => {
    const storage = new InMemoryStore();
    const first = register(storage, workflowOn(linearShape, 'petri'));
    await (await first.createRun({ runId: 'fresh' })).start({ inputData: { n: 1 } });
    const suspended = (await load(storage, 'r-linear', 'fresh'))!;

    const second = register(storage, workflowOn(linearShape, 'petri'));
    const run = await second.createRun({ runId: 'fresh' });
    const { writes } = await writesDuring(storage, () => run.resume({ step: 'g', resumeData: { add: 5 } }));

    expect(writes.map((w) => w.status)).toEqual(['running', 'success']);
    const start = writes[0]!;
    expect(start.context).toEqual(suspended.context);
    expect(Object.keys(start.context)).toEqual(Object.keys(suspended.context));
    expect(start).toMatchObject({ suspendedPaths: {}, resumeLabels: {}, activePaths: [1], stepExecutionPath: ['plus1', 'g'] });
    // The terminal write carries the stored records beside the new ones — never `{ input }` alone.
    expect(Object.keys(writes[1]!.context)).toEqual(['input', 'plus1', 'g', 'times10']);
  });

  it('the overwrite guard keeps a suspended run\'s entry for the resume, and drops it once the run ends otherwise (default.ts:1010-1018)', async () => {
    // The guard's map is private; it is found as the Map that receives this run's statuses.
    const sets: { map: Map<unknown, unknown>; key: unknown; value: unknown }[] = [];
    const realSet = Map.prototype.set;
    const spy = vi.spyOn(Map.prototype, 'set').mockImplementation(function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
      sets.push({ map: this, key, value });
      return realSet.call(this, key, value);
    });
    try {
      const storage = new InMemoryStore();
      const mastra = register(storage, workflowOn(linearShape, 'petri'));
      const run = await mastra.createRun({ runId: 'dropped' });
      await run.start({ inputData: { n: 1 } });
      const guards = [...new Set(sets.filter((e) => e.key === 'dropped' && e.value === 'suspended').map((e) => e.map))];
      expect(guards).toHaveLength(1);
      const guard = guards[0]!;
      // Suspended: kept, so the same-instance resume's running write is skipped.
      expect(guard.get('dropped')).toBe('suspended');
      const result = await run.resume({ step: 'g', resumeData: { add: 5 } });
      expect(result).toMatchObject({ status: 'success' });
      // The terminal write was recorded on this guard, then the entry dropped.
      expect(sets.filter((e) => e.map === guard && e.key === 'dropped').map((e) => e.value)).toStrictEqual(['running', 'suspended', 'success']);
      expect(guard.has('dropped')).toBe(false);
      expect(guard.size).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('the suspended snapshot carries the run span ids so a resume links back (default.ts:938-950)', async () => {
    const storage = new InMemoryStore();
    const wf = workflowOn(linearShape, 'petri');
    const mastra = register(storage, wf);
    const run = await mastra.createRun({ runId: 'traced' });
    const engine = mastra.executionEngine;
    const span = {
      traceId: 'trace-1',
      id: 'raw-span',
      getExportedSpanId: () => 'exported-span',
      getParentSpanId: () => 'parent-span',
      end: () => undefined,
      error: () => undefined,
    };
    await engine.execute({
      workflowId: 'r-linear',
      runId: 'traced',
      graph: mastra.buildExecutionGraph(),
      serializedStepGraph: mastra.serializedStepGraph,
      input: { n: 1 },
      pubsub: (run as unknown as { pubsub: never }).pubsub,
      requestContext: new RequestContext(),
      abortController: new AbortController(),
      workflowSpan: span as never,
    } as never);
    const snapshot = await load(storage, 'r-linear', 'traced');
    expect(snapshot).toMatchObject({ status: 'suspended', tracingContext: { traceId: 'trace-1', spanId: 'exported-span', parentSpanId: 'parent-span' } });
  });
});

// ---------------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------------

describe('a refused resume persists nothing, and Run releases its claim', () => {
  /**
   * The pinned invariant (workflow.ts:4760-4806,4846-4849): the engine refuses **before** its first
   * write, so storage still shows the claimed suspension untouched, `Run`'s `.catch` rolls the claim
   * back to `suspended`, and the run can be resumed again — here on the default engine.
   */
  async function refusedThenRescued(
    suspendShape: Shape,
    resumeShape: Shape,
    call: ResumeCall & { readonly perStep?: boolean },
  ): Promise<{ error: unknown; before: WorkflowRunState; after: WorkflowRunState; claims: unknown[]; rescued: unknown }> {
    const storage = new InMemoryStore();
    const first = register(storage, workflowOn(suspendShape, 'petri'));
    await (await first.createRun({ runId: 'refused' })).start({ inputData: { n: 1 } });
    const before = (await load(storage, suspendShape.id, 'refused'))!;

    const store = (await storage.getStore('workflows'))!;
    const claims = vi.spyOn(store, 'updateWorkflowState');
    vi.mocked(persist.persistRun).mockClear();
    const second = register(storage, workflowOn(resumeShape, 'petri'));
    const run = await second.createRun({ runId: 'refused' });
    const error = await run
      .resume({ step: call.step, resumeData: call.resumeData, ...(call.perStep ? { perStep: true } : {}) } as never)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(vi.mocked(persist.persistRun).mock.calls).toEqual([]);
    const after = (await load(storage, suspendShape.id, 'refused'))!;
    const claimCalls = claims.mock.calls.map(([arg]) => arg.opts);
    claims.mockRestore();

    const rescue = register(storage, workflowOn(suspendShape, 'default'));
    const rescued = await (await rescue.createRun({ runId: 'refused' })).resume({
      step: call.step,
      resumeData: call.resumeData,
    } as never);
    return { error, before, after, claims: claimCalls, rescued };
  }

  const pairOf = createStep({
    id: 'pair',
    inputSchema: num,
    outputSchema: z.array(num),
    execute: async ({ inputData }) => [{ n: inputData.n }, { n: inputData.n + 1 }],
  });
  const foreachShape: Shape = {
    id: 'r-foreach',
    build: (cfg) =>
      createWorkflow({ id: 'r-foreach', inputSchema: num, outputSchema: z.array(num), ...cfg })
        .then(pairOf)
        .foreach(gate('item'), { concurrency: 2 })
        .commit(),
  };

  it('a .foreach() resumes on every route as on the default engine: no forEachIndex feeds every suspended item', async () => {
    const oracle = await allRoutes(foreachShape, [{ step: 'item', resumeData: { add: 5 } }]);
    expect(oracle.results.map((r) => (r as { status: string }).status)).toEqual(['suspended', 'success']);
    expect((oracle.results[1] as { result: unknown }).result).toEqual([{ n: 6 }, { n: 7 }]);
  });

  it('a .foreach() resumed item by item: the named one runs, the other stays parked, then finishes it', async () => {
    const oracle = await allRoutes(foreachShape, [
      { step: 'item', resumeData: { add: 5 }, forEachIndex: 1 },
      { step: 'item', resumeData: { add: 7 }, forEachIndex: 0 },
    ]);
    expect(oracle.results.map((r) => (r as { status: string }).status)).toEqual(['suspended', 'suspended', 'success']);
    expect((oracle.results[2] as { result: unknown }).result).toEqual([{ n: 8 }, { n: 7 }]);
  });

  it('a .foreach() at run budget 1 resumes as on the default engine', async () => {
    await allRoutes(foreachShape, [{ step: 'item', resumeData: { add: 5 }, forEachIndex: 0 }, { step: 'item', resumeData: { add: 1 }, forEachIndex: 1 }], { concurrency: 1 });
  });

  it('a workflow changed since the run suspended: refused by name, the suspension stays, the default engine then resumes it', async () => {
    const changed: Shape = {
      id: 'r-linear',
      build: (cfg) =>
        createWorkflow({ id: 'r-linear', inputSchema: num, outputSchema: num, ...cfg }).then(plus1).then(gate('other')).then(times10).commit(),
    };
    const { error, before, after, claims, rescued } = await refusedThenRescued(linearShape, changed, { step: 'g', resumeData: { add: 5 } });

    expect(error).toBeInstanceOf(UnsupportedRunModeError);
    expect((error as UnsupportedRunModeError).resume).toEqual({ stepId: 'g', path: [1], reason: 'id-mismatch' });
    expect((error as Error).message).toBe(
      "PetriExecutionEngine cannot resume step 'g' at [1] (workflow 'r-linear', run 'refused'): the workflow changed since the run suspended",
    );
    // Claimed `running`, then rolled back to `suspended` by Run's release.
    expect(claims).toEqual([
      { status: 'running', expectedStatus: 'suspended' },
      { status: 'suspended', expectedStatus: 'running' },
    ]);
    expect(comparable(after)).toEqual(comparable(before));
    expect(rescued).toMatchObject({ status: 'success', result: { n: 70 } });
  });

  it('perStep on a resume stays refused, before anything is persisted', async () => {
    const { error, before, after, rescued } = await refusedThenRescued(linearShape, linearShape, {
      step: 'g',
      resumeData: { add: 5 },
      perStep: true,
    });
    expect(error).toBeInstanceOf(UnsupportedRunModeError);
    expect((error as UnsupportedRunModeError).mode).toBe('perStep');
    expect(comparable(after)).toEqual(comparable(before));
    expect(rescued).toMatchObject({ status: 'success', result: { n: 70 } });
  });

  it('restart and timeTravel stay refused by name', async () => {
    const wf = workflowOn(linearShape, 'petri');
    const engine = (wf as unknown as { executionEngine: ExecutionEngine }).executionEngine;
    const base = {
      workflowId: 'r-linear',
      runId: 'x',
      graph: wf.buildExecutionGraph(),
      serializedStepGraph: [],
      input: { n: 1 },
      pubsub: {},
      requestContext: new RequestContext(),
      abortController: new AbortController(),
      resume: { steps: ['g'], stepResults: {}, resumePayload: {}, resumePath: [1] },
    };
    for (const [mode, extra] of [
      ['restart', { restart: { activePaths: [0], activeStepsPath: {}, stepResults: {}, state: {} } }],
      ['timeTravel', { timeTravel: { executionPath: [0], steps: ['a'], stepResults: {}, state: {} } }],
    ] as const) {
      const error = await engine.execute({ ...base, ...extra } as never).then(() => undefined, (e: unknown) => e);
      expect(error).toBeInstanceOf(UnsupportedRunModeError);
      expect((error as UnsupportedRunModeError).mode).toBe(mode);
    }
    expect(vi.mocked(persist.persistRun).mock.calls).toEqual([]);
  });

  it('a resumePath naming nothing is refused as no-site, and resumePath is never mutated', async () => {
    const wf = workflowOn(linearShape, 'petri');
    const engine = (wf as unknown as { executionEngine: ExecutionEngine }).executionEngine;
    const resumePath = [7];
    const error = await engine
      .execute({
        workflowId: 'r-linear',
        runId: 'x',
        graph: wf.buildExecutionGraph(),
        serializedStepGraph: [],
        input: { n: 1 },
        pubsub: {},
        requestContext: new RequestContext(),
        abortController: new AbortController(),
        resume: { steps: ['g'], stepResults: { input: { n: 1 } }, resumePayload: {}, resumePath },
      } as never)
      .then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(UnsupportedRunModeError);
    expect((error as UnsupportedRunModeError).resume).toMatchObject({ stepId: 'g', path: [7], reason: 'no-site' });
    expect(resumePath).toEqual([7]);
    expect(vi.mocked(persist.persistRun).mock.calls).toEqual([]);
  });
});

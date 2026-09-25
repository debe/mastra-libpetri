/**
 * The differential corpus: real Mastra workflows, written with Mastra's own `createWorkflow` /
 * `createStep` and zod schemas, each built once per engine so the default engine is the oracle.
 *
 * Every step body is traced: it records a `start` before its code and an `end` after it, whatever
 * the outcome. Labels are the step id, plus the item for a `.foreach()` item and the attempt for a
 * retried step, so the harness can line the two engines' runs up (`src/conformance/differential.ts`).
 *
 * Every observation also records which engine's `execute()` ran it: both engines' prototypes are
 * wrapped for the duration of one observation (observations never overlap), so a nested workflow
 * shows up as a second call, on whichever engine actually ran it.
 *
 * And every event the run publishes: `run.watch()` is subscribed after `createRun()` and before
 * `start()` / `resume()`, and unsubscribed a macrotask after the run settles, so an event published
 * with `void publish(...)` (a writer chunk on a stream, `workflow.ts:4135-4141`) is still caught. A
 * fixture observed `via: 'stream'` runs through `run.stream()` instead and records the chunks of its
 * `fullStream` — what a streaming caller sees, the stream's own `workflow-start` / `workflow-finish`
 * included (`stream/RunOutput.ts:69-150`).
 */
import { z } from 'zod';
import { createStep, createWorkflow, DefaultExecutionEngine } from '@mastra/core/workflows';
import { createTool } from '@mastra/core/tools';
import { TripWire } from '@mastra/core/agent';
import { MastraNonRetryableError } from '@mastra/core/error';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { PetriExecutionEngine } from '../../src/mastra/engine.js';
import { phaseEngine, RESUME_ROUTES, routeLabel, UUID } from '../../src/conformance/differential.js';
import type {
  Attribution,
  DifferentialCase,
  EngineName,
  Execution,
  IndependentPair,
  Observation,
  PhaseObservation,
  ResumeCase,
  ResumeObservation,
  ResumeRoute,
  ResumeRouteLabel,
  TraceEvent,
} from '../../src/conformance/differential.js';

/** The loop bound the petri engine requires and Mastra does not have (`docs/divergences.md` row 13). */
export const ITERATION_BOUND = 20;

/** What a started run offers the harness: Mastra's own `Run`, read structurally. */
interface StartedRun {
  start(args: Record<string, unknown>): Promise<unknown>;
  cancel(): Promise<void>;
  /** `Run.watch` (`workflow.ts:4298-4362`): every event on the run's topic, nested runs' relayed. */
  watch(cb: (event: unknown) => void): () => void;
}

/** `Run.stream` (`workflow.ts:4039-4180`), read structurally: the chunks, then the result. */
interface StreamingRun {
  stream(args: Record<string, unknown>): { readonly fullStream: ReadableStream<unknown>; readonly result: Promise<unknown> };
}

/** Subscribes to the run's events; the returned function waits a macrotask, unsubscribes and returns what arrived. */
function watchEvents(run: StartedRun): () => Promise<unknown[]> {
  const events: unknown[] = [];
  const unwatch = run.watch((event) => {
    events.push(event);
  });
  return async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    unwatch();
    return [...events];
  };
}

/** Runs through `run.stream()`: drains `fullStream` to its end, then awaits the result. */
async function streamRun(run: StartedRun, args: Record<string, unknown>, sink: unknown[]): Promise<unknown> {
  const output = (run as unknown as StreamingRun).stream({ ...args, closeOnSuspend: true });
  const reader = output.fullStream.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    sink.push(next.value);
  }
  return output.result;
}

/** Collects step boundaries in the order step code crossed them, and lets step code cancel its run. */
export class Recorder {
  readonly events: TraceEvent[] = [];
  #run: StartedRun | undefined;

  async around<T>(label: string, body: () => T | Promise<T>): Promise<T> {
    this.events.push({ kind: 'start', label });
    try {
      return await body();
    } finally {
      this.events.push({ kind: 'end', label });
    }
  }

  /** Called by `observe` once the run exists, before it starts. */
  bind(run: StartedRun): void {
    this.#run = run;
  }

  /** `Run.cancel()` on the run being observed, as a caller would call it — from outside the net. */
  cancel(): Promise<void> {
    if (this.#run === undefined) throw new Error('Recorder.cancel() before the run was bound');
    return this.#run.cancel();
  }
}

/** What a built workflow offers the harness: Mastra's own `Workflow`, read structurally. */
interface Runnable {
  createRun(): Promise<StartedRun>;
}

/** The config that picks the engine: nothing for Mastra's own, `executionEngine` for ours. */
export type EngineConfig = Readonly<Record<string, never>> | { readonly executionEngine: PetriExecutionEngine };

/**
 * The run budgets the corpus runs at ([ADR 0006]): the candidate is built with
 * `PetriExecutionEngine({ concurrency: k })`, `undefined` meaning unbounded. The oracle is always
 * Mastra's engine, unchanged — it has no budget.
 */
export const BUDGETS: readonly (number | undefined)[] = [1, 2, 4, undefined];

/**
 * The engine config for one side. `concurrency` is the candidate's run budget, ignored for the
 * oracle: Mastra has no such bound, which is the point of comparing against it.
 */
export function engineConfig(engine: EngineName, concurrency?: number): EngineConfig {
  switch (engine) {
    case 'default':
      return {};
    case 'petri':
      return {
        executionEngine: new PetriExecutionEngine({
          iterationBound: ITERATION_BOUND,
          ...(concurrency === undefined ? {} : { concurrency }),
        }),
      };
    default:
      return assertNever(engine);
  }
}

export interface MastraFixture {
  readonly name: string;
  readonly input: unknown;
  /** The oracle's outcome — its result's `status`, or `rejected` — so a broken fixture cannot pass by failing on both engines. */
  readonly expected: string;
  readonly initialState?: Record<string, unknown>;
  readonly build: (cfg: EngineConfig, rec: Recorder) => Runnable;
  /** Documented differences, each naming its `docs/divergences.md` row. */
  readonly divergences?: readonly Attribution[];
  /**
   * Step pairs the net may reorder or overlap (`docs/divergences.md` row 4). Declared only where
   * the corpus needs it; a weakening on an undeclared pair fails.
   */
  readonly independent?: readonly IndependentPair[];
  /**
   * The most steps the oracle overlaps — a `.parallel()`'s arms, a `.foreach()`'s concurrency — or
   * 1 when absent. A candidate budget below it binds ([ADR 0006]).
   */
  readonly width?: number;
  /**
   * Differences a binding budget causes (k below {@link width}), each naming its row. Declared
   * only for those runs, so an unbounded run that shows one is a finding, and a bound run that
   * stops showing one is a stale attribution.
   */
  readonly boundDivergences?: readonly Attribution[];
  /**
   * How the run is observed: `watch` (the default) runs `start()` and records `run.watch()`;
   * `stream` runs `run.stream()` and records its `fullStream` chunks.
   */
  readonly via?: 'watch' | 'stream';
}

/** The fixture's width: 1 unless it declares one. */
export const widthOf = (f: MastraFixture): number => f.width ?? 1;

/** Whether a candidate budget `k` binds on the fixture: a number below its width. */
export const binds = (f: MastraFixture, k: number | undefined): boolean => k !== undefined && k < widthOf(f);

/**
 * Wraps `proto.execute` so every call is recorded as run by `engine`; returns the undo. Read and
 * written through `Reflect`, because the wrapper sees Mastra's params as `unknown`.
 */
function probeExecute(proto: object, engine: EngineName, sink: Execution[]): () => void {
  const original: unknown = Reflect.get(proto, 'execute');
  if (typeof original !== 'function') throw new Error(`no execute() on the ${engine} engine's prototype`);
  Reflect.set(proto, 'execute', function (this: unknown, ...args: unknown[]): unknown {
    const params = args[0];
    const workflowId = typeof params === 'object' && params !== null ? Reflect.get(params, 'workflowId') : undefined;
    sink.push({ engine, workflowId: typeof workflowId === 'string' ? workflowId : '<unknown>' });
    return Reflect.apply(original, this, args);
  });
  return () => {
    Reflect.set(proto, 'execute', original);
  };
}

/**
 * Builds and runs the fixture on one engine through `Run.start()`, with the state in the result.
 * Building, committing and creating the run are inside the same `try` as `start()`: a throw from
 * any of them is the observation's rejection, never the harness's.
 */
export async function observe(fixture: MastraFixture, engine: EngineName, input: unknown, concurrency?: number): Promise<Observation> {
  const rec = new Recorder();
  const executions: Execution[] = [];
  const undo = [
    probeExecute(PetriExecutionEngine.prototype, 'petri', executions),
    probeExecute(DefaultExecutionEngine.prototype, 'default', executions),
  ];
  const streamed: unknown[] = [];
  let collect: (() => Promise<unknown[]>) | undefined;
  const events = async () => (collect === undefined ? [...streamed] : [...streamed, ...(await collect())]);
  try {
    const wf = fixture.build(engineConfig(engine, concurrency), rec);
    const run = await wf.createRun();
    rec.bind(run);
    const args = {
      inputData: input,
      outputOptions: { includeState: true },
      // A structured clone per engine: the default engine merges state into the object it is handed.
      ...(fixture.initialState === undefined ? {} : { initialState: structuredClone(fixture.initialState) }),
    };
    let result: unknown;
    if (fixture.via === 'stream') {
      result = await streamRun(run, args, streamed);
    } else {
      collect = watchEvents(run);
      result = await run.start(args);
    }
    return { kind: 'resolved', result, trace: [...rec.events], executions: [...executions], events: await events() };
  } catch (error) {
    return { kind: 'rejected', error, trace: [...rec.events], executions: [...executions], events: await events() };
  } finally {
    for (const u of undo.reverse()) u();
  }
}

/** The fixture as a harness case, its candidate built with run budget `concurrency` (absent: unbounded). */
export function toCase(fixture: MastraFixture, concurrency?: number): DifferentialCase {
  return {
    name: fixture.name,
    input: fixture.input,
    run: (engine, input) => observe(fixture, engine, input, concurrency),
    ...(concurrency === undefined ? {} : { concurrency }),
    divergences: [...(fixture.divergences ?? []), ...(binds(fixture, concurrency) ? (fixture.boundDivergences ?? []) : [])],
    ...(fixture.independent === undefined ? {} : { independent: fixture.independent }),
  };
}

// ---------------------------------------------------------------------------------------------
// Schemas and step builders
// ---------------------------------------------------------------------------------------------

const N = z.object({ n: z.number() });
type N = z.infer<typeof N>;
const Seen = z.object({ seen: z.array(z.string()).optional() });

/** `{n} -> {n'}`, traced under its id. The id is kept literal, so `.parallel()` types its record. */
function nStep<const Id extends string>(rec: Recorder, id: Id, fn: (n: number) => number | Promise<number>) {
  return createStep({
    id,
    inputSchema: N,
    outputSchema: N,
    execute: async ({ inputData }) => rec.around(id, async () => ({ n: await fn(inputData.n) })),
  });
}

function boom(rec: Recorder, id: string, message = `${id} failed`) {
  return createStep({
    id,
    inputSchema: N,
    outputSchema: N,
    execute: async (): Promise<N> =>
      rec.around(id, () => {
        throw new Error(message);
      }),
  });
}

const wf = (id: string, cfg: EngineConfig, extra: Record<string, unknown> = {}) =>
  createWorkflow({ id, inputSchema: N, outputSchema: z.any(), ...cfg, ...extra });

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------------------------

export const FIXTURES: readonly MastraFixture[] = [
  {
    name: 'linear',
    expected: 'success',
    input: { n: 1 },
    build: (cfg, rec) =>
      wf('linear', cfg)
        .then(nStep(rec, 'a', (n) => n + 1))
        .then(nStep(rec, 'b', (n) => n * 10))
        .then(nStep(rec, 'c', (n) => n - 3))
        .commit(),
  },
  {
    name: 'linear-failing',
    expected: 'failed',
    input: { n: 1 },
    build: (cfg, rec) =>
      wf('linear-failing', cfg)
        .then(nStep(rec, 'a', (n) => n + 1))
        .then(boom(rec, 'b'))
        .then(nStep(rec, 'c', (n) => n))
        .commit(),
  },
  {
    name: 'parallel',
    width: 2,
    expected: 'success',
    input: { n: 1 },
    build: (cfg, rec) =>
      wf('parallel', cfg)
        .then(nStep(rec, 'pre', (n) => n + 1))
        .parallel([
          nStep(rec, 'left', async (n) => (await tick(), n * 2)),
          nStep(rec, 'right', (n) => n * 3),
        ])
        .then(
          createStep({
            id: 'join',
            inputSchema: z.object({ left: N, right: N }),
            outputSchema: N,
            execute: async ({ inputData }) => rec.around('join', () => ({ n: inputData.left.n + inputData.right.n })),
          }),
        )
        .commit(),
  },
  {
    name: 'parallel-failing-arm',
    width: 2,
    expected: 'failed',
    input: { n: 1 },
    build: (cfg, rec) =>
      wf('parallel-failing-arm', cfg)
        .parallel([nStep(rec, 'ok', (n) => n + 1), boom(rec, 'bad')])
        .then(createStep({ id: 'after', inputSchema: z.any(), outputSchema: z.any(), execute: async ({ inputData }) => rec.around('after', () => inputData) }))
        .commit(),
  },
  {
    name: 'parallel-bailing-arm',
    width: 2,
    expected: 'success',
    input: { n: 1 },
    build: (cfg, rec) =>
      wf('parallel-bailing-arm', cfg)
        .parallel([
          nStep(rec, 'ok', async (n) => (await tick(), n + 1)),
          createStep({
            id: 'bailer',
            inputSchema: N,
            outputSchema: N,
            execute: async ({ bail }) => rec.around('bailer', () => bail({ n: 99 })),
          }),
        ])
        .then(createStep({ id: 'after', inputSchema: z.any(), outputSchema: z.any(), execute: async ({ inputData }) => rec.around('after', () => inputData) }))
        .commit(),
  },
  {
    name: 'branch-inclusive',
    width: 2,
    expected: 'success',
    input: { n: 5 },
    build: (cfg, rec) =>
      wf('branch-inclusive', cfg)
        .branch([
          [async ({ inputData }: { inputData: N }) => inputData.n > 1, nStep(rec, 'big', (n) => n * 100)],
          [async ({ inputData }: { inputData: N }) => inputData.n % 2 === 1, nStep(rec, 'odd', (n) => n + 1)],
          [async () => false, nStep(rec, 'never', (n) => n)],
        ])
        .then(createStep({ id: 'after', inputSchema: z.any(), outputSchema: z.any(), execute: async ({ inputData }) => rec.around('after', () => inputData) }))
        .commit(),
  },
  {
    name: 'branch-none-truthy',
    expected: 'success',
    input: { n: 5 },
    build: (cfg, rec) =>
      wf('branch-none-truthy', cfg)
        .branch([
          [async () => false, nStep(rec, 'x', (n) => n)],
          [async () => false, nStep(rec, 'y', (n) => n)],
        ])
        .then(createStep({ id: 'after', inputSchema: z.any(), outputSchema: z.any(), execute: async ({ inputData }) => rec.around('after', () => inputData) }))
        .commit(),
  },
  {
    name: 'branch-throwing-condition',
    expected: 'success',
    input: { n: 5 },
    build: (cfg, rec) =>
      wf('branch-throwing-condition', cfg)
        .branch([
          [
            async () => {
              throw new Error('condition broke');
            },
            nStep(rec, 'x', (n) => n),
          ],
          [async () => true, nStep(rec, 'y', (n) => n + 1)],
        ])
        .commit(),
  },
  {
    name: 'dowhile',
    expected: 'success',
    input: { n: 0 },
    build: (cfg, rec) =>
      wf('dowhile', cfg)
        .dowhile(nStep(rec, 'body', (n) => n + 1), async ({ inputData }) => inputData.n < 3)
        .commit(),
  },
  {
    name: 'dountil',
    expected: 'success',
    input: { n: 0 },
    build: (cfg, rec) =>
      wf('dountil', cfg)
        .dountil(nStep(rec, 'body', (n) => n + 2), async ({ inputData, iterationCount }) => inputData.n >= 5 || iterationCount >= 10)
        .then(nStep(rec, 'after', (n) => n))
        .commit(),
  },
  {
    name: 'dowhile-throwing-condition',
    expected: 'rejected',
    input: { n: 0 },
    build: (cfg, rec) =>
      wf('dowhile-throwing-condition', cfg)
        .dowhile(nStep(rec, 'body', (n) => n + 1), async () => {
          throw new Error('condition broke');
        })
        .commit(),
    divergences: [
      {
        row: 26,
        paths: ['kind'],
        reason: 'a throwing loop condition rejects start() on the default engine (handlers/control-flow.ts:835); the petri engine fails the run',
      },
    ],
  },
  ...foreachFixtures(1),
  ...foreachFixtures(3),
  {
    name: 'sleep',
    expected: 'success',
    input: { n: 1 },
    build: (cfg, rec) =>
      wf('sleep', cfg)
        .then(nStep(rec, 'a', (n) => n + 1))
        .sleep(5)
        .then(nStep(rec, 'b', (n) => n * 2))
        .commit(),
  },
  {
    name: 'sleep-fn',
    expected: 'success',
    input: { n: 3 },
    build: (cfg, rec) =>
      wf('sleep-fn', cfg)
        .then(nStep(rec, 'a', (n) => n + 1))
        .sleep(async ({ inputData }) => inputData.n)
        .then(nStep(rec, 'b', (n) => n * 2))
        .commit(),
  },
  {
    name: 'map',
    expected: 'success',
    input: { n: 2 },
    build: (cfg, rec) => {
      const a = nStep(rec, 'a', (n) => n + 1);
      return wf('map', cfg)
        .then(a)
        .map(async ({ inputData, getInitData }) => ({ n: inputData.n * 3 + (getInitData() as N).n }))
        .then(nStep(rec, 'b', (n) => n + 1))
        .map({ n: { step: a, path: 'n' } })
        .then(nStep(rec, 'c', (n) => n))
        .commit();
    },
  },
  {
    name: 'workflow-state',
    width: 2,
    // Both arms read the state at their start and write it back whole: Mastra overlaps them, so
    // p2's write replaces p1's (seen = init, s1, p2). A budget of 1 serialises them and p2 reads
    // p1's write — the budget changes the data. Row 71 (proposed with ADR 0006's M3 report).
    boundDivergences: [
      {
        row: 71,
        // The step's result event carries the same output (handlers/step.ts:661-690).
        paths: ['result.result', 'result.state.seen.**', 'result.steps.s2.output', 'events.s2.*.payload.output'],
        reason:
          "overlapping arms that read-modify-write workflow state lose an update in Mastra (each arm's state is the context's at its start, handlers/control-flow.ts:249); serialised by a budget, neither is lost",
      },
    ],
    expected: 'success',
    input: { n: 1 },
    initialState: { seen: ['init'] },
    build: (cfg, rec) => {
      const tracked = (id: string) =>
        createStep({
          id,
          inputSchema: N,
          outputSchema: N,
          stateSchema: Seen,
          execute: async ({ inputData, state, setState }) =>
            rec.around(id, async () => {
              await setState({ ...state, seen: [...(state.seen ?? []), id] });
              return { n: inputData.n + 1 };
            }),
        });
      return wf('workflow-state', cfg, { stateSchema: Seen })
        .then(tracked('s1'))
        .parallel([tracked('p1'), tracked('p2')])
        .then(
          createStep({
            id: 's2',
            inputSchema: z.any(),
            outputSchema: z.any(),
            stateSchema: Seen,
            execute: async ({ state, setState }) =>
              rec.around('s2', async () => {
                await setState({ seen: [...(state.seen ?? []), 's2'] });
                return state.seen?.length ?? 0;
              }),
          }),
        )
        .commit();
    },
  },
  {
    name: 'retries',
    expected: 'success',
    input: { n: 1 },
    build: (cfg, rec) =>
      wf('retries', cfg, { retryConfig: { attempts: 1, delay: 0 } })
        .then(
          createStep({
            id: 'flaky',
            inputSchema: N,
            outputSchema: N,
            retries: 2,
            execute: async ({ inputData, retryCount }) =>
              rec.around(`flaky:r${retryCount}`, () => {
                if (retryCount < 2) throw new Error(`attempt ${retryCount}`);
                return { n: inputData.n + retryCount };
              }),
          }),
        )
        .then(
          createStep({
            id: 'wf-level',
            inputSchema: N,
            outputSchema: N,
            execute: async ({ inputData, retryCount }) =>
              rec.around(`wf-level:r${retryCount}`, () => {
                if (retryCount < 1) throw new Error(`attempt ${retryCount}`);
                return inputData;
              }),
          }),
        )
        .commit(),
  },
  {
    name: 'retries-exhausted',
    expected: 'failed',
    input: { n: 1 },
    build: (cfg, rec) =>
      wf('retries-exhausted', cfg, { retryConfig: { attempts: 2, delay: 0 } })
        .then(
          createStep({
            id: 'always',
            inputSchema: N,
            outputSchema: N,
            execute: async ({ retryCount }): Promise<N> =>
              rec.around(`always:r${retryCount}`, () => {
                throw new Error(`attempt ${retryCount}`);
              }),
          }),
        )
        .commit(),
  },
  {
    name: 'non-retryable',
    expected: 'failed',
    input: { n: 1 },
    build: (cfg, rec) =>
      wf('non-retryable', cfg, { retryConfig: { attempts: 3, delay: 0 } })
        .then(
          createStep({
            id: 'fatal',
            inputSchema: N,
            outputSchema: N,
            execute: async ({ retryCount }): Promise<N> =>
              rec.around(`fatal:r${retryCount}`, () => {
                throw new MastraNonRetryableError('do not retry');
              }),
          }),
        )
        .commit(),
  },
  {
    name: 'tripwire',
    expected: 'tripwire',
    input: { n: 1 },
    build: (cfg, rec) =>
      wf('tripwire', cfg)
        .then(nStep(rec, 'a', (n) => n))
        .then(
          createStep({
            id: 'guard',
            inputSchema: N,
            outputSchema: N,
            execute: async (): Promise<N> =>
              rec.around('guard', () => {
                throw new TripWire('blocked', { retry: false, metadata: { rule: 'r1' } }, 'proc-1');
              }),
          }),
        )
        .commit(),
  },
  {
    name: 'bail',
    expected: 'success',
    input: { n: 1 },
    build: (cfg, rec) =>
      wf('bail', cfg)
        .then(
          createStep({
            id: 'early',
            inputSchema: N,
            outputSchema: N,
            execute: async ({ inputData, bail }) => rec.around('early', () => bail({ n: inputData.n + 41 })),
          }),
        )
        .then(nStep(rec, 'never', (n) => n))
        .commit(),
  },
  {
    name: 'suspend-at-start',
    expected: 'suspended',
    input: { n: 1 },
    build: (cfg, rec) =>
      wf('suspend-at-start', cfg)
        .then(nStep(rec, 'a', (n) => n + 1))
        .then(
          createStep({
            id: 'approve',
            inputSchema: N,
            outputSchema: N,
            suspendSchema: z.object({ question: z.string() }),
            resumeSchema: z.object({ ok: z.boolean() }),
            execute: async ({ inputData, suspend, resumeData }) =>
              rec.around('approve', async () => {
                if (resumeData === undefined) return suspend({ question: `approve ${inputData.n}?` });
                return inputData;
              }),
          }),
        )
        .commit(),
  },
  {
    name: 'nested-workflow',
    expected: 'success',
    input: { n: 1 },
    build: (cfg, rec) => {
      const inner = createWorkflow({ id: 'inner', inputSchema: N, outputSchema: N, ...cfg })
        .then(nStep(rec, 'i1', (n) => n * 2))
        .then(nStep(rec, 'i2', (n) => n + 7))
        .commit();
      return wf('nested-workflow', cfg)
        .then(nStep(rec, 'pre', (n) => n + 1))
        .then(inner)
        .then(nStep(rec, 'post', (n) => n * 10))
        .commit();
    },
  },
  {
    name: 'tool-step',
    expected: 'success',
    input: { n: 4 },
    build: (cfg, rec) => {
      const double = createTool({
        id: 'double',
        description: 'doubles n',
        inputSchema: N,
        outputSchema: N,
        execute: async (input) => rec.around('double', () => ({ n: input.n * 2 })),
      });
      return wf('tool-step', cfg)
        .then(createStep(double))
        .then(nStep(rec, 'after', (n) => n + 1))
        .commit();
    },
  },
  {
    name: 'two-sleeps',
    expected: 'success',
    input: { n: 1 },
    // Two `sleep_<uuid>` step ids per build: normalised with distinct ordinals, never onto one key.
    build: (cfg, rec) =>
      wf('two-sleeps', cfg)
        .then(nStep(rec, 'a', (n) => n + 1))
        .sleep(1)
        .then(nStep(rec, 'b', (n) => n * 2))
        .sleep(2)
        .then(nStep(rec, 'c', (n) => n + 3))
        .commit(),
  },
  {
    name: 'bail-then-sleep',
    expected: 'success',
    input: { n: 1 },
    // A bail ends the run before the sleep; the sleep must not appear in stepExecutionPath.
    build: (cfg, rec) =>
      wf('bail-then-sleep', cfg)
        .then(nStep(rec, 'a', (n) => n + 1))
        .then(
          createStep({
            id: 'bailer',
            inputSchema: N,
            outputSchema: N,
            execute: async ({ inputData, bail }) => rec.around('bailer', () => bail({ n: inputData.n * 5 })),
          }),
        )
        .sleep(5)
        .then(nStep(rec, 'never', (n) => n))
        .commit(),
  },
  {
    name: 'cancel-mid-step',
    expected: 'canceled',
    input: { n: 1 },
    // Run.cancel() while `slow` runs: the step finishes its body, and the run ends canceled.
    build: (cfg, rec) =>
      wf('cancel-mid-step', cfg)
        .then(nStep(rec, 'a', (n) => n + 1))
        .then(
          createStep({
            id: 'slow',
            inputSchema: N,
            outputSchema: N,
            execute: async ({ inputData, abortSignal }) =>
              rec.around('slow', async () => {
                await rec.cancel();
                if (!abortSignal.aborted) throw new Error('Run.cancel() did not reach the step');
                await tick();
                return { n: inputData.n + 10 };
              }),
          }),
        )
        .then(nStep(rec, 'never', (n) => n))
        .commit(),
  },
  {
    name: 'cancel-mid-sleep',
    expected: 'canceled',
    input: { n: 1 },
    // Run.cancel() while the sleep waits: Mastra leaves the sleep's `waiting` record (handlers/entry.ts:602-609).
    build: (cfg, rec) =>
      wf('cancel-mid-sleep', cfg)
        .then(
          nStep(rec, 'a', (n) => {
            setTimeout(() => void rec.cancel(), 15);
            return n + 1;
          }),
        )
        .sleep(400)
        .then(nStep(rec, 'never', (n) => n))
        .commit(),
  },
  {
    name: 'nested-suspend',
    expected: 'suspended',
    input: { n: 1 },
    build: (cfg, rec) => {
      const inner = createWorkflow({ id: 'inner-suspend', inputSchema: N, outputSchema: N, ...cfg })
        .then(nStep(rec, 'i1', (n) => n * 2))
        .then(
          createStep({
            id: 'approve',
            inputSchema: N,
            outputSchema: N,
            suspendSchema: z.object({ question: z.string() }),
            resumeSchema: z.object({ ok: z.boolean() }),
            execute: async ({ inputData, suspend, resumeData }) =>
              rec.around('approve', async () => {
                if (resumeData === undefined) return suspend({ question: `approve ${inputData.n}?` });
                return inputData;
              }),
          }),
        )
        .commit();
      return wf('nested-suspend', cfg)
        .then(nStep(rec, 'pre', (n) => n + 1))
        .then(inner)
        .then(nStep(rec, 'post', (n) => n * 10))
        .commit();
    },
  },
  {
    name: 'registered',
    expected: 'success',
    input: { n: 2 },
    // Registered with a Mastra instance: the engine gets `__registerMastra`, and step code sees `mastra`.
    build: (cfg, rec) => {
      const registered = wf('registered', cfg)
        .then(
          createStep({
            id: 'sees-mastra',
            inputSchema: N,
            outputSchema: N,
            execute: async ({ inputData, mastra }) =>
              rec.around('sees-mastra', () => ({ n: inputData.n + (mastra instanceof Mastra ? 100 : 0) })),
          }),
        )
        .map(async ({ inputData }) => ({ n: inputData.n * 2 }))
        .sleep(1)
        .then(nStep(rec, 'after', (n) => n + 1))
        .commit();
      const mastra = new Mastra({ workflows: { registered }, logger: false });
      return mastra.getWorkflow('registered');
    },
  },
  {
    name: 'loop-then-loop',
    expected: 'success',
    input: { n: 0 },
    // Row 48: one step id entered by a loop, a `.then` and a second loop. Mastra seeds each record
    // from the prior one under the same id (`handlers/step.ts:170-178`), so `metadata.iterationCount`
    // carries over; the oracle decides what the record holds.
    build: (cfg, rec) => {
      const counter = nStep(rec, 'counter', (n) => n + 1);
      return wf('loop-then-loop', cfg)
        .dowhile(counter, async ({ inputData }) => inputData.n < 2)
        .then(counter)
        .dountil(counter, async ({ inputData }) => inputData.n >= 6)
        .commit();
    },
  },
  {
    name: 'parallel-wide',
    width: 6,
    expected: 'success',
    input: { n: 1 },
    // Six arms, each waiting a timer, so Mastra overlaps all six and a budget of 1, 2 or 4 binds.
    build: (cfg, rec) => {
      const arm = <const Id extends string>(id: Id, factor: number) =>
        nStep(rec, id, async (n) => (await delay(2), n * factor));
      return wf('parallel-wide', cfg)
        .then(nStep(rec, 'pre', (n) => n + 1))
        .parallel([arm('w1', 1), arm('w2', 2), arm('w3', 3), arm('w4', 4), arm('w5', 5), arm('w6', 6)])
        .then(
          createStep({
            id: 'join',
            inputSchema: z.record(z.string(), N),
            outputSchema: N,
            execute: async ({ inputData }) =>
              rec.around('join', () => ({ n: Object.values(inputData).reduce((sum, v) => sum + v.n, 0) })),
          }),
        )
        .commit();
    },
  },
  ...foreachFixtures(5, 8),
  {
    name: 'foreach-empty-cancel-before',
    expected: 'canceled',
    input: { n: 0 },
    // A foreach over [] after a step that cancels the run and waits for it: the abort is seen
    // before the foreach entry on both engines, which then writes no record (`default.ts:815`).
    build: (cfg, rec) =>
      wf('foreach-empty-cancel-before', cfg)
        .then(emptyItems(rec, () => rec.cancel()))
        .foreach(echoItem(rec), { concurrency: 5 })
        .commit(),
  },
  {
    name: 'foreach-empty-cancel-inside',
    expected: 'canceled',
    input: { n: 0 },
    // Row 49: the abort lands inside Mastra's empty foreach — after the entry's abort check, before
    // its final one (`handlers/control-flow.ts:1291-1306`) — so Mastra records `canceled []`. With
    // no item there is no await to land in, only microtasks: the window is depths 25-26 after the
    // preceding step returns, measured on the pinned @mastra/core. Through M4, and again since the
    // M5 publish fix, the petri foreach has completed before the abort lands, so it records
    // `success []` and publishes its -result and -finish; the abort still reaches the petri run
    // before its terminal, so the run is `canceled` on both engines and row 52 (the run succeeding)
    // does not apply at the time of writing. A microtask-depth fixture: which side of the window
    // each engine lands on is not by construction.
    build: (cfg, rec) =>
      wf('foreach-empty-cancel-inside', cfg)
        .then(emptyItems(rec, () => afterMicrotasks(INSIDE_EMPTY_FOREACH, () => void rec.cancel())))
        .foreach(echoItem(rec), { concurrency: 5 })
        .commit(),
    divergences: [
      {
        row: 49,
        paths: ['result.steps.item.status', 'events.item.length'],
        reason:
          "a cancel inside an empty foreach: Mastra's final abort check records canceled [] (handlers/control-flow.ts:1291-1306) and publishes nothing after the foreach's -start (the -result/-finish at :1331-1351 are past that return); the petri foreach completes with no await to land in, so success [] with its -result and -finish",
      },
    ],
  },
  {
    name: 'sleep-until',
    expected: 'success',
    input: { n: 4 },
    // A `.sleepUntil()` with a date fn: its own `-waiting` / `-result` / `-finish` events
    // (handlers/entry.ts:695-800), beside the fixed and fn `.sleep()`s above.
    build: (cfg, rec) =>
      wf('sleep-until', cfg)
        .then(nStep(rec, 'a', (n) => n + 1))
        .sleepUntil(async ({ inputData }) => new Date(Date.now() + (inputData as N).n))
        .then(nStep(rec, 'b', (n) => n * 2))
        .commit(),
  },
  {
    name: 'emit-step-events-off',
    width: 2,
    expected: 'success',
    input: { n: 2 },
    // `createWorkflow({ options: { emitStepEvents: false } })`: Mastra publishes no step, sleep or
    // foreach event (handlers/step.ts:104, handlers/entry.ts:28, handlers/control-flow.ts:47), so
    // the oracle's watch sees nothing. The petri engine is handed the workflow's options as `init()`
    // hands them (src/mastra/init.ts:232-234); a workflow built with `executionEngine` never passes
    // them itself (workflow.ts:1819-1827).
    build: (cfg, rec) =>
      withWorkflowOptions(
        cfg,
        wf('emit-step-events-off', cfg, { options: { emitStepEvents: false } })
          .then(nStep(rec, 'a', (n) => n + 1))
          .sleep(1)
          .then(
            createStep({
              id: 'explode',
              inputSchema: N,
              outputSchema: z.array(N),
              execute: async ({ inputData }) => rec.around('explode', () => Array.from({ length: inputData.n }, (_, i) => ({ n: i + 1 }))),
            }),
          )
          .foreach(echoItem(rec), { concurrency: 2 })
          .commit(),
      ),
  },
  {
    name: 'writer',
    expected: 'success',
    input: { n: 1 },
    // `writer.write()` and `writer.custom()` under `start()`: the default engine's outputWriter is
    // unset there (workflow.ts:3781-3797), so its watch sees neither chunk, only the lifecycle. A
    // candidate that publishes them anyway (row 58) shows as `events.w@output` / `events.$data-progress`.
    build: (cfg, rec) => writerWorkflow('writer', cfg, rec),
  },
  {
    name: 'writer-stream',
    expected: 'success',
    input: { n: 1 },
    via: 'stream',
    // The same workflow observed through `run.stream()`: writer chunks, the custom `data-*` chunk,
    // the step events as the stream re-shapes them (workflow.ts:4083-4105; `-finish` dropped,
    // stream/RunOutput.ts:84), and the stream's own start and finish.
    build: (cfg, rec) => writerWorkflow('writer-stream', cfg, rec),
  },
];

/**
 * Hands the petri engine the workflow's normalised options, as `init()` does
 * (src/mastra/init.ts:232-234): a workflow built with an `executionEngine` keeps its options to
 * itself (workflow.ts:1805-1827). The default engine is built by the workflow with them already.
 */
function withWorkflowOptions<W extends { readonly options: unknown }>(cfg: EngineConfig, workflow: W): W {
  if ('executionEngine' in cfg) (cfg.executionEngine as { options: unknown }).options = workflow.options;
  return workflow;
}

/** `w` writes two chunks and a custom `data-progress` chunk, then `after` runs. */
function writerWorkflow(id: string, cfg: EngineConfig, rec: Recorder) {
  return wf(id, cfg)
    .then(
      createStep({
        id: 'w',
        inputSchema: N,
        outputSchema: N,
        execute: async ({ inputData, writer }) =>
          rec.around('w', async () => {
            await writer.write({ progress: inputData.n });
            await writer.custom({ type: 'data-progress', data: { n: inputData.n } });
            await writer.write({ progress: inputData.n + 1 });
            return { n: inputData.n + 1 };
          }),
      }),
    )
    .then(nStep(rec, 'after', (n) => n * 2))
    .commit();
}


/**
 * The microtask depth, after the step before an empty foreach returns, at which Mastra sees the
 * abort inside the foreach (measured on the pinned @mastra/core: depths 25 and 26; 24 is before
 * the entry, 27 after the foreach recorded success). Changing Mastra moves it; the fixture's
 * `expected: 'canceled'` and its record then fail loudly.
 */
const INSIDE_EMPTY_FOREACH = 26;

function afterMicrotasks(depth: number, f: () => void): void {
  if (depth === 0) f();
  else queueMicrotask(() => afterMicrotasks(depth - 1, f));
}

/**
 * `{n} -> []`, running `hook` inside its traced body first — awaited when it returns a promise,
 * called synchronously otherwise, so a microtask count taken from the step's return is not shifted.
 */
function emptyItems(rec: Recorder, hook: () => Promise<void> | void) {
  return createStep({
    id: 'explode',
    inputSchema: N,
    outputSchema: z.array(N),
    execute: async () =>
      rec.around('explode', (): N[] | Promise<N[]> => {
        const pending = hook();
        return pending === undefined ? [] : pending.then(() => []);
      }),
  });
}

function echoItem(rec: Recorder) {
  return createStep({ id: 'item', inputSchema: N, outputSchema: N, execute: async ({ inputData }) => rec.around(`item:${inputData.n}`, () => inputData) });
}

function foreachFixtures(concurrency: number, count = 3): MastraFixture[] {
  const Items = z.array(N);
  const item = (rec: Recorder, failOn?: number) =>
    createStep({
      id: 'item',
      inputSchema: N,
      outputSchema: N,
      execute: async ({ inputData }) =>
        rec.around(`item:${inputData.n}`, async () => {
          // Later items finish first, so a concurrent run's completion order differs from its start order.
          await delay(3 * (count + 1 - inputData.n));
          if (inputData.n === failOn) throw new Error(`item ${inputData.n} failed`);
          return { n: inputData.n * 10 };
        }),
    });
  const toItems = (rec: Recorder) =>
    createStep({
      id: 'explode',
      inputSchema: N,
      outputSchema: Items,
      execute: async ({ inputData }) => rec.around('explode', () => Array.from({ length: inputData.n }, (_, i) => ({ n: i + 1 }))),
    });
  const width = Math.min(concurrency, count);
  // More items than lanes: Mastra's sliding window (`handlers/control-flow.ts:1053-1057`) orders a
  // later item after whichever earlier one freed its slot — an incidental order, not a data one.
  // No item reads another's output, so items are declared independent (row 4); a budget that
  // reorders them weakens that, reported. With every item in its own lane there is no such order.
  const labels = Array.from({ length: count }, (_, i) => `item:${i + 1}`);
  const independent: IndependentPair[] =
    count > concurrency ? labels.flatMap((a, i) => labels.slice(i + 1).map((b): IndependentPair => [a, b])) : [];
  const shared = { width, ...(independent.length > 0 ? { independent } : {}) };
  return [
    {
      name: `foreach-c${concurrency}`,
      expected: 'success',
      ...shared,
      input: { n: count },
      build: (cfg, rec) => wf(`foreach-c${concurrency}`, cfg).then(toItems(rec)).foreach(item(rec), { concurrency }).commit(),
    },
    {
      name: `foreach-c${concurrency}-failing-item`,
      expected: 'failed',
      ...shared,
      // Under a binding budget an item dispatched to a lane may wait for a permit, so the failing
      // item is seen at a different point in the window: the set of items that ran differs from
      // Mastra's (fewer dispatched; some already-dispatched ones start after the failure). The data
      // agree. Row 70, the budget. Only with more items than lanes: otherwise all are dispatched at once.
      ...(count > concurrency
        ? {
            boundDivergences: [
              {
                row: 70,
                // An item never dispatched publishes no progress event either (handlers/control-flow.ts:1117-1147).
                paths: ['trace.*', 'result.steps.item.suspendPayload.__workflow_meta.foreachOutput.**', ...labels.map((_, i) => `events.item[${i}]`)],
                reason:
                  "a budget below the foreach concurrency changes which items were dispatched when the failing item stopped dispatch (handlers/control-flow.ts:1082-1107), and so which items the failed aggregate's foreachOutput lists and which publish progress; the run result is the same",
              },
            ],
          }
        : {}),
      divergences: [
        {
          row: 35,
          paths: ['startedAt', 'endedAt'].map((k) => `result.steps.item.suspendPayload.__workflow_meta.foreachOutput.*.${k}`),
          reason:
            "clock stamps, not a difference: each foreachOutput entry of the failed aggregate carries its item's start and end (handlers/control-flow.ts:1194-1198, 1360-1370), and the fresh-run EXCLUDED_PATHS, unlike RESUME_EXCLUDED_PATHS, does not exclude a stamp at that depth",
        },
      ],
      input: { n: count },
      build: (cfg, rec) => wf(`foreach-c${concurrency}-failing-item`, cfg).then(toItems(rec)).foreach(item(rec, 2), { concurrency }).commit(),
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Suspend, then resume ([ADR 0007])
// ---------------------------------------------------------------------------------------------

/** One `Run.resume()` call, as a fixture declares it; `resumeData` is passed exactly when present. */
export interface ResumeCall {
  readonly step?: string | readonly string[];
  readonly label?: string;
  readonly resumeData?: unknown;
  readonly forEachIndex?: number;
}

/**
 * A fixture that suspends and is resumed: run to its suspension with `start()`, then each
 * `resume()` in turn, on the routes of `src/conformance/differential.ts` ([ADR 0007]).
 */
export interface ResumeFixture {
  readonly name: string;
  /** The workflow id: the storage key both engines share, so a run crosses engines. */
  readonly id: string;
  readonly input: unknown;
  readonly resumes: readonly ResumeCall[];
  /** The oracle's outcome per phase — a status, or `rejected` — so a broken fixture cannot pass by failing on both. */
  readonly expected: readonly string[];
  readonly build: (cfg: EngineConfig, rec: Recorder) => Runnable;
  /** The resume sites the compiled net registers (`path.join('.')`), which the proofs cover. */
  readonly sites: readonly string[];
  readonly divergences?: readonly Attribution[];
  readonly independent?: readonly IndependentPair[];
  /** As {@link MastraFixture.width}. */
  readonly width?: number;
  readonly boundDivergences?: readonly Attribution[];
  /**
   * Attributions that hold only where the fixture's steps can overlap — the petri budget unbounded
   * or at least {@link width} — the counterpart of `boundDivergences`.
   */
  readonly overlapDivergences?: readonly Attribution[];
}

/** What a registered workflow offers the resume driver: Mastra's own `Workflow`, read structurally. */
interface ResumableRun extends StartedRun {
  resume(args: Record<string, unknown>): Promise<unknown>;
}
interface Registered {
  createRun(options: { runId: string }): Promise<ResumableRun>;
}

/** Registers `wf` on a new `Mastra` over `storage`: one per engine instance. */
function register(storage: InMemoryStore, wf: Runnable): Registered {
  const mastra = new Mastra({ storage, workflows: { wf } as never, logger: false });
  return (mastra as unknown as { getWorkflow(key: string): Registered }).getWorkflow('wf');
}

/** A sort key for one stored run that does not depend on its ids or its clock. */
function storedKey(snapshot: unknown): string {
  return JSON.stringify(snapshot, (k, v: unknown) => (['timestamp', 'startedAt', 'endedAt', 'suspendedAt', 'resumedAt', 'runId'].includes(k) ? undefined : v))
    .replace(UUID, '<uuid>');
}

/**
 * Every `WorkflowRunState` in storage, by workflow name, each list in {@link storedKey} order — as
 * `InMemoryStore` holds it, key for key: a key whose value is `undefined` is kept, so Mastra's
 * `tracingContext: undefined` on a write that passes none (`handlers/entry.ts:209-227`) is compared
 * with the petri engine's.
 */
async function storedRuns(storage: InMemoryStore): Promise<Record<string, unknown[]>> {
  const store = await storage.getStore('workflows');
  if (!store) throw new Error('InMemoryStore has no workflows store');
  const { runs } = await store.listWorkflowRuns();
  const out: Record<string, unknown[]> = {};
  for (const run of runs) {
    const snapshot: unknown = typeof run.snapshot === 'string' ? JSON.parse(run.snapshot) : structuredClone(run.snapshot);
    (out[run.workflowName] ??= []).push(snapshot);
  }
  const sorted: Record<string, unknown[]> = {};
  for (const name of Object.keys(out).sort()) sorted[name] = out[name]!.sort((a, b) => (storedKey(a) < storedKey(b) ? -1 : storedKey(a) > storedKey(b) ? 1 : 0));
  return sorted;
}

/**
 * Runs `start()` then each `resume()` on the route's engines, through a real `Mastra` over one
 * `InMemoryStore`. On a `same` route every phase runs on one registered workflow — one engine
 * instance; otherwise each phase builds and registers its own, as another process would. The
 * storage is the only thing the phases share. Each phase records what it returned or threw, every
 * stored snapshot after it, its step trace and the `execute()` calls it caused.
 */
export async function observeResume(fixture: ResumeFixture, route: ResumeRoute, concurrency?: number): Promise<ResumeObservation> {
  const storage = new InMemoryStore();
  const rec = new Recorder();
  const runId = `${fixture.id}-run`;
  const same = route.process === 'same' && route.suspendOn === route.resumeOn;
  let shared: Registered | undefined;
  const phases: PhaseObservation[] = [];
  const outputOptions = { includeState: true, includeResumeLabels: true };
  for (let i = 0; i <= fixture.resumes.length; i++) {
    const engine = phaseEngine(route, i);
    const executions: Execution[] = [];
    const from = rec.events.length;
    const undo = [
      probeExecute(PetriExecutionEngine.prototype, 'petri', executions),
      probeExecute(DefaultExecutionEngine.prototype, 'default', executions),
    ];
    let outcome: PhaseObservation['outcome'];
    let collect: (() => Promise<unknown[]>) | undefined;
    try {
      const wf = same ? (shared ??= register(storage, fixture.build(engineConfig(engine, concurrency), rec))) : register(storage, fixture.build(engineConfig(engine, concurrency), rec));
      const run = await wf.createRun({ runId });
      rec.bind(run);
      collect = watchEvents(run);
      const call = fixture.resumes[i - 1];
      const result =
        call === undefined
          ? await run.start({ inputData: fixture.input, outputOptions })
          : await run.resume({
              ...(call.step === undefined ? {} : { step: call.step }),
              ...(call.label === undefined ? {} : { label: call.label }),
              ...('resumeData' in call ? { resumeData: call.resumeData } : {}),
              ...(call.forEachIndex === undefined ? {} : { forEachIndex: call.forEachIndex }),
              outputOptions,
            });
      outcome = { kind: 'resolved', result };
    } catch (error) {
      outcome = { kind: 'rejected', error };
    } finally {
      for (const u of undo.reverse()) u();
    }
    const events = collect === undefined ? [] : await collect();
    phases.push({ outcome, stored: await storedRuns(storage), trace: rec.events.slice(from), executions, events });
  }
  return { phases };
}

/** The fixture as a resume case, the petri engine built with run budget `concurrency` (absent: unbounded). */
export function toResumeCase(fixture: ResumeFixture, concurrency?: number): ResumeCase {
  const bound = concurrency !== undefined && concurrency < (fixture.width ?? 1);
  return {
    name: fixture.name,
    run: (route) => observeResume(fixture, route, concurrency),
    ...(concurrency === undefined ? {} : { concurrency }),
    divergences: [
      ...(fixture.divergences ?? []),
      ...(bound ? (fixture.boundDivergences ?? []) : (fixture.overlapDivergences ?? [])),
    ],
    ...(fixture.independent === undefined ? {} : { independent: fixture.independent }),
  };
}

const Add = z.object({ add: z.number() });
const Ask = z.object({ ask: z.string() });

/** Suspends until resumed, then adds the resume data to its input. `onResume` runs inside the resumed body. */
function gate(rec: Recorder, id: string, options: { label?: string; onResume?: () => Promise<void> } = {}) {
  return createStep({
    id,
    inputSchema: N,
    outputSchema: N,
    resumeSchema: Add,
    suspendSchema: Ask,
    execute: async ({ inputData, resumeData, suspend }) =>
      rec.around(id, async () => {
        if (!resumeData) return suspend({ ask: id }, options.label === undefined ? undefined : { resumeLabel: options.label });
        await options.onResume?.();
        return { n: inputData.n + resumeData.add };
      }),
  });
}

/** Each arm's output under its id, summed. */
function sumArms(rec: Recorder, id: string) {
  return createStep({
    id,
    inputSchema: z.record(z.string(), N),
    outputSchema: N,
    execute: async ({ inputData }) => rec.around(id, () => ({ n: Object.values(inputData).reduce((acc, v) => acc + v.n, 0) })),
  });
}

const resumeFixture = (f: ResumeFixture): ResumeFixture => f;

/**
 * The routes whose resume phases run on the petri engine. An attribution for what the petri engine
 * does on resume — a refusal, a position rule — is scoped to them: on `petri>default` the default
 * engine resumes, and a difference there must be explained by what the petri engine stored.
 */
const RESUMES_ON_PETRI: readonly ResumeRouteLabel[] = RESUME_ROUTES.filter((r) => r.resumeOn === 'petri').map(routeLabel);

export const RESUME_FIXTURES: readonly ResumeFixture[] = [
  resumeFixture({
    name: 'resume-step',
    id: 'rs-step',
    input: { n: 1 },
    resumes: [{ step: 'g', resumeData: { add: 5 } }],
    expected: ['suspended', 'success'],
    sites: ['0', '1', '2'],
    build: (cfg, rec) =>
      wf('rs-step', cfg)
        .then(nStep(rec, 'a', (n) => n + 1))
        .then(gate(rec, 'g'))
        .then(nStep(rec, 'c', (n) => n * 10))
        .commit(),
  }),
  resumeFixture({
    name: 'resume-suspend-again',
    id: 'rs-again',
    input: { n: 1 },
    resumes: [
      { step: 'stubborn', resumeData: { add: 1 } },
      { step: 'stubborn', resumeData: { add: 2 } },
    ],
    expected: ['suspended', 'suspended', 'success'],
    sites: ['0', '1', '2'],
    build: (cfg, rec) =>
      wf('rs-again', cfg)
        .then(nStep(rec, 'a', (n) => n + 1))
        .then(
          createStep({
            id: 'stubborn',
            inputSchema: N,
            outputSchema: N,
            resumeSchema: Add,
            suspendSchema: Ask,
            execute: async ({ inputData, resumeData, suspendData, suspend }) =>
              rec.around('stubborn', async () => {
                if (resumeData?.add !== 2) return suspend({ ask: `again after ${JSON.stringify(suspendData ?? null)}` });
                return { n: inputData.n + resumeData.add };
              }),
          }),
        )
        .then(nStep(rec, 'c', (n) => n * 10))
        .commit(),
  }),
  resumeFixture({
    name: 'resume-parallel-two-suspended',
    id: 'rs-par2',
    width: 2,
    input: { n: 1 },
    // The non-lowest arm first, by id: the re-suspension lists the other, then it finishes.
    resumes: [
      { step: 'b', resumeData: { add: 2 } },
      { step: 'a', resumeData: { add: 1 } },
    ],
    expected: ['suspended', 'suspended', 'success'],
    sites: ['0', '1.0', '1.1', '2'],
    build: (cfg, rec) =>
      wf('rs-par2', cfg)
        .then(nStep(rec, 'pre', (n) => n + 1))
        .parallel([gate(rec, 'a'), gate(rec, 'b')])
        .then(sumArms(rec, 'sum'))
        .commit(),
  }),
  resumeFixture({
    name: 'resume-parallel-sibling-done',
    id: 'rs-par-done',
    width: 2,
    input: { n: 1 },
    resumes: [{ step: 'g', resumeData: { add: 3 } }],
    expected: ['suspended', 'success'],
    sites: ['0.0', '0.1', '1'],
    build: (cfg, rec) =>
      wf('rs-par-done', cfg)
        .parallel([nStep(rec, 't', (n) => n * 10), gate(rec, 'g')])
        .then(sumArms(rec, 'sum'))
        .commit(),
  }),
  resumeFixture({
    name: 'resume-parallel-last',
    id: 'rs-par-last',
    width: 2,
    input: { n: 1 },
    // The resumed block is the last entry, beside a sibling that succeeded: the run's result is the
    // block's own output — the replayed sibling's stored output beside the resumed arm's new one —
    // as Mastra's buildResumedBlockResult returns it (handlers/entry.ts:44-96, 354-391). A replay
    // that drops the sibling's output (settles it instead) differs here; nothing follows the block
    // to hide it.
    resumes: [{ step: 'g', resumeData: { add: 3 } }],
    expected: ['suspended', 'success'],
    sites: ['0.0', '0.1'],
    build: (cfg, rec) => wf('rs-par-last', cfg).parallel([nStep(rec, 't', (n) => n * 10), gate(rec, 'g')]).commit(),
  }),
  resumeFixture({
    name: 'resume-branch-last',
    id: 'rs-branch-last',
    width: 2,
    input: { n: 1 },
    // Both conditions hold: arm 'bb' is taken and succeeds, arm 'ba' suspends. The resumed branch
    // is the last entry, so the result is both taken arms' outputs (handlers/entry.ts:480-509); the
    // conditions are not evaluated again.
    resumes: [{ step: 'ba', resumeData: { add: 4 } }],
    expected: ['suspended', 'success'],
    sites: ['0.0', '0.1'],
    build: (cfg, rec) =>
      wf('rs-branch-last', cfg)
        .branch([
          [async ({ inputData }: { inputData: N }) => inputData.n > 0, gate(rec, 'ba')],
          [async ({ inputData }: { inputData: N }) => inputData.n > 0, nStep(rec, 'bb', (n) => n * 10)],
        ])
        .commit(),
  }),
  resumeFixture({
    name: 'resume-parallel-labels',
    id: 'rs-labels',
    width: 3,
    input: { n: 1 },
    // Settles the PLAUSIBLE label loss (default.ts:878-891 with entry.ts:100-107): after resuming
    // 'c' by label the stored resumeLabels are {}, so 'L-a' names nothing, Run falls back to
    // suspendedPaths, finds two and rejects. Resuming by id still works.
    resumes: [
      { label: 'L-c', resumeData: { add: 3 } },
      { label: 'L-a', resumeData: { add: 1 } },
      { step: 'a', resumeData: { add: 1 } },
      { step: 'b', resumeData: { add: 2 } },
    ],
    expected: ['suspended', 'suspended', 'rejected', 'suspended', 'success'],
    sites: ['0.0', '0.1', '0.2', '1'],
    build: (cfg, rec) =>
      wf('rs-labels', cfg)
        .parallel([gate(rec, 'a', { label: 'L-a' }), gate(rec, 'b', { label: 'L-b' }), gate(rec, 'c', { label: 'L-c' })])
        .then(sumArms(rec, 'sum'))
        .commit(),
  }),
  resumeFixture({
    name: 'resume-branch',
    id: 'rs-branch',
    input: { n: 1 },
    resumes: [{ step: 'ba', resumeData: { add: 4 } }],
    expected: ['suspended', 'success'],
    sites: ['0', '1.0', '1.1'],
    build: (cfg, rec) =>
      wf('rs-branch', cfg)
        .then(nStep(rec, 'pre', (n) => n + 1))
        .branch([
          [async ({ inputData }: { inputData: N }) => inputData.n > 0, gate(rec, 'ba')],
          [async ({ inputData }: { inputData: N }) => inputData.n < 0, nStep(rec, 'bb', (n) => n * 10)],
        ])
        .commit(),
  }),
  resumeFixture({
    name: 'resume-loop',
    id: 'rs-loop',
    input: { n: 0 },
    // Suspends on the iteration whose input is 2: iteration n re-runs with the resume data, n+1 on fresh.
    resumes: [{ step: 'body', resumeData: { add: 10 } }],
    expected: ['suspended', 'success'],
    sites: ['0', '1'],
    build: (cfg, rec) =>
      wf('rs-loop', cfg)
        .dountil(
          createStep({
            id: 'body',
            inputSchema: N,
            outputSchema: N,
            resumeSchema: Add,
            suspendSchema: Ask,
            execute: async ({ inputData, resumeData, suspend }) =>
              rec.around('body', async () => {
                if (inputData.n === 2 && !resumeData) return suspend({ ask: `body at ${inputData.n}` });
                return { n: inputData.n + 1 + (resumeData?.add ?? 0) };
              }),
          }),
          async ({ inputData }) => inputData.n >= 15,
        )
        .then(nStep(rec, 'after', (n) => n * 10))
        .commit(),
  }),
  resumeFixture({
    name: 'resume-nested',
    id: 'rs-nested',
    input: { n: 1 },
    resumes: [{ step: ['rs-inner', 'ig'], resumeData: { add: 5 } }],
    expected: ['suspended', 'success'],
    sites: ['0', '1', '2'],
    build: (cfg, rec) => {
      const inner = createWorkflow({ id: 'rs-inner', inputSchema: N, outputSchema: N, ...cfg })
        .then(nStep(rec, 'i1', (n) => n * 2))
        .then(gate(rec, 'ig'))
        .commit();
      return wf('rs-nested', cfg)
        .then(nStep(rec, 'pre', (n) => n + 1))
        .then(inner)
        .then(nStep(rec, 'post', (n) => n * 10))
        .commit();
    },
  }),
  resumeFixture({
    name: 'resume-cancel',
    id: 'rs-cancel',
    input: { n: 1 },
    // Run.cancel() from inside the resumed step: it finishes its body, the next entry never starts.
    resumes: [{ step: 'g', resumeData: { add: 5 } }],
    expected: ['suspended', 'canceled'],
    sites: ['0', '1', '2'],
    build: (cfg, rec) =>
      wf('rs-cancel', cfg)
        .then(nStep(rec, 'a', (n) => n + 1))
        .then(gate(rec, 'g', { onResume: () => rec.cancel() }))
        .then(nStep(rec, 'never', (n) => n))
        .commit(),
  }),
  resumeFixture({
    name: 'resume-cancel-in-block',
    id: 'rs-cancel-block',
    width: 2,
    input: { n: 1 },
    // A cancel inside a resumed arm of a block that is not the last entry: the loop top sees it.
    resumes: [{ step: 'g', resumeData: { add: 5 } }],
    expected: ['suspended', 'canceled'],
    sites: ['0.0', '0.1', '1'],
    build: (cfg, rec) =>
      wf('rs-cancel-block', cfg)
        .parallel([nStep(rec, 't', (n) => n), gate(rec, 'g', { onResume: () => rec.cancel() })])
        .then(sumArms(rec, 'never'))
        .commit(),
    divergences: [
      {
        row: 76,
        paths: ['phases.1.stored.rs-cancel-block.0.tracingContext'],
        reason:
          "Mastra's resumed block skips the entry-end re-stamp, so its abort is seen at the next loop top, whose write passes no tracingContext (default.ts:815-835); the petri engine ends at the block and writes the terminal's {} (default.ts:946-951)",
      },
    ],
  }),
  resumeFixture({
    name: 'resume-cancel-in-last-block',
    id: 'rs-cancel-last',
    width: 2,
    input: { n: 1 },
    // Settles the PLAUSIBLE re-stamp: Mastra's resumed-block branch returns before the entry-end
    // re-stamp (handlers/entry.ts:385-391 against :815-817), and nothing follows the block to see
    // the abort at the loop top, so the canceled run succeeds. Here the cancel wins.
    resumes: [{ step: 'g', resumeData: { add: 5 } }],
    expected: ['suspended', 'success'],
    sites: ['0.0', '0.1'],
    build: (cfg, rec) => wf('rs-cancel-last', cfg).parallel([nStep(rec, 't', (n) => n), gate(rec, 'g', { onResume: () => rec.cancel() })]).commit(),
    divergences: [
      {
        row: 76,
        paths: [
          'phases.1.result.status',
          'phases.1.result.result',
          'phases.1.stored.rs-cancel-last.0.status',
          'phases.1.stored.rs-cancel-last.0.result',
          'phases.1.stored.rs-cancel-last.0.tracingContext',
        ],
        reason:
          "a cancel inside a resumed arm of the last entry: Mastra's resumed-block branch skips the entry-end re-stamp (handlers/entry.ts:385-391, :815-817) and the run succeeds; the petri engine's cancel wins",
      },
    ],
  }),
  ...[0, '', false, null, undefined].map((value) =>
    resumeFixture({
      name: `resume-falsy-${value === '' ? 'empty' : String(value)}`,
      id: 'rs-falsy',
      input: { n: 1 },
      // Falsy resumeData reaches the step, but Mastra records a fresh start: no resumePayload, and
      // the payload is the validated input (handlers/step.ts:166-175).
      resumes: [{ step: 'f', resumeData: value }],
      expected: ['suspended', 'success'],
      sites: ['0', '1'],
      build: (cfg, rec) =>
        wf('rs-falsy', cfg)
          .then(nStep(rec, 'a', (n) => n + 1))
          .then(
            createStep({
              id: 'f',
              inputSchema: N,
              outputSchema: z.any(),
              resumeSchema: z.any(),
              suspendSchema: Ask,
              execute: async ({ inputData, resumeData, suspendData, suspend }) =>
                rec.around('f', async () => {
                  if (suspendData === undefined) return suspend({ ask: 'f' });
                  return { n: inputData.n, got: resumeData === undefined ? '<undefined>' : resumeData };
                }),
            }),
          )
          .commit(),
    }),
  ),
  resumeFixture({
    name: 'resume-same-id-later',
    id: 'rs-same-id',
    input: { n: 1 },
    // One step object entered twice. Mastra treats every entry whose id is in resume.steps as
    // resumed for the whole segment: the later 'g' gets the resume data and its stale stored input,
    // and skips its stepExecutionPath push (entry.ts:306-316; step.ts:140-142). Here resume data is
    // position-exact (maintainer decision 4), so the later 'g' suspends on its own.
    resumes: [{ step: 'g', resumeData: { add: 5 } }],
    expected: ['suspended', 'success'],
    sites: ['0', '1', '2'],
    build: (cfg, rec) => {
      const g = gate(rec, 'g');
      return wf('rs-same-id', cfg)
        .then(g)
        .then(nStep(rec, 'a', (n) => n + 1))
        .then(g)
        .commit();
    },
    divergences: [
      {
        row: 75,
        routes: RESUMES_ON_PETRI,
        // The later 'g' suspends here and succeeds in Mastra: the run's status, result and
        // suspension lists, the later 'g' record, the path it pushes, and what a suspended result
        // carries beside them ('a''s payload, resumeLabels; the non-success exit's tracingContext {}).
        paths: [
          'phases.1.result.status',
          'phases.1.result.result',
          'phases.1.result.suspended',
          'phases.1.result.suspendPayload',
          'phases.1.result.resumeLabels',
          'phases.1.result.stepExecutionPath.length',
          'phases.1.result.steps.g.**',
          'phases.1.result.steps.a.payload',
          'phases.1.stored.rs-same-id.0.status',
          'phases.1.stored.rs-same-id.0.result',
          'phases.1.stored.rs-same-id.0.suspendedPaths.g',
          'phases.1.stored.rs-same-id.0.stepExecutionPath.length',
          'phases.1.stored.rs-same-id.0.tracingContext',
          'phases.1.stored.rs-same-id.0.context.g.**',
          // The same two entries in the phase's events: the later 'g' starts on its own input and
          // suspends, where Mastra's starts on the stale input and succeeds (handlers/step.ts:166-178,661-690).
          'phases.1.events.g.**',
        ],
        reason:
          'a later entry of the resumed step id: Mastra feeds it the resume data and its stale stored input and skips its stepExecutionPath push (entry.ts:306-316, step.ts:140-142); resume data here goes to the resumed position only, so the later entry suspends',
      },
    ],
  }),
  ...foreachResumeFixtures(),
];

/**
 * `.foreach()` resume: three items, the middle one or the last two suspending, the rest done — with
 * forEachIndex set and unset, and a parked suspension resumed after another — and a foreach over a
 * nested workflow. The first three resume on the petri engine and match the oracle on every route
 * with no attribution: the aggregate, its `foreachOutput` entries, the host's `resumeLabels`,
 * `resumePayload` and `resumedAt`, what each item was handed. The nested one stays refused by name
 * (row 77).
 */
function foreachResumeFixtures(): ResumeFixture[] {
  const Items = z.array(N);
  const toItems = (rec: Recorder) =>
    createStep({
      id: 'explode',
      inputSchema: N,
      outputSchema: Items,
      execute: async ({ inputData }) => rec.around('explode', () => Array.from({ length: inputData.n }, (_, i) => ({ n: i + 1 }))),
    });
  const item = (rec: Recorder, suspends: readonly number[]) =>
    createStep({
      id: 'item',
      inputSchema: N,
      outputSchema: N,
      resumeSchema: Add,
      suspendSchema: Ask,
      execute: async ({ inputData, resumeData, suspend }) =>
        rec.around(`item:${inputData.n}`, async () => {
          await delay(2 * (4 - inputData.n));
          if (suspends.includes(inputData.n) && !resumeData) return suspend({ ask: `item ${inputData.n}` });
          return { n: inputData.n * 10 + (resumeData?.add ?? 0) };
        }),
    });
  const build = (id: string, suspends: readonly number[]) => (cfg: EngineConfig, rec: Recorder) =>
    wf(id, cfg).then(toItems(rec)).foreach(item(rec, suspends), { concurrency: 3 }).commit();
  const labels = ['item:1', 'item:2', 'item:3'];
  const independent = labels.flatMap((a, i) => labels.slice(i + 1).map((b): IndependentPair => [a, b]));
  return [
    {
      name: 'resume-foreach-index',
      id: 'rs-fe-index',
      width: 3,
      independent,
      input: { n: 3 },
      resumes: [{ step: 'item', resumeData: { add: 5 }, forEachIndex: 1 }],
      expected: ['suspended', 'success'],
      sites: ['0', '1'],
      build: build('rs-fe-index', [2]),
    },
    {
      name: 'resume-foreach-no-index',
      id: 'rs-fe-all',
      width: 3,
      independent,
      input: { n: 3 },
      resumes: [{ step: 'item', resumeData: { add: 5 } }],
      expected: ['suspended', 'success'],
      sites: ['0', '1'],
      build: build('rs-fe-all', [2]),
    },
    {
      name: 'resume-foreach-parked',
      id: 'rs-fe-parked',
      width: 3,
      independent,
      input: { n: 3 },
      // Items 2 and 3 suspend; resuming item 3 by index re-suspends with item 2 parked, then item 2 finishes it.
      resumes: [
        { step: 'item', resumeData: { add: 7 }, forEachIndex: 2 },
        { step: 'item', resumeData: { add: 5 }, forEachIndex: 1 },
      ],
      expected: ['suspended', 'suspended', 'success'],
      sites: ['0', '1'],
      build: build('rs-fe-parked', [2, 3]),
    },
    {
      name: 'resume-foreach-nested',
      id: 'rs-fe-nested',
      width: 2,
      input: { n: 2 },
      // Settles the PLAUSIBLE nested-in-foreach run id: both items' children suspend, and resuming
      // forEachIndex 1 resumes the child the aggregate's __workflow_meta.runId names — item 0's
      // (step.ts:430; control-flow.ts:1442-1446). Item 1's record gets item 0's result, and item 0
      // then cannot be resumed ("This workflow run was not suspended").
      resumes: [
        { step: ['rs-fe-child', 'ig'], resumeData: { add: 10 }, forEachIndex: 1 },
        { step: ['rs-fe-child', 'ig'], resumeData: { add: 20 }, forEachIndex: 0 },
      ],
      expected: ['suspended', 'suspended', 'failed'],
      sites: ['0', '1'],
      build: (cfg, rec) => {
        const child = createWorkflow({ id: 'rs-fe-child', inputSchema: N, outputSchema: N, ...cfg }).then(gate(rec, 'ig')).commit();
        return wf('rs-fe-nested', cfg).then(toItems(rec)).foreach(child, { concurrency: 2 }).commit();
      },
      overlapDivergences: [
        {
          row: 35,
          paths: ['phases.*.result.steps.rs-fe-child.suspendPayload.__workflow_meta.foreachOutput.*.metadata', 'phases.*.stored.*.*.context.rs-fe-child.suspendPayload.__workflow_meta.foreachOutput.*.metadata'],
          reason:
            "an item's foreachOutput entry carries its metadata.nestedRunId in Mastra (control-flow.ts:1193-1198); here only when the leaf's record is still the item's at its settle. When the two children suspend together, the second's record overwrites the first's before it settles, and the first's entry is rebuilt from its outcome token, which carries no host metadata",
        },
      ],
      divergences: [
        {
          row: 77,
          routes: RESUMES_ON_PETRI,
          paths: ['phases.1.**', 'phases.2.**', 'trace.*'],
          reason:
            "a .foreach() over a nested workflow: Mastra resumes the child named by the aggregate's __workflow_meta.runId, the lowest index, whatever forEachIndex says (step.ts:430; control-flow.ts:1442-1446); the petri engine refuses the resume by name",
        },
      ],
    },
  ];
}

function assertNever(value: never): never {
  throw new Error(`unhandled engine: ${String(value)}`);
}

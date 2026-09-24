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
 */
import { z } from 'zod';
import { createStep, createWorkflow, DefaultExecutionEngine } from '@mastra/core/workflows';
import { createTool } from '@mastra/core/tools';
import { TripWire } from '@mastra/core/agent';
import { MastraNonRetryableError } from '@mastra/core/error';
import { Mastra } from '@mastra/core/mastra';
import { PetriExecutionEngine } from '../../src/mastra/engine.js';
import type {
  Attribution,
  DifferentialCase,
  EngineName,
  Execution,
  IndependentPair,
  Observation,
  TraceEvent,
} from '../../src/conformance/differential.js';

/** The loop bound the petri engine requires and Mastra does not have (`docs/divergences.md` row 13). */
export const ITERATION_BOUND = 20;

/** What a started run offers the harness: Mastra's own `Run`, read structurally. */
interface StartedRun {
  start(args: Record<string, unknown>): Promise<unknown>;
  cancel(): Promise<void>;
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
  try {
    const wf = fixture.build(engineConfig(engine, concurrency), rec);
    const run = await wf.createRun();
    rec.bind(run);
    const result = await run.start({
      inputData: input,
      outputOptions: { includeState: true },
      // A structured clone per engine: the default engine merges state into the object it is handed.
      ...(fixture.initialState === undefined ? {} : { initialState: structuredClone(fixture.initialState) }),
    });
    return { kind: 'resolved', result, trace: [...rec.events], executions: [...executions] };
  } catch (error) {
    return { kind: 'rejected', error, trace: [...rec.events], executions: [...executions] };
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
        paths: ['result.result', 'result.state.seen.**', 'result.steps.s2.output'],
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
    // preceding step returns, measured on the pinned @mastra/core. The petri run has finished by
    // then (row 52), so it records `success []` and the run succeeds.
    build: (cfg, rec) =>
      wf('foreach-empty-cancel-inside', cfg)
        .then(emptyItems(rec, () => afterMicrotasks(INSIDE_EMPTY_FOREACH, () => void rec.cancel())))
        .foreach(echoItem(rec), { concurrency: 5 })
        .commit(),
    divergences: [
      {
        row: 49,
        paths: ['result.steps.item.status'],
        reason:
          "a cancel inside an empty foreach: Mastra's final abort check records canceled [] (handlers/control-flow.ts:1291-1306); the petri foreach completes with no await to land in, so success []",
      },
      {
        row: 52,
        paths: ['result.status', 'result.result'],
        reason:
          'the abort arrives 26 microtasks after the step returns: still inside the run on Mastra, which has several awaits per entry; after the petri run has already succeeded',
      },
    ],
  },
];


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
                paths: ['trace.*'],
                reason:
                  'a budget below the foreach concurrency changes which items were dispatched when the failing item stopped dispatch (handlers/control-flow.ts:1082-1107); the run result is the same',
              },
            ],
          }
        : {}),
      divergences: [
        {
          row: 35,
          paths: ['result.steps.item.suspendPayload'],
          reason:
            "a failed foreach's record carries __workflow_meta.foreachOutput/resumeLabels for replay-skip of succeeded items (handlers/control-flow.ts:1355-1369, #21749); foreach replay bookkeeping is M4",
        },
      ],
      input: { n: count },
      build: (cfg, rec) => wf(`foreach-c${concurrency}-failing-item`, cfg).then(toItems(rec)).foreach(item(rec, 2), { concurrency }).commit(),
    },
  ];
}

function assertNever(value: never): never {
  throw new Error(`unhandled engine: ${String(value)}`);
}

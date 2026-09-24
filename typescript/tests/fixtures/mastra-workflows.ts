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

export function engineConfig(engine: EngineName): EngineConfig {
  switch (engine) {
    case 'default':
      return {};
    case 'petri':
      return { executionEngine: new PetriExecutionEngine({ iterationBound: ITERATION_BOUND }) };
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
  /** Step pairs the net may reorder or overlap (`docs/divergences.md` row 4); none at k = 1 so far. */
  readonly independent?: readonly IndependentPair[];
}

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
export async function observe(fixture: MastraFixture, engine: EngineName, input: unknown): Promise<Observation> {
  const rec = new Recorder();
  const executions: Execution[] = [];
  const undo = [
    probeExecute(PetriExecutionEngine.prototype, 'petri', executions),
    probeExecute(DefaultExecutionEngine.prototype, 'default', executions),
  ];
  try {
    const wf = fixture.build(engineConfig(engine), rec);
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

export function toCase(fixture: MastraFixture): DifferentialCase {
  return {
    name: fixture.name,
    input: fixture.input,
    run: (engine, input) => observe(fixture, engine, input),
    ...(fixture.divergences === undefined ? {} : { divergences: fixture.divergences }),
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
];

function foreachFixtures(concurrency: number): MastraFixture[] {
  const Items = z.array(N);
  const item = (rec: Recorder, failOn?: number) =>
    createStep({
      id: 'item',
      inputSchema: N,
      outputSchema: N,
      execute: async ({ inputData }) =>
        rec.around(`item:${inputData.n}`, async () => {
          // Later items finish first, so a concurrent run's completion order differs from its start order.
          await new Promise<void>((resolve) => setTimeout(resolve, 12 - 3 * inputData.n));
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
  return [
    {
      name: `foreach-c${concurrency}`,
      expected: 'success',
      input: { n: 3 },
      build: (cfg, rec) => wf(`foreach-c${concurrency}`, cfg).then(toItems(rec)).foreach(item(rec), { concurrency }).commit(),
    },
    {
      name: `foreach-c${concurrency}-failing-item`,
      expected: 'failed',
      divergences: [
        {
          row: 35,
          paths: ['result.steps.item.suspendPayload'],
          reason:
            "a failed foreach's record carries __workflow_meta.foreachOutput/resumeLabels for replay-skip of succeeded items (handlers/control-flow.ts:1355-1369, #21749); foreach replay bookkeeping is M4",
        },
      ],
      input: { n: 3 },
      build: (cfg, rec) => wf(`foreach-c${concurrency}-failing-item`, cfg).then(toItems(rec)).foreach(item(rec, 2), { concurrency }).commit(),
    },
  ];
}

function assertNever(value: never): never {
  throw new Error(`unhandled engine: ${String(value)}`);
}

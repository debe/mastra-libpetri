/**
 * **The `pipeline()` surface** ([ADR 0015], M7b W1 C): what `init().pipeline` mints, what it refuses
 * at mint, and that the mark is ignorable on Mastra's `DefaultExecutionEngine`.
 *
 * - **The factory.** `[body, options]`: the body is a committed nested workflow `stages[0] -> … ->
 *   stages[s-1]` with stage 0's input schema, the last stage's output schema, a copying state schema
 *   and `validateInputs: true`; the options carry `concurrency: Σc_j`, the description, and a fresh
 *   `metadata` with the author's keys and the frozen `Pipeline` under a symbol `JSON` drops.
 * - **Refusals at mint**, by name: `pipeline-empty`, `pipeline-value`, `blueprint-arms`,
 *   `blueprint-position`.
 * - **The copying state schema** (the W0 amendment): on Mastra's own engines a failed item merges
 *   nothing into the run's state — pinned on a pure-Mastra oracle built from the very parameters the
 *   factory mints with, against the same body without a state schema, which leaks.
 * - **The Layer test.** A pipeline-marked workflow, forced onto `DefaultExecutionEngine` through
 *   Mastra's `cloneWorkflow`, runs as `.foreach(nestedWorkflow, { concurrency: Σc_j })`: every item
 *   through every stage, the same output, records and peak item window as a hand-written twin.
 * - **The types**, as `@ts-expect-error` under `npm run check` (`surfaceTypes`, never run).
 *
 * Environment: `@mastra/core` from the pinned registry package, libpetri 8.0.0 (registry, not
 * linked), the machine clock (small real timers). Tested, not proven. Each case names the mutation
 * that breaks it.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent } from '@mastra/core/agent';
import {
  cloneWorkflow,
  createStep as mastraCreateStep,
  createWorkflow as mastraCreateWorkflow,
} from '@mastra/core/workflows';
import { MAX_FOREACH_LANES } from '../../src/compiler/index.js';
import { init, type PetriStep } from '../../src/mastra/index.js';
import {
  FOREACH_PIPELINE,
  mintBody,
  Pipeline,
  PIPELINE_STATE_SCHEMA,
  pipelineOf,
  type BodyChain,
  type PipelineBodyParams,
} from '../../src/mastra/pipeline.js';
import { BLOCK_DECISION } from '../../src/mastra/resources.js';

const { createWorkflow, createStep, cloneStep, pipeline, race } = init();

const Item = z.object({ n: z.number(), fail: z.boolean().optional() });
const Mid = z.object({ n: z.number(), fail: z.boolean().optional(), seen: z.array(z.string()) });
const Out = z.object({ out: z.string() });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const mk = (id: string, metadata?: Record<string, unknown>) =>
  createStep({ id, inputSchema: Item, outputSchema: Item, ...(metadata ? { metadata } : {}), execute: async ({ inputData }) => inputData });

/** Graph-level view of a committed workflow. */
interface Graph {
  readonly id: string;
  readonly stepGraph: readonly { type: string; step?: unknown; metadata?: unknown; opts?: unknown }[];
  readonly serializedStepGraph: readonly unknown[];
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
  readonly stateSchema: unknown;
  readonly options: { readonly validateInputs?: boolean };
  readonly retryConfig?: { readonly attempts?: number };
  readonly executionEngine: { constructor: { name: string } };
}

/** Catches what `fn` throws. */
function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a refusal');
}

describe('the factory', () => {
  it('mints the body stage 0 -> … -> s-1 and the foreach options carrying the frozen Pipeline', () => {
    // Breaks if: the body is chained in another order, takes another stage's schemas, drops the copying
    // state schema or validateInputs, carries a retryConfig; or the options carry an `id`, a
    // concurrency other than Σc_j, or the author's metadata object itself.
    const a = mk('a'), b = mk('b'), c = mk('c');
    const userMetadata = { checkpoint: true, note: 'x' };
    const [body, options] = pipeline([a, b, c], { id: 'per', concurrency: [2, 1, 3], description: 'docs', metadata: userMetadata });
    const g = body as unknown as Graph;
    expect(g.id).toBe('per');
    expect(g.stepGraph.map((e) => [e.type, e.step])).toEqual([['step', a], ['step', b], ['step', c]]);
    expect(g.inputSchema).toBe(a.inputSchema);
    expect(g.outputSchema).toBe(c.outputSchema);
    expect(g.stateSchema).toBe(PIPELINE_STATE_SCHEMA);
    expect(g.options.validateInputs).toBe(true);
    expect(g.retryConfig?.attempts ?? 0).toBe(0);
    expect(g.executionEngine.constructor.name).toBe('PetriExecutionEngine');

    expect('id' in options).toBe(false);
    expect(options.concurrency).toBe(6);
    expect(options.description).toBe('docs');
    expect(options.metadata).not.toBe(userMetadata);
    expect(userMetadata).toEqual({ checkpoint: true, note: 'x' });
    expect(Object.getOwnPropertySymbols(userMetadata)).toEqual([]);
    expect(options.metadata).toMatchObject({ checkpoint: true, note: 'x' });

    const p = pipelineOf(options.metadata);
    expect(p).toBeInstanceOf(Pipeline);
    const minted = p as Pipeline;
    expect(minted.body).toBe(body);
    expect(minted.stages).toEqual([a, b, c]);
    minted.stages.forEach((s, j) => expect(s).toBe([a, b, c][j]));
    expect(minted.bounds).toEqual([2, 1, 3]);
    expect(minted.id).toBe('per');
    expect(minted.width).toBe(6);
    expect(Object.isFrozen(minted) && Object.isFrozen(minted.stages) && Object.isFrozen(minted.bounds)).toBe(true);
  });

  it('concurrency: absent is 1 per stage; one number is that number per stage', () => {
    // Breaks if: an absent concurrency defaults to anything but 1, or a number is not spread per stage.
    const [, one] = pipeline([mk('a'), mk('b')], { id: 'p1' });
    expect(one.concurrency).toBe(2);
    expect((pipelineOf(one.metadata) as Pipeline).bounds).toEqual([1, 1]);
    const [, three] = pipeline([mk('a'), mk('b'), mk('c')], { id: 'p3', concurrency: 3 });
    expect(three.concurrency).toBe(9);
    expect((pipelineOf(three.metadata) as Pipeline).bounds).toEqual([3, 3, 3]);
    const [, bare] = pipeline([mk('a')], { id: 'bare' });
    expect('description' in bare).toBe(false);
  });

  it('agent and tool stages enter the body as Mastra\'s declarative entries', () => {
    // Breaks if: the body is built from anything but `.then(stage)` (which keeps an agent's ref and options).
    const agent = new Agent({ id: 'writer', name: 'writer', instructions: 'be brief', model: {} as never });
    const options = { retries: 1 };
    const st = createStep(agent, options);
    const [body] = pipeline([st], { id: 'ask' });
    const entry = (body as unknown as Graph).stepGraph[0] as unknown as { type: string; agent: unknown; options: unknown };
    expect(entry.type).toBe('agent');
    expect(entry.agent).toBe(agent);
    expect(entry.options).toBe(options);
  });

  it('only the factory mints a Pipeline', () => {
    // Breaks if: the constructor guard is dropped.
    expect(() => new (Pipeline as unknown as new (...args: unknown[]) => Pipeline)(Symbol('forged'), {}, [], [])).toThrow(/init\(\)\.pipeline/);
  });

  it('spread into .foreach(): the entry keeps the options object, and the serialized graph is a plain foreach', () => {
    // Breaks if: the options omit `concurrency` (Mastra then copies them, `workflow.ts:2630-2636`), or
    // the marker sits under a string key (JSON would carry it to the default engine's graph).
    const [body, options] = pipeline([mk('a'), mk('b')], { id: 'per', concurrency: [2, 1], metadata: { checkpoint: false } });
    const parent = createWorkflow({ id: 'w', inputSchema: z.array(Item), outputSchema: z.any() }).foreach(body, options).commit();
    const g = parent as unknown as Graph;
    expect(g.stepGraph[0]!.opts).toBe(options);
    expect(g.stepGraph[0]!.metadata).toBe(options.metadata);
    expect(pipelineOf(g.stepGraph[0]!.metadata)).toBeInstanceOf(Pipeline);
    const serialized = JSON.parse(JSON.stringify(g.serializedStepGraph[0])) as { type: string; opts: unknown; metadata: unknown };
    expect(serialized.type).toBe('foreach');
    expect(serialized.opts).toEqual({ concurrency: 3 });
    expect(serialized.metadata).toEqual({ checkpoint: false });
  });
});

describe('refusals at mint', () => {
  const cases: [string, () => unknown, RegExp][] = [
    ['no stages', () => pipeline([] as never, { id: 'p' }), /^pipeline\('p'\): pipeline-empty/],
    ['a bound of 0', () => pipeline([mk('a'), mk('b')], { id: 'p', concurrency: [1, 0] }), /pipeline-value: stage 1's concurrency/],
    ['a fractional bound', () => pipeline([mk('a')], { id: 'p', concurrency: 1.5 }), /pipeline-value: stage 0's concurrency/],
    ['a string bound', () => pipeline([mk('a')], { id: 'p', concurrency: '2' as never }), /pipeline-value/],
    ['a short bound vector', () => pipeline([mk('a'), mk('b')], { id: 'p', concurrency: [1] as never }), /pipeline-value: concurrency gives 1 bound\(s\) for 2/],
    [
      'Σc_j above MAX_FOREACH_LANES',
      () => pipeline([mk('a'), mk('b')], { id: 'p', concurrency: [MAX_FOREACH_LANES, 1] }),
      new RegExp(`pipeline-value: .* adds up to ${MAX_FOREACH_LANES + 1}`),
    ],
    ['no id', () => pipeline([mk('a')], {} as never), /pipeline-value: the id is required/],
    ['stages not an array', () => pipeline(mk('a') as never, { id: 'p' }), /blueprint-arms: the stages must be an array/],
    ['a stage listed twice', () => { const a = mk('a'); return pipeline([a, a], { id: 'p' }); }, /blueprint-arms: stage 1 is the same step as stage 0/],
    ['two stages sharing an id', () => pipeline([mk('a'), mk('a')], { id: 'p' }), /blueprint-arms: two stages have the id "a"/],
    [
      'a nested-workflow stage',
      () => pipeline([createWorkflow({ id: 'child', inputSchema: Item, outputSchema: Item }).then(mk('in')).commit() as never], { id: 'p' }),
      /blueprint-arms: stage 0 \('child'\) is a nested workflow/,
    ],
    [
      'a race marker on a stage',
      () => pipeline([mk('a', race([mk('x')])[1].metadata)], { id: 'p' }),
      /blueprint-position: stage 0 \('a'\) carries a race \/ quorum \/ pipeline marker/,
    ],
    [
      'a pipeline marker on a stage',
      () => pipeline([mk('b'), mk('a', pipeline([mk('x')], { id: 'q' })[1].metadata)], { id: 'p' }),
      /blueprint-position: stage 1 \('a'\)/,
    ],
  ];
  for (const [name, fn, why] of cases) {
    it(name, () => {
      // Breaks if: the factory accepts it, or names another refusal.
      expect(thrown(fn).message).toMatch(why);
    });
  }

  it('a marker on an agent stage\'s options is seen too', () => {
    // Breaks if: the stage's metadata is read only off the Step object, not its kept options.
    const agent = new Agent({ id: 'writer', name: 'writer', instructions: 'be brief', model: {} as never });
    const st = createStep(agent, { metadata: { ...race([mk('x')])[1].metadata } } as never);
    // Mastra copies the options' metadata onto the step too; clear that copy so only the kept
    // options carry the marker, and the read of `__agentOptions` is what refuses it.
    (st as { metadata?: unknown }).metadata = undefined;
    expect((st as unknown as { __agentOptions?: { metadata?: object } }).__agentOptions?.metadata).toBeDefined();
    expect(thrown(() => pipeline([st], { id: 'p' })).message).toMatch(/blueprint-position/);
  });

  it('a stage cloned under its own id is a different stage', () => {
    // Breaks if: stages are compared by something coarser than identity and id.
    const a = mk('a');
    expect(() => pipeline([a, cloneStep(a, { id: 'a2' })], { id: 'p' })).not.toThrow();
  });
});

describe('the copying state schema: a failed item merges nothing', () => {
  it('validates into a fresh object, every key kept', () => {
    // Breaks if: the schema is one that strips keys (a bare z.object) or returns its input.
    const state = { init: true, nested: { k: 1 }, list: [1] };
    const result = PIPELINE_STATE_SCHEMA['~standard'].validate(state) as { value: unknown };
    expect(result.value).not.toBe(state);
    expect(result.value).toEqual(state);
  });

  /**
   * A pure-Mastra twin of `.foreach(...pipeline([a, b], { concurrency: [1, 1] }))`: Mastra's own
   * `createWorkflow` and `createStep` throughout, the body built by `mintBody` — the factory's own
   * builder — or the same without a state schema. Item 1 sets its state in `a` and fails in `b`.
   */
  async function oracle(copying: boolean) {
    const a = mastraCreateStep({
      id: 'a',
      inputSchema: Item,
      outputSchema: Item,
      execute: async ({ inputData, state, setState }) => {
        await setState({ ...(state as object), [`a${inputData.n}`]: true });
        await sleep(2);
        return inputData;
      },
    });
    const b = mastraCreateStep({
      id: 'b',
      inputSchema: Item,
      outputSchema: Out,
      execute: async ({ inputData }) => {
        if (inputData.fail) throw new Error(`item ${inputData.n} fails`);
        return { out: `r${inputData.n}` };
      },
    });
    const create = (params: PipelineBodyParams): BodyChain => {
      const { stateSchema: _stateSchema, ...rest } = params;
      return mastraCreateWorkflow((copying ? params : rest) as never) as unknown as BodyChain;
    };
    const body = mintBody(create, 'per', [a, b]);
    const parent = mastraCreateWorkflow({ id: `oracle-${copying}`, inputSchema: z.array(Item), outputSchema: z.any() })
      .foreach(body as never, { concurrency: 2 })
      .commit();
    const run = await parent.createRun();
    return (await run.start({ inputData: [{ n: 0 }, { n: 1, fail: true }], outputOptions: { includeState: true } } as never)) as {
      status: string;
      state?: Record<string, unknown>;
    };
  }

  it('on the pure-Mastra oracle, with the minted parameters: the failed item\'s setState is not merged', async () => {
    // Breaks if: pipelineBodyParams drops the copying state schema — the child then mutates the
    // parent's own state object in place (`default.ts:710`), and `a1` leaks, as the control shows.
    const minted = await oracle(true);
    expect(minted.status).toBe('failed');
    expect(minted.state).toEqual({ a0: true });
    const control = await oracle(false);
    expect(control.status).toBe('failed');
    expect(control.state).toEqual({ a0: true, a1: true });
  });

  it('on the default engine running the minted body (a forced cloneWorkflow): the same', async () => {
    // Breaks if: the minted body lets a failed item's state through on the twin.
    const { parent } = ingest('state', { failAt: 1 });
    const clone = cloned(parent, 'state-clone');
    const run = await clone.createRun();
    const res = (await run.start({ inputData: [{ n: 0 }, { n: 1, fail: true }], outputOptions: { includeState: true } })) as {
      status: string;
      state?: Record<string, unknown>;
    };
    expect(res.status).toBe('failed');
    expect(res.state).toEqual({ a0: true });
  });
});

/** Counts items in flight, and stage calls per item. */
class Trace {
  #now = 0;
  peak = 0;
  readonly calls: string[] = [];
  enter(): void {
    this.#now += 1;
    this.peak = Math.max(this.peak, this.#now);
  }
  leave(): void {
    this.#now -= 1;
  }
}

/**
 * Three stages over `{ n }`: `a` (enters the item window, sets state), `b`, `c` (leaves it). Built
 * with `create` — the petri `createStep`, or Mastra's own for the hand-written twin — from the same
 * functions.
 */
function stagesWith(create: (params: unknown) => unknown, trace: Trace, failAt?: number) {
  const a = create({
    id: 'a',
    inputSchema: Item,
    outputSchema: Mid,
    execute: async ({ inputData, state, setState }: { inputData: z.infer<typeof Item>; state: unknown; setState(s: unknown): Promise<void> }) => {
      trace.enter();
      trace.calls.push(`a${inputData.n}`);
      await setState({ ...(state as object), [`a${inputData.n}`]: true });
      await sleep(4);
      return { ...inputData, seen: ['a'] };
    },
  });
  const b = create({
    id: 'b',
    inputSchema: Mid,
    outputSchema: Mid,
    execute: async ({ inputData }: { inputData: z.infer<typeof Mid> }) => {
      trace.calls.push(`b${inputData.n}`);
      await sleep(1);
      if (inputData.n === failAt) {
        trace.leave();
        throw new Error(`item ${inputData.n} fails in b`);
      }
      return { ...inputData, seen: [...inputData.seen, 'b'] };
    },
  });
  const c = create({
    id: 'c',
    inputSchema: Mid,
    outputSchema: Out,
    execute: async ({ inputData }: { inputData: z.infer<typeof Mid> }) => {
      trace.calls.push(`c${inputData.n}`);
      trace.leave();
      return { out: `${inputData.n}:${[...inputData.seen, 'c'].join('')}` };
    },
  });
  return [a, b, c] as const;
}

/** The petri parent: `.foreach(...pipeline([a, b, c], { id: 'per', concurrency: [2, 1, 1] }))`. */
function ingest(tag: string, opts: { failAt?: number } = {}) {
  const trace = new Trace();
  const [a, b, c] = stagesWith(createStep as never, trace, opts.failAt) as unknown as [
    PetriStep<'a', any, z.infer<typeof Item>, z.infer<typeof Mid>>,
    PetriStep<'b', any, z.infer<typeof Mid>, z.infer<typeof Mid>>,
    PetriStep<'c', any, z.infer<typeof Mid>, z.infer<typeof Out>>,
  ];
  const parent = createWorkflow({ id: `ingest-${tag}`, inputSchema: z.array(Item), outputSchema: z.any() })
    .foreach(...pipeline([a, b, c], { id: 'per', concurrency: [2, 1, 1] }))
    .commit();
  return { parent, trace };
}

/** The hand-written twin: Mastra's own factories, `.foreach(nestedWorkflow, { concurrency: 4 })`. */
function twin(tag: string, opts: { failAt?: number } = {}) {
  const trace = new Trace();
  const [a, b, c] = stagesWith(mastraCreateStep as never, trace, opts.failAt) as unknown as [never, never, never];
  const body = mastraCreateWorkflow({ id: 'per', inputSchema: Item, outputSchema: Out, stateSchema: z.record(z.string(), z.any()) })
    .then(a)
    .then(b)
    .then(c)
    .commit();
  const parent = mastraCreateWorkflow({ id: `twin-${tag}`, inputSchema: z.array(Item), outputSchema: z.any() })
    .foreach(body as never, { concurrency: 4 })
    .commit();
  return { parent: parent as unknown as Runnable, trace };
}

interface RunResult {
  status: string;
  result?: unknown;
  error?: { message?: string };
  state?: Record<string, unknown>;
  steps: Record<string, { status: string; output?: unknown }>;
}
interface Runnable {
  createRun(): Promise<{ start(o: { inputData: unknown; outputOptions?: { includeState?: boolean } }): Promise<unknown> }>;
}

/** Mastra's `cloneWorkflow` of a petri workflow: a `new Workflow` with no engine — the default one. */
function cloned(parent: unknown, id: string): Runnable & Graph {
  return (cloneWorkflow as unknown as (w: unknown, o: { id: string }) => Runnable & Graph)(parent, { id });
}

async function runOn(w: Runnable, items: unknown[]): Promise<RunResult> {
  const run = await w.createRun();
  return (await run.start({ inputData: items, outputOptions: { includeState: true } })) as RunResult;
}

describe('the Layer test: on DefaultExecutionEngine the mark is ignored, and the entry is the twin', () => {
  const items = [0, 1, 2, 3, 4, 5].map((n) => ({ n }));

  it('every item, every stage, the twin\'s output, records, state and item window', async () => {
    // Breaks if: the options carry anything the default engine reads other than `concurrency: Σc_j`
    // (a different window, a changed entry type), or the body is not `a -> b -> c`.
    const petri = ingest('layer');
    const clone = cloned(petri.parent, 'layer-clone');
    expect(clone.executionEngine.constructor.name).toBe('DefaultExecutionEngine');
    expect(clone.stepGraph[0]!.type).toBe('foreach');
    expect(pipelineOf(clone.stepGraph[0]!.metadata)).toBeInstanceOf(Pipeline);

    const ours = await runOn(clone, items);
    const hand = twin('layer');
    const theirs = await runOn(hand.parent, items);

    expect(ours.status).toBe('success');
    expect(ours.result).toEqual(items.map(({ n }) => ({ out: `${n}:abc` })));
    expect(ours.result).toEqual(theirs.result);
    expect(ours.steps['per']).toMatchObject({ status: 'success', output: theirs.steps['per']!.output });
    expect(Object.keys(ours.steps).sort()).toEqual(Object.keys(theirs.steps).sort());
    expect(ours.state).toEqual(theirs.state);
    expect(ours.state).toEqual(Object.fromEntries(items.map(({ n }) => [`a${n}`, true])));
    for (const { n } of items) {
      for (const stage of ['a', 'b', 'c']) {
        expect(petri.trace.calls.filter((c) => c === `${stage}${n}`)).toHaveLength(1);
      }
    }
    expect([...petri.trace.calls].sort()).toEqual([...hand.trace.calls].sort());
    // Σc_j = 4 is the twin's own Layer 1 window: no stage bound applies on the default engine.
    expect(petri.trace.peak).toBe(4);
    expect(hand.trace.peak).toBe(4);
  });

  it('a mid-pipeline failure: the twin\'s status, error and state', async () => {
    // Breaks if: the default engine's run of the marked workflow differs from the twin's on failure.
    const ours = await runOn(cloned(ingest('fail', { failAt: 2 }).parent, 'fail-clone'), items);
    const theirs = await runOn(twin('fail', { failAt: 2 }).parent, items);
    expect(ours.status).toBe('failed');
    expect(theirs.status).toBe('failed');
    expect(ours.error?.message).toBe(theirs.error?.message);
    expect(ours.steps['per']!.status).toBe(theirs.steps['per']!.status);
    expect(ours.state?.['a2']).toBeUndefined();
    expect(theirs.state?.['a2']).toBeUndefined();
  });
});

/**
 * The surface's types, checked by `npm run check` (never run). Beside the contract's own
 * `surfaceTypes` (tests/compiler/pipeline-contract.test.ts): the brand on every stage, `Chained<S>`
 * through an agent-free chain, and the body's types flowing into `.then()`.
 */
export function surfaceTypes(): void {
  const A = createStep({ id: 'a', inputSchema: Item, outputSchema: Mid, execute: async ({ inputData }) => ({ ...inputData, seen: [] }) });
  const B = createStep({ id: 'b', inputSchema: Mid, outputSchema: Out, execute: async () => ({ out: '' }) });
  const plainB = mastraCreateStep({ id: 'b', inputSchema: Mid, outputSchema: Out, execute: async () => ({ out: '' }) });
  const after = createStep({ id: 'after', inputSchema: z.array(Out), outputSchema: z.number(), execute: async ({ inputData }) => inputData.length });
  createWorkflow({ id: 'w', inputSchema: z.array(Item), outputSchema: z.number() })
    .foreach(...pipeline([A, B], { id: 'per', concurrency: [2, 1] }))
    .then(after)
    .commit();
  // @ts-expect-error — a default-engine stage: the brand refuses it
  pipeline([A, plainB], { id: 'plain' });
  // @ts-expect-error — B's output (Out) is not A's input (Item)
  pipeline([A, B, A], { id: 'loop-back' });
  // @ts-expect-error — three bounds for two stages
  pipeline([A, B], { id: 'len', concurrency: [1, 1, 1] });
  const [body] = pipeline([A, B], { id: 'per' });
  // @ts-expect-error — the body's input is Item, not Out
  const wrong: PetriStep<'per', any, z.infer<typeof Out>, z.infer<typeof Out>, any, any> = body;
  void wrong;
  void BLOCK_DECISION;
  void FOREACH_PIPELINE;
}

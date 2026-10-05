import type { Step } from '@mastra/core/workflows';
import { z } from 'zod';
import { MAX_FOREACH_LANES } from '../compiler/index.js';
import type { PetriCreateWorkflow, PetriPipeline, PetriStep } from './init.js';
import { BLOCK_DECISION } from './resources.js';

/**
 * Where `init().pipeline` keeps a `.foreach()`'s minted {@link Pipeline} ([ADR 0015]): a key of the
 * fresh `metadata` object it puts in the returned foreach options. Mastra keeps the foreach's `opts`
 * by reference when `concurrency` is set (`workflow.ts:2630-2636`), which the factory always writes,
 * so the adapter finds the very {@link Pipeline} here; `JSON.stringify` drops a symbol key, so the
 * serialized graph stays a plain `{ type: 'foreach', opts: { concurrency } }` and the default engine
 * never sees it — there the entry runs as `.foreach(nestedWorkflow, { concurrency: Σc_j })`, the twin.
 *
 * Module-private in the package's sense, as `BLOCK_DECISION`: exported for the adapter and the tests,
 * never from `mastra/index.ts`.
 */
export const FOREACH_PIPELINE: unique symbol = Symbol('mastra-libpetri.foreachPipeline');

/** Guards {@link Pipeline}'s constructor: only `init().pipeline` mints one. */
const mintedPipeline: unique symbol = Symbol('mastra-libpetri.pipeline');

/**
 * A minted pipeline ([ADR 0015]): the nested workflow `body = stages[0] -> … -> stages[s-1]` the
 * factory built, the stages it was given (frozen, **kept by identity**), and one bound per stage
 * (frozen). The adapter refuses an entry whose step is not `body`, or whose body's step graph is not
 * exactly these stages by kind (`blueprint-arms`: a step by identity, an agent or tool by id, ref and
 * options identity), and a pipeline spread into two `.foreach()` calls (`blueprint-reused`).
 */
export class Pipeline {
  /** @internal Use `init().pipeline`. */
  constructor(
    key: typeof mintedPipeline,
    /** The minted nested workflow: what the `.foreach()` runs on the default engine, and its record key. */
    readonly body: object,
    /** The Step objects the factory was given, in order. */
    readonly stages: readonly object[],
    /** `c_j`, stage order: whole numbers ≥ 1, as many as stages. */
    readonly bounds: readonly number[],
  ) {
    if (key !== mintedPipeline) throw new TypeError('a Pipeline is made by init().pipeline');
  }

  /** The body's id: the pipeline's `options.id`, and the key Mastra records the aggregate under. */
  get id(): string {
    return (this.body as { id: string }).id;
  }

  /** The item window `W = Σc_j`: the twin's own Layer 1 `concurrency`. */
  get width(): number {
    return this.bounds.reduce((sum, c) => sum + c, 0);
  }
}

/**
 * The `pipeline` marker a `.foreach()` entry's `metadata` carries under {@link FOREACH_PIPELINE}, or
 * `undefined` — every entry built without `pipeline`. Anything under the key that is not a minted
 * {@link Pipeline} is the adapter's to refuse (`blueprint-arms`).
 */
export function pipelineOf(metadata: unknown): unknown {
  if (metadata === null || typeof metadata !== 'object') return undefined;
  if (!Object.prototype.hasOwnProperty.call(metadata, FOREACH_PIPELINE)) return undefined;
  return (metadata as { [FOREACH_PIPELINE]?: unknown })[FOREACH_PIPELINE];
}

/** Any petri step, as a pipeline stage. A default-engine step is not one: the brand rejects it. */
export type PipelineStage = PetriStep<string, any, any, any, any, any, any>;

/** At least one stage, as a tuple: `const S` infers one, and an empty or non-tuple array is a type error. */
export type PipelineStages = readonly [PipelineStage, ...PipelineStage[]];

/** A step's input type. */
export type StageInput<S> = S extends Step<any, any, infer I, any, any, any, any, any> ? I : never;

/** A step's output type. */
export type StageOutput<S> = S extends Step<any, any, any, infer O, any, any, any, any> ? O : never;

/** The last element of a tuple. */
export type LastStage<S extends readonly unknown[]> = S extends readonly [...unknown[], infer L] ? L : never;

/** The element before index `K` (a numeric string key) of a tuple. */
type PreviousStage<S extends readonly unknown[], K> = K extends `${infer N extends number}`
  ? S extends readonly [...infer Head, unknown]
    ? N extends Head['length']
      ? LastStage<Head>
      : PreviousStage<Head, K>
    : never
  : never;

/**
 * Each stage `j > 0` kept as it is when stage `j − 1`'s output is assignable to its input, `never`
 * otherwise — so `stages: S & Chained<S>` puts a broken chain's error on the offending stage (the W0
 * spike checked it to 60 stages).
 */
export type Chained<S extends readonly unknown[]> = {
  readonly [K in keyof S]: K extends '0' ? S[K] : [StageOutput<PreviousStage<S, K>>] extends [StageInput<S[K]>] ? S[K] : never;
};

/**
 * What `pipeline` takes beside its stages: the body's `id` (required — it is the minted nested
 * workflow's id, the key Mastra's foreach records under, and what `getStepResult` and restart read),
 * `concurrency` — Mastra's word — per stage (one number for every stage, or one per stage; default 1),
 * and Mastra's own foreach options. `metadata` is copied into a fresh object, its keys kept
 * (`checkpoint` among them, [ADR 0010]).
 */
export interface PipelineOptions<TId extends string = string, S extends readonly unknown[] = PipelineStages> {
  readonly id: TId;
  readonly concurrency?: number | { readonly [K in keyof S]: number };
  readonly description?: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * The options `pipeline` hands back, to spread into `.foreach()` with the body. No `id`: the entry has
 * one id, the body's. `concurrency` is Σc_j, always written.
 */
export interface PipelineEntryOptions {
  readonly concurrency: number;
  readonly description?: string;
  readonly metadata: Record<string, unknown> & { readonly [FOREACH_PIPELINE]: Pipeline };
}

/**
 * The minted body's type: a petri step from stage 0's input to the last stage's output — not a
 * petri `Workflow`, which implements `Step<…, DefaultEngineType, …>` (`workflow.ts:1740`) and does not
 * spread into a petri `.foreach()`; the factory re-brands it, as `createStep(workflow)` does (the W0
 * spike's amendment).
 */
export type PipelineBody<TId extends string, S extends PipelineStages> = PetriStep<
  TId,
  any,
  StageInput<S[0]>,
  StageOutput<LastStage<S>>,
  any,
  any
>;

/**
 * The minted body's `stateSchema` ([ADR 0015], the W0 spike's amendment): any object of string keys,
 * every key kept. Its only job is to **copy**. Without a body `stateSchema`, Mastra's
 * `_validateInitialState` hands the child run the parent's very state object
 * (`workflow.ts:3646-3648`) and the child mutates it in place (`default.ts:710`, `:917`), so a failed
 * item's earlier-stage `setState` would reach the parent. With one, the state is validated into a
 * fresh object (`workflow.ts:3622-3636`) and only a returning item merges it back
 * (`workflow.ts:3054`): the snapshot maintainer decision 3 describes, by construction rather than by
 * the parent's options. A shallow copy, as `Object.assign` merges shallowly.
 *
 * Exported for the tests.
 */
export const PIPELINE_STATE_SCHEMA = z.record(z.string(), z.any());

/** The blueprint markers a stage's own metadata must not carry (`blueprint-position`). */
const MARKERS: readonly symbol[] = [BLOCK_DECISION, FOREACH_PIPELINE];

/**
 * `init().pipeline`, bound to `init()`'s `createWorkflow` ([ADR 0015]). Checks its arguments, in the
 * adapter's order — `pipeline-empty`, `pipeline-value`, `blueprint-arms`, `blueprint-position` — so a
 * refusal names the same reason at either point; builds
 *
 * ```ts
 * body = createWorkflow({ id, inputSchema: stages[0].inputSchema, outputSchema: last.outputSchema,
 *                         stateSchema: PIPELINE_STATE_SCHEMA, options: { validateInputs: true } })
 *          .then(stages[0])…then(stages[s-1]).commit()
 * ```
 *
 * with no `retryConfig` — the twin's stages run under the child's `{ attempts: 0 }`; on the petri
 * engine each stage's retries are its own under the **parent's** `retryConfig` (maintainer decision
 * 2) — and mints `{ concurrency: Σc_j, description?, metadata: { ...user, [FOREACH_PIPELINE]:
 * Pipeline } }`. `concurrency` is always written, so Mastra keeps the options object by reference
 * (`workflow.ts:2630-2636`) and the adapter can tell a hand-altered value (`pipeline-value`).
 *
 * The author's `metadata` is copied, never written to; its keys are kept (`checkpoint` among them,
 * [ADR 0010]; a `concurrency` there is the adapter's `concurrency-foreach`).
 */
export function bindPipeline(createWorkflow: PetriCreateWorkflow): PetriPipeline {
  return ((stages: unknown, options: PipelineOptions | undefined) => {
    const id: unknown = options?.id;
    const label = `pipeline(${typeof id === 'string' ? `'${id}'` : String(id)})`;
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError(
        `${label}: pipeline-value: the id is required and must be a non-empty string — it is the body's id, ` +
          'the key Mastra records the aggregate under',
      );
    }
    if (!Array.isArray(stages)) {
      throw new TypeError(`${label}: blueprint-arms: the stages must be an array of steps, got ${typeof stages}`);
    }
    if (stages.length === 0) {
      throw new RangeError(`${label}: pipeline-empty: a pipeline needs at least one stage`);
    }
    const bounds = boundsOf(label, options?.concurrency, stages.length);
    checkStages(label, stages);

    const body = mintBody(createWorkflow as unknown as (params: PipelineBodyParams) => BodyChain, id, stages);

    const pipeline = Object.freeze(new Pipeline(mintedPipeline, body, Object.freeze([...stages]), Object.freeze(bounds)));
    // A fresh object: the author's metadata is never written to. The symbol key is enumerable, so a
    // spread copy carries the pipeline with it — and a copy on a second `.foreach()` is refused as
    // `blueprint-reused` rather than silently running as a plain foreach.
    const metadata = { ...(options?.metadata ?? {}), [FOREACH_PIPELINE]: pipeline } as PipelineEntryOptions['metadata'];
    const entryOptions: PipelineEntryOptions = {
      concurrency: pipeline.width,
      ...(options?.description !== undefined ? { description: options.description } : {}),
      metadata,
    };
    return [body, entryOptions];
  }) as unknown as PetriPipeline;
}

/** What the body is created with: {@link pipelineBodyParams}. */
export interface PipelineBodyParams {
  readonly id: string;
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
  readonly stateSchema: typeof PIPELINE_STATE_SCHEMA;
  readonly options: { readonly validateInputs: true };
}

/** The part of Mastra's workflow builder the body uses. */
export interface BodyChain {
  then(step: unknown): BodyChain;
  commit(): object;
}

/**
 * The minted body's `createWorkflow` parameters ([ADR 0015], amended): stage 0's input schema, the
 * last stage's output schema, the copying {@link PIPELINE_STATE_SCHEMA} and `validateInputs: true`;
 * no `retryConfig`. One definition, so the tests' pure-Mastra oracle (Mastra's own `createWorkflow`
 * over the same parameters) is the body the factory mints.
 */
export function pipelineBodyParams(id: string, stages: readonly unknown[]): PipelineBodyParams {
  const first = stages[0] as { inputSchema?: unknown };
  const last = stages[stages.length - 1] as { outputSchema?: unknown };
  return {
    id,
    inputSchema: first.inputSchema,
    outputSchema: last.outputSchema,
    stateSchema: PIPELINE_STATE_SCHEMA,
    options: { validateInputs: true },
  };
}

/** `createWorkflow(pipelineBodyParams(id, stages)).then(stages[0])…then(stages[s-1]).commit()`. */
export function mintBody(createWorkflow: (params: PipelineBodyParams) => BodyChain, id: string, stages: readonly unknown[]): object {
  let chain = createWorkflow(pipelineBodyParams(id, stages));
  for (const stage of stages) chain = chain.then(stage);
  return chain.commit();
}

/**
 * `c_j` per stage, refused as `pipeline-value` unless each is a whole number ≥ 1, the vector (when one
 * is given) has one per stage, and Σc_j is at most `MAX_FOREACH_LANES`. Absent is 1 per stage; one
 * number is that number per stage.
 */
function boundsOf(label: string, concurrency: unknown, s: number): number[] {
  const given: readonly unknown[] =
    concurrency === undefined ? Array<number>(s).fill(1) : Array.isArray(concurrency) ? concurrency : Array<unknown>(s).fill(concurrency);
  if (given.length !== s) {
    throw new RangeError(
      `${label}: pipeline-value: concurrency gives ${given.length} bound(s) for ${s} stage(s); give one per stage, or one number for all`,
    );
  }
  given.forEach((c, j) => {
    if (typeof c !== 'number' || !Number.isSafeInteger(c) || c < 1) {
      throw new RangeError(`${label}: pipeline-value: stage ${j}'s concurrency must be a whole number of at least 1, got ${String(c)}`);
    }
  });
  const bounds = given as number[];
  const width = bounds.reduce((sum, c) => sum + c, 0);
  if (width > MAX_FOREACH_LANES) {
    throw new RangeError(
      `${label}: pipeline-value: the stages' concurrency adds up to ${width} items in flight, above the ${MAX_FOREACH_LANES} ` +
        'this engine supports',
    );
  }
  return [...bounds];
}

/**
 * Each stage is a step object listed once, with an id no other stage has, that is not a nested
 * workflow (M8 compiles those) — `blueprint-arms` — and carries no blueprint marker in its own
 * metadata — `blueprint-position`. A stage built from an agent or tool keeps its metadata on the
 * options object Mastra keeps as `__agentOptions` / `__toolOptions`, which the adapter reads too.
 */
function checkStages(label: string, stages: readonly unknown[]): void {
  const ids = new Set<unknown>();
  stages.forEach((stage, j) => {
    if (stage === null || (typeof stage !== 'object' && typeof stage !== 'function')) {
      throw new TypeError(`${label}: blueprint-arms: stage ${j} is not a step`);
    }
    if (stages.indexOf(stage) !== j) {
      throw new TypeError(`${label}: blueprint-arms: stage ${j} is the same step as stage ${stages.indexOf(stage)}; list each stage once`);
    }
    const s = stage as { id?: unknown; component?: unknown; metadata?: unknown; __agentOptions?: unknown; __toolOptions?: unknown };
    if (ids.has(s.id)) {
      throw new TypeError(
        `${label}: blueprint-arms: two stages have the id ${JSON.stringify(s.id)}; each stage is recorded under its id. ` +
          'Give one its own id with cloneStep().',
      );
    }
    ids.add(s.id);
    if (s.component === 'WORKFLOW') {
      throw new TypeError(
        `${label}: blueprint-arms: stage ${j} ('${String(s.id)}') is a nested workflow; a pipeline stage is a step, an agent or ` +
          'a tool',
      );
    }
    const carriers = [s.metadata, (s.__agentOptions as { metadata?: unknown } | undefined)?.metadata, (s.__toolOptions as { metadata?: unknown } | undefined)?.metadata];
    for (const metadata of carriers) {
      if (metadata === null || typeof metadata !== 'object') continue;
      if (MARKERS.some((key) => Object.prototype.hasOwnProperty.call(metadata, key))) {
        throw new TypeError(
          `${label}: blueprint-position: stage ${j} ('${String(s.id)}') carries a race / quorum / pipeline marker in its own ` +
            'metadata; a marker belongs on the call it decides — .parallel(...race()) or .foreach(...pipeline())',
        );
      }
    }
  });
}

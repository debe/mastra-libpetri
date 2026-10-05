import type { Step } from '@mastra/core/workflows';
import type { PetriCreateWorkflow, PetriPipeline, PetriStep } from './init.js';

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
 * `init().pipeline`, bound to `init()`'s `createWorkflow` ([ADR 0015]). The factory will check its
 * arguments (`pipeline-empty`, `pipeline-value`, `blueprint-arms`, `blueprint-position` on a stage's
 * own marker), build `body = createWorkflow({ id, inputSchema: stages[0].inputSchema, outputSchema:
 * last.outputSchema, stateSchema: <copying>, options: { validateInputs: true } }).then(stages[0])…
 * .commit()` with no `retryConfig` — the copying state schema and `validateInputs` make the twin the
 * snapshot maintainer decision 3 describes, by construction — and mint `{ concurrency: Σc_j,
 * description?, metadata: { ...user, [FOREACH_PIPELINE]: Pipeline } }`.
 *
 * Contract stub (M7b W0): W1 C builds it. Binding it is free — `init()` never calls the stub — and
 * calling it throws.
 */
export function bindPipeline(createWorkflow: PetriCreateWorkflow): PetriPipeline {
  void createWorkflow;
  return ((_stages: unknown, options?: { readonly id?: unknown }) => {
    throw new Error(`pipeline('${String(options?.id)}'): not implemented (M7b W1)`);
  }) as unknown as PetriPipeline;
}

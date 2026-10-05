import {
  cloneStep as mastraCloneStep,
  createStep as mastraCreateStep,
  Workflow,
  type AgentStepOptions,
  type CreateWorkflowParams,
  type InferSchemaOutput,
  type Step,
  type StepMetadata,
  type StepParams,
} from '@mastra/core/workflows';
import type { Agent, SubAgent } from '@mastra/core/agent';
import type { ActorSignal } from '@mastra/core/auth/ee';
import type { MastraScorers } from '@mastra/core/evals';
import type { Processor, ProcessorStepInputSchema, ProcessorStepOutputSchema } from '@mastra/core/processors';
import type { InferPublicSchema, PublicSchema, StandardSchemaWithJSON } from '@mastra/core/schema';
import type { Tool, ToolExecutionContext } from '@mastra/core/tools';
import type { DynamicArgument } from '@mastra/core/types';
import { PetriExecutionEngine, type PetriEngineOptions } from './engine.js';
import {
  attachResources,
  limit,
  Quota,
  quorum,
  race,
  rateLimit,
  resourcesOf,
  type DecisionEntryOptions,
  type DecisionOptions,
  type QuotaOptions,
  type StepResources,
} from './resources.js';
import {
  bindPipeline,
  type Chained,
  type PipelineBody,
  type PipelineEntryOptions,
  type PipelineOptions,
  type PipelineStages,
} from './pipeline.js';

declare const petriEngine: unique symbol;

/**
 * The phantom engine type of every workflow and step built by {@link init} — Mastra's
 * `TEngineType`, the slot `@mastra/inngest` brands with `InngestEngineType`.
 *
 * Mastra reads `TEngineType` in exactly one place a step exposes: the `engine` parameter of the
 * step's `execute` (and of conditions), which is contravariant. Mastra's own brand is
 * `DefaultEngineType = {}`, and every object type is assignable to `{}`, so an object brand alone
 * rejects only one direction (a petri step in a default workflow). The `| undefined` makes this
 * type and `{}` incomparable, so a step built for either engine is rejected by the other.
 *
 * It is a type, never a value: `StepExecutor` passes `engine: {}` at runtime, and the key is a
 * `unique symbol` nothing can name, so no code can read the brand and act on it.
 */
export type PetriEngineType = { readonly [petriEngine]: 'petri' } | undefined;

/** A step on the petri engine: Mastra's `Step` with {@link PetriEngineType} as its engine type. */
export type PetriStep<
  TStepId extends string = string,
  TState = unknown,
  TInput = unknown,
  TOutput = unknown,
  TResume = unknown,
  TSuspend = unknown,
  TRequestContext extends Record<string, any> | unknown = unknown,
> = Step<TStepId, TState, TInput, TOutput, TResume, TSuspend, PetriEngineType, TRequestContext>;

/**
 * A workflow on the petri engine. Every builder method (`then`, `parallel`, `branch`, `dowhile`,
 * `foreach`, …) is Mastra's own and threads `TEngineType` through, so the brand needs nothing here
 * beyond the first type argument.
 */
export type PetriWorkflow<
  TSteps extends Step<string, any, any, any, any, any, PetriEngineType, any>[] = PetriStep[],
  TWorkflowId extends string = string,
  TState = unknown,
  TInput = unknown,
  TOutput = unknown,
  TPrevSchema = TInput,
  TRequestContext extends Record<string, any> | unknown = unknown,
> = Workflow<PetriEngineType, TSteps, TWorkflowId, TState, TInput, TOutput, TPrevSchema, TRequestContext>;

/**
 * What {@link init} takes: the engine's own options. `mastra` arrives per workflow
 * (`createWorkflow({ mastra })` or registration), and the execution options come from Mastra's own
 * `createWorkflow({ options })`, exactly as the default engine receives them.
 */
export type PetriInitOptions = Omit<PetriEngineOptions, 'mastra' | 'options'>;

/**
 * `createWorkflow` on the petri engine: Mastra's `createWorkflow` parameters, less the two that pick
 * an engine. `executionEngine` is this factory's to set; `schedule` makes Mastra select its evented
 * engine instead (`create.ts:55-66`), so it is refused here rather than silently ignored.
 */
export type PetriCreateWorkflow = <
  TWorkflowId extends string = string,
  TInputSchema extends PublicSchema<any> = PublicSchema<any>,
  TOutputSchema extends PublicSchema<any> = PublicSchema<any>,
  TStateSchema extends PublicSchema<any> | undefined = undefined,
  TSteps extends Step<string, any, any, any, any, any, PetriEngineType>[] = PetriStep[],
  TRequestContextSchema extends PublicSchema<any> | undefined = undefined,
>(
  params: CreateWorkflowParams<TWorkflowId, TStateSchema, TInputSchema, TOutputSchema, TSteps, TRequestContextSchema> & {
    readonly executionEngine?: never;
    readonly schedule?: never;
  },
) => Workflow<
  PetriEngineType,
  TSteps,
  TWorkflowId,
  InferSchemaOutput<TStateSchema>,
  InferPublicSchema<TInputSchema>,
  InferPublicSchema<TOutputSchema>,
  InferPublicSchema<TInputSchema>,
  InferSchemaOutput<TRequestContextSchema>
>;

type ProcessorSource<TProcessorId extends string> =
  | (Processor<TProcessorId> & { processInput: Function })
  | (Processor<TProcessorId> & { processInputStream: Function })
  | (Processor<TProcessorId> & { processInputStep: Function })
  | (Processor<TProcessorId> & { processOutputStream: Function })
  | (Processor<TProcessorId> & { processOutputResult: Function })
  | (Processor<TProcessorId> & { processOutputStep: Function })
  | (Processor<TProcessorId> & { processToolResult: Function })
  | (Processor<TProcessorId> & { computeStateSignal: Function });

type ProcessorStep<TProcessorId extends string> = PetriStep<
  `processor:${TProcessorId}`,
  unknown,
  InferPublicSchema<typeof ProcessorStepInputSchema>,
  InferPublicSchema<typeof ProcessorStepOutputSchema>,
  unknown,
  unknown
>;

/**
 * What the petri `createStep` accepts beside Mastra's own parameters — Layer 3, so only here, behind
 * the brand ([ADR 0002]). Mastra's own `createStep` has neither key, so an object literal carrying
 * one is an excess-property error there, and a {@link Quota} is minted only by {@link init}'s
 * factories.
 *
 * Stripped before Mastra's `createStep` sees the parameters and attached to the Step under
 * `STEP_RESOURCES` (`resources.ts`), where the adapter reads them.
 */
export interface PetriStepResources {
  /**
   * The quotas every attempt of this step draws on ([ADR 0012]), from `init().limit` /
   * `init().rateLimit`. A declarative `.agent('id')` / `.tool('id')` never passes through here and
   * cannot carry one (`uses-position`).
   */
  readonly uses?: readonly Quota[];
  /**
   * A per-attempt deadline in milliseconds ([ADR 0013]): on expiry the attempt's signal aborts, the
   * step is waited for, its result discarded, and the attempt fails with a `StepTimeoutError` —
   * retried like any thrown error. A whole number in [1, `MAX_WAIT_MS`] (`timeout-value`).
   */
  readonly timeout?: number;
}

/**
 * `createStep` on the petri engine: Mastra's overloads, one for one, each returning a
 * {@link PetriStep}, plus one Mastra has no need for — a petri workflow passed as a step. Mastra
 * nests a workflow by handing it to `.then()` directly, but a `Workflow` declares its own `execute`
 * with `DefaultEngineType` (`workflow.d.ts`), which the brand rejects; this overload returns the
 * very same workflow object, so Mastra still sees `component === 'WORKFLOW'` and nests it.
 */
export interface PetriCreateStep {
  <
    TStepId extends string,
    TStateSchema extends PublicSchema | undefined,
    TInputSchema extends PublicSchema,
    TOutputSchema extends PublicSchema,
    TResumeSchema extends PublicSchema | undefined = undefined,
    TSuspendSchema extends PublicSchema | undefined = undefined,
    TRequestContextSchema extends PublicSchema | undefined = undefined,
  >(
    params: StepParams<TStepId, TStateSchema, TInputSchema, TOutputSchema, TResumeSchema, TSuspendSchema, TRequestContextSchema> &
      PetriStepResources,
  ): PetriStep<
    TStepId,
    TStateSchema extends PublicSchema ? InferPublicSchema<TStateSchema> : unknown,
    InferPublicSchema<TInputSchema>,
    InferPublicSchema<TOutputSchema>,
    TResumeSchema extends PublicSchema ? InferPublicSchema<TResumeSchema> : unknown,
    TSuspendSchema extends PublicSchema ? InferPublicSchema<TSuspendSchema> : unknown,
    TRequestContextSchema extends PublicSchema ? InferPublicSchema<TRequestContextSchema> : unknown
  >;
  <TStepId extends string>(
    agent: SubAgent<TStepId, any> | Agent<TStepId, any>,
    agentOptions?: Omit<AgentStepOptions<{ text: string }>, 'structuredOutput'> & {
      structuredOutput?: never;
      retries?: number;
      scorers?: DynamicArgument<MastraScorers>;
    } & PetriStepResources,
  ): PetriStep<TStepId, unknown, { prompt: string }, { text: string }, unknown, unknown>;
  <TStepId extends string, TStepOutput>(
    agent: SubAgent<TStepId, any> | Agent<TStepId, any>,
    agentOptions: Omit<AgentStepOptions<TStepOutput>, 'structuredOutput'> & {
      structuredOutput: { schema: StandardSchemaWithJSON<TStepOutput> };
      retries?: number;
      scorers?: DynamicArgument<MastraScorers>;
      metadata?: StepMetadata;
    } & PetriStepResources,
  ): PetriStep<TStepId, unknown, { prompt: string }, TStepOutput, unknown, unknown>;
  <
    TSchemaIn,
    TSchemaOut,
    TSuspend,
    TResume,
    TContext extends ToolExecutionContext<TSuspend, TResume, any>,
    TId extends string,
    TRequestContext extends Record<string, any> | unknown = unknown,
  >(
    tool: Tool<TSchemaIn, TSchemaOut, TSuspend, TResume, TContext, TId, TRequestContext>,
    toolOptions?: {
      retries?: number;
      scorers?: DynamicArgument<MastraScorers>;
      metadata?: StepMetadata;
      actor?: ActorSignal;
    } & PetriStepResources,
  ): PetriStep<TId, unknown, TSchemaIn, TSchemaOut, TSuspend, TResume, TRequestContext>;
  <TProcessorId extends string>(processor: ProcessorSource<TProcessorId>): ProcessorStep<TProcessorId>;
  <TWorkflowId extends string, TState, TInput, TOutput, TRequestContext extends Record<string, any> | unknown>(
    workflow: Workflow<PetriEngineType, any, TWorkflowId, TState, TInput, TOutput, any, TRequestContext>,
  ): PetriStep<TWorkflowId, TState, TInput, TOutput, any, any, TRequestContext>;
}

/** `cloneStep` on the petri engine: Mastra's, over petri steps. */
export type PetriCloneStep = <TStepId extends string>(
  step: Step<string, any, any, any, any, any, PetriEngineType>,
  opts: { id: TStepId },
) => PetriStep<TStepId, any, any, any, any, any>;

/**
 * `Workflow.engineType` for a workflow built by {@link init}. Mastra reads it in three places
 * ([ADR 0010], "The Run.restart seam"):
 *
 * - `Run._restart` refuses any engine but `'default'` and `'evented'` (`workflow.ts:4872-4875`).
 *   {@link init} lets a petri run through: each `Run` its workflow creates carries an instance
 *   `_restart` that reports `'default'` for the synchronous prologue of Mastra's own `_restart` —
 *   the only place the field is read — and restores `'petri'` before the first `await`. The
 *   engine then decides what a restart may do, and refuses by its own error.
 * - `Workflow.restartAllActiveWorkflowRuns` returns early for any engine but `'default'`
 *   (`workflow.ts:3147-3165`); {@link init} replaces it on the instance with Mastra's body, ungated.
 * - `Mastra.listActiveWorkflowRuns` keeps only `'default'` workflows (`mastra/index.ts:3952`), so
 *   Mastra's boot hook still skips petri runs; `restartActiveRuns` (`recovery.ts`) is the
 *   counterpart to call beside it.
 */
export const PETRI_ENGINE_TYPE = 'petri';

/** `init().limit` ([ADR 0012]): at most `n` attempts of the steps using it in flight at once, per run. */
export type PetriLimit = (n: number, options: QuotaOptions) => Quota;

/**
 * `init().rateLimit` ([ADR 0012]): at most `burst` attempts at once, one more every `perMs` ms on the
 * run's clock, retries included, per run.
 */
export type PetriRateLimit = (burst: number, perMs: number, options: QuotaOptions) => Quota;

/**
 * `init().race` ([ADR 0014]): the first arm to succeed wins; the rest are preempted, awaited and
 * recorded `canceled`. Spread into Mastra's own `.parallel()`:
 *
 * ```ts
 * wf.parallel(...race([a, b, c], { id: 'fastest' }))
 * ```
 *
 * The arms are petri steps, so the brand gates it ([ADR 0002]); the next entry still receives every
 * declared arm, read from the step records, as after any `.parallel()` — **a loser's key holds
 * `undefined`** (its record is `canceled`, with no `output`). Mastra validates a step's input by
 * default (`validateInputs`), so the next step's input schema must make every arm's key optional
 * (`z.object({ a: A.optional(), b: B.optional(), … })`), or the first run with a loser fails there.
 */
export type PetriRace = <const TArms extends readonly PetriStep<string, any, any, any, any, any, any>[]>(
  arms: TArms,
  options?: DecisionOptions,
) => [arms: TArms, options: DecisionEntryOptions];

/**
 * `init().quorum` ([ADR 0014]): `k` of the arms must succeed; the block fails once `n − k + 1` have
 * not. `quorum(1, arms)` is `race(arms)`. Spread into `.parallel()`, as {@link PetriRace}.
 */
export type PetriQuorum = <const TArms extends readonly PetriStep<string, any, any, any, any, any, any>[]>(
  k: number,
  arms: TArms,
  options?: DecisionOptions,
) => [arms: TArms, options: DecisionEntryOptions];

/**
 * `init().pipeline` ([ADR 0015]): a `.foreach()` over a chain of stages, compiled into the parent net
 * with `c_j` lanes per stage, each item handed lane to lane — stage 2 of item 1 runs while stage 1 of
 * item 2 does. Spread into Mastra's own `.foreach()`:
 *
 * ```ts
 * wf.foreach(...pipeline([fetchDoc, embed, store], { id: 'per-doc', concurrency: [2, 1, 1] }))
 * ```
 *
 * `S` is a `const` tuple of petri steps: the brand gates every stage ([ADR 0002]), and
 * {@link Chained} makes a stage whose input does not accept the previous stage's output a type error
 * on that stage. The body is a petri step from stage 0's input to the last stage's output; on
 * `DefaultExecutionEngine` the entry runs as `.foreach(nestedWorkflow, { concurrency: Σc_j })`, the
 * twin. Stages run in the parent's run — retries per stage under the parent's `retryConfig`, a stage
 * `limit` one quota across items, records and `getInitData()` per item, no child runs; a suspended
 * stage ends the run `suspended` and its resume is refused (`pipeline`).
 */
export type PetriPipeline = <const S extends PipelineStages, const TId extends string>(
  stages: S & Chained<S>,
  options: PipelineOptions<TId, S>,
) => [body: PipelineBody<TId, S>, options: PipelineEntryOptions];

/** What {@link init} returns. */
export interface PetriFactories {
  readonly createWorkflow: PetriCreateWorkflow;
  readonly createStep: PetriCreateStep;
  readonly cloneStep: PetriCloneStep;
  /** Layer 3 ([ADR 0012]): a quota a petri step draws on through `createStep({ uses })`. */
  readonly limit: PetriLimit;
  /** Layer 3 ([ADR 0012]): a rate a petri step draws on through `createStep({ uses })`. */
  readonly rateLimit: PetriRateLimit;
  /** Layer 3 ([ADR 0014]): the first success of a `.parallel()` wins. */
  readonly race: PetriRace;
  /** Layer 3 ([ADR 0014]): `k` successes of a `.parallel()` decide it. */
  readonly quorum: PetriQuorum;
  /** Layer 3 ([ADR 0015]): a `.foreach()` over a chain of stages, one bound per stage. */
  readonly pipeline: PetriPipeline;
}

/**
 * Mastra's workflow factories, bound to the petri engine — the `@mastra/inngest` pattern
 * ([ADR 0002], [ADR 0005]).
 *
 * `createWorkflow` builds Mastra's own `Workflow` with a fresh `PetriExecutionEngine` as its
 * `executionEngine`, and hands that engine the workflow's normalized `options` — the object Mastra
 * gives its default engine (`workflow.ts:1805-1827`), which a custom engine otherwise never sees.
 * `createStep` and `cloneStep` are Mastra's own, re-typed. Nothing is re-implemented: the builder,
 * `commit()`, `Run`, storage and observability are Mastra's.
 *
 * Every workflow, step and condition built here carries {@link PetriEngineType}, so mixing them
 * with the default engine's is a type error in both directions.
 */
export function init(options: PetriInitOptions = {}): PetriFactories {
  const createWorkflow = ((params: CreateWorkflowParams & { readonly schedule?: unknown }) => {
    const { executionEngine, schedule } = params as { executionEngine?: unknown; schedule?: unknown };
    if (executionEngine !== undefined) {
      throw new TypeError(
        `createWorkflow('${params.id}'): 'executionEngine' is set by init(); a workflow built here always runs on it.`,
      );
    }
    if (schedule !== undefined) {
      throw new TypeError(
        `createWorkflow('${params.id}'): 'schedule' selects Mastra's evented engine, so it cannot be combined with this one.`,
      );
    }
    const engine = new PetriExecutionEngine({ ...options, ...(params.mastra ? { mastra: params.mastra } : {}) });
    const workflow = new Workflow({ ...params, executionEngine: engine });
    engine.options = workflow.options;
    workflow.engineType = PETRI_ENGINE_TYPE;
    openRestart(workflow);
    return workflow;
  }) as unknown as PetriCreateWorkflow;

  const createStep = ((source: unknown, sourceOptions?: unknown) => {
    if (source instanceof Workflow) return source;
    const create = mastraCreateStep as (s: unknown, o?: unknown) => object;
    if (sourceOptions !== undefined) {
      // An agent or tool source. Mastra keeps the options object as `__agentOptions` /
      // `__toolOptions` and later spreads it into `agent.stream()` (`run-agent-entry.ts:37`) and the
      // serialized graph, so `uses` / `timeout` are stripped from a shallow copy — only when present:
      // an options object without them reaches Mastra as it was given. Nothing binds to it.
      const resources = resourcesIn(sourceOptions);
      if (!carriesResourceKeys(sourceOptions)) return create(source, sourceOptions);
      const { uses: _uses, timeout: _timeout, ...options } = sourceOptions as Record<string, unknown>;
      const step = create(source, options);
      if (resources !== undefined) {
        attachResources(step, resources);
        attachResources(options, resources);
      }
      return step;
    }
    // A params object, or a processor. Mastra builds the Step from a fixed list of the params' fields
    // and binds `execute` to the params object itself (`workflow.ts:510-530`, the bind at `:523`), so
    // the very object is passed on: `uses` and `timeout` never reach the Step, and `this` inside
    // `execute` is the object the author wrote, exactly as on Mastra's own `createStep`.
    const resources = resourcesIn(source);
    const step = create(source);
    if (resources !== undefined) attachResources(step, resources);
    return step;
  }) as PetriCreateStep;

  // Mastra's `cloneStep` copies a fixed list of fields (`workflow.ts:1648-1666`) — not the
  // non-enumerable resources, nor an agent or tool step's `__agentOptions` / `__toolOptions` — so the
  // clone gets the original's resources here.
  const cloneStep = ((step: object, opts: { id: string }) => {
    const clone = (mastraCloneStep as (s: object, o: { id: string }) => object)(step, opts);
    const resources = resourcesOf(step);
    if (resources !== undefined) attachResources(clone, resources);
    return clone;
  }) as unknown as PetriCloneStep;

  return {
    createWorkflow,
    createStep,
    cloneStep,
    limit,
    rateLimit,
    race: race as PetriRace,
    quorum: quorum as PetriQuorum,
    pipeline: bindPipeline(createWorkflow),
  };
}

/**
 * Whether a plain object — a params object or an agent/tool options object — has a `uses` or
 * `timeout` key. An `Agent`, `Tool` or processor is a class instance whose own fields are not this
 * engine's to read.
 */
function carriesResourceKeys(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.hasOwn(value, 'uses') || Object.hasOwn(value, 'timeout');
}

/**
 * The resources a `createStep` argument declares ([ADR 0012], [ADR 0013]): `undefined` when it
 * declares none — no `uses` (or an empty one) and no `timeout`. `uses` must be an array of quotas
 * minted by `init().limit` / `init().rateLimit`; anything else is refused here, since the brand's
 * type check does not reach a caller that casts. `timeout` is carried as given: the adapter refuses
 * a bad value as `timeout-value`, by the entry it names.
 */
function resourcesIn(value: unknown): StepResources | undefined {
  if (!carriesResourceKeys(value)) return undefined;
  const { uses, timeout } = value as { uses?: unknown; timeout?: unknown };
  if (uses !== undefined && (!Array.isArray(uses) || !uses.every((q) => q instanceof Quota))) {
    throw new TypeError('createStep: `uses` takes quotas made by init().limit or init().rateLimit');
  }
  const quotas = (uses as readonly Quota[] | undefined) ?? [];
  if (quotas.length === 0 && timeout === undefined) return undefined;
  return {
    ...(quotas.length === 0 ? {} : { quotas }),
    ...(timeout === undefined ? {} : { timeoutMs: timeout as number }),
  };
}

/** Marks a `Run` whose `_restart` {@link openRestart} has already wrapped. */
const restartSeam: unique symbol = Symbol('mastra-libpetri.restartSeam');

/** The parts of Mastra's `Run` the seam touches: `_restart` is protected, `workflowEngineType` readonly. */
interface RunSeam {
  workflowEngineType: string;
  _restart: (args: unknown) => Promise<unknown>;
  [restartSeam]?: true;
}

/** The parts of Mastra's `Workflow` the seam touches: `logger` is protected. */
interface WorkflowSeam {
  readonly id: string;
  readonly logger: { debug(message: string, args?: unknown): void; error(message: string, args?: unknown): void };
  createRun(options?: unknown): Promise<unknown>;
  listActiveWorkflowRuns(): Promise<{ runs: { runId: string }[] }>;
  restartAllActiveWorkflowRuns(): Promise<void>;
}

/**
 * Opens `Run.restart()` and `Workflow.restartAllActiveWorkflowRuns()` on a petri workflow
 * ([ADR 0010], "The Run.restart seam"), on the instance only — no Mastra prototype is touched.
 *
 * `createRun` is replaced on the instance, so Mastra's own callers reach it: `restartAllActiveWorkflowRuns`
 * and a nested workflow's `execute`, which restarts its child through `this.createRun`
 * (`workflow.ts:2972-2974`, `3017`). Each run is wrapped once: `createRun` returns the cached run
 * for a known `runId` (`workflow.ts:2738-2739`), and the symbol mark keeps a second wrap off it.
 *
 * The wrapped `_restart` sets `workflowEngineType` to `'default'`, calls Mastra's `_restart`, and
 * restores `'petri'` in `finally`. Mastra's `_restart` is an `async` function, so the call returns
 * its promise when the body reaches its first `await` (the snapshot load, `workflow.ts:4877`);
 * the engine check (`workflow.ts:4872-4875`) runs before it, and the `finally` runs right after.
 * No other code reads the field (`workflow.ts:4873-4874` are its only reads), and none can run
 * while the synchronous prologue does. `tests/upstream/restart-seam.test.ts` pins both facts.
 */
function openRestart(workflow: Workflow<any, any, any, any, any, any, any, any>): void {
  const seam = workflow as unknown as WorkflowSeam;
  const createRun = seam.createRun.bind(seam);
  seam.createRun = async (runOptions?: unknown) => {
    const run = (await createRun(runOptions)) as RunSeam;
    if (run[restartSeam] !== true) {
      const restart = run._restart;
      run._restart = function petriRestart(this: RunSeam, args: unknown) {
        const engineType = this.workflowEngineType;
        this.workflowEngineType = 'default';
        try {
          return restart.call(this, args);
        } finally {
          this.workflowEngineType = engineType;
        }
      };
      run[restartSeam] = true;
    }
    return run;
  };

  // Mastra's body (`workflow.ts:3147-3165`) without the engine gate: sequential, each failure logged.
  seam.restartAllActiveWorkflowRuns = async function restartAllActiveWorkflowRuns(this: WorkflowSeam) {
    const activeRuns = await this.listActiveWorkflowRuns();
    if (activeRuns.runs.length > 0) {
      this.logger.debug('Restarting active workflow runs', { count: activeRuns.runs.length });
    }
    for (const runSnapshot of activeRuns.runs) {
      try {
        const run = (await this.createRun({ runId: runSnapshot.runId })) as { restart(): Promise<unknown> };
        await run.restart();
        this.logger.debug('Restarted workflow run', { workflowId: this.id, runId: runSnapshot.runId });
      } catch (error) {
        this.logger.error('Failed to restart workflow run', { workflowId: this.id, runId: runSnapshot.runId, error });
      }
    }
  };
}

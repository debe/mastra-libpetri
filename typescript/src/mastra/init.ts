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
    params: StepParams<TStepId, TStateSchema, TInputSchema, TOutputSchema, TResumeSchema, TSuspendSchema, TRequestContextSchema>,
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
    },
  ): PetriStep<TStepId, unknown, { prompt: string }, { text: string }, unknown, unknown>;
  <TStepId extends string, TStepOutput>(
    agent: SubAgent<TStepId, any> | Agent<TStepId, any>,
    agentOptions: Omit<AgentStepOptions<TStepOutput>, 'structuredOutput'> & {
      structuredOutput: { schema: StandardSchemaWithJSON<TStepOutput> };
      retries?: number;
      scorers?: DynamicArgument<MastraScorers>;
      metadata?: StepMetadata;
    },
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
    },
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
 * `Workflow.engineType` for a workflow built by {@link init}. Mastra reads it in two places, and
 * both are the behaviour wanted until resume and restart land (M4): `Run.restart()` refuses any
 * engine but `'default'` and `'evented'` (`workflow.ts:4872-4875`), and `Mastra` restarts active
 * runs only of `'default'` workflows (`mastra/index.ts:3952`).
 */
export const PETRI_ENGINE_TYPE = 'petri';

/** What {@link init} returns. */
export interface PetriFactories {
  readonly createWorkflow: PetriCreateWorkflow;
  readonly createStep: PetriCreateStep;
  readonly cloneStep: PetriCloneStep;
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
    return workflow;
  }) as unknown as PetriCreateWorkflow;

  const createStep = ((source: unknown, sourceOptions?: unknown) =>
    source instanceof Workflow
      ? source
      : (mastraCreateStep as (s: unknown, o?: unknown) => unknown)(source, sourceOptions)) as PetriCreateStep;

  const cloneStep = mastraCloneStep as unknown as PetriCloneStep;

  return { createWorkflow, createStep, cloneStep };
}

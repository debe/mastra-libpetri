import { MastraError, ErrorDomain, ErrorCategory } from '@mastra/core/error';
import { ExecutionEngine, type ExecutionEngineOptions, type WorkflowRunStatus } from '@mastra/core/workflows';
import { StepExecutor } from '@mastra/core/workflows/evented';
import type { Mastra } from '@mastra/core/mastra';
import { compile } from '../compiler/compile.js';
import type { CompiledWorkflow, WorkflowDescription } from '../compiler/types.js';
import { runWorkflowDetailed, type RunReport } from '../engine/kernel.js';
import { adaptExecutionGraph } from './adapt.js';
import { persistRun, type PersistContext } from './persist.js';
import { MastraStepRunner } from './runner.js';
import { formatWorkflowResult, type FormattedResult } from './result.js';

type ExecuteParams = Parameters<ExecutionEngine['execute']>[0];
type WorkflowSpan = NonNullable<ExecuteParams['workflowSpan']>;

export interface PetriEngineOptions {
  readonly mastra?: Mastra;
  /**
   * Mastra's engine options — `validateInputs`, `shouldPersistSnapshot`, `pruneSnapshot`,
   * `onFinish`, `onError`, `onStart`. A workflow built with a custom `executionEngine` does **not**
   * hand its own `createWorkflow({ options })` to that engine (`workflow.ts:1819-1827`), so the
   * lifecycle callbacks are configured here.
   */
  readonly options?: Partial<ExecutionEngineOptions>;
  /** The loop bound this engine requires and Mastra does not have (`docs/divergences.md` row 13). */
  readonly iterationBound?: number;
}

const DEFAULTS: ExecutionEngineOptions = { validateInputs: true, shouldPersistSnapshot: () => true };

/**
 * The run modes M2 does not run. Each is a `Run` method (`resume`, `restart`, `timeTravel`) or a
 * `start()` option (`perStep`) whose semantics live in the default engine's loop and its snapshot
 * handling; running one as a plain start would quietly re-run finished steps.
 */
export type UnsupportedRunMode = 'resume' | 'restart' | 'timeTravel' | 'perStep';

/** Thrown by `execute()` for a run mode this engine does not support yet (ADR 0005, until M4). */
export class UnsupportedRunModeError extends Error {
  override readonly name = 'UnsupportedRunModeError';
  readonly mode: UnsupportedRunMode;
  readonly workflowId: string;
  readonly runId: string;

  constructor(mode: UnsupportedRunMode, workflowId: string, runId: string) {
    super(
      `PetriExecutionEngine does not support '${mode}' yet (workflow '${workflowId}', run '${runId}'); ` +
        'run the workflow on the default engine for this, or start it afresh',
    );
    this.mode = mode;
    this.workflowId = workflowId;
    this.runId = runId;
  }
}

/**
 * Thrown by `execute()` when the net comes to rest with no terminal marked — a model defect the
 * proven `exactlyOneTerminal` rules out. The run **rejects**: its span is errored, no lifecycle
 * callback fires and nothing more is persisted, so storage keeps the `running` snapshot written at
 * start — what the default engine leaves behind when its own `execute()` throws. Writing `failed`
 * instead would report a Mastra outcome for a run no Mastra outcome describes.
 */
export class StrandedRunError extends Error {
  override readonly name = 'StrandedRunError';
  readonly workflowId: string;
  readonly runId: string;
  /** The places still holding a token, as the kernel names them. */
  readonly places: readonly string[];

  constructor(workflowId: string, runId: string, places: readonly string[]) {
    super(
      `PetriExecutionEngine: run '${runId}' of workflow '${workflowId}' came to rest with no outcome; ` +
        `tokens remain in ${places.join(', ') || '(no place)'}`,
    );
    this.workflowId = workflowId;
    this.runId = runId;
    this.places = places;
  }
}

/**
 * An alternative execution engine for Mastra workflows: the workflow is compiled to one Coloured
 * Time Petri Net and the net decides what runs ([ADR 0001]). Registered through Mastra's own
 * `createWorkflow({ executionEngine })`.
 *
 * `execute()` owns what `DefaultExecutionEngine.execute` owns (`default.ts:720-1130`): the run's
 * persistence at start and at the end, ending the workflow span on **every** path — `Run._start`
 * leaves it to `execute()` (`workflow.ts:3734`) — and the `onFinish` / `onError` callbacks, never
 * for a `paused` run (`default.ts:985`). `onStart` is not ours: `Run._start` invokes it before
 * calling `execute()` (`workflow.ts:3766`).
 */
export class PetriExecutionEngine extends ExecutionEngine {
  readonly #iterationBound: number | undefined;
  /**
   * Compiled nets keyed by the adapter's description, serialised. A description is plain data and
   * `compile` a pure function of it, so equal keys give equal nets; `structuralHash` is itself
   * computed *by* `compile`, which made it a key that cost a full build to look up.
   */
  readonly #cache = new Map<string, CompiledWorkflow>();

  constructor(options: PetriEngineOptions = {}) {
    super({ ...(options.mastra ? { mastra: options.mastra } : {}), options: { ...DEFAULTS, ...options.options } });
    this.#iterationBound = options.iterationBound;
  }

  async execute<_TState, _TInput, TOutput>(params: ExecuteParams): Promise<TOutput> {
    const span = new SpanOnce(params.workflowSpan);
    try {
      return (await this.#execute(params, span)) as TOutput;
    } catch (error) {
      // Every rejection ends the span as an error, once — a refusal, an adapter or compiler
      // refusal, a stranded run, a storage failure. Run does not catch it: `start()` rejects.
      span.error(error);
      throw error;
    }
  }

  async #execute(params: ExecuteParams, span: SpanOnce): Promise<FormattedResult> {
    const { workflowId, runId } = params;
    const refused = refusedMode(params);
    if (refused !== undefined) throw new UnsupportedRunModeError(refused, workflowId, runId);

    if (params.graph.steps.length === 0) {
      // As `default.ts:777-787`, id and all.
      throw new MastraError({
        id: 'WORKFLOW_EXECUTE_EMPTY_GRAPH',
        text: 'Workflow must have at least one step',
        domain: ErrorDomain.MASTRA_WORKFLOW,
        category: ErrorCategory.USER,
      });
    }

    const description = adaptExecutionGraph(params.graph, {
      ...(params.retryConfig ? { retryConfig: params.retryConfig } : {}),
      ...(this.#iterationBound === undefined ? {} : { iterationBound: this.#iterationBound }),
    });
    const compiled = this.#compiled(description);

    // Read per run, never cached. `Run._start` does not touch the engine's options; what replaces
    // them is `init()` (the workflow's own options object) and `Workflow.execute` — the NESTED path,
    // which rewrites `executionEngine.options.validateInputs` on every nested run
    // (`workflow.ts:2939-2949`). A hand-constructed engine never sees `createWorkflow({ options })`
    // (`workflow.ts:1819-1827`): `docs/divergences.md`, and the default engine's own contract.
    const validateInputs = this.options.validateInputs;
    const initialState = (params.initialState ?? {}) as Record<string, unknown>;
    const runner = new MastraStepRunner({
      executor: this.#executorFor(params),
      graph: params.graph,
      workflowId,
      runId,
      // `handlers/step.ts:360`: every step sees the run's resourceId.
      ...(params.resourceId === undefined ? {} : { resourceId: params.resourceId }),
      // Step code sees the registered Mastra or `undefined` (`handlers/step.ts:352-356`) — never the
      // executor's view below. The key is set even when undefined: the runner reads its presence.
      mastra: this.mastra,
      requestContext: params.requestContext,
      abortController: params.abortController,
      initialState,
      validateInputs,
    });

    const persistBase = {
      workflowId,
      runId,
      ...(params.resourceId === undefined ? {} : { resourceId: params.resourceId }),
      input: params.input,
      serializedStepGraph: params.serializedStepGraph,
      requestContext: params.requestContext,
    } satisfies Partial<PersistContext>;

    // The default engine's first write is a step's `start` with run status `running`
    // (`handlers/step.ts:216-229`); `Run` wrote `pending` when it was created (`workflow.ts:2794`).
    await persistRun(this, { ...persistBase, phase: 'start', state: initialState });

    const report: RunReport = await runWorkflowDetailed(compiled, params.input, {
      runner,
      signal: params.abortController.signal,
      // Mastra has no run timeout (`default.ts:720-1130`). A stranded run with a signal would then
      // wait forever; the proven `exactlyOneTerminal` rules that out, not a timer.
      timeoutMs: null,
    });

    const outcome = report.outcome;
    if (outcome.status === 'stranded') throw new StrandedRunError(workflowId, runId, outcome.places);
    if (outcome.residue !== undefined) {
      // A token left beside the terminal: the run's result stands, the model is wrong. Never silent.
      this.getLogger().error(
        `PetriExecutionEngine: run '${runId}' of workflow '${workflowId}' ended '${outcome.status}' ` +
          `with tokens left in ${outcome.residue.join(', ')}`,
        { workflowId, runId, status: outcome.status, residue: outcome.residue },
      );
    }

    const state = runner.state;
    // Carries `runId`, `stepExecutionPath` and — only when asked — `state` and `resumeLabels`: what
    // `default.ts:1050-1058,1125-1128` add around `fmtReturnValue`.
    const formatted = formatWorkflowResult({
      report,
      input: params.input,
      state,
      runId,
      graph: params.graph,
      resumeLabels: runner.resumeLabels,
      ...(params.outputOptions ? { outputOptions: params.outputOptions } : {}),
    });

    await persistRun(this, {
      ...persistBase,
      phase: 'terminal',
      state,
      report,
      result: formatted,
      resumeLabels: runner.resumeLabels,
    });

    const ending = endingOf(formatted);
    // The span. Mastra ends a canceled run's span two ways: a dedicated branch when the abort is seen
    // at the top of its entry loop (`default.ts:815-829`), and the ordinary terminal branch when an
    // entry that was running is re-stamped `canceled` at its end (`handlers/entry.ts:815-817`, then
    // `default.ts:969-983`). A cancel swept before an entry *started* is the first — but only at
    // entry 0: a not-started sweep at a later entry is, in Mastra's order, the re-stamp of the entry
    // before it, which checks the signal before the next loop top does.
    const o = report.outcome;
    const atLoopTop = o.status === 'canceled' && !o.started && (o.origin === undefined || (o.origin.path.length === 1 && o.origin.path[0] === 0));
    if (atLoopTop) span.end({ attributes: { status: 'canceled' } });
    else if (ending.error !== undefined) span.error(ending.error, formatted.status);
    else span.end({ output: ending.result, attributes: { status: formatted.status } });

    if (formatted.status === 'paused') {
      // No callbacks for a paused run; the watch event instead (`default.ts:985-1009`).
      await params.pubsub.publish(`workflow.events.v2.${runId}`, {
        type: 'watch',
        runId,
        data: { type: 'workflow-paused', payload: {} },
      });
    } else {
      await this.invokeLifecycleCallbacks({
        status: formatted.status,
        result: ending.result,
        error: ending.error,
        steps: formatted.steps as LifecycleInfo['steps'],
        tripwire: ending.tripwire,
        runId,
        workflowId,
        ...(params.resourceId === undefined ? {} : { resourceId: params.resourceId }),
        input: params.input,
        requestContext: params.requestContext,
        state,
        ...(formatted.stepExecutionPath === undefined ? {} : { stepExecutionPath: formatted.stepExecutionPath }),
      });
    }

    return formatted;
  }

  /**
   * One `StepExecutor` per run. It publishes a step's writer chunks, and hands steps and nested
   * workflows `[PUBSUB_SYMBOL]`, on `this.mastra.pubsub` (`evented/step-executor.ts:47-60,250`),
   * where the default engine uses the run's own `params.pubsub` — the bus `Run.watch` and
   * `Run.stream` listen on (`workflow.ts:3569,4354`), which is **not** `mastra.pubsub`. So the
   * executor is given a view whose `pubsub` is the run's: over the registered Mastra, every other
   * member read from it (methods bound to it, for its private fields); unregistered, a stand-in
   * with exactly that pubsub and this engine's logger.
   */
  #executorFor(params: ExecuteParams): StepExecutor {
    return new StepExecutor({ mastra: runView(this.mastra, params.pubsub, () => this.getLogger()) });
  }

  #compiled(description: WorkflowDescription): CompiledWorkflow {
    const key = JSON.stringify(description);
    const hit = this.#cache.get(key);
    if (hit) return hit;
    const compiled = compile(description);
    this.#cache.set(key, compiled);
    return compiled;
  }
}

/** `mastra` as `StepExecutor` should see it for one run: its `pubsub` replaced by the run's. */
function runView(mastra: Mastra | undefined, pubsub: ExecuteParams['pubsub'], logger: () => unknown): Mastra {
  if (mastra === undefined) return { pubsub, getLogger: logger } as unknown as Mastra;
  return new Proxy(mastra, {
    get(target, key) {
      if (key === 'pubsub') return pubsub;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** The first run mode in `params` this engine refuses, in the order `default.ts:790-799` reads them. */
function refusedMode(params: ExecuteParams): UnsupportedRunMode | undefined {
  if (params.timeTravel !== undefined) return 'timeTravel';
  if (params.restart !== undefined) return 'restart';
  if (params.resume !== undefined) return 'resume';
  if (params.perStep === true) return 'perStep';
  return undefined;
}

type LifecycleInfo = Parameters<ExecutionEngine['invokeLifecycleCallbacks']>[0];

/** `result.result`, `result.error` and `result.tripwire` as `default.ts` reads them off a formatted result. */
function endingOf(formatted: FormattedResult): { result?: unknown; error?: unknown; tripwire?: unknown } {
  switch (formatted.status) {
    case 'success':
      return { result: formatted.result };
    case 'failed':
      return { error: formatted.error };
    case 'tripwire':
      return { tripwire: formatted.tripwire };
    case 'suspended':
    case 'paused':
    case 'canceled':
      return {};
    default:
      return assertNever(formatted);
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled formatted result: ${JSON.stringify(value)}`);
}

/** The run's workflow span, ended at most once whatever path ends it. */
class SpanOnce {
  readonly #span: WorkflowSpan | undefined;
  #ended = false;

  constructor(span: WorkflowSpan | undefined) {
    this.#span = span;
  }

  end(options: Parameters<WorkflowSpan['end']>[0]): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#span?.end(options);
  }

  error(error: unknown, status?: WorkflowRunStatus): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#span?.error({
      error: error as Error,
      ...(status === undefined ? {} : { attributes: { status } }),
    });
  }
}

import { MastraError, ErrorDomain, ErrorCategory } from '@mastra/core/error';
import { ExecutionEngine, type ExecutionEngineOptions, type WorkflowRunStatus } from '@mastra/core/workflows';
import { StepExecutor } from '@mastra/core/workflows/evented';
import type { Mastra } from '@mastra/core/mastra';
import type { AnySpan } from '@mastra/core/observability';
import type { Clock } from 'libpetri';
import type { DebugSessionRegistry } from 'libpetri/debug';
import { compile } from '../compiler/compile.js';
import { HostPreconditionError } from '../compiler/gadgets/leaf.js';
import { resumeSeed, UnresumablePositionError, type ResumeSeed } from '../compiler/resume.js';
import type { CompiledWorkflow, WorkflowDescription } from '../compiler/types.js';
import { runWorkflowDetailed, type RunReport } from '../engine/kernel.js';
import { adaptExecutionGraph } from './adapt.js';
import { StepEvents } from './events.js';
import { suspendTracingContext } from './host.js';
import { persistRun, type PersistContext, type PersistGuard } from './persist.js';
import { decodeResume, type DecodedResume } from './resume-codec.js';
import { MastraStepRunner } from './runner.js';
import { StepSpans, type SpanLifecycle } from './spans.js';
import { formatWorkflowResult, withForeachHostFields, type FormattedResult, type ResumedFrom } from './result.js';

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
  /**
   * At most this many step attempts in flight at once within one run ([ADR 0006]) — a place with
   * that many permits, so the bound is proven, not merely enforced. Mastra has no run-level bound;
   * omitted, steps run unbounded, as Mastra's do, and a workflow means the same either way.
   * Budgets are per run: a nested workflow on its own engine has its own.
   */
  readonly concurrency?: number;
  /**
   * The clock the net runs on ([TIME-015]) — for deterministic tests. Mastra's own step code still
   * reads the machine clock; only the net's timing (fixed sleeps, retry delays, record stamps)
   * follows this.
   */
  readonly clock?: Clock;
  /**
   * The libpetri debug UI's session registry ([ADR 0008]). Given one, every run segment registers
   * a session — its net, and every net event as it happens — so the debug UI shows the marking
   * live. Observation only: the run is the same with or without it. The session id is the run id,
   * and a resumed segment takes `<runId>~resume-<n>`; sessions are completed, never removed, so the
   * registry's own `maxSessions` bounds what is kept.
   */
  readonly debug?: DebugSessionRegistry;
}

const DEFAULTS: ExecutionEngineOptions = { validateInputs: true, shouldPersistSnapshot: () => true };

/**
 * The run modes this engine refuses. `restart`, `timeTravel` (`Run` methods) and `perStep` (a
 * `start()` option) are refused outright: their semantics live in the default engine's loop and its
 * snapshot handling, and running one as a plain start would quietly re-run finished steps (M4b and
 * later). `resume` runs ([ADR 0007]) and is refused only for a position it cannot place — then with
 * the reason, in Mastra's words.
 */
export type UnsupportedRunMode = 'resume' | 'restart' | 'timeTravel' | 'perStep';

/**
 * Thrown by `execute()` for a run mode, or a resume, this engine does not support (ADR 0005,
 * ADR 0007). Always before anything is persisted, so a refused resume leaves the suspension as it
 * was and `Run` releases its claim (`workflow.ts:4760-4806,4846-4849`).
 */
export class UnsupportedRunModeError extends Error {
  override readonly name = 'UnsupportedRunModeError';
  readonly mode: UnsupportedRunMode;
  readonly workflowId: string;
  readonly runId: string;
  /** Why a resume was refused, when it was one: the step, its stored position and the reason. */
  readonly resume?: {
    readonly stepId: string;
    readonly path: readonly number[];
    readonly reason: UnresumablePositionError['reason'];
  };

  constructor(
    mode: UnsupportedRunMode,
    workflowId: string,
    runId: string,
    resume?: { readonly stepId: string; readonly path: readonly number[]; readonly reason: UnresumablePositionError['reason']; readonly detail: string },
    options?: { readonly cause?: unknown },
  ) {
    super(
      resume === undefined
        ? `PetriExecutionEngine does not support '${mode}' yet (workflow '${workflowId}', run '${runId}'); ` +
            'run the workflow on the default engine for this, or start it afresh'
        : `PetriExecutionEngine cannot resume step '${resume.stepId}' at [${resume.path.join(', ')}] ` +
            `(workflow '${workflowId}', run '${runId}'): ${resume.detail}`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.mode = mode;
    this.workflowId = workflowId;
    this.runId = runId;
    if (resume !== undefined) this.resume = { stepId: resume.stepId, path: [...resume.path], reason: resume.reason };
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
export class PetriExecutionEngine extends ExecutionEngine implements SpanLifecycle {
  readonly #iterationBound: number | undefined;
  readonly #concurrency: number | undefined;
  readonly #clock: Clock | undefined;
  readonly #debug: DebugSessionRegistry | undefined;
  /**
   * Compiled nets keyed by the adapter's description, serialised. A description is plain data and
   * `compile` a pure function of it, so equal keys give equal nets; `structuralHash` is itself
   * computed *by* `compile`, which made it a key that cost a full build to look up.
   */
  readonly #cache = new Map<string, CompiledWorkflow>();
  /**
   * The status this instance last wrote for each run — the default engine's overwrite guard
   * (`handlers/entry.ts:195-205`, kept per engine at `default.ts:85-105`). A suspended or paused
   * run keeps its entry, so a resume in the same process does not overwrite the suspension with
   * `running` before it has an outcome; any other outcome drops it, as `default.ts:1010-1018,
   * 1117-1124` do, so the map does not grow with every run.
   */
  readonly #lastPersisted = new Map<string, WorkflowRunStatus>();
  readonly #guard: PersistGuard = {
    lastPersisted: (runId) => this.#lastPersisted.get(runId),
    persisted: (runId, status) => void this.#lastPersisted.set(runId, status),
  };

  constructor(options: PetriEngineOptions = {}) {
    super({ ...(options.mastra ? { mastra: options.mastra } : {}), options: { ...DEFAULTS, ...options.options } });
    this.#iterationBound = options.iterationBound;
    this.#concurrency = options.concurrency;
    this.#clock = options.clock;
    this.#debug = options.debug;
  }

  /**
   * The two options that shape the net `execute()` compiles — read by `verifyMastraWorkflow`, so
   * what it proves is the net this engine runs. Omitted keys were not configured.
   */
  settings(): { readonly concurrency?: number; readonly iterationBound?: number } {
    return {
      ...(this.#concurrency === undefined ? {} : { concurrency: this.#concurrency }),
      ...(this.#iterationBound === undefined ? {} : { iterationBound: this.#iterationBound }),
    };
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

    // A resume is placed — decoded, and its one seed token chosen — before anything is persisted
    // or run, so a resume this engine cannot place is refused with the stored suspension intact
    // and `Run` releases its claim (`workflow.ts:4760-4806,4846-4849`).
    const resumed = params.resume === undefined ? undefined : placeResume(params, compiled);
    const resumedFrom: ResumedFrom | undefined =
      resumed === undefined
        ? undefined
        : { index: resumed.seed.site.path[0], carriedPath: resumed.decoded.carriedPath, context: resumed.decoded.context };

    // Read per run, never cached. `Run._start` does not touch the engine's options; what replaces
    // them is `init()` (the workflow's own options object) and `Workflow.execute` — the NESTED path,
    // which rewrites `executionEngine.options.validateInputs` on every nested run
    // (`workflow.ts:2939-2949`). A hand-constructed engine never sees `createWorkflow({ options })`
    // (`workflow.ts:1819-1827`): `docs/divergences.md`, and the default engine's own contract.
    const validateInputs = this.options.validateInputs;
    const initialState = (params.initialState ?? {}) as Record<string, unknown>;
    const now = (): number => (this.#clock === undefined ? Date.now() : this.#clock.epochNow());
    // Mastra's step watch events ([ADR 0008]), gated per run as `publishStepEvent` is
    // (`handlers/entry.ts:23-29`): `emitStepEvents` defaults to true (`workflow.ts:1807`).
    let segmentStart: number | undefined;
    const events = new StepEvents({
      pubsub: params.pubsub,
      runId,
      enabled: this.options.emitStepEvents !== false,
      now,
      ...(resumed === undefined
        ? {}
        : {
            resume: {
              payload: resumed.decoded.runnerResume.payload,
              resumedAt: () => segmentStart ?? now(),
              records: resumed.decoded.records,
            },
          }),
    });
    // The run's step and control-flow spans under the run's span, which `Run` created
    // (`workflow.ts:3735-3751`) — the default engine's, through this engine's span hooks. With no
    // run span every span would be `undefined` (`default.ts:311`), so none is tracked.
    const spans = params.workflowSpan === undefined ? undefined : new StepSpans({
      lifecycle: this,
      workflowSpan: params.workflowSpan as AnySpan | undefined,
      graph: params.graph,
      workflowId,
      runId,
      requestContext: params.requestContext,
      tracingPolicy: this.options.tracingPolicy,
      signal: params.abortController.signal,
      initData: params.input,
      resumedBlock: resumed?.seed.site.kind === 'arm' ? resumed.seed.site.path[0] : undefined,
    });
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
      ...(resumed === undefined ? {} : { resume: { ...resumed.decoded.runnerResume, records: resumed.decoded.records } }),
      ...(this.#clock === undefined ? {} : { now: () => this.#clock!.epochNow() }),
      events,
      ...(params.outputWriter === undefined ? {} : { outputWriter: params.outputWriter }),
      ...(spans === undefined ? {} : { spans }),
      ...(params.actor === undefined ? {} : { actor: params.actor }),
      ...(params.disableScorers === undefined ? {} : { disableScorers: params.disableScorers }),
      logger: () => this.getLogger(),
    });

    const persistBase = {
      workflowId,
      runId,
      ...(params.resourceId === undefined ? {} : { resourceId: params.resourceId }),
      input: params.input,
      serializedStepGraph: params.serializedStepGraph,
      requestContext: params.requestContext,
      ...(resumedFrom === undefined ? {} : { resume: resumedFrom }),
    } satisfies Partial<PersistContext>;

    // The default engine's first write is a step's `start` with run status `running`
    // (`handlers/step.ts:216-229`); `Run` wrote `pending` when it was created (`workflow.ts:2794`).
    // On a resume `Run` has already claimed the run `running` (`workflow.ts:4758`); this write
    // carries the stored context whole and clears the stored `suspendedPaths`.
    await persistRun(
      this,
      resumed === undefined
        ? { ...persistBase, phase: 'start', state: initialState }
        : { ...persistBase, phase: 'resume-start', activePath: resumed.decoded.request.path, state: initialState },
      this.#guard,
    );

    // Mastra's `resumeTime` for a resumed `.foreach()`, taken as the segment enters it
    // (`handlers/control-flow.ts:987-988`).
    segmentStart = now();
    const debug = this.#debugSession(compiled, workflowId, runId, resumed !== undefined);
    let netReport: RunReport;
    try {
      netReport = await runWorkflowDetailed(compiled, params.input, {
        runner,
        signal: params.abortController.signal,
        // Mastra has no run timeout (`default.ts:720-1130`). A stranded run with a signal would then
        // wait forever; the proven `exactlyOneTerminal` rules that out, not a timer.
        timeoutMs: null,
        ...(this.#clock ? { clock: this.#clock } : {}),
        // A resumed segment: one token at the site, and the stored records as the run's own
        // (`default.ts:800-807`).
        ...(resumed === undefined ? {} : { resume: resumed.seed, stepResults: resumed.decoded.records }),
        ...(debug === undefined ? {} : { eventStore: debug.eventStore }),
      });
    } finally {
      if (debug !== undefined) this.#debug?.complete(debug.sessionId);
      // Every step event is out before the run's outcome is: `Run` publishes `workflow-finish` once
      // `execute()` resolves. Never rejects.
      await events.flush();
    }
    const observerError = netReport.observerError ?? events.error ?? spans?.error;
    if (observerError !== undefined) {
      // An observer — step events, the debug tee — threw. The run is unaffected ([ADR 0008]); never silent.
      this.getLogger().error(
        `PetriExecutionEngine: an observer of run '${runId}' of workflow '${workflowId}' threw; the run is unaffected`,
        { workflowId, runId, error: observerError.error },
      );
    }

    const site = resumed?.seed.site;
    // The host's fields on every `.foreach()` aggregate the net wrote: the run's resume labels and,
    // on a resumed foreach, `resumePayload` / `resumedAt` (see `withForeachHostFields`).
    const report: RunReport = {
      ...netReport,
      stepResults: withForeachHostFields(netReport.stepResults, {
        graph: params.graph,
        ...(resumed === undefined ? {} : { carried: resumed.decoded.records }),
        resumeLabels: runner.resumeLabels,
        ...(site?.kind === 'foreach' && resumed?.decoded.runnerResume.steps[0] === site.stepId
          ? { resumed: { bodyId: site.stepId, resumePayload: resumed.decoded.runnerResume.payload, resumedAt: segmentStart } }
          : {}),
      }),
    };
    const outcome = report.outcome;
    if (outcome.status === 'stranded') throw new StrandedRunError(workflowId, runId, outcome.places);
    if (outcome.status === 'failed' && outcome.error instanceof HostPreconditionError) {
      // The host refused a step before it ran (row 84): the default engine's resume rejects there,
      // with the error itself — a `TypeError` from `handlers/step.ts:160` as it is — and writes no
      // outcome. A position this engine refuses at run time rejects as the refusal does at seed time.
      const cause = outcome.error.cause;
      throw cause instanceof UnresumablePositionError ? refusal(cause, workflowId, runId, outcome.error.stepId) : cause;
    }
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
      ...(resumedFrom === undefined ? {} : { resume: resumedFrom }),
    });

    await persistRun(
      this,
      {
        ...persistBase,
        phase: 'terminal',
        state,
        report,
        result: formatted,
        resumeLabels: runner.resumeLabels,
        ...(params.workflowSpan === undefined ? {} : { suspendTracing: suspendTracingContext(params.workflowSpan) }),
      },
      this.#guard,
    );
    // Only a suspended or paused run keeps its entry: a later resume in this process must see it.
    if (formatted.status !== 'suspended' && formatted.status !== 'paused') this.#lastPersisted.delete(runId);

    const ending = endingOf(formatted);
    // The span. Mastra ends a canceled run's span two ways: a dedicated branch when the abort is seen
    // at the top of its entry loop (`default.ts:815-829`), and the ordinary terminal branch when an
    // entry that was running is re-stamped `canceled` at its end (`handlers/entry.ts:815-817`, then
    // `default.ts:969-983`). A cancel swept before an entry *started* is the first — but only at
    // entry 0: a not-started sweep at a later entry is, in Mastra's order, the re-stamp of the entry
    // before it, which checks the signal before the next loop top does.
    // On a resumed run the loop-top check before the segment's first entry is at `resumePath[0]`
    // (`default.ts:811-835`): the resume site's gate, which for an arm site is the block's
    // `re-enter` sweep, reporting the block's top-level path.
    const o = report.outcome;
    const firstIndex = resumedFrom?.index ?? 0;
    const atLoopTop =
      o.status === 'canceled' && !o.started && (o.origin === undefined || (o.origin.path.length === 1 && o.origin.path[0] === firstIndex));
    if (atLoopTop) span.end({ attributes: { status: 'canceled' } });
    else if (ending.error !== undefined) span.error(ending.error, formatted.status);
    else span.end({ output: ending.result, attributes: { status: formatted.status } });

    // `workflow-canceled`: published where an entry that ran ends with the signal aborted
    // (`handlers/entry.ts:815-837`), never by the loop-top branch (`default.ts:815-870`) — so for a
    // canceled run exactly when the span above took the terminal branch, before the callbacks.
    if (formatted.status === 'canceled' && !atLoopTop) {
      await events.canceled();
      if (events.error !== undefined && observerError === undefined) {
        this.getLogger().error(`PetriExecutionEngine: publishing 'workflow-canceled' for run '${runId}' threw; the run is unaffected`, {
          workflowId,
          runId,
          error: events.error.error,
        });
      }
    }

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

  /**
   * Registers this segment with the debug registry, when there is one: the run id for a start,
   * `<runId>~resume-<n>` for the n-th resumed segment this registry has seen of the run.
   */
  #debugSession(compiled: CompiledWorkflow, workflowId: string, runId: string, resumed: boolean) {
    const registry = this.#debug;
    if (registry === undefined) return undefined;
    let sessionId = runId;
    for (let n = 1; resumed || registry.getSession(sessionId) !== undefined; n++) {
      sessionId = `${runId}~resume-${n}`;
      if (registry.getSession(sessionId) === undefined) break;
    }
    try {
      return registry.register(sessionId, compiled.net, { workflowId, runId, segment: resumed ? 'resume' : 'start' });
    } catch (error) {
      // Observation only ([ADR 0008]): a registry that cannot register runs the segment unobserved.
      this.getLogger().error(
        `PetriExecutionEngine: the debug registry refused run '${runId}' of workflow '${workflowId}'; the run is unaffected`,
        { workflowId, runId, error },
      );
      return undefined;
    }
  }

  // ---- Span hooks: `DefaultExecutionEngine`'s defaults (`default.ts:280-418`), overridable ----------

  /** A step's span, as a child of `parentSpan` (`default.ts:294-312`). */
  async createStepSpan(params: Parameters<SpanLifecycle['createStepSpan']>[0]): Promise<AnySpan | undefined> {
    return params.parentSpan?.createChildSpan(params.options as never) as AnySpan | undefined;
  }

  /** `default.ts:322-332`. */
  async endStepSpan(params: Parameters<SpanLifecycle['endStepSpan']>[0]): Promise<void> {
    params.span?.end(params.endOptions as never);
  }

  /** `default.ts:342-352`. */
  async errorStepSpan(params: Parameters<SpanLifecycle['errorStepSpan']>[0]): Promise<void> {
    params.span?.error(params.errorOptions as never);
  }

  /** A control-flow span — parallel, conditional, loop (`default.ts:363-377`). */
  async createChildSpan(params: Parameters<SpanLifecycle['createChildSpan']>[0]): Promise<AnySpan | undefined> {
    return params.parentSpan?.createChildSpan(params.options as never) as AnySpan | undefined;
  }

  /** `default.ts:387-397`. */
  async endChildSpan(params: Parameters<SpanLifecycle['endChildSpan']>[0]): Promise<void> {
    params.span?.end(params.endOptions as never);
  }

  /** `default.ts:407-417`. */
  async errorChildSpan(params: Parameters<SpanLifecycle['errorChildSpan']>[0]): Promise<void> {
    params.span?.error(params.errorOptions as never);
  }

  #compiled(description: WorkflowDescription): CompiledWorkflow {
    // The budget is part of the key: `k` lives in the compiled workflow's initial marking.
    const key = JSON.stringify([description, this.#concurrency ?? null]);
    const hit = this.#cache.get(key);
    if (hit) return hit;
    const compiled = compile(description, this.#concurrency === undefined ? {} : { concurrency: this.#concurrency });
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

/**
 * The first run mode in `params` this engine refuses, in the order `default.ts:790-799` reads them.
 * `resume` is not among them ([ADR 0007]); `perStep` is refused on a resume as on a start.
 */
function refusedMode(params: ExecuteParams): UnsupportedRunMode | undefined {
  if (params.timeTravel !== undefined) return 'timeTravel';
  if (params.restart !== undefined) return 'restart';
  if (params.perStep === true) return 'perStep';
  return undefined;
}

/**
 * Places a resume ([ADR 0007]): decodes Mastra's `resume` parameter and chooses the one token the
 * segment starts from. Pure, and run before the first persist. A position it cannot place is
 * refused as an {@link UnsupportedRunModeError} naming the step, its stored path and the reason:
 *
 * - `UnresumablePositionError` from the compiler — nothing resumable there, the workflow changed
 *   since the run suspended (Mastra resumes blindly; this engine refuses by name, decision 2), a
 *   nested workflow inside a `.foreach()`, or a stored shape the design does not resume.
 */
function placeResume(params: ExecuteParams, compiled: CompiledWorkflow): { decoded: DecodedResume; seed: ResumeSeed } {
  const { workflowId, runId } = params;
  const stepId = params.resume?.steps[0] ?? '';
  let decoded: DecodedResume;
  try {
    decoded = decodeResume(params, compiled);
  } catch (error) {
    throw refusal(error, workflowId, runId, stepId);
  }
  let seed: ResumeSeed;
  try {
    seed = resumeSeed(compiled, decoded.request);
  } catch (error) {
    throw refusal(error, workflowId, runId, stepId);
  }
  return { decoded, seed };
}

/** An `UnresumablePositionError` as the refusal `execute()` rejects with; anything else unchanged. */
function refusal(error: unknown, workflowId: string, runId: string, stepId: string): unknown {
  if (!(error instanceof UnresumablePositionError)) return error;
  return new UnsupportedRunModeError(
    'resume',
    workflowId,
    runId,
    { stepId, path: error.path, reason: error.reason, detail: REASONS[error.reason](error) },
    { cause: error },
  );
}

const REASONS: Record<UnresumablePositionError['reason'], (e: UnresumablePositionError) => string> = {
  'no-site': (e) => `nothing at that position can be resumed (${e.message})`,
  'id-mismatch': () => 'the workflow changed since the run suspended',
  'foreach-nested': () => 'a nested workflow inside a .foreach() cannot be resumed yet',
  unsupported: (e) => e.message,
};

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

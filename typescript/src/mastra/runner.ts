import { randomUUID } from 'node:crypto';
import type { RequestContext } from '@mastra/core/di';
import type { Mastra } from '@mastra/core/mastra';
import {
  createMappingStep,
  createStepFromAgent,
  createStepFromTool,
  validateStepRequestContext,
  validateStepStateData,
  validateStepSuspendData,
  type ExecutionGraph,
  type StepFlowEntry,
  type StepResult,
} from '@mastra/core/workflows';
import type { StepExecutor } from '@mastra/core/workflows/evented';
import type { EntryPath } from '../compiler/names.js';
import type { RunView, StepCall, StepOutcome, StepRunner } from '../compiler/types.js';
import { entryId } from './host.js';
import { toMastraStepResult } from './step-result.js';

type SingleStepEntry = Extract<StepFlowEntry, { type: 'step' | 'agent' | 'tool' | 'mapping' }>;
/** The one entry kind `StepExecutor` is handed: every firing is resolved to a plain step first. */
type PlainStepEntry = Extract<StepFlowEntry, { type: 'step' }>;
type MastraStep = PlainStepEntry['step'];
type ConditionalEntry = Extract<StepFlowEntry, { type: 'conditional' }>;
type LoopEntry = Extract<StepFlowEntry, { type: 'loop' }>;
type SleepEntry = Extract<StepFlowEntry, { type: 'sleep' }>;
type SleepUntilEntry = Extract<StepFlowEntry, { type: 'sleepUntil' }>;
type Condition = Parameters<StepExecutor['evaluateCondition']>[0]['condition'];
/** The context Mastra builds for a step, a condition or a sleep function, as this file reads it. */
type Context = Record<PropertyKey, unknown>;
/** One `resumeLabels` entry, as the default engine's `suspend(…, { resumeLabel })` writes it. */
export interface ResumeLabel {
  readonly stepId: string;
  readonly foreachIndex: number | undefined;
}
type SuspendOptions = { readonly resumeLabel?: string | readonly string[] } | undefined;
type HostResult = StepResult<unknown, unknown, unknown, unknown> & {
  readonly __state?: Record<string, unknown>;
  readonly __stateDelta?: Record<string, unknown>;
  readonly tripwire?: unknown;
  readonly nonRetryable?: boolean;
};

export interface MastraStepRunnerOptions {
  readonly executor: StepExecutor;
  readonly graph: ExecutionGraph;
  readonly workflowId: string;
  readonly runId: string;
  /**
   * `Run.start({ resourceId })`, which the default engine hands every step (`handlers/step.ts:360`).
   * Absent or `undefined` when the run has none.
   */
  readonly resourceId?: string | undefined;
  /**
   * The `Mastra` the workflow is registered with, `undefined` when it is not — required, so an
   * engine cannot leave it out and have steps silently see none. The engine's own
   * `mastra`, never the executor's. Step code, conditions and sleep functions see this, as the
   * default engine passes `engine.mastra` (`handlers/step.ts:352-356`). The engine hands an
   * unregistered workflow's executor a stand-in ([ADR 0005]) that step code must not see: a
   * nested workflow registers whatever it is given and calls `mastra.getServer()` on it
   * (`workflow.ts:2914-2916`).
   */
  readonly mastra: Mastra | undefined;
  readonly requestContext: RequestContext;
  /** The run's own controller: a step's `abort()` aborts it, and the kernel sees the signal. */
  readonly abortController: AbortController;
  readonly initialState: Record<string, unknown>;
  readonly validateInputs: boolean;
}

/**
 * Runs each firing's step with **Mastra's own** single-step executor — the one its evented engine
 * uses (`@mastra/core/workflows/evented`, `StepExecutor`). It executes exactly one attempt and never
 * schedules, so Mastra keeps step execution (validation, spans, the step context, suspend, bail,
 * `abort()`, the stream writer) and the net keeps everything about what runs next.
 *
 * **The default engine is the oracle, not the evented one.** Where `StepExecutor` and
 * `DefaultExecutionEngine` disagree about what a step, a condition or a sleep function sees, this
 * file reproduces the default engine, each point cited below:
 *
 * - every entry kind is resolved to a plain step as the default engine resolves it
 *   (`executeAgent` / `executeTool` / `executeMapping`, `default.ts:1174-1213`), not run through
 *   the evented entry executors;
 * - a `.foreach()` item is handed over as the item, not re-indexed (see {@link run});
 * - `setState` is validated against the step's `stateSchema` and the **last** call wins
 *   (`handlers/step.ts:367-378`), merged into the state once the step has completed without
 *   failing (`:574-579`, `default.ts:709-713`);
 * - a step's `requestContextSchema` is enforced (`handlers/step.ts:117-124`);
 * - a nested workflow run by a `.foreach()` gets a run id of its own (`handlers/step.ts:108-109`);
 * - a step's record keeps the **validated** input as its payload (`handlers/step.ts:111,173`);
 * - `suspend` stores the suspend data as the step gave it — bare for a plain step, with the
 *   nested run's `__workflow_meta` for a nested workflow — and resume labels go to the run
 *   (`handlers/step.ts:385-415`), not into a `__workflow_meta` stamp of the executor's own;
 * - conditions and sleep functions see `retryCount: -1` and a `bail` that does nothing
 *   (`handlers/control-flow.ts:419-427,836-850`, `handlers/sleep.ts:87-104`).
 *
 * **One store.** The runner keeps no step results of its own: `StepExecutor` is handed a view over
 * the kernel's run scope that translates each record to Mastra's `StepResult` shape on access. The
 * workflow **state** (`setState`) and the run's **resume labels** are the two data held here. Both
 * are data: nothing in this file or the net reads them to decide what runs — a condition may read
 * the state, as in Mastra, and its verdict comes back to the net.
 */
export class MastraStepRunner implements StepRunner {
  readonly #o: MastraStepRunnerOptions;
  readonly #mastra: Mastra | undefined;
  /**
   * One object for the whole run, **mutated in place**, as the default engine's
   * `executionContext.state` is (`default.ts:709-713`): a step still running in a parallel arm
   * holds the same object, and sees a sibling's update the moment it is applied.
   */
  #state: Record<string, unknown>;
  /**
   * Mastra's `executionContext.resumeLabels`: every `suspend(…, { resumeLabel })` of the run, by
   * label, written the moment `suspend` is called (`handlers/step.ts:399-411`), a later label of
   * the same name overwriting an earlier one.
   */
  readonly #resumeLabels: Record<string, ResumeLabel> = {};

  constructor(options: MastraStepRunnerOptions) {
    this.#o = options;
    this.#state = { ...options.initialState };
    this.#mastra = options.mastra;
  }

  /** The workflow state after every applied update — Mastra's `state`. */
  get state(): Record<string, unknown> {
    return this.#state;
  }

  /**
   * The run's resume labels — what the default engine returns under `includeResumeLabels`
   * (`default.ts:1023-1025`) and persists as the snapshot's `resumeLabels` (`:702`).
   */
  get resumeLabels(): Readonly<Record<string, ResumeLabel>> {
    return this.#resumeLabels;
  }

  /**
   * One attempt of one step.
   *
   * **A `.foreach()` item.** The net hands over the item itself, with `call.foreachIndex`.
   * `StepExecutor` expects the whole array and indexes it (`evented/step-executor.ts:96`), so
   * passing both indexed the item a second time — `2[0]`, `undefined`, and every item failed its
   * input schema. It is handed a sparse array holding the item at its index instead.
   *
   * **The payload** is what the default engine records, `inputData` after `validateStepInput`
   * (`handlers/step.ts:111,173`): a schema's defaults and coercions applied, the raw input when
   * validation failed. `StepExecutor` records the whole sparse array for an item (`:110`), so the
   * runner takes the validated input from the context `execute` is called with.
   *
   * **A suspension** is recorded as the default engine records it (`handlers/step.ts:385-415,518`):
   * the suspend data after `validateStepSuspendData`, bare. `StepExecutor` wraps it in a
   * `__workflow_meta` stamp of its own (`{ runId, path: [stepId], … }`,
   * `evented/step-executor.ts:222-231`), which the default engine never writes and which, for a
   * nested workflow, **overwrites** the metadata Mastra's `Workflow.execute` builds from the
   * nested result (`{ runId: nested run, path: [inner step, …] }`, `workflow.ts:3056-3089`) — the
   * inner path and the nested run id resume needs. The data `suspend` was called with carries
   * that metadata, so it is what is kept. Resume labels go to {@link resumeLabels}.
   */
  async run(stepId: string, input: unknown, call: StepCall): Promise<StepOutcome> {
    const entry = this.#resolveStep(call.path, stepId);
    const foreachIndex = call.foreachIndex;
    const step = this.#runnable(entry);
    // A nested workflow started by a `.foreach()` runs under a fresh run id; anywhere else it
    // shares the parent's (`handlers/step.ts:108-109,359`).
    const nestedRunId =
      step.component === NESTED_WORKFLOW && foreachIndex !== undefined ? randomUUID() : undefined;

    let stateUpdate: Record<string, unknown> | undefined;
    // Set once `StepExecutor` has validated the input and called `execute` with it.
    let validated: { readonly input: unknown } | undefined;
    // The last `suspend` call's validated data: Mastra keeps the last (`handlers/step.ts:414`).
    let suspension: { readonly data: unknown } | undefined;
    const wrapped = overlay(step, {
      execute: async (ctx: Context): Promise<unknown> => {
        validated = { input: ctx['inputData'] };
        const { validationError } = await validateStepRequestContext({
          requestContext: this.#o.requestContext,
          step,
          validateInputs: this.#o.validateInputs,
        });
        if (validationError) throw validationError;
        const executorSuspend = ctx['suspend'] as (data: unknown) => Promise<unknown>;
        return step.execute({
          ...ctx,
          mastra: this.#mastra,
          suspend: async (data: unknown, options?: SuspendOptions): Promise<void> => {
            const { suspendData, validationError: suspendError } = await validateStepSuspendData({
              suspendData: data,
              step,
              validateInputs: this.#o.validateInputs,
            });
            if (suspendError) throw suspendError;
            for (const label of labelsOf(options)) this.#resumeLabels[label] = { stepId: step.id, foreachIndex };
            suspension = { data: suspendData };
            // Marks the attempt suspended; its stamped copy of the data is replaced below.
            await executorSuspend(data);
          },
          ...(nestedRunId === undefined ? {} : { runId: nestedRunId }),
          ...(this.#o.resourceId === undefined ? {} : { resourceId: this.#o.resourceId }),
          validateInputs: this.#o.validateInputs,
          setState: async (next: unknown): Promise<void> => {
            const { stateData, validationError: stateError } = await validateStepStateData({
              stateData: next,
              step,
              validateInputs: this.#o.validateInputs,
            });
            if (stateError) throw stateError;
            stateUpdate = stateData as Record<string, unknown> | undefined;
          },
        } as unknown as Parameters<MastraStep['execute']>[0]);
      },
    });

    const result = (await this.#o.executor.execute({
      workflowId: this.#o.workflowId,
      runId: this.#o.runId,
      entry: { type: 'step', step: wrapped },
      input: foreachIndex === undefined ? input : itemAt(input, foreachIndex),
      stepResults: this.#stepResults(call),
      state: this.#state,
      requestContext: this.#o.requestContext,
      retryCount: call.attempt,
      validateInputs: this.#o.validateInputs,
      abortController: this.#o.abortController,
      ...(foreachIndex === undefined ? {} : { foreachIdx: foreachIndex }),
    })) as HostResult;

    const { __state: _s, __stateDelta: _d, ...raw } = result as Record<string, unknown>;
    // Applied once the step has run without failing, suspended and bailed included, as the
    // default engine applies `contextMutations.stateUpdate` whenever the attempt returned.
    if (raw['status'] !== 'failed' && stateUpdate !== undefined) Object.assign(this.#state, stateUpdate);

    if (raw['status'] === 'suspended' && suspension === undefined) {
      throw new Error(`step '${stepId}' suspended without calling the suspend it was given`);
    }
    const host: Record<string, unknown> = {
      ...raw,
      payload: validated === undefined ? input : validated.input,
      ...(raw['status'] === 'suspended' ? { suspendPayload: suspension?.data } : {}),
      ...(nestedRunId === undefined ? {} : { metadata: { ...asRecord(raw['metadata']), nestedRunId } }),
    };
    return toOutcome(host);
  }

  /**
   * Each condition on its own, a throw or a rejection read as falsy — the default engine's
   * behaviour (`handlers/control-flow.ts:395-492`). `StepExecutor.evaluateConditions` catches only
   * a synchronous throw, so an async condition that rejects would reject the whole selection.
   * A branch condition is told no `iterationCount` (the default engine passes none; the evented
   * one passes 0).
   */
  async selectBranches(entryId: string, input: unknown, view: RunView): Promise<readonly number[]> {
    const entry = this.#top(view.path, 'conditional', entryId) as ConditionalEntry;
    const verdicts = await Promise.all(
      entry.conditions.map((condition) =>
        this.#o.executor
          .evaluateCondition({
            workflowId: this.#o.workflowId,
            condition: this.#condition(condition as Condition, false),
            runId: this.#o.runId,
            inputData: input,
            stepResults: this.#stepResults(view),
            state: this.#state,
            requestContext: this.#o.requestContext,
            abortController: this.#o.abortController,
            iterationCount: 0,
          })
          .then(Boolean, () => false),
      ),
    );
    return verdicts.flatMap((v, i) => (v ? [i] : []));
  }

  /**
   * A `.dowhile` / `.dountil` condition. `iteration` is the 1-based `iterationCount` of the
   * iteration that just ran, which is what the default engine hands the condition
   * (`handlers/control-flow.ts:847`), and `output` is that iteration's output (`:843`). A throw is
   * not caught, as Mastra does not catch it (`:835`); the net fails the run.
   */
  async evaluateLoopCondition(entryId: string, output: unknown, iteration: number, view: RunView): Promise<boolean> {
    const entry = this.#top(view.path, 'loop', entryId) as LoopEntry;
    return Boolean(
      await this.#o.executor.evaluateCondition({
        workflowId: this.#o.workflowId,
        condition: this.#condition(entry.condition as Condition, true),
        runId: this.#o.runId,
        inputData: output,
        stepResults: this.#stepResults(view),
        state: this.#state,
        requestContext: this.#o.requestContext,
        abortController: this.#o.abortController,
        iterationCount: iteration,
      }),
    );
  }

  /**
   * The wait of a `.sleep(fn)` (the function's value, unnormalised) or a `.sleepUntil(fn)` (an
   * epoch instant). A literal never reaches here: the net times it itself.
   *
   * `StepExecutor.resolveSleep` / `resolveSleepUntil` build the function's context, but they
   * swallow a throw as a zero wait, where the default engine lets it reject the run
   * (`handlers/sleep.ts:83-121`), and `resolveSleepUntil` returns a duration computed against
   * `Date.now()`. So the function is wrapped: the context it sees is the default engine's, what it
   * returns or throws is captured here, and the executor's own answer is discarded.
   *
   * - A `.sleep` value is returned as the function gave it. The leaf normalises it exactly as
   *   `!duration || duration < 0 ? 0 : duration` does (`leaf.ts`, `resolveWaitMs`); normalising
   *   here as well would turn a value the leaf refuses into a silent zero.
   * - A `.sleepUntil` value becomes `new Date(value)` unless it is one (`handlers/sleep.ts:252`),
   *   and the instant is its `getTime()` — `NaN` for an invalid date, which the leaf refuses.
   * - `setState` **replaces** the state, as `executionContext.state = state` does
   *   (`handlers/sleep.ts:93-95`), and is not validated.
   */
  async resolveWait(entryId: string, input: unknown, view: RunView): Promise<number> {
    const top = this.#o.graph.steps[view.path[0]!];
    let captured: { readonly value: unknown } | { readonly error: unknown } | undefined;
    const capture = (fn: (ctx: Context) => unknown) => async (ctx: Context): Promise<Date> => {
      try {
        captured = { value: await fn(this.#sideContext(ctx, { retryCount: -1, suspend: async () => {} }, true)) };
      } catch (error) {
        captured = { error };
      }
      return new Date();
    };
    const common = {
      workflowId: this.#o.workflowId,
      runId: this.#o.runId,
      input,
      stepResults: this.#stepResults(view),
      state: this.#state,
      requestContext: this.#o.requestContext,
      abortController: this.#o.abortController,
    };

    let kind: 'sleep' | 'sleepUntil';
    if (top?.type === 'sleep' && top.id === entryId && top.fn !== undefined) {
      kind = 'sleep';
      const step: SleepEntry = { ...top, duration: undefined, fn: capture(top.fn as (ctx: Context) => unknown) as SleepEntry['fn'] };
      await this.#o.executor.resolveSleep({ ...common, step });
    } else if (top?.type === 'sleepUntil' && top.id === entryId && top.fn !== undefined) {
      kind = 'sleepUntil';
      const step: SleepUntilEntry = { ...top, date: undefined, fn: capture(top.fn as (ctx: Context) => unknown) as SleepUntilEntry['fn'] };
      await this.#o.executor.resolveSleepUntil({ ...common, step });
    } else {
      throw new Error(`no per-run sleep '${entryId}' at path ${view.path.join('-')} in workflow '${this.#o.workflowId}'`);
    }

    if (captured === undefined) throw new Error(`${kind} '${entryId}': the function was never called`);
    if ('error' in captured) throw captured.error;
    if (kind === 'sleep') {
      // Unnormalised on purpose; see above. The leaf reads it as `unknown`.
      return captured.value as number;
    }
    const value = captured.value;
    return (value instanceof Date ? value : new Date(value as string | number)).getTime();
  }

  /**
   * A condition as the default engine calls it: `retryCount: -1`, a `bail` that does nothing,
   * the registered `mastra` or none, and — for a branch — no `iterationCount`.
   */
  #condition(condition: Condition, loop: boolean): Condition {
    const wrapped = (ctx: Context): Promise<boolean> =>
      (condition as unknown as (c: Context) => Promise<boolean>)(this.#sideContext(ctx, { retryCount: -1 }, loop));
    return wrapped as unknown as Condition;
  }

  /** The context of a condition or a sleep function, with the default engine's differences. */
  #sideContext(ctx: Context, extra: Context, keepIterationCount: boolean): Context {
    const { iterationCount, ...rest } = ctx;
    return {
      ...rest,
      ...(keepIterationCount && iterationCount !== undefined ? { iterationCount } : {}),
      mastra: this.#mastra,
      bail: () => {},
      ...extra,
      ...(ctx['setState'] === undefined
        ? {}
        : {
            setState: async (next: unknown): Promise<void> => {
              if (typeof next === 'object' && next !== null) this.#state = next as Record<string, unknown>;
            },
          }),
    };
  }

  /**
   * A single-step entry as the step the default engine runs for it
   * (`default.ts:1174-1213`): a `step` is itself; an `agent` or a `tool` is resolved from its
   * handle or, by id, from the registered `Mastra`, and built with `createStepFromAgent` /
   * `createStepFromTool` under the entry's id; a `mapping` is `createMappingStep`.
   */
  #runnable(entry: SingleStepEntry): MastraStep {
    switch (entry.type) {
      case 'step':
        return entry.step;
      case 'agent': {
        const agent = entry.agent ?? this.#mastra?.getAgentById(entry.agentId);
        if (!agent) {
          throw new Error(
            `Agent '${entry.agentId}' not found for workflow step '${entry.id}'. Register the agent on the Mastra instance or pass the agent instance directly.`,
          );
        }
        return { ...createStepFromAgent(agent as Parameters<typeof createStepFromAgent>[0], entry.options), id: entry.id } as MastraStep;
      }
      case 'tool': {
        const tool = entry.tool ?? this.#mastra?.getTool(entry.toolId as never);
        if (!tool) {
          throw new Error(
            `Tool '${entry.toolId}' not found for workflow step '${entry.id}'. Pass the tool instance directly.`,
          );
        }
        return { ...createStepFromTool(tool as Parameters<typeof createStepFromTool>[0], entry.options), id: entry.id } as MastraStep;
      }
      case 'mapping':
        return createMappingStep(entry.id, entry.mapConfig as Parameters<typeof createMappingStep>[1]) as MastraStep;
      default: {
        const unreachable: never = entry;
        throw new Error(`unknown single-step entry ${JSON.stringify(unreachable)}`);
      }
    }
  }

  /**
   * The Mastra entry a firing runs, found by **view path** and checked against the id. By id alone
   * is not enough: adapter-synthesised ids collide (two unnamed loops over one step).
   */
  #resolveStep(path: EntryPath, stepId: string): SingleStepEntry {
    const top = this.#o.graph.steps[path[0]!];
    let candidate: StepFlowEntry | undefined = top;
    if (top !== undefined && (top.type === 'parallel' || top.type === 'conditional')) {
      candidate = path.length > 1 ? top.steps[path[1]!] : undefined;
    } else if (top !== undefined && (top.type === 'loop' || top.type === 'foreach')) {
      candidate = top.step;
    }
    if (candidate === undefined || !isSingle(candidate) || entryId(candidate) !== stepId) {
      throw new Error(`no step '${stepId}' at path ${path.join('-')} in workflow '${this.#o.workflowId}'`);
    }
    return candidate;
  }

  #top<T extends StepFlowEntry['type']>(path: EntryPath, type: T, id: string): Extract<StepFlowEntry, { type: T }> {
    const top = this.#o.graph.steps[path[0]!];
    if (top === undefined || top.type !== type) {
      throw new Error(`no ${type} '${id}' at path ${path.join('-')} in workflow '${this.#o.workflowId}'`);
    }
    return top as Extract<StepFlowEntry, { type: T }>;
  }

  /** Mastra-shaped step results, read through to the kernel's store on every access. */
  #stepResults(view: RunView): Record<string, StepResult<unknown, unknown, unknown, unknown>> {
    return new Proxy({} as Record<string, StepResult<unknown, unknown, unknown, unknown>>, {
      get: (_, key) => {
        if (typeof key !== 'string') return undefined;
        const record = view.getStepResult(key);
        if (record !== undefined) return toMastraStepResult(record, { now: Date.now() });
        return key === 'input' ? view.initData : undefined;
      },
      has: (_, key) => typeof key === 'string' && (view.getStepResult(key) !== undefined || key === 'input'),
    });
  }
}

/** `RegisteredLogger.WORKFLOW` — the `component` a nested `Workflow` carries (`adapt.ts`). */
const NESTED_WORKFLOW = 'WORKFLOW';

function isSingle(entry: StepFlowEntry): entry is SingleStepEntry {
  return entry.type === 'step' || entry.type === 'agent' || entry.type === 'tool' || entry.type === 'mapping';
}

/** `suspend`'s `resumeLabel` option as a list (`handlers/step.ts:399-402`). */
function labelsOf(options: SuspendOptions): readonly string[] {
  const label = options?.resumeLabel;
  if (!label) return [];
  return typeof label === 'string' ? [label] : label;
}

/**
 * `step` with some members replaced, and every other read going to `step` itself. A `Proxy`, not
 * a spread: a nested workflow is a class instance with private fields, and a spread copy would
 * lose its prototype. Functions are bound to the original for the same reason.
 */
function overlay(step: MastraStep, replaced: Record<string, unknown>): MastraStep {
  return new Proxy(step, {
    get(target, key) {
      if (typeof key === 'string' && Object.hasOwn(replaced, key)) return replaced[key];
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** A sparse array holding `item` at `index`, which `StepExecutor` indexes back to `item`. */
function itemAt(item: unknown, index: number): unknown[] {
  const items: unknown[] = [];
  items[index] = item;
  return items;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Mastra's `StepResult` as the net's outcome, keeping the whole result as `host` for the codec. */
function toOutcome(host: Record<string, unknown>): StepOutcome {
  // The validated input rides on the outcome so the record carries it, not the raw token data.
  const payload = { payload: host['payload'] };
  switch (host['status']) {
    case 'success':
      return { status: 'success', output: host['output'], ...payload, host };
    case 'bailed':
      return { status: 'bailed', output: host['output'], ...payload, host };
    case 'paused':
      return { status: 'paused', ...payload, host };
    case 'suspended':
      return {
        status: 'suspended',
        suspendPayload: host['suspendPayload'],
        ...(host['suspendOutput'] === undefined ? {} : { suspendOutput: host['suspendOutput'] }),
        ...payload,
        host,
      };
    default:
      return {
        status: 'failed',
        error: host['error'],
        ...(host['tripwire'] === undefined ? {} : { tripwire: host['tripwire'] }),
        ...(host['nonRetryable'] === true ? { nonRetryable: true } : {}),
        ...payload,
        host,
      };
  }
}

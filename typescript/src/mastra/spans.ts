import type { RequestContext } from '@mastra/core/di';
import { MastraError, ErrorDomain, ErrorCategory, getErrorFromUnknown } from '@mastra/core/error';
import { EntityType, SpanType, type AnySpan, type TracingPolicy } from '@mastra/core/observability';
import { selectFields } from '@mastra/core/utils';
import { getSingleStepEntryId, resolveForeachConcurrency, type ExecutionGraph, type StepFlowEntry } from '@mastra/core/workflows';
import type { EntryPath } from '../compiler/names.js';
import type { LifecycleEvent, StepRecord } from '../compiler/types.js';
import { toMastraStepResult } from './step-result.js';

/** What a span is created with — the options the default engine hands `createChildSpan`. */
export interface SpanOptions {
  readonly name: string;
  readonly type: SpanType;
  readonly input?: unknown;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly attributes?: Record<string, unknown>;
  readonly tracingPolicy?: TracingPolicy | undefined;
  readonly requestContext?: RequestContext;
}

/**
 * The span lifecycle hooks the default engine owns (`default.ts:280-418`) — `createStepSpan`,
 * `endStepSpan`, `errorStepSpan` and their control-flow twins — which `PetriExecutionEngine`
 * implements with the same defaults, so a subclass can make them durable as Inngest does.
 * Mastra's `executionContext` parameter is not carried: it only feeds a durable override.
 */
export interface SpanLifecycle {
  createStepSpan(params: { parentSpan: AnySpan | undefined; stepId: string; operationId: string; options: SpanOptions }): Promise<AnySpan | undefined>;
  endStepSpan(params: { span: AnySpan | undefined; operationId: string; endOptions: { output?: unknown; attributes?: Record<string, unknown> } }): Promise<void>;
  errorStepSpan(params: { span: AnySpan | undefined; operationId: string; errorOptions: { error: Error; attributes?: Record<string, unknown> } }): Promise<void>;
  createChildSpan(params: { parentSpan: AnySpan | undefined; operationId: string; options: SpanOptions }): Promise<AnySpan | undefined>;
  endChildSpan(params: { span: AnySpan | undefined; operationId: string; endOptions?: { output?: unknown; attributes?: Record<string, unknown> } }): Promise<void>;
  errorChildSpan(params: { span: AnySpan | undefined; operationId: string; errorOptions: { error: Error; attributes?: Record<string, unknown> } }): Promise<void>;
}

export interface StepSpansOptions {
  readonly lifecycle: SpanLifecycle;
  /** The run's `WORKFLOW_RUN` span, which `Run` created; absent, every span here is too. */
  readonly workflowSpan: AnySpan | undefined;
  readonly graph: ExecutionGraph;
  readonly workflowId: string;
  readonly runId: string;
  readonly requestContext: RequestContext;
  /** `engine.options.tracingPolicy`, as every default-engine span is created with it. */
  readonly tracingPolicy: TracingPolicy | undefined;
  readonly signal: AbortSignal;
  /** The run's input, `getInitData()` of a `.foreach()`'s concurrency (`handlers/control-flow.ts:983-986`). */
  readonly initData: unknown;
  /**
   * The top-level index of a `.parallel()` / `.branch()` this segment resumes an arm of. The
   * default engine resumes such an arm straight from `executeEntry` (`handlers/entry.ts:350-413`),
   * with no block span: the arm's step span is a child of the run's.
   */
  readonly resumedBlock?: number | undefined;
}

type SingleEntry = Extract<StepFlowEntry, { type: 'step' | 'agent' | 'tool' | 'mapping' }>;
type ParallelEntry = Extract<StepFlowEntry, { type: 'parallel' }>;
type ConditionalEntry = Extract<StepFlowEntry, { type: 'conditional' }>;
type LoopEntry = Extract<StepFlowEntry, { type: 'loop' }>;
type ForeachEntry = Extract<StepFlowEntry, { type: 'foreach' }>;
type Mastra = Record<string, unknown>;

/** A control-flow span of one top-level entry in this segment — a top-level entry runs at most once in it. */
interface Block {
  readonly span: Promise<AnySpan | undefined>;
  closed: boolean;
  /** `.parallel()` / `.branch()`: the arms to wait for — every arm, or the selected ones. */
  expected?: readonly number[];
  /** Each settled arm's result, or each settled `.foreach()` item's, by index. */
  readonly settled: Map<number, Mastra>;
  /** A loop: the iteration its body last ran — Mastra's `iterationCount`. */
  iteration?: number;
}

/**
 * The run's spans as the default engine builds them, driven by the points the runner sees — its
 * attempt-0 call of each step and the net's lifecycle events ([ADR 0008]) — and by the branch and
 * loop conditions it evaluates. Observation only: nothing here is read to decide what runs, and a
 * throw is kept in {@link error}, never propagated into a firing.
 *
 * - **A step** (`handlers/step.ts:182-202,531-560`; `default.ts:455-511`): a `WORKFLOW_STEP` span
 *   before its first attempt, with the validated input and, for a mapping entry, its
 *   `entryDescription` / `entryMetadata`; ended with the output and status on a final record that
 *   did not fail, errored with `WORKFLOW_STEP_INVOKE_FAILED` wrapping the step's error on one that
 *   did. A `.foreach()` item gets one too, under the foreach's span (`handlers/control-flow.ts:1096-1113`).
 * - **A `.parallel()`** (`handlers/control-flow.ts:170-309`): `WORKFLOW_PARALLEL`, opened as its
 *   first arm starts and closed once every arm has settled — the `Promise.all` Mastra awaits.
 * - **A `.branch()`** (`:378-640`): `WORKFLOW_CONDITIONAL`, opened before its conditions, one
 *   `WORKFLOW_CONDITIONAL_EVAL` per condition, `truthyIndexes` / `selectedSteps` once they are
 *   known, closed once every selected arm has settled.
 * - **A `.dowhile()` / `.dountil()`** (`:710-910`): `WORKFLOW_LOOP`, opened as its body first
 *   starts, one eval span per condition, closed by the verdict that leaves, by a body that does not
 *   succeed, or by the abort checks Mastra makes after a body and after a condition.
 * - **A `.foreach()`** (`:998-1480`): `WORKFLOW_LOOP` from `foreach-entered` to `foreach-settled`.
 */
export class StepSpans {
  readonly #o: StepSpansOptions;
  readonly #steps = new Map<string, Promise<AnySpan | undefined>>();
  readonly #blocks = new Map<number, Block>();
  #error: { readonly error: unknown } | undefined;

  constructor(options: StepSpansOptions) {
    this.#o = options;
  }

  /** The first throw from any span operation — kept, never raised, as the events' is. */
  get error(): { readonly error: unknown } | undefined {
    return this.#error;
  }

  #keep(error: unknown): void {
    this.#error ??= { error };
  }

  async #safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (error) {
      this.#keep(error);
      return undefined;
    }
  }

  #op(suffix: string): string {
    return `workflow.${this.#o.workflowId}.run.${this.#o.runId}.${suffix}`;
  }

  #top(path: EntryPath): StepFlowEntry | undefined {
    return this.#o.graph.steps[path[0]!];
  }

  /**
   * The step's span: created at attempt 0, the same span for every retry (`handlers/step.ts:182`,
   * before `executeStepWithRetry`). `input` is `validateStepInput`'s `inputData`; `prevOutput` the
   * input as it arrived, which a block's span opened here carries (`handlers/control-flow.ts:176,716`).
   */
  step(
    call: { readonly stepId: string; readonly path: EntryPath; readonly attempt: number; readonly foreachIndex?: number | undefined; readonly iteration?: number | undefined },
    entry: SingleEntry,
    input: unknown,
    prevOutput: unknown,
  ): Promise<AnySpan | undefined> {
    const key = stepKey(call.stepId, call.path, call.foreachIndex);
    const open = this.#steps.get(key);
    if (call.attempt > 0 && open !== undefined) return open;
    const span = this.#safe(async () => {
      const parent = await this.#parent(call.path, prevOutput, call.iteration);
      const mapping = entry.type === 'mapping' ? entry : undefined;
      const description = mapping?.description;
      const metadata = mapping?.metadata as Record<string, unknown> | undefined;
      return this.#o.lifecycle.createStepSpan({
        parentSpan: parent,
        stepId: call.stepId,
        operationId: this.#op(`step.${call.stepId}.span.start`),
        options: {
          name: `workflow step: '${call.stepId}'`,
          type: SpanType.WORKFLOW_STEP,
          entityType: EntityType.WORKFLOW_STEP,
          entityId: call.stepId,
          input,
          ...(description || metadata
            ? { attributes: { ...(description ? { entryDescription: description } : {}), ...(metadata ? { entryMetadata: metadata } : {}) } }
            : {}),
          tracingPolicy: this.#o.tracingPolicy,
          requestContext: this.#o.requestContext,
        },
      });
    });
    this.#steps.set(key, span);
    return span;
  }

  /** The span a step's span is a child of: its block's, or the run's. */
  async #parent(path: EntryPath, input: unknown, iteration: number | undefined): Promise<AnySpan | undefined> {
    const index = path[0]!;
    const top = this.#top(path);
    switch (top?.type) {
      case 'parallel':
        if (this.#o.resumedBlock === index) return this.#o.workflowSpan;
        return this.#parallel(index, top, input).span;
      case 'conditional': {
        const block = this.#blocks.get(index);
        return block === undefined ? this.#o.workflowSpan : block.span;
      }
      case 'loop': {
        const block = this.#loop(index, top, input);
        if (iteration !== undefined) block.iteration = iteration;
        return block.span;
      }
      case 'foreach': {
        const block = this.#blocks.get(index);
        return block === undefined ? this.#o.workflowSpan : block.span;
      }
      default:
        return this.#o.workflowSpan;
    }
  }

  #open(index: number, options: SpanOptions, operation: string): Block {
    const block: Block = {
      span: this.#safe(() =>
        this.#o.lifecycle.createChildSpan({ parentSpan: this.#o.workflowSpan, operationId: this.#op(`${operation}.${index}.span.start`), options }),
      ),
      closed: false,
      settled: new Map(),
    };
    this.#blocks.set(index, block);
    return block;
  }

  #parallel(index: number, entry: ParallelEntry, input: unknown): Block {
    const existing = this.#blocks.get(index);
    if (existing !== undefined) return existing;
    const block = this.#open(
      index,
      {
        type: SpanType.WORKFLOW_PARALLEL,
        name: controlFlowSpanName(entry, `parallel: '${entry.steps.length} branches'`),
        input,
        attributes: {
          branchCount: entry.steps.length,
          parallelSteps: entry.steps.map((s) => singleId(s)),
          ...identityAttributes(entry),
        },
        tracingPolicy: this.#o.tracingPolicy,
      },
      'parallel',
    );
    block.expected = entry.steps.map((_, i) => i);
    return block;
  }

  #loop(index: number, entry: LoopEntry, input: unknown): Block {
    const existing = this.#blocks.get(index);
    if (existing !== undefined) return existing;
    return this.#open(
      index,
      {
        type: SpanType.WORKFLOW_LOOP,
        name: controlFlowSpanName(entry, `loop: '${entry.loopType}'`),
        input,
        attributes: { loopType: entry.loopType, ...identityAttributes(entry) },
        tracingPolicy: this.#o.tracingPolicy,
      },
      'loop',
    );
  }

  // ---- .branch() ----------------------------------------------------------------------------------

  /** The conditional's span, before any condition (`handlers/control-flow.ts:378-392`). */
  conditional(index: number, entry: ConditionalEntry, input: unknown): void {
    if (this.#o.resumedBlock === index || this.#blocks.has(index)) return;
    this.#open(
      index,
      {
        type: SpanType.WORKFLOW_CONDITIONAL,
        name: controlFlowSpanName(entry, `conditional: '${entry.conditions.length} conditions'`),
        input,
        attributes: { conditionCount: entry.conditions.length, ...identityAttributes(entry) },
        tracingPolicy: this.#o.tracingPolicy,
      },
      'conditional',
    );
  }

  /** One condition's `WORKFLOW_CONDITIONAL_EVAL` span (`:398-412`). */
  async conditionEval(index: number, conditionIndex: number, input: unknown): Promise<AnySpan | undefined> {
    const block = this.#blocks.get(index);
    if (block === undefined) return undefined;
    return this.#safe(async () =>
      this.#o.lifecycle.createChildSpan({
        parentSpan: await block.span,
        operationId: this.#op(`conditional.${index}.eval.${conditionIndex}.span.start`),
        options: {
          type: SpanType.WORKFLOW_CONDITIONAL_EVAL,
          name: `condition '${conditionIndex}'`,
          input,
          attributes: { conditionIndex },
          tracingPolicy: this.#o.tracingPolicy,
        },
      }),
    );
  }

  /** A condition that returned: `result !== null`, i.e. whether it was truthy (`:455-464`). */
  async conditionEvaluated(span: AnySpan | undefined, index: number, conditionIndex: number, selected: boolean): Promise<void> {
    await this.#safe(() =>
      this.#o.lifecycle.endChildSpan({
        span,
        operationId: this.#op(`conditional.${index}.eval.${conditionIndex}.span.end`),
        endOptions: { output: selected, attributes: { result: selected } },
      }),
    );
  }

  /** A condition that threw: the span is errored with the tracked `MastraError`, `result: false` (`:481-490`). */
  async conditionFailed(span: AnySpan | undefined, index: number, conditionIndex: number, error: Error): Promise<void> {
    await this.#safe(() =>
      this.#o.lifecycle.errorChildSpan({
        span,
        operationId: this.#op(`conditional.${index}.eval.${conditionIndex}.span.error`),
        errorOptions: { error, attributes: { result: false } },
      }),
    );
  }

  /** The selection: `truthyIndexes` and `selectedSteps` on the span (`:522-528`); no arm closes it now. */
  async selected(index: number, entry: ConditionalEntry, truthy: readonly number[]): Promise<void> {
    const block = this.#blocks.get(index);
    if (block === undefined) return;
    await this.#safe(async () => {
      (await block.span)?.update({
        attributes: { truthyIndexes: [...truthy], selectedSteps: truthy.map((i) => singleId(entry.steps[i]!)) },
      } as never);
    });
    block.expected = [...truthy];
    if (truthy.length === 0) await this.#closeBlock(index, block, 'conditional', []);
  }

  // ---- .dowhile() / .dountil() --------------------------------------------------------------------

  /** A loop condition's eval span (`handlers/control-flow.ts:820-833`); `iteration` is 1-based. */
  async loopEval(index: number, entry: LoopEntry, iteration: number, output: unknown): Promise<AnySpan | undefined> {
    const block = this.#blocks.get(index);
    if (block === undefined || block.closed) return undefined;
    return this.#safe(async () =>
      this.#o.lifecycle.createChildSpan({
        parentSpan: await block.span,
        operationId: this.#op(`loop.${index}.eval.${iteration - 1}.span.start`),
        options: {
          type: SpanType.WORKFLOW_CONDITIONAL_EVAL,
          name: `condition: '${entry.loopType}'`,
          input: selectFields(output, ['stepResult', 'output.text', 'output.object', 'messages']),
          attributes: { conditionIndex: iteration - 1 },
          tracingPolicy: this.#o.tracingPolicy,
        },
      }),
    );
  }

  /**
   * The condition returned `verdict` (`:875-910`): its eval span ends with it; then the loop's span
   * ends early if the run was aborted meanwhile, or ends with the last output when the verdict
   * leaves the loop. A throwing condition reaches neither, as in Mastra (`:835` does not catch).
   */
  async loopVerdict(index: number, entry: LoopEntry, span: AnySpan | undefined, verdict: unknown, iteration: number, output: unknown): Promise<void> {
    await this.#safe(() =>
      this.#o.lifecycle.endChildSpan({ span, operationId: this.#op(`loop.${index}.eval.${iteration - 1}.span.end`), endOptions: { output: verdict } }),
    );
    const block = this.#blocks.get(index);
    if (block === undefined || block.closed) return;
    const leaves = entry.loopType === 'dowhile' ? !verdict : !!verdict;
    if (this.#o.signal.aborted) {
      await this.#endBlock(index, block, 'loop', 'end.early', { attributes: { totalIterations: iteration } });
    } else if (leaves) {
      await this.#endBlock(index, block, 'loop', 'end', { output, attributes: { totalIterations: iteration } });
    }
  }

  // ---- the net's lifecycle events -----------------------------------------------------------------

  /** A lifecycle event from the net ([ADR 0008]). */
  async observe(event: LifecycleEvent): Promise<void> {
    switch (event.kind) {
      case 'step-settled':
        return this.#stepSettled(event.stepId, event.path, event.foreachIndex, event.record);
      case 'foreach-entered':
        return this.#foreachEntered(event.path, event.input);
      case 'foreach-settled':
        return this.#foreachSettled(event.path, event.record);
      default:
        return;
    }
  }

  async #stepSettled(stepId: string, path: EntryPath, foreachIndex: number | undefined, record: StepRecord): Promise<void> {
    const key = stepKey(stepId, path, foreachIndex);
    const pending = this.#steps.get(key);
    this.#steps.delete(key);
    const result = toMastraStepResult(record, { now: Date.now() }) as unknown as Mastra;
    const span = pending === undefined ? undefined : await pending;
    if (result['status'] === 'failed') {
      // `executeStepWithRetry` errors the span itself, with the tracked error (`default.ts:476-499`).
      await this.#safe(async () => {
        const errorInstance = getErrorFromUnknown(result['error'], { serializeStack: false, fallbackMessage: 'Unknown step execution error' });
        const mastraError = new MastraError(
          {
            id: 'WORKFLOW_STEP_INVOKE_FAILED',
            domain: ErrorDomain.MASTRA_WORKFLOW,
            category: ErrorCategory.USER,
            details: { workflowId: this.#o.workflowId, runId: this.#o.runId, stepId: `workflow.${this.#o.workflowId}.step.${stepId}` },
          },
          errorInstance,
        );
        span?.error({ error: mastraError, attributes: { status: 'failed' } } as never);
      });
    } else {
      await this.#safe(() =>
        this.#o.lifecycle.endStepSpan({
          span,
          operationId: this.#op(`step.${stepId}.span.end`),
          endOptions: { output: result['output'], attributes: { status: result['status'] } },
        }),
      );
    }

    const index = path[0]!;
    const top = this.#top(path);
    const block = this.#blocks.get(index);
    if (block === undefined || block.closed) return;
    if (top?.type === 'foreach' && foreachIndex !== undefined) {
      block.settled.set(foreachIndex, result);
    } else if (top?.type === 'parallel' || top?.type === 'conditional') {
      const arm = path[1];
      if (arm === undefined) return;
      block.settled.set(arm, result);
      const expected = block.expected;
      if (expected !== undefined && expected.every((i) => block.settled.has(i))) {
        await this.#closeBlock(index, block, top.type === 'parallel' ? 'parallel' : 'conditional', expected, top.steps);
      }
    } else if (top?.type === 'loop') {
      const iteration = block.iteration ?? 1;
      if (result['status'] !== 'success') {
        await this.#endBlock(index, block, 'loop', 'end.early', { attributes: { totalIterations: iteration - 1 } });
      } else if (this.#o.signal.aborted) {
        await this.#endBlock(index, block, 'loop', 'end.early', { attributes: { totalIterations: iteration } });
      }
    }
  }

  /**
   * A `.parallel()` or `.branch()` whose arms have all settled: errored with the lowest failed
   * arm's error, or ended with the lowest suspended arm, `canceled`, or the successful outputs by
   * id (`handlers/control-flow.ts:262-309,596-640`).
   */
  async #closeBlock(index: number, block: Block, kind: 'parallel' | 'conditional', arms: readonly number[], steps?: readonly StepFlowEntry[]): Promise<void> {
    const results = [...arms].sort((a, b) => a - b).map((i) => [i, block.settled.get(i) ?? {}] as const);
    const failed = results.find(([, r]) => r['status'] === 'failed');
    const suspended = results.find(([, r]) => r['status'] === 'suspended');
    if (failed !== undefined) {
      block.closed = true;
      await this.#safe(async () =>
        this.#o.lifecycle.errorChildSpan({
          span: await block.span,
          operationId: this.#op(`${kind}.${index}.span.error`),
          errorOptions: { error: failed[1]['error'] as Error },
        }),
      );
      return;
    }
    let output: unknown;
    if (suspended !== undefined) {
      const r = suspended[1];
      output = {
        status: 'suspended',
        suspendPayload: r['suspendPayload'],
        ...(r['suspendOutput'] ? { suspendOutput: r['suspendOutput'] } : {}),
        ...(kind === 'conditional' ? { suspendedAt: r['suspendedAt'] } : {}),
      };
    } else if (this.#o.signal.aborted) {
      output = { status: 'canceled' };
    } else {
      const byId: Record<string, unknown> = {};
      for (const [i, r] of results) if (r['status'] === 'success' && steps?.[i] !== undefined) byId[singleId(steps[i])] = r['output'];
      output = byId;
    }
    await this.#endBlock(index, block, kind, 'end', { output });
  }

  async #endBlock(index: number, block: Block, kind: string, suffix: string, endOptions: { output?: unknown; attributes?: Record<string, unknown> }): Promise<void> {
    if (block.closed) return;
    block.closed = true;
    await this.#safe(async () =>
      this.#o.lifecycle.endChildSpan({ span: await block.span, operationId: this.#op(`${kind}.${index}.span.${suffix}`), endOptions }),
    );
  }

  // ---- .foreach() ---------------------------------------------------------------------------------

  async #foreachEntered(path: EntryPath, input: unknown): Promise<void> {
    const index = path[0]!;
    const top = this.#top(path);
    if (top?.type !== 'foreach' || this.#blocks.has(index)) return;
    const entry = top as ForeachEntry;
    let concurrency: number | undefined;
    try {
      concurrency = resolveForeachConcurrency(entry.opts as Parameters<typeof resolveForeachConcurrency>[0], {
        inputData: input,
        getInitData: () => this.#o.initData,
      } as Parameters<typeof resolveForeachConcurrency>[1]);
    } catch (error) {
      this.#keep(error);
    }
    const block = this.#open(
      index,
      {
        type: SpanType.WORKFLOW_LOOP,
        name: controlFlowSpanName(entry, `loop: 'foreach'`),
        input,
        attributes: { loopType: 'foreach', concurrency, ...identityAttributes(entry) },
        tracingPolicy: this.#o.tracingPolicy,
      },
      'foreach',
    );
    await block.span;
  }

  /** The aggregate's record: the foreach's span ends as Mastra's does for that outcome (`:1282-1486`). */
  async #foreachSettled(path: EntryPath, record: StepRecord): Promise<void> {
    const index = path[0]!;
    const block = this.#blocks.get(index);
    if (block === undefined || block.closed) return;
    const result = toMastraStepResult(record, { now: Date.now() }) as unknown as Mastra;
    switch (result['status']) {
      case 'failed':
        block.closed = true;
        await this.#safe(async () =>
          this.#o.lifecycle.errorChildSpan({
            span: await block.span,
            operationId: this.#op(`foreach.${index}.span.error`),
            errorOptions: { error: result['error'] as Error },
          }),
        );
        return;
      case 'canceled':
        return this.#endBlock(index, block, 'foreach', 'end.early', { output: result['output'] ?? [] });
      case 'bailed':
      case 'paused':
        return this.#endBlock(index, block, 'foreach', 'end.early', { output: 'output' in result ? result['output'] : undefined });
      case 'suspended': {
        const lowest = [...block.settled.entries()].filter(([, r]) => r['status'] === 'suspended').sort(([a], [b]) => a - b)[0]?.[1];
        const output =
          lowest === undefined
            ? undefined
            : {
                status: 'suspended',
                suspendPayload: lowest['suspendPayload'],
                suspendedAt: lowest['suspendedAt'],
                ...(lowest['suspendOutput'] ? { suspendOutput: lowest['suspendOutput'] } : {}),
              };
        return this.#endBlock(index, block, 'foreach', 'end', { output });
      }
      default:
        return this.#endBlock(index, block, 'foreach', 'end', { output: result['output'] });
    }
  }
}

function stepKey(stepId: string, path: EntryPath, foreachIndex: number | undefined): string {
  return `${stepId}\u0000${path.join('.')}\u0000${foreachIndex ?? ''}`;
}

/** A block arm's id, as Mastra's `getSingleStepEntryId` reads it. */
function singleId(entry: StepFlowEntry): string {
  return getSingleStepEntryId(entry as Parameters<typeof getSingleStepEntryId>[0]);
}

/** `getControlFlowSpanName` (`handlers/control-flow.ts:56-59`). */
function controlFlowSpanName(entry: { id?: string }, fallback: string): string {
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  return id ? `${fallback.split(':')[0]}: '${id}'` : fallback;
}

/** `getControlFlowIdentityAttributes` (`handlers/control-flow.ts:66-84`). */
function identityAttributes(entry: { id?: string; description?: string; metadata?: Record<string, unknown> }): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  if (id) attributes['entryId'] = id;
  const description = typeof entry.description === 'string' ? entry.description.trim() : '';
  if (description) attributes['entryDescription'] = description;
  if (entry.metadata && typeof entry.metadata === 'object') attributes['entryMetadata'] = entry.metadata;
  return attributes;
}

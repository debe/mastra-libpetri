import { TripWire } from '@mastra/core/agent';
import { getErrorFromUnknown, type SerializedError } from '@mastra/core/error';
import { deepEqual } from '@mastra/core/utils';
import type { StepFlowEntry } from '@mastra/core/workflows';
import type { RunOutcome, RunReport } from '../engine/kernel.js';
import type { StepRecord } from '../compiler/types.js';
import { entryId } from './host.js';
import { toMastraStepResult } from './step-result.js';

/** `Run.start({ outputOptions })`, as `execute()` receives it. */
export interface OutputOptions {
  readonly includeState?: boolean;
  readonly includeResumeLabels?: boolean;
}

/** What `formatWorkflowResult` needs from one finished run. */
export interface FormatContext {
  readonly report: RunReport;
  /** The workflow's input — Mastra's `stepResults.input`. */
  readonly input: unknown;
  /** The workflow state after the run — Mastra's `lastState`. */
  readonly state: Record<string, unknown>;
  /** `Run.start({ outputOptions })`, forwarded by `execute()`. */
  readonly outputOptions?: OutputOptions;
  /**
   * The run's id. `DefaultExecutionEngine.execute` spreads it into every result it returns
   * (`default.ts:870,1053,1125-1128`); omitted, the result has no `runId`.
   */
  readonly runId?: string;
  /**
   * The workflow's top-level entries — `execute()`'s `graph.steps`. `stepExecutionPath` is built
   * from them; omitted, the result has **no** `stepExecutionPath` and no payload deduplication,
   * which is exactly what `fmtReturnValue` does when its `stepExecutionPath` argument is absent
   * (`default.ts:564`).
   */
  readonly graph?: { readonly steps: readonly StepFlowEntry[] };
  /**
   * The run's resume labels — Mastra's `executionContext.resumeLabels`, every
   * `suspend(…, { resumeLabel })` of the run by label (`handlers/step.ts:399-411`), as the runner
   * collects them. A suspended run returns them under `includeResumeLabels`
   * (`default.ts:1023-1025`); omitted, that is `{}`.
   */
  readonly resumeLabels?: Readonly<Record<string, ResumeLabel>>;
}

/** One `resumeLabels` entry, as the step context's `suspend(…, { resumeLabel })` writes it. */
export interface ResumeLabel {
  readonly stepId: string;
  readonly foreachIndex?: number;
}

/** What every status carries: `fmtReturnValue`'s `base`, plus what `execute()` adds to it. */
interface ResultBase {
  readonly steps: Record<string, unknown>;
  readonly input: unknown;
  readonly stepExecutionPath?: string[];
  readonly runId?: string;
  readonly state?: Record<string, unknown>;
}

/** Mastra's `WorkflowResult` (and its `canceled` stream status), as `execute()` returns it. */
export type FormattedResult = (
  | (ResultBase & { readonly status: 'success'; readonly result: unknown })
  | (ResultBase & { readonly status: 'failed'; readonly error: SerializedError })
  | (ResultBase & { readonly status: 'tripwire'; readonly tripwire: unknown })
  | (ResultBase & {
      readonly status: 'suspended';
      readonly suspended: string[][];
      readonly suspendPayload: Record<string, unknown>;
      readonly resumeLabels?: Record<string, ResumeLabel>;
    })
  | (ResultBase & { readonly status: 'paused' })
  | (ResultBase & { readonly status: 'canceled' })
) &
  // An index signature, so a caller that reads a field by name without narrowing (the engine's
  // span and callbacks do) reads `unknown` rather than failing to compile.
  Record<string, unknown>;

/**
 * The run's result in Mastra's `WorkflowResult` shape — a port of `fmtReturnValue`
 * (`default.ts:531-649`) and of what `DefaultExecutionEngine.execute` does around it
 * (`default.ts:812-1130`), driven by the `RunReport` instead of by a `for` loop's `lastOutput`.
 *
 * Line by line:
 *
 * - **`steps`** is `{ input, ...stepResults }` in Mastra's `StepResult` shape, with
 *   `metadata.nestedRunId` stripped and an emptied `metadata` dropped (`default.ts:538-555`) — the
 *   cleaning runs over `input` too, as Mastra's loop does. `input` is `steps.input` afterwards, so
 *   a step named `input` replaces it, as in Mastra. A sleep canceled mid-wait keeps the
 *   `{ status: 'waiting', payload, startedAt }` record its wait began with, as Mastra's does
 *   (`handlers/entry.ts:602-609`).
 * - **`stepExecutionPath`** ({@link stepExecutionPath}) and the **payload deduplication** over it
 *   (`default.ts:564-606`): along the path, a step's `payload` is removed when it is `===` or
 *   `deepEqual` (Mastra's own, from `@mastra/core/utils`) to the previous *successful* output,
 *   starting from the run's input.
 * - **status**: `success` carries `result`; a bail is already `success` in the report
 *   (`default.ts:926-928`); `failed` carries `error` as `formatResultError` serializes it —
 *   `getErrorFromUnknown(error, { serializeStack: false, fallbackMessage: 'Unknown workflow error' })
 *   .toJSON()`, so `{ message, name, ...own fields, cause? }` and never a stack (`default.ts:521-529`);
 *   `tripwire` carries a `TripWire` instance flattened, or tripwire data as it is
 *   (`default.ts:611-626`), and a tripwire the kernel accepted that is neither is an ordinary
 *   `failed` carrying the outcome's `error`; `suspended` carries **every** suspended record
 *   (`default.ts:629-644`, {@link suspension}); `paused` and `canceled` carry nothing more.
 *   A suspended `.foreach()`'s record does **not** carry Mastra's foreach `__workflow_meta`
 *   (`foreachIndex`, `foreachOutput`, `resumeLabels`, `handlers/control-flow.ts:1432-1450`): the
 *   kernel's aggregate record holds no per-item results to rebuild `foreachOutput` from
 *   (`docs/divergences.md`, row 35).
 * - **`execute()`'s additions**: `runId`; `state` only when `outputOptions.includeState`;
 *   the run's `resumeLabels` only for a suspended run with `outputOptions.includeResumeLabels`
 *   (`default.ts:1023-1025`).
 */
export function formatWorkflowResult(ctx: FormatContext): FormattedResult {
  const { report } = ctx;
  const outcome = report.outcome;
  if (outcome.status === 'stranded') throw new Error(`run stranded with tokens in: ${outcome.places.join(', ')}`);

  const now = Date.now();
  const rank = firstInsertionRank(ctx.graph, report.stepResults);

  // Mastra's `stepResults`: `{ input }` first (`default.ts:805-807`), then every record.
  const raw: Record<string, unknown> = { input: ctx.input };
  for (const [id, record] of [...report.stepResults].sort(([a], [b]) => rank(a) - rank(b))) {
    raw[id] = toMastraStepResult(record, { now });
  }

  const steps = cleanStepResults(raw);
  const path = ctx.graph === undefined ? undefined : stepExecutionPath(ctx.graph.steps, outcome);
  const base = {
    steps: path === undefined ? steps : deduplicatePayloads(steps, path),
    input: steps['input'],
    ...(path === undefined ? {} : { stepExecutionPath: path }),
  };
  const extras = {
    ...(ctx.runId === undefined ? {} : { runId: ctx.runId }),
    ...(ctx.outputOptions?.includeState ? { state: ctx.state } : {}),
  };

  switch (outcome.status) {
    case 'success':
      return { ...base, status: 'success', result: outcome.output, ...extras };
    case 'failed':
      return { ...base, status: 'failed', error: formatResultError(outcome.error), ...extras };
    case 'tripwire': {
      const wire = outcome.tripwire;
      if (wire instanceof TripWire) {
        const options = wire.options as { retry?: boolean; metadata?: unknown } | undefined;
        const tripwire = { reason: wire.message, retry: options?.retry, metadata: options?.metadata, processorId: wire.processorId };
        return { ...base, status: 'tripwire', tripwire, ...extras };
      }
      if (typeof wire === 'object' && wire !== null && 'reason' in wire) return { ...base, status: 'tripwire', tripwire: wire, ...extras };
      // The kernel reads any `Error` as a tripwire; Mastra only a `TripWire`. Anything else is an
      // ordinary failure, serialized from the failure's own error as `formatResultError` reads
      // `lastOutput.error` (`default.ts:521-529,611-627`).
      return { ...base, status: 'failed', error: formatResultError(outcome.error), ...extras };
    }
    case 'suspended': {
      const { suspended, suspendPayload } = suspension(raw);
      const labels = ctx.outputOptions?.includeResumeLabels ? { resumeLabels: { ...ctx.resumeLabels } } : {};
      return { ...base, status: 'suspended', suspended, suspendPayload, ...extras, ...labels };
    }
    case 'paused':
      return { ...base, status: 'paused', ...extras };
    case 'canceled':
      return { ...base, status: 'canceled', ...extras };
    default:
      return assertNever(outcome);
  }
}

/** `formatResultError` (`default.ts:521-529`): `error || lastOutput.error`, serialized without a stack. */
export function formatResultError(error: unknown): SerializedError {
  return getErrorFromUnknown(error, { serializeStack: false, fallbackMessage: 'Unknown workflow error' }).toJSON();
}

/**
 * `cleanStepResults` (`default.ts:538-555`): `metadata.nestedRunId` removed, and `metadata` itself
 * dropped when nothing else is left. Only a non-array object that **has** a `metadata` key is
 * touched; a falsy `metadata` is left as it is.
 */
export function cleanStepResults(stepResults: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [stepId, stepResult] of Object.entries(stepResults)) {
    if (stepResult && typeof stepResult === 'object' && !Array.isArray(stepResult) && 'metadata' in stepResult) {
      const { metadata, ...rest } = stepResult as { metadata: unknown } & Record<string, unknown>;
      if (metadata) {
        const { nestedRunId: _nestedRunId, ...userMetadata } = metadata as Record<string, unknown>;
        clean[stepId] = Object.keys(userMetadata).length > 0 ? { ...rest, metadata: userMetadata } : rest;
      } else {
        clean[stepId] = stepResult;
      }
    } else {
      clean[stepId] = stepResult;
    }
  }
  return clean;
}

/**
 * The payload-deduplication pass (`default.ts:567-606`): along `path`, a copy of each step's
 * result loses `payload` when it equals the previous successful output — `===` first, then
 * Mastra's `deepEqual`, a throw counting as "not equal". The run's input is the first "previous
 * output"; only a `success` advances it. Steps off the path, and ids with no result, are left alone.
 */
export function deduplicatePayloads(
  steps: Readonly<Record<string, unknown>>,
  path: readonly string[],
): Record<string, unknown> {
  const optimized: Record<string, unknown> = { ...steps };
  let previousOutput: unknown;
  let hasPreviousOutput = 'input' in steps;
  if (hasPreviousOutput) previousOutput = steps['input'];

  for (const stepId of path) {
    const original = steps[stepId];
    if (!original) continue;
    const step = { ...(original as Record<string, unknown>) };
    let matches = false;
    if (hasPreviousOutput) {
      try {
        matches = step['payload'] === previousOutput || deepEqual(step['payload'], previousOutput);
      } catch {
        // Values that cannot be structurally compared are treated as not matching.
      }
    }
    if (matches) delete step['payload'];
    if (step['status'] === 'success') {
      previousOutput = step['output'];
      hasPreviousOutput = true;
    }
    optimized[stepId] = step;
  }
  return optimized;
}

/**
 * Mastra's `stepExecutionPath`: the ids of the **top-level** single-step entries (`step`, `agent`,
 * `tool`, `mapping`, a nested workflow) and `.sleep` / `.sleepUntil` entries, in the order they
 * **started** — `executeEntry` pushes them before running them (`handlers/entry.ts:308,587,696`).
 * Nothing inside `.parallel()`, `.branch()`, a loop or a foreach is pushed: those children run
 * through `engine.executeStep` directly (`handlers/control-flow.ts:91-105`), sharing the array but
 * never appending to it.
 *
 * Top-level entries run strictly in sequence and every entry before the one the run stopped at
 * succeeded, so the path is decided by **where the run stopped** — read from the outcome, never
 * inferred from which records exist:
 *
 * - `success`: every entry ran.
 * - a bail (`success` with `bailed: true`), `failed`, `tripwire`, `suspended`, `paused`: the entry
 *   at `path[0]` started — it produced the outcome — and nothing after it did. A `.sleep()` after
 *   a bail is therefore never on the path, as in Mastra.
 * - `canceled` with an origin: the entry at `origin.path[0]` is on the path exactly when the
 *   cancellation token says its work had **started** (`CanceledToken.started`: a sleep swept
 *   mid-wait, an outcome re-stamped by the settle stage) — and not when it was swept at its start
 *   gate, which is Mastra's loop-top abort check (`default.ts:815`). An origin deeper than the top
 *   level (`path.length > 1`) lies inside a top-level combinator, which is never pushed.
 * - `canceled` with no origin: only the settle stage after the last entry's success emits one
 *   (`compile.ts`, `settleDone`), so every entry ran.
 */
export function stepExecutionPath(
  entries: readonly StepFlowEntry[],
  outcome: Exclude<RunOutcome, { readonly status: 'stranded' }>,
): string[] {
  const upTo = (stop: number, includeStop: boolean): string[] => {
    const path: string[] = [];
    entries.forEach((entry, i) => {
      const id = pushedId(entry);
      if (id !== undefined && (i < stop || (i === stop && includeStop))) path.push(id);
    });
    return path;
  };
  const stopAt = (path: readonly number[]): number => path[0] ?? entries.length;

  switch (outcome.status) {
    case 'success':
      return outcome.bailed === true ? upTo(stopAt(outcome.path), true) : upTo(entries.length, false);
    case 'failed':
    case 'tripwire':
    case 'suspended':
    case 'paused':
      return upTo(stopAt(outcome.path), true);
    case 'canceled':
      return outcome.origin === undefined
        ? upTo(entries.length, false)
        : upTo(stopAt(outcome.origin.path), canceledStarted(outcome));
    default:
      return assertNever(outcome);
  }
}

/**
 * `CanceledToken.started`, as the canceled outcome carries it. The contract makes the flag
 * required on the token; an outcome that does not carry it is read as **not started** — the
 * absence is a kernel defect to fix there (it must copy the flag through `classify`), not
 * something to guess from records or timing here.
 */
function canceledStarted(outcome: Extract<RunOutcome, { readonly status: 'canceled' }>): boolean {
  return 'started' in outcome && outcome.started === true;
}

/** The id an entry pushes onto `stepExecutionPath`, or `undefined` for one that never pushes. */
function pushedId(entry: StepFlowEntry): string | undefined {
  switch (entry.type) {
    case 'step':
    case 'agent':
    case 'tool':
    case 'mapping':
      return entryId(entry);
    case 'sleep':
    case 'sleepUntil':
      return entry.id;
    case 'parallel':
    case 'conditional':
    case 'loop':
    case 'foreach':
      return undefined;
    default:
      return assertNever(entry);
  }
}

/**
 * `suspended` and `suspendPayload` (`default.ts:629-644`): **every** suspended result in
 * `stepResults` order, not only the one that ended the run — two `.parallel()` arms that both
 * suspend are both listed. `__workflow_meta` is stripped from each payload, and its `path`, when
 * present, extends the suspended path (a nested workflow's inner step).
 */
export function suspension(stepResults: Readonly<Record<string, unknown>>): {
  suspended: string[][];
  suspendPayload: Record<string, unknown>;
} {
  const suspendPayload: Record<string, unknown> = {};
  const suspended = Object.entries(stepResults).flatMap(([stepId, stepResult]): string[][] => {
    const result = stepResult as { status?: unknown; suspendPayload?: unknown } | null | undefined;
    if (result?.status !== 'suspended') return [];
    const { __workflow_meta, ...rest } = (result.suspendPayload ?? {}) as { __workflow_meta?: { path?: unknown } } & Record<
      string,
      unknown
    >;
    suspendPayload[stepId] = rest;
    const nestedPath = __workflow_meta?.path;
    return nestedPath ? [[stepId, ...(nestedPath as string[])]] : [[stepId]];
  });
  return { suspended, suspendPayload };
}

/**
 * Mastra's `stepResults` key order: a key is inserted when the step first **starts** — its running
 * record (`handlers/step.ts:169-178`; `.parallel()` arms all at once in declaration order,
 * `handlers/control-flow.ts:202-208`). The kernel records on completion, so its order is
 * completion order; this ranks ids by their first position in the graph instead, which is start
 * order for a fresh run. Only `suspended`'s order depends on it. An id not in the graph keeps its
 * record order, after every id that is.
 */
function firstInsertionRank(
  graph: FormatContext['graph'],
  records: ReadonlyMap<string, StepRecord>,
): (id: string) => number {
  const ranks = new Map<string, number>();
  const add = (id: string): void => {
    if (!ranks.has(id)) ranks.set(id, ranks.size);
  };
  for (const entry of graph?.steps ?? []) {
    switch (entry.type) {
      case 'step':
      case 'agent':
      case 'tool':
      case 'mapping':
        add(entryId(entry));
        break;
      case 'sleep':
      case 'sleepUntil':
        add(entry.id);
        break;
      case 'parallel':
      case 'conditional':
        for (const arm of entry.steps) add(entryId(arm));
        break;
      case 'loop':
      case 'foreach':
        add(entryId(entry.step));
        break;
      default:
        assertNever(entry);
    }
  }
  for (const id of records.keys()) add(id);
  return (id) => ranks.get(id) ?? Number.MAX_SAFE_INTEGER;
}

function assertNever(value: never): never {
  throw new Error(`unhandled variant: ${JSON.stringify(value)}`);
}

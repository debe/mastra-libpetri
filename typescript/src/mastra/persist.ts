import type {
  ExecutionEngine,
  SerializedStepFlowEntry,
  WorkflowRunState,
  WorkflowRunStatus,
} from '@mastra/core/workflows';
import { getErrorFromUnknown } from '@mastra/core/error';
import { MASTRA_AUTH_TOKEN_KEY } from '@mastra/core/request-context';
import type { RunOutcome, RunReport } from '../engine/kernel.js';
import type { FormattedResult, ResumeLabel } from './result.js';
import { toMastraStepResult } from './step-result.js';

/** What every snapshot of a run needs. */
interface PersistBase {
  readonly workflowId: string;
  readonly runId: string;
  readonly resourceId?: string;
  readonly input: unknown;
  readonly state: Record<string, unknown>;
  readonly serializedStepGraph: unknown;
  readonly requestContext: unknown;
}

/**
 * What persisting a run needs, by the moment of the run the snapshot records.
 *
 * - `start` — before the net runs: no report, no result.
 * - `terminal` — after `formatWorkflowResult`: the run's report, and the formatted result, which is
 *   the **single source** of the snapshot's `stepExecutionPath` — the default engine hands the same
 *   list to `fmtReturnValue` and to the snapshot (`default.ts:954-967`).
 *
 * There is no phase for a stranded run: it has no formatted result (`formatWorkflowResult` throws),
 * and the engine rejects it leaving the `start` row in place (`StrandedRunError`), as the default
 * engine leaves its last row when its own `execute()` throws.
 */
export type PersistContext = PersistBase &
  (
    | { readonly phase: 'start' }
    | {
        readonly phase: 'terminal';
        readonly report: RunReport;
        readonly result: FormattedResult;
        /**
         * The run's resume labels — Mastra's `executionContext.resumeLabels`, every
         * `suspend(…, { resumeLabel })` of the run (`handlers/step.ts:398-411`), as the runner
         * collects them. Omitted, the snapshot's `resumeLabels` is `{}`.
         */
        readonly resumeLabels?: Readonly<Record<string, ResumeLabel>>;
      }
  );

/**
 * Writes the run's `WorkflowRunState` to Mastra's storage — the port of
 * `DefaultExecutionEngine.persistStepUpdate` (`handlers/entry.ts:163-238`):
 *
 * 1. the predicate is the run's persistence override when one is registered, else
 *    `engine.options.shouldPersistSnapshot`, called with `{ stepResults, workflowStatus }`; a falsy
 *    answer (or no predicate at all) writes nothing (`:187-192`);
 * 2. the snapshot is built field for field as `:209-227` builds it (see {@link buildRunSnapshot});
 * 3. it goes through `mastra.getStorage().getStore('workflows').persistWorkflowSnapshot`, after
 *    `engine.options.pruneSnapshot` when one is set (`:229-235`). No registered Mastra, or a Mastra
 *    without storage, writes nothing — as the default engine's optional chain does.
 *
 * **Options are the engine's, not the workflow's.** `createWorkflow({ executionEngine })` keeps the
 * workflow's `shouldPersistSnapshot` / `pruneSnapshot` for its own `pending` row at `createRun`
 * (`workflow.ts:2771-2819`) and never hands them to a supplied engine (`:1819-1827`); the default
 * engine reads `engine.options` too, so reading them here is Mastra's contract for every engine.
 *
 * The two phases stand for the default engine's many writes (`docs/divergences.md`): `start` for the
 * first `running` write (`handlers/step.ts:216-229`), `terminal` for the `terminal` /
 * `workflow-end` / loop-top `canceled` write (`default.ts:814-835,954-967,1081-1093`).
 */
export async function persistRun(engine: ExecutionEngine, ctx: PersistContext): Promise<void> {
  const workflowStatus = statusOf(ctx);
  const stepResults = contextOf(ctx, Date.now());
  const predicate = engine.getRunPersistenceOverride(ctx.runId) ?? engine.options?.shouldPersistSnapshot;
  if (!predicate?.({ stepResults: stepResults as never, workflowStatus })) return;

  const snapshot = buildRunSnapshot(ctx);
  const workflowsStore = await engine.mastra?.getStorage()?.getStore('workflows');
  const prune = engine.options?.pruneSnapshot;
  await workflowsStore?.persistWorkflowSnapshot({
    workflowName: ctx.workflowId,
    runId: ctx.runId,
    ...(ctx.resourceId === undefined ? {} : { resourceId: ctx.resourceId }),
    snapshot: prune ? prune({ snapshot, workflowStatus }) : snapshot,
  });
}

/**
 * The `WorkflowRunState` `persistStepUpdate` would write for this moment of the run.
 *
 * - `status` — the top-level status `fmtReturnValue` reports: `bailed` is `success`, a failure
 *   carrying a tripwire is `tripwire` (`default.ts:608-628,926-928`); `running` at start.
 * - `value` — the workflow state; `context` — `{ input, ...stepResults }` in Mastra's `StepResult`
 *   shape, unformatted (the persisted record keeps `payload` and `metadata.nestedRunId`, which only
 *   the returned result strips), written as the runner recorded them: a suspension's data bare, a
 *   nested workflow's with the metadata naming the inner step (`workflow.ts:3059-3090`), and a
 *   sleep canceled mid-wait as its `waiting` record (`handlers/entry.ts:605-609`).
 * - `result` — the run's output on `success`; `error` — `getErrorFromUnknown(...).toJSON()` on
 *   `failed`, as `formatResultError` builds it (`default.ts:521-529`); both absent otherwise.
 * - `activePaths` — Mastra's `executionContext.executionPath` of the entry whose context the
 *   default engine persisted with (see {@link terminalPosition}).
 * - `stepExecutionPath` — the formatted result's, the one list both carry.
 * - `activeStepsPath` `{}` (every finished step deleted its entry, `handlers/step.ts:532`; a sleep
 *   deletes its own when the wait ends or is cut short, `handlers/entry.ts:634`), `waitingPaths`
 *   `{}`; `suspendedPaths` names the reported suspension; `resumeLabels` is the run's, as
 *   `suspend(…, { resumeLabel })` writes them to the execution context (`handlers/step.ts:398-411`).
 * - `tracingContext` — `{}` on every write made after an entry (the entry-end check or the
 *   non-success exit, `default.ts:938-966`), and **absent** on a run that ran to the end
 *   (`:1081-1093`) and on a cancel seen before the first entry (`:814-835`, no key passed). The span
 *   ids a suspension would carry are not available here.
 * - `requestContext` — serialized as `serializeRequestContext` does, without the auth token
 *   (`default.ts:657-671`).
 */
export function buildRunSnapshot(ctx: PersistContext, now: number = Date.now()): WorkflowRunState {
  const graph = graphOf(ctx.serializedStepGraph);
  const common = {
    runId: ctx.runId,
    value: { ...ctx.state } as WorkflowRunState['value'],
    context: contextOf(ctx, now) as WorkflowRunState['context'],
    serializedStepGraph: graph,
    waitingPaths: {},
    activeStepsPath: {},
    requestContext: serializeRequestContext(ctx.requestContext),
    timestamp: now,
  };

  if (ctx.phase === 'start') {
    return {
      ...common,
      status: 'running',
      activePaths: [0],
      stepExecutionPath: [],
      suspendedPaths: {},
      resumeLabels: {},
      result: undefined,
      error: undefined,
    };
  }

  const o = ctx.report.outcome;
  const { index, afterEntry } = terminalPosition(o, graph);
  const ended = {
    activePaths: [index],
    stepExecutionPath: [...(ctx.result.stepExecutionPath ?? [])],
    suspendedPaths: {},
    resumeLabels: { ...(ctx.resumeLabels ?? {}) },
    result: undefined,
    error: undefined,
    ...(afterEntry ? { tracingContext: {} } : {}),
  };
  switch (o.status) {
    case 'success':
      return { ...common, ...ended, status: 'success', result: o.output as WorkflowRunState['result'] };
    case 'failed':
      return { ...common, ...ended, status: 'failed', error: serializeError(o.error) };
    case 'tripwire':
      return { ...common, ...ended, status: 'tripwire' };
    case 'suspended':
      return { ...common, ...ended, status: 'suspended', suspendedPaths: { [o.stepId]: [...o.path] } };
    case 'paused':
      return { ...common, ...ended, status: 'paused' };
    case 'canceled':
      return { ...common, ...ended, status: 'canceled' };
    case 'stranded':
      throw strandedError(o.places);
    default:
      return assertNever(o);
  }
}

/** Where the default engine's terminal write stands: its `executionPath [index]`, and which write. */
interface TerminalPosition {
  /** The top-level index of the `executionContext` the write was made with. */
  readonly index: number;
  /**
   * Whether the write came after an entry returned — the non-success exit (`default.ts:938-966`),
   * which passes `tracingContext: {}` — rather than the run's end (`:1081-1093`) or the loop-top
   * cancel check (`:814-835`), which pass none.
   */
  readonly afterEntry: boolean;
}

/**
 * The default engine's `executionContext` at its terminal write, from the outcome alone.
 *
 * - a run that ran to the end: the last entry, no tracing context;
 * - a non-success exit (failed, tripwire, suspended, paused, a bail): the entry it came out of —
 *   the reporting step's view path cut to its top level;
 * - canceled — read from `CanceledToken.started`, which is structural (a sweep at a start gate
 *   reports work that never began, the settle stage and a sweep inside a begun construct report
 *   work that had):
 *   - **started**, or no origin (the final settle, after the last entry): Mastra's entry-end check
 *     saw the abort inside entry `i` and re-stamped it canceled (`handlers/entry.ts:815-829`); the
 *     exit then persists at `[i]` with `tracingContext {}`;
 *   - **not started**, at the gate of top-level entry `i > 0`: the entry before it, `i - 1`, ran to
 *     its end. An abort raised while it ran is seen by its entry-end check, as above, at `[i - 1]`.
 *     (One raised in the few awaits after that check reaches the loop-top check instead, which
 *     persists `lastExecutionContext` — also `[i - 1]` — with no tracing context; the net has one
 *     gate for both, see `docs/divergences.md`.)
 *   - **not started** at entry 0: the loop-top check before the first entry, with no
 *     `lastExecutionContext`: `[0]` and no tracing context (`default.ts:812-835`).
 */
function terminalPosition(o: RunOutcome, graph: readonly SerializedStepFlowEntry[]): TerminalPosition {
  switch (o.status) {
    case 'success':
      return o.bailed ? { index: topLevel(o.path), afterEntry: true } : { index: Math.max(graph.length - 1, 0), afterEntry: false };
    case 'failed':
    case 'tripwire':
    case 'suspended':
    case 'paused':
      return { index: topLevel(o.path), afterEntry: true };
    case 'canceled': {
      if (o.origin === undefined) return { index: Math.max(graph.length - 1, 0), afterEntry: true };
      const index = topLevel(o.origin.path);
      // A gate below the top level is inside a top-level entry that has begun.
      if (startedOf(o) || o.origin.path.length > 1) return { index, afterEntry: true };
      return index === 0 ? { index: 0, afterEntry: false } : { index: index - 1, afterEntry: true };
    }
    case 'stranded':
      throw strandedError(o.places);
    default:
      return assertNever(o);
  }
}

/**
 * `CanceledToken.started` as the outcome carries it — read exactly as `result.ts` reads it for
 * `stepExecutionPath`, so the snapshot's two paths never disagree. The kernel's `RunOutcome` does
 * not forward the flag yet (`classify` copies `origin` only); an outcome without it reads as **not
 * started**, a kernel defect to fix there rather than a guess from records or timing here. The `in`
 * check compiles unchanged once the field is declared.
 */
function startedOf(o: Extract<RunOutcome, { readonly status: 'canceled' }>): boolean {
  return 'started' in o && o.started === true;
}

function strandedError(places: readonly string[]): Error {
  return new Error(`cannot persist a stranded run: tokens remain in ${places.join(', ')}`);
}

function statusOf(ctx: PersistContext): WorkflowRunStatus {
  if (ctx.phase === 'start') return 'running';
  const o = ctx.report.outcome;
  switch (o.status) {
    case 'success':
    case 'failed':
    case 'tripwire':
    case 'suspended':
    case 'paused':
    case 'canceled':
      return o.status;
    case 'stranded':
      throw strandedError(o.places);
    default:
      return assertNever(o);
  }
}

/** Mastra's `stepResults`: seeded `{ input }` (`default.ts:805-807`), then every record. */
function contextOf(ctx: PersistContext, now: number): Record<string, unknown> {
  const context: Record<string, unknown> = { input: ctx.input };
  if (ctx.phase === 'terminal') {
    for (const [id, record] of ctx.report.stepResults) context[id] = toMastraStepResult(record, { now });
  }
  return context;
}

function topLevel(path: readonly number[]): number {
  return path[0] ?? 0;
}

function graphOf(value: unknown): SerializedStepFlowEntry[] {
  return Array.isArray(value) ? (value as SerializedStepFlowEntry[]) : [];
}

/** `formatResultError`: `getErrorFromUnknown(e, { serializeStack: false, … }).toJSON()`. */
function serializeError(error: unknown): WorkflowRunState['error'] {
  return getErrorFromUnknown(error, { serializeStack: false, fallbackMessage: 'Unknown workflow error' }).toJSON();
}

/** `serializeRequestContext` (`default.ts:657-671`), over whatever `execute()` was handed. */
function serializeRequestContext(requestContext: unknown): Record<string, unknown> {
  let obj: Record<string, unknown> = {};
  if (typeof requestContext === 'object' && requestContext !== null) {
    const rc = requestContext as {
      toJSON?: () => Record<string, unknown>;
      forEach?: (fn: (value: unknown, key: string) => void) => void;
    };
    if (typeof rc.toJSON === 'function') {
      obj = { ...rc.toJSON() };
    } else if (typeof rc.forEach === 'function') {
      rc.forEach((value, key) => {
        obj[key] = value;
      });
    }
  }
  delete obj[MASTRA_AUTH_TOKEN_KEY];
  return obj;
}

function assertNever(value: never): never {
  throw new Error(`unreachable: ${JSON.stringify(value)}`);
}

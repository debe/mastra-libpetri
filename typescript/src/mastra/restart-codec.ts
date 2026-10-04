import type { ExecutionEngine, StepFlowEntry } from '@mastra/core/workflows';
import { UnrestartablePositionError, type RestartRequest } from '../compiler/restart.js';
import type { StepRecord } from '../compiler/types.js';
import { entryId, type StoredStepResult } from './host.js';
import type { ResumedFrom } from './result.js';
import { fromMastraStepResult } from './step-result.js';

type ExecuteParams = Parameters<ExecutionEngine['execute']>[0];

/** A Mastra restart, decoded for the net ([ADR 0010]). */
export interface DecodedRestart {
  /** What `restartSeed` places: the stored position, the records, and entry `p`'s input. */
  readonly request: RestartRequest;
  /** `activePaths[0]`: the top-level entry the segment starts at. */
  readonly index: number;
  /** The carried-in records, for the kernel's run scope — the request's. */
  readonly records: ReadonlyMap<string, StepRecord>;
  /**
   * Mastra's `stepResults` as `Run._restart` handed them over — the stored `snapshot.context`
   * (`utils.ts:628`), `input` included, every entry verbatim and in its stored key order. A
   * `running` entry (a step in flight when the process died) has no `StepRecord`; it is kept here,
   * and only here, as the default engine's `stepResults` object keeps it (`default.ts:800-807`).
   */
  readonly context: Readonly<Record<string, unknown>>;
  /** The workflow's input: `context.input`. Mastra hands `execute()` none on a restart (`workflow.ts:4968-4983`). */
  readonly input: unknown;
  /** Mastra's stored `stepExecutionPath`, continued by this segment (`default.ts:808-809`). */
  readonly carriedPath: readonly string[];
  /** The stored workflow state — Mastra's `lastState` on a restart (`default.ts:811`). `undefined` when none was stored. */
  readonly state: Record<string, unknown> | undefined;
  /**
   * The stored `activeStepsPath` — which steps were in flight. A nested workflow step named here
   * is restarted, not started, on its first attempt (`handlers/step.ts:435-437`).
   */
  readonly activeStepsPath: Readonly<Record<string, readonly number[]>>;
}

/**
 * The only reader of Mastra's restart shape ([ADR 0010]): `restart.{activePaths, activeStepsPath,
 * stepResults, state, stepExecutionPath}` as `createRestartExecutionParams` builds it
 * (`utils.ts:577-634`). It never mutates `activePaths`, which Mastra consumes with `shift()`
 * (`default.ts:797-799`): the request holds a copy, and the caller's array is left as `Run` built it.
 *
 * Refuses, as `no-position` and before anything is persisted, an `activePaths` that is not a
 * non-empty list of non-negative integers, or whose first index is not a top-level entry of
 * `graph`. A stored step result whose status Mastra does not declare is refused by
 * `fromMastraStepResult`, naming it.
 *
 * Lives under `src/mastra/` because it reads Mastra's types ([ADR 0005]).
 */
export function decodeRestart(params: ExecuteParams, graph: { readonly steps: readonly StepFlowEntry[] }): DecodedRestart {
  const restart = params.restart;
  if (restart === undefined) throw new Error('decodeRestart: execute() was not handed a restart');

  const stored: unknown = restart.activePaths;
  if (!isPath(stored)) {
    throw new UnrestartablePositionError(
      'no-position',
      Array.isArray(stored) ? (stored.filter((n) => typeof n === 'number') as number[]) : [],
      `the run stored no position to restart from (activePaths ${JSON.stringify(stored)})`,
    );
  }
  const activePaths = [...stored];
  const index = activePaths[0]!;
  if (index >= graph.steps.length) {
    throw new UnrestartablePositionError(
      'no-position',
      activePaths,
      `activePaths [${activePaths.join(', ')}] names entry ${index}, but the workflow has ${graph.steps.length} top-level entries`,
    );
  }

  const context: Record<string, unknown> = { ...((restart.stepResults ?? {}) as Record<string, unknown>) };
  const records = new Map<string, StepRecord>();
  for (const [stepId, result] of Object.entries(context)) {
    // `input` is the workflow's input, not a step (`default.ts:805-807`).
    if (stepId === 'input') continue;
    const record = fromMastraStepResult(result as StoredStepResult);
    if (record !== undefined) records.set(stepId, record);
  }

  const activeStepsPath: Record<string, readonly number[]> = {};
  for (const [stepId, path] of Object.entries(restart.activeStepsPath ?? {})) activeStepsPath[stepId] = [...path];

  return {
    request: { activePaths, records, input: stepOutputBefore(context, graph.steps, index) },
    index,
    records,
    context,
    input: context['input'],
    carriedPath: [...(restart.stepExecutionPath ?? [])],
    state: restart.state === undefined ? undefined : { ...(restart.state as Record<string, unknown>) },
    activeStepsPath,
  };
}

/**
 * Where a restarted run picks up, as result formatting and persistence read it: the segment's
 * first entry, which re-runs from its start and pushes its id again (`restarted`), the carried
 * `stepExecutionPath`, and the stored context whole.
 */
export function restartedFrom(decoded: DecodedRestart): ResumedFrom {
  return { index: decoded.index, carriedPath: decoded.carriedPath, context: decoded.context, restarted: true };
}

/**
 * The value entry `index` takes as input on a restart: `getStepOutput(stepResults, steps[index - 1])`
 * (`default.ts:1132-1159`, called as `handlers/entry.ts:295` calls it), over the stored context.
 */
export function stepOutputBefore(stepResults: Readonly<Record<string, unknown>>, steps: readonly StepFlowEntry[], index: number): unknown {
  return getStepOutput(stepResults, index > 0 ? steps[index - 1] : undefined);
}

/**
 * A port of `DefaultExecutionEngine.getStepOutput` (`default.ts:1132-1159`), line for line:
 *
 * - no entry (index 0): the workflow's input, `stepResults.input`;
 * - a single step — `step`, `agent`, `tool`, `mapping` — or a `sleep` / `sleepUntil`: its record's
 *   `output`, `undefined` when there is no record or no output;
 * - a `.parallel()` or `.branch()`: an object with **every** arm's id, in arm order, mapped to its
 *   record's `output` — `undefined` for an arm with none (a branch arm not taken keeps its key);
 * - a loop or a foreach: its body's record's `output`.
 */
export function getStepOutput(stepResults: Readonly<Record<string, unknown>>, step: StepFlowEntry | undefined): unknown {
  if (step === undefined) return stepResults['input'];
  switch (step.type) {
    case 'step':
    case 'agent':
    case 'tool':
    case 'mapping':
      return outputOf(stepResults, entryId(step));
    case 'sleep':
    case 'sleepUntil':
      return outputOf(stepResults, step.id);
    case 'parallel':
    case 'conditional':
      return step.steps.reduce<Record<string, unknown>>((acc, arm) => {
        const id = entryId(arm);
        acc[id] = outputOf(stepResults, id);
        return acc;
      }, {});
    case 'loop':
    case 'foreach':
      return outputOf(stepResults, entryId(step.step));
    default:
      return undefined;
  }
}

/** `stepResults[id]?.output`. */
function outputOf(stepResults: Readonly<Record<string, unknown>>, id: string): unknown {
  const result = stepResults[id];
  return result === null || result === undefined ? undefined : (result as { output?: unknown }).output;
}

/** A positional path — `[top]`, `[top, arm]`, … — of non-negative integers. */
function isPath(value: unknown): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0)
  );
}

import type { ExecutionEngine } from '@mastra/core/workflows';
import { UnresumablePositionError, type ResumeRequest } from '../compiler/resume.js';
import type { CompiledWorkflow, StepRecord } from '../compiler/types.js';
import type { StoredStepResult } from './host.js';
import { fromMastraStepResult } from './step-result.js';

type ExecuteParams = Parameters<ExecutionEngine['execute']>[0];

/** What the runner needs to feed a resumed attempt. */
export interface RunnerResume {
  readonly payload: unknown;
  readonly steps: readonly string[];
  readonly label?: string;
  readonly forEachIndex?: number;
}

/** A Mastra resume, decoded for the net. */
export interface DecodedResume {
  readonly request: ResumeRequest;
  /** The carried-in records, for the kernel's run scope. */
  readonly records: ReadonlyMap<string, StepRecord>;
  /** Mastra's stored `stepExecutionPath`, continued by this segment. */
  readonly carriedPath: readonly string[];
  readonly runnerResume: RunnerResume;
  /**
   * Mastra's `stepResults` as `Run` handed them over — the stored `snapshot.context` with `input`
   * (`workflow.ts:4677-4685`), every entry verbatim and in its stored key order. Every snapshot
   * this segment writes starts from it, and the result's `steps` too, as the default engine's
   * `stepResults` object does (`default.ts:800-807`): a `running` or `skipped` entry, which has no
   * `StepRecord`, is not lost.
   */
  readonly context: Readonly<Record<string, unknown>>;
}

/**
 * The only reader of Mastra's resume shape ([ADR 0007]): `resume.{steps, stepResults,
 * resumePayload, resumePath, stepExecutionPath, forEachIndex, label}` (`default.ts:732-740`). It
 * never mutates `resumePath`, which Mastra consumes with `shift()` (`default.ts:800-802`,
 * `handlers/entry.ts:351,414`): the request holds a copy, and the caller's array is left as `Run`
 * built it.
 *
 * Refuses, before anything is persisted, a `resumePath` that names no position — `Run` reads it
 * from `snapshot.suspendedPaths[steps[0]]` (`workflow.ts:4820`), which is absent when the step was
 * never suspended and `retryCount` let the check at `:4662-4671` pass. A stored step result whose
 * status Mastra does not declare is refused by `fromMastraStepResult`, naming it.
 *
 * Lives under `src/mastra/` because it reads Mastra's types ([ADR 0005]); `src/codec/` stays
 * host-free.
 */
export function decodeResume(params: ExecuteParams, _compiled: CompiledWorkflow): DecodedResume {
  const resume = params.resume;
  if (resume === undefined) throw new Error('decodeResume: execute() was not handed a resume');

  const stored: unknown = resume.resumePath;
  if (!isPath(stored)) {
    throw new UnresumablePositionError(
      'no-site',
      [],
      `resume of step '${resume.steps[0] ?? ''}': the run stored no position for it (resumePath ${JSON.stringify(stored)})`,
    );
  }
  const path = [...stored];

  const context: Record<string, unknown> = { ...(resume.stepResults as Record<string, unknown>) };
  const records = new Map<string, StepRecord>();
  for (const [stepId, result] of Object.entries(context)) {
    // `input` is the workflow's input, not a step (`default.ts:805-807`).
    if (stepId === 'input') continue;
    const record = fromMastraStepResult(result as StoredStepResult);
    if (record !== undefined) records.set(stepId, record);
  }

  const steps = [...resume.steps];
  const forEachIndex = resume.forEachIndex;
  const label = resume.label;
  return {
    request: {
      path,
      steps,
      ...(forEachIndex === undefined ? {} : { forEachIndex }),
      records,
    },
    records,
    carriedPath: [...(resume.stepExecutionPath ?? [])],
    runnerResume: {
      payload: resume.resumePayload,
      steps,
      ...(label === undefined ? {} : { label }),
      ...(forEachIndex === undefined ? {} : { forEachIndex }),
    },
    context,
  };
}

/** A positional view path — `[top]` or `[top, arm]` — of non-negative integers. */
function isPath(value: unknown): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0)
  );
}

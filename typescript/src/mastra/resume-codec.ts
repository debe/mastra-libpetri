import type { ExecutionEngine } from '@mastra/core/workflows';
import type { ResumeRequest } from '../compiler/resume.js';
import type { CompiledWorkflow, StepRecord } from '../compiler/types.js';

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
}

/**
 * The only reader of Mastra's resume shape ([ADR 0007]): `resume.{steps, stepResults,
 * resumePayload, resumePath, stepExecutionPath, forEachIndex, label}` (`default.ts:732-740`). It
 * never mutates `resumePath`, which Mastra consumes with `shift()`.
 *
 * Lives under `src/mastra/` because it reads Mastra's types ([ADR 0005]); `src/codec/` stays
 * host-free.
 *
 * CONTRACT STUB (ADR 0007): implemented by the engine-and-snapshot area.
 */
export function decodeResume(_params: ExecuteParams, _compiled: CompiledWorkflow): DecodedResume {
  throw new Error('decodeResume: not implemented yet (M4, ADR 0007)');
}

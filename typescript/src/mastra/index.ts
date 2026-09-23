/**
 * @packageDocumentation
 * mastra — the boundary with the host.
 *
 * Mastra's graph types are mirrored structurally in `host.ts`, so this package never imports
 * `@mastra/core` at runtime, and `adapt.ts` turns a committed workflow's step flow into the
 * compiler's description. `step-result.ts` translates the engine's step records to and from
 * Mastra's `StepResult`, and gives a step Mastra's `getStepResult`. See the root README for the
 * architecture.
 */
export {
  adaptStepFlow,
  adaptExecutionGraph,
  MASTRA_BRANCH_ENTRY_TYPE,
  MASTRA_WORKFLOW_COMPONENT,
  UnsupportedWorkflowError,
} from './adapt.js';
export type { AdaptOptions } from './adapt.js';
export { entryId } from './host.js';
export { fromMastraStepResult, getStepResultView, toMastraStepResult } from './step-result.js';
export type { OutcomeStepResult, StepReference, ToMastraOptions } from './step-result.js';
export type {
  DeclarativeEntryOptions,
  ExecutionGraph,
  ForeachConcurrencyContext,
  ForeachOptions,
  SerializedCondition,
  SerializedError,
  SerializedStepFailure,
  SingleStepEntry,
  Step,
  StepBailed,
  StepCanceled,
  StepFailure,
  StepFlowEntry,
  StepMetadata,
  StepPaused,
  StepResult,
  StepRunning,
  StepSkipped,
  StepSuccess,
  StepSuspended,
  StepTripwireInfo,
  StepWaiting,
  StoredStepResult,
} from './host.js';

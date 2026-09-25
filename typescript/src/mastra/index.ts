/**
 * @packageDocumentation
 * mastra — the boundary with the host, and the only directory that imports `@mastra/core`
 * ([ADR 0005]; `tests/mastra/boundary.test.ts` enforces it).
 *
 * `init()` returns Mastra's own `createWorkflow` / `createStep`, bound to `PetriExecutionEngine`
 * and branded with `PetriEngineType`. The engine extends Mastra's `ExecutionEngine`, compiles the
 * committed step flow (`adapt.ts`) to one net, and runs every firing on Mastra's `StepExecutor`.
 * `step-result.ts` translates the engine's step records to and from Mastra's `StepResult`;
 * `resume-codec.ts` decodes the `resume` parameter `Run.resume()` hands `execute()` ([ADR 0007]).
 * See the root README for the architecture.
 */
export { init, PETRI_ENGINE_TYPE } from './init.js';
export type {
  PetriCloneStep,
  PetriCreateStep,
  PetriCreateWorkflow,
  PetriEngineType,
  PetriFactories,
  PetriInitOptions,
  PetriStep,
  PetriWorkflow,
} from './init.js';
export { PetriExecutionEngine, UnsupportedRunModeError } from './engine.js';
export type { PetriEngineOptions, UnsupportedRunMode } from './engine.js';
export {
  adaptStepFlow,
  adaptExecutionGraph,
  MASTRA_BRANCH_ENTRY_TYPE,
  MASTRA_WORKFLOW_COMPONENT,
  UnsupportedWorkflowError,
} from './adapt.js';
export type { AdaptOptions } from './adapt.js';
export { entryId, suspendTracingContext } from './host.js';
export type { TracedSpan, TracingContext } from './host.js';
export { decodeResume } from './resume-codec.js';
export type { DecodedResume, RunnerResume } from './resume-codec.js';
export type { PersistGuard } from './persist.js';
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

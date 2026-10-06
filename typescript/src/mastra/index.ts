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
 * `init()` also opens `Run.restart()` to petri runs, and `recovery.ts`'s `restartActiveRuns`
 * restarts them at boot, beside Mastra's own hook, which skips them ([ADR 0010]).
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
  PetriLimit,
  PetriPipeline,
  PetriQuorum,
  PetriRace,
  PetriRateLimit,
  PetriStep,
  PetriStepResources,
  Undoable,
  PetriWorkflow,
} from './init.js';
export { Quota } from './resources.js';
export { StepTimeoutError } from '../compiler/timeout.js';
export { CompensatorSuspendedError } from './runner.js';
export { StepPreemptedError } from '../compiler/preempt.js';
export { QuorumNotMetError } from '../compiler/blueprints/first-k.js';
export type { ArmStatus } from '../compiler/blueprints/first-k.js';
export type { DecisionEntryOptions, DecisionOptions, QuotaOptions } from './resources.js';
export type { Chained, PipelineBody, PipelineEntryOptions, PipelineOptions, PipelineStage, PipelineStages } from './pipeline.js';
export { PetriExecutionEngine, UnsupportedRunModeError } from './engine.js';
export type { PetriEngineOptions, RestartRefusalReason, UnsupportedRunMode } from './engine.js';
export { restartActiveRuns } from './recovery.js';
export type { RestartActiveRunsOptions, RestartActiveRunsReport } from './recovery.js';
export {
  adaptStepFlow,
  adaptExecutionGraph,
  BLUEPRINT_REFUSALS,
  COMPENSATE_REFUSALS,
  LAYER2_METADATA_KEYS,
  MASTRA_BRANCH_ENTRY_TYPE,
  MASTRA_WORKFLOW_COMPONENT,
  UnsupportedWorkflowError,
} from './adapt.js';
export type { AdaptOptions, BlueprintRefusal, CompensateRefusal, Layer2MetadataKey } from './adapt.js';
export { isMastraWorkflow, nestedWorkflows, verifyMastraWorkflow, workflowsIn } from './verify.js';
export type { MastraVerification, MastraVerifyOptions, VerifiableWorkflow } from './verify.js';
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

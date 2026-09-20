/**
 * @packageDocumentation
 * mastra — the boundary with the host.
 *
 * Mastra's graph types are mirrored structurally in `host.ts`, so this package never imports
 * `@mastra/core` at runtime, and `adapt.ts` turns a committed workflow's step flow into the
 * compiler's description. See the root README for the architecture.
 */
export { adaptStepFlow, adaptExecutionGraph, MASTRA_BRANCH_ENTRY_TYPE } from './adapt.js';
export type { AdaptOptions } from './adapt.js';
export { entryId } from './host.js';
export type {
  DeclarativeEntryOptions,
  ExecutionGraph,
  ForeachConcurrencyContext,
  ForeachOptions,
  SerializedCondition,
  SingleStepEntry,
  Step,
  StepFlowEntry,
} from './host.js';

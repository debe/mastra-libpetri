/**
 * mastra-libpetri — an alternative execution engine for Mastra workflows.
 *
 * A compiler turns a committed Mastra workflow's `StepFlowEntry[]` into one Coloured Time
 * Petri Net; a kernel runs that net, so the net decides what runs next. Registered through
 * Mastra's own `createWorkflow({ executionEngine })` extension point — with nothing
 * registered, Mastra runs its own engine exactly as before.
 *
 * The Mastra-facing entry is re-exported here and lives in `mastra-libpetri/mastra`:
 * `init()` returns Mastra's `createWorkflow` / `createStep` bound to `PetriExecutionEngine`.
 * `@mastra/core` is a peer dependency imported only under `src/mastra/` (ADR 0005); the
 * `compiler`, `verify`, `codec` and `conformance` subpaths never load it.
 */
export { init, PETRI_ENGINE_TYPE, PetriExecutionEngine, UnsupportedRunModeError } from './mastra/index.js';
export type {
  PetriCloneStep,
  PetriCreateStep,
  PetriCreateWorkflow,
  PetriEngineOptions,
  PetriEngineType,
  PetriFactories,
  PetriInitOptions,
  PetriStep,
  PetriWorkflow,
  UnsupportedRunMode,
} from './mastra/index.js';
export {
  assertLibpetriSurface,
  missingSurfaceMembers,
  LibpetriSurfaceError,
} from './internal/libpetri-surface.js';
export type { SurfaceProbe } from './internal/libpetri-surface.js';

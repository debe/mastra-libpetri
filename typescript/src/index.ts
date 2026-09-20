/**
 * mastra-libpetri — an alternative execution engine for Mastra workflows.
 *
 * A compiler turns a committed Mastra workflow's `StepFlowEntry[]` into one Coloured Time
 * Petri Net; a kernel runs that net, so the net decides what runs next. Registered through
 * Mastra's own `createWorkflow({ executionEngine })` extension point — with nothing
 * registered, Mastra runs its own engine exactly as before.
 */
export {
  assertLibpetriSurface,
  missingSurfaceMembers,
  LibpetriSurfaceError,
} from './internal/libpetri-surface.js';
export type { SurfaceProbe } from './internal/libpetri-surface.js';

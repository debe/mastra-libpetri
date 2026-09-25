/**
 * @packageDocumentation
 * conformance — the differential harness: a fixture run on Mastra's default engine (the oracle)
 * and on this engine, compared on engine identity (the gate: each side ran on the engine it
 * claims, nested workflows included), on data (the gate), on happens-before (the gate: no oracle
 * ordering reversed or inverted, except between steps a fixture declares independent) and
 * reported on ordering, and on the run budget (the gate: the candidate's peak steps in flight
 * never above its `concurrency`). Wall time on each engine is measured and reported.
 * Suspend-then-resume fixtures run phase by phase on every {@link ResumeRoute} — the engine that
 * suspends, the one that resumes, in one process or a fresh engine per phase — each compared with
 * the default engine's oracle by the same gates ([ADR 0007]).
 * Host-free: fixtures inject how they run and how `execute()` is observed.
 */
export {
  compareObservations,
  compareResume,
  formatDifferentialReport,
  formatResumeReport,
  formatVerdicts,
  matches,
  normalise,
  oracleRoute,
  peakInFlight,
  phaseEngine,
  routeLabel,
  runBoth,
  runResume,
  EXCLUDED_PATHS,
  RESUME_EXCLUDED_PATHS,
  RESUME_ROUTES,
  UUID,
} from './differential.js';
export type {
  Attribution,
  BudgetLabel,
  CompareOptions,
  Difference,
  DifferentialCase,
  EngineName,
  Execution,
  IndependentPair,
  Measurements,
  Observation,
  OrderingReport,
  PhaseObservation,
  ResumeCase,
  ResumeObservation,
  ResumeRoute,
  ResumeRouteLabel,
  ResumeVerdict,
  TraceEvent,
  Verdict,
  VerdictKind,
} from './differential.js';

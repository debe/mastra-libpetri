/**
 * @packageDocumentation
 * conformance — the differential harness: a fixture run on Mastra's default engine (the oracle)
 * and on this engine, compared on engine identity (the gate: each side ran on the engine it
 * claims, nested workflows included), on data (the gate), on happens-before (the gate: no oracle
 * ordering reversed or inverted, except between steps a fixture declares independent) and
 * reported on ordering, and on the run budget (the gate: the candidate's peak steps in flight
 * never above its `concurrency`). Wall time on each engine is measured and reported.
 * Host-free: fixtures inject how they run and how `execute()` is observed.
 */
export {
  compareObservations,
  formatDifferentialReport,
  formatVerdicts,
  matches,
  normalise,
  peakInFlight,
  runBoth,
  EXCLUDED_PATHS,
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
  TraceEvent,
  Verdict,
  VerdictKind,
} from './differential.js';

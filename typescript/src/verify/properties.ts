import {
  SmtVerifier,
  deadlockFree,
  terminatesAtSink,
  type SmtVerificationResult,
} from 'libpetri/verification';
import type { CompiledWorkflow } from '../compiler/types.js';

export interface VerifyOptions {
  /** Per-property budget. A query that runs out returns `unknown`, which is not a pass. */
  readonly timeoutMs?: number;
}

export interface PropertyReport {
  readonly property: string;
  readonly result: SmtVerificationResult;
}

/**
 * Proves the declared property set for a compiled workflow.
 *
 * **Both terminals are declared as sinks.** `DeadlockFree` is the strict reading — it fails on
 * a quiescent marking holding a token *outside* the declared sinks ([VER-013]). A terminal left
 * off the list therefore reads as a stranded token, so `wf.failed` is as much a sink as
 * `wf.done`: a workflow that failed did not deadlock, it finished badly.
 *
 * **`TerminatesAtSink` is the complementary claim**, not a restatement. It fails when a
 * quiescent marking has *no* declared sink marked. The two invert on a fully drained net, so
 * asserting both says "nothing is stranded" *and* "we actually reach a terminal".
 *
 * Callers must assert `proven` explicitly. `isViolated()` is false for `unknown` too, so
 * `expect(isViolated()).toBe(false)` passes on a query that timed out and the test is vacuous
 * from then on.
 */
export async function verifyWorkflow(
  compiled: CompiledWorkflow,
  options: VerifyOptions = {},
): Promise<readonly PropertyReport[]> {
  const timeout = options.timeoutMs ?? 30_000;

  const base = () =>
    SmtVerifier.forNet(compiled.net)
      .initialMarking((m) => m.tokens(compiled.entryPlace, 1))
      .sinkPlaces(compiled.donePlace, compiled.failedPlace)
      // P-invariants are what make these queries converge; without them a chain of xor
      // branches is where a proof stops landing.
      .semiflowInvariants(true)
      .timeout(timeout);

  return [
    { property: 'deadlockFree', result: await base().property(deadlockFree()).verify() },
    { property: 'terminatesAtSink', result: await base().property(terminatesAtSink()).verify() },
  ];
}

/** Formats a report for a CLI or a failed assertion: verdict, route, and the reason if unknown. */
export function describeReport(report: PropertyReport): string {
  const { verdict, route, elapsedMs } = report.result;
  const detail = verdict.type === 'unknown' ? ` (${verdict.reason})` : '';
  return `${report.property}: ${verdict.type} via ${route} in ${elapsedMs}ms${detail}`;
}

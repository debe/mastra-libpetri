import {
  SmtVerifier,
  deadlockFree,
  quiescentCount,
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
 * **Every terminal is declared as a sink.** `DeadlockFree` is the strict reading — it fails on
 * a quiescent marking holding a token *outside* the declared sinks ([VER-013]). A terminal left
 * off the list therefore reads as a stranded token, so `wf.failed`, `wf.bailed`,
 * `wf.suspended` and `wf.paused` are as much sinks as `wf.done`: a workflow that failed did not
 * deadlock, it finished badly, and a suspended one is parked by design.
 *
 * What these two properties do **not** say is which terminal a run reaches. That is the point of
 * keeping the terminals apart: a property about completion can now be stated against `wf.done`
 * alone, where it used to cover every bailed run as well.
 *
 * **`TerminatesAtSink` is the complementary claim**, not a restatement. It fails when a
 * quiescent marking has *no* declared sink marked. The two invert on a fully drained net, so
 * asserting both says "nothing is stranded" *and* "we actually reach a terminal".
 *
 * **`exactlyOneTerminal` is what the other two cannot see.** A net that reaches *two* terminals,
 * or puts two tokens in one, has every sink marked and nothing stranded, so both of the above
 * stay proven — a step writing `and(next, failed)` passes them. `quiescentCount(terminals, 1, 1)`
 * says every quiescent marking holds exactly one terminal token, which is the condition
 * `classify()` treats as correctness. It was added after a verifier weakened a join's
 * `exactly(n)` to `exactly(n - 1)` and both original proofs stayed green.
 *
 * **None of the three establishes termination.** All of them range over quiescent markings only
 * ([VER-002]); a run that cycles forever never reaches one, so it violates nothing here. A loop's
 * `iterationBound` is therefore not proven to bound anything by this set — see the loop gadget
 * for what is and is not shown.
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

  const t = compiled.terminals;
  const terminals = [t.done, t.failed, t.bailed, t.suspended, t.paused] as const;

  const base = () =>
    SmtVerifier.forNet(compiled.net)
      .initialMarking((m) => m.tokens(compiled.entryPlace, 1))
      .sinkPlaces(...terminals)
      // P-invariants are what make these queries converge; without them a chain of xor
      // branches is where a proof stops landing.
      .semiflowInvariants(true)
      .timeout(timeout);

  return [
    { property: 'deadlockFree', result: await base().property(deadlockFree()).verify() },
    { property: 'terminatesAtSink', result: await base().property(terminatesAtSink()).verify() },
    {
      property: 'exactlyOneTerminal',
      result: await base().property(quiescentCount(terminals, 1, 1)).verify(),
    },
  ];
}

/** Formats a report for a CLI or a failed assertion: verdict, route, and the reason if unknown. */
export function describeReport(report: PropertyReport): string {
  const { verdict, route, elapsedMs } = report.result;
  const detail = verdict.type === 'unknown' ? ` (${verdict.reason})` : '';
  return `${report.property}: ${verdict.type} via ${route} in ${elapsedMs}ms${detail}`;
}

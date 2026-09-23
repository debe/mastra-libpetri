import {
  SmtVerifier,
  deadlockFree,
  placeBound,
  quiescentCount,
  terminatesAtSink,
  type SmtVerificationResult,
} from 'libpetri/verification';
import type { CompiledWorkflow } from '../compiler/types.js';
import { cancelStructureViolations } from './structure.js';

/**
 * Which runs a proof covers.
 *
 * - `closed` — no cancellation ever arrives: the cancel request place starts empty.
 * - `cancel` — exactly one cancellation arrives, **at any point**: the request place is seeded,
 *   and the arrival transition may fire in every reachable marking — before the first entry,
 *   mid-step, between retries, after a terminal.
 *
 * Both are needed and neither implies the other. The arrival is enabled until it fires, so no
 * marking with a pending request is quiescent: a `cancel` proof examines only runs where the
 * cancel did arrive, and says nothing about a run that completes without one. Both segments run
 * on the same closed net, so neither is pushed off the enumeration route by the cancellation — but
 * a net with timed transitions (a retry delay, a fixed `.sleep`) or of a foreach's size still goes
 * to SMT in both, as it would with no cancellation at all.
 *
 * **A loop needs more than this.** Its allowance is deposited as several tokens into one place,
 * which the analyses model as one ([IO-016]), so a proof seeded at the entry cannot see a missing
 * budget reset on a cancel path. The loop's own tests also prove from the post-`start` marking.
 */
export type Segment = 'closed' | 'cancel';

export interface VerifyOptions {
  /** Per-property budget. A query that runs out returns `unknown`, which is not a pass. */
  readonly timeoutMs?: number;
  /**
   * The segments to prove. **Both, unless a test is deliberately splitting a slow shape across
   * budgets** — a claim about a workflow cites both, and one alone is half a proof.
   */
  readonly segments?: readonly Segment[];
  /**
   * `'skip'` omits the structural cancel check, which otherwise throws first. Only for tests that
   * demonstrate what the *proofs* cannot see on a mutant the structural check would refuse.
   */
  readonly structure?: 'check' | 'skip';
}

export interface PropertyReport {
  readonly property: string;
  readonly segment: Segment;
  readonly result: SmtVerificationResult;
}

/**
 * Proves the declared property set for a compiled workflow.
 *
 * **Every terminal is declared as a sink.** `DeadlockFree` is the strict reading — it fails on
 * a quiescent marking holding a token *outside* the declared sinks ([VER-013]). A terminal left
 * off the list therefore reads as a stranded token, so `wf.failed`, `wf.bailed`,
 * `wf.suspended`, `wf.paused` and `wf.canceled` are as much sinks as `wf.done`: a workflow that failed did not
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
 * **Structure before behaviour.** A missing inhibitor on the cancel place still drains to exactly
 * one terminal — it only starts work Mastra would not — so no property above can see it.
 * `cancelStructureViolations` checks the net's arcs for it, exactly, and runs first.
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
  const segments = options.segments ?? (['closed', 'cancel'] as const);

  if (options.structure !== 'skip') {
    const violations = cancelStructureViolations(compiled);
    if (violations.length > 0) {
      throw new Error(`cancellation structure is unsound:\n  ${violations.join('\n  ')}`);
    }
  }

  const t = compiled.terminals;
  const terminals = [t.done, t.failed, t.bailed, t.suspended, t.paused, t.canceled] as const;

  const base = (segment: Segment) =>
    SmtVerifier.forNet(compiled.net)
      .initialMarking((m) => {
        m.tokens(compiled.entryPlace, 1);
        if (segment === 'cancel') m.tokens(compiled.cancelRequest, 1);
      })
      // The cancel place is a sink: once marked it stays. That blinds `terminatesAtSink` to a
      // stranded run in the cancel segment — a marked cancel place satisfies it — which is one
      // more reason `exactlyOneTerminal` is in the set.
      .sinkPlaces(...terminals, compiled.cancel)
      // P-invariants are what make these queries converge; without them a chain of xor
      // branches is where a proof stops landing.
      .semiflowInvariants(true)
      .timeout(timeout);

  const reports: PropertyReport[] = [];
  for (const segment of segments) {
    const run = async (property: string, prop: Parameters<SmtVerifier['property']>[0]): Promise<void> => {
      reports.push({ property, segment, result: await base(segment).property(prop).verify() });
    };
    await run('deadlockFree', deadlockFree());
    await run('terminatesAtSink', terminatesAtSink());
    await run('exactlyOneTerminal', quiescentCount(terminals, 1, 1));
    // With no cancel arriving, nothing may reach `wf.canceled` — reachability, not quiescence, so
    // it sees a transient state too. It is what catches a cancel finisher that lost its read arc
    // on the signal: that net still drains to exactly one terminal, only sometimes the wrong one.
    if (segment === 'closed') await run('neverCanceled', placeBound(t.canceled, 0));
  }
  return reports;
}

/** Formats a report for a CLI or a failed assertion: segment, verdict, route, and why if unknown. */
export function describeReport(report: PropertyReport): string {
  const { verdict, route, elapsedMs } = report.result;
  const detail = verdict.type === 'unknown' ? ` (${verdict.reason})` : '';
  return `${report.segment}/${report.property}: ${verdict.type} via ${route} in ${elapsedMs}ms${detail}`;
}

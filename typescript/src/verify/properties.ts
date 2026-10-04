import {
  SmtVerifier,
  deadlockFree,
  placeBound,
  quiescentCount,
  terminatesAtSink,
  type SmtProperty,
  type SmtVerificationResult,
} from 'libpetri/verification';
import type { Place } from 'libpetri';
import type { BoundarySite, CompiledWorkflow, ResumeSite } from '../compiler/types.js';
import {
  cancelStructureViolations,
  checkpointStructureViolations,
  resumeGateViolations,
  resumeTimingViolations,
  suspensionCoverageViolations,
} from './structure.js';
import { budgetStructureViolations } from './budget.js';
import { poolSinks, poolStructureViolations } from './pools.js';
import { initialCounts } from '../engine/kernel.js';

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
 *
 * - a {@link ResumeSegment} — a resumed run ([ADR 0007]): one token at a registered resume site,
 *   with or without one cancellation arriving at any point.
 * - a {@link RestartSegment} — a restarted run ([ADR 0010]): one token at a top-level boundary,
 *   with or without one cancellation arriving at any point.
 */
export type Segment = 'closed' | 'cancel' | ResumeSegment | RestartSegment;

/**
 * A restarted run of the same net ([ADR 0010]), proven from `{boundaries[index].place: 1,
 * wf.permits: k}` plus the cancel request when `cancel` is set — one per top-level boundary, marked
 * or not. Where the marking equals a `resume@index` segment's, the verifier proves it once and cites
 * the proof under both labels. Built with {@link restartSegment}; labelled `restart@<index>`.
 */
export interface RestartSegment {
  readonly restart: number;
  readonly cancel: boolean;
}

/** A restart segment whose string form is its label. */
export function restartSegment(index: number, cancel: boolean): RestartSegment {
  const segment = { restart: index, cancel };
  Object.defineProperty(segment, 'toString', { value: () => segmentLabel(segment), enumerable: false });
  return segment;
}

/**
 * A resumed run of the same net ([ADR 0007]), proven from `{site.place: 1, wf.permits: k}` (the
 * permits when a budget is compiled in) plus one token in `wf.cancel.request` when `cancel` is set,
 * whose arrival may then land anywhere, before the gate included. That is CORE-073's route for a
 * restored marking: re-verify with it as the initial marking. It is never claimed to be reachable
 * from the fresh entry marking.
 *
 * What a resumed run starts from is checked against the same definition, {@link initialCounts}:
 * the kernel refuses a run whose marking differs per place from `resume@site`'s. A **pre-aborted**
 * resumed run starts from `{site, wf.cancel, permits}` — not the `resume@site+cancel` marking, but
 * its successor after `t.cancel.arrive` moves the request to the signal, so it is reachable from
 * the proven marking and covered by that proof.
 *
 * Build one with {@link resumeSegment}: its `toString()` is the readable label
 * (`resume@1.0`, `resume@1.0+cancel`), so `${report.segment}` reads well in a key or a log.
 */
export interface ResumeSegment {
  /** The site key: the site's path joined with `.`, as `CompiledWorkflow.resumeSites` keys it. */
  readonly resume: string;
  readonly cancel: boolean;
}

/** A resume segment whose string form is its label. The label is not an enumerable field. */
export function resumeSegment(site: string, cancel: boolean): ResumeSegment {
  const segment = { resume: site, cancel };
  Object.defineProperty(segment, 'toString', { value: () => segmentLabel(segment), enumerable: false });
  return segment;
}

/** `closed`, `cancel`, `resume@<site>[+cancel]` or `restart@<index>[+cancel]`. */
export function segmentLabel(segment: Segment): string {
  if (typeof segment === 'string') return segment;
  if ('restart' in segment) return `restart@${segment.restart}${segment.cancel ? '+cancel' : ''}`;
  return `resume@${segment.resume}${segment.cancel ? '+cancel' : ''}`;
}

/** Whether a cancellation arrives in this segment — the one the property set turns on. */
function cancels(segment: Segment): boolean {
  return typeof segment === 'string' ? segment === 'cancel' : segment.cancel;
}

/**
 * The initial marking a segment is proven from, as token counts per place: the entry place for a
 * fresh segment, the site's place for a resume segment, the cancel request when a cancellation
 * arrives, and `k` permits. **One definition with the kernel's**: both call {@link initialCounts};
 * the kernel checks every run's tokens against it, and refuses a run that differs. A run's marking
 * equals its `closed` or `resume@site` segment's; a pre-aborted run's is the successor, after
 * `t.cancel.arrive`, of its `+cancel` segment's — the signal marked instead of the request.
 *
 * Throws on a site key the workflow does not register.
 */
export function segmentInitialMarking(compiled: CompiledWorkflow, segment: Segment): ReadonlyMap<Place<unknown>, number> {
  const start =
    typeof segment === 'string' ? compiled.entryPlace
    : 'restart' in segment ? boundaryOf(compiled, segment.restart).place
    : siteOf(compiled, segment.resume).place;
  return initialCounts(compiled, start, cancels(segment) ? compiled.cancelRequest : undefined);
}

/**
 * The marking as a key that two equal markings share whatever their insertion order: `name=n`
 * pairs, sorted. Equal keys mean the two segments are the same query, so `verifyWorkflow` and
 * `verify` ask it once and cite the answer under both labels.
 */
export function markingKey(marking: ReadonlyMap<Place<unknown>, number>): string {
  return [...marking].map(([p, n]) => `${p.name}=${n}`).sort().join(',');
}

function boundaryOf(compiled: CompiledWorkflow, index: number): BoundarySite {
  const site = compiled.boundaries[index];
  if (!Number.isInteger(index) || site === undefined || site.index !== index) {
    throw new Error(`no top-level boundary ${index} in workflow '${compiled.net.name}' (boundaries: 0..${compiled.boundaries.length - 1})`);
  }
  return site;
}

function siteOf(compiled: CompiledWorkflow, key: string): ResumeSite {
  const site = compiled.resumeSites.get(key);
  if (site === undefined) {
    const known = [...compiled.resumeSites.keys()].sort(compareSiteKeys);
    throw new Error(`no resume site '${key}' in workflow '${compiled.net.name}' (sites: ${known.length > 0 ? known.join(', ') : 'none'})`);
  }
  return site;
}

/** `{place: n, …}` — the marking a claim names. */
function describeMarking(marking: ReadonlyMap<Place<unknown>, number>): string {
  return `{${[...marking].map(([p, n]) => `${p.name}: ${n}`).join(', ')}}`;
}

export interface VerifyOptions {
  /** Per-property budget. A query that runs out returns `unknown`, which is not a pass. */
  readonly timeoutMs?: number;
  /**
   * The segments to prove, exactly — when given, `resume` is not consulted. **Omit it, unless a
   * test is deliberately splitting a slow shape across budgets** — a claim about a workflow cites
   * every segment, and one alone is part of a proof.
   */
  readonly segments?: readonly Segment[];
  /**
   * Which resume sites to prove, when `segments` is omitted: each selected site adds two segments,
   * `resume@s` and `resume@s+cancel`, after `closed` and `cancel`. `'all'` (the default) is every
   * site in `compiled.resumeSites`; a list names site keys, and an unknown key throws.
   */
  readonly resume?: 'all' | 'none' | readonly string[];
  /**
   * Which top-level boundaries to prove a restart from ([ADR 0010]), when `segments` is omitted:
   * each selected boundary adds `restart@p` and `restart@p+cancel`, after the resume segments.
   * `'all'` (the default) is every boundary, marked or not — a row from Mastra's own engine may name
   * any; a list names entry indices, and an unknown one throws. A segment whose marking equals an
   * earlier one's (`restart@0` is `closed`; `restart@p` is `resume@p` at a step or loop) is still
   * listed, and cites that segment's proof.
   */
  readonly restart?: 'all' | 'none' | readonly number[];
  /**
   * `'skip'` omits the structural cancel check, which otherwise throws first. Only for tests that
   * demonstrate what the *proofs* cannot see on a mutant the structural check would refuse.
   */
  readonly structure?: 'check' | 'skip';
}

export interface PropertyReport {
  readonly property: string;
  readonly segment: Segment;
  /** The initial marking the proof started from, e.g. `{s.0.a.in: 1, wf.permits: 2}`. */
  readonly marking: string;
  readonly result: SmtVerificationResult;
  /**
   * Present when this report was not asked separately: `segment`'s initial marking equals this
   * earlier segment's, so the query is the same one, and `result` is that segment's answer to it.
   */
  readonly sameProofAs?: Segment;
}

/**
 * The segments `verifyWorkflow` proves for these options: `segments` verbatim when given, else
 * `closed`, `cancel`, then `resume@s` and `resume@s+cancel` per selected site, in site-key order,
 * then `restart@p` and `restart@p+cancel` per selected boundary, in index order.
 */
export function segmentsFor(
  compiled: CompiledWorkflow,
  options: Pick<VerifyOptions, 'segments' | 'resume' | 'restart'> = {},
): readonly Segment[] {
  if (options.segments !== undefined) return options.segments;
  const selection = options.resume ?? 'all';
  const keys =
    selection === 'all' ? [...compiled.resumeSites.keys()].sort(compareSiteKeys)
    : selection === 'none' ? []
    : selection.map((key) => siteOf(compiled, key).path.join('.'));
  const restarts = options.restart ?? 'all';
  const indices =
    restarts === 'all' ? compiled.boundaries.map((b) => b.index)
    : restarts === 'none' ? []
    : restarts.map((index) => boundaryOf(compiled, index).index);
  return [
    'closed',
    'cancel',
    ...keys.flatMap((key) => [resumeSegment(key, false), resumeSegment(key, true)]),
    ...indices.flatMap((index) => [restartSegment(index, false), restartSegment(index, true)]),
  ];
}

/** `0` < `1` < `1.0` < `1.1` < `2` < `10`: numerically, segment by segment. */
function compareSiteKeys(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i]! - y[i]!;
  }
  return x.length - y.length;
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
 * `cancelStructureViolations` checks the net's arcs for it, exactly, and runs first — with the
 * budget check and the three resume checks ([ADR 0007]): every site gated, and swept into
 * `wf.canceled` alone (`resumeGateViolations`), every suspendable step under a site
 * (`suspensionCoverageViolations`), and no timed transition enabled by a seed
 * (`resumeTimingViolations`).
 *
 * **Resume segments.** By default every registered site is proven twice, `resume@s` and
 * `resume@s+cancel`, with the same property set — `neverCanceled` only where no cancel arrives.
 * A claim about a workflow names all `2 + 2·|sites|` segments, `k`, and the route. The gates are
 * dead in the fresh segments, so a dead-transition analysis must take the union of all of them.
 *
 * **Restart segments** ([ADR 0010]). By default every top-level boundary `p` is proven twice too,
 * `restart@p` and `restart@p+cancel`, from `{in_p: 1}` plus the budget — so a claim names
 * `2 + 2·|sites| + 2·|boundaries|` segments. Where a segment's initial marking equals an earlier
 * one's — `restart@0` is `closed`, `restart@0+cancel` is `cancel`, and `restart@p` is `resume@p` at a
 * top-level step or loop, whose site is its own input place — the query is asked once and its
 * report is repeated under the later label with `sameProofAs` naming the segment that asked it.
 * The `checkpoint structure` check runs with the others, and so does `pool structure`
 * (`poolStructureViolations`, [ADR 0012]): every pool — permits, a block's slots, a quota — conserved
 * on the arcs. Every pool place is a sink, as the permits always were, and each pool other than the
 * permits adds its quiescence claim to the set: `poolReturned(<pool>)` for slots and a `limit`,
 * `demandDrained(<demand>)` for a rate quota's bucket.
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
  // Resolved first, so an unknown site key throws before anything else runs.
  const segments = segmentsFor(compiled, options);

  if (options.structure !== 'skip') {
    const checks: readonly (readonly [string, (c: CompiledWorkflow) => readonly string[]])[] = [
      ['cancellation structure', cancelStructureViolations],
      ['step budget structure', budgetStructureViolations],
      ['pool structure', poolStructureViolations],
      ['resume gate structure', resumeGateViolations],
      ['suspension coverage', suspensionCoverageViolations],
      ['resume timing structure', resumeTimingViolations],
      ['checkpoint structure', checkpointStructureViolations],
    ];
    for (const [what, check] of checks) {
      const violations = check(compiled);
      if (violations.length > 0) throw new Error(`${what} is unsound:\n  ${violations.join('\n  ')}`);
    }
  }

  const t = compiled.terminals;
  const terminals = [t.done, t.failed, t.bailed, t.suspended, t.paused, t.canceled] as const;

  const base = (marking: ReadonlyMap<Place<unknown>, number>) =>
    SmtVerifier.forNet(compiled.net)
      .initialMarking((m) => {
        for (const [p, n] of marking) m.tokens(p, n);
      })
      // The cancel place is a sink: once marked it stays. That blinds `terminatesAtSink` to a
      // stranded run in the cancel segment — a marked cancel place satisfies it — which is one
      // more reason `exactlyOneTerminal` is in the set.
      // Every pool place too ([ADR 0012]) — the permits as before, each block's slots, each quota and,
      // for a bucket, its `spent`, where the tokens rest once demand is gone ([TIME-011]).
      .sinkPlaces(...terminals, compiled.cancel, ...poolSinks(compiled))
      // P-invariants are what make these queries converge; without them a chain of xor
      // branches is where a proof stops landing.
      .semiflowInvariants(true)
      .timeout(timeout);

  // Two segments with the same initial marking are the same query: asked once, cited under both.
  const reports: PropertyReport[] = [];
  const asked = new Map<string, { readonly segment: Segment; readonly result: SmtVerificationResult }>();
  for (const segment of segments) {
    const initial = segmentInitialMarking(compiled, segment);
    const marking = describeMarking(initial);
    const key = markingKey(initial);
    for (const [property, prop] of completionProperties(compiled, segment)) {
      const earlier = asked.get(`${key}|${property}`);
      if (earlier !== undefined) {
        reports.push({ property, segment, marking, result: earlier.result, sameProofAs: earlier.segment });
        continue;
      }
      const result = await base(initial).property(prop).verify();
      asked.set(`${key}|${property}`, { segment, result });
      reports.push({ property, segment, marking, result });
    }
  }
  return reports;
}

/**
 * The completion set for one segment, in the order `verifyWorkflow` proves it — each property's
 * name and query. Exported so a caller can re-ask one query under other options.
 */
export function completionProperties(compiled: CompiledWorkflow, segment: Segment): readonly (readonly [string, SmtProperty])[] {
  const t = compiled.terminals;
  const terminals = [t.done, t.failed, t.bailed, t.suspended, t.paused, t.canceled] as const;
  const out: (readonly [string, SmtProperty])[] = [
    ['deadlockFree', deadlockFree()],
    ['terminatesAtSink', terminatesAtSink()],
    ['exactlyOneTerminal', quiescentCount(terminals, 1, 1)],
  ];
  // With no cancel arriving, nothing may reach `wf.canceled` — reachability, not quiescence, so
  // it sees a transient state too. It is what catches a cancel finisher that lost its read arc
  // on the signal: that net still drains to exactly one terminal, only sometimes the wrong one.
  // A resumed segment without a cancel is held to the same: a gate's sweep must stay dead.
  if (!cancels(segment)) out.push(['neverCanceled', placeBound(t.canceled, 0)]);
  // The step budget ([ADR 0006]): no transition ever mints a permit, and every one is back when
  // the run comes to rest — so steps in flight never exceed `k` and none is lost.
  if (compiled.budget) {
    out.push(['permitsBounded', placeBound(compiled.budget.permits, compiled.budget.k)]);
    out.push(['permitsReturned', quiescentCount([compiled.budget.permits], compiled.budget.k, compiled.budget.k)]);
  }
  // Every other pool ([ADR 0011], [ADR 0012]): all its tokens back when the run comes to rest — a
  // block's slots and a `limit`'s quota in the pool place; a bucket's split between the bucket and
  // `spent` by design, so what must be empty is its demand, which is what keeps the refill alive.
  // The permits keep their own names above. Their bounds are in the bounds family (`boundClaims`).
  for (const pool of compiled.pools) {
    if (pool.kind === 'permits') continue;
    if (pool.kind === 'bucket') out.push([`demandDrained(${pool.demand.name})`, quiescentCount([pool.demand], 0, 0)]);
    else out.push([`poolReturned(${pool.place.name})`, quiescentCount([pool.place], pool.seed, pool.seed)]);
  }
  return out;
}

/**
 * Formats a report for a CLI or a failed assertion: segment, property, verdict, route, the time,
 * why if unknown, and the initial marking — every part a claim has to name. For example
 * `resume@1.0+cancel/exactlyOneTerminal: proven via … in 12ms from {s.1.fan.resume-0: 1, …}`.
 */
export function describeReport(report: PropertyReport): string {
  const { verdict, route, elapsedMs } = report.result;
  const detail = verdict.type === 'unknown' ? ` (${verdict.reason})` : '';
  const cited = report.sameProofAs === undefined ? '' : ` (the proof of ${segmentLabel(report.sameProofAs)}, same marking)`;
  return `${segmentLabel(report.segment)}/${report.property}: ${verdict.type} via ${route} in ${elapsedMs}ms${detail} from ${report.marking}${cited}`;
}

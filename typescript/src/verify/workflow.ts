import { availableParallelism } from 'node:os';
import {
  SmtVerifier,
  Z3Unavailable,
  mutualExclusion,
  placeBound,
  unreachable,
  z3Available,
  type SmtProperty,
  type SmtVerificationResult,
} from 'libpetri/verification';
import type { Place } from 'libpetri';
import type { CompiledWorkflow } from '../compiler/types.js';
import { assertLibpetriSurface } from '../internal/libpetri-surface.js';
import {
  boundClaims,
  exclusions,
  livenessTargets,
  retryCeilingViolations,
  type UnclaimedPlace,
} from './claims.js';
import {
  completionProperties,
  describeReport,
  segmentInitialMarking,
  segmentLabel,
  segmentsFor,
  verifyWorkflow,
  type Segment,
  type VerifyOptions,
} from './properties.js';

/**
 * The four families `verify` proves ([ADR 0009]):
 *
 * - `completion` — `verifyWorkflow`'s set, the same queries: `deadlockFree` with every terminal a sink,
 *   `terminatesAtSink`, `exactlyOneTerminal`, `neverCanceled`, and the budget's two.
 * - `bounds` — `placeBound` on every place at its claimed bound (1 unless a gadget claims more).
 * - `exclusion` — `mutualExclusion` for Mastra's barrier between entries, and the gadgets' own.
 * - `liveness` — every step attempt, retries included, has a confirmed run that enables it: no
 *   dead steps, and the retry ceiling is reached, not merely bounded.
 *
 * The retry ceiling's other half — no step runs more than `retries + 1` times per arrival — is a
 * structural check on the arcs, run with the others before any query.
 */
export type Family = 'completion' | 'bounds' | 'exclusion' | 'liveness';

/** The quick phase's budget per query. Its verdict is kept only when it settles the claim. */
const QUICK_MS = 5_000;

/**
 * A completion proof that enumerated within this is a segment small enough to enumerate every
 * claim in: the quick phase is skipped there. Only speed turns on it, never a verdict.
 */
const CHEAP_ENUMERATION_MS = 250;

export const FAMILIES: readonly Family[] = ['completion', 'bounds', 'exclusion', 'liveness'];

export interface WorkflowVerifyOptions extends VerifyOptions {
  /** The families to prove. Omitted: all four. A claim about a workflow cites every one. */
  readonly families?: readonly Family[];
  /** Queries run at once. Each is a z3 process or an in-process enumeration. Default: half the cores. */
  readonly jobs?: number;
}

/**
 * One claim and what backs it.
 *
 * - `proof` — a safety property; it holds only when the verdict is `proven`. `unknown` does not
 *   hold: a timeout is not a pass.
 * - `witness` — a liveness claim; it holds only when the query that the step is dead came back
 *   `violated` **with a confirmed firing sequence** (`counterexampleConfirmed === true`), which is
 *   then the witness. A violation the replay could not confirm does not hold.
 */
export interface ClaimReport {
  readonly family: Family;
  readonly kind: 'proof' | 'witness';
  /** E.g. `deadlockFree`, `bound(s.0.a.in<=1)`, `exclusive(s.0.a.in,s.1.b.in)`, `live(t.0.a.run)`. */
  readonly property: string;
  readonly segment: Segment;
  /** The initial marking the query started from. */
  readonly marking: string;
  readonly result: SmtVerificationResult;
  readonly holds: boolean;
}

export interface VerificationReport {
  readonly workflow: string;
  /** The run budget the net was compiled with, or `unbounded`. */
  readonly k: number | 'unbounded';
  readonly structuralHash: string;
  readonly segments: readonly Segment[];
  readonly families: readonly Family[];
  readonly claims: readonly ClaimReport[];
  /** Places no bound is claimed for, each with its reason ([ADR 0009]). */
  readonly unclaimed: readonly UnclaimedPlace[];
  /** Every claim holds. */
  readonly holds: boolean;
}

/**
 * Proves every claim M6 makes about a compiled workflow ([ADR 0009]) and says which hold.
 *
 * **Structure first.** The six structural checks `verifyWorkflow` runs, plus
 * `retryCeilingViolations`, run before any query and throw on a violation — unless
 * `structure: 'skip'`, which exists for mutation tests only.
 *
 * **What each claim ranges over.** Every proof is over the untimed, value-blind model the SMT and
 * enumeration routes share ([VER-004]): a `proven` holds of every run, because the model can do
 * everything the executor can; a `witness` is a run of the model, which on a net with timed
 * transitions (a fixed sleep, a retry delay) may be one the clock rules out — the route names
 * which. Liveness is shown in the `closed` segment alone: a step that runs in a fresh run is not
 * dead, and the other segments start inside a run.
 *
 * Throws `LibpetriSurfaceError` when the installed libpetri lacks a member this calls, and
 * `Z3Unavailable` when no solver resolves: without either, proofs would be quietly absent.
 */
export async function verify(compiled: CompiledWorkflow, options: WorkflowVerifyOptions = {}): Promise<VerificationReport> {
  assertLibpetriSurface();
  // Checked up front, not inferred from a route: a small net can settle every claim structurally
  // or by enumeration, and a missing solver would then go unnoticed until the net that needs it.
  if (!z3Available()) throw new Z3Unavailable('no z3 resolves (set LIBPETRI_Z3, or put z3 on PATH): verify needs a solver');
  const families = options.families ?? FAMILIES;
  const timeout = options.timeoutMs ?? 30_000;
  const segments = segmentsFor(compiled, options);

  if (options.structure !== 'skip') {
    const violations = retryCeilingViolations(compiled);
    if (violations.length > 0) throw new Error(`retry ceiling structure is unsound:\n  ${violations.join('\n  ')}`);
  }

  const t = compiled.terminals;
  const sinks: Place<unknown>[] = [t.done, t.failed, t.bailed, t.suspended, t.paused, t.canceled, compiled.cancel, ...(compiled.budget ? [compiled.budget.permits] : [])];
  const query = (segment: Segment, property: SmtProperty, phase: 'quick' | 'full' | 'state-equation'): Promise<SmtVerificationResult> => {
    const initial = segmentInitialMarking(compiled, segment);
    const verifier = SmtVerifier.forNet(compiled.net)
      .initialMarking((m) => {
        for (const [p, n] of initial) m.tokens(p, n);
      })
      .sinkPlaces(...sinks)
      .semiflowInvariants(true)
      .property(property);
    // The quick phase skips the enumeration route, which libpetri tries first and which declines
    // only after exhausting its class budget — seconds per query on a wide net, where the linear
    // bound of [VER-015] settles most of these claims in milliseconds.
    if (phase === 'quick') return verifier.enumerationMaxClasses(0).timeout(Math.min(timeout, QUICK_MS)).verify();
    // [VER-016]'s firing counters: what closes a foreach's completion proofs at five lanes, which
    // time out without them. Opt-in in libpetri because it slows a violated query's witness search,
    // so it is asked only of a completion proof that came back `unknown`.
    if (phase === 'state-equation') return verifier.stateEquation(true).timeout(timeout).verify();
    return verifier.timeout(timeout).verify();
  };
  const settles = (kind: 'proof' | 'witness', result: SmtVerificationResult): boolean =>
    kind === 'proof' ? result.verdict.type === 'proven' : result.verdict.type === 'violated' && result.counterexampleConfirmed === true;
  /**
   * The quick phase's answer stands only when it settles the claim — a `proven`, or a confirmed
   * witness, is sound however short its budget. Anything else is asked again in full, so the
   * verdict a claim reports never depends on the quick phase's timeout, only its speed does.
   */
  const decide = async (job: { readonly kind: 'proof' | 'witness'; readonly segment: Segment; readonly smt: SmtProperty }): Promise<SmtVerificationResult> => {
    // A segment whose completion proofs enumerated cheaply has a small state space, which
    // enumeration settles faster than any solver: ask in full straight away.
    if (enumerates.has(segmentLabel(job.segment))) return query(job.segment, job.smt, 'full');
    const quick = await query(job.segment, job.smt, 'quick');
    return settles(job.kind, quick) ? quick : query(job.segment, job.smt, 'full');
  };

  const claims: ClaimReport[] = [];
  const width = options.jobs ?? Math.max(1, Math.floor(availableParallelism() / 2));
  const markings = new Map(segments.map((s) => [segmentLabel(s), describeMarking(segmentInitialMarking(compiled, s))]));
  const markingOf = (segment: Segment): string => markings.get(segmentLabel(segment)) ?? describeMarking(segmentInitialMarking(compiled, segment));
  /** Segments whose completion proofs enumerated cheaply — the route hint `decide` reads. */
  const enumerates = new Set<string>();

  // The structural checks, which the other families stand on too: `segments: []` runs them and no
  // query. Completion is then asked here rather than through `verifyWorkflow`'s sequential loop —
  // the same queries on the same verifier settings, run in the pool.
  if (options.structure !== 'skip') await verifyWorkflow(compiled, { ...options, segments: [] });
  if (families.includes('completion')) {
    const asked = segments.flatMap((segment) => completionProperties(compiled, segment).map(([property, smt]) => ({ segment, property, smt })));
    const answers = await pool(asked, width, async ({ segment, smt }) => {
      const first = await query(segment, smt, 'full');
      if (first.verdict.type !== 'unknown') return first;
      const retried = await query(segment, smt, 'state-equation');
      // A retry that settles nothing keeps the first answer: it is the one the options asked for.
      return retried.verdict.type === 'unknown' ? first : retried;
    });
    asked.forEach(({ segment, property }, i) => {
      const result = answers[i]!;
      claims.push({ family: 'completion', kind: 'proof', property, segment, marking: markingOf(segment), result, holds: result.verdict.type === 'proven' });
      // Enumeration first only where it was cheap: `parallel-wide` enumerates too, at 3 s a query,
      // and asking 5,183 claims that way took 44 min against 149 s through the quick phase.
      if (result.route === 'enumeration' && result.elapsedMs <= CHEAP_ENUMERATION_MS) enumerates.add(segmentLabel(segment));
    });
  }

  interface Job {
    readonly family: Family;
    readonly kind: 'proof' | 'witness';
    readonly property: string;
    readonly segment: Segment;
    readonly smt: SmtProperty;
  }
  const jobs: Job[] = [];
  const { claimed, unclaimed } = boundClaims(compiled);
  const exclusive = exclusions(compiled);
  for (const segment of segments) {
    if (families.includes('bounds')) {
      for (const c of claimed) jobs.push({ family: 'bounds', kind: 'proof', property: `bound(${c.place.name}<=${c.bound})`, segment, smt: placeBound(c.place, c.bound) });
    }
    if (families.includes('exclusion')) {
      for (const e of exclusive) jobs.push({ family: 'exclusion', kind: 'proof', property: `exclusive(${e.a.name},${e.b.name})`, segment, smt: mutualExclusion(e.a, e.b) });
    }
  }
  if (families.includes('liveness')) {
    for (const target of livenessTargets(compiled)) {
      jobs.push({ family: 'liveness', kind: 'witness', property: `live(${target.transition})`, segment: 'closed', smt: unreachable(target.inputs) });
    }
  }

  const results = await pool(jobs, width, decide);
  jobs.forEach((job, i) => {
    const result = results[i]!;
    const holds = settles(job.kind, result);
    claims.push({ family: job.family, kind: job.kind, property: job.property, segment: job.segment, marking: markingOf(job.segment), result, holds });
  });

  return {
    workflow: compiled.net.name,
    k: compiled.budget?.k ?? 'unbounded',
    structuralHash: compiled.structuralHash,
    segments,
    families,
    claims,
    unclaimed,
    holds: claims.every((c) => c.holds),
  };
}

/** `{place: n, …}`, as `describeReport` prints a marking. */
function describeMarking(marking: ReadonlyMap<Place<unknown>, number>): string {
  return `{${[...marking].map(([p, n]) => `${p.name}: ${n}`).join(', ')}}`;
}

/** Runs `work` over `items` with at most `width` in flight; results in item order. */
async function pool<T, R>(items: readonly T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane));
  return out;
}

/**
 * One line per claim, as `describeReport` prints a completion proof — a witness adds how many
 * firings it took. For a CLI or a failed assertion.
 */
export function describeClaim(claim: ClaimReport): string {
  const line = describeReport({ property: claim.property, segment: claim.segment, marking: claim.marking, result: claim.result });
  // A witness query asks whether the step is dead, so its `proven` is the failure: say so.
  const reading = claim.kind !== 'witness' ? ''
    : claim.holds ? ` (witness: ${claim.result.counterexampleTransitions.length} firings)`
    : claim.result.verdict.type === 'proven' ? ' (the step is proven dead)'
    : claim.result.verdict.type === 'violated' ? ' (a run was found but not confirmed)'
    : ' (no witness found)';
  return `${claim.holds ? 'holds' : 'FAILS'} ${claim.family}: ${line}${reading}`;
}

import { availableParallelism } from 'node:os';
import {
  SmtVerifier,
  StateSpaceCache,
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
  ENUMERATION_MAX_CLASSES,
  completionProperties,
  describeReport,
  markingKey,
  segmentInitialMarking,
  segmentLabel,
  segmentsFor,
  verifyWorkflow,
  type Segment,
  type VerifyOptions,
} from './properties.js';
import { poolSinks } from './pools.js';

/**
 * The four families `verify` proves ([ADR 0009]):
 *
 * - `completion` — `verifyWorkflow`'s set, the same queries: `deadlockFree` with every terminal a sink,
 *   `terminatesAtSink`, `exactlyOneTerminal`, `neverCanceled`, the budget's two, and one per other
 *   pool ([ADR 0012]): `poolReturned` for slots and a `limit`, `demandDrained` for a rate quota.
 * - `bounds` — `placeBound` on every place at its claimed bound (1 unless a gadget claims more; a
 *   pool's places at what the pool implies, `boundClaims`).
 * - `exclusion` — `mutualExclusion` for Mastra's barrier between entries, and the gadgets' own.
 * - `liveness` — every step attempt, retries included, has a confirmed run that enables it: no
 *   dead steps, and the retry ceiling is reached, not merely bounded.
 *
 * The retry ceiling's other half — no step runs more than `retries + 1` times per arrival — is a
 * structural check on the arcs, run with the others before any query.
 */
export type Family = 'completion' | 'bounds' | 'exclusion' | 'liveness';

export const FAMILIES: readonly Family[] = ['completion', 'bounds', 'exclusion', 'liveness'];

export interface WorkflowVerifyOptions extends VerifyOptions {
  /** The families to prove. Omitted: all four. A claim about a workflow cites every one. */
  readonly families?: readonly Family[];
  /** Queries run at once. Each is a z3 process or an in-process enumeration. Default: half the cores. */
  readonly jobs?: number;
  /**
   * Re-ask a proof that came back `unknown` once more assuming atomic firing
   * (`assumeAtomicFiring(true)`), and attach the answer as `assumingAtomic` ([ADR 0009], amended
   * on the libpetri 8.0.0 upgrade). It never makes a claim hold. Default: true.
   */
  readonly atomicFallback?: boolean;
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
  /**
   * Present only on a `proof` whose `result` is `unknown`: the same query under libpetri's opt-out
   * that reads every firing as one step (`assumeAtomicFiring(true)`). Since libpetri 8.0.0 the
   * verifier splits a firing whose outputs another transition tests into a start and a completion
   * ([VER-004]), as the executor runs it, and some proofs no longer close in budget on the split net.
   * A `proven` here is the weaker claim — it holds of every run in which no such firing is
   * overtaken while in flight — and never makes the claim hold.
   */
  readonly assumingAtomic?: SmtVerificationResult;
  /**
   * Present when this claim was not asked separately: its segment's initial marking equals this
   * earlier segment's, so the query is the same one and `result` (and `assumingAtomic`) is that
   * segment's answer — `restart@0` cites `closed`, `restart@p` cites `resume@p` at a step or loop
   * ([ADR 0010]). The claim is listed under both labels; it is proven once.
   */
  readonly sameProofAs?: Segment;
  /**
   * What the claim does not say, where that is easy to misread. A rate quota's bucket bound
   * ([ADR 0012]) carries one: it bounds the burst, while the rate over time is a timed property,
   * tested under a ManualClock and not proven.
   */
  readonly note?: string;
}

/** The claim is `unknown` under in-flight firing and `proven` assuming atomic firing. */
export function provenOnlyAssumingAtomic(claim: ClaimReport): boolean {
  return claim.result.verdict.type === 'unknown' && claim.assumingAtomic?.verdict.type === 'proven';
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
 * **Structure first.** The seven structural checks `verifyWorkflow` runs (the pool check among them), plus
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
 * **Segments with equal markings are asked once.** The restart segments ([ADR 0010]) repeat
 * markings already listed — `restart@0` is `closed`, `restart@0+cancel` is `cancel`, `restart@p` is
 * `resume@p` at a top-level step or loop. Each such segment's claims are the earlier segment's,
 * listed again under its own label with `sameProofAs` naming the segment that was asked.
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
  // The pools are sinks as the permits always were ([ADR 0012]): `poolSinks` lists the permits too.
  const sinks: Place<unknown>[] = [t.done, t.failed, t.bailed, t.suspended, t.paused, t.canceled, compiled.cancel, ...poolSinks(compiled)];
  // One state-space cache per call ([VER-017]): the graph depends only on the net and the initial
  // marking, so a segment's is built once and every claim on it reuses it — or, when it outgrew the
  // budget, goes straight to the solver pipeline, whose linear bound ([VER-015]) settles most claims
  // in milliseconds. Every query lists its marking from `segmentInitialMarking`, in the same order
  // and with the net's own places, which is what the cache keys on.
  const cache = new StateSpaceCache();
  const query = (segment: Segment, property: SmtProperty, phase: 'plain' | 'state-equation' | 'atomic' | 'atomic-state-equation'): Promise<SmtVerificationResult> => {
    const initial = segmentInitialMarking(compiled, segment);
    let verifier = SmtVerifier.forNet(compiled.net)
      .initialMarking((m) => {
        for (const [p, n] of initial) m.tokens(p, n);
      })
      .sinkPlaces(...sinks)
      .semiflowInvariants(true)
      .stateSpaceCache(cache)
      .enumerationMaxClasses(ENUMERATION_MAX_CLASSES)
      .timeout(timeout)
      // `timeout` bounds each z3 process; one query may start several, plus solver-free work no
      // timeout covers ([VER-013]). The total budget caps the whole query, so 30 s is the limit it
      // says, and an exhausted one names the phase it ran out in.
      .totalBudget(timeout)
      .property(property);
    // [VER-016]'s firing counters: opt-in in libpetri because they slow a violated query's witness
    // search, so asked only of a completion proof that came back `unknown`.
    if (phase === 'state-equation' || phase === 'atomic-state-equation') verifier = verifier.stateEquation(true);
    if (phase === 'atomic' || phase === 'atomic-state-equation') verifier = verifier.assumeAtomicFiring(true);
    return verifier.verify();
  };
  const settles = (kind: 'proof' | 'witness', result: SmtVerificationResult): boolean =>
    kind === 'proof' ? result.verdict.type === 'proven' : result.verdict.type === 'violated' && result.counterexampleConfirmed === true;

  const claims: ClaimReport[] = [];
  const width = options.jobs ?? Math.max(1, Math.floor(availableParallelism() / 2));
  const markings = new Map(segments.map((s) => [segmentLabel(s), describeMarking(segmentInitialMarking(compiled, s))]));
  const markingOf = (segment: Segment): string => markings.get(segmentLabel(segment)) ?? describeMarking(segmentInitialMarking(compiled, segment));
  // Segments whose initial markings are equal ask the same queries ([ADR 0010]: `restart@0` is
  // `closed`, `restart@p` is `resume@p` at a step or loop). Each later one cites the first: the query
  // is asked once and its answer listed under both labels — never dropped from the report.
  const firstWithMarking = new Map<string, Segment>();
  const citing = new Map<string, Segment>();
  for (const segment of segments) {
    const key = markingKey(segmentInitialMarking(compiled, segment));
    const first = firstWithMarking.get(key);
    if (first === undefined) firstWithMarking.set(key, segment);
    else if (segmentLabel(first) !== segmentLabel(segment)) citing.set(segmentLabel(segment), first);
  }
  const citedBy = (segment: Segment): Segment | undefined => citing.get(segmentLabel(segment));
  const asking = [...new Map(segments.filter((segment) => citedBy(segment) === undefined).map((s) => [segmentLabel(s), s])).values()];

  // The structural checks, which the other families stand on too: `segments: []` runs them and no
  // query. Completion is then asked here rather than through `verifyWorkflow`'s sequential loop —
  // the same queries on the same verifier settings, run in the pool.
  if (options.structure !== 'skip') await verifyWorkflow(compiled, { ...options, segments: [] });
  if (families.includes('completion')) {
    const asked = asking.flatMap((segment) => completionProperties(compiled, segment).map(([property, smt]) => ({ segment, property, smt })));
    const answers = await pool(asked, width, async ({ segment, smt }) => {
      const first = await query(segment, smt, 'plain');
      if (first.verdict.type !== 'unknown') return first;
      const retried = await query(segment, smt, 'state-equation');
      // A retry that settles nothing keeps the first answer: it is the one the options asked for.
      return retried.verdict.type === 'unknown' ? first : retried;
    });
    asked.forEach(({ segment, property }, i) => {
      const result = answers[i]!;
      claims.push({ family: 'completion', kind: 'proof', property, segment, marking: markingOf(segment), result, holds: result.verdict.type === 'proven' });
    });
  }

  interface Job {
    readonly family: Family;
    readonly kind: 'proof' | 'witness';
    readonly property: string;
    readonly segment: Segment;
    readonly smt: SmtProperty;
    readonly note?: string;
  }
  const jobs: Job[] = [];
  const { claimed, unclaimed } = boundClaims(compiled);
  const rateNotes = new Map(
    compiled.pools.flatMap((pool) =>
      pool.kind === 'bucket'
        ? [[pool.place.name, `bounds the burst of quota '${pool.quota}'; its rate, ${pool.seed} per ${pool.perMs} ms, is timed: tested, not proven`] as const]
        : [],
    ),
  );
  const exclusive = exclusions(compiled);
  for (const segment of asking) {
    if (families.includes('bounds')) {
      for (const c of claimed) {
        const note = rateNotes.get(c.place.name);
        jobs.push({ family: 'bounds', kind: 'proof', property: `bound(${c.place.name}<=${c.bound})`, segment, smt: placeBound(c.place, c.bound), ...(note === undefined ? {} : { note }) });
      }
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

  const results = await pool(jobs, width, (job) => query(job.segment, job.smt, 'plain'));
  jobs.forEach((job, i) => {
    const result = results[i]!;
    const holds = settles(job.kind, result);
    claims.push({ family: job.family, kind: job.kind, property: job.property, segment: job.segment, marking: markingOf(job.segment), result, holds, ...(job.note === undefined ? {} : { note: job.note }) });
  });

  // The labelled fallback: a proof the split net could not decide, asked again assuming atomic
  // firing. Attached, never counted — `holds` is already false for every one of them.
  if (options.atomicFallback !== false) {
    const undecided = claims.map((c, i) => [c, i] as const).filter(([c]) => c.kind === 'proof' && c.result.verdict.type === 'unknown');
    const smtOf = (c: ClaimReport): SmtProperty | undefined =>
      c.family === 'completion' ? completionProperties(compiled, c.segment).find(([name]) => name === c.property)?.[1]
      : jobs.find((j) => j.property === c.property && segmentLabel(j.segment) === segmentLabel(c.segment))?.smt;
    const atomic = await pool(undecided, width, async ([c]) => {
      const smt = smtOf(c);
      if (smt === undefined) return undefined;
      const first = await query(c.segment, smt, 'atomic');
      // As for completion above: a five-lane foreach's atomic `deadlockFree` closes only with
      // [VER-016] counters (346 s on libpetri 7.0.0).
      return first.verdict.type === 'unknown' ? query(c.segment, smt, 'atomic-state-equation') : first;
    });
    undecided.forEach(([c, i], n) => {
      const answer = atomic[n];
      if (answer !== undefined) claims[i] = { ...c, assumingAtomic: answer };
    });
  }

  // The cited claims: every asked claim of the segment a later one cites, repeated under the later
  // label with its own segment and marking, and the same result. The report keeps the order it had
  // before any was cited — completion by segment, then bounds and exclusion by segment, then
  // liveness — with each cited segment in its own place.
  const ofSegment = (segment: Segment, family: Family): ClaimReport[] => {
    const source = citedBy(segment);
    const label = segmentLabel(source ?? segment);
    const own = claims.filter((c) => c.family === family && segmentLabel(c.segment) === label);
    return source === undefined ? own : own.map((c) => ({ ...c, segment, marking: markingOf(segment), sameProofAs: source }));
  };
  const all: ClaimReport[] = [
    ...segments.flatMap((segment) => ofSegment(segment, 'completion')),
    ...segments.flatMap((segment) => [...ofSegment(segment, 'bounds'), ...ofSegment(segment, 'exclusion')]),
    ...claims.filter((c) => c.family === 'liveness'),
  ];

  return {
    workflow: compiled.net.name,
    k: compiled.budget?.k ?? 'unbounded',
    structuralHash: compiled.structuralHash,
    segments,
    families,
    claims: all,
    unclaimed,
    holds: all.every((c) => c.holds),
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
  const atomic = claim.assumingAtomic === undefined ? ''
    : ` [assuming atomic firing: ${claim.assumingAtomic.verdict.type} via ${claim.assumingAtomic.route} in ${claim.assumingAtomic.elapsedMs}ms]`;
  const note = claim.note === undefined ? '' : ` (${claim.note})`;
  return `${claim.holds ? 'holds' : 'FAILS'} ${claim.family}: ${line}${reading}${note}${atomic}`;
}

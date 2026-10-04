import type { Place, Transition } from 'libpetri';
import type { CompiledWorkflow } from '../compiler/types.js';

/**
 * What M6 claims about a compiled workflow beyond completion ([ADR 0009]), derived from the
 * compiled net and what its gadgets declared — never written by hand per workflow. Every function
 * here is pure over the `CompiledWorkflow`; `verify` turns each claim into a query.
 *
 * Places and transitions are compared **by name** throughout, as in `structure.ts`: libpetri place
 * identity is the name string ([CORE-010]).
 */

/** A place bound to prove: `placeBound(place, bound)` in every segment. */
export interface BoundClaim {
  readonly place: Place<unknown>;
  readonly bound: number;
  readonly why: string;
}

/** A place with no bound claimed, and why — listed in the report, never silently skipped. */
export interface UnclaimedPlace {
  readonly place: string;
  readonly why: string;
}

/** Two places never marked together: `mutualExclusion(a, b)` in every segment. */
export interface Exclusion {
  readonly a: Place<unknown>;
  readonly b: Place<unknown>;
  /** `barrier` — Mastra's `for` loop, derived from the entries; `gadget` — declared by one. */
  readonly source: 'barrier' | 'gadget';
  readonly why: string;
}

/**
 * A step attempt, or a timeout funnel ([ADR 0013]), that must be shown live: a confirmed run in which
 * every input is marked. A funnel's only input is its attempt's `timedOut_j`, so its witness is a run
 * that times attempt `j` out.
 */
export interface LivenessTarget {
  readonly transition: string;
  readonly stepId: string;
  readonly attempt: number;
  /** `attempt` — a step attempt; `timeout` — attempt `attempt`'s timeout funnel. */
  readonly kind: 'attempt' | 'timeout';
  /** The transition's input places — `unreachable` of this set is refuted by the witness. */
  readonly inputs: ReadonlySet<Place<unknown>>;
}

function placeByName(compiled: CompiledWorkflow): ReadonlyMap<string, Place<unknown>> {
  return new Map([...compiled.net.places].map((p) => [p.name, p as Place<unknown>]));
}

/**
 * Every place's bound: the gadget's claim where it made one, else 1. The permit place is left to
 * `permitsBounded`, which already proves it at `k`, so it is neither claimed here nor listed.
 * Sorted by place name, so a report reads the same on every run.
 *
 * **The pools bring their own** ([ADR 0011], [ADR 0012]), derived from `CompiledWorkflow.pools` and
 * never written by a gadget: `placeBound(pool, seed)` for a block's slots, a `limit` and a bucket,
 * and for a bucket `placeBound(spent, burst)` and `placeBound(demand, |takers|)` — one demand token
 * per using attempt waiting, and each attempt's own link holds at most one — unless a gadget claimed
 * the demand itself. A holder other than `spent` (a block's `active`) is the gadget's to claim.
 *
 * **A bucket's rate is listed, not claimed.** *At most `burst` per `perMs` window* is a timed
 * property the untimed verifier cannot state: it is tested under a ManualClock, not proven, and
 * `unclaimed` says so under the bucket's name.
 */
export function boundClaims(compiled: CompiledWorkflow): { readonly claimed: readonly BoundClaim[]; readonly unclaimed: readonly UnclaimedPlace[] } {
  const claimed: BoundClaim[] = [];
  const unclaimed: UnclaimedPlace[] = [];
  const permits = compiled.budget?.permits.name;
  const derived = poolBounds(compiled);
  for (const place of [...compiled.net.places].sort((a, b) => a.name.localeCompare(b.name))) {
    if (place.name === permits) continue;
    const pooled = derived.get(place.name);
    const claim = compiled.claims.get(place.name);
    if (pooled !== undefined && (pooled.over || claim === undefined)) claimed.push({ place, bound: pooled.bound, why: pooled.why });
    else if (claim === undefined) claimed.push({ place, bound: 1, why: 'no gadget claims more' });
    else if (claim.bound === 'unclaimed') unclaimed.push({ place: place.name, why: claim.why });
    else claimed.push({ place, bound: claim.bound, why: claim.why });
  }
  for (const pool of compiled.pools) {
    if (pool.kind !== 'bucket') continue;
    unclaimed.push({
      place: pool.place.name,
      why:
        `the rate of quota '${pool.quota}' — at most ${pool.seed} per ${pool.perMs} ms — is a timed property the untimed ` +
        'verifier cannot state: tested under a ManualClock, not proven ([ADR 0012]); the bucket\'s bound is claimed',
    });
  }
  return { claimed, unclaimed };
}

/**
 * The bounds a pool implies, by place name. `over` — the pool's claim replaces a gadget's: the pool
 * place and `spent`, which no gadget owns. A bucket's demand yields to a gadget's claim.
 */
function poolBounds(compiled: CompiledWorkflow): ReadonlyMap<string, { readonly bound: number; readonly why: string; readonly over: boolean }> {
  const out = new Map<string, { readonly bound: number; readonly why: string; readonly over: boolean }>();
  for (const pool of compiled.pools) {
    if (pool.kind === 'permits') continue;
    const what = pool.kind === 'slots' ? 'slot pool' : pool.kind === 'limit' ? `limit quota '${pool.quota}'` : `rate quota '${pool.quota}'`;
    out.set(pool.place.name, { bound: pool.seed, why: `${what} seeded ${pool.seed}, conserved with its holders`, over: true });
    if (pool.kind === 'bucket') {
      out.set(pool.spent.name, { bound: pool.seed, why: `rate quota '${pool.quota}': spent tokens, at most its burst ${pool.seed}`, over: true });
      const n = Math.max(1, new Set(pool.takers).size);
      out.set(pool.demand.name, { bound: n, why: `rate quota '${pool.quota}': one demand per waiting attempt, ${n} using attempts`, over: false });
    }
  }
  return out;
}

/**
 * The places an outcome waits in on its way out of the run: the settle places and `wf.canceled`.
 * Every one is fed only once the entry that produced it has returned, so no entry holds work
 * while one is marked.
 */
function outcomePlaces(compiled: CompiledWorkflow, byName: ReadonlyMap<string, Place<unknown>>): Place<unknown>[] {
  const settles = [...byName.values()].filter((p) => p.name.startsWith('wf.settle.'));
  return [...settles, compiled.terminals.canceled as Place<unknown>];
}

/**
 * The barrier and the gadgets' own exclusions.
 *
 * **The barrier** is Mastra's `for` loop over the step flow (`default.ts:800-900`): entry `i + 1`
 * starts only once entry `i` has returned, and a run's outcome is reported only once the entry that
 * produced it has returned. So for every top-level entry `i`, every place it owns is exclusive
 * with where its success goes (the next entry's input, or the success settle place) and with
 * every outcome place (the settle places and `wf.canceled`).
 *
 * That is enough, pairwise, for the whole claim: a place of entry `i` can only be filled by a
 * firing of entry `i` (the vocabulary names nothing else there) or by entry `i - 1`'s success, so
 * if every place of entry `i` is empty at the moment `next(i)` is marked, none is filled again
 * afterwards — the argument is written out in [ADR 0009].
 */
export function exclusions(compiled: CompiledWorkflow): readonly Exclusion[] {
  const byName = placeByName(compiled);
  const at = (name: string): Place<unknown> => {
    const place = byName.get(name);
    if (place === undefined) throw new Error(`exclusion names '${name}', which is not a place of '${compiled.net.name}'`);
    return place;
  };
  const outcomes = outcomePlaces(compiled, byName);
  const out: Exclusion[] = [];
  for (const entry of compiled.entries) {
    const next = at(entry.next);
    const boundary = [next, ...outcomes.filter((p) => p.name !== next.name)];
    for (const name of entry.interior) {
      for (const b of boundary) {
        out.push({ a: at(name), b, source: 'barrier', why: `entry ${entry.index} ('${entry.id}') has returned before ${b.name} is marked` });
      }
    }
  }
  for (const claim of compiled.exclusions) out.push({ a: at(claim.a), b: at(claim.b), source: 'gadget', why: claim.why });
  return out;
}

/**
 * Every step attempt, retries included, as a target to witness — and, for a step with a timeout
 * ([ADR 0013]), every attempt's funnel, so each `timedOut_j` is shown reachable.
 */
export function livenessTargets(compiled: CompiledWorkflow): readonly LivenessTarget[] {
  const byTransition = new Map([...compiled.net.transitions].map((t) => [t.name, t]));
  const target = (chain: CompiledWorkflow['steps'][number], name: string, attempt: number, kind: LivenessTarget['kind']): LivenessTarget => {
    const t = byTransition.get(name);
    if (t === undefined) throw new Error(`step '${chain.stepId}' names ${kind === 'attempt' ? 'attempt' : 'timeout funnel'} '${name}', which is not a transition`);
    return { transition: name, stepId: chain.stepId, attempt, kind, inputs: new Set(t.inputSpecs.map((spec) => spec.place as Place<unknown>)) };
  };
  return compiled.steps.flatMap((chain) => [
    ...chain.attempts.map((name, attempt) => target(chain, name, attempt, 'attempt')),
    ...chain.timeouts.map((name, attempt) => target(chain, name, attempt, 'timeout')),
  ]);
}

/**
 * Checks, from the arcs alone, that no step can run more than `retries + 1` times per arrival at
 * its input ([ADR 0009]) — Mastra's `for (let i = 0; i < retries + 1; i++)` (`default.ts:455`).
 *
 * Retries are unrolled, so the ceiling is the chain's topology, and what has to hold is that the
 * chain is a **simple path** nothing else enters:
 *
 * 1. **Its length.** `retries + 1` attempts and `retries` hops, every one a transition of the net,
 *    every attempt registered as a step attempt.
 * 2. **Its links.** Attempt 0 consumes the step's input; hop `j` consumes exactly one place, which
 *    attempt `j` produces into, and produces exactly one place, which attempt `j + 1` consumes.
 *    Beside its link, an attempt consumes nothing but pool places — the run's permits, a quota, a
 *    bucket's demand ([ADR 0012]). An attempt drawing on a bucket enters through a **request** — one
 *    transition, the link's only consumer, which consumes the link alone and produces the place the
 *    attempt consumes, and is its only producer — a one-for-one relay, so the path stays simple.
 * 3. **Nothing else enters it.** Only attempt `j` — or its timeout funnel — produces into hop `j`'s
 *    input, and only hop `j` into attempt `j + 1`'s link; no transition outside the chain consumes
 *    either, and no attempt or funnel produces into the step's input or into an earlier link.
 * 4. **It ends.** The final attempt, and the final funnel, produce into no link of the chain.
 * 5. **Its timeouts** ([ADR 0013]), when it has any: `retries + 1` funnels and `timedOut` places;
 *    `timedOut_j` is produced only by attempt `j`, which does produce into it, and consumed only by
 *    funnel `j`, which consumes nothing else; funnel `j` forwards into hop `j`'s input on a
 *    non-final attempt — the timeout is retried through the same delayed hop as a thrown error —
 *    and into no place of the chain on the final one.
 *
 * With that, a token that enters the input passes each attempt at most once — so `retries + 1`
 * is a ceiling on attempts per arrival, whatever the step returns, a timeout included. That the
 * ceiling is *reached* is the final attempt's liveness witness, which `verify` proves separately,
 * as it witnesses each `timedOut_j`. A loop re-enters the input once per iteration; each arrival
 * has its own ceiling, as each of Mastra's does.
 *
 * Returns one line per violation; empty means sound.
 */
export function retryCeilingViolations(compiled: CompiledWorkflow): readonly string[] {
  const out: string[] = [];
  const byName = new Map([...compiled.net.transitions].map((t) => [t.name, t]));
  const placeNames = new Set([...compiled.net.places].map((p) => p.name));
  // What an attempt may consume beside its link: every pool place and holder, and a bucket's demand.
  const pooled = new Set<string>([
    ...(compiled.budget ? [compiled.budget.permits.name] : []),
    ...compiled.pools.flatMap((pool) => [pool.place.name, ...pool.holders.map((h) => h.place), ...(pool.kind === 'bucket' ? [pool.demand.name] : [])]),
  ]);
  const attempts = new Set(compiled.stepAttempts);
  const inputs = (t: Transition): string[] => t.inputSpecs.map((spec) => spec.place.name);
  const outputs = (t: Transition): string[] => [...t.outputPlaces()].map((p) => p.name);
  const producers = (place: string): string[] => [...compiled.net.transitions].filter((t) => outputs(t).includes(place)).map((t) => t.name);
  const consumers = (place: string): string[] => [...compiled.net.transitions].filter((t) => inputs(t).includes(place)).map((t) => t.name);
  const list = (names: readonly string[]): string => `[${names.join(', ')}]`;

  for (const chain of compiled.steps) {
    const label = `step '${chain.stepId}' at ${chain.path.join('-')}`;
    if (chain.attempts.length !== chain.retries + 1) {
      out.push(`${label} declares ${chain.retries} retries and has ${chain.attempts.length} attempts; it needs ${chain.retries + 1}`);
      continue;
    }
    if (chain.hops.length !== chain.retries) {
      out.push(`${label} declares ${chain.retries} retries and has ${chain.hops.length} retry hops`);
      continue;
    }
    const timed = chain.timeouts.length > 0 || chain.timedOut.length > 0;
    if (timed && (chain.timeouts.length !== chain.retries + 1 || chain.timedOut.length !== chain.retries + 1)) {
      out.push(`${label} has ${chain.timeouts.length} timeout funnels and ${chain.timedOut.length} timedOut places; a step with a timeout needs ${chain.retries + 1} of each`);
      continue;
    }
    const missing = [...chain.attempts, ...chain.hops, ...chain.timeouts].filter((name) => !byName.has(name));
    if (missing.length > 0) {
      out.push(`${label} names ${missing.map((m) => `'${m}'`).join(', ')}, not in the net`);
      continue;
    }
    const absent = chain.timedOut.filter((name) => !placeNames.has(name));
    if (absent.length > 0) {
      out.push(`${label} names timedOut ${absent.map((m) => `'${m}'`).join(', ')}, not places of the net`);
      continue;
    }
    for (const name of chain.attempts) {
      if (!attempts.has(name)) out.push(`${label}: '${name}' is not registered as a step attempt`);
    }

    // The link each attempt consumes: the step's input, then each hop's output.
    const links: string[] = [chain.inPlace];
    const retryPlaces: string[] = [];
    chain.hops.forEach((name, j) => {
      const hop = byName.get(name)!;
      const hopIn = inputs(hop);
      const hopOut = outputs(hop);
      if (hopIn.length !== 1) out.push(`${label}: hop '${hop.name}' consumes ${hopIn.length} places; a hop consumes exactly one`);
      if (hopOut.length !== 1) out.push(`${label}: hop '${hop.name}' produces into ${hopOut.length} places; a hop produces exactly one`);
      retryPlaces[j] = hopIn[0] ?? '';
      links[j + 1] = hopOut[0] ?? '';
    });
    const chainPlaces = new Set([...links, ...retryPlaces, ...chain.timedOut]);

    // What consumes each link: attempt j itself, or the request relaying it to attempt j.
    const entries: string[] = [];
    chain.attempts.forEach((name, j) => {
      const t = byName.get(name)!;
      entries[j] = name;
      const own = inputs(t).filter((p) => !pooled.has(p));
      const relay = own.length === 1 && own[0] !== links[j] ? relayOf(own[0]!) : undefined;
      if (relay !== undefined && relay.from === links[j]) entries[j] = relay.name;
      else if (own.length !== 1 || own[0] !== links[j]) {
        out.push(`${label}: attempt ${j} ('${name}') consumes [${own.join(', ')}]; it must consume exactly '${links[j]}' (and pool places), or the one place a request relays it to`);
      }
      const produced = outputs(t);
      const back = produced.filter((p) => links.includes(p));
      if (back.length > 0) out.push(`${label}: attempt ${j} ('${name}') produces into the chain's own input [${back.join(', ')}]`);
      const retriesInto = produced.filter((p) => retryPlaces.includes(p));
      if (j < chain.retries) {
        if (!retriesInto.includes(retryPlaces[j]!)) out.push(`${label}: attempt ${j} ('${name}') never produces into its retry '${retryPlaces[j]}'`);
        if (retriesInto.some((p) => p !== retryPlaces[j])) out.push(`${label}: attempt ${j} ('${name}') produces into another attempt's retry`);
      } else if (retriesInto.length > 0) {
        out.push(`${label}: the final attempt ('${name}') produces into a retry [${retriesInto.join(', ')}]: the chain does not end`);
      }
      if (timed) {
        const timedOutInto = produced.filter((p) => chain.timedOut.includes(p));
        if (!timedOutInto.includes(chain.timedOut[j]!)) out.push(`${label}: attempt ${j} ('${name}') never produces into its timedOut '${chain.timedOut[j]}'`);
        if (timedOutInto.some((p) => p !== chain.timedOut[j])) out.push(`${label}: attempt ${j} ('${name}') produces into another attempt's timedOut`);
      }
    });

    // A request: the one producer of `place`, consuming one non-pool place and producing `place`
    // beside pool places only, with `place` consumed only by the attempt.
    function relayOf(place: string): { readonly name: string; readonly from: string } | undefined {
      const by = producers(place);
      if (by.length !== 1) return undefined;
      const r = byName.get(by[0]!)!;
      const from = inputs(r).filter((p) => !pooled.has(p));
      const to = outputs(r).filter((p) => !pooled.has(p));
      if (from.length !== 1 || to.length !== 1 || to[0] !== place || consumers(place).length !== 1) return undefined;
      return { name: r.name, from: from[0]! };
    }

    chain.timeouts.forEach((name, j) => {
      const funnel = byName.get(name)!;
      const timedOut = chain.timedOut[j]!;
      const own = inputs(funnel);
      if (own.length !== 1 || own[0] !== timedOut) out.push(`${label}: timeout funnel ${j} ('${name}') consumes ${list(own)}; it must consume exactly '${timedOut}'`);
      const into = outputs(funnel).filter((p) => chainPlaces.has(p));
      if (j < chain.retries) {
        if (into.length !== 1 || into[0] !== retryPlaces[j]) out.push(`${label}: timeout funnel ${j} ('${name}') feeds ${list(into)} of the chain; it must feed exactly its retry '${retryPlaces[j]}'`);
      } else if (into.length > 0) {
        out.push(`${label}: the final timeout funnel ('${name}') feeds ${list(into)} of the chain: the chain does not end`);
      }
      const by = producers(timedOut);
      if (by.length !== 1 || by[0] !== chain.attempts[j]) out.push(`${label}: timedOut '${timedOut}' is produced by ${list(by)}; only attempt ${j} may`);
      const from = consumers(timedOut);
      if (from.length !== 1 || from[0] !== name) out.push(`${label}: timedOut '${timedOut}' is consumed by ${list(from)}; only timeout funnel ${j} may`);
    });

    retryPlaces.forEach((place, j) => {
      const by = producers(place);
      const allowed = timed ? [chain.attempts[j]!, chain.timeouts[j]!] : [chain.attempts[j]!];
      if (!by.includes(chain.attempts[j]!) || by.some((p) => !allowed.includes(p))) {
        out.push(`${label}: retry '${place}' is produced by ${list(by)}; only attempt ${j}${timed ? ` or timeout funnel ${j}` : ''} may`);
      }
      const from = consumers(place);
      if (from.length !== 1 || from[0] !== chain.hops[j]) out.push(`${label}: retry '${place}' is consumed by [${from.join(', ')}]; only hop ${j} may`);
    });
    links.slice(1).forEach((place, i) => {
      const by = producers(place);
      if (by.length !== 1 || by[0] !== chain.hops[i]) out.push(`${label}: attempt input '${place}' is produced by [${by.join(', ')}]; only hop ${i} may`);
      const from = consumers(place);
      const entry = entries[i + 1] === chain.attempts[i + 1] ? `attempt ${i + 1}` : `attempt ${i + 1}'s request '${entries[i + 1]}'`;
      if (from.length !== 1 || from[0] !== entries[i + 1]) out.push(`${label}: attempt input '${place}' is consumed by [${from.join(', ')}]; only ${entry} may`);
    });
  }
  return out;
}

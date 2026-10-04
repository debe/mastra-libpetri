import type { Place, Transition } from 'libpetri';
import type { CompiledWorkflow } from '../compiler/types.js';
import { settledBound } from '../compiler/blueprints/first-k.js';

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
  /**
   * `barrier` — Mastra's `for` loop, derived from the entries; `gadget` — declared by one;
   * `decision` — a counted decision's `won` against its `short` ([ADR 0014]), derived from
   * `CompiledWorkflow.decisions` (the gadget's own declaration of the same pair is not repeated).
   */
  readonly source: 'barrier' | 'gadget' | 'decision';
  readonly why: string;
}

/**
 * A step attempt, or a timeout funnel ([ADR 0013]), that must be shown live: a confirmed run in which
 * every input is marked. A funnel's only input is its attempt's `timedOut_j`, so its witness is a run
 * that times attempt `j` out.
 *
 * A counted decision ([ADR 0014]) adds one kind, from `CompiledWorkflow.decisions`:
 * - `decision` — the block's `met` or its `short` (`outcome`). `met`'s inputs are a count arc
 *   (`exactly(k, okSeen)`) no place set states, so `inputs` is the transition's **output**, `{won}` or
 *   `{short}`, which nothing else produces: `unreachable({won})` refuted is `met` fired. `stepId` is
 *   the block's id and `attempt` is 0.
 *
 * An arm's `collect-preempted-i` is **not** a target: the leaf's `preempted` branch is an xor output
 * the net does not condition on the decision (the signal is host data), so the verifier can take it
 * before any decision and its liveness is vacuous — it would say nothing about losing to a decision.
 */
export interface LivenessTarget {
  readonly transition: string;
  readonly stepId: string;
  /** The attempt index; 0 for a `decision`. */
  readonly attempt: number;
  /**
   * `attempt` — a step attempt; `timeout` — attempt `attempt`'s timeout funnel; `decision` — a
   * block's `met` / `short` ([ADR 0014]).
   */
  readonly kind: 'attempt' | 'timeout' | 'decision';
  /** Which decision a `decision` target is; absent on every other kind. */
  readonly outcome?: 'met' | 'short';
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
 * **A counted decision brings its own** ([ADR 0014]), derived from `CompiledWorkflow.decisions`
 * and replacing a gadget's claim on the same place: `permit`, `won`, `short` and each arm's
 * `preempted` at 1, `okSeen` and `miss` at `n`, and `settled` at `max(n − k, k − 1)` (`settledBound`)
 * where it is emitted (`n ≥ 2`). `decisionStructureViolations` is what ties them to the arcs.
 *
 * **A bucket's rate is listed, not claimed.** *At most `burst` per `perMs` window* is a timed
 * property the untimed verifier cannot state: it is tested under a ManualClock, not proven, and
 * `unclaimed` says so under the bucket's name.
 */
export function boundClaims(compiled: CompiledWorkflow): { readonly claimed: readonly BoundClaim[]; readonly unclaimed: readonly UnclaimedPlace[] } {
  const claimed: BoundClaim[] = [];
  const unclaimed: UnclaimedPlace[] = [];
  const permits = compiled.budget?.permits.name;
  const derived = new Map([...poolBounds(compiled), ...decisionBounds(compiled)]);
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
 * The bounds a counted decision implies ([ADR 0014]), by place name, each replacing a gadget's claim.
 * After `met` the `n − k` surplus arrivals are absorbed into `settled`, after `short` the `k − 1`;
 * `met` and `short` share one permit, so at most one of the two counts applies.
 */
function decisionBounds(compiled: CompiledWorkflow): ReadonlyMap<string, { readonly bound: number; readonly why: string; readonly over: boolean }> {
  const out = new Map<string, { readonly bound: number; readonly why: string; readonly over: boolean }>();
  for (const d of compiled.decisions) {
    const block = `block '${d.blockId}' (k = ${d.k} of n = ${d.n})`;
    out.set(d.permit, { bound: 1, why: `${block}: one decision right, seeded once by the fork`, over: true });
    out.set(d.won, { bound: 1, why: `${block}: met fires at most once, on the one decision right`, over: true });
    out.set(d.short, { bound: 1, why: `${block}: short fires at most once, on the one decision right`, over: true });
    out.set(d.okSeen, { bound: d.n, why: `${block}: one arrival per arm`, over: true });
    out.set(d.miss, { bound: d.n, why: `${block}: one arrival per arm`, over: true });
    if (d.settled !== undefined) {
      const bound = settledBound({ k: d.k }, d.n);
      out.set(d.settled, { bound, why: `${block}: the surplus after met (n − k = ${d.n - d.k}) or after short (k − 1 = ${d.k - 1})`, over: true });
    }
    d.preempted.forEach((p, i) => out.set(p, { bound: 1, why: `${block}: arm ${i} leaves once`, over: true }));
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
 *
 * **A counted decision** ([ADR 0014]): `mutualExclusion(won, short)` per block, derived from
 * `CompiledWorkflow.decisions` — `met` and `short` consume the one decision right. The gadget declares
 * the same pair; it is listed once, as `decision`.
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
  const decided = new Set<string>();
  for (const d of compiled.decisions) {
    out.push({ a: at(d.won), b: at(d.short), source: 'decision', why: `block '${d.blockId}': met and short consume the one decision right` });
    decided.add(`${d.won}|${d.short}`).add(`${d.short}|${d.won}`);
  }
  for (const claim of compiled.exclusions) {
    if (decided.has(`${claim.a}|${claim.b}`)) continue;
    out.push({ a: at(claim.a), b: at(claim.b), source: 'gadget', why: claim.why });
  }
  return out;
}

/**
 * Every step attempt, retries included, as a target to witness — and, for a step with a timeout
 * ([ADR 0013]), every attempt's funnel, so each `timedOut_j` is shown reachable — then every
 * counted decision's `met` and `short` ({@link decisionTargets}, [ADR 0014]).
 */
export function livenessTargets(compiled: CompiledWorkflow): readonly LivenessTarget[] {
  const byTransition = new Map([...compiled.net.transitions].map((t) => [t.name, t]));
  const target = (chain: CompiledWorkflow['steps'][number], name: string, attempt: number, kind: LivenessTarget['kind']): LivenessTarget => {
    const t = byTransition.get(name);
    if (t === undefined) throw new Error(`step '${chain.stepId}' names ${kind === 'attempt' ? 'attempt' : 'timeout funnel'} '${name}', which is not a transition`);
    return { transition: name, stepId: chain.stepId, attempt, kind, inputs: new Set(t.inputSpecs.map((spec) => spec.place as Place<unknown>)) };
  };
  return [
    ...compiled.steps.flatMap((chain) => [
      ...chain.attempts.map((name, attempt) => target(chain, name, attempt, 'attempt')),
      ...chain.timeouts.map((name, attempt) => target(chain, name, attempt, 'timeout')),
    ]),
    ...decisionTargets(compiled),
  ];
}

/**
 * Every counted decision's liveness targets ([ADR 0014]): per block, `met` then `short` (kind
 * `decision`), for every `n` and `k` including `n = 1` — both are emitted on every block. `met` is
 * live when `k` arms can succeed together, `short` when `n − k + 1` can miss; each arm's untimed
 * abstraction can do either (a step attempt may succeed or fail), so both are claimed. A fixture
 * whose arm cannot succeed (or cannot miss) is a description the claim would rightly refute.
 * `livenessTargets` appends them; empty for a net with no decisions.
 *
 * **What witnesses them.** On an untimed net, an executor run whose stubs never take an arm's
 * `preempted` branch, nor an attempt's `paused` one, which only a nested-workflow step has
 * (`witness.ts`, `avoidingPreemption`): `short` is reached by failures, bails or suspensions, as a
 * host run of plain steps reaches it. A claim the verifier settles instead (a timed net, or no run reached it) is a
 * run of the untimed model, which may preempt an arm before any decision; `verify` says so on the
 * claim (`OVER_APPROXIMATION_NOTE`).
 *
 * **Unclaimed, with the reason:** each arm's `collect-preempted-i`. The leaf's `preempted` branch is
 * an xor output the net does not condition on the decision, so the verifier reaches it before any
 * `met` / `short` fires — a liveness proof of it would be vacuous. That an arm *is* preempted after a
 * decision is tested (`tests/engine/race.test.ts`), not proven. For `n = 1` there is no such collect.
 */
export function decisionTargets(compiled: CompiledWorkflow): readonly LivenessTarget[] {
  if (compiled.decisions.length === 0) return [];
  const byName = placeByName(compiled);
  const transitions = new Set([...compiled.net.transitions].map((t) => t.name));
  return compiled.decisions.flatMap((d) =>
    ([['met', d.met, d.won], ['short', d.shortTransition, d.short]] as const).map(([outcome, transition, decided]): LivenessTarget => {
      const output = byName.get(decided);
      if (!transitions.has(transition) || output === undefined) {
        throw new Error(`block '${d.blockId}' names ${outcome} '${transition}' -> '${decided}', which is not in the net`);
      }
      return { transition, stepId: d.blockId, attempt: 0, kind: 'decision', outcome, inputs: new Set([output]) };
    }),
  );
}

/** A transition whose liveness is not claimed, and why — listed, never silently skipped. */
export interface UnclaimedTarget {
  readonly transition: string;
  readonly why: string;
}

/**
 * The liveness targets deliberately not claimed ([ADR 0014]): each arm's `collect-preempted-i`, arm
 * order, block by block. The reason is the one in {@link decisionTargets}: the `preempted` branch is
 * not conditioned on the decision in the arcs, so a witness could take it before any `met` / `short`
 * and would say nothing about losing to a decision. Empty for a net with no decisions, and for a
 * block of one arm (no preempted collect).
 */
export function unclaimedTargets(compiled: CompiledWorkflow): readonly UnclaimedTarget[] {
  return compiled.decisions.flatMap((d) =>
    d.collectPreempted.map((transition, i) => ({
      transition,
      why:
        `block '${d.blockId}', arm ${i}: the preempted branch is an xor output the net does not condition on the decision, ` +
        'so its liveness would be witnessed before any decision and say nothing about losing one; that a loser is ' +
        'preempted after a decision is tested, not proven ([ADR 0014])',
    })),
  );
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

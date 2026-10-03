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

/** A step attempt that must be shown live: a confirmed run in which every input is marked. */
export interface LivenessTarget {
  readonly transition: string;
  readonly stepId: string;
  readonly attempt: number;
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
 */
export function boundClaims(compiled: CompiledWorkflow): { readonly claimed: readonly BoundClaim[]; readonly unclaimed: readonly UnclaimedPlace[] } {
  const claimed: BoundClaim[] = [];
  const unclaimed: UnclaimedPlace[] = [];
  const permits = compiled.budget?.permits.name;
  for (const place of [...compiled.net.places].sort((a, b) => a.name.localeCompare(b.name))) {
    if (place.name === permits) continue;
    const claim = compiled.claims.get(place.name);
    if (claim === undefined) claimed.push({ place, bound: 1, why: 'no gadget claims more' });
    else if (claim.bound === 'unclaimed') unclaimed.push({ place: place.name, why: claim.why });
    else claimed.push({ place, bound: claim.bound, why: claim.why });
  }
  return { claimed, unclaimed };
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

/** Every step attempt, retries included, as a target to witness. */
export function livenessTargets(compiled: CompiledWorkflow): readonly LivenessTarget[] {
  const byTransition = new Map([...compiled.net.transitions].map((t) => [t.name, t]));
  return compiled.steps.flatMap((chain) =>
    chain.attempts.map((name, attempt) => {
      const t = byTransition.get(name);
      if (t === undefined) throw new Error(`step '${chain.stepId}' names attempt '${name}', which is not a transition`);
      return { transition: name, stepId: chain.stepId, attempt, inputs: new Set(t.inputSpecs.map((spec) => spec.place as Place<unknown>)) };
    }),
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
 *    Beside its link, an attempt consumes nothing but the run's permits.
 * 3. **Nothing else enters it.** Only attempt `j` produces into hop `j`'s input, and only hop `j`
 *    into attempt `j + 1`'s; no transition outside the chain consumes either, and no attempt
 *    produces into the step's input or into an earlier link.
 * 4. **It ends.** The final attempt produces into no link of the chain.
 *
 * With that, a token that enters the input passes each attempt at most once — so `retries + 1`
 * is a ceiling on attempts per arrival, whatever the step returns. That the ceiling is *reached*
 * is the final attempt's liveness witness, which `verify` proves separately. A loop re-enters the
 * input once per iteration; each arrival has its own ceiling, as each of Mastra's does.
 *
 * Returns one line per violation; empty means sound.
 */
export function retryCeilingViolations(compiled: CompiledWorkflow): readonly string[] {
  const out: string[] = [];
  const byName = new Map([...compiled.net.transitions].map((t) => [t.name, t]));
  const permits = compiled.budget?.permits.name;
  const attempts = new Set(compiled.stepAttempts);
  const inputs = (t: Transition): string[] => t.inputSpecs.map((spec) => spec.place.name);
  const outputs = (t: Transition): string[] => [...t.outputPlaces()].map((p) => p.name);
  const producers = (place: string): string[] => [...compiled.net.transitions].filter((t) => outputs(t).includes(place)).map((t) => t.name);
  const consumers = (place: string): string[] => [...compiled.net.transitions].filter((t) => inputs(t).includes(place)).map((t) => t.name);

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
    const missing = [...chain.attempts, ...chain.hops].filter((name) => !byName.has(name));
    if (missing.length > 0) {
      out.push(`${label} names ${missing.map((m) => `'${m}'`).join(', ')}, not in the net`);
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

    chain.attempts.forEach((name, j) => {
      const t = byName.get(name)!;
      const own = inputs(t).filter((p) => p !== permits);
      if (own.length !== 1 || own[0] !== links[j]) {
        out.push(`${label}: attempt ${j} ('${name}') consumes [${own.join(', ')}]; it must consume exactly '${links[j]}' (and a permit)`);
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
    });

    retryPlaces.forEach((place, j) => {
      const by = producers(place);
      if (by.length !== 1 || by[0] !== chain.attempts[j]) out.push(`${label}: retry '${place}' is produced by [${by.join(', ')}]; only attempt ${j} may`);
      const from = consumers(place);
      if (from.length !== 1 || from[0] !== chain.hops[j]) out.push(`${label}: retry '${place}' is consumed by [${from.join(', ')}]; only hop ${j} may`);
    });
    links.slice(1).forEach((place, i) => {
      const by = producers(place);
      if (by.length !== 1 || by[0] !== chain.hops[i]) out.push(`${label}: attempt input '${place}' is produced by [${by.join(', ')}]; only hop ${i} may`);
      const from = consumers(place);
      if (from.length !== 1 || from[0] !== chain.attempts[i + 1]) out.push(`${label}: attempt input '${place}' is consumed by [${from.join(', ')}]; only attempt ${i + 1} may`);
    });
  }
  return out;
}


import type { SmtProperty, SmtVerificationResult } from 'libpetri/verification';
import { requiredCount, type PetriNet, type Place, type Transition } from 'libpetri';

/**
 * A structural discharge by an **initially empty siphon** — an argument over the real net and the
 * segment's initial marking, never a second net ([ADR 0009]; CLAUDE.md, "one net").
 *
 * **The argument.** Let `S` be a set of places, all unmarked initially, such that every transition
 * that can put a token into `S` also *requires* a token in `S` to be enabled — by an input arc (every
 * `In` kind needs at least one token: `one`, `exactly(n ≥ 1)`, `all`, `atLeast(n ≥ 1)`) or by a read
 * arc. Then no firing is ever the first to mark `S`: before it, `S` is empty, so the firing is not
 * enabled. By induction over any firing sequence `S` stays empty in every reachable marking, and
 * every transition with an input or read arc on `S` is **dead** — never enabled.
 *
 * {@link emptySiphon} computes the largest such `S` inside the unmarked places, the classic way: start
 * from every unmarked place, and while a transition produces into the candidate set without requiring
 * any place of it, drop its outputs from the set. The fixpoint is the union of all such siphons.
 *
 * **What does not weaken it**, each because deadness is "never enabled", and enablement needs the
 * tokens:
 * - **Inhibitor arcs** are never a requirement — an inhibitor on an empty place is *satisfied*, so a
 *   producer that only inhibits on `S` is not dead and its outputs leave the set.
 * - **Reset arcs** only remove tokens; they produce nothing.
 * - **Timing** constrains *when* an enabled transition fires, never whether a disabled one may.
 * - **The in-flight split of [VER-004]**: a firing's completion follows its own start, and the start
 *   needs the transition's inputs and reads as before.
 * - **Xor outputs and action timeouts**: every place any branch may write is counted as an output
 *   (`Transition.outputPlaces()` collects xor branches, `forwardInput` targets and timeout branches).
 *
 * **What it assumes.** The net is closed: no environment place feeds `S` from outside. That is the
 * model every `verify` and `verifyWorkflow` query is asked in — no environment places are declared on
 * the verifier — so a discharge here is a claim about the same model a solver proof would be.
 *
 * Places are compared by **name**, as the structural checks do (`structure.ts`): `place()` does not
 * intern, so a same-named place built elsewhere is the same place to the executor.
 */
export interface EmptySiphon {
  /** The places of the maximal initially empty siphon, sorted by name. Empty when there is none. */
  readonly places: readonly string[];
  /** The transitions that need a place of {@link places} — by input or read arc — so never fire. */
  readonly dead: readonly string[];
}

// An input arc requires its place only when it needs at least one token there (`requiredCount`); every
// `In` kind does today, and one that did not would simply not count.
const requires = (t: Transition): string[] => [
  ...t.inputSpecs.filter((i) => requiredCount(i) >= 1).map((i) => i.place.name),
  ...t.reads.map((r) => r.place.name),
];
const produces = (t: Transition): string[] => [...t.outputPlaces()].map((p) => p.name);

/**
 * The maximal siphon of `net` contained in the places `marking` leaves empty, and the transitions it
 * kills. `marking` maps a place to its initial token count; a place absent from it, or at 0, is unmarked.
 */
export function emptySiphon(net: PetriNet, marking: ReadonlyMap<Place<unknown>, number>): EmptySiphon {
  const transitions = [...net.transitions];
  const marked = new Set([...marking].filter(([, n]) => n > 0).map(([p]) => p.name));
  const all = new Set<string>([...net.places].map((p) => p.name));
  // A place an arc names but the net does not list is still a place of the run.
  for (const t of transitions) for (const name of [...requires(t), ...produces(t)]) all.add(name);
  const siphon = new Set([...all].filter((name) => !marked.has(name)));

  let changed = true;
  while (changed) {
    changed = false;
    for (const t of transitions) {
      const into = produces(t).filter((p) => siphon.has(p));
      if (into.length === 0 || requires(t).some((p) => siphon.has(p))) continue;
      for (const p of into) siphon.delete(p);
      changed = true;
    }
  }
  const dead = transitions.filter((t) => requires(t).some((p) => siphon.has(p))).map((t) => t.name);
  return { places: [...siphon].sort(), dead: dead.sort() };
}

/**
 * The property answered from the siphon alone, or `undefined` when the siphon does not settle it.
 *
 * Settled, each because a place of the initially empty siphon holds no token in any reachable marking:
 * - `placeBound(p, n)`, any `n >= 0`, with `p` in the siphon — bounded by every bound, `0` included.
 *   This is `neverCanceled` (`placeBound(wf.canceled, 0)`) in every segment no cancel arrives in, where
 *   `wf.cancel.request` and `wf.cancel` start empty and nothing else produces into them.
 * - `mutualExclusion(p1, p2)` with **either** place in the siphon — the violation needs both marked at
 *   once, and one never is: the exclusion claims (`exclusions` in `claims.ts`) pairing an entry's
 *   interior with `wf.canceled` where no cancel arrives.
 *
 * Every other property shape, and every pair or bound outside the siphon, is left to the verifier:
 * `undefined`. The result is `proven` on the `structural` route, with the siphon named in the report —
 * the same shape a solver proof has, so a claim built on it says its property, marking and route as
 * any other. `elapsedMs` is whole milliseconds ({@link wholeMs}).
 */
export function dischargeBySiphon(
  net: PetriNet,
  marking: ReadonlyMap<Place<unknown>, number>,
  property: SmtProperty,
  siphon: EmptySiphon = emptySiphon(net, marking),
): SmtVerificationResult | undefined {
  const started = performance.now();
  const inSiphon = (p: Place<unknown>): boolean => siphon.places.includes(p.name);
  let claim: string;
  let empty: string;
  if (property.type === 'place-bound') {
    if (property.bound < 0 || !inSiphon(property.place)) return undefined;
    claim = `'${property.place.name}' <= ${property.bound}`;
    empty = property.place.name;
  } else if (property.type === 'mutual-exclusion') {
    const held = [property.p1, property.p2].find(inSiphon);
    if (held === undefined) return undefined;
    claim = `'${property.p1.name}' and '${property.p2.name}' never both marked`;
    empty = held.name;
  } else {
    return undefined;
  }
  const named = `{${siphon.places.join(', ')}}`;
  const report =
    `${claim} PROVEN structurally: '${empty}' lies in the initially empty siphon ${named} — every transition ` +
    `producing into it requires a token in it (input or read arc), so it stays empty in every reachable marking; ` +
    `${siphon.dead.length} transition(s) dead: ${siphon.dead.join(', ')}`;
  return {
    verdict: { type: 'proven', method: 'initially empty siphon', inductiveInvariant: `0 = ${siphon.places.map((p) => `M(${p})`).join(' + ')}` },
    route: 'structural',
    report,
    invariants: [],
    discoveredInvariants: [],
    counterexampleTrace: [],
    counterexampleTransitions: [],
    counterexampleConfirmed: null,
    counterexampleTiming: null,
    elapsedMs: wholeMs(performance.now() - started),
    statistics: {
      places: net.places.size,
      transitions: net.transitions.size,
      invariantsFound: 0,
      structuralResult: `initially empty siphon of ${siphon.places.length} place(s); ${siphon.dead.length} dead transition(s)`,
    },
  };
}

/**
 * A duration as `describeReport` prints every route's: whole milliseconds. libpetri's own results
 * carry `performance.now()` differences; the printed line rounds them, and a result built here is
 * stored already rounded so a JSON report does not carry sub-millisecond noise either.
 */
export function wholeMs(ms: number): number {
  return Math.round(ms);
}

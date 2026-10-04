import type { CompiledWorkflow } from '../compiler/types.js';

/**
 * Checks, from the arcs alone, that every pool of the net is conserved ([ADR 0012]) — the run
 * permits ([ADR 0006]), every block's slots ([ADR 0011]), every `limit` quota and every `rateLimit`
 * bucket. It generalises `budgetStructureViolations`, which keeps its export and its rules for the
 * permits, and is host-agnostic: it reads only `CompiledWorkflow.pools` and the net (an M10
 * candidate).
 *
 * For each pool `P` with conservation vector `V` = `P.place` at weight 1 plus `P.holders`:
 *
 * 1. **The pool exists.** `P.place` and every holder are places of the net, and every declared
 *    taker and giver is one of its transitions.
 * 2. **Takers take exactly one.** A transition with an input arc on `P.place` is one of `P.takers`,
 *    and that arc is `one(P.place)` (or `exactly(1, …)`), its only arc there. Every declared taker has
 *    one.
 * 3. **Givers give exactly one.** A transition producing into `P.place` is one of `P.givers`, and
 *    every branch of its output spec — walked as a multiset, so a place named twice counts twice
 *    ([IO-016]) — puts exactly one token there. Every declared giver does.
 * 4. **Every branch conserves `V`.** For every transition with an arc on a place of `V`, every branch
 *    of its output spec produces, weighted over `V`, exactly what its inputs consume weighted over
 *    `V`. An attempt that takes a permit or a quota and returns it on every branch passes; one that
 *    keeps it on its failure branch, or mints one, does not.
 * 5. **Nothing reads or resets `V`.** No read arc and no reset arc on any place of `V`; the one
 *    exception in the whole net is a bucket's refill reading its `demand`, which is not in `V`. An
 *    inhibitor moves nothing and is not flagged.
 * 6. **A bucket's refill is its only.** `P.refill` is `one(spent), read(demand)` → `P.place` with a
 *    `delayed(P.perMs)` timing, and no other transition reads `demand`.
 * 7. **One permits pool, matching `budget`.** At most one `permits` pool, present exactly when
 *    `compiled.budget` is, with the same place and `seed === k`.
 *
 * Places are compared **by name**, as `budgetStructureViolations` compares them: `place()` does not
 * intern, and fusion leaves only the canonical name in the net.
 *
 * Returns one line per violation, prefixed by the pool place's name; empty means sound, and is always
 * empty for a net with no pools.
 */
export function poolStructureViolations(compiled: CompiledWorkflow): readonly string[] {
  void compiled;
  throw new Error('poolStructureViolations: not implemented (M7 W1 E)');
}

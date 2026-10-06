import type { CompiledWorkflow } from '../compiler/types.js';

/**
 * Checks, from the arcs alone, that the compensation ladder is the shape its claims rest on
 * ([ADR 0017], amended by the W0 spike) — `structure.ts` style, over `CompiledWorkflow.compensations`
 * (the blueprint's declaration, never derived from the arcs it inspects), under "compensate
 * structure" in `properties.ts`. Host-agnostic: the M10 candidate's check.
 *
 * Model checking cannot see four things, and the W0 spike has a mutant for each that passes every
 * behavioural claim: termination and at most once (S1, S3; MUT5), cancel-free compensators (S5),
 * outcome routing (S6, S6t) and reverse order beyond adjacent levels (S1, by transitivity). C1
 * (`rolledBack`) ranges over quiescent markings only and cannot see a rollback that never rests.
 *
 * 1. **S1, arming and levels.** `arm_j` takes exactly {arming_j, level.{j-1}} and gives exactly
 *    {successor(k_j), level.j}; arming_j's only producer is entry k_j's `next`; `level.j` (j ≥ 1) has
 *    no producers but `arm_j` and `settle_{j+1}.*`.
 * 2. **S2, one routing rule.** Every top-level `exits.failed` is `wf.comp.failure`; `raise` is its only
 *    consumer. A top-level entry's outputs stay in its interior, its `next`, its arming, the ladder's
 *    exits, or pools.
 * 3. **S3, one rung at a time.** `start_j` takes exactly {pending, level.j}, gives exactly {u_j.in,
 *    undoing_j}, and is the only producer of both; each of the five `u_j` exits has exactly one
 *    consumer, `settle_j.<kind>`, which takes exactly {u_j.<kind>, undoing_j} and gives exactly
 *    {level.{j-1}, pending}; `undoing_j` has no other consumer; the rollback subgraph strictly
 *    descends and is acyclic.
 * 4. **S4, the held failure.** `finish` takes exactly {pending, level.0, fault} and is the only
 *    producer of `wf.settle.failed`.
 * 5. **S5, cancel-free.** No `wf.comp` transition has an arc on `wf.cancel`; no swept transition
 *    consumes a `wf.comp` place; compensator leaves carry no signal.
 * 6. **S6, outcome routing.** Each `discharge_j.<kind>` moves exactly one `exit.<kind>` and `level.j`
 *    to its own `wf.settle.<kind>` (`done` to the success settle place); only `discharge_j.canceled`
 *    produces a terminal (`wf.canceled`); nothing in the ladder consumes, resets, inhibits or reads a
 *    terminal.
 * 7. **S7, the coverage exemption.** The attempts {@link compensatorAttempts} exempts are exactly the
 *    compensators' chains, which leave only by their own exits.
 * 8. **S8, nothing dead.** No ladder place lacks a producer and no ladder transition is dead from
 *    the arcs (the W0 six-kind ladder's `settle_j.canceled` is its mutant).
 *
 * Mutants (`tests/verify/compensate.test.ts`, W1 claims): one per rule, each also run against the
 * behavioural claims with the result recorded.
 *
 * Returns one line per violation, prefixed by its rule; empty for a net with no ladder.
 *
 * Contract stub (M7b W0): W1 (claims) builds the rules. An unannotated workflow has no ladder and
 * gets `[]`; a net with one throws until then.
 */
export function compensateStructureViolations(compiled: CompiledWorkflow): readonly string[] {
  if (compiled.compensations === undefined) return [];
  throw new Error('compensateStructureViolations: not implemented (M7b W1)');
}

/**
 * The step attempts of every compensator ([ADR 0017], S7): `CompensatorSite.attempts` over the
 * ladder's rungs. A compensator that suspends is unresolved — its settle returns the level and the
 * rollback goes on — and registers no resume site (`compensate-suspend` refuses a declared schema,
 * the runner rewrites a dynamic suspend `failed`), so `suspensionCoverageViolations` exempts them, as
 * it exempts `decidingArmAttempts` and `pipelineLaneAttempts`. They are not unchecked:
 * `compensateStructureViolations` S3 and S7 hold each suspended exit to its own settle. Empty for a
 * net with no ladder; an attempt with no net-map entry is never exempt.
 *
 * Contract stub (M7b W0): W1 (claims) builds it. An unannotated workflow gets the empty set; a net
 * with a ladder throws until then.
 */
export function compensatorAttempts(compiled: CompiledWorkflow): ReadonlySet<string> {
  if (compiled.compensations === undefined) return new Set();
  throw new Error('compensatorAttempts: not implemented (M7b W1)');
}

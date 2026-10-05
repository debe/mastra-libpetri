import type { CompiledWorkflow } from '../compiler/types.js';

/**
 * Checks, from the arcs alone, that every pipeline is the shape its claims rest on ([ADR 0015],
 * amended by the W0 spike) — `structure.ts` style, over `CompiledWorkflow.pipelines` (the gadget's
 * declaration, never derived from the arcs it inspects), under "pipeline structure" in
 * `properties.ts`. Host-agnostic: the M10 candidate's check.
 *
 * For each `PipelineSite`:
 *
 * 1. **Hand-offs are rendezvous.** Each `to{m}` takes exactly `done_{j,l}`, `slot_{j,l}`,
 *    `permit_{j+1,m}`, is inhibited by `wf.cancel`, and gives exactly `body_{j+1,m}`, `slot_{j+1,m}`,
 *    `permit_{j,l}`.
 * 2. **Bodies have one source.** Stage `j + 1`'s body has no producer but stage-`j` hand-offs, stage
 *    0's none but `start`; only `start`, `refuse` and the settles take `queue.open`.
 * 3. **One slot per item.** Every transition consuming a slot produces at most one slot.
 * 4. **Every exit is settled or dropped.** Every lane exit's `¬cancel` consumers are exactly the
 *    ones the site declares for it (`settles` by exit — three variants for `failed` and `suspended`;
 *    `handoffs` or `collect` for `done`), and it has exactly one `drop` (`drops` by exit) reading
 *    `cancel`. The ADR's "exactly one `¬cancel` consumer" reads per variant: no exit has an
 *    undeclared consumer.
 * 5. **Finishers wait for every lane.** Every finisher takes every permit of every stage, plus
 *    `queue.closed` and `frame`.
 * 6. **Monotone.** No pipeline place carries an inhibitor, reset or drain — so under [VER-004] the
 *    only split stays `t.cancel.arrive`.
 * 7. **A suspended exit stays in the pipeline.** A lane's `suspended` exit reaches only its own
 *    settle or drop — what the `pipelineLaneAttempts` coverage exemption rests on.
 *
 * Mutants (`tests/verify/pipeline.test.ts`, W1 D): a hand-off without the next permit; an inhibitor
 * on `fault` added to a hand-off; a finisher missing a stage-1 permit; a collect without its drop.
 * Rule 8 of the amendment — no pipeline transition unreachable from the arcs — is a W1 test, not a
 * claim.
 *
 * Returns one line per violation, prefixed by the foreach's id; empty for a net with no pipelines.
 *
 * Contract stub (M7b W0): W1 D builds the rules. An unannotated workflow has no pipelines and gets
 * `[]`; a net with one throws until then.
 */
export function pipelineStructureViolations(compiled: CompiledWorkflow): readonly string[] {
  if (compiled.pipelines.length === 0) return [];
  throw new Error('pipelineStructureViolations: not implemented (M7b W1)');
}

/**
 * The step attempts inside a pipeline's lanes ([ADR 0015], maintainer decision 4): every attempt of
 * a stage's lane body, whose naming path is `[...site.path, L]`. A stage suspension ends the pipeline
 * `suspended` but registers no resume site — a resume there is refused by name (`pipeline`) — so
 * `suspensionCoverageViolations` exempts them, as it exempts `decidingArmAttempts`. They are not
 * unchecked: `pipelineStructureViolations` rule 7 holds each suspended exit to its own settle or
 * drop. Empty for a net with no pipelines; an attempt with no net-map entry is never exempt.
 *
 * Contract stub (M7b W0): W1 D builds it. An unannotated workflow gets the empty set; a net with a
 * pipeline throws until then.
 */
export function pipelineLaneAttempts(compiled: CompiledWorkflow): ReadonlySet<string> {
  if (compiled.pipelines.length === 0) return new Set();
  throw new Error('pipelineLaneAttempts: not implemented (M7b W1)');
}

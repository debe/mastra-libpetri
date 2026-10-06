import type { Place, Transition } from 'libpetri';
import type { EntryPath, NameVocabulary } from '../names.js';
import type {
  CompensationSite,
  ExclusionClaim,
  Exits,
  FlowToken,
  StepDescription,
  Terminals,
  WorkflowDescription,
} from '../types.js';

/**
 * `compensate` ([ADR 0017], amended by the W0 spike): the run-wide ladder that undoes completed
 * top-level steps, newest first, when a later top-level entry fails. Host-free (an M10 candidate), as
 * `firstKGadget` and `pipelineGadget` are. Not a gadget: it wraps the top-level spine, so `compile()`
 * calls it — and only when {@link hasCompensation} says some step carries a `compensate` — and wires
 * what it returns:
 *
 * - every top-level entry emits into {@link Ladder.exits} instead of the settle-stage exits, and the
 *   last entry's success into {@link Ladder.done};
 * - entry `i`'s success place is {@link Ladder.armAt}`(i, successor)` — `arming_j` when `i = k_j`;
 * - every checkpoint sweep is handed `Ladder.exits.canceled` as its canceled place
 *   (`checkpointStructureViolations` rule 3 and `resumeGateViolations` rule 6 accept it);
 * - once the spine is emitted, {@link Ladder.finish} emits the rollback, the discharges and the
 *   compensator leaves (through {@link LadderFinish.emit}), and returns the site and C2–C4.
 *
 * The net is the ADR's (`CompensationSite` in `../types.ts` draws it): `wf.comp.*` places and
 * `t.comp.*` transitions through `names.reserve`, compensator `u_j` at path `[n + j - 1]` viewed at
 * `[k_j]`, emitted with no cancel signal and `detached`; five compensator exit kinds; `undoing_j`
 * holding the rest of the stack; every place 1-bounded; no ladder arc on `wf.cancel`.
 *
 * Throws, naming the step, on a description the adapter would have refused: `compensate` on anything
 * but a top-level `.then()` step, or on the last entry (`compensate-position`); a compensator carrying
 * its own `compensate` (`compensate-value`); a compensator id colliding with a graph id or another
 * compensator, or one forward step compensated twice (`compensate-ids`); a checkpoint at or after
 * `k_1` (`compensate-checkpoint`). `compensate-suspend` is the adapter's alone: a description carries
 * no schemas.
 *
 * Contract stub (M7b W0): W1 (net) builds it. Reached only by a description carrying a `compensate`,
 * which nothing can produce yet — the petri `createStep` refuses the key until W1 (surface).
 */
export function compensateLadder(args: LadderArgs): Ladder {
  throw new Error(`compensateLadder('${args.description.id}'): not implemented (M7b W1)`);
}

/**
 * The seed a segment starting at top-level index `at` adds to its marking ([ADR 0017], W0 amendment
 * 4): `level.a` with `a = |{j : k_j < at}|`, and the forward step ids whose stored outputs rebuild the
 * stack, bottom first. **The one seed**: `segmentInitialMarking` (`verify/properties.ts`) and the
 * kernel's fresh, resume and restart seeds all call it, so a proof's `restart@p` and a run's restart
 * at `p` start from the same level. `at` is `0` for a fresh run, the boundary's index for a restart,
 * and the resume site's top-level index `path[0]` for a resume. A restart from a marked checkpoint
 * always gets `level.0`, because `compensate-checkpoint` refuses every checkpoint at or after `k_1`;
 * it is this formula, not a constant, that the kernel shares.
 *
 * Contract stub (M7b W0): W1 (net) builds it. Called only with a `CompiledWorkflow.compensations`,
 * which nothing can compile yet.
 */
export function ladderLevel(site: CompensationSite, at: number): LadderSeed {
  throw new Error(`ladderLevel(m=${site.m}, at=${at}): not implemented (M7b W1)`);
}

/**
 * Whether any step of the description — top-level, arm, loop or foreach body, pipeline stage, or
 * compensator — carries a `compensate` key. `compile()` calls {@link compensateLadder} exactly when
 * this is true, so a key in a position the ladder refuses reaches the ladder's refusal rather than
 * being silently ignored, and an unannotated description never reaches the ladder at all.
 */
export function hasCompensation(description: WorkflowDescription): boolean {
  const carries = (s: StepDescription): boolean => s.compensate !== undefined;
  return description.entries.some((entry) => {
    switch (entry.kind) {
      case 'step': return carries(entry);
      case 'parallel':
      case 'branch': return entry.arms.some(carries);
      case 'loop': return carries(entry.body);
      case 'foreach': return carries(entry.body) || (entry.pipeline?.stages.some(carries) ?? false);
      case 'sleep':
      case 'sleepUntil': return false;
    }
  });
}

/** What `compile()` hands {@link compensateLadder}. */
export interface LadderArgs {
  readonly description: WorkflowDescription;
  /** The checked checkpoints (`compensate-checkpoint` is judged against them). */
  readonly checkpoints: readonly number[];
  readonly names: NameVocabulary;
  /**
   * The settle-stage exits every top-level entry emitted into before M7b — `wf.settle.{failed,
   * bailed, suspended, paused}` and `wf.canceled` — where `finish` and the discharges deliver.
   */
  readonly settles: Exits;
  /** `wf.settle.done`: where `discharge_j.done` delivers. */
  readonly settleDone: Place<FlowToken>;
  readonly terminals: Terminals;
  /** `wf.cancel`: named only so the ladder can keep its arcs off it (S5); never on an arc. */
  readonly cancel: Place<null>;
  /** Adds a ladder transition to the net. Not mapped to an entry. */
  readonly transition: (t: Transition) => void;
  /** Adds a ladder place to the net. */
  readonly place: (p: Place<unknown>) => void;
}

/** What {@link compensateLadder} returns to `compile()`. See there for how each is wired. */
export interface Ladder {
  /**
   * The exits every top-level entry emits into: `failed` is `wf.comp.failure`, every other kind
   * `wf.comp.exit.<kind>` — `canceled` included, so every top-level, checkpoint and foreach sweep
   * feeds `wf.comp.exit.canceled` (intercept mode).
   */
  readonly exits: Exits;
  /** `wf.comp.exit.done`: the last top-level entry's success. */
  readonly done: Place<FlowToken>;
  /**
   * Entry `i`'s success place: `wf.comp.{j}.arming` when `i = k_j` (and `t.comp.{j}.arm` takes it,
   * with `level.{j-1}`, to `successor` and `level.j`), else `successor` unchanged. Called once per
   * top-level entry, right to left, with the place entry `i`'s success would otherwise go to — its
   * checkpoint place when one follows it.
   */
  armAt(i: number, successor: Place<FlowToken>): Place<FlowToken>;
  /**
   * Emits the rollback (`raise`, `start_j`, `settle_j.*`, `finish`), the discharges for every level
   * and the compensator leaves, after the spine. Returns the site — `CompiledWorkflow.compensations`
   * — and the ladder's exclusion claims: C2 (`level.j` with `wf.settle.failed`, j ≥ 1), C3
   * (`wf.comp.fault` with every top-level entry input, every `wf.settle.*` and every terminal) and C4
   * (`wf.canceled` with `wf.comp.failure` and with `wf.comp.pending`).
   */
  finish(args: LadderFinish): { readonly site: CompensationSite; readonly exclusions: readonly ExclusionClaim[] };
}

/** What `compile()` hands {@link Ladder.finish}. */
export interface LadderFinish {
  /** Every top-level entry's input place name, in entry order (C3). */
  readonly entryInputs: readonly string[];
  /**
   * Emits compensator `step` through the compiler's own `emit`: at naming path `path` (`[n + j - 1]`),
   * view path `viewPath` (`[k_j]`), success into `next`, outcomes into `exits`, **no cancel signal**
   * and `NestedOptions.detached`. The compiler maps its transitions to `{ path, id: step.id }` and
   * registers its attempts and chain as any step's. Returns its input place and its step attempts.
   * `exits.canceled` is never on an arc for a compensator leaf (no cancel signal, so no sweep): the
   * ladder hands the leaf an existing place there and must not register one through `args.place`,
   * and S8 ranges over the places {@link CompensationSite} names.
   */
  emit(
    step: StepDescription,
    path: EntryPath,
    viewPath: EntryPath,
    next: Place<FlowToken>,
    exits: Exits,
  ): { readonly inPlace: Place<FlowToken>; readonly attempts: readonly string[] };
}

/** What {@link ladderLevel} returns: the level token a segment is seeded with. */
export interface LadderSeed {
  /** `a = |{j : k_j < at}|`, in `0..m`. */
  readonly level: number;
  /** `wf.comp.level.a`: the place to seed with one token. */
  readonly place: string;
  /**
   * The forward step ids `k_1 … k_a`, bottom of the stack first: the kernel rebuilds the token's
   * value from their stored `success` records' `output` (`engine/scope.ts`); the verifier ignores it.
   */
  readonly stack: readonly string[];
}

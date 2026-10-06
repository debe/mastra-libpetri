import { Transition, and, one, outPlace, place, type Place } from 'libpetri';
import type { EntryPath, NameVocabulary } from '../names.js';
import type {
  BailToken,
  CanceledToken,
  CompensationSite,
  CompensatorExitKind,
  CompensatorSite,
  DischargeKind,
  ExclusionClaim,
  Exits,
  FailureToken,
  FlowToken,
  PauseToken,
  StepDescription,
  SuspendToken,
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
 * holding the rest of the stack; every place 1-bounded; no ladder arc on `wf.cancel`, and no ladder
 * transition carries an inhibitor, a read or a reset, so under [VER-004] the only split stays
 * `t.cancel.arrive`. **Intercept mode** (W0 amendment 1): nothing in the ladder consumes, reads or
 * reproduces a terminal; `wf.canceled` is produced only by the settle stage's cancel pairs and by
 * `discharge_j.canceled`, a pure move. Every transition carries a real `Out` (no `null`).
 *
 * Throws, naming the step, on a description the adapter would have refused: `compensate` on anything
 * but a top-level `.then()` step, or on the last entry (`compensate-position`); a compensator carrying
 * its own `compensate`, one that is not a plain step (a nested workflow, an agent, a tool or a
 * mapping), or the forward step itself (`compensate-value`); a compensator id colliding with a graph
 * id or another compensator, or a compensated step whose id occurs twice in the graph
 * (`compensate-ids`); a checkpoint at or after `k_1` (`compensate-checkpoint`). `compensate-suspend`
 * is the adapter's alone: a description carries no schemas.
 */
export function compensateLadder(args: LadderArgs): Ladder {
  const { description, names, settles, settleDone } = args;
  const rungs = rungsOf(description, args.checkpoints);
  const m = rungs.length;
  const n = description.entries.length;
  const { transition, place: addPlace } = args;

  const levels: Place<Stack>[] = [];
  for (let j = 0; j <= m; j++) {
    levels.push(place<Stack>(names.reserve(`wf.comp.level.${j}`, `compensation ladder level ${j}`)));
  }
  const failure = place<FailureToken>(names.reserve('wf.comp.failure', 'every top-level failure, to be raised'));
  const fault = place<FailureToken>(names.reserve('wf.comp.fault', 'the held original failure during a rollback'));
  const pending = place<null>(names.reserve('wf.comp.pending', 'a rollback is under way'));
  const exit = {
    done: place<FlowToken>(names.reserve('wf.comp.exit.done', 'the intercepted top-level success')),
    bailed: place<BailToken>(names.reserve('wf.comp.exit.bailed', 'the intercepted top-level bail')),
    suspended: place<SuspendToken>(names.reserve('wf.comp.exit.suspended', 'the intercepted top-level suspension')),
    paused: place<PauseToken>(names.reserve('wf.comp.exit.paused', 'the intercepted top-level pause')),
    canceled: place<CanceledToken>(names.reserve('wf.comp.exit.canceled', 'the intercepted top-level cancel, every sweep included')),
  };
  for (const p of [...levels, failure, fault, pending, exit.done, exit.bailed, exit.suspended, exit.paused, exit.canceled]) {
    addPlace(p as Place<unknown>);
  }

  // Filled by armAt (right to left), read by finish.
  const armed = new Map<number, { readonly arming: string; readonly arm: string }>();
  let finished = false;

  return {
    exits: { failed: failure, bailed: exit.bailed, suspended: exit.suspended, paused: exit.paused, canceled: exit.canceled },
    done: exit.done,

    armAt(i, successor) {
      const x = rungs.findIndex((r) => r.k === i);
      if (x < 0) return successor;
      if (armed.has(i)) throw new Error(`compensateLadder('${description.id}'): entry ${i} armed twice`);
      const j = x + 1;
      const arming = place<FlowToken>(names.reserve(`wf.comp.${j}.arming`, `entry ${i}'s success, arming level ${j}`));
      addPlace(arming as Place<unknown>);
      const below = levels[j - 1]!;
      const above = levels[j]!;
      const arm = names.reserve(`t.comp.${j}.arm`, `arm level ${j} with entry ${i}'s output`);
      transition(
        Transition.builder(arm)
          .inputs(one(arming), one(below))
          .outputs(and(outPlace(successor), outPlace(above)))
          .action(async (tctx) => {
            const flow = tctx.input(arming);
            const stack = tctx.input(below);
            tctx.output(successor, flow);
            // Push k_j's output: the stack is [out(k_1) … out(k_j)], bottom first.
            tctx.output(above, [...stack, flow.data]);
          })
          .build(),
      );
      armed.set(i, { arming: arming.name, arm });
      return arming;
    },

    finish(fin) {
      if (finished) throw new Error(`compensateLadder('${description.id}'): finish called twice`);
      finished = true;
      for (const { k } of rungs) {
        if (!armed.has(k)) throw new Error(`compensateLadder('${description.id}'): entry ${k} was never armed (armAt not called for it)`);
      }

      const raise = names.reserve('t.comp.raise', 'raise a top-level failure into a rollback');
      transition(
        Transition.builder(raise)
          .inputs(one(failure))
          .outputs(and(outPlace(fault), outPlace(pending)))
          .action(async (tctx) => {
            tctx.output(fault, tctx.input(failure));
            tctx.output(pending, null);
          })
          .build(),
      );
      const finishName = names.reserve('t.comp.finish', 'finish the rollback: settle the held failure');
      transition(
        Transition.builder(finishName)
          .inputs(one(pending), one(levels[0]!), one(fault))
          .outputs(outPlace(settles.failed))
          .action(async (tctx) => {
            tctx.input(pending);
            tctx.input(levels[0]!);
            tctx.output(settles.failed, tctx.input(fault));
          })
          .build(),
      );

      const compensators: CompensatorSite[] = rungs.map(({ k, forward, compensator }, x): CompensatorSite => {
        const j = x + 1;
        const level = levels[j]!;
        const below = levels[j - 1]!;
        const undoing = place<Stack>(names.reserve(`wf.comp.${j}.undoing`, `the stack below level ${j} while u_${j} runs`));
        const ex = {
          done: place<FlowToken>(names.reserve(`wf.comp.${j}.done`, `u_${j} done`)),
          failed: place<FailureToken>(names.reserve(`wf.comp.${j}.failed`, `u_${j} failed`)),
          bailed: place<BailToken>(names.reserve(`wf.comp.${j}.bailed`, `u_${j} bailed`)),
          suspended: place<SuspendToken>(names.reserve(`wf.comp.${j}.suspended`, `u_${j} suspended`)),
          paused: place<PauseToken>(names.reserve(`wf.comp.${j}.paused`, `u_${j} paused`)),
        };
        for (const p of [undoing, ex.done, ex.failed, ex.bailed, ex.suspended, ex.paused]) addPlace(p as Place<unknown>);
        const path: EntryPath = [n + j - 1];
        const viewPath: EntryPath = [k];
        // No cancel signal, so the leaf has no sweep and never produces `canceled` (W0 amendment 3):
        // its `canceled` exit is handed `wf.canceled`, an existing place no arc of it names. Were it
        // ever on an arc, S6 (only `discharge_j.canceled` produces a terminal) would refuse the net.
        const leaf = fin.emit(compensator, path, viewPath, ex.done, { ...ex, canceled: settles.canceled });
        const uIn = leaf.inPlace;
        const start = names.reserve(`t.comp.${j}.start`, `start u_${j} on the top of level ${j}`);
        transition(
          Transition.builder(start)
            .inputs(one(pending), one(level))
            .outputs(and(outPlace(uIn), outPlace(undoing)))
            .action(async (tctx) => {
              tctx.input(pending);
              const stack = tctx.input(level);
              tctx.output(undoing, stack.slice(0, -1));
              tctx.output(uIn, { data: stack[stack.length - 1] });
            })
            .build(),
        );
        const settleNames = {} as Record<CompensatorExitKind, string>;
        for (const kind of COMPENSATOR_EXITS) {
          const from = ex[kind] as Place<unknown>;
          const name = names.reserve(`t.comp.${j}.settle.${kind}`, `settle u_${j} ${kind}: down to level ${j - 1}`);
          settleNames[kind] = name;
          transition(
            Transition.builder(name)
              .inputs(one(from), one(undoing))
              .outputs(and(outPlace(below), outPlace(pending)))
              .action(async (tctx) => {
                // Unresolved or not, the rollback continues (maintainer decision 2 A): the outcome is
                // the compensator's record, never the run's error.
                tctx.input(from);
                tctx.output(below, tctx.input(undoing));
                tctx.output(pending, null);
              })
              .build(),
          );
        }
        const a = armed.get(k)!;
        return {
          j,
          k,
          forwardId: forward.id,
          stepId: compensator.id,
          path,
          viewPath,
          arming: a.arming,
          arm: a.arm,
          start,
          inPlace: uIn.name,
          undoing: undoing.name,
          exits: { done: ex.done.name, failed: ex.failed.name, bailed: ex.bailed.name, suspended: ex.suspended.name, paused: ex.paused.name },
          settles: settleNames,
          attempts: [...leaf.attempts],
        };
      });

      // Intercept mode: every non-failed top-level exit is discharged before the settle stage by a
      // pure move that takes the level token with it, at every level 0..m.
      const targets: Readonly<Record<DischargeKind, Place<unknown>>> = {
        done: settleDone as Place<unknown>,
        bailed: settles.bailed as Place<unknown>,
        suspended: settles.suspended as Place<unknown>,
        paused: settles.paused as Place<unknown>,
        canceled: settles.canceled as Place<unknown>,
      };
      const discharges: Record<DischargeKind, string>[] = [];
      for (let j = 0; j <= m; j++) {
        const level = levels[j]!;
        const row = {} as Record<DischargeKind, string>;
        for (const kind of DISCHARGE_KINDS) {
          const from = exit[kind] as Place<unknown>;
          const to = targets[kind];
          const name = names.reserve(`t.comp.${j}.discharge.${kind}`, `discharge level ${j} with the top-level ${kind}`);
          row[kind] = name;
          transition(
            Transition.builder(name)
              .inputs(one(from), one(level))
              .outputs(outPlace(to))
              .action(async (tctx) => {
                tctx.input(level);
                tctx.output(to, tctx.input(from));
              })
              .build(),
          );
        }
        discharges.push(row);
      }

      const site: CompensationSite = {
        m,
        levels: levels.map((p) => p.name),
        failure: failure.name,
        fault: fault.name,
        pending: pending.name,
        raise,
        finish: finishName,
        exits: {
          done: exit.done.name,
          bailed: exit.bailed.name,
          suspended: exit.suspended.name,
          paused: exit.paused.name,
          canceled: exit.canceled.name,
        },
        discharges,
        compensators,
      };

      const t = args.terminals;
      const settleNamesAll = [settles.failed, settles.bailed, settles.suspended, settles.paused, settleDone].map((p) => p.name);
      const terminalNames = [t.done, t.failed, t.bailed, t.suspended, t.paused, t.canceled].map((p) => p.name);
      const exclusions: ExclusionClaim[] = [
        ...levels.slice(1).map((l) => ({
          a: l.name,
          b: settles.failed.name,
          why: 'C2: no failed outcome settles while a completed compensated step is uncompensated',
        })),
        ...[...new Set([...fin.entryInputs, ...settleNamesAll, ...terminalNames])].map((b) => ({
          a: fault.name,
          b,
          why: 'C3 (fail-fast): nothing forward starts and nothing settles during a rollback',
        })),
        { a: t.canceled.name, b: failure.name, why: 'C4: a cancel never decides over a running rollback' },
        { a: t.canceled.name, b: pending.name, why: 'C4: a cancel never decides over a running rollback' },
      ];
      return { site, exclusions };
    },
  };
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
 * Throws on an `at` that is not a whole number in `0..n` (`n` the top-level entry count is not in the
 * site, so the upper end is not checked here; every caller's `at` is a top-level index), and on a
 * site whose `levels` do not number `m + 1`.
 */
export function ladderLevel(site: CompensationSite, at: number): LadderSeed {
  if (!Number.isInteger(at) || at < 0) {
    throw new Error(`ladderLevel(m=${site.m}, at=${String(at)}): at must be a top-level index, a whole number >= 0`);
  }
  if (site.levels.length !== site.m + 1 || site.compensators.length !== site.m) {
    throw new Error(`ladderLevel(m=${site.m}, at=${at}): the site has ${site.levels.length} levels and ${site.compensators.length} compensators`);
  }
  const below = site.compensators.filter((c) => c.k < at);
  const level = below.length;
  return { level, place: site.levels[level]!, stack: below.map((c) => c.forwardId) };
}

/** The level token's colour: the forward outputs `[out(k_1) … out(k_j)]`, bottom first. */
type Stack = readonly unknown[];

/** Five, not six (W0 amendment 3): a compensator has no cancel signal, so never ends `canceled`. */
const COMPENSATOR_EXITS: readonly CompensatorExitKind[] = ['done', 'failed', 'bailed', 'suspended', 'paused'];
const DISCHARGE_KINDS: readonly DischargeKind[] = ['done', 'bailed', 'suspended', 'paused', 'canceled'];

interface Rung {
  /** `k_j`: the compensated entry's top-level index. */
  readonly k: number;
  readonly forward: StepDescription;
  readonly compensator: StepDescription;
}

/**
 * The compensated top-level steps in ascending `k`, every refusal the compiler can judge checked first
 * (see {@link compensateLadder}). Message: `workflow '<id>': <why> (<code>)`, the code last, as the
 * blueprints' refusals end.
 */
function rungsOf(description: WorkflowDescription, checkpoints: readonly number[]): readonly Rung[] {
  const refuse = (why: string, code: string): never => {
    throw new Error(`workflow '${description.id}': ${why} (${code})`);
  };
  const last = description.entries.length - 1;
  // Every step occurrence in the graph, compensators excluded, with where it sits. `top` is set only
  // by the top-level `.then()` case: position is decided by the traversal, never by object identity,
  // so one keyed object at top level and again as an arm still refuses the arm (compensate-position).
  const graph: { readonly step: StepDescription; readonly where: string; readonly top?: number }[] = [];
  const blockIds: string[] = [];
  description.entries.forEach((entry, i) => {
    switch (entry.kind) {
      case 'step':
        graph.push({ step: entry, where: `top-level entry ${i}`, top: i });
        return;
      case 'parallel':
      case 'branch':
        blockIds.push(entry.id);
        entry.arms.forEach((arm, a) => graph.push({ step: arm, where: `arm ${a} of the .${entry.kind}() at ${i}` }));
        return;
      case 'loop':
        blockIds.push(entry.id);
        graph.push({ step: entry.body, where: `the body of the loop at ${i}` });
        return;
      case 'foreach':
        blockIds.push(entry.id);
        graph.push({ step: entry.body, where: `the body of the .foreach() at ${i}` });
        entry.pipeline?.stages.forEach((stage, s) => graph.push({ step: stage, where: `stage ${s} of the pipeline at ${i}` }));
        return;
      case 'sleep':
      case 'sleepUntil':
        blockIds.push(entry.id);
        return;
    }
  });

  const rungs: Rung[] = [];
  for (const { step, where, top } of graph) {
    if (step.compensate === undefined) continue;
    const k = top ?? refuse(`compensate on step '${step.id}', ${where}: only a top-level .then() step may carry one`, 'compensate-position');
    if (k === last) {
      refuse(`compensate on step '${step.id}', the last top-level entry: nothing after it can fail, so its compensator could never run`, 'compensate-position');
    }
    rungs.push({ k, forward: step, compensator: step.compensate });
  }

  const graphIds = new Set([...graph.map((g) => g.step.id), ...blockIds]);
  const seen = new Set<string>();
  for (const { forward, compensator } of rungs) {
    if (compensator.compensate !== undefined) {
      refuse(`compensator '${compensator.id}' of step '${forward.id}' carries its own compensate`, 'compensate-value');
    }
    if (compensator.source !== undefined && compensator.source !== 'step') {
      refuse(`compensator '${compensator.id}' of step '${forward.id}' is a ${compensator.source}, not a step`, 'compensate-value');
    }
    if (compensator === forward || compensator.id === forward.id) {
      refuse(`step '${forward.id}' is its own compensator`, 'compensate-value');
    }
    if (graphIds.has(compensator.id)) {
      refuse(`compensator '${compensator.id}' of step '${forward.id}' shares its id with the graph`, 'compensate-ids');
    }
    if (seen.has(compensator.id)) {
      refuse(`compensator '${compensator.id}' undoes two steps; records are latest-per-id`, 'compensate-ids');
    }
    seen.add(compensator.id);
    if (graph.filter((g) => g.step.id === forward.id).length > 1) {
      refuse(`compensated step '${forward.id}' occurs twice in the graph; records are latest-per-id, so two undos would read one output`, 'compensate-ids');
    }
  }

  const first = rungs[0];
  if (first !== undefined) {
    const late = checkpoints.find((c) => c >= first.k);
    if (late !== undefined) {
      refuse(
        `the checkpoint after entry ${late} is at or after the first compensated entry ${first.k} ('${first.forward.id}'); a restart from it would skip undos`,
        'compensate-checkpoint',
      );
    }
  }
  return rungs;
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

import type { TransitionContext } from 'libpetri';
import type { EntryPath } from './names.js';
import type { AttemptDeadline } from './timeout.js';
import type { StepPreemptedError } from './preempt.js';
import type { LifecycleEvent, RunView, StepRecord, StepRunner } from './types.js';

/**
 * The key under which the kernel hands each firing its run scope, through libpetri's
 * `executionContextProvider` ([CONC-*] execution context, read with `ctx.executionContext`).
 */
export const RUN_SCOPE_KEY = 'mastra-libpetri/run-scope';

/**
 * Everything a compiled action needs that belongs to **one run** rather than to the workflow's
 * shape.
 *
 * A compiled net is built once per shape and cached by its structural hash; a run brings its own
 * runner, its own step results and its own clock. Handing those over at firing time, rather than
 * closing over them at compile time, is what makes that cache sound — and it is what the Mastra
 * engine needs, because each Mastra run carries its own `stepResults`, abort signal and pubsub.
 */
export interface RunScope {
  readonly runner: StepRunner;
  readonly initData: unknown;
  getStepResult(stepId: string): StepRecord | undefined;
  /** Records a step's latest record under its id, as Mastra's `stepResults[id] = result`. */
  recordStepResult(stepId: string, record: StepRecord): void;
  /**
   * This segment is a restart ([ADR 0010]). Mastra hands `restart` to every entry of a restarted
   * run (`default.ts:893-935`), and a `.branch()` under restart re-runs every truthy arm, never
   * reusing a stored `success` (`handlers/control-flow.ts:544-553`). Absent means false.
   */
  readonly restarted?: boolean;
  /** Every record, in first-recorded order — what a checkpoint writes ([ADR 0010]). */
  stepResults(): ReadonlyMap<string, StepRecord>;
  /** Epoch milliseconds on the run's clock — `.sleepUntil`, and every record's timestamps. */
  epochNow(): number;
  /**
   * The run's abort signal — never aborted when the run has none. Actions read it only to cut
   * short work already in flight (an action-side wait, and a Mastra step's own `abortSignal`);
   * *whether new work starts* is decided by the net's inhibitor arcs, never by this.
   */
  readonly signal: AbortSignal;
  /**
   * Waits `ms` on the run's clock, resolving early when `signal` aborts — Mastra's
   * `abortableSleep`. Used by the sleeps that cannot be a transition timing: libpetri timing is
   * relative to enablement, so only a fixed `.sleep` is one.
   */
  wait(ms: number): Promise<void>;
  /**
   * Arms one step attempt's deadline `ms` from now on the run's clock ([ADR 0013], [TIME-015]):
   * its signal aborts with `reason` when it fires. A run abort before then disarms it, so the step's
   * own outcome stands. Nothing reads the machine clock, so a ManualClock advance fires it.
   */
  armDeadline(ms: number, reason: unknown): AttemptDeadline;
  /**
   * Preempts the deciding block at `path` ([ADR 0014]): aborts its one controller, with `reason` —
   * a `StepPreemptedError` the block's action built — so every attempt of its arms still running
   * sees `StepCall.preempt` fire, and every attempt called later is handed it already fired. What
   * that does to an attempt is the runner's verdict, frozen once (`StepOutcome.verdict`): an attempt
   * whose verdict was frozen before this call is not affected. Called by the
   * block's `met` and `short` actions — exactly one of them fires per block per segment, so the
   * second call that idempotence allows never happens; it is a no-op all the same. Never touches
   * `signal`: the run goes on. Not called for a block of one arm, which has nothing to preempt.
   *
   * `.parallel()` is top-level, so `path` is `[i]` and a block is decided at most once per segment.
   * Called before any arm asked for {@link preemption}, it still fires the signal that arm then gets.
   */
  preempt(path: EntryPath, reason: StepPreemptedError): void;
  /**
   * The deciding block's preemption signal at `path` — created on first ask, one per block per
   * segment, shared by every attempt of every arm, aborted only by {@link preempt}. The leaf hands it
   * to the runner as `StepCall.preempt` and never reads it: a gadget does not branch on a signal.
   */
  preemption(path: EntryPath): AbortSignal;
  /**
   * Forgets `stepId`'s suspension in the runner ([ADR 0014]): forwards to
   * `StepRunner.forgetSuspension`, a no-op when the runner has none. Called by a `race` / `quorum`
   * join, once per suspended loser, in the same firing that rewrites that loser's record `canceled`
   * — so the finished run's resume labels name no arm of a decided block. A nested workflow's own
   * suspended child run is not reached: that is the residual row 107 records.
   */
  forgetSuspension(stepId: string): void;
  /**
   * Item `k`'s store in the pipeline at `path` ([ADR 0015], maintainer decision 3: item scope at twin
   * parity) — created on first ask, one per (pipeline, item) per segment. `path` is the foreach's
   * top-level path, which every lane body sees as its view path; `k` is the item's index, the lane
   * token's `foreachIndex`. A stage's leaf (`NestedOptions.item`) reads the item as its `initData` and
   * its own records through it, and records there instead of {@link recordStepResult}, so a stage's
   * `getStepResult('fetch')` reads **this item's** `fetch`, as a stage of the twin's child run does,
   * and the run's step map gains no stage keys. The pipeline opens it at stage 0's `start` and forgets
   * it at the item's collect, bail, pause, settle or drop.
   */
  itemRecords(path: EntryPath, k: number): ItemRecords;
  /**
   * Hands a lifecycle event to the runner's `observe` ([ADR 0008]). `undefined` when the runner has
   * none, so an action awaits nothing and a run without an observer fires exactly as before. The
   * promise never rejects: an observer's throw or rejection is kept for the run's report, never
   * turned into a failed firing that would strand the tokens it consumed ([EXEC-031]).
   */
  observe(event: LifecycleEvent): Promise<void> | undefined;
}

/**
 * One pipeline item's own scope ([ADR 0015]): what a twin child run would hold for it — its input
 * and the records of the stages it has run. State is not here: the runner holds the item's state
 * snapshot (`StepRunner.openItem` / `closeItem`), and this store is how the pipeline's transitions
 * reach it — {@link open} snapshots, {@link forget} merges or discards.
 *
 * Item `k` travels the lanes as `FlowToken.foreachIndex = k` (stage 0's `start` sets it, each
 * hand-off carries it), so a stage's leaf and every lane exit token name their item.
 */
export interface ItemRecords {
  /** The item, as stage 0 received it — what a stage's `getInitData()` returns. Set by {@link open}. */
  readonly initData: unknown;
  /**
   * Opens the store for a newly admitted item, at stage 0's `start`: sets {@link initData}; records
   * start empty; and the runner snapshots the run's state for the item (`StepRunner.openItem`), as
   * the twin's child run takes it at item start (`workflow.ts:3006`).
   */
  open(initData: unknown): void;
  getStepResult(stepId: string): StepRecord | undefined;
  recordStepResult(stepId: string, record: StepRecord): void;
  /**
   * Drops the store: the item has left the pipeline. A later {@link RunScope.itemRecords} starts
   * fresh. `state` is what becomes of the item's state snapshot (`StepRunner.closeItem`), as the twin
   * merges a child's state on every non-throwing return (`workflow.ts:3054-3055`, the ADR's
   * amendment): `'merge'` at a collect, a bail, a pause, a suspend settle and **every drop**;
   * `'discard'` at a fail settle (failed and tripwire alike).
   */
  forget(state: 'merge' | 'discard'): void;
}

/** The run scope of the firing in progress. Throws if the kernel did not supply one. */
export function scopeOf(ctx: TransitionContext): RunScope {
  const scope = ctx.executionContext<RunScope>(RUN_SCOPE_KEY);
  if (scope === undefined) {
    throw new Error(
      `transition '${ctx.transitionName()}' fired without a run scope. Compiled nets are run ` +
        'through runWorkflow(), which supplies one; a net compiled only to be verified must never fire.',
    );
  }
  return scope;
}

/** The read-only view a runner call receives, for the entry at `path`. */
export function viewOf(scope: RunScope, path: EntryPath): RunView {
  return {
    path,
    initData: scope.initData,
    getStepResult: (stepId) => scope.getStepResult(stepId),
    abortSignal: scope.signal,
  };
}

import type { TransitionContext } from 'libpetri';
import type { EntryPath } from './names.js';
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
   * Hands a lifecycle event to the runner's `observe` ([ADR 0008]). `undefined` when the runner has
   * none, so an action awaits nothing and a run without an observer fires exactly as before. The
   * promise never rejects: an observer's throw or rejection is kept for the run's report, never
   * turned into a failed firing that would strand the tokens it consumed ([EXEC-031]).
   */
  observe(event: LifecycleEvent): Promise<void> | undefined;
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

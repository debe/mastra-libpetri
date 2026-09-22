import type { TransitionContext } from 'libpetri';
import type { EntryPath } from './names.js';
import type { RunView, StepOutcome, StepRunner } from './types.js';

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
  getStepResult(stepId: string): StepOutcome | undefined;
  /** Records a step's latest outcome under its id, as Mastra's `stepResults[id] = result`. */
  recordStepResult(stepId: string, outcome: StepOutcome): void;
  /** Epoch milliseconds on the run's clock, for a per-run `.sleepUntil`. */
  epochNow(): number;
  /**
   * Waits `ms` on the run's clock. Used only by a per-run `.sleep` / `.sleepUntil`, whose wait
   * cannot be a transition timing because libpetri timing belongs to the transition and not to
   * the token. Every fixed wait is a timed transition instead.
   */
  wait(ms: number): Promise<void>;
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
  };
}

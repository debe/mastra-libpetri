import type { EntryPath } from './names.js';

/**
 * A step attempt that outran its deadline ([ADR 0013]). Host-free, so the leaf constructs it: it is
 * the `error` of the attempt's `timedOut` branch and, on the final attempt, of the step's `failed`
 * record, and it is the `reason` of the attempt's `StepCall.deadline` signal — so a step reading
 * `abortSignal.reason` can tell a timeout from a run cancel.
 *
 * Retried like any thrown error (it is not a `MastraNonRetryableError`): a timeout on a non-final
 * attempt goes through the step's existing `delayed` retry hop.
 */
export class StepTimeoutError extends Error {
  override readonly name = 'StepTimeoutError';
  constructor(
    readonly stepId: string,
    /** The view path — Mastra's `executionPath` for the attempt. */
    readonly path: EntryPath,
    readonly timeoutMs: number,
    /** 0-based, as `StepCall.attempt`. */
    readonly attempt: number,
    readonly foreachIndex?: number,
  ) {
    super(
      `step '${stepId}' at [${path.join(', ')}]` +
        (foreachIndex === undefined ? '' : ` (item ${foreachIndex})`) +
        ` timed out after ${timeoutMs} ms on attempt ${attempt + 1}`,
    );
  }
}

/**
 * One attempt's deadline on the run's clock ([ADR 0013], [TIME-015]), armed by the leaf through
 * `RunScope.armDeadline` before it calls the runner.
 *
 * - `signal` is aborted, with the `reason` the leaf gave, exactly when the deadline fires — and
 *   never by the run's abort: a run abort before expiry **disarms** the deadline, so the step's own
 *   outcome stands.
 * - `expired` resolves when it fires and never resolves once disarmed, so the leaf can race it
 *   against the runner's promise without a dangling rejection.
 * - `disarm()` stops the timer; idempotent, and a no-op after it fired. The leaf disarms when the
 *   step settles first, so a finished attempt leaves no timer behind on a ManualClock.
 *
 * Once fired, the outcome is the timeout even if the step then returns success (maintainer
 * decision): the leaf waits for the step to settle — the action never abandons it, so permits,
 * quotas and slots stay held and a retry never overlaps its predecessor — then discards its result.
 */
export interface AttemptDeadline {
  readonly signal: AbortSignal;
  readonly expired: Promise<void>;
  /** Whether it fired. Stays false once disarmed. */
  readonly fired: boolean;
  disarm(): void;
}

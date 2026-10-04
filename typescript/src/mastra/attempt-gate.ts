import type { EntryPath } from '../compiler/names.js';
import type { StepCall } from '../compiler/types.js';

/** Which attempt a gate guards ([ADR 0013]): a step's id, its view path, its item and its retry. */
export interface AttemptIdentity {
  readonly stepId: string;
  readonly path: EntryPath;
  readonly foreachIndex?: number;
  readonly attempt: number;
}

/**
 * One step attempt's gate in the runner ([ADR 0013]). Built per call from `StepCall.abortSignal`
 * (the run's) and `StepCall.deadline` (the attempt's, present only when the step has a timeout).
 *
 * - `controller` is what the runner hands Mastra's `StepExecutor` as `abortController`: its
 *   `signal` is a per-attempt signal aborted by the run's abort **or** the deadline, with that
 *   source's reason; its `abort(reason)` aborts the **run's** controller, so a step's own `abort()`
 *   still cancels the run (`evented/step-executor.ts:89-90, 248-253`; `handlers/step.ts:420-450`).
 *   A nested workflow cancels its child run on that signal (`workflow.ts:2983, 3045`).
 * - `expired()` is true once the deadline has fired. From then on the runner applies no
 *   `stateUpdate`, runs no scorers, and ignores `suspend`, `bail` and resume labels for this
 *   identity; the leaf discards the outcome and records the timeout.
 * - `writer(stream)` wraps the attempt's `ToolStream` so chunks written after expiry are dropped.
 * - `release()` unlinks every listener; the runner calls it once the step has settled.
 *
 * Without a deadline the gate is transparent: `controller` behaves as the run's, `expired()` is
 * always false and `writer` returns its argument — so a step without a timeout runs exactly as today.
 */
export interface AttemptGate {
  readonly identity: AttemptIdentity;
  readonly controller: AbortController;
  expired(): boolean;
  writer<W extends object>(stream: W): W;
  release(): void;
}

/** Builds the gate for one runner call ([ADR 0013]). */
export function attemptGate(
  stepId: string,
  call: Pick<StepCall, 'path' | 'foreachIndex' | 'attempt' | 'abortSignal' | 'deadline'>,
  run: AbortController,
): AttemptGate {
  void stepId;
  void call;
  void run;
  throw new Error('attemptGate: not implemented (M7 W1 F)');
}

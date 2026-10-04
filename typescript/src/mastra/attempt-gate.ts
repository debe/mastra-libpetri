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
  const identity: AttemptIdentity = {
    stepId,
    path: call.path,
    ...(call.foreachIndex === undefined ? {} : { foreachIndex: call.foreachIndex }),
    attempt: call.attempt,
  };
  const deadline = call.deadline;
  if (deadline === undefined) {
    // Transparent: the run's own controller, exactly what the runner handed the executor before M7.
    return { identity, controller: run, expired: () => false, writer: (stream) => stream, release: () => {} };
  }

  // One signal the step sees, aborted by whichever source fires first, with that source's reason.
  const attempt = new AbortController();
  const sources = [...new Set([call.abortSignal, run.signal, deadline])];
  const unlink: (() => void)[] = [];
  for (const source of sources) {
    if (source.aborted) {
      attempt.abort(source.reason);
      break;
    }
    const onAbort = (): void => attempt.abort(source.reason);
    source.addEventListener('abort', onAbort, { once: true });
    unlink.push(() => source.removeEventListener('abort', onAbort));
  }
  const release = (): void => {
    for (const u of unlink.splice(0)) u();
  };
  if (attempt.signal.aborted) release();

  // What `StepExecutor` reads of its `abortController` is `signal` and `abort()` only
  // (`evented/step-executor.ts:89-90, 248-253`): the step sees the attempt's signal, and its own
  // `abort()` cancels the run, as on the default engine (`handlers/step.ts:420-450`).
  const controller = {
    get signal(): AbortSignal {
      return attempt.signal;
    },
    abort(reason?: unknown): void {
      run.abort(reason);
    },
  } as AbortController;

  const expired = (): boolean => deadline.aborted;
  return { identity, controller, expired, writer: (stream) => gated(stream, expired), release };
}

/**
 * `target` with every write dropped once `expired()` holds: a function (an `OutputWriter`) is not
 * called; an object (a `ToolStream`) has `write`, `custom` and the writers `getWriter()` returns
 * gated. Every other member is the target's own, bound to it — a `WritableStream` keeps internal
 * slots a proxy receiver would fail the brand check on.
 */
function gated<W extends object>(target: W, expired: () => boolean): W {
  return new Proxy(target, {
    apply(fn, self, args) {
      if (expired()) return Promise.resolve();
      return Reflect.apply(fn as (...a: unknown[]) => unknown, self, args);
    },
    get(object, key) {
      const value: unknown = Reflect.get(object, key, object);
      if (typeof value !== 'function') return value;
      const bound = (value as (...a: unknown[]) => unknown).bind(object);
      if (key === 'write' || key === 'custom') {
        return (...args: unknown[]) => (expired() ? Promise.resolve() : bound(...args));
      }
      if (key === 'getWriter') {
        return (...args: unknown[]) => gated(bound(...args) as object, expired);
      }
      return bound;
    },
  });
}

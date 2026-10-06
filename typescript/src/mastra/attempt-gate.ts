import type { EntryPath } from '../compiler/names.js';
import type { StepPreemptedError } from '../compiler/preempt.js';
import type { StepCall, StepOutcome } from '../compiler/types.js';

/** Which attempt a gate guards ([ADR 0013]): a step's id, its view path, its item and its retry. */
export interface AttemptIdentity {
  readonly stepId: string;
  readonly path: EntryPath;
  readonly foreachIndex?: number;
  readonly attempt: number;
}

/**
 * The attempt's verdict as the gate holds it ([ADR 0014]): `own` — the step's outcome stands —
 * `timedOut` or `preempted`, each with the reason its signal fired with.
 */
export type GateVerdict =
  | { readonly kind: 'own' }
  | { readonly kind: 'timedOut'; readonly reason: unknown }
  | { readonly kind: 'preempted'; readonly reason: StepPreemptedError };

/**
 * One step attempt's gate in the runner ([ADR 0013], [ADR 0014]). Built per call from
 * `StepCall.abortSignal` (the run's), `StepCall.deadline` (the attempt's, present only when the step
 * has a timeout) and `StepCall.preempt` (the deciding block's, present only on an arm of a `race` /
 * `quorum`).
 *
 * - `controller` is what the runner hands Mastra's `StepExecutor` as `abortController`: its
 *   `signal` is a per-attempt signal aborted by the run's abort, the deadline **or** the preemption,
 *   whichever fires first, with that source's reason (when several had fired before the call: run,
 *   then deadline, then preemption); its `abort(reason)` aborts the **run's** controller, so a step's
 *   own `abort()` still cancels the run (`evented/step-executor.ts:89-90, 248-253`;
 *   `handlers/step.ts:420-450`). A nested workflow cancels its child run on that signal
 *   (`workflow.ts:2983, 3045`).
 * - `verdict()` is the attempt's verdict so far, and `freeze()` fixes it — the **one** point the
 *   runner decides the attempt, when the step has settled (or before it starts). The rule is
 *   **first fired wins** across the run's abort, the deadline and the preemption, as the gate's
 *   listeners recorded them:
 *   1. the run's abort fired first → `own`: the step's outcome stands, as on Mastra's default engine;
 *   2. the deadline fired first → `timedOut` ([ADR 0013]: a run abort before expiry disarms the
 *      deadline, so this is unchanged);
 *   3. the preemption fired first → `preempted`;
 *   4. none fired → `own`.
 *   A signal that fires after the first never re-decides the attempt. Sources that had all fired
 *   before the call, which no listener saw, are taken in the order run, deadline, preemption: an
 *   attempt called with both the run's abort and the preemption already fired is `own`, and runs.
 *   After `freeze()` nothing that fires changes it, so a preemption landing while the runner applies
 *   the attempt's effects, or while the leaf records it, does not turn an applied outcome into a loser.
 * - `expired()` is `verdict().kind !== 'own'`: the runner applies the attempt's effects
 *   (`stateUpdate`, resume labels, scorers) only on a frozen `own`, and the writer drops chunks while
 *   it holds. Since the first source to fire decides, the provisional verdict never changes once a
 *   source has fired; the freeze only stops a source firing **after** the settle from deciding.
 * - `writer(stream)` wraps the attempt's `ToolStream` so chunks written while `expired()` are dropped.
 * - `release()` unlinks every listener; the runner calls it once the step has settled.
 *
 * Without a deadline and without a preemption the gate is transparent: `controller` is the run's,
 * the verdict is always `own` and `writer` returns its argument — so a step that is neither timed nor
 * an arm of a `race` / `quorum` runs exactly as before M7.
 *
 * **A compensator's attempt** (`StepCall.detached`, [ADR 0017]) is **detached from the run's abort**,
 * as Temporal's detached cancellation scope is: neither `StepCall.abortSignal` nor the run's
 * controller is a source, so the step's signal fires only on its own deadline, and a step that
 * honours `abortSignal` still runs its undo after a cancel. With no deadline (a compensator is never
 * an arm, so it has no preemption) the signal is the gate's own and never fires; the gate is not
 * decisive, the verdict is always `own`, and `writer` returns its argument. Either way
 * `controller.abort()` still aborts the **run's** controller — a compensator's `abort()` cancels the
 * run as any step's does, and the rollback, which no cancel preempts, still finishes. Without
 * `detached` nothing here changes.
 */
export interface AttemptGate {
  readonly identity: AttemptIdentity;
  readonly controller: AbortController;
  /** False for the transparent gate: no deadline and no preemption, nothing to decide. */
  readonly decisive: boolean;
  verdict(): GateVerdict;
  freeze(): GateVerdict;
  expired(): boolean;
  writer<W extends object>(stream: W): W;
  release(): void;
}

const OWN: GateVerdict = Object.freeze({ kind: 'own' });

/** Builds the gate for one runner call ([ADR 0013], [ADR 0014]). */
export function attemptGate(
  stepId: string,
  call: Pick<StepCall, 'path' | 'foreachIndex' | 'attempt' | 'abortSignal' | 'deadline' | 'preempt' | 'detached'>,
  run: AbortController,
): AttemptGate {
  const identity: AttemptIdentity = {
    stepId,
    path: call.path,
    ...(call.foreachIndex === undefined ? {} : { foreachIndex: call.foreachIndex }),
    attempt: call.attempt,
  };
  const deadline = call.deadline;
  const preempt = call.preempt;
  // [ADR 0017]: a compensator's attempt does not hear the run's abort; see the interface.
  const detached = call.detached === true;
  if (deadline === undefined && preempt === undefined && detached) {
    // A signal of the gate's own, linked to nothing: it never fires. `abort()` is still the run's.
    const own = new AbortController();
    const controller = {
      get signal(): AbortSignal {
        return own.signal;
      },
      abort(reason?: unknown): void {
        run.abort(reason);
      },
    } as AbortController;
    return {
      identity,
      controller,
      decisive: false,
      verdict: () => OWN,
      freeze: () => OWN,
      expired: () => false,
      writer: (stream) => stream,
      release: () => {},
    };
  }
  if (deadline === undefined && preempt === undefined) {
    // Transparent: the run's own controller, exactly what the runner handed the executor before M7.
    return {
      identity,
      controller: run,
      decisive: false,
      verdict: () => OWN,
      freeze: () => OWN,
      expired: () => false,
      writer: (stream) => stream,
      release: () => {},
    };
  }

  // Which source fired first, recorded by the listeners while linked. Unlinked (released, or a source
  // had fired before the call so no listener was added), it is read from the signals in the order
  // run, deadline, preemption: sources that fired unobserved are ordered by precedence.
  type Source = 'run' | 'deadline' | 'preempt';
  let first: Source | undefined;
  const sourceOf = (signal: AbortSignal): Source =>
    signal === deadline ? 'deadline' : signal === preempt ? 'preempt' : 'run';
  const noteFirst = (signal: AbortSignal): void => {
    first ??= sourceOf(signal);
  };
  const runAborted = (): boolean => !detached && (call.abortSignal.aborted || run.signal.aborted);
  const firstFired = (): Source | undefined =>
    first ??
    (runAborted() ? 'run' : deadline?.aborted === true ? 'deadline' : preempt?.aborted === true ? 'preempt' : undefined);

  // One signal the step sees, aborted by whichever source fires first, with that source's reason.
  // Sources in precedence order, so when several had fired before the call the step reads the run's.
  const attempt = new AbortController();
  const sources = [...new Set([...(detached ? [] : [call.abortSignal, run.signal]), deadline, preempt])].filter(
    (source): source is AbortSignal => source !== undefined,
  );
  const unlink: (() => void)[] = [];
  for (const source of sources) {
    if (source.aborted) {
      noteFirst(source);
      attempt.abort(source.reason);
      break;
    }
    const onAbort = (): void => {
      noteFirst(source);
      if (!attempt.signal.aborted) attempt.abort(source.reason);
    };
    source.addEventListener('abort', onAbort, { once: true });
    unlink.push(() => source.removeEventListener('abort', onAbort));
  }
  const release = (): void => {
    for (const u of unlink.splice(0)) u();
  };
  // Released at once when a source had fired before the call, as before; `noteFirst` took the first
  // fired source in precedence order.
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

  const current = (): GateVerdict => {
    switch (firstFired()) {
      case 'deadline':
        return { kind: 'timedOut', reason: deadline!.reason };
      case 'preempt':
        return { kind: 'preempted', reason: preempt!.reason as StepPreemptedError };
      default:
        return OWN;
    }
  };
  let frozen: GateVerdict | undefined;
  const verdict = (): GateVerdict => frozen ?? current();
  const freeze = (): GateVerdict => (frozen ??= current());
  const expired = (): boolean => verdict().kind !== 'own';
  return { identity, controller, decisive: true, verdict, freeze, expired, writer: (stream) => gated(stream, expired), release };
}

/**
 * The verdict as the runner reports it to the leaf (`StepOutcome.verdict`, [ADR 0014]). `started`
 * says whether the step was started at all; it matters only to a preemption, whose record then
 * takes no start of its own.
 */
export function reportedVerdict(verdict: GateVerdict, started: boolean): NonNullable<StepOutcome['verdict']> {
  switch (verdict.kind) {
    case 'own':
      return { kind: 'own' };
    case 'timedOut':
      return { kind: 'timedOut' };
    case 'preempted':
      return { kind: 'preempted', reason: verdict.reason, started };
  }
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

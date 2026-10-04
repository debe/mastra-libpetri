import { systemClock, type Clock } from 'libpetri';
import type { RunScope } from '../compiler/scope.js';
import type { AttemptDeadline } from '../compiler/timeout.js';
import type { CheckpointEvent, LifecycleEvent, StepRecord, StepRunner } from '../compiler/types.js';

export interface RunScopeOptions {
  readonly runner: StepRunner;
  readonly initData: unknown;
  readonly clock?: Clock;
  /** The run's abort signal. Omitted, the scope's signal simply never aborts. */
  readonly signal?: AbortSignal;
  /** Step records carried in from an earlier segment — a resume, or a Mastra snapshot. */
  readonly stepResults?: ReadonlyMap<string, StepRecord>;
  /** The segment is a restart ([ADR 0010]); see `RunScope.restarted`. */
  readonly restarted?: boolean;
}

/**
 * One run's scope: its runner, its input, its signal and its step records.
 *
 * The records are Mastra's own `stepResults` — the system of record Mastra persists in
 * `WorkflowRunState` — so on a resume this is rehydrated from the snapshot alongside the marking,
 * and nothing about the net is persisted separately. Latest record per step id, as Mastra's
 * `stepResults[id] = result` keeps.
 */
export class KernelRunScope implements RunScope {
  readonly runner: StepRunner;
  readonly initData: unknown;
  readonly signal: AbortSignal;
  readonly restarted: boolean;
  readonly #results: Map<string, StepRecord>;
  readonly #clock: Clock;

  constructor(options: RunScopeOptions) {
    this.runner = this.#keepingCheckpointErrors(options.runner);
    this.initData = options.initData;
    this.signal = options.signal ?? new AbortController().signal;
    this.restarted = options.restarted === true;
    this.#results = new Map(options.stepResults ?? []);
    this.#clock = options.clock ?? systemClock();
  }

  getStepResult(stepId: string): StepRecord | undefined {
    return this.#results.get(stepId);
  }

  recordStepResult(stepId: string, record: StepRecord): void {
    this.#results.set(stepId, record);
  }

  /** The first error an observer threw or rejected with, for the run's report ([ADR 0008]). */
  get observerError(): { readonly error: unknown } | undefined {
    return this.#observerError;
  }
  #observerError: { readonly error: unknown } | undefined;

  observe(event: LifecycleEvent): Promise<void> | undefined {
    const observe = this.runner.observe;
    if (observe === undefined) return undefined;
    const kept = (error: unknown): void => {
      this.#observerError ??= { error };
    };
    try {
      return Promise.resolve(observe.call(this.runner, event)).then(undefined, kept);
    } catch (error) {
      kept(error);
      return undefined;
    }
  }

  /**
   * The first error a checkpoint write (`StepRunner.checkpoint`) threw or rejected with ([ADR 0010]),
   * as the object itself. Unlike an observer's, it is **not** swallowed: the rejection still fails
   * the checkpoint's firing, which ends the run as `stranded` ([ADR 0007]'s failed-firing rule). But
   * libpetri's `transition-failed` event carries only the message and the type name, so this is
   * where the engine gets the original error back to reject with — the storage error, as Mastra's
   * own persist failure rejects.
   */
  get checkpointError(): { readonly error: unknown } | undefined {
    return this.#checkpointError;
  }
  #checkpointError: { readonly error: unknown } | undefined;

  /**
   * The runner as the actions see it: the caller's own, except that `checkpoint` — when it has one —
   * keeps its first throw or rejection here before passing it on unchanged. A proxy rather than a
   * copy, so every other member (present or added later) reaches the runner itself, bound to it, and
   * however an action calls `scope.runner.checkpoint` the error is kept. A runner without
   * `checkpoint` is handed through as it is.
   */
  #keepingCheckpointErrors(runner: StepRunner): StepRunner {
    const checkpoint = runner.checkpoint;
    if (typeof checkpoint !== 'function') return runner;
    const kept = (error: unknown): never => {
      this.#checkpointError ??= { error };
      throw error;
    };
    const wrapped = (event: CheckpointEvent): Promise<void> => {
      try {
        return Promise.resolve(checkpoint.call(runner, event)).then(undefined, kept);
      } catch (error) {
        return kept(error);
      }
    };
    return new Proxy(runner, {
      get(target, property) {
        if (property === 'checkpoint') return wrapped;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  /** Every record, in first-recorded order. */
  stepResults(): ReadonlyMap<string, StepRecord> {
    return this.#results;
  }

  epochNow(): number {
    return this.#clock.epochNow();
  }

  /**
   * Waits on the run's clock, so an action-side sleep follows an injected clock ([TIME-015])
   * instead of burning real time under a virtual one — and resolves early when the run's signal
   * aborts, as Mastra's `abortableSleep` does.
   *
   * `Clock.sleep` may resolve early and spuriously by contract, so the wait loops on the clock
   * rather than trusting a single resolution. One caveat, recorded rather than hidden: this calls
   * the clock's wait from an action, outside the executor loop it was specified for. A real clock
   * is unaffected; a virtual clock that advances on every finite `sleep` call advances once per
   * call here too, so a wait overlapping another timed wait can move virtual time further than
   * either alone.
   */
  async wait(ms: number): Promise<void> {
    if (ms <= 0 || this.signal.aborted) return;
    const until = this.#clock.now() + ms;
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    this.signal.addEventListener('abort', onAbort, { once: true });
    try {
      while (this.#clock.now() < until && !this.signal.aborted) {
        await this.#clock.sleep(until - this.#clock.now(), () => false, controller.signal);
      }
    } finally {
      this.signal.removeEventListener('abort', onAbort);
    }
  }

  /** See `RunScope.armDeadline` ([ADR 0013]). */
  armDeadline(ms: number, reason: unknown): AttemptDeadline {
    void ms;
    void reason;
    throw new Error('armDeadline: not implemented (M7 W1 B)');
  }
}

import { systemClock, type Clock } from 'libpetri';
import type { RunScope } from '../compiler/scope.js';
import type { LifecycleEvent, StepRecord, StepRunner } from '../compiler/types.js';

export interface RunScopeOptions {
  readonly runner: StepRunner;
  readonly initData: unknown;
  readonly clock?: Clock;
  /** The run's abort signal. Omitted, the scope's signal simply never aborts. */
  readonly signal?: AbortSignal;
  /** Step records carried in from an earlier segment — a resume, or a Mastra snapshot. */
  readonly stepResults?: ReadonlyMap<string, StepRecord>;
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
  readonly #results: Map<string, StepRecord>;
  readonly #clock: Clock;

  constructor(options: RunScopeOptions) {
    this.runner = options.runner;
    this.initData = options.initData;
    this.signal = options.signal ?? new AbortController().signal;
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
}

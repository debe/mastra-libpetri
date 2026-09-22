import { systemClock, type Clock } from 'libpetri';
import type { RunScope } from '../compiler/scope.js';
import type { StepOutcome, StepRunner } from '../compiler/types.js';

export interface RunScopeOptions {
  readonly runner: StepRunner;
  readonly initData: unknown;
  readonly clock?: Clock;
  /** Step results carried in from an earlier segment — a resume, or a Mastra snapshot. */
  readonly stepResults?: ReadonlyMap<string, StepOutcome>;
}

/**
 * One run's scope: its runner, its input and its step results.
 *
 * The step results are Mastra's own `stepResults` — the system of record Mastra persists in
 * `WorkflowRunState` — so on a resume this is rehydrated from the snapshot alongside the
 * marking, and nothing about the net is persisted separately. Latest outcome per step id, as
 * Mastra's `stepResults[id] = result` keeps.
 */
export class KernelRunScope implements RunScope {
  readonly runner: StepRunner;
  readonly initData: unknown;
  readonly #results: Map<string, StepOutcome>;
  readonly #clock: Clock;

  constructor(options: RunScopeOptions) {
    this.runner = options.runner;
    this.initData = options.initData;
    this.#results = new Map(options.stepResults ?? []);
    this.#clock = options.clock ?? systemClock();
  }

  getStepResult(stepId: string): StepOutcome | undefined {
    return this.#results.get(stepId);
  }

  recordStepResult(stepId: string, outcome: StepOutcome): void {
    this.#results.set(stepId, outcome);
  }

  /** Every recorded outcome, in first-recorded order. */
  stepResults(): ReadonlyMap<string, StepOutcome> {
    return this.#results;
  }

  epochNow(): number {
    return this.#clock.epochNow();
  }

  /**
   * Waits on the run's clock, so a per-run sleep follows an injected clock ([TIME-015]) instead
   * of burning real time under a virtual one.
   *
   * `Clock.sleep` may resolve early and spuriously by contract, so the wait loops on the clock
   * rather than trusting a single resolution. One caveat, recorded rather than hidden: this calls
   * the clock's wait from an action, outside the executor loop it was specified for. A real clock
   * is unaffected; a virtual clock that advances on every finite `sleep` call advances once per
   * call here too, so a per-run wait overlapping another timed wait can move virtual time further
   * than either alone.
   */
  async wait(ms: number): Promise<void> {
    if (ms <= 0) return;
    const until = this.#clock.now() + ms;
    const controller = new AbortController();
    while (this.#clock.now() < until) {
      await this.#clock.sleep(until - this.#clock.now(), () => false, controller.signal);
    }
  }
}

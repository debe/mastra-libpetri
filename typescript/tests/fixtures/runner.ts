import type { RunView, StepCall, StepOutcome, StepRunner } from '../../src/compiler/types.js';

/** A step's scripted behaviour: its outcome as a function of its input and the call. */
export type Behaviour = (input: unknown, call: StepCall) => StepOutcome | Promise<StepOutcome>;

export interface RecordingRunnerOptions {
  /** Per-step behaviour; a step with none echoes its input as a success. */
  readonly steps?: Record<string, Behaviour>;
  /** `.branch` selection by entry id. */
  readonly branches?: Record<string, (input: unknown, view: RunView) => readonly number[] | Promise<readonly number[]>>;
  /** `.dowhile` / `.dountil` condition by entry id. */
  readonly loops?: Record<string, (output: unknown, iteration: number, view: RunView) => boolean | Promise<boolean>>;
  /** Per-run `.sleep` / `.sleepUntil` wait by entry id. */
  readonly waits?: Record<string, (input: unknown, view: RunView) => number | Promise<number>>;
}

/**
 * Records the order steps actually ran — `calls` holds every attempt, so a retried step appears
 * once per attempt — so happens-before and retry counts can be asserted, not assumed.
 *
 * Only the capabilities actually configured exist on the instance: a workflow with a `.branch`
 * run against a runner without `branches` fails the way a real runner lacking `selectBranches`
 * would, rather than being quietly answered.
 */
export class RecordingRunner implements StepRunner {
  readonly calls: string[] = [];
  readonly attempts: { readonly stepId: string; readonly attempt: number }[] = [];

  readonly selectBranches?: StepRunner['selectBranches'];
  readonly evaluateLoopCondition?: StepRunner['evaluateLoopCondition'];
  readonly resolveWait?: StepRunner['resolveWait'];

  readonly #steps: Record<string, Behaviour>;

  /** Accepts the options object, or — the older form — a bare per-step behaviour map. */
  constructor(options: RecordingRunnerOptions | Record<string, Behaviour> = {}) {
    const opts: RecordingRunnerOptions = isOptions(options) ? options : { steps: options };
    this.#steps = opts.steps ?? {};

    const { branches, loops, waits } = opts;
    if (branches !== undefined) {
      this.selectBranches = async (entryId, input, view) => {
        const select = own(branches, entryId);
        if (select === undefined) throw new Error(`no branch selection scripted for '${entryId}'`);
        return select(input, view);
      };
    }
    if (loops !== undefined) {
      this.evaluateLoopCondition = async (entryId, output, iteration, view) => {
        const cond = own(loops, entryId);
        if (cond === undefined) throw new Error(`no loop condition scripted for '${entryId}'`);
        return cond(output, iteration, view);
      };
    }
    if (waits !== undefined) {
      this.resolveWait = async (entryId, input, view) => {
        const wait = own(waits, entryId);
        if (wait === undefined) throw new Error(`no wait scripted for '${entryId}'`);
        return wait(input, view);
      };
    }
  }

  async run(stepId: string, input: unknown, call: StepCall): Promise<StepOutcome> {
    this.calls.push(stepId);
    this.attempts.push({ stepId, attempt: call.attempt });
    const fn = own(this.#steps, stepId);
    if (fn !== undefined) return fn(input, call);
    return { status: 'success', output: input };
  }
}

/**
 * Tells the options object from a bare behaviour map by the **values**, not the keys: a behaviour
 * is a function and an options field is a record. Keying on names would misread a workflow that
 * happens to have a step called `steps`.
 */
function isOptions(value: RecordingRunnerOptions | Record<string, Behaviour>): value is RecordingRunnerOptions {
  const OPTION_KEYS = new Set(['steps', 'branches', 'loops', 'waits']);
  return Object.entries(value).every(([k, v]) => OPTION_KEYS.has(k) && typeof v === 'object' && v !== null);
}

/**
 * Looks up an own property only. A plain `record[id]` resolves `Object.prototype` members, so a
 * step called `toString` or `constructor` would run the prototype's method as its behaviour
 * instead of echoing its input.
 */
function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** A runner that must never be called — for a run whose steps are not supposed to fire. */
export const inertRunner: StepRunner = {
  async run(): Promise<StepOutcome> {
    throw new Error('inert runner must not be called');
  },
};

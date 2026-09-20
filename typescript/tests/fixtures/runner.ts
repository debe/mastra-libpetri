import type { StepOutcome, StepRunner } from '../../src/compiler/types.js';

/** Records the order steps actually ran, so happens-before can be asserted, not assumed. */
export class RecordingRunner implements StepRunner {
  readonly calls: string[] = [];

  constructor(private readonly behaviour: Record<string, (input: unknown) => StepOutcome> = {}) {}

  async run(stepId: string, input: unknown): Promise<StepOutcome> {
    this.calls.push(stepId);
    const fn = this.behaviour[stepId];
    if (fn !== undefined) return fn(input);
    return { status: 'success', output: input };
  }
}

/** A runner that never fires — for compiling a net purely to verify its structure. */
export const inertRunner: StepRunner = {
  async run(): Promise<StepOutcome> {
    throw new Error('inert runner must not be called');
  },
};

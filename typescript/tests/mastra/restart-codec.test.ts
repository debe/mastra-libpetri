import { DefaultExecutionEngine, type ExecutionEngine, type StepFlowEntry } from '@mastra/core/workflows';
import { UnrestartablePositionError } from '../../src/compiler/restart.js';
import { decodeRestart, getStepOutput, restartedFrom, stepOutputBefore } from '../../src/mastra/restart-codec.js';

/**
 * The restart codec ([ADR 0010]): Mastra's `restart` parameter (`utils.ts:577-634`) decoded for the
 * net, without touching what `Run._restart` handed over, and the input of the entry a restart
 * continues at — a port of `getStepOutput` (`default.ts:1132-1159`), checked against Mastra's own.
 */

type ExecuteParams = Parameters<ExecutionEngine['execute']>[0];

/** Every entry kind `getStepOutput` distinguishes, as `buildExecutionGraph` shapes them (ids only). */
const steps = [
  { type: 'step', step: { id: 'a' } },
  { type: 'parallel', steps: [{ type: 'step', step: { id: 'p1' } }, { type: 'tool', id: 'p2' }] },
  { type: 'conditional', steps: [{ type: 'step', step: { id: 'c1' } }, { type: 'agent', id: 'c2' }], conditions: [] },
  { type: 'foreach', step: { type: 'step', step: { id: 'each' } }, opts: { concurrency: 1 } },
  { type: 'loop', step: { type: 'step', step: { id: 'body' } }, loopType: 'dountil', condition: () => true },
  { type: 'sleep', id: 'sleep_1', duration: 1 },
  { type: 'mapping', id: 'map_1' },
  { type: 'sleepUntil', id: 'sleep_2', date: new Date(0) },
  { type: 'tool', id: 'last' },
] as unknown as StepFlowEntry[];

/** A stored context: `input`, successes, a branch arm not taken (no key), a step `running`. */
const context = {
  input: { n: 1 },
  a: { status: 'success', payload: { n: 1 }, output: { n: 2 }, startedAt: 1, endedAt: 2 },
  p1: { status: 'success', payload: { n: 2 }, output: { n: 3 }, startedAt: 2, endedAt: 3 },
  p2: { status: 'success', payload: { n: 2 }, output: { n: 4 }, startedAt: 2, endedAt: 3 },
  c1: { status: 'success', payload: {}, output: { n: 5 }, startedAt: 3, endedAt: 4 },
  each: { status: 'success', payload: [1, 2], output: [{ n: 6 }, { n: 7 }], startedAt: 4, endedAt: 5 },
  body: { status: 'success', payload: { n: 7 }, output: { n: 8 }, startedAt: 5, endedAt: 6, metadata: { iterationCount: 2 } },
  sleep_1: { status: 'success', payload: { n: 8 }, output: { n: 8 }, startedAt: 6, endedAt: 7 },
  map_1: { status: 'success', payload: { n: 8 }, output: { m: 9 }, startedAt: 7, endedAt: 8 },
  sleep_2: { status: 'running', payload: { m: 9 }, startedAt: 8 },
} as const;

function paramsWith(restart: unknown): ExecuteParams {
  return { workflowId: 'wf', runId: 'r', graph: { id: 'wf', steps }, restart } as unknown as ExecuteParams;
}

describe('getStepOutput, ported', () => {
  const mastras = new DefaultExecutionEngine({ mastra: undefined, options: { validateInputs: true } } as never);

  it.each(steps.map((step, i) => [i, step.type] as const))('matches Mastra\'s own for the entry before %i (%s)', (i) => {
    const mastra = mastras.getStepOutput(context as never, steps[i]);
    expect(getStepOutput(context, steps[i])).toStrictEqual(mastra);
  });

  it('matches Mastra\'s own with no previous entry: the workflow input', () => {
    expect(getStepOutput(context, undefined)).toStrictEqual(mastras.getStepOutput(context as never, undefined));
    expect(getStepOutput(context, undefined)).toStrictEqual({ n: 1 });
  });

  it('a parallel keeps every arm\'s key; a branch arm not taken is present and undefined', () => {
    expect(getStepOutput(context, steps[1])).toStrictEqual({ p1: { n: 3 }, p2: { n: 4 } });
    const branch = getStepOutput(context, steps[2]) as Record<string, unknown>;
    expect(Object.keys(branch)).toEqual(['c1', 'c2']);
    expect(branch).toStrictEqual({ c1: { n: 5 }, c2: undefined });
    expect(branch).toStrictEqual(mastras.getStepOutput(context as never, steps[2]));
  });

  it('a foreach and a loop give their body\'s output; a step with no record gives undefined', () => {
    expect(getStepOutput(context, steps[3])).toStrictEqual([{ n: 6 }, { n: 7 }]);
    expect(getStepOutput(context, steps[4])).toStrictEqual({ n: 8 });
    expect(getStepOutput({ input: 1 }, steps[0])).toBeUndefined();
  });

  it('stepOutputBefore(p) is getStepOutput of entry p - 1, the input at 0', () => {
    expect(stepOutputBefore(context, steps, 0)).toStrictEqual({ n: 1 });
    expect(stepOutputBefore(context, steps, 1)).toStrictEqual({ n: 2 });
    for (let p = 1; p < steps.length; p++) {
      expect(stepOutputBefore(context, steps, p)).toStrictEqual(mastras.getStepOutput(context as never, steps[p - 1]));
    }
  });
});

describe('decodeRestart', () => {
  it('never mutates activePaths, which Mastra consumes with shift() (default.ts:797-799)', () => {
    const activePaths = [2, 1];
    const restart = { activePaths, activeStepsPath: { c1: [2, 0] }, stepResults: context, state: { s: 1 }, stepExecutionPath: ['a'] };
    const decoded = decodeRestart(paramsWith(restart), { steps });
    expect(activePaths).toEqual([2, 1]);
    expect(restart.activePaths).toBe(activePaths);
    expect(decoded.request.activePaths).toEqual([2, 1]);
    expect(decoded.request.activePaths).not.toBe(activePaths);
    expect(decoded.index).toBe(2);
  });

  it('decodes position, input, records, carried path, state and activeStepsPath', () => {
    const decoded = decodeRestart(
      paramsWith({ activePaths: [3], activeStepsPath: { each: [3] }, stepResults: context, state: { s: 1 }, stepExecutionPath: ['a'] }),
      { steps },
    );
    // Entry 3's input is the branch's output, as getStepOutput builds it.
    expect(decoded.request.input).toStrictEqual({ c1: { n: 5 }, c2: undefined });
    expect(decoded.input).toStrictEqual({ n: 1 });
    expect(decoded.carriedPath).toEqual(['a']);
    expect(decoded.state).toStrictEqual({ s: 1 });
    expect(decoded.activeStepsPath).toStrictEqual({ each: [3] });
    expect(decoded.request.records).toBe(decoded.records);
  });

  it('a running entry has no StepRecord: it is kept in the carried context only', () => {
    const decoded = decodeRestart(paramsWith({ activePaths: [7], activeStepsPath: {}, stepResults: context }), { steps });
    expect(decoded.records.has('sleep_2')).toBe(false);
    expect(decoded.records.has('input')).toBe(false);
    expect([...decoded.records.keys()]).toEqual(['a', 'p1', 'p2', 'c1', 'each', 'body', 'sleep_1', 'map_1']);
    // The context is the stored one, key for key and in its order, `running` entry included.
    expect(decoded.context).toStrictEqual(context);
    expect(Object.keys(decoded.context)).toEqual(Object.keys(context));
    expect(decoded.context).not.toBe(context);
  });

  it('carries everything restartedFrom needs: index, carried path, context, restarted', () => {
    const decoded = decodeRestart(paramsWith({ activePaths: [1], activeStepsPath: {}, stepResults: context, stepExecutionPath: ['a'] }), { steps });
    expect(restartedFrom(decoded)).toStrictEqual({ index: 1, carriedPath: ['a'], context: decoded.context, restarted: true });
    expect(decoded.state).toBeUndefined();
  });

  it.each([
    ['empty', []],
    ['not a path', [-1]],
    ['a fraction', [0.5]],
    ['past the last entry', [steps.length]],
    ['absent', undefined],
  ])('refuses activePaths %s as no-position', (_name, activePaths) => {
    let error: unknown;
    try {
      decodeRestart(paramsWith({ activePaths, activeStepsPath: {}, stepResults: context }), { steps });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UnrestartablePositionError);
    expect((error as UnrestartablePositionError).reason).toBe('no-position');
  });
});

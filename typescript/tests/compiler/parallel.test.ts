import { describe, expect, it } from 'vitest';
import { PrecompiledNetExecutor, tokenOf } from 'libpetri';
import { compile } from '../../src/compiler/index.js';
import { describeReport, verifyWorkflow } from '../../src/verify/index.js';
import { classify, runWorkflow, type RunOutcome } from '../../src/engine/index.js';
import { parallelGadget } from '../../src/compiler/gadgets/parallel.js';
import type {
  CompiledWorkflow,
  FlowToken,
  StepOutcome,
  StepRunner,
  WorkflowDescription,
} from '../../src/compiler/types.js';
import { RecordingRunner, inertRunner } from '../fixtures/runner.js';

/** Registered explicitly, so these run against this gadget and not the registry's placeholder. */
const build = (description: WorkflowDescription, runner: StepRunner): CompiledWorkflow =>
  compile(description, { runner, gadgets: { parallel: parallelGadget } });

/**
 * `RecordingRunner`'s behaviours are synchronous, so every arm settles in the same pass. One
 * test needs a sibling genuinely still in flight when another arm has already failed — that is
 * the interleaving a naive fork/join strands.
 */
class PacedRunner implements StepRunner {
  readonly calls: string[] = [];

  constructor(
    private readonly behaviour: Record<string, (input: unknown) => Promise<StepOutcome> | StepOutcome>,
  ) {}

  async run(stepId: string, input: unknown): Promise<StepOutcome> {
    this.calls.push(stepId);
    const fn = this.behaviour[stepId];
    if (fn === undefined) return { status: 'success', output: input };
    return fn(input);
  }
}

const after = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs to quiescence exactly as `runWorkflow` does, but also reports every place still holding a
 * token. A join is precisely the shape whose bugs hide in the tokens the classification never
 * looks at: `classify` reports `failed` as soon as the failure terminal is marked, so an arm
 * left stranded elsewhere would be invisible to the outcome alone.
 */
async function run(
  compiled: CompiledWorkflow,
  input: unknown,
): Promise<{ readonly outcome: RunOutcome; readonly held: readonly string[] }> {
  const executor = new PrecompiledNetExecutor(
    compiled.net,
    new Map([[compiled.entryPlace, [tokenOf<FlowToken>({ data: input })]]]),
  );
  const marking = await executor.run(10_000, 'close');

  const held: string[] = [];
  for (const p of compiled.net.places) {
    const count = marking.tokenCount(p);
    if (count > 0) held.push(`${p.name}=${count}`);
  }
  return { outcome: classify(compiled, marking), held: held.sort() };
}

const tag = (id: string) => (input: unknown): StepOutcome => ({
  status: 'success',
  output: `${input as string}/${id}`,
});

const fanThenAfter = {
  id: 'fanout',
  entries: [
    {
      kind: 'parallel',
      id: 'fan',
      arms: [
        { kind: 'step', id: 'a' },
        { kind: 'step', id: 'b' },
        { kind: 'step', id: 'c' },
      ],
    },
    { kind: 'step', id: 'after' },
  ],
} as const;

const nestedFan = {
  id: 'nested-fanout',
  entries: [
    {
      kind: 'parallel',
      id: 'outer',
      arms: [
        { kind: 'step', id: 'a' },
        {
          kind: 'parallel',
          id: 'inner',
          arms: [
            { kind: 'step', id: 'b' },
            { kind: 'step', id: 'c' },
          ],
        },
      ],
    },
  ],
} as const;

describe('parallel', () => {
  it('runs every arm and joins exactly once before the next entry', async () => {
    const runner = new RecordingRunner({ a: tag('a'), b: tag('b'), c: tag('c') });

    const { outcome, held } = await run(build(fanThenAfter, runner), 'x');

    // All three ran, in no order this test is entitled to predict, and `after` ran only once
    // all three had: the join is the only producer into the next entry's place.
    expect(runner.calls.slice(0, 3).sort()).toEqual(['a', 'b', 'c']);
    expect(runner.calls[3]).toBe('after');
    expect(runner.calls).toHaveLength(4);
    expect(outcome.status).toBe('success');
    expect(held).toEqual(['wf.done=1']);
  });

  it('carries every arm both its input and its output across the join', async () => {
    const runner = new RecordingRunner({
      a: tag('a'),
      b: tag('b'),
      c: tag('c'),
      after: (input) => ({ status: 'success', output: input }),
    });

    const { outcome } = await run(build(fanThenAfter, runner), 'x');

    // Every arm saw the same input `x` (the fork copies it), and every arm's output reached the
    // next entry keyed by arm id, assembled in arm order rather than completion order.
    expect(outcome).toEqual({ status: 'success', output: { a: 'x/a', b: 'x/b', c: 'x/c' } });
  });

  it('routes one failing arm to the failure terminal without stranding its siblings', async () => {
    const runner = new PacedRunner({
      a: async (input) => { await after(10); return tag('a')(input); },
      b: () => ({ status: 'failed', error: 'b exploded' }),
      c: async (input) => { await after(10); return tag('c')(input); },
    });

    const { outcome, held } = await run(build(fanThenAfter, runner), 'x');

    // `b` fails while `a` and `c` are still in flight — the case that deadlocks a join wired
    // directly to each arm's done place.
    expect(outcome).toEqual({ status: 'failed', stepId: 'b', error: 'b exploded' });
    expect(runner.calls.slice(0, 3).sort()).toEqual(['a', 'b', 'c']);
    expect(runner.calls).not.toContain('after');
    // The whole point: one token, at the terminal, and nothing left anywhere else. A sibling
    // sitting in `arrived` or a marker left in `err-seen` would show up here.
    expect(held).toEqual(['wf.failed=1']);
  });

  it('drains every error marker when several arms fail', async () => {
    const runner = new PacedRunner({
      a: () => ({ status: 'failed', error: 'a exploded' }),
      b: async (input) => { await after(10); return tag('b')(input); },
      c: async () => { await after(5); return { status: 'failed', error: 'c exploded' }; },
    });

    const { outcome, held } = await run(build(fanThenAfter, runner), 'x');

    // Two failures put two tokens in `err-seen`; one `join-fail` firing must clear both. The
    // first to fail is the one reported, which is what `Promise.all` would have rejected with.
    expect(outcome).toEqual({ status: 'failed', stepId: 'a', error: 'a exploded' });
    // Without the reset arc this would also hold `...fan.err-seen=1`, forever.
    expect(held).toEqual(['wf.failed=1']);
  });

  it('joins a parallel nested inside a parallel arm', async () => {
    const runner = new RecordingRunner({ a: tag('a'), b: tag('b'), c: tag('c') });

    const { outcome, held } = await run(build(nestedFan, runner), 'x');

    expect(runner.calls.sort()).toEqual(['a', 'b', 'c']);
    expect(outcome).toEqual({
      status: 'success',
      output: { a: 'x/a', inner: { b: 'x/b', c: 'x/c' } },
    });
    expect(held).toEqual(['wf.done=1']);
  });

  it('carries a nested arm failure through both joins', async () => {
    const runner = new PacedRunner({
      a: async (input) => { await after(10); return tag('a')(input); },
      b: async (input) => { await after(10); return tag('b')(input); },
      c: () => ({ status: 'failed', error: 'c exploded' }),
    });

    const { outcome, held } = await run(build(nestedFan, runner), 'x');

    // The inner gadget's failure terminal is the outer gadget's local `arm-err`, not
    // `wf.failed`, so the inner join settles first and the outer one decides the run.
    expect(outcome).toEqual({ status: 'failed', stepId: 'c', error: 'c exploded' });
    expect(held).toEqual(['wf.failed=1']);
  });

  it('joins an arm that has no failure branch at all', async () => {
    const runner = new RecordingRunner({ a: tag('a') });
    const withSleep = {
      id: 'fan-with-sleep',
      entries: [
        {
          kind: 'parallel',
          id: 'fan',
          arms: [
            { kind: 'step', id: 'a' },
            { kind: 'sleep', id: 'wait', durationMs: 5 },
          ],
        },
      ],
    } as const;

    const { outcome, held } = await run(build(withSleep, runner), 'x');

    // `sleepGadget` never writes to its failure place, so `arm-err` has no producer here. The
    // join must not depend on one existing.
    expect(outcome).toEqual({ status: 'success', output: { a: 'x/a', wait: 'x' } });
    expect(held).toEqual(['wf.done=1']);
  });

  it('keeps two arms that are the same step apart in the net', async () => {
    const runner = new RecordingRunner({ a: tag('a') });
    const twins = {
      id: 'twins',
      entries: [
        {
          kind: 'parallel',
          id: 'fan',
          arms: [
            { kind: 'step', id: 'a' },
            { kind: 'step', id: 'a' },
          ],
        },
      ],
    } as const;

    const { outcome, held } = await run(build(twins, runner), 'x');

    // Arm identity in the net is the path, so both arms compile to distinct places and both
    // run. The id-keyed aggregate still collapses to one entry — exactly as Mastra's does.
    expect(runner.calls).toEqual(['a', 'a']);
    expect(outcome).toEqual({ status: 'success', output: { a: 'x/a' } });
    expect(held).toEqual(['wf.done=1']);
  });

  it('compiles a single-arm parallel', async () => {
    const solo = {
      id: 'solo',
      entries: [{ kind: 'parallel', id: 'fan', arms: [{ kind: 'step', id: 'only' }] }],
    } as const;

    const { outcome } = await run(build(solo, new RecordingRunner({ only: tag('only') })), 'x');

    expect(outcome).toEqual({ status: 'success', output: { only: 'x/only' } });
  });

  it('rejects a parallel with no arms rather than compiling a net that hangs', () => {
    const empty = {
      id: 'empty-fan',
      entries: [{ kind: 'parallel', id: 'fan', arms: [] }],
    } as const;

    expect(() => build(empty, new RecordingRunner())).toThrow(/no arms/);
  });

  it('runs through the kernel unchanged', async () => {
    const runner = new RecordingRunner({ a: tag('a'), b: tag('b'), c: tag('c') });

    const outcome = await runWorkflow(build(fanThenAfter, runner), 'x');

    expect(outcome.status).toBe('success');
    expect(runner.calls).toHaveLength(4);
  });
});

/**
 * The failure mode a join is most likely to have is a token nobody can consume, and `classify`
 * is blind to it: it reports `failed` the instant `wf.failed` is marked, so a sibling left in
 * `arrived` or a marker left in `err-seen` never reaches the outcome. Every case below asserts
 * the *held* set, not just the status, and every one is an interleaving the executor tests
 * above do not reach.
 */
describe('parallel, stranded-token hunt', () => {
  const armsOf = (ids: readonly string[]): WorkflowDescription => ({
    id: 'w',
    entries: [{ kind: 'parallel', id: 'fan', arms: ids.map((id) => ({ kind: 'step', id })) }],
  });
  const fails = (error: string) => (): StepOutcome => ({ status: 'failed', error });
  const failsAfter = (error: string, ms: number) => async (): Promise<StepOutcome> => {
    await after(ms);
    return { status: 'failed', error };
  };
  const succeedsAfter = (id: string, ms: number) => async (input: unknown): Promise<StepOutcome> => {
    await after(ms);
    return tag(id)(input);
  };

  it('strands nothing when every arm fails at once', async () => {
    const runner = new PacedRunner({ a: fails('a!'), b: fails('b!'), c: fails('c!') });

    const { outcome, held } = await run(build(armsOf(['a', 'b', 'c']), runner), 'x');

    // Three failures put three tokens in `err-seen`; one `join-fail` firing consumes the FIFO
    // head and the reset drops the other two. Any survivor would show up here, permanently:
    // its only consumer needs a full `arrived` count that can never come again.
    expect(outcome).toEqual({ status: 'failed', stepId: 'a', error: 'a!' });
    expect(held).toEqual(['wf.failed=1']);
  });

  it('reports the first arm to fail when failures are staggered in time', async () => {
    const runner = new PacedRunner({
      a: failsAfter('a!', 40),
      b: failsAfter('b!', 5),
      c: failsAfter('c!', 20),
    });

    const { outcome, held } = await run(build(armsOf(['a', 'b', 'c']), runner), 'x');

    // `one(err-seen)` takes the FIFO head ([EXEC-010]), which is the arm that failed first in
    // time — not the lowest-indexed arm. That is what `Promise.all` would have rejected with.
    expect(outcome).toEqual({ status: 'failed', stepId: 'b', error: 'b!' });
    expect(held).toEqual(['wf.failed=1']);
  });

  it('strands nothing with eight arms, half of them failing at different times', async () => {
    const runner = new PacedRunner({
      a: failsAfter('a!', 5),
      c: failsAfter('c!', 10),
      e: failsAfter('e!', 15),
      g: failsAfter('g!', 20),
      b: succeedsAfter('b', 30),
      d: succeedsAfter('d', 30),
      f: succeedsAfter('f', 30),
      h: succeedsAfter('h', 30),
    });

    const { outcome, held } = await run(
      build(armsOf(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']), runner),
      'x',
    );

    // Four successes and four failures, all eight settlements landing in one `arrived` place,
    // and four markers in `err-seen` that a single `join-fail` firing must clear.
    expect(outcome).toEqual({ status: 'failed', stepId: 'a', error: 'a!' });
    expect(held).toEqual(['wf.failed=1']);
  });

  it('holds a failure until a sibling sleep elapses, rather than stranding the sleep', async () => {
    const runner = new PacedRunner({ a: fails('a!') });
    const withSleep = {
      id: 'w',
      entries: [
        {
          kind: 'parallel',
          id: 'fan',
          arms: [
            { kind: 'step', id: 'a' },
            { kind: 'sleep', id: 'wait', durationMs: 40 },
          ],
        },
      ],
    } as const;

    const started = Date.now();
    const { outcome, held } = await run(build(withSleep, runner), 'x');

    // A divergence from `Promise.all`, and a deliberate one: the join is a count, so the
    // failure cannot be reported until every arm has settled. Rejecting early would mean
    // firing `join-fail` on a partial count and leaving the sleeper's eventual token with no
    // consumer — the stranding this whole shape exists to avoid. Documented, not accidental.
    expect(outcome).toEqual({ status: 'failed', stepId: 'a', error: 'a!' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    expect(held).toEqual(['wf.failed=1']);
  });

  it('strands nothing when an outer arm fails while a nested parallel is still in flight', async () => {
    const runner = new PacedRunner({
      a: fails('a!'),
      b: succeedsAfter('b', 30),
      c: succeedsAfter('c', 30),
    });

    const { outcome, held } = await run(build(nestedFan, runner), 'x');

    // The inner join has not settled when the outer one already has its error marker. Both
    // joins still have to reach a decision, and the inner's success token must be consumed by
    // the outer `collect`, not left sitting in `arm-1-done`.
    expect(outcome).toEqual({ status: 'failed', stepId: 'a', error: 'a!' });
    expect(held).toEqual(['wf.failed=1']);
  });

  it('strands nothing when every arm of every nesting level fails', async () => {
    const runner = new PacedRunner({ a: fails('a!'), b: fails('b!'), c: fails('c!') });

    const { outcome, held } = await run(build(nestedFan, runner), 'x');

    expect(outcome.status).toBe('failed');
    expect(held).toEqual(['wf.failed=1']);
  });

  it('strands nothing when the parallel is followed by an entry that never runs', async () => {
    const runner = new PacedRunner({ a: fails('a!'), b: succeedsAfter('b', 20), c: succeedsAfter('c', 20) });

    const { outcome, held } = await run(build(fanThenAfter, runner), 'x');

    // `after`'s input place must stay empty, and nothing may be left in the gadget either.
    expect(runner.calls).not.toContain('after');
    expect(outcome.status).toBe('failed');
    expect(held).toEqual(['wf.failed=1']);
  });

  it('keeps an arm output whose id is __proto__ as an own key of the aggregate', async () => {
    // Regression. Arm ids are arbitrary user strings, and the aggregate used to be assembled by
    // `aggregate[id] = value`. For `__proto__` that assignment is a setter call: it replaced the
    // result object's prototype instead of creating a key, so the arm's output disappeared from
    // `Object.keys` and its fields showed up on every downstream read as inherited properties.
    const runner: StepRunner = {
      async run(stepId: string): Promise<StepOutcome> {
        if (stepId === '__proto__') return { status: 'success', output: { leaked: true } };
        return { status: 'success', output: stepId };
      },
    };

    const { outcome, held } = await run(build(armsOf(['__proto__', 'b']), runner), 'x');

    expect(outcome.status).toBe('success');
    const aggregate = (outcome as { output: Record<string, unknown> }).output;
    expect(Object.keys(aggregate).sort()).toEqual(['__proto__', 'b']);
    expect(Object.prototype.hasOwnProperty.call(aggregate, '__proto__')).toBe(true);
    // The prototype is untouched, so nothing the arm returned leaks onto unrelated reads.
    expect(Object.getPrototypeOf(aggregate)).toBe(Object.prototype);
    expect((aggregate as { leaked?: unknown }).leaked).toBeUndefined();
    expect(held).toEqual(['wf.done=1']);
  });

  it('strands nothing when the step runner throws instead of returning a failure', async () => {
    const runner = new PacedRunner({
      a: () => { throw new Error('boom'); },
      b: succeedsAfter('b', 20),
    });

    const { outcome, held } = await run(build(armsOf(['a', 'b']), runner), 'x');

    // `stepAction` converts a thrown runner into the declared failure branch, so the arm still
    // settles and the join still reaches its count. A lost settlement here would hang the join.
    expect(outcome.status).toBe('failed');
    expect(held).toEqual(['wf.failed=1']);
  });
});

/**
 * These belong in `tests/verify/` by convention and live here only because this change was
 * scoped to two files. They are the claim the executor tests cannot make: the executor tests
 * say "these interleavings were fine", the proofs say "no interleaving strands a token".
 */
describe('parallel, proved', () => {
  const shapes: Record<string, WorkflowDescription> = {
    'fan-out then a successor': fanThenAfter,
    'parallel nested in a parallel arm': nestedFan,
    'an arm that never fails': {
      id: 'fan-with-sleep',
      entries: [
        {
          kind: 'parallel',
          id: 'fan',
          arms: [
            { kind: 'step', id: 'a' },
            { kind: 'sleep', id: 'wait', durationMs: 5 },
          ],
        },
      ],
    },
  };

  for (const [shape, description] of Object.entries(shapes)) {
    it(`is deadlock-free and terminates at a declared sink: ${shape}`, async () => {
      const reports = await verifyWorkflow(build(description, inertRunner));

      // `proven` explicitly. `unknown` is not a pass, and asserting "not violated" would make
      // this test vacuous the day a query times out.
      for (const report of reports) {
        expect(report.result.verdict.type, describeReport(report)).toBe('proven');
      }
      expect(reports.map((r) => r.property)).toEqual(['deadlockFree', 'terminatesAtSink']);
    }, 90_000);
  }

  // Not a test, because the mutation cannot be expressed without a second gadget, but the
  // measurement that makes the one above non-vacuous: routing each arm straight to `wf.failed`
  // instead of to the gadget-local `arm-err` turns `deadlockFree` on the first shape from
  // `proven` into **violated** — the siblings of a failed arm sit in `arrived` with no enabled
  // consumer. The proof distinguishes this design from the naive one; it does not merely pass.
});

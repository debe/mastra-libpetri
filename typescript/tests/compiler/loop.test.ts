import { describe, expect, it } from 'vitest';
import { Transition, arcPlace, requiredCount, type PetriNet, type Place } from 'libpetri';
import { compile } from '../../src/compiler/compile.js';
import { MAX_ITERATION_BOUND, loopGadget } from '../../src/compiler/gadgets/loop.js';
import type { Gadget } from '../../src/compiler/gadgets/types.js';
import type {
  EntryDescription,
  RunView,
  StepDescription,
  StepOutcome,
  WorkflowDescription,
} from '../../src/compiler/types.js';
import { runWorkflow, runWorkflowDetailed, type RunOutcome } from '../../src/engine/kernel.js';
import { RecordingRunner, type Behaviour } from '../fixtures/runner.js';

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

type LoopType = 'dowhile' | 'dountil';

const tick: StepDescription = { kind: 'step', id: 'tick' };

const loop = (loopType: LoopType, iterationBound: number, body: StepDescription = tick): EntryDescription => ({
  kind: 'loop',
  id: 'poll',
  loopType,
  iterationBound,
  body,
});

const only = (entry: EntryDescription): WorkflowDescription => ({ id: 'poller', entries: [entry] });
const between = (entry: EntryDescription): WorkflowDescription => ({
  id: 'poller',
  entries: [{ kind: 'step', id: 'prime' }, entry, { kind: 'step', id: 'ship' }],
});

const increment: Behaviour = (input) => ({ status: 'success', output: (input as number) + 1 });

interface ConditionCall {
  readonly output: unknown;
  readonly iteration: number;
  readonly path: readonly number[];
  readonly initData: unknown;
  /** What the run's step results held for the body at the moment the condition ran. */
  readonly bodyResult: StepOutcome | undefined;
}

/**
 * A runner whose `poll` condition is recorded call by call, so the `iterationCount` *sequence*
 * and what the condition saw can be asserted rather than only how many times the body ran.
 * `trace` interleaves body runs and condition evaluations, which is what "the condition is
 * evaluated after the body" is a claim about.
 */
function loopRunner(
  condition: (output: unknown, iteration: number, view: RunView) => boolean,
  steps: Record<string, Behaviour> = {},
) {
  const conditions: ConditionCall[] = [];
  const trace: string[] = [];
  const bodyInputs: unknown[] = [];
  const bodyPaths: (readonly number[])[] = [];
  const body = steps['tick'] ?? increment;
  const runner = new RecordingRunner({
    steps: {
      ...steps,
      tick: (input, call) => {
        trace.push('body');
        bodyInputs.push(input);
        bodyPaths.push(call.path);
        return body(input, call);
      },
    },
    loops: {
      poll: (output, iteration, view) => {
        trace.push(`condition ${iteration}`);
        conditions.push({ output, iteration, path: view.path, initData: view.initData, bodyResult: view.getStepResult('tick') });
        return condition(output, iteration, view);
      },
    },
  });
  return { runner, conditions, trace, bodyInputs, bodyPaths };
}

/** A condition that stops after `exitAt` iterations, phrased the way each loop type phrases it. */
const stopAfter = (loopType: LoopType, exitAt: number) => (_output: unknown, iteration: number) =>
  loopType === 'dowhile' ? iteration < exitAt : iteration >= exitAt;

/** A condition that never lets the loop settle. */
const never = (loopType: LoopType) => () => loopType === 'dowhile';

// ---------------------------------------------------------------------------------------------
// 1. What each iteration receives, and what the condition receives
// ---------------------------------------------------------------------------------------------

describe('loop: iteration semantics', () => {
  it.each([
    ['dowhile', 1],
    ['dowhile', 3],
    ['dountil', 1],
    ['dountil', 3],
  ] as const)('%s leaves after iteration %i when the condition says so', async (loopType, exitAt) => {
    const { runner, conditions } = loopRunner(stopAfter(loopType, exitAt));

    const outcome = await runWorkflow(compile(only(loop(loopType, 5))), 0, { runner });

    // A clean `toEqual`: any allowance left in `budget` would surface as `residue` here.
    expect(outcome).toEqual({ status: 'success', output: exitAt });
    expect(runner.calls).toEqual(Array.from({ length: exitAt }, () => 'tick'));
    // 1-based, one more each time (`handlers/control-flow.ts:728,847,883`), and the condition sees
    // the body's output of that same iteration (`:843`).
    expect(conditions.map((c) => c.iteration)).toEqual(Array.from({ length: exitAt }, (_, i) => i + 1));
    expect(conditions.map((c) => c.output)).toEqual(Array.from({ length: exitAt }, (_, i) => i + 1));
  });

  it.each(['dowhile', 'dountil'] as const)(
    '%s runs the body before the condition is first evaluated, on every iteration',
    async (loopType) => {
      // One `do { body; condition } while (…)` for both types (`:739-901`): neither pre-tests.
      const { runner, trace } = loopRunner(stopAfter(loopType, 2));

      await runWorkflow(compile(only(loop(loopType, 5))), 0, { runner });

      expect(trace).toEqual(['body', 'condition 1', 'body', 'condition 2']);
    },
  );

  it("feeds the first iteration the previous entry's output and every later one the previous iteration's", async () => {
    // `result` starts as the loop's input (`:730-734`), the body is called with
    // `prevOutput: result.output` (`:764`) and `result` becomes the body's result (`:780`).
    const { runner, bodyInputs } = loopRunner((output) => (output as number) < 13, {
      prime: () => ({ status: 'success', output: 10 }),
      ship: (input) => ({ status: 'success', output: `shipped:${input as number}` }),
    });

    const outcome = await runWorkflow(compile(between(loop('dowhile', 5))), 'ignored', { runner });

    expect(bodyInputs).toEqual([10, 11, 12]);
    expect(runner.calls).toEqual(['prime', 'tick', 'tick', 'tick', 'ship']);
    expect(outcome).toEqual({ status: 'success', output: 'shipped:13' });
  });

  it("runs the body at the loop's own path and hands the condition the run's view", async () => {
    // Mastra passes the loop's `executionContext` to the body unchanged (`:760`), so the body's
    // `executionPath` is the loop's — unlike a `.parallel()` arm, which gets `[...path, i]` (`:244`).
    const { runner, conditions, bodyPaths } = loopRunner((output) => (output as number) < 12, {
      prime: () => ({ status: 'success', output: 10 }),
    });

    await runWorkflow(compile(between(loop('dowhile', 5))), { order: 7 }, { runner });

    expect(bodyPaths).toEqual([[1], [1]]);
    expect(conditions.map((c) => c.path)).toEqual([[1], [1]]);
    expect(conditions.map((c) => c.initData)).toEqual([{ order: 7 }, { order: 7 }]);
    // The condition runs after the iteration's result is written (`:779` before `:835`), so
    // `getStepResult` on the body reads the iteration being judged, not the one before it.
    expect(conditions.map((c) => c.bodyResult)).toEqual([
      { status: 'success', output: 11 },
      { status: 'success', output: 12 },
    ]);
  });

  it("leaves the last iteration's result under the body's id, which is what the next entry reads", async () => {
    // The loop's result is stored under the body's id (`handlers/entry.ts:810-812`) and the
    // next entry reads `stepResults[body.id].output` (`default.ts:1150-1151`).
    const { runner } = loopRunner((output) => (output as number) < 3, {
      ship: (input) => ({ status: 'success', output: `shipped:${input as number}` }),
    });

    const report = await runWorkflowDetailed(
      compile({ id: 'poller', entries: [loop('dowhile', 5), { kind: 'step', id: 'ship' }] }),
      0,
      { runner },
    );

    expect(report.stepResults.get('tick')).toEqual({ status: 'success', output: 3 });
    expect(report.outcome).toEqual({ status: 'success', output: 'shipped:3' });
    // Nothing is recorded under the loop's own id: Mastra has no such key.
    expect(report.stepResults.has('poll')).toBe(false);
  });

  it("compiles and runs when the loop's id is its body's id, as the adapter defaults it", async () => {
    // The body shares the loop's path, so both would claim `entryIn(path, id)`. The loop's input is
    // `loop-in` precisely so that this, the common case, does not collide.
    const compiled = compile(only({ kind: 'loop', id: 'tick', loopType: 'dowhile', iterationBound: 3, body: tick }));
    const runner = new RecordingRunner({ steps: { tick: increment }, loops: { tick: (o) => (o as number) < 2 } });

    expect(await runWorkflow(compiled, 0, { runner })).toEqual({ status: 'success', output: 2 });
    const names = [...compiled.net.places].map((p) => p.name);
    expect(names).toContain('s.0.tick.loop-in');
    expect(names).toContain('s.0.tick.in');
    expect(compiled.entryPlace.name).toBe('s.0.tick.loop-in');
  });
});

// ---------------------------------------------------------------------------------------------
// 2. The iteration bound — ours, not Mastra's
// ---------------------------------------------------------------------------------------------

describe('loop: the iteration bound', () => {
  it.each(['dowhile', 'dountil'] as const)(
    'fails a %s whose condition never settles after exactly iterationBound iterations',
    async (loopType) => {
      const { runner, conditions } = loopRunner(never(loopType));

      const report = await runWorkflowDetailed(compile(only(loop(loopType, 3))), 0, { runner });

      expect(runner.calls).toEqual(['tick', 'tick', 'tick']);
      // The condition is still asked on the last iteration; the bound only refuses a fourth.
      expect(conditions.map((c) => c.iteration)).toEqual([1, 2, 3]);
      expect(report.outcome).toEqual({ status: 'failed', stepId: 'poll', error: expect.any(Error) });
      const error = (report.outcome as { error: Error }).error;
      expect(error.message).toMatch(/iterationBound of 3/);
      expect(error.message).toMatch(new RegExp(loopType));
      // The loop's failure is its result, and Mastra keeps a loop's result under the body's id.
      expect(report.stepResults.get('tick')).toEqual({ status: 'failed', error });
    },
  );

  it('runs exactly once at a bound of one: settle on the first evaluation, or fail', async () => {
    const settles = loopRunner(() => false);
    expect(await runWorkflow(compile(only(loop('dowhile', 1))), 0, { runner: settles.runner }))
      .toEqual({ status: 'success', output: 1 });
    expect(settles.runner.calls).toEqual(['tick']);

    const doesNot = loopRunner(() => true);
    const capped = await runWorkflow(compile(only(loop('dowhile', 1))), 0, { runner: doesNot.runner });
    expect(doesNot.runner.calls).toEqual(['tick']);
    expect(capped).toEqual({ status: 'failed', stepId: 'poll', error: expect.any(Error) });
  });

  it('stops the run at the bound: nothing after the loop runs', async () => {
    const { runner } = loopRunner(() => true, { prime: () => ({ status: 'success', output: 0 }) });

    const outcome = await runWorkflow(compile(between(loop('dowhile', 2))), 0, { runner });

    expect(runner.calls).toEqual(['prime', 'tick', 'tick']);
    expect(outcome).toEqual({ status: 'failed', stepId: 'poll', error: expect.any(Error) });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_ITERATION_BOUND + 1])(
    'refuses iterationBound=%s at compile',
    (bound) => {
      expect(() => compile(only(loop('dowhile', bound)))).toThrow(/iterationBound=/);
    },
  );

  it('accepts the ceiling itself', () => {
    expect(() => compile(only(loop('dowhile', MAX_ITERATION_BOUND)))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// 3. A non-success iteration ends the loop with that result (`:791-801`)
// ---------------------------------------------------------------------------------------------

/**
 * Each case leaves on the **second** of five allowed iterations, so three allowance tokens and —
 * on the body paths — the pending marker have to be cleared on the way out. `toEqual` on the
 * outcome is the leak check: a token left anywhere surfaces as a `residue` key and fails it.
 */
describe('loop: every non-success iteration leaves, and leaves nothing behind', () => {
  const secondIteration = (outcome: StepOutcome): Behaviour => (input, call) =>
    (input as number) === 1 ? outcome : increment(input, call);

  const cases: ReadonlyArray<readonly [string, StepDescription, StepOutcome, RunOutcome]> = [
    [
      'a failure',
      tick,
      { status: 'failed', error: 'card declined' },
      { status: 'failed', stepId: 'tick', error: 'card declined' },
    ],
    [
      'a tripwire, which rides the failure path',
      tick,
      { status: 'failed', error: 'blocked', tripwire: { reason: 'policy' } },
      { status: 'tripwire', stepId: 'tick', tripwire: { reason: 'policy' } },
    ],
    [
      'a bail, which ends the run as a success',
      tick,
      { status: 'bailed', output: 'early' },
      { status: 'success', output: 'early', bailed: true },
    ],
    [
      "a suspension, recorded at the loop's path",
      tick,
      { status: 'suspended', payload: { ask: 'approve' } },
      { status: 'suspended', stepId: 'tick', path: [0], payload: { ask: 'approve' } },
    ],
    [
      'a nested workflow pausing',
      { kind: 'step', id: 'tick', source: 'workflow' },
      { status: 'paused' },
      { status: 'paused', stepId: 'tick', path: [0] },
    ],
  ];

  it.each(cases)('%s', async (_name, body, bodyOutcome, expected) => {
    const { runner, conditions } = loopRunner(() => true, { tick: secondIteration(bodyOutcome), ship: increment });

    const report = await runWorkflowDetailed(
      compile({ id: 'poller', entries: [loop('dowhile', 5, body), { kind: 'step', id: 'ship' }] }),
      0,
      { runner },
    );

    expect(report.outcome).toEqual(expected);
    // Two body runs, then the loop is over: the condition judged only the iteration that
    // succeeded, and the step after the loop never ran.
    expect(runner.calls).toEqual(['tick', 'tick']);
    expect(conditions.map((c) => c.iteration)).toEqual([1]);
    // The leaf recorded the final outcome, which is the loop's result under the body's id — except
    // that a bail which ends the run is rewritten to 'success', as Mastra rewrites the object its
    // stepResults holds (`default.ts:926-928`).
    expect(report.stepResults.get('tick')).toEqual(
      bodyOutcome.status === 'bailed' ? { status: 'success', output: bodyOutcome.output } : bodyOutcome,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Conditions that cannot answer
// ---------------------------------------------------------------------------------------------

describe('loop: a condition that cannot answer fails the run', () => {
  it('fails the run when the condition throws — Mastra rejects run.start() instead', async () => {
    const boom = new Error('condition provider down');
    const { runner } = loopRunner((_o, iteration) => {
      if (iteration === 2) throw boom;
      return true;
    });

    const report = await runWorkflowDetailed(
      compile({ id: 'poller', entries: [loop('dowhile', 5), { kind: 'step', id: 'ship' }] }),
      0,
      { runner },
    );

    // Three allowance tokens are still unspent here, so a missing reset on `abort` would show.
    expect(report.outcome).toEqual({ status: 'failed', stepId: 'poll', error: boom });
    expect(runner.calls).toEqual(['tick', 'tick']);
    expect(report.stepResults.get('tick')).toEqual({ status: 'failed', error: boom });
  });

  it('fails before the body runs when the runner cannot evaluate conditions at all', async () => {
    const runner = new RecordingRunner({ steps: { tick: increment } });

    const outcome = await runWorkflow(compile(only(loop('dowhile', 5))), 0, { runner });

    expect(outcome).toEqual({ status: 'failed', stepId: 'poll', error: expect.any(Error) });
    expect(String((outcome as { error: unknown }).error)).toMatch(/evaluateLoopCondition/);
    // No side effect ran for a loop that could never decide whether to repeat.
    expect(runner.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. A retrying body
// ---------------------------------------------------------------------------------------------

describe('loop: a body with retries', () => {
  const retrying: StepDescription = { kind: 'step', id: 'tick', retries: 1 };

  it('retries within an iteration and starts every iteration with a fresh set of attempts', async () => {
    // Each iteration runs the step handler afresh (`control-flow.ts:755` ->
    // `handlers/step.ts:320` -> `default.ts:455`), so the attempt count restarts: iteration 1
    // needs its retry, iteration 2 does not.
    const { runner, conditions } = loopRunner((output) => (output as number) < 2, {
      tick: (input, call) =>
        (input as number) === 0 && call.attempt === 0 ? { status: 'failed', error: 'flaky' } : increment(input, call),
    });

    const outcome = await runWorkflow(compile(only(loop('dowhile', 5, retrying))), 0, { runner });

    expect(outcome).toEqual({ status: 'success', output: 2 });
    expect(runner.attempts).toEqual([
      { stepId: 'tick', attempt: 0 },
      { stepId: 'tick', attempt: 1 },
      { stepId: 'tick', attempt: 0 },
    ]);
    // A retried attempt is not an iteration: the condition was asked twice, not three times.
    expect(conditions.map((c) => c.iteration)).toEqual([1, 2]);
  });

  it('fails the loop when an iteration exhausts its retries', async () => {
    const { runner } = loopRunner(() => true, {
      tick: (input, call) => ((input as number) === 1 ? { status: 'failed', error: 'down' } : increment(input, call)),
    });

    const outcome = await runWorkflow(compile(only(loop('dowhile', 5, retrying))), 0, { runner });

    expect(outcome).toEqual({ status: 'failed', stepId: 'tick', error: 'down' });
    expect(runner.attempts).toEqual([
      { stepId: 'tick', attempt: 0 },
      { stepId: 'tick', attempt: 0 },
      { stepId: 'tick', attempt: 1 },
    ]);
  });

  it('does not retry a non-retryable failure inside the loop', async () => {
    const { runner } = loopRunner(() => true, {
      tick: () => ({ status: 'failed', error: 'fatal', nonRetryable: true }),
    });

    const outcome = await runWorkflow(compile(only(loop('dowhile', 5, retrying))), 0, { runner });

    expect(outcome).toEqual({ status: 'failed', stepId: 'tick', error: 'fatal' });
    expect(runner.attempts).toEqual([{ stepId: 'tick', attempt: 0 }]);
  });
});

// ---------------------------------------------------------------------------------------------
// 6. The shape the bound rests on
// ---------------------------------------------------------------------------------------------

function role<T>(net: PetriNet, suffix: string): Place<T> {
  const matches = [...net.places].filter((p) => p.name.endsWith(suffix));
  if (matches.length !== 1) throw new Error(`expected one place ending '${suffix}', got ${matches.length}`);
  return matches[0] as Place<T>;
}

const tail = (t: Transition): string => t.name.split('.').pop()!;

describe('loop: the shape the bound rests on', () => {
  const net = compile(only(loop('dowhile', 5))).net;
  const budget = role(net, '.poll.budget');
  const ready = role(net, '.poll.ready');
  const running = role(net, '.poll.running');
  const transition = (name: string) => [...net.transitions].find((t) => tail(t) === name && t.name.includes('.poll.'))!;

  it('spends the allowance one token per iteration and never refills it mid-loop', () => {
    const producers = [...net.transitions].filter((t) => t.outputPlaces().has(budget));
    const consumers = [...net.transitions].filter((t) => t.inputPlaces().has(budget));

    expect(producers.map(tail)).toEqual(['start']);
    expect(consumers.map(tail)).toEqual(['enter']);
    const spec = consumers[0]!.inputSpecs.find((s) => s.place === budget)!;
    expect(spec.type).toBe('one');
    expect(requiredCount(spec)).toBe(1);
  });

  it('decides the bound by topology: an inhibitor arc, not a number an action reads', () => {
    const enter = transition('enter');
    const exhaust = transition('exhaust');

    expect(enter.inputPlaces().has(ready)).toBe(true);
    expect(enter.inputPlaces().has(budget)).toBe(true);
    expect(exhaust.inputPlaces().has(ready)).toBe(true);
    expect(exhaust.inhibitors.map(arcPlace)).toEqual([budget]);
    expect(exhaust.inputPlaces().has(budget)).toBe(false);
  });

  it('clears the unspent allowance on every way out except exhaustion, and nowhere else', () => {
    const resetters = [...net.transitions].filter((t) => t.resets.map(arcPlace).includes(budget)).map(tail).sort();

    // Not `check`, which also fires on the repeat branch; not `exhaust`, which only fires once
    // the allowance is gone; not `start`, which runs once per run and finds the place empty.
    expect(resetters).toEqual(['abort', 'finish', 'leave-bailed', 'leave-failed', 'leave-paused', 'leave-suspended']);
  });

  it('consumes the pending marker on every path and never resets it', () => {
    const producers = [...net.transitions].filter((t) => t.outputPlaces().has(running)).map(tail);
    const consumers = [...net.transitions].filter((t) => t.inputPlaces().has(running));

    expect(producers).toEqual(['enter']);
    expect(consumers.map(tail).sort()).toEqual([
      'check',
      'leave-bailed',
      'leave-failed',
      'leave-paused',
      'leave-suspended',
    ]);
    for (const t of consumers) expect(t.inputSpecs.find((s) => s.place === running)!.type).toBe('one');
    expect([...net.transitions].filter((t) => t.resets.map(arcPlace).includes(running))).toEqual([]);
  });

  it('declares repeat, exit and a failing condition as one Xor', () => {
    const check = transition('check');
    expect(check.outputSpec!.type).toBe('xor');
    expect([...check.outputPlaces()].map((p) => p.name.split('.').pop()).sort()).toEqual(['exiting', 'failing', 'ready']);
  });

  it('gives every non-terminal place a consumer', () => {
    const compiled = compile(only(loop('dowhile', 5)));
    const terminals = new Set(Object.values(compiled.terminals).map((p) => p.name));

    for (const p of compiled.net.places) {
      if (terminals.has(p.name)) continue;
      const consumed = [...compiled.net.transitions].some(
        (t) => t.inputPlaces().has(p) || t.resets.map(arcPlace).includes(p),
      );
      expect(consumed, `'${p.name}' has no consumer`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 7. Non-vacuity: every cleanup arc is load-bearing at run time
// ---------------------------------------------------------------------------------------------

interface Mutation {
  readonly dropReset?: string;
  readonly dropInput?: string;
}

/** Rebuilds one transition with one arc removed; everything else is copied verbatim. */
function rebuild(t: Transition, m: Mutation): Transition {
  const ends = (suffix: string | undefined) => (p: Place<unknown>) => suffix !== undefined && p.name.endsWith(suffix);
  const b = Transition.builder(t.name)
    .inputs(...t.inputSpecs.filter((s) => !ends(m.dropInput)(s.place)))
    .inhibitors(...t.inhibitors.map(arcPlace))
    .reads(...t.reads.map(arcPlace))
    .resets(...t.resets.map(arcPlace).filter((p) => !ends(m.dropReset)(p)))
    .timing(t.timing)
    .priority(t.priority)
    .action(t.action);
  if (t.outputSpec !== null) b.outputs(t.outputSpec);
  const built = b.build();
  const before = t.inputSpecs.length + t.resets.length;
  if (built.inputSpecs.length + built.resets.length !== before - 1) {
    throw new Error(`mutation ${JSON.stringify(m)} removed nothing from '${t.name}'`);
  }
  return built;
}

/** The real gadget with one arc of one transition removed — src is never edited. */
function mutated(transitionRole: string, m: Mutation): Gadget {
  return (entry, next, ctx) => {
    const result = loopGadget(entry, next, ctx);
    const hits = result.transitions.filter((t) => t.name.endsWith(`.${transitionRole}`));
    if (hits.length !== 1) throw new Error(`expected one '${transitionRole}' transition, got ${hits.length}`);
    return { ...result, transitions: result.transitions.map((t) => (hits.includes(t) ? rebuild(t, m) : t)) };
  };
}

/**
 * For each exit, the same run twice: with the real gadget the outcome is clean, and with that
 * exit's cleanup arc removed the leftover tokens surface as residue. Each case leaves on the
 * second of five iterations, so three allowance tokens are outstanding.
 */
describe('loop: removing any cleanup arc strands tokens (non-vacuity)', () => {
  const bodyOn2 = (outcome: StepOutcome): Behaviour => (input, call) =>
    (input as number) === 1 ? outcome : increment(input, call);

  const scenarios: ReadonlyArray<
    readonly [string, Mutation, () => ReturnType<typeof loopRunner>, StepDescription, RunOutcome, readonly string[]]
  > = [
    ['finish', { dropReset: '.budget' }, () => loopRunner((o) => (o as number) < 2), tick,
      { status: 'success', output: 2 }, ['s.0.poll.budget=3']],
    ['abort', { dropReset: '.budget' }, () => loopRunner((_o, i) => { if (i === 2) throw 'x'; return true; }), tick,
      { status: 'failed', stepId: 'poll', error: 'x' }, ['s.0.poll.budget=3']],
    ['leave-failed', { dropReset: '.budget' }, () => loopRunner(() => true, { tick: bodyOn2({ status: 'failed', error: 'e' }) }), tick,
      { status: 'failed', stepId: 'tick', error: 'e' }, ['s.0.poll.budget=3']],
    ['leave-bailed', { dropReset: '.budget' }, () => loopRunner(() => true, { tick: bodyOn2({ status: 'bailed', output: 'b' }) }), tick,
      { status: 'success', output: 'b', bailed: true }, ['s.0.poll.budget=3']],
    ['leave-suspended', { dropReset: '.budget' }, () => loopRunner(() => true, { tick: bodyOn2({ status: 'suspended', payload: 'p' }) }), tick,
      { status: 'suspended', stepId: 'tick', path: [0], payload: 'p' }, ['s.0.poll.budget=3']],
    ['leave-paused', { dropReset: '.budget' }, () => loopRunner(() => true, { tick: bodyOn2({ status: 'paused' }) }),
      { kind: 'step', id: 'tick', source: 'workflow' },
      { status: 'paused', stepId: 'tick', path: [0] }, ['s.0.poll.budget=3']],
    ['leave-bailed', { dropInput: '.running' }, () => loopRunner(() => true, { tick: bodyOn2({ status: 'bailed', output: 'b' }) }), tick,
      { status: 'success', output: 'b', bailed: true }, ['s.0.poll.running']],
  ];

  it.each(scenarios)('%s without %o', async (transitionRole, mutation, makeRunner, body, clean, residue) => {
    const description = only(loop('dowhile', 5, body));

    const real = await runWorkflow(compile(description), 0, { runner: makeRunner().runner });
    const broken = await runWorkflow(
      compile(description, { gadgets: { loop: mutated(transitionRole, mutation) } }),
      0,
      { runner: makeRunner().runner },
    );

    expect(real).toEqual(clean);
    expect(broken).toEqual({ ...clean, residue });
  });
});

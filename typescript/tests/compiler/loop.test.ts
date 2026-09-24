import { describe, expect, it } from 'vitest';
import { Transition, arcPlace, one, outPlace, place, requiredCount, type PetriNet, type Place } from 'libpetri';
import { compile } from '../../src/compiler/compile.js';
import { MAX_ITERATION_BOUND, loopGadget } from '../../src/compiler/gadgets/loop.js';
import type { Gadget } from '../../src/compiler/gadgets/types.js';
import type {
  CanceledToken,
  EntryDescription,
  RunView,
  StepDescription,
  StepOutcome,
  StepRecord,
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
  readonly bodyResult: StepRecord | undefined;
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
    expect(conditions.map((c) => c.bodyResult)).toMatchObject([
      { status: 'success', output: 11, payload: 10, metadata: { iterationCount: 1 } },
      { status: 'success', output: 12, payload: 11, metadata: { iterationCount: 2 } },
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

    expect(report.stepResults.get('tick')).toMatchObject({
      status: 'success',
      output: 3,
      payload: 2,
      metadata: { iterationCount: 3 },
    });
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
      expect(report.outcome).toEqual({ status: 'failed', stepId: 'tick', path: [0], error: expect.any(Error) });
      const error = (report.outcome as { error: Error }).error;
      expect(error.message).toMatch(/iterationBound of 3/);
      expect(error.message).toMatch(new RegExp(loopType));
      // The loop's failure is its result, and Mastra keeps a loop's result under the body's id —
      // with the payload of the iteration that last ran.
      expect(report.stepResults.get('tick')).toMatchObject({ status: 'failed', error, payload: 2, metadata: { iterationCount: 3 } });
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
    expect(capped).toEqual({ status: 'failed', stepId: 'tick', path: [0], error: expect.any(Error) });
  });

  it('stops the run at the bound: nothing after the loop runs', async () => {
    const { runner } = loopRunner(() => true, { prime: () => ({ status: 'success', output: 0 }) });

    const outcome = await runWorkflow(compile(between(loop('dowhile', 2))), 0, { runner });

    expect(runner.calls).toEqual(['prime', 'tick', 'tick']);
    expect(outcome).toEqual({ status: 'failed', stepId: 'tick', path: [1], error: expect.any(Error) });
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
      { status: 'failed', stepId: 'tick', path: [0], error: 'card declined' },
    ],
    [
      'a tripwire, which rides the failure path',
      tick,
      { status: 'failed', error: 'blocked', tripwire: { reason: 'policy' } },
      // The outcome carries the failure's `error` beside the tripwire (contract change).
      { status: 'tripwire', stepId: 'tick', path: [0], tripwire: { reason: 'policy' }, error: 'blocked' },
    ],
    [
      'a bail, which ends the run as a success',
      tick,
      { status: 'bailed', output: 'early' },
      // A bail names the step that bailed (contract change): the body, at the loop's path.
      { status: 'success', output: 'early', bailed: true, stepId: 'tick', path: [0] },
    ],
    [
      "a suspension, recorded at the loop's path",
      tick,
      { status: 'suspended', suspendPayload: { ask: 'approve' } },
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
    expect(report.stepResults.get('tick')).toMatchObject({
      ...(bodyOutcome.status === 'bailed' ? { status: 'success', output: bodyOutcome.output } : bodyOutcome),
      payload: 1,
      metadata: { iterationCount: 2 },
    });
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
    // Named by the body, where the loop's result lives (`handlers/entry.ts:810-812`).
    expect(report.outcome).toEqual({ status: 'failed', stepId: 'tick', path: [0], error: boom });
    expect(runner.calls).toEqual(['tick', 'tick']);
    expect(report.stepResults.get('tick')).toMatchObject({ status: 'failed', error: boom, payload: 1, metadata: { iterationCount: 2 } });
  });

  it('fails before the body runs when the runner cannot evaluate conditions at all', async () => {
    const runner = new RecordingRunner({ steps: { tick: increment } });

    const outcome = await runWorkflow(compile(only(loop('dowhile', 5))), 0, { runner });

    expect(outcome).toEqual({ status: 'failed', stepId: 'tick', path: [0], error: expect.any(Error) });
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

    expect(outcome).toEqual({ status: 'failed', stepId: 'tick', path: [0], error: 'down' });
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

    expect(outcome).toEqual({ status: 'failed', stepId: 'tick', path: [0], error: 'fatal' });
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
    // The allowance, and the cancellation signal (Mastra's :889 check precedes any next iteration).
    expect(exhaust.inhibitors.map(arcPlace).map((p) => p.name)).toEqual([budget.name, 'wf.cancel']);
    expect(exhaust.inputPlaces().has(budget)).toBe(false);
  });

  it('clears the unspent allowance on every way out except exhaustion, and nowhere else', () => {
    const resetters = [...net.transitions].filter((t) => t.resets.map(arcPlace).includes(budget)).map(tail).sort();

    // Not `check`, which also fires on the repeat branch; not `exhaust`, which only fires once
    // the allowance is gone; not `start`, which runs once per run and finds the place empty.
    // The three cancellation sweeps after `start` clear it too.
    expect(resetters).toEqual([
      'abort',
      'cancel-exiting',
      'cancel-produced',
      'cancel-ready',
      'finish',
      'leave-bailed',
      'leave-failed',
      'leave-paused',
      'leave-suspended',
    ]);
  });

  it('consumes the pending marker on every path and never resets it', () => {
    const producers = [...net.transitions].filter((t) => t.outputPlaces().has(running)).map(tail);
    const consumers = [...net.transitions].filter((t) => t.inputPlaces().has(running));

    expect(producers).toEqual(['enter']);
    expect(consumers.map(tail).sort()).toEqual([
      'cancel-produced',
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
    // The cancellation signal is the environment's: nothing consumes it, by design.
    const terminals = new Set([...Object.values(compiled.terminals).map((p) => p.name), compiled.cancel.name]);

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
  readonly dropInhibitor?: string;
}

/** Rebuilds one transition with one arc removed; everything else is copied verbatim. */
function rebuild(t: Transition, m: Mutation): Transition {
  const ends = (suffix: string | undefined) => (p: Place<unknown>) => suffix !== undefined && p.name.endsWith(suffix);
  const b = Transition.builder(t.name)
    .inputs(...t.inputSpecs.filter((s) => !ends(m.dropInput)(s.place)))
    .inhibitors(...t.inhibitors.map(arcPlace).filter((p) => !ends(m.dropInhibitor)(p)))
    .reads(...t.reads.map(arcPlace))
    .resets(...t.resets.map(arcPlace).filter((p) => !ends(m.dropReset)(p)))
    .timing(t.timing)
    .priority(t.priority)
    .action(t.action);
  if (t.outputSpec !== null) b.outputs(t.outputSpec);
  const built = b.build();
  const arcs = (x: Transition) => x.inputSpecs.length + x.resets.length + x.inhibitors.length;
  if (arcs(built) !== arcs(t) - 1) {
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
      { status: 'failed', stepId: 'tick', path: [0], error: 'x' }, ['s.0.poll.budget=3']],
    ['leave-failed', { dropReset: '.budget' }, () => loopRunner(() => true, { tick: bodyOn2({ status: 'failed', error: 'e' }) }), tick,
      { status: 'failed', stepId: 'tick', path: [0], error: 'e' }, ['s.0.poll.budget=3']],
    ['leave-bailed', { dropReset: '.budget' }, () => loopRunner(() => true, { tick: bodyOn2({ status: 'bailed', output: 'b' }) }), tick,
      { status: 'success', output: 'b', bailed: true, stepId: 'tick', path: [0] }, ['s.0.poll.budget=3']],
    ['leave-suspended', { dropReset: '.budget' }, () => loopRunner(() => true, { tick: bodyOn2({ status: 'suspended', suspendPayload: 'p' }) }), tick,
      { status: 'suspended', stepId: 'tick', path: [0], payload: 'p' }, ['s.0.poll.budget=3']],
    ['leave-paused', { dropReset: '.budget' }, () => loopRunner(() => true, { tick: bodyOn2({ status: 'paused' }) }),
      { kind: 'step', id: 'tick', source: 'workflow' },
      { status: 'paused', stepId: 'tick', path: [0] }, ['s.0.poll.budget=3']],
    ['leave-bailed', { dropInput: '.running' }, () => loopRunner(() => true, { tick: bodyOn2({ status: 'bailed', output: 'b' }) }), tick,
      { status: 'success', output: 'b', bailed: true, stepId: 'tick', path: [0] }, ['s.0.poll.running']],
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

// ---------------------------------------------------------------------------------------------
// 8. Iteration metadata (`handlers/step.ts:177`, `control-flow.ts:771`)
// ---------------------------------------------------------------------------------------------

describe('loop: iteration metadata', () => {
  it('stamps each iteration 1-based on the body record, and nothing on the entry after the loop', async () => {
    const seen: (StepRecord | undefined)[] = [];
    const { runner } = loopRunner(
      (output, _i, view) => {
        seen.push(view.getStepResult('tick'));
        return (output as number) < 3;
      },
      { ship: increment },
    );

    const report = await runWorkflowDetailed(
      compile({ id: 'poller', entries: [loop('dowhile', 5), { kind: 'step', id: 'ship' }] }),
      0,
      { runner },
    );

    expect(report.outcome).toEqual({ status: 'success', output: 4 });
    expect(seen.map((r) => r?.metadata)).toEqual([{ iterationCount: 1 }, { iterationCount: 2 }, { iterationCount: 3 }]);
    expect(seen.map((r) => r?.payload)).toEqual([0, 1, 2]);
    for (const r of seen) {
      expect(typeof r?.startedAt).toBe('number');
      expect(typeof r?.endedAt).toBe('number');
    }
    // The iteration ends at the loop's exit: the next entry is not an iteration.
    expect(report.stepResults.get('ship')).toMatchObject({ status: 'success', output: 4, payload: 3 });
    expect(report.stepResults.get('ship')!.metadata).toBeUndefined();
  });

  it('stamps the iteration on a failing and a suspending iteration too', async () => {
    const failing = loopRunner(() => true, {
      tick: (input, call) => ((input as number) === 2 ? { status: 'failed', error: 'x' } : increment(input, call)),
    });
    const r1 = await runWorkflowDetailed(compile(only(loop('dowhile', 5))), 0, { runner: failing.runner });
    expect(r1.stepResults.get('tick')).toMatchObject({ status: 'failed', payload: 2, metadata: { iterationCount: 3 } });

    const suspending = loopRunner(() => true, {
      tick: (input, call) => ((input as number) === 1 ? { status: 'suspended', suspendPayload: 'ask' } : increment(input, call)),
    });
    const r2 = await runWorkflowDetailed(compile(only(loop('dowhile', 5))), 0, { runner: suspending.runner });
    expect(r2.outcome).toEqual({ status: 'suspended', stepId: 'tick', path: [0], payload: 'ask' });
    expect(r2.stepResults.get('tick')).toMatchObject({
      status: 'suspended',
      suspendPayload: 'ask',
      payload: 1,
      metadata: { iterationCount: 2 },
    });
  });
});

// ---------------------------------------------------------------------------------------------
// 9. Re-entry from a record (`handlers/control-flow.ts:727-734`, divergences row 27)
// ---------------------------------------------------------------------------------------------

describe('loop: starting from a record already under the body id', () => {
  it(".then(s) then a loop over s: the loop re-feeds s's payload, not its output, and counts from 1", async () => {
    // `loopInput = stepResults[s].payload` whenever that own property exists (:729-733): the
    // `.then(s)` record holds payload 0 and output 1, and the loop's first iteration gets 0.
    const { runner, bodyInputs, conditions } = loopRunner((output) => (output as number) < 2);

    const report = await runWorkflowDetailed(
      compile({ id: 'poller', entries: [{ kind: 'step', id: 'tick' }, loop('dowhile', 5)] }),
      0,
      { runner },
    );

    expect(bodyInputs).toEqual([0, 0, 1]);
    // The `.then(s)` record carries no iterationCount, so `iteration` starts at 0 (:727-728).
    expect(conditions.map((c) => c.iteration)).toEqual([1, 2]);
    expect(report.outcome).toEqual({ status: 'success', output: 2 });
    expect(report.stepResults.get('tick')).toMatchObject({ payload: 1, output: 2, metadata: { iterationCount: 2 } });
  });

  it('continues iterationCount from a carried-in record, whatever its status, from its payload', async () => {
    // A suspended third iteration, as a resume would carry it in: the loop re-runs iteration 3
    // (`iteration = 3 - 1`, then `iterationCount: iteration + 1`) on the recorded payload.
    for (const status of ['suspended', 'success', 'failed'] as const) {
      const prior: StepRecord =
        status === 'suspended'
          ? { status, suspendPayload: 'ask', payload: 5, metadata: { iterationCount: 3 } }
          : status === 'success'
            ? { status, output: 99, payload: 5, metadata: { iterationCount: 3 } }
            : { status, error: 'old', payload: 5, metadata: { iterationCount: 3 } };
      const { runner, bodyInputs, conditions } = loopRunner((output) => (output as number) < 7);

      const report = await runWorkflowDetailed(compile(only(loop('dowhile', 5))), 'ignored', {
        runner,
        stepResults: new Map([['tick', prior]]),
      });

      expect(bodyInputs, status).toEqual([5, 6]);
      expect(conditions.map((c) => c.iteration), status).toEqual([3, 4]);
      expect(report.outcome, status).toEqual({ status: 'success', output: 7 });
      expect(report.stepResults.get('tick'), status).toMatchObject({ payload: 6, metadata: { iterationCount: 4 } });
    }
  });

  it("falls back to the previous entry's output when the record has no own payload", async () => {
    // `Object.prototype.hasOwnProperty.call(prevStepResult, 'payload')` (:731): a record without
    // the key does not feed the loop, but its iterationCount still does.
    const prior = { status: 'success', output: 'x', metadata: { iterationCount: 2 } } as unknown as StepRecord;
    const { runner, bodyInputs, conditions } = loopRunner(() => false);

    await runWorkflowDetailed(compile(only(loop('dowhile', 5))), 10, { runner, stepResults: new Map([['tick', prior]]) });

    expect(bodyInputs).toEqual([10]);
    expect(conditions.map((c) => c.iteration)).toEqual([2]);
  });

  it('treats an iterationCount of 0 as absent, as the truthiness test at :728 does', async () => {
    const prior: StepRecord = { status: 'success', output: 1, payload: 4, metadata: { iterationCount: 0 } };
    const { runner, conditions } = loopRunner(() => false);

    await runWorkflowDetailed(compile(only(loop('dowhile', 5))), 0, { runner, stepResults: new Map([['tick', prior]]) });

    expect(conditions.map((c) => c.iteration)).toEqual([1]);
  });

  it('re-enters from a bare canceled record as Mastra does: no payload, no count, so from the input at 1', async () => {
    // :727-734 never look at the status. Mastra's canceled record is bare (`entry.ts:811`), so
    // `hasOwnProperty(payload)` is false and `iterationCount` is undefined: the loop starts from
    // the previous entry's output at iteration 0, exactly as if nothing were there.
    const prior: StepRecord = { status: 'canceled' };
    const { runner, bodyInputs, conditions } = loopRunner((output) => (output as number) < 12);

    const report = await runWorkflowDetailed(compile(only(loop('dowhile', 5))), 10, {
      runner,
      stepResults: new Map([['tick', prior]]),
    });

    expect(bodyInputs).toEqual([10, 11]);
    expect(conditions.map((c) => c.iteration)).toEqual([1, 2]);
    expect(report.outcome).toEqual({ status: 'success', output: 12 });
    // The canceled record is replaced by the first iteration's, as any record would be.
    expect(report.stepResults.get('tick')).toMatchObject({ status: 'success', payload: 11, metadata: { iterationCount: 2 } });
  });

  it('re-enters from a canceled record that does carry a payload and a count, the fields winning over the status', async () => {
    // A foreach-shaped or host-written canceled record may carry the fields; Mastra would read them.
    const prior: StepRecord = { status: 'canceled', payload: 5, metadata: { iterationCount: 3 } };
    const { runner, bodyInputs, conditions } = loopRunner((output) => (output as number) < 7);

    await runWorkflowDetailed(compile(only(loop('dowhile', 5))), 'ignored', { runner, stepResults: new Map([['tick', prior]]) });

    expect(bodyInputs).toEqual([5, 6]);
    expect(conditions.map((c) => c.iteration)).toEqual([3, 4]);
  });

  it('gives a re-entered loop a fresh allowance: the bound counts body runs of this entry', async () => {
    const prior: StepRecord = { status: 'suspended', suspendPayload: undefined, payload: 0, metadata: { iterationCount: 10 } };
    const { runner, conditions } = loopRunner(() => true);

    const outcome = await runWorkflow(compile(only(loop('dowhile', 2))), 0, { runner, stepResults: new Map([['tick', prior]]) });

    expect(conditions.map((c) => c.iteration)).toEqual([10, 11]);
    expect(outcome).toEqual({ status: 'failed', stepId: 'tick', path: [0], error: expect.any(Error) });
    expect(String((outcome as { error: unknown }).error)).toMatch(/iterationBound of 2.*iterationCount 11/);
  });
});

// ---------------------------------------------------------------------------------------------
// 10. Cancellation (`default.ts:815`, `handlers/control-flow.ts:742,807,889`)
// ---------------------------------------------------------------------------------------------

/**
 * Every case asserts the outcome with `toEqual`, so a budget or marker token left behind by a
 * canceled loop surfaces as `residue` and fails it.
 *
 * **The canceled record.** Once the loop has started, Mastra's canceled result is stored under the
 * body's id as a bare `{ status: 'canceled' }` (`handlers/entry.ts:810-812`, from
 * `control-flow.ts:752/817/899`), **replacing** the last iteration's record — so each case after
 * `start` asserts the record with `toEqual`, which fails on any payload, timestamp or metadata
 * left over from the iteration. Before `start` (`default.ts:815`) nothing is stored.
 */
describe('loop: cancellation', () => {
  // The loop's result lives under the body's id, so its cancellation names the body. `started`
  // tells the two sweep families apart: `cancel-in`, before the loop's first transition, reports
  // work that never began; `cancel-ready` / `cancel-produced` / `cancel-exiting`, after `start`,
  // report a loop that had (and each records the bare canceled result).
  const canceledAtLoop = { status: 'canceled', origin: { stepId: 'tick', path: [0] }, started: true } as const;
  const canceledBeforeLoop = { status: 'canceled', origin: { stepId: 'tick', path: [0] }, started: false } as const;
  const bareCanceled = { status: 'canceled' } as const;

  // A pre-aborted run seeds the signal itself (the arrival window this once pinned is closed in the
  // kernel), so `cancel-in` fires and the loop never began: `started: false`.
  it('never starts when the signal fired before the entry: nothing runs, nothing is recorded', async () => {
    const ac = new AbortController();
    ac.abort();
    const { runner, conditions } = loopRunner(() => true);

    const report = await runWorkflowDetailed(compile(only(loop('dowhile', 5))), 0, { runner, signal: ac.signal });

    expect(report.outcome).toEqual(canceledBeforeLoop);
    expect(runner.calls).toEqual([]);
    expect(conditions).toEqual([]);
    expect(report.stepResults.has('tick')).toBe(false);
  });

  it('is canceled at its start when an earlier entry aborts; the body never runs', async () => {
    const ac = new AbortController();
    const { runner } = loopRunner(() => true, {
      prime: () => {
        ac.abort();
        return { status: 'success', output: 0 };
      },
    });

    const outcome = await runWorkflow(compile(between(loop('dowhile', 5))), 0, { runner, signal: ac.signal });

    expect(outcome).toEqual({ status: 'canceled', origin: { stepId: 'tick', path: [1] }, started: false });
    expect(runner.calls).toEqual(['prime']);
  });

  it('records the bare canceled result when the cancel lands after start, before the first body run (:742)', async () => {
    // A cancel that arrives between `start` and `enter` is Mastra's first :742 check: the loop has
    // been entered, so `entry.ts:811` stores its canceled result — replacing the record the
    // `.then(tick)` before it left under the same id. Driven by a gadget wrapper that aborts from
    // `start`'s action, the only way to land a cancel in exactly that interval.
    const ac = new AbortController();
    const abortingStart: Gadget = (entry, next, ctx) => {
      const result = loopGadget(entry, next, ctx);
      return {
        ...result,
        transitions: result.transitions.map((t) => {
          if (!t.name.endsWith('.start')) return t;
          const b = Transition.builder(t.name)
            .inputs(...t.inputSpecs)
            .inhibitors(...t.inhibitors.map(arcPlace))
            .reads(...t.reads.map(arcPlace))
            .resets(...t.resets.map(arcPlace))
            .timing(t.timing)
            .priority(t.priority)
            .action(async (c) => {
              await t.action(c);
              ac.abort();
              // Hold `start` open until the arrival has landed, so `ready` appears with the signal
              // already marked. Without the hold the request and `ready` land in one executor
              // cycle and `enter` fires beside `arrive` — the arrival window reported to the lead,
              // which the pre-aborted tests above pin; this test is about the sweep, not that.
              await new Promise((resolve) => setTimeout(resolve, 5));
            });
          b.outputs(t.outputSpec!);
          return b.build();
        }),
      };
    };
    const { runner } = loopRunner(() => true);

    const report = await runWorkflowDetailed(
      compile({ id: 'poller', entries: [{ kind: 'step', id: 'tick' }, loop('dowhile', 5)] }, { gadgets: { loop: abortingStart } }),
      0,
      { runner, signal: ac.signal },
    );

    // `cancel-ready`: the loop had started.
    expect(report.outcome).toEqual({ status: 'canceled', origin: { stepId: 'tick', path: [1] }, started: true });
    // Only the `.then(tick)` ran; the loop's body never did.
    expect(runner.calls).toEqual(['tick']);
    expect(report.stepResults.get('tick')).toEqual(bareCanceled);
  });

  it('lets a running body finish, then skips the condition (:807)', async () => {
    const ac = new AbortController();
    const { runner, conditions } = loopRunner(() => true, {
      tick: (input, call) => {
        ac.abort();
        return increment(input, call);
      },
    });

    const report = await runWorkflowDetailed(compile(between(loop('dowhile', 5))), 0, { runner, signal: ac.signal });

    // `cancel-produced`: a body had run.
    expect(report.outcome).toEqual({ status: 'canceled', origin: { stepId: 'tick', path: [1] }, started: true });
    expect(runner.calls).toEqual(['prime', 'tick']);
    expect(conditions).toEqual([]);
    // The iteration's success record is replaced by Mastra's bare canceled result
    // (`handlers/entry.ts:811`): no output, no payload, no iterationCount survive.
    expect(report.stepResults.get('tick')).toEqual(bareCanceled);
    // The entry after the loop never ran, and nothing was recorded for it.
    expect(report.stepResults.has('ship')).toBe(false);
  });

  it.each([
    ['repeat', true],
    ['stop', false],
  ] as const)('is canceled after a condition that aborted and said %s (:889)', async (_name, again) => {
    const ac = new AbortController();
    const { runner, conditions } = loopRunner(() => {
      ac.abort();
      return again;
    }, { ship: increment });

    const report = await runWorkflowDetailed(
      compile({ id: 'poller', entries: [loop('dowhile', 5), { kind: 'step', id: 'ship' }] }),
      0,
      { runner, signal: ac.signal },
    );

    // Four allowance tokens are unspent: a missing reset shows up as residue here.
    expect(report.outcome).toEqual(canceledAtLoop);
    expect(runner.calls).toEqual(['tick']);
    expect(conditions.map((c) => c.iteration)).toEqual([1]);
    expect(report.stepResults.get('tick')).toEqual(bareCanceled);
  });

  it('wins over the bound: a cancel at an exhausted allowance is canceled, not failed', async () => {
    const ac = new AbortController();
    const { runner } = loopRunner(() => {
      ac.abort();
      return true;
    });

    const report = await runWorkflowDetailed(compile(only(loop('dowhile', 1))), 0, { runner, signal: ac.signal });

    expect(report.outcome).toEqual(canceledAtLoop);
    // Canceled, not the bound's failure: the sweep's record, not `exhaust`'s.
    expect(report.stepResults.get('tick')).toEqual(bareCanceled);
  });

  /**
   * A non-success iteration returns before the :807 check (`control-flow.ts:791-801`), so the loop
   * does not sweep it: `leave-X` is ungated, the body's real record stays, and only the settle
   * stage re-stamps the run's outcome (`handlers/entry.ts:815-817`) — with the **body's** origin,
   * which is what tells an ungated leave from an over-gated one. Each case leaves on the second of
   * five iterations, so three allowance tokens and the marker must be cleared on the way out:
   * `toEqual` makes any leftover a `residue` key.
   */
  const nonSuccess: ReadonlyArray<readonly [string, StepDescription, StepOutcome]> = [
    ['failed', tick, { status: 'failed', error: 'down', nonRetryable: true }],
    ['bailed', tick, { status: 'bailed', output: 'early' }],
    ['suspended', tick, { status: 'suspended', suspendPayload: { ask: 'approve' } }],
    ['paused', { kind: 'step', id: 'tick', source: 'workflow' }, { status: 'paused' }],
  ];

  it.each(nonSuccess)(
    'lets a %s iteration leave ungated, re-stamps the run canceled, and keeps the real record (entry.ts:815-817)',
    async (_status, body, bodyOutcome) => {
      const ac = new AbortController();
      const { runner, conditions } = loopRunner(() => true, {
        tick: (input, call) => {
          if ((input as number) !== 1) return increment(input, call);
          ac.abort();
          return bodyOutcome;
        },
        ship: increment,
      });

      const report = await runWorkflowDetailed(
        compile({ id: 'poller', entries: [loop('dowhile', 5, body), { kind: 'step', id: 'ship' }] }),
        0,
        { runner, signal: ac.signal },
      );

      // The settle stage re-stamps an outcome that ran: `started: true`.
      expect(report.outcome).toEqual({ status: 'canceled', origin: { stepId: 'tick', path: [0] }, started: true });
      expect(runner.calls).toEqual(['tick', 'tick']);
      expect(conditions.map((c) => c.iteration)).toEqual([1]);
      // Not the bare canceled record: Mastra stores the body's own result, then re-stamps only
      // the value it returns.
      expect(report.stepResults.get('tick')).toMatchObject({ ...bodyOutcome, payload: 1, metadata: { iterationCount: 2 } });
      expect(report.stepResults.has('ship')).toBe(false);
    },
  );

  it.each(nonSuccess)(
    'a %s iteration that raised the abort itself: the run is canceled, the body keeps its record',
    async (_status, body, bodyOutcome) => {
      // Mastra returns a non-success body result BEFORE its after-body abort check
      // (`handlers/control-flow.ts:790-800` precedes `:804-816`), so the loop hands back the body's
      // own result, and the entry-level re-stamp (`handlers/entry.ts:815-817`) then makes the run
      // `canceled` — with the body's record already stored, unchanged. A bail therefore stays
      // `bailed` on the record: the top-level bail-to-success rewrite sees `canceled`, not `bailed`.
      //
      // The abort is raised synchronously inside the body. An earlier version raised it on a later
      // macrotask and accepted either outcome; a census showed that abort landing after the run
      // had ended in 120 of 120 runs, so the race it described never happened.
      for (let i = 0; i < 10; i++) {
        const ac = new AbortController();
        const { runner } = loopRunner(() => true, {
          tick: (input, call) => {
            if ((input as number) !== 1) return increment(input, call);
            ac.abort();
            return bodyOutcome;
          },
          ship: increment,
        });
        const report = await runWorkflowDetailed(
          compile({ id: 'poller', entries: [loop('dowhile', 5, body), { kind: 'step', id: 'ship' }] }),
          0,
          { runner, signal: ac.signal },
        );
        expect(report.outcome, `run ${i}`).toEqual({ status: 'canceled', origin: { stepId: 'tick', path: [0] }, started: true });
        expect(runner.calls, `run ${i}`).toEqual(['tick', 'tick']);
        expect(report.stepResults.get('tick'), `run ${i}`).toMatchObject(bodyOutcome);
      }
    },
  );

  it('does not gate the body: a retry after the abort still runs (default.ts:455-460)', async () => {
    const ac = new AbortController();
    const { runner } = loopRunner(() => true, {
      tick: (input, call) => {
        if (call.attempt === 0) {
          ac.abort();
          return { status: 'failed', error: 'flaky' };
        }
        return increment(input, call);
      },
    });

    const outcome = await runWorkflow(compile(only(loop('dowhile', 5, { kind: 'step', id: 'tick', retries: 1 }))), 0, {
      runner,
      signal: ac.signal,
    });

    expect(runner.attempts).toEqual([
      { stepId: 'tick', attempt: 0 },
      { stepId: 'tick', attempt: 1 },
    ]);
    expect(outcome).toEqual(canceledAtLoop);
  });

  it('writes no canceled record from the pre-entry sweep, even over an earlier record under the body id', async () => {
    // `default.ts:815` returns before `entry.ts` stores anything, so the `.then(tick)` record stays.
    const ac = new AbortController();
    const { runner } = loopRunner(() => true, {
      tick: (input, call) => {
        ac.abort();
        return increment(input, call);
      },
    });

    const report = await runWorkflowDetailed(
      compile({ id: 'poller', entries: [{ kind: 'step', id: 'tick' }, loop('dowhile', 5)] }),
      0,
      { runner, signal: ac.signal },
    );

    expect(report.outcome).toEqual({ status: 'canceled', origin: { stepId: 'tick', path: [1] }, started: false });
    expect(runner.calls).toEqual(['tick']);
    expect(report.stepResults.get('tick')).toMatchObject({ status: 'success', output: 1, payload: 0 });
  });

  it('with a signal that never fires, runs to success and to the bound as before', async () => {
    const ac = new AbortController();
    const ok = loopRunner((o) => (o as number) < 3);
    expect(await runWorkflow(compile(only(loop('dowhile', 5))), 0, { runner: ok.runner, signal: ac.signal })).toEqual({
      status: 'success',
      output: 3,
    });
    const capped = loopRunner(() => true);
    expect(await runWorkflow(compile(only(loop('dowhile', 2))), 0, { runner: capped.runner, signal: ac.signal })).toEqual({
      status: 'failed',
      stepId: 'tick',
      path: [0],
      error: expect.any(Error),
    });
  });
});

// ---------------------------------------------------------------------------------------------
// 11. Non-vacuity: every cancellation inhibitor changes what a run does
// ---------------------------------------------------------------------------------------------

/**
 * Each inhibitor on the signal is refused structurally when stripped — `cancelStructureViolations`,
 * which `verifyWorkflow` runs first (`tests/verify/loop.test.ts` block 5). What the arc changes
 * is **what runs**, which is the whole of Mastra's check, so each is also shown changing a run:
 * the sweeps are declared after the transitions they race, and in each mutant the executor takes
 * the wrong road ([EXEC-002]).
 */
describe('loop: removing a cancellation inhibitor changes the run (non-vacuity)', () => {
  const noInhibitor = (role: string) => mutated(role, { dropInhibitor: 'wf.cancel' });

  it('start: without it, a loop after an aborting entry starts and records a failure it never should', async () => {
    // The abort is raised by the entry before the loop, not before the run: a pre-aborted run is
    // currently exposed to the arrival window (see 'never starts when the signal fired before the
    // entry'), which would blur this flip.
    const run = async (compiled: ReturnType<typeof compile>) => {
      const ac = new AbortController();
      // No evaluateLoopCondition: `start` fails if it fires at all.
      const runner = new RecordingRunner({
        steps: {
          prime: () => {
            ac.abort();
            return { status: 'success', output: 0 };
          },
          tick: increment,
        },
      });
      return runWorkflowDetailed(compiled, 0, { runner, signal: ac.signal });
    };
    const real = await run(compile(between(loop('dowhile', 5))));
    const broken = await run(compile(between(loop('dowhile', 5)), { gadgets: { loop: noInhibitor('start') } }));

    expect(real.outcome).toEqual({ status: 'canceled', origin: { stepId: 'tick', path: [1] }, started: false });
    expect(real.stepResults.has('tick')).toBe(false);
    expect(broken.stepResults.get('tick')).toMatchObject({ status: 'failed' });
  });

  it('enter: without it, a body runs after the abort', async () => {
    const make = () => {
      const ac = new AbortController();
      const l = loopRunner(() => {
        ac.abort();
        return true;
      });
      return { ...l, signal: ac.signal };
    };
    const real = make();
    await runWorkflow(compile(only(loop('dowhile', 5))), 0, { runner: real.runner, signal: real.signal });
    const broken = make();
    await runWorkflow(compile(only(loop('dowhile', 5)), { gadgets: { loop: noInhibitor('enter') } }), 0, {
      runner: broken.runner,
      signal: broken.signal,
    });

    expect(real.runner.calls).toEqual(['tick']);
    expect(broken.runner.calls).toEqual(['tick', 'tick']);
  });

  it('exhaust: without it, the bound beats the cancel and overwrites the body record', async () => {
    const make = () => {
      const ac = new AbortController();
      const l = loopRunner(() => {
        ac.abort();
        return true;
      });
      return { ...l, signal: ac.signal };
    };
    const real = make();
    const r = await runWorkflowDetailed(compile(only(loop('dowhile', 1))), 0, { runner: real.runner, signal: real.signal });
    const broken = make();
    const b = await runWorkflowDetailed(compile(only(loop('dowhile', 1)), { gadgets: { loop: noInhibitor('exhaust') } }), 0, {
      runner: broken.runner,
      signal: broken.signal,
    });

    expect(r.stepResults.get('tick')).toEqual({ status: 'canceled' });
    expect(b.stepResults.get('tick')).toMatchObject({ status: 'failed', error: expect.any(Error) });
  });

  it('check: without it, the condition is asked after the abort', async () => {
    const make = () => {
      const ac = new AbortController();
      const l = loopRunner(() => false, {
        tick: (input, call) => {
          ac.abort();
          return increment(input, call);
        },
      });
      return { ...l, signal: ac.signal };
    };
    const real = make();
    await runWorkflow(compile(only(loop('dowhile', 5))), 0, { runner: real.runner, signal: real.signal });
    const broken = make();
    await runWorkflow(compile(only(loop('dowhile', 5)), { gadgets: { loop: noInhibitor('check') } }), 0, {
      runner: broken.runner,
      signal: broken.signal,
    });

    expect(real.conditions).toEqual([]);
    expect(broken.conditions.map((c) => c.iteration)).toEqual([1]);
  });

  it("finish: without it, the loop's success is handed on and the cancel lands on the next entry", async () => {
    const run = async (compiled: ReturnType<typeof compile>) => {
      const ac = new AbortController();
      const { runner } = loopRunner(() => {
        ac.abort();
        return false;
      }, { ship: increment });
      return runWorkflow(compiled, 0, { runner, signal: ac.signal });
    };
    const shape: WorkflowDescription = { id: 'poller', entries: [loop('dowhile', 5), { kind: 'step', id: 'ship' }] };

    expect(await run(compile(shape))).toEqual({ status: 'canceled', origin: { stepId: 'tick', path: [0] }, started: true });
    expect(await run(compile(shape, { gadgets: { loop: noInhibitor('finish') } }))).toEqual({
      status: 'canceled',
      origin: { stepId: 'ship', path: [1] },
      started: false,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// `CanceledToken.started` — structural: which sweep fired says whether the work had begun.
// ---------------------------------------------------------------------------------------------

/**
 * Observes every token a gadget writes to its `canceled` exit without changing what happens
 * next: the gadget is compiled with a local tap in that exit's stead, and one forwarding
 * transition copies each token on. It reads `started` straight off the token, independent of
 * whether the kernel's `RunOutcome` forwards it.
 */
function tappedCanceled(inner: Gadget): { gadget: Gadget; seen: unknown[] } {
  const seen: unknown[] = [];
  const gadget: Gadget = (entry, next, ctx) => {
    const tap = place<CanceledToken>(ctx.names.reserve(`test.tap.canceled.${entry.id}`, 'test observation tap'));
    const result = inner(entry, next, { ...ctx, exits: { ...ctx.exits, canceled: tap } });
    const forward = Transition.builder(`test.tap.canceled.${entry.id}.forward`)
      .inputs(one(tap))
      .outputs(outPlace(ctx.exits.canceled))
      .action(async (tctx) => {
        const token = tctx.input(tap);
        seen.push(token);
        tctx.output(ctx.exits.canceled, token);
      })
      .build();
    return { ...result, transitions: [...result.transitions, forward] };
  };
  return { gadget, seen };
}

/**
 * `inner`, with every transition whose name ends in `suffix` rebuilt so the `started` flag of any
 * canceled token it writes is inverted — every arc, the timing and the priority kept. The mutant
 * that shows a `started` assertion is not vacuous.
 */
function flippingStarted(inner: Gadget, suffix: string): Gadget {
  return (entry, next, ctx) => {
    const r = inner(entry, next, ctx);
    const flip = (t: Transition): Transition => {
      const b = Transition.builder(t.name)
        .inputs(...t.inputSpecs)
        .outputs(t.outputSpec!)
        .timing(t.timing)
        .priority(t.priority)
        .action((tctx) =>
          t.action(
            new Proxy(tctx, {
              get(target, prop) {
                if (prop === 'output') {
                  return (p: Place<unknown>, value: unknown) =>
                    target.output(
                      p,
                      value !== null && typeof value === 'object' && 'started' in value
                        ? { ...value, started: !(value as CanceledToken).started }
                        : value,
                    );
                }
                const v: unknown = Reflect.get(target, prop, target);
                return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
              },
            }),
          ),
        );
      for (const arc of t.reads) b.read(arc.place);
      for (const arc of t.inhibitors) b.inhibitor(arc.place);
      for (const arc of t.resets) b.reset(arc.place);
      return b.build();
    };
    const transitions = r.transitions.map((t) => (t.name.endsWith(suffix) ? flip(t) : t));
    expect(transitions.filter((t, i) => t !== r.transitions[i]).length, `no transition ends in '${suffix}'`).toBeGreaterThan(0);
    return { ...r, transitions };
  };
}

describe('loop: which cancel sweep fired, read from `started` on the token', () => {
  /** One scenario per sweep: the shape, a runner that lands the abort there, and the flag. */
  type Scenario = readonly [sweep: string, make: (ac: AbortController) => RecordingRunner, entries: 'only' | 'between', path: number, started: boolean];
  const scenarios: readonly Scenario[] = [
    // `prime` aborts: the loop's gate sweeps its input before `start` — nothing began.
    ['cancel-in', (ac) => loopRunner(() => true, { prime: () => { ac.abort(); return { status: 'success', output: 0 }; } }).runner, 'between', 1, false],
    // The condition aborts and says repeat: the next iteration's `ready` is swept (:742/:889).
    ['cancel-ready', (ac) => loopRunner(() => { ac.abort(); return true; }).runner, 'only', 0, true],
    // The body aborts and succeeds: swept before the condition (:807).
    ['cancel-produced', (ac) => loopRunner(() => true, { tick: (i, c) => { ac.abort(); return increment(i, c); } }).runner, 'only', 0, true],
    // The condition aborts and says stop: the loop's success is swept (:889).
    ['cancel-exiting', (ac) => loopRunner(() => { ac.abort(); return false; }).runner, 'only', 0, true],
  ];
  const shapeOf = (entries: 'only' | 'between') => (entries === 'only' ? only(loop('dowhile', 5)) : between(loop('dowhile', 5)));

  it.each(scenarios)('%s reports started %s', async (sweep, make, entries, path, started) => {
    const ac = new AbortController();
    const tap = tappedCanceled(loopGadget);
    const report = await runWorkflowDetailed(compile(shapeOf(entries), { gadgets: { loop: tap.gadget } }), 0, {
      runner: make(ac),
      signal: ac.signal,
    });
    expect(tap.seen, sweep).toEqual([{ origin: { stepId: 'tick', path: [path] }, started }]);
    // A sweep after `start` records the bare canceled result; `cancel-in` records nothing.
    if (started) expect(report.stepResults.get('tick')).toEqual({ status: 'canceled' });
    else expect(report.stepResults.has('tick')).toBe(false);
  });

  it.each(scenarios)('a mutant flipping %s is caught', async (sweep, make, entries, path, started) => {
    const ac = new AbortController();
    const tap = tappedCanceled(flippingStarted(loopGadget, `.${sweep}`));
    await runWorkflowDetailed(compile(shapeOf(entries), { gadgets: { loop: tap.gadget } }), 0, { runner: make(ac), signal: ac.signal });
    expect(tap.seen).toEqual([{ origin: { stepId: 'tick', path: [path] }, started: !started }]);
  });
});

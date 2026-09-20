import { describe, expect, it } from 'vitest';
import { arcPlace, requiredCount, type PetriNet, type Place, type Transition } from 'libpetri';
import { SmtVerifier, deadlockFree, placeBound, terminatesAtSink } from 'libpetri/verification';
import { compile } from '../../src/compiler/compile.js';
import { loopGadget } from '../../src/compiler/gadgets/loop.js';
import type { EntryDescription, StepOutcome, WorkflowDescription } from '../../src/compiler/types.js';
import { runWorkflow } from '../../src/engine/kernel.js';
import { RecordingRunner } from '../fixtures/runner.js';

/**
 * Records every condition evaluation, so the `iterationCount` *sequence* can be asserted rather
 * than only how many times the body ran. A loop that ran the right number of times while telling
 * the condition the wrong iteration is a real Mastra divergence and invisible to a count check.
 */
class LoopRunner extends RecordingRunner {
  readonly conditions: { entryId: string; output: unknown; iteration: number }[] = [];

  constructor(
    behaviour: Record<string, (input: unknown) => StepOutcome>,
    private readonly condition: (output: unknown, iteration: number) => boolean,
  ) {
    super(behaviour);
  }

  async evaluateLoopCondition(entryId: string, output: unknown, iteration: number): Promise<boolean> {
    this.conditions.push({ entryId, output, iteration });
    return this.condition(output, iteration);
  }
}

const increment = (input: unknown): StepOutcome => ({ status: 'success', output: (input as number) + 1 });

const loopEntry = (
  loopType: 'dowhile' | 'dountil',
  maxIterations: number,
  body: EntryDescription = { kind: 'step', id: 'tick' },
): EntryDescription => ({ kind: 'loop', id: 'poll', loopType, maxIterations, body });

const loopOnly = (loopType: 'dowhile' | 'dountil', maxIterations: number): WorkflowDescription => ({
  id: 'poller',
  entries: [loopEntry(loopType, maxIterations)],
});

/** Registers only this gadget, so the run does not depend on the unimplemented placeholders. */
const build = (description: WorkflowDescription, runner: LoopRunner) =>
  compile(description, { runner, gadgets: { loop: loopGadget } });

const iterations = (runner: LoopRunner) => runner.conditions.map((c) => c.iteration);
const outputsSeen = (runner: LoopRunner) => runner.conditions.map((c) => c.output);

describe('loop gadget: iteration semantics', () => {
  it('dowhile repeats while the condition holds and leaves on the first false', async () => {
    const runner = new LoopRunner({ tick: increment }, (output) => (output as number) < 3);

    const outcome = await runWorkflow(build(loopOnly('dowhile', 10), runner), 0);

    expect(runner.calls).toEqual(['tick', 'tick', 'tick']);
    expect(outcome).toEqual({ status: 'success', output: 3 });
    // The body's own output is fed back in as the next iteration's input, as Mastra does via
    // `loopAgainData.prevResult`.
    expect(outputsSeen(runner)).toEqual([1, 2, 3]);
  });

  it('dountil repeats until the condition holds, which is the same net with one negation', async () => {
    const runner = new LoopRunner({ tick: increment }, (output) => (output as number) >= 3);

    const outcome = await runWorkflow(build(loopOnly('dountil', 10), runner), 0);

    expect(runner.calls).toEqual(['tick', 'tick', 'tick']);
    expect(outcome).toEqual({ status: 'success', output: 3 });
    expect(outputsSeen(runner)).toEqual([1, 2, 3]);
  });

  it('hands the condition iterationCount 1 on the first evaluation and one more each time', async () => {
    // The condition keys off the count alone, so the assertion below is about the sequence the
    // loop produced and not a coincidence of the payload.
    const runner = new LoopRunner({ tick: increment }, (_output, iteration) => iteration < 4);

    const outcome = await runWorkflow(build(loopOnly('dowhile', 10), runner), 0);

    expect(iterations(runner)).toEqual([1, 2, 3, 4]);
    expect(runner.calls).toEqual(['tick', 'tick', 'tick', 'tick']);
    expect(outcome).toEqual({ status: 'success', output: 4 });
  });

  it('runs the body exactly once when the condition settles immediately', async () => {
    const runner = new LoopRunner({ tick: increment }, () => false);

    const outcome = await runWorkflow(build(loopOnly('dowhile', 10), runner), 0);

    expect(iterations(runner)).toEqual([1]);
    expect(outcome).toEqual({ status: 'success', output: 1 });
  });

  it('carries the loop result on to the next entry, and the previous entry into the loop', async () => {
    const runner = new LoopRunner(
      {
        prime: () => ({ status: 'success', output: 10 }),
        tick: increment,
        ship: (input) => ({ status: 'success', output: `shipped:${input as number}` }),
      },
      (output) => (output as number) < 12,
    );

    const outcome = await runWorkflow(
      build(
        {
          id: 'poller',
          entries: [{ kind: 'step', id: 'prime' }, loopEntry('dowhile', 10), { kind: 'step', id: 'ship' }],
        },
        runner,
      ),
      0,
    );

    expect(runner.calls).toEqual(['prime', 'tick', 'tick', 'ship']);
    expect(outcome).toEqual({ status: 'success', output: 'shipped:12' });
  });
});

describe('loop gadget: the iteration allowance', () => {
  it('caps a dowhile whose condition never goes false, and says so', async () => {
    const runner = new LoopRunner({ tick: increment }, () => true);

    const outcome = await runWorkflow(build(loopOnly('dowhile', 3), runner), 0);

    // Exactly maxIterations body runs: one allowance token per iteration, and nothing refills it.
    expect(runner.calls).toEqual(['tick', 'tick', 'tick']);
    expect(iterations(runner)).toEqual([1, 2, 3]);
    // Exhaustion fails rather than exiting: a truncated result that looked like a normal exit
    // would reach the next entry with nothing to distinguish it from a settled condition.
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.stepId).toBe('poll');
    expect(String(outcome.error)).toMatch(/maxIterations=3/);
  });

  it('caps a dountil whose condition is never met', async () => {
    const runner = new LoopRunner({ tick: increment }, () => false);

    const outcome = await runWorkflow(build(loopOnly('dountil', 2), runner), 0);

    expect(runner.calls).toEqual(['tick', 'tick']);
    expect(iterations(runner)).toEqual([1, 2]);
    expect(outcome.status).toBe('failed');
  });

  it('exits with allowance to spare and still carries the result out', async () => {
    // maxIterations 8, two iterations used, so six allowance tokens go unspent.
    //
    // This test does NOT show they are cleared, and the name it used to carry said it did.
    // `classify` reads `wf.failed`, then `wf.done`, and only scans for stranded tokens when
    // neither is marked (`src/engine/kernel.ts`) — so a run that reaches a terminal masks every
    // token stranded anywhere else. Measured: with `finish`'s reset deleted this run leaves
    // `{'wf.done': 1, 's.0.poll.budget': 6}` and this assertion still passes unchanged.
    // The strand check is in `tests/verify/loop.test.ts`, which reads the marking directly and
    // proves the same thing over a net seeded with a real allowance.
    const runner = new LoopRunner({ tick: increment }, (output) => (output as number) < 2);

    const outcome = await runWorkflow(build(loopOnly('dowhile', 8), runner), 0);

    expect(outcome).toEqual({ status: 'success', output: 2 });
  });

  it('is a fresh allowance per entry, so a re-entered loop is not starved by the last one', async () => {
    // The outer loop enters the inner one twice, and the inner one spends both of its two
    // allowance tokens each time. Without `start` reseeding, the second entry would find an empty
    // budget and fail on its first evaluation; without the reset, entries would accumulate past
    // the bound instead.
    const runner = new LoopRunner(
      { tick: increment },
      (output, iteration) => (iteration === 1 ? true : (output as number) % 2 !== 0),
    );

    const outcome = await runWorkflow(
      build(
        {
          id: 'nested',
          entries: [
            {
              kind: 'loop',
              id: 'outer',
              loopType: 'dowhile',
              maxIterations: 4,
              body: { kind: 'loop', id: 'poll', loopType: 'dowhile', maxIterations: 2, body: { kind: 'step', id: 'tick' } },
            },
          ],
        },
        runner,
      ),
      0,
    );

    // Two ticks per inner entry: the first evaluation always repeats, the second sees an even
    // number and stops. The inner sequence restarting at 1 is the second entry getting its own
    // allowance and its own iteration count.
    expect(outcome).toEqual({ status: 'success', output: 4 });
    expect(runner.calls).toEqual(['tick', 'tick', 'tick', 'tick']);
    expect(runner.conditions.filter((c) => c.entryId === 'poll').map((c) => c.iteration))
      .toEqual([1, 2, 1, 2]);
    expect(runner.conditions.filter((c) => c.entryId === 'outer').map((c) => c.iteration))
      .toEqual([1, 2]);
  });
});

describe('loop gadget: failure is a branch', () => {
  it('routes a failing iteration to the workflow terminal and stops the loop', async () => {
    const runner = new LoopRunner(
      {
        tick: (input) =>
          (input as number) === 1 ? { status: 'failed', error: 'card declined' } : increment(input),
        ship: (input) => ({ status: 'success', output: input }),
      },
      () => true,
    );

    const outcome = await runWorkflow(
      build(
        { id: 'poller', entries: [loopEntry('dowhile', 10), { kind: 'step', id: 'ship' }] },
        runner,
      ),
      0,
    );

    expect(runner.calls).toEqual(['tick', 'tick']);
    // The condition was consulted once, after the iteration that succeeded — never after the
    // failing one, because the body's failure never reaches `produced`.
    expect(iterations(runner)).toEqual([1]);
    expect(outcome).toEqual({ status: 'failed', stepId: 'tick', error: 'card declined' });
  });

  it('treats a throwing condition as a failure rather than a quiet exit', async () => {
    const boom = new Error('condition provider down');
    const runner = new LoopRunner({ tick: increment }, () => {
      throw boom;
    });

    const outcome = await runWorkflow(build(loopOnly('dowhile', 10), runner), 0);

    expect(outcome).toEqual({ status: 'failed', stepId: 'poll', error: boom });
  });

  it('refuses to compile without a condition evaluator', () => {
    expect(() => compile(loopOnly('dowhile', 3), { runner: new RecordingRunner(), gadgets: { loop: loopGadget } }))
      .toThrow(/evaluateLoopCondition/);
  });

  it('refuses a non-positive allowance, which no `Out` spec could honour', () => {
    const runner = new LoopRunner({}, () => false);
    expect(() => build(loopOnly('dowhile', 0), runner)).toThrow(/maxIterations=0/);
  });
});

/** Places and transitions the loop emitted, found by role suffix rather than by rebuilt name. */
function role<T>(net: PetriNet, suffix: string): Place<T> {
  const matches = [...net.places].filter((p) => p.name.endsWith(suffix));
  if (matches.length !== 1) throw new Error(`expected one place ending '${suffix}', got ${matches.length}`);
  return matches[0] as Place<T>;
}

function transition(net: PetriNet, suffix: string): Transition {
  const matches = [...net.transitions].filter((t) => t.name.endsWith(suffix));
  if (matches.length !== 1) throw new Error(`expected one transition ending '${suffix}', got ${matches.length}`);
  return matches[0]!;
}

describe('loop gadget: the shape the allowance rests on', () => {
  const runner = () => new LoopRunner({ tick: increment }, () => true);

  it('spends the allowance one token per iteration and never refills it mid-loop', () => {
    const net = build(loopOnly('dowhile', 5), runner()).net;
    const budget = role(net, '.budget');

    const producers = [...net.transitions].filter((t) => t.outputPlaces().has(budget));
    const consumers = [...net.transitions].filter((t) => t.inputPlaces().has(budget));

    // One producer, and it is the transition that starts the whole loop — so the allowance is
    // fixed at entry and cannot grow while iterations run.
    expect(producers.map((t) => t.name.split('.').pop())).toEqual(['start']);
    // One consumer, taking exactly one token. `all()` or `atLeast(n)` here would drain the place
    // and take the P-invariant that carries the bound with it.
    expect(consumers.map((t) => t.name.split('.').pop())).toEqual(['enter']);
    const spec = consumers[0]!.inputSpecs.find((s) => s.place === budget)!;
    expect(spec.type).toBe('one');
    expect(requiredCount(spec)).toBe(1);
  });

  it('decides exhaustion by topology: an inhibitor arc, not a number an action reads', () => {
    const net = build(loopOnly('dowhile', 5), runner()).net;
    const budget = role(net, '.budget');
    const ready = role(net, '.ready');

    const enter = transition(net, '.enter');
    const exhaust = transition(net, '.exhaust');

    // Both consume `ready`; they are told apart by their other precondition alone, so every
    // marking in which `ready` holds a token enables exactly one of them.
    expect(enter.inputPlaces().has(ready)).toBe(true);
    expect(exhaust.inputPlaces().has(ready)).toBe(true);
    expect(enter.inputPlaces().has(budget)).toBe(true);
    expect(exhaust.inhibitors.map(arcPlace)).toContain(budget);
    expect(exhaust.inputPlaces().has(budget)).toBe(false);
  });

  it('clears the unspent allowance on every way out, and nowhere else', () => {
    const net = build(loopOnly('dowhile', 5), runner()).net;
    const budget = role(net, '.budget');

    const resetters = [...net.transitions]
      .filter((t) => t.resets.map(arcPlace).includes(budget))
      .map((t) => t.name.split('.').pop())
      .sort();

    // `start` (stale allowance from a previous entry), `finish` (normal exit) and `abort` (every
    // failure). Never `check`, which also fires on the repeat branch and would wipe the very
    // allowance the next iteration is about to spend.
    expect(resetters).toEqual(['abort', 'finish', 'start']);
  });

  it('keeps one iteration in flight: one producer and one consumer of the pending marker', () => {
    const net = build(loopOnly('dowhile', 5), runner()).net;
    const running = role(net, '.running');

    expect([...net.transitions].filter((t) => t.outputPlaces().has(running)).map((t) => t.name.split('.').pop()))
      .toEqual(['enter']);
    expect([...net.transitions].filter((t) => t.inputPlaces().has(running)).map((t) => t.name.split('.').pop()))
      .toEqual(['check']);
  });

  it('declares both loop outcomes and the failure outcome on one transition', () => {
    const net = build(loopOnly('dowhile', 5), runner()).net;
    const check = transition(net, '.check');
    const spec = check.outputSpec!;

    expect(spec.type).toBe('xor');
    // Continue, exit and fail: three complete branches, so the structural branches are exactly
    // the runtime outcomes ([IO-015]).
    expect([...check.outputPlaces()].map((p) => p.name.split('.').pop()).sort())
      .toEqual(['exiting', 'failing', 'ready']);
  });

  it('gives every place a producer and a consumer', () => {
    const compiled = build(loopOnly('dowhile', 5), runner());
    const terminals = new Set([compiled.donePlace.name, compiled.failedPlace.name]);

    for (const place of compiled.net.places) {
      if (terminals.has(place.name)) continue;
      if (place === compiled.entryPlace) continue;
      const consumed = [...compiled.net.transitions].some(
        (t) => t.inputPlaces().has(place) || t.resets.map(arcPlace).includes(place),
      );
      expect(consumed, `'${place.name}' has no consumer`).toBe(true);
    }
  });
});

/**
 * What is proved, and what is only tested.
 *
 * [IO-016] makes an output branch a *set* of places: the flattener behind every analysis deposits
 * one token per named place whatever the action wrote. `start` writes `maxIterations` tokens into
 * a place its branch names once, so for `maxIterations > 1` the net the verifier reads is not the
 * net the executor runs — and in the unsafe direction, since it explores *fewer* iterations. Two
 * things follow, and both are asserted below rather than assumed:
 *
 * - The topology is proved at `maxIterations = 1`, the one compile where the two agree exactly.
 *   Every transition and every `Xor` branch is reachable there, so the claim covers the whole
 *   shape; what it does not cover is the cycle going round more than once, nor — and this is the
 *   sharp edge — *leaving with allowance to spare*, which is unreachable when only one token is
 *   modelled and is exactly what `finish`'s reset exists for.
 * - The gap itself is pinned, so it fails loudly the day libpetri gains an output multiplicity
 *   or `CompiledWorkflow` carries an initial marking.
 *
 * The rest of the cap **is** provable, and is proved: `tests/verify/loop.test.ts` seeds `ready`
 * and `budget` directly — the post-`start` marking, and libpetri's own budget idiom — and gets
 * `placeBound(budget, k)` proven with `placeBound(budget, k - 1)` violated, so the bound is real
 * and tight, alongside `deadlockFree` over the leftover-allowance exit. What stays unproven is
 * one action's deposit count: that `start` puts `maxIterations` tokens in. That part is *tested*
 * here (the two exhaustion cases above run the body exactly `maxIterations` times).
 */
describe('loop gadget, proved at an allowance of one', () => {
  const property = (compiled: ReturnType<typeof build>) =>
    SmtVerifier.forNet(compiled.net)
      .initialMarking((m) => m.tokens(compiled.entryPlace, 1))
      .sinkPlaces(compiled.donePlace, compiled.failedPlace)
      // The exit resets on `budget` drop every basis row whose support touches it, so the
      // semiflows have to be asked for explicitly or a count claim has no law to rest on.
      .semiflowInvariants(true)
      .timeout(60_000);

  it('behaves at an allowance of one: settle on the first evaluation, or fail', async () => {
    const settles = new LoopRunner({ tick: increment }, () => false);
    const doesNot = new LoopRunner({ tick: increment }, () => true);

    expect(await runWorkflow(build(loopOnly('dowhile', 1), settles), 0))
      .toEqual({ status: 'success', output: 1 });
    expect(settles.calls).toEqual(['tick']);

    const capped = await runWorkflow(build(loopOnly('dowhile', 1), doesNot), 0);
    expect(doesNot.calls).toEqual(['tick']);
    expect(capped.status).toBe('failed');
  });

  it('strands nothing and always reaches a terminal', async () => {
    const compiled = build(loopOnly('dowhile', 1), new LoopRunner({ tick: increment }, () => true));

    const nothingStranded = await property(compiled).property(deadlockFree()).verify();
    const reachesTerminal = await property(compiled).property(terminatesAtSink()).verify();

    // Assert `proven` explicitly. `isViolated()` is false for `unknown` too, so "not violated"
    // would pass on a query that timed out and the test would be vacuous from then on.
    expect(nothingStranded.verdict.type, nothingStranded.report).toBe('proven');
    expect(reachesTerminal.verdict.type, reachesTerminal.report).toBe('proven');
  }, 180_000);

  it('never has two iterations in flight, and never more than one token waiting to start', async () => {
    const compiled = build(loopOnly('dountil', 1), new LoopRunner({ tick: increment }, () => false));
    const running = role<{ iteration: number }>(compiled.net, '.running');
    const ready = role(compiled.net, '.ready');

    const oneInFlight = await property(compiled).property(placeBound(running, 1)).verify();
    const oneWaiting = await property(compiled).property(placeBound(ready, 1)).verify();
    // A control, because a route that answered `proven` to everything would make the two above
    // worthless: an iteration does reach `running`, so a bound of zero must come back violated.
    const control = await property(compiled).property(placeBound(running, 0)).verify();

    expect(oneInFlight.verdict.type, oneInFlight.report).toBe('proven');
    expect(oneWaiting.verdict.type, oneWaiting.report).toBe('proven');
    expect(control.verdict.type, control.report).toBe('violated');
  }, 180_000);

  it('pins the [IO-016] gap that keeps the allowance itself out of reach of a proof', async () => {
    // The executor really puts three tokens in `budget` here — the cap test above shows three
    // iterations run — yet a bound of one comes back `proven`, because every branch-enumerating
    // analysis models one token per named place. This assertion is a characterisation of the
    // encoding, not a property of the loop: when it starts failing, `placeBound(budget, N)`
    // has become a real claim and belongs in the test above.
    const compiled = build(loopOnly('dowhile', 3), new LoopRunner({ tick: increment }, () => true));
    const budget = role(compiled.net, '.budget');

    const understated = await property(compiled).property(placeBound(budget, 1)).verify();

    expect(understated.verdict.type, understated.report).toBe('proven');
  }, 180_000);
});

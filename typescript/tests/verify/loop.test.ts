import { describe, expect, it } from 'vitest';
import { PrecompiledNetExecutor, tokenOf, type PetriNet, type Place } from 'libpetri';
import { SmtVerifier, deadlockFree, placeBound, terminatesAtSink } from 'libpetri/verification';
import { compile } from '../../src/compiler/compile.js';
import { loopGadget } from '../../src/compiler/gadgets/loop.js';
import { classify } from '../../src/engine/kernel.js';
import { describeReport, verifyWorkflow } from '../../src/verify/index.js';
import { RecordingRunner, inertRunner } from '../fixtures/runner.js';
import type {
  CompiledWorkflow,
  EntryDescription,
  StepOutcome,
  StepRunner,
  WorkflowDescription,
} from '../../src/compiler/types.js';

/**
 * `loop` is registered explicitly: `defaultGadgets()` still maps the kind to
 * `unimplemented('loop')`, so without this the compile throws rather than proving anything.
 *
 * The gadget resolves `evaluateLoopCondition` at *compile* time and refuses to build without
 * one, so the structural runner has to carry a stub even though it is never called.
 */
const inertLoopRunner: StepRunner = {
  ...inertRunner,
  async evaluateLoopCondition(): Promise<boolean> {
    throw new Error('inert runner must not be called');
  },
};

const compileLoop = (description: WorkflowDescription, runner: StepRunner = inertLoopRunner) =>
  compile(description, { runner, gadgets: { loop: loopGadget } });

const step = (id: string): EntryDescription => ({ kind: 'step', id });
const loop = (
  id: string,
  maxIterations: number,
  body: EntryDescription,
  loopType: 'dowhile' | 'dountil' = 'dowhile',
): EntryDescription => ({ kind: 'loop', id, loopType, maxIterations, body });

/** A place by its role suffix, so the assertion does not rebuild the name scheme by hand. */
function role<T>(net: PetriNet, suffix: string): Place<T> {
  const matches = [...net.places].filter((p) => p.name.endsWith(suffix));
  if (matches.length !== 1) {
    throw new Error(`expected one place ending '${suffix}', got ${matches.length}`);
  }
  return matches[0] as Place<T>;
}

// ---------------------------------------------------------------------------------------------
// 1. The whole compiled net, from the entry place, exactly as `runWorkflow` seeds it.
// ---------------------------------------------------------------------------------------------

/**
 * Every shape must come back `proven`, not merely un-violated.
 *
 * The two properties are complementary, not redundant ([VER-013]): `deadlockFree` fails on a
 * quiescent marking holding a token *outside* the declared sinks — a stranded allowance token,
 * a pending marker nobody cleared — and `terminatesAtSink` fails on a quiescent marking with no
 * sink marked at all. Together they say the loop never leaves anything behind *and* always
 * reaches a terminal.
 */
const shapes: ReadonlyArray<readonly [string, WorkflowDescription]> = [
  ['an allowance of one', { id: 'w', entries: [loop('poll', 1, step('tick'))] }],
  ['an allowance of three', { id: 'w', entries: [loop('poll', 3, step('tick'))] }],
  ['a dountil', { id: 'w', entries: [loop('poll', 3, step('tick'), 'dountil')] }],
  [
    'a loop between two steps',
    { id: 'w', entries: [step('before'), loop('poll', 3, step('tick')), step('after')] },
  ],
  [
    'two loops in series',
    { id: 'w', entries: [loop('first', 2, step('a')), loop('second', 2, step('b'))] },
  ],
  ['a loop nested in a loop', { id: 'w', entries: [loop('outer', 2, loop('inner', 2, step('tick')))] }],
  [
    'three levels of nesting',
    { id: 'w', entries: [loop('a', 2, loop('b', 2, loop('c', 2, step('tick'))))] },
  ],
  // `sleepGadget` never writes to its failure place, so with a sleep body the loop's `failing`
  // place has one fewer producer and the `abort` leg is reachable only through `exhaust` and a
  // throwing condition. A liveness argument that only worked because the body might fail would
  // be accidental, so this shape has to close too.
  [
    'a body that can never fail',
    { id: 'w', entries: [loop('poll', 3, { kind: 'sleep', id: 'nap', durationMs: 5 })] },
  ],
];

describe('compiled loop, proved over the whole net', () => {
  it.each(shapes)('%s is deadlock-free and terminates at a declared sink', async (_name, description) => {
    const reports = await verifyWorkflow(compileLoop(description), { timeoutMs: 120_000 });

    // Assert `proven` explicitly. `isViolated()` is false for `unknown` too, so asserting
    // "not violated" would pass on a query that timed out and the test would be vacuous.
    for (const report of reports) {
      expect(report.result.verdict.type, describeReport(report)).toBe('proven');
    }
    expect(reports.map((r) => r.property)).toEqual(['deadlockFree', 'terminatesAtSink']);
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------
// 2. The same net at a *real* allowance, which the query above cannot reach.
// ---------------------------------------------------------------------------------------------

/**
 * Why the block above is not the whole story, and why this one exists.
 *
 * [IO-016] makes an output branch a *set* of places: the flattener behind every analysis
 * deposits one token per named place whatever the action wrote. `start` writes `maxIterations`
 * tokens into a place its `And` branch names once, so from the entry place the analyses only
 * ever see `budget` holding **one** token — at `maxIterations` 1, 3 or 300 alike.
 *
 * That is not merely a weaker proof, it is a *blind spot with a shape*. The one marking the
 * loop's exit resets exist for — leaving with allowance to spare — is unreachable in the
 * flattened net, because the single modelled token is always spent by the first `enter`. So the
 * query above cannot see whether the leftover allowance is cleared. Measured, not argued:
 * deleting `.reset(budget)` from `finish` leaves every shape above `proven`, while it leaves
 * six tokens in `s.0.poll.budget` on a real eight-allowance run.
 *
 * The fix is not a different topology — the topology is already right. It is to seed the
 * allowance where the verifier reads it, which is libpetri's own budget idiom
 * (`.initialMarking(m => m.tokens(idle, 1).tokens(budget, k))`). Seeding `ready` and `budget`
 * directly is exactly the post-`start` marking the executor reaches, so this block proves the
 * loop's *cycle* at a genuine allowance of k: the bound holds, it is tight, and nothing strands
 * on any exit.
 *
 * What remains unproven after this is one action's deposit count — that `start` really puts
 * `maxIterations` tokens in — and nothing else. That is a much smaller claim than "the cap is
 * not provable", and it is pinned by the executor tests in `tests/compiler/loop.test.ts`.
 */
const seeded = (compiled: CompiledWorkflow, allowance: number) =>
  SmtVerifier.forNet(compiled.net)
    .initialMarking((m) =>
      m.tokens(role(compiled.net, '.ready'), 1).tokens(role(compiled.net, '.budget'), allowance),
    )
    .sinkPlaces(compiled.donePlace, compiled.failedPlace)
    // The exit resets on `budget` drop every basis row whose support touches it, so the
    // semiflows have to be asked for explicitly or a count claim has no law to rest on.
    .semiflowInvariants(true)
    .timeout(120_000);

describe('compiled loop, proved at a real allowance', () => {
  const compiled = () => compileLoop({ id: 'w', entries: [loop('poll', 3, step('tick'))] });

  it.each([1, 2, 3, 5])(
    'strands nothing and reaches a terminal with an allowance of %i',
    async (allowance) => {
      const c = compiled();

      const nothingStranded = await seeded(c, allowance).property(deadlockFree()).verify();
      const reachesTerminal = await seeded(c, allowance).property(terminatesAtSink()).verify();

      expect(nothingStranded.verdict.type, nothingStranded.report).toBe('proven');
      expect(reachesTerminal.verdict.type, reachesTerminal.report).toBe('proven');
    },
    180_000,
  );

  it.each([1, 2, 3, 5])('holds the allowance at exactly %i and never refills it', async (allowance) => {
    const c = compiled();
    const budget = role(c.net, '.budget');

    const atBound = await seeded(c, allowance).property(placeBound(budget, allowance)).verify();
    // The control is what makes the line above a claim rather than a formality: the bound is
    // tight, so one token lower must come back `violated`. Without it a route that answered
    // `proven` to everything would look identical.
    const tight = await seeded(c, allowance).property(placeBound(budget, allowance - 1)).verify();

    expect(atBound.verdict.type, atBound.report).toBe('proven');
    expect(tight.verdict.type, tight.report).toBe('violated');
  }, 180_000);

  it('keeps one iteration in flight however large the allowance', async () => {
    const c = compiled();
    // Every place the loop owns except `budget`, which is the allowance itself and bounded
    // above. One token each is the sequentiality claim: the single circulating flow token is
    // the control token, so there is no marking with two iterations in flight.
    for (const suffix of ['.ready', '.running', '.produced', '.exiting', '.failing']) {
      const p = role(c.net, suffix);
      const bounded = await seeded(c, 5).property(placeBound(p, 1)).verify();
      const control = await seeded(c, 5).property(placeBound(p, 0)).verify();

      expect(bounded.verdict.type, `${suffix}: ${bounded.report}`).toBe('proven');
      // Each of these really is reached, so a bound of zero must be violated — otherwise the
      // line above would be proving something about a dead place.
      expect(control.verdict.type, `${suffix} control: ${control.report}`).toBe('violated');
    }
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------
// 3. The residual marking itself, because `classify` cannot report a strand next to a terminal.
// ---------------------------------------------------------------------------------------------

class LoopRunner extends RecordingRunner {
  constructor(
    behaviour: Record<string, (input: unknown) => StepOutcome>,
    private readonly condition: (output: unknown, iteration: number) => boolean,
  ) {
    super(behaviour);
  }

  async evaluateLoopCondition(_id: string, output: unknown, iteration: number): Promise<boolean> {
    return this.condition(output, iteration);
  }
}

/**
 * Runs to quiescence and returns the **whole** residual marking.
 *
 * `classify` reads `wf.failed`, then `wf.done`, and only scans for stranded tokens when neither
 * is marked (`src/engine/kernel.ts`). So any run that reaches a terminal — which is every run
 * this gadget produces — masks every token stranded anywhere else. Asserting on `classify`'s
 * outcome therefore cannot detect a strand in this gadget at all, and the marking has to be
 * read directly. Measured: with `finish`'s reset deleted, an eight-allowance loop that exits
 * after two iterations leaves `{'wf.done': 1, 's.0.poll.budget': 6}` and `classify` still
 * returns `{ status: 'success', output: 2 }`.
 */
async function residue(compiled: CompiledWorkflow, input: unknown): Promise<Record<string, number>> {
  const executor = new PrecompiledNetExecutor(
    compiled.net,
    new Map([[compiled.entryPlace, [tokenOf({ data: input })]]]),
    {},
  );
  const marking = await executor.run(30_000, 'close');
  const held: Record<string, number> = {};
  for (const p of compiled.net.places) {
    const count = marking.tokenCount(p);
    if (count > 0) held[p.name] = count;
  }
  // Kept so a failure message says both what the marking was and what the engine would have
  // reported, which is the whole point of the discrepancy.
  classify(compiled, marking);
  return held;
}

const increment = (input: unknown): StepOutcome => ({ status: 'success', output: (input as number) + 1 });
const explode = (): StepOutcome => ({ status: 'failed', error: 'card declined' });

describe('loop gadget: nothing is left behind on any exit', () => {
  const plain = (max: number): WorkflowDescription => ({ id: 'w', entries: [loop('poll', max, step('tick'))] });
  const nested = (outer: number, inner: number): WorkflowDescription => ({
    id: 'w',
    entries: [loop('outer', outer, loop('poll', inner, step('tick')))],
  });

  it('exits with allowance to spare and clears every unspent token', async () => {
    // Eight allowed, two spent: six tokens have to be cleared by `finish`'s reset. This is the
    // case the whole-net proof cannot reach, so it is asserted on the marking.
    const runner = new LoopRunner({ tick: increment }, (o) => (o as number) < 2);
    expect(await residue(compileLoop(plain(8), runner), 0)).toEqual({ 'wf.done': 1 });
  }, 60_000);

  it('clears the allowance and the pending marker when the body fails mid-loop', async () => {
    // The body fails on the third iteration, so `abort` has to clear both a partly-spent
    // allowance and the `running` marker the failing iteration left behind.
    const runner = new LoopRunner(
      { tick: (i) => ((i as number) === 2 ? explode() : increment(i)) },
      () => true,
    );
    expect(await residue(compileLoop(plain(9), runner), 0)).toEqual({ 'wf.failed': 1 });
  }, 60_000);

  it('clears the allowance when the condition throws', async () => {
    const runner = new LoopRunner({ tick: increment }, () => {
      throw new Error('condition provider down');
    });
    expect(await residue(compileLoop(plain(7), runner), 0)).toEqual({ 'wf.failed': 1 });
  }, 60_000);

  it('clears everything on exhaustion, where the allowance is spent to zero', async () => {
    const runner = new LoopRunner({ tick: increment }, () => true);
    expect(await residue(compileLoop(plain(4), runner), 0)).toEqual({ 'wf.failed': 1 });
  }, 60_000);

  it('leaves neither loop holding anything when an inner loop fails inside an outer one', async () => {
    // The inner loop's failure goes to the *outer* loop's local failure place, so the outer
    // `abort` has to clear its own allowance and marker on a path it did not itself start.
    const runner = new LoopRunner(
      { tick: (i) => ((i as number) === 3 ? explode() : increment(i)) },
      () => true,
    );
    expect(await residue(compileLoop(nested(5, 5), runner), 0)).toEqual({ 'wf.failed': 1 });
  }, 60_000);

  it('leaves neither loop holding anything when an inner loop exhausts', async () => {
    const runner = new LoopRunner({ tick: increment }, () => true);
    expect(await residue(compileLoop(nested(3, 2), runner), 0)).toEqual({ 'wf.failed': 1 });
  }, 60_000);

  it('leaves nothing behind when a loop is re-entered and exits with spare allowance twice', async () => {
    // Two entries of the inner loop, each leaving unspent allowance: the second entry must find
    // a cleared place and must not accumulate the first entry's leftovers.
    const runner = new LoopRunner({ tick: increment }, (o, i) => (i === 1 ? true : (o as number) % 2 !== 0));
    expect(await residue(compileLoop(nested(4, 6), runner), 0)).toEqual({ 'wf.done': 1 });
  }, 60_000);

  it('leaves nothing behind when a step after the loop fails', async () => {
    const runner = new LoopRunner({ tick: increment, ship: explode }, () => false);
    const description: WorkflowDescription = {
      id: 'w',
      entries: [loop('poll', 5, step('tick')), step('ship')],
    };
    expect(await residue(compileLoop(description, runner), 0)).toEqual({ 'wf.failed': 1 });
  }, 60_000);
});

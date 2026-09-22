import { describe, expect, it } from 'vitest';
import { Transition, arcPlace, type PetriNet, type Place } from 'libpetri';
import {
  SmtVerifier,
  deadlockFree,
  placeBound,
  terminatesAtSink,
  type SmtProperty,
  type SmtVerificationResult,
} from 'libpetri/verification';
import { compile } from '../../src/compiler/compile.js';
import { loopGadget } from '../../src/compiler/gadgets/loop.js';
import type { Gadget } from '../../src/compiler/gadgets/types.js';
import type { CompiledWorkflow, EntryDescription, StepDescription, WorkflowDescription } from '../../src/compiler/types.js';
import { runWorkflow } from '../../src/engine/kernel.js';
import { describeReport, verifyWorkflow } from '../../src/verify/index.js';
import { RecordingRunner } from '../fixtures/runner.js';

/**
 * What is proven about the loop, from which marking, and what is not.
 *
 * Every verdict below is from `SmtVerifier` (the IC3/PDR route: untimed, value-blind, priority-
 * blind), with no environment places, all five workflow terminals declared as sinks and semiflow
 * invariants on — `verifyWorkflow`'s configuration. The initial marking is named per block,
 * because it is the whole difference between them:
 *
 * 1. **From the entry place** (one token in the loop's input, as `runWorkflow` seeds it). Proven
 *    at bounds 1, 2 and 4 — but [IO-016] models one token per place a branch names, so `start`'s
 *    `iterationBound` deposit is explored as an allowance of **one** at every bound. These
 *    verdicts cover the topology (every transition and branch is reachable), not the cycle
 *    running twice, and not a loop leaving with allowance to spare. Block 3 pins that gap.
 * 2. **From the post-`start` marking** (`ready` = 1, `budget` = k). The same net with the
 *    allowance seeded where the verifier reads it, which is libpetri's own budget idiom. Proven at
 *    k = 1, 2, 4, with the bound shown tight. What neither block proves is `start`'s deposit
 *    count; `tests/compiler/loop.test.ts` pins that by running the body exactly k times.
 */

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

type LoopType = 'dowhile' | 'dountil';

const tick: StepDescription = { kind: 'step', id: 'tick' };
const loop = (iterationBound: number, body: StepDescription = tick, loopType: LoopType = 'dowhile', id = 'poll'): EntryDescription => ({
  kind: 'loop',
  id,
  loopType,
  iterationBound,
  body,
});
const only = (entry: EntryDescription): WorkflowDescription => ({ id: 'w', entries: [entry] });

function role<T>(net: PetriNet, suffix: string): Place<T> {
  const matches = [...net.places].filter((p) => p.name.endsWith(suffix));
  if (matches.length !== 1) throw new Error(`expected one place ending '${suffix}', got ${matches.length}`);
  return matches[0] as Place<T>;
}

/** `verifyWorkflow`'s configuration, seeded at the post-`start` marking instead of the entry. */
const seeded = (compiled: CompiledWorkflow, allowance: number) => {
  const { done, failed, bailed, suspended, paused } = compiled.terminals;
  return SmtVerifier.forNet(compiled.net)
    .initialMarking((m) => m.tokens(role(compiled.net, '.poll.ready'), 1).tokens(role(compiled.net, '.poll.budget'), allowance))
    .sinkPlaces(done, failed, bailed, suspended, paused)
    .semiflowInvariants(true)
    .timeout(120_000);
};

const fromEntry = (compiled: CompiledWorkflow) => {
  const { done, failed, bailed, suspended, paused } = compiled.terminals;
  return SmtVerifier.forNet(compiled.net)
    .initialMarking((m) => m.tokens(compiled.entryPlace, 1))
    .sinkPlaces(done, failed, bailed, suspended, paused)
    .semiflowInvariants(true)
    .timeout(120_000);
};

const verdict = async (builder: ReturnType<typeof seeded>, property: SmtProperty): Promise<SmtVerificationResult> =>
  builder.property(property).verify();

// ---------------------------------------------------------------------------------------------
// 1. The whole compiled net, from the entry place
// ---------------------------------------------------------------------------------------------

const shapes: ReadonlyArray<readonly [string, (bound: number) => WorkflowDescription]> = [
  ['a dowhile alone', (n) => only(loop(n))],
  ['a dountil alone', (n) => only(loop(n, tick, 'dountil'))],
  [
    'a loop between two steps',
    (n) => ({ id: 'w', entries: [{ kind: 'step', id: 'before' }, loop(n), { kind: 'step', id: 'after' }] }),
  ],
  ['a body with a delayed retry', (n) => only(loop(n, { kind: 'step', id: 'tick', retries: 1, retryDelayMs: 5 }))],
  ['a nested-workflow body', (n) => only(loop(n, { kind: 'step', id: 'tick', source: 'workflow' }))],
  ['a loop whose id is its body id', (n) => only(loop(n, tick, 'dowhile', 'tick'))],
  [
    'two loops in series',
    (n) => ({ id: 'w', entries: [loop(n, { kind: 'step', id: 'a' }, 'dowhile', 'first'), loop(n, { kind: 'step', id: 'b' }, 'dountil', 'second')] }),
  ],
];

const cases = shapes.flatMap(([name, make]) => [1, 2, 4].map((bound) => [name, bound, make(bound)] as const));

describe('loop, proved from the entry place', () => {
  it.each(cases)('%s at iterationBound %i is deadlock-free and terminates at a sink', async (_name, _bound, description) => {
    const reports = await verifyWorkflow(compile(description), { timeoutMs: 120_000 });

    expect(reports.map((r) => r.property)).toEqual(['deadlockFree', 'terminatesAtSink', 'exactlyOneTerminal']);
    for (const report of reports) {
      expect(report.result.verdict.type, describeReport(report)).toBe('proven');
    }
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------
// 2. The cycle at a real allowance, from the post-`start` marking
// ---------------------------------------------------------------------------------------------

describe('loop, proved from the post-start marking at a real allowance', () => {
  it.each([1, 2, 4])('strands nothing and reaches a terminal with an allowance of %i', async (k) => {
    const compiled = compile(only(loop(k)));

    const nothingStranded = await verdict(seeded(compiled, k), deadlockFree());
    const reachesTerminal = await verdict(seeded(compiled, k), terminatesAtSink());

    expect(nothingStranded.verdict.type, nothingStranded.report).toBe('proven');
    expect(reachesTerminal.verdict.type, reachesTerminal.report).toBe('proven');
  }, 300_000);

  it.each([1, 2, 4])('holds the allowance at %i, tightly, and never refills it', async (k) => {
    const compiled = compile(only(loop(k)));
    const budget = role(compiled.net, '.poll.budget');

    const atBound = await verdict(seeded(compiled, k), placeBound(budget, k));
    // The control that makes the line above a claim: the seeded tokens really are there.
    const tight = await verdict(seeded(compiled, k), placeBound(budget, k - 1));

    expect(atBound.verdict.type, atBound.report).toBe('proven');
    expect(tight.verdict.type, tight.report).toBe('violated');
  }, 300_000);

  it.each([1, 2, 4])('keeps one iteration in flight at an allowance of %i', async (k) => {
    const compiled = compile(only(loop(k)));
    const running = role(compiled.net, '.poll.running');

    const oneInFlight = await verdict(seeded(compiled, k), placeBound(running, 1));
    // An iteration does reach `running`, so a bound of zero must be violated — otherwise the
    // line above would be a claim about a dead place.
    const control = await verdict(seeded(compiled, k), placeBound(running, 0));

    expect(oneInFlight.verdict.type, oneInFlight.report).toBe('proven');
    expect(control.verdict.type, control.report).toBe('violated');
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------
// 3. The [IO-016] gap, pinned
// ---------------------------------------------------------------------------------------------

describe('loop: the allowance the entry-place proofs actually explore', () => {
  it('models an allowance of one at iterationBound 4 — the gap block 2 exists for', async () => {
    // The executor puts four tokens in `budget` here, and yet a bound of one comes back proven,
    // because every branch-enumerating analysis models one token per named place. This is a
    // characterisation of the encoding, not a property of the loop: the day it fails, block 1's
    // verdicts have become claims about the real allowance.
    const compiled = compile(only(loop(4)));
    const understated = await verdict(fromEntry(compiled), placeBound(role(compiled.net, '.poll.budget'), 1));

    expect(understated.verdict.type, understated.report).toBe('proven');
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------
// 4. Non-vacuity: the safeguards the verdicts rest on
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
  const arcs = (x: Transition) => x.inputSpecs.length + x.inhibitors.length + x.resets.length;
  if (arcs(built) !== arcs(t) - 1) throw new Error(`mutation ${JSON.stringify(m)} removed nothing from '${t.name}'`);
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

const typeOf = (r: SmtVerificationResult) => r.verdict.type;

describe('loop: removing a safeguard flips a verdict (non-vacuity)', () => {
  it("rests the bound on exhaust's inhibitor, not on priority", async () => {
    // Without the inhibitor, `exhaust` competes with `enter` for `ready` while allowance remains.
    // The executor still picks `enter` (priority 1 over 0), so the run is unchanged — and the
    // proof, which does not see priority, finds the marking where `exhaust` wins and strands the
    // allowance beside `wf.failed`. The exclusion the proof relies on is the arc.
    const description = only(loop(3));
    const broken = compile(description, { gadgets: { loop: mutated('exhaust', { dropInhibitor: '.budget' }) } });
    const runner = () =>
      new RecordingRunner({
        steps: { tick: (input) => ({ status: 'success', output: (input as number) + 1 }) },
        loops: { poll: (o) => (o as number) < 2 },
      });

    expect(await runWorkflow(broken, 0, { runner: runner() })).toEqual({ status: 'success', output: 2 });
    expect(await runWorkflow(compile(description), 0, { runner: runner() })).toEqual({ status: 'success', output: 2 });

    const [real] = await verifyWorkflow(compile(description), { timeoutMs: 120_000 });
    const [mutant] = await verifyWorkflow(broken, { timeoutMs: 120_000 });
    expect(real!.result.verdict.type, describeReport(real!)).toBe('proven');
    expect(mutant!.result.verdict.type, describeReport(mutant!)).toBe('violated');
  }, 300_000);

  it("needs the post-start marking to see finish's reset at all", async () => {
    // Measured, not argued: from the entry place the allowance is one, it is always spent by the
    // first `enter`, and leaving with allowance to spare is unreachable — so deleting `finish`'s
    // reset changes neither entry-place verdict. Seeded at a real allowance, `deadlockFree` fails.
    const description = only(loop(2));
    const broken = compile(description, { gadgets: { loop: mutated('finish', { dropReset: '.budget' }) } });

    const entryReports = await verifyWorkflow(broken, { timeoutMs: 120_000 });
    for (const report of entryReports) expect(report.result.verdict.type, describeReport(report)).toBe('proven');

    const real = await verdict(seeded(compile(description), 2), deadlockFree());
    const mutant = await verdict(seeded(broken, 2), deadlockFree());
    expect(real.verdict.type, real.report).toBe('proven');
    expect(mutant.verdict.type, mutant.report).toBe('violated');
  }, 300_000);

  it.each(['abort', 'leave-failed', 'leave-bailed', 'leave-suspended', 'leave-paused'])(
    "needs %s's reset on the allowance, at a real allowance",
    async (transitionRole) => {
      const description = only(loop(2));
      const broken = compile(description, { gadgets: { loop: mutated(transitionRole, { dropReset: '.budget' }) } });

      const mutant = await verdict(seeded(broken, 2), deadlockFree());
      expect(typeOf(mutant), mutant.report).toBe('violated');
    },
    300_000,
  );

  it('needs every body exit to consume the pending marker, even at an allowance of one', async () => {
    const broken = compile(only(loop(2)), { gadgets: { loop: mutated('leave-bailed', { dropInput: '.running' }) } });

    const [mutant] = await verifyWorkflow(broken, { timeoutMs: 120_000 });
    expect(mutant!.result.verdict.type, describeReport(mutant!)).toBe('violated');
  }, 300_000);
});

import { afterAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { Transition, arcPlace, type PetriNet, type Place } from 'libpetri';
import {
  SmtVerifier,
  deadlockFree,
  placeBound,
  quiescentCount,
  terminatesAtSink,
  type SmtProperty,
  type SmtVerificationResult,
} from 'libpetri/verification';
import { compile } from '../../src/compiler/compile.js';
import { loopGadget } from '../../src/compiler/gadgets/loop.js';
import type { Gadget } from '../../src/compiler/gadgets/types.js';
import type { CompiledWorkflow, EntryDescription, StepDescription, WorkflowDescription } from '../../src/compiler/types.js';
import { runWorkflow } from '../../src/engine/kernel.js';
import { cancelStructureViolations, describeReport, verifyWorkflow, type PropertyReport, type Segment } from '../../src/verify/index.js';
import { RecordingRunner } from '../fixtures/runner.js';

/**
 * What is proven about the loop, from which marking, in which environment mode, and what is not.
 *
 * Every verdict below is from `SmtVerifier` (untimed, value-blind, priority-blind), with all six
 * workflow terminals and the cancel place declared as sinks and semiflow invariants on —
 * `verifyWorkflow`'s configuration. Two segments, on the same closed net:
 *
 * - **closed** — the cancel request place starts empty: a run nobody cancels. Four properties:
 *   `deadlockFree`, `terminatesAtSink`, `exactlyOneTerminal`, and `neverCanceled`
 *   (`placeBound(wf.canceled, 0)`), which sees a sweep that fires without the signal.
 * - **cancel** — the request place is seeded with one token and `t.cancel.arrive` may move it to
 *   `wf.cancel` at every reachable point: one cancellation, landing anywhere. Three properties.
 *
 * Before any proof, `verifyWorkflow` runs `cancelStructureViolations`: an inhibitor on the signal
 * that no quiescence property can see is refused from the arcs (block 5).
 *
 * Two initial markings:
 *
 * 1. **From the entry place** (one token in the first entry's input, as `runWorkflow` seeds it).
 *    [IO-016] models one token per place a branch names, so `start`'s `iterationBound` deposit is
 *    explored as an allowance of **one** at every bound: these verdicts cover the topology, not
 *    the cycle running twice, and not a loop leaving with allowance to spare. Block 3 pins that.
 * 2. **From the post-`start` marking** (`ready` = 1, `budget` = k): the allowance seeded where
 *    the verifier reads it. Proven at k = 1, 2, 4. `start`'s deposit count itself is pinned by the
 *    executor tests in `tests/compiler/loop.test.ts`, not here.
 *
 * Set `LOOP_PROOF_LOG=<file>` to write every verdict's route and time to a file.
 */

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

type LoopType = 'dowhile' | 'dountil';
const SEGMENTS: readonly Segment[] = ['closed', 'cancel'];

const tick: StepDescription = { kind: 'step', id: 'tick' };
const loop = (iterationBound: number, body: StepDescription = tick, loopType: LoopType = 'dowhile', id = 'poll'): EntryDescription => ({
  kind: 'loop',
  id,
  loopType,
  iterationBound,
  body,
});
const only = (entry: EntryDescription): WorkflowDescription => ({ id: 'w', entries: [entry] });
const between = (entry: EntryDescription): WorkflowDescription => ({
  id: 'w',
  entries: [{ kind: 'step', id: 'before' }, entry, { kind: 'step', id: 'after' }],
});

function role<T>(net: PetriNet, suffix: string): Place<T> {
  const matches = [...net.places].filter((p) => p.name.endsWith(suffix));
  if (matches.length !== 1) throw new Error(`expected one place ending '${suffix}', got ${matches.length}`);
  return matches[0] as Place<T>;
}

const terminalsOf = (c: CompiledWorkflow) => {
  const { done, failed, bailed, suspended, paused, canceled } = c.terminals;
  return [done, failed, bailed, suspended, paused, canceled] as const;
};

/**
 * `verifyWorkflow`'s configuration, seeded at the post-`start` marking instead of the entry.
 * `verifyWorkflow` itself only seeds the entry place, so this rebuilds its configuration: same
 * sinks, same invariants, and the `cancel` segment seeded the same way — one token in the request
 * place, which `arrive` may move on at every reachable point. The net stays closed either way.
 */
const seeded = (compiled: CompiledWorkflow, allowance: number, segment: Segment = 'closed') =>
  SmtVerifier.forNet(compiled.net)
    .initialMarking((m) => {
      m.tokens(role(compiled.net, '.poll.ready'), 1).tokens(role(compiled.net, '.poll.budget'), allowance);
      if (segment === 'cancel') m.tokens(compiled.cancelRequest, 1);
    })
    .sinkPlaces(...terminalsOf(compiled), compiled.cancel)
    .semiflowInvariants(true)
    .timeout(120_000);

const fromEntry = (compiled: CompiledWorkflow) =>
  SmtVerifier.forNet(compiled.net)
    .initialMarking((m) => m.tokens(compiled.entryPlace, 1))
    .sinkPlaces(...terminalsOf(compiled), compiled.cancel)
    .semiflowInvariants(true)
    .timeout(120_000);

const verdict = async (builder: ReturnType<typeof seeded>, property: SmtProperty): Promise<SmtVerificationResult> =>
  builder.property(property).verify();

/** `verifyWorkflow`'s property set per segment, at the post-start marking. */
async function seededReports(compiled: CompiledWorkflow, k: number, segment: Segment): Promise<PropertyReport[]> {
  const reports: PropertyReport[] = [
    { property: 'deadlockFree', segment, result: await verdict(seeded(compiled, k, segment), deadlockFree()) },
    { property: 'terminatesAtSink', segment, result: await verdict(seeded(compiled, k, segment), terminatesAtSink()) },
    {
      property: 'exactlyOneTerminal',
      segment,
      result: await verdict(seeded(compiled, k, segment), quiescentCount(terminalsOf(compiled), 1, 1)),
    },
  ];
  if (segment === 'closed') {
    reports.push({ property: 'neverCanceled', segment, result: await verdict(seeded(compiled, k), placeBound(compiled.terminals.canceled, 0)) });
  }
  return reports;
}

const log: string[] = [];
const record = (label: string, reports: readonly PropertyReport[]) => {
  for (const r of reports) log.push(`${label} :: ${describeReport(r)}`);
};
afterAll(() => {
  const file = process.env['LOOP_PROOF_LOG'];
  if (file !== undefined) writeFileSync(file, `${log.join('\n')}\n`);
});

const CLOSED = ['closed/deadlockFree', 'closed/terminatesAtSink', 'closed/exactlyOneTerminal', 'closed/neverCanceled'];
const CANCEL = ['cancel/deadlockFree', 'cancel/terminatesAtSink', 'cancel/exactlyOneTerminal'];
const key = (r: PropertyReport) => `${r.segment}/${r.property}`;

/** Every report proven — `verdict.type === 'proven'`, never `!isViolated()`, which passes on `unknown`. */
const expectAllProven = (reports: readonly PropertyReport[], expected: readonly string[] = [...CLOSED, ...CANCEL]) => {
  expect(reports.map(key)).toEqual(expected);
  for (const report of reports) expect(report.result.verdict.type, describeReport(report)).toBe('proven');
};

/** `segment/property` -> verdict type, so a mutant's expectation names exactly what flips. */
const verdicts = (reports: readonly PropertyReport[]) => Object.fromEntries(reports.map((r) => [key(r), r.result.verdict.type]));
const described = (reports: readonly PropertyReport[]) => reports.map(describeReport).join('; ');

// ---------------------------------------------------------------------------------------------
// 1. The whole compiled net, from the entry place, both segments
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
  [
    'a step then a loop over the same step',
    (n) => ({ id: 'w', entries: [{ kind: 'step', id: 'tick' }, loop(n)] }),
  ],
];

const cases = shapes.flatMap(([name, make]) => [1, 2, 4].map((bound) => [name, bound, make(bound)] as const));

describe('loop, proved from the entry place', () => {
  it.each(cases)('%s at iterationBound %i: every property proven in both segments', async (name, bound, description) => {
    const compiled = compile(description);
    expect(cancelStructureViolations(compiled)).toEqual([]);

    const reports = await verifyWorkflow(compiled, { timeoutMs: 120_000 });
    record(`entry | ${name} | bound ${bound}`, reports);
    expectAllProven(reports);
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------
// 2. The cycle at a real allowance, from the post-`start` marking
// ---------------------------------------------------------------------------------------------

/**
 * Required, not optional: an entry-seeded proof models the allowance as one ([IO-016]), so it
 * cannot see a sweep that ends the loop with allowance to spare and does not clear it
 * (`cancel-produced`, `cancel-exiting` — block 5 shows both mutants proven from the entry and
 * violated here).
 */
describe('loop, proved from the post-start marking at a real allowance', () => {
  it.each([1, 2, 4].flatMap((k) => SEGMENTS.map((segment) => [k, segment] as const)))(
    'allowance %i, %s segment: every property proven',
    async (k, segment) => {
      const reports = await seededReports(compile(only(loop(k))), k, segment);
      record(`post-start | allowance ${k} | ${segment}`, reports);
      expectAllProven(reports, segment === 'closed' ? CLOSED : CANCEL);
    },
    300_000,
  );

  it.each([1, 2, 4])('holds the allowance at %i, tightly, and never refills it', async (k) => {
    const compiled = compile(only(loop(k)));
    const budget = role(compiled.net, '.poll.budget');

    const atBound = await verdict(seeded(compiled, k), placeBound(budget, k));
    // The control that makes the line above a claim: the seeded tokens really are there.
    const tight = await verdict(seeded(compiled, k), placeBound(budget, k - 1));

    expect(atBound.verdict.type, atBound.report).toBe('proven');
    expect(tight.verdict.type, tight.report).toBe('violated');
  }, 300_000);

  it.each([1, 2, 4])('keeps one iteration in flight at an allowance of %i, in both segments', async (k) => {
    const compiled = compile(only(loop(k)));
    const running = role(compiled.net, '.poll.running');

    for (const segment of SEGMENTS) {
      const oneInFlight = await verdict(seeded(compiled, k, segment), placeBound(running, 1));
      // An iteration does reach `running`, so a bound of zero must be violated — otherwise the
      // line above would be a claim about a dead place.
      const control = await verdict(seeded(compiled, k, segment), placeBound(running, 0));

      expect(oneInFlight.verdict.type, `${segment}: ${oneInFlight.report}`).toBe('proven');
      expect(control.verdict.type, `${segment}: ${control.report}`).toBe('violated');
    }
  }, 300_000);

  it('reaches wf.canceled from the post-start marking only when a cancel is seeded', async () => {
    // Non-vacuity of the cancel segment itself: the seeded request really lands and a sweep
    // really fires, so the cancel segment's three proofs are about runs that were canceled.
    const compiled = compile(only(loop(2)));
    const closed = await verdict(seeded(compiled, 2, 'closed'), placeBound(compiled.terminals.canceled, 0));
    const canceled = await verdict(seeded(compiled, 2, 'cancel'), placeBound(compiled.terminals.canceled, 0));

    expect(closed.verdict.type, closed.report).toBe('proven');
    expect(canceled.verdict.type, canceled.report).toBe('violated');
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
  readonly dropRead?: string;
}

/** Rebuilds one transition with one arc removed; everything else is copied verbatim. */
function rebuild(t: Transition, m: Mutation): Transition {
  const ends = (suffix: string | undefined) => (p: Place<unknown>) => suffix !== undefined && p.name.endsWith(suffix);
  const b = Transition.builder(t.name)
    .inputs(...t.inputSpecs.filter((s) => !ends(m.dropInput)(s.place)))
    .inhibitors(...t.inhibitors.map(arcPlace).filter((p) => !ends(m.dropInhibitor)(p)))
    .reads(...t.reads.map(arcPlace).filter((p) => !ends(m.dropRead)(p)))
    .resets(...t.resets.map(arcPlace).filter((p) => !ends(m.dropReset)(p)))
    .timing(t.timing)
    .priority(t.priority)
    .action(t.action);
  if (t.outputSpec !== null) b.outputs(t.outputSpec);
  const built = b.build();
  const arcs = (x: Transition) => x.inputSpecs.length + x.inhibitors.length + x.reads.length + x.resets.length;
  if (arcs(built) !== arcs(t) - 1) throw new Error(`mutation ${JSON.stringify(m)} removed nothing from '${t.name}'`);
  return built;
}

const hit = (transitions: readonly Transition[], transitionRole: string): Transition => {
  const hits = transitions.filter((t) => t.name.endsWith(`.${transitionRole}`));
  if (hits.length !== 1) throw new Error(`expected one '${transitionRole}' transition, got ${hits.length}`);
  return hits[0]!;
};

/** The real gadget with one arc of one transition removed — src is never edited. */
function mutated(transitionRole: string, m: Mutation): Gadget {
  return (entry, next, ctx) => {
    const result = loopGadget(entry, next, ctx);
    const target = hit(result.transitions, transitionRole);
    return { ...result, transitions: result.transitions.map((t) => (t === target ? rebuild(t, m) : t)) };
  };
}

/** The real gadget with one whole transition removed. */
function without(transitionRole: string): Gadget {
  return (entry, next, ctx) => {
    const result = loopGadget(entry, next, ctx);
    const target = hit(result.transitions, transitionRole);
    return { ...result, transitions: result.transitions.filter((t) => t !== target) };
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

    const real = await verifyWorkflow(compile(description), { timeoutMs: 120_000, segments: ['closed'] });
    const mutant = await verifyWorkflow(broken, { timeoutMs: 120_000, segments: ['closed'] });
    expectAllProven(real, CLOSED);
    expect(verdicts(mutant), described(mutant)).toMatchObject({ 'closed/deadlockFree': 'violated' });
  }, 300_000);

  it("needs the post-start marking to see finish's reset at all", async () => {
    // Measured, not argued: from the entry place the allowance is one, it is always spent by the
    // first `enter`, and leaving with allowance to spare is unreachable — so deleting `finish`'s
    // reset changes no entry-place verdict in either segment. Seeded at a real allowance,
    // `deadlockFree` fails.
    const description = only(loop(2));
    const broken = compile(description, { gadgets: { loop: mutated('finish', { dropReset: '.budget' }) } });

    expectAllProven(await verifyWorkflow(broken, { timeoutMs: 120_000 }));

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

    const mutant = await verifyWorkflow(broken, { timeoutMs: 120_000, segments: ['closed'] });
    expect(verdicts(mutant), described(mutant)).toMatchObject({ 'closed/deadlockFree': 'violated' });
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------
// 5. Non-vacuity of the cancellation structure
// ---------------------------------------------------------------------------------------------

describe('loop: removing a cancellation safeguard is caught — by structure, by a proof, or both', () => {
  it('the real loop passes the structural check', () => {
    expect(cancelStructureViolations(compile(only(loop(2))))).toEqual([]);
    expect(cancelStructureViolations(compile(between(loop(2))))).toEqual([]);
  });

  // The inhibitors. Without one, the guarded transition races its sweep and both roads end in
  // exactly one terminal, so no quiescence property can see it — last phase pinned that as a
  // characterisation. The structural check sees it exactly: each of these transitions needs every
  // input its sweep consumes, so it must be inhibited. `verifyWorkflow` refuses the mutant before
  // proving anything. The run-level flip is `tests/compiler/loop.test.ts` block 11.
  it.each([
    ['start', 'cancel-in'],
    ['enter', 'cancel-ready'],
    ['exhaust', 'cancel-ready'],
    ['check', 'cancel-produced'],
    ['finish', 'cancel-exiting'],
  ])("flags %s without its cancel inhibitor as competing with '%s'", async (transitionRole, sweep) => {
    const broken = compile(only(loop(2)), { gadgets: { loop: mutated(transitionRole, { dropInhibitor: 'wf.cancel' }) } });

    const violations = cancelStructureViolations(broken);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(new RegExp(`'t\\.0\\.poll\\.${transitionRole}' competes with sweep 't\\.0\\.poll\\.${sweep}'`));
    await expect(verifyWorkflow(broken, { timeoutMs: 120_000 })).rejects.toThrow(/cancellation structure is unsound/);
  });

  // Each sweep is the only way out of its place once the signal is marked, because the transition
  // that would continue is inhibited. Removing it strands the waiting token — structurally sound
  // (nothing races), so it is the cancel segment that catches it.
  it.each(['cancel-in', 'cancel-ready', 'cancel-produced', 'cancel-exiting'])(
    'needs the %s sweep: closed proven, cancel violated, from the entry place',
    async (sweep) => {
      const broken = compile(only(loop(2)), { gadgets: { loop: without(sweep) } });
      expect(cancelStructureViolations(broken)).toEqual([]);

      const reports = await verifyWorkflow(broken, { timeoutMs: 120_000 });
      record(`mutant without ${sweep} | entry`, reports);
      expectAllProven(reports.filter((r) => r.segment === 'closed'), CLOSED);
      expect(verdicts(reports), described(reports)).toMatchObject({
        'cancel/deadlockFree': 'violated',
        'cancel/exactlyOneTerminal': 'violated',
      });
    },
    300_000,
  );

  // A sweep that fires without the signal. That net still drains to exactly one terminal — only
  // sometimes the wrong one — and it is no longer a sweep, so the structural check has nothing to
  // compare; `neverCanceled` (closed segment) is what sees it.
  it.each(['cancel-in', 'cancel-ready', 'cancel-produced', 'cancel-exiting'])(
    'needs %s to read the signal: closed neverCanceled violated',
    async (sweep) => {
      const broken = compile(only(loop(2)), { gadgets: { loop: mutated(sweep, { dropRead: 'wf.cancel' }) } });
      expect(cancelStructureViolations(broken)).toEqual([]);

      const reports = await verifyWorkflow(broken, { timeoutMs: 120_000, segments: ['closed'] });
      record(`mutant ${sweep} without read | entry | closed`, reports);
      expect(verdicts(reports), described(reports)).toMatchObject({ 'closed/neverCanceled': 'violated' });
    },
    300_000,
  );

  // A sweep that ends the loop with allowance to spare must clear it. From the entry place the
  // allowance is one ([IO-016]) and `enter` has usually spent it, so for `cancel-produced` and
  // `cancel-exiting` only the post-start marking sees a missing reset — pinned on both sides.
  it.each([
    ['cancel-ready', 'violated'],
    ['cancel-produced', 'proven'],
    ['cancel-exiting', 'proven'],
  ] as const)(
    "needs %s's reset on the allowance: the post-start cancel segment sees it (from the entry: %s)",
    async (sweep, fromEntryVerdict) => {
      const broken = compile(only(loop(2)), { gadgets: { loop: mutated(sweep, { dropReset: '.budget' }) } });

      const closed = await seededReports(broken, 2, 'closed');
      record(`mutant ${sweep} without reset | post-start 2 | closed`, closed);
      expectAllProven(closed, CLOSED);

      const canceled = await seededReports(broken, 2, 'cancel');
      record(`mutant ${sweep} without reset | post-start 2 | cancel`, canceled);
      expect(verdicts(canceled), described(canceled)).toMatchObject({ 'cancel/deadlockFree': 'violated' });

      // The entry-seeded route: the blind spot for two of the three, measured.
      const entry = await verifyWorkflow(broken, { timeoutMs: 120_000 });
      record(`mutant ${sweep} without reset | entry`, entry);
      expectAllProven(entry.filter((r) => r.segment === 'closed'), CLOSED);
      expect(verdicts(entry)['cancel/deadlockFree'], described(entry)).toBe(fromEntryVerdict);
    },
    300_000,
  );

  it('needs cancel-produced to consume the pending marker', async () => {
    const broken = compile(only(loop(2)), { gadgets: { loop: mutated('cancel-produced', { dropInput: '.running' }) } });

    const reports = await verifyWorkflow(broken, { timeoutMs: 120_000 });
    expectAllProven(reports.filter((r) => r.segment === 'closed'), CLOSED);
    expect(verdicts(reports), described(reports)).toMatchObject({ 'cancel/deadlockFree': 'violated' });
  }, 300_000);

  it('would strand the marker and the allowance if the body were gated as well', async () => {
    // Why the body is emitted without the signal, beyond Mastra never checking inside one: a leaf
    // given it sweeps its waiting input straight to `wf.canceled` while `running` and `budget`
    // still hold tokens. The proofs catch that — so they would catch a future change that gates it.
    const gatedBody: Gadget = (entry, next, ctx) =>
      loopGadget(entry, next, {
        ...ctx,
        emitNested: (step, path, childNext, exits, options) =>
          ctx.emitNested(step, path, childNext, exits, { ...options, ...(ctx.cancel ? { cancel: ctx.cancel } : {}) }),
      });
    const broken = compile(only(loop(2)), { gadgets: { loop: gatedBody } });

    const reports = await verifyWorkflow(broken, { timeoutMs: 120_000 });
    expectAllProven(reports.filter((r) => r.segment === 'closed'), CLOSED);
    expect(verdicts(reports), described(reports)).toMatchObject({ 'cancel/deadlockFree': 'violated' });
  }, 300_000);
});

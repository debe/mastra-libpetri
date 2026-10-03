import { appendFileSync } from 'node:fs';
import { describe, expect, it, type ExpectStatic } from 'vitest';
import { Transition, and, xor, type Out, type Place } from 'libpetri';
import {
  SmtVerifier,
  deadlockFree,
  mutualExclusion,
  placeBound,
  terminatesAtSink,
  type SmtProperty,
  type SmtVerificationResult,
} from 'libpetri/verification';
import { compile, type Gadget } from '../../src/compiler/index.js';
import { budgetStructureViolations } from '../../src/verify/budget.js';
import { foreachGadget } from '../../src/compiler/gadgets/foreach.js';
import {
  cancelStructureViolations,
  describeReport,
  segmentInitialMarking,
  segmentLabel,
  segmentsFor,
  verifyWorkflow,
  type PropertyReport,
  type Segment,
} from '../../src/verify/index.js';
import type { CompiledWorkflow, EntryDescription, StepDescription } from '../../src/compiler/types.js';

/**
 * `.foreach`, proved — under libpetri 8.0.0's in-flight firing ([VER-004]), with a **30 s** budget
 * per query: a proof that does not close in that is a net to redesign, not a budget to raise.
 *
 * **What every proof here is about.** The initial marking is a segment's ([ADR 0007]): one token in
 * the workflow's entry place, or in the foreach's resume site, plus the cancel request when a
 * cancellation arrives, plus `k` permits under a run budget. The route is whichever
 * `verifyWorkflow` takes, recorded beside each figure (`PROOF_LOG`); semiflow invariants on; all six
 * workflow terminals and the cancel place are declared sinks. The encoding is untimed and
 * value-blind, so `start.l`'s "more items" / "last item" choice is free: **one proof covers every
 * item count at once**, the empty array included (`split`'s second branch, which opens the foreach
 * with the queue closed — so the cancel segment also covers an arrival *inside* an empty foreach,
 * row 49), and a non-array (its third).
 *
 * **Why it is cheap.** The net is bounded: every result and recorded outcome rides the frame, and
 * what has been recorded is a complement pair per kind — so no place holds more than one token.
 * Every arc a settle's outputs meet takes one token, so no settle is split. Up to three lanes the
 * whole state space enumerates; five lanes go to the solver and settle in seconds.
 *
 * `proven` is compared by string. `isViolated()` is false for `unknown` too, so a "not violated"
 * assertion would keep passing once a query started timing out. `unknown` fails, everywhere.
 */

const BUDGET_MS = 30_000;

const body = (extra: Omit<StepDescription, 'kind' | 'id'> = {}): StepDescription => ({ kind: 'step', id: 'body', ...extra });
const foreach = (concurrency: number, b: StepDescription = body()): EntryDescription => ({
  kind: 'foreach',
  id: 'items',
  body: b,
  concurrency,
});

function build(entries: readonly EntryDescription[], gadget?: Gadget, k?: number): CompiledWorkflow {
  return compile({ id: 'batch', entries }, { ...(gadget ? { gadgets: { foreach: gadget } } : {}), ...(k === undefined ? {} : { concurrency: k }) });
}

const cancels = (segment: Segment): boolean => (typeof segment === 'string' ? segment === 'cancel' : segment.cancel);

/**
 * Every property of every default segment, in the order `verifyWorkflow` runs them: `closed`,
 * `cancel`, then `resume@s` and `resume@s+cancel` per resume site ([ADR 0007]) — a foreach
 * registers its own site. `neverCanceled` only where no cancel arrives. With a run budget compiled
 * in ([ADR 0006]) each segment adds `permitsBounded` and `permitsReturned`.
 */
const everyKey = (compiled: CompiledWorkflow): string[] =>
  segmentsFor(compiled).flatMap((segment) =>
    [
      'deadlockFree',
      'terminatesAtSink',
      'exactlyOneTerminal',
      ...(cancels(segment) ? [] : ['neverCanceled']),
      ...(compiled.budget ? ['permitsBounded', 'permitsReturned'] : []),
    ].map((p) => `${segmentLabel(segment)}/${p}`),
  );
const keyOf = (r: PropertyReport): string => `${segmentLabel(r.segment)}/${r.property}`;

/** Appends a line to the file `PROOF_LOG` names, when it names one — the route-and-ms record. */
const proofLog = (line: string): void => {
  const file = process.env['PROOF_LOG'];
  if (file) appendFileSync(file, `${line}\n`);
};

/** `verifyWorkflow`'s default — the structural checks, then every segment — with every property `proven`. */
async function prove(expect: ExpectStatic, label: string, compiled: CompiledWorkflow): Promise<readonly PropertyReport[]> {
  const reports = await verifyWorkflow(compiled, { timeoutMs: BUDGET_MS });
  proofLog(`[${label}] ${reports.map(describeReport).join('; ')}`);
  expect(reports.map(keyOf)).toEqual(everyKey(compiled));
  for (const report of reports) expect(report.result.verdict.type, `${label}: ${describeReport(report)}`).toBe('proven');
  return reports;
}

/** Each verdict by `segment/property`, for a mutant whose verdicts are expected to flip. */
async function verdicts(label: string, compiled: CompiledWorkflow): Promise<Record<string, string>> {
  const reports = await verifyWorkflow(compiled, { timeoutMs: BUDGET_MS, structure: 'skip' });
  proofLog(`[${label}] ${reports.map(describeReport).join('; ')}`);
  return Object.fromEntries(reports.map((r) => [keyOf(r), r.result.verdict.type]));
}

/** One property from a segment's initial marking, under exactly the hypotheses `verifyWorkflow` uses. */
function check(compiled: CompiledWorkflow, property: SmtProperty, segment: Segment = 'closed'): Promise<SmtVerificationResult> {
  const t = compiled.terminals;
  const initial = segmentInitialMarking(compiled, segment);
  return SmtVerifier.forNet(compiled.net)
    .initialMarking((m) => {
      for (const [p, n] of initial) m.tokens(p, n);
    })
    .sinkPlaces(t.done, t.failed, t.bailed, t.suspended, t.paused, t.canceled, compiled.cancel, ...(compiled.budget ? [compiled.budget.permits] : []))
    .semiflowInvariants(true)
    .timeout(BUDGET_MS)
    .property(property)
    .verify();
}

const verdict = (r: SmtVerificationResult): string =>
  `${r.verdict.type} via ${r.route} in ${r.elapsedMs}ms${r.verdict.type === 'unknown' ? ` (${r.verdict.reason})` : ''}`;

function placeNamed(compiled: CompiledWorkflow, name: string): Place<unknown> {
  const found = [...compiled.net.places].find((p) => p.name === name);
  if (found === undefined) throw new Error(`no place '${name}' in the compiled net`);
  return found as Place<unknown>;
}

// -------------------------------------------------------------------------------------------
// Mutated copies. The real gadget is compiled and one arc is removed from the named
// transitions; `src` is never edited. A mutation that matches nothing throws, so a renamed
// transition cannot turn a check vacuous. The proofs never run an action, so a mutant's action
// is left as it was.
// -------------------------------------------------------------------------------------------

interface Mutation {
  readonly transition: RegExp;
  readonly dropInhibitor?: RegExp;
  readonly dropInput?: RegExp;
  readonly dropRead?: RegExp;
  /** Removes matching places from every `and` in the output spec. */
  readonly dropOutput?: RegExp;
}

function pruneOut(out: Out, drop: RegExp): Out {
  switch (out.type) {
    case 'and':
      return and(...out.children.filter((c) => !(c.type === 'place' && drop.test(c.place.name))).map((c) => pruneOut(c, drop)));
    case 'xor':
      return xor(...out.children.map((c) => pruneOut(c, drop)));
    default:
      return out;
  }
}

function rebuild(t: Transition, m: Mutation): Transition {
  const b = Transition.builder(t.name)
    .inputs(...t.inputSpecs.filter((spec) => !(m.dropInput?.test(spec.place.name) ?? false)))
    .outputs(m.dropOutput ? pruneOut(t.outputSpec!, m.dropOutput) : t.outputSpec!)
    .timing(t.timing)
    .priority(t.priority)
    .action(t.action);
  for (const arc of t.inhibitors) if (!(m.dropInhibitor?.test(arc.place.name) ?? false)) b.inhibitor(arc.place);
  for (const arc of t.reads) if (!(m.dropRead?.test(arc.place.name) ?? false)) b.read(arc.place);
  for (const arc of t.resets) b.reset(arc.place);
  return b.build();
}

function mutated(m: Mutation): Gadget {
  return (entry, next, ctx) => {
    const result = foreachGadget(entry, next, ctx);
    let touched = 0;
    const transitions = result.transitions.map((t) => {
      if (!m.transition.test(t.name)) return t;
      touched++;
      return rebuild(t, m);
    });
    if (touched === 0) throw new Error(`mutation ${String(m.transition)} matched no transition`);
    return { ...result, transitions };
  };
}

// ===========================================================================================

/** Per-test budget: a test asks up to a few dozen queries of at most 30 s each. */
const T = { timeout: 600_000 } as const;

/**
 * Every query spawns its own solver or enumerates in-process and no test shares state, so the
 * blocks run concurrently; assertions therefore use the test's own `expect`.
 */
describe.concurrent('compiled foreach, proved (every segment)', () => {
  it.for([1, 2, 3, 5])('is deadlock-free, never canceled unasked, and ends in exactly one terminal with %i lane(s)', T, async (lanes, { expect }) => {
    await prove(expect, `foreach(c=${lanes})`, build([foreach(lanes)]));
  });

  it('stays provable when the foreach is neither first nor last', T, async ({ expect }) => {
    // `next` is then another entry's input rather than `wf.done`, so `join` and the empty
    // foreach deposit into live structure — and, under cancel, into its sweep.
    await prove(expect, '[before, foreach(c=2), after]', build([{ kind: 'step', id: 'before' }, foreach(2), { kind: 'step', id: 'after' }]));
  });

  it('stays provable when the body retries with a delay', T, async ({ expect }) => {
    // The leaf's unrolled retries sit inside each lane, between `start.l` and the settles, and are
    // not gated: a cancel landing mid-retry must still let the lane come home. A timed net, so the
    // solver's route, never enumeration.
    await prove(expect, 'foreach(c=2, body retries=1 delay=10)', build([foreach(2, body({ retries: 1, retryDelayMs: 10 }))]));
  });
});

/**
 * The run budget composes with the lanes ([ADR 0006], M3). A lane is the foreach's own bound — at
 * most `c` items dispatched — and each item's step attempt then takes one of the run's `k` permits
 * on top of it, handing it back on every outcome branch; no foreach transition touches the
 * permits. Proven for c = 2 at k = 1 (the budget binds below the lane count) and k = 2 (they
 * coincide), from every segment, the foreach's resume site included.
 */
describe.concurrent('compiled foreach under a run budget, proved (every segment)', () => {
  it.for([1, 2])('c = 2, k = %i: the budget is conserved from the arcs, and every property of every segment is proven', T, async (k, { expect }) => {
    const compiled = build([foreach(2)], undefined, k);
    expect(compiled.budget?.k).toBe(k);
    expect(budgetStructureViolations(compiled)).toEqual([]);
    await prove(expect, `foreach(c=2) k=${k}`, compiled);
  });
});

/**
 * Fail-fast, as a marking property again. A failure, bail or pause is recorded only by a settle that
 * took the queue — waiting for any `start` in flight to give it back — and nothing reopens a closed
 * queue, so the open queue is never marked beside a recorded one, in-flight firing included. That
 * is "no item starts once an outcome is recorded", for every interleaving and every item count.
 * Not a suspension: a resume carries suspensions beside an open queue, as Mastra's does.
 */
describe.concurrent('compiled foreach: dispatch stops at the first failure, bail or pause', () => {
  it.for<[number, Segment]>([
    [2, 'closed'],
    [2, 'cancel'],
    [3, 'closed'],
  ])('the open queue is never marked beside a recorded failure, bail or pause (%i lanes, %s)', T, async ([lanes, segment], { expect }) => {
    const compiled = build([foreach(lanes)]);
    const open = placeNamed(compiled, 's.0.items.queue.open');
    for (const recorded of ['fault', 'exit']) {
      const r = await check(compiled, mutualExclusion(open, placeNamed(compiled, `s.0.items.${recorded}`)), segment);
      proofLog(`[foreach(c=${lanes}) ${segmentLabel(segment)} mutualExclusion(queue.open, ${recorded})] ${verdict(r)}`);
      expect(r.verdict.type, `${recorded}: ${verdict(r)}`).toBe('proven');
    }
  });

  it('every place holds at most one token: the data rides the frame', T, async ({ expect }) => {
    const compiled = build([foreach(2)]);
    for (const p of [...compiled.net.places].filter((x) => x.name.startsWith('s.0.items.'))) {
      const r = await check(compiled, placeBound(p, 1));
      expect(r.verdict.type, `${p.name}: ${verdict(r)}`).toBe('proven');
    }
  });

  it('a recorded flag and its complement are never marked together', T, async ({ expect }) => {
    const compiled = build([foreach(2)]);
    for (const kind of ['fault', 'exit', 'susp']) {
      const r = await check(compiled, mutualExclusion(placeNamed(compiled, `s.0.items.no-${kind}`), placeNamed(compiled, `s.0.items.${kind}`)));
      expect(r.verdict.type, `${kind}: ${verdict(r)}`).toBe('proven');
    }
  });
});

/**
 * Each safeguard removed once, and the property that sees it. 2 lanes, closed segment unless noted.
 */
describe.concurrent('compiled foreach: each safeguard is load-bearing (mutated copies)', () => {
  it('a settle that does not take the queue lets an item start after a recorded failure', T, async ({ expect }) => {
    const compiled = build([foreach(2)], mutated({ transition: /\.lane\d+\.fail$/, dropInput: /\.queue\.open$/, dropOutput: /\.queue\.closed$/ }));
    const r = await check(compiled, mutualExclusion(placeNamed(compiled, 's.0.items.queue.open'), placeNamed(compiled, 's.0.items.fault')));
    expect(r.verdict.type, verdict(r)).toBe('violated');
  });

  /**
   * Each row removes one arc and expects `DeadlockFree` to fail: the arc is what keeps some token
   * from being stranded at quiescence — a flag, a lane's outcome, the queue. Together the rows cover
   * every flag arc the finishers rely on, the queue a finisher waits for, and the permits.
   */
  it.for<[string, Mutation]>([
    ['join fires beside a recorded failure', { transition: /\.items\.join$/, dropInput: /\.no-fault$/ }],
    ['join fires beside a recorded bail or pause', { transition: /\.items\.join$/, dropInput: /\.no-exit$/ }],
    ['join fires beside a recorded suspension', { transition: /\.items\.join$/, dropInput: /\.no-susp$/ }],
    ['join fires with items still queued', { transition: /\.items\.join$/, dropInput: /\.queue\.closed$/ }],
    ['a bail is decided over a failure', { transition: /\.items\.exit\./, dropInput: /\.no-fault$/ }],
    ['a suspension is decided over a failure', { transition: /\.items\.suspend$/, dropInput: /\.no-fault$/ }],
    ['a suspension is decided over a bail', { transition: /\.items\.suspend$/, dropInput: /\.no-exit$/ }],
    ['a failure is decided under a running item', { transition: /\.items\.fail\./, dropInput: /\.permit$/ }],
    ['a settle does not give the lane back', { transition: /\.lane\d+\.fail/, dropOutput: /\.permit$/ }],
  ])('DeadlockFree is violated when %s', T, async ([, mutation], { expect }) => {
    const r = await check(build([foreach(2)], mutated(mutation)), deadlockFree(), 'closed');
    expect(r.verdict.type, verdict(r)).toBe('violated');
  });

  it('TerminatesAtSink is violated when a settle does not give the lane back', T, async ({ expect }) => {
    // The complementary claim: with a permit gone, no finisher can ever fire, so the net comes
    // to rest with no terminal marked at all.
    const r = await check(build([foreach(2)], mutated({ transition: /\.lane\d+\.fail/, dropOutput: /\.permit$/ })), terminatesAtSink());
    expect(r.verdict.type, verdict(r)).toBe('violated');
  });
});

/**
 * The cancellation safeguards the *proofs* see, each removed once: invisible to the closed segment
 * — without a cancel none of these arcs is consulted — and flipping the cancel segment. The
 * structural check passes on each (none of them is an inhibitor on the signal).
 */
describe.concurrent('compiled foreach: each cancellation safeguard is load-bearing (mutated copies, 1 lane)', () => {
  const closedProven = {
    'closed/deadlockFree': 'proven',
    'closed/terminatesAtSink': 'proven',
    'closed/exactlyOneTerminal': 'proven',
    'closed/neverCanceled': 'proven',
  };

  it('without the sweep on its input, a cancel before split strands the input', T, async ({ expect }) => {
    const noSweep: Gadget = (entry, next, ctx) => {
      const r = foreachGadget(entry, next, ctx);
      const kept = r.transitions.filter((t) => !/\.items\.cancel$/.test(t.name));
      if (kept.length !== r.transitions.length - 1) throw new Error('the sweep was not found — the check would be vacuous');
      return { ...r, transitions: kept };
    };
    const compiled = build([foreach(1)], noSweep);
    expect(cancelStructureViolations(compiled)).toEqual([]);
    const v = await verdicts('MUTANT c=1 no sweep', compiled);
    expect(v).toMatchObject(closedProven);
    expect(v).toMatchObject({ 'cancel/deadlockFree': 'violated', 'cancel/exactlyOneTerminal': 'violated' });
  });

  it.for<[string, Mutation]>([
    ['a cancel finisher fires with items still queued', { transition: /\.items\.canceled\./, dropInput: /\.queue\.closed$/ }],
    ['a cancel finisher fires under a running item', { transition: /\.items\.canceled\./, dropInput: /\.permit$/ }],
    ['a cancel finisher leaves a recorded failure behind', { transition: /\.items\.canceled\.f/, dropInput: /\.fault$/ }],
  ])('closed segment proven, cancel segment violated, when %s', T, async ([label, mutation], { expect }) => {
    const compiled = build([foreach(1)], mutated(mutation));
    expect(cancelStructureViolations(compiled)).toEqual([]);
    const v = await verdicts(`MUTANT c=1 ${label}`, compiled);
    expect(v).toMatchObject(closedProven);
    expect(v).toMatchObject({ 'cancel/deadlockFree': 'violated' });
  });

  it('without refuse, the queue a cancel stops is never closed: the cancel segment strands it', T, async ({ expect }) => {
    const noRefuse: Gadget = (entry, next, ctx) => {
      const r = foreachGadget(entry, next, ctx);
      return { ...r, transitions: r.transitions.filter((t) => !/\.lane\d+\.refuse$/.test(t.name)) };
    };
    const v = await verdicts('MUTANT c=1 no refuse', build([foreach(1)], noRefuse));
    expect(v).toMatchObject(closedProven);
    expect(v).toMatchObject({ 'cancel/deadlockFree': 'violated' });
  });

  /**
   * The finishers' read arc on the signal. Without it the net still drains to exactly one terminal
   * in both segments — but a run nobody canceled can end in `wf.canceled`. `closed/neverCanceled`
   * is the property that sees it; the arc-level check does not, because a transition that neither
   * reads nor inhibits the signal is not a sweep.
   */
  it('without the cancel finishers\' read arc, closed/neverCanceled is violated and nothing else is', T, async ({ expect }) => {
    const compiled = build([foreach(1)], mutated({ transition: /\.items\.canceled\./, dropRead: /^wf\.cancel$/ }));
    expect(cancelStructureViolations(compiled)).toEqual([]);
    const v = await verdicts('MUTANT c=1 cancel finishers without read(cancel)', compiled);
    expect(v).toEqual({
      'closed/deadlockFree': 'proven',
      'closed/terminatesAtSink': 'proven',
      'closed/exactlyOneTerminal': 'proven',
      'closed/neverCanceled': 'violated',
      'cancel/deadlockFree': 'proven',
      'cancel/terminatesAtSink': 'proven',
      'cancel/exactlyOneTerminal': 'proven',
      // Resumed at the foreach's own site ([ADR 0007]): the finishers are reached from there too,
      // so the resumed segment without a cancel sees the same, and the one with a cancel does not.
      'resume@0/deadlockFree': 'proven',
      'resume@0/terminatesAtSink': 'proven',
      'resume@0/exactlyOneTerminal': 'proven',
      'resume@0/neverCanceled': 'violated',
      'resume@0+cancel/deadlockFree': 'proven',
      'resume@0+cancel/terminatesAtSink': 'proven',
      'resume@0+cancel/exactlyOneTerminal': 'proven',
    });
  });
});

/**
 * The inhibitors on the signal, which no quiescence property can see: each only stops work Mastra
 * would not start, and the run still drains to one terminal. Each is checked from the arcs — it is
 * what `cancelStructureViolations` exists for — and each has a run-level flip in
 * `tests/compiler/foreach.test.ts`. Only the inhibitor on `wf.cancel` is removed.
 */
describe('compiled foreach: every inhibitor on the signal has structural teeth', () => {
  const stripSignal = (transition: RegExp): Gadget => (entry, next, ctx) => {
    const r = foreachGadget(entry, next, ctx);
    let touched = 0;
    const transitions = r.transitions.map((t) => {
      if (!transition.test(t.name)) return t;
      touched++;
      const b = Transition.builder(t.name).inputs(...t.inputSpecs).outputs(t.outputSpec!).action(t.action).timing(t.timing).priority(t.priority);
      for (const a of t.inhibitors) if (a.place.name !== ctx.cancel?.name) b.inhibitor(a.place);
      for (const a of t.reads) b.read(a.place);
      for (const a of t.resets) b.reset(a.place);
      return b.build();
    });
    if (touched === 0) throw new Error(`${String(transition)} matched no transition — the check would be vacuous`);
    return { ...r, transitions };
  };

  const gated = /\.items\.(split|lane\d+\.start|join|fail\.[a-z]+|exit\.[a-z]+|suspend|re-enter)$/;

  it('the real gadget is structurally sound, and every transition that starts or decides work carries the inhibitor', () => {
    const real = build([foreach(2)]);
    expect(cancelStructureViolations(real)).toEqual([]);
    const starters = [...real.net.transitions].filter((t) => gated.test(t.name));
    expect(starters.map((t) => t.name.replace('t.0.items.', '')).sort()).toEqual(
      ['split', 'lane0.start', 'lane1.start', 'join', 'fail.f', 'fail.fe', 'fail.fs', 'fail.fes', 'exit.e', 'exit.es', 'suspend', 're-enter'].sort(),
    );
    for (const t of starters) expect(t.inhibitors.map((a) => a.place.name), t.name).toContain('wf.cancel');
  });

  it.each<[string, RegExp]>([
    ['split', /\.items\.split$/],
    ['lane.start (dispatch)', /\.lane\d+\.start$/],
    ['join', /\.items\.join$/],
    ['fail', /\.items\.fail\./],
    ['exit', /\.items\.exit\./],
    ['suspend', /\.items\.suspend$/],
    ['re-enter', /\.items\.re-enter$/],
  ])('%s without its inhibitor on the signal: the structural check names it, and the proof refuses the net', async (_role, transition) => {
    const mutant = build([foreach(2)], stripSignal(transition));
    const named = cancelStructureViolations(mutant);
    expect(named.length).toBeGreaterThan(0);
    for (const line of named) expect(line).toMatch(/without an inhibitor on 'wf\.cancel'/);
    const stripped = [...mutant.net.transitions].filter((t) => transition.test(t.name)).map((t) => t.name);
    for (const name of stripped) expect(named.some((line) => line.startsWith(`'${name}'`)), `${name} named`).toBe(true);
    await expect(verifyWorkflow(mutant, { timeoutMs: 1_000 })).rejects.toThrow('cancellation structure is unsound');
  });
});

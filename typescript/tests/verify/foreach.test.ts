import { appendFileSync } from 'node:fs';
import { describe, it, type ExpectStatic } from 'vitest';
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
  segmentLabel,
  segmentsFor,
  verifyWorkflow,
  type PropertyReport,
  type Segment,
} from '../../src/verify/index.js';
import type { CompiledWorkflow, EntryDescription, StepDescription } from '../../src/compiler/types.js';

/**
 * `.foreach`, proved.
 *
 * **What every proof here is about.** The initial marking is one token in the workflow's entry
 * place; the route is whichever `verifyWorkflow` takes (SMT for every foreach shape measured —
 * the per-lane copies put it past enumeration), recorded beside each figure; semiflow invariants
 * on; all six workflow terminals and the cancel place are declared sinks. Two segments on the one
 * closed net: **closed** (the cancel request place empty — a run nobody cancels) and **cancel**
 * (the request place seeded with one token, so the arrival may fire at every reachable point, from
 * before `split` to after the terminal). `verifyWorkflow` runs both by default and runs
 * `cancelStructureViolations` first. The encoding is untimed and value-blind, so `start.l`'s "more
 * items" / "last item" choice is free: **one proof covers every item count at once**, including
 * the empty array (`split`'s second branch, which opens the foreach with no cursor and leaves it
 * to `join-empty` or `canceled-empty` — so the cancel segment also covers an arrival *inside* an
 * empty foreach, row 49) and a non-array (its third). The shapes below therefore vary only in
 * concurrency, in what surrounds the foreach and in the run's step budget.
 *
 * `proven` is compared by string. `isViolated()` is false for `unknown` too, so a "not violated"
 * assertion would keep passing once a query started timing out. `unknown` fails, everywhere.
 *
 * **Cost.** foreach stays on SMT; `closed/deadlockFree` is the expensive query (tens of seconds at
 * two lanes, minutes at three). One and two lanes run in the default suite; three and more run
 * only in the slow lane below (`SLOW_PROOFS=1`, 600s per query). Set `PROOF_LOG` to a file to
 * record every figure with its route.
 */

const body = (extra: Omit<StepDescription, 'kind' | 'id'> = {}): StepDescription => ({ kind: 'step', id: 'body', ...extra });
const foreach = (concurrency: number, b: StepDescription = body()): EntryDescription => ({
  kind: 'foreach',
  id: 'items',
  body: b,
  concurrency,
});

function build(entries: readonly EntryDescription[], gadget?: Gadget): CompiledWorkflow {
  return compile({ id: 'batch', entries }, gadget ? { gadgets: { foreach: gadget } } : {});
}

const cancels = (segment: Segment): boolean => (typeof segment === 'string' ? segment === 'cancel' : segment.cancel);

/**
 * Every property of every default segment, in the order `verifyWorkflow` runs them: `closed`,
 * `cancel`, then `resume@s` and `resume@s+cancel` per resume site ([ADR 0007]) — a foreach
 * registers its own site. `neverCanceled` only where no cancel arrives. With a run budget compiled
 * in ([ADR 0006]) each segment adds `permitsBounded` (`placeBound(wf.permits, k)`) and
 * `permitsReturned` (`quiescentCount([wf.permits], k, k)`), and every initial marking also holds
 * `k` permits.
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

/**
 * `verifyWorkflow`'s default — the structural checks, then every segment, the foreach's resume
 * site's two included — with every property `proven`. Logs each report's route and time under
 * `label`.
 */
async function prove(
  expect: ExpectStatic,
  label: string,
  compiled: CompiledWorkflow,
  timeoutMs = 300_000,
): Promise<readonly PropertyReport[]> {
  const reports = await verifyWorkflow(compiled, { timeoutMs });
  proofLog(`[${label}] ${reports.map(describeReport).join('; ')}`);
  expect(reports.map(keyOf)).toEqual(everyKey(compiled));
  for (const report of reports) expect(report.result.verdict.type, `${label}: ${describeReport(report)}`).toBe('proven');
  return reports;
}

/** Each verdict by `segment/property`, for a mutant whose verdicts are expected to flip. */
async function verdicts(label: string, compiled: CompiledWorkflow, timeoutMs = 300_000): Promise<Record<string, string>> {
  const reports = await verifyWorkflow(compiled, { timeoutMs });
  proofLog(`[${label}] ${reports.map(describeReport).join('; ')}`);
  return Object.fromEntries(reports.map((r) => [keyOf(r), r.result.verdict.type]));
}

/**
 * One property, under exactly the hypotheses `verifyWorkflow` uses — every terminal and the cancel
 * place are sinks, and in the `cancel` segment the request place is seeded with one token.
 */
function check(
  compiled: CompiledWorkflow,
  property: SmtProperty,
  segment: Segment = 'closed',
  timeoutMs = 120_000,
): Promise<SmtVerificationResult> {
  const { terminals } = compiled;
  return SmtVerifier.forNet(compiled.net)
    .initialMarking((m) => {
      m.tokens(compiled.entryPlace, 1);
      if (segment === 'cancel') m.tokens(compiled.cancelRequest, 1);
    })
    .sinkPlaces(
      terminals.done,
      terminals.failed,
      terminals.bailed,
      terminals.suspended,
      terminals.paused,
      terminals.canceled,
      compiled.cancel,
    )
    .semiflowInvariants(true)
    .timeout(timeoutMs)
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
// transition cannot turn a check vacuous.
// -------------------------------------------------------------------------------------------

interface Mutation {
  readonly transition: RegExp;
  readonly dropInhibitor?: RegExp;
  readonly dropReset?: RegExp;
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
  for (const arc of t.resets) if (!(m.dropReset?.test(arc.place.name) ?? false)) b.reset(arc.place);
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

/** Per-test budget: each query's own solver budget is at most 300s, and a test runs up to seven. */
const SLOW = { timeout: 1_800_000 } as const;

/** The slow lane: three lanes and more, 600s per query. Opt in with `SLOW_PROOFS=1`. */
const SLOW_LANE = process.env['SLOW_PROOFS'] === '1';

/**
 * Every query spawns its own Z3 process and no test shares state, so the blocks run concurrently;
 * assertions therefore use the test's own `expect`.
 */
describe.concurrent('compiled foreach, proved (both segments)', () => {
  it.for([1, 2])('is deadlock-free, never canceled unasked, and ends in exactly one terminal with %i lane(s)', SLOW, async (lanes, { expect }) => {
    await prove(expect, `foreach(c=${lanes})`, build([foreach(lanes)]));
  });

  it('stays provable when the foreach is neither first nor last', SLOW, async ({ expect }) => {
    // `next` is then another entry's input rather than `wf.done`, so `join` and `split`'s
    // no-items branch deposit into live structure — and, under cancel, into its sweep.
    await prove(expect, '[before, foreach(c=2), after]', build([{ kind: 'step', id: 'before' }, foreach(2), { kind: 'step', id: 'after' }]));
  });

  it('stays provable when the body retries with a delay', SLOW, async ({ expect }) => {
    // The leaf's unrolled retries sit inside each lane, between `start.l` and the settles, and are
    // not gated: a cancel landing mid-retry must still let the lane come home.
    await prove(expect, 'foreach(c=2, body retries=1 delay=10)', build([foreach(2, body({ retries: 1, retryDelayMs: 10 }))]));
  });
});

/**
 * The run budget composes with the lanes ([ADR 0006], M3). A lane is the foreach's own bound — at
 * most `c` items dispatched — and each item's step attempt then takes one of the run's `k` permits
 * on top of it, handing it back on every outcome branch; no foreach transition touches the
 * permits. So an item can sit in its lane waiting for a permit, and neither bound can starve the
 * other: a lane holds no permit while it waits, and a permit is never held across a settle, a
 * retry delay or a finisher. Proven for c = 2 at k = 1 (the budget binds below the lane count) and
 * k = 2 (they coincide): the initial marking is one token in the entry place plus `k` permits,
 * plus the cancel request in the `cancel` segment; route SMT, as for every foreach shape; eleven
 * properties, and the same eleven again from the foreach's resume site `resume@0` with and without
 * a cancel ([ADR 0007]), whose marking also holds the `k` permits. Peak items in flight = min(c, k) is measured by `tests/compiler/foreach.test.ts`
 * — "in flight" is an executor notion (a transition whose action has not returned), not a marking.
 */
describe.concurrent('compiled foreach under a run budget, proved (both segments)', () => {
  it.for([1, 2])('c = 2, k = %i: the budget is conserved from the arcs, and every property of every segment is proven', SLOW, async (k, { expect }) => {
    const compiled = compile({ id: 'batch', entries: [foreach(2)] }, { concurrency: k });
    expect(compiled.budget?.k).toBe(k);
    expect(budgetStructureViolations(compiled)).toEqual([]);
    await prove(expect, `foreach(c=2) k=${k}`, compiled, 300_000);
  });
});

describe.runIf(SLOW_LANE).concurrent('SLOW LANE (SLOW_PROOFS=1): compiled foreach with three lanes, 600s per query', () => {
  const BUDGET = { timeout: 7 * 600_000 + 60_000 } as const;

  it('is deadlock-free, never canceled unasked, and ends in exactly one terminal with 3 lanes', BUDGET, async ({ expect }) => {
    await prove(expect, 'foreach(c=3)', build([foreach(3)]), 600_000);
  });

  it('never holds the cursor beside a recorded outcome with 3 lanes', BUDGET, async ({ expect }) => {
    const compiled = build([foreach(3)]);
    const cursor = placeNamed(compiled, 's.0.items.cursor');
    for (const record of ['faults', 'exits', 'suspensions']) {
      const r = await check(compiled, mutualExclusion(cursor, placeNamed(compiled, `s.0.items.${record}`)), 'closed', 600_000);
      proofLog(`[foreach(c=3) closed mutualExclusion(cursor, ${record})] ${verdict(r)}`);
      expect(r.verdict.type, `cursor vs ${record}: ${verdict(r)}`).toBe('proven');
    }
  });
});

describe.concurrent('compiled foreach: dispatch stops at the first non-success item', () => {
  /**
   * The verifier's half of fail-fast. `start.l` needs the cursor, so "the cursor is never marked
   * together with a recorded outcome" is "no item can start once an outcome is recorded" — for
   * every interleaving and every item count.
   *
   * The other half — no start between an item's outcome and its settle — is the start
   * transitions' inhibitor arcs, true by the firing rule rather than by a marking property (a
   * marking cannot say which of two firings came first). It is shown structurally and by an
   * executor test in `tests/compiler/foreach.test.ts`.
   */
  it.for<Segment>(['closed', 'cancel'])('never holds the cursor beside a recorded outcome with 2 lanes (%s)', SLOW, async (segment, { expect }) => {
    // Under cancel, `refuse.l` or a cancel finisher removes the cursor; neither may reopen the
    // window in which an item starts beside a recorded outcome.
    const compiled = build([foreach(2)]);
    const cursor = placeNamed(compiled, 's.0.items.cursor');
    for (const record of ['faults', 'exits', 'suspensions']) {
      const r = await check(compiled, mutualExclusion(cursor, placeNamed(compiled, `s.0.items.${record}`)), segment, 300_000);
      proofLog(`[foreach(c=2) ${segment} mutualExclusion(cursor, ${record})] ${verdict(r)}`);
      expect(r.verdict.type, `${segment}: cursor vs ${record}: ${verdict(r)}`).toBe('proven');
    }
  });

  it('bounds each outcome record by the lane count, and the bound is tight', async ({ expect }) => {
    const compiled = build([foreach(2)]);
    for (const record of ['faults', 'exits', 'suspensions']) {
      const at = placeNamed(compiled, `s.0.items.${record}`);
      const bounded = await check(compiled, placeBound(at, 2));
      expect(bounded.verdict.type, `${record} <= 2: ${verdict(bounded)}`).toBe('proven');
      // Both lanes can be mid-item when the first outcome lands, so two records are reachable.
      const tighter = await check(compiled, placeBound(at, 1));
      expect(tighter.verdict.type, `${record} <= 1: ${verdict(tighter)}`).toBe('violated');
    }
  }, SLOW.timeout);
});

describe.concurrent('compiled foreach: per-lane invariants', () => {
  it('keeps every per-lane place 1-bounded and permit/slot exclusive', async ({ expect }) => {
    const compiled = build([foreach(2)]);
    const oneBounded = [
      's.0.items.in',
      // A 1-bounded cursor is what makes each index unique.
      's.0.items.cursor',
      ...[0, 1].flatMap((l) =>
        ['permit', 'slot', 'done', 'failed', 'bailed', 'suspended', 'paused'].map((role) => `s.0.items.lane${l}.${role}`),
      ),
    ];
    for (const name of oneBounded) {
      const r = await check(compiled, placeBound(placeNamed(compiled, name), 1));
      expect(r.verdict.type, `${name}: ${verdict(r)}`).toBe('proven');
    }
    for (const l of [0, 1]) {
      const r = await check(
        compiled,
        mutualExclusion(placeNamed(compiled, `s.0.items.lane${l}.permit`), placeNamed(compiled, `s.0.items.lane${l}.slot`)),
      );
      expect(r.verdict.type, `lane${l} permit/slot: ${verdict(r)}`).toBe('proven');
    }
  }, SLOW.timeout);

  it('records that results are genuinely unbounded', async ({ expect }) => {
    // Not a strand — `DeadlockFree` proves above — but the count is the input's length, which
    // is data. The verifier finds a real counterexample (dispatch, collect, dispatch again).
    const compiled = build([foreach(2)]);
    const r = await check(compiled, placeBound(placeNamed(compiled, 's.0.items.results'), 1));
    expect(r.verdict.type, verdict(r)).toBe('violated');
  }, SLOW.timeout);
});

describe.concurrent('compiled foreach: each safeguard is load-bearing (mutated copies)', () => {
  it('without the reset on the cursor, an item can start after an outcome is recorded', async ({ expect }) => {
    const compiled = build([foreach(2)], mutated({ transition: /\.lane\d+\.(fail|bail|pause|suspend)$/, dropReset: /cursor/ }));
    const cursor = placeNamed(compiled, 's.0.items.cursor');
    for (const record of ['faults', 'exits', 'suspensions']) {
      const r = await check(compiled, mutualExclusion(cursor, placeNamed(compiled, `s.0.items.${record}`)));
      expect(r.verdict.type, `cursor vs ${record}: ${verdict(r)}`).toBe('violated');
    }
  }, SLOW.timeout);

  /**
   * Each row removes one arc and expects `DeadlockFree` to fail: the arc is what keeps some token
   * from being stranded at quiescence. Together the rows cover every inhibitor, reset and permit
   * arc the finishers and settles rely on.
   */
  it.for<[string, Mutation]>([
    ['join fires with items still queued', { transition: /\.items\.join$/, dropInhibitor: /cursor/ }],
    ['join fires beside a recorded failure', { transition: /\.items\.join$/, dropInhibitor: /faults/ }],
    ['join fires beside a recorded bail or pause', { transition: /\.items\.join$/, dropInhibitor: /exits/ }],
    ['join fires beside a recorded suspension', { transition: /\.items\.join$/, dropInhibitor: /suspensions/ }],
    ['join-empty fires beside results', { transition: /\.items\.join-empty$/, dropInhibitor: /results/ }],
    ['join-empty fires with items still queued', { transition: /\.items\.join-empty$/, dropInhibitor: /cursor/ }],
    ['join-empty fires beside a recorded failure', { transition: /\.items\.join-empty$/, dropInhibitor: /faults/ }],
    ['join-empty fires beside a recorded bail or pause', { transition: /\.items\.join-empty$/, dropInhibitor: /exits/ }],
    ['join-empty fires beside a recorded suspension', { transition: /\.items\.join-empty$/, dropInhibitor: /suspensions/ }],
    ['a bail is decided over a failure', { transition: /\.items\.exit$/, dropInhibitor: /faults/ }],
    ['a suspension is decided over a failure', { transition: /\.items\.suspend$/, dropInhibitor: /faults/ }],
    ['a suspension is decided over a bail', { transition: /\.items\.suspend$/, dropInhibitor: /exits/ }],
    ['a failure leaves the losing bail behind', { transition: /\.items\.fail$/, dropReset: /exits/ }],
    ['a failure leaves the losing suspension behind', { transition: /\.items\.fail$/, dropReset: /suspensions/ }],
    ['a bail leaves the losing suspension behind', { transition: /\.items\.exit$/, dropReset: /suspensions/ }],
    ['a failure leaves the successes behind', { transition: /\.items\.fail$/, dropReset: /results/ }],
    ['a bail leaves the successes behind', { transition: /\.items\.exit$/, dropReset: /results/ }],
    ['a suspension leaves the successes behind', { transition: /\.items\.suspend$/, dropReset: /results/ }],
    ['a failure is decided under a running item', { transition: /\.items\.fail$/, dropInput: /permit/ }],
    ['a settle does not give the lane back', { transition: /\.lane\d+\.fail$/, dropOutput: /permit/ }],
  ])('DeadlockFree is violated when %s', SLOW, async ([, mutation], { expect }) => {
    // 300s: the suspension-vs-bail rows take 70-100s alone and time out at 120s when the suite's
    // solvers run side by side. A counterexample is found or the test fails; `unknown` is no pass.
    const r = await check(build([foreach(2)], mutated(mutation)), deadlockFree(), 'closed', 300_000);
    expect(r.verdict.type, verdict(r)).toBe('violated');
  });

  it('TerminatesAtSink is violated when a settle does not give the lane back', async ({ expect }) => {
    // The complementary claim: with a permit gone, no finisher can ever fire, so the net comes
    // to rest with no terminal marked at all.
    const r = await check(build([foreach(2)], mutated({ transition: /\.lane\d+\.fail$/, dropOutput: /permit/ })), terminatesAtSink());
    expect(r.verdict.type, verdict(r)).toBe('violated');
  }, SLOW.timeout);
});

/**
 * The cancellation safeguards the *proofs* see, each removed once: invisible to the closed segment
 * — without a cancel none of these arcs is consulted — and flipping the cancel segment. The
 * structural check passes on each (none of them is an inhibitor on the signal), so these go
 * through `verifyWorkflow`'s default unchanged.
 */
describe.concurrent('compiled foreach: each cancellation safeguard is load-bearing (mutated copies, 1 lane)', () => {
  const closedProven = {
    'closed/deadlockFree': 'proven',
    'closed/terminatesAtSink': 'proven',
    'closed/exactlyOneTerminal': 'proven',
    'closed/neverCanceled': 'proven',
  };

  it('without the sweep on its input, a cancel before split strands the input', SLOW, async ({ expect }) => {
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
    ['the cancel finishers leave the queued tail behind', { transition: /\.items\.canceled(-empty)?$/, dropReset: /cursor/ }],
    ['the cancel finishers leave a recorded failure behind', { transition: /\.items\.canceled(-empty)?$/, dropReset: /faults/ }],
    ['the cancel finishers leave a recorded bail or pause behind', { transition: /\.items\.canceled(-empty)?$/, dropReset: /exits/ }],
    ['the cancel finishers leave a recorded suspension behind', { transition: /\.items\.canceled(-empty)?$/, dropReset: /suspensions/ }],
    ['the empty cancel finisher fires beside results', { transition: /\.items\.canceled-empty$/, dropInhibitor: /results/ }],
    ['a cancel finisher fires under a running item', { transition: /\.items\.canceled$/, dropInput: /permit/ }],
  ])('closed segment proven, cancel segment violated, when %s', SLOW, async ([label, mutation], { expect }) => {
    const compiled = build([foreach(1)], mutated(mutation));
    expect(cancelStructureViolations(compiled)).toEqual([]);
    const v = await verdicts(`MUTANT c=1 ${label}`, compiled);
    expect(v).toMatchObject(closedProven);
    expect(v).toMatchObject({ 'cancel/deadlockFree': 'violated' });
  });

  /**
   * The finishers' read arc on the signal. Without it the net still drains to exactly one terminal
   * in both segments — the deadlock and terminal proofs stay green, and at run time the executor's
   * declaration-order tie-break hides it — but a run nobody canceled can end in `wf.canceled`.
   * `closed/neverCanceled` is the property that sees it; the arc-level check does not, because a
   * transition that neither reads nor inhibits the signal is not a sweep.
   */
  it('without the cancel finishers\' read arc, closed/neverCanceled is violated and nothing else is', SLOW, async ({ expect }) => {
    const compiled = build([foreach(1)], mutated({ transition: /\.items\.canceled(-empty)?$/, dropRead: /^wf\.cancel$/ }));
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
 * `tests/compiler/foreach.test.ts`. Only the inhibitor on `wf.cancel` is removed; every other arc
 * stays.
 */
describe('compiled foreach: every inhibitor on the signal has structural teeth', () => {
  const stripSignal = (transition: RegExp): Gadget => (entry, next, ctx) => {
    const r = foreachGadget(entry, next, ctx);
    let touched = 0;
    const transitions = r.transitions.map((t) => {
      if (!transition.test(t.name)) return t;
      touched++;
      const b = Transition.builder(t.name).inputs(...t.inputSpecs).outputs(t.outputSpec!).action(t.action).timing(t.timing);
      for (const a of t.inhibitors) if (a.place.name !== ctx.cancel?.name) b.inhibitor(a.place);
      for (const a of t.reads) b.read(a.place);
      for (const a of t.resets) b.reset(a.place);
      return b.build();
    });
    if (touched === 0) throw new Error(`${String(transition)} matched no transition — the check would be vacuous`);
    return { ...r, transitions };
  };

  const lanes = 2;
  const permits = (): string => [0, 1].map((l) => `s.0.items.lane${l}.permit`).join(', ');
  const competes = (name: string, sweep: string, inputs: string): string =>
    `'${name}' competes with sweep '${sweep}' for [${inputs}] without an inhibitor on 'wf.cancel'`;

  it('the real gadget is structurally sound, and every one of these transitions carries the inhibitor', () => {
    const real = build([foreach(lanes)]);
    expect(cancelStructureViolations(real)).toEqual([]);
    for (const name of ['split', 'lane0.start', 'lane1.start', 'join', 'join-empty', 'fail', 'exit', 'suspend']) {
      const t = [...real.net.transitions].find((x) => x.name === `t.0.items.${name}`);
      expect(t?.inhibitors.map((a) => a.place.name), name).toContain('wf.cancel');
    }
  });

  it.each<[string, RegExp, readonly string[]]>([
    ['split', /\.items\.split$/, [competes('t.0.items.split', 't.0.items.cancel', 's.0.items.in')]],
    [
      'lane.start (dispatch)',
      /\.lane\d+\.start$/,
      [0, 1].map((l) => competes(`t.0.items.lane${l}.start`, `t.0.items.lane${l}.refuse`, `s.0.items.cursor, s.0.items.lane${l}.permit`)),
    ],
    ['join', /\.items\.join$/, [
      competes('t.0.items.join', 't.0.items.canceled', `s.0.items.results, s.0.items.frame, ${permits()}`),
      competes('t.0.items.join', 't.0.items.canceled-empty', `s.0.items.frame, ${permits()}`),
    ]],
    ['join-empty', /\.items\.join-empty$/, [
      competes('t.0.items.join-empty', 't.0.items.canceled', `s.0.items.frame, ${permits()}`),
      competes('t.0.items.join-empty', 't.0.items.canceled-empty', `s.0.items.frame, ${permits()}`),
    ]],
    ['fail', /\.items\.fail$/, [competes('t.0.items.fail', 't.0.items.canceled-empty', `s.0.items.frame, ${permits()}`)]],
    ['exit', /\.items\.exit$/, [competes('t.0.items.exit', 't.0.items.canceled-empty', `s.0.items.frame, ${permits()}`)]],
    ['suspend', /\.items\.suspend$/, [competes('t.0.items.suspend', 't.0.items.canceled-empty', `s.0.items.frame, ${permits()}`)]],
  ])('%s without its inhibitor on the signal: the structural check names it, and the proof refuses the net', async (_role, transition, expected) => {
    const mutant = build([foreach(lanes)], stripSignal(transition));
    expect([...cancelStructureViolations(mutant)].sort()).toEqual([...expected].sort());
    await expect(verifyWorkflow(mutant, { timeoutMs: 1_000 })).rejects.toThrow('cancellation structure is unsound');
  });
});

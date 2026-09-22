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
import { foreachGadget } from '../../src/compiler/gadgets/foreach.js';
import { verifyWorkflow, describeReport } from '../../src/verify/index.js';
import type { CompiledWorkflow, EntryDescription, StepDescription } from '../../src/compiler/types.js';

/**
 * `.foreach`, proved.
 *
 * **What every proof here is about.** The initial marking is one token in the workflow's entry
 * place; there are no environment places; the route is the SMT (IC3/PDR) route with semiflow
 * invariants on; all five workflow terminals are declared sinks. The encoding is untimed and
 * value-blind, so `start.l`'s "more items" / "last item" choice is free: **one proof covers every
 * item count at once**, including the empty array (`split`'s second branch) and a non-array
 * (its third). The `(items, concurrency)` shapes below therefore vary only in concurrency and in
 * what surrounds the foreach.
 *
 * `proven` is compared by string. `isViolated()` is false for `unknown` too, so a "not violated"
 * assertion would keep passing once a query started timing out.
 *
 * **The nested 2x2 limit is gone, not fixed.** The previous suite held a foreach-in-a-foreach to
 * 1x1 because Z3 returned `unknown` on `DeadlockFree` at 2x2. A foreach body is now a single step
 * (Mastra's `SingleStepEntry`), so that net can no longer be compiled — the gadget refuses it, see
 * `tests/compiler/foreach.test.ts` — and nothing here needs to prove it.
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

async function prove(expect: ExpectStatic, compiled: CompiledWorkflow): Promise<void> {
  const reports = await verifyWorkflow(compiled, { timeoutMs: 120_000 });
  expect(reports.map((r) => r.property)).toEqual(['deadlockFree', 'terminatesAtSink', 'exactlyOneTerminal']);
  for (const report of reports) {
    expect(report.result.verdict.type, describeReport(report)).toBe('proven');
  }
}

/** One property, under exactly the hypotheses `verifyWorkflow` uses. */
function check(compiled: CompiledWorkflow, property: SmtProperty): Promise<SmtVerificationResult> {
  const { terminals } = compiled;
  return SmtVerifier.forNet(compiled.net)
    .initialMarking((m) => m.tokens(compiled.entryPlace, 1))
    .sinkPlaces(terminals.done, terminals.failed, terminals.bailed, terminals.suspended, terminals.paused)
    .semiflowInvariants(true)
    .timeout(120_000)
    .property(property)
    .verify();
}

const verdict = (r: SmtVerificationResult): string =>
  `${r.verdict.type} via ${r.route}${r.verdict.type === 'unknown' ? ` (${r.verdict.reason})` : ''}`;

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
  for (const arc of t.reads) b.read(arc.place);
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

/** Per-test budget: each query's own solver budget is 120s, and a test runs up to six of them. */
const SLOW = { timeout: 300_000 } as const;

/**
 * Every query spawns its own Z3 process and no test shares state, so the blocks run concurrently;
 * assertions therefore use the test's own `expect`.
 */
describe.concurrent('compiled foreach, proved', () => {
  it.for([1, 2, 3])('is deadlock-free and terminates at a sink with %i lane(s)', SLOW, async (lanes, { expect }) => {
    await prove(expect, build([foreach(lanes)]));
  });

  it('stays provable when the foreach is neither first nor last', async ({ expect }) => {
    // `next` is then another entry's input rather than `wf.done`, so `join` and `split`'s
    // no-items branch deposit into live structure.
    await prove(expect, build([{ kind: 'step', id: 'before' }, foreach(2), { kind: 'step', id: 'after' }]));
  }, SLOW.timeout);

  it('stays provable when the body retries with a delay', async ({ expect }) => {
    // The leaf's unrolled retries sit inside each lane, between `start.l` and the settles.
    await prove(expect, build([foreach(2, body({ retries: 1, retryDelayMs: 10 }))]));
  }, SLOW.timeout);
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
  it.for([2, 3])('never holds the cursor beside a recorded outcome with %i lanes', SLOW, async (lanes, { expect }) => {
    const compiled = build([foreach(lanes)]);
    const cursor = placeNamed(compiled, 's.0.items.cursor');
    for (const record of ['faults', 'exits', 'suspensions']) {
      const r = await check(compiled, mutualExclusion(cursor, placeNamed(compiled, `s.0.items.${record}`)));
      expect(r.verdict.type, `cursor vs ${record}: ${verdict(r)}`).toBe('proven');
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
    const r = await check(build([foreach(2)], mutated(mutation)), deadlockFree());
    expect(r.verdict.type, verdict(r)).toBe('violated');
  });

  it('TerminatesAtSink is violated when a settle does not give the lane back', async ({ expect }) => {
    // The complementary claim: with a permit gone, no finisher can ever fire, so the net comes
    // to rest with no terminal marked at all.
    const r = await check(build([foreach(2)], mutated({ transition: /\.lane\d+\.fail$/, dropOutput: /permit/ })), terminatesAtSink());
    expect(r.verdict.type, verdict(r)).toBe('violated');
  }, SLOW.timeout);
});

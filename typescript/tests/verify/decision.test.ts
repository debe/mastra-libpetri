import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PetriNet, Transition, exactly, one, outPlace, place, xor, type In, type Out, type Place } from 'libpetri';
import { compile, settledBound } from '../../src/compiler/index.js';
import type { CompiledWorkflow, DecisionSite, EntryDescription, QuotaRef, StepDescription, WorkflowDescription } from '../../src/compiler/types.js';
import {
  boundClaims,
  decisionStructureViolations,
  decisionTargets,
  describeClaim,
  exclusions,
  FAMILIES,
  livenessTargets,
  OVER_APPROXIMATION_NOTE,
  segmentLabel,
  verify,
  type VerificationReport,
} from '../../src/verify/index.js';
import { unclaimedTargets } from '../../src/verify/claims.js';
import { verifyWorkflow } from '../../src/verify/properties.js';
import { formatReport, reportJson } from '../../src/cli.js';

/**
 * The counted decision's claims ([ADR 0014], amended M7b W0), M7b W1 E.
 *
 * Two halves. **The arc rules** (`decisionStructureViolations`): empty on every compiled shape —
 * n/k from 1/1 to 4/4, under `concurrency`, a run budget, a retrying and a timed arm, a `limit`
 * inside an arm, the block as a later entry — and one hand-edited mutant per rule, each asserting the
 * exact lines. No proofs there. **The claims** (`boundClaims`, `exclusions`, `decisionTargets`,
 * `unclaimedTargets`) derived from `CompiledWorkflow.decisions`, and `verify()` on the compiled race at
 * n = 3 (k = 1, 2, 3) and n = 4 (k = 1, 2), all four families: every proof's verdict `proven`, every
 * witness `violated` with a confirmed run; one exclusion mutant shows the exclusion is not vacuous.
 *
 * Proof environment: libpetri 8.0.0 from the registry (not linked), z3 on PATH, environment mode
 * none (one closed net). Segments: `verify`'s defaults for the workflow — `closed`, `cancel`, and
 * `restart@p[+cancel]` per top-level boundary (no resume sites: the block never suspends); bounds and
 * exclusion in every segment, liveness in `closed`. 30 s a query. Each proof run is timed and its
 * total and slowest query appended to `$DECISION_TIMINGS` when that is set.
 *
 * Each test names the mutation of `src/verify/decision.ts` or `claims.ts` that breaks it.
 */

const step = (id: string, extra: Omit<StepDescription, 'kind' | 'id'> = {}): StepDescription => ({ kind: 'step', id, ...extra });
const ids = (n: number): string[] => ['a', 'b', 'c', 'd', 'e'].slice(0, n);
const quorum = (k: number, arms: readonly StepDescription[], extra: { concurrency?: number; id?: string } = {}): EntryDescription => ({
  kind: 'parallel',
  id: extra.id ?? 'q',
  arms,
  decision: { k },
  ...(extra.concurrency === undefined ? {} : { concurrency: extra.concurrency }),
});
const wf = (...entries: EntryDescription[]): WorkflowDescription => ({ id: 'w', entries });
const race = (n: number, k: number): CompiledWorkflow => compile(wf(quorum(k, ids(n).map((id) => step(id)))));
const site = (compiled: CompiledWorkflow): DecisionSite => {
  expect(compiled.decisions).toHaveLength(1);
  return compiled.decisions[0]!;
};

// --- hand edits --------------------------------------------------------------------------------

interface Rebuild {
  readonly inputs?: readonly In[];
  readonly output?: Out;
  readonly reads?: readonly Place<unknown>[];
  readonly resets?: readonly Place<unknown>[];
  readonly inhibitors?: readonly Place<unknown>[];
}

/** A copy of `t` with some arcs replaced; action, timing and priority kept. */
function rebuild(t: Transition, change: Rebuild): Transition {
  const b = Transition.builder(t.name).inputs(...(change.inputs ?? t.inputSpecs)).timing(t.timing).priority(t.priority).action(t.action);
  const output = change.output ?? t.outputSpec;
  if (output !== null) b.outputs(output);
  for (const p of change.inhibitors ?? t.inhibitors.map((a) => a.place)) b.inhibitor(p);
  for (const p of change.resets ?? t.resets.map((a) => a.place)) b.reset(p);
  for (const p of change.reads ?? t.reads.map((a) => a.place)) b.read(p);
  return b.build();
}

/** The compiled workflow with transitions replaced by name (null drops one), others added, and the site edited. */
function edited(
  compiled: CompiledWorkflow,
  replace: Record<string, (t: Transition) => Transition | null>,
  add: readonly Transition[] = [],
  siteEdit: (d: DecisionSite) => DecisionSite = (d) => d,
  extraPlaces: readonly Place<unknown>[] = [],
): CompiledWorkflow {
  const seen = new Set<string>();
  const transitions = [...compiled.net.transitions].flatMap((t) => {
    const change = replace[t.name];
    if (change === undefined) return [t];
    seen.add(t.name);
    const r = change(t);
    return r === null ? [] : [r];
  });
  const missing = Object.keys(replace).filter((name) => !seen.has(name));
  if (missing.length > 0) throw new Error(`the edit names no transition ${missing.join(', ')}`);
  const net = PetriNet.builder(compiled.net.name).places(...compiled.net.places, ...extraPlaces).transitions(...transitions, ...add).build();
  return { ...compiled, net, decisions: compiled.decisions.map(siteEdit) };
}

const placeOf = (compiled: CompiledWorkflow, name: string): Place<unknown> => {
  const p = [...compiled.net.places].find((x) => x.name === name);
  if (p === undefined) throw new Error(`no place '${name}'`);
  return p;
};

/** An absorb, built as the gadget builds one: one token of `from`, a read on `decided`, into `settled`. */
const absorb = (name: string, from: Place<unknown>, decided: Place<unknown>, settled: Place<unknown>): Transition =>
  Transition.builder(name).inputs(one(from)).read(decided).outputs(outPlace(settled)).action(async () => {}).build();

// --------------------------------------------------------------------------------------------------
// The arc rules
// --------------------------------------------------------------------------------------------------

describe('decisionStructureViolations: every compiled shape is sound', () => {
  const L: QuotaRef = { id: 'L', kind: 'limit', n: 1 };
  const shapes: readonly (readonly [string, () => CompiledWorkflow])[] = [
    ...([[1, 1], [2, 1], [2, 2], [3, 1], [3, 2], [3, 3], [4, 1], [4, 2], [4, 4]] as const).map(
      ([n, k]) => [`n = ${n}, k = ${k}`, () => race(n, k)] as const,
    ),
    ['n = 3, k = 2, concurrency 2', () => compile(wf(quorum(2, ids(3).map((id) => step(id)), { concurrency: 2 })))],
    ['n = 3, k = 1, run budget 1', () => compile(wf(quorum(1, ids(3).map((id) => step(id)))), { concurrency: 1 })],
    ['n = 3, k = 2, a retrying, timed arm', () => compile(wf(quorum(2, [step('a', { retries: 2, retryDelayMs: 5, timeoutMs: 100 }), step('b'), step('c')])))],
    ['n = 2, k = 1, a limit inside an arm', () => compile(wf(quorum(1, [step('a', { quotas: [L] }), step('b')])))],
    ['n = 1, k = 1, a retrying arm', () => compile(wf(quorum(1, [step('a', { retries: 1 })])))],
    ['two blocks, the second a later entry', () => compile(wf(step('s'), quorum(1, [step('a'), step('b')], { id: 'r' }), quorum(2, [step('c'), step('d'), step('e')])))],
  ];
  // Breaks if: any rule misreads the compiled gadget — e.g. counting pool places as a collect's own
  // arrival, or a retry hop or timeout funnel as a stray consumer of an arm's outcome.
  it.each(shapes)('%s', (_, build) => {
    const compiled = build();
    expect(compiled.decisions.length).toBeGreaterThan(0);
    expect(decisionStructureViolations(compiled)).toEqual([]);
  });

  // Breaks if: the check throws (the W0 stub) on a net with no decision.
  it('is empty on a net with no decision', () => {
    expect(decisionStructureViolations(compile(wf({ kind: 'parallel', id: 'p', arms: [step('a'), step('b')] })))).toEqual([]);
  });
});

describe('decisionStructureViolations: one mutant per rule', () => {
  const base = race(3, 2);
  const d = site(base);
  const P = (name: string): Place<unknown> => placeOf(base, name);
  const at = "block 'q' at 0: ";

  // Breaks if: rule 6 skips inhibitor arcs, or skips the decision places other than okSeen/miss.
  // An inhibitor(won) on short is the mutant ADR 0014 names: short could then fire after met only
  // while won is still unjoined — a decision the arcs no longer make exclusive by the permit alone.
  it('flags an inhibitor(won) on short', () => {
    const mutant = edited(base, { [d.shortTransition]: (t) => rebuild(t, { inhibitors: [P(d.won)] }) });
    expect(decisionStructureViolations(mutant)).toEqual([
      `${at}'t.0.q.short' has an inhibitor on decision place 's.0.q.won'; every decision place is monotone`,
    ]);
  });

  // Breaks if: rule 3 or 4 no longer ties okSeen / miss to their declared collects, or a collect's
  // branch is not held to exactly one token of its own place.
  it('flags a success collect producing miss', () => {
    const name = d.collectOk[0]!;
    const mutant = edited(base, { [name]: (t) => rebuild(t, { output: outPlace(P(d.miss)) }) });
    expect(decisionStructureViolations(mutant)).toEqual([
      `${at}'s.0.q.ok-seen' is produced by [t.0.q.collect-1, t.0.q.collect-2]; only the success collects [t.0.q.collect-0, t.0.q.collect-1, t.0.q.collect-2] may`,
      `${at}'t.0.q.collect-0' branch 0 (s.0.q.miss) must be exactly one token into 's.0.q.ok-seen'`,
      `${at}'s.0.q.miss' is produced by [t.0.q.collect-0, t.0.q.collect-bail, t.0.q.collect-err, t.0.q.collect-pause, t.0.q.collect-preempted-0, t.0.q.collect-preempted-1, t.0.q.collect-preempted-2, t.0.q.collect-susp]; only the miss collects [t.0.q.collect-bail, t.0.q.collect-err, t.0.q.collect-pause, t.0.q.collect-preempted-0, t.0.q.collect-preempted-1, t.0.q.collect-preempted-2, t.0.q.collect-susp] may`,
    ]);
  });

  // Breaks if: rule 6 skips reset arcs. A reset makes okSeen non-monotone, so VER-004 would split
  // every success collect — the cost the amendment removed.
  it('flags a reset on okSeen', () => {
    const mutant = edited(base, { [d.joinMet]: (t) => rebuild(t, { resets: [P(d.okSeen)] }) });
    expect(decisionStructureViolations(mutant)).toEqual([
      `${at}'t.0.q.join-met' has a reset on decision place 's.0.q.ok-seen'; every decision place is monotone`,
    ]);
  });

  // Breaks if: rule 5 accepts any absorb whose arcs are well-formed, without asking whether it can
  // ever fire: at k = n met takes every arrival, so an absorb after won is dead.
  it('flags a dead absorb pair emitted (-won at k = n)', () => {
    const full = race(3, 3);
    const f = site(full);
    const settled = placeOf(full, f.settled!);
    const pair = [
      absorb('t.0.q.absorb-ok-won', placeOf(full, f.okSeen), placeOf(full, f.won), settled),
      absorb('t.0.q.absorb-miss-won', placeOf(full, f.miss), placeOf(full, f.won), settled),
    ];
    const declared = edited(full, {}, pair, (s) => ({ ...s, absorbs: [...pair.map((t) => t.name), ...s.absorbs] }));
    expect(decisionStructureViolations(declared)).toEqual([
      `${at}absorb 't.0.q.absorb-ok-won' takes 's.0.q.ok-seen' after 's.0.q.won', a dead absorb (k = n = 3: met takes every arrival, nothing is left after it)`,
      `${at}absorb 't.0.q.absorb-miss-won' takes 's.0.q.miss' after 's.0.q.won', a dead absorb (k = n = 3: met takes every arrival, nothing is left after it)`,
    ]);
    // Undeclared, the pair is a stranger producing settled and reading won.
    expect(decisionStructureViolations(edited(full, {}, pair))).toEqual([
      `${at}'s.0.q.settled' is produced by [t.0.q.absorb-miss-short, t.0.q.absorb-miss-won, t.0.q.absorb-ok-short, t.0.q.absorb-ok-won]; only the absorbs [t.0.q.absorb-miss-short, t.0.q.absorb-ok-short] may`,
      `${at}'s.0.q.won' is read by [t.0.q.absorb-miss-won, t.0.q.absorb-ok-won]; only the absorbs after it may`,
      `${at}'s.0.q.ok-seen' is consumed by [t.0.q.absorb-ok-short, t.0.q.absorb-ok-won, t.0.q.met]; only met and the ok absorbs may`,
      `${at}'s.0.q.miss' is consumed by [t.0.q.absorb-miss-short, t.0.q.absorb-miss-won, t.0.q.short]; only short and the miss absorbs may`,
    ]);
  });

  // Breaks if: rule 5 checks only the absorbs present, not that every live one is: at k = 2 of 3
  // the surplus after met strands without absorb-ok-won.
  it('flags a missing live absorb', () => {
    const mutant = edited(base, { 't.0.q.absorb-ok-won': () => null }, [], (s) => ({ ...s, absorbs: s.absorbs.filter((a) => a !== 't.0.q.absorb-ok-won') }));
    expect(decisionStructureViolations(mutant)).toEqual([`${at}no absorb takes 's.0.q.ok-seen' after 's.0.q.won'; the surplus would strand`]);
  });

  // Breaks if: rule 5 accepts an absorb that consumes the decision instead of reading it.
  it('flags an absorb consuming won instead of reading it', () => {
    const name = 't.0.q.absorb-ok-won';
    const mutant = edited(base, { [name]: (t) => rebuild(t, { inputs: [one(P(d.okSeen)), one(P(d.won))], reads: [] }) });
    expect(decisionStructureViolations(mutant)).toEqual([
      `${at}absorb '${name}' consumes [one() s.0.q.ok-seen, one() s.0.q.won]; it consumes one token of 's.0.q.ok-seen' or 's.0.q.miss' and nothing else`,
      `${at}absorb '${name}' reads []; it reads exactly 's.0.q.won' or 's.0.q.short'`,
      `${at}no absorb takes 's.0.q.ok-seen' after 's.0.q.won'; the surplus would strand`,
      `${at}'s.0.q.won' is consumed by [${name}, t.0.q.join-met]; only join-met may`,
    ]);
  });

  // Breaks if: rule 3 checks which places met consumes and not how many: one(okSeen) at k = 2 is a
  // race wearing a quorum's name.
  it('flags met taking one(okSeen) at k = 2', () => {
    const mutant = edited(base, { [d.met]: (t) => rebuild(t, { inputs: [one(P(d.permit)), one(P(d.okSeen))] }) });
    expect(decisionStructureViolations(mutant)).toEqual([
      `${at}'t.0.q.met' consumes [one() s.0.q.permit, one() s.0.q.ok-seen]; met consumes exactly one(s.0.q.permit) and exactly(2, s.0.q.ok-seen)`,
    ]);
  });

  // Breaks if: rule 4 counts n − k instead of n − k + 1 — the failure the review found in the draft.
  it('flags short counting n − k misses', () => {
    const mutant = edited(base, { [d.shortTransition]: (t) => rebuild(t, { inputs: [one(P(d.permit)), one(P(d.miss))] }) });
    expect(decisionStructureViolations(mutant)).toEqual([
      `${at}'t.0.q.short' consumes [one() s.0.q.permit, one() s.0.q.miss]; short consumes exactly one(s.0.q.permit) and exactly(2, s.0.q.miss)`,
    ]);
  });

  // Breaks if: rule 2 lets met or short decide without the one decision right.
  it('flags met without the permit', () => {
    const mutant = edited(base, { [d.met]: (t) => rebuild(t, { inputs: [exactly(2, P(d.okSeen))] }) });
    expect(decisionStructureViolations(mutant)).toEqual([
      `${at}permit 's.0.q.permit' is consumed by [t.0.q.short]; only met and short may`,
      `${at}'t.0.q.met' consumes [exactly(2) s.0.q.ok-seen]; met consumes exactly one(s.0.q.permit) and exactly(2, s.0.q.ok-seen)`,
    ]);
  });

  // Breaks if: rule 2 accepts a second producer of the decision right.
  it('flags a second producer of the permit', () => {
    const spare = Transition.builder('t.0.q.spare').inputs(one(P(d.miss))).outputs(outPlace(P(d.permit))).action(async () => {}).build();
    expect(decisionStructureViolations(edited(base, {}, [spare]))).toEqual([
      `${at}permit 's.0.q.permit' is produced by [t.0.q.fork, t.0.q.spare]; only the block's fork may`,
      `${at}the fork 't.0.q.spare' consumes decision place(s) [s.0.q.miss]`,
      `${at}'s.0.q.miss' is consumed by [t.0.q.absorb-miss-short, t.0.q.absorb-miss-won, t.0.q.short, t.0.q.spare]; only short and the miss absorbs may`,
    ]);
  });

  // Breaks if: rule 6 lets join-met fire before every arm has arrived (its settled arc dropped).
  it('flags join-met without its settled arc', () => {
    const first = race(3, 1);
    const f = site(first);
    const mutant = edited(first, { [f.joinMet]: (t) => rebuild(t, { inputs: [one(placeOf(first, f.won))] }) });
    expect(decisionStructureViolations(mutant)).toEqual([
      `${at}'t.0.q.join-met' consumes [one() s.0.q.won]; join-met consumes exactly one(s.0.q.won) and exactly(2, s.0.q.settled)`,
      `${at}'s.0.q.settled' is consumed by []; only [t.0.q.join-met] may`,
    ]);
  });

  // Breaks if: rule 7 does not tie each preempted place to its own arm's attempts.
  it("flags an arm's attempt leaving by another arm's preempted place", () => {
    const run = 't.0-0.a.run';
    const mine = P(d.preempted[0]!);
    const theirs = P(d.preempted[1]!);
    const swap = (o: Out): Out =>
      o.type === 'and' ? { ...o, children: o.children.map(swap) } : o.type === 'place' && o.place.name === mine.name ? outPlace(theirs) : o;
    const mutant = edited(base, {
      [run]: (t) => {
        const spec = t.outputSpec!;
        if (spec.type !== 'xor') throw new Error('expected an xor');
        return rebuild(t, { output: xor(...spec.children.map(swap)) });
      },
    });
    expect(decisionStructureViolations(mutant)).toEqual([
      `${at}arm 0's attempt '${run}' has 0 branch(es) into 's.0.q.arm-0-preempted'; it needs exactly one, holding one token of it alone`,
      `${at}arm 1's preempted 's.0.q.arm-1-preempted' is produced by [${run}], not attempts of arm 1`,
    ]);
  });

  // Breaks if: rule 7 only looks at the declared preempted places, so an n = 1 arm given a
  // preemption anyway (and a place nothing declared consumes) passes.
  it('flags a preempted branch on the arm of a block of one', () => {
    const one1 = race(1, 1);
    const run = 't.0-0.a.run';
    const stray = place<unknown>('s.0.q.arm-0-preempted');
    const mutant = edited(
      one1,
      {
        [run]: (t) => {
          const spec = t.outputSpec;
          if (spec?.type !== 'xor') throw new Error('expected an xor');
          return rebuild(t, { output: xor(...spec.children, outPlace(stray)) });
        },
      },
      [],
      (s) => s,
      [stray],
    );
    expect(decisionStructureViolations(mutant)).toEqual([
      `${at}arm 0's attempt '${run}' produces into 's.0.q.arm-0-preempted', consumed by []; an arm's outcome goes to its own chain or a declared collect`,
    ]);
  });

  // Breaks if: rule 1 stops refusing a site whose counts disagree with themselves, or names absent
  // from the net — every later rule would then index past the arrays it reads.
  it('flags a site that does not add up, and names missing from the net', () => {
    expect(decisionStructureViolations(edited(base, {}, [], (s) => ({ ...s, k: 4 })))).toEqual([`${at}k is 4; it must be a whole number in [1, 3]`]);
    expect(decisionStructureViolations(edited(base, {}, [], (s) => ({ ...s, collectPreempted: s.collectPreempted.slice(1) })))).toEqual([
      `${at}declares 2 preempted collects; it needs 3`,
      `${at}declares miss collects [t.0.q.collect-err, t.0.q.collect-bail, t.0.q.collect-susp, t.0.q.collect-pause, t.0.q.collect-preempted-0, t.0.q.collect-preempted-1, t.0.q.collect-preempted-2]; it needs the four kinds, then [t.0.q.collect-preempted-1, t.0.q.collect-preempted-2]`,
    ]);
    expect(decisionStructureViolations(edited(base, {}, [], (s) => ({ ...s, settled: undefined })))).toEqual([`${at}declares no settled place at n = 3; only n = 1 has none`]);
    expect(decisionStructureViolations(edited(base, { [d.joinShort]: () => null }))).toEqual([`${at}names transition(s) 't.0.q.join-short', not in the net`]);
  });

  // Breaks if: rule 6 lets a transition read a decision place other than won / short.
  it('flags a read on okSeen', () => {
    const mutant = edited(base, { [d.joinShort]: (t) => rebuild(t, { reads: [P(d.okSeen)] }) });
    expect(decisionStructureViolations(mutant)).toEqual([`${at}decision place 's.0.q.ok-seen' is read by [t.0.q.join-short]; only won and short are read, by the absorbs`]);
  });

  // Breaks if: properties.ts drops 'decision structure' from the checks run before any query.
  it('runs before any query, in verifyWorkflow', async () => {
    const mutant = edited(base, { [d.shortTransition]: (t) => rebuild(t, { inhibitors: [P(d.won)] }) });
    await expect(verifyWorkflow(mutant, { segments: [] })).rejects.toThrow(/^decision structure is unsound:\n {2}block 'q' at 0: 't\.0\.q\.short' has an inhibitor on decision place 's\.0\.q\.won'/);
    await expect(verifyWorkflow(base, { segments: [] })).resolves.toEqual([]);
  });
});

// --------------------------------------------------------------------------------------------------
// The claims, derived
// --------------------------------------------------------------------------------------------------

describe('the decision claims, derived from CompiledWorkflow.decisions', () => {
  // Breaks if: a decision bound is dropped, or `settled` is claimed at n − k (the k − 1 after short
  // forgotten) — at n = 3, k = 3 that would claim 0 where short leaves 2 to absorb.
  it.each([[3, 1], [3, 2], [3, 3], [4, 1], [4, 2]] as const)('bounds every decision place at n = %i, k = %i', (n, k) => {
    const compiled = race(n, k);
    const d = site(compiled);
    const bounds = new Map(boundClaims(compiled).claimed.map((c) => [c.place.name, c.bound] as const));
    const want = Math.max(n - k, k - 1);
    expect(settledBound({ k }, n)).toBe(want);
    expect({
      permit: bounds.get(d.permit),
      won: bounds.get(d.won),
      short: bounds.get(d.short),
      okSeen: bounds.get(d.okSeen),
      miss: bounds.get(d.miss),
      settled: bounds.get(d.settled!),
      preempted: d.preempted.map((p) => bounds.get(p)),
    }).toEqual({ permit: 1, won: 1, short: 1, okSeen: n, miss: n, settled: want, preempted: Array(n).fill(1) });
  });

  // Breaks if: the decision's bound stops replacing a gadget's claim on the same place.
  it("replaces a gadget's claim on a decision place", () => {
    const compiled = race(3, 2);
    const d = site(compiled);
    const claims = new Map(compiled.claims);
    claims.set(d.settled!, { place: d.settled!, bound: 9, why: 'wrong' });
    const bound = boundClaims({ ...compiled, claims }).claimed.find((c) => c.place.name === d.settled);
    expect([bound?.bound, bound?.why]).toEqual([1, "block 'q' (k = 2 of n = 3): the surplus after met (n − k = 1) or after short (k − 1 = 1)"]);
  });

  // Breaks if: the exclusion is not derived, or the gadget's copy of it is listed again.
  it('claims mutualExclusion(won, short) once, as a decision', () => {
    const compiled = race(3, 2);
    const pairs = exclusions(compiled).filter((e) => e.source !== 'barrier').map((e) => [e.source, e.a.name, e.b.name]);
    expect(pairs).toEqual([['decision', 's.0.q.won', 's.0.q.short']]);
    // Derived even when the gadget declares nothing.
    const bare = exclusions({ ...compiled, exclusions: [] }).filter((e) => e.source !== 'barrier').map((e) => [e.source, e.a.name, e.b.name]);
    expect(bare).toEqual([['decision', 's.0.q.won', 's.0.q.short']]);
  });

  // Breaks if: decisionTargets stops naming met and short by their output, or livenessTargets stops
  // appending them; or a collect-preempted becomes a target.
  it('targets met and short, by the place each alone produces, for every n including 1', () => {
    for (const [n, k] of [[1, 1], [3, 2]] as const) {
      const compiled = race(n, k);
      const targets = decisionTargets(compiled).map((t) => [t.kind, t.outcome, t.transition, t.stepId, t.attempt, [...t.inputs].map((p) => p.name)]);
      expect(targets).toEqual([
        ['decision', 'met', 't.0.q.met', 'q', 0, ['s.0.q.won']],
        ['decision', 'short', 't.0.q.short', 'q', 0, ['s.0.q.short']],
      ]);
      const all = livenessTargets(compiled).map((t) => t.transition);
      expect(all.slice(-2)).toEqual(['t.0.q.met', 't.0.q.short']);
      expect(all.filter((t) => t.includes('collect'))).toEqual([]);
    }
    expect(decisionTargets(compile(wf(step('a'))))).toEqual([]);
  });

  // Breaks if: collect-preempted-i is dropped from the unclaimed list, or listed at n = 1.
  it('lists each collect-preempted as unclaimed, with the reason', () => {
    expect(unclaimedTargets(race(3, 1)).map((u) => u.transition)).toEqual(['t.0.q.collect-preempted-0', 't.0.q.collect-preempted-1', 't.0.q.collect-preempted-2']);
    expect(unclaimedTargets(race(3, 1))[0]!.why).toMatch(/not condition on the decision.*tested, not proven/);
    expect(unclaimedTargets(race(1, 1))).toEqual([]);
  });
});

// --------------------------------------------------------------------------------------------------
// Proofs
// --------------------------------------------------------------------------------------------------

/** Every claim holds, by verdict: `proven` for a proof, a confirmed witness for liveness. */
function expectHolds(report: VerificationReport): void {
  expect(report.families).toEqual([...FAMILIES]);
  for (const family of FAMILIES) expect(report.claims.some((c) => c.family === family), family).toBe(true);
  for (const c of report.claims) {
    const line = describeClaim(c);
    if (c.kind === 'proof') expect(c.result.verdict.type, line).toBe('proven');
    else {
      expect(c.result.verdict.type, line).toBe('violated');
      expect(c.result.counterexampleConfirmed, line).toBe(true);
    }
    expect(c.holds, line).toBe(true);
  }
  expect(report.holds).toBe(true);
}

/** Wall time, total and slowest query, for the report line. */
function timing(name: string, report: VerificationReport, ms: number): string {
  const slowest = [...report.claims].sort((a, b) => b.result.elapsedMs - a.result.elapsedMs)[0]!;
  const routes = [...new Set(report.claims.map((c) => c.result.route))].sort().join(', ');
  return `${name}: ${report.claims.length} claims in ${Math.round(ms)} ms wall; slowest ${segmentLabel(slowest.segment)}/${slowest.property} ${Math.round(slowest.result.elapsedMs)} ms; routes ${routes}`;
}

describe('verify: the compiled race, all four families', () => {
  // Breaks if: any decision claim fails to prove (a bound too tight, the exclusion lost, met or
  // short dead), any query exceeds its 30 s budget (`unknown` is not `proven`), or the decision's
  // claims stop reaching `verify` (the presence checks below).
  it.each([[3, 1], [3, 2], [3, 3], [4, 1], [4, 2]] as const)(
    'n = %i, k = %i, then a next step: every claim holds',
    async (n, k) => {
      const compiled = compile(wf(quorum(k, ids(n).map((id) => step(id))), step('next')));
      const d = site(compiled);
      const started = performance.now();
      const report = await verify(compiled);
      const ms = performance.now() - started;
      const line = timing(`n=${n} k=${k}`, report, ms);
      if (process.env.DECISION_TIMINGS) appendFileSync(process.env.DECISION_TIMINGS, `${line}\n`);
      expectHolds(report);
      for (const c of report.claims) expect(c.result.elapsedMs, describeClaim(c)).toBeLessThan(30_000);

      const properties = new Set(report.claims.map((c) => c.property));
      const settled = Math.max(n - k, k - 1);
      for (const p of [
        `bound(${d.permit}<=1)`,
        `bound(${d.won}<=1)`,
        `bound(${d.short}<=1)`,
        `bound(${d.okSeen}<=${n})`,
        `bound(${d.miss}<=${n})`,
        `bound(${d.settled}<=${settled})`,
        ...d.preempted.map((p) => `bound(${p}<=1)`),
        `exclusive(${d.won},${d.short})`,
        `live(${d.met})`,
        `live(${d.shortTransition})`,
      ]) {
        expect(properties.has(p), p).toBe(true);
      }
      for (const name of d.collectPreempted) expect(properties.has(`live(${name})`), name).toBe(false);

      // V1. live(short) is witnessed by an executor run of genuine misses: no arm is preempted
      // before a decision, which no host run can do. Pin: no collect-preempted firing in it.
      for (const target of [d.met, d.shortTransition]) {
        const live = report.claims.find((c) => c.property === `live(${target})`)!;
        expect(live.result.route, describeClaim(live)).toBe('execution');
        expect(live.note, describeClaim(live)).toBeUndefined();
        const steps = live.result.counterexampleTransitions;
        for (const name of d.collectPreempted) {
          expect(steps.some((s) => s === name || s === `complete:${name}`), `${target}'s witness fires ${name}`).toBe(false);
        }
      }

      // V2. What is not claimed is in the report and printed, never silently left out.
      expect(report.unclaimedTargets.map((u) => u.transition)).toEqual(d.collectPreempted);
      const text = formatReport({ name: 'w', report });
      expect(text).toContain(`  unclaimed liveness targets (${n}):`);
      for (const name of d.collectPreempted) expect(text).toContain(`    live(${name}) not claimed — `);
      expect((reportJson({ name: 'w', report }) as { unclaimedTargets: unknown }).unclaimedTargets).toEqual(report.unclaimedTargets);
    },
    180_000,
  );

  // Breaks if: the exclusion or the decision's bound is vacuous. Counting alone makes met and short
  // exclusive (k + n − k + 1 > n arrivals), so the exclusion mutant breaks both the permit and the
  // count: met without the permit and short counting n − k misses lets both fire at n = 3, k = 2.
  // Met without the permit at k = 1 fires once per success, past `bound(won<=1)`. Structure is
  // skipped, since the arc rules refuse both mutants first.
  it('the claims are not vacuous: the exclusion and bound(won<=1) come back violated on mutants', async () => {
    const quorum2 = race(3, 2);
    const d = site(quorum2);
    const both = edited(quorum2, {
      [d.met]: (t) => rebuild(t, { inputs: [exactly(2, placeOf(quorum2, d.okSeen))] }),
      [d.shortTransition]: (t) => rebuild(t, { inputs: [one(placeOf(quorum2, d.permit)), one(placeOf(quorum2, d.miss))] }),
    });
    expect(decisionStructureViolations(both).length).toBeGreaterThan(0);
    const exclusive = await verify(both, { families: ['exclusion'], segments: ['closed'], structure: 'skip', atomicFallback: false });
    const pair = exclusive.claims.find((c) => c.property === `exclusive(${d.won},${d.short})`);
    expect(pair, 'the exclusion claim').toBeDefined();
    expect(pair!.result.verdict.type, describeClaim(pair!)).toBe('violated');
    expect(pair!.holds).toBe(false);

    const first = race(3, 1);
    const f = site(first);
    const free = edited(first, { [f.met]: (t) => rebuild(t, { inputs: [one(placeOf(first, f.okSeen))] }) });
    const bounds = await verify(free, { families: ['bounds'], segments: ['closed'], structure: 'skip', atomicFallback: false });
    const won = bounds.claims.find((c) => c.property === `bound(${f.won}<=1)`);
    expect(won, 'the bound claim').toBeDefined();
    expect(won!.result.verdict.type, describeClaim(won!)).toBe('violated');
    expect(won!.holds).toBe(false);
  }, 60_000);
});

describe('verify: a deciding arm on a timed net', () => {
  // Breaks if: a liveness claim the verifier settled on a net with a decision (a timed net is never
  // witnessed by execution) stops saying its witness is in the untimed over-approximation, which may
  // preempt an arm before any decision.
  it("says the verifier's witness is in the untimed over-approximation", async () => {
    const compiled = compile(wf(quorum(1, [step('a', { retries: 1, retryDelayMs: 5 }), step('b')])));
    const d = site(compiled);
    const report = await verify(compiled, { families: ['liveness'], segments: ['closed'] });
    for (const target of [d.met, d.shortTransition]) {
      const live = report.claims.find((c) => c.property === `live(${target})`)!;
      expect(live.result.route, describeClaim(live)).not.toBe('execution');
      expect(live.note, describeClaim(live)).toBe(OVER_APPROXIMATION_NOTE);
      expect(describeClaim(live)).toContain('untimed over-approximation');
    }
    expect(report.unclaimedTargets.map((u) => u.transition)).toEqual(d.collectPreempted);
    // A block of one arm has no preempted branch: no note, nothing unclaimed.
    const one = await verify(compile(wf(quorum(1, [step('a', { retries: 1, retryDelayMs: 5 })]))), { families: ['liveness'], segments: ['closed'] });
    expect(one.claims.every((c) => c.note === undefined)).toBe(true);
    expect(one.unclaimedTargets).toEqual([]);
  }, 60_000);

  // Breaks if: the note is attached to every liveness claim the verifier settled on a net with a
  // decision, a target proven dead included — a proof has no witness to qualify.
  it('a target the verifier proves dead carries no over-approximation note; a live one does', async () => {
    const compiled = compile(wf(quorum(1, [step('a', { retries: 1, retryDelayMs: 5 }), step('b')])));
    const d = site(compiled);
    const never = place<unknown>('never-marked');
    const dead = edited(compiled, { [d.met]: (t) => rebuild(t, { inputs: [...t.inputSpecs, one(never)] }) }, [], (x) => x, [never]);
    const report = await verify(dead, { families: ['liveness'], segments: ['closed'], structure: 'skip', atomicFallback: false });
    const met = report.claims.find((c) => c.property === `live(${d.met})`)!;
    expect(met.result.verdict.type, describeClaim(met)).toBe('proven');
    expect(met.note, describeClaim(met)).toBeUndefined();
    const short = report.claims.find((c) => c.property === `live(${d.shortTransition})`)!;
    expect(short.result.verdict.type, describeClaim(short)).toBe('violated');
    expect(short.note, describeClaim(short)).toBe(OVER_APPROXIMATION_NOTE);
  }, 60_000);
});

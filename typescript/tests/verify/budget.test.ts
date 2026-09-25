import { appendFileSync } from 'node:fs';
import { describe, expect, it, type ExpectStatic } from 'vitest';
import { PetriNet, Transition, all, and, exactly, one, outPlace, place, xor, type In, type Out, type Place } from 'libpetri';
import { compile, stepGadget, type Gadget } from '../../src/compiler/index.js';
import { budgetStructureViolations, permitConsumers } from '../../src/verify/budget.js';
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
 * The run's step budget ([ADR 0006]), proved for every gadget shape and checked on the arcs.
 *
 * **What every proof here is about.** Properties: `verifyWorkflow`'s full set — `deadlockFree`,
 * `terminatesAtSink`, `exactlyOneTerminal`, in `closed` also `neverCanceled`, and with a budget
 * `permitsBounded` (`placeBound(wf.permits, k)`) and `permitsReturned`
 * (`quiescentCount([wf.permits], k, k)`). Initial marking: one token in the entry place and `k`
 * in `wf.permits`; in the `cancel` segment also one in `wf.cancel.request`, so the arrival may
 * land at every reachable point. Environment: closed in both (the arrival is part of the net).
 * Then `resume@s` and `resume@s+cancel` per resume site ([ADR 0007]): one token at the site in
 * place of the entry token, `k` permits, the same property sets.
 * Sinks: the six terminals, `wf.cancel` and `wf.permits`. The route is whatever the verifier
 * reports, printed on a failed assertion and written to `PROOF_LOG` when that names a file.
 *
 * `proven` is compared by string, everywhere: `isViolated()` is false for `unknown` too.
 *
 * **Cost.** Everything but `.foreach` proves in well under a second per shape (enumeration or
 * SMT). A two-lane foreach takes ~30-40s per budget on SMT, most of it `deadlockFree`; three lanes
 * run only in the slow lane (`SLOW_PROOFS=1`), as in `foreach.test.ts`.
 */

const step = (id: string, extra: Partial<Omit<StepDescription, 'kind' | 'id'>> = {}): StepDescription => ({ kind: 'step', id, ...extra });
const arms = (n: number): StepDescription[] => Array.from({ length: n }, (_, i) => step(`a${i + 1}`));

/** `verifyWorkflow`'s property set under a budget, in a segment without and with a cancel arriving. */
const UNCANCELED = ['deadlockFree', 'terminatesAtSink', 'exactlyOneTerminal', 'neverCanceled', 'permitsBounded', 'permitsReturned'];
const CANCELED = ['deadlockFree', 'terminatesAtSink', 'exactlyOneTerminal', 'permitsBounded', 'permitsReturned'];
const cancels = (segment: Segment): boolean => (typeof segment === 'string' ? segment === 'cancel' : segment.cancel);
/**
 * Every `segment/property` key `verifyWorkflow` reports on a budgeted workflow by default:
 * `closed`, `cancel`, then `resume@s` and `resume@s+cancel` for every resume site ([ADR 0007]).
 */
const keysFor = (compiled: CompiledWorkflow): string[] =>
  segmentsFor(compiled).flatMap((segment) => (cancels(segment) ? CANCELED : UNCANCELED).map((p) => `${segmentLabel(segment)}/${p}`));
const keyOf = (r: PropertyReport): string => `${segmentLabel(r.segment)}/${r.property}`;

const proofLog = (line: string): void => {
  const file = process.env['PROOF_LOG'];
  if (file) appendFileSync(file, `${line}\n`);
};

const build = (entries: readonly EntryDescription[], concurrency: number, gadgets?: Partial<Record<EntryDescription['kind'], Gadget>>): CompiledWorkflow =>
  compile({ id: 'budget', entries }, { concurrency, ...(gadgets ? { gadgets } : {}) });

/** Structure clean (cancel and budget), then every property of every segment `proven`, resume sites included. */
async function prove(expect: ExpectStatic, label: string, compiled: CompiledWorkflow, timeoutMs = 300_000): Promise<void> {
  expect(cancelStructureViolations(compiled)).toEqual([]);
  expect(budgetStructureViolations(compiled)).toEqual([]);
  const reports = await verifyWorkflow(compiled, { timeoutMs });
  proofLog(`[budget ${label}] ${reports.map(describeReport).join('; ')}`);
  expect(reports.map(keyOf)).toEqual(keysFor(compiled));
  for (const r of reports) expect(r.result.verdict.type, `${label}: ${describeReport(r)}`).toBe('proven');
}

/**
 * Each verdict by `segment/property`, for a mutant whose verdicts are expected to flip. The
 * structural checks are skipped (`structure: 'skip'`) so the proofs run on a mutant the budget
 * check refuses once it is wired into `verifyWorkflow`; each test asserts that check itself.
 */
async function verdicts(label: string, compiled: CompiledWorkflow): Promise<Record<string, string>> {
  const reports = await verifyWorkflow(compiled, { timeoutMs: 120_000, structure: 'skip' });
  proofLog(`[budget mutant ${label}] ${reports.map(describeReport).join('; ')}`);
  return Object.fromEntries(reports.map((r) => [keyOf(r), r.result.verdict.type]));
}

// ---------------------------------------------------------------------------------------------
// Every gadget shape at budget 1 and 2.
// ---------------------------------------------------------------------------------------------

/** A shape, and how many step attempts it compiles — each must be exactly one permit consumer. */
const shapes: ReadonlyArray<readonly [string, readonly EntryDescription[], number]> = [
  ['a leaf retrying twice, no delay', [step('a', { retries: 2 })], 3],
  ['a leaf retrying once after a timed delay, then a step', [step('a', { retries: 1, retryDelayMs: 5 }), step('b')], 3],
  [
    'fixed and per-run sleeps around a step',
    [
      { kind: 'sleep', id: 's1', duration: { fixed: 10 } },
      { kind: 'sleep', id: 's2', duration: { perRun: true } },
      step('a'),
      { kind: 'sleepUntil', id: 's3', until: { fixed: 1 } },
      { kind: 'sleepUntil', id: 's4', until: { perRun: true } },
    ],
    1,
  ],
  ...[1, 2, 3, 4].map((n) => [`parallel n=${n}`, [{ kind: 'parallel', id: 'fan', arms: arms(n) }], n] as const),
  ...[1, 2, 3].map((n) => [`branch k=${n}`, [{ kind: 'branch', id: 'pick', arms: arms(n) }], n] as const),
  ...[1, 2, 3].map((b) => [`dowhile bound=${b}`, [{ kind: 'loop', id: 'again', loopType: 'dowhile', iterationBound: b, body: step('body') }], 1] as const),
  ['dountil bound=2, body retrying once', [{ kind: 'loop', id: 'again', loopType: 'dountil', iterationBound: 2, body: step('body', { retries: 1 }) }], 2],
  ['a step, parallel n=2, a step', [step('before'), { kind: 'parallel', id: 'fan', arms: arms(2) }, step('after')], 4],
];

describe.concurrent('every gadget shape is proven under a budget (both segments, all properties)', () => {
  for (const k of [1, 2]) {
    it.for(shapes)(`k=${k}: %s`, { timeout: 360_000 }, async ([label, entries, attempts], { expect }) => {
      const compiled = build(entries, k);
      expect(compiled.budget?.k).toBe(k);
      // The only permit consumers are step attempts, one per attempt: no sleep, condition, join or
      // retry delay holds a permit.
      const consumers = permitConsumers(compiled).map((t) => t.name);
      expect(consumers).toHaveLength(attempts);
      for (const name of consumers) expect(name).toMatch(/\.run(-\d+)?$/);
      await prove(expect, `k=${k} ${label}`, compiled);
    });
  }
});

const foreach = (c: number, body: StepDescription = step('body')): EntryDescription => ({ kind: 'foreach', id: 'items', body, concurrency: c });
const SLOW_LANE = process.env['SLOW_PROOFS'] === '1';

describe.concurrent('foreach under a budget (both segments, all properties)', () => {
  for (const k of [1, 2]) {
    it.for([1, 2])(`k=${k}: foreach c=%i`, { timeout: 1_800_000 }, async (c, { expect }) => {
      const compiled = build([foreach(c)], k);
      expect(permitConsumers(compiled)).toHaveLength(c);
      await prove(expect, `k=${k} foreach c=${c}`, compiled);
    });
  }
});

describe.runIf(SLOW_LANE).concurrent('SLOW LANE (SLOW_PROOFS=1): foreach c=3 under a budget, 600s per query', () => {
  for (const k of [1, 2]) {
    it(`k=${k}: foreach c=3`, { timeout: 11 * 600_000 + 60_000 }, async ({ expect }) => {
      const compiled = build([foreach(3)], k);
      expect(permitConsumers(compiled)).toHaveLength(3);
      await prove(expect, `k=${k} foreach c=3`, compiled, 600_000);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Non-vacuity. The real step gadget is compiled and its run transitions are rebuilt with one
// change, through the `gadgets` override — src is never edited. Every mutant asserts `violated`
// (not "not proven": `unknown` would satisfy that) and the exact structural line.
// ---------------------------------------------------------------------------------------------

interface Rebuild {
  readonly inputs?: readonly In[];
  readonly output?: Out;
  readonly reads?: readonly Place<unknown>[];
  readonly resets?: readonly Place<unknown>[];
}

/** A copy of `t` with some arcs replaced; action, timing and priority kept. */
function rebuild(t: Transition, change: Rebuild): Transition {
  const b = Transition.builder(t.name)
    .inputs(...(change.inputs ?? t.inputSpecs))
    .timing(t.timing)
    .priority(t.priority)
    .action(t.action);
  const output = change.output ?? t.outputSpec;
  if (output !== null) b.outputs(output);
  for (const a of t.inhibitors) b.inhibitor(a.place);
  for (const p of change.resets ?? t.resets.map((a) => a.place)) b.reset(p);
  for (const p of change.reads ?? t.reads.map((a) => a.place)) b.read(p);
  return b.build();
}

/** The step gadget with every first-attempt run transition of step `id` rewritten, plus extras. */
function mutantStep(id: string, mutate: (t: Transition, permits: Place<null>) => Transition, extra: (permits: Place<null>) => Transition[] = () => []): Gadget {
  let matched = false;
  const gadget: Gadget = (entry, next, ctx) => {
    const result = stepGadget(entry, next, ctx);
    if (entry.id !== id) return result;
    const permits = ctx.permits;
    if (permits === undefined) throw new Error('mutant needs a budget');
    const transitions = result.transitions.map((t) => (t.name.endsWith(`.${id}.run`) ? ((matched = true), mutate(t, permits)) : t));
    return { ...result, transitions: [...transitions, ...extra(permits)] };
  };
  return (entry, next, ctx) => {
    const r = gadget(entry, next, ctx);
    if (entry.id === id && !matched) throw new Error(`mutation matched no run transition of '${id}'`);
    return r;
  };
}

/** The run's `xor` with branch `i` replaced. */
function withBranch(t: Transition, i: number, replace: (branch: Out) => Out): Out {
  const spec = t.outputSpec;
  if (spec === null || spec.type !== 'xor') throw new Error(`'${t.name}' has no xor output`);
  if (spec.children[i] === undefined) throw new Error(`'${t.name}' has no branch ${i}`);
  return xor(...spec.children.map((c, j) => (j === i ? replace(c) : c)));
}
/** A branch `and(outcome, permits)` without its permit. */
const outcomeOnly = (branch: Out): Out => {
  if (branch.type !== 'and' || branch.children[0] === undefined) throw new Error('expected and(outcome, permits)');
  return branch.children[0];
};

describe.concurrent('non-vacuity: mutants of the step gadget', () => {
  it('a step keeping its permit on failure: permitsReturned violated in both segments, and the structure names the branch', async ({ expect }) => {
    // Branch 1 is the failure: `xor(next, failed, bailed, suspended, paused)`, each `and`ed with
    // the permit. Initial marking k=1, two steps: a run where `a` fails rests with 0 permits.
    const compiled = build([step('a'), step('b')], 1, {
      step: mutantStep('a', (t) => rebuild(t, { output: withBranch(t, 1, outcomeOnly) })),
    });
    expect(budgetStructureViolations(compiled)).toEqual([
      "'t.0.a.run' branch 1 (wf.settle.failed) returns 0 permits; every branch returns exactly one",
    ]);
    const v = await verdicts('leak on failure', compiled);
    expect(v['closed/permitsReturned']).toBe('violated');
    expect(v['cancel/permitsReturned']).toBe('violated');
    // No permit is minted, so the bound still holds: the two properties see different defects.
    expect(v['closed/permitsBounded']).toBe('proven');
    expect(v['cancel/permitsBounded']).toBe('proven');
  });

  it('a branch returning two permits (the second through a mint transition): permitsBounded violated, and the structure names the mint', async ({ expect }) => {
    // Success deposits the permit AND a token in `spare`, which `t.0.a.mint` turns into a second
    // permit. At k=1 the two arms of the parallel can then run at once.
    const spare = place<null>('s.0.a.spare');
    const compiled = build([{ kind: 'parallel', id: 'fan', arms: [step('a'), step('b')] }], 1, {
      step: mutantStep(
        'a',
        (t) => rebuild(t, { output: withBranch(t, 0, (b) => and(b, outPlace(spare))) }),
        (permits) => [
          Transition.builder('t.0.a.mint')
            .inputs(one(spare))
            .outputs(outPlace(permits))
            .action(async (tctx) => {
              tctx.input(spare);
              tctx.output(permits, null);
            })
            .build(),
        ],
      ),
    });
    expect(budgetStructureViolations(compiled)).toEqual(["'t.0.a.mint' produces a permit it never consumed"]);
    const v = await verdicts('mint', compiled);
    expect(v['closed/permitsBounded']).toBe('violated');
    expect(v['cancel/permitsBounded']).toBe('violated');
    expect(v['closed/permitsReturned']).toBe('violated');
  });

  it('a step that does not consume a permit: permitsBounded violated, and the structure names it', async ({ expect }) => {
    const compiled = build([step('a'), step('b')], 1, {
      step: mutantStep('a', (t, permits) => rebuild(t, { inputs: t.inputSpecs.filter((s) => s.place.name !== permits.name) })),
    });
    // Two rules fire: the step-attempt rule (a step attempt must take a permit) and the mint rule.
    expect(budgetStructureViolations(compiled)).toEqual([
      "'t.0.a.run' is a step attempt and takes no permit",
      "'t.0.a.run' produces a permit it never consumed",
    ]);
    const v = await verdicts('no consume', compiled);
    expect(v['closed/permitsBounded']).toBe('violated');
    expect(v['cancel/permitsBounded']).toBe('violated');
  });

  it('a branch naming the permit twice is ONE permit to every proof ([IO-016]); only the structure sees it', async ({ expect }) => {
    // Why the structural check exists. The analyses deposit one token per named place of a branch,
    // so `and(outcome, permits, permits)` proves exactly like the intact net — every property of
    // both segments, same initial markings — while the arcs say the branch mints a permit.
    const compiled = build([step('a'), step('b')], 1, {
      step: mutantStep('a', (t, permits) => rebuild(t, { output: withBranch(t, 0, (b) => and(b, outPlace(permits))) })),
    });
    expect(budgetStructureViolations(compiled)).toEqual([
      "'t.0.a.run' branch 0 (s.1.b.in + wf.permits×2) returns 2 permits; every branch returns exactly one",
    ]);
    const reports = await verifyWorkflow(compiled, { timeoutMs: 120_000, structure: 'skip' });
    proofLog(`[budget mutant double-named] ${reports.map(describeReport).join('; ')}`);
    expect(reports.map(keyOf)).toEqual(keysFor(compiled));
    for (const r of reports) expect(r.result.verdict.type, describeReport(r)).toBe('proven');
  });
});

// ---------------------------------------------------------------------------------------------
// The structural rules, one hand-edited net each (no proofs).
// ---------------------------------------------------------------------------------------------

describe('budgetStructureViolations: each rule', () => {
  const base = build([step('a'), step('b')], 2);
  const permits = base.budget!.permits;
  const edited = (edit: (t: Transition) => Transition, extra: readonly Transition[] = []): CompiledWorkflow => ({
    ...base,
    net: PetriNet.builder(base.net.name)
      .places(...base.net.places)
      .transitions(...[...base.net.transitions].map(edit), ...extra)
      .build(),
  });
  const onRun = (name: string, change: (t: Transition) => Transition) => (t: Transition) => (t.name === name ? change(t) : t);
  const noop = async (): Promise<void> => {};

  it('is empty on the compiled net, and when no budget is compiled in', () => {
    expect(budgetStructureViolations(base)).toEqual([]);
    expect(budgetStructureViolations(compile({ id: 'budget', entries: [step('a')] }))).toEqual([]);
    expect(permitConsumers(compile({ id: 'budget', entries: [step('a')] }))).toEqual([]);
  });

  it('flags a permit place missing from the net', () => {
    // Every step attempt consumes the net's own permits, not the named place, so each also takes
    // "no permit" from the budget it was given.
    expect(budgetStructureViolations({ ...base, budget: { permits: place<null>('wf.permits.elsewhere'), k: 2 } })).toEqual([
      "the permit place 'wf.permits.elsewhere' is not in the net",
      "'t.1.b.run' is a step attempt and takes no permit",
      "'t.0.a.run' is a step attempt and takes no permit",
    ]);
  });

  it('flags a consumer taking more than one: exactly(2), all(), a second arc', () => {
    const withIn = (spec: In) => edited(onRun('t.0.a.run', (t) => rebuild(t, { inputs: [...t.inputSpecs.filter((s) => s.place.name !== permits.name), spec] })));
    expect(budgetStructureViolations(withIn(exactly(2, permits)))).toEqual(["'t.0.a.run' consumes the permits with exactly(2); a step takes exactly one"]);
    expect(budgetStructureViolations(withIn(all(permits)))).toEqual(["'t.0.a.run' consumes the permits with all(); a step takes exactly one"]);
    expect(budgetStructureViolations(withIn(exactly(1, permits)))).toEqual([]);
    const twice = edited(onRun('t.0.a.run', (t) => rebuild(t, { inputs: [...t.inputSpecs, one(permits)] })));
    expect(budgetStructureViolations(twice)).toEqual(["'t.0.a.run' has 2 input arcs on the permits; a step takes exactly one"]);
  });

  it('flags a transition that reads the permits, and one that resets them', () => {
    const reader = edited(onRun('t.1.b.run', (t) => rebuild(t, { reads: [...t.reads.map((a) => a.place), permits] })));
    expect(budgetStructureViolations(reader)).toEqual(["'t.1.b.run' reads the permits; it must consume one or leave them alone"]);
    const clear = Transition.builder('t.clear').inputs(one(base.terminals.done)).reset(permits).outputs(outPlace(base.terminals.done)).action(noop).build();
    expect(budgetStructureViolations(edited((t) => t, [clear]))).toEqual(["'t.clear' resets the permits"]);
  });

  it('compares by name: a same-named permit place built elsewhere is the permit place', () => {
    const twin = place<null>('wf.permits');
    const mint = Transition.builder('t.mint').inputs(one(base.terminals.done)).outputs(and(outPlace(base.terminals.done), outPlace(twin))).action(noop).build();
    expect(budgetStructureViolations(edited((t) => t, [mint]))).toEqual(["'t.mint' produces a permit it never consumed"]);
  });
});

describe('rule 4: every step attempt takes a permit — the bypass that passed every proof', () => {
  it('flags a gadget whose body step was compiled with no budget, and verifyWorkflow refuses it', async () => {
    // The foreach critic's mutant: the body compiled as if the run were unbounded. All eleven
    // proofs stayed green, because no transition touching the permits was wrong.
    const bypass: Gadget = (e, n, ctx) => stepGadget(e, n, { ...ctx, permits: undefined });
    const compiled = compile({ id: 'bypass', entries: [step('a'), step('b')] }, { concurrency: 2, gadgets: { step: bypass } });
    expect(budgetStructureViolations(compiled)).toEqual([
      "'t.1.b.run' is a step attempt and takes no permit",
      "'t.0.a.run' is a step attempt and takes no permit",
    ]);
    await expect(verifyWorkflow(compiled)).rejects.toThrow(/step budget structure is unsound/);
  });

  it('the compiled workflow names every step attempt, retries included', () => {
    const compiled = compile({ id: 'attempts', entries: [step('a', { retries: 2 }), step('b')] }, { concurrency: 1 });
    expect([...compiled.stepAttempts].sort()).toEqual(['t.0.a.run', 't.0.a.run-1', 't.0.a.run-2', 't.1.b.run']);
    expect(budgetStructureViolations(compiled)).toEqual([]);
  });
});

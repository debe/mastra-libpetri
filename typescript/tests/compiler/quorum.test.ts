import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryEventStore, enumerateBranches, type Transition } from 'libpetri';
import {
  compile,
  QuorumNotMetError,
  settledBound,
  StepPreemptedError,
} from '../../src/compiler/index.js';
import type { EntryPath } from '../../src/compiler/names.js';
import { KernelRunScope, runWorkflowDetailed } from '../../src/engine/index.js';
import { attemptGate, reportedVerdict } from '../../src/mastra/attempt-gate.js';
import type {
  CompiledWorkflow,
  DecisionSite,
  EntryDescription,
  StepCall,
  StepDescription,
  StepOutcome,
  StepRunner,
  WorkflowDescription,
} from '../../src/compiler/types.js';

/**
 * The first-k decision gadget ([ADR 0014], amended M7b W0): `race` / `quorum(k)` on a `.parallel()`.
 *
 * Two halves. **Shape**: the names `DecisionSite` declares, the arcs of `met`, `short`, the absorbs
 * and the joins for each (n, k), dead absorb pairs omitted at k = n and k = 1, `settled` and every
 * preemption omitted at n = 1, the claims, and the structural hash moving with `k`. **Runs**: the
 * kernel (`runWorkflowDetailed`) with a scripted runner and the real `KernelRunScope` at n = 3
 * (k = 1, 2, 3) and n = 4 (k = 1, 2): winners FIFO, losers preempted and recorded `canceled` with the
 * block's `StepPreemptedError`, no residue and exactly one terminal (a `residue` key would be
 * present otherwise — every outcome is asserted whole).
 *
 * Environment: libpetri 8.0.0 from the registry (not linked), real timers. Everything here is
 * **tested, not proven**: the decision's claims are W2's (`tests/verify/blueprints.test.ts`).
 *
 * Each test names the mutation of `first-k.ts` that breaks it.
 */

const step = (id: string, extra: Omit<StepDescription, 'kind' | 'id'> = {}): StepDescription => ({ kind: 'step', id, ...extra });
const ids = (n: number): string[] => ['a', 'b', 'c', 'd', 'e'].slice(0, n);
const quorum = (k: number, arms: readonly StepDescription[], extra: { concurrency?: number } = {}): EntryDescription => ({
  kind: 'parallel',
  id: 'q',
  arms,
  decision: { k },
  ...extra,
});
const wf = (...entries: EntryDescription[]): WorkflowDescription => ({ id: 'w', entries });
const after = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const byName = (compiled: CompiledWorkflow): Map<string, Transition> =>
  new Map([...compiled.net.transitions].map((t) => [t.name, t] as const));
const placeNames = (compiled: CompiledWorkflow): Set<string> => new Set([...compiled.net.places].map((p) => p.name));
const site = (compiled: CompiledWorkflow): DecisionSite => {
  expect(compiled.decisions).toHaveLength(1);
  return compiled.decisions[0]!;
};
const ins = (t: Transition): [string, string, number?][] =>
  t.inputSpecs.map((i) => (i.type === 'exactly' ? [i.type, i.place.name, i.count] : [i.type, i.place.name]));

// --------------------------------------------------------------------------------------------------
// Shape
// --------------------------------------------------------------------------------------------------

describe('quorum: names and the declared site', () => {
  // Breaks if: any role is renamed, `settled` is emitted at n = 3 under another name, the miss
  // collects are reordered, or the site is not returned through `GadgetResult.decisions`.
  it('declares every place and transition at n = 3, k = 2, and every name is in the net', () => {
    const compiled = compile(wf(quorum(2, ids(3).map((id) => step(id)))));
    const d = site(compiled);
    expect(d).toStrictEqual({
      path: [0],
      blockId: 'q',
      k: 2,
      n: 3,
      permit: 's.0.q.permit',
      okSeen: 's.0.q.ok-seen',
      miss: 's.0.q.miss',
      won: 's.0.q.won',
      short: 's.0.q.short',
      settled: 's.0.q.settled',
      preempted: ['s.0.q.arm-0-preempted', 's.0.q.arm-1-preempted', 's.0.q.arm-2-preempted'],
      met: 't.0.q.met',
      shortTransition: 't.0.q.short',
      collectOk: ['t.0.q.collect-0', 't.0.q.collect-1', 't.0.q.collect-2'],
      collectMiss: [
        't.0.q.collect-err',
        't.0.q.collect-bail',
        't.0.q.collect-susp',
        't.0.q.collect-pause',
        't.0.q.collect-preempted-0',
        't.0.q.collect-preempted-1',
        't.0.q.collect-preempted-2',
      ],
      collectPreempted: ['t.0.q.collect-preempted-0', 't.0.q.collect-preempted-1', 't.0.q.collect-preempted-2'],
      absorbs: ['t.0.q.absorb-ok-won', 't.0.q.absorb-miss-won', 't.0.q.absorb-ok-short', 't.0.q.absorb-miss-short'],
      joinMet: 't.0.q.join-met',
      joinShort: 't.0.q.join-short',
    });
    const transitions = byName(compiled);
    const places = placeNames(compiled);
    for (const name of [d.permit, d.okSeen, d.miss, d.won, d.short, d.settled!, ...d.preempted]) expect(places).toContain(name);
    for (const name of [d.met, d.shortTransition, ...d.collectOk, ...d.collectMiss, ...d.absorbs, d.joinMet, d.joinShort]) {
      expect(transitions.has(name)).toBe(true);
    }
    // The old parallel join is not here: the decision replaces it, never sits beside it.
    expect(transitions.has('t.0.q.join-ok')).toBe(false);
    expect(places.has('s.0.q.arrived')).toBe(false);
  });

  // Breaks if: the parallel gadget stops delegating, or an unannotated block gains a decision.
  it('an unannotated .parallel() declares no decision', () => {
    const compiled = compile(wf({ kind: 'parallel', id: 'q', arms: [step('a'), step('b')] }));
    expect(compiled.decisions).toStrictEqual([]);
  });
});

/** Every (n, k) the proofs use, plus the edges n = 1 and k = n = 2. */
const CONFIGS: readonly [number, number][] = [[1, 1], [2, 2], [3, 1], [3, 2], [3, 3], [4, 1], [4, 2]];

describe.each(CONFIGS)('quorum: arcs at n = %i, k = %i', (n, k) => {
  const compiled = compile(wf(quorum(k, ids(n).map((id) => step(id)))));
  const d = site(compiled);
  const t = byName(compiled);

  // Breaks if: `met` takes `one(okSeen)`, a count other than k, or anything beside permit + okSeen;
  // or `short` counts n − k misses (deadlocks when all arrive) or anything but permit + miss.
  it('met takes permit + exactly(k, okSeen) -> won; short takes permit + exactly(n − k + 1, miss) -> short', () => {
    expect(ins(t.get(d.met)!)).toStrictEqual([['one', d.permit], ['exactly', d.okSeen, k]]);
    expect(enumerateBranches(t.get(d.met)!.outputSpec!).map((b) => [...b].map((p) => p.name))).toStrictEqual([[d.won]]);
    expect(ins(t.get(d.shortTransition)!)).toStrictEqual([['one', d.permit], ['exactly', d.miss, n - k + 1]]);
    expect(enumerateBranches(t.get(d.shortTransition)!.outputSpec!).map((b) => [...b].map((p) => p.name))).toStrictEqual([[d.short]]);
  });

  // Breaks if: a count of 0 keeps an arc (libpetri refuses `exactly(0)` at build anyway), or a join
  // counts the wrong surplus — `join-met` n − k, `join-short` k − 1.
  it('the joins wait for the surplus; a count of 0 omits its arc', () => {
    const settledArc = (c: number): [string, string, number?][] => (c === 0 ? [] : [['exactly', d.settled!, c]]);
    expect(ins(t.get(d.joinMet)!)).toStrictEqual([['one', d.won], ...settledArc(n - k)]);
    expect(ins(t.get(d.joinShort)!)).toStrictEqual([['one', d.short], ...settledArc(k - 1)]);
  });

  // Breaks if: the dead `-won` pair is emitted at k = n, the dead `-short` pair at k = 1, a live pair
  // is dropped, an absorb consumes `won` / `short` instead of reading it, or `settled` exists at n = 1.
  it('exactly the live absorbs exist, each one(okSeen | miss) + read(decision) -> settled', () => {
    const expected = [
      ...(n >= 2 && k < n ? ['absorb-ok-won', 'absorb-miss-won'] : []),
      ...(n >= 2 && k > 1 ? ['absorb-ok-short', 'absorb-miss-short'] : []),
    ].map((r) => `t.0.q.${r}`);
    expect(d.absorbs).toStrictEqual(expected);
    for (const name of d.absorbs) {
      const absorb = t.get(name)!;
      const [, from, decided] = name.match(/absorb-(ok|miss)-(won|short)$/)!;
      expect(ins(absorb)).toStrictEqual([['one', from === 'ok' ? d.okSeen : d.miss]]);
      expect(absorb.reads.map((r) => r.place.name)).toStrictEqual([decided === 'won' ? d.won : d.short]);
      expect(enumerateBranches(absorb.outputSpec!).map((b) => [...b].map((p) => p.name))).toStrictEqual([[d.settled]]);
    }
    expect([...t.keys()].filter((name) => name.includes('.absorb-')).sort()).toStrictEqual([...expected].sort());
    expect(d.settled === undefined).toBe(n === 1);
    expect([...compiled.net.places].some((p) => p.name === 's.0.q.settled')).toBe(n >= 2);
  });

  // Breaks if: an inhibitor or a reset lands on any decision transition — the W0 spike's reason to
  // drop `arrived`: a non-monotone place splits every collect under VER-004.
  it('no inhibitor and no reset on any decision transition', () => {
    for (const name of [d.met, d.shortTransition, ...d.collectOk, ...d.collectMiss, ...d.absorbs, d.joinMet, d.joinShort]) {
      expect(t.get(name)!.inhibitors).toStrictEqual([]);
      expect(t.get(name)!.resets).toStrictEqual([]);
    }
  });

  // Breaks if: `fork` stops seeding the permit, or seeds it on a separate branch.
  it('fork writes every arm input and the one permit in one branch, gated by cancel', () => {
    const fork = t.get('t.0.q.fork')!;
    expect(enumerateBranches(fork.outputSpec!).map((b) => [...b].map((p) => p.name).sort())).toStrictEqual([
      [...ids(n).map((id, i) => `s.0-${i}.${id}.in`), d.permit].sort(),
    ]);
    expect(fork.inhibitors.map((a) => a.place.name)).toStrictEqual(['wf.cancel']);
  });

  // Breaks if: the bounds are not claimed, `settled` is claimed at a different bound or claimed at
  // n = 1, or the won/short exclusion is dropped.
  it('claims okSeen and miss at n, settled at settledBound, and won/short exclusive', () => {
    expect(compiled.claims.get(d.okSeen)?.bound).toBe(n);
    expect(compiled.claims.get(d.miss)?.bound).toBe(n);
    if (d.settled === undefined) expect([...compiled.claims.keys()].some((p) => p.endsWith('.settled'))).toBe(false);
    else expect(compiled.claims.get(d.settled)?.bound).toBe(settledBound({ k }, n));
    expect(compiled.exclusions.filter((e) => e.a === d.won && e.b === d.short)).toHaveLength(1);
  });

  // Breaks if: an arm of an n ≥ 2 block is emitted without `preempt`, or one of an n = 1 block with it.
  it('every attempt of an arm has a preempted branch iff n ≥ 2', () => {
    for (let i = 0; i < n; i++) {
      const run = t.get(`t.0-${i}.${ids(n)[i]}.run`)!;
      const targets = enumerateBranches(run.outputSpec!).flatMap((b) => [...b].map((p) => p.name));
      expect(targets.includes(`s.0.q.arm-${i}-preempted`)).toBe(n >= 2);
      expect(targets.some((p) => p.endsWith('-preempted') && p !== `s.0.q.arm-${i}-preempted`)).toBe(false);
    }
    expect(d.preempted).toHaveLength(n >= 2 ? n : 0);
    expect(d.collectPreempted).toHaveLength(n >= 2 ? n : 0);
  });
});

describe('quorum: compile-time checks', () => {
  // Breaks if: the gadget stops refusing an empty block, or a k outside [1, n] / not whole.
  it.each([
    ['n = 0', 1, 0],
    ['k = 0', 0, 3],
    ['k = n + 1', 4, 3],
    ['k = 1.5', 1.5, 3],
  ])('refuses %s, naming the block', (_label, k, n) => {
    expect(() => compile(wf(quorum(k, ids(n).map((id) => step(id)))))).toThrow(/block 'q'/);
  });

  // Breaks if: `structuralHash` drops `decision.k` (compile.ts) — the names do not separate two
  // quorums of one block — or an unannotated block gains a key.
  it('the structural hash moves with k, and a decision changes it', () => {
    const arms = ids(3).map((id) => step(id));
    const h = (e: EntryDescription): string => compile(wf(e)).structuralHash;
    const plain = h({ kind: 'parallel', id: 'q', arms });
    expect(new Set([plain, h(quorum(1, arms)), h(quorum(2, arms)), h(quorum(3, arms))]).size).toBe(4);
    expect(h(quorum(2, arms))).toBe(h(quorum(2, arms)));
  });

  // Breaks if: a retry attempt lacks the `preempted` branch (the leaf's job, wired by this gadget's
  // `emitNested(…, { preempt })`).
  it('a retrying arm has the preempted branch on every attempt', () => {
    const compiled = compile(wf(quorum(1, [step('a', { retries: 2 }), step('b')])));
    const t = byName(compiled);
    for (const name of ['t.0-0.a.run', 't.0-0.a.run-1', 't.0-0.a.run-2']) {
      const targets = enumerateBranches(t.get(name)!.outputSpec!).flatMap((b) => [...b].map((p) => p.name));
      expect(targets).toContain('s.0.q.arm-0-preempted');
    }
  });

  // Breaks if: the admission is dropped under a binding concurrency, or a collect — the preempted
  // ones included — does not give its slot back.
  it('under concurrency 2 of 3, arms are admitted in order and every collect gives its slot back', () => {
    const compiled = compile(wf(quorum(1, ids(3).map((id) => step(id)), { concurrency: 2 })));
    const d = site(compiled);
    expect(compiled.pools.filter((p) => p.kind === 'slots')).toHaveLength(1);
    const pool = compiled.pools.find((p) => p.kind === 'slots')!;
    expect(pool.takers).toStrictEqual(['t.0.q.admit-0', 't.0.q.admit-1', 't.0.q.admit-2']);
    expect([...pool.givers].sort()).toStrictEqual([...d.collectOk, ...d.collectMiss].sort());
  });
});

// --------------------------------------------------------------------------------------------------
// Runs
// --------------------------------------------------------------------------------------------------

/** A loser: waits until its block preempts it (or a long fallback), then claims success — discarded. */
const loser = (seen: string[], id: string) => async (_input: unknown, call: StepCall): Promise<StepOutcome> => {
  if (call.preempt === undefined) throw new Error(`arm '${id}' was not handed its block's preemption`);
  if (!call.preempt.aborted) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      call.preempt!.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
  seen.push(id);
  return { status: 'success', output: `${id}-late` };
};

type Behaviour = (input: unknown, call: StepCall) => StepOutcome | Promise<StepOutcome>;

/**
 * A runner over per-step behaviours, recording calls, with a `forgetSuspension` spy. It speaks the
 * verdict protocol as `MastraStepRunner` does ([ADR 0014]): one `attemptGate` per call, an attempt
 * the block has already decided is not started (and not recorded in `calls`), and a started
 * attempt's verdict is frozen when its behaviour settles and reported when the gate is decisive.
 */
function scripted(steps: Record<string, Behaviour>) {
  const calls: string[] = [];
  const preempts: (AbortSignal | undefined)[] = [];
  const forgetSuspension = vi.fn<(stepId: string) => void>();
  const runner: StepRunner = {
    async run(stepId, input, call) {
      const gate = attemptGate(stepId, call, new AbortController());
      try {
        if (gate.expired()) {
          const v = gate.freeze();
          return { status: 'failed', error: v.kind === 'own' ? undefined : v.reason, verdict: reportedVerdict(v, false) };
        }
        calls.push(stepId);
        preempts.push(call.preempt);
        const fn = steps[stepId];
        const outcome = fn === undefined ? ({ status: 'success', output: input } as StepOutcome) : await fn(input, call);
        const v = gate.freeze();
        return gate.decisive ? { ...outcome, verdict: reportedVerdict(v, true) } : outcome;
      } finally {
        gate.release();
      }
    },
    forgetSuspension,
  };
  return { runner, calls, preempts, forgetSuspension };
}

async function runIt(description: WorkflowDescription, runner: StepRunner, options: { signal?: AbortSignal } = {}) {
  const compiled = compile(description);
  const store = new InMemoryEventStore();
  const report = await runWorkflowDetailed(compiled, 'x', { runner, eventStore: store, timeoutMs: 10_000, ...options });
  const d = compiled.decisions[0]!;
  /** The tokens deposited into a place, in order. */
  const added = (placeName: string): unknown[] =>
    store.events().flatMap((e) => (e.type === 'token-added' && e.placeName === placeName ? [e.token.value] : []));
  const fired = (transitionName: string): number =>
    store.events().filter((e) => e.type === 'transition-completed' && e.transitionName === transitionName).length;
  return { report, d, added, fired };
}

const preemptedBy = (outcome: 'met' | 'short') => new StepPreemptedError('q', [0], outcome);

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * n = 3 (k = 1, 2, 3) and n = 4 (k = 1, 2). The k winners succeed in **reverse** arm order (the last
 * arm first), so FIFO and index order disagree; every other arm is a loser waiting on its signal.
 */
describe.each([[3, 1], [3, 2], [3, 3], [4, 1], [4, 2]] as const)('quorum runs: n = %i, k = %i, decided by met', (n, k) => {
  const arms = ids(n);
  const winners = arms.slice(n - k).reverse(); // time order: last arm first
  const losers = arms.slice(0, n - k);

  const script = () => {
    const late: string[] = [];
    const steps: Record<string, Behaviour> = {};
    winners.forEach((id, rank) => {
      steps[id] = async (input) => {
        await after(5 + 15 * rank);
        return { status: 'success', output: `${input as string}/${id}` };
      };
    });
    for (const id of losers) steps[id] = loser(late, id);
    return { late, ...scripted(steps) };
  };

  // Breaks if: `met` takes winners in index order (`won` would read low index first), `met`'s action
  // does not call `scope.preempt` (losers sit 2 s and then succeed: their records read `success`), the
  // absorbs are missing (the run strands with `won` and okSeen/miss marked), or a join fires early.
  it('as the last entry: the winners are FIFO, the losers preempted and canceled, no residue', async () => {
    const s = script();
    const { report, d, added, fired } = await runIt(wf(quorum(k, arms.map((id) => step(id)))), s.runner);

    expect(report.outcome).toStrictEqual({
      status: 'success',
      output: Object.fromEntries(arms.filter((id) => winners.includes(id)).map((id) => [id, `x/${id}`])),
    });
    // FIFO on okSeen ([IO-002]): the first k in collect order, which is time order.
    const won = added(d.won) as { winners: { index: number }[]; reason: StepPreemptedError }[];
    expect(won).toHaveLength(1);
    expect(won[0]!.winners.map((w) => arms[w.index])).toStrictEqual(winners);
    expect(won[0]!.reason).toStrictEqual(preemptedBy('met'));
    expect(fired(d.met)).toBe(1);
    expect(fired(d.shortTransition)).toBe(0);
    expect(fired(d.joinMet)).toBe(1);
    expect(fired(d.joinShort)).toBe(0);
    // Every loser ran, saw the signal, and is recorded `canceled` with the block's reason.
    expect([...s.late].sort()).toStrictEqual([...losers].sort());
    for (const id of losers) {
      const record = report.stepResults.get(id)!;
      expect(record.status).toBe('canceled');
      expect(record.status === 'canceled' && record.reason).toStrictEqual(preemptedBy('met'));
      expect(record.status === 'canceled' && record.reason).toBeInstanceOf(StepPreemptedError);
    }
    for (const id of winners) expect(report.stepResults.get(id)).toMatchObject({ status: 'success', output: `x/${id}` });
    // Every arm attempt carried the block's one signal.
    expect(s.preempts.every((p) => p !== undefined && p === s.preempts[0])).toBe(true);
    expect(s.forgetSuspension).not.toHaveBeenCalled();
  });

  // Breaks if: the join's next value is built from the arrivals rather than the step records (a
  // loser's key would be missing, or carry its discarded `-late` output), or the next entry runs
  // before every loser has settled.
  it('then a next entry: it gets every declared arm, a loser present and undefined, after all settle', async () => {
    const s = script();
    let saw: unknown;
    const steps = { ...s };
    const runner: StepRunner = {
      run: async (id, input, call) => {
        if (id === 'next') {
          // Every loser had already settled when `next` ran.
          expect([...s.late].sort()).toStrictEqual([...losers].sort());
          saw = input;
          return { status: 'success', output: 'done' };
        }
        return steps.runner.run(id, input, call);
      },
    };
    const { report } = await runIt(wf(quorum(k, arms.map((id) => step(id))), step('next')), runner);
    expect(report.outcome).toStrictEqual({ status: 'success', output: 'done' });
    expect(saw).toStrictEqual(Object.fromEntries(arms.map((id) => [id, winners.includes(id) ? `x/${id}` : undefined])));
    expect(Object.keys(saw as object)).toStrictEqual(arms);
  });
});

describe('quorum runs: no winner', () => {
  // Breaks if: the failed join reports the first failure in time instead of the lowest index, wraps
  // it, or `short`'s action does not preempt (arm b would then succeed late and be recorded success).
  it('n = 3, k = 2: two failures decide short; the lowest-index failure is forwarded unchanged', async () => {
    const late: string[] = [];
    const s = scripted({
      a: async () => {
        await after(20);
        return { status: 'failed', error: 'a!' };
      },
      b: loser(late, 'b'),
      c: async () => ({ status: 'failed', error: 'c!', tripwire: { reason: 'c' } }),
    });
    const { report, d, fired } = await runIt(wf(quorum(2, [step('a'), step('b'), step('c')]), step('next')), s.runner);
    expect(report.outcome).toStrictEqual({ status: 'failed', stepId: 'a', path: [0, 0], error: 'a!' });
    expect(fired(d.shortTransition)).toBe(1);
    expect(fired(d.met)).toBe(0);
    expect(late).toStrictEqual(['b']);
    expect(report.stepResults.get('b')).toMatchObject({ status: 'canceled', reason: preemptedBy('short') });
    expect(s.calls).not.toContain('next');
  });

  // Breaks if: statuses are read from records after the rewrite (`suspended` would read `canceled`),
  // the suspended loser's record is not rewritten, or its resume labels are not forgotten.
  it('n = 3, k = 2: no failed arm — QuorumNotMetError with suspended and preempted distinct', async () => {
    const late: string[] = [];
    const s = scripted({
      a: async () => ({ status: 'suspended', suspendPayload: { ask: 'a' } }),
      b: loser(late, 'b'),
      c: async () => {
        await after(10);
        return { status: 'bailed', output: 'c-bail' };
      },
    });
    const { report } = await runIt(wf(quorum(2, [step('a'), step('b'), step('c')])), s.runner);
    expect(report.outcome.status).toBe('failed');
    const outcome = report.outcome as { stepId: string; path: EntryPath; error: QuorumNotMetError; residue?: unknown };
    expect(outcome.residue).toBeUndefined();
    expect(outcome.stepId).toBe('q');
    expect(outcome.path).toStrictEqual([0]);
    expect(outcome.error).toBeInstanceOf(QuorumNotMetError);
    expect({ need: outcome.error.need, succeeded: outcome.error.succeeded, statuses: outcome.error.statuses }).toStrictEqual({
      need: 2,
      succeeded: 0,
      statuses: [
        { stepId: 'a', index: 0, status: 'suspended' },
        { stepId: 'b', index: 1, status: 'preempted' },
        { stepId: 'c', index: 2, status: 'bailed' },
      ],
    });
    expect(report.stepResults.get('a')).toMatchObject({ status: 'canceled', reason: preemptedBy('short'), payload: 'x' });
    expect(report.stepResults.get('a')).not.toHaveProperty('suspendPayload');
    expect(s.forgetSuspension.mock.calls).toStrictEqual([['a']]);
    expect(report.stepResults.get('c')).toMatchObject({ status: 'bailed', output: 'c-bail' });
  });

  // Breaks if: the suspended loser is rewritten only on the failed join, not on `join-met`.
  it('n = 3, k = 1: a suspended arm under met is rewritten canceled and its labels forgotten', async () => {
    const late: string[] = [];
    const s = scripted({
      a: async () => ({ status: 'suspended', suspendPayload: null }),
      b: async () => {
        await after(10);
        return { status: 'success', output: 'b!' };
      },
      c: loser(late, 'c'),
    });
    const { report } = await runIt(wf(quorum(1, [step('a'), step('b'), step('c')])), s.runner);
    expect(report.outcome).toStrictEqual({ status: 'success', output: { b: 'b!' } });
    expect(report.stepResults.get('a')).toMatchObject({ status: 'canceled', reason: preemptedBy('met') });
    expect(s.forgetSuspension.mock.calls).toStrictEqual([['a']]);
  });
});

describe('quorum runs: edges', () => {
  // Breaks if: a preempted arrival is not counted as a miss (the net then deadlocks: n arrivals, the
  // permit marked, no threshold met), or the absorbs do not take preempted misses after `short`.
  // The net allows the `preempted` branch before any decision; this forces it at runtime.
  it.each([[3, 1], [3, 2], [4, 2]] as const)('every arm preempted before any decision: n = %i, k = %i ends short, no residue', async (n, k) => {
    const early = new AbortController();
    early.abort(new StepPreemptedError('elsewhere', [9], 'met'));
    vi.spyOn(KernelRunScope.prototype, 'preemption').mockImplementation(() => early.signal);
    const s = scripted({});
    const arms = ids(n);
    const { report, d, fired } = await runIt(wf(quorum(k, arms.map((id) => step(id)))), s.runner);
    expect(s.calls).toStrictEqual([]);
    expect(fired(d.shortTransition)).toBe(1);
    const outcome = report.outcome as { status: string; error: QuorumNotMetError; residue?: unknown };
    expect(outcome.status).toBe('failed');
    expect(outcome.residue).toBeUndefined();
    expect(outcome.error.statuses.map((x) => x.status)).toStrictEqual(arms.map(() => 'preempted'));
  });

  // Breaks if: an n = 1 block gets a preemption (the arm would be handed `StepCall.preempt`), or
  // `settled` / an absorb is referenced (the build fails on a missing place).
  it('n = 1: success passes, the arm gets no preemption signal', async () => {
    const s = scripted({ a: async () => ({ status: 'success', output: 1 }) });
    const { report } = await runIt(wf(quorum(1, [step('a')])), s.runner);
    expect(report.outcome).toStrictEqual({ status: 'success', output: { a: 1 } });
    expect(s.preempts).toStrictEqual([undefined]);
  });

  // Breaks if: an n = 1 suspension is not a miss, or its record is left `suspended`.
  it('n = 1: a suspension is a miss; QuorumNotMetError, the record canceled', async () => {
    const s = scripted({ a: async () => ({ status: 'suspended', suspendPayload: 1 }) });
    const { report } = await runIt(wf(quorum(1, [step('a')])), s.runner);
    const outcome = report.outcome as { status: string; error: QuorumNotMetError; residue?: unknown };
    expect(outcome.status).toBe('failed');
    expect(outcome.residue).toBeUndefined();
    expect(outcome.error.statuses).toStrictEqual([{ stepId: 'a', index: 0, status: 'suspended' }]);
    expect(report.stepResults.get('a')).toMatchObject({ status: 'canceled', reason: preemptedBy('short') });
    expect(s.forgetSuspension.mock.calls).toStrictEqual([['a']]);
  });

  // Breaks if: the admission is dropped (c would run concurrently and be called), or a preempted
  // collect keeps its slot (the pool would show at rest as residue).
  it('concurrency 2 of 3, k = 1: the arm admitted after the decision is never called', async () => {
    const late: string[] = [];
    const s = scripted({
      a: loser(late, 'a'),
      b: async () => {
        await after(10);
        return { status: 'success', output: 'b!' };
      },
    });
    const { report } = await runIt(wf(quorum(1, [step('a'), step('b'), step('c')], { concurrency: 2 })), s.runner);
    expect(report.outcome).toStrictEqual({ status: 'success', output: { b: 'b!' } });
    expect(s.calls.sort()).toStrictEqual(['a', 'b']);
    expect(report.stepResults.get('c')).toMatchObject({ status: 'canceled', reason: preemptedBy('met') });
  });

  // Breaks if: `fork` loses its cancel inhibitor or the sweep is dropped.
  it('a run aborted before the block: canceled, never started, no arm called', async () => {
    const abort = new AbortController();
    abort.abort();
    const s = scripted({});
    const { report } = await runIt(wf(quorum(1, [step('a'), step('b')])), s.runner, { signal: abort.signal });
    expect(report.outcome).toStrictEqual({ status: 'canceled', origin: { stepId: 'q', path: [0] }, started: false });
    expect(s.calls).toStrictEqual([]);
  });
});

/**
 * Mutants of `first-k.ts` the runs above let through. Each test names the one it kills; each was
 * confirmed by applying the mutant to the source and seeing this test fail, then restoring it.
 *
 * Two of them need an arrival **after** the decision that the leaf did not turn into a preemption —
 * a surplus success, a suspension after `short`. At runtime that is an arm whose attempt settles
 * between the decision and its preemption; here it is forced by making `KernelRunScope.preempt` a
 * no-op, so the late arrival reaches its absorb deterministically. The net allows it either way.
 */
describe('quorum runs: the joins over the absorbed surplus', () => {
  const noPreempt = () => vi.spyOn(KernelRunScope.prototype, 'preempt').mockImplementation(() => {});

  // Kills: the last entry's output built from `winners` alone, not `[...winners, ...rest]` — a
  // surplus success absorbed after `met` would drop out of the block's output.
  it('n = 3, k = 1, last entry: a surplus success that settles after met is in the output', async () => {
    noPreempt();
    const s = scripted({
      a: async () => {
        await after(5);
        return { status: 'success', output: 'a!' };
      },
      b: async () => {
        await after(30);
        return { status: 'success', output: 'b!' };
      },
      c: async () => {
        await after(40);
        return { status: 'bailed', output: 'c-bail' };
      },
    });
    const { report, d, added, fired } = await runIt(wf(quorum(1, [step('a'), step('b'), step('c')])), s.runner);
    expect((added(d.won) as { winners: { index: number }[] }[]).map((w) => w.winners.map((x) => x.index))).toStrictEqual([[0]]);
    expect(fired(d.joinMet)).toBe(1);
    expect(report.outcome).toStrictEqual({ status: 'success', output: { a: 'a!', b: 'b!' } });
  });

  // Kills: `join-short` rewriting only `misses`, not the absorbed `rest` — a suspension arriving after
  // `short` would keep its `suspended` record and its resume labels.
  it('n = 3, k = 2: a suspension absorbed after short is rewritten canceled, its labels forgotten', async () => {
    noPreempt();
    const s = scripted({
      a: async () => {
        await after(30);
        return { status: 'suspended', suspendPayload: { ask: 'a' } };
      },
      b: async () => ({ status: 'bailed', output: 'b-bail' }),
      c: async () => {
        await after(5);
        return { status: 'bailed', output: 'c-bail' };
      },
    });
    const { report, d, added } = await runIt(wf(quorum(2, [step('a'), step('b'), step('c')])), s.runner);
    // `short` was decided by b and c; a arrived after it, through `absorb-miss-short`.
    const shorts = added(d.short) as { misses: { index: number }[] }[];
    expect(shorts.map((x) => x.misses.map((m) => m.index).sort())).toStrictEqual([[1, 2]]);
    const outcome = report.outcome as { status: string; error: QuorumNotMetError; residue?: unknown };
    expect(outcome.status).toBe('failed');
    expect(outcome.residue).toBeUndefined();
    expect(outcome.error.statuses.map((x) => x.status)).toStrictEqual(['suspended', 'bailed', 'bailed']);
    expect(report.stepResults.get('a')).toMatchObject({ status: 'canceled', reason: preemptedBy('short') });
    expect(s.forgetSuspension.mock.calls).toStrictEqual([['a']]);
  });
});

describe('quorum runs: what the joins report', () => {
  // Kills: `QuorumNotMetError.succeeded` hard-coded 0 — or counted from the misses alone, missing the
  // success that `absorb-ok-short` settled.
  it('n = 3, k = 2: one success, then a suspension and a bail — short counts the success', async () => {
    const s = scripted({
      a: async () => ({ status: 'success', output: 'a!' }),
      b: async () => {
        await after(5);
        return { status: 'suspended', suspendPayload: null };
      },
      c: async () => {
        await after(15);
        return { status: 'bailed', output: 'c-bail' };
      },
    });
    const { report } = await runIt(wf(quorum(2, [step('a'), step('b'), step('c')])), s.runner);
    const outcome = report.outcome as { status: string; error: QuorumNotMetError; residue?: unknown };
    expect(outcome.status).toBe('failed');
    expect(outcome.residue).toBeUndefined();
    expect(outcome.error).toBeInstanceOf(QuorumNotMetError);
    expect({ need: outcome.error.need, succeeded: outcome.error.succeeded, statuses: outcome.error.statuses }).toStrictEqual({
      need: 2,
      succeeded: 1,
      statuses: [
        { stepId: 'a', index: 0, status: 'success' },
        { stepId: 'b', index: 1, status: 'suspended' },
        { stepId: 'c', index: 2, status: 'bailed' },
      ],
    });
    expect(report.stepResults.get('a')).toMatchObject({ status: 'success', output: 'a!' });
  });

  // Kills: `outputOf` without its `bailed` case — the next entry would read a bailed arm's key as
  // `undefined`, where Mastra's `stepResults[id]?.output` reads the bail's output.
  it('n = 3, k = 1, then a next entry: a bailed arm passes its output, a loser undefined', async () => {
    const late: string[] = [];
    let saw: unknown;
    const s = scripted({
      a: async () => {
        await after(10);
        return { status: 'success', output: 'a!' };
      },
      b: async () => ({ status: 'bailed', output: 'b-bail' }),
      c: loser(late, 'c'),
      next: async (input) => {
        saw = input;
        return { status: 'success', output: 'done' };
      },
    });
    const { report } = await runIt(wf(quorum(1, [step('a'), step('b'), step('c')]), step('next')), s.runner);
    expect(report.outcome).toStrictEqual({ status: 'success', output: 'done' });
    expect(saw).toStrictEqual({ a: 'a!', b: 'b-bail', c: undefined });
    expect(Object.keys(saw as object)).toStrictEqual(['a', 'b', 'c']);
  });
});

describe('quorum runs: the suspended loser rewrite', () => {
  // Kills: `canceledFrom` dropping `metadata` or `startedAt`, and `rewriteSuspended` not emitting
  // `step-settled` for the rewritten record. The arm id `a` ran first as a loop body, so its suspended
  // record carries `metadata.iterationCount` over (row 48), as Mastra's carry-over does.
  it('the rewritten record keeps payload, startedAt and metadata, and is observed as step-settled', async () => {
    const late: string[] = [];
    let aCalls = 0;
    const events: { kind: string; stepId?: string; record?: { status: string } }[] = [];
    const s = scripted({
      a: async (input) => {
        aCalls += 1;
        return aCalls === 1 ? { status: 'success', output: input } : { status: 'suspended', suspendPayload: { ask: 'a' } };
      },
      b: async () => {
        await after(10);
        return { status: 'success', output: 'b!' };
      },
      c: loser(late, 'c'),
    });
    const runner: StepRunner = {
      ...s.runner,
      evaluateLoopCondition: async () => false,
      observe: (event) => {
        events.push(event as (typeof events)[number]);
      },
    };
    const description = wf(
      { kind: 'loop', id: 'l', body: step('a'), loopType: 'dowhile', iterationBound: 3 },
      quorum(1, [step('a'), step('b'), step('c')]),
    );
    const { report } = await runIt(description, runner);
    expect(report.outcome).toStrictEqual({ status: 'success', output: { b: 'b!' } });
    expect(aCalls).toBe(2);

    const settledA = events.filter((e) => e.kind === 'step-settled' && e.stepId === 'a').map((e) => e.record as StepRecordLike);
    const suspended = settledA.find((r) => r.status === 'suspended');
    expect(suspended).toBeDefined();
    expect(typeof suspended!.startedAt).toBe('number');
    expect(suspended!.metadata).toStrictEqual({ iterationCount: 1 });

    const reason = new StepPreemptedError('q', [1], 'met');
    const rewritten = report.stepResults.get('a') as StepRecordLike;
    expect(rewritten).toStrictEqual({
      status: 'canceled',
      reason,
      payload: suspended!.payload,
      startedAt: suspended!.startedAt,
      endedAt: rewritten.endedAt,
      metadata: { iterationCount: 1 },
    });
    expect(typeof rewritten.endedAt).toBe('number');
    // The rewrite is observed, after the suspension, as the record the store now holds.
    expect(settledA.map((r) => r.status)).toStrictEqual(['success', 'suspended', 'canceled']);
    expect(settledA[2]).toStrictEqual(rewritten);
    expect(s.forgetSuspension.mock.calls).toStrictEqual([['a']]);
  });

  // Kills: `rewriteSuspended` dropping `await observed` — the join would fire on before the
  // rewritten record's `step-settled` observer had finished, so the next entry would start first.
  it('the join waits for the rewrite\'s step-settled observer before the next entry runs', async () => {
    const order: string[] = [];
    const s = scripted({
      a: async () => ({ status: 'suspended', suspendPayload: null }),
      b: async () => {
        await after(10);
        return { status: 'success', output: 'b!' };
      },
      c: loser([], 'c'),
      z: async (input) => {
        order.push('z');
        return { status: 'success', output: input };
      },
    });
    const runner: StepRunner = {
      ...s.runner,
      observe: async (event) => {
        const e = event as { kind: string; stepId?: string; record?: { status: string } };
        if (e.kind !== 'step-settled' || e.stepId !== 'a' || e.record?.status !== 'canceled') return;
        await after(30);
        order.push('observed-a-canceled');
      },
    };
    const { report } = await runIt(wf(quorum(1, [step('a'), step('b'), step('c')]), step('z')), runner);
    expect(report.outcome).toMatchObject({ status: 'success' });
    expect(report.stepResults.get('a')).toMatchObject({ status: 'canceled', reason: preemptedBy('met') });
    expect(order).toStrictEqual(['observed-a-canceled', 'z']);
  });

  // Kills: `rewriteSuspended` without its prior-status guard — a suspended arrival whose record
  // another writer replaced since would be overwritten `canceled` and its labels forgotten.
  it('a suspended arrival whose record was replaced since is left alone', async () => {
    const record = vi.spyOn(KernelRunScope.prototype, 'recordStepResult');
    const replaced = { status: 'success', output: 'replaced', payload: 'z' } as const;
    const s = scripted({
      a: async () => ({ status: 'suspended', suspendPayload: null }),
      b: async () => {
        await after(10);
        return { status: 'success', output: 'b!' };
      },
      c: async (_input, call) => {
        // A loser that, before it settles, sees another writer replace a's record.
        await new Promise<void>((resolve) => call.preempt!.addEventListener('abort', () => resolve(), { once: true }));
        const scope = record.mock.contexts[0] as KernelRunScope;
        scope.recordStepResult('a', replaced);
        return { status: 'success', output: 'c-late' };
      },
    });
    const { report } = await runIt(wf(quorum(1, [step('a'), step('b'), step('c')])), s.runner);
    expect(report.outcome).toStrictEqual({ status: 'success', output: { b: 'b!' } });
    expect(report.stepResults.get('a')).toStrictEqual(replaced);
    expect(s.forgetSuspension).not.toHaveBeenCalled();
    expect(report.stepResults.get('c')).toMatchObject({ status: 'canceled', reason: preemptedBy('met') });
  });
});

type StepRecordLike = {
  status: string;
  payload?: unknown;
  startedAt?: number;
  endedAt?: number;
  metadata?: unknown;
  reason?: unknown;
};

import { describe, expect, it } from 'vitest';
import { PetriNet, Transition, and, one, outPlace, place, xor, type Out, type Place } from 'libpetri';
import { compile, parallelGadget, stepGadget, type Gadget } from '../../src/compiler/index.js';
import {
  boundClaims,
  describeClaim,
  exclusions,
  livenessTargets,
  retryCeilingViolations,
  segmentLabel,
  verify,
  type ClaimReport,
  type VerificationReport,
} from '../../src/verify/index.js';
import type { CompiledWorkflow, EntryDescription, FlowToken, StepDescription } from '../../src/compiler/types.js';

/**
 * The four claim families of [ADR 0009], on small compiled workflows: what each derives, and — for
 * each family — one mutant that every completion proof passes and exactly that family refutes.
 *
 * Every query: sinks the six terminals and `wf.cancel`; segments `closed`, `cancel`, then
 * `resume@s` and `resume@s+cancel` per site; bounds and exclusions in every segment, liveness in
 * `closed`; environment mode none (one closed net). Routes and times are in `describeClaim`, which
 * every failed assertion prints.
 */

const step = (id: string, retries = 0): StepDescription => ({ kind: 'step', id, ...(retries > 0 ? { retries } : {}) });
const wf = (...entries: EntryDescription[]) => ({ id: 'claims', entries });

const key = (c: ClaimReport): string => `${segmentLabel(c.segment)}/${c.property}`;
const failing = (report: VerificationReport): string[] => report.claims.filter((c) => !c.holds).map(key).sort();
const why = (report: VerificationReport): string => report.claims.filter((c) => !c.holds).map(describeClaim).join('\n');

/** Every claim holds, and each one says so with an explicit verdict — never "not violated". */
function expectHolds(report: VerificationReport): void {
  for (const c of report.claims) {
    if (c.kind === 'proof') expect(c.result.verdict.type, describeClaim(c)).toBe('proven');
    else {
      expect(c.result.verdict.type, describeClaim(c)).toBe('violated');
      expect(c.result.counterexampleConfirmed, describeClaim(c)).toBe(true);
    }
  }
  expect(report.holds, why(report)).toBe(true);
}

function placeNamed(compiled: CompiledWorkflow, name: string): Place<unknown> {
  const p = [...compiled.net.places].find((x) => x.name === name);
  if (p === undefined) throw new Error(`no place '${name}'`);
  return p;
}

/** The compiled workflow with some transitions replaced (by name) and others added; nothing else. */
function rewired(compiled: CompiledWorkflow, replace: Record<string, Transition | null>, add: readonly Transition[] = []): CompiledWorkflow {
  const transitions = [...compiled.net.transitions].flatMap((t) => (t.name in replace ? (replace[t.name] === null ? [] : [replace[t.name]!]) : [t]));
  const net = PetriNet.builder(compiled.net.name).places(...compiled.net.places).transitions(...transitions, ...add).build();
  return { ...compiled, net };
}

/** A copy of `t` with a different output spec; everything else kept. */
function withOutputs(t: Transition, out: Out): Transition {
  const b = Transition.builder(t.name).inputs(...t.inputSpecs).outputs(out).timing(t.timing).priority(t.priority).action(t.action);
  for (const a of t.inhibitors) b.inhibitor(a.place);
  for (const a of t.resets) b.reset(a.place);
  for (const a of t.reads) b.read(a.place);
  return b.build();
}

const transitionNamed = (compiled: CompiledWorkflow, name: string): Transition => {
  const t = [...compiled.net.transitions].find((x) => x.name === name);
  if (t === undefined) throw new Error(`no transition '${name}'`);
  return t;
};

describe('derivation', () => {
  it('claims 1 on every place of a chain, and derives the barrier from the entries', () => {
    const compiled = compile(wf(step('a'), step('b')));
    const { claimed, unclaimed } = boundClaims(compiled);
    expect(unclaimed).toEqual([]);
    expect(claimed.every((c) => c.bound === 1)).toBe(true);
    expect(claimed.map((c) => c.place.name)).toEqual([...compiled.net.places].map((p) => p.name).sort((a, b) => a.localeCompare(b)));

    expect(compiled.entries.map((e) => [e.index, e.id, e.interior, e.next])).toEqual([
      [0, 'a', ['s.0.a.in'], 's.1.b.in'],
      [1, 'b', ['s.1.b.in'], 'wf.settle.done'],
    ]);
    // Each owned place against `next` and the outcome places — five settles and `wf.canceled` —
    // counting the success settle once where it is also `next`: 7 for `a`, 6 for `b`.
    const pairs = exclusions(compiled).map((e) => `${e.a.name}|${e.b.name}`);
    expect(pairs).toHaveLength(7 + 6);
    expect(pairs).toContain('s.0.a.in|s.1.b.in');
    expect(pairs).toContain('s.1.b.in|wf.settle.done');
    expect(pairs).toContain('s.1.b.in|wf.canceled');
  });

  it('takes a block\'s arm count, a foreach\'s lanes and its exclusions, and lists what it does not claim', () => {
    const compiled = compile(wf(
      { kind: 'parallel', id: 'fan', arms: [step('x'), step('y'), step('z')] },
      { kind: 'loop', id: 'poll', body: step('tick'), loopType: 'dowhile', iterationBound: 4 },
      { kind: 'foreach', id: 'items', body: step('item'), concurrency: 2 },
    ));
    const bound = new Map(boundClaims(compiled).claimed.map((c) => [c.place.name, c.bound]));
    for (const role of ['arrived', 'arm-err', 'arm-bail', 'arm-susp', 'arm-pause', 'err-seen', 'susp-seen']) expect(bound.get(`s.0.fan.${role}`), role).toBe(3);
    expect(bound.get('s.2.items.faults')).toBe(2);
    expect(bound.get('s.2.items.exits')).toBe(2);
    expect(bound.get('s.2.items.cursor')).toBe(1);
    expect(boundClaims(compiled).unclaimed.map((u) => u.place)).toEqual([
      's.1.poll.budget',
      's.2.items.parked',
      's.2.items.results',
      's.2.items.suspensions',
    ]);
    const declared = exclusions(compiled).filter((e) => e.source === 'gadget').map((e) => `${e.a.name}|${e.b.name}`);
    expect(declared).toEqual([
      's.2.items.cursor|s.2.items.faults',
      's.2.items.cursor|s.2.items.exits',
      's.2.items.cursor|s.2.items.suspensions',
      's.2.items.lane0.permit|s.2.items.lane0.slot',
      's.2.items.lane1.permit|s.2.items.lane1.slot',
    ]);
  });

  it('lists a foreach\'s record bounds above two lanes as unclaimed, with the reason, rather than claiming what z3 cannot decide', () => {
    const compiled = compile(wf({ kind: 'foreach', id: 'items', body: step('item'), concurrency: 3 }));
    const unclaimed = boundClaims(compiled).unclaimed;
    expect(unclaimed.map((u) => u.place)).toEqual(['s.0.items.exits', 's.0.items.faults', 's.0.items.parked', 's.0.items.results', 's.0.items.suspensions']);
    expect(unclaimed.find((u) => u.place === 's.0.items.faults')!.why).toMatch(/unknown to z3 above 2 lanes/);
  });

  it('records each step\'s chain and targets every attempt, retries included', () => {
    const compiled = compile(wf(step('a', 2), { kind: 'parallel', id: 'fan', arms: [step('x', 1), step('y')] }));
    expect(compiled.steps.map((s) => [s.stepId, s.path, s.retries, s.attempts, s.hops])).toEqual([
      ['x', [1, 0], 1, ['t.1-0.x.run', 't.1-0.x.run-1'], ['t.1-0.x.retry-1']],
      ['y', [1, 1], 0, ['t.1-1.y.run'], []],
      ['a', [0], 2, ['t.0.a.run', 't.0.a.run-1', 't.0.a.run-2'], ['t.0.a.retry-1', 't.0.a.retry-2']],
    ]);
    expect(livenessTargets(compiled).map((t) => t.transition).sort()).toEqual([...compiled.stepAttempts].sort());
  });
});

describe('retryCeilingViolations', () => {
  const compiled = compile(wf(step('a', 2), step('b')), { concurrency: 2 });

  it('is empty on every compiled chain', () => {
    expect(retryCeilingViolations(compiled)).toEqual([]);
    expect(retryCeilingViolations(compile(wf({ kind: 'foreach', id: 'items', body: step('item', 1), concurrency: 3 })))).toEqual([]);
    expect(retryCeilingViolations(compile(wf({ kind: 'loop', id: 'poll', body: step('tick', 3), loopType: 'dountil', iterationBound: 5 })))).toEqual([]);
  });

  it('flags a final attempt that loops back into a retry: the chain does not end', () => {
    const last = transitionNamed(compiled, 't.0.a.run-2');
    const looping = withOutputs(last, xor(last.outputSpec!, and(outPlace(placeNamed(compiled, 's.0.a.retry-1')), outPlace(placeNamed(compiled, 'wf.permits')))));
    expect(retryCeilingViolations(rewired(compiled, { 't.0.a.run-2': looping }))).toEqual([
      "step 'a' at 0: the final attempt ('t.0.a.run-2') produces into a retry [s.0.a.retry-1]: the chain does not end",
      "step 'a' at 0: retry 's.0.a.retry-1' is produced by [t.0.a.run, t.0.a.run-2]; only attempt 0 may",
    ]);
  });

  it('flags a second way into an attempt', () => {
    const shortcut = Transition.builder('t.0.a.shortcut')
      .inputs(one(placeNamed(compiled, 's.0.a.retry-2')))
      .outputs(outPlace(placeNamed(compiled, 's.0.a.attempt-1')))
      .build();
    expect(retryCeilingViolations(rewired(compiled, {}, [shortcut]))).toEqual([
      "step 'a' at 0: retry 's.0.a.retry-2' is consumed by [t.0.a.retry-2, t.0.a.shortcut]; only hop 1 may",
      "step 'a' at 0: attempt input 's.0.a.attempt-1' is produced by [t.0.a.retry-1, t.0.a.shortcut]; only hop 0 may",
    ]);
  });

  it('flags an attempt that re-enters the step\'s own input, and a chain shorter than its retries', () => {
    const first = transitionNamed(compiled, 't.0.a.run');
    const again = withOutputs(first, xor(first.outputSpec!, and(outPlace(placeNamed(compiled, 's.0.a.in')), outPlace(placeNamed(compiled, 'wf.permits')))));
    expect(retryCeilingViolations(rewired(compiled, { 't.0.a.run': again }))).toEqual([
      "step 'a' at 0: attempt 0 ('t.0.a.run') produces into the chain's own input [s.0.a.in]",
    ]);
    const chain = compiled.steps.find((s) => s.stepId === 'a')!;
    const lying = { ...compiled, steps: compiled.steps.map((s) => (s === chain ? { ...s, retries: 3 } : s)) };
    expect(retryCeilingViolations(lying)).toEqual(["step 'a' at 0 declares 3 retries and has 3 attempts; it needs 4"]);
  });

  it('flags an attempt that never hands a failure to its retry, and verify refuses the net', async () => {
    const first = transitionNamed(compiled, 't.0.a.run');
    const noRetry = withOutputs(first, dropBranchInto(first.outputSpec!, 's.0.a.retry-1'));
    const mutant = rewired(compiled, { 't.0.a.run': noRetry });
    expect(retryCeilingViolations(mutant)).toEqual([
      "step 'a' at 0: attempt 0 ('t.0.a.run') never produces into its retry 's.0.a.retry-1'",
      "step 'a' at 0: retry 's.0.a.retry-1' is produced by []; only attempt 0 may",
    ]);
    await expect(verify(mutant, { families: ['liveness'] })).rejects.toThrow(/retry ceiling structure is unsound/);
  });
});

/** `out` without the xor alternatives that produce into `place`. */
function dropBranchInto(out: Out, placeName: string): Out {
  if (out.type !== 'xor') throw new Error('expected an xor');
  const names = (o: Out): string[] => (o.type === 'place' ? [o.place.name] : o.type === 'and' || o.type === 'xor' ? o.children.flatMap(names) : []);
  return xor(...out.children.filter((c) => !names(c).includes(placeName)));
}

describe('verify: every family holds on real shapes', () => {
  it.each([
    ['a chain with retries', wf(step('a', 2), step('b')), undefined],
    ['the same under a budget of 1', wf(step('a', 2), step('b')), 1],
    ['a parallel and a branch', wf({ kind: 'parallel', id: 'fan', arms: [step('x'), step('y', 1)] }, { kind: 'branch', id: 'pick', arms: [step('p'), step('q')] }), undefined],
    ['a loop', wf(step('a'), { kind: 'loop', id: 'poll', body: step('tick', 1), loopType: 'dowhile', iterationBound: 3 }), undefined],
  ])('%s', async (_label, description, k) => {
    const compiled = compile(description, k === undefined ? {} : { concurrency: k });
    const report = await verify(compiled, { timeoutMs: 120_000 });
    expect(report.families).toEqual(['completion', 'bounds', 'exclusion', 'liveness']);
    expect(report.k).toBe(k ?? 'unbounded');
    expectHolds(report);
    // Every family is present, and liveness covers every attempt exactly once.
    for (const family of report.families) expect(report.claims.some((c) => c.family === family), family).toBe(true);
    expect(report.claims.filter((c) => c.family === 'liveness').map((c) => c.property).sort()).toEqual(compiled.stepAttempts.map((t) => `live(${t})`).sort());
  }, 300_000);
});

describe('a witness of zero firings', () => {
  it('the first step is live from the initial marking itself: violated, confirmed, trace [M0], no firings', async () => {
    // The shape libpetri documents for an initially violating marking (U11; libpetri's own pin is
    // `tests/verification/initial-violation-trace.test.ts`). Every workflow's first step lands here,
    // so a release that changed it would fail the whole corpus gate — this names why.
    for (const k of [undefined, 1]) {
      const compiled = compile(wf(step('a'), step('b')), k === undefined ? {} : { concurrency: k });
      const report = await verify(compiled, { families: ['liveness'] });
      const first = report.claims.find((c) => c.property === 'live(t.0.a.run)')!;
      expect(first.result.verdict.type, describeClaim(first)).toBe('violated');
      expect(first.result.counterexampleConfirmed).toBe(true);
      expect(first.result.counterexampleTransitions).toEqual([]);
      expect(first.result.counterexampleTrace).toHaveLength(1);
      expect(first.holds).toBe(true);
    }
  }, 120_000);
});

describe('non-vacuity: one mutant per family, which every completion proof passes', () => {
  it('bounds: a block that claims 1 where its arms settle n times is refuted on exactly those places', async () => {
    const unclaimed: Gadget = (entry, next, ctx) => {
      const { claims: _dropped, ...rest } = parallelGadget(entry, next, ctx);
      return rest;
    };
    const compiled = compile(wf({ kind: 'parallel', id: 'fan', arms: [step('x'), step('y')] }), { gadgets: { parallel: unclaimed } });
    const report = await verify(compiled, { families: ['completion', 'bounds'], resume: 'none' });
    // Every place a settling arm writes, in both fresh segments; the collect places each take one.
    const over = ['arm-bail', 'arm-err', 'arm-pause', 'arm-susp', 'arrived', 'err-seen', 'susp-seen'];
    expect(failing(report)).toEqual(['cancel', 'closed'].flatMap((s) => over.map((r) => `${s}/bound(s.0.fan.${r}<=1)`)));
    expect(report.claims.filter((c) => c.family === 'completion').every((c) => c.holds), why(report)).toBe(true);
  }, 300_000);

  it('exclusion: a step whose success leaves a token behind that drains later breaks the barrier and nothing else', async () => {
    // The lag drains to nothing, so every quiescent marking is clean and every completion proof
    // stays proven — what they cannot see is that entry 1 started while entry 0 still held work.
    const lagging: Gadget = (entry, next, ctx) => {
      if (entry.id !== 'a') return stepGadget(entry, next, ctx);
      const handoff = place<FlowToken>(ctx.names.entryPlace(ctx.path, entry.id, 'handoff'));
      const lag = place<null>(ctx.names.entryPlace(ctx.path, entry.id, 'lag'));
      const inner = stepGadget(entry, handoff, ctx);
      const split = Transition.builder(ctx.names.entryTransition(ctx.path, entry.id, 'split'))
        .inputs(one(handoff))
        .outputs(and(outPlace(next), outPlace(lag)))
        .action(async (tctx) => {
          tctx.output(next, tctx.input(handoff));
          tctx.output(lag, null);
        })
        .build();
      const drain = Transition.builder(ctx.names.entryTransition(ctx.path, entry.id, 'drain')).inputs(one(lag)).build();
      return { ...inner, transitions: [...inner.transitions, split, drain] };
    };
    const compiled = compile(wf(step('a'), step('b')), { gadgets: { step: lagging } });
    const report = await verify(compiled, { families: ['completion', 'exclusion'] });
    expect(report.claims.filter((c) => c.family === 'completion').every((c) => c.holds), why(report)).toBe(true);
    // The lag beside b's input, and beside every outcome b can reach before it drains; in every
    // segment that starts at or before entry 0 — `resume@1` starts past it and cannot see it.
    const refuted = failing(report);
    expect(refuted).toContain('closed/exclusive(s.0.a.lag,s.1.b.in)');
    expect(refuted).toContain('cancel/exclusive(s.0.a.lag,s.1.b.in)');
    expect(refuted).toContain('resume@0/exclusive(s.0.a.lag,s.1.b.in)');
    expect(refuted.every((k) => k.includes('(s.0.a.lag,'))).toBe(true);
    expect(refuted.some((k) => k.startsWith('resume@1'))).toBe(false);
  }, 300_000);

  it('liveness: an attempt no failure can reach is dead — found with the structure check skipped', async () => {
    const compiled = compile(wf(step('a', 1), step('b')));
    const first = transitionNamed(compiled, 't.0.a.run');
    const mutant = rewired(compiled, { 't.0.a.run': withOutputs(first, dropBranchInto(first.outputSpec!, 's.0.a.retry-1')) });
    const report = await verify(mutant, { families: ['completion', 'liveness'], structure: 'skip' });
    expect(report.claims.filter((c) => c.family === 'completion').every((c) => c.holds), why(report)).toBe(true);
    expect(failing(report)).toEqual(['closed/live(t.0.a.run-1)']);
    // What the dead attempt's query says: proven unreachable — the opposite of a witness.
    expect(report.claims.find((c) => c.property === 'live(t.0.a.run-1)')!.result.verdict.type).toBe('proven');
  }, 300_000);
});

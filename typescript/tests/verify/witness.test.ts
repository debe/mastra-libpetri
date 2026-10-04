import { describe, expect, it } from 'vitest';
import { PetriNet, Transition, and, enumerateBranches, exactly, one, outPlace, place, xor, type Out, type Place } from 'libpetri';
import type { MarkingState } from 'libpetri/verification';
import { compile } from '../../src/compiler/index.js';
import { describeClaim, livenessTargets, segmentInitialMarking, verify } from '../../src/verify/index.js';
import { assertSameNet, avoidingPreemption, executionWitnessesApply, executionWitnesses, stubOutputs, type ClaimResult } from '../../src/verify/witness.js';
import type { CompiledWorkflow, EntryDescription, StepDescription } from '../../src/compiler/types.js';

/**
 * Liveness witnesses read off executor runs of the same net (`witness.ts`): untimed nets only, stub
 * actions on the real `Out` specs, deterministic branch policies, a manual clock. Every claim here:
 * property `live(<attempt>)` (`unreachable(inputs)` refuted), the `closed` segment's initial marking,
 * environment mode none (one closed net), route `execution` — or the verifier's route where no run
 * reached the attempt or the net is timed.
 */

const step = (id: string, extra: Partial<StepDescription> = {}): StepDescription => ({ kind: 'step', id, ...extra });
const wf = (...entries: EntryDescription[]) => ({ id: 'witness', entries });

function rewired(compiled: CompiledWorkflow, replace: Record<string, Transition>): CompiledWorkflow {
  const transitions = [...compiled.net.transitions].map((t) => replace[t.name] ?? t);
  return { ...compiled, net: PetriNet.builder(compiled.net.name).places(...compiled.net.places).transitions(...transitions).build() };
}
function withOutputs(t: Transition, out: Out): Transition {
  const b = Transition.builder(t.name).inputs(...t.inputSpecs).outputs(out).timing(t.timing).priority(t.priority).action(t.action);
  for (const a of t.inhibitors) b.inhibitor(a.place);
  for (const a of t.resets) b.reset(a.place);
  for (const a of t.reads) b.read(a.place);
  return b.build();
}
function dropBranchInto(out: Out, placeName: string): Out {
  if (out.type !== 'xor') throw new Error('expected an xor');
  const names = (o: Out): string[] => (o.type === 'place' ? [o.place.name] : o.type === 'and' || o.type === 'xor' ? o.children.flatMap(names) : []);
  return xor(...out.children.filter((c) => !names(c).includes(placeName)));
}
const transitionNamed = (compiled: CompiledWorkflow, name: string): Transition => [...compiled.net.transitions].find((t) => t.name === name)!;

/**
 * Replays a witness against the net's own arithmetic, independent of how it was recorded: every step
 * `t` is a start enabled in `M[i]` (inputs, reads, inhibitors) with `M[i+1] = M[i] - pre(t) + inflight:t`
 * (resets drained); every `complete:t` takes `inflight:t` and adds exactly one branch of `t`'s `Out`
 * spec, one token per place (`enumerateBranches`, as the analyses model it). Returns the branches taken.
 */
function replay(net: PetriNet, w: ClaimResult, target: Transition): string[][] {
  const byName = new Map([...net.transitions].map((t) => [t.name, t]));
  const counts = (m: MarkingState): Map<string, number> => new Map(m.placesWithTokens().map((p) => [p.name, m.tokens(p)]));
  const get = (m: Map<string, number>, name: string): number => m.get(name) ?? 0;
  const enabled = (t: Transition, m: Map<string, number>): boolean =>
    t.inputSpecs.every((i) => get(m, i.place.name) >= (i.type === 'exactly' ? i.count : i.type === 'at-least' ? i.minimum : 1)) &&
    t.reads.every((r) => get(m, r.place.name) > 0) &&
    t.inhibitors.every((h) => get(m, h.place.name) === 0);
  const steps = w.counterexampleTransitions;
  const trace = w.counterexampleTrace;
  expect(trace).toHaveLength(steps.length + 1);
  const taken: string[][] = [];
  steps.forEach((step, i) => {
    const m = counts(trace[i]!);
    const next = counts(trace[i + 1]!);
    const expected = new Map(m);
    const add = (name: string, by: number): void => {
      const n = get(expected, name) + by;
      expect(n, `${step}: ${name}`).toBeGreaterThanOrEqual(0);
      if (n === 0) expected.delete(name);
      else expected.set(name, n);
    };
    if (step.startsWith('complete:')) {
      const t = byName.get(step.slice('complete:'.length))!;
      expect(t, step).toBeDefined();
      add(`inflight:${t.name}`, -1);
      // What the completion added, on the net's places: exactly one branch, one token per place.
      const diff = [...new Set([...m.keys(), ...next.keys()])].filter((p) => !p.startsWith('inflight:')).filter((p) => get(next, p) !== get(m, p));
      for (const p of diff) expect(get(next, p) - get(m, p), `${step}: ${p}`).toBe(1);
      const branch = diff.sort();
      const branches = enumerateBranches(t.outputSpec!).map((b) => [...b].map((p) => p.name).sort());
      expect(branches.map((b) => JSON.stringify(b)), `${step} took ${JSON.stringify(branch)}`).toContain(JSON.stringify(branch));
      for (const p of branch) add(p, 1);
      taken.push(branch);
    } else {
      const t = byName.get(step)!;
      expect(t, step).toBeDefined();
      expect(enabled(t, m), `${step} enabled at step ${i}`).toBe(true);
      for (const input of t.inputSpecs) add(input.place.name, -(input.type === 'one' ? 1 : input.type === 'exactly' ? input.count : get(m, input.place.name)));
      for (const r of t.resets) add(r.place.name, -get(expected, r.place.name));
      add(`inflight:${t.name}`, 1);
    }
    expect(Object.fromEntries([...next].sort()), `step ${i}: ${step}`).toEqual(Object.fromEntries([...expected].sort()));
  });
  expect(enabled(target, counts(trace.at(-1)!)), `${target.name} enabled in the last marking`).toBe(true);
  return taken;
}

describe('execution witnesses', () => {
  it('reach every attempt of an untimed workflow — retries by failing the attempts before them — on the execution route', async () => {
    for (const concurrency of [undefined, 1]) {
      const compiled = compile(
        wf(step('a', { retries: 2 }), { kind: 'parallel', id: 'fan', arms: [step('x', { retries: 1 }), step('y'), step('z')] }, step('b')),
        concurrency === undefined ? {} : { concurrency },
      );
      expect(executionWitnessesApply(compiled.net)).toBe(true);
      const initial = segmentInitialMarking(compiled, 'closed');
      const targets = livenessTargets(compiled);
      const witnesses = await executionWitnesses(compiled, initial, targets);
      expect([...witnesses.keys()].sort()).toEqual(targets.map((t) => t.transition).sort());
      for (const target of targets) {
        const w = witnesses.get(target.transition)!;
        expect(w.route).toBe('execution');
        expect(w.verdict.type).toBe('violated');
        expect(w.counterexampleConfirmed).toBe(true);
        expect(w.counterexampleTiming).toBe('untimed-net');
        // One marking before each start, the last the one the target starts in: every input marked.
        expect(w.counterexampleTrace).toHaveLength(w.counterexampleTransitions.length + 1);
        const last = w.counterexampleTrace.at(-1)!;
        for (const p of target.inputs) expect(last.tokens(p), `${target.transition}: ${p.name}`).toBeGreaterThan(0);
        // The first marking is the segment's.
        for (const [p, n] of initial) expect(w.counterexampleTrace[0]!.tokens(p)).toBe(n);
      }
      // Attempt 2 of `a` is reached only through the two failures before it.
      const third = witnesses.get('t.0.a.run-2')!.counterexampleTransitions;
      expect(third.filter((t) => t.startsWith('t.0.a.run'))).toEqual(['t.0.a.run', 't.0.a.run-1']);
      // The first step is live in the initial marking itself: no firings, trace [M0].
      expect(witnesses.get('t.0.a.run')!.counterexampleTransitions).toEqual([]);
    }
  });

  it('are deterministic: the same net and marking give the same witnesses', async () => {
    const compiled = compile(wf(step('a', { retries: 1 }), { kind: 'parallel', id: 'fan', arms: [step('x', { retries: 1 }), step('y')] }));
    const initial = segmentInitialMarking(compiled, 'closed');
    const runs = await Promise.all([0, 1].map(() => executionWitnesses(compiled, initial, livenessTargets(compiled))));
    const shape = (m: ReadonlyMap<string, { readonly counterexampleTransitions: readonly string[] }>) =>
      [...m].map(([k, v]) => [k, v.counterexampleTransitions]).sort();
    expect(shape(runs[0]!)).toEqual(shape(runs[1]!));
  });

  it('never settle a dead attempt: the mutant with no retry branch is left to the verifier, which proves it dead', async () => {
    const compiled = compile(wf(step('a', { retries: 1 }), step('b')));
    const first = transitionNamed(compiled, 't.0.a.run');
    const mutant = rewired(compiled, { 't.0.a.run': withOutputs(first, dropBranchInto(first.outputSpec!, 's.0.a.retry-1')) });
    const witnesses = await executionWitnesses(mutant, segmentInitialMarking(mutant, 'closed'), livenessTargets(mutant));
    expect(witnesses.has('t.0.a.run-1')).toBe(false);
    expect(witnesses.has('t.0.a.run')).toBe(true);
    const report = await verify(mutant, { families: ['liveness'], structure: 'skip' });
    const dead = report.claims.find((c) => c.property === 'live(t.0.a.run-1)')!;
    expect(dead.holds, describeClaim(dead)).toBe(false);
    expect(dead.result.route).not.toBe('execution');
    expect(dead.result.verdict.type, describeClaim(dead)).toBe('proven');
  });

  it('do not apply to a timed net: a retry delay sends every liveness claim to the verifier', async () => {
    const compiled = compile(wf(step('a', { retries: 1, retryDelayMs: 50 }), step('b')));
    expect(executionWitnessesApply(compiled.net)).toBe(false);
    expect((await executionWitnesses(compiled, segmentInitialMarking(compiled, 'closed'), livenessTargets(compiled))).size).toBe(0);
    const report = await verify(compiled, { families: ['liveness'] });
    for (const c of report.claims) {
      expect(c.result.route, describeClaim(c)).not.toBe('execution');
      expect(c.holds, describeClaim(c)).toBe(true);
    }
  });

  it('settle only liveness in verify: every proof keeps a verifier or structural route', async () => {
    const compiled = compile(wf(step('a', { retries: 1 }), step('b')));
    const report = await verify(compiled, { resume: 'none', restart: 'none' });
    expect(report.holds).toBe(true);
    for (const c of report.claims) {
      if (c.family === 'liveness') expect(c.result.route, describeClaim(c)).toBe('execution');
      else expect(c.result.route, describeClaim(c)).not.toBe('execution');
    }
  });
  it('are firing sequences: every step replays against pre/post, every completion deposits one branch', async () => {
    for (const concurrency of [undefined, 1]) {
      const compiled = compile(
        wf(step('a', { retries: 2 }), { kind: 'parallel', id: 'fan', arms: [step('x', { retries: 1 }), step('y'), step('z')] }, step('b')),
        concurrency === undefined ? {} : { concurrency },
      );
      const witnesses = await executionWitnesses(compiled, segmentInitialMarking(compiled, 'closed'), livenessTargets(compiled));
      for (const [name, w] of witnesses) replay(compiled.net, w, transitionNamed(compiled, name));
      // Attempt 2 of `a`: its two predecessors completed into their retry branches, and that is recorded.
      const third = witnesses.get('t.0.a.run-2')!;
      const branches = replay(compiled.net, third, transitionNamed(compiled, 't.0.a.run-2'));
      expect(third.counterexampleTransitions).toContain('complete:t.0.a.run');
      expect(branches.some((b) => b.includes('s.0.a.retry-1'))).toBe(true);
    }
  });

  it('say what they are: an executor run of starts and completions, timed per run in whole ms', async () => {
    const compiled = compile(wf(step('a', { retries: 1 }), step('b')));
    const report = await verify(compiled, { families: ['liveness'], structure: 'skip' });
    for (const c of report.claims) {
      expect(c.result.route).toBe('execution');
      expect(describeClaim(c)).toContain('witnessed by an executor run');
      expect(c.result.report).toContain('complete:<t>');
      expect(Number.isInteger(c.result.elapsedMs), describeClaim(c)).toBe(true);
    }
  });

  it('admit a step timeout: it is an xor branch of an untimed net, and its funnels are witnessed', async () => {
    const compiled = compile(wf(step('a', { retries: 1, timeoutMs: 100 }), step('b')));
    expect(executionWitnessesApply(compiled.net)).toBe(true);
    const targets = livenessTargets(compiled);
    expect(targets.some((t) => t.kind === 'timeout')).toBe(true);
    const witnesses = await executionWitnesses(compiled, segmentInitialMarking(compiled, 'closed'), targets);
    expect([...witnesses.keys()].sort()).toEqual(targets.map((t) => t.transition).sort());
    for (const [name, w] of witnesses) replay(compiled.net, w, transitionNamed(compiled, name));
  });
});

describe('one token per place', () => {
  it('stubOutputs writes every place of one branch once, matching a branch the analyses enumerate', () => {
    const compiled = compile(wf(step('a', { retries: 2, timeoutMs: 50 }), { kind: 'parallel', id: 'fan', arms: [step('x', { retries: 1 }), step('y')] }, step('b')), { concurrency: 1 });
    for (const t of compiled.net.transitions) {
      if (t.outputSpec === null) continue;
      const branches = enumerateBranches(t.outputSpec).map((b) => JSON.stringify([...b].map((p) => p.name).sort()));
      for (const policy of [() => 0, (_: string, c: readonly Out[]) => c.length - 1]) {
        const names = stubOutputs(t.name, t.outputSpec, policy).map((p) => p.name);
        expect(new Set(names).size, t.name).toBe(names.length);
        expect(branches, t.name).toContain(JSON.stringify([...names].sort()));
      }
    }
  });

  it('a branch naming a place twice is refused: by the stub, and before that by libpetri\'s builder', async () => {
    const twice = and(outPlace(place<null>('s.0.a.out')), outPlace(place<null>('s.0.a.out')));
    expect(() => stubOutputs('t', twice, () => 0)).toThrow(/twice/);
    // Nested under an xor too: the policy picks the branch, the stub still refuses.
    const nested = xor(outPlace(place<null>('p')), and(outPlace(place<null>('q')), xor(outPlace(place<null>('q')), outPlace(place<null>('r')))));
    const picks = [1, 0]; // the outer xor takes the and, the inner one 'q' again
    expect(() => stubOutputs('t', nested, () => picks.shift() ?? 0)).toThrow(/'q' twice/);
    // The precondition the stub relies on in the first place ([IO-015], libpetri 8.0.0): no such
    // transition can be built, so no compiled net carries one.
    const compiled = compile(wf(step('a'), step('b')));
    const first = transitionNamed(compiled, 't.0.a.run');
    const [somePlace] = [...first.outputPlaces()];
    expect(() => withOutputs(first, and(outPlace(somePlace!), outPlace(somePlace!)))).toThrow(/twice/);
  });
});

describe('assertSameNet', () => {
  const a = place<null>('a');
  const b = place<null>('b');
  const out = outPlace(b);
  const net = (opts: { count?: number; input?: Place<null>; priority?: number; spec?: Out; extra?: boolean; places?: Place<null>[] } = {}) => {
    const t = Transition.builder('t').inputs(exactly(opts.count ?? 2, opts.input ?? a)).outputs(opts.spec ?? out).priority(opts.priority ?? 0).action(async () => {}).build();
    const more = opts.extra ? [Transition.builder('u').inputs(one(b)).outputs(outPlace(a)).action(async () => {}).build()] : [];
    return PetriNet.builder('n').places(...(opts.places ?? [a, b])).transitions(t, ...more).build();
  };

  it('accepts a rebinding of actions alone', () => {
    const original = net();
    expect(() => assertSameNet(original, original.bindActionsWithResolver(() => async () => {}))).not.toThrow();
  });

  it('refuses a rebinding that changes counts, place identity, priority, the Out spec or the transitions', () => {
    const original = net();
    const stranger = place<null>('a'); // same name, another object
    for (const [what, changed] of [
      ['exactly(3) for exactly(2)', net({ count: 3 })],
      ['a same-named place built elsewhere', net({ input: stranger, places: [stranger, b] })],
      ['priority', net({ priority: 5 })],
      ['another Out spec object, same places', net({ spec: outPlace(b) })],
      ['an extra transition', net({ extra: true })],
    ] as const) {
      expect(() => assertSameNet(original, changed), what).toThrow(/changed the net/);
    }
  });
});

describe("a deciding arm's preempted branch is never taken (ADR 0014)", () => {
  const race = (n: number, k: number, extra: Partial<StepDescription> = {}): CompiledWorkflow =>
    compile(wf({ kind: 'parallel', id: 'q', arms: ['a', 'b', 'c', 'd'].slice(0, n).map((id) => step(id, extra)), decision: { k } }, step('next')));

  // Breaks if: `avoidingPreemption` offers the policy a child writing an avoided place, or maps its
  // answer back to the wrong index.
  it('avoidingPreemption offers only the children writing no avoided place, and maps the answer back', () => {
    const [x, y, z] = [place<unknown>('x'), place<unknown>('y'), place<unknown>('z.preempted')];
    const children: Out[] = [outPlace(x), and(outPlace(z), outPlace(y)), outPlace(y)];
    const offered: number[] = [];
    const last = avoidingPreemption(new Set(['z.preempted']), (_, c) => {
      offered.push(c.length);
      return c.length - 1;
    });
    expect(last('t', children)).toBe(2);
    expect(avoidingPreemption(new Set(['z.preempted']), () => 0)('t', children)).toBe(0);
    expect(avoidingPreemption(new Set(['z.preempted']), () => 1)('t', children)).toBe(2);
    expect(offered).toEqual([2]);
    // Nothing avoided: the policy itself.
    const own = (): number => 1;
    expect(avoidingPreemption(new Set(), own)).toBe(own);
  });

  // Breaks if: the witness runs take an arm's `preempted` branch (the 'last' policy did: it is the
  // last child of every arm attempt), so `short` is witnessed by preempting arms before any decision —
  // a run no host can make. Pin: short's witness contains no collect-preempted firing, and every
  // completion of an arm attempt deposits an ordinary outcome.
  it.each([[3, 1], [3, 2], [3, 3], [2, 1]] as const)('n = %i, k = %i: met and short are witnessed by genuine outcomes', async (n, k) => {
    const compiled = race(n, k);
    const d = compiled.decisions[0]!;
    const targets = livenessTargets(compiled);
    const witnesses = await executionWitnesses(compiled, segmentInitialMarking(compiled, 'closed'), targets);
    expect([...witnesses.keys()].sort()).toEqual(targets.map((t) => t.transition).sort());
    const preempted = new Set(d.preempted);
    for (const target of [d.met, d.shortTransition]) {
      const w = witnesses.get(target)!;
      expect(w.route, target).toBe('execution');
      const steps = w.counterexampleTransitions;
      for (const c of d.collectPreempted) expect(steps.some((s) => s === c || s === `complete:${c}`), `${target} fires ${c}`).toBe(false);
      for (const m of w.counterexampleTrace) for (const p of m.placesWithTokens()) expect(preempted.has(p.name), `${target}: ${p.name} marked`).toBe(false);
      const taken = replay(compiled.net, w, transitionNamed(compiled, target));
      for (const branch of taken) for (const p of branch) expect(preempted.has(p), `${target} took ${p}`).toBe(false);
      expect(String(w.report)).toContain('no preempted branch taken');
    }
    // short is reached by n − k + 1 genuine misses, collected by the ordinary miss collects.
    const short = witnesses.get(d.shortTransition)!.counterexampleTransitions;
    const misses = short.filter((s) => d.collectMiss.includes(s));
    expect(misses.length).toBeGreaterThanOrEqual(n - k + 1);
  });
});

describe('execution witnesses of a decision: no pause on a plain-step race', () => {
  // Breaks if: the witness policies may take an attempt's `paused` branch when a failed, bailed or
  // suspended one exists ('last' did: `paused` is the last ordinary child of every attempt), so
  // `short` is witnessed by pauses — which only a nested-workflow step can produce, never a plain one.
  it.each([[3, 1], [3, 2], [2, 1]] as const)('n = %i, k = %i: short is witnessed with no collect-pause', async (n, k) => {
    const compiled = compile({
      id: 'witness',
      entries: [{ kind: 'parallel', id: 'q', arms: ['a', 'b', 'c'].slice(0, n).map((id) => ({ kind: 'step', id }) as StepDescription), decision: { k } }, { kind: 'step', id: 'next' }],
    });
    const d = compiled.decisions[0]!;
    const pause = d.collectMiss.find((t) => t.endsWith('collect-pause'));
    expect(pause).toBeDefined();
    const targets = livenessTargets(compiled);
    const witnesses = await executionWitnesses(compiled, segmentInitialMarking(compiled, 'closed'), targets);
    for (const target of [d.met, d.shortTransition]) {
      const w = witnesses.get(target)!;
      expect(w.route, target).toBe('execution');
      const steps = w.counterexampleTransitions;
      expect(steps.some((s) => s === pause || s === `complete:${pause}`), `${target} fires ${pause}`).toBe(false);
    }
    const short = witnesses.get(d.shortTransition)!.counterexampleTransitions;
    expect(short.filter((s) => d.collectMiss.includes(s)).length).toBeGreaterThanOrEqual(n - k + 1);
  });
});

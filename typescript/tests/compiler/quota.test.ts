import { describe, expect, it } from 'vitest';
import { Transition, andPlaces, one, outPlace, place, type In, type Place } from 'libpetri';
import { SmtVerifier, deadlockFree, placeBound, quiescentCount, terminatesAtSink, type SmtProperty } from 'libpetri/verification';
import { compile, type Gadget } from '../../src/compiler/index.js';
import { runWorkflow } from '../../src/engine/index.js';
import { poolStructureViolations } from '../../src/verify/pools.js';
import { initialCounts } from '../../src/engine/kernel.js';
import type {
  CompiledWorkflow,
  EntryDescription,
  FlowToken,
  Pool,
  QuotaRef,
  StepDescription,
  WorkflowDescription,
} from '../../src/compiler/types.js';
import { ManualClock } from '../support/manual-clock.js';
import { RecordingRunner } from '../fixtures/runner.js';

/**
 * Quota places ([ADR 0012]): the compiler's half — `GadgetContext.quotaMember`, the canonical
 * `wf.quota.<id>` places, one fusion set per (quota, role), the one refill per rate quota, the
 * `limit` / `bucket` pools and the structural hash.
 *
 * **What draws on a quota here.** Until the leaf emits quota arcs (M7 W1 B), the step gadget is
 * replaced by {@link quotaStep}, a one-attempt stand-in with exactly the arcs ADR 0012 gives the
 * leaf: `request: in -> ready + demand` for a rate quota, and an attempt that takes `in` (or `ready`
 * + `demand` + bucket) plus every limit pool and returns every pool / deposits `spent` on its one
 * branch. The tests under "the leaf" run only once the real leaf registers quotas on its chain.
 *
 * **Proofs** use the closed segment only (`initialCounts` from the entry place: one token there, every
 * pool at its seed), environment closed, sinks the six terminals plus `wf.cancel` and every pool
 * place (and a bucket's `spent`, where its tokens rest by design). The route is whatever the
 * verifier reports; each query has the 30 s budget, and a query over it is a redesign.
 */

const step = (id: string, quotas?: readonly QuotaRef[], extra: Partial<Omit<StepDescription, 'kind' | 'id' | 'quotas'>> = {}): StepDescription =>
  ({ kind: 'step', id, ...(quotas ? { quotas } : {}), ...extra });
const limit = (id: string, n: number): QuotaRef => ({ id, kind: 'limit', n });
const rate = (id: string, burst: number, perMs: number): QuotaRef => ({ id, kind: 'rate', burst, perMs });
const wf = (...entries: EntryDescription[]): WorkflowDescription => ({ id: 'w', entries });

/** In-flight accounting for the stand-in's actions. */
class Probe {
  inFlight = 0;
  peak = 0;
  readonly starts: { readonly id: string; readonly at: number }[] = [];
  constructor(readonly now: () => number = () => 0) {}
}

/**
 * The stand-in step: one attempt, success only, with ADR 0012's quota arcs. Every member place is
 * asked of `ctx.quotaMember` and written to **by its own name** in the action, so a run also checks
 * the place alias fusion leaves on the rebuilt transition ([MOD-031]).
 */
const quotaStep = (probe: Probe, holdMs = 5): Gadget => (entry, next, ctx) => {
  const s = entry as StepDescription;
  const refs = s.quotas ?? [];
  const inPlace = place<FlowToken>(ctx.names.entryIn(ctx.path, s.id));
  const transitions: Transition[] = [];
  let from: Place<FlowToken> = inPlace;
  const takes: In[] = [];
  const returns: Place<null>[] = [];
  for (const ref of refs) {
    const pool = ctx.quotaMember(ref, 'pool');
    if (ctx.quotaMember(ref, 'pool') !== pool) throw new Error('one emission must get one member per (quota, role)');
    takes.push(one(pool));
    if (ref.kind === 'limit') {
      returns.push(pool);
      continue;
    }
    const demand = ctx.quotaMember(ref, 'demand');
    const spent = ctx.quotaMember(ref, 'spent');
    const ready = place<FlowToken>(ctx.names.entryPlace(ctx.path, s.id, `ready-${ref.id}`));
    const before = from;
    const request = Transition.builder(ctx.names.entryTransition(ctx.path, s.id, `request-${ref.id}`))
      .inputs(one(before))
      .outputs(andPlaces(ready, demand))
      .action(async (tctx) => {
        tctx.output(ready, tctx.input(before));
        tctx.output(demand, null);
      });
    if (ctx.cancel) request.inhibitor(ctx.cancel);
    transitions.push(request.build());
    takes.push(one(demand));
    returns.push(spent);
    from = ready;
  }
  const input = from;
  const run = Transition.builder(ctx.names.entryRun(ctx.path, s.id))
    .inputs(one(input), ...takes)
    .outputs(returns.length === 0 ? outPlace(next) : andPlaces(next, ...returns))
    .action(async (tctx) => {
      const token = tctx.input(input);
      // Only quota users count towards the peak.
      const counted = refs.length > 0;
      if (counted) probe.inFlight++;
      probe.peak = Math.max(probe.peak, probe.inFlight);
      probe.starts.push({ id: s.id, at: probe.now() });
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      if (counted) probe.inFlight--;
      tctx.output(next, { data: token.data });
      for (const p of returns) tctx.output(p, null);
    });
  if (ctx.cancel) run.inhibitor(ctx.cancel);
  const built = run.build();
  transitions.push(built);
  ctx.stepAttempt(built.name);
  ctx.stepChain({
    stepId: s.id,
    path: ctx.path,
    retries: 0,
    inPlace: inPlace.name,
    attempts: [built.name],
    hops: [],
    timeouts: [],
    timedOut: [],
    quotas: refs.map((r) => r.id),
  });
  return { inPlace, transitions };
};

const build = (description: WorkflowDescription, probe = new Probe(), holdMs?: number): CompiledWorkflow =>
  compile(description, { gadgets: { step: quotaStep(probe, holdMs) } });

const placeNames = (c: CompiledWorkflow): string[] => [...c.net.places].map((p) => p.name).sort();
const transitionNames = (c: CompiledWorkflow): string[] => [...c.net.transitions].map((t) => t.name);
const transition = (c: CompiledWorkflow, name: string) => {
  const t = [...c.net.transitions].find((x) => x.name === name);
  if (t === undefined) throw new Error(`no transition '${name}'`);
  return t;
};
const arcPlaces = (c: CompiledWorkflow): string[] =>
  [...c.net.transitions].flatMap((t) => [
    ...t.inputSpecs.map((i) => i.place.name),
    ...t.reads.map((r) => r.place.name),
    ...t.inhibitors.map((r) => r.place.name),
    ...t.resets.map((r) => r.place.name),
    ...[...t.outputPlaces()].map((p) => p.name),
  ]);
const isMember = (name: string): boolean => /^s\..*\.quota\./.test(name);

// ---------------------------------------------------------------------------------------------

describe('structural hash', () => {
  // Golden values computed from the W0 commit (e1951bd) before any quota code existed: an
  // unannotated description must hash byte for byte as it did.
  const blocks = wf(
    { kind: 'parallel', id: 'p', arms: [step('x'), step('y')] },
    { kind: 'branch', id: 'b', arms: [step('u'), step('v')] },
    { kind: 'loop', id: 'l', loopType: 'dowhile', iterationBound: 3, body: step('body') },
    { kind: 'foreach', id: 'f', concurrency: 2, body: step('item') },
    { kind: 'sleep', id: 's', duration: { fixed: 100 } },
  );
  const linear = wf(step('a'), step('b', undefined, { retries: 2, retryDelayMs: 50 }));

  it('keeps an unannotated description at its pre-M7 hash', () => {
    expect(compile(linear).structuralHash).toBe('b9eb7b4ec8ac43f6');
    expect(compile(linear, { concurrency: 2 }).structuralHash).toBe('f078f53125ff1553');
    expect(compile(blocks).structuralHash).toBe('25bb1261e57b2ba6');
    expect(compile(blocks, { concurrency: 2 }).structuralHash).toBe('70f141a96c0132ba');
    expect(compile({ ...wf(step('a'), step('b'), step('c')), checkpoints: [0, 1] }).structuralHash).toBe('a5d17a43ffd6b1e5');
  });

  it('hashes an empty quota list as no quotas', () => {
    expect(build(wf(step('a', []), step('b'))).structuralHash).toBe(build(wf(step('a'), step('b'))).structuralHash);
  });

  it('separates two quota sizes of one shape, which the names alone do not', () => {
    const a = build(wf(step('a', [limit('db', 2)]))).structuralHash;
    const b = build(wf(step('a', [limit('db', 3)]))).structuralHash;
    const c = build(wf(step('a', [rate('api', 3, 1000)]))).structuralHash;
    const d = build(wf(step('a', [rate('api', 3, 2000)]))).structuralHash;
    expect(new Set([a, b, c, d]).size).toBe(4);
    expect(a).not.toBe(build(wf(step('a'))).structuralHash);
  });

  it('separates two timeouts and a binding block limit, and ignores one that cannot bind', () => {
    const plain = compile(wf(step('a'))).structuralHash;
    expect(compile(wf(step('a', undefined, { timeoutMs: 100 }))).structuralHash).not.toBe(plain);
    expect(compile(wf(step('a', undefined, { timeoutMs: 100 }))).structuralHash)
      .not.toBe(compile(wf(step('a', undefined, { timeoutMs: 200 }))).structuralHash);
    // The block shape is hashed directly, so this holds whatever the parallel gadget emits.
    const fan = (concurrency?: number): EntryDescription => ({
      kind: 'parallel', id: 'p', arms: [step('x'), step('y'), step('z')], ...(concurrency !== undefined ? { concurrency } : {}),
    });
    const free = compile(wf(fan()), { gadgets: { parallel: stubBlock } }).structuralHash;
    expect(compile(wf(fan(3)), { gadgets: { parallel: stubBlock } }).structuralHash).toBe(free);
    expect(compile(wf(fan(9)), { gadgets: { parallel: stubBlock } }).structuralHash).toBe(free);
    expect(compile(wf(fan(2)), { gadgets: { parallel: stubBlock } }).structuralHash).not.toBe(free);
  });
});

/** A block that ignores its arms and its limit, so only the description differs between hashes. */
const stubBlock: Gadget = (entry, next, ctx) => {
  const inPlace = place<FlowToken>(ctx.names.entryIn(ctx.path, entry.id));
  return {
    inPlace,
    transitions: [
      Transition.builder(ctx.names.entryRun(ctx.path, entry.id))
        .inputs(one(inPlace))
        .outputs(outPlace(next))
        .action(async (tctx) => {
          tctx.output(next, tctx.input(inPlace));
        })
        .build(),
    ],
  };
};

describe('a rate quota used by three steps', () => {
  // Two top-level steps and a parallel arm: three emissions, three paths.
  const description = wf(
    step('a', [rate('api', 3, 1000)]),
    { kind: 'parallel', id: 'p', arms: [step('b', [rate('api', 3, 1000)]), step('c')] },
    step('d', [rate('api', 3, 1000)]),
  );
  const compiled = build(description);

  it('passes the pool check (W1 E) on the arcs', () => {
    expect(poolStructureViolations(compiled)).toEqual([]);
  });

  it('compiles to exactly one bucket, one spent, one demand and one refill', () => {
    expect(placeNames(compiled).filter((n) => n.includes('quota'))).toEqual(['wf.quota.api', 'wf.quota.api.demand', 'wf.quota.api.spent']);
    expect(transitionNames(compiled).filter((n) => n.includes('refill'))).toEqual(['t.quota.api.refill']);
  });

  it('gives the refill one(spent), read(demand), delayed(per) -> bucket, with a real Out spec', () => {
    const refill = transition(compiled, 't.quota.api.refill');
    expect(refill.inputSpecs.map((i) => [i.type, i.place.name])).toEqual([['one', 'wf.quota.api.spent']]);
    expect(refill.reads.map((r) => r.place.name)).toEqual(['wf.quota.api.demand']);
    expect(refill.inhibitors).toEqual([]);
    expect(refill.resets).toEqual([]);
    expect(refill.timing).toEqual({ type: 'delayed', afterMs: 1000 });
    expect(refill.outputSpec).toMatchObject({ type: 'place', place: { name: 'wf.quota.api' } });
  });

  it('fuses every member into the canonical places: no member survives, every arc names wf.quota.api*', () => {
    expect(placeNames(compiled).filter(isMember)).toEqual([]);
    expect(arcPlaces(compiled).filter(isMember)).toEqual([]);
    for (const id of ['a', 'b', 'd']) {
      const run = [...compiled.net.transitions].find((t) => t.name.endsWith(`.${id}.run`))!;
      expect(run.inputSpecs.map((i) => i.place.name)).toEqual(expect.arrayContaining(['wf.quota.api', 'wf.quota.api.demand']));
      expect([...run.outputPlaces()].map((p) => p.name)).toContain('wf.quota.api.spent');
      // The alias the action writes through ([MOD-031]): its member's name maps to the canonical place.
      const aliases = [...run.placeAlias].filter(([declared]) => isMember(declared)).map(([, actual]) => actual.name).sort();
      expect(aliases).toEqual(['wf.quota.api', 'wf.quota.api.demand', 'wf.quota.api.spent']);
    }
    // Arms are emitted under their own path, so the members were three distinct places before fusion.
    expect(compiled.steps.filter((s) => s.quotas.includes('api')).map((s) => s.path.join('-'))).toEqual(['2', '1-0', '0']);
  });

  it('registers one bucket pool: seed burst, spent at weight 1, takers the three attempts, the refill its giver', () => {
    const pools = compiled.pools.filter((p): p is Extract<Pool, { kind: 'bucket' }> => p.kind === 'bucket');
    expect(pools).toHaveLength(1);
    const pool = pools[0]!;
    expect(pool.place.name).toBe('wf.quota.api');
    expect(pool.seed).toBe(3);
    expect(pool.holders).toEqual([{ place: 'wf.quota.api.spent', weight: 1 }]);
    expect(pool.spent.name).toBe('wf.quota.api.spent');
    expect(pool.demand.name).toBe('wf.quota.api.demand');
    expect(pool.refill).toBe('t.quota.api.refill');
    expect(pool.givers).toEqual(['t.quota.api.refill']);
    expect(pool.perMs).toBe(1000);
    expect([...pool.takers].sort()).toEqual(['t.0.a.run', 't.1-0.b.run', 't.2.d.run']);
    // The canonical places are the net's own objects, so the kernel seeds what the net holds.
    const byName = new Map([...compiled.net.places].map((p) => [p.name, p] as const));
    expect(byName.get('wf.quota.api')).toBe(pool.place);
    expect(byName.get('wf.quota.api.spent')).toBe(pool.spent);
    expect(initialCounts(compiled, compiled.entryPlace).get(pool.place)).toBe(3);
  });

  it('never lets a claim name a member', () => {
    for (const name of compiled.claims.keys()) expect(isMember(name)).toBe(false);
    for (const e of compiled.exclusions) expect([e.a, e.b].filter(isMember)).toEqual([]);
  });
});

describe('quota refs', () => {
  it('refuses one id with different parameters, naming both', () => {
    expect(() => build(wf(step('a', [limit('db', 2)]), step('b', [limit('db', 3)])))).toThrow(
      /quota 'db' is limit\(2\) at entry 0 \('a'\) and limit\(3\) at entry 1 \('b'\)/,
    );
    expect(() => build(wf(step('a', [rate('api', 2, 100)]), step('b', [rate('api', 2, 200)])))).toThrow(/rateLimit\(2, 100ms\).*rateLimit\(2, 200ms\)/);
    expect(() => build(wf(step('a', [limit('q', 2)]), step('b', [rate('q', 2, 100)])))).toThrow(/limit\(2\).*rateLimit\(2, 100ms\)/);
  });

  it('refuses a ref a gadget invents that disagrees with the description', () => {
    const liar: Gadget = (entry, next, ctx) => {
      ctx.quotaMember(limit('db', 5), 'pool');
      return quotaStep(new Probe())(entry, next, ctx);
    };
    expect(() => compile(wf(step('a', [limit('db', 2)])), { gadgets: { step: liar } })).toThrow(/limit\(2\).*limit\(5\)/);
  });

  it("refuses a limit's spent or demand", () => {
    const asks: Gadget = (entry, next, ctx) => {
      ctx.quotaMember(limit('db', 1), 'spent');
      return quotaStep(new Probe())(entry, next, ctx);
    };
    expect(() => compile(wf(step('a', [limit('db', 1)])), { gadgets: { step: asks } })).toThrow(/only a rateLimit has a 'spent' place/);
  });

  it('refuses out-of-range values, a bad id and a step naming one quota twice', () => {
    expect(() => build(wf(step('a', [limit('db', 0)])))).toThrow(/whole number in \[1, 1024\]/);
    expect(() => build(wf(step('a', [limit('db', 1.5)])))).toThrow(/whole number/);
    expect(() => build(wf(step('a', [rate('api', 1, 0)])))).toThrow(/refill interval/);
    expect(() => build(wf(step('a', [limit('d.b', 1)])))).toThrow(/quota id must match/);
    expect(() => build(wf(step('a', [limit('db', 1), limit('db', 1)])))).toThrow(/uses quota 'db' twice/);
  });

  it('refuses a claim on a member, with the reason', () => {
    const claims: Gadget = (entry, next, ctx) => {
      const result = quotaStep(new Probe())(entry, next, ctx);
      const member = ctx.quotaMember((entry as StepDescription).quotas![0]!, 'pool');
      return { ...result, claims: [{ place: member.name, bound: 1, why: 'test' }] };
    };
    expect(() => compile(wf(step('a', [limit('db', 1)])), { gadgets: { step: claims } })).toThrow(/quota member that fusion removes/);
  });

  it('declares the pool even when no attempt draws on it, so a missing arc is a structural finding, not a missing pool', () => {
    // A leaf that registers the quota on its chain but compiled its attempt without the arc.
    const arcless: Gadget = (entry, next, ctx) => {
      const result = stubBlock(entry, next, ctx);
      const attempt = result.transitions[0]!.name;
      ctx.stepAttempt(attempt);
      ctx.stepChain({
        stepId: entry.id, path: ctx.path, retries: 0, inPlace: result.inPlace.name, attempts: [attempt],
        hops: [], timeouts: [], timedOut: [], quotas: ['db'],
      });
      return result;
    };
    const unused = compile(wf({ kind: 'step', id: 'a', quotas: [limit('db', 2)] }), { gadgets: { step: arcless } });
    expect(placeNames(unused)).toContain('wf.quota.db');
    expect(unused.pools.map((p) => [p.kind, p.place.name, p.seed])).toEqual([['limit', 'wf.quota.db', 2]]);
    // …and the pool check (W1 E) sees the declared taker without its arc.
    expect(poolStructureViolations(unused).length).toBeGreaterThan(0);
  });
});

describe('a limit used by two steps', () => {
  // Four arms in one parallel, two of them (and two of a second step's) on one limit of 2.
  const description = wf(
    {
      kind: 'parallel',
      id: 'p',
      arms: [step('a', [limit('db', 2)]), step('b', [limit('db', 2)]), step('c', [limit('db', 2)]), step('d')],
    },
    step('e', [limit('db', 2)]),
  );

  it('registers one limit pool whose takers and givers are its attempts', () => {
    const compiled = build(description);
    expect(placeNames(compiled).filter((n) => n.includes('quota'))).toEqual(['wf.quota.db']);
    const pool = compiled.pools.find((p) => p.kind === 'limit')!;
    expect(pool).toMatchObject({ kind: 'limit', quota: 'db', seed: 2, holders: [] });
    expect([...pool.takers].sort()).toEqual(['t.0-0.a.run', 't.0-1.b.run', 't.0-2.c.run', 't.1.e.run']);
    expect(pool.givers).toEqual(pool.takers);
    expect(poolStructureViolations(compiled)).toEqual([]);
  });

  it('runs with at most n in flight and every token back at the end (stand-in step)', async () => {
    const probe = new Probe();
    const compiled = build(description, probe, 15);
    const outcome = await runWorkflow(compiled, 'x', { runner: new RecordingRunner({}) });
    // `success` without residue: the kernel reports `wf.quota.db` unless all n tokens are back.
    expect(outcome.status).toBe('success');
    expect('residue' in outcome).toBe(false);
    expect(probe.starts.map((s) => s.id).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    // Three db users start together and hold 15 ms each: the limit, not the timing, caps them at 2.
    expect(probe.peak).toBe(2);
  });

  it('proves the pool bounded at n and full at every quiescent marking (closed segment)', async () => {
    const compiled = build(description);
    const pool = compiled.pools.find((p) => p.kind === 'limit')!;
    const results = await prove(compiled, [
      ['poolBounded', placeBound(pool.place, 2)],
      ['poolReturned', quiescentCount([pool.place], 2, 2)],
    ]);
    for (const [name, verdict] of results) expect(verdict, name).toBe('proven');
  });
});

describe('a rate quota at runtime (stand-in step, ManualClock)', () => {
  it('admits a burst at once, then one token back per interval — one refill, not one per user', async () => {
    const clock = new ManualClock();
    const probe = new Probe(() => clock.now());
    const quota = rate('api', 2, 1000);
    const compiled = build(
      wf({ kind: 'parallel', id: 'p', arms: ['a', 'b', 'c', 'd', 'e'].map((id) => step(id, [quota])) }),
      probe,
      0,
    );
    const outcome = await runWorkflow(compiled, 'x', { runner: new RecordingRunner({}), clock });
    expect(outcome.status).toBe('success');
    expect('residue' in outcome).toBe(false);
    // Burst 2 at t=0; then the single refill returns one token per 1000 ms while demand waits.
    // A refill per using step would have admitted the three later arms together at t=1000.
    expect(probe.starts.map((s) => s.at)).toEqual([0, 0, 1000, 2000, 3000]);
  });

  it('proves bucket and spent bounded at burst and no demand left at quiescence (closed segment)', async () => {
    const description = wf(
      step('a', [rate('api', 2, 1000)]),
      { kind: 'parallel', id: 'p', arms: [step('b', [rate('api', 2, 1000)]), step('c', [rate('api', 2, 1000)])] },
    );
    const compiled = build(description);
    const pool = compiled.pools.find((p): p is Extract<Pool, { kind: 'bucket' }> => p.kind === 'bucket')!;
    const results = await prove(compiled, [
      ['bucketBounded', placeBound(pool.place, 2)],
      ['spentBounded', placeBound(pool.spent, 2)],
      ['demandDrained', quiescentCount([pool.demand], 0, 0)],
    ]);
    for (const [name, verdict] of results) expect(verdict, name).toBe('proven');
  });
});

/**
 * The property set, plus `deadlockFree`, `terminatesAtSink` and `exactlyOneTerminal`, from the
 * closed segment's marking. Logs each verdict, route and time.
 */
async function prove(compiled: CompiledWorkflow, extra: readonly (readonly [string, SmtProperty])[]): Promise<[string, string][]> {
  const t = compiled.terminals;
  const terminals = [t.done, t.failed, t.bailed, t.suspended, t.paused, t.canceled] as const;
  const resting = compiled.pools.flatMap((p) => [p.place as Place<unknown>, ...(p.kind === 'bucket' ? [p.spent as Place<unknown>] : [])]);
  const initial = initialCounts(compiled, compiled.entryPlace);
  const properties: (readonly [string, SmtProperty])[] = [
    ['deadlockFree', deadlockFree()],
    ['terminatesAtSink', terminatesAtSink()],
    ['exactlyOneTerminal', quiescentCount(terminals, 1, 1)],
    ...extra,
  ];
  const out: [string, string][] = [];
  for (const [name, property] of properties) {
    const started = performance.now();
    const result = await SmtVerifier.forNet(compiled.net)
      .initialMarking((m) => {
        for (const [p, n] of initial) m.tokens(p, n);
      })
      .sinkPlaces(...terminals, compiled.cancel, ...resting)
      .semiflowInvariants(true)
      .timeout(30_000)
      .property(property)
      .verify();
    const ms = Math.round(performance.now() - started);
    console.log(`[quota ${compiled.pools.map((p) => p.kind).join('+')}] ${name}: ${result.verdict.type} ${ms}ms route=${JSON.stringify((result as { route?: unknown }).route ?? null)}`);
    out.push([name, result.verdict.type]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The real leaf (M7 W1 B). These run once the leaf registers its quotas on its chain; until then
// they are skipped, and say so.

const leafEmitsQuotas = ((): boolean => {
  try {
    return compile(wf(step('a', [limit('db', 1)]))).steps[0]!.quotas.length > 0;
  } catch {
    return false;
  }
})();

describe.runIf(leafEmitsQuotas)('the leaf', () => {
  it('fuses its members away and takes and returns a limit on every branch', () => {
    const compiled = compile(wf(step('a', [limit('db', 2)], { retries: 1 }), step('b', [limit('db', 2)])), { concurrency: 2 });
    expect(placeNames(compiled).filter(isMember)).toEqual([]);
    expect(arcPlaces(compiled).filter(isMember)).toEqual([]);
    const pool = compiled.pools.find((p) => p.kind === 'limit')!;
    expect(pool.takers.length).toBe(3);
    for (const name of pool.takers) {
      const t = transition(compiled, name);
      expect(t.inputSpecs.filter((i) => i.place.name === 'wf.quota.db').map((i) => i.type)).toEqual(['one']);
    }
  });

  it('runs a limit of 1 over two parallel arms one at a time, every token back', async () => {
    let inFlight = 0;
    let peak = 0;
    const hold = async (): Promise<{ status: 'success'; output: unknown }> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return { status: 'success', output: 1 };
    };
    const compiled = compile(wf({ kind: 'parallel', id: 'p', arms: [step('a', [limit('db', 1)]), step('b', [limit('db', 1)])] }));
    const outcome = await runWorkflow(compiled, 'x', { runner: new RecordingRunner({ a: hold, b: hold }) });
    expect(outcome.status).toBe('success');
    expect('residue' in outcome).toBe(false);
    expect(peak).toBe(1);
  });

  it('compiles a rate quota over three steps, one with a retry, to one bucket and one refill, and passes the pool check', () => {
    const compiled = compile(
      wf(
        step('a', [rate('api', 2, 1000)], { retries: 1 }),
        { kind: 'parallel', id: 'p', arms: [step('b', [rate('api', 2, 1000)]), step('c', [rate('api', 2, 1000), limit('db', 1)])] },
      ),
      { concurrency: 2 },
    );
    expect(placeNames(compiled).filter((n) => n.includes('quota'))).toEqual(['wf.quota.api', 'wf.quota.api.demand', 'wf.quota.api.spent', 'wf.quota.db']);
    expect(transitionNames(compiled).filter((n) => n.includes('refill'))).toEqual(['t.quota.api.refill']);
    expect(placeNames(compiled).filter(isMember)).toEqual([]);
    expect(arcPlaces(compiled).filter(isMember)).toEqual([]);
    const bucket = compiled.pools.find((p) => p.kind === 'bucket')!;
    expect(bucket.takers.length).toBe(4); // a's two attempts, b, c
    expect(poolStructureViolations(compiled)).toEqual([]);
  });

  it('runs a rate quota at burst then one per interval (ManualClock)', async () => {
    const clock = new ManualClock();
    const starts: number[] = [];
    const stamp = (): { status: 'success'; output: unknown } => {
      starts.push(clock.now());
      return { status: 'success', output: 1 };
    };
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const compiled = compile(wf({ kind: 'parallel', id: 'p', arms: ids.map((id) => step(id, [rate('api', 2, 1000)])) }));
    const outcome = await runWorkflow(compiled, 'x', {
      runner: new RecordingRunner(Object.fromEntries(ids.map((id) => [id, stamp]))),
      clock,
    });
    expect(outcome.status).toBe('success');
    expect('residue' in outcome).toBe(false);
    expect(starts).toEqual([0, 0, 1000, 2000, 3000]);
  });

  it('proves a rate quota over three steps, one with a retry (closed segment)', async () => {
    const compiled = compile(
      wf(step('a', [rate('api', 2, 1000)], { retries: 1 }), { kind: 'parallel', id: 'p', arms: [step('b', [rate('api', 2, 1000)]), step('c', [rate('api', 2, 1000)])] }),
    );
    const pool = compiled.pools.find((p): p is Extract<Pool, { kind: 'bucket' }> => p.kind === 'bucket')!;
    const results = await prove(compiled, [
      ['bucketBounded', placeBound(pool.place, 2)],
      ['spentBounded', placeBound(pool.spent, 2)],
      ['demandDrained', quiescentCount([pool.demand], 0, 0)],
    ]);
    for (const [name, verdict] of results) expect(verdict, name).toBe('proven');
  });

  it('proves a limit over two steps (closed segment)', async () => {
    const compiled = compile(wf(step('a', [limit('db', 1)]), step('b', [limit('db', 1)])));
    const pool = compiled.pools.find((p) => p.kind === 'limit')!;
    const results = await prove(compiled, [
      ['poolBounded', placeBound(pool.place, 1)],
      ['poolReturned', quiescentCount([pool.place], 1, 1)],
    ]);
    for (const [name, verdict] of results) expect(verdict, name).toBe('proven');
  });
});

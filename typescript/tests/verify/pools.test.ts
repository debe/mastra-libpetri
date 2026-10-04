import { describe, expect, it } from 'vitest';
import { PetriNet, Transition, and, delayed, exactly, one, outPlace, place, xor, type In, type Out, type Place } from 'libpetri';
import { compile, type Gadget } from '../../src/compiler/index.js';
import {
  boundClaims,
  describeClaim,
  livenessTargets,
  poolStructureViolations,
  retryCeilingViolations,
  segmentLabel,
  verify,
  type ClaimReport,
  type VerificationReport,
} from '../../src/verify/index.js';
import type { CompiledWorkflow, FlowToken, PlaceClaim, Pool, StepChain } from '../../src/compiler/types.js';
import type { GadgetContext } from '../../src/compiler/gadgets/types.js';

/**
 * The shared pool check ([ADR 0012]) and the claims `verify` derives from `CompiledWorkflow.pools`,
 * on small hand-built nets — one per pool kind, plus a step whose attempts race a timeout
 * ([ADR 0013]). Each net is one top-level entry, emitted by a test gadget through `compile`'s
 * `gadgets` override, so the compiler wraps it in the real cancel, settle and terminal structure and
 * collects its pools as it collects a block gadget's.
 *
 * Every query: sinks the six terminals, `wf.cancel` and every pool place (a bucket's `spent` too);
 * segments `closed`, `cancel`, `resume@0`, `resume@0+cancel`, `restart@0`, `restart@0+cancel` — the
 * last four cite the first two, whose markings they share; environment mode none (one closed net).
 * Bounds and exclusions in every segment, liveness in `closed`. `proven` is asserted by string, and
 * a witness by `violated` with a confirmed sequence. Each mutant asserts the exact structural lines.
 */

type Spec = {
  readonly in?: readonly In[];
  readonly out: Out;
  readonly inhibit?: readonly Place<unknown>[];
  readonly read?: readonly Place<unknown>[];
  readonly reset?: readonly Place<unknown>[];
  readonly delayMs?: number;
};

function T(name: string, spec: Spec): Transition {
  // Never fired: these nets are only verified. An action is bound because libpetri refuses a
  // passthrough on a transition that declares outputs (IO-015).
  const b = Transition.builder(name).inputs(...(spec.in ?? [])).outputs(spec.out).action(async () => {});
  if (spec.delayMs !== undefined) b.timing(delayed(spec.delayMs));
  for (const p of spec.inhibit ?? []) b.inhibitor(p);
  for (const p of spec.read ?? []) b.read(p);
  for (const p of spec.reset ?? []) b.reset(p);
  return b.build();
}

/** `and` of places, or the one place. */
const outs = (...places: Place<unknown>[]): Out => (places.length === 1 ? outPlace(places[0]!) : and(...places.map(outPlace)));

/** A place by name, one object per name, so a test can refer to it again. */
function placeTable(): (name: string) => Place<null> {
  const seen = new Map<string, Place<null>>();
  return (name) => {
    let p = seen.get(name);
    if (p === undefined) seen.set(name, (p = place<null>(name)));
    return p;
  };
}

interface Built {
  readonly transitions: readonly Transition[];
  readonly pools: readonly Pool[];
  readonly claims?: readonly PlaceClaim[];
  readonly chains: readonly StepChain[];
}

/**
 * One top-level entry built by `body`: its input `in` is gated on the cancel signal by whatever
 * consumes it first, and swept into the canceled exit beside it, as every top-level entry is.
 */
function hand(id: string, body: (P: (name: string) => Place<null>, next: Place<FlowToken>, ctx: GadgetContext, start: Place<FlowToken>) => Built): CompiledWorkflow {
  const gadget: Gadget = (_entry, next, ctx) => {
    const P = placeTable();
    const start = place<FlowToken>(`s.0.${id}.in`);
    const built = body(P, next, ctx, start);
    for (const chain of built.chains) {
      ctx.stepChain(chain);
      for (const a of chain.attempts) ctx.stepAttempt(a);
    }
    const sweep = T(`t.0.${id}.cancel`, { in: [one(start)], out: outPlace(ctx.exits.canceled), read: [ctx.cancel!] });
    return { inPlace: start, transitions: [...built.transitions, sweep], pools: built.pools, ...(built.claims ? { claims: built.claims } : {}) };
  };
  return compile({ id, entries: [{ kind: 'step', id }] }, { gadgets: { step: gadget } });
}

const chain = (stepId: string, path: readonly number[], inPlace: string, attempts: readonly string[], extra: Partial<StepChain> = {}): StepChain => ({
  stepId,
  path,
  retries: attempts.length - 1,
  inPlace,
  attempts,
  hops: [],
  timeouts: [],
  timedOut: [],
  quotas: [],
  ...extra,
});

// ---------------------------------------------------------------------------------------------
// The nets.
// ---------------------------------------------------------------------------------------------

/**
 * A block of two arms under `concurrency: 1` ([ADR 0011]), as the block gadget compiles it: the fork
 * puts the cursor at `q0`; `admit-j: q_j + slot -> a_j + active (+ q_{j+1})`; the arm's attempt
 * `run-j`; `collect-j: d_j + active -> arrived + slot`; the join takes both arrivals.
 */
function slotsNet(arms = 2, c = 1): CompiledWorkflow {
  return hand('blk', (P, next, ctx, start) => {
    const slots = P('wf.slots.0');
    const active = P('s.0.blk.active');
    const arrived = P('s.0.blk.arrived');
    const at = (n: string, j: number): Place<null> => P(`s.0.blk.${n}${j}`);
    const ids = Array.from({ length: arms }, (_, j) => 'abcdefgh'[j]!);
    const transitions = [
      T('t.0.blk.fork', { in: [one(start)], out: outPlace(at('q', 0)), inhibit: [ctx.cancel!] }),
      ...ids.flatMap((id, j) => [
        T(`t.0.blk.admit-${j}`, { in: [one(at('q', j)), one(slots)], out: j < arms - 1 ? outs(at('a', j), active, at('q', j + 1)) : outs(at('a', j), active) }),
        T(`t.0-${j}.${id}.run`, { in: [one(at('a', j))], out: outPlace(at('d', j)) }),
        T(`t.0.blk.collect-${j}`, { in: [one(at('d', j)), one(active)], out: outs(arrived, slots) }),
      ]),
      T('t.0.blk.join', { in: [exactly(arms, arrived)], out: outPlace(next) }),
    ];
    return {
      transitions,
      pools: [
        {
          kind: 'slots',
          place: slots,
          seed: c,
          holders: [{ place: active.name, weight: 1 }],
          takers: ids.map((_, j) => `t.0.blk.admit-${j}`),
          givers: ids.map((_, j) => `t.0.blk.collect-${j}`),
        },
      ],
      claims: [
        { place: active.name, bound: c, why: 'one per admitted arm' },
        { place: arrived.name, bound: arms, why: 'one per arm' },
      ],
      chains: ids.map((id, j) => chain(id, [0, j], at('a', j).name, [`t.0-${j}.${id}.run`])),
    };
  });
}

/**
 * Two steps sharing a `limit(1)` quota ([ADR 0012]): each attempt takes `one(quota)` and returns it
 * on both of its branches, succeeded and failed.
 */
function limitNet(): CompiledWorkflow {
  return hand('lim', (P, next, ctx, start) => {
    const quota = P('wf.quota.L');
    const run = (j: number): Transition[] => {
      const a = P(`s.0.lim.a${j}`);
      const ok = P(`s.0.lim.ok${j}`);
      const err = P(`s.0.lim.err${j}`);
      const r = P(`s.0.lim.r${j}`);
      return [
        T(`t.0.lim.run-${j}`, { in: [one(a), one(quota)], out: xor(outs(ok, quota), outs(err, quota)) }),
        T(`t.0.lim.ok-${j}`, { in: [one(ok)], out: outPlace(r) }),
        T(`t.0.lim.err-${j}`, { in: [one(err)], out: outPlace(r) }),
      ];
    };
    return {
      transitions: [
        T('t.0.lim.fork', { in: [one(start)], out: outs(P('s.0.lim.a0'), P('s.0.lim.a1')), inhibit: [ctx.cancel!] }),
        ...run(0),
        ...run(1),
        T('t.0.lim.join', { in: [one(P('s.0.lim.r0')), one(P('s.0.lim.r1'))], out: outPlace(next) }),
      ],
      pools: [{ kind: 'limit', quota: 'L', place: quota, seed: 1, holders: [], takers: ['t.0.lim.run-0', 't.0.lim.run-1'], givers: ['t.0.lim.run-0', 't.0.lim.run-1'] }],
      chains: [chain('s0', [0], 's.0.lim.a0', ['t.0.lim.run-0']), chain('s1', [0], 's.0.lim.a1', ['t.0.lim.run-1'])],
    };
  });
}

/**
 * Two steps sharing a `rateLimit(1, 10 ms)` quota ([ADR 0012]): `request-j: a_j -> ready_j + demand`,
 * the attempt `ready_j + demand + bucket -> d_j + spent`, and the one refill
 * `one(spent), read(demand), delayed(10) -> bucket`.
 */
function bucketNet(): CompiledWorkflow {
  return hand('rate', (P, next, ctx, start) => {
    const bucket = P('wf.quota.R');
    const spent = P('wf.quota.R.spent');
    const demand = P('wf.quota.R.demand');
    const lane = (j: number): Transition[] => [
      T(`t.0.rate.request-${j}`, { in: [one(P(`s.0.rate.a${j}`))], out: outs(P(`s.0.rate.ready${j}`), demand) }),
      T(`t.0.rate.run-${j}`, { in: [one(P(`s.0.rate.ready${j}`)), one(demand), one(bucket)], out: outs(P(`s.0.rate.d${j}`), spent) }),
    ];
    return {
      transitions: [
        T('t.0.rate.fork', { in: [one(start)], out: outs(P('s.0.rate.a0'), P('s.0.rate.a1')), inhibit: [ctx.cancel!] }),
        ...lane(0),
        ...lane(1),
        T('t.quota.R.refill', { in: [one(spent)], out: outPlace(bucket), read: [demand], delayMs: 10 }),
        T('t.0.rate.join', { in: [one(P('s.0.rate.d0')), one(P('s.0.rate.d1'))], out: outPlace(next) }),
      ],
      pools: [
        {
          kind: 'bucket',
          quota: 'R',
          place: bucket,
          seed: 1,
          holders: [{ place: spent.name, weight: 1 }],
          spent,
          demand,
          refill: 't.quota.R.refill',
          perMs: 10,
          takers: ['t.0.rate.run-0', 't.0.rate.run-1'],
          givers: ['t.quota.R.refill'],
        },
      ],
      chains: [chain('s0', [0], 's.0.rate.a0', ['t.0.rate.run-0']), chain('s1', [0], 's.0.rate.a1', ['t.0.rate.run-1'])],
    };
  });
}

/**
 * A top-level step retried once, with a timeout ([ADR 0013]): each attempt's output has a
 * `timedOut_j` branch; funnel 0 forwards into the retry place the delayed hop drains, funnel 1 into
 * the failure exit.
 */
function timeoutNet(): CompiledWorkflow {
  return hand('slow', (P, next, ctx, start) => {
    const retry1 = P('s.0.slow.retry-1');
    const attempt1 = P('s.0.slow.attempt-1');
    const to0 = P('s.0.slow.timedOut-0');
    const to1 = P('s.0.slow.timedOut-1');
    return {
      transitions: [
        T('t.0.slow.run', { in: [one(start)], out: xor(outPlace(next), outPlace(retry1), outPlace(to0)), inhibit: [ctx.cancel!] }),
        T('t.0.slow.timeout-0', { in: [one(to0)], out: outPlace(retry1) }),
        T('t.0.slow.retry-1', { in: [one(retry1)], out: outPlace(attempt1), delayMs: 5 }),
        T('t.0.slow.run-1', { in: [one(attempt1)], out: xor(outPlace(next), outPlace(ctx.exits.failed), outPlace(to1)) }),
        T('t.0.slow.timeout-1', { in: [one(to1)], out: outPlace(ctx.exits.failed) }),
      ],
      pools: [],
      chains: [
        chain('slow', [0], start.name, ['t.0.slow.run', 't.0.slow.run-1'], {
          hops: ['t.0.slow.retry-1'],
          timeouts: ['t.0.slow.timeout-0', 't.0.slow.timeout-1'],
          timedOut: [to0.name, to1.name],
        }),
      ],
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Mutation helpers: replace transitions by name, keep everything else (pools included).
// ---------------------------------------------------------------------------------------------

function rewired(compiled: CompiledWorkflow, replace: Record<string, Transition | null>, add: readonly Transition[] = []): CompiledWorkflow {
  const transitions = [...compiled.net.transitions].flatMap((t) => (t.name in replace ? (replace[t.name] === null ? [] : [replace[t.name]!]) : [t]));
  const net = PetriNet.builder(compiled.net.name).places(...compiled.net.places).transitions(...transitions, ...add).build();
  return { ...compiled, net };
}

function placeOf(compiled: CompiledWorkflow, name: string): Place<null> {
  const p = [...compiled.net.places].find((x) => x.name === name);
  if (p === undefined) throw new Error(`no place '${name}'`);
  return p as Place<null>;
}

function transitionOf(compiled: CompiledWorkflow, name: string): Transition {
  const t = [...compiled.net.transitions].find((x) => x.name === name);
  if (t === undefined) throw new Error(`no transition '${name}'`);
  return t;
}

/** A copy of `t` with some of its arcs replaced. */
function remade(t: Transition, change: Partial<Spec>): Transition {
  return T(t.name, {
    in: change.in ?? t.inputSpecs,
    out: change.out ?? t.outputSpec!,
    inhibit: change.inhibit ?? t.inhibitors.map((a) => a.place),
    read: change.read ?? t.reads.map((a) => a.place),
    reset: change.reset ?? t.resets.map((a) => a.place),
    ...(change.delayMs !== undefined ? { delayMs: change.delayMs } : t.timing.type === 'delayed' ? { delayMs: t.timing.afterMs } : {}),
  });
}

// ---------------------------------------------------------------------------------------------
// Sound nets: structure clean, every claim proven.
// ---------------------------------------------------------------------------------------------

const key = (c: ClaimReport): string => `${segmentLabel(c.segment)}/${c.property}`;
const why = (report: VerificationReport): string => report.claims.filter((c) => !c.holds).map(describeClaim).join('\n');

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

/** One line per claim with its route and time, for the timing report. */
const timings = (label: string, report: VerificationReport, ms: number): string =>
  `[pools ${label}] ${report.claims.length} claims in ${ms} ms; slowest ${Math.round(Math.max(...report.claims.map((c) => c.result.elapsedMs)))} ms; routes ${[...new Set(report.claims.map((c) => c.result.route))].join(', ')}`;

describe('the pool check accepts every pool kind as compiled', () => {
  it.for([
    ['slots', () => slotsNet()],
    ['limit', limitNet],
    ['bucket', bucketNet],
    ['timeout funnels (no pool)', timeoutNet],
  ] as const)('%s', ([, build]) => {
    const compiled = build();
    expect(poolStructureViolations(compiled)).toEqual([]);
    expect(retryCeilingViolations(compiled)).toEqual([]);
  });

  it('the permits pool of a budgeted compile is clean and matches the budget', () => {
    const compiled = compile({ id: 'k', entries: [{ kind: 'step', id: 'a', retries: 1 }] }, { concurrency: 2 });
    expect(compiled.pools.map((p) => [p.kind, p.place.name, p.seed])).toEqual([['permits', 'wf.permits', 2]]);
    expect(poolStructureViolations(compiled)).toEqual([]);
  });

  it('a net with no pools has nothing to say', () => {
    const compiled = compile({ id: 'none', entries: [{ kind: 'step', id: 'a' }] });
    expect(compiled.pools).toEqual([]);
    expect(poolStructureViolations(compiled)).toEqual([]);
  });
});

describe('claims derived from the pools', () => {
  it('slots: placeBound(slots, c) and poolReturned(slots) beside the gadget\'s placeBound(active, c)', () => {
    const { claimed } = boundClaims(slotsNet());
    const bounds = Object.fromEntries(claimed.map((c) => [c.place.name, c.bound]));
    expect(bounds['wf.slots.0']).toBe(1);
    expect(bounds['s.0.blk.active']).toBe(1);
  });

  it('bucket: bucket and spent at burst, demand at its takers, and the rate listed as unclaimed', () => {
    const { claimed, unclaimed } = boundClaims(bucketNet());
    const bounds = Object.fromEntries(claimed.map((c) => [c.place.name, c.bound]));
    expect([bounds['wf.quota.R'], bounds['wf.quota.R.spent'], bounds['wf.quota.R.demand']]).toEqual([1, 1, 2]);
    expect(unclaimed).toEqual([
      {
        place: 'wf.quota.R',
        why: "the rate of quota 'R' — at most 1 per 10 ms — is a timed property the untimed verifier cannot state: tested under a ManualClock, not proven ([ADR 0012]); the bucket's bound is claimed",
      },
    ]);
  });

  it('a timeout funnel is a liveness target: each timedOut_j must be witnessed reachable', () => {
    const targets = livenessTargets(timeoutNet()).map((t) => [t.kind, t.transition, [...t.inputs].map((p) => p.name)]);
    expect(targets).toEqual([
      ['attempt', 't.0.slow.run', ['s.0.slow.in']],
      ['attempt', 't.0.slow.run-1', ['s.0.slow.attempt-1']],
      ['timeout', 't.0.slow.timeout-0', ['s.0.slow.timedOut-0']],
      ['timeout', 't.0.slow.timeout-1', ['s.0.slow.timedOut-1']],
    ]);
  });
});

describe.concurrent('every claim is proven on each sound net, in every segment', () => {
  const cases: ReadonlyArray<readonly [string, () => CompiledWorkflow, readonly string[]]> = [
    ['slots c=1 of 2 arms', () => slotsNet(2, 1), ['closed/poolReturned(wf.slots.0)', 'cancel/poolReturned(wf.slots.0)', 'closed/bound(wf.slots.0<=1)', 'restart@0+cancel/bound(wf.slots.0<=1)', 'closed/bound(s.0.blk.active<=1)']],
    ['slots c=2 of 3 arms', () => slotsNet(3, 2), ['closed/poolReturned(wf.slots.0)', 'cancel/bound(wf.slots.0<=2)', 'closed/bound(s.0.blk.active<=2)', 'closed/live(t.0-2.c.run)']],
    ['limit n=1 shared by 2 steps', limitNet, ['closed/poolReturned(wf.quota.L)', 'cancel/poolReturned(wf.quota.L)', 'resume@0/bound(wf.quota.L<=1)']],
    ['rateLimit burst=1 per 10 ms shared by 2 steps', bucketNet, ['closed/demandDrained(wf.quota.R.demand)', 'cancel/demandDrained(wf.quota.R.demand)', 'closed/bound(wf.quota.R<=1)', 'closed/bound(wf.quota.R.spent<=1)', 'closed/bound(wf.quota.R.demand<=2)']],
    ['a step retried once with a timeout', timeoutNet, ['closed/live(t.0.slow.timeout-0)', 'closed/live(t.0.slow.timeout-1)', 'closed/live(t.0.slow.run-1)']],
  ];
  it.for(cases)('%s', { timeout: 300_000 }, async ([label, build, expected], { expect }) => {
    const compiled = build();
    const started = performance.now();
    const report = await verify(compiled, { timeoutMs: 30_000 });
    const ms = Math.round(performance.now() - started);
    console.log(timings(label, report, ms));
    expect(report.claims.map(key)).toEqual(expect.arrayContaining([...expected]));
    expectHolds(report);
    if (label.startsWith('rateLimit')) {
      const bound = report.claims.find((c) => key(c) === 'closed/bound(wf.quota.R<=1)')!;
      expect(describeClaim(bound)).toContain("(bounds the burst of quota 'R'; its rate, 1 per 10 ms, is timed: tested, not proven)");
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Mutants: each refuted by the pool check (or the retry ceiling) with its exact lines, and `verify`
// refuses it by name before any query.
// ---------------------------------------------------------------------------------------------

describe('slots mutants', () => {
  const base = slotsNet();
  const slots = placeOf(base, 'wf.slots.0');
  const active = placeOf(base, 's.0.blk.active');

  it('an admit that takes no slot', async () => {
    const admit = transitionOf(base, 't.0.blk.admit-1');
    const mutant = rewired(base, { [admit.name]: remade(admit, { in: [one(placeOf(base, 's.0.blk.q1'))] }) });
    const lines = [
      "wf.slots.0: 't.0.blk.admit-1' is a declared taker and takes nothing from the pool",
      "wf.slots.0: 't.0.blk.admit-1' branch 0 (s.0.blk.a1 + s.0.blk.active) leaves 1 where it took 0: the pool and its holders are not conserved",
    ];
    expect(poolStructureViolations(mutant)).toEqual(lines);
    await expect(verify(mutant)).rejects.toThrow(`pool structure is unsound:\n  ${lines.join('\n  ')}`);
  });

  it('a release that returns no slot', () => {
    const collect = transitionOf(base, 't.0.blk.collect-0');
    const mutant = rewired(base, { [collect.name]: remade(collect, { out: outPlace(placeOf(base, 's.0.blk.arrived')) }) });
    expect(poolStructureViolations(mutant)).toEqual([
      "wf.slots.0: 't.0.blk.collect-0' branch 0 (s.0.blk.arrived) gives 0; a giver gives exactly one on every branch",
    ]);
  });

  it('a release that returns two slots (the second through a mint: libpetri refuses a place named twice in one branch)', () => {
    const collect = transitionOf(base, 't.0.blk.collect-1');
    const spare = place<null>('s.0.blk.spare');
    const mint = T('t.0.blk.mint', { in: [one(spare)], out: outPlace(slots) });
    const mutant = rewired(base, { [collect.name]: remade(collect, { out: outs(placeOf(base, 's.0.blk.arrived'), slots, spare) }) }, [mint]);
    expect(poolStructureViolations(mutant)).toEqual(["wf.slots.0: 't.0.blk.mint' gives to the pool but is not one of its givers"]);
  });

  it('a transition that reads the pool, and one that resets its holder', () => {
    const join = transitionOf(base, 't.0.blk.join');
    const fork = transitionOf(base, 't.0.blk.fork');
    const mutant = rewired(base, { [join.name]: remade(join, { read: [slots] }), [fork.name]: remade(fork, { reset: [active] }) });
    expect(poolStructureViolations(mutant)).toEqual([
      "wf.slots.0: 't.0.blk.fork' resets 's.0.blk.active'; nothing resets a pool or its holders",
      "wf.slots.0: 't.0.blk.join' reads 'wf.slots.0'; nothing reads a pool or its holders",
    ]);
  });

  it("an arm fed by the fork: the block compiled without admission for arm 1", async () => {
    const fork = transitionOf(base, 't.0.blk.fork');
    const admit0 = transitionOf(base, 't.0.blk.admit-0');
    const pool = base.pools[0]!;
    const mutant: CompiledWorkflow = {
      ...rewired(base, {
        [fork.name]: remade(fork, { out: outs(placeOf(base, 's.0.blk.q0'), placeOf(base, 's.0.blk.a1')) }),
        [admit0.name]: remade(admit0, { out: outs(placeOf(base, 's.0.blk.a0'), active) }),
        't.0.blk.admit-1': null,
      }),
      pools: [{ ...pool, takers: ['t.0.blk.admit-0'] }],
    };
    const lines = ["wf.slots.0: 't.0.blk.fork' produces into arm input 's.0.blk.a1' and is not one of the pool's takers: the arm runs without admission"];
    expect(poolStructureViolations(mutant)).toEqual(lines);
    await expect(verify(mutant)).rejects.toThrow(`pool structure is unsound:\n  ${lines.join('\n  ')}`);
  });

  it('an undeclared taker, and a pool declaring a missing giver', () => {
    const pool = base.pools[0]!;
    const mutant: CompiledWorkflow = { ...base, pools: [{ ...pool, takers: ['t.0.blk.admit-0'], givers: [...pool.givers, 't.0.blk.nope'] }] };
    expect(poolStructureViolations(mutant)).toEqual([
      "wf.slots.0: declares giver 't.0.blk.nope', which is not a transition of the net",
      "wf.slots.0: 't.0.blk.admit-1' takes from the pool but is not one of its takers",
      "wf.slots.0: 't.0.blk.admit-1' produces into arm input 's.0.blk.a1' and is not one of the pool's takers: the arm runs without admission",
    ]);
  });
});

describe('limit mutants', () => {
  const base = limitNet();
  const quota = placeOf(base, 'wf.quota.L');

  it('an attempt that keeps the quota on its failure branch', () => {
    const run = transitionOf(base, 't.0.lim.run-0');
    const mutant = rewired(base, { [run.name]: remade(run, { out: xor(outs(placeOf(base, 's.0.lim.ok0'), quota), outPlace(placeOf(base, 's.0.lim.err0'))) }) });
    expect(poolStructureViolations(mutant)).toEqual([
      "wf.quota.L: 't.0.lim.run-0' branch 1 (s.0.lim.err0) gives 0; a giver gives exactly one on every branch",
    ]);
  });

  it('an attempt that takes two at once', () => {
    const run = transitionOf(base, 't.0.lim.run-1');
    const mutant = rewired(base, { [run.name]: remade(run, { in: [one(placeOf(base, 's.0.lim.a1')), exactly(2, quota)] }) });
    expect(poolStructureViolations(mutant)).toEqual([
      "wf.quota.L: 't.0.lim.run-1' consumes the pool with exactly(2); a taker takes exactly one",
      "wf.quota.L: 't.0.lim.run-1' branch 0 (s.0.lim.ok1 + wf.quota.L) leaves 1 where it took 2: the pool and its holders are not conserved",
      "wf.quota.L: 't.0.lim.run-1' branch 1 (s.0.lim.err1 + wf.quota.L) leaves 1 where it took 2: the pool and its holders are not conserved",
    ]);
  });
});

describe('bucket mutants', () => {
  const base = bucketNet();
  const bucket = placeOf(base, 'wf.quota.R');
  const spent = placeOf(base, 'wf.quota.R.spent');
  const demand = placeOf(base, 'wf.quota.R.demand');

  it('a refill without its read of demand', async () => {
    const refill = transitionOf(base, 't.quota.R.refill');
    const mutant = rewired(base, { [refill.name]: remade(refill, { read: [] }) });
    const lines = ["wf.quota.R: the refill 't.quota.R.refill' reads []; it reads exactly 'wf.quota.R.demand'"];
    expect(poolStructureViolations(mutant)).toEqual(lines);
    await expect(verify(mutant)).rejects.toThrow(`pool structure is unsound:\n  ${lines.join('\n  ')}`);
  });

  it('a second refill', () => {
    const second = T('t.quota.R.refill-2', { in: [one(spent)], out: outPlace(bucket), read: [demand], delayMs: 10 });
    const mutant = rewired(base, {}, [second]);
    expect(poolStructureViolations(mutant)).toEqual([
      "wf.quota.R: 't.quota.R.refill-2' gives to the pool but is not one of its givers",
      "wf.quota.R: 't.quota.R.refill-2' reads the demand 'wf.quota.R.demand'; only the refill 't.quota.R.refill' may",
    ]);
  });

  it('a refill on the wrong period, and an attempt that spends nothing', () => {
    const refill = transitionOf(base, 't.quota.R.refill');
    const run = transitionOf(base, 't.0.rate.run-1');
    const mutant = rewired(base, { [refill.name]: remade(refill, { delayMs: 1 }), [run.name]: remade(run, { out: outPlace(placeOf(base, 's.0.rate.d1')) }) });
    expect(poolStructureViolations(mutant)).toEqual([
      "wf.quota.R: 't.0.rate.run-1' branch 0 (s.0.rate.d1) leaves 0 where it took 1: the pool and its holders are not conserved",
      "wf.quota.R: the refill 't.quota.R.refill' is delayed(1); it is delayed(10)",
    ]);
  });
});

describe('timeout funnel mutants (the retry ceiling)', () => {
  const base = timeoutNet();

  it('funnel 0 feeding attempt 1 directly, past the delayed hop', async () => {
    const funnel = transitionOf(base, 't.0.slow.timeout-0');
    const mutant = rewired(base, { [funnel.name]: remade(funnel, { out: outPlace(placeOf(base, 's.0.slow.attempt-1')) }) });
    const lines = [
      "step 'slow' at 0: timeout funnel 0 ('t.0.slow.timeout-0') feeds [s.0.slow.attempt-1] of the chain; it must feed exactly its retry 's.0.slow.retry-1'",
      "step 'slow' at 0: attempt input 's.0.slow.attempt-1' is produced by [t.0.slow.timeout-0, t.0.slow.retry-1]; only hop 0 may",
    ];
    expect(retryCeilingViolations(mutant)).toEqual(lines);
    await expect(verify(mutant)).rejects.toThrow(`retry ceiling structure is unsound:\n  ${lines.join('\n  ')}`);
  });

  it('the final funnel feeding back into the retry', () => {
    const funnel = transitionOf(base, 't.0.slow.timeout-1');
    const mutant = rewired(base, { [funnel.name]: remade(funnel, { out: outPlace(placeOf(base, 's.0.slow.retry-1')) }) });
    expect(retryCeilingViolations(mutant)).toEqual([
      "step 'slow' at 0: the final timeout funnel ('t.0.slow.timeout-1') feeds [s.0.slow.retry-1] of the chain: the chain does not end",
      "step 'slow' at 0: retry 's.0.slow.retry-1' is produced by [t.0.slow.run, t.0.slow.timeout-0, t.0.slow.timeout-1]; only attempt 0 or timeout funnel 0 may",
    ]);
  });

  it('a timedOut place produced by the wrong attempt', () => {
    const run1 = transitionOf(base, 't.0.slow.run-1');
    const spec = run1.outputSpec;
    if (spec === null || spec.type !== 'xor') throw new Error('expected an xor');
    const mutant = rewired(base, {
      [run1.name]: remade(run1, { out: xor(spec.children[0]!, spec.children[1]!, outPlace(placeOf(base, 's.0.slow.timedOut-0'))) }),
    });
    expect(retryCeilingViolations(mutant)).toEqual([
      "step 'slow' at 0: attempt 1 ('t.0.slow.run-1') never produces into its timedOut 's.0.slow.timedOut-1'",
      "step 'slow' at 0: attempt 1 ('t.0.slow.run-1') produces into another attempt's timedOut",
      "step 'slow' at 0: timedOut 's.0.slow.timedOut-0' is produced by [t.0.slow.run, t.0.slow.run-1]; only attempt 0 may",
      "step 'slow' at 0: timedOut 's.0.slow.timedOut-1' is produced by []; only attempt 1 may",
    ]);
  });
});

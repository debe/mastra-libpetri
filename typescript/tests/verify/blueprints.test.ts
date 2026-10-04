/**
 * **Blueprints compose** ([ADR 0002], [ADR 0012]): the acceptance test ADR 0002 names. Built through
 * `init()`'s factories — the Layer 3 surface — and run through Mastra's own `Run`.
 *
 * 1. A `rateLimit` used by three different steps compiles to exactly one `bucket`, `spent` and
 *    `demand` and one refill.
 * 2. Under a `ManualClock`, three steps × 10 calls at burst 3, per 1000 ms start at exactly a single
 *    bucket's instants — 0, 0, 0, 1000, …, 27000 — and no 1000 ms window holds more than 3 starts.
 *    The calls are each step's attempts (`retries: 9`, failing until the tenth): a provider counts
 *    calls, so every attempt spends one.
 * 3. A `limit(n)` inside a `.parallel()` bounded by `metadata.concurrency = c`, on an engine with
 *    budget `k`, peaks at exactly min(c, n, k).
 * 4. `verify()` on each composition: every claim of all four families holds — a proof's verdict is
 *    `proven`, a liveness witness `violated` with its run confirmed. The bucket's rate is listed in
 *    `unclaimed` as tested, not proven: (2) above is that test.
 *
 * Environment: `@mastra/core` from the pinned registry package, libpetri 8.0.0 (registry, not
 * linked). The runtime cases (2, 3) are tested, not proven; (2) on the tests' `ManualClock`, (3) on
 * the machine clock with every arm waiting a timer. The proofs (4) are per claim: property, segment,
 * initial marking and route are printed for every claim on failure (`describeClaim`); environment
 * mode none (one closed net); 30 s a query — a proof that does not close in that is a net to
 * redesign, never a budget to raise.
 */
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { compile } from '../../src/compiler/compile.js';
import type { CompiledWorkflow } from '../../src/compiler/types.js';
import { adaptExecutionGraph, init, type ExecutionGraph } from '../../src/mastra/index.js';
import { compileMastraWorkflow, verifyMastraWorkflow } from '../../src/mastra/verify.js';
import { describeClaim, FAMILIES, segmentLabel, segmentsFor, type Segment, type VerificationReport } from '../../src/verify/index.js';
import { ManualClock } from '../support/manual-clock.js';

const N = z.object({ n: z.number() });
const TIMEOUT_MS = 30_000;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Graph = { buildExecutionGraph(): unknown; retryConfig?: { attempts?: number; delay?: number } };
const compiledOf = (wf: Graph, k?: number): CompiledWorkflow =>
  compile(adaptExecutionGraph(wf.buildExecutionGraph() as ExecutionGraph, wf.retryConfig ? { retryConfig: wf.retryConfig } : {}), k === undefined ? {} : { concurrency: k });

/** Every claim holds, by verdict: `proven` for a proof, a confirmed witness for liveness. */
function expectHolds(report: VerificationReport, families: readonly string[] = FAMILIES): void {
  expect(report.families).toEqual([...families]);
  for (const family of families) expect(report.claims.some((c) => c.family === family), family).toBe(true);
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

/** Total and slowest query, for the report line. */
function timing(name: string, report: VerificationReport, ms: number): string {
  const slowest = [...report.claims].sort((a, b) => b.result.elapsedMs - a.result.elapsedMs)[0]!;
  const routes = new Map<string, number>();
  for (const c of report.claims) routes.set(c.result.route, (routes.get(c.result.route) ?? 0) + 1);
  return `[blueprints] ${name} k=${report.k}: ${report.claims.length} claims hold in ${ms.toFixed(0)}ms; ` +
    `routes ${[...routes].map(([r, n]) => `${r} ${n}`).join(', ')}; slowest ${slowest.result.elapsedMs}ms ${slowest.property} @${typeof slowest.segment === 'string' ? slowest.segment : JSON.stringify(slowest.segment)} via ${slowest.result.route}`;
}

/**
 * The tests' `ManualClock`, made to let in-flight work settle before it moves time.
 *
 * The executor races its in-flight actions against `clock.sleep(untilNextTimer)`; `ManualClock`
 * advances the instant it is asked, so virtual time jumps to the next refill while a step admitted
 * at the previous instant is still in Mastra's own prologue (`StepExecutor`'s awaits) — its body
 * then reads a later `now()` than the instant the net fired it at. Measured on this very workflow
 * with the plain `ManualClock`: `a 0, b 0, c 0, a 2000, b 3000, c 3000, a 5000, …` — the bucket's
 * 30 starts still end at 27000, the token count is right, the stamps are not.
 *
 * Here a finite `sleep` first yields macrotask turns while nothing is ready, so an admitted step's
 * body runs at the instant it was admitted; only when no in-flight work moves does time advance.
 * Still virtual and deterministic: nothing reads the machine clock.
 */
class SettlingClock extends ManualClock {
  override async sleep(delayMs: number, ready: () => boolean, signal: AbortSignal): Promise<void> {
    if (Number.isFinite(delayMs)) {
      for (let turn = 0; turn < 20; turn++) {
        if (signal.aborted || ready()) return;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    return super.sleep(delayMs, ready, signal);
  }
}

// ---------------------------------------------------------------------------------------------
// One rate quota, three steps
// ---------------------------------------------------------------------------------------------

const BURST = 3;
const PER_MS = 1_000;
const CALLS = 10;
/**
 * The calls per step in the proved composition (4): no retries. Ten per step is a runtime test of
 * the rate; proven, thirty attempts on one timed refill is a net no query closes in 30 s.
 */
const PROVEN_CALLS = 1;

/**
 * Three steps in one `.parallel()`, each `retries: CALLS - 1` and failing until its last attempt,
 * all on one `rateLimit(BURST, PER_MS)`. Each attempt records the run clock's instant as it starts.
 */
function rateWorkflow(clock?: ManualClock, calls = CALLS) {
  const { createWorkflow, createStep, rateLimit } = init(clock === undefined ? {} : { clock });
  const api = rateLimit(BURST, PER_MS, { id: 'api' });
  const starts: { id: string; at: number }[] = [];
  const attempts = new Map<string, number>();
  const caller = <const Id extends string>(id: Id) =>
    createStep({
      id,
      inputSchema: N,
      outputSchema: N,
      retries: calls - 1,
      uses: [api],
      execute: async ({ inputData }) => {
        starts.push({ id, at: clock?.now() ?? Number.NaN });
        const n = (attempts.get(id) ?? 0) + 1;
        attempts.set(id, n);
        if (n < calls) throw new Error(`${id} call ${n} rejected`);
        return { n: inputData.n + n };
      },
    });
  const workflow = createWorkflow({ id: 'rate-three', inputSchema: N, outputSchema: z.any() })
    .parallel([caller('a'), caller('b'), caller('c')])
    .commit();
  return { workflow, starts };
}

describe('a rateLimit used by three steps', () => {
  it('compiles to exactly one bucket, one spent, one demand and one refill', () => {
    const compiled = compiledOf(rateWorkflow().workflow);
    const places = [...compiled.net.places].map((p) => p.name).filter((n) => n.includes('quota')).sort();
    expect(places).toEqual(['wf.quota.api', 'wf.quota.api.demand', 'wf.quota.api.spent']);
    const transitions = [...compiled.net.transitions].map((t) => t.name).filter((n) => n.includes('refill'));
    expect(transitions).toEqual(['t.quota.api.refill']);
    const buckets = compiled.pools.filter((p) => p.kind === 'bucket');
    expect(buckets).toHaveLength(1);
    // Every attempt of the three steps draws on it: 3 x CALLS takers.
    expect(new Set(buckets[0]!.takers).size).toBe(3 * CALLS);
    expect(compiled.steps.filter((s) => s.quotas.includes('api')).map((s) => s.stepId).sort()).toEqual(['a', 'b', 'c']);
  });

  it(`under a ManualClock, 3 steps x ${CALLS} calls start at exactly a single bucket's instants`, async () => {
    const clock = new SettlingClock();
    const { workflow, starts } = rateWorkflow(clock);
    const result = await (await workflow.createRun()).start({ inputData: { n: 0 } });
    expect(result.status).toBe('success');
    expect(result.status === 'success' ? result.result : undefined).toEqual({ a: { n: CALLS }, b: { n: CALLS }, c: { n: CALLS } });

    // One bucket: BURST at once, then one per PER_MS — however the three steps interleave.
    const total = 3 * CALLS;
    const single = Array.from({ length: total }, (_, i) => Math.max(0, i - (BURST - 1)) * PER_MS);
    expect(starts.map((s) => s.at)).toEqual(single);
    // Each step made every call.
    for (const id of ['a', 'b', 'c']) expect(starts.filter((s) => s.id === id)).toHaveLength(CALLS);
    // At most BURST starts in any PER_MS window: the rate, tested.
    for (const s of starts) expect(starts.filter((t) => t.at >= s.at && t.at < s.at + PER_MS).length).toBeLessThanOrEqual(BURST);
    // Three refills per step would have admitted them three at a time: they are not.
    expect(clock.now()).toBe((total - BURST) * PER_MS);
  });
});

// ---------------------------------------------------------------------------------------------
// A limit inside a block-limited parallel
// ---------------------------------------------------------------------------------------------

const ARMS = 6;
/** Arms in the proved compositions (4): enough for c, n and k each to bind; six only adds interleavings. */
const PROVEN_ARMS = 4;

function limitedWorkflow(c: number, n: number, k: number | undefined, arms = ARMS) {
  const { createWorkflow, createStep, limit } = init(k === undefined ? {} : { concurrency: k });
  const db = limit(n, { id: 'db' });
  let now = 0;
  const flight = { peak: 0 };
  const arm = (i: number) =>
    createStep({
      id: `arm${i}`,
      inputSchema: N,
      outputSchema: N,
      uses: [db],
      execute: async ({ inputData }) => {
        now += 1;
        flight.peak = Math.max(flight.peak, now);
        await delay(4);
        now -= 1;
        return { n: inputData.n * i };
      },
    });
  const workflow = createWorkflow({ id: 'limit-in-block', inputSchema: N, outputSchema: z.any() })
    .parallel(Array.from({ length: arms }, (_, i) => arm(i + 1)), { metadata: { concurrency: c } })
    .commit();
  return { workflow, flight };
}

/** (c, n, k): each of the three is the binding one at least once, and k unbounded twice. */
const GRID: readonly (readonly [number, number, number | undefined])[] = [
  [2, 3, 4],
  [3, 2, 4],
  [4, 3, 2],
  [3, 4, undefined],
  [5, 2, undefined],
  [1, 6, undefined],
];

describe('a limit inside a block-limited .parallel()', () => {
  for (const [c, n, k] of GRID) {
    const expected = Math.min(c, n, k ?? Infinity);
    it(`c=${c}, n=${n}, k=${k ?? 'unbounded'}: peaks at min(c, n, k) = ${expected}`, async () => {
      const { workflow, flight } = limitedWorkflow(c, n, k);
      const result = await (await workflow.createRun()).start({ inputData: { n: 1 } });
      expect(result.status).toBe('success');
      expect(Object.keys(result.status === 'success' ? (result.result as object) : {})).toHaveLength(ARMS);
      expect(flight.peak).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// verify() on each composition
// ---------------------------------------------------------------------------------------------

/** Every blueprint at once: a limit and the rate shared, inside a block limit, one step timed out and retried. */
function everything() {
  const { createWorkflow, createStep, limit, rateLimit } = init({ concurrency: 2 });
  const db = limit(1, { id: 'db' });
  const api = rateLimit(2, 500, { id: 'api' });
  const step = (id: string, extra: Record<string, unknown>) =>
    createStep({ id, inputSchema: N, outputSchema: N, execute: async ({ inputData }: { inputData: { n: number } }) => inputData, ...extra } as never);
  return createWorkflow({ id: 'everything', inputSchema: N, outputSchema: z.any() })
    .then(step('first', { uses: [api] }))
    // The smallest net with every blueprint meeting: a third arm adds interleavings, not composition.
    .parallel([step('p1', { uses: [db, api] }), step('p2', { uses: [db], timeout: 100, retries: 1 })], {
      metadata: { concurrency: 2 },
    })
    .commit();
}

const COMPOSITIONS: readonly {
  readonly name: string;
  readonly build: () => Graph;
  readonly rate?: { id: string; burst: number; perMs: number };
  /**
   * Proven one segment per test. Same claims, same 30 s a query; a 4-core CI runner took the
   * whole workflow past the 60 s test cap on claim volume (2,256 claims, about 210 by smt, the
   * slowest 3.5 s alone), not on any one proof. The pool and rate claims are the closed segment's.
   */
  readonly bySegment?: true;
}[] = [
  { name: `rateLimit(${BURST}, ${PER_MS}) x 3 steps x ${PROVEN_CALLS} calls`, build: () => rateWorkflow(undefined, PROVEN_CALLS).workflow, rate: { id: 'api', burst: BURST, perMs: PER_MS } },
  { name: `limit(2) in .parallel(c=3) of ${PROVEN_ARMS}, k=4`, build: () => limitedWorkflow(3, 2, 4, PROVEN_ARMS).workflow },
  { name: `limit(3) in .parallel(c=2) of ${PROVEN_ARMS}, unbounded`, build: () => limitedWorkflow(2, 3, undefined, PROVEN_ARMS).workflow },
  { name: 'limit + rateLimit + timeout in .parallel(c=2), k=2', build: everything, rate: { id: 'api', burst: 2, perMs: 500 }, bySegment: true },
];

describe('verify() on each composition: every claim holds', () => {
  const cases = COMPOSITIONS.flatMap((composition) =>
    composition.bySegment
      ? segmentsFor(compileMastraWorkflow(composition.build() as never)).map((segment) => ({ composition, segment }))
      : [{ composition, segment: undefined as Segment | undefined }],
  );
  for (const { composition, segment } of cases) {
    const name = segment === undefined ? composition.name : `${composition.name} @ ${segmentLabel(segment)}`;
    it(name, { timeout: 60_000 }, async () => {
      const t0 = performance.now();
      const verification = await verifyMastraWorkflow(
        composition.build() as never,
        segment === undefined
          ? { timeoutMs: TIMEOUT_MS }
          : { timeoutMs: TIMEOUT_MS, segments: [segment], families: segment === 'closed' ? FAMILIES : FAMILIES.filter((f) => f !== 'liveness') },
      );
      const ms = performance.now() - t0;
      const report = verification.workflow;
      const line = timing(name, report, ms);
      console.log(line);
      const log = process.env['PROOF_LOG'];
      if (log) appendFileSync(log, `${line}\n`);
      expect(Object.keys(verification.nested)).toEqual([]);
      expectHolds(report, segment === undefined || segment === 'closed' ? FAMILIES : FAMILIES.filter((f) => f !== 'liveness'));
      expect(verification.holds).toBe(true);
      if (segment !== undefined && segment !== 'closed') return;

      const properties = new Set(report.claims.map((c) => c.property));
      for (const pool of compiledOf(composition.build()).pools) {
        if (pool.kind === 'permits') continue;
        expect(properties.has(`bound(${pool.place.name}<=${pool.seed})`), pool.place.name).toBe(true);
        expect(properties.has(pool.kind === 'bucket' ? `demandDrained(${pool.demand.name})` : `poolReturned(${pool.place.name})`), pool.place.name).toBe(true);
      }

      if (composition.rate === undefined) {
        expect(report.unclaimed.filter((u) => u.place.startsWith('wf.quota.'))).toEqual([]);
      } else {
        const { id, burst, perMs } = composition.rate;
        // The bucket's bound is claimed and proven; its rate is listed as tested, not proven.
        expect(properties.has(`bound(wf.quota.${id}<=${burst})`)).toBe(true);
        expect(properties.has(`bound(wf.quota.${id}.spent<=${burst})`)).toBe(true);
        const rate = report.unclaimed.filter((u) => u.place === `wf.quota.${id}`);
        expect(rate).toHaveLength(1);
        expect(rate[0]!.why).toContain(`at most ${burst} per ${perMs} ms`);
        expect(rate[0]!.why).toMatch(/tested under a ManualClock, not proven/);
      }
    });
  }
});

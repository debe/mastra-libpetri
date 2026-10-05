/**
 * **`pipeline()` composes** ([ADR 0015], amended by the W0 spike; with [ADR 0006], [ADR 0012],
 * [ADR 0013]): the W0 matrix, built through `init()`'s factories — the Layer 3 surface an author
 * writes, `.foreach(...pipeline(stages, { id: 'per-doc', concurrency })).then(report)` — and proven
 * through `verifyMastraWorkflow`, so the net proven is the one `PetriExecutionEngine.execute()`
 * compiles: the engine's own run budget, the workflow's `retryConfig` reaching every stage (maintainer
 * decision 2), a stage's `uses` and `timeout` applied at the parent's run scope.
 *
 * `tests/verify/pipeline.test.ts` proves the gadget from hand-written descriptions ((1,1), (1,1,1),
 * (2,2), and (2,1) with a `limit(1)` description) and asks the overlap there; this file proves what
 * the adapter makes of the author's workflow, and adds the shapes that description file lacks: (2,1)
 * plain and under a run budget of 1, a `limit(1)` shared by a stage **and** a parent step (one quota,
 * ADR 0015 "Composition"), a rate quota on a stage, a timed stage, and stages retrying — by their own
 * `retries` and inherited from the workflow's `retryConfig`.
 *
 * Per shape:
 *
 * - every claim of all four families holds in every default segment, by verdict — a proof `proven`,
 *   a liveness witness `violated` with its run confirmed — and the segment list is pinned (the
 *   pipeline registers no resume site; `resume@1` is the `report` step's);
 * - the pipeline's own claims are present by property name in every segment: `bound(·<=1)` on every
 *   site place, `exclusive(permit, slot)` per lane, the queue and flag exclusions. Their provenance
 *   is pinned separately, off the derivations `verify` asks (`boundClaims`, `exclusions`): each site
 *   place — enumerated here from the site's fields, `7 + 9·Σc_j` of them, not through `sitePlaces` —
 *   bound at 1 *because of the pipeline*, and the pipeline's exclusions sourced `pipeline`, exactly
 *   (the gadget declares the same pairs, so presence by name alone would not see the derivation go);
 * - `split`'s three output branches: the open queue, the closed queue at once (an empty input), the
 *   foreach's `failed` — a branch dropped only shrinks behaviour, which no safety claim notices;
 * - where a stage uses a quota, its claims in every segment: a `limit` `bound(quota<=n)` and
 *   `poolReturned`, a `rateLimit` `bound(bucket<=burst)`, `bound(spent<=burst)` and `demandDrained`,
 *   with the rate itself listed unclaimed (tested, not proven);
 * - on an immediate (untimed) net, the overlap (`pipelineOverlaps`): `mutualExclusion(stage j lane 0
 *   slot, stage j+1 lane 0 slot)` a definitive, confirmed `violated` for every adjacent pair — stage
 *   j+1 of one item runs while stage j of another does. Not asked on a timed net (the untimed
 *   abstraction; ADR 0015, "Claims").
 *
 * The minted body is a Mastra workflow in the `.foreach()`'s step position, so `verifyMastraWorkflow`
 * also verifies it as a nested workflow, `per-doc`: the minted body compiled by this engine's compiler
 * as a standalone petri workflow, under its own (absent) `retryConfig`. That is not the twin's run —
 * neither the petri engine (which runs the stages in the parent's run) nor `DefaultExecutionEngine`
 * runs that net — so its report proves nothing about either; it is pinned to hold, not counted as a
 * pipeline claim. Whether `nestedWorkflows` should skip a pipeline body is open (maintainer).
 *
 * Environment: `@mastra/core` from the pinned registry package; libpetri 8.0.0 from the registry, not
 * linked (`scripts/link-libpetri.sh --check`: "error: not linked"); z3 on PATH. Proven, per claim:
 * property, segment, initial marking and route are printed for every claim on failure
 * (`describeClaim`); environment mode none (one closed net); 30 s a query — a proof that does not
 * close in that is a net to redesign, never a budget to raise; and 30 s of `verifyMastraWorkflow` wall a
 * shape (`WALL_MS`), since the per-query cap does not bound the sum. Nothing here is run: no runtime claim
 * is made, tested or proven.
 *
 * Measured 2026-10-06, libpetri 8.0.0 from npm (not linked), this file alone; wall is
 * `verifyMastraWorkflow` (workflow + the nested body), slowest is the one slowest query:
 *
 * | Shape                                                   | Claims | Wall    | Slowest query                                   |
 * |---------------------------------------------------------|--------|---------|-------------------------------------------------|
 * | (1,1)                                                   | 1,911  | 0.17 s  | 19 ms deadlockFree @cancel, enumeration         |
 * | (1,1,1)                                                 | 2,496  | 0.37 s  | 156 ms deadlockFree @cancel, enumeration        |
 * | (2,1)                                                   | 2,496  | 0.34 s  | 156 ms deadlockFree @cancel, enumeration        |
 * | (2,2)                                                   | 3,081  | 3.4 s   | 1.86 s deadlockFree @cancel, enumeration        |
 * | (2,1), run budget 1                                     | 2,512  | 0.36 s  | 160 ms deadlockFree @cancel, enumeration        |
 * | (2,1), limit(1) on stage 1 and report                   | 2,512  | 0.35 s  | 159 ms deadlockFree @cancel, enumeration        |
 * | (1,1), stage 1 retrying 2 x 5 ms                        | 2,169  | 4.5 s   | 0.83 s live(t.1.report.run) @closed, smt        |
 * | (2,1), stage 1 retrying 2 x 5 ms, run budget 1          | 2,770  | 6.5 s   | 1.41 s live(t.1.report.run) @closed, smt        |
 * | (1,1), retryConfig 1 x 5 ms inherited by both stages    | 2,282  | 5.8 s   | 2.01 s live(t.1.report.run-1) @closed, smt      |
 * | (1,1), stage 1 timed out at 100 ms                      | 1,976  | 0.12 s  | 14 ms deadlockFree @cancel, enumeration         |
 * | (1,1), rateLimit(2, 100) on stage 0                     | 2,007  | 4.5 s   | 0.23 s exclusive(queue.open,fault) @cancel, smt |
 *
 * Claims are the workflow's (the nested body adds 317–619). The overlap queries: every one a
 * confirmed `violated` by enumeration, the slowest 0.50 s ((2,2)). The whole file: 29 s wall alone.
 * No query near 30 s, so no shape was dropped.
 *
 * Each test names the src mutation that breaks it; each was applied in a scratch copy of
 * `typescript/` (never the live `src/`) and seen to fail the test there.
 *
 * The workflow is built through the typed surface — `pipeline([s0, s1], { id, concurrency: [c0, c1] })`,
 * no cast — so `npm run check` holds this file to `Chained`, the per-stage `concurrency` tuple and the
 * `PipelineBody` brand; the `@ts-expect-error` refusals are `tests/mastra/pipeline-surface.test.ts`'s.
 */
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SmtVerifier, StateSpaceCache, mutualExclusion, type SmtProperty, type SmtVerificationResult } from 'libpetri/verification';
import type { CompiledWorkflow, PipelineSite } from '../../src/compiler/types.js';
import { init, type Quota } from '../../src/mastra/index.js';
import { compileMastraWorkflow, verifyMastraWorkflow } from '../../src/mastra/verify.js';
import { branchesOf } from '../../src/verify/budget.js';
import { pipelineOverlaps } from '../../src/verify/claims.js';
import {
  boundClaims,
  describeClaim,
  exclusions,
  FAMILIES,
  poolSinks,
  segmentInitialMarking,
  segmentLabel,
  type Segment,
  type VerificationReport,
} from '../../src/verify/index.js';

const N = z.object({ n: z.number() });
const TIMEOUT_MS = 30_000;
/**
 * The per-query cap does not bound `verifyMastraWorkflow`'s wall (thousands of queries), so a shape's
 * wall has its own ceiling — 5x the slowest measured — and each `it` has headroom above both, so a
 * slow verdict fails on its message, not on a vitest timeout.
 */
const WALL_MS = 30_000;
const IT_MS = 90_000;

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
    expect(c.result.elapsedMs, line).toBeLessThan(TIMEOUT_MS);
    expect(c.holds, line).toBe(true);
  }
  expect(report.holds).toBe(true);
}

/** Claims, wall and slowest query, for the report line (and `$PROOF_LOG` when set). */
function timing(name: string, report: VerificationReport, nested: VerificationReport, ms: number): string {
  const all = [...report.claims, ...nested.claims];
  const slowest = [...all].sort((a, b) => b.result.elapsedMs - a.result.elapsedMs)[0]!;
  const routes = new Map<string, number>();
  for (const c of report.claims) routes.set(c.result.route, (routes.get(c.result.route) ?? 0) + 1);
  return `[pipeline-blueprints] ${name} k=${report.k}: ${report.claims.length} + ${nested.claims.length} nested claims hold in ${ms.toFixed(0)}ms; ` +
    `routes ${[...routes].map(([r, n]) => `${r} ${n}`).join(', ')}; slowest ${slowest.result.elapsedMs}ms ${slowest.property} @${segmentLabel(slowest.segment)} via ${slowest.result.route}`;
}

// ---------------------------------------------------------------------------------------------
// The workflow an author writes
// ---------------------------------------------------------------------------------------------

interface Shape {
  readonly name: string;
  /** `c_j`, one per stage; the stages are `s0`, `s1`, …. */
  readonly bounds: readonly number[];
  /** `init({ concurrency: 1 })`: one step attempt in flight in the run. */
  readonly budget?: true;
  /** The workflow's `retryConfig`. */
  readonly retryConfig?: { readonly attempts?: number; readonly delay?: number };
  /** Per stage index: the stage's own `retries`. */
  readonly retries?: Readonly<Record<number, number>>;
  /** Per stage index: the stage's `timeout`, ms. */
  readonly timeout?: Readonly<Record<number, number>>;
  /** A `limit(1)` 'gpu' used by this stage and by the `report` step: one quota across both. */
  readonly limitOn?: number;
  /** A `rateLimit(burst, perMs)` 'api' used by this stage. */
  readonly rateOn?: { readonly stage: number; readonly burst: number; readonly perMs: number };
  /**
   * A timed net: a retry delay or a refill. Its liveness is the verifier's witness, and the overlap
   * is not asked. A step `timeout` is not one: it compiles to an `xor` branch of an untimed net.
   */
  readonly timed: boolean;
  /** Attempts per stage, as compiled (retries included), lane by lane identical. */
  readonly attempts: readonly number[];
}

/** `[pipeline 'per-doc' over s0..s{n-1}, step 'report']`, built only through `init()`. */
function pipelineWorkflow(s: Shape) {
  const api = init(s.budget ? { concurrency: 1 } : {});
  const gpu = api.limit(1, { id: 'gpu' });
  const rate = s.rateOn === undefined ? undefined : api.rateLimit(s.rateOn.burst, s.rateOn.perMs, { id: 'api' });
  const stage = (j: number) => {
    const uses: readonly Quota[] = [...(s.limitOn === j ? [gpu] : []), ...(s.rateOn?.stage === j && rate !== undefined ? [rate] : [])];
    const retries = s.retries?.[j];
    const timeout = s.timeout?.[j];
    return api.createStep({
      id: `s${j}`,
      inputSchema: N,
      outputSchema: N,
      execute: async ({ inputData }) => inputData,
      ...(retries === undefined ? {} : { retries }),
      ...(timeout === undefined ? {} : { timeout }),
      ...(uses.length > 0 ? { uses } : {}),
    });
  };
  const report = createReport(api, s.limitOn === undefined ? [] : [gpu]);
  expect(s.bounds.length === 2 || s.bounds.length === 3, s.name).toBe(true);
  // Typed, per stage count: the tuple of stages and the tuple of bounds, as an author writes them.
  const c = (j: number): number => s.bounds[j]!;
  const [body, options] =
    s.bounds.length === 2
      ? api.pipeline([stage(0), stage(1)], { id: 'per-doc', concurrency: [c(0), c(1)] })
      : api.pipeline([stage(0), stage(1), stage(2)], { id: 'per-doc', concurrency: [c(0), c(1), c(2)] });
  return api
    .createWorkflow({ id: 'ingest', inputSchema: z.array(N), outputSchema: z.any(), ...(s.retryConfig ? { retryConfig: s.retryConfig } : {}) })
    .foreach(body, options)
    .then(report)
    .commit();
}

function createReport(api: ReturnType<typeof init>, uses: readonly Quota[]) {
  return api.createStep({
    id: 'report',
    inputSchema: z.any(),
    outputSchema: z.any(),
    execute: async ({ inputData }) => inputData,
    ...(uses.length > 0 ? { uses } : {}),
  });
}

// ---------------------------------------------------------------------------------------------
// The matrix (ADR 0015's Amendment: the W0 spike's shapes)
// ---------------------------------------------------------------------------------------------

const SHAPES: readonly Shape[] = [
  { name: '(1,1)', bounds: [1, 1], timed: false, attempts: [1, 1] },
  { name: '(1,1,1)', bounds: [1, 1, 1], timed: false, attempts: [1, 1, 1] },
  { name: '(2,1)', bounds: [2, 1], timed: false, attempts: [1, 1] },
  { name: '(2,2)', bounds: [2, 2], timed: false, attempts: [1, 1] },
  { name: '(2,1), run budget 1', bounds: [2, 1], budget: true, timed: false, attempts: [1, 1] },
  { name: '(2,1), limit(1) on stage 1 and report', bounds: [2, 1], limitOn: 1, timed: false, attempts: [1, 1] },
  { name: '(1,1), stage 1 retrying 2 x 5 ms', bounds: [1, 1], retries: { 1: 2 }, retryConfig: { delay: 5 }, timed: true, attempts: [1, 3] },
  {
    name: '(2,1), stage 1 retrying 2 x 5 ms, run budget 1',
    bounds: [2, 1],
    budget: true,
    retries: { 1: 2 },
    retryConfig: { delay: 5 },
    timed: true,
    attempts: [1, 3],
  },
  { name: '(1,1), retryConfig 1 x 5 ms inherited by both stages', bounds: [1, 1], retryConfig: { attempts: 1, delay: 5 }, timed: true, attempts: [2, 2] },
  { name: '(1,1), stage 1 timed out at 100 ms', bounds: [1, 1], timeout: { 1: 100 }, timed: false, attempts: [1, 1] },
  { name: '(1,1), rateLimit(2, 100) on stage 0', bounds: [1, 1], rateOn: { stage: 0, burst: 2, perMs: 100 }, timed: true, attempts: [1, 1] },
];

/** `verify`'s default segments for `[pipeline, report]`: the report's resume site, two boundaries; the pipeline has none. */
const SEGMENTS = ['closed', 'cancel', 'resume@1', 'resume@1+cancel', 'restart@0', 'restart@0+cancel', 'restart@1', 'restart@1+cancel'];

const siteOf = (compiled: CompiledWorkflow): PipelineSite => {
  expect(compiled.pipelines).toHaveLength(1);
  return compiled.pipelines[0]!;
};

/**
 * Every place the site names, read off its fields here — not through `sitePlaces`, which the bound
 * derivation itself uses, so a place dropped there would drop out of the expectation too.
 */
function namedPlaces(site: PipelineSite): string[] {
  const { frame, queueOpen, queueClosed, fault, noFault, susp, noSusp } = site;
  return [
    frame, queueOpen, queueClosed, fault, noFault, susp, noSusp,
    ...site.lanes.flatMap((l) => [l.permit, l.slot, l.body, l.done, ...Object.values(l.exits)]),
  ];
}

/** `[a, b]` order-free, for comparing exclusion pairs. */
const pairKey = (a: string, b: string): string => [a, b].sort().join(' | ');

describe('verify() on pipeline() through init(): every claim holds in every default segment', () => {
  for (const shape of SHAPES) {
    // Breaks if (each applied in a scratch copy): `split` without its `opened(queue.closed)` branch
    // (blueprints/pipeline.ts) — every shape, by the branch pin; `sitePlaces` without the lane slot
    // (verify/pipeline.ts) — every shape, the slot's bound then the default's, not the pipeline's;
    // `exclusions` without `pair(queueOpen, fault)` (claims.ts) — every shape, the pair then sourced
    // `gadget`; stage 0's `start` admitting the last item
    // without closing the queue (blueprints/pipeline.ts) — every shape, by proof (`deadlockFree`
    // violated; two retrying shapes then also hit the 90 s test timeout); the adapter compiling a pipeline-marked
    // `.foreach()` as the plain foreach of Σc_j lanes — every shape; the adapter handing the stages
    // options without the workflow's `retryConfig` — the three retrying shapes (an inherited retry
    // lost, or the delay lost and the net untimed); a stage's `uses` dropped by the adapter — the
    // limit and rate shapes; a stage's `timeout` dropped — the timed-out shape;
    // `verifyMastraWorkflow` ignoring its engine's budget — the two budget shapes; the bound vector
    // reversed by the adapter — the four (2,1) shapes. And, without a mutant: any query past 30 s
    // (`unknown` is not `proven`), or a resume segment appearing for the pipeline.
    it(shape.name, { timeout: IT_MS }, async () => {
      const workflow = pipelineWorkflow(shape);
      const compiled = compileMastraWorkflow(workflow);
      const site = siteOf(compiled);
      expect([site.foreachId, [...site.bounds]]).toEqual(['per-doc', [...shape.bounds]]);
      expect(site.lanes.map((l) => l.stage)).toEqual(shape.bounds.flatMap((c, j) => Array.from({ length: c }, () => j)));
      // What the engine compiles is what is proven: each lane's attempts, the budget, the pools.
      for (const lane of site.lanes) {
        const chain = compiled.steps.find((st) => st.path.join('.') === `${site.path.join('.')}.${lane.flat}`)!;
        expect(chain.attempts, `lane ${lane.flat}`).toHaveLength(shape.attempts[lane.stage]!);
        // A stage's timeout reaches every lane of it: one funnel per attempt.
        expect(chain.timeouts, `lane ${lane.flat}`).toHaveLength(shape.timeout?.[lane.stage] === undefined ? 0 : chain.attempts.length);
      }
      expect(compiled.pools.some((p) => p.kind === 'permits')).toBe(shape.budget === true);
      const gpu = compiled.pools.find((p) => p.kind === 'limit');
      if (shape.limitOn !== undefined) {
        // One quota across every item and the parent step: every stage-1 lane attempt and report's.
        const lanes = site.lanes.filter((l) => l.stage === shape.limitOn);
        const takers = compiled.steps
          .filter((st) => st.stepId === 'report' || lanes.some((l) => st.path.join('.') === `${site.path.join('.')}.${l.flat}`))
          .flatMap((st) => st.attempts);
        expect(takers).toHaveLength(lanes.length + 1);
        expect([...gpu!.takers].sort()).toEqual([...takers].sort());
      } else expect(gpu).toBeUndefined();
      expect(compiled.pools.some((p) => p.kind === 'bucket')).toBe(shape.rateOn !== undefined);
      expect([...compiled.net.transitions].some((t) => t.timing.type !== 'immediate')).toBe(shape.timed);

      // `split`: open(queue.open) | open(queue.closed) | the foreach's failed, open(q) = frame + q +
      // both flags off + every permit. The closed branch is the empty input's.
      const width = shape.bounds.reduce((a, b) => a + b, 0);
      const split = [...compiled.net.transitions].find((t) => t.name === site.split)!;
      const permits = site.lanes.map((l) => l.permit);
      const opened = (q: string) => [site.frame, q, site.noFault, site.noSusp, ...permits].sort();
      const branches = branchesOf(split.outputSpec!);
      expect(branches.map((b) => [...b.values()].every((n) => n === 1)), 'one token a place').toEqual([true, true, true]);
      expect(branches.slice(0, 2).map((b) => [...b.keys()].sort())).toEqual([opened(site.queueOpen), opened(site.queueClosed)]);
      expect(branches[2]!.size).toBe(1);
      expect(namedPlaces(site)).not.toContain([...branches[2]!.keys()][0]);
      expect([...branches[2]!.keys()][0]).toMatch(/failed$/);

      // Provenance, off the derivations `verify` asks. Bounds: every site place 1, because of the
      // pipeline — not the default 1 a place gets when nothing claims it.
      const named = namedPlaces(site);
      expect(named).toHaveLength(7 + 9 * width);
      expect(new Set(named).size).toBe(named.length);
      const bounds = new Map(boundClaims(compiled).claimed.map((b) => [b.place.name, b] as const));
      for (const name of named) {
        const b = bounds.get(name);
        expect(b, name).toBeDefined();
        expect([b!.bound, b!.why], name).toEqual([1, `pipeline 'per-doc' (bounds [${shape.bounds.join(', ')}]): every pipeline place is 1-bounded`]);
      }
      // Exclusions: exactly the pipeline's pairs sourced `pipeline`, none of them left to the gadget.
      const sourced = exclusions(compiled);
      const want = [
        pairKey(site.queueOpen, site.queueClosed),
        pairKey(site.queueOpen, site.fault),
        pairKey(site.queueOpen, site.susp),
        pairKey(site.noFault, site.fault),
        pairKey(site.noSusp, site.susp),
        ...site.lanes.map((l) => pairKey(l.permit, l.slot)),
      ].sort();
      expect(sourced.filter((e) => e.source === 'pipeline').map((e) => pairKey(e.a.name, e.b.name)).sort()).toEqual(want);
      const gadget = new Set(sourced.filter((e) => e.source !== 'pipeline').map((e) => pairKey(e.a.name, e.b.name)));
      for (const p of want) expect(gadget.has(p), `${p} listed again, not as pipeline`).toBe(false);

      const t0 = performance.now();
      const verification = await verifyMastraWorkflow(workflow, { timeoutMs: TIMEOUT_MS });
      const ms = performance.now() - t0;
      const report = verification.workflow;
      // The minted body, compiled as a standalone petri workflow (not the twin's run): it holds.
      expect(Object.keys(verification.nested)).toEqual(['per-doc']);
      const nested = verification.nested['per-doc']!;
      const line = timing(shape.name, report, nested, ms);
      console.log(line);
      const log = process.env['PROOF_LOG'];
      if (log) appendFileSync(log, `${line}\n`);

      expect(ms, `${shape.name}: verifyMastraWorkflow wall`).toBeLessThan(WALL_MS);
      expect(report.k).toBe(shape.budget ? 1 : 'unbounded');
      expectHolds(report);
      expectHolds(nested);
      expect(verification.holds).toBe(true);

      // Every default segment proven, none quietly dropped, each with the pipeline's own claims.
      expect(report.segments.map(segmentLabel)).toEqual(SEGMENTS);
      const pipelineClaims = [
        ...named.map((name) => `bound(${name}<=1)`),
        ...site.lanes.map((l) => `exclusive(${l.permit},${l.slot})`),
        `exclusive(${site.queueOpen},${site.queueClosed})`,
        `exclusive(${site.queueOpen},${site.fault})`,
        `exclusive(${site.queueOpen},${site.susp})`,
        `exclusive(${site.noFault},${site.fault})`,
        `exclusive(${site.noSusp},${site.susp})`,
      ];
      const quotaClaims = [
        ...(shape.limitOn === undefined ? [] : ['bound(wf.quota.gpu<=1)', 'poolReturned(wf.quota.gpu)']),
        ...(shape.rateOn === undefined
          ? []
          : [`bound(wf.quota.api<=${shape.rateOn.burst})`, `bound(wf.quota.api.spent<=${shape.rateOn.burst})`, 'demandDrained(wf.quota.api.demand)']),
      ];
      for (const seg of SEGMENTS) {
        const at = new Set(report.claims.filter((c) => segmentLabel(c.segment) === seg).map((c) => c.property));
        for (const p of [...pipelineClaims, ...quotaClaims]) expect(at.has(p), `${p} @${seg}`).toBe(true);
      }
      if (shape.limitOn === undefined && shape.rateOn === undefined) {
        expect(report.claims.some((c) => c.property.includes('wf.quota.'))).toBe(false);
      }
      if (shape.rateOn !== undefined) {
        // The bucket's rate is listed as tested, not proven.
        const rate = report.unclaimed.filter((u) => u.place === 'wf.quota.api');
        expect(rate).toHaveLength(1);
        expect(rate[0]!.why).toContain(`at most ${shape.rateOn.burst} per ${shape.rateOn.perMs} ms`);
      }

      // Every lane attempt (and timeout funnel) is a liveness target, witnessed in closed: by execution on an immediate
      // net, by the verifier on a timed one (a run cannot be stubbed through a delay).
      const laneChains = compiled.steps.filter((st) => st.path.length === 2 && st.path[0] === site.path[0]);
      const laneAttempts = laneChains.flatMap((st) => [...st.attempts, ...st.timeouts]);
      expect(laneAttempts).toHaveLength(site.lanes.reduce((n, l) => n + shape.attempts[l.stage]! * (shape.timeout?.[l.stage] === undefined ? 1 : 2), 0));
      for (const attempt of laneAttempts) {
        const live = report.claims.find((c) => c.property === `live(${attempt})` && segmentLabel(c.segment) === 'closed');
        expect(live, `live(${attempt})`).toBeDefined();
        if (shape.timed) expect(live!.result.route, describeClaim(live!)).not.toBe('execution');
        else expect(live!.result.route, describeClaim(live!)).toBe('execution');
        // No deciding arm, so no preempted branch to over-approximate: the note is a race's alone.
        expect(live!.note, describeClaim(live!)).toBeUndefined();
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------
// The overlap: stage j+1 of one item while stage j of another
// ---------------------------------------------------------------------------------------------

/** One query from a segment's initial marking, as `verify` asks it, through a shared cache. */
function ask(compiled: CompiledWorkflow, segment: Segment, property: SmtProperty, cache: StateSpaceCache): Promise<SmtVerificationResult> {
  const t = compiled.terminals;
  const initial = segmentInitialMarking(compiled, segment);
  return SmtVerifier.forNet(compiled.net)
    .initialMarking((m) => {
      for (const [p, n] of initial) m.tokens(p, n);
    })
    .sinkPlaces(t.done, t.failed, t.bailed, t.suspended, t.paused, t.canceled, compiled.cancel, ...poolSinks(compiled))
    .semiflowInvariants(true)
    .stateSpaceCache(cache)
    .enumerationMaxClasses(50_000)
    .timeout(TIMEOUT_MS)
    .totalBudget(TIMEOUT_MS)
    .property(property)
    .verify();
}

describe('the overlap through init(): every adjacent stage pair is reachable together, confirmed', () => {
  for (const shape of SHAPES.filter((s) => !s.timed)) {
    // Breaks if (each applied in a scratch copy): stage 0's `start` reading the permit of every
    // other lane — an item is admitted only into an idle pipeline, the pair becomes exclusive
    // (`proven`) and the pipeline runs one item at a time; the adapter compiling the pipeline as a
    // plain foreach. Only a definitive, confirmed `violated` passes; `unknown` fails.
    // Headroom above the 30 s query budget, so an `unknown` reports by its message.
    it(shape.name, { timeout: 60_000 }, async () => {
      const compiled = compileMastraWorkflow(pipelineWorkflow(shape));
      const site = siteOf(compiled);
      const overlaps = pipelineOverlaps(compiled);
      expect(overlaps.map((o) => [o.stage, o.a.name, o.b.name])).toEqual(
        shape.bounds.slice(0, -1).map((_, j) => [j, site.lanes.find((l) => l.stage === j && l.lane === 0)!.slot, site.lanes.find((l) => l.stage === j + 1 && l.lane === 0)!.slot]),
      );
      const cache = new StateSpaceCache();
      for (const o of overlaps) {
        const r = await ask(compiled, 'closed', mutualExclusion(o.a, o.b), cache);
        const line = `exclusive(${o.a.name},${o.b.name}): ${r.verdict.type} via ${r.route} in ${Math.round(r.elapsedMs)}ms, confirmed ${String(r.counterexampleConfirmed)}`;
        console.log(`[pipeline-blueprints] overlap ${shape.name} ${line}`);
        expect(r.verdict.type, line).toBe('violated');
        expect(r.counterexampleConfirmed, line).toBe(true);
        expect(r.elapsedMs, line).toBeLessThan(TIMEOUT_MS);
      }
    });
  }
});

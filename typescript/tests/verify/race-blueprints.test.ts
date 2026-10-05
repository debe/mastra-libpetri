/**
 * **race and quorum compose** ([ADR 0014], with [ADR 0002] and [ADR 0012]): the composition matrix,
 * built through `init()`'s factories — the Layer 3 surface — and proven through
 * `verifyMastraWorkflow`, so the net proven is the one `PetriExecutionEngine.execute()` compiles: the
 * engine's own run budget read from the workflow, the workflow's `retryConfig`, the `limit` carried
 * on the steps.
 *
 * `tests/verify/decision.test.ts` proves the compiled race from a hand-written description; this file
 * proves what an author writes: `wf.parallel(...quorum(k, arms)).then(next)` over n = 3 (k = 1, 2, 3)
 * and n = 4 (k = 1, 2), each crossed with
 *
 * - a run budget of 1 (`init({ concurrency: 1 })`) or none;
 * - a `limit(1)` shared by two arms, or none;
 *
 * and, on a timed net, one arm retrying (`retries: 2`, the workflow's `retryConfig.delay` 5 ms) once
 * per (n, k) under both the budget and the limit — the slowest composition — and once alone at n = 3,
 * k = 1. The other 15 timed crossings were measured once (all held; 161 s for the full 40, slowest
 * query 7.6 s) and are not kept: the timed cases were 90% of the file and add no shape the kept ones
 * lack.
 *
 * In every case every claim of all four families holds — a proof's verdict `proven`, a liveness
 * witness `violated` with its run confirmed — and the decision's claims are present by property name:
 * `bound(permit<=1)`, `bound(won<=1)`, `bound(short<=1)`, `bound(okSeen<=n)`, `bound(miss<=n)`,
 * `bound(settled<=max(n−k, k−1))`, `bound(preempted-i<=1)` and `exclusive(won,short)` in every
 * segment proven, `live(met)` and `live(short)` in `closed`. On an untimed net `met` and `short` are
 * witnessed by execution; on a timed one (the retrying arm) the verifier settles them and says its
 * witness is in the untimed over-approximation.
 *
 * Environment: `@mastra/core` from the pinned registry package; libpetri 8.0.0 from the registry, not
 * linked (`scripts/link-libpetri.sh --check`: "not linked"); z3 on PATH. Proven, per claim: property,
 * segment, initial marking and route are printed for every claim on failure (`describeClaim`);
 * environment mode none (one closed net); segments `verify`'s defaults, pinned — `closed`, `cancel`,
 * `resume@1[+cancel]` (the `next` step's resume site; the block itself never suspends),
 * `restart@0[+cancel]` and `restart@1[+cancel]`; 30 s a query — a proof that
 * does not close in that is a net to redesign, never a budget to raise. Each case's total and slowest
 * query are printed, and appended to `$PROOF_LOG` when set. Nothing here is run: no runtime claim is
 * made, tested or proven.
 *
 * Each test names the mutation that breaks it.
 */
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { DecisionSite } from '../../src/compiler/types.js';
import { init } from '../../src/mastra/index.js';
import { compileMastraWorkflow, verifyMastraWorkflow } from '../../src/mastra/verify.js';
import {
  describeClaim,
  FAMILIES,
  OVER_APPROXIMATION_NOTE,
  segmentLabel,
  type VerificationReport,
} from '../../src/verify/index.js';

const N = z.object({ n: z.number() });
const TIMEOUT_MS = 30_000;
const ARM_IDS = ['a', 'b', 'c', 'd'] as const;

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
    expect(c.result.elapsedMs, line).toBeLessThan(TIMEOUT_MS);
    expect(c.holds, line).toBe(true);
  }
  expect(report.holds).toBe(true);
}

/** Total and slowest query, for the report line. */
function timing(name: string, report: VerificationReport, ms: number): string {
  const slowest = [...report.claims].sort((a, b) => b.result.elapsedMs - a.result.elapsedMs)[0]!;
  const routes = new Map<string, number>();
  for (const c of report.claims) routes.set(c.result.route, (routes.get(c.result.route) ?? 0) + 1);
  return `[race-blueprints] ${name} k=${report.k}: ${report.claims.length} claims hold in ${ms.toFixed(0)}ms; ` +
    `routes ${[...routes].map(([r, n]) => `${r} ${n}`).join(', ')}; slowest ${slowest.result.elapsedMs}ms ${slowest.property} @${segmentLabel(slowest.segment)} via ${slowest.result.route}`;
}

// ---------------------------------------------------------------------------------------------
// The workflow an author writes
// ---------------------------------------------------------------------------------------------

interface Shape {
  readonly n: 3 | 4;
  readonly k: number;
  /** `init({ concurrency: 1 })`: one step attempt in flight in the run. */
  readonly budget: boolean;
  /** Arm `a` retries twice, after the workflow's `retryConfig.delay` of 5 ms. */
  readonly retry: boolean;
  /** Arms `a` and `b` share one `limit(1)`. */
  readonly limit: boolean;
}

const label = (s: Shape): string =>
  `${s.k === 1 ? 'race' : `quorum(${s.k})`} of ${s.n}` +
  `${s.budget ? ', run budget 1' : ''}${s.retry ? ', arm a retrying (2, 5 ms)' : ''}${s.limit ? ', limit(1) in arms a, b' : ''}`;

/** `wf.parallel(...quorum(k, arms)).then(next)`, built only through `init()`. */
function raceWorkflow(s: Shape) {
  const { createWorkflow, createStep, limit, quorum } = init(s.budget ? { concurrency: 1 } : {});
  const db = limit(1, { id: 'db' });
  const arm = (id: string) =>
    createStep({
      id,
      inputSchema: N,
      outputSchema: N,
      ...(s.retry && id === 'a' ? { retries: 2 } : {}),
      ...(s.limit && (id === 'a' || id === 'b') ? { uses: [db] } : {}),
      execute: async ({ inputData }) => inputData,
    });
  const next = createStep({ id: 'next', inputSchema: z.any(), outputSchema: z.any(), execute: async ({ inputData }) => inputData });
  return createWorkflow({
    id: 'race-blueprint',
    inputSchema: N,
    outputSchema: z.any(),
    ...(s.retry ? { retryConfig: { delay: 5 } } : {}),
  })
    .parallel(...quorum(s.k, ARM_IDS.slice(0, s.n).map(arm), { id: 'q' }))
    .then(next)
    .commit();
}

// ---------------------------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------------------------

const NK: readonly (readonly [3 | 4, number])[] = [[3, 1], [3, 2], [3, 3], [4, 1], [4, 2]];

/** Untimed: every (n, k) × budget × limit. Timed: see the module comment. */
const SHAPES: readonly Shape[] = [
  ...NK.flatMap(([n, k]) =>
    [false, true].flatMap((budget) => [false, true].map((limit): Shape => ({ n, k, budget, retry: false, limit }))),
  ),
  ...NK.map(([n, k]): Shape => ({ n, k, budget: true, retry: true, limit: true })),
  { n: 3, k: 1, budget: false, retry: true, limit: false },
];

/** `verify`'s default segments for `.parallel(...).then(next)`: one resume site (`next`), two boundaries. */
const SEGMENTS = ['closed', 'cancel', 'resume@1', 'resume@1+cancel', 'restart@0', 'restart@0+cancel', 'restart@1', 'restart@1+cancel'];

describe('verify() on race and quorum through init(): every claim holds', () => {
  for (const shape of SHAPES) {
    const name = label(shape);
    // Breaks if: any claim fails to prove on the composed net — a decision bound too tight under the
    // budget's queue or the limit's pool, the exclusion lost, met or short dead behind the retry
    // chain or the shared permit — any query passes 30 s (`unknown` is not `proven`), the engine's
    // budget or the workflow's retryConfig stops reaching the verified net, or the decision's
    // claims stop reaching `verify` through init() and the adapter (the presence checks).
    it(name, { timeout: 60_000 }, async () => {
      const workflow = raceWorkflow(shape);
      const compiled = compileMastraWorkflow(workflow as never);
      expect(compiled.decisions).toHaveLength(1);
      const d: DecisionSite = compiled.decisions[0]!;
      expect([d.blockId, d.n, d.k]).toEqual(['q', shape.n, shape.k]);
      // What the engine compiles is what is proven: its budget, the retry chain, the limit pool.
      expect(compiled.steps.find((st) => st.stepId === 'a')!.attempts).toHaveLength(shape.retry ? 3 : 1);
      // The limit reaches arms a and b, every attempt of each, and nothing else.
      const db = compiled.pools.find((p) => p.kind === 'limit' && p.place.name === 'wf.quota.db');
      if (shape.limit) {
        const shared = compiled.steps.filter((st) => st.stepId === 'a' || st.stepId === 'b').flatMap((st) => st.attempts);
        expect([...db!.takers].sort()).toEqual([...shared].sort());
      } else expect(db).toBeUndefined();
      expect(compiled.pools.some((p) => p.kind === 'permits')).toBe(shape.budget);

      const t0 = performance.now();
      const verification = await verifyMastraWorkflow(workflow as never, { timeoutMs: TIMEOUT_MS });
      const ms = performance.now() - t0;
      const report = verification.workflow;
      const line = timing(name, report, ms);
      console.log(line);
      const log = process.env['PROOF_LOG'];
      if (log) appendFileSync(log, `${line}\n`);

      expect(report.k).toBe(shape.budget ? 1 : 'unbounded');
      expect(Object.keys(verification.nested)).toEqual([]);
      expectHolds(report);
      expect(verification.holds).toBe(true);
      // Every default segment proven, none quietly dropped, each with its claims.
      expect(report.segments.map(segmentLabel)).toEqual(SEGMENTS);
      for (const seg of SEGMENTS) expect(report.claims.some((c) => segmentLabel(c.segment) === seg), seg).toBe(true);
      if (shape.limit) {
        for (const seg of SEGMENTS) {
          const at = report.claims.filter((c) => segmentLabel(c.segment) === seg).map((c) => c.property);
          expect(at, seg).toContain('bound(wf.quota.db<=1)');
          expect(at, seg).toContain('poolReturned(wf.quota.db)');
        }
      } else expect(report.claims.some((c) => c.property.includes('wf.quota.db'))).toBe(false);

      // The decision's claims, by property name, in every segment proven.
      const settled = Math.max(shape.n - shape.k, shape.k - 1);
      expect(d.settled).toBeDefined();
      expect(d.preempted).toHaveLength(shape.n);
      for (const seg of report.segments) {
        const at = new Set(report.claims.filter((c) => segmentLabel(c.segment) === segmentLabel(seg)).map((c) => c.property));
        for (const p of [
          `bound(${d.permit}<=1)`,
          `bound(${d.won}<=1)`,
          `bound(${d.short}<=1)`,
          `bound(${d.okSeen}<=${shape.n})`,
          `bound(${d.miss}<=${shape.n})`,
          `bound(${d.settled}<=${settled})`,
          ...d.preempted.map((p) => `bound(${p}<=1)`),
          `exclusive(${d.won},${d.short})`,
        ]) {
          expect(at.has(p), `${p} @${segmentLabel(seg)}`).toBe(true);
        }
      }

      // live(met) and live(short) in closed; each collect-preempted-i is unclaimed, and said.
      for (const target of [d.met, d.shortTransition]) {
        const live = report.claims.find((c) => c.property === `live(${target})` && segmentLabel(c.segment) === 'closed');
        expect(live, `live(${target})`).toBeDefined();
        if (shape.retry) {
          // A timed net is never witnessed by execution: the verifier's witness, with its note.
          expect(live!.result.route, describeClaim(live!)).not.toBe('execution');
          expect(live!.note, describeClaim(live!)).toBe(OVER_APPROXIMATION_NOTE);
        } else {
          expect(live!.result.route, describeClaim(live!)).toBe('execution');
          expect(live!.note, describeClaim(live!)).toBeUndefined();
        }
      }
      for (const name of d.collectPreempted) expect(report.claims.some((c) => c.property === `live(${name})`), name).toBe(false);
      expect(report.unclaimedTargets.map((u) => u.transition)).toEqual(d.collectPreempted);
    });
  }
});

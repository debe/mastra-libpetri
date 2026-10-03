import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { verifyMastraWorkflow, type MastraVerification } from '../../src/mastra/verify.js';
import { describeClaim, segmentLabel, type VerificationReport } from '../../src/verify/index.js';
import { FIXTURES, RESUME_FIXTURES, Recorder, engineConfig } from '../fixtures/mastra-workflows.js';

/**
 * **The M6 gate** ([ADR 0009]): every workflow of the differential corpus — each fresh-run fixture
 * and each resume fixture, and every workflow they nest — compiled exactly as the engine compiles
 * it (`verifyMastraWorkflow`: the fixture's own `PetriExecutionEngine` supplies the iteration bound
 * and the budget), and every claim of all four families holds: `proven` for a proof, a confirmed
 * witness for liveness. `unknown` fails; a missing solver throws before any query.
 *
 * - **Budgets:** unbounded and `k = 1`. A budget compiles a different net (every attempt takes a
 *   permit); `k = 2` and `4` are the same net with more permits in the initial marking.
 * - **Segments:** `closed`, `cancel`, and `resume@s` / `resume@s+cancel` for every resume site.
 * - **Sinks:** the six terminals, `wf.cancel`, and the permits under a budget.
 * - **Environment mode:** none — one closed net; a cancellation arrives through `t.cancel.arrive`.
 * - **Route and time:** per claim in `describeClaim`, printed on failure; a summary per workflow is
 *   appended to the file `PROOF_LOG` names, when it names one.
 *
 * The workflows run one at a time: each `verify` already runs its queries in a pool as wide as half
 * the cores, and two pools at once would starve the solver into timeouts, which read as `unknown`.
 *
 * **One lane, 30 s a query.** Every workflow runs in `npm test`. Under libpetri 8.0.0's in-flight
 * firing the whole corpus — 132 cases, about 124,000 claims — takes about 13 minutes on ten cores;
 * a proof that does not close in 30 s is a net to redesign, not a budget to raise ([ADR 0009]).
 */

/** Per query. A proof that does not close in 30 s is a net to redesign, not a budget to raise. */
const TIMEOUT_MS = 30_000;

const proofLog = (line: string): void => {
  const file = process.env['PROOF_LOG'];
  if (file) appendFileSync(file, `${line}\n`);
};

/** One line per workflow: what was claimed, how it was settled, and what was left unclaimed. */
function summary(label: string, name: string, report: VerificationReport, ms: number): string {
  const routes = new Map<string, number>();
  for (const c of report.claims) routes.set(c.result.route, (routes.get(c.result.route) ?? 0) + 1);
  const families = report.families.map((f) => `${f} ${report.claims.filter((c) => c.family === f).length}`).join(', ');
  return `[corpus ${label}] ${name} k=${report.k}: ${report.claims.filter((c) => c.holds).length}/${report.claims.length} hold (${families}) ` +
    `in ${ms}ms; routes ${[...routes].map(([r, n]) => `${r} ${n}`).join(', ')}; segments ${report.segments.map(segmentLabel).join(' ')}; ` +
    `unclaimed ${report.unclaimed.map((u) => u.place).join(', ') || 'none'}`;
}

function expectHolds(name: string, report: VerificationReport): void {
  for (const c of report.claims) {
    const line = `${name}: ${describeClaim(c)}`;
    if (c.kind === 'proof') expect(c.result.verdict.type, line).toBe('proven');
    else {
      expect(c.result.verdict.type, line).toBe('violated');
      expect(c.result.counterexampleConfirmed, line).toBe(true);
    }
  }
  // Every family is present: a gate that silently dropped one would still pass the loop above.
  expect(report.families).toEqual(['completion', 'bounds', 'exclusion', 'liveness']);
  for (const family of report.families) expect(report.claims.some((c) => c.family === family), `${name}: ${family}`).toBe(true);
}

const corpus = [
  ...FIXTURES.map((f) => ({ name: f.name, build: f.build })),
  ...RESUME_FIXTURES.map((f) => ({ name: f.name, build: f.build })),
];

describe.each([
  ['unbounded', undefined],
  ['k=1', 1],
] as const)('the corpus, %s', (label, k) => {
  for (const fixture of corpus) {
    it(fixture.name, { timeout: 600_000 }, async () => {
      const workflow = fixture.build(engineConfig('petri', k), new Recorder());
      const started = Date.now();
      const result: MastraVerification = await verifyMastraWorkflow(workflow as never, { timeoutMs: TIMEOUT_MS });
      const ms = Date.now() - started;
      proofLog(summary(label, fixture.name, result.workflow, ms));
      for (const [id, nested] of Object.entries(result.nested)) proofLog(summary(label, `${fixture.name} > ${id}`, nested, ms));

      expectHolds(fixture.name, result.workflow);
      for (const [id, nested] of Object.entries(result.nested)) expectHolds(`${fixture.name} > ${id}`, nested);
      expect(result.holds).toBe(true);
    });
  }
});

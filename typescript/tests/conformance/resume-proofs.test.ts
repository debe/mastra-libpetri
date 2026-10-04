import { describe, expect, it } from 'vitest';
import { compile } from '../../src/compiler/compile.js';
import type { CompiledWorkflow } from '../../src/compiler/types.js';
import { adaptExecutionGraph } from '../../src/mastra/adapt.js';
import {
  budgetStructureViolations,
  cancelStructureViolations,
  describeReport,
  resumeGateViolations,
  resumeTimingViolations,
  segmentLabel,
  segmentsFor,
  suspensionCoverageViolations,
  verifyWorkflow,
} from '../../src/verify/index.js';
import { BUDGETS, engineConfig, ITERATION_BOUND, Recorder, RESUME_FIXTURES, type ResumeFixture } from '../fixtures/mastra-workflows.js';

/**
 * The nets behind the resume corpus, proven ([ADR 0007]): every fixture's compiled workflow at every
 * budget the differential runs it at, k in {1, 2, 4, unbounded}. Each claim names its segments —
 * `closed`, `cancel`, and `resume@s` / `resume@s+cancel` for every registered site, from the marking
 * the kernel seeds (`{site: 1, permits: k[, cancel request: 1]}`) — the property, and the route
 * libpetri reports, printed per net. Environment-closed, untimed, value-blind (VER-004). Every
 * verdict is asserted `proven` by name, so `unknown` fails. The six structural checks are asserted
 * empty first, each by name.
 */

/** One net per distinct shape: the falsy fixtures share one. */
const SHAPES: readonly ResumeFixture[] = [...new Map(RESUME_FIXTURES.map((f) => [f.id, f])).values()];

/** 30 s a query, every shape: a proof that does not close in that is a net to redesign ([ADR 0009]). */
const BUDGET_MS = 30_000;
const isForeach = (f: ResumeFixture) => f.id.startsWith('rs-fe-');

function compiledFor(fixture: ResumeFixture, k: number | undefined): CompiledWorkflow {
  const cfg = engineConfig('petri', k);
  const wf = fixture.build(cfg, new Recorder()) as unknown as { buildExecutionGraph(): Parameters<typeof adaptExecutionGraph>[0] };
  return compile(adaptExecutionGraph(wf.buildExecutionGraph(), { iterationBound: ITERATION_BOUND }), k === undefined ? {} : { concurrency: k });
}

const STRUCTURE = [
  ['cancel', cancelStructureViolations],
  ['budget', budgetStructureViolations],
  ['resumeGate', resumeGateViolations],
  ['suspensionCoverage', suspensionCoverageViolations],
  ['resumeTiming', resumeTimingViolations],
] as const;

for (const k of BUDGETS) {
  describe(`the resume corpus' nets, proven at k = ${k ?? 'unbounded'}`, () => {
    for (const fixture of SHAPES.filter(isForeach)) {
      it(`${fixture.id}: sites ${fixture.sites.join(', ')} registered, every structural check clean`, () => {
        const compiled = compiledFor(fixture, k);
        expect([...compiled.resumeSites.keys()].sort()).toEqual([...fixture.sites].sort());
        const structure = Object.fromEntries(STRUCTURE.map(([name, check]) => [name, check(compiled)]));
        expect(structure).toEqual(Object.fromEntries(STRUCTURE.map(([name]) => [name, []])));
      });
    }
    for (const fixture of SHAPES) {
      it(`${fixture.id}: sites ${fixture.sites.join(', ')}`, async () => {
        const compiled = compiledFor(fixture, k);
        expect(compiled.budget?.k).toBe(k);
        expect([...compiled.resumeSites.keys()].sort()).toEqual([...fixture.sites].sort());

        const structure = Object.fromEntries(STRUCTURE.map(([name, check]) => [name, check(compiled)]));
        expect(structure).toEqual(Object.fromEntries(STRUCTURE.map(([name]) => [name, []])));

        const t0 = performance.now();
        // The fresh and resume segments: the restart segments ([ADR 0010]) are left out here, and
        // proven in tests/verify/restart-segments.test.ts and tests/mastra/engine-resume.test.ts.
        const reports = await verifyWorkflow(compiled, { timeoutMs: BUDGET_MS, restart: 'none' });
        const ms = performance.now() - t0;
        const routes = reports.map(describeReport).join('\n');
        console.log(`[proof] ${fixture.id} k=${k ?? 'unbounded'} ${ms.toFixed(0)}ms:\n${routes}`);

        const labels = segmentsFor(compiled, { restart: 'none' }).map(segmentLabel);
        const sites = [...fixture.sites].sort((a, b) => {
          const pa = a.split('.').map(Number);
          const pb = b.split('.').map(Number);
          for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const d = (pa[i] ?? -1) - (pb[i] ?? -1);
            if (d !== 0) return d;
          }
          return 0;
        });
        expect(labels).toEqual(['closed', 'cancel', ...sites.flatMap((s) => [`resume@${s}`, `resume@${s}+cancel`])]);
        const properties = ['deadlockFree', 'terminatesAtSink', 'exactlyOneTerminal', ...(k === undefined ? [] : ['permitsBounded', 'permitsReturned'])];
        const expected: Record<string, string> = {};
        for (const label of labels) {
          for (const p of properties) expected[`${label}/${p}`] = 'proven';
          if (!label.endsWith('cancel')) expected[`${label}/neverCanceled`] = 'proven';
        }
        const verdicts = Object.fromEntries(reports.map((r) => [`${segmentLabel(r.segment)}/${r.property}`, r.result.verdict.type]));
        expect(verdicts, routes).toEqual(expected);
      }, isForeach(fixture) ? 14_400_000 : 600_000);
    }
  });
}

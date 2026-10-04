import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  compareObservations,
  compareResume,
  formatResumeReport,
  formatVerdicts,
  oracleRoute,
  RESUME_ROUTES,
  routeLabel,
  RESUME_EXCLUDED_PATHS,
  runResume,
  type Attribution,
  type PhaseObservation,
  type ResumeObservation,
  type ResumeVerdict,
} from '../../src/conformance/differential.js';
import { UnsupportedRunModeError } from '../../src/mastra/engine.js';
import { BUDGETS, observeResume, RESUME_FIXTURES, toResumeCase, type ResumeFixture } from '../fixtures/mastra-workflows.js';

/**
 * Suspend, then resume, on both engines and crossed ([ADR 0007]). Each resumable fixture is run to
 * its suspension with Mastra's `Run.start()` on one engine and continued with `Run.resume()` on
 * another, through a real `Mastra` over one `InMemoryStore`, on every route:
 *
 * - `default>default` — the oracle, once per process mode;
 * - `petri>petri same` — one engine instance for every phase (in-process);
 * - `petri>petri` — a new instance per phase (cross-process);
 * - `default>petri` and `petri>default` — the stored `WorkflowRunState` is the only thing handed
 *   across, so a match shows it is the only record.
 *
 * At every budget k in {1, 2, 4, unbounded}. Per phase, the value `start()`/`resume()` returned or
 * the error it threw, and every stored snapshot, are compared with the oracle's field by field, with
 * only clock stamps and run/trace ids excluded (`RESUME_EXCLUDED_PATHS`). A difference is allowed
 * only when a documented row of `docs/divergences.md` covers it.
 */

const DIVERGENCES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/divergences.md');
const documentedRows = new Set([...readFileSync(DIVERGENCES, 'utf8').matchAll(/^\| (\d+) \|/gm)].map((m) => Number(m[1])));
const known = (row: number) => documentedRows.has(row);

const budgetName = (k: number | undefined) => (k === undefined ? 'unbounded' : String(k));
const binds = (f: ResumeFixture, k: number | undefined) => k !== undefined && k < (f.width ?? 1);

const ALL: ResumeVerdict[] = [];
afterAll(() => {
  if (ALL.length === 0) return;
  const report = formatResumeReport(ALL);
  console.log(report);
  const out = process.env['RESUME_DIFFERENTIAL_REPORT'];
  if (out !== undefined && out !== '') writeFileSync(out, `${report}\n`);
});

describe('the routes', () => {
  it('are the four candidates, each against the oracle of its process mode', () => {
    expect(RESUME_ROUTES.map(routeLabel)).toEqual(['petri>petri same', 'petri>petri', 'default>petri', 'petri>default']);
    expect(RESUME_ROUTES.map((r) => routeLabel(oracleRoute(r)))).toEqual(['default>default same', 'default>default', 'default>default', 'default>default']);
  });
});

for (const k of BUDGETS) {
  describe(`suspend then resume, every route, petri budget k = ${budgetName(k)}`, () => {
    for (const fixture of RESUME_FIXTURES) {
      it(fixture.name, async () => {
        const verdicts = await runResume(toResumeCase(fixture, k));
        ALL.push(...verdicts);
        const report = formatVerdicts(verdicts);
        expect(verdicts.map((v) => routeLabel(v.route))).toEqual(RESUME_ROUTES.map(routeLabel));

        for (const v of verdicts) {
          // The fixture exercised what it meant to, on the oracle, phase by phase.
          expect(v.oraclePhases, report).toEqual(fixture.expected);
          // Engine identity: every phase ran on its route's engine only, nested workflows included.
          expect(v.identity, report).toEqual([]);
          expect(v.executions.oracle.petri).toBe(0);
          if (v.route.suspendOn === 'petri' && v.route.resumeOn === 'petri') expect(v.executions.candidate.default).toBe(0);
          if (v.route.suspendOn !== v.route.resumeOn) {
            expect(v.executions.candidate.default).toBeGreaterThanOrEqual(1);
            expect(v.executions.candidate.petri).toBeGreaterThanOrEqual(1);
          }

          for (const d of v.differences) expect({ path: d.path, row: d.row, known: d.row !== undefined && known(d.row) }).toEqual({ path: d.path, row: d.row, known: true });

          expect(v.ordering.reversed, report).toEqual([]);
          expect(v.ordering.inverted, report).toEqual([]);
          if ((fixture.independent ?? []).length === 0 || !binds(fixture, k)) expect(v.ordering.weakened, report).toEqual([]);

          expect(v.budget, report).toEqual([]);
          expect(v.measurements.concurrency).toBe(k ?? 'unbounded');
          if (k !== undefined) expect(v.measurements.peakInFlight.candidate).toBeLessThanOrEqual(k);

          expect(v.verdict, report).not.toBe('fail');
        }

        // Every declared attribution explains something on some route: a stale one fails. A
        // route-scoped one explains something on every route it names (it is listed as unused
        // only there; elsewhere it attributes nothing, see 'route-scoped attributions' below).
        const c = toResumeCase(fixture, k);
        const stale = (c.divergences ?? []).filter((at) => verdicts.every((v) => v.unusedAttributions.includes(at)));
        expect(stale.map((at) => `row ${at.row}: ${at.reason}`)).toEqual([]);
        const scopedUnused = verdicts.flatMap((v) =>
          v.unusedAttributions.filter((at) => at.routes !== undefined).map((at) => `row ${at.row} unused on ${routeLabel(v.route)}: ${at.reason}`),
        );
        expect(scopedUnused).toEqual([]);
      });
    }
  });
}

describe('route-scoped attributions', () => {
  const phase = (status: string): PhaseObservation => ({
    outcome: { kind: 'resolved', result: { status } },
    stored: {},
    trace: [],
    executions: [{ engine: 'default', workflowId: 'w' }],
  });
  const oracle: ResumeObservation = { phases: [phase('success')] };
  const candidate: ResumeObservation = { phases: [phase('suspended')] };
  const scoped: Attribution = { row: 75, paths: ['phases.0.result.status'], reason: 'scoped', routes: ['default>petri'] };

  it('attribute a difference on the routes they name, and nothing on any other: there it is a finding', () => {
    const on = compareResume('f', { suspendOn: 'default', resumeOn: 'petri', process: 'fresh' }, oracle, candidate, [scoped]);
    const off = compareResume('f', { suspendOn: 'petri', resumeOn: 'default', process: 'fresh' }, oracle, candidate, [scoped]);
    expect(on.differences).toStrictEqual([{ path: 'phases.0.result.status', oracle: 'success', candidate: 'suspended', row: 75 }]);
    expect(on.verdict).toBe('divergent');
    expect(on.unusedAttributions).toStrictEqual([]);
    expect(off.differences).toStrictEqual([{ path: 'phases.0.result.status', oracle: 'success', candidate: 'suspended' }]);
    expect(off.verdict).toBe('fail');
    // Not applicable there, so not reported as unused there either.
    expect(off.unusedAttributions).toStrictEqual([]);
  });

  it('are listed as unused on a named route where they matched nothing', () => {
    const same = compareResume('f', { suspendOn: 'default', resumeOn: 'petri', process: 'fresh' }, oracle, oracle, [scoped]);
    expect(same.verdict).toBe('pass');
    expect(same.unusedAttributions).toStrictEqual([scoped]);
  });

  it('never apply to a fresh-run comparison, which has no route', () => {
    const fresh = compareObservations(
      'f',
      { kind: 'resolved', result: { status: 'success' }, trace: [], executions: [{ engine: 'default', workflowId: 'w' }] },
      { kind: 'resolved', result: { status: 'suspended' }, trace: [], executions: [{ engine: 'petri', workflowId: 'w' }] },
      [{ ...scoped, paths: ['result.status'] }],
    );
    expect(fresh.differences).toStrictEqual([{ path: 'result.status', oracle: 'success', candidate: 'suspended' }]);
    expect(fresh.verdict).toBe('fail');
    expect(fresh.unusedAttributions).toStrictEqual([]);
  });
});

describe('the suspend stamp\'s run id is compared on resume', () => {
  it('is not excluded: RESUME_EXCLUDED_PATHS names no __workflow_meta.runId, and a stamp naming another child differs', () => {
    expect(RESUME_EXCLUDED_PATHS.filter((p) => p.includes('__workflow_meta.runId'))).toStrictEqual([]);
    const at = (runId: string): ResumeObservation => ({
      phases: [
        {
          // Two children's run ids first, so each has the same ordinal on both sides; then the stamp.
          outcome: {
            kind: 'resolved',
            result: { a: '0f0f0f0f-0000-4000-8000-000000000000', b: '1f1f1f1f-0000-4000-8000-000000000000', steps: { s: { suspendPayload: { __workflow_meta: { runId } } } } },
          },
          stored: {},
          trace: [],
          executions: [{ engine: 'default', workflowId: 'w' }],
        },
      ],
    });
    const route = { suspendOn: 'default', resumeOn: 'petri', process: 'fresh' } as const;
    // The same child: equal.
    expect(compareResume('f', route, at('0f0f0f0f-0000-4000-8000-000000000000'), at('0f0f0f0f-0000-4000-8000-000000000000'), []).differences).toStrictEqual([]);
    // Another child: a difference.
    expect(compareResume('f', route, at('0f0f0f0f-0000-4000-8000-000000000000'), at('1f1f1f1f-0000-4000-8000-000000000000'), []).differences).toStrictEqual([
      { path: 'phases.0.result.steps.s.suspendPayload.__workflow_meta.runId', oracle: '<uuid#0>', candidate: '<uuid#1>' },
    ]);
  });
});

describe("a stored record's clock stamps on resume", () => {
  it('are masked, not dropped: a stamp one side stores and the other omits is a difference; its value is not', () => {
    const at = (context: Record<string, unknown>): ResumeObservation => ({
      phases: [
        {
          outcome: { kind: 'resolved', result: { status: 'suspended', steps: { g: { status: 'suspended', ...context } } } },
          stored: { w: [{ timestamp: 1, runId: 'r', context: { g: { status: 'suspended', ...context } } }] },
          trace: [],
          executions: [{ engine: 'default', workflowId: 'w' }],
        },
      ],
    });
    const route = { suspendOn: 'default', resumeOn: 'petri', process: 'fresh' } as const;
    expect(compareResume('f', route, at({ startedAt: 1, suspendedAt: 2 }), at({ startedAt: 5, suspendedAt: 9 }), []).differences).toStrictEqual([]);
    expect(compareResume('f', route, at({ startedAt: 1, suspendedAt: 2 }), at({ startedAt: 5 }), []).differences.map((d) => d.path)).toStrictEqual([
      'phases.0.result.steps.g.suspendedAt',
      'phases.0.stored.w.0.context.g.suspendedAt',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// The PLAUSIBLE items, settled on real Mastra
// ---------------------------------------------------------------------------------------------

const fixture = (name: string): ResumeFixture => {
  const f = RESUME_FIXTURES.find((x) => x.name === name);
  if (f === undefined) throw new Error(`no resume fixture '${name}'`);
  return f;
};
const DEFAULT = { suspendOn: 'default', resumeOn: 'default', process: 'fresh' } as const;
const PETRI = { suspendOn: 'petri', resumeOn: 'petri', process: 'fresh' } as const;
const result = (o: Awaited<ReturnType<typeof observeResume>>, i: number): Record<string, unknown> => {
  const p = o.phases[i]!.outcome;
  if (p.kind !== 'resolved') throw new Error(`phase ${i} rejected: ${String(p.error)}`);
  return p.result as Record<string, unknown>;
};
const stored = (o: Awaited<ReturnType<typeof observeResume>>, i: number, wf: string): Record<string, unknown> =>
  o.phases[i]!.stored[wf]![0] as Record<string, unknown>;

describe('settled with real Mastra runs', () => {
  it("label loss: after one arm is resumed by label, Mastra's stored resumeLabels are {} and a second label names nothing — reproduced", async () => {
    const f = fixture('resume-parallel-labels');
    for (const route of [DEFAULT, PETRI]) {
      const o = await observeResume(f, route);
      expect(stored(o, 0, 'rs-labels')['resumeLabels']).toEqual({ 'L-a': { stepId: 'a' }, 'L-b': { stepId: 'b' }, 'L-c': { stepId: 'c' } });
      // 'c' resumed by label: 'a' and 'b' are still suspended, and their labels are gone.
      expect(stored(o, 1, 'rs-labels')).toMatchObject({ status: 'suspended', suspendedPaths: { a: [0, 0], b: [0, 1] } });
      expect(stored(o, 1, 'rs-labels')['resumeLabels']).toEqual({});
      expect(result(o, 1)['resumeLabels']).toEqual({});
      const rejected = o.phases[2]!.outcome;
      expect(rejected.kind).toBe('rejected');
      expect(String((rejected as { error: Error }).error.message)).toMatch(/^Multiple suspended steps found: \[a\], \[b\]/);
      expect(result(o, 4)).toMatchObject({ status: 'success', result: { n: 1 + 1 + (1 + 2) + (1 + 3) } });
    }
  });

  it("a resumed last-entry block: the run's result is the replayed sibling's stored output beside the resumed arm's (row 43)", async () => {
    for (const [name, wf, output] of [
      ['resume-parallel-last', 'rs-par-last', { t: { n: 10 }, g: { n: 1 + 3 } }],
      ['resume-branch-last', 'rs-branch-last', { ba: { n: 1 + 4 }, bb: { n: 10 } }],
    ] as const) {
      for (const route of [DEFAULT, PETRI]) {
        const o = await observeResume(fixture(name), route);
        expect(result(o, 1)['status']).toBe('success');
        expect(result(o, 1)['result']).toStrictEqual(output);
        expect(stored(o, 1, wf)['result']).toStrictEqual(output);
        // The sibling ran once, in the start phase: its output is replayed, never recomputed.
        expect(o.phases[1]!.trace.map((e) => e.label)).not.toContain(name === 'resume-parallel-last' ? 't' : 'bb');
      }
    }
  });

  it("the resumed-block re-stamp: a cancel inside a resumed arm of the last entry leaves Mastra's run successful — the petri engine's cancel wins (row 76)", async () => {
    const f = fixture('resume-cancel-in-last-block');
    const oracle = await observeResume(f, DEFAULT);
    expect(result(oracle, 1)).toMatchObject({ status: 'success', result: { t: { n: 1 }, g: { n: 6 } } });
    expect(stored(oracle, 1, 'rs-cancel-last')).toMatchObject({ status: 'success' });
    const petri = await observeResume(f, PETRI);
    expect(result(petri, 1)).toMatchObject({ status: 'canceled' });
    expect(stored(petri, 1, 'rs-cancel-last')).toMatchObject({ status: 'canceled', activePaths: [0] });
    // Not last: Mastra sees the abort at the next loop top, and both engines cancel.
    const notLast = fixture('resume-cancel-in-block');
    for (const route of [DEFAULT, PETRI]) {
      const o = await observeResume(notLast, route);
      expect(result(o, 1)).toMatchObject({ status: 'canceled' });
      expect(stored(o, 1, 'rs-cancel-block')).toMatchObject({ status: 'canceled', activePaths: [0] });
      expect(o.phases[1]!.trace.map((e) => e.label)).not.toContain('never');
    }
  });

  it("nested-in-foreach run id: Mastra resumes the lowest-index item's child whatever forEachIndex names — the petri engine refuses (row 77)", async () => {
    const f = fixture('resume-foreach-nested');
    const oracle = await observeResume(f, DEFAULT);
    const aggregate = stored(oracle, 0, 'rs-fe-nested')['context'] as Record<string, { suspendPayload: { __workflow_meta: { runId: string; foreachOutput: { metadata: { nestedRunId: string } }[] } } }>;
    const meta = aggregate['rs-fe-child']!.suspendPayload.__workflow_meta;
    const [child0, child1] = meta.foreachOutput.map((e) => e.metadata.nestedRunId);
    expect(meta.runId).toBe(child0);
    expect(child1).not.toBe(child0);
    // forEachIndex 1 names item 1 (input n=2), but the child resumed is item 0's (input n=1): 1 + 10.
    const r1 = result(oracle, 1)['steps'] as Record<string, { suspendPayload: { __workflow_meta: { foreachOutput: { status: string; output?: unknown }[] } } }>;
    expect(r1['rs-fe-child']!.suspendPayload.__workflow_meta.foreachOutput[1]).toMatchObject({ status: 'success', output: { n: 11 } });
    const children = oracle.phases[1]!.stored['rs-fe-child'] as { runId: string; status: string }[];
    expect(children.find((c) => c.runId === child0)).toMatchObject({ status: 'success' });
    expect(children.find((c) => c.runId === child1)).toMatchObject({ status: 'suspended' });
    // Item 0 cannot be resumed any more: its child already ran to success.
    expect(result(oracle, 2)).toMatchObject({ status: 'failed', error: { message: 'This workflow run was not suspended' } });

    const petri = await observeResume(f, PETRI);
    for (const i of [1, 2]) {
      const outcome = petri.phases[i]!.outcome;
      expect(outcome.kind).toBe('rejected');
      expect((outcome as { error: unknown }).error).toBeInstanceOf(UnsupportedRunModeError);
      // Refused by name before anything persists (row 77): the one foreach resume still refused.
      expect((outcome as { error: UnsupportedRunModeError }).error.resume).toStrictEqual({ stepId: 'rs-fe-child', path: [1], reason: 'foreach-nested' });
      expect(petri.phases[i]!.stored).toEqual(petri.phases[0]!.stored);
    }
  });
});

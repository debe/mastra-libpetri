import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  compareRestart,
  crashLabel,
  crashPoints,
  formatRestartReport,
  RESTART_ROUTES,
  restartLabel,
  restartOracle,
  runRestart,
  storageAt,
  type CrashPoint,
  type PersistedRow,
  type RestartAttribution,
  type RestartObservation,
  type RestartVerdict,
} from '../../src/conformance/restart.js';
import { formatVerdicts, matches } from '../../src/conformance/differential.js';
import { BUDGETS, crashRows, RESTART_FIXTURES, toRestartCase } from '../fixtures/mastra-workflows.js';

/**
 * Crash, then restart, on both engines and crossed ([ADR 0010]). Each fixture runs to its end on the
 * writer engine with every persisted row recorded; at every `running` / `waiting` row it wrote — its
 * own or a nested workflow's — a fresh `Mastra` over a fresh store holding storage as it stood then
 * is restarted with `createRun({ runId }).restart()`, once on Mastra's engine (the oracle) and once
 * on the petri engine (the candidate):
 *
 * - `petri>petri` against `petri>default` — the same petri-written row (the start row and every
 *   checkpoint) restarted by each engine. ADR 0010 claims it restarts identically on Mastra's
 *   engine, so **no difference at all** is allowed here, attributed or not.
 * - `default>petri` against `default>default` — Mastra's per-step rows. A difference must be
 *   attributed to rows 91-99, scoped to this route and to the crash points (`activePaths`) it
 *   explains.
 *
 * At every budget k in {1, 2, 4, unbounded}, the petri engine's on both sides of the crash.
 */

const DIVERGENCES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/divergences.md');
const documentedRows = new Set([...readFileSync(DIVERGENCES, 'utf8').matchAll(/^\| (\d+) \|/gm)].map((m) => Number(m[1])));
/** The restart rows of `docs/divergences.md` (ADR 0010): the only ones a restart difference may cite. */
const RESTART_ROWS = new Set([91, 92, 93, 94, 95, 96, 97, 98, 99]);

const budgetName = (k: number | undefined) => (k === undefined ? 'unbounded' : String(k));

/**
 * Differences that are **engine findings, not divergences**: never attributed to a row, reported to
 * the lead, and pinned here so the suite shows them as exactly what they are. A case listed here
 * must still fail with exactly these unattributed paths; once the engine is fixed, the entry goes
 * stale and this test says so.
 *
 * `restart-branch` at Mastra's entry-end row of the `.branch()` (`[1]`, `activeStepsPath {}`, both
 * truthy arms stored `success`): Mastra re-decides and re-runs both arms — under restart
 * `isRestartStep` is defined, so its stored-result short-circuit never applies
 * (`handlers/control-flow.ts:544-553`). The petri engine reuses the stored outputs without running
 * the arms (`gateVerdict` in `src/compiler/gadgets/branch.ts` reuses any stored `success`,
 * restart or not), contradicting ADR 0010 ("a branch re-decides") and row 92 ("re-runs every
 * truthy arm on both engines").
 */
const OPEN_FINDINGS: readonly { fixture: string; route: string; activePaths: readonly number[]; paths: readonly string[] }[] = [
];
const openFinding = (v: RestartVerdict) =>
  OPEN_FINDINGS.find(
    (f) => v.fixture.startsWith(`${f.fixture} `) && restartLabel(v.route) === f.route && f.activePaths.join(',') === v.point.activePaths.join(','),
  );

const ALL: RestartVerdict[] = [];
afterAll(() => {
  if (ALL.length === 0) return;
  const report = formatRestartReport(ALL);
  console.log(report);
  const out = process.env['RESTART_DIFFERENTIAL_REPORT'];
  if (out !== undefined && out !== '') writeFileSync(out, `${report}\n`);
});

describe('the routes', () => {
  it('are petri>petri against petri>default and default>petri against default>default', () => {
    expect(RESTART_ROUTES.map(restartLabel)).toEqual(['petri>petri', 'default>petri']);
    expect(RESTART_ROUTES.map((r) => restartLabel(restartOracle(r)))).toEqual(['petri>default', 'default>default']);
  });
});

for (const k of BUDGETS) {
  describe(`crash at every row, then restart, petri budget k = ${budgetName(k)}`, () => {
    for (const fixture of RESTART_FIXTURES) {
      it(fixture.name, async () => {
        // The fixture exercised what it meant to: the uninterrupted run, on the oracle.
        expect((await crashRows(fixture, 'default')).outcome).toBe(fixture.expected);
        expect((await crashRows(fixture, 'petri', k)).outcome).toBe(fixture.expected);

        const c = toRestartCase(fixture, k);
        const verdicts = await runRestart(c);
        ALL.push(...verdicts);
        const report = formatVerdicts(verdicts);
        for (const route of RESTART_ROUTES) expect(verdicts.filter((v) => v.route === route).length, report).toBeGreaterThan(0);

        for (const v of verdicts) {
          // Engine identity: each restart ran on its engine only, nested workflows included.
          expect(v.identity, report).toEqual([]);
          expect(v.executions.oracle.petri).toBe(0);
          expect(v.executions.candidate.default).toBe(0);
          expect(v.budget, report).toEqual([]);
          expect(v.measurements.concurrency).toBe(k ?? 'unbounded');
          if (k !== undefined) expect(v.measurements.peakInFlight.candidate).toBeLessThanOrEqual(k);
          expect(v.ordering.reversed, report).toEqual([]);
          expect(v.ordering.inverted, report).toEqual([]);

          const open = openFinding(v);
          if (open !== undefined) {
            expect(v.verdict, report).toBe('fail');
            expect(v.differences.map((d) => ({ path: d.path, row: d.row })), report).toEqual(open.paths.map((path) => ({ path, row: undefined })));
            continue;
          }
          if (v.route.writtenBy === 'petri') {
            // ADR 0010: a petri-written row restarts identically on Mastra's engine.
            expect(v.differences, report).toEqual([]);
            expect(v.verdict).toBe('pass');
          } else {
            for (const d of v.differences) {
              expect({ path: d.path, row: d.row, documented: d.row !== undefined && documentedRows.has(d.row) && RESTART_ROWS.has(d.row) }, report).toEqual({
                path: d.path,
                row: d.row,
                documented: true,
              });
            }
            expect(v.verdict, report).not.toBe('fail');
          }
        }

        // Every attribution explains something at some crash point where it applies: a stale one fails.
        const stale = (c.divergences ?? []).filter((at) => verdicts.every((v) => !v.differences.some((d) => d.row === at.row && at.paths.some((p) => matches(p, d.path)))));
        expect(stale.map((at) => `row ${at.row}: ${at.reason}`)).toEqual([]);
        // An open finding that no longer shows is stale too: the engine was fixed, drop the entry.
        for (const f of OPEN_FINDINGS.filter((x) => x.fixture === fixture.name)) {
          expect(verdicts.some((v) => openFinding(v) === f), `open finding on ${f.fixture} [${f.route}] no longer shows`).toBe(true);
        }
      });
    }
  });
}

describe('crash points', () => {
  const row = (workflowName: string, status: string, activePaths: number[], extra: Record<string, unknown> = {}): PersistedRow => ({
    workflowName,
    runId: 'r',
    snapshot: { status, activePaths, activeStepsPath: {}, ...extra },
  });
  const rows = [
    row('w', 'pending', []),
    row('w', 'running', [0]),
    row('w', 'running', [1], { activeStepsPath: { inner: [1] } }),
    row('inner', 'pending', []),
    row('inner', 'running', [0]),
    row('inner', 'success', [1]),
    row('w', 'waiting', [2]),
    row('w', 'success', [2]),
  ];

  it('are every running or waiting write, nested ones included, named by the top-level row in storage then', () => {
    expect(crashPoints(rows, 'w').map((p) => crashLabel(p, 'w'))).toEqual([
      '@1 running [0]',
      '@2 running [1]',
      '@4 running [1] after inner',
      '@6 waiting [2]',
    ]);
    expect(crashPoints(rows, 'w')[2]).toMatchObject({ writer: 'inner', activeStepsPath: { inner: [1] } });
  });

  it('seed storage as it stood just after the write: the latest row per workflow and run', () => {
    expect(storageAt(rows, 4).map((r) => [r.workflowName, (r.snapshot as { status: string }).status])).toEqual([
      ['w', 'running'],
      ['inner', 'running'],
    ]);
    expect(storageAt(rows, 2).map((r) => r.workflowName)).toEqual(['w']);
  });
});

describe('restart attributions', () => {
  const at = (activePaths: number[]): CrashPoint => ({ index: 1, writer: 'w', status: 'running', activePaths, activeStepsPath: {} });
  const observation = (labels: string[]): RestartObservation => ({
    outcome: { kind: 'resolved', result: { status: 'success' } },
    stored: {},
    trace: labels.flatMap((label) => [
      { kind: 'start' as const, label },
      { kind: 'end' as const, label },
    ]),
    executions: [{ engine: 'default', workflowId: 'w' }],
    writes: 1,
  });
  const scoped: RestartAttribution = { row: 92, paths: ['trace.x#0'], reason: 'scoped', routes: ['default>petri'], activePaths: [[1]] };
  const oracle = observation([]);
  const candidate = { ...observation(['x']), executions: [{ engine: 'petri' as const, workflowId: 'w' }] };
  const defaultRoute = RESTART_ROUTES[1]!;
  const petriRoute = RESTART_ROUTES[0]!;

  it('attribute only on the routes and at the crash points they name', () => {
    expect(compareRestart('f', 'w', defaultRoute, at([1]), oracle, candidate, [scoped]).verdict).toBe('divergent');
    expect(compareRestart('f', 'w', defaultRoute, at([1, 0]), oracle, candidate, [scoped]).verdict).toBe('fail');
    expect(compareRestart('f', 'w', petriRoute, at([1]), oracle, candidate, [scoped]).verdict).toBe('fail');
  });

  it('fail on identity whatever is attributed: the oracle restarts on default, the candidate on petri', () => {
    const v = compareRestart('f', 'w', defaultRoute, at([1]), oracle, { ...candidate, executions: [{ engine: 'default', workflowId: 'w' }] }, [scoped]);
    expect(v.identity).toEqual(["candidate executed 'w' on the default engine, expected petri"]);
    expect(v.verdict).toBe('fail');
  });
});

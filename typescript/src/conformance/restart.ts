/**
 * The restart differential ([ADR 0010]): a run crashes, and a new process restarts it from what it
 * finds in storage.
 *
 * A crash is simulated by recording every `WorkflowRunState` a run persists, in order. For a run on
 * engine A (the *writer*), each `running` or `waiting` row the top-level workflow wrote is one
 * crash point: a fresh store is seeded with storage **as it stood just after that write** — the
 * latest row per `(workflow, run)`, so a nested workflow's own row is there when it had written one
 * — and a fresh engine B restarts the run with Mastra's `createRun({ runId }).restart()`.
 *
 * Every crash point is restarted twice, from the same seed: once on Mastra's engine (the oracle)
 * and once on the petri engine (the candidate). So the routes are
 *
 * - `petri>petri` against `petri>default` — the same petri-written row, restarted by each engine.
 *   ADR 0010 claims a petri checkpoint row restarts identically on Mastra's engine;
 * - `default>petri` against `default>default` — rows written by Mastra's engine, which writes at
 *   every step's start and end, so they name positions a petri run never stores.
 *
 * Compared, per crash point, by the gates of `differential.ts`: identity (each restart ran on its
 * engine only, nested workflows included, executing the same workflows as often), the data — what
 * `restart()` returned or threw (`result.<…>`, `error.<…>`, `kind`) and every row in storage after
 * it, which is the terminal row (`stored.<workflow>.<n>.<…>`) — the steps re-run and their
 * happens-before (`trace.<label>`, `order.<a>.<b>`), and the candidate's run budget. Excluded are
 * exactly {@link RESUME_EXCLUDED_PATHS}: clock stamps masked to their presence, run/trace ids.
 * Events are not compared here: the restart differential is about what re-runs and what is
 * stored. The rows each restart wrote are counted and reported, not compared — Mastra writes per
 * step, this engine at checkpoints and the terminal (`docs/divergences.md` row 55).
 *
 * An {@link RestartAttribution} may be scoped to routes (as on a resume) and to crash points (the
 * stored `activePaths` it explains), so an attribution never explains a difference at a position
 * it was not written for.
 *
 * Host-free (ADR 0005): the fixture injects how a run crashes and how it is restarted.
 */
import {
  clockMasked,
  compareOrder,
  diff,
  formatDifferentialReport,
  normalise,
  peakInFlight,
  RESUME_EXCLUDED_PATHS,
  settle,
  type Attribution,
  type CompareOptions,
  type EngineName,
  type Execution,
  type IndependentPair,
  type ResumeRouteLabel,
  type TraceEvent,
  type Verdict,
} from './differential.js';

/** One `persistWorkflowSnapshot` call, as the recording store saw it. */
export interface PersistedRow {
  readonly workflowName: string;
  readonly runId: string;
  readonly snapshot: unknown;
}

/** Which engine wrote the rows, and which one restarts from them. */
export interface RestartRoute {
  readonly writtenBy: EngineName;
  readonly restartOn: EngineName;
}

/** The candidate routes: every row restarted on the petri engine. */
export const RESTART_ROUTES: readonly RestartRoute[] = [
  { writtenBy: 'petri', restartOn: 'petri' },
  { writtenBy: 'default', restartOn: 'petri' },
];

/** The oracle of a route: the same rows, restarted on Mastra's engine. */
export function restartOracle(route: RestartRoute): RestartRoute {
  return { writtenBy: route.writtenBy, restartOn: 'default' };
}

/** `petri>default`, …: the writer, then the engine that restarts. A {@link ResumeRouteLabel}, so attributions scope alike. */
export function restartLabel(route: RestartRoute): ResumeRouteLabel {
  return `${route.writtenBy}>${route.restartOn}`;
}

/**
 * A crash point: the run died just after write `index`. The row that write stored may be a nested
 * workflow's (`writer`); what a restart reads first is the top-level row in storage at that moment,
 * whose `status`, `activePaths` and `activeStepsPath` are given here.
 */
export interface CrashPoint {
  /** The write's position among every write of the crash run, nested workflows' included. */
  readonly index: number;
  /** The workflow whose row that write stored: the top-level one, or a nested one. */
  readonly writer: string;
  readonly status: string;
  readonly activePaths: readonly number[];
  readonly activeStepsPath: Readonly<Record<string, readonly number[]>>;
}

/** `@3 running [1,0]`, or `@5 running [1] after rt-inner`: how reports name a crash point. */
export function crashLabel(p: CrashPoint, workflowName?: string): string {
  const nested = workflowName !== undefined && p.writer !== workflowName ? ` after ${p.writer}` : '';
  return `@${p.index} ${p.status} [${p.activePaths.join(',')}]${nested}`;
}

/**
 * Every write the run made while active — a row of status `running` or `waiting`, the only ones
 * Mastra restarts (`utils.ts:585-599`), of the top-level workflow or a nested one — at which the
 * top-level row in storage is itself active, in write order.
 */
export function crashPoints(rows: readonly PersistedRow[], workflowName: string): CrashPoint[] {
  const out: CrashPoint[] = [];
  let top: Record<string, unknown> | undefined;
  rows.forEach((r, index) => {
    if (!isRecord(r.snapshot)) return;
    if (r.workflowName === workflowName) top = r.snapshot;
    if (!isActive(r.snapshot) || top === undefined || !isActive(top)) return;
    const paths = top['activePaths'];
    const steps = top['activeStepsPath'];
    out.push({
      index,
      writer: r.workflowName,
      status: String(top['status']),
      activePaths: Array.isArray(paths) ? paths.filter((n): n is number => typeof n === 'number') : [],
      activeStepsPath: isRecord(steps) ? (structuredClone(steps) as Record<string, number[]>) : {},
    });
  });
  return out;
}

function isActive(snapshot: Record<string, unknown>): boolean {
  return snapshot['status'] === 'running' || snapshot['status'] === 'waiting';
}

/** Storage just after write `index`: the latest row per `(workflow, run)`, in first-write order. */
export function storageAt(rows: readonly PersistedRow[], index: number): PersistedRow[] {
  const latest = new Map<string, PersistedRow>();
  for (const r of rows.slice(0, index + 1)) latest.set(JSON.stringify([r.workflowName, r.runId]), r);
  return [...latest.values()].map((r) => ({ ...r, snapshot: structuredClone(r.snapshot) }));
}

/** What one restart did: its outcome, storage after it, the steps it ran, and its `execute()` calls. */
export interface RestartObservation {
  readonly outcome: { readonly kind: 'resolved'; readonly result: unknown } | { readonly kind: 'rejected'; readonly error: unknown };
  /** Every `WorkflowRunState` in storage after the restart, by workflow name. */
  readonly stored: Readonly<Record<string, readonly unknown[]>>;
  readonly trace: readonly TraceEvent[];
  readonly executions: readonly Execution[];
  /** How many rows the restart persisted: reported, never compared (row 55). */
  readonly writes: number;
}

/** An {@link Attribution}, optionally scoped to the crash points whose stored `activePaths` it names. */
export interface RestartAttribution extends Attribution {
  readonly activePaths?: readonly (readonly number[])[];
}

export interface RestartCase {
  readonly name: string;
  /** The top-level workflow's storage name: its rows are the crash points. */
  readonly workflowName: string;
  /** Runs the fixture to its end on `writer`, recording every row it persists. */
  readonly crash: (writer: EngineName) => Promise<readonly PersistedRow[]>;
  /** Seeds a fresh store with `seed` and restarts the run on a fresh `engine`. */
  readonly restart: (engine: EngineName, seed: readonly PersistedRow[]) => Promise<RestartObservation>;
  /** Paths `kind`, `result.<…>`, `error.<…>`, `stored.<workflow>.<n>.<…>`, `trace.<label>`, `order.<a>.<b>`. */
  readonly divergences?: readonly RestartAttribution[];
  readonly independent?: readonly IndependentPair[];
  /** The petri engine's run budget, gated on the candidate restart; absent, unbounded. */
  readonly concurrency?: number;
  readonly routes?: readonly RestartRoute[];
}

export interface RestartVerdict extends Verdict {
  readonly route: RestartRoute;
  readonly point: CrashPoint;
  /** Rows each restart persisted. */
  readonly writes: { readonly oracle: number; readonly candidate: number };
}

/** Whether `at` may attribute at this route and crash point. */
function appliesAt(at: RestartAttribution, route: RestartRoute, point: CrashPoint): boolean {
  if (at.routes !== undefined && !at.routes.includes(restartLabel(route))) return false;
  if (at.activePaths !== undefined && !at.activePaths.some((p) => samePath(p, point.activePaths))) return false;
  return true;
}

function samePath(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i]);
}

/**
 * Per route: crash the run once on the writer, then for every crash point restart it on the oracle
 * and on the candidate, sequentially, and compare.
 */
export async function runRestart(c: RestartCase): Promise<RestartVerdict[]> {
  const verdicts: RestartVerdict[] = [];
  for (const route of c.routes ?? RESTART_ROUTES) {
    const rows = await c.crash(route.writtenBy);
    const points = crashPoints(rows, c.workflowName);
    if (points.length === 0) throw new Error(`${c.name}: the ${route.writtenBy} engine wrote no running or waiting row`);
    for (const point of points) {
      const seed = storageAt(rows, point.index);
      const timed = async (engine: EngineName) => {
        const t0 = performance.now();
        const observation = await c.restart(engine, seed);
        return { observation, ms: performance.now() - t0 };
      };
      const oracle = await timed(restartOracle(route).restartOn);
      const candidate = await timed(route.restartOn);
      verdicts.push(
        compareRestart(c.name, c.workflowName, route, point, oracle.observation, candidate.observation, c.divergences ?? [], c.independent ?? [], {
          ...(c.concurrency === undefined ? {} : { concurrency: c.concurrency }),
          wallMs: { oracle: oracle.ms, candidate: candidate.ms },
        }),
      );
    }
  }
  return verdicts;
}

/** One crash point, restarted on the oracle and on the candidate, compared. Pure. */
export function compareRestart(
  name: string,
  workflowName: string,
  route: RestartRoute,
  point: CrashPoint,
  oracle: RestartObservation,
  candidate: RestartObservation,
  attributions: readonly RestartAttribution[],
  independent: readonly IndependentPair[] = [],
  options: CompareOptions = {},
): RestartVerdict {
  const oracleEngine = restartOracle(route).restartOn;
  const identity = restartIdentity(oracle, oracleEngine, candidate, route.restartOn);
  const raw: { path: string; oracle: unknown; candidate: unknown }[] = [];
  const ou = new Map<string, number>();
  const cu = new Map<string, number>();
  const [excluded, masked] = clockMasked(RESUME_EXCLUDED_PATHS);

  if (oracle.outcome.kind !== candidate.outcome.kind) {
    raw.push({ path: 'kind', oracle: oracle.outcome.kind, candidate: candidate.outcome.kind });
  } else {
    const root = oracle.outcome.kind === 'resolved' ? 'result' : 'error';
    const a = oracle.outcome.kind === 'resolved' ? oracle.outcome.result : oracle.outcome.error;
    const b = candidate.outcome.kind === 'resolved' ? candidate.outcome.result : candidate.outcome.error;
    diff(normalise(a, [root], ou, excluded, masked), normalise(b, [root], cu, excluded, masked), [root], raw);
  }
  diff(normalise(oracle.stored, ['stored'], ou, excluded, masked), normalise(candidate.stored, ['stored'], cu, excluded, masked), ['stored'], raw);

  const ordering = compareOrder(oracle.trace, candidate.trace, independent);
  for (const label of ordering.onlyOracle) raw.push({ path: `trace.${label}`, oracle: 'ran', candidate: 'did not run' });
  for (const label of ordering.onlyCandidate) raw.push({ path: `trace.${label}`, oracle: 'did not run', candidate: 'ran' });
  for (const [a, b] of ordering.report.reversed) raw.push({ path: `order.${a}.${b}`, oracle: `${a} before ${b}`, candidate: `${b} before ${a}` });
  for (const [a, b] of ordering.report.inverted) raw.push({ path: `order.${a}.${b}`, oracle: `${a} before ${b}`, candidate: `${b} started before ${a} ended` });

  const k = options.concurrency;
  const peak = { oracle: peakInFlight(oracle.trace), candidate: peakInFlight(candidate.trace) };
  const budget = k !== undefined && route.restartOn === 'petri' && peak.candidate > k ? [`candidate had ${peak.candidate} steps in flight at once, above its budget of ${k}`] : [];

  const { differences, unused, verdict } = settle(raw, attributions, (at) => appliesAt(at, route, point), identity.length > 0 || budget.length > 0);
  return {
    fixture: `${name} ${crashLabel(point, workflowName)} [${restartLabel(route)}]`,
    route,
    point,
    verdict,
    oracleOutcome: outcomeOf(oracle),
    identity,
    executions: { oracle: countByEngine(oracle.executions), candidate: countByEngine(candidate.executions) },
    differences,
    ordering: ordering.report,
    unusedAttributions: unused,
    budget,
    measurements: {
      concurrency: k ?? 'unbounded',
      peakInFlight: peak,
      wallMs: { oracle: options.wallMs?.oracle ?? null, candidate: options.wallMs?.candidate ?? null },
    },
    writes: { oracle: oracle.writes, candidate: candidate.writes },
  };
}

/**
 * Identity of one restart pair: each side ran on its engine only, a resolved restart went through
 * `execute()`, and both executed the same workflows the same number of times — unless one side
 * resolved and the other rejected, which is a data difference (`kind`).
 */
function restartIdentity(oracle: RestartObservation, oracleEngine: EngineName, candidate: RestartObservation, candidateEngine: EngineName): string[] {
  const problems: string[] = [];
  for (const [o, side, engine] of [
    [oracle, 'oracle', oracleEngine],
    [candidate, 'candidate', candidateEngine],
  ] as const) {
    for (const e of o.executions) if (e.engine !== engine) problems.push(`${side} executed '${e.workflowId}' on the ${e.engine} engine, expected ${engine}`);
    if (o.outcome.kind === 'resolved' && o.executions.length === 0) problems.push(`${side} resolved without any engine's execute()`);
  }
  if (oracle.outcome.kind !== candidate.outcome.kind) return problems;
  const perWorkflow = (o: RestartObservation) => {
    const m = new Map<string, number>();
    for (const e of o.executions) m.set(e.workflowId, (m.get(e.workflowId) ?? 0) + 1);
    return m;
  };
  const a = perWorkflow(oracle);
  const b = perWorkflow(candidate);
  for (const id of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(id) ?? 0;
    const y = b.get(id) ?? 0;
    if (x !== y) problems.push(`'${id}' executed ${x} time(s) by the oracle, ${y} by the candidate`);
  }
  return problems;
}

function countByEngine(executions: readonly Execution[]): Record<EngineName, number> {
  const out: Record<EngineName, number> = { default: 0, petri: 0 };
  for (const e of executions) out[e.engine] += 1;
  return out;
}

function outcomeOf(o: RestartObservation): string {
  if (o.outcome.kind === 'rejected') return 'rejected';
  const status = isRecord(o.outcome.result) ? o.outcome.result['status'] : undefined;
  return typeof status === 'string' ? status : 'unknown';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * The restart report: {@link formatDifferentialReport} over the crash-point-named verdicts, then the
 * rows each restart wrote, per crash point (oracle/candidate).
 */
export function formatRestartReport(verdicts: readonly RestartVerdict[]): string {
  const lines = [formatDifferentialReport(verdicts), '', 'rows written by each restart (oracle/petri)'];
  for (const v of verdicts) lines.push(`${v.fixture} k=${v.measurements.concurrency}: ${v.writes.oracle}/${v.writes.candidate}`);
  return lines.join('\n');
}

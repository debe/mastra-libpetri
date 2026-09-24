/**
 * The differential harness: one fixture, run on Mastra's `DefaultExecutionEngine` (the oracle) and
 * on `PetriExecutionEngine` (the candidate) in one process, compared four ways.
 *
 * 0. **Engine identity — the gate, never attributable.** Each observation carries the
 *    `execute()` calls every engine received while it ran, nested workflows included. The oracle
 *    may show no candidate call, the candidate no oracle call, and both must have executed the same
 *    workflows the same number of times. Without it, a candidate that silently ran on Mastra's own
 *    engine would agree with the oracle on everything.
 * 1. **Data equivalence — the gate.** The whole observation: the run's status, result, error,
 *    tripwire, every step record (status, output, payload, suspendPayload, error …), the workflow
 *    state, the execution path, and a rejected `start()` when there is one. Excluded, and nothing
 *    else:
 *    - the paths in {@link EXCLUDED_PATHS} — timestamps and run/trace/span ids, **at the positions
 *      where Mastra writes them** (the result's top level, a step record's top level, a suspend
 *      stamp). The same key inside user data — an output, a payload, the state — is compared.
 *    - UUIDs inside strings and keys, replaced by an ordinal placeholder per observation (`<uuid#0>`,
 *      `<uuid#1>`, … in first-seen order). Mastra mints `sleep_<uuid>` step ids per build, and each
 *      engine needs its own build; the ordinal keeps two distinct UUIDs distinct, so two sleeps'
 *      records never collapse onto one key. A key that still collides after rewriting throws.
 *    - What `Object.keys` and own enumerable symbols do not reach: non-enumerable own properties
 *      (an `Error`'s `stack` among them — a call-site address) and prototype getters. An `Error`
 *      contributes its `name`, `message` and `cause` explicitly.
 *    A `Map` is compared as its entries, a `Set` as its values, a `Date` as its instant, an array
 *    hole as a hole, and any non-plain object carries its constructor's name.
 * 2. **Happens-before — the gate.** From each engine's step trace, `a -> b` when `a` ended before
 *    `b` started. An oracle ordering the candidate lacks is gated: either it is *reversed* (`b`
 *    ended before `a` started) or *inverted* (`b` started before `a` ended). Only a pair the
 *    fixture declares independent may weaken — the net's partial order, `docs/divergences.md`
 *    row 4 — and it is then reported, not gated.
 * 3. **The ordering report — not a gate.** Weakened (declared independent) and strengthened
 *    pairs, listed. A strengthening — the candidate orders a pair the oracle overlapped, as a run
 *    budget of k serialising a `.parallel()`'s arms does ([ADR 0006]) — is allowed and never
 *    silent: {@link formatDifferentialReport} lists every one, per fixture and budget.
 * 4. **The run budget — the gate.** A case may name the candidate's `concurrency` (k): the most
 *    steps it may have in flight at once. The peak is read off each side's trace (open spans at
 *    once); a candidate peak above k fails the fixture, and no attribution can rescue it. Each
 *    side's wall time is measured too — reported, never gated.
 *
 * A difference is `divergent` only when an {@link Attribution} naming a `docs/divergences.md` row
 * covers its path; an unattributed difference makes the fixture `fail`.
 *
 * Host-free by construction (ADR 0005): a fixture's `run` is injected, so this file never reaches
 * Mastra. The Mastra side — including how `execute()` calls are observed — lives with the fixtures.
 */

/** The two engines compared: Mastra's own is always the oracle. */
export type EngineName = 'default' | 'petri';

/** One step boundary, as the instrumented step code saw it. */
export interface TraceEvent {
  readonly kind: 'start' | 'end';
  /** The step's identity within the run: its id, plus whatever tells repeated runs apart. */
  readonly label: string;
}

/** One `execute()` call an engine received during an observation: the top-level run or a nested one. */
export interface Execution {
  readonly engine: EngineName;
  readonly workflowId: string;
}

/** What one engine produced for one fixture. */
export type Observation =
  | {
      readonly kind: 'resolved';
      readonly result: unknown;
      readonly trace: readonly TraceEvent[];
      readonly executions: readonly Execution[];
    }
  | {
      readonly kind: 'rejected';
      readonly error: unknown;
      readonly trace: readonly TraceEvent[];
      readonly executions: readonly Execution[];
    };

/**
 * A known, documented difference: every difference whose path matches one of `paths` is
 * attributed to `row` of `docs/divergences.md`. Paths are dot-separated; `*` matches one segment,
 * a trailing `**` any rest (including none).
 *
 * Paths: `kind` (resolved on one engine, rejected on the other), `result.<…>` (the formatted
 * result), `error.<…>` (a rejection), `trace.<label>` (a step that ran on one engine only),
 * `order.<a>.<b>` (an oracle ordering the candidate reversed or inverted). A trace label may not
 * contain a dot. Engine identity is never attributable.
 */
export interface Attribution {
  readonly row: number;
  readonly paths: readonly string[];
  readonly reason: string;
}

/**
 * Two steps the fixture declares independent: neither reads what the other writes, so the net may
 * run them in either order or together (`docs/divergences.md` row 4). A label matches a span with
 * any occurrence suffix (`b` matches `b#0`, `b#1`); a full key (`b#1`) matches only itself.
 */
export type IndependentPair = readonly [string, string];

/** A fixture as the harness sees it: a name, an input and a way to run it on either engine. */
export interface DifferentialCase<I = unknown> {
  readonly name: string;
  readonly input: I;
  readonly run: (engine: EngineName, input: I) => Promise<Observation>;
  readonly divergences?: readonly Attribution[];
  readonly independent?: readonly IndependentPair[];
  /**
   * The candidate's run budget — at most this many steps in flight ([ADR 0006]) — as `run` builds
   * it; absent, unbounded. The harness does not configure the engine, it checks the trace.
   */
  readonly concurrency?: number;
}

/** A budget as reports print it: the number, or `unbounded`. */
export type BudgetLabel = number | 'unbounded';

/** Per-side measurements of one fixture: reported; only the candidate's peak against k is gated. */
export interface Measurements {
  /** The candidate's budget, or `unbounded`. */
  readonly concurrency: BudgetLabel;
  /** Most traced steps open at once, per side ({@link peakInFlight}). */
  readonly peakInFlight: { readonly oracle: number; readonly candidate: number };
  /** Wall time of each side's `run`, in milliseconds (`performance.now()`), or `null` when not measured. */
  readonly wallMs: { readonly oracle: number | null; readonly candidate: number | null };
}

export interface Difference {
  readonly path: string;
  readonly oracle: unknown;
  readonly candidate: unknown;
  /** The divergence row that explains it; absent means unattributed, a finding. */
  readonly row?: number;
}

export interface OrderingReport {
  /** Start order of the oracle's steps, as labelled. */
  readonly oracleStarts: readonly string[];
  readonly candidateStarts: readonly string[];
  /** Oracle `a -> b` the candidate lacks, on a pair declared independent: reported, not gated. */
  readonly weakened: readonly (readonly [string, string])[];
  /** Oracle `a -> b` where the candidate started `b` before `a` ended (and `b` did not end first). Gated. */
  readonly inverted: readonly (readonly [string, string])[];
  /** Oracle `a -> b` where the candidate has `b -> a`. Gated. */
  readonly reversed: readonly (readonly [string, string])[];
  /** Candidate orderings the oracle does not have, and whose reverse it does not have either. */
  readonly strengthened: readonly (readonly [string, string])[];
}

export type VerdictKind = 'pass' | 'divergent' | 'fail';

export interface Verdict {
  readonly fixture: string;
  readonly verdict: VerdictKind;
  /**
   * What the oracle did — its result's `status`, or `rejected` — so a caller can check the fixture
   * exercised what it meant to: two engines failing identically on a broken fixture also agree.
   */
  readonly oracleOutcome: string;
  /** Why the two observations are not oracle-vs-candidate. Non-empty makes the verdict `fail`. */
  readonly identity: readonly string[];
  /** `execute()` calls per engine, per side: `{oracle: {default, petri}, candidate: {default, petri}}`. */
  readonly executions: {
    readonly oracle: Readonly<Record<EngineName, number>>;
    readonly candidate: Readonly<Record<EngineName, number>>;
  };
  /** Every gated difference, attributed or not. */
  readonly differences: readonly Difference[];
  readonly ordering: OrderingReport;
  /** Declared attributions that matched nothing in this run. A caller gates it: a stale row. */
  readonly unusedAttributions: readonly Attribution[];
  /** Why the candidate broke its run budget. Non-empty makes the verdict `fail`; never attributable. */
  readonly budget: readonly string[];
  readonly measurements: Measurements;
}

/**
 * The only positions excluded from comparison: timestamps and run/trace/span ids where Mastra
 * writes them. Patterns as {@link matches}, over the normalised path.
 *
 * - `result.runId` — spread into every result (`default.ts:1050-1058`); `traceId`/`spanId` beside
 *   it when tracing is on.
 * - `result.steps.*.{startedAt,endedAt,suspendedAt,resumedAt,pausedAt}` — a step record's clock
 *   fields (`default.ts:470-510`, `handlers/entry.ts:602-609`).
 * - `result.steps.*.suspendPayload.__workflow_meta.runId` — the suspend stamp's run id.
 */
export const EXCLUDED_PATHS: readonly string[] = [
  'result.runId',
  'result.traceId',
  'result.spanId',
  ...['startedAt', 'endedAt', 'suspendedAt', 'resumedAt', 'pausedAt'].map((k) => `result.steps.*.${k}`),
  'result.steps.*.suspendPayload.__workflow_meta.runId',
];

/** A UUID inside a string — minted per build or per run, so an id. */
export const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Runs the fixture on the oracle, then on the candidate — sequentially, never interleaved — timing each. */
export async function runBoth<I>(fixture: DifferentialCase<I>, input: I = fixture.input): Promise<Verdict> {
  const timed = async (engine: EngineName) => {
    const t0 = performance.now();
    const observation = await fixture.run(engine, input);
    return { observation, ms: performance.now() - t0 };
  };
  const oracle = await timed('default');
  const candidate = await timed('petri');
  return compareObservations(fixture.name, oracle.observation, candidate.observation, fixture.divergences ?? [], fixture.independent ?? [], {
    ...(fixture.concurrency === undefined ? {} : { concurrency: fixture.concurrency }),
    wallMs: { oracle: oracle.ms, candidate: candidate.ms },
  });
}

/** What {@link compareObservations} is told beyond the two observations: the budget and the timings. */
export interface CompareOptions {
  /** The candidate's run budget; absent, unbounded and nothing is gated. */
  readonly concurrency?: number;
  readonly wallMs?: { readonly oracle: number; readonly candidate: number };
}

/** The whole comparison, pure: identity, data, happens-before, the budget, then the verdict. */
export function compareObservations(
  name: string,
  oracle: Observation,
  candidate: Observation,
  attributions: readonly Attribution[],
  independent: readonly IndependentPair[] = [],
  options: CompareOptions = {},
): Verdict {
  const identity = engineIdentity(oracle, candidate);
  const k = options.concurrency;
  const peak = { oracle: peakInFlight(oracle.trace), candidate: peakInFlight(candidate.trace) };
  const budget = k !== undefined && peak.candidate > k ? [`candidate had ${peak.candidate} steps in flight at once, above its budget of ${k}`] : [];
  const raw: { path: string; oracle: unknown; candidate: unknown }[] = [];

  if (oracle.kind !== candidate.kind) {
    raw.push({ path: 'kind', oracle: oracle.kind, candidate: candidate.kind });
  } else {
    const root = oracle.kind === 'resolved' ? 'result' : 'error';
    const a = oracle.kind === 'resolved' ? oracle.result : oracle.error;
    const b = candidate.kind === 'resolved' ? candidate.result : candidate.error;
    diff(normalise(a, [root]), normalise(b, [root]), [root], raw);
  }

  const ordering = compareOrder(oracle.trace, candidate.trace, independent);
  for (const label of ordering.onlyOracle) raw.push({ path: `trace.${label}`, oracle: 'ran', candidate: 'did not run' });
  for (const label of ordering.onlyCandidate) raw.push({ path: `trace.${label}`, oracle: 'did not run', candidate: 'ran' });
  for (const [a, b] of ordering.report.reversed) raw.push({ path: `order.${a}.${b}`, oracle: `${a} before ${b}`, candidate: `${b} before ${a}` });
  for (const [a, b] of ordering.report.inverted) {
    raw.push({ path: `order.${a}.${b}`, oracle: `${a} before ${b}`, candidate: `${b} started before ${a} ended` });
  }

  const used = new Set<Attribution>();
  const differences: Difference[] = raw.map((d) => {
    const hit = attributions.find((at) => at.paths.some((p) => matches(p, d.path)));
    if (hit === undefined) return d;
    used.add(hit);
    return { ...d, row: hit.row };
  });

  const verdict: VerdictKind =
    identity.length > 0 || budget.length > 0
      ? 'fail'
      : differences.length === 0
        ? 'pass'
        : differences.every((d) => d.row !== undefined)
          ? 'divergent'
          : 'fail';
  return {
    fixture: name,
    verdict,
    oracleOutcome: outcomeOf(oracle),
    identity,
    executions: { oracle: countByEngine(oracle.executions), candidate: countByEngine(candidate.executions) },
    differences,
    ordering: ordering.report,
    unusedAttributions: attributions.filter((at) => !used.has(at)),
    budget,
    measurements: {
      concurrency: k ?? 'unbounded',
      peakInFlight: peak,
      wallMs: { oracle: options.wallMs?.oracle ?? null, candidate: options.wallMs?.candidate ?? null },
    },
  };
}

/**
 * The most steps a trace had open at once: +1 at each `start`, -1 at each `end` closing an open
 * one, in trace order. A step that never ended stays open to the end of the trace.
 */
export function peakInFlight(trace: readonly TraceEvent[]): number {
  const open = new Map<string, number>();
  let now = 0;
  let peak = 0;
  for (const e of trace) {
    const n = open.get(e.label) ?? 0;
    if (e.kind === 'start') {
      open.set(e.label, n + 1);
      now += 1;
      peak = Math.max(peak, now);
    } else if (n > 0) {
      open.set(e.label, n - 1);
      now -= 1;
    }
  }
  return peak;
}

/**
 * Engine identity: the oracle ran on Mastra's engine only, the candidate on ours only, and both
 * executed the same workflows the same number of times — so a nested workflow that fell back to
 * the default engine shows here. A resolved run went through `execute()` at least once.
 */
function engineIdentity(oracle: Observation, candidate: Observation): string[] {
  const problems: string[] = [];
  const stray = (o: Observation, side: string, wrong: EngineName) => {
    for (const e of o.executions) if (e.engine === wrong) problems.push(`${side} executed '${e.workflowId}' on the ${wrong} engine`);
  };
  stray(oracle, 'oracle', 'petri');
  stray(candidate, 'candidate', 'default');
  for (const [o, side] of [
    [oracle, 'oracle'],
    [candidate, 'candidate'],
  ] as const) {
    if (o.kind === 'resolved' && o.executions.length === 0) problems.push(`${side} resolved without any engine's execute()`);
  }
  const perWorkflow = (o: Observation) => {
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

function outcomeOf(o: Observation): string {
  if (o.kind === 'rejected') return 'rejected';
  const status = isRecord(o.result) ? o.result['status'] : undefined;
  return typeof status === 'string' ? status : 'unknown';
}

/** One line per fixture, then one per difference: the report a reader scans. */
export function formatVerdicts(verdicts: readonly Verdict[]): string {
  const lines: string[] = [];
  for (const v of verdicts) {
    const rows = [...new Set(v.differences.flatMap((d) => (d.row === undefined ? [] : [d.row])))];
    const cited = rows.length === 0 ? '' : ` rows ${rows.join(',')}`;
    const x = v.executions;
    lines.push(
      `${v.verdict.padEnd(9)} ${v.fixture} (oracle: ${v.oracleOutcome}; execute() default ${x.oracle.default}/${x.candidate.default}, petri ${x.oracle.petri}/${x.candidate.petri})${cited}`,
    );
    for (const p of v.identity) lines.push(`  IDENTITY: ${p}`);
    for (const p of v.budget) lines.push(`  BUDGET: ${p}`);
    for (const d of v.differences) {
      const who = d.row === undefined ? 'FINDING' : `row ${d.row}`;
      lines.push(`  ${who}: ${d.path}  oracle=${show(d.oracle)}  petri=${show(d.candidate)}`);
    }
    const o = v.ordering;
    if (o.weakened.length > 0) lines.push(`  weakened (independent): ${o.weakened.map(([a, b]) => `${a}<${b}`).join(', ')}`);
    if (o.strengthened.length > 0) lines.push(`  strengthened: ${o.strengthened.map(([a, b]) => `${a}<${b}`).join(', ')}`);
    for (const at of v.unusedAttributions) lines.push(`  unused attribution: row ${at.row} (${at.paths.join(', ')})`);
  }
  return lines.join('\n');
}

/**
 * The M3 differential report: the corpus run at several budgets. First the verdict table — one row
 * per fixture, one column per budget, each cell `verdict peak/k` — then the measurements per
 * fixture and budget (peak in flight and wall time on each engine), then **every strengthening**,
 * per fixture and budget: an ordering the candidate imposed that the oracle did not have. Nothing
 * a budget changed about ordering is left out.
 */
export function formatDifferentialReport(verdicts: readonly Verdict[]): string {
  const budgets = [...new Set(verdicts.map((v) => v.measurements.concurrency))];
  const fixtures = [...new Set(verdicts.map((v) => v.fixture))];
  const at = (f: string, k: BudgetLabel) => verdicts.find((v) => v.fixture === f && v.measurements.concurrency === k);
  const width = Math.max(7, ...fixtures.map((f) => f.length));
  const col = (k: BudgetLabel) => `k=${k === 'unbounded' ? 'inf' : k}`;
  const lines: string[] = ['verdict table (cell: verdict, candidate peak in flight / oracle peak)'];
  lines.push(`${'fixture'.padEnd(width)}  ${budgets.map((k) => col(k).padEnd(18)).join('')}`);
  for (const f of fixtures) {
    const cells = budgets.map((k) => {
      const v = at(f, k);
      return (v === undefined ? '-' : `${v.verdict} ${v.measurements.peakInFlight.candidate}/${v.measurements.peakInFlight.oracle}`).padEnd(18);
    });
    lines.push(`${f.padEnd(width)}  ${cells.join('')}`);
  }
  const totals = budgets.map((k) => {
    const vs = verdicts.filter((v) => v.measurements.concurrency === k);
    const count = (kind: VerdictKind) => vs.filter((v) => v.verdict === kind).length;
    return `${col(k)}: ${count('pass')} pass, ${count('divergent')} divergent, ${count('fail')} fail`;
  });
  lines.push(`totals  ${totals.join('; ')}`);

  lines.push('', 'measurements (peak in flight oracle/petri; wall ms oracle/petri)');
  for (const f of fixtures) {
    const cells = budgets.map((k) => {
      const m = at(f, k)?.measurements;
      if (m === undefined) return `${col(k)} -`;
      const ms = (x: number | null) => (x === null ? '?' : x.toFixed(1));
      return `${col(k)} ${m.peakInFlight.oracle}/${m.peakInFlight.candidate} ${ms(m.wallMs.oracle)}/${ms(m.wallMs.candidate)}`;
    });
    lines.push(`${f.padEnd(width)}  ${cells.join(' | ')}`);
  }

  lines.push('', 'strengthenings (candidate a<b the oracle overlapped), per fixture and budget');
  let any = false;
  for (const f of fixtures) {
    for (const k of budgets) {
      const v = at(f, k);
      if (v === undefined || v.ordering.strengthened.length === 0) continue;
      any = true;
      lines.push(`${f} ${col(k)} (${v.ordering.strengthened.length}): ${v.ordering.strengthened.map(([a, b]) => `${a}<${b}`).join(', ')}`);
    }
  }
  if (!any) lines.push('none');

  const weakened = verdicts.filter((v) => v.ordering.weakened.length > 0);
  lines.push('', 'weakenings (declared independent), per fixture and budget');
  for (const v of weakened) {
    lines.push(`${v.fixture} ${col(v.measurements.concurrency)} (${v.ordering.weakened.length}): ${v.ordering.weakened.map(([a, b]) => `${a}<${b}`).join(', ')}`);
  }
  if (weakened.length === 0) lines.push('none');

  lines.push('', 'per-fixture detail');
  for (const k of budgets) {
    lines.push(`-- ${col(k)}`);
    lines.push(formatVerdicts(verdicts.filter((v) => v.measurements.concurrency === k)));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------------------------

/** A hole in a sparse array: distinct from `undefined`, which a caller can tell apart with `in`. */
const HOLE = Object.freeze({ $hole: true });

/**
 * Plain data both engines can be compared on, per the header's rules. `at` is the value's path
 * (`['result']` for a resolved observation's result), so {@link EXCLUDED_PATHS} applies only at
 * Mastra's record positions. `uuids` numbers the UUIDs of one observation in first-seen order;
 * pass a fresh map per observation, or let it default.
 */
export function normalise(value: unknown, at: readonly string[] = [], uuids: Map<string, number> = new Map()): unknown {
  return norm(value, [...at], uuids, new WeakSet());
}

function ordinal(s: string, uuids: Map<string, number>): string {
  return s.replace(UUID, (u) => {
    const key = u.toLowerCase();
    let n = uuids.get(key);
    if (n === undefined) {
      n = uuids.size;
      uuids.set(key, n);
    }
    return `<uuid#${n}>`;
  });
}

function norm(value: unknown, path: string[], uuids: Map<string, number>, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return ordinal(value, uuids);
  if (typeof value === 'symbol') return { $symbol: value.description ?? '' };
  if (typeof value === 'function') return { $function: value.name };
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  try {
    if (value instanceof Date) return { $date: Number.isNaN(value.getTime()) ? 'invalid' : value.toISOString() };
    if (Array.isArray(value)) {
      return Array.from({ length: value.length }, (_, i) => (i in value ? norm(value[i], [...path, String(i)], uuids, seen) : HOLE));
    }
    if (value instanceof Map) {
      return { $map: [...value.entries()].map(([k, v], i) => [norm(k, [...path, '$map', String(i), '0'], uuids, seen), norm(v, [...path, '$map', String(i), '1'], uuids, seen)]) };
    }
    if (value instanceof Set) return { $set: [...value].map((v, i) => norm(v, [...path, '$set', String(i)], uuids, seen)) };

    const out: Record<string, unknown> = {};
    const put = (key: string, v: unknown) => {
      if (Object.hasOwn(out, key)) throw new Error(`normalise: two keys collide as '${key}' at '${path.join('.')}'`);
      out[key] = v;
    };
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      const ctor = (value as { constructor?: { name?: unknown } }).constructor;
      put('$class', typeof ctor?.name === 'string' ? ctor.name : '<anonymous>');
    }
    if (value instanceof Error) {
      put('$error', value.name);
      put('$message', ordinal(value.message, uuids));
      if (value.cause !== undefined) put('$cause', norm(value.cause, [...path, '$cause'], uuids, seen));
    }
    for (const [k, v] of Object.entries(value)) {
      const key = ordinal(k, uuids);
      const next = [...path, key];
      if (EXCLUDED_PATHS.some((p) => matchSegments(p.split('.'), next))) continue;
      put(key, norm(v, next, uuids, seen));
    }
    for (const s of Object.getOwnPropertySymbols(value)) {
      if (!Object.prototype.propertyIsEnumerable.call(value, s)) continue;
      const key = `@@${s.description ?? ''}`;
      put(key, norm((value as Record<symbol, unknown>)[s], [...path, key], uuids, seen));
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Leaf differences between two normalised values. Strict: an absent key and a key holding
 * `undefined` differ, because a caller can tell them apart.
 */
function diff(a: unknown, b: unknown, path: string[], out: { path: string; oracle: unknown; candidate: unknown }[]): void {
  if (Object.is(a, b)) return;
  const at = path.join('.');
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push({ path: `${at}.length`, oracle: a.length, candidate: b.length });
    }
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], [...path, String(i)], out);
    return;
  }
  if (isRecord(a) && isRecord(b) && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
      const inA = Object.hasOwn(a, k);
      const inB = Object.hasOwn(b, k);
      if (inA && inB) diff(a[k], b[k], [...path, k], out);
      else out.push({ path: [...path, k].join('.'), oracle: inA ? a[k] : '<absent>', candidate: inB ? b[k] : '<absent>' });
    }
    return;
  }
  out.push({ path: at, oracle: a, candidate: b });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

// ---------------------------------------------------------------------------------------------
// Happens-before
// ---------------------------------------------------------------------------------------------

interface Span {
  readonly start: number;
  end: number | undefined;
}

/**
 * A trace's spans, keyed by label with an occurrence suffix: the `n`th start of `label` is
 * `label#n`, closed by the first unclosed end of the same label. Occurrence numbering is how a
 * loop body's iterations or a retried attempt line up across engines.
 */
function spans(trace: readonly TraceEvent[]): Map<string, Span> {
  const out = new Map<string, Span>();
  const count = new Map<string, number>();
  const open = new Map<string, string[]>();
  trace.forEach((e, i) => {
    if (e.label.includes('.')) throw new Error(`trace label '${e.label}' contains a dot; attribution paths split on dots`);
    if (e.kind === 'start') {
      const n = count.get(e.label) ?? 0;
      count.set(e.label, n + 1);
      const key = `${e.label}#${n}`;
      out.set(key, { start: i, end: undefined });
      const stack = open.get(e.label) ?? [];
      stack.push(key);
      open.set(e.label, stack);
    } else {
      const key = open.get(e.label)?.shift();
      const span = key === undefined ? undefined : out.get(key);
      if (span !== undefined) span.end = i;
    }
  });
  return out;
}

/** `a -> b`: `a` ended before `b` started. */
function before(a: Span, b: Span): boolean {
  return a.end !== undefined && a.end < b.start;
}

function labelMatches(pattern: string, key: string): boolean {
  return pattern.includes('#') ? pattern === key : key.slice(0, key.lastIndexOf('#')) === pattern;
}

function declaredIndependent(independent: readonly IndependentPair[], a: string, b: string): boolean {
  return independent.some(
    ([x, y]) => (labelMatches(x, a) && labelMatches(y, b)) || (labelMatches(x, b) && labelMatches(y, a)),
  );
}

function compareOrder(
  oracleTrace: readonly TraceEvent[],
  candidateTrace: readonly TraceEvent[],
  independent: readonly IndependentPair[],
): { report: OrderingReport; onlyOracle: string[]; onlyCandidate: string[] } {
  const o = spans(oracleTrace);
  const c = spans(candidateTrace);
  const common = [...o.keys()].filter((k) => c.has(k));
  const weakened: [string, string][] = [];
  const inverted: [string, string][] = [];
  const strengthened: [string, string][] = [];
  const reversed: [string, string][] = [];
  for (const a of common) {
    for (const b of common) {
      if (a === b) continue;
      const oa = o.get(a)!;
      const ob = o.get(b)!;
      const ca = c.get(a)!;
      const cb = c.get(b)!;
      const oracleAB = before(oa, ob);
      const candAB = before(ca, cb);
      if (oracleAB && !candAB) {
        // The candidate lacks an oracle ordering: b started before a ended, or b ran wholly first.
        if (declaredIndependent(independent, a, b)) weakened.push([a, b]);
        else if (before(cb, ca)) reversed.push([a, b]);
        else inverted.push([a, b]);
      } else if (candAB && !oracleAB && !before(ob, oa)) strengthened.push([a, b]);
    }
  }
  const startOrder = (m: Map<string, Span>) => [...m.entries()].sort((x, y) => x[1].start - y[1].start).map(([k]) => k);
  return {
    report: { oracleStarts: startOrder(o), candidateStarts: startOrder(c), weakened, inverted, reversed, strengthened },
    onlyOracle: [...o.keys()].filter((k) => !c.has(k)),
    onlyCandidate: [...c.keys()].filter((k) => !o.has(k)),
  };
}

// ---------------------------------------------------------------------------------------------
// Attribution paths
// ---------------------------------------------------------------------------------------------

/** `*` matches one segment, a trailing `**` any rest. */
export function matches(pattern: string, path: string): boolean {
  return matchSegments(pattern.split('.'), path.split('.'));
}

function matchSegments(p: readonly string[], s: readonly string[]): boolean {
  for (let i = 0; i < p.length; i++) {
    const seg = p[i];
    if (seg === '**' && i === p.length - 1) return true;
    const got = s[i];
    if (got === undefined) return false;
    if (seg !== '*' && seg !== got) return false;
  }
  return p.length === s.length;
}

function show(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s.length > 160 ? `${s.slice(0, 157)}...` : s;
  } catch {
    return String(v);
  }
}

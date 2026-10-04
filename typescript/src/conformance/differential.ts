/**
 * The differential harness: one fixture, run on Mastra's `DefaultExecutionEngine` (the oracle) and
 * on `PetriExecutionEngine` (the candidate) in one process, compared five ways.
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
 *    - the paths in {@link EXCLUDED_PATHS} — run/trace/span ids, **at the positions where Mastra
 *      writes them** (the result's top level, a suspend stamp) — and the *values* of its clock
 *      stamps (a step record's `startedAt`, `endedAt`, …): those are masked, their presence and kind
 *      still compared, so a stamp one engine writes and the other omits is a difference. The same
 *      key inside user data — an output, a payload, the state — is compared.
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
 * 5. **Events — the gate.** Everything the run's `watch()` delivered (or its `stream()` enqueued),
 *    grouped by step ({@link eventGroup}) and compared group by group, in order within a group
 *    (`events.<group>.<n>.<…>`). Across groups, which is not a total order (`docs/divergences.md`
 *    row 4), as happens-before over spans ({@link eventModel}): an oracle order between two steps,
 *    or between a step and a run-level event, the candidate reverses or inverts
 *    (`events.$order.<a>.<b>`, weakened only on a declared independent pair); a progress event,
 *    writer chunk or nested step outside its owner step's span (`events.$within.<key>`); a step
 *    occurrence whose events carry more than one call id on one side only (`events.$calls.<key>`).
 *    Excluded: run ids ({@link EVENT_EXCLUDED_PATHS}), and UUIDs as ordinals, continuing the
 *    result's numbering. Clock stamps are masked — presence compared, value not
 *    ({@link EVENT_MASKED_PATHS}); step call ids are numbered per group. Attributable like any
 *    other path, and always gated: no option or environment variable turns the dimension off.
 *
 * A difference is `divergent` only when an {@link Attribution} naming a `docs/divergences.md` row
 * covers its path; an unattributed difference makes the fixture `fail`.
 *
 * **Suspend, then resume ([ADR 0007]).** {@link runResume} runs a resumable fixture phase by phase
 * — `start()`, then each `resume()` — on a {@link ResumeRoute}: the engine that suspends, the one
 * that resumes, in one process or a fresh engine per phase. Each candidate route is compared with
 * the oracle of its process mode by the same four gates, per phase: identity, the phase's outcome
 * and every stored `WorkflowRunState` (the records), happens-before over the phases' traces, and
 * the budget on each phase the petri engine ran. The crossed routes hand nothing across but storage.
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
      /** Every event the run's `watch()` (or `stream()`) delivered, in arrival order; absent, not observed. */
      readonly events?: readonly unknown[];
    }
  | {
      readonly kind: 'rejected';
      readonly error: unknown;
      readonly trace: readonly TraceEvent[];
      readonly executions: readonly Execution[];
      readonly events?: readonly unknown[];
    };

/**
 * A known, documented difference: every difference whose path matches one of `paths` is
 * attributed to `row` of `docs/divergences.md`. Paths are dot-separated; `*` matches one segment,
 * a trailing `**` any rest (including none).
 *
 * Paths: `kind` (resolved on one engine, rejected on the other), `result.<…>` (the formatted
 * result), `error.<…>` (a rejection), `events.<group>…` (the watch events, see {@link groupEvents}),
 * `trace.<label>` (a step that ran on one engine only),
 * `order.<a>.<b>` (an oracle ordering the candidate reversed or inverted). A trace label may not
 * contain a dot. Engine identity is never attributable.
 *
 * `routes` scopes an attribution to the suspend-then-resume routes it explains (see
 * {@link ResumeRoute}, printed by {@link routeLabel}): on any other route it attributes nothing, so a
 * difference there is a finding. Absent, the attribution applies on every route. A fresh-run
 * comparison has no route, so a route-scoped attribution never applies in {@link compareObservations}.
 */
export interface Attribution {
  readonly row: number;
  readonly paths: readonly string[];
  readonly reason: string;
  readonly routes?: readonly ResumeRouteLabel[];
  /**
   * The difference hangs on a race the fixture cannot pin — a microtask-depth window, say — so it
   * may or may not appear. A difference that does appear must still match it; an unused one is not
   * reported. Only for a fixture whose own comment documents the race.
   */
  readonly racy?: true;
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
  /**
   * Oracle event orderings (`a -> b` over {@link eventModel}'s spans) the candidate lacks, on a pair
   * declared independent: reported, not gated. Prefixed with the phase (`phases.<i>.`) on a resume.
   */
  readonly eventsWeakened?: readonly (readonly [string, string])[];
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
  /** Every difference, attributed or not, event differences included: all gated. */
  readonly differences: readonly Difference[];
  readonly ordering: OrderingReport;
  /**
   * Declared attributions that apply to this run and matched nothing in it. A caller gates it: a
   * stale row. A route-scoped attribution is listed only on its routes (never on a fresh run).
   */
  readonly unusedAttributions: readonly Attribution[];
  /** Why the candidate broke its run budget. Non-empty makes the verdict `fail`; never attributable. */
  readonly budget: readonly string[];
  readonly measurements: Measurements;
}

/**
 * The only positions excluded from comparison: timestamps and run/trace/span ids where Mastra
 * writes them. Patterns as {@link matches}, over the normalised path. The comparisons mask the
 * clock-stamp positions among them rather than drop them ({@link clockMasked}): value hidden,
 * presence and kind compared. {@link normalise} on its own still drops every listed path.
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

/**
 * An exclusion list split for {@link normalise}: its clock-stamp positions (a last segment in
 * {@link CLOCK}) masked — value dropped, presence and kind compared — and the rest excluded.
 */
export function clockMasked(paths: readonly string[]): [excluded: string[], masked: string[]] {
  const isClock = (p: string) => (CLOCK as readonly string[]).includes(p.slice(p.lastIndexOf('.') + 1));
  return [paths.filter((p) => !isClock(p)), paths.filter(isClock)];
}

/** A UUID inside a string — minted per build or per run, so an id. */
export const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

const CLOCK = ['startedAt', 'endedAt', 'suspendedAt', 'resumedAt', 'pausedAt'] as const;

/**
 * The positions an event comparison excludes, over `events.<group>.<n>.<…>` — each event as
 * `run.watch()` hands it (`workflow.ts:4323-4327`: the published `data`), or as `run.stream()`
 * enqueues it. Run ids, where Mastra writes them, and nothing else: the same key inside an output,
 * a payload or a writer chunk's `output` is compared.
 *
 * - `runId` on the chunk — a writer chunk's (`tools/stream.ts:47-50`), every `run.stream()` chunk
 *   (`workflow.ts:4088-4105`), and the stream's own `workflow-start` / `workflow-finish`
 *   (`stream/RunOutput.ts:72-79,125-128`).
 * - `payload.runId` — a writer chunk's (`tools/stream.ts:52-56`); the legacy stream's
 *   `workflow-start` / `workflow-finish` (`workflow.ts:3938,3957`).
 * - `payload.suspendPayload.__workflow_meta.runId` — a suspended nested workflow's stamp, the
 *   child's run id (`workflow.ts:3076-3084`), carried by the parent step's `-suspended`; excluded on a fresh run as {@link EXCLUDED_PATHS} excludes it in
 *   the result. {@link RESUME_EVENT_EXCLUDED_PATHS} compares it, as {@link RESUME_EXCLUDED_PATHS} does.
 *
 * Clock stamps are not excluded but masked ({@link EVENT_MASKED_PATHS}): their value is dropped,
 * their presence and kind compared. A step call id is neither: {@link groupEvents} numbers it.
 */
export const EVENT_EXCLUDED_PATHS: readonly string[] = [
  'events.*.*.runId',
  'events.*.*.payload.runId',
  'events.*.*.payload.suspendPayload.__workflow_meta.runId',
];

/** {@link EVENT_EXCLUDED_PATHS} on a suspend-then-resume phase: the suspend stamp's run id is compared. */
export const RESUME_EVENT_EXCLUDED_PATHS: readonly string[] = EVENT_EXCLUDED_PATHS.filter((p) => !p.endsWith('.__workflow_meta.runId'));

/**
 * The positions whose value an event comparison masks and whose presence it compares, over
 * `events.<group>.<n>.<…>`: the clock stamps `{startedAt,endedAt,suspendedAt,resumedAt,pausedAt}`
 * where Mastra writes them. A masked value is its kind (`<clock:number>`), so a stamp one engine
 * writes and the other omits, or writes as another kind, is a difference.
 *
 * - `payload.<clock>` — a step's `-start` spreads its running record (`default.ts:226-233`, the
 *   record at `handlers/step.ts:169-178`), its `-result` / `-suspended` the final one
 *   (`handlers/step.ts:515-545`, emitted at `:661-690`); a sleep's `-waiting` and `-result`
 *   (`handlers/entry.ts:588-601,669-680`, the `sleepUntil` twins at `:700-712,781-792`); a
 *   foreach's `-start`, `-result` and `-suspended` (`handlers/control-flow.ts:1015-1024,1331-1341,1420-1430,1454-1465`).
 * - `payload.suspendPayload.__workflow_meta.foreachOutput.*.<clock>` — a suspended or failed
 *   foreach's per-item entries (`handlers/control-flow.ts:1194-1198,1360-1370`).
 */
export const EVENT_MASKED_PATHS: readonly string[] = [
  ...CLOCK.map((k) => `events.*.*.payload.${k}`),
  ...CLOCK.map((k) => `events.*.*.payload.suspendPayload.__workflow_meta.foreachOutput.*.${k}`),
];

/** The group of events whose step has no id: run-level events (`workflow-paused`, `workflow-canceled`, a stream's start and finish). */
export const RUN_EVENTS = '$run';

/**
 * Which group an event belongs to — the unit whose order is compared event by event. Order *within*
 * a group is deterministic in Mastra (one step's start precedes its result, which precedes its
 * finish; a foreach's progress events follow its start); order *across* groups is not a total order
 * (`docs/divergences.md` row 4: independent steps interleave), so it is compared as happens-before
 * over spans instead ({@link eventModel}).
 *
 * - `payload.id` — every step, sleep and foreach event (`default.ts:229`, `handlers/step.ts:663`,
 *   `handlers/entry.ts:597`, `handlers/control-flow.ts:1021,1076`). A nested workflow's events
 *   reach the parent's watch with the id prefixed `<workflowId>.<id>` (`workflow.ts:4330-4346`), so
 *   they form their own group beside the nested step's own (`<workflowId>`).
 * - `<stepName>@output` — a writer chunk, `workflow-step-output` (`tools/stream.ts:46-58`), in a
 *   group of its own per writing step: ordered against the step's other chunks, not against its
 *   lifecycle. Where a chunk goes depends on how the run is observed — the default engine drops it
 *   under `start()`, whose `outputWriter` is unset (`workflow.ts:3781-3797` against `:4135`), and
 *   the petri engine publishes it (`docs/divergences.md` row 58) — so a separate group keeps the
 *   step's lifecycle comparable on its own, and lets a routing difference be attributed without
 *   masking one in the lifecycle. A nested step's chunk is not prefixed (the relay prefixes
 *   `payload.id` only, `workflow.ts:4340-4346`), so it groups under the bare step id.
 * - `$<type>` for a custom `data-*` chunk (`tools/stream.ts:68-72`, relayed as is,
 *   `workflow.ts:4330-4337`): it carries no step, so each type is its own ordered group.
 * - {@link RUN_EVENTS} for anything else.
 *
 * A foreach's progress events (`workflow-step-progress`, `handlers/control-flow.ts:1064-1084`)
 * are grouped per item by {@link groupEvents}, not here: `<id>[<currentIndex>]`. Mastra emits them
 * as items complete (`:1117-1147`), so their order across items is completion order — order across
 * independent steps (row 4), which a sliding window of lanes or a run budget changes. Each item's
 * own progress is deterministic, but its `completedCount` is not: it is the running count of
 * items that finished before it, suspended ones not counted (`:1119-1135,1146`), so it is the
 * item's rank in that same order. {@link groupEvents} therefore replaces it with the item's own
 * contribution, `$completedIncrement` — its count minus the count on the foreach's previous
 * progress event since its last `workflow-step-start` (1 for a finished item, 0 for a suspended
 * one) — which is order-free and still catches a counter that skips, repeats or never moves.
 *
 * A group name is one path segment: a `.` in it (a nested prefix) is written `/`, so `inner.i1`'s
 * events are at `events.inner/i1.<n>`. UUIDs in it become ordinals like any other string.
 */
export function eventGroup(event: unknown): string {
  const payload = isRecord(event) ? event['payload'] : undefined;
  const id = isRecord(payload) ? payload['id'] : undefined;
  if (typeof id === 'string') return id;
  const type = isRecord(event) ? event['type'] : undefined;
  const stepName = isRecord(payload) ? payload['stepName'] : undefined;
  if (typeof stepName === 'string') return `${stepName}@output`;
  if (typeof type === 'string' && type.startsWith('data-')) return `$${type}`;
  return RUN_EVENTS;
}

/**
 * One side's events, grouped by {@link eventGroup} and normalised (as {@link normalise}, at
 * `events.<group>.<n>`, under `excluded`, clock stamps masked by {@link EVENT_MASKED_PATHS}): each
 * group's events in arrival order, groups keyed by name. `uuids` continues the side's ordinals, so
 * pass the map its result was normalised with.
 *
 * A step call id (`payload.stepCallId`: a `randomUUID()` per call, `default.ts:226-233`,
 * `handlers/step.ts:660-690`) becomes `<call#k>`, `k` its first-seen rank among the call ids of its
 * group: its presence is compared (a foreach's `-start` has none in Mastra,
 * `handlers/control-flow.ts:1015-1024`), and so is which events share a call — a `-result` whose id
 * is not its `-start`'s reads `<call#1>` where Mastra has `<call#0>`. It consumes no UUID ordinal.
 */
export function groupEvents(
  events: readonly unknown[],
  uuids: Map<string, number> = new Map(),
  excluded: readonly string[] = EVENT_EXCLUDED_PATHS,
): Record<string, unknown[]> {
  const groups: Record<string, unknown[]> = {};
  const calls = new Map<string, Map<string, number>>();
  const push = (group: string, event: unknown) => {
    const key = groupKey(group, uuids);
    const list = (groups[key] ??= []);
    list.push(normalise(numberCall(event, key, calls), ['events', key, String(list.length)], uuids, excluded, EVENT_MASKED_PATHS));
  };
  /** Per foreach id, the counter on its last progress event since its last start. */
  const counters = new Map<string, number>();
  for (const event of events) {
    const progress = foreachProgress(event);
    if (progress === undefined) {
      const group = eventGroup(event);
      if (isRecord(event) && event['type'] === 'workflow-step-start') counters.delete(group);
      push(group, event);
      continue;
    }
    const { completedCount, ...payload } = progress.payload;
    const before = counters.get(progress.id) ?? 0;
    const increment = typeof completedCount === 'number' ? completedCount - before : completedCount;
    if (typeof completedCount === 'number') counters.set(progress.id, completedCount);
    push(`${progress.id}[${progress.index}]`, { ...(event as Record<string, unknown>), payload: { ...payload, $completedIncrement: increment } });
  }
  return groups;
}

/** A group name as one path segment: UUIDs as ordinals, a `.` (a nested prefix) written `/`. */
function groupKey(group: string, uuids: Map<string, number>): string {
  return ordinal(group, uuids).replaceAll('.', '/');
}

/** The event with its top-level `payload.stepCallId` replaced by its `<call#k>` within `group`. */
function numberCall(event: unknown, group: string, calls: Map<string, Map<string, number>>): unknown {
  const payload = isRecord(event) ? event['payload'] : undefined;
  if (!isRecord(payload) || Array.isArray(payload) || !Object.hasOwn(payload, 'stepCallId')) return event;
  const id = payload['stepCallId'];
  if (typeof id !== 'string') return event;
  const seen = calls.get(group) ?? new Map<string, number>();
  calls.set(group, seen);
  let k = seen.get(id);
  if (k === undefined) {
    k = seen.size;
    seen.set(id, k);
  }
  return { ...(event as Record<string, unknown>), payload: { ...payload, stepCallId: `<call#${k}>` } };
}

/** A foreach progress event's parts (`handlers/control-flow.ts:1064-1084`), or `undefined`. */
function foreachProgress(event: unknown): { type: string; id: string; index: number; payload: Record<string, unknown> } | undefined {
  if (!isRecord(event) || event['type'] !== 'workflow-step-progress') return undefined;
  const payload = event['payload'];
  if (!isRecord(payload) || Array.isArray(payload)) return undefined;
  const id = payload['id'];
  const index = payload['currentIndex'];
  if (typeof id !== 'string' || typeof index !== 'number') return undefined;
  return { type: event['type'], id, index, payload };
}

/** An event's `type`, or `?`: how a report names an event it does not print whole. */
function typeOf(event: unknown): string {
  const t = isRecord(event) ? event['type'] : undefined;
  return typeof t === 'string' ? t : '?';
}

/** Where a point must lie on one side, and whether it did: inside `owner`'s open, unsettled span. */
export interface Containment {
  readonly owner: string;
  readonly inside: boolean;
}

/**
 * One side's events as happens-before material, over the group names of {@link groupEvents}:
 *
 * - `spans` — each step occurrence `<group>#<n>` (its `n`th run: a loop's iterations, a resumed
 *   step's second start) from its first `-start` or `-waiting` to its `-finish` or `-suspended`,
 *   or its last `-result` when neither follows; and each run-level event — `$run:<type>#<m>` (a
 *   stream's `workflow-start`/`-finish`, `workflow-canceled`, `workflow-paused`) and a custom
 *   chunk, `$data-<x>#<m>` — as a point span. Ordered against each other as
 *   {@link compareOrder} orders a trace's spans.
 * - `within` — every point that belongs to a step, and where it lay: a foreach's progress
 *   (`<id>[<k>]#<m>`) and a writer chunk (`<step>@output#<m>`) inside their step's span *before
 *   it settled* (its first `-result`, `-suspended` or `-finish`: Mastra publishes progress before
 *   the aggregate's result, `handlers/control-flow.ts:1117-1147,1331-1341`, and a chunk while the
 *   step runs, `tools/stream.ts:46-58`); a nested step's occurrence (`inner/i1#<n>`) wholly inside
 *   an occurrence of its parent step (`inner`) before the parent settled. A writer chunk's step is
 *   named bare even when nested (`workflow.ts:4340-4346`), so any group ending in `/<step>` owns it.
 * - `calls` — per step occurrence, how many distinct step call ids its events carry: one when its
 *   `-start`, `-result` and `-finish` correlate (`default.ts:226-233`, `handlers/step.ts:660-690`).
 */
export function eventModel(
  events: readonly unknown[],
  uuids: Map<string, number> = new Map(),
): EventModel {
  interface Occurrence {
    readonly key: string;
    readonly start: number;
    end: number | undefined;
    settle: number | undefined;
    closed: boolean;
    readonly calls: Set<string>;
  }
  const occurrences = new Map<string, Occurrence[]>();
  const points = new Map<string, number>();
  const spans = new Map<string, Span>();
  const within = new Map<string, Containment>();
  const pointKey = (label: string) => {
    const m = points.get(label) ?? 0;
    points.set(label, m + 1);
    return `${label}#${m}`;
  };
  const list = (group: string) => occurrences.get(group) ?? [];
  const unsettled = (o: Occurrence, i: number) => !o.closed && o.settle === undefined && o.start < i;
  /** Whether some occurrence of `group` is running — opened, not yet settled — at index `i`. */
  const running = (group: string, i: number) => list(group).some((o) => unsettled(o, i));
  const open = (group: string, i: number): Occurrence => {
    const list = occurrences.get(group) ?? [];
    occurrences.set(group, list);
    const o: Occurrence = { key: `${group}#${list.length}`, start: i, end: undefined, settle: undefined, closed: false, calls: new Set() };
    list.push(o);
    return o;
  };

  events.forEach((event, i) => {
    const type = typeOf(event);
    const progress = foreachProgress(event);
    if (progress !== undefined) {
      const owner = groupKey(progress.id, uuids);
      within.set(pointKey(`${owner}[${progress.index}]`), { owner, inside: running(owner, i) });
      return;
    }
    const raw = eventGroup(event);
    const group = groupKey(raw, uuids);
    if (group.startsWith('$')) {
      const key = pointKey(group === RUN_EVENTS ? `${group}:${type}` : group);
      spans.set(key, { start: i, end: i });
      return;
    }
    if (group.endsWith('@output')) {
      const step = group.slice(0, -'@output'.length);
      const owners = [...occurrences.keys()].filter((g) => g === step || g.endsWith(`/${step}`));
      within.set(pointKey(group), { owner: step, inside: owners.some((g) => running(g, i)) });
      return;
    }
    // A settling event closes the oldest occurrence still open, as a trace's end closes the oldest
    // open start of its label ({@link spans}): a loop's next run may start before the last finished.
    let o: Occurrence | undefined;
    switch (type) {
      case 'workflow-step-start':
      case 'workflow-step-waiting':
        o = list(group).find((x) => !x.closed && x.settle === undefined) ?? open(group, i);
        break;
      case 'workflow-step-result':
        o = list(group).find((x) => !x.closed && x.settle === undefined) ?? list(group).find((x) => !x.closed) ?? open(group, i);
        o.settle ??= i;
        o.end = i;
        break;
      case 'workflow-step-suspended':
      case 'workflow-step-finish':
        o = list(group).find((x) => !x.closed) ?? open(group, i);
        o.settle ??= i;
        o.end = i;
        o.closed = true;
        break;
      default:
        // Any other event a step publishes lies inside it, like a progress event.
        within.set(pointKey(`${group}:${type}`), { owner: group, inside: running(group, i) });
        return;
    }
    const payload = isRecord(event) ? event['payload'] : undefined;
    const call = isRecord(payload) ? payload['stepCallId'] : undefined;
    if (typeof call === 'string') o.calls.add(call);
  });

  const calls = new Map<string, number>();
  for (const [group, list] of occurrences) {
    for (const o of list) {
      spans.set(o.key, { start: o.start, end: o.end });
      calls.set(o.key, o.calls.size);
      const slash = group.lastIndexOf('/');
      if (slash < 0) continue;
      const parent = group.slice(0, slash);
      const parents = occurrences.get(parent);
      if (parents === undefined) continue;
      const inside = parents.some(
        (p) => p.start < o.start && (p.settle === undefined || (o.end !== undefined && o.end < p.settle)),
      );
      within.set(o.key, { owner: parent, inside });
    }
  }
  return { spans, within, calls };
}

/** {@link eventModel}'s result. */
export interface EventModel {
  readonly spans: Map<string, Span>;
  readonly within: Map<string, Containment>;
  readonly calls: Map<string, number>;
}

/** What {@link compareEvents} is told beyond the two sides' events. */
export interface CompareEventsOptions {
  readonly root?: string;
  readonly oracleUuids?: Map<string, number>;
  readonly candidateUuids?: Map<string, number>;
  readonly excluded?: readonly string[];
  /** Step pairs the fixture declares independent (row 4): an event order between them may weaken. */
  readonly independent?: readonly IndependentPair[];
}

/**
 * The event differences between two sides, pure, and the event orderings weakened on declared
 * independent pairs (reported, not gated).
 *
 * Per group, in order: a group on one side only is one difference at `<root>.<group>`, its values
 * the group's event types; a group on both is compared event by event, field by field
 * (`<root>.<group>.<n>.<…>`), and a length mismatch is `<root>.<group>.length`, its values each
 * side's event types in order.
 *
 * Across groups, over {@link eventModel} on each side, on keys both sides have:
 * - `<root>.$order.<a>.<b>` — the oracle has `a` wholly before `b` and the candidate does not:
 *   reversed or inverted, as {@link compareOrder} gates a trace; weakened, and not gated, only when
 *   the fixture declares the two steps independent.
 * - `<root>.$within.<point>` — the oracle has the point inside its owner's span and the candidate
 *   does not.
 * - `<root>.$calls.<occurrence>` — the two sides disagree on how many step call ids one step
 *   occurrence carries (one: its events correlate).
 *
 * `$order`, `$within` and `$calls` never collide with a group: `$` names only `$run` and `$data-*`.
 */
export function compareEvents(
  oracle: readonly unknown[],
  candidate: readonly unknown[],
  options: CompareEventsOptions = {},
): { path: string; oracle: unknown; candidate: unknown }[] {
  return compareEventsDetailed(oracle, candidate, options).differences;
}

function compareEventsDetailed(
  oracle: readonly unknown[],
  candidate: readonly unknown[],
  options: CompareEventsOptions = {},
): { differences: RawDifference[]; weakened: readonly (readonly [string, string])[] } {
  const root = options.root ?? 'events';
  const excluded = options.excluded ?? EVENT_EXCLUDED_PATHS;
  const ou = options.oracleUuids ?? new Map<string, number>();
  const cu = options.candidateUuids ?? new Map<string, number>();
  const a = groupEvents(oracle, ou, excluded);
  const b = groupEvents(candidate, cu, excluded);
  const out: RawDifference[] = [];
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const x = a[key];
    const y = b[key];
    const at = `${root}.${key}`;
    if (x === undefined || y === undefined) {
      out.push({ path: at, oracle: x === undefined ? '<absent>' : x.map(typeOf), candidate: y === undefined ? '<absent>' : y.map(typeOf) });
      continue;
    }
    if (x.length !== y.length) out.push({ path: `${at}.length`, oracle: x.map(typeOf), candidate: y.map(typeOf) });
    for (let i = 0; i < Math.min(x.length, y.length); i++) diff(x[i], y[i], [...at.split('.'), String(i)], out);
  }

  const om = eventModel(oracle, ou);
  const cm = eventModel(candidate, cu);
  const order = compareSpanMaps(om.spans, cm.spans, options.independent ?? []);
  for (const [x, y] of order.report.reversed) out.push({ path: `${root}.$order.${x}.${y}`, oracle: `${x} before ${y}`, candidate: `${y} before ${x}` });
  for (const [x, y] of order.report.inverted) {
    out.push({ path: `${root}.$order.${x}.${y}`, oracle: `${x} before ${y}`, candidate: `${y} started before ${x} ended` });
  }
  for (const [key, o] of om.within) {
    const c = cm.within.get(key);
    if (c === undefined || !o.inside || c.inside) continue;
    out.push({ path: `${root}.$within.${key}`, oracle: `inside ${o.owner}`, candidate: `outside ${c.owner}` });
  }
  for (const [key, n] of om.calls) {
    const m = cm.calls.get(key);
    if (m === undefined || (n <= 1) === (m <= 1)) continue;
    out.push({ path: `${root}.$calls.${key}`, oracle: `${n} step call id(s)`, candidate: `${m} step call id(s)` });
  }
  return { differences: out, weakened: order.report.weakened };
}

/** Whether a difference path is on the events dimension (`events.…`, or a phase's `phases.<i>.events.…`). */
export function isEventPath(path: string): boolean {
  return path.startsWith('events.') || /^phases\.\d+\.events\./.test(path);
}

/**
 * A difference path with its group and indices made generic, for reports that count what an
 * event implementation still lacks: `events.a.2.payload.status` -> `events.<group>.*.payload.status`,
 * `phases.1.events.$run.length` -> `phases.*.events.$run.length` (the run group is kept by name).
 */
export function eventPattern(path: string): string {
  const segs = path.split('.');
  let i = 0;
  const out: string[] = [];
  if (segs[0] === 'phases') {
    out.push('phases', '*');
    i = 2;
  }
  out.push(segs[i] ?? '');
  const group = segs[i + 1];
  if (group !== undefined) {
    out.push(
      group.startsWith('$')
        ? group
        : group.endsWith('@output')
          ? '<group>@output'
          : /\[\d+\]$/.test(group)
              ? '<group>[*]'
              : '<group>',
    );
  }
  const cross = group === '$order' || group === '$within' || group === '$calls';
  for (const seg of segs.slice(i + 2)) out.push(cross ? '<key>' : /^\d+$/.test(seg) ? '*' : seg);
  return out.join('.');
}

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

type RawDifference = { path: string; oracle: unknown; candidate: unknown };

/**
 * Attributes every raw difference and decides the verdict. `applies` says whether an attribution
 * may attribute on this run. Every difference is gated: there is no mode that lists event
 * differences without counting them.
 */
export function settle(
  raw: readonly RawDifference[],
  attributions: readonly Attribution[],
  applies: (at: Attribution) => boolean,
  gatedElsewhere: boolean,
): { differences: Difference[]; unused: Attribution[]; verdict: VerdictKind } {
  const used = new Set<Attribution>();
  const differences: Difference[] = raw.map((d) => {
    const hit = attributions.find((at) => applies(at) && at.paths.some((p) => matches(p, d.path)));
    if (hit === undefined) return d;
    used.add(hit);
    return { ...d, row: hit.row };
  });
  const verdict: VerdictKind = gatedElsewhere
    ? 'fail'
    : differences.length === 0
      ? 'pass'
      : differences.every((d) => d.row !== undefined)
        ? 'divergent'
        : 'fail';
  return { differences, unused: attributions.filter((at) => applies(at) && !used.has(at) && at.racy !== true), verdict };
}

/** The events of one side, or `[]` when it observed none — compared only when either side observed some. */
function eventsOf(o: { readonly events?: readonly unknown[] }): readonly unknown[] {
  return o.events ?? [];
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
  const raw: RawDifference[] = [];
  const ou = new Map<string, number>();
  const cu = new Map<string, number>();

  if (oracle.kind !== candidate.kind) {
    raw.push({ path: 'kind', oracle: oracle.kind, candidate: candidate.kind });
  } else {
    const root = oracle.kind === 'resolved' ? 'result' : 'error';
    const a = oracle.kind === 'resolved' ? oracle.result : oracle.error;
    const b = candidate.kind === 'resolved' ? candidate.result : candidate.error;
    diff(normalise(a, [root], ou, ...clockMasked(EXCLUDED_PATHS)), normalise(b, [root], cu, ...clockMasked(EXCLUDED_PATHS)), [root], raw);
  }
  // Events: after the result, so a `sleep_<uuid>` id keeps the ordinal its record got there.
  let eventsWeakened: readonly (readonly [string, string])[] = [];
  if (oracle.events !== undefined || candidate.events !== undefined) {
    const events = compareEventsDetailed(eventsOf(oracle), eventsOf(candidate), { oracleUuids: ou, candidateUuids: cu, independent });
    raw.push(...events.differences);
    eventsWeakened = events.weakened;
  }

  const ordering = compareOrder(oracle.trace, candidate.trace, independent);
  for (const label of ordering.onlyOracle) raw.push({ path: `trace.${label}`, oracle: 'ran', candidate: 'did not run' });
  for (const label of ordering.onlyCandidate) raw.push({ path: `trace.${label}`, oracle: 'did not run', candidate: 'ran' });
  for (const [a, b] of ordering.report.reversed) raw.push({ path: `order.${a}.${b}`, oracle: `${a} before ${b}`, candidate: `${b} before ${a}` });
  for (const [a, b] of ordering.report.inverted) {
    raw.push({ path: `order.${a}.${b}`, oracle: `${a} before ${b}`, candidate: `${b} started before ${a} ended` });
  }

  const { differences, unused, verdict } = settle(raw, attributions, (at) => at.routes === undefined, identity.length > 0 || budget.length > 0);
  return {
    fixture: name,
    verdict,
    oracleOutcome: outcomeOf(oracle),
    identity,
    executions: { oracle: countByEngine(oracle.executions), candidate: countByEngine(candidate.executions) },
    differences,
    ordering: { ...ordering.report, eventsWeakened },
    unusedAttributions: unused,
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
      lines.push(`  ${who}: ${d.path}  ${showPair(d)}`);
    }
    const o = v.ordering;
    if (o.weakened.length > 0) lines.push(`  weakened (independent): ${o.weakened.map(([a, b]) => `${a}<${b}`).join(', ')}`);
    const ew = o.eventsWeakened ?? [];
    if (ew.length > 0) lines.push(`  events weakened (independent): ${ew.map(([a, b]) => `${a}<${b}`).join(', ')}`);
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

  lines.push('', ...formatEventSummary(verdicts));

  lines.push('', 'per-fixture detail');
  for (const k of budgets) {
    lines.push(`-- ${col(k)}`);
    lines.push(formatVerdicts(verdicts.filter((v) => v.measurements.concurrency === k)));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Suspend, then resume ([ADR 0007])
// ---------------------------------------------------------------------------------------------

/**
 * Which engine ran a run to its suspension, which one resumed it, and whether the resume ran on the
 * same engine instance (`same`: one process) or on a new one per phase (`fresh`: another process as
 * far as the engine can tell). Only a route with one engine can be `same`.
 */
export interface ResumeRoute {
  readonly suspendOn: EngineName;
  readonly resumeOn: EngineName;
  readonly process: 'same' | 'fresh';
}

/**
 * The candidate routes, each compared with the oracle of its process mode. The crossed pairs hand
 * nothing across but the stored `WorkflowRunState`, so they show it is the only record: a run
 * suspended under either engine resumes under the other.
 */
export const RESUME_ROUTES: readonly ResumeRoute[] = [
  { suspendOn: 'petri', resumeOn: 'petri', process: 'same' },
  { suspendOn: 'petri', resumeOn: 'petri', process: 'fresh' },
  { suspendOn: 'default', resumeOn: 'petri', process: 'fresh' },
  { suspendOn: 'petri', resumeOn: 'default', process: 'fresh' },
];

/** The oracle for a route: both phases on Mastra's engine, in the route's process mode. */
export function oracleRoute(route: ResumeRoute): ResumeRoute {
  return { suspendOn: 'default', resumeOn: 'default', process: route.process };
}

/** How reports, fixture names and route-scoped {@link Attribution}s name a route. */
export type ResumeRouteLabel = `${EngineName}>${EngineName}` | `${EngineName}>${EngineName} same`;

/** `petri>default`, `petri>petri same`, …: how reports and fixture names print a route. */
export function routeLabel(route: ResumeRoute): ResumeRouteLabel {
  return route.process === 'same' ? `${route.suspendOn}>${route.resumeOn} same` : `${route.suspendOn}>${route.resumeOn}`;
}

/** Whether `at` may attribute a difference seen on `route`: it names no routes, or names this one. */
function appliesOn(at: Attribution, route: ResumeRoute): boolean {
  return at.routes === undefined || at.routes.includes(routeLabel(route));
}

/** The engine that ran phase `i`: the suspending engine for `start()`, the resuming one after. */
export function phaseEngine(route: ResumeRoute, i: number): EngineName {
  return i === 0 ? route.suspendOn : route.resumeOn;
}

/**
 * One phase of a suspend-then-resume observation — `start()`, then each `resume()` in turn: what it
 * returned or threw, and every `WorkflowRunState` in storage after it, keyed by workflow name (a
 * nested workflow stores its own). Several runs of one workflow are listed in an order that does not
 * depend on their ids.
 */
export interface PhaseObservation {
  readonly outcome: { readonly kind: 'resolved'; readonly result: unknown } | { readonly kind: 'rejected'; readonly error: unknown };
  readonly stored: Readonly<Record<string, readonly unknown[]>>;
  readonly trace: readonly TraceEvent[];
  readonly executions: readonly Execution[];
  /** Every event the run's `watch()` delivered during this phase, in arrival order; absent, not observed. */
  readonly events?: readonly unknown[];
}

export interface ResumeObservation {
  readonly phases: readonly PhaseObservation[];
}

/** A resumable fixture as the harness sees it: a name and a way to run it on any route. */
export interface ResumeCase {
  readonly name: string;
  readonly run: (route: ResumeRoute) => Promise<ResumeObservation>;
  /**
   * Paths `phases.<i>.kind`, `phases.<i>.result.<…>`, `phases.<i>.error.<…>`,
   * `phases.<i>.stored.<workflow>.<n>.<…>`, `phases.<i>.events.<group>.<n>.<…>`, `trace.<label>`
   * and `order.<a>.<b>`.
   */
  readonly divergences?: readonly Attribution[];
  readonly independent?: readonly IndependentPair[];
  /** The petri engine's run budget, checked on every phase the petri engine ran; absent, unbounded. */
  readonly concurrency?: number;
  /** The routes to run; absent, {@link RESUME_ROUTES}. */
  readonly routes?: readonly ResumeRoute[];
}

/** A resume verdict: a {@link Verdict} for one route, its fixture named `<fixture> [<route>]`. */
export interface ResumeVerdict extends Verdict {
  readonly route: ResumeRoute;
  /** Each phase's outcome on the oracle, in order: a status, or `rejected`. */
  readonly oraclePhases: readonly string[];
}

/**
 * The positions a suspend-then-resume comparison excludes: {@link EXCLUDED_PATHS} but the suspend
 * stamp's run id, and the same kinds of values where Mastra writes them in a stored
 * `WorkflowRunState` — its `timestamp` and `runId`, a record's clock fields, the tracing ids — and in
 * a `.foreach()` aggregate's per-item `foreachOutput` entries (`handlers/control-flow.ts:1432-1450`).
 *
 * The suspend stamp's `__workflow_meta.runId` is **compared**: on a resume it is load-bearing —
 * Mastra resumes a nested child by it (`handlers/step.ts:430`) — and it is stable without masking.
 * A top-level run id is fixed per fixture, and a nested child's is a UUID that {@link normalise}
 * turns into its first-seen ordinal, so a stamp naming the wrong child is a difference.
 */
export const RESUME_EXCLUDED_PATHS: readonly string[] = (() => {
  const clock = ['startedAt', 'endedAt', 'suspendedAt', 'resumedAt', 'pausedAt'];
  const records = (root: string) => [
    ...clock.map((k) => `${root}.*.${k}`),
    ...clock.map((k) => `${root}.*.suspendPayload.__workflow_meta.foreachOutput.*.${k}`),
  ];
  return [
    ...EXCLUDED_PATHS.filter((p) => !p.endsWith('.__workflow_meta.runId')),
    ...records('result.steps'),
    'stored.*.*.timestamp',
    'stored.*.*.runId',
    'stored.*.*.tracingContext.traceId',
    'stored.*.*.tracingContext.spanId',
    'stored.*.*.tracingContext.parentSpanId',
    ...records('stored.*.*.context'),
  ];
})();

/**
 * Runs the case's oracles (one per process mode used), then each candidate route — sequentially,
 * never interleaved — and compares each candidate with its oracle.
 */
export async function runResume(fixture: ResumeCase): Promise<ResumeVerdict[]> {
  const routes = fixture.routes ?? RESUME_ROUTES;
  const oracles = new Map<string, { observation: ResumeObservation; ms: number }>();
  const timed = async (route: ResumeRoute) => {
    const t0 = performance.now();
    const observation = await fixture.run(route);
    return { observation, ms: performance.now() - t0 };
  };
  const verdicts: ResumeVerdict[] = [];
  for (const route of routes) {
    const o = oracleRoute(route);
    const key = routeLabel(o);
    let oracle = oracles.get(key);
    if (oracle === undefined) {
      oracle = await timed(o);
      oracles.set(key, oracle);
    }
    const candidate = await timed(route);
    verdicts.push(
      compareResume(fixture.name, route, oracle.observation, candidate.observation, fixture.divergences ?? [], fixture.independent ?? [], {
        ...(fixture.concurrency === undefined ? {} : { concurrency: fixture.concurrency }),
        wallMs: { oracle: oracle.ms, candidate: candidate.ms },
      }),
    );
  }
  return verdicts;
}

/**
 * The whole comparison of one route with its oracle, pure. Per phase: identity (the phase ran on its
 * route's engine only, and executed the same workflows as often as the oracle's), then the data —
 * the outcome and every stored snapshot. Then happens-before over the phases' traces in order, and
 * the budget on each phase the petri engine ran.
 */
export function compareResume(
  name: string,
  route: ResumeRoute,
  oracle: ResumeObservation,
  candidate: ResumeObservation,
  attributions: readonly Attribution[],
  independent: readonly IndependentPair[] = [],
  options: CompareOptions = {},
): ResumeVerdict {
  const identity: string[] = [];
  const raw: { path: string; oracle: unknown; candidate: unknown }[] = [];
  const budget: string[] = [];
  const eventsWeakened: [string, string][] = [];
  const k = options.concurrency;
  const ou = new Map<string, number>();
  const cu = new Map<string, number>();

  if (oracle.phases.length !== candidate.phases.length) {
    raw.push({ path: 'phases.length', oracle: oracle.phases.length, candidate: candidate.phases.length });
  }
  const n = Math.min(oracle.phases.length, candidate.phases.length);
  for (let i = 0; i < n; i++) {
    const o = oracle.phases[i]!;
    const c = candidate.phases[i]!;
    const at = `phases.${i}`;
    identity.push(...phaseIdentity(i, o, 'default', c, phaseEngine(route, i)));

    if (o.outcome.kind !== c.outcome.kind) {
      raw.push({ path: `${at}.kind`, oracle: o.outcome.kind, candidate: c.outcome.kind });
    } else {
      const root = o.outcome.kind === 'resolved' ? 'result' : 'error';
      const a = o.outcome.kind === 'resolved' ? o.outcome.result : o.outcome.error;
      const b = c.outcome.kind === 'resolved' ? c.outcome.result : c.outcome.error;
      const out: { path: string; oracle: unknown; candidate: unknown }[] = [];
      diff(normalise(a, [root], ou, ...clockMasked(RESUME_EXCLUDED_PATHS)), normalise(b, [root], cu, ...clockMasked(RESUME_EXCLUDED_PATHS)), [root], out);
      for (const d of out) raw.push({ ...d, path: `${at}.${d.path}` });
    }
    const out: { path: string; oracle: unknown; candidate: unknown }[] = [];
    diff(normalise(o.stored, ['stored'], ou, ...clockMasked(RESUME_EXCLUDED_PATHS)), normalise(c.stored, ['stored'], cu, ...clockMasked(RESUME_EXCLUDED_PATHS)), ['stored'], out);
    for (const d of out) raw.push({ ...d, path: `${at}.${d.path}` });
    if (o.events !== undefined || c.events !== undefined) {
      const events = compareEventsDetailed(eventsOf(o), eventsOf(c), {
        root: `${at}.events`,
        oracleUuids: ou,
        candidateUuids: cu,
        excluded: RESUME_EVENT_EXCLUDED_PATHS,
        independent,
      });
      raw.push(...events.differences);
      for (const [x, y] of events.weakened) eventsWeakened.push([`${at}.${x}`, `${at}.${y}`]);
    }

    if (k !== undefined && phaseEngine(route, i) === 'petri') {
      const peak = peakInFlight(c.trace);
      if (peak > k) budget.push(`phase ${i}: candidate had ${peak} steps in flight at once, above its budget of ${k}`);
    }
  }

  const oTrace = oracle.phases.flatMap((p) => p.trace);
  const cTrace = candidate.phases.flatMap((p) => p.trace);
  const ordering = compareOrder(oTrace, cTrace, independent);
  for (const label of ordering.onlyOracle) raw.push({ path: `trace.${label}`, oracle: 'ran', candidate: 'did not run' });
  for (const label of ordering.onlyCandidate) raw.push({ path: `trace.${label}`, oracle: 'did not run', candidate: 'ran' });
  for (const [a, b] of ordering.report.reversed) raw.push({ path: `order.${a}.${b}`, oracle: `${a} before ${b}`, candidate: `${b} before ${a}` });
  for (const [a, b] of ordering.report.inverted) {
    raw.push({ path: `order.${a}.${b}`, oracle: `${a} before ${b}`, candidate: `${b} started before ${a} ended` });
  }

  const { differences, unused, verdict } = settle(raw, attributions, (at) => appliesOn(at, route), identity.length > 0 || budget.length > 0);
  const phaseOutcome = (p: PhaseObservation) => outcomeOf(p.outcome.kind === 'resolved' ? { kind: 'resolved', result: p.outcome.result, trace: [], executions: [] } : { kind: 'rejected', error: p.outcome.error, trace: [], executions: [] });
  const oraclePhases = oracle.phases.map(phaseOutcome);
  const petriPhases = candidate.phases.filter((_, i) => phaseEngine(route, i) === 'petri');
  return {
    fixture: `${name} [${routeLabel(route)}]`,
    route,
    oraclePhases,
    verdict,
    oracleOutcome: oraclePhases.join('>'),
    identity,
    executions: {
      oracle: countByEngine(oracle.phases.flatMap((p) => p.executions)),
      candidate: countByEngine(candidate.phases.flatMap((p) => p.executions)),
    },
    differences,
    ordering: { ...ordering.report, eventsWeakened },
    unusedAttributions: unused,
    budget,
    measurements: {
      concurrency: k ?? 'unbounded',
      peakInFlight: {
        oracle: Math.max(0, ...oracle.phases.map((p) => peakInFlight(p.trace))),
        candidate: Math.max(0, ...petriPhases.map((p) => peakInFlight(p.trace))),
      },
      wallMs: { oracle: options.wallMs?.oracle ?? null, candidate: options.wallMs?.candidate ?? null },
    },
  };
}

/**
 * Identity of one phase: the oracle's ran on Mastra's engine only, the candidate's on its route's
 * engine only, and both executed the same workflows the same number of times. A resolved phase went
 * through `execute()` at least once; a rejected one may not have (`Run.resume` validates first).
 */
function phaseIdentity(i: number, oracle: PhaseObservation, oracleEngine: EngineName, candidate: PhaseObservation, candidateEngine: EngineName): string[] {
  const problems: string[] = [];
  for (const [p, side, engine] of [
    [oracle, 'oracle', oracleEngine],
    [candidate, 'candidate', candidateEngine],
  ] as const) {
    for (const e of p.executions) if (e.engine !== engine) problems.push(`phase ${i}: ${side} executed '${e.workflowId}' on the ${e.engine} engine, expected ${engine}`);
    if (p.outcome.kind === 'resolved' && p.executions.length === 0) problems.push(`phase ${i}: ${side} resolved without any engine's execute()`);
  }
  const perWorkflow = (p: PhaseObservation) => {
    const m = new Map<string, number>();
    for (const e of p.executions) m.set(e.workflowId, (m.get(e.workflowId) ?? 0) + 1);
    return m;
  };
  // A phase that resolved on one side and was rejected on the other is a data difference
  // (`phases.<i>.kind`), gated or attributed there; its execute() counts cannot agree.
  if (oracle.outcome.kind !== candidate.outcome.kind) return problems;
  const a = perWorkflow(oracle);
  const b = perWorkflow(candidate);
  for (const id of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(id) ?? 0;
    const y = b.get(id) ?? 0;
    if (x !== y) problems.push(`phase ${i}: '${id}' executed ${x} time(s) by the oracle, ${y} by the candidate`);
  }
  return problems;
}

/**
 * The resume report: one row per fixture and route, one column per budget, then every difference
 * with its row or as a FINDING — {@link formatDifferentialReport} over the route-named verdicts.
 */
export function formatResumeReport(verdicts: readonly ResumeVerdict[]): string {
  return formatDifferentialReport(verdicts);
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
export function normalise(
  value: unknown,
  at: readonly string[] = [],
  uuids: Map<string, number> = new Map(),
  excluded: readonly string[] = EXCLUDED_PATHS,
  masked: readonly string[] = [],
): unknown {
  const patterns = excluded.map((p) => p.split('.'));
  return norm(value, [...at], uuids, new WeakSet(), patterns, masked.map((p) => p.split('.')));
}

/**
 * A masked value: its kind, never its content — `<clock:number>`, `<clock:string>`, `<clock:null>`,
 * … and `undefined` as itself — so a key present on one side and absent on the other, or holding
 * another kind of value, is still a difference.
 */
function mask(v: unknown): unknown {
  if (v === undefined) return undefined;
  return `<clock:${v === null ? 'null' : v instanceof Date ? 'Date' : typeof v}>`;
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

function norm(
  value: unknown,
  path: string[],
  uuids: Map<string, number>,
  seen: WeakSet<object>,
  excluded: readonly (readonly string[])[],
  masked: readonly (readonly string[])[] = [],
): unknown {
  if (typeof value === 'string') return ordinal(value, uuids);
  if (typeof value === 'symbol') return { $symbol: value.description ?? '' };
  if (typeof value === 'function') return { $function: value.name };
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  try {
    if (value instanceof Date) return { $date: Number.isNaN(value.getTime()) ? 'invalid' : value.toISOString() };
    if (Array.isArray(value)) {
      return Array.from({ length: value.length }, (_, i) => (i in value ? norm(value[i], [...path, String(i)], uuids, seen, excluded, masked) : HOLE));
    }
    if (value instanceof Map) {
      return { $map: [...value.entries()].map(([k, v], i) => [norm(k, [...path, '$map', String(i), '0'], uuids, seen, excluded, masked), norm(v, [...path, '$map', String(i), '1'], uuids, seen, excluded, masked)]) };
    }
    if (value instanceof Set) return { $set: [...value].map((v, i) => norm(v, [...path, '$set', String(i)], uuids, seen, excluded, masked)) };

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
      if (value.cause !== undefined) put('$cause', norm(value.cause, [...path, '$cause'], uuids, seen, excluded, masked));
    }
    for (const [k, v] of Object.entries(value)) {
      const key = ordinal(k, uuids);
      const next = [...path, key];
      if (excluded.some((p) => matchSegments(p, next))) continue;
      if (masked.some((p) => matchSegments(p, next))) {
        put(key, mask(v));
        continue;
      }
      put(key, norm(v, next, uuids, seen, excluded, masked));
    }
    for (const s of Object.getOwnPropertySymbols(value)) {
      if (!Object.prototype.propertyIsEnumerable.call(value, s)) continue;
      const key = `@@${s.description ?? ''}`;
      put(key, norm((value as Record<symbol, unknown>)[s], [...path, key], uuids, seen, excluded, masked));
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
export function diff(a: unknown, b: unknown, path: string[], out: { path: string; oracle: unknown; candidate: unknown }[]): void {
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

/** A span over one side's sequence: indices of its opening and closing events; `end` undefined, never closed. */
export interface Span {
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

export function compareOrder(
  oracleTrace: readonly TraceEvent[],
  candidateTrace: readonly TraceEvent[],
  independent: readonly IndependentPair[],
): { report: OrderingReport; onlyOracle: string[]; onlyCandidate: string[] } {
  return compareSpanMaps(spans(oracleTrace), spans(candidateTrace), independent);
}

/**
 * Happens-before over two sides' spans, keyed alike (`<label>#<n>`): every oracle `a -> b` the
 * candidate lacks is weakened (a declared independent pair), reversed or inverted; every candidate
 * ordering the oracle has neither way round is strengthened. Keys on one side only are listed apart.
 */
function compareSpanMaps(
  o: ReadonlyMap<string, Span>,
  c: ReadonlyMap<string, Span>,
  independent: readonly IndependentPair[],
): { report: OrderingReport; onlyOracle: string[]; onlyCandidate: string[] } {
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
  const startOrder = (m: ReadonlyMap<string, Span>) => [...m.entries()].sort((x, y) => x[1].start - y[1].start).map(([k]) => k);
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

/**
 * What the events dimension shows across verdicts: how many fixtures fail on events alone, and
 * every unattributed event difference by {@link eventPattern} with the fixtures it appears in, so
 * what an event implementation still lacks reads as a short list.
 */
export function formatEventSummary(verdicts: readonly Verdict[]): string[] {
  const lines = ['event differences (unattributed), by pattern'];
  const onlyEvents = verdicts.filter((v) => {
    const findings = v.differences.filter((d) => d.row === undefined);
    return findings.length > 0 && findings.every((d) => isEventPath(d.path)) && v.identity.length === 0 && v.budget.length === 0;
  });
  lines.push(`${onlyEvents.length} of ${verdicts.length} verdict(s) have findings on events only`);
  const byPattern = new Map<string, Set<string>>();
  for (const v of verdicts) {
    const label = `${v.fixture} k=${v.measurements.concurrency === 'unbounded' ? 'inf' : v.measurements.concurrency}`;
    for (const d of v.differences) {
      if (d.row !== undefined || !isEventPath(d.path)) continue;
      const set = byPattern.get(eventPattern(d.path)) ?? new Set<string>();
      set.add(label);
      byPattern.set(eventPattern(d.path), set);
    }
  }
  for (const [pattern, where] of [...byPattern.entries()].sort((a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : 1))) {
    lines.push(`${String(where.size).padStart(4)}  ${pattern}`);
  }
  if (byPattern.size === 0) lines.push('none');
  return lines;
}

/** A difference's two sides, an event group's type sequence written `a > b > c`. */
function showPair(d: Difference): string {
  const side = (v: unknown) =>
    isEventPath(d.path) && Array.isArray(v) && v.every((x) => typeof x === 'string') ? `[${v.join(' > ')}]` : show(v);
  return `oracle=${side(d.oracle)}  petri=${side(d.candidate)}`;
}

function show(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s.length > 160 ? `${s.slice(0, 157)}...` : s;
  } catch {
    return String(v);
  }
}

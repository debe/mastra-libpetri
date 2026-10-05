import { Transition, and, one, outPlace, place, type In, type Out, type Place, type TransitionContext } from 'libpetri';
import { scopeOf, type RunScope } from '../scope.js';
import type { BailToken, CanceledToken, Exits, FailureToken, FlowToken, ForeachItemRecord, PauseToken, StepRecord, SuspendToken } from '../types.js';
import type { EntryPath } from '../names.js';
import { HostPreconditionError } from './leaf.js';

/**
 * What `.foreach()` ([`foreach.ts`]) and `pipeline()` ([`../blueprints/pipeline.ts`], [ADR 0015])
 * share: the frame, the cursor, the complement flags, the settle and finisher factories, the
 * aggregates and the item records. Extracted from `foreach.ts` unchanged — the foreach's net is
 * byte-identical (its `structuralHash`, a name-and-arc digest and `tests/verify/foreach.test.ts`'s
 * class counts pin it) — so the two gadgets cannot drift apart on what Mastra's aggregate is.
 *
 * Host-free, as the gadgets are. Line references are `handlers/control-flow.ts` unless named.
 */

/**
 * The undispatched tail of the input — Mastra's fastq queue, the colour of `queue.open`.
 *
 * One token, consumed and re-emitted by whichever lane starts the next item, so items *start* in
 * input order because there is only ever one cursor, not because anything iterates. A settle taking
 * it and leaving `queue.closed` is `queue.kill()`: nothing queued can start again.
 */
export interface ForeachCursor {
  readonly items: readonly unknown[];
  /**
   * The items still to start, in start order, the resumed ones flagged ([ADR 0007]) — a resume's
   * queue, which skips the items that succeeded and the ones that stay parked
   * (`handlers/control-flow.ts:1227-1272`). Absent on a fresh run, where it is `0..n-1`.
   */
  readonly order?: readonly CursorItem[];
  /** The position of the next item: in `order` when there is one, else in `items`. */
  readonly next: number;
}

/** One queued item: its index in the input, and whether it is the attempt a resume feeds. */
export interface CursorItem {
  readonly index: number;
  readonly resumed?: true;
}

/**
 * The foreach itself, from `split` to its finisher — Mastra's `stepInfo` (`:990-996`): the input
 * exactly as it arrived (a string stays a string) and when the foreach started. The success,
 * suspended and canceled aggregates are built on it; failure and exit aggregates are an item's.
 */
export interface ForeachFrame {
  readonly input: unknown;
  /** Absent only on a resume whose stored aggregate had none (Mastra writes no new one there). */
  readonly startedAt?: number;
  /**
   * A resumed foreach's `stepInfo` beyond `payload` and `startedAt`: the stored aggregate minus
   * Mastra's completion fields (`omitPriorCompletionFields`, `utils.ts:759-777`, spread first at
   * `handlers/control-flow.ts:990-996`). Absent on a fresh run.
   */
  readonly kept?: Readonly<Record<string, unknown>>;
  /**
   * Mastra's `prevForeachOutput` as the resume found it — the stored aggregate's
   * `__workflow_meta.foreachOutput`, holes kept (`:1040-1041`), with the succeeded items'
   * `suspendPayload` cleared as the queue loop clears it (`:1253-1255`). Absent on a fresh run.
   */
  readonly base?: readonly unknown[];
  /** Every item settled in this segment, latest first — each one's `foreachOutput` entry. */
  readonly settled?: Settled;
  /** Every item that succeeded, latest first — the `results` array's cells. */
  readonly results?: Cell<ForeachResult>;
  /** Every failure recorded, latest first: the earliest is Mastra's `errorResult`. */
  readonly faults?: Cell<FaultRecord>;
  /** Every bail or pause recorded, latest first: the earliest is Mastra's `exitResult`. */
  readonly exits?: Cell<ExitRecord>;
  /** Every suspension — recorded in this segment, or carried by a resume — latest first. */
  readonly suspensions?: Cell<SuspensionRecord>;
}

/** A list cell: the frame is re-emitted by every settle, and consing is O(1) where copying is not. */
export interface Cell<T> {
  readonly value: T;
  readonly prev: Cell<T> | undefined;
}

export const cons = <T>(list: Cell<T> | undefined, value: T): Cell<T> => ({ value, prev: list });

/** The list's values, earliest first. */
export function listOf<T>(list: Cell<T> | undefined): T[] {
  const out: T[] = [];
  for (let c = list; c !== undefined; c = c.prev) out.push(c.value);
  return out.reverse();
}

/**
 * One settled item's entry in Mastra's `foreachOutput` (`:1194-1198`), as a list cell: the frame
 * is re-emitted by every settle, and appending a cell is O(1) where copying an array is O(items).
 */
export interface Settled {
  readonly index: number;
  readonly record: StepRecord;
  readonly prev: Settled | undefined;
}

/**
 * What a lane is working on. Its presence *is* "this lane is busy". It holds no index — the
 * item's `foreachIndex` rides on every token the body emits — only what the item's own record
 * needs when that record becomes the foreach's (a failure, a bail, a pause).
 */
export interface ForeachSlot {
  readonly item: unknown;
  readonly startedAt: number;
}

/** One item's output, tagged with where it belongs in the output array. */
export interface ForeachResult {
  readonly index: number;
  readonly value: unknown;
}

/** A lane's permit. `null`, because presence is the whole message ([CORE-012] unit token). */
export type LanePermit = null;

/** When a recorded item ran, and on what — the fields of its own `StepResult`. */
export interface ItemFrame {
  readonly item: unknown;
  readonly startedAt: number;
  readonly endedAt: number;
}

/**
 * A failed item, recorded — Mastra's `errorResult` candidates. `entry` is the item's own record, the
 * one its `foreachOutput` entry is made from: the failed aggregate is that record
 * (`{...finalErrorResult}`, `handlers/control-flow.ts:1360-1370`).
 */
export interface FaultRecord extends ItemFrame {
  readonly failure: FailureToken;
  readonly entry: StepRecord;
}

/** A bailed or paused item, recorded — Mastra's `exitResult` candidates, returned as they are (`:1406`). */
export type ExitRecord =
  | (ItemFrame & { readonly status: 'bailed'; readonly bail: BailToken; readonly entry: StepRecord })
  | (ItemFrame & { readonly status: 'paused'; readonly pause: PauseToken; readonly entry: StepRecord });

/** A suspended item, recorded — Mastra's `foreachIndexObj`. */
export interface SuspensionRecord {
  readonly suspension: SuspendToken;
}

/**
 * How many lanes one `.foreach` may compile to — a pipeline's Σc_j included ([ADR 0015]).
 *
 * A lane is a full copy of the body, so the net is O(concurrency x |body|) and so is anything
 * that explores it. Mastra has no ceiling (`utils.ts:786-796`); refusing loudly beats compiling a
 * net nothing could explore, and the refusal is a recorded divergence, not a silent clamp.
 */
export const MAX_FOREACH_LANES = 256;

/** The largest item count that is still an array length; past it, `results[k]` stops being an index. */
const MAX_ITEMS = 2 ** 32 - 1;

/**
 * The items, read exactly as Mastra reads them: `for (let k = 0; k < prevOutput.length; k++)
 * queue.push(prevOutput[k])` (`handlers/control-flow.ts:1050`, `:1228`, `:1272`). There is no
 * array check anywhere at run time — the builder's `'Previous step must return an array type'`
 * (`workflow.ts:2618`) is a compile-time conditional type — so:
 *
 * - an array iterates its elements, holes as `undefined`;
 * - a string iterates its UTF-16 code units, and any array-like its indexed properties;
 * - anything whose `length` is not a number greater than 0 — a plain object, a number, a boolean —
 *   yields no items, so the foreach succeeds with `[]`.
 *
 * Where Mastra is not well-defined this fails instead, with an error that says why: `null` and
 * `undefined` make Mastra throw a `TypeError` out of `execute()`, so `run.start()` rejects
 * (nothing in `handlers/entry.ts` or `default.ts:894` catches it); an infinite `length` enqueues
 * forever; and past 2^32-1 items the result slots are no longer array indices.
 */
export function itemsOf(id: string, input: unknown): unknown[] {
  if (input === null || input === undefined) {
    throw new TypeError(
      `.foreach '${id}' received ${String(input)} from the previous step; it needs an array. ` +
        '(Mastra throws reading its length, which rejects the run.)',
    );
  }
  const source = input as { readonly length?: unknown; readonly [index: number]: unknown };
  // `k < prevOutput.length` converts exactly as Number() does, a thrown conversion included.
  const bound = Number(source.length);
  if (bound === Infinity || bound > MAX_ITEMS) {
    throw new RangeError(
      `.foreach '${id}' received input with length ${String(source.length)}; ` +
        `at most ${MAX_ITEMS} items can be iterated.`,
    );
  }
  const items: unknown[] = [];
  for (let k = 0; k < bound; k++) items.push(source[k]);
  return items;
}

// -------------------------------------------------------------------------------------------
// Places: the frame, the cursor, the complement flags.
// -------------------------------------------------------------------------------------------

/**
 * A recorded kind as a complement pair — exactly one of `off` / `on` marked from `split` to the
 * finisher. A settle moves its kind's token to `on`; the finishers' arcs on them encode Mastra's
 * precedence. Every arc on them takes one token, so no settle has an output another transition
 * tests by inhibitor, reset or drain, and none is split under [VER-004].
 */
export interface FlagPair {
  readonly off: Place<null>;
  readonly on: Place<null>;
}

/** `no-<kind>` and `<kind>`, named through the gadget's own place namer. */
export const flagPair = (p: (role: string) => string, kind: string): FlagPair => ({ off: place<null>(p(`no-${kind}`)), on: place<null>(p(kind)) });

/** The frame and the cursor pair: `frame`, `queue.open`, `queue.closed`. */
export interface FramePlaces<F> {
  /**
   * The foreach's one data token, from `split` to its finisher: everything the aggregate is built
   * from rides here — results, recorded outcomes, carried suspensions — so the net holds at most one
   * token per place, and every settle, which consumes and re-emits it, is ordered by it.
   */
  readonly frame: Place<F>;
  /** Items remain to start: the cursor over them — Mastra's fastq queue. */
  readonly queueOpen: Place<ForeachCursor>;
  /** No item will start again: the queue ran out, or a non-success settle killed it. */
  readonly queueClosed: Place<null>;
}

export function framePlaces<F>(p: (role: string) => string): FramePlaces<F> {
  return { frame: place<F>(p('frame')), queueOpen: place<ForeachCursor>(p('queue.open')), queueClosed: place<null>(p('queue.closed')) };
}

/** A builder step that adds the signal's inhibitor given a signal, and is the identity without one. */
export type Gate = (b: ReturnType<typeof Transition.builder>) => ReturnType<typeof Transition.builder>;

/** Adds the signal's inhibitor to a transition that starts or decides work, given a signal. */
export const unlessCanceledBy = (cancel: Place<null> | undefined): Gate => (b) => (cancel === undefined ? b : b.inhibitor(cancel));

/** No gate: the transition fires whatever the signal says. */
export const ungated: Gate = (b) => b;

/**
 * The opened foreach's outputs, as one `and`: the frame, the queue (open or closed), one place of
 * each complement pair, every permit — so no marking exists with permits and no queue (outputs of a
 * firing land together, [EXEC-001]).
 */
export const openedOut = (frame: Place<unknown>, queue: Place<unknown>, flags: readonly Place<null>[], permits: readonly Place<LanePermit>[]): Out =>
  and(outPlace(frame), outPlace(queue), ...flags.map((f) => outPlace(f)), ...permits.map((pl) => outPlace(pl)));

/**
 * The cancel sweep on the input — Mastra's check before the entry (`default.ts:815`): the foreach
 * never starts. Records nothing — Mastra writes no step result for an entry it skipped.
 */
export function cancelSweep(name: string, inPlace: Place<FlowToken>, cancel: Place<null>, canceled: Place<CanceledToken>, origin: { readonly stepId: string; readonly path: EntryPath }): Transition {
  return Transition.builder(name)
    .inputs(one(inPlace))
    .read(cancel)
    .outputs(outPlace(canceled))
    .action(async (tctx) => {
      tctx.input(inPlace);
      tctx.output(canceled, { origin, started: false });
    })
    .build();
}

/**
 * `split`'s action: reads the items, publishes the foreach's start, and either fails the foreach
 * (an input Mastra cannot iterate, see {@link itemsOf}) or hands `open` the fresh frame and the
 * cursor — `undefined` when there are no items, which opens the foreach with the queue closed.
 */
export function splitAction(
  entryId: string,
  bodyId: string,
  viewPath: EntryPath,
  inPlace: Place<FlowToken>,
  failed: Place<FailureToken>,
  open: (tctx: TransitionContext, f: ForeachFrame, cursor: ForeachCursor | undefined) => void,
): (tctx: TransitionContext) => Promise<void> {
  return async (tctx) => {
    const incoming = tctx.input(inPlace);
    const scope = scopeOf(tctx);
    const startedAt = scope.epochNow();

    // Decide, then emit ([EXEC-031]: the input is already gone and nothing is restored).
    let items: readonly unknown[] | undefined;
    let error: unknown;
    try {
      items = itemsOf(entryId, incoming.data);
    } catch (e) {
      error = e;
    }

    // Mastra publishes the foreach's start before it reads the input's length
    // (`handlers/control-flow.ts:1015-1027,1053`), so a foreach over a non-array starts too.
    const observed = scope.observe({
      kind: 'foreach-entered',
      stepId: bodyId,
      path: viewPath,
      input: incoming.data,
      startedAt,
      items: items?.length,
      resumed: false,
    });
    if (observed !== undefined) await observed;
    if (items === undefined) {
      const record: StepRecord = {
        status: 'failed',
        error,
        payload: incoming.data,
        startedAt,
        endedAt: scope.epochNow(),
      };
      scope.recordStepResult(bodyId, record);
      const settled = scope.observe({ kind: 'foreach-settled', stepId: bodyId, path: viewPath, record });
      if (settled !== undefined) await settled;
      tctx.output(failed, { stepId: bodyId, path: viewPath, error });
      return;
    }
    open(tctx, { input: incoming.data, startedAt }, items.length > 0 ? { items, next: 0 } : undefined);
  };
}

// -------------------------------------------------------------------------------------------
// Item records.
// -------------------------------------------------------------------------------------------

/**
 * The item's own record, for its `foreachOutput` entry (`:1194-1198`): what the body's leaf just
 * recorded under the body id, when that record is still this item's — a sibling that settled in
 * between may have overwritten it (every item shares the id, `:1179`) — else rebuilt from the
 * outcome token and the lane's slot. Data only: nothing here decides what fires.
 */
export function itemRecordOf(scope: RunScope, bodyId: string, k: number, status: StepRecord['status'], rebuilt: () => StepRecord): StepRecord {
  const recorded = scope.getStepResult(bodyId);
  return recorded !== undefined && recorded.status === status && recorded.metadata?.foreachIndex === k ? recorded : rebuilt();
}

/** Re-emits the frame with one more settled item. */
export const settleInto = (f: ForeachFrame, index: number, record: StepRecord): ForeachFrame => ({
  ...f,
  settled: { index, record, prev: f.settled },
});

/**
 * A host refusal on a failure token ([`HostPreconditionError`]): the host refused the item before
 * it ran. Outside a foreach the run rejects with its cause, as Mastra's resume does; inside one,
 * Mastra's worker catches the throw as a failed item (`handlers/control-flow.ts:1200-1217`), so the
 * foreach fails with the cause as the item's error.
 */
export function hostRefusal(token: unknown): { readonly cause: unknown } | undefined {
  const error = (token as { readonly error?: unknown }).error;
  return error instanceof HostPreconditionError ? { cause: error.cause } : undefined;
}

/**
 * The index an item's success token carries — the leaf copies the dispatch token's `foreachIndex`
 * onto it. A token without one is a broken contract, and failing loudly beats misplacing a result.
 */
export function indexOf(token: FlowToken, id: string): number {
  if (token.foreachIndex === undefined) {
    throw new Error(`.foreach '${id}': an item's result arrived without its foreachIndex`);
  }
  return token.foreachIndex;
}

/**
 * One item's entry in Mastra's `foreachOutput`: the item's own result, its `suspendPayload` cleared
 * unless it is still suspended (`:1194-1198`, `:1253-1255`).
 *
 * The item's result is its record as the host would hold it: the host's own fields a record does
 * not model (a resumed item's `resumePayload` and `resumedAt`, …) under the record's, and `metadata`
 * merged — the host's (a nested workflow item's `nestedRunId`, `handlers/step.ts:559-561`) with the
 * record's. The foreach index the engine stamps in `metadata` goes: Mastra never stores it. A
 * record's own fields always win over the host's copies, as the codec reads a record.
 */
export function foreachEntry(record: StepRecord): Record<string, unknown> {
  const { host, metadata, ...rest } = record as StepRecord & { readonly metadata?: Record<string, unknown> };
  const hostRecord = host !== null && typeof host === 'object' ? (host as Record<string, unknown>) : {};
  const { metadata: hostMeta, ...hostRest } = hostRecord;
  const inherited = Object.fromEntries(Object.entries(hostRest).filter(([k]) => !RECORD_FIELDS.has(k)));
  const { foreachIndex: _index, ...own } = metadata ?? {};
  const meta = { ...(hostMeta !== null && typeof hostMeta === 'object' ? (hostMeta as Record<string, unknown>) : {}), ...own };
  const entry = { ...inherited, ...rest, ...(Object.keys(meta).length > 0 ? { metadata: meta } : {}) };
  return record.status === 'suspended' ? entry : { ...entry, suspendPayload: {} };
}

/** A `StepRecord`'s own fields: a host's copies of these never reach a `foreachOutput` entry. */
const RECORD_FIELDS: ReadonlySet<string> = new Set([
  'status',
  'output',
  'error',
  'tripwire',
  'nonRetryable',
  'payload',
  'startedAt',
  'endedAt',
  'suspendedAt',
  'suspendPayload',
  'suspendOutput',
  'metadata',
]);

/**
 * Mastra's `prevForeachOutput` at a finisher: the resume's base with every item settled in this
 * segment written over it, in settle order. `slice()`, not a spread, so holes stay holes, as
 * Mastra's integer-indexed writes leave them.
 */
export function foreachOutputOf(f: ForeachFrame): unknown[] {
  const out: unknown[] = f.base === undefined ? [] : f.base.slice();
  const cells: Settled[] = [];
  for (let c = f.settled; c !== undefined; c = c.prev) cells.push(c);
  for (let i = cells.length - 1; i >= 0; i--) out[cells[i]!.index] = foreachEntry(cells[i]!.record);
  return out;
}

/** The same entries as the token's `ForeachMeta` carries them: by index, holes and nulls skipped. */
export function itemRecordsOf(foreachOutput: readonly unknown[]): ForeachItemRecord[] {
  const out: ForeachItemRecord[] = [];
  foreachOutput.forEach((entry, index) => {
    if (entry !== null && entry !== undefined) out.push({ index, record: entry as StepRecord });
  });
  return out;
}

/** A stored aggregate's `__workflow_meta.foreachOutput`, or none. */
export function storedForeachOutput(record: StepRecord | undefined): readonly unknown[] {
  const payload = (record as { readonly suspendPayload?: unknown } | undefined)?.suspendPayload;
  if (payload === null || typeof payload !== 'object') return [];
  const meta = (payload as { readonly __workflow_meta?: unknown }).__workflow_meta;
  if (meta === null || typeof meta !== 'object') return [];
  const output = (meta as { readonly foreachOutput?: unknown }).foreachOutput;
  return Array.isArray(output) ? output : [];
}

// -------------------------------------------------------------------------------------------
// The aggregates.
// -------------------------------------------------------------------------------------------

/** `results[k] = output` only when the output is defined (`:1189-1191`) — holes stay holes. */
export function assemble(collected: readonly ForeachResult[]): unknown[] {
  const output: unknown[] = [];
  for (const r of collected) if (r.value !== undefined) output[r.index] = r.value;
  return output;
}

/**
 * The aggregate's `stepInfo` (`:990-996`): the foreach's input and start on a fresh run; on a
 * resume, the stored aggregate minus its completion fields, which keeps its `payload` and
 * `startedAt` — Mastra writes `resumePayload` and `resumedAt` there instead, which are the
 * host's (`docs/divergences.md`).
 */
export const stepInfo = (f: ForeachFrame) => ({
  ...f.kept,
  payload: f.input,
  ...(f.startedAt === undefined ? {} : { startedAt: f.startedAt }),
});

/** The success aggregate, `{...stepInfo, status, output: results, endedAt}` (`:1486-1492`), and its output. */
export function successAggregate(f: ForeachFrame, endedAt: number): { readonly record: StepRecord; readonly output: unknown[] } {
  const output = assemble(listOf(f.results));
  return { record: { ...stepInfo(f), status: 'success', output, endedAt } as StepRecord, output };
}

/**
 * The failed aggregate: the first failure in time — Mastra's `if (!errorResult) errorResult = result`
 * (`:1130`, `:1210`) — as its own record, `{...finalErrorResult}` (`:1360-1370`), plus Mastra's
 * `__workflow_meta.foreachOutput`, every item settled so far. Its `resumeLabels` are the run's, which
 * only the host holds.
 */
export function failedAggregate(f: ForeachFrame): { readonly record: StepRecord; readonly first: FaultRecord; readonly foreachOutput: unknown[] } {
  const first = listOf(f.faults)[0]!;
  const foreachOutput = foreachOutputOf(f);
  const { suspendPayload: _none, ...own } = first.entry as StepRecord & { readonly suspendPayload?: unknown };
  const record = { ...own, suspendPayload: { __workflow_meta: { foreachOutput } } } as StepRecord;
  return { record, first, foreachOutput };
}

/**
 * The suspended aggregate, `{...stepInfo, suspendedAt, status, suspendPayload}` (`:1432-1450`): the
 * lowest suspended index (`Object.keys(...)[0]`, `:1411-1412`), its suspend payload with Mastra's
 * `__workflow_meta.{foreachIndex, foreachOutput}` merged in — spread exactly as Mastra spreads it —
 * and no `endedAt`.
 */
export function suspendedAggregate(
  f: ForeachFrame,
  suspendedAt: number,
): { readonly record: StepRecord; readonly lowest: SuspendToken; readonly foreachIndex: number; readonly foreachOutput: unknown[] } {
  const recorded = listOf(f.suspensions).map((r) => r.suspension);
  let lowest = recorded[0]!;
  for (const r of recorded) if ((r.foreachIndex ?? 0) < (lowest.foreachIndex ?? 0)) lowest = r;
  const foreachIndex = lowest.foreachIndex ?? 0;
  const foreachOutput = foreachOutputOf(f);
  const own = lowest.payload as { readonly __workflow_meta?: object } | null | undefined;
  const record = {
    ...stepInfo(f),
    status: 'suspended',
    // Spread exactly as Mastra spreads it: a primitive payload spreads as JS spreads it.
    suspendPayload: {
      ...(lowest.payload as object),
      __workflow_meta: { ...(own ?? {})?.__workflow_meta, foreachIndex, foreachOutput },
    },
    suspendedAt,
  } as StepRecord;
  return { record, lowest, foreachIndex, foreachOutput };
}

/** The canceled aggregate, `{...stepInfo, status: 'canceled', output: results, endedAt}` (`:1164-1169`, `:1298-1312`). */
export function canceledAggregate(f: ForeachFrame, endedAt: number): { readonly record: StepRecord; readonly output: unknown[] } {
  const output = assemble(listOf(f.results));
  return { record: { ...stepInfo(f), status: 'canceled', output, endedAt }, output };
}

/** Records the aggregate under the body id, as `entry.ts:811-812` does, and publishes it. */
export async function writeAggregate(scope: RunScope, bodyId: string, viewPath: EntryPath, record: StepRecord): Promise<void> {
  scope.recordStepResult(bodyId, record);
  const observed = scope.observe({ kind: 'foreach-settled', stepId: bodyId, path: viewPath, record });
  if (observed !== undefined) await observed;
}

// -------------------------------------------------------------------------------------------
// The settle factory.
// -------------------------------------------------------------------------------------------

/** Which settle variants a lane gets, as `[queue, again]`. */
export type SettleVariant = readonly [queue: 'open' | 'closed', again: boolean];

/**
 * The foreach's four: the queue open or already closed, the flag off or already on. A pipeline
 * omits `['open', true]` ([ADR 0015], the W0 amendment): without a resume path nothing raises a
 * flag beside an open queue, so that settle is dead.
 */
export const FOUR_SETTLES: readonly SettleVariant[] = [
  ['open', false],
  ['open', true],
  ['closed', false],
  ['closed', true],
];
export const THREE_SETTLES: readonly SettleVariant[] = [
  ['open', false],
  ['closed', false],
  ['closed', true],
];

/** The settle's name suffix for a variant: `''`, `.again`, `.queue-closed`, `.queue-closed.again`. */
export const settleSuffix = ([queue, again]: SettleVariant): string => `${queue === 'closed' ? '.queue-closed' : ''}${again ? '.again' : ''}`;

/**
 * One non-success settle per variant: records the outcome on the frame, kills the queue, raises its
 * kind's flag, frees the lane. Each arc takes one token — no reset, no inhibitor, no drain — so the
 * settle is never split ([VER-004]). Taking the queue token is the kill, and it is race-free: a
 * sibling's `start` in flight holds the queue, and the settle waits for it to come back rather
 * than resetting an empty place and letting the start revive it.
 *
 * Priority 1, above every `start` (0): when an item's outcome lands while the queue is open and a
 * lane is idle, the executor kills the queue before it starts another item ([EXEC-002]). The
 * verifier, which ignores priority, explores that window too; nothing it proves depends on it.
 *
 * `record` is the gadget's: given the consumed outcome, slot and frame, it returns the frame to put
 * back. It runs synchronously when it returns a frame, so a gadget whose record awaits nothing
 * fires exactly as before the extraction.
 */
export function settleTransitions<T, S, F>(spec: {
  readonly name: (variant: SettleVariant) => string;
  readonly variants: readonly SettleVariant[];
  readonly gate: Gate;
  readonly from: Place<T>;
  readonly slot: Place<S>;
  readonly frame: Place<F>;
  readonly permit: Place<LanePermit>;
  readonly queueOpen: Place<ForeachCursor>;
  readonly queueClosed: Place<null>;
  readonly kind: FlagPair;
  readonly record: (tctx: TransitionContext, arrived: T, slot: S, frame: F) => F | Promise<F>;
}): Transition[] {
  const { from, slot, frame, permit, queueOpen, queueClosed, kind } = spec;
  return spec.variants.map((variant) => {
    const [queue, again] = variant;
    return spec
      .gate(Transition.builder(spec.name(variant)))
      .inputs(one(from), one(slot), one(frame), one(queue === 'open' ? queueOpen : queueClosed), one(again ? kind.on : kind.off))
      .outputs(and(outPlace(frame), outPlace(permit), outPlace(queueClosed), outPlace(kind.on)))
      .priority(1)
      .action(async (tctx) => {
        const arrived = tctx.input(from);
        const s = tctx.input(slot);
        const f = tctx.input(frame);
        tctx.input(queue === 'open' ? queueOpen : queueClosed);
        tctx.input(again ? kind.on : kind.off);
        const recorded = spec.record(tctx, arrived, s, f);
        tctx.output(frame, recorded instanceof Promise ? await recorded : recorded);
        tctx.output(permit, null);
        tctx.output(queueClosed, null);
        tctx.output(kind.on, null);
      })
      .build();
  });
}

// -------------------------------------------------------------------------------------------
// The finisher factory.
// -------------------------------------------------------------------------------------------

export type FlagState = 'off' | 'on';

/** One complement pair as a finisher sees it: the states it accepts, and its letter in the name. */
export interface FinisherFlag {
  readonly pair: FlagPair;
  readonly letter: string;
  readonly accepts: readonly FlagState[];
}

/**
 * How a finisher variant is named. `'on'` — the foreach's — letters every flag that is on
 * (`fail.f`, `fail.fe`, …); `'varying'` letters only the flags whose state the finisher does not fix
 * (`fail.clean`, `fail.s`). Either way a finisher with one combination is named by its role alone.
 */
export type FinisherNaming = 'on' | 'varying';

/**
 * A finisher's arcs: the queue closed — nothing can start — every permit — no item still running,
 * so no outcome can arrive after the decision — the frame, and one token of each flag, which is
 * where Mastra's precedence lives. One transition is emitted per combination of accepted flag
 * states (the first flag outermost), each taking its tokens with one arc, and every combination of
 * flags is decided by exactly one finisher.
 */
export function finisherTransitions(spec: {
  readonly name: (role: string) => string;
  readonly role: string;
  readonly naming: FinisherNaming;
  readonly queueClosed: Place<null>;
  readonly frame: Place<unknown>;
  readonly flags: readonly FinisherFlag[];
  readonly permits: readonly In[];
  readonly build: (b: ReturnType<typeof Transition.builder>, flags: readonly Place<null>[]) => Transition;
}): Transition[] {
  const combos: FlagState[][] = spec.flags.reduce<FlagState[][]>((acc, flag) => acc.flatMap((prefix) => flag.accepts.map((s) => [...prefix, s])), [[]]);
  const single = combos.length === 1;
  return combos.map((states) => {
    const flags = states.map((s, i) => spec.flags[i]!.pair[s]);
    const suffix = states
      .map((s, i) => (s === 'on' && (spec.naming === 'on' || spec.flags[i]!.accepts.length > 1) ? spec.flags[i]!.letter : ''))
      .join('');
    const name = single ? spec.role : `${spec.role}.${suffix === '' ? 'clean' : suffix}`;
    return spec.build(Transition.builder(spec.name(name)).inputs(one(spec.queueClosed), one(spec.frame), ...flags.map((f) => one(f)), ...spec.permits), flags);
  });
}

/** Takes a finisher's queue, flags and permits; returns the frame. */
export function takeAll<F>(tctx: TransitionContext, queueClosed: Place<null>, frame: Place<F>, flags: readonly Place<null>[], permits: readonly Place<LanePermit>[]): F {
  tctx.input(queueClosed);
  for (const f of flags) tctx.input(f);
  for (const pl of permits) tctx.input(pl);
  return tctx.input(frame);
}

/**
 * A lane's local exits, never the context's: a sibling lane mid-item still holds a slot, and an
 * outcome that jumped straight to a terminal would strand it. Local exits let every in-flight item
 * finish, as Mastra's do, before a finisher decides.
 *
 * `canceled` is local too, and nothing can reach it: the body is emitted without the signal,
 * because Mastra never checks it inside an item. Were that ever changed, a token there would hold
 * the lane's slot forever, and `exactlyOneTerminal` would say so.
 */
export function laneExits(r: (role: string) => string): Exits {
  return {
    failed: place<FailureToken>(r('failed')),
    bailed: place<BailToken>(r('bailed')),
    suspended: place<SuspendToken>(r('suspended')),
    paused: place<PauseToken>(r('paused')),
    canceled: place<CanceledToken>(r('canceled')),
  };
}

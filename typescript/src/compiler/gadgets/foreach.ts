import { Transition, all, and, one, outPlace, place, xor, type Out, type Place } from 'libpetri';
import { scopeOf, type RunScope } from '../scope.js';
import type {
  BailToken,
  CanceledToken,
  EntryDescription,
  Exits,
  FailureToken,
  FlowToken,
  ForeachItemRecord,
  ForeachMeta,
  ForeachResume,
  ForeachSite,
  PauseToken,
  StepRecord,
  SuspendToken,
} from '../types.js';
import { HostPreconditionError } from './leaf.js';
import type { Gadget } from './types.js';

/**
 * The undispatched tail of the input — Mastra's fastq queue.
 *
 * One token, consumed and re-emitted by whichever lane starts the next item, so items *start* in
 * input order because there is only ever one cursor, not because anything iterates. Removing it
 * is `queue.kill()`: nothing queued can start again.
 */
interface ForeachCursor {
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
interface CursorItem {
  readonly index: number;
  readonly resumed?: true;
}

/**
 * The foreach itself, from `split` to its finisher — Mastra's `stepInfo` (`:990-996`): the input
 * exactly as it arrived (a string stays a string) and when the foreach started. The success,
 * suspended and canceled aggregates are built on it; failure and exit aggregates are an item's.
 */
interface ForeachFrame {
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
}

/**
 * One settled item's entry in Mastra's `foreachOutput` (`:1194-1198`), as a list cell: the frame
 * is re-emitted by every settle, and appending a cell is O(1) where copying an array is O(items).
 */
interface Settled {
  readonly index: number;
  readonly record: StepRecord;
  readonly prev: Settled | undefined;
}

/**
 * What a lane is working on. Its presence *is* "this lane is busy". It holds no index — the
 * item's `foreachIndex` rides on every token the body emits — only what the item's own record
 * needs when that record becomes the foreach's (a failure, a bail, a pause).
 */
interface ForeachSlot {
  readonly item: unknown;
  readonly startedAt: number;
}

/** One item's output, tagged with where it belongs in the output array. */
interface ForeachResult {
  readonly index: number;
  readonly value: unknown;
}

/** A lane's permit. `null`, because presence is the whole message ([CORE-012] unit token). */
type LanePermit = null;

/** When a recorded item ran, and on what — the fields of its own `StepResult`. */
interface ItemFrame {
  readonly item: unknown;
  readonly startedAt: number;
  readonly endedAt: number;
}

/**
 * A failed item, recorded — Mastra's `errorResult` candidates. `entry` is the item's own record, the
 * one its `foreachOutput` entry is made from: the failed aggregate is that record
 * (`{...finalErrorResult}`, `handlers/control-flow.ts:1360-1370`).
 */
interface FaultRecord extends ItemFrame {
  readonly failure: FailureToken;
  readonly entry: StepRecord;
}

/** A bailed or paused item, recorded — Mastra's `exitResult` candidates, returned as they are (`:1406`). */
type ExitRecord =
  | (ItemFrame & { readonly status: 'bailed'; readonly bail: BailToken; readonly entry: StepRecord })
  | (ItemFrame & { readonly status: 'paused'; readonly pause: PauseToken; readonly entry: StepRecord });

/** A suspended item, recorded — Mastra's `foreachIndexObj`. */
interface SuspensionRecord {
  readonly suspension: SuspendToken;
}

/**
 * How many lanes one `.foreach` may compile to.
 *
 * A lane is a full copy of the body, so the net is O(concurrency x |body|) and so is anything
 * that explores it. Mastra has no ceiling (`utils.ts:786-796`); refusing loudly beats compiling a
 * net nothing could explore, and the refusal is a recorded divergence, not a silent clamp.
 */
export const MAX_FOREACH_LANES = 256;

/** The largest item count that is still an array length; past it, `results[k]` stops being an index. */
const MAX_ITEMS = 2 ** 32 - 1;

/**
 * `.foreach(step, { concurrency })` — run the body once per item of the previous entry's output,
 * at most `concurrency` at a time, results in **input** order, and **stop dispatching the moment
 * any item does not succeed, or the run is canceled**.
 *
 * ```text
 *   sweep          in, ?cancel                 -> exits.canceled                        (given a signal)
 *   split          in              ¬cancel     -> xor( frame + cursor + permit.* | frame + permit.* [no items] | exits.failed )
 *   start.l        cursor, permit.l ¬cancel    -> xor( body.l + slot.l + cursor | body.l + slot.l )
 *                  inhibited by every *other* lane's failed/bailed/suspended/paused
 *   refuse.l       cursor, permit.l ?cancel    -> permit.l                              (given a signal)
 *   (body.l)       body.l                      -> done.l | failed.l | bailed.l | suspended.l | paused.l
 *   collect.l      done.l, slot.l, frame              -> results + permit.l + frame
 *   fail.l         failed.l, slot.l, frame,    reset(cursor) -> faults + permit.l + frame
 *   bail.l         bailed.l, slot.l, frame,    reset(cursor) -> exits + permit.l + frame
 *   pause.l        paused.l, slot.l, frame,    reset(cursor) -> exits + permit.l + frame
 *   suspend.l      suspended.l, slot.l, frame, reset(cursor) -> suspensions + permit.l + frame
 *
 *   join     all(results), frame, permit.*  ¬cancel ¬cursor ¬faults ¬exits ¬suspensions ¬parked -> next
 *   join-empty           frame, permit.*    ¬cancel ¬cursor ¬faults ¬exits ¬suspensions ¬parked ¬results -> next
 *   fail     all(faults), frame, permit.*   ¬cancel reset(exits, suspensions, results, parked)  -> exits.failed
 *   exit     all(exits), frame, permit.*    ¬cancel ¬faults reset(suspensions, results, parked) -> exits.bailed | exits.paused
 *   suspend  all(suspensions), frame, permit.* ¬cancel ¬faults ¬exits ¬parked reset(results)   -> exits.suspended
 *   cancel   all(results), frame, permit.*  ?cancel reset(cursor, faults, exits, suspensions, parked) -> exits.canceled
 *   cancel-empty        frame, permit.*     ?cancel ¬results reset(cursor, faults, exits, suspensions, parked) -> exits.canceled
 *
 *   resume ([ADR 0007]; a top-level foreach only, marked only by a resume seed):
 *   re-enter.cancel  resume, ?cancel        -> exits.canceled                              (not started)
 *   re-enter         resume  ¬cancel        -> xor( frame + permit.* [+ cursor] [+ results] [+ parked]  (all 8)
 *                                                 | exits.failed [a seed that does not fit] )
 *   unpark   all(parked), permit.*  ¬cursor -> suspensions + permit.*
 * ```
 * (`¬` an inhibitor arc, `?` a read arc; the arcs on `cancel` exist only given a signal.)
 *
 * **What Mastra does** (`executeForeach`, `handlers/control-flow.ts:952-1495`). Every item is
 * pushed onto a `fastq` queue of width `concurrency` (`:1225`, `:1228-1272`); fastq starts the
 * next queued item the moment a worker calls back, so admission is fluid. On the first item that
 * does not succeed — failed, bailed, paused *or suspended* — `handleNonSuccessResult` calls
 * `killQueue()` (`:1141`), which is `inFlight -= queue.length(); queue.kill()` (`:1087-1090`):
 * nothing queued ever starts, items already running finish, and only then (`:1276-1280`) is the
 * foreach decided, with a fixed precedence — canceled (`:1283-1312`), then any failure
 * (`:1315-1316`), else any bail or pause (`:1373`), else any suspension (`:1410`), else success.
 *
 * **Cancellation, at dispatch and after the drain.** Mastra's worker checks the signal before it
 * runs each task (`:1160-1172`): once aborted, it kills the queue, so no queued item starts; it
 * never interrupts an item already running. After the queue drains it checks again (`:1298-1312`),
 * so a cancel that landed while the last items ran still wins over success *and* over a recorded
 * failure, bail or suspension. Both return `status: 'canceled'` with `output: results` — the same
 * array the workers fill, so it holds every success that finished **before the drain**, in-flight
 * ones included, at its input index, with holes. Here: `split` and every `start.l` are inhibited
 * by the signal, and each lane's `refuse.l` reads it and consumes the cursor — the worker's
 * `killQueue()` — handing the permit back; the body is **not** gated,
 * because Mastra never checks between an item's start and its end; the four ordinary finishers are
 * inhibited by it and the two cancel finishers read it, so exactly one decides. The cancel
 * finishers wait, like every finisher, for every permit — in-flight items finish first — and put
 * the partial array on `exits.canceled`. The foreach's input place has a sweep: that is Mastra's
 * check before the entry (`default.ts:815`), where the foreach never starts at all.
 *
 * **The stop is structural, in two halves.**
 *
 * - *Once an outcome is recorded*, the cursor is gone: every non-success settle carries a reset
 *   arc on it, which is `queue.kill()` — the undispatched tail is dropped in the same firing that
 *   records the outcome ([EXEC-013]: resets drain during the firing, before the action). `start.l`
 *   needs the cursor, so no item can start afterwards. The verifier checks this as
 *   `mutualExclusion(cursor, faults | exits | suspensions)`.
 * - *Between an item's outcome and its settle*, every `start.m` is inhibited by the four
 *   non-success places of every other lane, so the stop takes effect the instant the body's
 *   action writes its outcome, not one firing later. (A lane's own outcome needs no arc: while it
 *   is pending the lane holds its slot, not its permit. Leaving those `4c` redundant arcs out is
 *   not cosmetic: at three lanes they took `DeadlockFree` from 8s to 189s, measured against the
 *   linked libpetri tree at `808171c`, not a release.) Mastra has a window
 *   here — it awaits a progress-event publish (`:1126`, `:1129`, `:1135`) before `killQueue()`, and
 *   a sibling finishing in that await releases a queued item — which we close rather than
 *   reproduce: it is a race, not a behaviour anyone can rely on. This half is by construction, not
 *   by a marking property: a marking cannot say which of two firings came first.
 *
 * **Why lanes, not one body and N permits.** An anonymous permit cannot say *which* body is free,
 * so a result could not be paired with its slot once completion order differs from dispatch
 * order; and it would not run concurrently at all, because the executor never fires a transition
 * that is still in flight (`inFlightFlags` in `precompiled-net-executor.ts`). A lane is one body
 * instantiation *named* at child path `[...path, lane]` but *viewed* at the foreach's own path —
 * Mastra runs every item at the foreach's `executionPath` and tells them apart by `foreachIndex`
 * alone (`:1101`) — so N lanes are N distinct transitions genuinely in flight, the runner and
 * every outcome token see Mastra's path, and each item's index rides on its tokens.
 *
 * **Why the permit is a place.** Between `split` and a finisher every lane holds exactly one of
 * `permit.l` and `slot.l` (checked: both 1-bounded and mutually exclusive), so summed over lanes
 * `inFlight + permits = concurrency` — a limit the verifier can read, where a runtime semaphore
 * would prove nothing. Every finisher consumes **every** permit, which
 * both proves that no item is still running — so no outcome can arrive after the decision — and
 * clears the lanes that never started.
 *
 * **Which outcome is reported** — each an explicit Mastra rule, each a transition, the precedence
 * enforced by inhibitors and resets rather than by a choice inside one action:
 *
 * - *Canceled beats everything* (`:1283-1312` run before the error check), as above.
 * - *Failure beats the rest, first in time.* `if (!errorResult) errorResult = result`
 *   (`:1130`, `:1210`) keeps the first failure to settle, not the lowest index. `all(faults)`
 *   hands the action every recorded failure in arrival order ([CORE-013] FIFO), and the head is
 *   taken. (`.parallel()` differs: it reports the lowest arm index.) The failure token is
 *   forwarded whole, so a `tripwire` and a `nonRetryable` both survive (`:1360-1369` spreads the
 *   item's own result).
 * - *Then a bail or a pause, first in time*: `if (!exitResult) exitResult = result` (`:1136`),
 *   and the foreach returns that result as its own (`:1406`). A bail therefore ends the run as a
 *   success carrying the bail output; the array is never produced.
 * - *Then a suspension, lowest index*: suspended items land in an integer-keyed object
 *   (`foreachIndexObj[k]`, `:1119-1124`) and `Object.keys(...)[0]` is its **lowest** key
 *   (`:1411-1412`), whatever order they suspended in.
 *
 * Losers are reset, not stranded: a higher-precedence finisher resets the lower-precedence
 * records, and every non-success finisher resets `results` — Mastra returns no array in those
 * cases either (the cancel finishers consume `results` instead: the partial array is theirs).
 *
 * **The run-scoped step results.** The body's leaf records each item's outcome under the body id
 * as the item settles, exactly as Mastra's `Object.assign(stepResults, ...)` does (`:1179`).
 * The finisher then records the **aggregate** under the same id, as `entry.ts:811-812` does with
 * the foreach's own result, and it can only fire once every lane is idle — so the aggregate is
 * always the last write. What the aggregate is follows Mastra's return value, which is not one
 * shape:
 *
 * - *success*: `{...stepInfo, status, output: results, endedAt}` (`:1486-1492`) — the payload is
 *   the foreach's input, `startedAt` the foreach's. Mastra adds `metadata.nestedRunId` only for
 *   nested-workflow items, which this engine does not track (`docs/divergences.md` row 35); there
 *   is no other metadata.
 * - *failed*: `{...finalErrorResult, suspendPayload}` (`:1360-1370`) — the **failing item's own
 *   result**, so its payload is the item's (the stored aggregate's, for a resumed item), its times
 *   the item's, and `tripwire` / `nonRetryable` ride along. It is the record the item's settle
 *   chose for its `foreachOutput` entry — the leaf's, or, when a sibling in flight overwrote that
 *   before the settle fired, rebuilt from the outcome token (`stepPayload`, `stepStartedAt`) —
 *   so the aggregate and its own entry agree. `startedAt` is **not** the foreach's: the item's
 *   `executeStep` takes its own (`handlers/step.ts:166,174`). Its `suspendPayload` is
 *   `{__workflow_meta: {foreachOutput}}`, every item settled so far; the run's `resumeLabels` are
 *   the host's to add.
 * - *bailed / paused*: `exitResult` returned verbatim (`:1406`) — again the item's own record, the
 *   one its entry was made from.
 * - *suspended*: `{...stepInfo, suspendedAt, status, suspendPayload}` (`:1432-1450`) — the
 *   foreach's payload and start, no `endedAt`, and the lowest suspended item's payload with
 *   `__workflow_meta.{foreachIndex, foreachOutput}` merged in: what a resume reads.
 *
 * **`foreachOutput`** is Mastra's `prevForeachOutput`: each item's own result, by index, written
 * as the item settles (`:1194-1198`) — its `suspendPayload` cleared unless it is still suspended.
 * The frame carries it: every settle takes the frame and puts it back with the item's entry, so
 * the finisher that fires has every entry in hand whichever it is, and no finisher needs an
 * `all()` variant per combination of non-empty places. The entry is the leaf's record for the
 * item when the body's record is still that item's, host fields included, else rebuilt from the
 * outcome token (the validated input and the item's start it carries) and the slot
 * (`docs/divergences.md`). `__workflow_meta.resumeLabels` is the run's label map, which only the
 * host holds; the gadget writes none. On a resume, `stepInfo` is the stored aggregate's.
 *
 * **Resume** ([ADR 0007], `:1227-1272`). A top-level foreach is a resume site. One
 * `ForeachResume` token re-enters it: `re-enter` re-opens the frame and every permit and emits
 * whichever of the cursor (the queue, the resumed items flagged), `results` (the items that
 * succeeded, reused) and `parked` (the suspensions this segment does not re-run) the seed has. A
 * parked suspension inhibits no `start` — Mastra's `killQueue()` fires only for this segment's
 * outcomes — and joins `suspensions` through `unpark` once nothing can start and every lane is
 * home, so `mutualExclusion(cursor, suspensions)` still holds; `join` and `suspend` wait for it,
 * the other finishers clear it.
 * - *canceled*: `{...stepInfo, status: 'canceled', output: results, endedAt}` (`:1164-1169`,
 *   `:1298-1312`) — the foreach's payload and start, the partial array. A `canceled` record is a
 *   combinator's alone: it is a `StepRecord`, never a `StepOutcome`. `endedAt` is the drain's;
 *   Mastra's dispatch-time `canceledResult` stamps it when the first queued item is refused, a
 *   difference only a clock can see. The sweep before `split` records nothing, as Mastra writes
 *   no result for an entry it never started.
 *
 * `getStepOutput` reads `stepResults[body.id]` (`default.ts:1152-1153`), which is why the value
 * on `next` is the same whether or not `next` is the run's result.
 *
 * **Output.** `results[k] = output` for each success whose output is not `undefined`
 * (`:1189-1191`), so an `undefined` output leaves a *hole* and the array is only as long as the
 * last defined index. Reproduced by assigning, not by mapping, and `k` is the token's
 * `foreachIndex`, which the leaf carries from the dispatch to the success token.
 *
 * **Why this needs no ν.** Correlation by name ([NU-020]) is for sibling groups that share places.
 * Here the streams are already disjoint — one lane, one item, one slot — and a combinator cannot
 * contain a combinator, so no second group is ever live over these places.
 *
 * **What is not bounded.** `results` grows with the input, which is data the model cannot see, so
 * `start.l`'s "more items" branch is value-blind and a proof covers every item count at once. The
 * three outcome records are each bounded by the lane count: once one exists no item starts, and
 * each lane holds at most one item.
 */
export const foreachGadget: Gadget = (entry, next, ctx) => {
  if (entry.kind !== 'foreach') throw new Error(`foreachGadget received a '${entry.kind}' entry`);
  // The IR narrows the body to a single step, as Mastra's `SingleStepEntry` does. Checked at run
  // time too, because a caller outside the type system could still hand us a combinator.
  if ((entry.body as { kind: string }).kind !== 'step') {
    throw new Error(
      `.foreach '${entry.id}': the body must be a single step, got '${(entry.body as { kind: string }).kind}'. ` +
        'Mastra types a foreach body as SingleStepEntry; nest through a nested workflow instead.',
    );
  }
  const lanes = foreachLanes(entry);
  const bodyId = entry.body.id;
  const { names, path, viewPath, exits, cancel } = ctx;

  // Every name is minted through the vocabulary: libpetri place identity is the name string
  // ([CORE-010]), so a hand-rolled name that collided would silently merge two lanes.
  const p = (role: string): string => names.entryPlace(path, entry.id, role);
  const t = (role: string): string => names.entryTransition(path, entry.id, role);

  const inPlace = place<FlowToken>(names.entryIn(path, entry.id));
  const frame = place<ForeachFrame>(p('frame'));
  const cursor = place<ForeachCursor>(p('cursor'));
  const results = place<ForeachResult>(p('results'));
  const faults = place<FaultRecord>(p('faults'));
  const exited = place<ExitRecord>(p('exits'));
  const suspensions = place<SuspensionRecord>(p('suspensions'));
  /**
   * A resume's carried suspensions — items suspended before this segment that it does not re-run
   * (`:1242-1250`). Unlike `suspensions` they inhibit no `start`: Mastra's `killQueue()` fires only
   * for an outcome of this segment, never for a carried one. Marked only by `re-enter`.
   */
  const parked = place<SuspensionRecord>(p('parked'));
  /** The resume site: one {@link ForeachResume}, marked only by a resume seed ([ADR 0007]). */
  const resume = place<ForeachResume>(p('resume'));

  interface Lane {
    readonly permit: Place<LanePermit>;
    readonly slot: Place<ForeachSlot>;
    readonly done: Place<FlowToken>;
    readonly out: Exits;
    readonly bodyIn: Place<FlowToken>;
  }

  const laneList: Lane[] = [];
  for (let lane = 0; lane < lanes; lane++) {
    const done = place<FlowToken>(p(`lane${lane}.done`));
    // Gadget-local exits, never `ctx.exits`: a sibling lane mid-item still holds a slot, and an
    // outcome that jumped straight to a terminal would strand it. Local exits let every in-flight
    // item finish, as Mastra's do, before a finisher decides.
    //
    // `canceled` is local too, and nothing can reach it: the body is emitted without the signal,
    // because Mastra never checks it inside an item. Were that ever changed, a token there would
    // hold the lane's slot forever, and `exactlyOneTerminal` would say so.
    const out: Exits = {
      failed: place<FailureToken>(p(`lane${lane}.failed`)),
      bailed: place<BailToken>(p(`lane${lane}.bailed`)),
      suspended: place<SuspendToken>(p(`lane${lane}.suspended`)),
      paused: place<PauseToken>(p(`lane${lane}.paused`)),
      canceled: place<CanceledToken>(p(`lane${lane}.canceled`)),
    };
    // Named by the lane, viewed at the foreach's path: every item runs at Mastra's
    // `executionPath` for the foreach (`:1101`), told apart by `foreachIndex` alone.
    const body = ctx.emitNested(entry.body, [...path, lane], done, out, { viewPath });
    laneList.push({
      permit: place<LanePermit>(p(`lane${lane}.permit`)),
      slot: place<ForeachSlot>(p(`lane${lane}.slot`)),
      done,
      out,
      bodyIn: body.inPlace,
    });
  }

  /** A lane's non-success outcome places: its item has finished badly and is not yet recorded. */
  const pending = (l: Lane): Place<unknown>[] => [l.out.failed, l.out.bailed, l.out.suspended, l.out.paused];
  const everyPermit = laneList.map((l) => one(l.permit));
  /** What the canceled token names: the step the foreach runs, at the foreach's path. */
  const origin = { stepId: bodyId, path: viewPath };

  const transitions: Transition[] = [];

  /** Adds the signal's inhibitor to a transition that starts or decides work, given a signal. */
  const unlessCanceled = (b: ReturnType<typeof Transition.builder>): ReturnType<typeof Transition.builder> =>
    cancel === undefined ? b : b.inhibitor(cancel);

  if (cancel !== undefined) {
    /**
     * Mastra's check before the entry (`default.ts:815`): the foreach never starts. Records
     * nothing — Mastra writes no step result for an entry it skipped.
     */
    transitions.push(
      Transition.builder(t('cancel'))
        .inputs(one(inPlace))
        .read(cancel)
        .outputs(outPlace(exits.canceled))
        .action(async (tctx) => {
          tctx.input(inPlace);
          tctx.output(exits.canceled, { origin, started: false });
        })
        .build(),
    );
  }

  /**
   * Opens the foreach: seeds the frame, the cursor **and** every permit in one firing, so no
   * marking exists with permits and no cursor (outputs of a firing land together, [EXEC-001]).
   *
   * Three declared branches for three outcomes: items to run; no items at all; and an input
   * Mastra cannot iterate either (see {@link itemsOf}), where Mastra's `execute()` rejects and we
   * fail the run.
   *
   * **No items still opens the foreach** — frame and permits, no cursor — and a finisher decides
   * it, exactly as the non-empty case is decided (row 49). Mastra enqueues nothing (`:1228`), skips
   * the wait (`:1276`) and still runs its check after the drain (`:1298-1312`) before it returns
   * `[]` (`:1486-1494`): an abort that lands anywhere between the check before the entry
   * (`default.ts:815`) and that check — while `executeForeach` awaits its span and its
   * `workflow-step-start` publish (`:998-1027`), or while it reads `prevOutput.length` (`:1053`) —
   * makes an empty foreach `canceled` with `output: []`, not `success []`. Deciding it here, inside
   * this firing, would give that window no marking to land in. Opened, the empty foreach is
   * decided by `join-empty` (¬cancel) or `canceled-empty` (?cancel), the same pair of arcs that
   * decides every other foreach — no action ever reads the signal.
   */
  transitions.push(
    unlessCanceled(Transition.builder(t('split')))
      .inputs(one(inPlace))
      .outputs(
        xor(
          and(outPlace(frame), outPlace(cursor), ...laneList.map((l) => outPlace(l.permit))),
          and(outPlace(frame), ...laneList.map((l) => outPlace(l.permit))),
          outPlace(exits.failed),
        ),
      )
      .action(async (tctx) => {
        const incoming = tctx.input(inPlace);
        const scope = scopeOf(tctx);
        const startedAt = scope.epochNow();

        // Decide, then emit ([EXEC-031]: the input is already gone and nothing is restored).
        let items: readonly unknown[] | undefined;
        let error: unknown;
        try {
          items = itemsOf(entry.id, incoming.data);
        } catch (e) {
          error = e;
        }

        if (items === undefined) {
          scope.recordStepResult(bodyId, {
            status: 'failed',
            error,
            payload: incoming.data,
            startedAt,
            endedAt: scope.epochNow(),
          });
          tctx.output(exits.failed, { stepId: bodyId, path: viewPath, error });
          return;
        }
        tctx.output(frame, { input: incoming.data, startedAt });
        // No items: no cursor, so no lane can start and `join-empty` / `canceled-empty` decide.
        if (items.length > 0) tctx.output(cursor, { items, next: 0 });
        for (const l of laneList) tctx.output(l.permit, null);
      })
      .build(),
  );

  /**
   * The item's own record, for its `foreachOutput` entry (`:1194-1198`): what the body's leaf just
   * recorded under the body id, when that record is still this item's — a sibling that settled in
   * between may have overwritten it (every item shares the id, `:1179`) — else rebuilt from the
   * outcome token and the lane's slot. Data only: nothing here decides what fires.
   */
  const itemRecordOf = (scope: RunScope, k: number, status: StepRecord['status'], rebuilt: () => StepRecord): StepRecord => {
    const recorded = scope.getStepResult(bodyId);
    return recorded !== undefined && recorded.status === status && recorded.metadata?.foreachIndex === k ? recorded : rebuilt();
  };
  /** Re-emits the frame with one more settled item. */
  const settleInto = (f: ForeachFrame, index: number, record: StepRecord): ForeachFrame => ({
    ...f,
    settled: { index, record, prev: f.settled },
  });

  // Settles are declared before starts. Nothing depends on it — the inhibitors close the window
  // structurally — but it keeps the executor's tie-break ([EXEC-002]) pointing the same way.
  laneList.forEach((l, lane) => {
    /**
     * A success: places the output at the index the leaf carried through, and returns the permit,
     * in one firing — so no marking has the lane idle and its result missing, which is what lets
     * `join` read "every permit is back" as "every result is in". The frame passes through, taking
     * the item's `foreachOutput` entry, as Mastra's worker writes `prevForeachOutput[k]` (`:1198`).
     */
    transitions.push(
      Transition.builder(t(`lane${lane}.collect`))
        .inputs(one(l.done), one(l.slot), one(frame))
        .outputs(and(outPlace(results), outPlace(l.permit), outPlace(frame)))
        .action(async (tctx) => {
          const produced = tctx.input(l.done);
          const s = tctx.input(l.slot);
          const f = tctx.input(frame);
          const scope = scopeOf(tctx);
          const index = indexOf(produced, entry.id);
          const record = itemRecordOf(scope, index, 'success', () => ({
            status: 'success',
            output: produced.data,
            payload: s.item,
            startedAt: s.startedAt,
            endedAt: scope.epochNow(),
            metadata: { foreachIndex: index },
          }));
          tctx.output(results, { index, value: produced.data });
          tctx.output(l.permit, null);
          tctx.output(frame, settleInto(f, index, record));
        })
        .build(),
    );

    /** One non-success settle: records the outcome, kills the queue, frees the lane. */
    const settle = <T extends { readonly foreachIndex?: number }, R>(
      role: string,
      from: Place<T>,
      into: Place<R>,
      status: StepRecord['status'],
      record: (token: T, item: ItemFrame, entry: StepRecord) => R,
      entryOf: (token: T, item: ItemFrame) => StepRecord,
    ) =>
      Transition.builder(t(`lane${lane}.${role}`))
        .inputs(one(from), one(l.slot), one(frame))
        .reset(cursor)
        .outputs(and(outPlace(into), outPlace(l.permit), outPlace(frame)))
        .action(async (tctx) => {
          const arrived = tctx.input(from);
          const s = tctx.input(l.slot);
          const f = tctx.input(frame);
          const scope = scopeOf(tctx);
          // The item as the step validated it, when the runner said: Mastra's aggregate record
          // for a deciding item takes that item's own payload (`handlers/step.ts:173`).
          // ... and that item's own start, `handlers/step.ts:166,174`, which `{...finalErrorResult}`
          // and `return exitResult` hand on unchanged (`:1360-1369`, `:1406`; row 49). The slot's
          // stamp is the *dispatch*, which a run budget ([ADR 0006]) can hold apart from the
          // item's first attempt; it stands in only while the leaf does not report the start.
          // The start is the aggregate record's alone, so it goes no further than this settle.
          const { stepStartedAt: reported, ...rest } = arrived as T & { stepStartedAt?: unknown };
          const refused = hostRefusal(rest);
          const token = (refused === undefined ? rest : { ...rest, error: refused.cause }) as unknown as T;
          const item = 'stepPayload' in (token as object) ? (token as { stepPayload?: unknown }).stepPayload : s.item;
          const startedAt = typeof reported === 'number' ? reported : s.startedAt;
          const frameOf: ItemFrame = { item, startedAt, endedAt: scope.epochNow() };
          const index = token.foreachIndex;
          // The item's own record — the leaf's, or rebuilt from the token — decided once: its
          // `foreachOutput` entry and, should this item decide the foreach, the aggregate. A host
          // refusal wrote no record: Mastra's worker catches the throw as `thrownResult`
          // (`handlers/control-flow.ts:1200-1217`) — the error, no payload, stamped now.
          const entryRecord =
            refused !== undefined
              ? ({ status: 'failed', error: refused.cause, payload: undefined, startedAt: frameOf.endedAt, endedAt: frameOf.endedAt, ...(index === undefined ? {} : { metadata: { foreachIndex: index } }) } as StepRecord)
              : index === undefined
                ? entryOf(token, frameOf)
                : itemRecordOf(scope, index, status, () => entryOf(token, frameOf));
          tctx.output(into, record(token, frameOf, entryRecord));
          tctx.output(l.permit, null);
          tctx.output(frame, index === undefined ? f : settleInto(f, index, entryRecord));
        })
        .build();

    /** The fields every rebuilt item entry shares: the item's input, start and index. */
    const itemBase = (item: ItemFrame, foreachIndex: number | undefined) => ({
      payload: item.item,
      startedAt: item.startedAt,
      ...(foreachIndex === undefined ? {} : { metadata: { foreachIndex } }),
    });
    transitions.push(
      settle(
        'fail',
        l.out.failed,
        faults,
        'failed',
        (failure, item, entry): FaultRecord => ({ ...item, failure, entry }),
        (failure, item) => ({
          status: 'failed',
          error: failure.error,
          ...(failure.tripwire === undefined ? {} : { tripwire: failure.tripwire }),
          ...(failure.nonRetryable === true ? { nonRetryable: true } : {}),
          ...itemBase(item, failure.foreachIndex),
          endedAt: item.endedAt,
        }),
      ),
      settle(
        'bail',
        l.out.bailed,
        exited,
        'bailed',
        (bail, item, entry): ExitRecord => ({ ...item, status: 'bailed', bail, entry }),
        (bail, item) => ({ status: 'bailed', output: bail.output, ...itemBase(item, bail.foreachIndex), endedAt: item.endedAt }),
      ),
      settle(
        'pause',
        l.out.paused,
        exited,
        'paused',
        (pause, item, entry): ExitRecord => ({ ...item, status: 'paused', pause, entry }),
        (pause, item) => ({ status: 'paused', ...itemBase(item, pause.foreachIndex) }),
      ),
      settle(
        'suspend',
        l.out.suspended,
        suspensions,
        'suspended',
        // The item's input and start served its entry; the foreach's own suspension carries neither.
        ({ stepPayload: _payload, ...suspension }): SuspensionRecord => ({ suspension }),
        (suspension, item) => ({
          status: 'suspended',
          suspendPayload: suspension.payload,
          ...itemBase(item, suspension.foreachIndex),
          suspendedAt: suspension.suspendedAt ?? item.endedAt,
        }),
      ),
    );
  });

  laneList.forEach((l, lane) => {
    /**
     * Admits the next item into this lane. Competing with the other lanes' `start` for the one
     * cursor is the whole scheduler: which lane runs an item is the marking's decision, and no
     * priority is involved. Inhibited by the signal: Mastra's worker checks it before each task
     * (`:1160`), and that is the only place an item can be stopped.
     *
     * The `xor` is "more items" versus "this was the last": the last drops the cursor, which is
     * what eventually lets `join` fire. A value-blind analysis that takes the short branch early
     * merely dispatches fewer items, which strands nothing.
     *
     * On a resume the cursor carries the queue Mastra built (`:1227-1272`): the head of `order`
     * starts, flagged `resumed` when it is the attempt the resume feeds. The flag is colour only.
     */
    transitions.push(
      unlessCanceled(Transition.builder(t(`lane${lane}.start`)))
        .inputs(one(cursor), one(l.permit))
        .inhibitors(...laneList.filter((other) => other !== l).flatMap(pending))
        .outputs(
          xor(
            and(outPlace(l.bodyIn), outPlace(l.slot), outPlace(cursor)),
            and(outPlace(l.bodyIn), outPlace(l.slot)),
          ),
        )
        .action(async (tctx) => {
          const c = tctx.input(cursor);
          const head: CursorItem = c.order === undefined ? { index: c.next } : c.order[c.next]!;
          const item = c.items[head.index];
          tctx.output(l.bodyIn, { data: item, foreachIndex: head.index, ...(head.resumed === true ? { resumed: true as const } : {}) });
          tctx.output(l.slot, { item, startedAt: scopeOf(tctx).epochNow() });
          const length = c.order === undefined ? c.items.length : c.order.length;
          if (c.next + 1 < length) tctx.output(cursor, { ...c, next: c.next + 1 });
        })
        .build(),
    );

    if (cancel !== undefined) {
      /**
       * Mastra's worker when the signal has fired (`:1160-1172`): it refuses the task, kills the
       * queue and hands the worker back — `killQueue(); inFlight--; cb(null)`. Here: the cursor
       * is consumed, so nothing queued can ever start, and the lane's permit is handed straight
       * back. It is the sweep `start.l` competes with, which is what makes `start.l`'s inhibitor
       * on the signal checkable from the arcs alone (`cancelStructureViolations`).
       */
      transitions.push(
        Transition.builder(t(`lane${lane}.refuse`))
          .inputs(one(cursor), one(l.permit))
          .read(cancel)
          .outputs(outPlace(l.permit))
          .action(async (tctx) => {
            tctx.input(cursor);
            tctx.input(l.permit);
            tctx.output(l.permit, null);
          })
          .build(),
      );
    }
  });

  /** `results[k] = output` only when the output is defined (`:1189-1191`) — holes stay holes. */
  const assemble = (collected: readonly ForeachResult[]): unknown[] => {
    const output: unknown[] = [];
    for (const r of collected) if (r.value !== undefined) output[r.index] = r.value;
    return output;
  };

  /**
   * The aggregate's `stepInfo` (`:990-996`): the foreach's input and start on a fresh run; on a
   * resume, the stored aggregate minus its completion fields, which keeps its `payload` and
   * `startedAt` — Mastra writes `resumePayload` and `resumedAt` there instead, which are the
   * host's (`docs/divergences.md`).
   */
  const stepInfo = (f: ForeachFrame) => ({
    ...f.kept,
    payload: f.input,
    ...(f.startedAt === undefined ? {} : { startedAt: f.startedAt }),
  });

  /**
   * Every item that succeeded. Enabled only with nothing left to start (¬cursor), no lane busy (every
   * permit consumed), nothing recorded against the foreach (¬faults ¬exits ¬suspensions ¬parked)
   * and no cancel (Mastra's check after the drain, `:1298`). `all(results)` is honest: the domain
   * really is "take every result", and nothing can add to it while this firing holds every permit.
   *
   * Two transitions, as the cancel finishers are, because `all()` needs at least one token:
   * `join` with results, `join-empty` inhibited by them — the foreach that had no items
   * (`:1486-1494` with nothing enqueued). Every dispatched item leaves exactly one token in
   * `results`, `faults`, `exits` or `suspensions`, and only a canceled run refuses one, so
   * `join-empty` can fire only for a foreach that never dispatched.
   */
  const joined = (role: string, withResults: boolean): Transition => {
    const b = unlessCanceled(Transition.builder(t(role)))
      .inputs(...(withResults ? [all(results)] : []), one(frame), ...everyPermit)
      .inhibitors(cursor, faults, exited, suspensions, parked)
      .outputs(outPlace(next));
    if (!withResults) b.inhibitor(results);
    return b
      .action(async (tctx) => {
        const output = withResults ? assemble(tctx.inputs(results)) : [];
        const f = tctx.input(frame);
        const scope = scopeOf(tctx);
        scope.recordStepResult(bodyId, {
          ...stepInfo(f),
          status: 'success',
          output,
          endedAt: scope.epochNow(),
        } as StepRecord);
        tctx.output(next, { data: output });
      })
      .build();
  };
  transitions.push(joined('join', true), joined('join-empty', false));

  /**
   * A failure was recorded: the first in time wins, and outranks every outcome but a cancel.
   *
   * The aggregate is the failing item's own result plus Mastra's `__workflow_meta.foreachOutput`
   * — every item settled so far, succeeded and suspended ones included (`:1355-1369`), which the
   * frame has carried since `split`. Its `resumeLabels` are the run's, which only the host holds.
   */
  transitions.push(
    unlessCanceled(Transition.builder(t('fail')))
      .inputs(all(faults), one(frame), ...everyPermit)
      .resets(exited, suspensions, results, parked)
      .outputs(outPlace(exits.failed))
      .action(async (tctx) => {
        const first = tctx.inputs(faults)[0]!;
        const f = tctx.input(frame);
        const { failure } = first;
        const foreachOutput = foreachOutputOf(f);
        // The item's own result, as `{...finalErrorResult}` is (`:1360-1370`) — the very record its
        // `foreachOutput` entry was made from, so the two agree on its payload and start (a
        // resumed item's payload is the stored aggregate's) — plus Mastra's meta.
        const { suspendPayload: _none, ...own } = first.entry as StepRecord & { readonly suspendPayload?: unknown };
        scopeOf(tctx).recordStepResult(bodyId, { ...own, suspendPayload: { __workflow_meta: { foreachOutput } } } as StepRecord);
        const meta: ForeachMeta = { foreachIndex: failure.foreachIndex ?? 0, foreachOutput: itemRecordsOf(foreachOutput) };
        tctx.output(exits.failed, { ...failure, foreach: meta });
      })
      .build(),
  );

  /** No failure, and a bail or pause was recorded: the first in time is the foreach's result. */
  transitions.push(
    unlessCanceled(Transition.builder(t('exit')))
      .inputs(all(exited), one(frame), ...everyPermit)
      .inhibitor(faults)
      .resets(suspensions, results, parked)
      .outputs(xor(outPlace(exits.bailed), outPlace(exits.paused)))
      .action(async (tctx) => {
        const first = tctx.inputs(exited)[0]!;
        tctx.input(frame);
        // `return exitResult` (`:1406`): the item's own record — a paused one has no `endedAt`
        // (`handlers/step.ts:525`) — whose `foreachOutput` entry was made from the same record.
        scopeOf(tctx).recordStepResult(bodyId, first.entry);
        if (first.status === 'bailed') {
          tctx.output(exits.bailed, first.bail);
          return;
        }
        tctx.output(exits.paused, first.pause);
      })
      .build(),
  );

  /**
   * A resume's carried suspensions join this segment's, once nothing can start and no lane is
   * busy (¬cursor, every permit) — so `suspensions` still never holds a token beside the cursor,
   * which is what `mutualExclusion(cursor, suspensions)` proves. Mastra puts both in one
   * `foreachIndexObj` (`:1119-1124`, `:1246-1250`); the join of the two is this transition.
   * `all(parked)`: every carried suspension at once, as one firing ([IO-016], threshold arcs only).
   */
  transitions.push(
    Transition.builder(t('unpark'))
      .inputs(all(parked), ...everyPermit)
      .inhibitor(cursor)
      .outputs(and(outPlace(suspensions), ...laneList.map((l) => outPlace(l.permit))))
      .action(async (tctx) => {
        for (const r of tctx.inputs(parked)) tctx.output(suspensions, r);
        for (const l of laneList) tctx.output(l.permit, null);
      })
      .build(),
  );

  /**
   * Only suspensions were recorded: the lowest index is the foreach's suspension. Inhibited by
   * `parked`: a carried suspension joins first (`unpark`), so none is left behind.
   *
   * `{...stepInfo, suspendedAt, status, suspendPayload}` (`:1432-1450`): the foreach's own payload
   * and start, the lowest item's suspend payload with Mastra's `__workflow_meta` merged in — that
   * item's `foreachIndex` and every item's `foreachOutput` entry, what a resume reads to skip the
   * items that succeeded and re-run the one that suspended — and no `endedAt`. No `suspendOutput`:
   * Mastra reads it from `foreachIndexObj`, which never stores one (`:1119-1124`). The meta's
   * `resumeLabels` are the run's, which only the host holds. The token carries the same meta.
   */
  transitions.push(
    unlessCanceled(Transition.builder(t('suspend')))
      .inputs(all(suspensions), one(frame), ...everyPermit)
      .inhibitors(faults, exited, parked)
      .reset(results)
      .outputs(outPlace(exits.suspended))
      .action(async (tctx) => {
        const recorded = tctx.inputs(suspensions).map((r) => r.suspension);
        const f = tctx.input(frame);
        let lowest = recorded[0]!;
        for (const r of recorded) if ((r.foreachIndex ?? 0) < (lowest.foreachIndex ?? 0)) lowest = r;
        const foreachIndex = lowest.foreachIndex ?? 0;
        const foreachOutput = foreachOutputOf(f);
        const own = lowest.payload as { readonly __workflow_meta?: object } | null | undefined;
        const scope = scopeOf(tctx);
        scope.recordStepResult(bodyId, {
          ...stepInfo(f),
          status: 'suspended',
          // Spread exactly as Mastra spreads it: a primitive payload spreads as JS spreads it.
          suspendPayload: {
            ...(lowest.payload as object),
            __workflow_meta: { ...(own ?? {})?.__workflow_meta, foreachIndex, foreachOutput },
          },
          suspendedAt: scope.epochNow(),
        } as StepRecord);
        const meta: ForeachMeta = { foreachIndex, foreachOutput: itemRecordsOf(foreachOutput) };
        tctx.output(exits.suspended, { ...lowest, foreach: meta });
      })
      .build(),
  );

  if (cancel !== undefined) {
    /**
     * The run was canceled while the foreach ran: Mastra's `canceledResult` (`:1160-1172`) or its
     * check after the drain (`:1298-1312`), which outranks every other outcome. Waits for every
     * permit — in-flight items finish, as Mastra's do — and then clears whatever the queue and the
     * lanes left: the undispatched tail, any recorded outcome and any carried suspension. Two
     * transitions only because `all()` needs at least one token: one with results, one inhibited
     * by them.
     *
     * Records `{...stepInfo, status: 'canceled', output: results, endedAt}` under the body id, as
     * both of Mastra's canceled returns are (`:1164-1169`, `:1298-1312`), stored by
     * `entry.ts:811-812`: the foreach's input and start, the partial array. The same array rides
     * the `exits.canceled` token.
     */
    const canceled = (role: string, withResults: boolean): Transition => {
      const b = Transition.builder(t(role))
        .inputs(...(withResults ? [all(results)] : []), one(frame), ...everyPermit)
        .read(cancel)
        .resets(cursor, faults, exited, suspensions, parked)
        .outputs(outPlace(exits.canceled));
      if (!withResults) b.inhibitor(results);
      return b
        .action(async (tctx) => {
          const output = withResults ? assemble(tctx.inputs(results)) : [];
          const f = tctx.input(frame);
          const scope = scopeOf(tctx);
          scope.recordStepResult(bodyId, {
            ...stepInfo(f),
            status: 'canceled',
            output,
            endedAt: scope.epochNow(),
          });
          tctx.output(exits.canceled, { origin, output, started: true });
        })
        .build();
    };
    transitions.push(canceled('canceled', true), canceled('canceled-empty', false));
  }

  // -------------------------------------------------------------------------------------------
  // Resume ([ADR 0007]). A top-level foreach is a resume site: one `ForeachResume` token re-enters
  // it with the queue Mastra would build, the items that succeeded, and the suspensions it keeps.
  // -------------------------------------------------------------------------------------------
  const resumeSites: ForeachSite[] = [];
  if (cancel !== undefined && path.length === 1) {
    /**
     * Mastra's check before the entry (`default.ts:815`) holds for a resumed segment too: a
     * resume that arrives canceled never re-enters. It names the foreach's step at its path, not
     * started, as the sweep before `split` does.
     */
    transitions.push(
      Transition.builder(t('re-enter.cancel'))
        .inputs(one(resume))
        .read(cancel)
        .outputs(outPlace(exits.canceled))
        .action(async (tctx) => {
          tctx.input(resume);
          tctx.output(exits.canceled, { origin, started: false });
        })
        .build(),
    );

    /**
     * Re-opens the foreach where the resume left it (`:1227-1272`), in one firing: the frame and
     * every lane permit, as `split` opens it, plus whichever of these the seed has — the cursor
     * over the items still to run, one `results` token per item that succeeded (their outputs
     * reused, `:1252-1254`), one `parked` token per suspension that stays. The choice among the
     * eight subsets is an `xor` decided from the seed and then emitted, so a value-blind proof
     * explores every one of them from the single seed. A seed that does not fit the stored input
     * fails the run by name instead of throwing, which would strand it.
     *
     * The frame takes the stored aggregate as Mastra's `stepInfo` does (`:990-996`) — read from
     * the run's records like a loop's `start` reads its own, data only — and its
     * `__workflow_meta.foreachOutput` as the base every settle writes over (`:1040-1041`).
     */
    const opened = (withCursor: boolean, withResults: boolean, withParked: boolean): Out =>
      and(
        outPlace(frame),
        ...laneList.map((l) => outPlace(l.permit)),
        ...(withCursor ? [outPlace(cursor)] : []),
        ...(withResults ? [outPlace(results)] : []),
        ...(withParked ? [outPlace(parked)] : []),
      );
    const subsets: Out[] = [];
    for (const c of [true, false]) for (const r of [true, false]) for (const k of [true, false]) subsets.push(opened(c, r, k));

    transitions.push(
      Transition.builder(t('re-enter'))
        .inputs(one(resume))
        .inhibitor(cancel)
        .outputs(xor(...subsets, outPlace(exits.failed)))
        .action(async (tctx) => {
          const seed = tctx.input(resume);
          const scope = scopeOf(tctx);
          const misfit = seedMisfit(seed);
          if (misfit !== undefined) {
            tctx.output(exits.failed, {
              stepId: bodyId,
              path: viewPath,
              error: new Error(`.foreach '${entry.id}' cannot resume from this seed: ${misfit}`),
            });
            return;
          }
          const prior = scope.getStepResult(bodyId);
          tctx.output(frame, resumedFrame(seed, prior));
          for (const l of laneList) tctx.output(l.permit, null);
          if (seed.order.length > 0) tctx.output(cursor, { items: seed.items, order: seed.order, next: 0 });
          for (const d of seed.done) tctx.output(results, { index: d.index, value: (d.record as { output?: unknown }).output });
          for (const suspension of seed.parked) tctx.output(parked, { suspension });
        })
        .build(),
    );

    resumeSites.push({ kind: 'foreach', path: [path[0]!], stepId: bodyId, place: resume, ...(entry.body.source === 'workflow' ? { nested: true as const } : {}) });
  }

  // The body's transitions are collected by the builder as `emitNested` returns them; repeating
  // them here would register each one twice.
  return { inPlace, transitions, resumeSites };
};

/**
 * A host refusal on a failure token ([`HostPreconditionError`]): the host refused the item before
 * it ran. Outside a foreach the run rejects with its cause, as Mastra's resume does; inside one,
 * Mastra's worker catches the throw as a failed item (`handlers/control-flow.ts:1200-1217`), so the
 * foreach fails with the cause as the item's error.
 */
function hostRefusal(token: unknown): { readonly cause: unknown } | undefined {
  const error = (token as { readonly error?: unknown }).error;
  return error instanceof HostPreconditionError ? { cause: error.cause } : undefined;
}

/**
 * The index an item's success token carries — the leaf copies the dispatch token's `foreachIndex`
 * onto it. A token without one is a broken contract, and failing loudly beats misplacing a result.
 */
function indexOf(token: FlowToken, id: string): number {
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
function foreachEntry(record: StepRecord): Record<string, unknown> {
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
function foreachOutputOf(f: ForeachFrame): unknown[] {
  const out: unknown[] = f.base === undefined ? [] : f.base.slice();
  const cells: Settled[] = [];
  for (let c = f.settled; c !== undefined; c = c.prev) cells.push(c);
  for (let i = cells.length - 1; i >= 0; i--) out[cells[i]!.index] = foreachEntry(cells[i]!.record);
  return out;
}

/** The same entries as the token's `ForeachMeta` carries them: by index, holes and nulls skipped. */
function itemRecordsOf(foreachOutput: readonly unknown[]): ForeachItemRecord[] {
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

/**
 * The frame a resume re-opens with. `stepInfo` is the stored aggregate minus Mastra's completion
 * fields and the engine's `host` (`handlers/control-flow.ts:990-996`); the input is its `payload`,
 * as `getResumeStepPrevOutput` reads it (`handlers/entry.ts:111-128,555-561`); the base is its
 * `foreachOutput`, the succeeded items' entries cleared as the queue loop clears them
 * (`:1253-1255`) and a parked item the store does not list filled from its seed.
 */
function resumedFrame(seed: ForeachResume, prior: StepRecord | undefined): ForeachFrame {
  const {
    output: _output,
    error: _error,
    endedAt: _endedAt,
    suspendedAt: _suspendedAt,
    suspendPayload: _suspendPayload,
    suspendOutput: _suspendOutput,
    tripwire: _tripwire,
    nonRetryable: _nonRetryable,
    host: _host,
    status: _status,
    payload: _payload,
    // Mastra writes this segment's in their place (`:993-995`): the host's, never the stored ones.
    resumePayload: _resumePayload,
    resumedAt: _resumedAt,
    startedAt,
    ...kept
  } = (prior ?? {}) as Record<string, unknown>;
  const input = prior !== undefined && Object.hasOwn(prior, 'payload') ? prior.payload : seed.items;
  const base = storedForeachOutput(prior).slice();
  for (const d of seed.done) base[d.index] = foreachEntry(d.record);
  for (const s of seed.parked) {
    const k = s.foreachIndex!;
    if (base[k] === null || base[k] === undefined) {
      base[k] = { status: 'suspended', suspendPayload: s.payload, ...(s.suspendedAt === undefined ? {} : { suspendedAt: s.suspendedAt }) };
    }
  }
  return { input, ...(typeof startedAt === 'number' ? { startedAt } : {}), kept, base };
}

/**
 * Why a seed cannot re-open this foreach, or `undefined` when it can: every index a whole number
 * inside the stored input, each item in at most one of the queue, the succeeded and the parked.
 * `foreachSeed` builds only fitting seeds; this is what keeps a hand-built one from stranding.
 */
function seedMisfit(seed: ForeachResume): string | undefined {
  if (seed === null || typeof seed !== 'object') return 'it is not a ForeachResume';
  const { items, order, done, parked } = seed;
  if (!Array.isArray(items) || !Array.isArray(order) || !Array.isArray(done) || !Array.isArray(parked)) {
    return 'items, order, done and parked must all be arrays';
  }
  const seen = new Set<number>();
  const claim = (index: unknown, what: string): string | undefined => {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= items.length) {
      return `${what} names item ${String(index)}, outside the ${items.length} stored item(s)`;
    }
    if (seen.has(index)) return `item ${index} is listed twice`;
    seen.add(index);
    return undefined;
  };
  for (const o of order) {
    const bad = claim((o as CursorItem | null)?.index, 'the queue');
    if (bad !== undefined) return bad;
  }
  for (const d of done) {
    const bad = claim((d as ForeachItemRecord | null)?.index, 'a succeeded item');
    if (bad !== undefined) return bad;
  }
  for (const s of parked) {
    const bad = claim((s as SuspendToken | null)?.foreachIndex, 'a parked suspension');
    if (bad !== undefined) return bad;
  }
  return undefined;
}

/**
 * The lane count, clamped exactly as Mastra's `resolveForeachConcurrency` clamps
 * (`utils.ts:786-796`): anything that is not a finite number, or is below 1, runs one at a time;
 * anything else is floored. Only the ceiling is ours.
 */
export function foreachLanes(entry: Extract<EntryDescription, { kind: 'foreach' }>): number {
  const configured: unknown = entry.concurrency;
  const lanes =
    typeof configured !== 'number' || !Number.isFinite(configured) || configured < 1 ? 1 : Math.floor(configured);
  if (lanes > MAX_FOREACH_LANES) {
    throw new Error(
      `.foreach '${entry.id}' has concurrency ${lanes}, above the ${MAX_FOREACH_LANES}-lane limit. ` +
        'Each concurrent item is a full copy of the step in the compiled workflow, so its size grows ' +
        'linearly with the concurrency. Lower it, or batch the items so each step call does more work.',
    );
  }
  return lanes;
}

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

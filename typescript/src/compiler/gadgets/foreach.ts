import { Transition, and, one, outPlace, place, xor, type Out, type Place, type TransitionContext } from 'libpetri';
import { scopeOf } from '../scope.js';
import { pipelineGadget } from '../blueprints/pipeline.js';
import type {
  BailToken,
  EntryDescription,
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
import {
  FOUR_SETTLES,
  MAX_FOREACH_LANES,
  cancelSweep,
  canceledAggregate,
  cons,
  failedAggregate,
  finisherTransitions,
  flagPair,
  foreachEntry,
  framePlaces,
  hostRefusal,
  indexOf,
  itemRecordOf,
  itemRecordsOf,
  laneExits,
  listOf,
  openedOut,
  settleInto,
  settleSuffix,
  settleTransitions,
  splitAction,
  storedForeachOutput,
  successAggregate,
  suspendedAggregate,
  takeAll,
  ungated,
  unlessCanceledBy,
  writeAggregate,
  type CursorItem,
  type ExitRecord,
  type FaultRecord,
  type FinisherFlag,
  type FlagPair,
  type FlagState,
  type ForeachCursor,
  type ForeachFrame,
  type ForeachSlot,
  type ItemFrame,
  type LanePermit,
  type SuspensionRecord,
} from './foreach-frame.js';
import type { Gadget } from './types.js';

// The frame, cursor, flags, settle and finisher factories live in `foreach-frame.ts`, shared with
// `pipeline()` ([ADR 0015]); these stay importable from here, where they always were.
export { MAX_FOREACH_LANES, itemsOf, storedForeachOutput } from './foreach-frame.js';

/**
 * `.foreach(step, { concurrency })` — run the body once per item of the previous entry's output,
 * at most `concurrency` at a time, results in **input** order, and **stop dispatching the moment
 * any item does not succeed, or the run is canceled**.
 *
 * ```text
 *   sweep        in, ?cancel                  -> exits.canceled                               (given a signal)
 *   split        in              ¬cancel      -> xor( open(queue.open) | open(queue.closed) [no items] | exits.failed )
 *                                                open(q) = frame + q + no-fault + no-exit + no-susp + permit.*
 *   start.l      queue.open, permit.l ¬cancel -> xor( body.l + slot.l + queue.open | body.l + slot.l + queue.closed )
 *   refuse.l     queue.open, permit.l ?cancel -> queue.closed + permit.l                      (given a signal)
 *   (body.l)     body.l                       -> done.l | failed.l | bailed.l | suspended.l | paused.l
 *   collect.l    done.l, slot.l, frame        -> frame + permit.l                     (the result onto the frame)
 *   K.l          K-outcome.l, slot.l, frame, queue.{open|closed}, {no-|}flag(K)
 *                                             -> frame + permit.l + queue.closed + flag(K)    (priority 1)
 *                for K in fail -> fault, bail -> exit, pause -> exit, suspend -> susp; four variants each
 *
 *   join         queue.closed, frame, permit.*, no-fault, no-exit, no-susp     ¬cancel -> next
 *   fail.*       queue.closed, frame, permit.*, fault, {no-}exit, {no-}susp    ¬cancel -> exits.failed
 *   exit.*       queue.closed, frame, permit.*, no-fault, exit, {no-}susp      ¬cancel -> exits.bailed | exits.paused
 *   suspend      queue.closed, frame, permit.*, no-fault, no-exit, susp        ¬cancel -> exits.suspended
 *   canceled.*   queue.closed, frame, permit.*, {no-}fault, {no-}exit, {no-}susp ?cancel -> exits.canceled
 *
 *   resume ([ADR 0007]; a top-level foreach only, marked only by a resume seed):
 *   re-enter.cancel  resume, ?cancel  -> exits.canceled                                       (not started)
 *   re-enter         resume  ¬cancel  -> xor( open(queue.{open|closed}) with susp on or off (4) | exits.failed )
 * ```
 * (`¬` an inhibitor arc, `?` a read arc; the arcs on `cancel` exist only given a signal. Every
 * other arc takes one token.)
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
 * by the signal, and each lane's `refuse.l` reads it and closes the queue — the worker's
 * `killQueue()` — handing the permit back; the body is **not** gated, because Mastra never checks
 * between an item's start and its end; the ordinary finishers are inhibited by it and the cancel
 * finishers read it, so exactly one decides. The cancel finishers wait, like every finisher, for
 * every permit and the closed queue — in-flight items finish first — and put the partial array on
 * `exits.canceled`. The foreach's input place has a sweep: that is Mastra's check before the entry
 * (`default.ts:815`), where the foreach never starts at all.
 *
 * **The stop is the queue token.** A non-success settle *takes* the queue — open or already closed
 * — and puts back a closed one: that is `queue.kill()`, and `start.l` needs the open queue, so no
 * item starts afterwards. It is race-free under in-flight firing ([VER-004]): a sibling `start` in
 * flight holds the queue token, so the settle waits for it to come back rather than resetting an
 * empty place the start would then refill — the revival libpetri 8.0.0's verifier found in an
 * earlier version of this gadget, which the TypeScript executor never showed in 2,400 runs. The
 * claim is a marking property again: `mutualExclusion(queue.open, fault | exit)`, proven in every
 * segment. Between an item's outcome and its settle there is a window: the settle carries
 * priority 1 over every `start` (0), so at run time it fires the instant the outcome lands
 * ([EXEC-002]); Mastra has the same window — it awaits a progress publish (`:1126`, `:1129`,
 * `:1135`) before `killQueue()` — and the priority-blind verifier explores it.
 *
 * **Why no inhibitors and no drains.** Every result and recorded outcome rides the frame as data,
 * and what has been recorded is a complement pair per kind (`no-fault` / `fault`, …), so every
 * place holds at most one token and every arc takes one. Under libpetri 8.0.0 a transition whose
 * outputs another transition tests by an inhibitor, reset or drain is verified as a start and a
 * completion; none of the settles is, and the net is bounded, so its proofs enumerate or settle in
 * seconds ([ADR 0009], amended).
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
 * **Which outcome is reported** — each an explicit Mastra rule, each a finisher, the precedence in
 * which flags it accepts rather than in a choice inside one action:
 *
 * - *Canceled beats everything* (`:1283-1312` run before the error check), as above: the cancel
 *   finishers accept every combination of flags.
 * - *Failure beats the rest, first in time.* `if (!errorResult) errorResult = result`
 *   (`:1130`, `:1210`) keeps the first failure to settle, not the lowest index. The frame lists
 *   failures in settle order, and the earliest is taken. (`.parallel()` differs: it reports the
 *   lowest arm index.) The failure token is forwarded whole, so a `tripwire` and a `nonRetryable`
 *   both survive (`:1360-1369` spreads the item's own result).
 * - *Then a bail or a pause, first in time*: `if (!exitResult) exitResult = result` (`:1136`),
 *   and the foreach returns that result as its own (`:1406`). A bail therefore ends the run as a
 *   success carrying the bail output; the array is never produced.
 * - *Then a suspension, lowest index*: suspended items land in an integer-keyed object
 *   (`foreachIndexObj[k]`, `:1119-1124`) and `Object.keys(...)[0]` is its **lowest** key
 *   (`:1411-1412`), whatever order they suspended in.
 *
 * Every finisher takes one token of each flag, so nothing is left behind whichever decides.
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
 * `ForeachResume` token re-enters it: `re-enter` re-opens the frame — carrying the items that
 * succeeded (reused) and the suspensions this segment does not re-run — every permit, the queue
 * (open over the items still to run, the resumed ones flagged, or closed), and `susp` on exactly
 * when a suspension stays. A carried suspension raises the flag but kills no queue — only a settle
 * of this segment takes the queue, as Mastra's `killQueue()` fires only for this segment's
 * outcomes — and the suspend finisher reports the lowest index across both, as Mastra's one
 * `foreachIndexObj` does.
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
 * **Everything is bounded.** The input's length is data the model cannot see, so `start.l`'s
 * "more items" branch is value-blind and a proof covers every item count at once — but no place
 * grows with it: results and recorded outcomes ride the frame, and every place holds at most one
 * token, so no bound is claimed above 1 and nothing is left unclaimed.
 */
export const foreachGadget: Gadget = (entry, next, ctx) => {
  if (entry.kind !== 'foreach') throw new Error(`foreachGadget received a '${entry.kind}' entry`);
  // A pipeline ([ADR 0015]) is its own gadget; without one this is exactly today's foreach.
  if (entry.pipeline !== undefined) return pipelineGadget(entry, next, ctx);
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
  const { frame, queueOpen, queueClosed } = framePlaces<ForeachFrame>(p);
  // What has been recorded, as complement pairs (`FlagPair`).
  const fault = flagPair(p, 'fault');
  const exit = flagPair(p, 'exit');
  /** A recorded suspension — this segment's, or one a resume carries. */
  const susp = flagPair(p, 'susp');
  /** The resume site: one {@link ForeachResume}, marked only by a resume seed ([ADR 0007]). */
  const resume = place<ForeachResume>(p('resume'));

  interface Lane {
    readonly permit: Place<LanePermit>;
    readonly slot: Place<ForeachSlot>;
    readonly done: Place<FlowToken>;
    readonly out: ReturnType<typeof laneExits>;
    readonly bodyIn: Place<FlowToken>;
  }

  const laneList: Lane[] = [];
  for (let lane = 0; lane < lanes; lane++) {
    const done = place<FlowToken>(p(`lane${lane}.done`));
    // Gadget-local exits, never `ctx.exits` (`laneExits`); `canceled` is unreachable.
    const out = laneExits((role) => p(`lane${lane}.${role}`));
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

  const everyPermit = laneList.map((l) => one(l.permit));
  const permitPlaces = laneList.map((l) => l.permit);
  /** What the canceled token names: the step the foreach runs, at the foreach's path. */
  const origin = { stepId: bodyId, path: viewPath };

  const transitions: Transition[] = [];

  /** Adds the signal's inhibitor to a transition that starts or decides work, given a signal. */
  const unlessCanceled = unlessCanceledBy(cancel);

  // Mastra's check before the entry (`default.ts:815`): the foreach never starts.
  if (cancel !== undefined) transitions.push(cancelSweep(t('cancel'), inPlace, cancel, exits.canceled, origin));

  /** The foreach opened: the frame, the queue, every flag off but `susp` as given, every permit. */
  const opened = (queue: 'open' | 'closed', suspended: boolean): Out =>
    openedOut(frame, queue === 'open' ? queueOpen : queueClosed, [fault.off, exit.off, suspended ? susp.on : susp.off], permitPlaces);
  const emitOpened = (tctx: TransitionContext, f: ForeachFrame, cursor: ForeachCursor | undefined, suspended: boolean): void => {
    tctx.output(frame, f);
    if (cursor === undefined) tctx.output(queueClosed, null);
    else tctx.output(queueOpen, cursor);
    tctx.output(fault.off, null);
    tctx.output(exit.off, null);
    tctx.output(suspended ? susp.on : susp.off, null);
    for (const l of laneList) tctx.output(l.permit, null);
  };

  /**
   * Opens the foreach: seeds the frame, the queue, the flags **and** every permit in one firing,
   * so no marking exists with permits and no queue (outputs of a firing land together, [EXEC-001]).
   *
   * Three declared branches for three outcomes: items to run; no items at all; and an input
   * Mastra cannot iterate either (see {@link itemsOf}), where Mastra's `execute()` rejects and we
   * fail the run.
   *
   * **No items still opens the foreach** — with the queue closed — and a finisher decides it,
   * exactly as the non-empty case is decided (row 49). Mastra enqueues nothing (`:1228`), skips the
   * wait (`:1276`) and still runs its check after the drain (`:1298-1312`) before it returns `[]`
   * (`:1486-1494`): an abort that lands anywhere between the check before the entry
   * (`default.ts:815`) and that check makes an empty foreach `canceled` with `output: []`, not
   * `success []`. Opened, the empty foreach is decided by `join` (¬cancel) or a `canceled`
   * finisher (?cancel), the arcs that decide every other foreach — no action reads the signal.
   */
  transitions.push(
    unlessCanceled(Transition.builder(t('split')))
      .inputs(one(inPlace))
      .outputs(xor(opened('open', false), opened('closed', false), outPlace(exits.failed)))
      .action(splitAction(entry.id, bodyId, viewPath, inPlace, exits.failed, (tctx, f, cursor) => emitOpened(tctx, f, cursor, false)))
      .build(),
  );

  laneList.forEach((l, lane) => {
    /**
     * A success: places the output at the index the leaf carried through, and returns the permit,
     * in one firing — so no marking has the lane idle and its result missing, which is what lets
     * a finisher read "every permit is back" as "every result is in". The frame takes the result
     * and the item's `foreachOutput` entry, as Mastra's worker writes `results[k]` and
     * `prevForeachOutput[k]` (`:1189-1198`).
     */
    transitions.push(
      Transition.builder(t(`lane${lane}.collect`))
        .inputs(one(l.done), one(l.slot), one(frame))
        .outputs(and(outPlace(frame), outPlace(l.permit)))
        .action(async (tctx) => {
          const produced = tctx.input(l.done);
          const s = tctx.input(l.slot);
          const f = tctx.input(frame);
          const scope = scopeOf(tctx);
          const index = indexOf(produced, entry.id);
          const record = itemRecordOf(scope, bodyId, index, 'success', () => ({
            status: 'success',
            output: produced.data,
            payload: s.item,
            startedAt: s.startedAt,
            endedAt: scope.epochNow(),
            metadata: { foreachIndex: index },
          }));
          const withResult: ForeachFrame = { ...f, results: cons(f.results, { index, value: produced.data }) };
          tctx.output(frame, settleInto(withResult, index, record));
          tctx.output(l.permit, null);
        })
        .build(),
    );

    /**
     * One non-success settle (`settleTransitions`): records the outcome on the frame, kills the
     * queue, raises its kind's flag, frees the lane — four variants, the queue open or already
     * closed, the flag off or already on. Mastra has a window between an item's outcome and its
     * `killQueue()` — it awaits a progress-event publish (`:1126`, `:1129`, `:1135`) — which the
     * settle's priority 1 closes at run time and the priority-blind verifier explores.
     */
    const settle = <T extends { readonly foreachIndex?: number }, R>(
      role: string,
      from: Place<T>,
      kind: FlagPair,
      status: StepRecord['status'],
      append: (f: ForeachFrame, recorded: R) => ForeachFrame,
      record: (token: T, item: ItemFrame, entry: StepRecord) => R,
      entryOf: (token: T, item: ItemFrame) => StepRecord,
    ): Transition[] =>
      settleTransitions({
        name: (variant) => t(`lane${lane}.${role}${settleSuffix(variant)}`),
        variants: FOUR_SETTLES,
        gate: ungated,
        from,
        slot: l.slot,
        frame,
        permit: l.permit,
        queueOpen,
        queueClosed,
        kind,
        record: (tctx, arrived, s, f) => {
          const scope = scopeOf(tctx);
          // The item as the step validated it, when the runner said: Mastra's aggregate record
          // for a deciding item takes that item's own payload (`handlers/step.ts:173`) — and that
          // item's own start, `handlers/step.ts:166,174`, which `{...finalErrorResult}` and
          // `return exitResult` hand on unchanged (`:1360-1369`, `:1406`; row 49). The slot's
          // stamp is the *dispatch*, which a run budget ([ADR 0006]) can hold apart from the
          // item's first attempt; it stands in only while the leaf does not report the start.
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
                : itemRecordOf(scope, bodyId, index, status, () => entryOf(token, frameOf));
          const recorded = append(f, record(token, frameOf, entryRecord));
          return index === undefined ? recorded : settleInto(recorded, index, entryRecord);
        },
      });

    /** The fields every rebuilt item entry shares: the item's input, start and index. */
    const itemBase = (item: ItemFrame, foreachIndex: number | undefined) => ({
      payload: item.item,
      startedAt: item.startedAt,
      ...(foreachIndex === undefined ? {} : { metadata: { foreachIndex } }),
    });
    transitions.push(
      ...settle(
        'fail',
        l.out.failed,
        fault,
        'failed',
        (f, r: FaultRecord) => ({ ...f, faults: cons(f.faults, r) }),
        (failure: FailureToken, item, entry): FaultRecord => ({ ...item, failure, entry }),
        (failure, item) => ({
          status: 'failed',
          error: failure.error,
          ...(failure.tripwire === undefined ? {} : { tripwire: failure.tripwire }),
          ...(failure.nonRetryable === true ? { nonRetryable: true } : {}),
          ...itemBase(item, failure.foreachIndex),
          endedAt: item.endedAt,
        }),
      ),
      ...settle(
        'bail',
        l.out.bailed,
        exit,
        'bailed',
        (f, r: ExitRecord) => ({ ...f, exits: cons(f.exits, r) }),
        (bail: BailToken, item, entry): ExitRecord => ({ ...item, status: 'bailed', bail, entry }),
        (bail, item) => ({ status: 'bailed', output: bail.output, ...itemBase(item, bail.foreachIndex), endedAt: item.endedAt }),
      ),
      ...settle(
        'pause',
        l.out.paused,
        exit,
        'paused',
        (f, r: ExitRecord) => ({ ...f, exits: cons(f.exits, r) }),
        (pause: PauseToken, item, entry): ExitRecord => ({ ...item, status: 'paused', pause, entry }),
        (pause, item) => ({ status: 'paused', ...itemBase(item, pause.foreachIndex) }),
      ),
      ...settle(
        'suspend',
        l.out.suspended,
        susp,
        'suspended',
        (f, r: SuspensionRecord) => ({ ...f, suspensions: cons(f.suspensions, r) }),
        // The item's input and start served its entry; the foreach's own suspension carries neither.
        ({ stepPayload: _payload, ...suspension }: SuspendToken): SuspensionRecord => ({ suspension }),
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
     * queue token is the whole scheduler: which lane runs an item is the marking's decision, and
     * no priority is involved among lanes. Inhibited by the signal: Mastra's worker checks it
     * before each task (`:1160`), and that is the only place an item can be stopped. Once a
     * non-success settle has taken the queue, it is closed and no start is enabled.
     *
     * The `xor` is "more items" versus "this was the last": the last closes the queue, which is
     * what eventually lets a finisher fire. A value-blind analysis that takes the short branch
     * early merely dispatches fewer items, which strands nothing.
     *
     * On a resume the cursor carries the queue Mastra built (`:1227-1272`): the head of `order`
     * starts, flagged `resumed` when it is the attempt the resume feeds. The flag is colour only.
     */
    transitions.push(
      unlessCanceled(Transition.builder(t(`lane${lane}.start`)))
        .inputs(one(queueOpen), one(l.permit))
        .outputs(
          xor(
            and(outPlace(l.bodyIn), outPlace(l.slot), outPlace(queueOpen)),
            and(outPlace(l.bodyIn), outPlace(l.slot), outPlace(queueClosed)),
          ),
        )
        .action(async (tctx) => {
          const c = tctx.input(queueOpen);
          tctx.input(l.permit);
          const head: CursorItem = c.order === undefined ? { index: c.next } : c.order[c.next]!;
          const item = c.items[head.index];
          tctx.output(l.bodyIn, { data: item, foreachIndex: head.index, ...(head.resumed === true ? { resumed: true as const } : {}) });
          tctx.output(l.slot, { item, startedAt: scopeOf(tctx).epochNow() });
          const length = c.order === undefined ? c.items.length : c.order.length;
          if (c.next + 1 < length) tctx.output(queueOpen, { ...c, next: c.next + 1 });
          else tctx.output(queueClosed, null);
        })
        .build(),
    );

    if (cancel !== undefined) {
      /**
       * Mastra's worker when the signal has fired (`:1160-1172`): it refuses the task, kills the
       * queue and hands the worker back — `killQueue(); inFlight--; cb(null)`. Here: the queue
       * closes, so nothing queued can ever start, and the lane's permit is handed straight back.
       * It is the sweep `start.l` competes with, which is what makes `start.l`'s inhibitor on the
       * signal checkable from the arcs alone (`cancelStructureViolations`).
       */
      transitions.push(
        Transition.builder(t(`lane${lane}.refuse`))
          .inputs(one(queueOpen), one(l.permit))
          .read(cancel)
          .outputs(and(outPlace(queueClosed), outPlace(l.permit)))
          .action(async (tctx) => {
            tctx.input(queueOpen);
            tctx.input(l.permit);
            tctx.output(queueClosed, null);
            tctx.output(l.permit, null);
          })
          .build(),
      );
    }
  });

  /**
   * A finisher (`finisherTransitions`): the queue closed, every permit, the frame, and one token of
   * each flag in the states it accepts — one transition per combination, named by the flags that
   * are on (`fail.f`, `fail.fe`, …).
   */
  const flags = (f: readonly FlagState[], e: readonly FlagState[], s: readonly FlagState[]): readonly FinisherFlag[] => [
    { pair: fault, letter: 'f', accepts: f },
    { pair: exit, letter: 'e', accepts: e },
    { pair: susp, letter: 's', accepts: s },
  ];
  const finisher = (role: string, accepts: readonly FinisherFlag[], build: (b: ReturnType<typeof Transition.builder>, flagPlaces: readonly Place<null>[]) => Transition): Transition[] =>
    finisherTransitions({ name: t, role, naming: 'on', queueClosed, frame, flags: accepts, permits: everyPermit, build });
  const takeFrame = (tctx: TransitionContext, flagPlaces: readonly Place<null>[]): ForeachFrame => takeAll(tctx, queueClosed, frame, flagPlaces, permitPlaces);

  /**
   * Every item succeeded. Enabled only with nothing left to start (the queue closed), no lane busy
   * (every permit), nothing recorded (every flag off) and no cancel (Mastra's check after the
   * drain, `:1298`) — the foreach with no items included (`:1486-1494`).
   */
  transitions.push(
    ...finisher('join', flags(['off'], ['off'], ['off']), (b, flagPlaces) =>
      unlessCanceled(b)
        .outputs(outPlace(next))
        .action(async (tctx) => {
          const f = takeFrame(tctx, flagPlaces);
          const scope = scopeOf(tctx);
          const { record, output } = successAggregate(f, scope.epochNow());
          await writeAggregate(scope, bodyId, viewPath, record);
          tctx.output(next, { data: output });
        })
        .build(),
    ),
  );

  /**
   * A failure was recorded: the first in time wins, and outranks every outcome but a cancel.
   *
   * The aggregate is the failing item's own result plus Mastra's `__workflow_meta.foreachOutput`
   * — every item settled so far, succeeded and suspended ones included (`:1355-1369`), which the
   * frame has carried since `split` (`failedAggregate`). The frame lists failures in settle order,
   * so the first is the first in time — Mastra's `if (!errorResult) errorResult = result`
   * (`:1130`, `:1210`).
   */
  transitions.push(
    ...finisher('fail', flags(['on'], ['off', 'on'], ['off', 'on']), (b, flagPlaces) =>
      unlessCanceled(b)
        .outputs(outPlace(exits.failed))
        .action(async (tctx) => {
          const f = takeFrame(tctx, flagPlaces);
          const { record, first, foreachOutput } = failedAggregate(f);
          const { failure } = first;
          const scope = scopeOf(tctx);
          await writeAggregate(scope, bodyId, viewPath, record);
          const meta: ForeachMeta = { foreachIndex: failure.foreachIndex ?? 0, foreachOutput: itemRecordsOf(foreachOutput) };
          tctx.output(exits.failed, { ...failure, foreach: meta });
        })
        .build(),
    ),
  );

  /** No failure, and a bail or pause was recorded: the first in time is the foreach's result. */
  transitions.push(
    ...finisher('exit', flags(['off'], ['on'], ['off', 'on']), (b, flagPlaces) =>
      unlessCanceled(b)
        .outputs(xor(outPlace(exits.bailed), outPlace(exits.paused)))
        .action(async (tctx) => {
          const f = takeFrame(tctx, flagPlaces);
          const first = listOf(f.exits)[0]!;
          // `return exitResult` (`:1406`): the item's own record — a paused one has no `endedAt`
          // (`handlers/step.ts:525`) — whose `foreachOutput` entry was made from the same record.
          await writeAggregate(scopeOf(tctx), bodyId, viewPath, first.entry);
          if (first.status === 'bailed') {
            tctx.output(exits.bailed, first.bail);
            return;
          }
          tctx.output(exits.paused, first.pause);
        })
        .build(),
    ),
  );

  /**
   * Only suspensions were recorded — this segment's and the ones a resume carries, which Mastra
   * keeps in one `foreachIndexObj` (`:1119-1124`, `:1246-1250`): the lowest index is the foreach's
   * suspension (`Object.keys(...)[0]`, `:1411-1412`).
   *
   * `{...stepInfo, suspendedAt, status, suspendPayload}` (`:1432-1450`, `suspendedAggregate`): the
   * foreach's own payload and start, the lowest item's suspend payload with Mastra's
   * `__workflow_meta` merged in — that item's `foreachIndex` and every item's `foreachOutput`
   * entry, what a resume reads to skip the items that succeeded and re-run the one that suspended —
   * and no `endedAt`. No `suspendOutput`: Mastra reads it from `foreachIndexObj`, which never stores
   * one (`:1119-1124`). The meta's `resumeLabels` are the run's, which only the host holds. The
   * token carries the same meta.
   */
  transitions.push(
    ...finisher('suspend', flags(['off'], ['off'], ['on']), (b, flagPlaces) =>
      unlessCanceled(b)
        .outputs(outPlace(exits.suspended))
        .action(async (tctx) => {
          const f = takeFrame(tctx, flagPlaces);
          const scope = scopeOf(tctx);
          const { record, lowest, foreachIndex, foreachOutput } = suspendedAggregate(f, scope.epochNow());
          await writeAggregate(scope, bodyId, viewPath, record);
          const meta: ForeachMeta = { foreachIndex, foreachOutput: itemRecordsOf(foreachOutput) };
          tctx.output(exits.suspended, { ...lowest, foreach: meta });
        })
        .build(),
    ),
  );

  if (cancel !== undefined) {
    /**
     * The run was canceled while the foreach ran: Mastra's `canceledResult` (`:1160-1172`) or its
     * check after the drain (`:1298-1312`), which outranks every other outcome — so it takes every
     * combination of flags, one transition each. Waits for every permit — in-flight items finish,
     * as Mastra's do — and for the queue to close, which `refuse.l` does once the signal is up.
     *
     * Records `{...stepInfo, status: 'canceled', output: results, endedAt}` under the body id, as
     * both of Mastra's canceled returns are (`:1164-1169`, `:1298-1312`), stored by
     * `entry.ts:811-812`: the foreach's input and start, the partial array. The same array rides
     * the `exits.canceled` token.
     */
    transitions.push(
      ...finisher('canceled', flags(['off', 'on'], ['off', 'on'], ['off', 'on']), (b, flagPlaces) =>
        b
          .read(cancel)
          .outputs(outPlace(exits.canceled))
          .action(async (tctx) => {
            const f = takeFrame(tctx, flagPlaces);
            const scope = scopeOf(tctx);
            const { record, output } = canceledAggregate(f, scope.epochNow());
            await writeAggregate(scope, bodyId, viewPath, record);
            tctx.output(exits.canceled, { origin, output, started: true });
          })
          .build(),
      ),
    );
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
     * Re-opens the foreach where the resume left it (`:1227-1272`), in one firing, as `split`
     * opens it: the frame — carrying the items that succeeded (their outputs reused, `:1252-1254`)
     * and the suspensions that stay — every permit, the queue open over the items still to run or
     * closed, and `susp` on exactly when a suspension stays. A carried suspension raises the flag
     * but kills no queue: only a settle of this segment takes the queue, as Mastra's `killQueue()`
     * fires only for this segment's outcomes. The four combinations are an `xor` decided from the
     * seed, so a value-blind proof explores every one of them from the single seed. A seed that
     * does not fit the stored input fails the run by name instead of throwing, which would strand it.
     *
     * The frame takes the stored aggregate as Mastra's `stepInfo` does (`:990-996`) — read from
     * the run's records like a loop's `start` reads its own, data only — and its
     * `__workflow_meta.foreachOutput` as the base every settle writes over (`:1040-1041`).
     */
    const reopenings: Out[] = [];
    for (const queue of ['open', 'closed'] as const) for (const suspended of [false, true]) reopenings.push(opened(queue, suspended));

    transitions.push(
      Transition.builder(t('re-enter'))
        .inputs(one(resume))
        .inhibitor(cancel)
        .outputs(xor(...reopenings, outPlace(exits.failed)))
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
          const reopened = resumedFrame(seed, prior);
          const observed = scope.observe({
            kind: 'foreach-entered',
            stepId: bodyId,
            path: viewPath,
            input: reopened.input,
            ...(reopened.startedAt === undefined ? {} : { startedAt: reopened.startedAt }),
            ...(reopened.kept === undefined ? {} : { kept: reopened.kept }),
            items: seed.items.length,
            resumed: true,
          });
          if (observed !== undefined) await observed;
          let f: ForeachFrame = reopened;
          for (const d of seed.done) f = { ...f, results: cons(f.results, { index: d.index, value: (d.record as { output?: unknown }).output }) };
          for (const suspension of seed.parked) f = { ...f, suspensions: cons(f.suspensions, { suspension }) };
          emitOpened(tctx, f, seed.order.length > 0 ? { items: seed.items, order: seed.order, next: 0 } : undefined, seed.parked.length > 0);
        })
        .build(),
    );

    resumeSites.push({ kind: 'foreach', path: [path[0]!], stepId: bodyId, place: resume, ...(entry.body.source === 'workflow' ? { nested: true as const } : {}) });
  }

  // The body's transitions are collected by the builder as `emitNested` returns them; repeating
  // them here would register each one twice. Every place holds at most one token — the data rides
  // the frame — so the default bound of 1 is claimed everywhere, and nothing is left unclaimed.
  return {
    inPlace,
    transitions,
    resumeSites,
    exclusions: [
      { a: queueOpen.name, b: queueClosed.name, why: 'the queue is open or closed, never both' },
      // Fail-fast: a failure, bail or pause is recorded only by a settle that took the queue —
      // waiting for any start in flight to give it back — and nothing reopens a closed queue, so no
      // item can start after one, under in-flight firing too ([VER-004]). Not a suspension: a resume
      // carries suspensions beside an open queue, as Mastra's does.
      { a: queueOpen.name, b: fault.on.name, why: 'a recorded failure has killed the queue' },
      { a: queueOpen.name, b: exit.on.name, why: 'a recorded bail or pause has killed the queue' },
      ...[fault, exit, susp].map((k) => ({ a: k.off.name, b: k.on.name, why: `'${k.on.name}' is recorded or not, never both` })),
      ...laneList.map((l, i) => ({ a: l.permit.name, b: l.slot.name, why: `lane ${i} is idle or busy, never both` })),
    ],
  };
};

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

import { Transition, all, and, one, outPlace, place, xor, type Place } from 'libpetri';
import { scopeOf } from '../scope.js';
import type {
  BailToken,
  CanceledToken,
  EntryDescription,
  Exits,
  FailureToken,
  FlowToken,
  PauseToken,
  SuspendToken,
} from '../types.js';
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
  readonly next: number;
}

/**
 * The foreach itself, from `split` to its finisher — Mastra's `stepInfo` (`:990-996`): the input
 * exactly as it arrived (a string stays a string) and when the foreach started. The success,
 * suspended and canceled aggregates are built on it; failure and exit aggregates are an item's.
 */
interface ForeachFrame {
  readonly input: unknown;
  readonly startedAt: number;
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

/** A failed item, recorded — Mastra's `errorResult` candidates. */
interface FaultRecord extends ItemFrame {
  readonly failure: FailureToken;
}

/** A bailed or paused item, recorded — Mastra's `exitResult` candidates. */
type ExitRecord =
  | (ItemFrame & { readonly status: 'bailed'; readonly bail: BailToken })
  | (ItemFrame & { readonly status: 'paused'; readonly pause: PauseToken });

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
 *   collect.l      done.l, slot.l              -> results + permit.l
 *   fail.l         failed.l, slot.l,    reset(cursor) -> faults + permit.l
 *   bail.l         bailed.l, slot.l,    reset(cursor) -> exits + permit.l
 *   pause.l        paused.l, slot.l,    reset(cursor) -> exits + permit.l
 *   suspend.l      suspended.l, slot.l, reset(cursor) -> suspensions + permit.l
 *
 *   join     all(results), frame, permit.*  ¬cancel ¬cursor ¬faults ¬exits ¬suspensions  -> next
 *   join-empty           frame, permit.*    ¬cancel ¬cursor ¬faults ¬exits ¬suspensions ¬results -> next
 *   fail     all(faults), frame, permit.*   ¬cancel reset(exits, suspensions, results)   -> exits.failed
 *   exit     all(exits), frame, permit.*    ¬cancel ¬faults reset(suspensions, results)  -> exits.bailed | exits.paused
 *   suspend  all(suspensions), frame, permit.* ¬cancel ¬faults ¬exits reset(results)     -> exits.suspended
 *   cancel   all(results), frame, permit.*  ?cancel reset(cursor, faults, exits, suspensions) -> exits.canceled
 *   cancel-empty        frame, permit.*     ?cancel ¬results reset(cursor, faults, exits, suspensions) -> exits.canceled
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
 * - *failed*: `{...finalErrorResult, suspendPayload}` (`:1360-1369`) — the **failing item's own
 *   result**, so its payload is the item, its times the item's, and `tripwire` / `nonRetryable`
 *   ride along. Rebuilt from the outcome token and the slot, because by the time the finisher
 *   fires a sibling still in flight may have overwritten the leaf's record. `metadata.foreachIndex`
 *   is kept as the leaf wrote it. `startedAt` is **not** the foreach's: the item's `executeStep`
 *   takes its own (`handlers/step.ts:166,174`; `stepInfo` of `executeForeach` is never written
 *   into `stepResults` before items run, so nothing carries over on a fresh run), stamped before
 *   its first attempt — the leaf's `startedAt`, carried on the token as `stepStartedAt`.
 * - *bailed / paused*: `exitResult` returned verbatim (`:1406`) — again the item's own result.
 * - *suspended*: `{...stepInfo, suspendedAt, status, suspendPayload}` (`:1432-1450`) — the
 *   foreach's payload and start, no `endedAt`.
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

  // Settles are declared before starts. Nothing depends on it — the inhibitors close the window
  // structurally — but it keeps the executor's tie-break ([EXEC-002]) pointing the same way.
  laneList.forEach((l, lane) => {
    /**
     * A success: places the output at the index the leaf carried through, and returns the permit,
     * in one firing — so no marking has the lane idle and its result missing, which is what lets
     * `join` read "every permit is back" as "every result is in".
     */
    transitions.push(
      Transition.builder(t(`lane${lane}.collect`))
        .inputs(one(l.done), one(l.slot))
        .outputs(and(outPlace(results), outPlace(l.permit)))
        .action(async (tctx) => {
          const produced = tctx.input(l.done);
          tctx.input(l.slot);
          tctx.output(results, { index: indexOf(produced, entry.id), value: produced.data });
          tctx.output(l.permit, null);
        })
        .build(),
    );

    /** One non-success settle: records the outcome, kills the queue, frees the lane. */
    const settle = <T, R>(role: string, from: Place<T>, into: Place<R>, record: (token: T, item: ItemFrame) => R) =>
      Transition.builder(t(`lane${lane}.${role}`))
        .inputs(one(from), one(l.slot))
        .reset(cursor)
        .outputs(and(outPlace(into), outPlace(l.permit)))
        .action(async (tctx) => {
          const arrived = tctx.input(from);
          const s = tctx.input(l.slot);
          // The item as the step validated it, when the runner said: Mastra's aggregate record
          // for a deciding item takes that item's own payload (`handlers/step.ts:173`).
          // ... and that item's own start, `handlers/step.ts:166,174`, which `{...finalErrorResult}`
          // and `return exitResult` hand on unchanged (`:1360-1369`, `:1406`; row 49). The slot's
          // stamp is the *dispatch*, which a run budget ([ADR 0006]) can hold apart from the
          // item's first attempt; it stands in only while the leaf does not report the start.
          // The start is the aggregate record's alone, so it goes no further than this settle.
          const { stepStartedAt: reported, ...rest } = arrived as T & { stepStartedAt?: unknown };
          const token = rest as T;
          const item = 'stepPayload' in (token as object) ? (token as { stepPayload?: unknown }).stepPayload : s.item;
          const startedAt = typeof reported === 'number' ? reported : s.startedAt;
          tctx.output(into, record(token, { item, startedAt, endedAt: scopeOf(tctx).epochNow() }));
          tctx.output(l.permit, null);
        })
        .build();

    transitions.push(
      settle('fail', l.out.failed, faults, (failure, item): FaultRecord => ({ ...item, failure })),
      settle('bail', l.out.bailed, exited, (bail, item): ExitRecord => ({ ...item, status: 'bailed', bail })),
      settle('pause', l.out.paused, exited, (pause, item): ExitRecord => ({ ...item, status: 'paused', pause })),
      settle('suspend', l.out.suspended, suspensions, (suspension): SuspensionRecord => ({ suspension })),
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
          const index = c.next;
          const item = c.items[index];
          tctx.output(l.bodyIn, { data: item, foreachIndex: index });
          tctx.output(l.slot, { item, startedAt: scopeOf(tctx).epochNow() });
          if (index + 1 < c.items.length) tctx.output(cursor, { items: c.items, next: index + 1 });
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
   * Every item succeeded. Enabled only with nothing left to start (¬cursor), no lane busy (every
   * permit consumed), nothing recorded against the foreach (¬faults ¬exits ¬suspensions) and no
   * cancel (Mastra's check after the drain, `:1298`). `all(results)` is honest: the domain really
   * is "take every result", and nothing can add to it while this firing holds every permit.
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
      .inhibitors(cursor, faults, exited, suspensions)
      .outputs(outPlace(next));
    if (!withResults) b.inhibitor(results);
    return b
      .action(async (tctx) => {
        const output = withResults ? assemble(tctx.inputs(results)) : [];
        const f = tctx.input(frame);
        const scope = scopeOf(tctx);
        scope.recordStepResult(bodyId, {
          status: 'success',
          output,
          payload: f.input,
          startedAt: f.startedAt,
          endedAt: scope.epochNow(),
        });
        tctx.output(next, { data: output });
      })
      .build();
  };
  transitions.push(joined('join', true), joined('join-empty', false));

  /** A failure was recorded: the first in time wins, and outranks every outcome but a cancel. */
  transitions.push(
    unlessCanceled(Transition.builder(t('fail')))
      .inputs(all(faults), one(frame), ...everyPermit)
      .resets(exited, suspensions, results)
      .outputs(outPlace(exits.failed))
      .action(async (tctx) => {
        const first = tctx.inputs(faults)[0]!;
        tctx.input(frame);
        const { failure } = first;
        // The item's own result, as `{...finalErrorResult}` is (`:1360-1369`).
        scopeOf(tctx).recordStepResult(bodyId, {
          status: 'failed',
          error: failure.error,
          ...(failure.tripwire === undefined ? {} : { tripwire: failure.tripwire }),
          ...(failure.nonRetryable === true ? { nonRetryable: true } : {}),
          ...itemRecord(first, failure.foreachIndex),
        });
        tctx.output(exits.failed, failure);
      })
      .build(),
  );

  /** No failure, and a bail or pause was recorded: the first in time is the foreach's result. */
  transitions.push(
    unlessCanceled(Transition.builder(t('exit')))
      .inputs(all(exited), one(frame), ...everyPermit)
      .inhibitor(faults)
      .resets(suspensions, results)
      .outputs(xor(outPlace(exits.bailed), outPlace(exits.paused)))
      .action(async (tctx) => {
        const first = tctx.inputs(exited)[0]!;
        tctx.input(frame);
        const scope = scopeOf(tctx);
        if (first.status === 'bailed') {
          scope.recordStepResult(bodyId, {
            status: 'bailed',
            output: first.bail.output,
            ...itemRecord(first, first.bail.foreachIndex),
          });
          tctx.output(exits.bailed, first.bail);
          return;
        }
        // Mastra's paused result has no `endedAt` (`handlers/step.ts:525`).
        const { endedAt: _unused, ...paused } = itemRecord(first, first.pause.foreachIndex);
        scope.recordStepResult(bodyId, { status: 'paused', ...paused });
        tctx.output(exits.paused, first.pause);
      })
      .build(),
  );

  /** Only suspensions were recorded: the lowest index is the foreach's suspension. */
  transitions.push(
    unlessCanceled(Transition.builder(t('suspend')))
      .inputs(all(suspensions), one(frame), ...everyPermit)
      .inhibitors(faults, exited)
      .reset(results)
      .outputs(outPlace(exits.suspended))
      .action(async (tctx) => {
        const recorded = tctx.inputs(suspensions).map((r) => r.suspension);
        const f = tctx.input(frame);
        let lowest = recorded[0]!;
        for (const r of recorded) if ((r.foreachIndex ?? 0) < (lowest.foreachIndex ?? 0)) lowest = r;
        // `{...stepInfo, suspendedAt, status, suspendPayload}` (`:1432-1450`): the foreach's own
        // payload and start, the lowest item's suspend payload, and no `endedAt`. No
        // `suspendOutput`: Mastra reads it from `foreachIndexObj`, which never stores one
        // (`:1119-1124`), so a foreach's suspended result never has it. The `__workflow_meta`
        // Mastra merges into the payload is resume state, not modelled (`docs/divergences.md`).
        const scope = scopeOf(tctx);
        scope.recordStepResult(bodyId, {
          status: 'suspended',
          suspendPayload: lowest.payload,
          payload: f.input,
          startedAt: f.startedAt,
          suspendedAt: scope.epochNow(),
        });
        tctx.output(exits.suspended, lowest);
      })
      .build(),
  );

  if (cancel !== undefined) {
    /**
     * The run was canceled while the foreach ran: Mastra's `canceledResult` (`:1160-1172`) or its
     * check after the drain (`:1298-1312`), which outranks every other outcome. Waits for every
     * permit — in-flight items finish, as Mastra's do — and then clears whatever the queue and the
     * lanes left: the undispatched tail and any recorded outcome. Two transitions only because
     * `all()` needs at least one token: one with results, one inhibited by them.
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
        .resets(cursor, faults, exited, suspensions)
        .outputs(outPlace(exits.canceled));
      if (!withResults) b.inhibitor(results);
      return b
        .action(async (tctx) => {
          const output = withResults ? assemble(tctx.inputs(results)) : [];
          const f = tctx.input(frame);
          const scope = scopeOf(tctx);
          scope.recordStepResult(bodyId, {
            status: 'canceled',
            output,
            payload: f.input,
            startedAt: f.startedAt,
            endedAt: scope.epochNow(),
          });
          tctx.output(exits.canceled, { origin, output, started: true });
        })
        .build();
    };
    transitions.push(canceled('canceled', true), canceled('canceled-empty', false));
  }

  // The body's transitions are collected by the builder as `emitNested` returns them; repeating
  // them here would register each one twice.
  return { inPlace, transitions };
};

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

/** The fields of an item's own `StepResult` that become the foreach's when that item decides it. */
function itemRecord(
  item: ItemFrame,
  foreachIndex: number | undefined,
): { payload: unknown; startedAt: number; endedAt: number; metadata?: { foreachIndex: number } } {
  return {
    payload: item.item,
    startedAt: item.startedAt,
    endedAt: item.endedAt,
    ...(foreachIndex === undefined ? {} : { metadata: { foreachIndex } }),
  };
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

import { Transition, all, and, one, outPlace, place, xor, type Place } from 'libpetri';
import { scopeOf } from '../scope.js';
import type {
  BailToken,
  EntryDescription,
  Exits,
  FailureToken,
  FlowToken,
  PauseToken,
  StepOutcome,
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

/** What a lane is working on. Its presence *is* "this lane is busy". */
interface ForeachSlot {
  readonly index: number;
}

/** One item's output, tagged with where it belongs in the output array. */
interface ForeachResult {
  readonly index: number;
  readonly value: unknown;
}

/** A lane's permit. `null`, because presence is the whole message ([CORE-012] unit token). */
type LanePermit = null;

/** A failed item, recorded — Mastra's `errorResult` candidates. */
interface FaultRecord {
  readonly index: number;
  readonly failure: FailureToken;
}

/** A bailed or paused item, recorded — Mastra's `exitResult` candidates. */
type ExitRecord =
  | { readonly status: 'bailed'; readonly index: number; readonly bail: BailToken }
  | { readonly status: 'paused'; readonly index: number; readonly pause: PauseToken };

/** A suspended item, recorded — Mastra's `foreachIndexObj`. */
interface SuspensionRecord {
  readonly index: number;
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
 * any item does not succeed**.
 *
 * ```text
 *   split          in                          -> xor( cursor + permit.* | next [no items] | exits.failed )
 *   start.l        cursor, permit.l            -> xor( body.l + slot.l + cursor | body.l + slot.l )
 *                  inhibited by every *other* lane's failed/bailed/suspended/paused
 *   (body.l)       body.l                      -> done.l | failed.l | bailed.l | suspended.l | paused.l
 *   collect.l      done.l, slot.l              -> results + permit.l
 *   fail.l         failed.l, slot.l,    reset(cursor) -> faults + permit.l
 *   bail.l         bailed.l, slot.l,    reset(cursor) -> exits + permit.l
 *   pause.l        paused.l, slot.l,    reset(cursor) -> exits + permit.l
 *   suspend.l      suspended.l, slot.l, reset(cursor) -> suspensions + permit.l
 *
 *   join     all(results), permit.*   ¬cursor ¬faults ¬exits ¬suspensions      -> next
 *   fail     all(faults), permit.*    reset(exits, suspensions, results)       -> exits.failed
 *   exit     all(exits), permit.*     ¬faults  reset(suspensions, results)     -> exits.bailed | exits.paused
 *   suspend  all(suspensions), permit.* ¬faults ¬exits  reset(results)        -> exits.suspended
 * ```
 *
 * **What Mastra does** (`executeForeach`, `handlers/control-flow.ts:952-1495`). Every item is
 * pushed onto a `fastq` queue of width `concurrency` (`:1225`, `:1228-1272`); fastq starts the
 * next queued item the moment a worker calls back, so admission is fluid. On the first item that
 * does not succeed — failed, bailed, paused *or suspended* — `handleNonSuccessResult` calls
 * `killQueue()` (`:1141`), which is `inFlight -= queue.length(); queue.kill()` (`:1087-1090`):
 * nothing queued ever starts, items already running finish, and only then (`:1276-1280`) is the
 * foreach decided, with a fixed precedence — any failure (`:1315-1316`), else any bail or pause
 * (`:1373`), else any suspension (`:1410`), else success.
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
 * instantiation at child path `[...path, lane]`, so N lanes are N distinct transitions genuinely
 * in flight, and pairing is structural: `done.l`, the four outcome places and `slot.l` each hold at
 * most one token, because `start.l` needs a permit only a settle of that lane gives back.
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
 * - *Failure beats everything, first in time.* `if (!errorResult) errorResult = result`
 *   (`:1130`, `:1210`) keeps the first failure to settle, not the lowest index. `all(faults)`
 *   hands the action every recorded failure in arrival order ([CORE-013] FIFO), and the head is
 *   taken. (`.parallel()` differs: it reports the lowest arm index.) A `tripwire` rides on the
 *   failure unchanged, so the run ends `tripwire` exactly when Mastra's `fmtReturnValue` would.
 * - *Then a bail or a pause, first in time*: `if (!exitResult) exitResult = result` (`:1136`),
 *   and the foreach returns that result as its own (`:1406`). A bail therefore ends the run as a
 *   success carrying the bail output; the array is never produced.
 * - *Then a suspension, lowest index*: suspended items land in an integer-keyed object
 *   (`foreachIndexObj[k]`, `:1119-1124`) and `Object.keys(...)[0]` is its **lowest** key
 *   (`:1411-1412`), whatever order they suspended in. The record keeps only `status`,
 *   `suspendPayload` and `suspendedAt`, so the `suspendOutput` spread at `:1439-1441` never fires:
 *   a suspended foreach carries no output, and neither does ours.
 *
 * Losers are reset, not stranded: a higher-precedence finisher resets the lower-precedence
 * records, and every non-success finisher resets `results` — Mastra returns no array in those
 * cases either.
 *
 * **The run-scoped step results.** The body's leaf records each item's outcome under the body id
 * as the item settles, exactly as Mastra's `Object.assign(stepResults, ...)` does (`:1179`).
 * The finisher then records the **aggregate** under the same id, as `entry.ts:811-812` does with the
 * foreach's own result, and it can only fire once every lane is idle — so the aggregate is always
 * the last write. `getStepOutput` reads `stepResults[body.id]` (`default.ts:1152-1153`), which is
 * why the value on `next` is the same whether or not `next` is the run's result.
 *
 * **Output.** `results[k] = output` for each success whose output is not `undefined`
 * (`:1189-1191`), so an `undefined` output leaves a *hole* and the array is only as long as the
 * last defined index. Reproduced by assigning, not by mapping.
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
  const { names, path, exits } = ctx;

  // Every name is minted through the vocabulary: libpetri place identity is the name string
  // ([CORE-010]), so a hand-rolled name that collided would silently merge two lanes.
  const p = (role: string): string => names.entryPlace(path, entry.id, role);
  const t = (role: string): string => names.entryTransition(path, entry.id, role);

  const inPlace = place<FlowToken>(names.entryIn(path, entry.id));
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
    const out: Exits = {
      failed: place<FailureToken>(p(`lane${lane}.failed`)),
      bailed: place<BailToken>(p(`lane${lane}.bailed`)),
      suspended: place<SuspendToken>(p(`lane${lane}.suspended`)),
      paused: place<PauseToken>(p(`lane${lane}.paused`)),
    };
    const body = ctx.emitNested(entry.body, [...path, lane], done, out);
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

  const transitions: Transition[] = [];

  /**
   * Opens the foreach: seeds the cursor **and** every permit in one firing, so no marking exists
   * with permits and no cursor (outputs of a firing land together, [EXEC-001]).
   *
   * Three declared branches for three outcomes: items to run; no items at all (Mastra enqueues
   * nothing and returns `[]`, `:1228`, `:1488-1494`); and an input Mastra cannot iterate either
   * (see {@link itemsOf}), where Mastra's `execute()` rejects and we fail the run.
   */
  transitions.push(
    Transition.builder(t('split'))
      .inputs(one(inPlace))
      .outputs(xor(and(outPlace(cursor), ...laneList.map((l) => outPlace(l.permit))), outPlace(next), outPlace(exits.failed)))
      .action(async (tctx) => {
        const incoming = tctx.input(inPlace);
        const scope = scopeOf(tctx);

        // Decide, then emit ([EXEC-031]: the input is already gone and nothing is restored).
        let items: readonly unknown[] | undefined;
        let error: unknown;
        try {
          items = itemsOf(entry.id, incoming.data);
        } catch (e) {
          error = e;
        }

        if (items === undefined) {
          scope.recordStepResult(bodyId, { status: 'failed', error });
          tctx.output(exits.failed, { stepId: bodyId, error });
          return;
        }
        if (items.length === 0) {
          scope.recordStepResult(bodyId, { status: 'success', output: [] });
          tctx.output(next, { data: [] });
          return;
        }
        tctx.output(cursor, { items, next: 0 });
        for (const l of laneList) tctx.output(l.permit, null);
      })
      .build(),
  );

  // Settles are declared before starts. Nothing depends on it — the inhibitors close the window
  // structurally — but it keeps the executor's tie-break ([EXEC-002]) pointing the same way.
  laneList.forEach((l, lane) => {
    /**
     * A success: pairs the output with the index the lane started with and returns the permit,
     * in one firing — so no marking has the lane idle and its result missing, which is what lets
     * `join` read "every permit is back" as "every result is in".
     */
    transitions.push(
      Transition.builder(t(`lane${lane}.collect`))
        .inputs(one(l.done), one(l.slot))
        .outputs(and(outPlace(results), outPlace(l.permit)))
        .action(async (tctx) => {
          const produced = tctx.input(l.done);
          const s = tctx.input(l.slot);
          tctx.output(results, { index: s.index, value: produced.data });
          tctx.output(l.permit, null);
        })
        .build(),
    );

    /** One non-success settle: records the outcome, kills the queue, frees the lane. */
    const settle = <T, R>(role: string, from: Place<T>, into: Place<R>, record: (token: T, index: number) => R) =>
      Transition.builder(t(`lane${lane}.${role}`))
        .inputs(one(from), one(l.slot))
        .reset(cursor)
        .outputs(and(outPlace(into), outPlace(l.permit)))
        .action(async (tctx) => {
          const token = tctx.input(from);
          const s = tctx.input(l.slot);
          tctx.output(into, record(token, s.index));
          tctx.output(l.permit, null);
        })
        .build();

    transitions.push(
      settle('fail', l.out.failed, faults, (failure, index) => ({ index, failure })),
      settle('bail', l.out.bailed, exited, (bail, index): ExitRecord => ({ status: 'bailed', index, bail })),
      settle('pause', l.out.paused, exited, (pause, index): ExitRecord => ({ status: 'paused', index, pause })),
      settle('suspend', l.out.suspended, suspensions, (suspension, index) => ({ index, suspension })),
    );
  });

  laneList.forEach((l, lane) => {
    /**
     * Admits the next item into this lane. Competing with the other lanes' `start` for the one
     * cursor is the whole scheduler: which lane runs an item is the marking's decision, and no
     * priority is involved.
     *
     * The `xor` is "more items" versus "this was the last": the last drops the cursor, which is
     * what eventually lets `join` fire. A value-blind analysis that takes the short branch early
     * merely dispatches fewer items, which strands nothing.
     */
    transitions.push(
      Transition.builder(t(`lane${lane}.start`))
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
          tctx.output(l.bodyIn, { data: c.items[index] });
          tctx.output(l.slot, { index });
          if (index + 1 < c.items.length) tctx.output(cursor, { items: c.items, next: index + 1 });
        })
        .build(),
    );
  });

  /**
   * Every item succeeded. Enabled only with nothing left to start (¬cursor), no lane busy (every
   * permit consumed) and nothing recorded against the foreach (¬faults ¬exits ¬suspensions).
   * `all(results)` is honest: the domain really is "take every result", and nothing can add to it
   * while this firing holds every permit.
   */
  transitions.push(
    Transition.builder(t('join'))
      .inputs(all(results), ...everyPermit)
      .inhibitors(cursor, faults, exited, suspensions)
      .outputs(outPlace(next))
      .action(async (tctx) => {
        const output: unknown[] = [];
        for (const r of tctx.inputs(results)) {
          // `results[k] = result.output` only when the output is defined (`:1189-1191`).
          if (r.value !== undefined) output[r.index] = r.value;
        }
        scopeOf(tctx).recordStepResult(bodyId, { status: 'success', output });
        tctx.output(next, { data: output });
      })
      .build(),
  );

  /** A failure was recorded: the first in time wins, and outranks every other outcome. */
  transitions.push(
    Transition.builder(t('fail'))
      .inputs(all(faults), ...everyPermit)
      .resets(exited, suspensions, results)
      .outputs(outPlace(exits.failed))
      .action(async (tctx) => {
        const { failure } = tctx.inputs(faults)[0]!;
        const outcome: StepOutcome =
          failure.tripwire === undefined
            ? { status: 'failed', error: failure.error }
            : { status: 'failed', error: failure.error, tripwire: failure.tripwire };
        scopeOf(tctx).recordStepResult(bodyId, outcome);
        tctx.output(exits.failed, failure);
      })
      .build(),
  );

  /** No failure, and a bail or pause was recorded: the first in time is the foreach's result. */
  transitions.push(
    Transition.builder(t('exit'))
      .inputs(all(exited), ...everyPermit)
      .inhibitor(faults)
      .resets(suspensions, results)
      .outputs(xor(outPlace(exits.bailed), outPlace(exits.paused)))
      .action(async (tctx) => {
        const first = tctx.inputs(exited)[0]!;
        const scope = scopeOf(tctx);
        if (first.status === 'bailed') {
          scope.recordStepResult(bodyId, { status: 'bailed', output: first.bail.output });
          tctx.output(exits.bailed, { stepId: first.bail.stepId, output: first.bail.output });
          return;
        }
        scope.recordStepResult(bodyId, { status: 'paused' });
        // Mastra runs each item at the foreach's own execution path (`:1101`), so that is the
        // path reported, not the lane's.
        tctx.output(exits.paused, { stepId: first.pause.stepId, path });
      })
      .build(),
  );

  /** Only suspensions were recorded: the lowest index is the foreach's suspension. */
  transitions.push(
    Transition.builder(t('suspend'))
      .inputs(all(suspensions), ...everyPermit)
      .inhibitors(faults, exited)
      .reset(results)
      .outputs(outPlace(exits.suspended))
      .action(async (tctx) => {
        const recorded = tctx.inputs(suspensions);
        let lowest = recorded[0]!;
        for (const r of recorded) if (r.index < lowest.index) lowest = r;
        const { stepId, payload } = lowest.suspension;
        scopeOf(tctx).recordStepResult(bodyId, { status: 'suspended', payload });
        tctx.output(exits.suspended, { stepId, path, payload });
      })
      .build(),
  );

  // The body's transitions are collected by the builder as `emitNested` returns them; repeating
  // them here would register each one twice.
  return { inPlace, transitions };
};

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

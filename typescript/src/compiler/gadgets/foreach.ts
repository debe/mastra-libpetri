import { Transition, all, and, one, outPlace, place, xor, type Place } from 'libpetri';
import type { EntryDescription, FailureToken, FlowToken } from '../types.js';
import type { Gadget } from './types.js';

/**
 * The undispatched tail of the input array.
 *
 * One token, consumed and re-emitted by whichever lane starts the next item, which makes it a
 * mutex: items *start* in input order because there is only ever one cursor, not because the
 * engine iterates. `items` is the whole array and `next` indexes it, so the index that pairs a
 * result back to its slot is carried rather than recomputed.
 */
interface ForeachCursor {
  readonly items: readonly unknown[];
  readonly next: number;
}

/** What a lane is currently working on. Its presence *is* "this lane is busy". */
interface ForeachSlot {
  readonly index: number;
}

/** One item's output, tagged with where it belongs in the output array. */
interface ForeachResult {
  readonly index: number;
  readonly value: unknown;
}

/**
 * A lane's permit. `null` because presence is the whole message ([CORE-011] unit token).
 */
type LanePermit = null;

/**
 * How many lanes one `.foreach` may compile to.
 *
 * A lane is a full copy of the body, so the net is O(concurrency x |body|) and so is anything
 * that explores it. Failing loudly beats compiling a net that exhausts memory or that no
 * verification run could ever finish; the message says what to do instead.
 */
const MAX_LANES = 256;

/**
 * `.foreach(step, { concurrency })` — run the body once per item of the previous entry's
 * output array, at most `concurrency` at a time, and produce the results in **input** order.
 *
 * **The shape.** `concurrency` is a compile-time number, so the gadget emits that many *lanes*.
 * A lane is one instantiation of the body (child path `[...path, lane]`, hence its own places)
 * plus a permit place, a slot place and the two places the body settles into:
 *
 * ```
 *   split      in                     -> xor( cursor + permit.0..n | next | failed )
 *   start.l    cursor, permit.l       -> xor( body.l + slot.l + cursor | body.l + slot.l )
 *   (body.l)   body.l                 -> xor( done.l | failed.l )
 *   collect.l  done.l, slot.l         -> results + permit.l
 *   rescue.l   failed.l, slot.l       -> faults + permit.l
 *   join       all(results), permit.* -> next     ¬cursor ¬faults
 *   abort      all(faults), permit.*  -> failed   ¬cursor  reset(results)
 * ```
 *
 * **Why lanes rather than one body and N anonymous permits.** Two reasons, either decisive.
 * An anonymous permit cannot say *which* body is free, so N permits over one body copy put N
 * items into one set of places, and a result there can no longer be paired with the slot it
 * belongs to — completion order is not dispatch order, which is exactly the case the ordering
 * test covers. And it would not even run concurrently: both executors skip a transition whose
 * action is still in flight (`inFlightFlags` in `precompiled-net-executor.ts`, the `fireReady*`
 * paths), so one body transition runs one item at a time however many permits are held. Lanes
 * fix both: one item per lane by construction, and N distinct transitions genuinely in flight.
 *
 * **Why this needs no ν.** Correlation by name ([NU-020]) exists for the case where several
 * groups share places and the join must pair the right siblings. Here the sibling streams are
 * already disjoint — one lane, one item, one slot — so a match spec would correlate a place
 * whose per-name cardinality is structurally 1, which is the "match spec on a net where only
 * one group is live" anti-pattern and moves every query off the cheap linear routes. It is also
 * not available: the body rebuilds the flow token as `{ data }` (see `stepAction`), so no
 * minted name survives it for a key projection to read back.
 *
 * **Why the permit is a place and not an option.** `permit.l + slot.l = 1` per lane is a
 * P-invariant a verifier can read, and summed over lanes it is `inFlight + permits =
 * concurrency`. A runtime semaphore proves nothing. Fluid (not batched) admission falls out of
 * it for free: `start.l` needs only *its own* permit and the cursor, so the next item starts the
 * moment any one lane settles — no barrier, no generation counter, nothing that waits for a
 * batch.
 *
 * **What is not bounded, and what that costs.** `results` and `faults` grow with the input
 * array, which is data, and the model cannot see data. So they carry no structural bound, and
 * the untimed abstraction — value-blind, so it may re-emit the cursor forever — cannot close a
 * termination proof either. A `maxItems` on the entry description would fix both (a budget place
 * seeded with `maxItems`, an inhibitor-armed overflow branch on `start`); `EntryDescription`
 * does not carry one today. Everything else here is 1-bounded: `in`, `cursor`, and per lane
 * `permit`, `slot`, `done` and `failed`.
 */
export const foreachGadget: Gadget = (entry, next, ctx) => {
  if (entry.kind !== 'foreach') throw new Error(`foreachGadget received a '${entry.kind}' entry`);
  const lanes = laneCount(entry);

  // Every name is minted through the vocabulary: libpetri place identity is the name string
  // ([CORE-010]), so a hand-rolled name that collided would silently *merge* two lanes.
  const p = (role: string): string => ctx.names.entryPlace(ctx.path, entry.id, role);
  const t = (role: string): string => ctx.names.entryTransition(ctx.path, entry.id, role);

  const inPlace = place<FlowToken>(ctx.names.entryIn(ctx.path, entry.id));
  const cursor = place<ForeachCursor>(p('cursor'));
  const results = place<ForeachResult>(p('results'));
  const faults = place<FailureToken>(p('faults'));

  const permit: Place<LanePermit>[] = [];
  const slot: Place<ForeachSlot>[] = [];
  const settled: Place<FlowToken>[] = [];
  const broke: Place<FailureToken>[] = [];
  for (let lane = 0; lane < lanes; lane++) {
    permit.push(place<LanePermit>(p(`lane${lane}.permit`)));
    slot.push(place<ForeachSlot>(p(`lane${lane}.slot`)));
    settled.push(place<FlowToken>(p(`lane${lane}.done`)));
    broke.push(place<FailureToken>(p(`lane${lane}.failed`)));
  }

  const transitions: Transition[] = [];

  /**
   * Opens a round: seeds the cursor **and** every permit in one firing.
   *
   * One firing matters. Permits deposited without a cursor would be a marking where `join` is
   * enabled with nothing collected; there is no such marking, because outputs of a firing land
   * together in the completion phase ([EXEC-001] step 1).
   *
   * Three declared branches, because there are three outcomes: items to run, an empty array
   * (Mastra yields `[]` and the body never runs), and an input that is not an array at all.
   * Under [IO-015] exactly one branch must claim precisely what the action wrote, so "empty"
   * cannot be encoded as "the seeding branch, minus the cursor".
   *
   * It seeds rather than the initial marking doing it, which is also what makes re-entry safe:
   * a `.foreach` inside a `.dowhile` gets a fresh allowance per round because `join`/`abort`
   * consumed the previous one. No reset arc is used to "clear stale permits" — that would put a
   * reset on the very places carrying the per-lane invariant.
   */
  transitions.push(
    Transition.builder(t('split'))
      .inputs(one(inPlace))
      .outputs(
        xor(
          and(outPlace(cursor), ...permit.map((q) => outPlace(q))),
          outPlace(next),
          outPlace(ctx.failed),
        ),
      )
      .action(async (tctx) => {
        const incoming = tctx.input(inPlace);
        // Decide, then emit ([EXEC-031]: inputs are already gone and nothing is restored).
        if (!Array.isArray(incoming.data)) {
          tctx.output(ctx.failed, {
            stepId: entry.id,
            error: new TypeError(
              `.foreach '${entry.id}' expected an array from the previous entry, got ` +
                `${incoming.data === null ? 'null' : typeof incoming.data}`,
            ),
          });
          return;
        }
        // Copied at the boundary: the cursor is iterated over many firings, and the caller's
        // array is not the net's to trust for that long.
        const items: readonly unknown[] = [...incoming.data];
        if (items.length === 0) {
          tctx.output(next, { data: [] });
          return;
        }
        tctx.output(cursor, { items, next: 0 });
        for (const q of permit) tctx.output(q, null);
      })
      .build(),
  );

  for (let lane = 0; lane < lanes; lane++) {
    const myPermit = permit[lane]!;
    const mySlot = slot[lane]!;
    const myDone = settled[lane]!;
    const myFailed = broke[lane]!;

    // The body, instantiated once per lane. Its failure goes to a *gadget-local* place, never
    // straight to the workflow terminal: a sibling lane that is mid-item still owns a slot and
    // a permit, and a failure that jumped the fence would leave both stranded with `join`
    // inhibited forever. Local failure lets every lane settle, then `abort` decides.
    const body = ctx.emitNested(entry.body, [...ctx.path, lane], myDone, myFailed);

    /**
     * Admits the next item into this lane.
     *
     * Competing with the other lanes' `start` for the one cursor token is the whole scheduler:
     * the decision "which lane runs this item" is the marking's, not an action's, and the
     * losing lanes simply stay disabled. No priority is involved, so nothing here rests on
     * scheduling policy ([EXEC-002] is free to order these any way it likes).
     *
     * The `xor` is "this was the last item" versus "there are more": the last one drops the
     * cursor, which is what eventually enables `join` (which is inhibited by it). The choice
     * reads the consumed token, not hidden state — and a value-blind analysis that takes the
     * short branch early merely dispatches fewer items, which strands nothing.
     */
    transitions.push(
      Transition.builder(t(`lane${lane}.start`))
        .inputs(one(cursor), one(myPermit))
        .outputs(
          xor(
            and(outPlace(body.inPlace), outPlace(mySlot), outPlace(cursor)),
            and(outPlace(body.inPlace), outPlace(mySlot)),
          ),
        )
        .action(async (tctx) => {
          const c = tctx.input(cursor);
          const index = c.next;
          tctx.output(body.inPlace, { data: c.items[index] });
          tctx.output(mySlot, { index });
          if (index + 1 < c.items.length) tctx.output(cursor, { items: c.items, next: index + 1 });
        })
        .build(),
    );

    /**
     * Pairs this lane's output with the index it started with, and returns the permit.
     *
     * Pairing is structural, not FIFO and not by correlation: `done.l` and `slot.l` can each
     * hold at most one token, because `start.l` needs the permit that only this transition (or
     * `rescue.l`) gives back. There is nothing to choose between, so there is nothing to get
     * wrong when items complete out of order.
     *
     * Result and permit are emitted by the *same* firing, so no marking exists in which the
     * lane looks finished while its result is still missing — which is what lets `join` treat
     * "every permit is back" as "every result is in".
     */
    transitions.push(
      Transition.builder(t(`lane${lane}.collect`))
        .inputs(one(myDone), one(mySlot))
        .outputs(and(outPlace(results), outPlace(myPermit)))
        .action(async (tctx) => {
          const produced = tctx.input(myDone);
          const s = tctx.input(mySlot);
          tctx.output(results, { index: s.index, value: produced.data });
          tctx.output(myPermit, null);
        })
        .build(),
    );

    /**
     * The failure half of `collect.l`, and the reason a failed item does not hang the round:
     * it consumes the slot and returns the permit exactly as success does, so the lane rejoins
     * the pool and the remaining items still run. The failure itself becomes a token in
     * `faults`, which is what `abort` later reads.
     */
    transitions.push(
      Transition.builder(t(`lane${lane}.rescue`))
        .inputs(one(myFailed), one(mySlot))
        .outputs(and(outPlace(faults), outPlace(myPermit)))
        .action(async (tctx) => {
          const failure = tctx.input(myFailed);
          tctx.output(faults, failure);
          tctx.output(myPermit, null);
        })
        .build(),
    );
  }

  /**
   * Closes a successful round.
   *
   * "Everything is done" is three structural facts, no bookkeeping: the cursor is gone (nothing
   * left to start), every permit is back (no lane is busy), and no fault was recorded. The
   * permits are *consumed* rather than read past an inhibitor, which both proves the lanes idle
   * and clears them — a permit left behind would be a token with no consumer, i.e. a stranded
   * marking and an unbounded place.
   *
   * `all(results)` is the one draining arc here. It is honest — the domain really is "take
   * every result" and the count is the input array's length, which no invariant can weigh —
   * and it is safe against the drain-too-early trap for a structural reason rather than a
   * timing one: every transition that could add to `results` needs a permit this firing holds.
   *
   * Order is data, so it rides in the token and is restored by sorting on the slot index here.
   * Firing order is deliberately given no meaning.
   */
  transitions.push(
    Transition.builder(t('join'))
      .inputs(all(results), ...permit.map((q) => one(q)))
      .inhibitor(cursor)
      .inhibitor(faults)
      .outputs(outPlace(next))
      .action(async (tctx) => {
        const collected = [...tctx.inputs(results)];
        collected.sort((a, b) => a.index - b.index);
        tctx.output(next, { data: collected.map((r) => r.value) });
      })
      .build(),
  );

  /**
   * Closes a failed round.
   *
   * Same quiescence preconditions as `join`, and structurally exclusive with it: `join` is
   * inhibited by `faults`, this one requires a fault. No priority, no guard — the marking
   * decides which of the two is enabled.
   *
   * The reset arc on `results` is the consumer for the successful siblings of a failed item.
   * Reset is safe *here* specifically: `results` is already drained by `join`, so no
   * conservation law has it in its support, and the per-lane invariant it must not disturb
   * lives in `permit`/`slot`, which this transition consumes one at a time.
   *
   * Mastra fails the run on the first failing item; the first fault collected is reported,
   * which is the earliest to have settled.
   */
  transitions.push(
    Transition.builder(t('abort'))
      .inputs(all(faults), ...permit.map((q) => one(q)))
      .inhibitor(cursor)
      .reset(results)
      .outputs(outPlace(ctx.failed))
      .action(async (tctx) => {
        const failures = tctx.inputs(faults);
        tctx.output(ctx.failed, failures[0]!);
      })
      .build(),
  );

  // The children's transitions are collected by the builder as `emitNested` returns them;
  // repeating them here would register each one twice.
  return { inPlace, transitions };
};

/**
 * How many lanes this entry compiles to.
 *
 * Mastra's default is 1, and its `ForeachConcurrencyResolver` (a per-run number) cannot reach
 * here at all: the net is built once per workflow shape and cached by structural hash, so a
 * per-run concurrency would be a per-run net. `EntryDescription` carries a static number, which
 * is the only form a permit place can represent.
 */
function laneCount(entry: Extract<EntryDescription, { kind: 'foreach' }>): number {
  const c = entry.concurrency;
  if (!Number.isInteger(c) || c < 1) {
    throw new Error(
      `.foreach '${entry.id}' has concurrency ${String(c)}; it must be an integer >= 1. ` +
        'The limit is a permit place with one token per lane, so it cannot be fractional, ' +
        'zero (nothing would ever run) or resolved per run.',
    );
  }
  if (c > MAX_LANES) {
    throw new Error(
      `.foreach '${entry.id}' has concurrency ${c}, above the ${MAX_LANES}-lane limit. ` +
        'A lane is a full copy of the body, so the net grows linearly with it. Lower the ' +
        'concurrency, or batch the items so each body call does more work.',
    );
  }
  return c;
}

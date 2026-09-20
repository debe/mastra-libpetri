import {
  Transition,
  and,
  exactly,
  one,
  outPlace,
  place,
  type Place,
} from 'libpetri';
import type { EntryDescription, FailureToken, FlowToken } from '../types.js';
import type { Gadget } from './types.js';

/**
 * What one arm's settlement looks like to the join.
 *
 * The arm index is stamped by *which* collect transition fired, not carried in from the arm's
 * own output, so arm identity is topology rather than a value the join has to trust. A failed
 * arrival carries nothing: it exists only so the arm still counts toward the join's `exactly(n)`.
 */
type ArmArrival =
  | { readonly status: 'ok'; readonly index: number; readonly data: unknown }
  | { readonly status: 'failed' };

/**
 * `.parallel([...])` — every arm runs, every arm joins.
 *
 * ```text
 *   in --(fork)--> armIn_0 ... armIn_{n-1}        one branch, and(...): every arm always runs
 *
 *   armIn_i -> [arm i] -> armDone_i --(collect-i)--> arrived      {status: ok, index: i}
 *   [any arm's failure] -> armErr --(collect-err)--> arrived      {status: failed}
 *                                              and--> errSeen     the failure token itself
 *
 *   exactly(n) arrived, inhibited by errSeen        --(join-ok)---> next
 *   exactly(n) arrived, one(errSeen), reset(errSeen) --(join-fail)-> ctx.failed
 * ```
 *
 * **Why every arm deposits into one shared `arrived` place.** The naive fan-in — a join that
 * consumes one token from each arm's own done place — deadlocks the moment an arm fails: that
 * arm never produces, so the join is never enabled, and the siblings that *did* finish sit in
 * their done places with no enabled consumer for the life of the net. That is an unbounded place
 * in the model and a hang in production. Here the failure path deposits into `arrived` too, so
 * the join always sees exactly `n` settlements regardless of how many of them failed, and every
 * token this gadget creates has a consumer that becomes enabled in every reachable state.
 *
 * **Why `errSeen` exists at all.** `armErr` is consumed by `collectErr`, so by join time the
 * evidence that something failed would be gone. `errSeen` is that evidence, held in the marking
 * where the inhibitor arc can see it. The alternative — letting one join transition look at the
 * arrivals and decide — puts the ok/fail choice inside an action, where no analysis can see it
 * ([IO-006] removed input guards precisely so that decisions cannot hide there).
 *
 * **Why the choice is race-free.** `collectErr` writes `arrived` and `errSeen` in a single
 * firing, and a firing's complete output set is deposited in one step of the loop, strictly
 * before enablement is re-evaluated ([EXEC-001] steps 1 and 3). So the arrival that completes
 * the count can never be observed without the error marker that accompanies it: `errSeen` is
 * deposited no later than the `n`-th arrival. There is no window in which `join-ok` sees a full
 * count and an empty `errSeen`.
 *
 * **Why no priority.** `join-ok` is inhibited by `errSeen` and `join-fail` requires it, so the
 * two are structurally exclusive and are never simultaneously enabled. Ordering them by priority
 * would work as well and prove less: nothing here rests on [EXEC-002].
 *
 * **Concurrency limit.** Mastra's `.parallel()` fan-out is unbounded (`Promise.all`), and the
 * `parallel` variant of `EntryDescription` carries no limit to compile, so this gadget emits no
 * permit place (`docs/divergences.md` row 5 is still *proposed*, and `foreach` is where a
 * `concurrency` field actually exists today). Adding one later is a permit place seeded by an
 * upstream transition and consumed by each arm's start — but note it cannot be seeded by `fork`
 * writing `k` tokens into one place: a branch names places, not counts, and every analysis
 * models one token per named place ([IO-016]), so the multiplicity has to be topology.
 */
export const parallelGadget: Gadget = (entry, next, ctx) => {
  if (entry.kind !== 'parallel') throw new Error(`parallelGadget received a '${entry.kind}' entry`);

  const arms: readonly EntryDescription[] = entry.arms;
  const armCount = arms.length;
  if (armCount === 0) {
    // An `and()` with no children is rejected by libpetri, and `exactly(0, ...)` by `In`. Both
    // are downstream symptoms of the real defect: a fork with nothing to produce into leaves the
    // gadget's input token with no consumer, which is a hang, not an empty success.
    throw new Error(`parallel entry '${entry.id}' has no arms; nothing would consume its input token`);
  }

  const inPlace = place<FlowToken>(ctx.names.entryIn(ctx.path, entry.id));
  /** Every arm's settlement, success or failure. The join counts this place and nothing else. */
  const arrived = place<ArmArrival>(ctx.names.entryPlace(ctx.path, entry.id, 'arrived'));
  /**
   * Gadget-local failure sink for the arms. Passing this to `emitNested` instead of
   * `ctx.failed` is what stops a failing arm from ending the run while its siblings are still
   * in flight: their tokens would then have no consumer and the run would read as stranded.
   */
  const armErr = place<FailureToken>(ctx.names.entryPlace(ctx.path, entry.id, 'arm-err'));
  /** The marking's memory that an arm failed, kept alive past `armErr`'s consumption. */
  const errSeen = place<FailureToken>(ctx.names.entryPlace(ctx.path, entry.id, 'err-seen'));

  const armIns: Place<FlowToken>[] = [];
  const collects: Transition[] = [];

  for (let i = 0; i < armCount; i++) {
    const armDone = place<FlowToken>(ctx.names.entryPlace(ctx.path, entry.id, `arm-${i}-done`));
    // The child path extends ours, so the vocabulary's uniqueness assertion covers nesting:
    // two arms that are the same step id land at different paths and so at different names.
    const arm = ctx.emitNested(arms[i]!, [...ctx.path, i], armDone, armErr);
    armIns.push(arm.inPlace);

    // Stamping the index here rather than inside the arm is what keeps arm identity structural:
    // the arm produces an ordinary `FlowToken` and does not know it is an arm.
    collects.push(
      Transition.builder(ctx.names.entryTransition(ctx.path, entry.id, `collect-${i}`))
        .inputs(one(armDone))
        .outputs(outPlace(arrived))
        .action(async (tctx) => {
          const incoming = tctx.input(armDone);
          tctx.output(arrived, { status: 'ok', index: i, data: incoming.data });
        })
        .build(),
    );
  }

  const fork = Transition.builder(ctx.names.entryTransition(ctx.path, entry.id, 'fork'))
    .inputs(one(inPlace))
    // One branch, claiming exactly the set the action writes ([IO-015]): all arms always run,
    // so there is nothing to select. Every arm receives the same input, as Mastra's does.
    .outputs(and(...armIns.map(outPlace)))
    .action(async (tctx) => {
      const incoming = tctx.input(inPlace);
      const payload: FlowToken = { data: incoming.data };
      for (const armIn of armIns) tctx.output(armIn, payload);
    })
    .build();

  const collectErr = Transition.builder(ctx.names.entryTransition(ctx.path, entry.id, 'collect-err'))
    .inputs(one(armErr))
    // Both writes are one branch, and that is the whole safety argument: the arrival that keeps
    // the join's count honest and the marker that decides its outcome land together or not at all.
    .outputs(and(outPlace(arrived), outPlace(errSeen)))
    .action(async (tctx) => {
      const failure = tctx.input(armErr);
      tctx.output(arrived, { status: 'failed' });
      tctx.output(errSeen, failure);
    })
    .build();

  const joinOk = Transition.builder(ctx.names.entryTransition(ctx.path, entry.id, 'join-ok'))
    .inputs(exactly(armCount, arrived))
    .inhibitor(errSeen)
    .outputs(outPlace(next))
    .action(async (tctx) => {
      // Decide, then emit ([EXEC-031]: inputs are already consumed and are not restored). The
      // aggregate is assembled in full before a single token is written.
      const byIndex = new Array<unknown>(armCount);
      for (const arrival of tctx.inputs(arrived)) {
        // A failed arrival cannot reach here — `errSeen` would be marked and this transition
        // inhibited — and it carries no output to contribute in any case.
        if (arrival.status === 'ok') byIndex[arrival.index] = arrival.data;
      }
      // Keyed by arm id and assembled in arm order, so the result is independent of the order
      // the arms actually finished in. Mastra keys its `.parallel()` result the same way, which
      // also means two arms sharing an id collapse there exactly as they collapse here; the
      // net's own identity for an arm remains its index.
      //
      // Assembled through `Object.fromEntries`, never by assigning `aggregate[id] = ...`. Arm
      // ids are arbitrary user strings, and `obj['__proto__'] = value` is a *setter* call: it
      // replaces the aggregate's prototype instead of creating a key, so that arm's output
      // vanishes from the result and every downstream step sees the arm's fields as inherited
      // properties that `Object.keys` does not list. `fromEntries` defines own properties
      // (CreateDataPropertyOrThrow), so `__proto__` becomes an ordinary key like any other.
      // This is data loss, not a hang — no token strands either way — but the join's contract
      // is that every arm's output reaches `next`, and assignment quietly breaks it.
      const pairs = new Array<readonly [string, unknown]>(armCount);
      for (let i = 0; i < armCount; i++) pairs[i] = [arms[i]!.id, byIndex[i]] as const;
      tctx.output(next, { data: Object.fromEntries(pairs) });
    })
    .build();

  const joinFail = Transition.builder(ctx.names.entryTransition(ctx.path, entry.id, 'join-fail'))
    // `one` takes the FIFO head ([EXEC-010]), which is the first arm to have failed — the
    // outcome `Promise.all` would have rejected with. The reset then drains the rest: with k
    // failures there are k tokens in `errSeen`, and this single firing must leave none, or the
    // survivors sit in a place whose only consumer needs a full `arrived` count that will never
    // come again. Inputs are consumed before resets drain within a firing ([EXEC-013]), so the
    // head is safely in hand by the time the place is emptied.
    .inputs(exactly(armCount, arrived), one(errSeen))
    .reset(errSeen)
    .outputs(outPlace(ctx.failed))
    .action(async (tctx) => {
      tctx.output(ctx.failed, tctx.input(errSeen));
    })
    .build();

  // The arms' own transitions are deliberately not returned: `emitNested` already recorded them
  // against their own entry, and repeating them here would re-key the `NetMap` to this entry.
  return { inPlace, transitions: [fork, ...collects, collectErr, joinOk, joinFail] };
};

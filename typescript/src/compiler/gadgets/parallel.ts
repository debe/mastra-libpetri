import {
  Transition,
  all,
  and,
  exactly,
  one,
  outPlace,
  place,
  type Place,
} from 'libpetri';
import type { EntryPath } from '../names.js';
import { scopeOf } from '../scope.js';
import type {
  BailToken,
  CanceledToken,
  Exits,
  FailureToken,
  FlowToken,
  PauseToken,
  StepRecord,
  SuspendToken,
} from '../types.js';
import { admissionClaims, admissionPools, admit, bindingLimit, blockAdmission, collect } from './admission.js';
import { blockClaims, blockReentry, suspendedBlock, type ArmArrival } from './reentry.js';
import type { Gadget } from './types.js';
import { firstKGadget } from '../blueprints/first-k.js';

/**
 * `.parallel([...])` — every arm runs, every arm settles, then one join decides the block.
 *
 * ```text
 *   in --(fork, inhibitor cancel)--> armIn_0 ... armIn_{n-1}   and(...): every arm always runs
 *   in --(cancel, read cancel)-----> exits.canceled             the block never started
 *
 *   armIn_i -> [step i] -> armDone_i --(collect-i)-----> arrived {ok, index: i, data}
 *   [any arm]  failed    -> armErr   --(collect-err)---> arrived {failed}    + errSeen  (one firing)
 *   [any arm]  suspended -> armSusp  --(collect-susp)--> arrived {suspended} + suspSeen (one firing)
 *   [any arm]  bailed    -> armBail  --(collect-bail)--> arrived {settled}              (swallowed)
 *   [any arm]  paused    -> armPause --(collect-pause)-> arrived {settled}              (swallowed)
 *
 *   exactly(n) arrived, all(errSeen), reset(suspSeen)          --(join-fail)-> exits.failed
 *   exactly(n) arrived, all(suspSeen), inhibitor(errSeen)      --(join-susp)-> exits.suspended {lowest, pending: rest}
 *   exactly(n) arrived, inhibitor(errSeen), inhibitor(suspSeen) --(join-ok)---> next
 *
 *   resume-j --(re-enter-j, inhibitor cancel)--> armIn_j {resumed} + replay_i for every i != j
 *   resume-j --(re-enter-j.cancel, read cancel)-> exits.canceled    the resume never started
 *   replay_i --(replay-i)--> arrived (+ errSeen | suspSeen), as arm i's collect did  (./reentry.ts)
 * ```
 *
 * **What Mastra does, and so what this reproduces** (`handlers/control-flow.ts:220-313`). The
 * arms run under `Promise.all`, but a step's failure never *rejects* — `executeStepWithRetry`
 * returns it as a value (`default.ts:459-511`) — so every sibling is awaited to completion and
 * nothing is abandoned. Only then is the block decided, with a fixed precedence: any failed arm
 * makes it `failed`, else any suspended arm makes it `suspended`, else it succeeds (`canceled`
 * sits between the last two; see below for why it is not a rung here). A **bailed** or
 * **paused** arm is not tested for at all: it falls through to the success branch and is merely
 * left out of the block's output (`:286-295`). So a bail inside a parallel does not end the run,
 * and neither does a nested workflow's pause.
 *
 * **Why every settlement deposits into one shared `arrived` place.** The naive fan-in — a join
 * consuming one token from each arm's own done place — deadlocks the moment an arm does anything
 * but succeed: that arm never produces, the join is never enabled, and the siblings that did
 * finish sit in their done places for the life of the net. Here all five outcomes deposit into
 * `arrived`, so the join always sees exactly `n` settlements whatever they were, and every token
 * this gadget creates has a consumer that becomes enabled in every reachable state. It is also
 * what makes the join wait for every sibling, exactly as Mastra's `Promise.all` does: a failure
 * is not reported until the slowest arm has settled.
 *
 * **Why `errSeen` and `suspSeen` exist.** `armErr` and `armSusp` are drained by their collects,
 * so by join time the evidence would be gone. The two markers hold it in the marking, where an
 * inhibitor arc can read it. The alternative — one join transition looking at the arrivals and
 * choosing — puts the choice inside an action where no analysis can see it ([IO-006] removed
 * input guards precisely so that decisions cannot hide there).
 *
 * **Why the choice is race-free.** `collect-err` writes `arrived` and `errSeen` in a single
 * firing, and a firing's complete output set is deposited in one step, strictly before
 * enablement is re-evaluated ([EXEC-001]). So the arrival that completes the count can never be
 * observed without the marker that accompanies it, and there is no window in which `join-ok`
 * sees a full count and an empty `errSeen`. `collect-susp` is the same argument for `suspSeen`.
 *
 * **Why no priorities.** The three joins are structurally exclusive: `join-fail` needs `errSeen`,
 * which inhibits the other two; `join-susp` needs `suspSeen`, which inhibits `join-ok`. At most
 * one is ever enabled, so nothing here rests on [EXEC-002] ordering. `join-fail` resets `suspSeen`
 * because failure outranks suspension and the losing markers must not outlive the block.
 *
 * **Which failure is reported.** The lowest arm index, not the first in time: Mastra takes
 * `results.find(r => r.status === 'failed')` over an array index-aligned with the arms (`:267`),
 * and `Promise.all` preserves index order whatever order the arms settle in. `all(errSeen)` hands
 * the action every failure so it can choose, ranked by the arm index in each token's `path`; a
 * `one` would take the FIFO head, which is the first in *time* and is the wrong answer whenever
 * a higher-indexed arm fails sooner. The token
 * is forwarded unchanged, `tripwire` included, so the run ends `tripwire` exactly when Mastra's
 * `fmtReturnValue` would (`control-flow.ts:271-276`, `default.ts:611-629`). Suspension is
 * chosen the same way (`:269`).
 *
 * **The value handed on.** Two different values, because Mastra has two
 * (`GadgetContext.nextIsResult`): as the workflow's last entry it is the block's own output — only the arms that *succeeded in
 * this block*, keyed by id in arm order — and otherwise it is what `getStepOutput` hands the next
 * entry: a record over *every declared arm*, read from the run's step results
 * (`default.ts:1141-1149`), so a bailed arm carries its bail payload and a paused arm is present
 * as `undefined`.
 *
 * **Every arm receives the same input**, as Mastra's does (`prevOutput` is computed once, `:187`).
 *
 * **Cancellation gates the block's start, and nothing inside it.** Mastra checks its signal
 * before each top-level entry (`default.ts:815`) and never inside a step, so once the block has
 * started every arm runs to its own settlement. Given `ctx.cancel`, the block's first transition
 * (`fork`, or `empty` for an empty block) carries an inhibitor arc on it, and a sweep reads it and
 * moves a waiting input token to `exits.canceled`. The arms are emitted **without** a cancel, and
 * their `canceled` exit is the enclosing one — never written, because an ungated arm has no sweep.
 * A signal that lands mid-block is honoured *after* it: the block's outcome goes to the enclosing
 * exit, which at the top level is the settle stage that re-stamps it `canceled`
 * (`handlers/entry.ts:815-817`), or into the next entry's input, whose sweep is the same check.
 *
 * Mastra's own ladder has a `canceled` rung between `suspended` and `success`
 * (`handlers/control-flow.ts:278-283`). It is **not** built here: `.parallel()` is always a
 * top-level entry (its arms are `SingleStepEntry`, so it cannot sit in a loop or a foreach), and
 * at the top level `entry.ts:815-817` re-stamps *every* result `canceled` whenever the signal has
 * fired — so a block that failed, suspended, was canceled or succeeded under an abort ends the run
 * the same way, and the step records are written by the arms either way. A rung would add a
 * transition and an arc with no outcome a caller can tell apart.
 *
 * **Resume** ([ADR 0007]). Each arm is a resume site, `resume-j`, gated and swept like the block's
 * own start (`./reentry.ts`). Re-entering arm *j* runs only that arm, on its stored input, and
 * replays every sibling's stored outcome as the arrival its collect produced — Mastra re-runs only
 * the arm at the resume path and rebuilds the block from the siblings' records
 * (`handlers/entry.ts:350-392`). The join is the same three transitions, so a resumed block is
 * decided by the same precedence as a fresh one. A losing suspension is carried on the reported
 * one as `pending`, in arm order, rather than dropped, so every suspended arm stays resumable.
 *
 * **Concurrency is unbounded**, as `Promise.all` is, unless the block carries `concurrency = c`
 * below its arm count ([ADR 0011], `./admission.ts`). Then `fork` hands the input to a cursor
 * instead of to every arm, and arms are admitted in arm order from a pool of `c` slots seeded in the
 * initial marking — never `c` tokens written by `fork`: a branch names places, not counts ([IO-016]).
 *
 * ```text
 *   in --(fork, inhibitor cancel)--> q_0 {data}
 *   q_j + slot --(admit-j)--> armIn_j + active + q_{j+1} {data}      (no q_n)
 *   every collect: ... + active -> ... + slot
 * ```
 *
 * Every arm still runs, and none is gated by cancel: an arm admitted after an abort starts with its
 * signal aborted and writes its record, as an arm of a started block does. `c ≥ arms` compiles
 * exactly the unlimited net.
 */
export const parallelGadget: Gadget = (entry, next, ctx) => {
  if (entry.kind !== 'parallel') throw new Error(`parallelGadget received a '${entry.kind}' entry`);
  // A counted decision ([ADR 0014]) is its own gadget; without one this is exactly today's parallel.
  if (entry.decision !== undefined) return firstKGadget(entry, next, ctx);

  const { names, path, viewPath, cancel } = ctx;
  const arms = entry.arms;
  const armCount = arms.length;
  // The block's own limit, where it binds ([ADR 0011]); `undefined` compiles today's net.
  const admission = blockAdmission(names, path, entry.id, bindingLimit(entry.id, entry.concurrency, armCount));
  const inPlace = place<FlowToken>(names.entryIn(path, entry.id));
  /** Mastra's check before the entry: the input never reaches `fork` once the signal is marked. */
  const cancelSweep: Transition[] =
    cancel === undefined
      ? []
      : [sweep(names.entryTransition(path, entry.id, 'cancel'), inPlace, cancel, ctx.exits.canceled, entry.id, viewPath)];

  if (armCount === 0) {
    // Mastra reduces over an empty results array and continues with `{}` (`control-flow.ts:220,
    // 286-295`). `and()` with no children and `exactly(0, ...)` are both illegal in libpetri, so
    // the empty block is one pass-through. The next entry's record over zero declared arms is
    // `{}` as well, so the two value shapes coincide and `nextIsResult` does not matter here.
    const pass = Transition.builder(names.entryTransition(path, entry.id, 'empty'))
      .inputs(one(inPlace))
      .outputs(outPlace(next))
      .action(async (tctx) => {
        tctx.output(next, { data: {} });
      });
    if (cancel !== undefined) pass.inhibitor(cancel);
    return { inPlace, transitions: [pass.build(), ...cancelSweep] };
  }

  /** Every arm's settlement, whatever it was. The joins count this place and nothing else. */
  const arrived = place<ArmArrival>(names.entryPlace(path, entry.id, 'arrived'));
  /**
   * The arms' exits. Passing these to `emitNested` instead of `ctx.exits` is what stops one arm
   * from deciding the run while its siblings are still in flight — their tokens would then have
   * no consumer and the run would read as stranded. Shared by every arm: the arm a failure or
   * suspension came from is recovered from the token's `path`, where the join needs it.
   *
   * `canceled` is the enclosing exit and is never written: the arms are emitted without a cancel
   * signal, so none of them has a sweep ([ADR 0003]; Mastra never checks inside a started block).
   */
  const armExits: Exits = {
    failed: place<FailureToken>(names.entryPlace(path, entry.id, 'arm-err')),
    bailed: place<BailToken>(names.entryPlace(path, entry.id, 'arm-bail')),
    suspended: place<SuspendToken>(names.entryPlace(path, entry.id, 'arm-susp')),
    paused: place<PauseToken>(names.entryPlace(path, entry.id, 'arm-pause')),
    canceled: ctx.exits.canceled,
  };
  /** The marking's memory that an arm failed, kept past `arm-err`'s consumption. */
  const errSeen = place<FailureToken>(names.entryPlace(path, entry.id, 'err-seen'));
  /** The same for a suspended arm. */
  const suspSeen = place<SuspendToken>(names.entryPlace(path, entry.id, 'susp-seen'));

  const armIns: Place<FlowToken>[] = [];
  const collects: Transition[] = [];

  for (let i = 0; i < armCount; i++) {
    const armDone = place<FlowToken>(names.entryPlace(path, entry.id, `arm-${i}-done`));
    // The child path extends ours, so two arms that are the same step id land at different
    // paths and so at different names; the vocabulary's uniqueness assertion covers it. The view
    // path is Mastra's `executionPath: [...executionContext.executionPath, i]`
    // (`handlers/control-flow.ts:244`), and no `cancel`: a started block runs every arm.
    const arm = ctx.emitNested(arms[i]!, [...path, i], armDone, armExits, { viewPath: [...viewPath, i] });
    armIns.push(arm.inPlace);

    collects.push(
      collect(admission, names.entryTransition(path, entry.id, `collect-${i}`), armDone, [arrived], (tctx, done) => {
        tctx.output(arrived, { status: 'ok', index: i, data: done.data });
      }),
    );
  }

  // Under a limit: the cursor `q_j`, carrying the block's input, and one `admit-j` per arm. The arm
  // input is `{ data }` — the same token the unlimited fork writes.
  const cursors: Place<FlowToken>[] =
    admission === undefined ? [] : arms.map((_, j) => place<FlowToken>(names.entryPlace(path, entry.id, `q-${j}`)));
  const admits: Transition[] =
    admission === undefined
      ? []
      : arms.map((_, j) =>
          admit(
            admission,
            names.entryTransition(path, entry.id, `admit-${j}`),
            cursors[j]!,
            armIns[j]!,
            j + 1 < armCount ? { place: cursors[j + 1]!, pass: ({ data }) => ({ data }) } : undefined,
          ),
        );

  const forkBuilder = Transition.builder(names.entryTransition(path, entry.id, 'fork'))
    .inputs(one(inPlace))
    // One branch, claiming exactly the set the action writes ([IO-015]): every arm always runs,
    // so there is nothing to select. Every arm receives the same input, as Mastra's does. Under a
    // limit the input goes to the cursor, and each `admit-j` hands it on.
    .outputs(admission === undefined ? and(...armIns.map(outPlace)) : outPlace(cursors[0]!))
    .action(async (tctx) => {
      const { data } = tctx.input(inPlace);
      if (admission !== undefined) {
        tctx.output(cursors[0]!, { data });
        return;
      }
      for (const armIn of armIns) tctx.output(armIn, { data });
    });
  // The only gate in the block: whether it starts. The sweep beside it takes the input instead.
  if (cancel !== undefined) forkBuilder.inhibitor(cancel);
  const fork = forkBuilder.build();

  // Both writes are one branch, and that is the whole race-freedom argument: the arrival that
  // keeps the count honest and the marker that decides the outcome land together or not at all.
  const collectErr = collect(admission, names.entryTransition(path, entry.id, 'collect-err'), armExits.failed, [arrived, errSeen], (tctx, failure) => {
    tctx.output(arrived, { status: 'failed' });
    tctx.output(errSeen, failure);
  });

  const collectSusp = collect(admission, names.entryTransition(path, entry.id, 'collect-susp'), armExits.suspended, [arrived, suspSeen], (tctx, suspension) => {
    tctx.output(arrived, { status: 'suspended' });
    tctx.output(suspSeen, suspension);
  });

  // A bail or a pause is swallowed: the arm counts toward the join and contributes nothing else.
  // Its outcome is still in the run's step results, which is where the next entry reads it.
  const collectBail = collect(admission, names.entryTransition(path, entry.id, 'collect-bail'), armExits.bailed, [arrived], (tctx) => {
    tctx.output(arrived, { status: 'settled' });
  });

  const collectPause = collect(admission, names.entryTransition(path, entry.id, 'collect-pause'), armExits.paused, [arrived], (tctx) => {
    tctx.output(arrived, { status: 'settled' });
  });

  /**
   * The arm an outcome came from: the element of its view path just below the block's own, which
   * `emitNested` set to the arm index. Exact even when two arms share a step id — ranking by id
   * collapsed both onto the first index and let the later-indexed failure win on time order
   * (`docs/divergences.md` row 33).
   */
  const armIndex = (o: { readonly path: EntryPath }): number => o.path[viewPath.length] ?? armCount;

  const joinFail = Transition.builder(names.entryTransition(path, entry.id, 'join-fail'))
    // `all(errSeen)` takes every failure so the action can choose among them; the reset drops
    // any suspension markers, which lose to a failure. Both places are empty after this firing.
    .inputs(exactly(armCount, arrived), all(errSeen))
    .reset(suspSeen)
    .outputs(outPlace(ctx.exits.failed))
    .action(async (tctx) => {
      tctx.output(ctx.exits.failed, lowest(tctx.inputs(errSeen), armIndex));
    })
    .build();

  const joinSusp = Transition.builder(names.entryTransition(path, entry.id, 'join-susp'))
    .inputs(exactly(armCount, arrived), all(suspSeen))
    .inhibitor(errSeen)
    .outputs(outPlace(ctx.exits.suspended))
    .action(async (tctx) => {
      // The lowest arm is reported and every other suspension rides along as `pending`, in arm
      // order, so the result and the snapshot name every suspended arm ([ADR 0007], row 34).
      tctx.output(ctx.exits.suspended, suspendedBlock(tctx.inputs(suspSeen), armIndex));
    })
    .build();

  const joinOk = Transition.builder(names.entryTransition(path, entry.id, 'join-ok'))
    .inputs(exactly(armCount, arrived))
    .inhibitors(errSeen, suspSeen)
    .outputs(outPlace(next))
    .action(async (tctx) => {
      // Decide, then emit ([EXEC-031]: inputs are already consumed and are not restored). The
      // record is assembled in full before a single token is written.
      //
      // Every record here is built with `Object.fromEntries`, never `record[id] = value`. Arm
      // ids are arbitrary user strings, and `obj['__proto__'] = value` is a *setter* call that
      // replaces the record's prototype instead of creating a key — the arm's value vanishes
      // from `Object.keys` and its fields leak onto every downstream read as inherited
      // properties. `fromEntries` defines own properties, so `__proto__` is a key like any other.
      let data: Record<string, unknown>;
      if (ctx.nextIsResult) {
        // The block's own output (`control-flow.ts:286-295`): only the arms that succeeded in
        // this block, in arm order, so a later arm sharing an id overwrites an earlier one as
        // Mastra's `reduce` does. Bailed and paused arms arrived as `settled` and are absent.
        const byIndex = new Map<number, unknown>();
        for (const arrival of tctx.inputs(arrived)) {
          if (arrival.status === 'ok') byIndex.set(arrival.index, arrival.data);
        }
        const pairs: [string, unknown][] = [];
        for (let i = 0; i < armCount; i++) {
          if (byIndex.has(i)) pairs.push([arms[i]!.id, byIndex.get(i)]);
        }
        data = Object.fromEntries(pairs);
      } else {
        // What the next entry receives (`default.ts:1141-1149`): every declared arm, read from
        // the run's step results rather than from the arrivals. So a bailed arm carries its bail
        // payload, a paused arm is present as `undefined`, and two arms sharing an id show the
        // outcome recorded *last* — the step results keep the latest, in time.
        const scope = scopeOf(tctx);
        data = Object.fromEntries(arms.map((arm) => [arm.id, outputOf(scope.getStepResult(arm.id))]));
      }
      tctx.output(next, { data });
    })
    .build();

  // Resuming at an arm ([ADR 0007]): a gated `resume-j` site per arm whose re-entry replays every
  // sibling's stored outcome into `arrived` and the markers, so the join above decides unchanged.
  const reentry = blockReentry({
    names,
    path,
    viewPath,
    blockId: entry.id,
    block: 'parallel',
    arms,
    armIns,
    places: { arrived, errSeen, suspSeen },
    cancel,
    canceled: ctx.exits.canceled,
    failed: ctx.exits.failed,
    admission,
  });

  // The arms' own transitions are deliberately not returned: `emitNested` already recorded them
  // against their own entry, and repeating them here would re-key the `NetMap` to this entry.
  return {
    inPlace,
    resumeSites: reentry.resumeSites,
    claims: [
      ...blockClaims([arrived, armExits.failed, armExits.bailed, armExits.suspended, armExits.paused, errSeen, suspSeen], armCount),
      ...admissionClaims(admission),
    ],
    // Read after every collect, admit and re-admit is emitted: the pool's takers and givers.
    pools: admissionPools(admission),
    transitions: [
      fork,
      ...admits,
      ...cancelSweep,
      ...collects,
      collectErr,
      collectSusp,
      collectBail,
      collectPause,
      joinFail,
      joinSusp,
      joinOk,
      ...reentry.transitions,
    ],
  };
};

/**
 * The cancellation sweep, as the leaf's: reads the signal, consumes the input waiting to start
 * the block, and reports it. It records nothing — Mastra writes no step result for an entry it
 * skipped, and a skipped block's arms never ran.
 */
function sweep(
  name: string,
  from: Place<FlowToken>,
  cancel: Place<null>,
  canceled: Place<CanceledToken>,
  stepId: string,
  path: EntryPath,
): Transition {
  return Transition.builder(name)
    .inputs(one(from))
    .read(cancel)
    .outputs(outPlace(canceled))
    .action(async (tctx) => {
      tctx.input(from);
      tctx.output(canceled, { origin: { stepId, path }, started: false });
    })
    .build();
}

/**
 * Mastra's `stepResults[id]?.output` (`default.ts:1141-1149`), which reads the field whatever the
 * status. A success and a bail carry an `output`; a failed, suspended or paused step result is
 * written over `omitPriorCompletionFields(...)` (`handlers/step.ts:566-569`, `utils.ts:759-777`),
 * which strips any earlier `output`, and a suspension's own value lives in `suspendOutput`, not
 * `output`. A `canceled` record — a loop's or foreach's, under its body's id, with a foreach's
 * partial results as `output` or nothing — is read the same way, as Mastra's would be. It cannot
 * actually reach `join-ok`: every arm writes its own record before it arrives, whatever it did,
 * replacing an earlier or carried-in one. The case is handled for the type, not for a run.
 */
function outputOf(record: StepRecord | undefined): unknown {
  switch (record?.status) {
    case 'success':
    case 'bailed':
    case 'canceled':
      return record.output;
    default:
      return undefined;
  }
}

/** The token with the lowest arm index; on a tie, the earliest in the input order. */
function lowest<T>(tokens: readonly T[], indexOf: (token: T) => number): T {
  let best = tokens[0]!;
  let bestIndex = indexOf(best);
  for (let k = 1; k < tokens.length; k++) {
    const index = indexOf(tokens[k]!);
    if (index < bestIndex) {
      best = tokens[k]!;
      bestIndex = index;
    }
  }
  return best;
}

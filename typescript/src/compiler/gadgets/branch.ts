import {
  Transition,
  andPlaces,
  exactly,
  one,
  outPlace,
  place,
  xor,
  type Place,
} from 'libpetri';
import type { FailureToken, FlowToken } from '../types.js';
import type { Gadget, GadgetResult } from './types.js';

/**
 * What `decide` hands each arm's gate: the flow payload plus the one selection it made.
 *
 * A plain `readonly number[]` rather than a `Set`, because a marking snapshot is JSON
 * ([CORE-073] restore, M4's `MarkingCodec`) and a `Set` would not survive the round trip.
 * The verifier never reads it — the gate declares *both* of its outcomes, so the analysis
 * explores skip and run regardless of what the value says.
 */
export interface GateToken {
  readonly data: unknown;
  /** Indices of the arms whose condition was truthy. Possibly empty — that is legal. */
  readonly selected: readonly number[];
}

/**
 * One arm's "I have settled" marker. Every arm deposits exactly one, whichever way it went.
 *
 * `joined` is what separates *contributed a result* (the arm ran and succeeded) from *did not*
 * (skipped, or failed). It is read only by `join.ok`, which cannot fire while the error place
 * holds a token, so a failed arm's marker never reaches a reader.
 */
export interface ArrivalToken {
  /** Position in `entry.arms`, so the joined record is built in a deterministic order. */
  readonly index: number;
  /** The arm entry's id — Mastra keys a `.branch` result by step id. */
  readonly id: string;
  readonly joined: boolean;
  readonly data: unknown;
}

/**
 * `.branch([[cond, step], ...])` — **inclusive**, not if/else.
 *
 * Mastra evaluates every condition concurrently and runs *every* arm whose condition is truthy,
 * then joins all of them (`handlers/control-flow.ts:396,540`). Zero arms passing is a legal
 * outcome that still has to reach the next entry. Compiling this as an exclusive choice is a
 * correctness bug, not a simplification.
 *
 * ```
 *                         ┌── gate.0 ──xor──> arm.0.in ─(arm 0)─> arm.0.out ──settle──┐
 *   in ──decide──and──────┤                     └────────────skip───────────────┐     │
 *        │                │                                                     ├──> arrived
 *        │                └── gate.i ──xor──> arm.i.in ─(arm i)─> arm.i.out ──settle──┘
 *        │                                              └> arm.i.err ─settle.fail─> arrived + err
 *        └──xor──> wf.failed                             (the decision itself threw)
 *
 *   exactly(n, arrived), inhibitor(err)          ──join.ok───>  next
 *   exactly(n, arrived), one(err), reset(err)    ──join.fail──> failed      (priority 1)
 * ```
 *
 * **One decision, not n.** `selectBranches` is called once, inside `decide`, and the answer
 * travels to every gate in a token. Calling it per arm would be n independent decisions that
 * could disagree with each other — the inclusive semantics would still hold arm by arm, but the
 * branch as a whole would no longer correspond to a single evaluation of the conditions.
 *
 * **Why n independent `Xor`s is right here, though the design skill warns against `And` of
 * `Xor`.** That warning is about structural branches the runtime cannot produce: two
 * independent `Xor`s normally let the analysis reach a combination no execution ever writes,
 * and the proof then fails on a phantom. An inclusive branch is the case where the warning does
 * not apply, because *every* subset of arms genuinely is a reachable outcome — `selectBranches`
 * may return any of the 2^n subsets. The structural branches therefore equal the runtime
 * outcomes, which is the property [IO-015] actually asks for. A future reader will read this as
 * a bug; it is not.
 *
 * **Every arm settles, including the ones that did nothing.** A skipped arm deposits its
 * arrival marker straight into `arrived`: skipping *is* settling, so giving "nothing happened"
 * its own place would only add a token with no consumer, and a no-result marker with no drain
 * accumulates for the life of the net. A failed arm's marker is deposited by `settle.fail`
 * alongside the error, in one firing, which is what keeps the join reachable when an arm fails
 * — the sibling arms' markers would otherwise strand forever waiting for an n-th that never
 * comes.
 *
 * **The join is a cardinality join, not a pending-marker one.** `n` is `entry.arms.length`,
 * known at compile time, so `exactly(n, arrived)` is exact; the pending-marker-plus-inhibitor
 * idiom is for a fan-out whose width is data-dependent. `arrived` therefore has a hard bound of
 * n, which is what a place bound proof needs.
 */
export const branchGadget: Gadget = (entry, next, ctx): GadgetResult => {
  if (entry.kind !== 'branch') throw new Error(`branchGadget received a '${entry.kind}' entry`);

  const arms = entry.arms;
  const n = arms.length;
  if (n === 0) {
    // `exactly(0, arrived)` is satisfied by the empty marking, so a zero-arm join would be
    // permanently enabled and fire forever. There is no net that means "branch over nothing".
    throw new Error(
      `branch '${entry.id}' has no arms; a branch with no arms has no join cardinality ` +
        '(exactly(0) is enabled in every marking and would fire forever).',
    );
  }

  // Checked at compile time, not at firing time: a workflow whose runner cannot answer the
  // question this entry asks is a wiring mistake, and a wiring mistake should not wait until a
  // token reaches `decide` to surface.
  const selectBranches = ctx.runner.selectBranches;
  if (selectBranches === undefined) {
    throw new Error(
      `branch '${entry.id}' needs a runner with selectBranches(entryId, input), but the ` +
        'runner supplied to compile() does not implement it. `.branch` is inclusive: the ' +
        'compiler needs the set of truthy arms, not a single choice.',
    );
  }
  const select = selectBranches.bind(ctx.runner);

  const names = ctx.names;
  const path = ctx.path;
  const inPlace = place<FlowToken>(names.entryIn(path, entry.id));
  /** One marker per arm, whichever way the arm went. Bounded by n; drained by exactly one join. */
  const arrived = place<ArrivalToken>(names.entryPlace(path, entry.id, 'arrived'));
  /** Non-empty iff at least one arm failed. A flag place, read by the two joins as a pair. */
  const err = place<FailureToken>(names.entryPlace(path, entry.id, 'err'));

  const transitions: Transition[] = [];
  const gates: Place<GateToken>[] = [];

  for (let i = 0; i < n; i++) {
    const arm = arms[i]!;
    const gateIn = place<GateToken>(names.entryPlace(path, entry.id, `gate.${i}`));
    const armOut = place<FlowToken>(names.entryPlace(path, entry.id, `arm.${i}.out`));
    // A gadget-local failure place, which is what the `failed` override on `emitNested` exists
    // for: routing an arm straight to the workflow terminal would let a failing arm end the run
    // while its siblings' tokens are still in flight, and those tokens would then have no
    // enabled consumer anywhere.
    const armErr = place<FailureToken>(names.entryPlace(path, entry.id, `arm.${i}.err`));

    // The child is emitted first because the gate has to name the child's input place. Its
    // transitions and places are *not* returned from this gadget: `ctx.emitNested` is the
    // builder's own `emit`, which has already collected them and recorded them in the `NetMap`
    // under the child's path. Returning them again would put the same transition into the net
    // twice, and a duplicated transition fires twice.
    const child = ctx.emitNested(arm, [...path, i], armOut, armErr);

    gates.push(gateIn);

    transitions.push(
      Transition.builder(names.entryTransition(path, entry.id, `gate.${i}`))
        .inputs(one(gateIn))
        // Both outcomes are declared, which is the whole reason the selection is allowed to
        // ride in a token value: the verifier is value-blind, so it explores run *and* skip
        // whatever the token says, and the topology — not the payload — carries the decision.
        .outputs(xor(outPlace(child.inPlace), outPlace(arrived)))
        .action(async (tctx) => {
          const gate = tctx.input(gateIn);
          // Nothing here can throw, so both legs of the xor stay reachable and neither leg
          // needs a failure path of its own.
          if (gate.selected.includes(i)) tctx.output(child.inPlace, { data: gate.data });
          else tctx.output(arrived, { index: i, id: arm.id, joined: false, data: undefined });
        })
        .build(),

      // Stamps the arm's index onto its result. The join needs it to build a record whose key
      // order does not depend on which arm happened to finish first.
      Transition.builder(names.entryTransition(path, entry.id, `arm.${i}.settle`))
        .inputs(one(armOut))
        .outputs(outPlace(arrived))
        .action(async (tctx) => {
          tctx.output(arrived, { index: i, id: arm.id, joined: true, data: tctx.input(armOut).data });
        })
        .build(),

      // The arm's failure becomes an arrival marker *and* an error flag, in one firing. Both in
      // one firing is load-bearing: it is why the marking can never show `arrived === n` with an
      // error deposit still pending, so `join.ok` cannot win a race against `join.fail`.
      Transition.builder(names.entryTransition(path, entry.id, `arm.${i}.settle.fail`))
        .inputs(one(armErr))
        .outputs(andPlaces(arrived, err))
        .action(async (tctx) => {
          const failure = tctx.input(armErr);
          tctx.output(arrived, { index: i, id: arm.id, joined: false, data: undefined });
          tctx.output(err, failure);
        })
        .build(),
    );
  }

  transitions.push(
    Transition.builder(names.entryTransition(path, entry.id, 'decide'))
      .inputs(one(inPlace))
      // `xor(and(every gate), failed)`: either the decision was made and every gate is armed, or
      // it threw and nothing downstream exists at all. Under [IO-015] exactly one branch must
      // claim exactly the set written, and these two claim disjoint sets.
      .outputs(xor(andPlaces(...gates), outPlace(ctx.failed)))
      .action(async (tctx) => {
        const incoming = tctx.input(inPlace);

        // Decide, then emit ([EXEC-031]): the input is already consumed and is not restored on
        // failure, so everything that can throw happens here, writing nothing, and the writes
        // below cannot throw. A `try` that wrote in both halves would satisfy neither branch.
        let outcome: { readonly selected: readonly number[] } | { readonly error: unknown };
        try {
          const chosen = await select(entry.id, incoming.data);
          for (const index of chosen) {
            if (!Number.isInteger(index) || index < 0 || index >= n) {
              throw new Error(
                `selectBranches('${entry.id}') returned arm index ${String(index)}, outside ` +
                  `0..${n - 1}. An out-of-range index would silently skip every arm.`,
              );
            }
          }
          outcome = { selected: [...chosen] };
        } catch (error) {
          outcome = { error };
        }

        if ('error' in outcome) {
          // Straight to the caller's failure place, not through the join: no gate has been
          // armed, so there are no sibling tokens to strand. When this gadget is nested, that
          // place is the parent's local failure place and the parent settles it.
          tctx.output(ctx.failed, { stepId: entry.id, error: outcome.error });
          return;
        }
        for (const gate of gates) tctx.output(gate, { data: incoming.data, selected: outcome.selected });
      })
      .build(),

    Transition.builder(names.entryTransition(path, entry.id, 'join.ok'))
      .inputs(exactly(n, arrived))
      // The low-priority half of the consume/inhibit pair: `join.fail` consumes the error
      // token, this one is blocked by it. The pair is what makes "did any arm fail" a
      // structural question rather than something an action inspects.
      .inhibitor(err)
      .outputs(outPlace(next))
      .action(async (tctx) => {
        tctx.output(next, { data: joinedRecord(tctx.inputs<ArrivalToken>(arrived)) });
      })
      .build(),

    Transition.builder(names.entryTransition(path, entry.id, 'join.fail'))
      .inputs(exactly(n, arrived), one(err))
      // Several arms may have failed. `one(err)` gates and supplies the reported failure; the
      // reset drains whatever else landed, because those tokens have no other consumer and a
      // place that keeps them is an unbounded place. Inputs are consumed before resets drain
      // ([EXEC-013]), so `tctx.input(err)` still sees exactly the one gating token.
      //
      // This is the one reset arc in the gadget and it is deliberately on the flag place, never
      // on `arrived`: `arrived` is the place whose count the join's cardinality — and any place
      // bound proof over this gadget — depends on.
      .reset(err)
      // Redundant with the inhibitor above, which already makes the two mutually exclusive in
      // every marking. Kept because it is the house form of the consume/inhibit pair, and
      // because it costs nothing to be explicit about which half wins if an executor ever
      // evaluates enablement against a marking where both look live.
      .priority(1)
      .outputs(outPlace(ctx.failed))
      .action(async (tctx) => {
        // The failing arm's own stepId is forwarded, not the branch's: a counterexample that
        // says "branch pick failed" hides which arm did.
        tctx.output(ctx.failed, tctx.input(err));
      })
      .build(),
  );

  return { inPlace, transitions };
};

/**
 * The joined result: Mastra's `.branch` yields a record keyed by the step id of each arm that
 * ran, and an empty record when no condition was truthy.
 *
 * Sorted by arm index rather than by arrival, so the record's key order is a function of the
 * workflow's shape and not of which arm's step happened to resolve first. Skipped arms
 * contribute nothing, which is what makes "zero arms selected" produce `{}` rather than a
 * record full of holes.
 */
function joinedRecord(markers: readonly ArrivalToken[]): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const marker of [...markers].sort((a, b) => a.index - b.index)) {
    if (marker.joined) record[marker.id] = marker.data;
  }
  return record;
}

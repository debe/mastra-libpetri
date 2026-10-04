import { Transition, and, one, outPlace, place, type Out, type Place, type TransitionContext } from 'libpetri';
import type { EntryPath, NameVocabulary } from '../names.js';
import type { FlowToken, PlaceClaim, Pool } from '../types.js';

/**
 * A `.parallel()`'s or `.branch()`'s own bound on its fan-out ([ADR 0011]): a pool of `c` slots,
 * admitted in arm order, shared by both block gadgets so the two compile it identically.
 *
 * ```text
 *   wf.slots.<path>   seeded with c in every segment's initial marking — never by an action
 *   active            one token per admitted arm, from admission to settlement
 *
 *   admit-j:     q_j + slot             -> armIn_j + active + q_{j+1}     (q_n does not exist)
 *   collect-*:   <arm outcome> + active -> arrived (+ marker) + slot      (every collect)
 *   re-admit-j:  resumed_j + slot       -> armIn_j + active               (a resume's arm)
 * ```
 *
 * **The invariant is in the arcs.** Every transition touching `slots` or `active` moves one token
 * between them, so `slots + active = c` holds in every reachable marking — a P-semiflow libpetri's
 * linear bound and the shared pool check (`verify/pools.ts`) read directly, which is why it is
 * preferred over a threshold inhibitor. `placeBound(active, c)` is this gadget's claim; the pool's
 * own bound and quiescence claims come from `CompiledWorkflow.pools`.
 *
 * **FIFO by topology.** One cursor token walks `q_0 … q_{n-1}`, and only `admit-j` (or, in a
 * branch, a skipping gate) passes it on, so arm `j + 1` cannot be admitted before arm `j`. No
 * priority is involved, and the cursor is never held while an arm runs.
 *
 * **The slot is held from admission to settlement**, across every retry and retry delay of the
 * arm, because only a collect returns it. The run permit ([ADR 0006]) is taken later, by each
 * attempt, and returned in the attempt's own firing — slot first, then permit, so a permit is
 * never held while waiting for a slot and in flight within the block is at most `min(c, k)`.
 *
 * **Not gated by cancel.** Admission happens after the block has started, and Mastra never checks
 * its signal inside a started block ([ADR 0004], row 28): a queued arm is admitted after an abort
 * and starts with its signal already aborted, so every arm writes its record.
 */
export interface BlockAdmission {
  readonly c: number;
  readonly slots: Place<null>;
  readonly active: Place<null>;
  /** `admit-j` and `re-admit-j`, as emitted — the pool's takers. */
  readonly takers: string[];
  /** Every collect, as emitted — the pool's givers. */
  readonly givers: string[];
}

/**
 * The bound that binds: `c` when the block has one and `c < arms`, else `undefined` — `c ≥ arms`
 * cannot bind, so such a block compiles exactly as an unannotated one (same net, same hash).
 * Refuses a value that is not a whole number ≥ 1; the adapter refuses it first, by name.
 */
export function bindingLimit(blockId: string, concurrency: number | undefined, arms: number): number | undefined {
  if (concurrency === undefined) return undefined;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error(`block '${blockId}': concurrency must be a whole number ≥ 1, got ${String(concurrency)}`);
  }
  return concurrency < arms ? concurrency : undefined;
}

/** The pool and its holder for a block at `path`; `undefined` when the limit does not bind. */
export function blockAdmission(
  names: NameVocabulary,
  path: EntryPath,
  blockId: string,
  c: number | undefined,
): BlockAdmission | undefined {
  if (c === undefined) return undefined;
  return {
    c,
    slots: place<null>(names.slotsPlace(path)),
    active: place<null>(names.entryPlace(path, blockId, 'active')),
    takers: [],
    givers: [],
  };
}

/** One place, or the set of them, as one output branch. */
function outs(places: readonly Place<unknown>[]): Out {
  return places.length === 1 ? outPlace(places[0]!) : and(...places.map(outPlace));
}

/**
 * A collect: consumes `from` and, under a limit, one `active`; writes `to` and, under a limit, one
 * slot back — in the same firing as the arrival, so the slot and the settlement land together
 * ([EXEC-001]). Without a limit it is exactly the collect the gadget always emitted.
 */
export function collect<T>(
  admission: BlockAdmission | undefined,
  name: string,
  from: Place<T>,
  to: readonly Place<unknown>[],
  write: (tctx: TransitionContext, input: T) => void,
): Transition {
  const builder = Transition.builder(name)
    .inputs(...(admission === undefined ? [one(from)] : [one(from), one(admission.active)]))
    .outputs(outs(admission === undefined ? to : [...to, admission.slots]))
    .action(async (tctx) => {
      const input = tctx.input(from);
      write(tctx, input);
      if (admission !== undefined) tctx.output(admission.slots, null);
    });
  if (admission !== undefined) admission.givers.push(name);
  return builder.build();
}

/**
 * `admit-j`: the cursor at `from` and one slot become arm `j`'s input, one `active`, and — for every
 * arm but the last — the cursor at `cursor`, carrying `pass(input)`. The arm's input is `from`'s
 * flow token, unchanged.
 */
export function admit<C>(
  admission: BlockAdmission,
  name: string,
  from: Place<FlowToken>,
  armIn: Place<FlowToken>,
  cursor: { readonly place: Place<C>; readonly pass: (input: FlowToken) => C } | undefined,
): Transition {
  const to: Place<unknown>[] = [armIn, admission.active];
  if (cursor !== undefined) to.push(cursor.place);
  admission.takers.push(name);
  return Transition.builder(name)
    .inputs(one(from), one(admission.slots))
    .outputs(outs(to))
    .action(async (tctx) => {
      const input = tctx.input(from);
      tctx.output(armIn, input);
      tctx.output(admission.active, null);
      if (cursor !== undefined) tctx.output(cursor.place, cursor.pass(input));
    })
    .build();
}

/** `placeBound(active, c)`: one token per admitted, unsettled arm, never more than the slots. */
export function admissionClaims(admission: BlockAdmission | undefined): PlaceClaim[] {
  if (admission === undefined) return [];
  return [{ place: admission.active.name, bound: admission.c, why: `one per admitted arm, at most concurrency ${admission.c}` }];
}

/** The block's slot pool ([ADR 0011]), with `active` as its holder; empty when the limit does not bind. */
export function admissionPools(admission: BlockAdmission | undefined): Pool[] {
  if (admission === undefined) return [];
  return [
    {
      kind: 'slots',
      place: admission.slots,
      seed: admission.c,
      holders: [{ place: admission.active.name, weight: 1 }],
      takers: [...admission.takers],
      givers: [...admission.givers],
    },
  ];
}

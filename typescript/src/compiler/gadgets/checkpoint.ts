import { Transition, one, outPlace, place, type Place } from 'libpetri';
import type { NameVocabulary } from '../names.js';
import { scopeOf } from '../scope.js';
import type { CanceledToken, EntryDescription, FlowToken } from '../types.js';

/** What the checkpoint between two top-level entries emitted. */
export interface CheckpointResult {
  /** `s.<after>.checkpoint` — where entry `after`'s success goes instead of entry `after + 1`'s input. */
  readonly place: Place<FlowToken>;
  /** The write and its cancel sweep. */
  readonly transitions: readonly Transition[];
}

/**
 * The checkpoint after top-level entry `after` ([ADR 0010]).
 *
 * ```text
 *   entry `after` --success--> s.<after>.checkpoint --(t.<after>.checkpoint, ¬wf.cancel)--> in_{after+1}
 *                                                    --(t.<after>.checkpoint-cancel, ?wf.cancel)--> wf.canceled
 * ```
 *
 * **The write is a freeze, awaited in the firing.** `t.<after>.checkpoint` consumes the one flow
 * token, awaits `runner.checkpoint`, and only then puts the token, unchanged, into the next entry's
 * input. So the row is durable before any effect of entry `after + 1`, and the net holds no other
 * token while it is written — the barrier says so. A rejected write fails the firing: the token is
 * consumed and never produced, the run ends, and the engine rejects with the cause — an explicitly
 * requested durability point is never skipped silently.
 *
 * **Cancellation is structural.** The write is inhibited by `wf.cancel`; the sweep *reads* it (a
 * read arc, so the signal stays for every later check) and reports the cancel **unwritten**, with
 * exactly the token the next entry's own input sweep would report — `notStarted`, see
 * {@link notStartedAt}. So a canceled run takes no checkpoint, and its outcome is the unmarked
 * net's. A cancel that arrives while the write is in flight finds the token already consumed; the
 * write completes and the next entry's sweep reports it — Mastra's check before an entry
 * (`default.ts:815`), unchanged.
 *
 * **Why the sweep ends in `wf.canceled`, not in the next entry's input** (as ADR 0010 first drew
 * it). Both report the same outcome, but a sweep that leads back into work keeps the cancel signal
 * relevant to everything downstream, and the verifier's liveness witnesses stopped closing: on a
 * seven-entry workflow marked after entry 0, `live(t.5-0.item.run)` and two others went from ~100ms
 * `violated` (witness found) to `unknown` at the 30s budget, and removing that one sweep, or sending
 * it to `wf.canceled`, brought all of them back to ~260ms. Ending in `wf.canceled` is also what every
 * other sweep in the net does (`resumeGateViolations`, rule 6).
 *
 * **No runner at compile time.** The runner arrives per run through the run scope, as for every
 * other action. The kernel refuses a marked run whose runner has no `checkpoint` before it starts;
 * the action still throws a named error if one fires without it, rather than skipping the write.
 */
export function checkpointGadget(
  after: number,
  next: Place<FlowToken>,
  cancel: Place<null>,
  canceled: Place<CanceledToken>,
  notStarted: CanceledToken,
  names: NameVocabulary,
): CheckpointResult {
  const waiting = place<FlowToken>(names.checkpointPlace(after));

  const write = Transition.builder(names.checkpointTransition(after, false))
    .inputs(one(waiting))
    .inhibitor(cancel)
    .outputs(outPlace(next))
    .action(async (tctx) => {
      const token = tctx.input(waiting);
      const scope = scopeOf(tctx);
      const checkpoint = scope.runner.checkpoint;
      if (typeof checkpoint !== 'function') {
        throw new Error(
          `checkpoint after entry ${after} reached with a runner that has no checkpoint(); a workflow ` +
            'that marks a checkpoint must run with a runner that writes it (ADR 0010).',
        );
      }
      await checkpoint.call(scope.runner, { after, records: new Map(scope.stepResults()) });
      tctx.output(next, token);
    })
    .build();

  const sweep = Transition.builder(names.checkpointTransition(after, true))
    .inputs(one(waiting))
    .read(cancel)
    .outputs(outPlace(canceled))
    .action(async (tctx) => {
      tctx.input(waiting);
      tctx.output(canceled, notStarted);
    })
    .build();

  return { place: waiting, transitions: [write, sweep] };
}


/**
 * What the input sweep of the top-level entry at `index` reports when it never started: Mastra's
 * check before the entry (`default.ts:815`). The checkpoint before it reports the same, so a marked
 * and an unmarked net end a canceled run identically.
 *
 * Every gadget's input sweep emits `{ origin: { stepId, path: [index] }, started: false }` and
 * records nothing; `stepId` is the entry's own id, except for a loop and a `.foreach()`, which
 * report their **body** — the id Mastra keys their result under (`gadgets/loop.ts` `notStarted`,
 * `gadgets/foreach.ts` `origin`). A top-level flow token never carries a `foreachIndex`.
 * `tests/compiler/checkpoint.test.ts` runs every kind both ways and compares the outcomes.
 */
export function notStartedAt(entry: EntryDescription, index: number): CanceledToken {
  switch (entry.kind) {
    case 'loop':
    case 'foreach':
      return { origin: { stepId: entry.body.id, path: [index] }, started: false };
    case 'step':
    case 'sleep':
    case 'sleepUntil':
    case 'parallel':
    case 'branch':
      return { origin: { stepId: entry.id, path: [index] }, started: false };
  }
}

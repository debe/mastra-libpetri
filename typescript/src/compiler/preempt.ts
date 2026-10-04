import type { EntryPath } from './names.js';

/**
 * Why a loser of a `race` / `quorum` block stopped ([ADR 0014]). Host-free, so the decision gadget
 * constructs it — one per block per segment, in its `met` / `short` action, handed to
 * `RunScope.preempt(path, reason)` — exactly as the leaf constructs a `StepTimeoutError`
 * ([ADR 0013], `compiler/timeout.ts`).
 *
 * - It is the `reason` of the block's preemption signal, so a step reading `abortSignal.reason` can
 *   tell a preemption from a run cancel (`DOMException` `AbortError`) and from a timeout.
 * - It is the `reason` the leaf stamps on a loser's `canceled` record (`StepRecord`), and
 *   `step-result.ts` writes it as that row's `error` ([ADR 0014], Losers).
 *
 * Never retried and never a failure: a preempted attempt leaves by its arm's `preempted` branch.
 * `block`, `path` and `outcome` are own enumerable fields, so they survive a JSON round trip of the row.
 */
export class StepPreemptedError extends Error {
  override readonly name = 'StepPreemptedError';
  readonly kind = 'preempted' as const;
  constructor(
    /** The deciding block's id. */
    readonly block: string,
    /** The block's view path — Mastra's `executionPath` — always top-level, `[i]`. */
    readonly path: EntryPath,
    /** Which decision preempted it: `met` (k successes) or `short` (n − k + 1 misses). */
    readonly outcome: 'met' | 'short',
  ) {
    super(`preempted: block '${block}' at [${path.join(', ')}] decided (${outcome}) without this arm`);
  }
}

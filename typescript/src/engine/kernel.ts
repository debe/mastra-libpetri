import {
  PrecompiledNetExecutor,
  tokenOf,
  seedToken,
  type Clock,
  type Marking,
} from 'libpetri';
import type { CompiledWorkflow, FailureToken, FlowToken } from '../compiler/types.js';

/** How a run ended, read from the terminal marking rather than from a return value. */
export type RunOutcome =
  | { readonly status: 'success'; readonly output: unknown }
  | { readonly status: 'failed'; readonly stepId: string; readonly error: unknown }
  | { readonly status: 'stranded'; readonly places: readonly string[] };

export interface RunOptions {
  /**
   * Per-executor clock ([TIME-015]). Supply one to make a timed run deterministic; two
   * executors in one process take independent clocks, which is what the differential harness
   * needs and what `vi.useFakeTimers` cannot express.
   *
   * Set `deadlineToleranceMs` to 0 alongside it — the 5ms default absorbs real timer jitter and
   * under a virtual clock would mask the very behaviour being observed.
   */
  readonly clock?: Clock;
  /** Wall-clock budget for the whole run. */
  readonly timeoutMs?: number;
}

/**
 * Runs a compiled workflow to quiescence and classifies the terminal marking.
 *
 * **The net decides what runs.** There is no loop here — the kernel seeds the entry place,
 * hands the net to libpetri and reads the result. Ordering comes from the topology
 * ([EXEC-002]), never from this file.
 *
 * **Quiescence, not environment places.** No environment place is registered on this path, so
 * the executor terminates at quiescence ([ENV-010]) rather than requiring `drain()`. Suspend
 * and resume will register them, and will drive `drain()` from inside `Clock.sleep` — a
 * `drain()` from outside the loop reaches a parked executor only.
 *
 * **Cancellation is `close()`, never `run(timeoutMs)` alone.** The default timeout policy is
 * `'abandon'`: it rejects while the loop keeps firing and mutating the marking. `'close'` is
 * the only policy that actually stops.
 */
export async function runWorkflow(
  compiled: CompiledWorkflow,
  input: unknown,
  options: RunOptions = {},
): Promise<RunOutcome> {
  // A marking is built before any executor exists, so the ordinary constructor stamps wall
  // time and would differ on every replay — inside the marking. Seed through the clock.
  const seed = options.clock
    ? seedToken<FlowToken>(options.clock, { data: input })
    : tokenOf<FlowToken>({ data: input });

  const executor = new PrecompiledNetExecutor(
    compiled.net,
    new Map([[compiled.entryPlace, [seed]]]),
    options.clock ? { clock: options.clock, deadlineToleranceMs: 0 } : {},
  );

  const marking = await executor.run(options.timeoutMs ?? 300_000, 'close');
  return classify(compiled, marking);
}

/**
 * Reads the outcome out of the marking. Both terminals are checked, and anything left
 * elsewhere is reported as stranded rather than silently treated as success — a stranded token
 * is a modelling defect, and hiding it would make the engine's worst failure its quietest.
 */
export function classify(compiled: CompiledWorkflow, marking: Marking): RunOutcome {
  // `peekFirst` returns null, not undefined, on an empty place ([CORE-013]).
  const failure = marking.peekFirst(compiled.failedPlace) as { value: FailureToken } | null;
  if (failure !== null) {
    return { status: 'failed', stepId: failure.value.stepId, error: failure.value.error };
  }

  const done = marking.peekFirst(compiled.donePlace) as { value: FlowToken } | null;
  if (done !== null) return { status: 'success', output: done.value.data };

  const held: string[] = [];
  for (const p of compiled.net.places) {
    if (marking.tokenCount(p) > 0) held.push(p.name);
  }
  return { status: 'stranded', places: held.sort() };
}

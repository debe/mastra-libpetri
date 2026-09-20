import type { Clock } from 'libpetri';

/**
 * A clock the test drives ([TIME-015]).
 *
 * Two obligations the seam imposes, both of which are silent failures if missed:
 *
 * - **`sleep` must either suspend or advance the clock.** A host clock moves only when the
 *   host decides, so resolving without advancing while nothing is ready spins forever —
 *   `now() - enabledAt` never reaches the delay.
 * - **Resolve on abort, never reject.** That path runs during `close()`, where an unhandled
 *   rejection is worst.
 *
 * `sleep` may also resolve early and spuriously; the executor re-checks readiness, so this
 * does not have to be exact.
 */
export class ManualClock implements Clock {
  #now = 0;
  readonly #epochOrigin: number;

  constructor(epochOrigin = 1_700_000_000_000) {
    this.#epochOrigin = epochOrigin;
  }

  now(): number {
    return this.#now;
  }

  epochNow(): number {
    return this.#epochOrigin + this.#now;
  }

  /** Virtual milliseconds elapsed — the assertion surface for a timed test. */
  elapsed(): number {
    return this.#now;
  }

  async sleep(delayMs: number, ready: () => boolean, signal: AbortSignal): Promise<void> {
    if (signal.aborted || ready()) return;

    if (Number.isFinite(delayMs)) {
      // A timed transition is due in `delayMs`. Jump there: that is the whole point of virtual
      // time, and it is the "advance" half of suspend-or-advance.
      this.#now += delayMs;
      return;
    }

    // `Infinity` means no timed transition is pending — the executor is waiting on an in-flight
    // action. Suspend by yielding, so its promise can settle. Advancing here would be wrong:
    // no amount of elapsed time makes an unfinished action finish.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

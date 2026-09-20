/**
 * Spike — clock restart semantics ([TIME-010], [TIME-011], [TIME-012], [TIME-015]).
 *
 * Our loop and foreach gadgets reuse places across iterations, and our parallel gadget clears
 * its `errSeen` marker with a reset arc. Both shapes take a token out of a place and put one
 * back. Whether that counts as a *disablement* decides when a `delayed(d)` transition reading
 * that place becomes due — and a starving `delayed()` is silent: the net simply never reaches
 * the firing, and the run ends quiescent with the work undone.
 *
 * So this file pins, by exact virtual timestamp, the facts the compiler already assumes:
 *
 *  1. a `delayed(d)` transition enabled at virtual `t` fires at exactly `t + d`;
 *  2. a consume-and-return through an **input arc** restarts a dependent's clock;
 *  3. the same, with the dependent on a **read arc** — our loop gadget's shape;
 *  4. a **surplus** token preserves the clock — our foreach permit place depends on this;
 *  5. a **reset arc** restarts the clock — our parallel gadget's `errSeen` drain, and a
 *     surplus token does **not** rescue it, because a reset drains the place outright;
 *  6. the fresh clock is stamped where the **refill lands**, not where the consumption
 *     happened — so an asynchronous refresher that outlives a timing boundary pushes the whole
 *     delay out behind it. [TIME-012] AC5 says an async action restarts the clock but not from
 *     when, and this is the half our gadgets are exposed to.
 *
 * Every net here runs on {@link ManualClock} through {@link BoundedManualClock}, so time is
 * virtual, the run is instant, and every assertion names an instant rather than a tolerance.
 * The executor is {@link PrecompiledNetExecutor} because that is the one `engine/kernel.ts`
 * constructs; the bitmap executor carries the same code and is not what we ship against.
 *
 * **Teeth.** Each restart claim is paired *in this file* with the shape that flips it:
 * `buildTimerNet` emits the identical net with `disturbance: 'none'`, where the refresher never
 * touches the shared place, and the dependent then fires at 500 instead of 600. The surplus
 * case is the second such pairing — same arcs, one more token, and the clock is preserved. The
 * `delayed(d)` table varies `d` so no constant can satisfy it, and the chained case fires at
 * 350 rather than 250, which no run-relative reading could produce.
 *
 * Each assertion was additionally mutated and observed to fail, so none of them is vacuous:
 *
 * | mutation                                                  | observed failure                 |
 * |-----------------------------------------------------------|----------------------------------|
 * | input-arc consume-and-return asserted at 500 (no restart)  | `expected [ 600 ] to equal [ 500 ]` |
 * | surplus asserted at 600 + `['transition-enabled']`         | `expected [ 500 ] to equal [ 600 ]` |
 * | reset-with-surplus asserted at 500 (surplus rescues)       | `expected [ 600 ] to equal [ 500 ]` |
 * | deferred refill asserted at 600 (stamped at consumption)   | `expected [ 800 ] to equal [ 600 ]` |
 * | chained `Second` asserted at 250 (run-relative clock)      | `expected [ 350 ] to equal [ 250 ]` |
 * | deferred-refill restart instant asserted at 100            | `expected [ 0, 300 ] to equal [ 0, 100 ]` |
 * | surplus restart instants asserted as `[0, 100]`            | `expected [ 0 ] to equal [ 0, 100 ]` |
 *
 * A starving transition is not a silent pass either: `clockEventsBetween` asserts the dependent
 * started at all, and `firings` returns `[]` rather than `undefined`, so `[]` fails the compare.
 */

import { describe, expect, it } from 'vitest';
import {
  PetriNet,
  PrecompiledNetExecutor,
  Transition,
  delayed,
  one,
  outPlace,
  place,
  tokenOf,
  InMemoryEventStore,
  type Clock,
  type Marking,
  type NetEvent,
  type Place,
  type Token,
} from 'libpetri';
import { ManualClock } from '../support/manual-clock.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * {@link ManualClock}, bounded by the number of waits **entered** rather than by patience
 * ([TIME-015] contract 2).
 *
 * A net that starves under a host clock does not time out — under `Infinity` the wait yields a
 * macrotask and the loop spins forever making no progress, so an enclosing timeout is the wrong
 * instrument. Counting entries fails in milliseconds and names the defect instead. The throw
 * escapes through `Promise.race` and rejects `run()`; that is a harness failure, not the
 * contract-4 abort path, which still resolves.
 */
class BoundedManualClock implements Clock {
  readonly #inner = new ManualClock();
  readonly #maxWaits: number;
  #waits = 0;

  constructor(maxWaits = 200) {
    this.#maxWaits = maxWaits;
  }

  now(): number {
    return this.#inner.now();
  }

  epochNow(): number {
    return this.#inner.epochNow();
  }

  /** Virtual milliseconds elapsed — the assertion surface. */
  elapsed(): number {
    return this.#inner.elapsed();
  }

  /**
   * The virtual instant an event's epoch `timestamp` was taken at ([TIME-015]: events are
   * stamped from the epoch clock). The origin is derived from the clock rather than hardcoded,
   * so this stays correct if {@link ManualClock}'s epoch origin ever moves.
   */
  virtualOf(epochMs: number): number {
    return epochMs - (this.#inner.epochNow() - this.#inner.elapsed());
  }

  sleep(delayMs: number, ready: () => boolean, signal: AbortSignal): Promise<void> {
    this.#waits += 1;
    if (this.#waits > this.#maxWaits) {
      throw new Error(
        `clock waits exceeded ${this.#maxWaits} at virtual t=${this.#inner.elapsed()}ms — `
        + 'the net is spinning or starving, not merely slow',
      );
    }
    return this.#inner.sleep(delayMs, ready, signal);
  }
}

/** Virtual firing instants, per transition, in firing order. */
type FiringLog = Map<string, number[]>;

function record(log: FiringLog, name: string, atMs: number): void {
  const existing = log.get(name);
  if (existing === undefined) log.set(name, [atMs]);
  else existing.push(atMs);
}

/** Firing instants for `name`, or `[]` — never `undefined`, so a starve reads as `[]`. */
function firings(log: FiringLog, name: string): number[] {
  return log.get(name) ?? [];
}

interface RunOutcome {
  readonly fired: FiringLog;
  readonly endedAtMs: number;
  readonly events: readonly NetEvent[];
  readonly marking: Marking;
  readonly clock: BoundedManualClock;
}

async function runVirtual(
  net: PetriNet,
  initial: Map<Place<any>, Token<any>[]>,
  fired: FiringLog,
  clock: BoundedManualClock,
): Promise<RunOutcome> {
  const eventStore = new InMemoryEventStore();
  const executor = new PrecompiledNetExecutor(net, initial, {
    clock,
    // [TIME-013]/[TIME-015]: the 5ms default band exists to absorb real jitter. Under a host
    // clock there is none, and the band would mask exactly what a virtual clock exposes.
    deadlineToleranceMs: 0,
    eventStore,
  });
  const marking = await executor.run();
  return { fired, endedAtMs: clock.elapsed(), events: eventStore.events(), marking, clock };
}

/**
 * The clock events `dependent` received between `disturber` starting and `dependent` starting.
 *
 * `transition-enabled` after a gap the scan observed, `transition-clock-restarted` when the
 * scan never saw the gap ([TIME-012], [EVT-004], [EVT-005]); `[]` means the clock ran on.
 */
function clockEventsBetween(
  events: readonly NetEvent[],
  disturber: string,
  dependent: string,
): string[] {
  const from = events.findIndex(
    e => e.type === 'transition-started' && e.transitionName === disturber,
  );
  const to = events.findIndex(
    e => e.type === 'transition-started' && e.transitionName === dependent,
  );
  expect(from, `${disturber} never started`).toBeGreaterThanOrEqual(0);
  expect(to, `${dependent} never started after ${disturber}`).toBeGreaterThan(from);
  return events
    .slice(from + 1, to)
    .filter(
      e =>
        (e.type === 'transition-enabled' || e.type === 'transition-clock-restarted')
        && e.transitionName === dependent,
    )
    .map(e => e.type);
}

/**
 * The virtual instants at which `transition` was stamped with a fresh clock — one entry per
 * `transition-enabled` / `transition-clock-restarted` ([EVT-004], [EVT-005]).
 *
 * This reads the restart instant directly instead of inferring it from the firing, so a net
 * that fired late for some *other* reason cannot be mistaken for a restarted clock.
 */
function freshClockInstants(outcome: RunOutcome, transition: string): number[] {
  return outcome.events
    .filter(
      e =>
        (e.type === 'transition-enabled' || e.type === 'transition-clock-restarted')
        && e.transitionName === transition,
    )
    .map(e => outcome.clock.virtualOf(e.timestamp));
}

// ---------------------------------------------------------------------------
// 1. [TIME-010] A delayed(d) transition enabled at t fires at exactly t + d
// ---------------------------------------------------------------------------

describe('[TIME-010] delayed(d) fires at exactly enablement + d', () => {
  /** `Start -> Fire(delayed(d)) -> Done`, run on virtual time. */
  async function fireOnceAfter(delayMs: number): Promise<RunOutcome> {
    const start = place<string>('spike/start');
    const done = place<string>('spike/done');
    const fired: FiringLog = new Map();
    const clock = new BoundedManualClock();

    const fire = Transition.builder('Fire')
      .inputs(one(start))
      .outputs(outPlace(done))
      .timing(delayed(delayMs))
      .action(async (ctx) => {
        record(fired, 'Fire', clock.now());
        ctx.output(done, ctx.input(start));
      })
      .build();

    const net = PetriNet.builder('spike/delayed').transitions(fire).build();
    return runVirtual(net, new Map([[start, [tokenOf('go')]]]), fired, clock);
  }

  // The table is the teeth: the asserted instant tracks `d`, so no constant satisfies all three.
  // Mutation checked: expecting 250 for the d=1000 row fails with "expected [1000] to equal [250]".
  it.each([0, 250, 1000])('enabled at virtual 0 with delayed(%i) fires at exactly that instant', async (d) => {
    const outcome = await fireOnceAfter(d);
    expect(firings(outcome.fired, 'Fire')).toEqual([d]);
  });

  it('measures the delay from enablement, not from the start of the run', async () => {
    // First -> mid -> Second. `First` is delayed(100), so `Second` is not enabled until virtual
    // 100 and must fire at 350, not at 250. Run-relative timing would give 250 — which the
    // d=250 row above proves is the instant a run-relative delayed(250) does produce, so these
    // two tests together pin the *origin* of the clock and not merely its length.
    const start = place<string>('spike/start');
    const mid = place<string>('spike/mid');
    const done = place<string>('spike/done');
    const fired: FiringLog = new Map();
    const clock = new BoundedManualClock();

    const first = Transition.builder('First')
      .inputs(one(start))
      .outputs(outPlace(mid))
      .timing(delayed(100))
      .action(async (ctx) => {
        record(fired, 'First', clock.now());
        ctx.output(mid, ctx.input(start));
      })
      .build();
    const second = Transition.builder('Second')
      .inputs(one(mid))
      .outputs(outPlace(done))
      .timing(delayed(250))
      .action(async (ctx) => {
        record(fired, 'Second', clock.now());
        ctx.output(done, ctx.input(mid));
      })
      .build();

    const net = PetriNet.builder('spike/chain').transitions(first, second).build();
    const outcome = await runVirtual(net, new Map([[start, [tokenOf('go')]]]), fired, clock);

    expect(firings(outcome.fired, 'First')).toEqual([100]);
    expect(firings(outcome.fired, 'Second')).toEqual([350]);
    // The deposit that enables `Second` lands in the same cycle the consumption happened in:
    // no wait separates them, so enablement is stamped at 100 and not later.
    expect(outcome.endedAtMs).toBe(350);
  });
});

// ---------------------------------------------------------------------------
// 2-5. [TIME-011]/[TIME-012] Intermediate disablement
// ---------------------------------------------------------------------------

/**
 * How `Refresh` touches the shared `Timer` place. Everything else about the net is held fixed,
 * so a difference in `Close`'s firing instant is attributable to this and nothing else.
 */
type Disturbance =
  /** Never touches `Timer` — the control. `Close`'s clock has nothing to restart it. */
  | 'none'
  /** Consumes one token from `Timer` and returns one: our loop gadget's shape. */
  | 'consume-and-return'
  /** Drains `Timer` with a reset arc and deposits a fresh token: our parallel `errSeen` drain. */
  | 'reset-and-refill';

/** How `Close` depends on `Timer`. */
type Dependency = 'input-arc' | 'read-arc';

interface TimerNetOptions {
  readonly disturbance: Disturbance;
  readonly dependency: Dependency;
  /** Tokens initially in `Timer`. 2 gives the surplus case ([TIME-012] bullet 3). */
  readonly timerTokens: number;
}

/**
 * `Refresh` (delayed 100) disturbs `Timer`; `Close` (delayed 500) depends on it.
 *
 * Both are enabled at virtual 0, so the executor's first boundary is 100. `Refresh` fires there;
 * whether `Close` then fires at **500** (clock preserved) or **600** (clock restarted from the
 * refill) is the whole question. `Armed` gates `Close` to a single firing so the log is exact.
 */
function buildTimerNet(opts: TimerNetOptions, fired: FiringLog, clock: BoundedManualClock): {
  net: PetriNet;
  initial: Map<Place<any>, Token<any>[]>;
} {
  const activity = place<string>('spike/activity');
  const timer = place<string>('spike/timer');
  const armed = place<string>('spike/armed');
  const closed = place<string>('spike/closed');
  const refreshed = place<string>('spike/refreshed');

  let refresh = Transition.builder('Refresh')
    .timing(delayed(100))
    .priority(0);

  switch (opts.disturbance) {
    case 'none':
      // Every transition carries a real Out spec, control included.
      refresh = refresh
        .inputs(one(activity))
        .outputs(outPlace(refreshed))
        .action(async (ctx) => {
          record(fired, 'Refresh', clock.now());
          ctx.output(refreshed, ctx.input(activity));
        });
      break;
    case 'consume-and-return':
      refresh = refresh
        .inputs(one(activity), one(timer))
        .outputs(outPlace(timer))
        .action(async (ctx) => {
          record(fired, 'Refresh', clock.now());
          ctx.output(timer, ctx.input(timer));
        });
      break;
    case 'reset-and-refill':
      refresh = refresh
        .inputs(one(activity))
        .reset(timer)
        .outputs(outPlace(timer))
        .action(async (ctx) => {
          record(fired, 'Refresh', clock.now());
          ctx.output(timer, 'fresh');
        });
      break;
  }

  let close = Transition.builder('Close')
    .outputs(outPlace(closed))
    .timing(delayed(500))
    .action(async (ctx) => {
      record(fired, 'Close', clock.now());
      ctx.output(closed, 'closed');
    });
  close = opts.dependency === 'input-arc'
    ? close.inputs(one(armed), one(timer))
    : close.inputs(one(armed)).read(timer);

  const net = PetriNet.builder('spike/timer').transitions(refresh.build(), close.build()).build();
  const timers = Array.from({ length: opts.timerTokens }, (_, i) => tokenOf(`timer-${i}`));
  const initial = new Map<Place<any>, Token<any>[]>([
    [activity, [tokenOf('activity')]],
    [timer, timers],
    [armed, [tokenOf('armed')]],
  ]);
  return { net, initial };
}

async function runTimerNet(opts: TimerNetOptions): Promise<RunOutcome> {
  const fired: FiringLog = new Map();
  const clock = new BoundedManualClock();
  const { net, initial } = buildTimerNet(opts, fired, clock);
  return runVirtual(net, initial, fired, clock);
}

describe('[TIME-012] intermediate disablement restarts the clock', () => {
  it('control: an undisturbed delayed(500) fires at exactly 500', async () => {
    // The mutation that flips every restart claim below: identical net, identical delays,
    // `Refresh` simply never touches `Timer`. 500, not 600.
    const outcome = await runTimerNet({
      disturbance: 'none', dependency: 'input-arc', timerTokens: 1,
    });
    expect(firings(outcome.fired, 'Refresh')).toEqual([100]);
    expect(firings(outcome.fired, 'Close')).toEqual([500]);
    expect(clockEventsBetween(outcome.events, 'Refresh', 'Close')).toEqual([]);
  });

  it('consume-and-return through an input arc restarts the dependent from the refill (600, not 500)', async () => {
    const outcome = await runTimerNet({
      disturbance: 'consume-and-return', dependency: 'input-arc', timerTokens: 1,
    });
    expect(firings(outcome.fired, 'Refresh')).toEqual([100]);
    // 100 (the refill) + 500. Not 500: the first 100ms of the delay is discarded.
    expect(firings(outcome.fired, 'Close')).toEqual([600]);
    expect(clockEventsBetween(outcome.events, 'Refresh', 'Close')).toEqual(['transition-enabled']);
    // Enabled at virtual 0, then freshly enabled at virtual 100 — the refill instant.
    expect(freshClockInstants(outcome, 'Close')).toEqual([0, 100]);
  });

  it('consume-and-return restarts a READ-arc dependent too — our loop gadget (600, not 500)', async () => {
    // [TIME-012] AC2. The loop gadget's body reads a control place the loop-back transition
    // consumes and returns; a read arc looks passive but is a requirement, so the gap is real.
    const outcome = await runTimerNet({
      disturbance: 'consume-and-return', dependency: 'read-arc', timerTokens: 1,
    });
    expect(firings(outcome.fired, 'Refresh')).toEqual([100]);
    expect(firings(outcome.fired, 'Close')).toEqual([600]);
    expect(clockEventsBetween(outcome.events, 'Refresh', 'Close')).toEqual(['transition-enabled']);
  });

  it('a surplus token preserves the clock — our foreach permit place (500, not 600)', async () => {
    // [TIME-012] AC4. Two tokens: `Refresh` takes one, one remains, `Close` never loses its
    // requirement, and no clock event is emitted for it at all. This is the second mutation
    // proving the 600s above are not an artifact of the shape.
    const outcome = await runTimerNet({
      disturbance: 'consume-and-return', dependency: 'input-arc', timerTokens: 2,
    });
    expect(firings(outcome.fired, 'Refresh')).toEqual([100]);
    expect(firings(outcome.fired, 'Close')).toEqual([500]);
    expect(clockEventsBetween(outcome.events, 'Refresh', 'Close')).toEqual([]);
    // One fresh clock only, at virtual 0: the refresher never re-stamped it.
    expect(freshClockInstants(outcome, 'Close')).toEqual([0]);
  });

  it('a surplus token preserves a READ-arc dependent as well (500)', async () => {
    const outcome = await runTimerNet({
      disturbance: 'consume-and-return', dependency: 'read-arc', timerTokens: 2,
    });
    expect(firings(outcome.fired, 'Close')).toEqual([500]);
    expect(clockEventsBetween(outcome.events, 'Refresh', 'Close')).toEqual([]);
  });

  it('a reset arc restarts the dependent — our parallel errSeen drain (600, not 500)', async () => {
    // [TIME-012] AC3 and bullet 2: a reset is a consumption that drains the place, so every
    // transition requiring it is disabled in the intermediate marking even though the refill
    // lands in the same firing.
    const outcome = await runTimerNet({
      disturbance: 'reset-and-refill', dependency: 'input-arc', timerTokens: 1,
    });
    expect(firings(outcome.fired, 'Refresh')).toEqual([100]);
    expect(firings(outcome.fired, 'Close')).toEqual([600]);
    expect(clockEventsBetween(outcome.events, 'Refresh', 'Close')).toEqual(['transition-enabled']);
  });

  it('a reset drains surplus too, so surplus does NOT rescue the clock (600, not 500)', async () => {
    // The one place where the surplus rule does not apply: a reset arc takes every token, so
    // the "surplus keeps the clock" intuition our foreach relies on must not be carried over
    // to the parallel gadget's reset.
    const outcome = await runTimerNet({
      disturbance: 'reset-and-refill', dependency: 'input-arc', timerTokens: 2,
    });
    expect(firings(outcome.fired, 'Close')).toEqual([600]);
    expect(clockEventsBetween(outcome.events, 'Refresh', 'Close')).toEqual(['transition-enabled']);
  });

  it('a reset restarts a READ-arc dependent as well (600)', async () => {
    const outcome = await runTimerNet({
      disturbance: 'reset-and-refill', dependency: 'read-arc', timerTokens: 1,
    });
    expect(firings(outcome.fired, 'Close')).toEqual([600]);
    expect(clockEventsBetween(outcome.events, 'Refresh', 'Close')).toEqual(['transition-enabled']);
  });
});

// ---------------------------------------------------------------------------
// 6. The restart is stamped where the refill lands, not where the consumption happened
// ---------------------------------------------------------------------------

describe('[TIME-012] the fresh clock starts at the deposit, not at the consumption', () => {
  it('an async refresher that spans a timing boundary pushes the restart to the deposit', async () => {
    // Our step actions are asynchronous and can outlive a cycle, so it matters whether the
    // fresh clock is stamped when `Timer` was emptied (virtual 100) or when the token came
    // back. Here a `Spectator` with delayed(300) forces the executor to sleep while `Refresh`
    // is still in flight, so the two instants are 200ms apart and distinguishable.
    //
    // Teeth: this is a three-way discriminator. 500 = no restart, 600 = stamped at the
    // consumption, 800 = stamped at the deposit. The cases above already produce 500 and 600
    // in this same file, so none of the three is unreachable.
    const activity = place<string>('spike/activity');
    const timer = place<string>('spike/timer');
    const armed = place<string>('spike/armed');
    const closed = place<string>('spike/closed');
    const watched = place<string>('spike/watched');
    const seen = place<string>('spike/seen');

    const fired: FiringLog = new Map();
    const clock = new BoundedManualClock();
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });

    const refresh = Transition.builder('Refresh')
      .inputs(one(activity), one(timer))
      .outputs(outPlace(timer))
      .timing(delayed(100))
      .action(async (ctx) => {
        record(fired, 'Refresh', clock.now());
        await refreshGate;
        ctx.output(timer, ctx.input(timer));
      })
      .build();
    const spectator = Transition.builder('Spectator')
      .inputs(one(watched))
      .outputs(outPlace(seen))
      .timing(delayed(300))
      .action(async (ctx) => {
        record(fired, 'Spectator', clock.now());
        // Releasing here hands `Refresh` its deposit only after the clock has reached 300.
        releaseRefresh();
        ctx.output(seen, ctx.input(watched));
      })
      .build();
    const close = Transition.builder('Close')
      .inputs(one(armed), one(timer))
      .outputs(outPlace(closed))
      .timing(delayed(500))
      .action(async (ctx) => {
        record(fired, 'Close', clock.now());
        ctx.output(closed, 'closed');
      })
      .build();

    const net = PetriNet.builder('spike/deferred-refill')
      .transitions(refresh, spectator, close)
      .build();
    const outcome = await runVirtual(
      net,
      new Map<Place<any>, Token<any>[]>([
        [activity, [tokenOf('activity')]],
        [timer, [tokenOf('timer-0')]],
        [armed, [tokenOf('armed')]],
        [watched, [tokenOf('watched')]],
      ]),
      fired,
      clock,
    );

    expect(firings(outcome.fired, 'Refresh')).toEqual([100]);
    expect(firings(outcome.fired, 'Spectator')).toEqual([300]);
    expect(firings(outcome.fired, 'Close')).toEqual([800]);
    expect(clockEventsBetween(outcome.events, 'Refresh', 'Close')).toEqual(['transition-enabled']);
    // The load-bearing line: enabled at 0, re-enabled at 300 — where the deposit landed, not
    // at 100 where `Timer` was emptied. 800 = 300 + 500 follows from it.
    expect(freshClockInstants(outcome, 'Close')).toEqual([0, 300]);
  });
});

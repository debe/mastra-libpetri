/**
 * Spike — **[EXEC-002]** ready order, and the all-immediate fast-path seam.
 *
 * The kernel has no scheduler of its own: ordering falls out of priority, declaration order and
 * the marking. So libpetri's ready order *is* our scheduling semantics, and the M3 differential
 * harness compares it against Mastra's total order. Every fact below is pinned as observed, on
 * both backends ([EXEC-002] AC4), so an upgrade that changes one breaks this file rather than
 * silently re-ordering a compiled workflow.
 *
 * Each ordering claim is paired with the mutation that flips it — stated at the assertion — so
 * no assertion here can pass by accident:
 *
 * - declaration order (`fanNet`) flips when the builder order is reversed;
 * - priority (`conflictNet`) flips when the two priorities are swapped;
 * - enablement order (`enablementNet`) does **not** flip when the builder order is reversed,
 *   which is what separates it from the declaration-order rule the first test pins.
 *
 * Sources read: `libpetri/spec/04-execution-model.md` (EXEC-002, EXEC-003),
 * `runtime/precompiled-net-executor.ts` (`fireReadyTransitions`, `fireReadyImmediate`,
 * `fireReadyGeneral`, `updateDirtyTransitions`) and `runtime/bitmap-net-executor.ts`.
 */

import {
  BitmapNetExecutor,
  PetriNet,
  PrecompiledNet,
  PrecompiledNetExecutor,
  Transition,
  delayed,
  one,
  outPlace,
  place,
  unitToken,
  type Place,
  type Token,
  type TransitionAction,
  type TransitionContext,
} from 'libpetri';
import { ManualClock } from '../support/manual-clock.js';

/** A net and its initial marking, rebuilt per run so two backends never share mutable state. */
interface Wiring {
  readonly net: PetriNet;
  readonly initial: Map<Place<any>, Token<any>[]>;
}

type Build = (log: string[], clock: ManualClock) => Wiring;

/**
 * Appends the firing to `log` and forwards a unit token, so every transition carries a real
 * `Out` spec and passes [IO-015] validation. With `clock` the entry carries the virtual instant
 * of the firing — the action's prologue runs synchronously inside the firing, so the stamp is
 * the firing's own cycle reading, not a later one.
 */
function record(name: string, to: Place<null>, log: string[], clock?: ManualClock): TransitionAction {
  return async (ctx: TransitionContext): Promise<void> => {
    log.push(clock === undefined ? name : `${name}@${clock.elapsed()}`);
    ctx.output(to, null);
  };
}

function marking(...entries: readonly (readonly [Place<null>, number])[]): Map<Place<any>, Token<any>[]> {
  const initial = new Map<Place<any>, Token<any>[]>();
  for (const [p, count] of entries) {
    initial.set(p, Array.from({ length: count }, () => unitToken()));
  }
  return initial;
}

/**
 * Runs `build` on both backends and returns the firing order they agree on.
 *
 * The equality assertion is [EXEC-002] AC4 — "every executor backend produces the identical
 * ready order for the same net and marking". `virtual: false` runs on the default wall clock,
 * where consecutive orchestrator cycles genuinely carry different `now()` readings; under a
 * {@link ManualClock} that never sleeps they all read 0.
 */
async function firingOrder(build: Build, opts: { virtual?: boolean } = {}): Promise<string[]> {
  const virtual = opts.virtual ?? true;
  const orders: string[][] = [];
  for (const backend of ['precompiled', 'bitmap'] as const) {
    const log: string[] = [];
    const clock = new ManualClock();
    const { net, initial } = build(log, clock);
    const options = virtual ? { clock, deadlineToleranceMs: 0 } : {};
    const executor = backend === 'precompiled'
      ? new PrecompiledNetExecutor(net, initial, options)
      : new BitmapNetExecutor(net, initial, options);
    // `run()` with no timeout, per the house rule: a timeout's default policy keeps firing
    // after it rejects. Every net here quiesces.
    await executor.run();
    orders.push(log);
  }
  expect(orders[1]).toEqual(orders[0]);
  return orders[0]!;
}

// ===================================================================================
// 1. Equal priority, equal enablement time -> ascending declaration order [EXEC-002 AC3]
// ===================================================================================

/** Arm names chosen so that alphabetical order is neither the declaration order nor its reverse. */
const FAN_ARMS = ['zulu', 'alpha', 'mike'] as const;
/** Token insertion order — deliberately a third order, and not the one the net declares. */
const FAN_TOKEN_ORDER = ['alpha', 'mike', 'zulu'] as const;

/**
 * Three independent transitions, one token each, all `immediate`, all priority 0: they are
 * enabled in the same orchestrator cycle and therefore share one enablement timestamp
 * (`updateDirtyTransitions` reads the clock once per cycle), which is exactly [EXEC-002] AC3's
 * condition.
 */
function fanNet(declarationOrder: readonly string[]): Build {
  return (log) => {
    const sink = place<null>('sink');
    const arms = new Map<string, Place<null>>(FAN_ARMS.map((n) => [n, place<null>(`in-${n}`)]));
    const transitions = declarationOrder.map((n) =>
      Transition.builder(n)
        .inputs(one(arms.get(n)!))
        .outputs(outPlace(sink))
        .action(record(n, sink, log))
        .build());
    const net = PetriNet.builder('fan').transitions(...transitions).build();
    return {
      net,
      initial: marking(...FAN_TOKEN_ORDER.map((n) => [arms.get(n)!, 1] as const)),
    };
  };
}

describe('[EXEC-002] ready order', () => {
  it('breaks an equal-priority, same-cycle tie by ascending declaration order', async () => {
    const declared = ['zulu', 'alpha', 'mike'];
    const order = await firingOrder(fanNet(declared));

    // The four candidate rules give four different answers on this net, so the assertion
    // below picks one of them rather than passing under all.
    const byName = [...declared].sort();
    const reverseDeclaration = [...declared].reverse();
    const byTokenInsertion = [...FAN_TOKEN_ORDER];
    expect(new Set([declared, byName, reverseDeclaration].map((o) => o.join(','))).size).toBe(3);

    expect(order).toEqual(declared);
    expect(order).not.toEqual(byName);
    expect(order).not.toEqual(reverseDeclaration);
    expect(order).not.toEqual(byTokenInsertion);

    // Mutation checked: reverse the builder order, hold the token insertion order fixed. The
    // firing order follows the builder, so the assertion above has teeth. `tid` is assigned
    // from `net.transitions` — a Set in builder insertion order (`CompiledNet` ctor) — and both
    // fire paths scan ascending `tid`.
    const flipped = await firingOrder(fanNet(['mike', 'alpha', 'zulu']));
    expect(flipped).toEqual(['mike', 'alpha', 'zulu']);
  });

  // ===================================================================================
  // 2. Priority: higher first, and it outranks declaration order [EXEC-002 AC1, EXEC-003]
  // ===================================================================================

  /** Two transitions, one contested token: only the winner fires ([EXEC-003] AC1). */
  function conflictNet(firstPriority: number, secondPriority: number): Build {
    return (log) => {
      const contested = place<null>('contested');
      const sink = place<null>('sink');
      const mk = (name: string, priority: number) =>
        Transition.builder(name)
          .inputs(one(contested))
          .outputs(outPlace(sink))
          .priority(priority)
          .action(record(name, sink, log))
          .build();
      const net = PetriNet.builder('conflict')
        .transitions(mk('declared-first', firstPriority), mk('declared-second', secondPriority))
        .build();
      return { net, initial: marking([contested, 1]) };
    };
  }

  it('fires the higher priority first, whichever way the net declares it', async () => {
    // Declaration order is held constant; only the priorities move.
    expect(await firingOrder(conflictNet(0, 5))).toEqual(['declared-second']);
    // Mutation checked: swap the two priorities — the winner swaps with them. Higher-first,
    // and priority outranks declaration order.
    expect(await firingOrder(conflictNet(5, 0))).toEqual(['declared-first']);
    // Control: equal priorities fall back to declaration order, as in the first test.
    expect(await firingOrder(conflictNet(0, 0))).toEqual(['declared-first']);
  });

  /** [EXEC-002]'s own test derivation: priorities 5, 10, 5, all enabled in one cycle. */
  function priorityLevelsNet(high: number): Build {
    return (log) => {
      const sink = place<null>('sink');
      const arms = ['five-a', 'ten', 'five-b'] as const;
      const ins = new Map(arms.map((n) => [n, place<null>(`in-${n}`)] as const));
      const transitions = arms.map((n) =>
        Transition.builder(n)
          .inputs(one(ins.get(n)!))
          .outputs(outPlace(sink))
          .priority(n === 'ten' ? high : 5)
          .action(record(n, sink, log))
          .build());
      const net = PetriNet.builder('priority-levels').transitions(...transitions).build();
      return { net, initial: marking(...arms.map((n) => [ins.get(n)!, 1] as const)) };
    };
  }

  it('sorts descending by priority, then by declaration order within a level', async () => {
    expect(await firingOrder(priorityLevelsNet(10))).toEqual(['ten', 'five-a', 'five-b']);
    // Mutation checked: level the priorities (10 -> 5) and the net falls back to pure
    // declaration order, moving `ten` from first to second.
    expect(await firingOrder(priorityLevelsNet(5))).toEqual(['five-a', 'ten', 'five-b']);
  });

  // ===================================================================================
  // 3. Enablement time as the tiebreak [EXEC-002 AC2]
  // ===================================================================================

  /**
   * Two equal-priority transitions ready in the same pass with **different** enablement
   * timestamps, on an injected clock ([TIME-015]):
   *
   * - `held` is enabled at virtual 0 by the initial marking and waits out `delayed(100)`;
   * - `gate` fires at virtual 60 and produces the token that enables `gated`, which then waits
   *   out `delayed(40)`.
   *
   * Both become ready at the same virtual instant — the `@` stamps in the log prove it — so the
   * order between them is a tiebreak decision and not a readiness accident. Holding a
   * transition enabled-but-not-ready across cycles requires a lower timing bound, which is also
   * what disqualifies the net from the fast path (see the seam section).
   */
  function enablementNet(declaredFirst: 'gated' | 'held'): Build {
    return (log, clock) => {
      const heldIn = place<null>('held-in');
      const gateIn = place<null>('gate-in');
      const gatedIn = place<null>('gated-in');
      const sink = place<null>('sink');
      const held = Transition.builder('held')
        .timing(delayed(100))
        .inputs(one(heldIn))
        .outputs(outPlace(sink))
        .action(record('held', sink, log, clock))
        .build();
      const gated = Transition.builder('gated')
        .timing(delayed(40))
        .inputs(one(gatedIn))
        .outputs(outPlace(sink))
        .action(record('gated', sink, log, clock))
        .build();
      const gate = Transition.builder('gate')
        .timing(delayed(60))
        .inputs(one(gateIn))
        .outputs(outPlace(gatedIn))
        .action(record('gate', gatedIn, log, clock))
        .build();
      const ordered = declaredFirst === 'gated' ? [gated, held, gate] : [held, gated, gate];
      const net = PetriNet.builder('enablement-order').transitions(...ordered).build();
      return { net, initial: marking([heldIn, 1], [gateIn, 1]) };
    };
  }

  it('breaks an equal-priority tie by ascending enablement time, over declaration order', async () => {
    const gatedFirst = await firingOrder(enablementNet('gated'));
    expect(gatedFirst).toEqual(['gate@60', 'held@100', 'gated@100']);

    // Mutation checked: swap the two in the builder. Unlike the declaration-order test above,
    // the outcome does *not* flip — `held` (enabled at 0) still precedes `gated` (enabled at
    // 60) although it is now declared second. That pair of results is what distinguishes the
    // enablement-time rule from the declaration-order rule.
    const heldFirst = await firingOrder(enablementNet('held'));
    expect(heldFirst).toEqual(gatedFirst);

    // Both fired at the same virtual instant, so both were in the ready set of one pass.
    const instants = gatedFirst.slice(1).map((e) => e.split('@')[1]);
    expect(instants).toEqual(['100', '100']);

    // What this does *not* distinguish, stated rather than implied: among transitions ready in
    // one pass, "enabled earliest" and "has waited longest" are the same ordering on this
    // runtime. If two are ready at instant R with stamps s1 < s2, then R - s1 > R - s2, always.
    // A rule sorting on elapsed time descending would be indistinguishable here. The source
    // sorts on `a.enabledAtMs - b.enabledAtMs`; the observation pins the resulting order.
  });

  // ===================================================================================
  // 4. The seam: which fire path runs, and whether the choice is observable
  // ===================================================================================

  type Decoy = 'none' | 'priority' | 'delayed' | 'zero-delay';

  /**
   * A net whose real work is all-immediate and single-priority, plus one **decoy** transition
   * whose input place never receives a token, so it can never fire. The decoy exists only to
   * move the fast-path condition:
   *
   * ```ts
   * // precompiled-net-executor.ts, fireReadyTransitions
   * if (this.program.allImmediate && this.program.allSamePriority) { this.fireReadyImmediate(); ... }
   * ```
   *
   * Both flags are whole-net properties computed at compile time over **every** transition
   * (`PrecompiledNet` ctor; `BitmapNetExecutor` recomputes the same two privately), so a
   * transition that never becomes enabled still decides which path the whole net runs on.
   *
   * The work itself spans several orchestrator cycles — wave 1 (`b`, `a`) produces the tokens
   * wave 2 (`y`, `x`) contends for — so under the wall clock the two waves carry different
   * enablement timestamps, which is the only input the two paths read differently.
   */
  function seamNet(decoy: Decoy): Build {
    return (log) => {
      const a = place<null>('a');
      const b = place<null>('b');
      const relay = place<null>('relay');
      const sink = place<null>('sink');
      const idle = place<null>('idle-never-marked');
      const feeder = (name: string, from: Place<null>) =>
        Transition.builder(name)
          .inputs(one(from))
          .outputs(outPlace(relay))
          .action(record(name, relay, log))
          .build();
      const drain = (name: string) =>
        Transition.builder(name)
          .inputs(one(relay))
          .outputs(outPlace(sink))
          .action(record(name, sink, log))
          .build();
      const decoyBuilder = Transition.builder('decoy')
        .inputs(one(idle))
        .outputs(outPlace(sink))
        .action(record('decoy', sink, log));
      if (decoy === 'priority') decoyBuilder.priority(1);
      if (decoy === 'delayed') decoyBuilder.timing(delayed(5));
      if (decoy === 'zero-delay') decoyBuilder.timing(delayed(0));
      const net = PetriNet.builder('seam')
        .transitions(feeder('b', b), feeder('a', a), drain('y'), drain('x'), decoyBuilder.build())
        .build();
      return { net, initial: marking([a, 1], [b, 1]) };
    };
  }

  /**
   * The case [EXEC-002] singles out: "when two ready transitions carry different timestamps
   * because one was held across cycles while in flight".
   *
   * `slow` fires at cycle 0 and stays in flight across a real timer; `refill` puts a second
   * token in its input place meanwhile; `rival` is enabled by `slow`'s own output. All
   * immediate, all one priority — so this is the fast path, and the general-path variant is the
   * same net with the decoy's priority moved.
   */
  function inFlightSeamNet(decoy: Decoy): Build {
    return (log) => {
      const work = place<null>('work');
      const feed = place<null>('feed');
      const rivalIn = place<null>('rival-in');
      const sink = place<null>('sink');
      const idle = place<null>('idle-never-marked');
      const slow = Transition.builder('slow')
        .inputs(one(work))
        .outputs(outPlace(rivalIn))
        .action(async (ctx: TransitionContext): Promise<void> => {
          log.push('slow');
          await new Promise<void>((resolve) => setTimeout(resolve, 1));
          ctx.output(rivalIn, null);
        })
        .build();
      const refill = Transition.builder('refill')
        .inputs(one(feed))
        .outputs(outPlace(work))
        .action(record('refill', work, log))
        .build();
      const rival = Transition.builder('rival')
        .inputs(one(rivalIn))
        .outputs(outPlace(sink))
        .action(record('rival', sink, log))
        .build();
      const decoyBuilder = Transition.builder('decoy')
        .inputs(one(idle))
        .outputs(outPlace(sink))
        .action(record('decoy', sink, log));
      if (decoy === 'priority') decoyBuilder.priority(1);
      const net = PetriNet.builder('in-flight-seam')
        .transitions(slow, refill, rival, decoyBuilder.build())
        .build();
      return { net, initial: marking([work, 1], [feed, 1]) };
    };
  }

  const compileFlags = (decoy: Decoy) => {
    const { net } = seamNet(decoy)([], new ManualClock());
    const program = PrecompiledNet.compile(net);
    return { allImmediate: program.allImmediate, allSamePriority: program.allSamePriority };
  };

  it('selects the fast path on two whole-net flags, which one never-enabled transition moves', () => {
    // Baseline: everything immediate, everything priority 0 -> fast path.
    expect(compileFlags('none')).toEqual({ allImmediate: true, allSamePriority: true });

    // Mutation checked, three ways, each on a transition that can never fire:
    expect(compileFlags('priority')).toEqual({ allImmediate: true, allSamePriority: false });
    expect(compileFlags('delayed')).toEqual({ allImmediate: false, allSamePriority: true });
    // `delayed(0)` has the same firing interval as `immediate()` — earliest 0, no deadline —
    // yet it still moves the whole net off the fast path. The condition is the timing's *kind*,
    // not its bounds.
    expect(compileFlags('zero-delay')).toEqual({ allImmediate: false, allSamePriority: true });

    // And the net that pins the enablement-time rule is ineligible by construction: the lower
    // bound that holds a transition enabled-but-not-ready is itself a non-immediate timing.
    const { net } = enablementNet('gated')([], new ManualClock());
    expect(PrecompiledNet.compile(net).allImmediate).toBe(false);
  });

  it('gives the same firing order on both paths — the seam is not observable from outside', async () => {
    // Wall clock (`virtual: false`): consecutive cycles read different `now()` values, so the
    // two waves really do carry different enablement timestamps. Under a ManualClock that never
    // sleeps every cycle reads 0 and the comparison would be vacuous.
    const fast = await firingOrder(seamNet('none'), { virtual: false });
    const general = await firingOrder(seamNet('priority'), { virtual: false });
    const generalTimed = await firingOrder(seamNet('delayed'), { virtual: false });

    expect(fast).toEqual(['b', 'a', 'y', 'x']);
    expect(general).toEqual(fast);
    expect(generalTimed).toEqual(fast);
    expect(fast).not.toContain('decoy');

    // The case [EXEC-002] names — a transition held across cycles while in flight — likewise
    // does not separate the two paths. Firing clears the stamp (`enabledAtMs = -Infinity` in
    // both backends) and the enablement scan skips in-flight transitions, so `slow` is
    // re-stamped in the cycle its completion is processed, which is the cycle that stamps
    // `rival` too.
    const inFlightFast = await firingOrder(inFlightSeamNet('none'), { virtual: false });
    const inFlightGeneral = await firingOrder(inFlightSeamNet('priority'), { virtual: false });
    expect(inFlightFast).toEqual(['slow', 'refill', 'slow', 'rival', 'rival']);
    expect(inFlightGeneral).toEqual(inFlightFast);

    // Why they agree, from the source rather than from luck: a transition is stamped
    // `enabledAtMs = nowMs` by `updateDirtyTransitions`, which reads the clock once per cycle;
    // firing resets the stamp to -Infinity; and the enablement scan skips in-flight
    // transitions. So a transition can only carry an *older* stamp into a pass if a lower
    // timing bound kept it from firing in its own cycle — and any such bound clears
    // `allImmediate`. Two ready transitions with different stamps are therefore reachable only
    // on the general path, where the sort reads them. The fast path's declaration order and the
    // general path's stable sort then coincide on every all-immediate single-priority net.
    // This is a bounded claim: it is what these nets show, not a proof over all nets.
  });
});

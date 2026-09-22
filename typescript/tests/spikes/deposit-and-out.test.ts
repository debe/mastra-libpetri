/**
 * Spike — the two libpetri facts the compiler's chaining rule and its `Out` discipline
 * already rest on.
 *
 * **(A) Same-pass deposit invisibility** [EXEC-001, EXEC-003 AC3–AC5]. Every gadget chains
 * `entryIn(n) -> entryIn(n+1)`, which is only a chain because a token deposited into a place
 * during one firing pass is invisible to a transition consuming from that place *in the same
 * pass*. If a deposit became visible mid-pass the chain would collapse: a whole workflow could
 * run inside one orchestrator cycle, `foreach` batching would see tokens that had not settled,
 * and a `snapshot()` taken between cycles would no longer be a point the run can resume from.
 *
 * **(B) `Out` spec validation exactness** [IO-015, IO-016, CORE-043, CORE-072]. The hard rule
 * is that every transition carries a real `Out` spec. That rule only buys anything if libpetri
 * actually enforces the spec — so this pins, case by case, what is a compile error, what is a
 * fire-time failure, and what libpetri lets through in silence. `stepAction`'s decide-then-emit
 * discipline (`src/compiler/gadgets/leaf.ts`) exists because of the `xor` case below; the test
 * named for it confirms the discipline is load-bearing rather than defensive.
 *
 * Every assertion here is paired, in this file, with the mutation that flips it — a counterfactual
 * net or marking under which the asserted value is demonstrably different. The mutation is named
 * in each test's comment.
 *
 * Observed against the linked libpetri tree (unreleased 6.1.0), both backends.
 */
import { describe, expect, it } from 'vitest';
import {
  BitmapNetExecutor,
  InMemoryEventStore,
  PetriNet,
  PrecompiledNet,
  PrecompiledNetExecutor,
  Transition,
  all,
  and,
  one,
  outPlace,
  passthrough,
  place,
  tokenOf,
  xor,
} from 'libpetri';
import type { Place, Token } from 'libpetri';
import { MarkingState, StateClassGraph } from 'libpetri/verification';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type Seed = Map<Place<any>, Token<any>[]>;

/** Initial marking literal: `seeded([p, [1, 2]])` puts tokens 1, 2 in FIFO order in `p`. */
function seeded(...entries: Array<[Place<any>, unknown[]]>): Seed {
  return new Map(entries.map(([p, values]) => [p, values.map(tokenOf)]));
}

/**
 * The documented fast-path selector [EXEC-002]: the all-immediate single-priority path is
 * taken iff every transition is `Immediate` and all priorities are equal. Recomputed here
 * from the net so each test below can state, structurally, which firing path it exercises —
 * the condition is not otherwise observable from outside the executor.
 */
function fastPathEligible(net: PetriNet): boolean {
  const ts = [...net.transitions];
  return (
    ts.every(t => t.timing.type === 'immediate') && new Set(ts.map(t => t.priority)).size <= 1
  );
}

/**
 * For each firing, how many firings had already *deposited* their output when it started.
 *
 * `transition-completed` is emitted after that firing's tokens are in the marking, so this
 * counts settled deposits. A chain in which each link waits for its predecessor's deposit
 * yields 0, 1, 2, …; a pass in which two links fire together yields a repeated count.
 */
function startLedger(store: InMemoryEventStore): Array<{ transition: string; completedBefore: number }> {
  let completed = 0;
  const ledger: Array<{ transition: string; completedBefore: number }> = [];
  for (const e of store.events()) {
    if (e.type === 'transition-started') {
      ledger.push({ transition: e.transitionName, completedBefore: completed });
    } else if (e.type === 'transition-completed') {
      completed++;
    }
  }
  return ledger;
}

function failureMessages(store: InMemoryEventStore): string[] {
  return store
    .events()
    .filter(e => e.type === 'transition-failed')
    .map(e => `${e.exceptionType}: ${e.errorMessage}`);
}

function logMessages(store: InMemoryEventStore): Array<{ logger: string; level: string; message: string }> {
  return store
    .events()
    .filter(e => e.type === 'log-message')
    .map(e => ({ logger: e.logger, level: e.level, message: e.message }));
}

// ---------------------------------------------------------------------------
// (A) Same-pass deposit invisibility
// ---------------------------------------------------------------------------

const p0 = place<number>('p0');
const p1 = place<number>('p1');
const p2 = place<number>('p2');
const p3 = place<number>('p3');

/** `p0 -> t1 -> p1 -> t2 -> p2 -> t3 -> p3`, the shape every compiled entry list has. */
function chainNet(priorities: readonly [number, number, number]): PetriNet {
  const link = (name: string, from: Place<number>, to: Place<number>, priority: number) =>
    Transition.builder(name)
      .inputs(one(from))
      .outputs(outPlace(to))
      .priority(priority)
      .action(async ctx => {
        ctx.output(to, ctx.input(from) + 1);
      })
      .build();
  return PetriNet.builder('chain')
    .transitions(
      link('t1', p0, p1, priorities[0]),
      link('t2', p1, p2, priorities[1]),
      link('t3', p2, p3, priorities[2]),
    )
    .build();
}

async function runChain(net: PetriNet, seed: Seed) {
  const store = new InMemoryEventStore();
  const marking = await new BitmapNetExecutor(net, seed, { eventStore: store }).run();
  return { ledger: startLedger(store), marking };
}

/** `seed -> fill -> q`, alongside `all(q) -> drain -> sizes`, recording each drain's batch size. */
const drainSeed = place<number>('drain-seed');
const q = place<number>('q');
const sizes = place<number>('sizes');

function drainNet(name: string, fillPriority: number, drainPriority: number): PetriNet {
  const fill = Transition.builder('fill')
    .inputs(one(drainSeed))
    .outputs(outPlace(q))
    .priority(fillPriority)
    .action(async ctx => {
      ctx.output(q, ctx.input(drainSeed));
    })
    .build();
  const drain = Transition.builder('drain')
    .inputs(all(q))
    .outputs(outPlace(sizes))
    .priority(drainPriority)
    .action(async ctx => {
      ctx.output(sizes, ctx.inputs(q).length);
    })
    .build();
  return PetriNet.builder(name).transitions(fill, drain).build();
}

/** The batch size of each `drain` firing, oldest first. */
async function drainBatches(net: PetriNet, seed: Seed): Promise<number[]> {
  const marking = await new BitmapNetExecutor(net, seed).run();
  return marking.peekTokens(sizes).map(t => t.value);
}

describe('(A) same-pass deposit invisibility [EXEC-001, EXEC-003]', () => {
  it('fast path: a chain advances exactly one link per completion round', async () => {
    const net = chainNet([0, 0, 0]);
    expect(fastPathEligible(net)).toBe(true); // all-immediate, single priority

    const { ledger, marking } = await runChain(net, seeded([p0, [0]]));

    // Each link starts only after its predecessor's deposit has landed: 0, 1, 2.
    expect(ledger).toEqual([
      { transition: 't1', completedBefore: 0 },
      { transition: 't2', completedBefore: 1 },
      { transition: 't3', completedBefore: 2 },
    ]);
    expect(marking.tokenCount(p3)).toBe(1);
    expect(marking.peekTokens(p3).map(t => t.value)).toEqual([3]);
  });

  it('teeth: two links seeded at once DO start in the same pass', async () => {
    // The mutation checked: seed p1 as well, so t2's token is present when the pass begins
    // instead of being deposited during it. t2 then starts with completedBefore 0, the same
    // value t1 has — which is exactly the signature a collapsing chain would produce. The
    // ledger above is therefore measuring something real, not a value it always returns.
    const { ledger } = await runChain(chainNet([0, 0, 0]), seeded([p0, [0]], [p1, [9]]));

    const firstPassStarts = ledger.filter(e => e.completedBefore === 0).map(e => e.transition);
    expect(firstPassStarts).toEqual(['t1', 't2']);
  });

  it('general path: distinct priorities give the identical ledger', async () => {
    // Two priority levels take the executor off the all-immediate fast path and onto the
    // sorted general path [EXEC-002]. Observed: no divergence — both paths deposit at the
    // next cycle's step 1. This is the case the spike was told to treat as a major finding
    // if it differed; it does not.
    const net = chainNet([2, 1, 0]);
    expect(fastPathEligible(net)).toBe(false);

    const { ledger, marking } = await runChain(net, seeded([p0, [0]]));

    expect(ledger).toEqual([
      { transition: 't1', completedBefore: 0 },
      { transition: 't2', completedBefore: 1 },
      { transition: 't3', completedBefore: 2 },
    ]);
    expect(marking.peekTokens(p3).map(t => t.value)).toEqual([3]);
  });

  it('fast path: a same-pass deposit survives a later all() drain [EXEC-003 AC5]', async () => {
    // `fill` is declared first, so on the fast path (tid order) it fires before `drain` in the
    // same pass. Its deposit into q is nonetheless not there for `drain` to swallow: `drain`
    // takes the two tokens present when the pass began, and the deposited third re-enables it
    // for the next cycle.
    const net = drainNet('drain-fast', 0, 0);
    expect(fastPathEligible(net)).toBe(true);

    expect(await drainBatches(net, seeded([drainSeed, [99]], [q, [1, 2]]))).toEqual([2, 1]);
  });

  it('general path: the same drain, resolved by priority, behaves identically', async () => {
    // fill at priority 5 sorts ahead of drain at priority 1, so again fill fires first in the
    // pass — this time through fireReadyGeneral's sort rather than declaration order.
    const net = drainNet('drain-general', 5, 1);
    expect(fastPathEligible(net)).toBe(false);

    expect(await drainBatches(net, seeded([drainSeed, [99]], [q, [1, 2]]))).toEqual([2, 1]);
  });

  it('teeth: the same drain collapses to one firing when the third token is there at pass start', async () => {
    // The mutation checked: drop `fill` and seed q with all three tokens. `drain` then takes
    // all three in a single firing — [3] rather than [2, 1]. That is precisely the shape the
    // previous two tests would produce if a same-pass deposit were visible, so [2, 1] is a
    // discriminating observation rather than an arithmetic accident.
    const drainOnly = Transition.builder('drain')
      .inputs(all(q))
      .outputs(outPlace(sizes))
      .action(async ctx => {
        ctx.output(sizes, ctx.inputs(q).length);
      })
      .build();
    const net = PetriNet.builder('drain-collapsed').transitions(drainOnly).build();

    expect(await drainBatches(net, seeded([q, [1, 2, 3]]))).toEqual([3]);
  });

  it('the precompiled backend agrees, on the cached PrecompiledNet the compiler holds', async () => {
    // CompiledWorkflow caches a PrecompiledNet, so the engine runs this backend, not the
    // bitmap one. A backend that deposited mid-pass would make the compiler correct only
    // under the executor it is not using.
    const net = drainNet('drain-precompiled', 0, 0);
    const marking = await new PrecompiledNetExecutor(
      net,
      seeded([drainSeed, [99]], [q, [1, 2]]),
    ).run();

    expect(marking.peekTokens(sizes).map(t => t.value)).toEqual([2, 1]);
  });
});

// ---------------------------------------------------------------------------
// (B) Out spec validation exactness
// ---------------------------------------------------------------------------

const src = place<string>('src');
const A = place<string>('A');
const B = place<string>('B');
const C = place<string>('C');

interface FiringReport {
  failures: string[];
  logs: Array<{ logger: string; level: string; message: string }>;
  counts: { A: number; B: number; C: number; src: number };
  completions: number;
}

/**
 * Fires one transition `t` (inputs `one(src)`) against the given spec and action, and reports
 * everything observable afterwards. `srcTokens` controls how many times it fires.
 */
async function fireOnce(
  spec: Parameters<ReturnType<typeof Transition.builder>['outputs']>[0],
  action: Parameters<ReturnType<typeof Transition.builder>['action']>[0],
  srcTokens: string[] = ['x'],
): Promise<FiringReport> {
  const store = new InMemoryEventStore();
  const t = Transition.builder('t').inputs(one(src)).outputs(spec).action(action).build();
  const net = PetriNet.builder('one-shot').transitions(t).build();
  const marking = await new BitmapNetExecutor(net, seeded([src, srcTokens]), {
    eventStore: store,
  }).run();
  return {
    failures: failureMessages(store),
    logs: logMessages(store),
    counts: {
      A: marking.tokenCount(A),
      B: marking.tokenCount(B),
      C: marking.tokenCount(C),
      src: marking.tokenCount(src),
    },
    completions: store.events().filter(e => e.type === 'transition-completed').length,
  };
}

describe('(B) Out spec validation exactness [IO-015, IO-016, CORE-043]', () => {
  it('CORE-043 is a *compile* error, not a builder error, and names the transition', () => {
    const ghost = Transition.builder('ghost')
      .inputs(one(src))
      .outputs(outPlace(A))
      .action(passthrough())
      .build();
    const net = PetriNet.builder('ghost-net').transitions(ghost).build();

    // The builder accepts it. Nothing on the authoring path rejects a declared output paired
    // with the built-in passthrough — the check lives at compilation, which is where the
    // compiler's `CompiledWorkflow` would first hit it.
    expect(net.transitions.size).toBe(1);

    const names = /Transition 'ghost' declares an output spec but carries passthrough\(\)/;
    expect(() => PrecompiledNet.compile(net)).toThrow(names);
    expect(() => new BitmapNetExecutor(net, new Map())).toThrow(names);
    expect(() => new PrecompiledNetExecutor(net, new Map())).toThrow(names);
    // Verification rejects the same net, so a proof cannot green-light what will not compile.
    expect(() => StateClassGraph.build(net, MarkingState.empty(), 50)).toThrow(names);
  });

  it('teeth: the same topology compiles once the action produces, and a sink may keep passthrough', () => {
    // The mutations checked: (1) replace passthrough with a producing action — the rejection
    // disappears, so it is the action identity being rejected and not the topology; (2) drop
    // the output spec — a sink carrying passthrough compiles, so the check is not "passthrough
    // is banned".
    const producing = Transition.builder('ghost')
      .inputs(one(src))
      .outputs(outPlace(A))
      .action(async ctx => {
        ctx.output(A, ctx.input(src));
      })
      .build();
    expect(() => PrecompiledNet.compile(
      PetriNet.builder('producing').transitions(producing).build(),
    )).not.toThrow();

    const sink = Transition.builder('sink').inputs(one(src)).action(passthrough()).build();
    expect(() => PrecompiledNet.compile(
      PetriNet.builder('sink-net').transitions(sink).build(),
    )).not.toThrow();
  });

  it('writing to a place outside this transition\'s spec throws at fire time, net-declared or not', async () => {
    // B is a genuine place of this net — t2 declares it — and the write is still refused.
    // The gate is `TransitionContext.requireOutput`, built from *this* transition's out spec,
    // so the [CORE-072] "produced to an undeclared place" path is not reachable from an
    // ordinary action at all: the context refuses before the marking is ever touched.
    const store = new InMemoryEventStore();
    const t1 = Transition.builder('t1')
      .inputs(one(src))
      .outputs(outPlace(A))
      .action(async ctx => {
        ctx.output(B, 'stolen');
      })
      .build();
    const t2 = Transition.builder('t2')
      .inputs(one(A))
      .outputs(outPlace(B))
      .action(async ctx => {
        ctx.output(B, ctx.input(A));
      })
      .build();
    const net = PetriNet.builder('cross').transitions(t1, t2).build();
    expect([...net.places].map(p => p.name).sort()).toEqual(['A', 'B', 'src']);

    const marking = await new BitmapNetExecutor(net, seeded([src, ['x']]), {
      eventStore: store,
    }).run();

    expect(failureMessages(store)).toEqual(["Error: Place 'B' not in declared outputs: [A]"]);
    // Nothing anywhere: the input is consumed and not restored [EXEC-031], and t2 never runs.
    expect([marking.tokenCount(src), marking.tokenCount(A), marking.tokenCount(B)]).toEqual([0, 0, 0]);
  });

  it('writing nothing against a spec that requires a token fails at fire time [IO-015 AC6]', async () => {
    const report = await fireOnce(outPlace(A), async () => {});

    expect(report.failures).toEqual([
      "OutViolationError: 't': output does not match the declared spec - produced {}, " +
        'which no single branch of the spec claims exactly',
    ]);
    expect(report.counts.A).toBe(0);
    expect(report.completions).toBe(0);
  });

  it('writing both branches of an xor is "no branch claims this", not "ambiguous"', async () => {
    // [IO-015] compares for *equality*, so {A, B} is explained by neither {A} nor {B}. The
    // diagnostic wording matters to us: an engine reading errorMessage must not expect the
    // word "ambiguous" here.
    const report = await fireOnce(xor(outPlace(A), outPlace(B)), async ctx => {
      ctx.output(A, 'v');
      ctx.output(B, 'v');
    });

    expect(report.failures).toEqual([
      "OutViolationError: 't': output does not match the declared spec - produced {A, B}, " +
        'which no single branch of the spec claims exactly',
    ]);
    // Neither branch is deposited — a violating firing writes nothing at all.
    expect(report.counts).toEqual({ A: 0, B: 0, C: 0, src: 0 });
  });

  it('teeth: writing exactly one branch of the same xor succeeds', async () => {
    // The mutation checked: drop the second write. The identical spec now validates and
    // deposits, so the failure above is caused by the extra write, not by the spec shape.
    const report = await fireOnce(xor(outPlace(A), outPlace(B)), async ctx => {
      ctx.output(A, 'v');
    });

    expect(report.failures).toEqual([]);
    expect(report.counts).toEqual({ A: 1, B: 0, C: 0, src: 0 });
  });

  it('"ambiguous" is a distinct verdict, and subsumption is not ambiguity [IO-015 AC4, AC5]', async () => {
    // Two branches claiming the *same* set is the genuine ambiguity case.
    const ambiguous = await fireOnce(
      xor(and(outPlace(A), outPlace(B)), and(outPlace(B), outPlace(A))),
      async ctx => {
        ctx.output(A, 'v');
        ctx.output(B, 'v');
      },
    );
    expect(ambiguous.failures).toEqual([
      "OutViolationError: 't': ambiguous output - {A, B} is claimed by more than one branch",
    ]);
    expect(ambiguous.counts).toEqual({ A: 0, B: 0, C: 0, src: 0 });

    // Teeth for the same predicate: overlapping branches where only the wider one is written
    // exactly. No tie-break is applied and no subsumption rule is needed — it simply succeeds.
    const overlapping = await fireOnce(
      xor(and(outPlace(A), outPlace(B), outPlace(C)), and(outPlace(A), outPlace(B))),
      async ctx => {
        ctx.output(A, 'v');
        ctx.output(B, 'v');
        ctx.output(C, 'v');
      },
    );
    expect(overlapping.failures).toEqual([]);
    expect(overlapping.counts).toEqual({ A: 1, B: 1, C: 1, src: 0 });
  });

  it('writing twice to a place an and names once validates, deposits both, and warns once [IO-016]', async () => {
    // [IO-015] validates the produced *set* — "a spec names places, not counts" — so an action
    // that deposits several tokens into one claimed place conforms, by specification. It is not
    // silent: [IO-016 AC4] requires one WARN log-message event per transition per execution, so
    // the second firing's duplication is not reported again. (This test was once titled
    // "SILENT"; it always asserted the WARN. The deposit is silent to validation, not to the
    // event stream.)
    const report = await fireOnce(
      and(outPlace(A), outPlace(B)),
      async ctx => {
        ctx.output(A, 'v', 'w');
        ctx.output(B, 'v');
      },
      ['x', 'y'],
    );

    expect(report.failures).toEqual([]);
    expect(report.completions).toBe(2);
    expect(report.counts).toEqual({ A: 4, B: 2, C: 0, src: 0 });
    expect(report.logs).toHaveLength(1);
    expect(report.logs[0]).toEqual({
      logger: 'libpetri.runtime',
      level: 'WARN',
      message:
        "'t': wrote more than one token to a place its output spec names once (A: 2); " +
        'branch-enumerating analyses model one token per named place, so this firing ' +
        'exceeds what they explore (IO-016)',
    });
  });

  it('teeth: one token per named place emits no warning', async () => {
    // The mutation checked: write A once. The WARN disappears, so its presence above tracks
    // multiplicity rather than being emitted for every `and`.
    const report = await fireOnce(and(outPlace(A), outPlace(B)), async ctx => {
      ctx.output(A, 'v');
      ctx.output(B, 'v');
    });

    expect(report.logs).toEqual([]);
    expect(report.counts).toEqual({ A: 1, B: 1, C: 0, src: 0 });
  });

  it('SILENT to the caller: run() resolves normally however many firings failed', async () => {
    // This is the trap the engine has to work around: no fire-time failure reaches the caller
    // of run(). The promise resolves with a marking, the consumed tokens are gone [EXEC-031],
    // and the net simply stalls with nothing downstream. Anything that reports workflow
    // outcome must read the event store or the marking — never rely on run() rejecting.
    const store = new InMemoryEventStore();
    const bad = Transition.builder('bad')
      .inputs(one(src))
      .outputs(outPlace(A))
      .action(async () => {})
      .build();
    const net = PetriNet.builder('stall').transitions(bad).build();

    const marking = await new BitmapNetExecutor(net, seeded([src, ['x', 'y', 'z']]), {
      eventStore: store,
    }).run();

    expect(failureMessages(store)).toHaveLength(3);
    expect(marking.tokenCount(src)).toBe(0);
    expect(marking.tokenCount(A)).toBe(0);
  });

  it('decide-then-emit is necessary: writing both branches strands the flow entirely', async () => {
    // The exact shape `stepGadget` compiles — xor(next, failed) — with the discipline broken:
    // a try/catch that writes the success branch and then writes the failure branch from its
    // handler. Both writes land in one produced set, [IO-015] refuses it, and *neither* token
    // is deposited. The step's input is consumed, so the workflow has no token anywhere and
    // no failure branch either. Decide-then-emit is load-bearing, not stylistic.
    const next = place<string>('A');
    const failed = place<string>('B');
    const report = await fireOnce(xor(outPlace(next), outPlace(failed)), async ctx => {
      try {
        ctx.output(next, 'optimistic');
        throw new Error('step blew up after the write');
      } catch (error) {
        ctx.output(failed, String(error));
      }
    });

    expect(report.failures).toEqual([
      "OutViolationError: 't': output does not match the declared spec - produced {A, B}, " +
        'which no single branch of the spec claims exactly',
    ]);
    expect(report.counts).toEqual({ A: 0, B: 0, C: 0, src: 0 });
  });

  it('a write made before a throw is discarded with the firing [EXEC-030]', async () => {
    // A failed action never reaches output validation: the executor sees the rejection and
    // skips the deposit loop outright. So a partial write is lost rather than half-applied —
    // which is why `stepAction` converting a runner throw into the failure branch, instead of
    // letting it propagate, is what keeps the flow token alive.
    const report = await fireOnce(outPlace(A), async ctx => {
      ctx.output(A, 'v');
      throw new Error('boom');
    });

    expect(report.failures).toEqual(['Error: boom']);
    expect(report.counts.A).toBe(0);
  });

  it('SILENT: skipOutputValidation deposits both xor branches without a murmur', async () => {
    // Why the hard rule forbids it. With validation off, the decide-then-emit violation above
    // becomes a success: both branches receive a token, the workflow forks in two, and nothing
    // — no failure, no warning — records that the transition's own spec was contradicted. Only
    // the precompiled backend exposes the option; the bitmap executor has no such switch.
    const store = new InMemoryEventStore();
    const bad = Transition.builder('bad')
      .inputs(one(src))
      .outputs(xor(outPlace(A), outPlace(B)))
      .action(async ctx => {
        ctx.output(A, 'v');
        ctx.output(B, 'v');
      })
      .build();
    const net = PetriNet.builder('unvalidated').transitions(bad).build();

    const marking = await new PrecompiledNetExecutor(net, seeded([src, ['x']]), {
      eventStore: store,
      skipOutputValidation: true,
    }).run();

    expect(failureMessages(store)).toEqual([]);
    expect(logMessages(store)).toEqual([]);
    expect([marking.tokenCount(A), marking.tokenCount(B)]).toEqual([1, 1]);
  });

  it('teeth: the same net and backend with validation left on refuses the firing', async () => {
    // The mutation checked: drop skipOutputValidation. The identical net on the identical
    // backend now fails the firing and deposits nothing, so the silence above is the option's
    // doing and not a property of the precompiled executor.
    const store = new InMemoryEventStore();
    const bad = Transition.builder('bad')
      .inputs(one(src))
      .outputs(xor(outPlace(A), outPlace(B)))
      .action(async ctx => {
        ctx.output(A, 'v');
        ctx.output(B, 'v');
      })
      .build();
    const net = PetriNet.builder('validated').transitions(bad).build();

    const marking = await new PrecompiledNetExecutor(net, seeded([src, ['x']]), {
      eventStore: store,
    }).run();

    expect(failureMessages(store)).toHaveLength(1);
    expect([marking.tokenCount(A), marking.tokenCount(B)]).toEqual([0, 0]);
  });
});

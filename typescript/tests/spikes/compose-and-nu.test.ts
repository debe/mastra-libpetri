import { describe, expect, it } from 'vitest';
import {
  BitmapNetExecutor,
  Interface,
  PetriNet,
  SubnetDef,
  TokenInput,
  TokenOutput,
  Transition,
  TransitionContext,
  and,
  inMemoryEventStore,
  one,
  outPlace,
  place,
  tokenAt,
} from 'libpetri';
import type {
  BitmapNetExecutorOptions,
  Marking,
  Place,
  Token,
  TransitionFailed,
} from 'libpetri';

/**
 * Spike — composition name collisions, the instantiate -> bind -> re-instantiate round-trip,
 * and ν-name minting.
 *
 * A spike pins a libpetri behaviour the compiler already leans on, so an upgrade that changes
 * the behaviour breaks this build loudly instead of miscompiling quietly. Nothing here tests
 * our own code; every assertion is about the linked libpetri tree.
 *
 * Three groups:
 *
 * - **(A)** Name collisions under three different routes — a flat builder, `compose(SubnetDef)`
 *   places, and `compose(SubnetDef)` transitions — because they behave three different ways
 *   ([CORE-010], [MOD-025]). `NameVocabulary.assertUnique` exists for exactly the first of them.
 * - **(B)** The declared -> actual place correspondence across three rewrite passes
 *   ([MOD-031] AC#8). Its regression mode is silent token loss, not a build error.
 * - **(C)** Fresh-name minting format, ordering and resume safety ([NU-010], [NU-011]).
 *
 * Every `it` that asserts a behaviour holds also runs the mutation that flips it, in the same
 * test, so no assertion here can pass vacuously. The mutation is named in a comment above each.
 *
 * Two observations contradict `libpetri/spec/12-nu-nets.md` as it now reads. They are pinned as
 * **observed**, not as the spec would have them — see `describe('[NU-011] ...')`.
 */

// ============================================================
//  Shared helpers
// ============================================================

/**
 * Runs to quiescence and stops the executor. `run(ms, 'close')` rather than the default
 * `'abandon'` policy, whose loop keeps firing after the promise rejects.
 */
async function runToQuiescence(
  net: PetriNet,
  seed: Map<Place<any>, Token<any>[]>,
  options: BitmapNetExecutorOptions = {},
): Promise<Marking> {
  const executor = new BitmapNetExecutor(net, seed, options);
  try {
    return await executor.run(5_000, 'close');
  } finally {
    executor.close();
  }
}

/** Every place holding at least one token, by name. The shape a token-loss test asserts on. */
function census(net: PetriNet, marking: Marking): Record<string, number> {
  const held: Record<string, number> = {};
  for (const p of net.places) {
    const n = marking.tokenCount(p);
    if (n > 0) held[p.name] = n;
  }
  return held;
}

/** The `Place` reference a net actually holds under `name`. `SubnetDef.fromNet` checks by reference. */
function placeNamed<T>(net: PetriNet, name: string): Place<T> {
  for (const p of net.places) if (p.name === name) return p as Place<T>;
  throw new Error(`no place named '${name}' in net '${net.name}'`);
}

const seedOf = (value: string): Token<string>[] => [tokenAt(value, 0)];

/** `"<transition>: <message>"` for every contained firing failure, in order. */
function failureMessages(events: readonly { readonly type: string }[]): string[] {
  return events
    .filter((e): e is TransitionFailed => e.type === 'transition-failed')
    .map((e) => `${e.transitionName}: ${e.errorMessage}`);
}

// ============================================================
//  (A) Compose name collisions
// ============================================================

describe('[CORE-010] place identity is the name string', () => {
  /**
   * Mutation checked: renaming the second place object to `'x2'` (the `it` below). The token
   * then strands in `x` and `sink` stays empty, so this assertion is capable of failing.
   */
  it('merges two distinct same-named Place objects in one hand-built net', async () => {
    const xA = place<string>('x');
    const xB = place<string>('x');
    expect(xA).not.toBe(xB);

    const src = place<string>('src');
    const sink = place<string>('sink');

    const net = PetriNet.builder('flat')
      .transitions(
        Transition.builder('emit')
          .inputs(one(src))
          .outputs(outPlace(xA))
          .action(async (ctx) => {
            ctx.output(xA, `${ctx.input(src)}>A`);
          })
          .build(),
        Transition.builder('consume')
          .inputs(one(xB)) // the *other* object — never passed to `emit`
          .outputs(outPlace(sink))
          .action(async (ctx) => {
            ctx.output(sink, `${ctx.input(xB)}>B`);
          })
          .build(),
      )
      .build();

    // The net's own place set is a Set by reference, so it still reports both objects...
    expect([...net.places].filter((p) => p.name === 'x')).toHaveLength(2);

    // ...but the compiled net indexes places by name, so they are one slot and the token
    // deposited through `xA` is consumed through `xB`.
    const marking = await runToQuiescence(net, new Map([[src, seedOf('t')]]));
    expect(census(net, marking)).toEqual({ sink: 1 });
  });

  /** The mutation. Same net, one character of one name changed; the merge stops happening. */
  it('does not merge when the two names differ — the assertion above has teeth', async () => {
    const xA = place<string>('x');
    const xB = place<string>('x2');

    const src = place<string>('src');
    const sink = place<string>('sink');

    const net = PetriNet.builder('flat-distinct')
      .transitions(
        Transition.builder('emit')
          .inputs(one(src))
          .outputs(outPlace(xA))
          .action(async (ctx) => {
            ctx.output(xA, `${ctx.input(src)}>A`);
          })
          .build(),
        Transition.builder('consume')
          .inputs(one(xB))
          .outputs(outPlace(sink))
          .action(async (ctx) => {
            ctx.output(sink, `${ctx.input(xB)}>B`);
          })
          .build(),
      )
      .build();

    const marking = await runToQuiescence(net, new Map([[src, seedOf('t')]]));
    expect(census(net, marking)).toEqual({ x: 1 });
  });

  /**
   * The asymmetry that makes a name-collision audit necessary rather than optional: libpetri
   * transitions use **reference** equality (`Transition`: "each instance is unique regardless of
   * name"), so a duplicated transition name does not merge and does not throw — it doubles.
   *
   * Mutation checked: dropping the second transition (the `it` below). `sinkB` is then empty, so
   * this assertion detects the presence of two live transitions rather than asserting a tautology.
   */
  it('does NOT merge two distinct same-named Transition objects — they both fire', async () => {
    const src = place<string>('src');
    const sinkA = place<string>('sinkA');
    const sinkB = place<string>('sinkB');

    const net = PetriNet.builder('dup-transition')
      .transitions(
        Transition.builder('step')
          .inputs(one(src))
          .outputs(outPlace(sinkA))
          .priority(10)
          .action(async (ctx) => {
            ctx.output(sinkA, ctx.input(src));
          })
          .build(),
        Transition.builder('step') // same name, different object
          .inputs(one(src))
          .outputs(outPlace(sinkB))
          .priority(1)
          .action(async (ctx) => {
            ctx.output(sinkB, ctx.input(src));
          })
          .build(),
      )
      .build();

    expect([...net.transitions].filter((t) => t.name === 'step')).toHaveLength(2);

    const marking = await runToQuiescence(net, new Map([[src, [tokenAt('u', 0), tokenAt('v', 0)]]]));
    expect(census(net, marking)).toEqual({ sinkA: 1, sinkB: 1 });
  });

  /** The mutation: one transition instead of two. `sinkB` never fills. */
  it('fills only one sink with a single transition — the duplication assertion has teeth', async () => {
    const src = place<string>('src');
    const sinkA = place<string>('sinkA');
    const sinkB = place<string>('sinkB');

    const net = PetriNet.builder('single-transition')
      .places(sinkB)
      .transitions(
        Transition.builder('step')
          .inputs(one(src))
          .outputs(outPlace(sinkA))
          .action(async (ctx) => {
            ctx.output(sinkA, ctx.input(src));
          })
          .build(),
      )
      .build();

    const marking = await runToQuiescence(net, new Map([[src, [tokenAt('u', 0), tokenAt('v', 0)]]]));
    expect(census(net, marking)).toEqual({ sinkA: 2 });
  });
});

describe('[MOD-025] direct composition merges places by name and rejects transitions by name', () => {
  /** Builds a one-transition subnet that writes `'<in>>A'` into a place named `sharedName`. */
  function producerSubnet(sharedName: string): {
    readonly def: SubnetDef<void>;
    readonly source: Place<string>;
  } {
    const source = place<string>('A.src');
    const shared = place<string>(sharedName);
    return {
      source,
      def: SubnetDef.builder<void>('A')
        .transition(
          Transition.builder('A.emit')
            .inputs(one(source))
            .outputs(outPlace(shared))
            .action(async (ctx) => {
              ctx.output(shared, `${ctx.input(source)}>A`);
            })
            .build(),
        )
        .build(),
    };
  }

  /** Builds a one-transition subnet that reads a place named `'x'` into `'B.sink'`. */
  function consumerSubnet(transitionName: string): {
    readonly def: SubnetDef<void>;
    readonly sink: Place<string>;
  } {
    const shared = place<string>('x');
    const sink = place<string>('B.sink');
    return {
      sink,
      def: SubnetDef.builder<void>('B')
        .transition(
          Transition.builder(transitionName)
            .inputs(one(shared))
            .outputs(outPlace(sink))
            .action(async (ctx) => {
              ctx.output(sink, `${ctx.input(shared)}>B`);
            })
            .build(),
        )
        .build(),
    };
  }

  /**
   * Mutation checked: the producer declaring `'x_producer'` instead of `'x'` (the `it` below).
   * The two subnets then never touch and `B.sink` stays empty.
   */
  it('merges the two subnets’ same-named places silently — no error, one slot, tokens cross', async () => {
    const producer = producerSubnet('x');
    const consumer = consumerSubnet('B.consume');

    // Neither subnet mentions the other. The only thing they share is the string 'x'.
    const net = PetriNet.builder('host').compose(producer.def).compose(consumer.def).build();

    expect([...net.places].filter((p) => p.name === 'x')).toHaveLength(1);

    const marking = await runToQuiescence(net, new Map([[producer.source, seedOf('t')]]));
    expect(census(net, marking)).toEqual({ 'B.sink': 1 });

    const sink = placeNamed<string>(net, 'B.sink');
    expect(marking.tokenCount(sink)).toBe(1);
  });

  /** The mutation. One character of the producer's place name; the composition stops connecting. */
  it('leaves the subnets disconnected when the names differ — the merge assertion has teeth', async () => {
    const producer = producerSubnet('x_producer');
    const consumer = consumerSubnet('B.consume');

    const net = PetriNet.builder('host-distinct').compose(producer.def).compose(consumer.def).build();

    expect([...net.places].filter((p) => p.name === 'x')).toHaveLength(1);
    expect([...net.places].filter((p) => p.name === 'x_producer')).toHaveLength(1);

    const marking = await runToQuiescence(net, new Map([[producer.source, seedOf('t')]]));
    expect(census(net, marking)).toEqual({ x_producer: 1 });
  });

  /**
   * Transitions are the opposite case under direct composition: a name collision is rejected at
   * compose time, naming the transition and both nets.
   *
   * Mutation checked: giving the consumer's transition a different name (the assertion pair
   * below), which composes without complaint.
   */
  it('throws on a transition name collision, naming the transition and both nets', () => {
    const producer = producerSubnet('x');
    const collides = consumerSubnet('A.emit'); // same transition name as the producer's

    expect(() =>
      PetriNet.builder('host-collide').compose(producer.def).compose(collides.def),
    ).toThrow(/transition 'A\.emit' from subnet 'B' collides with a transition already in net 'host-collide'/);

    // The mutation: rename the transition, and the identical composition succeeds.
    const renamed = consumerSubnet('B.consume');
    expect(() =>
      PetriNet.builder('host-ok').compose(producer.def).compose(renamed.def),
    ).not.toThrow();
  });
});

// ============================================================
//  (B) instantiate -> bind-to-a-same-named-host-place -> re-instantiate
// ============================================================

/**
 * [MOD-031] AC#8. The shape a nested Mastra workflow takes, and the one whose regression is
 * silent token loss: the action's declared place is resolved through the transition's
 * declared -> actual correspondence, so an entry dropped at an intermediate pass leaves a later
 * pass nothing to rewrite — and the check that catches it runs *after* the inputs are consumed.
 *
 * Three passes are needed. At two passes the identity-bound place's actual name still equals its
 * declared name, so a lookup that tries the literal name first resolves it whatever the
 * correspondence did.
 */
describe('[MOD-031] declared place resolution across instantiate -> bind -> re-instantiate', () => {
  /** The author-original places the action hardcodes. */
  const declIn = place<string>('x'); // exposed as port 'x'
  const declOut = place<string>('out'); // exposed as port 'out'
  const declLog = place<string>('y'); // internal — renamed at every pass

  /** Author `T`: one transition whose action references all three declared places by constant. */
  function authorT(): SubnetDef<void> {
    return SubnetDef.builder<void>('T')
      .transition(
        Transition.builder('T.step')
          .inputs(one(declIn))
          .outputs(and(outPlace(declOut), outPlace(declLog)))
          .action(async (ctx) => {
            const v = ctx.input(declIn);
            ctx.output(declLog, `${v}:seen`);
            ctx.output(declOut, `${v}:done`);
          })
          .build(),
      )
      .inputPort('x', declIn)
      .outputPort('out', declOut)
      .build();
  }

  /**
   * Pass 1 + 2. Instantiate under `p1`, then bind port `x` to a bare host place **also named
   * `x`** — that equality is what makes the entry an identity, and is what triggered the
   * original defect — while port `out` binds to a differently-named host place.
   */
  function passOneAndTwo(): PetriNet {
    const hostX = place<string>('x'); // bare, same name as the declared port
    const hostSink = place<string>('sink');
    return PetriNet.builder('pass2')
      .compose(authorT().instantiate('p1'), { x: hostX, out: hostSink })
      .build();
  }

  /** Pass 3 + 4. Retrofit the composed net as a subnet, instantiate again, bind both ports. */
  function passThreeAndFour(pass2: PetriNet): {
    readonly net: PetriNet;
    readonly feed: Place<string>;
  } {
    const iface = Interface.builder()
      .inputPort('x', placeNamed<string>(pass2, 'x'))
      .outputPort('out', placeNamed<string>(pass2, 'sink'))
      .build();

    const feed = place<string>('feed');
    const done = place<string>('done');
    const net = PetriNet.builder('final')
      .compose(SubnetDef.fromNet(pass2, iface).instantiate('p2'), { x: feed, out: done })
      .build();
    return { net, feed };
  }

  it('resolves both declared places through three renames and delivers the token', async () => {
    const pass2 = passOneAndTwo();

    // Pass 2 left the identity entry in place — it is the only carrier of the author-original
    // key `x`, because the arcs now read 'x' only by coincidence of the binding.
    const composed = [...pass2.transitions].find((t) => t.name === 'p1/T.step');
    expect(composed).toBeDefined();
    expect([...composed!.placeAlias].map(([k, v]) => `${k}->${v.name}`).sort()).toEqual([
      'out->sink',
      'x->x',
      'y->p1/y',
    ]);

    const { net, feed } = passThreeAndFour(pass2);
    const events = inMemoryEventStore();
    const marking = await runToQuiescence(net, new Map([[feed, seedOf('w')]]), { eventStore: events });

    expect(census(net, marking)).toEqual({ done: 1, 'p2/p1/y': 1 });
    expect(failureMessages(events.events())).toEqual([]);
  });

  /**
   * The negative case, and the teeth. `dropIdentityEntries` reproduces the old per-entry
   * identity filter exactly: the entry `x -> x` is discarded at pass 2 because its actual name
   * equals its declared name. Everything downstream is byte-for-byte the same construction as
   * the passing test.
   *
   * Mutation checked: this *is* the mutation — filtering identities per entry rather than only
   * wholesale. The token does not merely go to the wrong place; it ends up in no place at all.
   */
  it('loses the token when the identity entry is dropped at the intermediate pass', async () => {
    const pass2 = passOneAndTwo();

    const defective = PetriNet.builder('pass2-defective')
      .places(...pass2.places)
      .transitions(...[...pass2.transitions].map(dropIdentityEntries))
      .build();

    const broken = [...defective.transitions].find((t) => t.name === 'p1/T.step');
    expect([...broken!.placeAlias].map(([k, v]) => `${k}->${v.name}`).sort()).toEqual([
      'out->sink',
      'y->p1/y',
    ]);

    const { net, feed } = passThreeAndFour(defective);
    const events = inMemoryEventStore();
    const marking = await runToQuiescence(net, new Map([[feed, seedOf('w')]]), { eventStore: events });

    // The transition enabled and consumed, then failed its declared-place check against a place
    // that pass 3 renamed away — the exact consume-then-throw [EXEC-031] shape MOD-031 names.
    expect(failureMessages(events.events())).toEqual([
      "p2/p1/T.step: Place 'x' not in declared inputs: [feed]",
    ]);

    // Consumed, then rejected: the token is in no place. Not `done`, not the log, not `feed`.
    expect(census(net, marking)).toEqual({});
  });

  /**
   * Rebuilds a transition with every identity entry removed from its declared -> actual
   * correspondence — the [MOD-031] place-alias defect, reconstructed from public surface.
   */
  function dropIdentityEntries(t: Transition): Transition {
    const filtered = new Map<string, Place<any>>();
    for (const [declared, actual] of t.placeAlias) {
      if (actual.name !== declared) filtered.set(declared, actual);
    }

    const builder = Transition.builder(t.name)
      .timing(t.timing)
      .priority(t.priority)
      .action(t.action);
    if (filtered.size > 0) builder.placeAlias(filtered);
    if (t.inputSpecs.length > 0) builder.inputs(...t.inputSpecs);
    if (t.outputSpec !== null) builder.outputs(t.outputSpec);
    for (const inh of t.inhibitors) builder.inhibitor(inh.place);
    for (const r of t.reads) builder.read(r.place);
    for (const r of t.resets) builder.reset(r.place);
    if (t.matchSpec !== null) builder.match(t.matchSpec);
    return builder.build();
  }
});

// ============================================================
//  (C) ν fresh-name minting
// ============================================================

/** Splits `<transition>#<scope>:<n>` by the documented rule: last `:`, then the last `#` before it. */
function parseMinted(name: string): { transition: string; scope: string; counter: number } {
  const colon = name.lastIndexOf(':');
  if (colon < 0) throw new Error(`not an executor-minted name (no ':'): ${name}`);
  const hash = name.lastIndexOf('#', colon);
  if (hash < 0) throw new Error(`not an executor-minted name (no '#'): ${name}`);
  return {
    transition: name.slice(0, hash),
    scope: name.slice(hash + 1, colon),
    counter: Number(name.slice(colon + 1)),
  };
}

/**
 * A net whose two transitions each mint one name and push it into `minted`. Both draw from the
 * same source place, so both are enabled in the same scan and priority alone orders them.
 */
function mintingNet(
  minted: string[],
  priorities: { readonly alpha: number; readonly beta: number },
): { readonly net: PetriNet; readonly src: Place<string> } {
  const src = place<string>('src');
  const outAlpha = place<string>('out.alpha');
  const outBeta = place<string>('out.beta');

  const mint = (target: Place<string>) => async (ctx: TransitionContext) => {
    const n = ctx.freshName();
    minted.push(n);
    ctx.output(target, n);
  };

  return {
    src,
    net: PetriNet.builder('mint')
      .transitions(
        Transition.builder('alpha')
          .inputs(one(src))
          .outputs(outPlace(outAlpha))
          .priority(priorities.alpha)
          .action(mint(outAlpha))
          .build(),
        Transition.builder('beta')
          .inputs(one(src))
          .outputs(outPlace(outBeta))
          .priority(priorities.beta)
          .action(mint(outBeta))
          .build(),
      )
      .build(),
  };
}

const twoSeeds = (): Token<string>[] => [tokenAt('a', 0), tokenAt('b', 0)];

describe('[NU-010] fresh-name minting: format, uniqueness and order', () => {
  /**
   * Mutation checked: swapping the two priorities (the second `expect` block). The suffixes
   * swap with them, so the assertion is reading the firing order rather than a fixed answer.
   */
  it('mints <transition>#<scope>:<n> from one executor-wide counter, ordered by priority', async () => {
    const minted: string[] = [];
    const high = mintingNet(minted, { alpha: 10, beta: 1 });
    await runToQuiescence(high.net, new Map([[high.src, twoSeeds()]]), { executionScope: 'pinned' });

    expect(minted).toHaveLength(2);
    expect(minted.map(parseMinted)).toEqual([
      { transition: 'alpha', scope: 'pinned', counter: 0 },
      { transition: 'beta', scope: 'pinned', counter: 1 },
    ]);

    // The counter is per *executor*, not per transition: two transitions minting in one pass get
    // 0 and 1, never 0 and 0. The prefix is the minting transition's own name.
    expect(new Set(minted).size).toBe(2);

    // The mutation: flip the priorities and the suffixes follow the new firing order.
    const flipped: string[] = [];
    const low = mintingNet(flipped, { alpha: 1, beta: 10 });
    await runToQuiescence(low.net, new Map([[low.src, twoSeeds()]]), { executionScope: 'pinned' });
    expect(flipped.map(parseMinted)).toEqual([
      { transition: 'beta', scope: 'pinned', counter: 0 },
      { transition: 'alpha', scope: 'pinned', counter: 1 },
    ]);
  });

  /**
   * The no-executor fallback is a *different* format: `<transition>#<n>` off a process-global
   * counter, with no scope and no `':'`. This is where a bare `fork#0` can come from — never
   * from an executor.
   *
   * Mutation checked: installing a supplier (second half), after which the same context mints
   * the executor form instead.
   */
  it('falls back to <transition>#<n> with no scope when no executor installed a minter', () => {
    const out = place<string>('out');
    const bare = new TransitionContext(
      'fork',
      new TokenInput(),
      new TokenOutput(),
      new Set<Place<any>>(),
      new Set<Place<any>>(),
      new Set<Place<any>>([out]),
    );

    const first = bare.freshName();
    const second = bare.freshName();
    expect(first).toMatch(/^fork#\d+$/);
    expect(first).not.toContain(':');
    expect(second).not.toBe(first);

    // The mutation: install a minter and the format changes under the same call.
    bare.setFreshNameSupplier(() => 'fork#scope:0' as typeof first);
    expect(bare.freshName()).toBe('fork#scope:0');
  });
});

describe('[NU-011] resume safety: what actually stops a restored name from being re-minted', () => {
  /**
   * The question our codec has to answer: a second executor over the same net restarts the
   * counter at 0 — so what keeps the second run's names off the first run's?
   *
   * Answer in the linked tree: only the scope. The counter restarts; the default scope differs.
   *
   * Mutation checked: pinning both executors to the same scope (the next `it`), which makes the
   * two runs mint byte-identical names.
   */
  it('restarts the counter on a second executor but changes the default scope', async () => {
    const firstNames: string[] = [];
    const first = mintingNet(firstNames, { alpha: 10, beta: 1 });
    await runToQuiescence(first.net, new Map([[first.src, twoSeeds()]]));

    const secondNames: string[] = [];
    const second = mintingNet(secondNames, { alpha: 10, beta: 1 });
    await runToQuiescence(second.net, new Map([[second.src, twoSeeds()]]));

    // The counter restarted.
    expect(firstNames.map((n) => parseMinted(n).counter)).toEqual([0, 1]);
    expect(secondNames.map((n) => parseMinted(n).counter)).toEqual([0, 1]);

    // The scope is what keeps them apart — and it is the *only* thing that does.
    const scopeA = parseMinted(firstNames[0]!).scope;
    const scopeB = parseMinted(secondNames[0]!).scope;
    expect(scopeB).not.toBe(scopeA);
    expect(new Set([...firstNames, ...secondNames]).size).toBe(4);
  });

  /**
   * The hazard this spike exists to record for our engine. A pinned scope buys [NU-010] AC#3
   * replay stability at the cost of [NU-011] AC#4: two executors given the same scope mint
   * byte-identical names. So an engine that pins `executionScope` to a stable workflow run id,
   * to make a segment replayable, makes resume re-mint names that are live in the restored
   * marking — the silent cross-segment merge NU-011 exists to prevent.
   *
   * Mutation checked: distinct pinned scopes (second half), after which the names are disjoint.
   */
  it('re-mints identical names across two executors when the host pins the same scope', async () => {
    const runOnce = async (scope: string): Promise<string[]> => {
      const minted: string[] = [];
      const built = mintingNet(minted, { alpha: 10, beta: 1 });
      await runToQuiescence(built.net, new Map([[built.src, twoSeeds()]]), { executionScope: scope });
      return minted;
    };

    const a = await runOnce('wf-run-1');
    const b = await runOnce('wf-run-1');
    expect(b).toEqual(a); // a collision, exactly as NU-011 AC#4 forbids — and opt-in

    // The mutation: distinct scopes, and the same two runs no longer overlap at all.
    const c = await runOnce('wf-run-2');
    expect(new Set([...a, ...c]).size).toBe(4);
  });

  /**
   * A restored marking carrying the *fallback* form (`fork#0`) cannot collide with anything an
   * executor mints, whatever the scope: the executor form always carries a `':'` and the
   * fallback form never does.
   *
   * Mutation checked: asserting against the executor-form name `fork#0:0` instead (second half),
   * which the default-scope run does not produce either — the separator is doing the work, not
   * luck.
   */
  it('never re-mints a restored fallback-form name, because the executor form carries a scope', async () => {
    const minted: string[] = [];
    const src = place<string>('src');
    const held = place<string>('held');
    const out = place<string>('out');

    const net = PetriNet.builder('restore')
      .places(held)
      .transitions(
        Transition.builder('fork')
          .inputs(one(src))
          .outputs(outPlace(out))
          .action(async (ctx) => {
            const n = ctx.freshName();
            minted.push(n);
            ctx.output(out, n);
          })
          .build(),
      )
      .build();

    // A marking restored from a prior segment, already holding `fork#0`.
    const restore = new Map<string, readonly Token<unknown>[]>([
      ['held', [tokenAt('fork#0', 0)]],
      ['src', [tokenAt('go', 0)]],
    ]);
    const marking = await runToQuiescence(net, new Map(), { restore });

    expect(minted).toHaveLength(1);
    expect(minted[0]).not.toBe('fork#0');
    expect(minted[0]).toContain(':');
    expect(parseMinted(minted[0]!).transition).toBe('fork');
    expect(marking.tokenCount(held)).toBe(1);

    // The mutation: the executor-form name built from the fallback's own digits is not minted
    // either, so the guarantee rests on the scope and not on the shape of the restored value.
    expect(minted[0]).not.toBe('fork#0:0');
  });

  /**
   * The default scope is 32 lowercase hex characters from the platform random source
   * ([NU-011] AC#5) — deliberately *not* the run identifier, so a resume in a fresh process
   * cannot collide with the process that wrote the snapshot.
   *
   * **This test has history, and the history is the point.** When it was first written the
   * linked tree defaulted the scope to `(executionIdCounter++).toString(16)`, a per-process
   * monotone counter, and it was pinned that way — as observed, not as specified — with the
   * assertions deliberately phrased so the spec-conforming implementation would break them.
   * It then broke, mid-session, when the scope was implemented upstream. That is the tripwire
   * working: a spike pins what the tree does so that a change to what it does is loud.
   *
   * Teeth: both halves distinguish the implementations rather than merely accepting the
   * current one. A counter scope fails the length assertion, and any per-process sequence
   * fails the distinctness assertion.
   */
  it('draws the default scope from the platform random source, 32 lowercase hex [NU-011 AC#5]', async () => {
    const scopeOf = async (): Promise<string> => {
      const minted: string[] = [];
      const built = mintingNet(minted, { alpha: 10, beta: 1 });
      await runToQuiescence(built.net, new Map([[built.src, twoSeeds()]]));
      return parseMinted(minted[0]!).scope;
    };

    const first = await scopeOf();
    const second = await scopeOf();

    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second).toMatch(/^[0-9a-f]{32}$/);

    // Distinct per executor, and specifically NOT the consecutive counter this used to be:
    // the old default made `second === first + 1`, which is what made a resume collide.
    expect(second).not.toBe(first);
    expect(Number.parseInt(second, 16)).not.toBe(Number.parseInt(first, 16) + 1);
  });

  /**
   * A host-supplied scope containing `'#'` is rejected at construction ([NU-011] AC#6),
   * because `'#'` is the scope separator in a minted name: without the ban, transition `a`
   * under scope `b#c` and transition `a#b` under scope `c` both mint `a#b#c:0`.
   *
   * Rejected rather than escaped — escaping would let two distinct scopes produce the same
   * name, which is the collision the requirement exists to prevent.
   *
   * **Also previously pinned the other way.** The linked tree policed only `''` and `':'` when
   * this was written, and the collision was constructible; it is not any more. What the test
   * keeps from that version is the collision's arithmetic, asserted on the name strings
   * directly, so the reason for the ban stays visible rather than becoming folklore.
   */
  it('rejects a scope containing # at construction, so the ambiguous name is unreachable [NU-011 AC#6]', () => {
    const src = place<string>('src');
    const out = place<string>('out');
    const netFor = (transitionName: string): PetriNet =>
      PetriNet.builder('scoped')
        .transitions(
          Transition.builder(transitionName)
            .inputs(one(src))
            .outputs(outPlace(out))
            .action(async (ctx) => {
              ctx.output(out, ctx.freshName());
            })
            .build(),
        )
        .build();

    // Why the ban exists: `<transition>#<scope>:<n>` is ambiguous if either side may contain
    // the separator. These two unrelated origins would render to one identical name.
    expect(`${'a'}#${'b#c'}:0`).toBe(`${'a#b'}#${'c'}:0`);

    // And the ban makes the left origin unconstructible.
    expect(() => new BitmapNetExecutor(netFor('a'), new Map(), { executionScope: 'b#c' })).toThrow(
      /must not contain ':' or '#'/,
    );
    expect(() => new BitmapNetExecutor(netFor('a'), new Map(), { executionScope: 'b:c' })).toThrow(
      /must not contain ':' or '#'/,
    );
    expect(() => new BitmapNetExecutor(netFor('a'), new Map(), { executionScope: '' })).toThrow(
      /non-empty/,
    );

    // Teeth: the validator rejects those and only those — a scope that carries neither
    // separator is still accepted, so the assertions above are not passing on a blanket throw.
    expect(() => new BitmapNetExecutor(netFor('a'), new Map(), { executionScope: 'b-c' })).not.toThrow();

    // A transition name MAY contain them; only the host-supplied scope is policed, and the
    // name still parses because the last ':' and the last '#' before it are the delimiters.
    expect(() => new BitmapNetExecutor(netFor('a#b'), new Map(), { executionScope: 'c' })).not.toThrow();
  });
});

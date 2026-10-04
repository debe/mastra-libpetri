import { describe, expect, it } from 'vitest';
import {
  BitmapNetExecutor,
  FusionSet,
  Interface,
  PetriNet,
  SubnetDef,
  Transition,
  inMemoryEventStore,
  one,
  outPlace,
  place,
  tokenOf,
} from 'libpetri';
import type { Marking, Place, Token, TransitionFailed } from 'libpetri';
import { RUN_SCOPE_KEY, compile } from '../../src/compiler/index.js';
import type { CompiledWorkflow, EntryDescription, FlowToken, StepDescription } from '../../src/compiler/types.js';
import { KernelRunScope } from '../../src/engine/index.js';
import { RecordingRunner } from '../fixtures/runner.js';

/**
 * The instantiate -> fuse -> re-instantiate round-trip ([MOD-031]) on the shape a nested workflow
 * takes: a **compiled** workflow wrapped as a subnet, instantiated under a prefix inside a parent,
 * its cancel signal fused with the parent's, and the parent itself re-instantiated one level
 * further down — then run on libpetri's executor with the run scope the kernel would hand it.
 *
 * Why the compiled net and not a hand-built one (`tests/spikes/compose-and-nu.test.ts` (B) pins
 * the libpetri behaviour on a toy): every compiled action addresses its places by the constant it
 * was built with — `ctx.input(entryPlace)`, `ctx.output(next, …)` — and composition renames those
 * places twice. The action survives only if each transition's declared -> actual correspondence
 * (`placeAlias`) carries every declared name through both renames. A regression there is not a
 * build error: the transition enables, consumes, then throws on a place it no longer knows, and the
 * token is in no place at all ([EXEC-031]).
 *
 * The parent binds the child's ports to host places carrying the **same names** as the child's
 * own (`s.0.a.in`, `wf.done`). That is the case that triggered the original defect: the first
 * pass's alias entry is an identity (`s.0.a.in -> s.0.a.in`), and dropping identities lost the
 * only record of the declared name before the second rename.
 */

const step = (id: string): StepDescription => ({ kind: 'step', id });
const fan = (id: string, arms: readonly StepDescription[]): EntryDescription => ({ kind: 'parallel', id, arms });

/** A child with a sequential edge, a fork/join and a terminal settle: every alias kind a nested body has. */
function child(): CompiledWorkflow {
  return compile({ id: 'child', entries: [step('a'), fan('fan', [step('b'), step('c')]), step('d')] });
}

interface Built {
  readonly child: CompiledWorkflow;
  readonly net: PetriNet;
  readonly feed: Place<FlowToken>;
  readonly result: Place<FlowToken>;
  readonly cancel: Place<null>;
}

/** Pass 1 + 2: the child instantiated under `child` inside a parent, ports bound, cancel fused. */
function parentOf(compiled: CompiledWorkflow): PetriNet {
  const iface = Interface.builder()
    .inputPort('in', compiled.entryPlace)
    .outputPort('done', compiled.terminals.done)
    .build();
  const instance = SubnetDef.fromNet(compiled.net, iface).instantiate('child');

  // Same names as the child's own ports: the identity-alias case.
  const hostIn = place<FlowToken>(compiled.entryPlace.name);
  const hostDone = place<FlowToken>(compiled.terminals.done.name);
  const start = place<FlowToken>('p.start');
  const returned = place<FlowToken>('p.returned');
  const parentCancel = place<null>('p.cancel');

  const call = Transition.builder('t.p.call')
    .inputs(one(start))
    .outputs(outPlace(hostIn))
    .action(async (ctx) => {
      ctx.output(hostIn, { data: ctx.input(start).data });
    })
    .build();
  const ret = Transition.builder('t.p.return')
    .inputs(one(hostDone))
    .outputs(outPlace(returned))
    .action(async (ctx) => {
      ctx.output(returned, { data: { child: ctx.input(hostDone).data } });
    })
    .build();

  return PetriNet.builder('parent')
    .transitions(call, ret)
    .compose(instance, { in: hostIn, done: hostDone })
    // The nested run shares the parent's cancellation: one signal, not two ([MOD-060], [MOD-061]).
    .fuse(FusionSet.of<null>('cancel', parentCancel, place<null>(`child/${compiled.cancel.name}`)))
    .build();
}

/** Pass 3 + 4: the parent retrofitted as a subnet and instantiated again under `outer`. */
function reInstantiated(compiled: CompiledWorkflow, parent: PetriNet): Built {
  const named = <T>(name: string): Place<T> => {
    for (const p of parent.places) if (p.name === name) return p as Place<T>;
    throw new Error(`no place '${name}' in '${parent.name}'`);
  };
  const iface = Interface.builder()
    .inputPort('in', named<FlowToken>('p.start'))
    .outputPort('out', named<FlowToken>('p.returned'))
    .inoutPort('cancel', named<null>('p.cancel'))
    .build();
  const feed = place<FlowToken>('feed');
  const result = place<FlowToken>('result');
  const cancel = place<null>('cancel');
  const net = PetriNet.builder('final')
    .compose(SubnetDef.fromNet(parent, iface).instantiate('outer'), { in: feed, out: result, cancel })
    .build();
  return { child: compiled, net, feed, result, cancel };
}

function build(mutate: (parent: PetriNet) => PetriNet = (p) => p): Built {
  const compiled = child();
  return reInstantiated(compiled, mutate(parentOf(compiled)));
}

/** Runs to quiescence with the run scope the kernel supplies, and stops with `close()`. */
async function runOn(built: Built, runner: RecordingRunner, input: unknown) {
  const scope = new KernelRunScope({ runner, initData: input });
  const events = inMemoryEventStore();
  const executor = new BitmapNetExecutor(built.net, new Map([[built.feed as Place<unknown>, [tokenOf<FlowToken>({ data: input }) as Token<unknown>]]]), {
    executionContextProvider: () => new Map<string, unknown>([[RUN_SCOPE_KEY, scope]]),
    eventStore: events,
  });
  let marking: Marking;
  try {
    marking = await executor.run(10_000, 'close');
  } finally {
    executor.close();
  }
  const failures = events
    .events()
    .filter((e): e is TransitionFailed => e.type === 'transition-failed')
    .map((e) => `${e.transitionName}: ${e.errorMessage}`);
  return { marking, failures };
}

/** Every marked place, by name — what a token-loss test asserts on. */
function census(net: PetriNet, marking: Marking): Record<string, number> {
  const held: Record<string, number> = {};
  for (const p of net.places) {
    const n = marking.tokenCount(p);
    if (n > 0) held[p.name] = n;
  }
  return held;
}

/** Where a child place ends up after both passes: a bound port's host, the fused cancel, or prefixed twice. */
function finalNameOf(built: Built, childName: string): string {
  const c = built.child;
  if (childName === c.entryPlace.name) return `outer/${childName}`; // bound to the same-named host, then renamed
  if (childName === c.terminals.done.name) return `outer/${childName}`;
  if (childName === c.cancel.name) return built.cancel.name; // fused into p.cancel, then bound to `cancel`
  return `outer/child/${childName}`;
}

/** Rebuilds a transition with every identity entry removed from its `placeAlias` — the [MOD-031] defect. */
function dropIdentityEntries(t: Transition): Transition {
  const kept = new Map<string, Place<any>>();
  for (const [declared, actual] of t.placeAlias) if (actual.name !== declared) kept.set(declared, actual);
  const b = Transition.builder(t.name).timing(t.timing).priority(t.priority).action(t.action);
  if (kept.size > 0) b.placeAlias(kept);
  if (t.inputSpecs.length > 0) b.inputs(...t.inputSpecs);
  if (t.outputSpec !== null) b.outputs(t.outputSpec);
  for (const a of t.inhibitors) b.inhibitor(a.place);
  for (const a of t.reads) b.read(a.place);
  for (const a of t.resets) b.reset(a.place);
  if (t.matchSpec !== null) b.match(t.matchSpec);
  return b.build();
}

const EXPECTED_CALLS = ['a', 'b', 'c', 'd'];
/** Each step tags its input, so the result shows the order the child ran in, not just that it ran. */
const tag = (id: string) => (input: unknown) => ({ status: 'success' as const, output: `${String(input)}/${id}` });
const taggingRunner = (): RecordingRunner =>
  new RecordingRunner({ a: tag('a'), b: tag('b'), c: tag('c'), d: (input) => ({ status: 'success', output: { saw: input } }) });

describe('[MOD-031] a compiled workflow through instantiate -> fuse -> re-instantiate', () => {
  it('keeps every place: each child place appears exactly once in the final net, where the passes put it', () => {
    const built = build();
    const finalNames = new Set([...built.net.places].map((p: Place<unknown>) => p.name));
    const childNames = [...built.child.net.places].map((p: Place<unknown>) => p.name);

    const mapped = childNames.map((n) => finalNameOf(built, n));
    for (const [i, name] of mapped.entries()) expect(finalNames.has(name), `${childNames[i]} -> ${name}`).toBe(true);
    // Injective: no two child places collapsed into one, apart from nothing — fusion only merged
    // the child's cancel into the parent's, which is not a child place.
    expect(new Set(mapped).size).toBe(childNames.length);
    // And nothing else: the child's places plus the parent's own two (`p.start`, `p.returned` ->
    // `feed`, `result`), the fused cancel counted once.
    expect(finalNames).toEqual(new Set([...mapped, built.feed.name, built.result.name]));
    // The fused-away member is gone, not merely unmarked.
    expect(finalNames.has(`outer/child/${built.child.cancel.name}`)).toBe(false);
  });

  it('carries an identity alias out of the first pass, which is the case under test', () => {
    const compiled = child();
    const entry = [...parentOf(compiled).transitions].find((t) => t.name === 'child/t.0.a.run');
    expect(entry?.placeAlias.get(compiled.entryPlace.name)?.name).toBe(compiled.entryPlace.name);
  });

  it("resolves every declared place of every child transition to its final place, through both renames", () => {
    const built = build();
    const finalByName = new Map([...built.net.places].map((p: Place<unknown>) => [p.name, p] as const));
    const composed = new Map([...built.net.transitions].map((t) => [t.name, t] as const));
    let checked = 0;
    for (const t of built.child.net.transitions) {
      const final = composed.get(`outer/child/${t.name}`);
      expect(final, t.name).toBeDefined();
      const declared = new Set<string>([
        ...t.inputSpecs.map((s) => s.place.name),
        ...[...t.outputPlaces()].map((p) => p.name),
        ...t.inhibitors.map((a) => a.place.name),
        ...t.reads.map((a) => a.place.name),
        ...t.resets.map((a) => a.place.name),
      ]);
      for (const name of declared) {
        const actual = final!.placeAlias.get(name);
        expect(actual?.name, `${t.name}: '${name}'`).toBe(finalNameOf(built, name));
        // Identity, not just a matching string: the alias points at the place the net holds.
        expect(finalByName.get(actual!.name), `${t.name}: '${name}'`).toBeDefined();
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('runs to the parent result with no token lost, no stray token, and every step run once', async () => {
    const built = build();
    const runner = taggingRunner();
    const { marking, failures } = await runOn(built, runner, 'x');

    expect(failures).toEqual([]);
    // Exactly one token in the whole net, and it is the result: nothing lost, nothing stranded.
    expect(census(built.net, marking)).toEqual({ result: 1 });
    expect([...runner.calls].sort()).toEqual(EXPECTED_CALLS);
    const out = marking.peekFirst(built.result) as Token<FlowToken> | null;
    expect(out?.value.data).toEqual({ child: { saw: { b: 'x/a/b', c: 'x/a/c' } } });
  });

  it('routes a fused cancellation into the child: the parent signal stops the nested run before any step', async () => {
    const built = build();
    const runner = taggingRunner();
    const scope = new KernelRunScope({ runner, initData: 'x' });
    const executor = new BitmapNetExecutor(
      built.net,
      new Map<Place<unknown>, Token<unknown>[]>([
        [built.feed, [tokenOf<FlowToken>({ data: 'x' })]],
        [built.cancel, [tokenOf<null>(null)]],
      ]),
      { executionContextProvider: () => new Map<string, unknown>([[RUN_SCOPE_KEY, scope]]) },
    );
    let marking: Marking;
    try {
      marking = await executor.run(10_000, 'close');
    } finally {
      executor.close();
    }
    // The child's first entry reads the fused signal and sweeps to its own canceled terminal. Were
    // the fusion lost, the child would have its own, unmarked cancel and run `a`.
    expect(runner.calls).toEqual([]);
    expect(census(built.net, marking)).toEqual({ cancel: 1, [`outer/child/${built.child.terminals.canceled.name}`]: 1 });
  });

  /**
   * The teeth. `dropIdentityEntries` reproduces the [MOD-031] defect — a per-entry identity filter —
   * at the intermediate pass, on the parent net only; every other step of the construction is the
   * one above. The child's entry transition enables and consumes, then fails its declared-place
   * check, and the run's one token is in no place.
   */
  it('loses the token when the identity alias is dropped at the intermediate pass', async () => {
    const built = build((parent) =>
      PetriNet.builder('parent-defective')
        .places(...parent.places)
        .transitions(...[...parent.transitions].map(dropIdentityEntries))
        .build(),
    );
    const runner = taggingRunner();
    const { marking, failures } = await runOn(built, runner, 'x');

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]).toMatch(/^outer\/child\/t\.0\.a\.run: Place 's\.0\.a\.in' not in declared inputs/);
    expect(runner.calls).toEqual([]);
    expect(census(built.net, marking)).toEqual({});
  });
});

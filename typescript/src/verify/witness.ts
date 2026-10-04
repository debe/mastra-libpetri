import {
  PrecompiledNet,
  PrecompiledNetExecutor,
  place,
  seedToken,
  type Clock,
  type EventStore,
  type NetEvent,
  type Out,
  type PetriNet,
  type Place,
  type Token,
  type TransitionContext,
} from 'libpetri';
import { MarkingState, isUntimed, type SmtVerificationResult, type VerificationRoute } from 'libpetri/verification';
import type { CompiledWorkflow } from '../compiler/types.js';
import type { LivenessTarget } from './claims.js';
import { poolSinks } from './pools.js';
import { wholeMs } from './siphon.js';

/**
 * A liveness witness read off an **executor run of the same net** — no solver, no second net
 * ([ADR 0009]; CLAUDE.md, "one net").
 *
 * **The argument.** A liveness claim `live(t)` is the query `unreachable(inputs(t))` coming back
 * `violated` with a confirmed firing sequence: some run of the model marks every input of `t`. The
 * model is untimed and value-blind and can do everything the executor can ([VER-004]): the
 * executor's firings — each a start consuming the inputs, then a completion depositing one branch
 * of the `Out` spec — are moves the model has. On a net with **no timing** (every transition
 * `immediate`) the clock removes nothing, so an executor run that *starts* `t` passed through a
 * marking where every input of `t` was marked: the claim is settled, on the `execution` route.
 * A timed net is never settled this way — a run's timing is the clock's choice, not the model's —
 * and falls back to the verifier unchanged.
 *
 * **The witness is a firing sequence, in [VER-004]'s split vocabulary.** Every firing of the run is
 * two steps: the start `t`, which consumes `t`'s inputs (and drains its resets) into `inflight:t`,
 * and the completion `complete:t`, which takes `inflight:t` and deposits the places of the one
 * branch the stub chose. `counterexampleTransitions` lists those steps in the order the executor
 * took them and `counterexampleTrace` the marking before each and after the last, `inflight:*`
 * places included, so `M[i+1] = M[i] - pre + post` holds of every step and the branch a completion
 * took is `M[i+1] - M[i]` on the net's places. The last marking is the one `t` starts in. It is
 * the split libpetri's verifier applies to a transition whose outputs another tests; applied to
 * every transition it is the executor's own interleaving, which is why `counterexampleConfirmed` is
 * `true`. `elapsedMs` is the time of the run that reached `t`, up to `t`'s start, in whole ms.
 *
 * **Step timeouts are admitted.** [ADR 0013]'s per-attempt timeout is an ordinary xor branch
 * (`timedOut`) of an immediate transition in an untimed net, not a libpetri action timeout; the
 * verifier's untimed model lets that branch be taken at any time, and so may a stub — `toward(t)`
 * takes it to reach a timeout funnel. The `no action timeout` conjunct of
 * {@link executionWitnessesApply} never excludes a net this compiler emits; it stays as the guard
 * for a libpetri `Out` `timeout` branch, which only the executor's clock takes and which no stub
 * here ever takes, so a net carrying one would have runs this module cannot produce.
 *
 * **What the run is.** The compiled net's places, transitions, arcs, timing and priorities, with
 * every action replaced by a stub (`PetriNet.bindActionsWithResolver`, which rebinds actions and
 * nothing else; {@link assertSameNet} checks that before any run). A stub writes **one token into
 * each place of one branch of the transition's `Out` spec** ({@link stubOutputs}, which refuses a
 * branch naming a place twice). That is what soundness rests on: the executor checks, at completion,
 * that the *set* of places written is exactly one branch of the spec ([IO-015]) — output validation
 * is never skipped — but a second token into a place passes that check with only a multiplicity
 * warning (libpetri 8.0.0), so one token per place is this module's own guarantee, not the
 * executor's. Two things keep it: libpetri 8.0.0's `Transition` builder refuses a spec naming a
 * place twice in one branch ([IO-015]), and {@link stubOutputs} throws if it ever met one, which
 * fails the firing and so the whole witness search, loudly. Decisions are xor
 * branches ([ADR 0009]: no guards, no correlation), so branch choice is the only freedom a run has,
 * and a deterministic **policy** fixes it. Nothing here touches Mastra: no runner, no run scope, no
 * Mastra type. The clock is a manual one ([TIME-015]): on an untimed net nothing waits on it.
 *
 * **Policies, bounded and deterministic.** `first` (every xor takes its first branch) and `last`
 * run once for all targets together; then, per target still unreached, `toward(t)` — every xor takes
 * the branch whose places are fewest firings from `t`'s inputs, a backwards distance over the arcs
 * (pool places, which every branch returns to, do not count). That reaches a retry attempt by
 * failing the attempts before it, a timeout funnel by timing its attempt out, the other arm of a
 * branch by taking it. Every run stops at {@link MAX_STARTS} starts, at quiescence, or — under
 * `toward(t)` — as soon as `t` starts, with `close()` ([ADR 0004]: never `run(timeoutMs)`).
 *
 * **Never the other way.** A run that does not reach `t` proves nothing: such a target is left to
 * the verifier, which is the only thing that can say `t` is dead. And no other claim kind is ever
 * settled from a run.
 */

/** A claim's route: libpetri's, or `execution` for a witness read off an executor run. */
export type ClaimRoute = VerificationRoute | 'execution';

/** A claim's result: the verifier's shape, with the route widened by `execution`. */
export type ClaimResult = Omit<SmtVerificationResult, 'route'> & { readonly route: ClaimRoute };

/** Starts per run before it is closed: a policy that loops is cut off, never waited out. */
export const MAX_STARTS = 10_000;

/** The place a started, uncompleted firing of `transition` holds its token in ([VER-004]'s name). */
export const inFlight = (transition: string): string => `inflight:${transition}`;
/** The completion step of `transition` in a witness ([VER-004]'s name). */
export const completion = (transition: string): string => `complete:${transition}`;

/**
 * Whether runs may settle liveness on this net: every transition `immediate`, and no libpetri action
 * timeout — a conjunct this compiler never trips (see the module comment), kept for the nets it does
 * not emit.
 */
export function executionWitnessesApply(net: PetriNet): boolean {
  return isUntimed(net) && [...net.transitions].every((t) => !t.hasActionTimeout());
}

/** Picks a child of an xor: the transition, the xor's children. Returns an index. */
export type Policy = (transition: string, children: readonly Out[]) => number;

interface Witness {
  readonly policy: string;
  /** The steps before the target's start: `t` for a start, `complete:t` for a completion. */
  readonly transitions: readonly string[];
  /** The marking before each step, then the one the target starts in: `transitions.length + 1`. */
  readonly trace: readonly MarkingState[];
  readonly starts: number;
  /** The run's own time up to the target's start, whole milliseconds. */
  readonly elapsedMs: number;
}

/**
 * Runs the compiled net from `initial` under the policies above and returns, per target transition
 * the runs started, a `violated` result on the `execution` route whose witness is the run's firing
 * sequence up to the target's start. A target absent from the map was reached by no run and is the
 * verifier's to decide.
 *
 * Returns an empty map on a net {@link executionWitnessesApply} refuses. Throws if a stub firing
 * fails or the events stop adding up to firings: such a run is not a run of the net as claimed.
 */
export async function executionWitnesses(
  compiled: CompiledWorkflow,
  initial: ReadonlyMap<Place<unknown>, number>,
  targets: readonly LivenessTarget[],
): Promise<ReadonlyMap<string, ClaimResult>> {
  const out = new Map<string, ClaimResult>();
  if (targets.length === 0 || !executionWitnessesApply(compiled.net)) return out;
  const net = compiled.net;

  // The stubs read the current run's policy from here; runs are sequential.
  let policy: Policy = () => 0;
  const stub = (name: string, spec: Out | null) => async (ctx: TransitionContext): Promise<void> => {
    if (spec !== null) for (const p of stubOutputs(name, spec, policy)) ctx.output(p, null);
  };
  const specs = new Map([...net.transitions].map((t) => [t.name, t.outputSpec]));
  const bound = net.bindActionsWithResolver((name) => stub(name, specs.get(name) ?? null));
  assertSameNet(net, bound);
  const program = PrecompiledNet.compile(bound);

  const places = new Map<string, Place<unknown>>([...net.places].map((p) => [p.name, p as Place<unknown>]));
  const placeNamed = (name: string): Place<unknown> => {
    let p = places.get(name);
    if (p === undefined) places.set(name, (p = place<unknown>(name)));
    return p;
  };
  const snapshot = (counts: ReadonlyMap<string, number>): MarkingState => {
    const b = MarkingState.builder();
    for (const [name, n] of counts) if (n > 0) b.tokens(placeNamed(name), n);
    return b.build();
  };
  const bump = (m: Map<string, number>, name: string, by: number): void => {
    const n = (m.get(name) ?? 0) + by;
    if (n < 0) throw new Error(`'${net.name}': execution witness: '${name}' went negative — the events are not a firing sequence`);
    if (n === 0) m.delete(name);
    else m.set(name, n);
  };
  const wanted = new Set(targets.map((t) => t.transition));
  const found = new Map<string, Witness>();

  const run = async (name: string, chosen: Policy, stopAt?: string): Promise<void> => {
    policy = chosen;
    const runStarted = performance.now();
    const current = new Map<string, number>([...initial].filter(([, n]) => n > 0).map(([p, n]) => [p.name, n]));
    const steps: string[] = [];
    const trace: MarkingState[] = [snapshot(current)];
    let removed = new Map<string, number>();
    let added = new Map<string, number>();
    let starts = 0;
    let failure: string | undefined;
    let executor: PrecompiledNetExecutor | undefined;
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      executor?.close();
    };
    const store: EventStore = {
      append(event: NetEvent): void {
        if (stopped) return;
        // The executor emits a firing's removals (inputs, then resets) just before its start, and a
        // completion's additions just before the completion: each batch belongs to the event after it.
        if (event.type === 'token-removed') bump(removed, event.placeName, 1);
        else if (event.type === 'token-added') bump(added, event.placeName, 1);
        else if (event.type === 'transition-started') {
          const t = event.transitionName;
          if (added.size > 0) failure = `tokens were added outside a completion before '${t}' started`;
          if (failure !== undefined) return stop();
          if (wanted.has(t) && !found.has(t)) {
            found.set(t, { policy: name, transitions: [...steps], trace: [...trace], starts, elapsedMs: wholeMs(performance.now() - runStarted) });
          }
          for (const [p, n] of removed) bump(current, p, -n);
          bump(current, inFlight(t), 1);
          removed = new Map();
          steps.push(t);
          trace.push(snapshot(current));
          starts++;
          if (t === stopAt || starts >= MAX_STARTS) stop();
        } else if (event.type === 'transition-completed') {
          const t = event.transitionName;
          if (removed.size > 0) failure = `tokens were removed outside a start before '${t}' completed`;
          if (failure !== undefined) return stop();
          bump(current, inFlight(t), -1);
          for (const [p, n] of added) bump(current, p, n);
          added = new Map();
          steps.push(completion(t));
          trace.push(snapshot(current));
        } else if (event.type === 'transition-failed') {
          failure = `'${event.transitionName}' failed: ${event.errorMessage}`;
          stop();
        }
      },
      events: () => [],
      isEnabled: () => true,
      size: () => 0,
      isEmpty: () => true,
    };
    const tokens = new Map<Place<unknown>, Token<unknown>[]>();
    const clock = manualClock();
    for (const [p, n] of initial) if (n > 0) tokens.set(p, Array.from({ length: n }, () => seedToken<unknown>(clock, null)));
    executor = new PrecompiledNetExecutor(bound, tokens, { program, eventStore: store, clock, deadlineToleranceMs: 0 });
    await executor.run(undefined, 'close');
    if (failure !== undefined) throw new Error(`'${net.name}': execution witness run '${name}': ${failure}; it is not a run of the net as claimed`);
  };

  await run('first', () => 0);
  await run('last', (_, children) => children.length - 1);
  for (const target of targets) {
    if (found.has(target.transition)) continue;
    await run(`toward(${target.transition})`, toward(compiled, target, initial), target.transition);
  }

  for (const [transition, w] of found) {
    const completions = w.transitions.length - w.starts;
    const what = `${w.starts} start(s) and ${completions} completion(s) of an executor run of the same net (untimed; stub actions, policy ${w.policy})`;
    out.set(transition, {
      verdict: { type: 'violated' },
      route: 'execution',
      report:
        `'${transition}' is enabled after ${what}: every input marked — violated. The witness is the run's firing sequence in ` +
        `the start/completion split ([VER-004]: '<t>' consumes into 'inflight:<t>', 'complete:<t>' deposits the branch it took)`,
      invariants: [],
      discoveredInvariants: [],
      counterexampleTrace: w.trace,
      counterexampleTransitions: w.transitions,
      counterexampleConfirmed: true,
      counterexampleTiming: 'untimed-net',
      elapsedMs: w.elapsedMs,
      statistics: {
        places: net.places.size,
        transitions: net.transitions.size,
        invariantsFound: 0,
        structuralResult: `executor run, policy ${w.policy}, ${what.split(' of an')[0]} before '${transition}'`,
      },
    });
  }
  return out;
}

/**
 * The places a stub writes for `out`, one token each: every place of one branch, the xors resolved by
 * `policy`. A `timeout` branch is never taken (only the executor's clock takes one). Throws if the
 * branch names a place twice — a second token would pass the executor's set check with only a
 * multiplicity warning, and the run would no longer be one the verifier's model has.
 */
export function stubOutputs(transition: string, out: Out, policy: Policy): readonly Place<unknown>[] {
  const written: Place<unknown>[] = [];
  const seen = new Set<string>();
  const write = (p: Place<unknown>): void => {
    if (seen.has(p.name)) throw new Error(`'${transition}': a stub branch names '${p.name}' twice; a witness deposits one token per place`);
    seen.add(p.name);
    written.push(p);
  };
  const walk = (o: Out): void => {
    switch (o.type) {
      case 'place':
        return write(o.place as Place<unknown>);
      case 'forward-input':
        return write(o.to as Place<unknown>);
      case 'and':
        for (const child of o.children) walk(child);
        return;
      case 'xor': {
        const taken = o.children.filter((c) => c.type !== 'timeout');
        if (taken.length === 0) return;
        const i = Math.min(Math.max(0, policy(transition, taken)), taken.length - 1);
        return walk(taken[i]!);
      }
      case 'timeout':
        return;
    }
  };
  walk(out);
  return written;
}

/**
 * `toward(t)`: each xor takes the child nearest `t` — the fewest firings from one of its places to
 * a marking of one of `t`'s inputs, by a backwards breadth-first search over the arcs. Places a pool
 * owns, and places marked initially, are left out: every branch returns a permit, so they would
 * tie every choice. Ties, and children that lead nowhere near `t`, take the lowest index.
 */
function toward(compiled: CompiledWorkflow, target: LivenessTarget, initial: ReadonlyMap<Place<unknown>, number>): Policy {
  const ignored = new Set<string>([
    ...poolSinks(compiled).map((p) => p.name),
    ...compiled.pools.flatMap((pool) => pool.holders.map((h) => h.place)),
    ...[...initial].filter(([, n]) => n > 0).map(([p]) => p.name),
  ]);
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const p of target.inputs) {
    if (ignored.has(p.name)) continue;
    dist.set(p.name, 0);
    queue.push(p.name);
  }
  const producers = new Map<string, string[][]>();
  for (const t of compiled.net.transitions) {
    const needs = [...t.inputSpecs.map((i) => i.place.name), ...t.reads.map((r) => r.place.name)].filter((p) => !ignored.has(p));
    for (const q of t.outputPlaces()) {
      const list = producers.get(q.name) ?? [];
      list.push(needs);
      producers.set(q.name, list);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const q = queue[i]!;
    const d = dist.get(q)!;
    for (const needs of producers.get(q) ?? []) {
      for (const p of needs) {
        if (dist.has(p)) continue;
        dist.set(p, d + 1);
        queue.push(p);
      }
    }
  }
  const score = (out: Out): number => {
    switch (out.type) {
      case 'place':
        return ignored.has(out.place.name) ? Infinity : (dist.get(out.place.name) ?? Infinity);
      case 'forward-input':
        return ignored.has(out.to.name) ? Infinity : (dist.get(out.to.name) ?? Infinity);
      case 'timeout':
        return Infinity;
      default:
        return Math.min(Infinity, ...out.children.map(score));
    }
  };
  return (_, children) => {
    let best = 0;
    let bestScore = Infinity;
    children.forEach((child, i) => {
      const s = score(child);
      if (s < bestScore) {
        bestScore = s;
        best = i;
      }
    });
    return best;
  };
}

/**
 * `bindActionsWithResolver` rebinds actions only; a run of anything else would not be a run of this
 * net. Checked: the same place **objects** (identity, not name — a same-named place built elsewhere
 * is a different place to a `Map` keyed by it), and per transition, by name, the same inputs with
 * their kind and counts (`exactly(n)`, `atLeast(n)`), outputs, inhibitors, reads, resets, timing,
 * priority and the very same `Out` spec object, every arc's place compared by identity. Exported for
 * the tests that feed it a rebinding which changes the structure.
 */
export function assertSameNet(net: PetriNet, bound: PetriNet): void {
  const ids = new Map<Place<unknown>, number>();
  const id = (p: Place<unknown>): string => {
    let n = ids.get(p);
    if (n === undefined) ids.set(p, (n = ids.size));
    return `${p.name}#${n}`;
  };
  // Number the original's places first, so a stranger in the rebinding gets a fresh number.
  for (const p of net.places) id(p as Place<unknown>);
  const arcs = (list: readonly { readonly place: Place<unknown> }[]): string[] => list.map((a) => id(a.place));
  const shape = (n: PetriNet): string =>
    JSON.stringify([
      [...n.places].map((p) => id(p as Place<unknown>)).sort(),
      [...n.transitions]
        .map((t) =>
          JSON.stringify([
            t.name,
            t.inputSpecs.map((i) => [i.type, id(i.place as Place<unknown>), i.type === 'exactly' ? i.count : i.type === 'at-least' ? i.minimum : null]),
            [...t.outputPlaces()].map((p) => id(p as Place<unknown>)).sort(),
            arcs(t.inhibitors as readonly { readonly place: Place<unknown> }[]),
            arcs(t.reads as readonly { readonly place: Place<unknown> }[]),
            arcs(t.resets as readonly { readonly place: Place<unknown> }[]),
            t.timing,
            t.priority,
          ]),
        )
        .sort(),
    ]);
  const byName = new Map([...net.transitions].map((t) => [t.name, t]));
  const sameSpecs = [...bound.transitions].every((t) => byName.get(t.name)?.outputSpec === t.outputSpec);
  if (net.transitions.size !== bound.transitions.size || net.places.size !== bound.places.size || !sameSpecs || shape(net) !== shape(bound)) {
    throw new Error(`'${net.name}': rebinding stub actions changed the net; an execution witness would not be a run of it`);
  }
}

/**
 * A manual clock ([TIME-015]): it moves only when the executor asks it to wait for a finite boundary,
 * which an untimed net never does; a wait with no boundary suspends until the executor ends it.
 */
function manualClock(): Clock {
  let t = 0;
  return {
    now: () => t,
    epochNow: () => t,
    sleep: (delayMs: number, ready: () => boolean, signal: AbortSignal): Promise<void> => {
      if (ready() || signal.aborted) return Promise.resolve();
      if (Number.isFinite(delayMs)) {
        t += Math.max(0, delayMs);
        return Promise.resolve();
      }
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  };
}

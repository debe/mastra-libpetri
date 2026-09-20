import { Transition, and, one, outPlace, place, xor } from 'libpetri';
import type { FailureToken, FlowToken } from '../types.js';
import type { Gadget } from './types.js';

/**
 * What waits between iterations: the value the next iteration will be fed, and how many
 * iterations have already completed.
 *
 * The count rides in the token because Mastra's `LoopConditionFunction` is handed an
 * `iterationCount` and there is nowhere else for a *payload* to live — but it is payload only.
 * Nothing in the net reads it, no transition is enabled or disabled by it, and no claim about
 * this gadget rests on it. The *bound* lives in the `budget` place, where it is at least a count
 * in the marking that the firing rule enforces; a number in a token would be enforced by an
 * action reading it, which is neither race-free nor checkable.
 */
interface LoopState {
  readonly data: unknown;
  readonly iteration: number;
}

/**
 * The marker for the one iteration currently in flight.
 *
 * The body is a child gadget: it consumes a `FlowToken` and produces a `FlowToken`, so anything
 * the loop needs on the far side of the body cannot travel *through* it. This is the
 * pending-marker place — one token per outstanding unit of work — which also makes
 * "an iteration is running" a fact the marking holds rather than a fact an action remembers.
 */
interface IterationMarker {
  readonly iteration: number;
}

/**
 * `.dowhile` / `.dountil`.
 *
 * Both run the body first and evaluate the condition after, and the first evaluation sees
 * `iterationCount === 1` (Mastra's `processWorkflowLoop`: `iterationCount = previous + 1`).
 * `dowhile` repeats while the condition holds; `dountil` repeats until it holds. That is the
 * *only* difference between them, and it is one boolean negation inside `check` — the topology
 * is identical, because the continue/exit decision is an `Xor` branch either way.
 *
 * **The shape.**
 *
 * ```text
 *   in ──start──▶ ready ──enter──▶ body.in ─(child)─▶ produced ──check──▶ ready   (repeat)
 *          │        │       │                            ▲        │  └──▶ exiting ──finish──▶ next
 *          │(reset) │       └──▶ running ────────────────┘        └─────▶ failing ──abort──▶ wf.failed
 *          └──▶ budget ◀────┘(one per iteration)                            ▲
 *                  ╳ (inhibitor)                                            │
 *               exhaust ◀── ready ─────────────────────────────────────────┘
 * ```
 *
 * **Why the iteration allowance is a place.** `budget` is seeded with `maxIterations` unit
 * tokens by `start` and drained one token per iteration by `enter`. A counter in a token or a
 * number in a closure would be a fact no analysis could ever see, and would leave the
 * continue/stop decision to an action reading a number — the exact shape this model exists to
 * remove. As a place, the decision is the marking: `enter` is enabled while a token is there and
 * `exhaust` while it is not, and the only claim outstanding is the count itself (see the next
 * paragraph). `maxIterations` appears in `start`'s closure purely as *how many tokens to seed* —
 * the canonical budget idiom — never as something an action consults to decide anything.
 *
 * **Why `start` resets the budget.** A loop entry is compiled once and can be entered more than
 * once (it is the body of an outer loop, or of a `foreach`). A stale allowance left by a
 * previous entry would add to the new one and `budget` would hold more than `maxIterations`,
 * so the second entry of a loop would run longer than the first — the cap is the one thing this
 * place is for. `finish` and `abort` already clear it on the way out, so the reset on `start` is
 * belt-and-braces; it is kept because it makes the cap hold whatever the exit path did, rather
 * than depending on every future exit remembering to clean up. Under [EXEC-013] the drain
 * happens during the firing step, before the action runs, so `start` cannot wipe the tokens it
 * is about to seed.
 *
 * Be honest about what that reset is worth today: it is **unobservable**. Every exit clears
 * `budget`, so a sequentially re-entered loop always finds the place already empty, and deleting
 * this reset changes no test and no verdict in either suite — measured, unlike the two exit
 * resets, which a mutation of each turns red. It is insurance against a future exit path, not a
 * live guard, and in the one scenario it is aimed at it would *hurt*: under concurrent re-entry
 * (a `foreach` with `concurrency > 1` over a loop body) a second entry's `start` would wipe the
 * first entry's unspent allowance and starve it into a spurious exhaustion failure. These places
 * are per-entry, not per-instance; concurrent re-entry needs ν-correlation or a per-instance
 * subnet, and this reset does not make it safe.
 *
 * **Why exhaustion fails rather than exits.** Mastra has no iteration cap at all; a `.dowhile`
 * whose condition never goes false loops forever. `maxIterations` is our structural addition,
 * needed because an unbounded loop place is an unbounded place and an unbounded place stops a
 * proof from closing. Exiting normally on exhaustion would be indistinguishable — to the next
 * entry and to the caller — from a condition that genuinely terminated, so a truncated result
 * would flow downstream with no signal at all. A failure names the entry and the cap. This is a
 * divergence from Mastra and belongs in `docs/divergences.md`.
 *
 * **Where the allowance has to be seeded for a proof to mean anything — read this before
 * quoting a bound.** [IO-016] makes an output branch a *set* of places: every branch-enumerating
 * analysis deposits exactly one token per named place, whatever the action wrote
 * (`postVector[idx] = 1` in the flattener). `start` writes `maxIterations` tokens into a place
 * its branch names once, which conforms to [IO-015] — the produced *set* matches, and the
 * executor emits the [IO-016] AC4 warning on the first such firing — but it means a query seeded
 * at the entry place explores a net whose allowance is **one** token, at `maxIterations` 1, 3 or
 * 300 alike. So `placeBound(budget, N)` seeded that way comes back `proven` for any N >= 1,
 * including bounds the executor really exceeds; that verdict is about a different net.
 *
 * This is not merely a weaker proof, it is a blind spot with a shape, and the shape is the one
 * the exit resets exist for. In the flattened net the single modelled allowance token is always
 * spent by the first `enter`, so *leaving with allowance to spare is unreachable* and no query
 * seeded at the entry place can see whether the leftovers are cleared. Measured: deleting
 * `.reset(budget)` from `finish` keeps `deadlockFree` `proven` on every shape, while a real
 * eight-allowance run that exits after two iterations strands six tokens.
 *
 * The answer is not a different topology — this topology is already right, and it is not the
 * case that no topology expresses the cap. It is to seed the allowance where the verifier reads
 * it, which is libpetri's own budget idiom (`.initialMarking(m => m.tokens(idle, 1).tokens(
 * budget, k))`). Seeding `ready` and `budget` directly is exactly the post-`start` marking, and
 * `tests/verify/loop.test.ts` proves over it that at a genuine allowance of k the bound holds,
 * that it is **tight** (`placeBound(budget, k - 1)` comes back `violated`), and that nothing
 * strands on any exit. What is left unproven afterwards is one action's deposit count — that
 * `start` really puts `maxIterations` tokens in — and nothing else. An output multiplicity
 * upstream (`postVector[idx] = n`) or a `CompiledWorkflow` carrying an initial marking would
 * close that last step; the executor tests in `tests/compiler/loop.test.ts` pin it meanwhile.
 *
 * **Why sequentiality needs no mutex place.** Exactly one flow token circulates: `start` emits
 * one `ready`, `enter` turns it into one `body.in` plus one `running`, `check` consumes both
 * halves and emits one of three places. There is no reachable marking in which two iterations
 * are in flight, and that is `placeBound(running, 1)` — proven at an allowance of one, which is
 * where the encoding and the executor agree, rather than argued. A mutex place would be the
 * alternative and is not available anyway: the kernel seeds only the entry place, so no place
 * can carry an initial token and a permit place has nothing to seed it.
 *
 * **Why `exhaust` is not a race.** `enter` consumes `one(budget)`; `exhaust` carries an
 * inhibitor on `budget`. They are structurally exclusive, so the exclusion does not rest on
 * priority (which no analysis sees by default) — the priorities below are the canonical idiom
 * written out, not load-bearing. The one window worth checking is the first one: `start` emits
 * `ready` and the `budget` tokens from a single firing, and [EXEC-003] AC4 makes deposits visible
 * uniformly at the next cycle, never part-way through a pass, so there is no instant at which
 * `ready` is marked and `budget` is still empty.
 *
 * **[TIME-012] does apply and is harmless here.** The reset arcs on `budget` restart the clocks
 * of `enter` (input) and `exhaust` (inhibitor). Both are `immediate`, whose interval is
 * `[0, inf)`, so a restart changes nothing. Adding timing to either without revisiting this
 * would silently reintroduce the trap.
 */
export const loopGadget: Gadget = (entry, next, ctx) => {
  if (entry.kind !== 'loop') throw new Error(`loopGadget received a '${entry.kind}' entry`);

  // Resolved at compile, not at fire: a loop compiled against a runner that cannot evaluate its
  // condition is a broken build, and discovering it from inside an action would surface as a
  // failed step halfway through a run instead.
  const runner = ctx.runner;
  const evaluate = runner.evaluateLoopCondition?.bind(runner);
  if (evaluate === undefined) {
    throw new Error(
      `loop entry '${entry.id}' needs StepRunner.evaluateLoopCondition, which this runner does ` +
        'not implement. A loop cannot be compiled without it: the continue/exit decision is an ' +
        'Xor branch whose action has nothing to ask.',
    );
  }

  // `.dowhile` / `.dountil` always run the body at least once, so a cap below 1 describes no
  // loop at all — and `start` would then have to seed zero tokens into a place its own `And`
  // branch claims, which is an [IO-015] violation rather than a quiet no-op.
  if (!Number.isInteger(entry.maxIterations) || entry.maxIterations < 1) {
    throw new Error(
      `loop entry '${entry.id}' has maxIterations=${entry.maxIterations}; it must be a positive ` +
        'integer, because the body always runs at least once and the allowance is seeded as ' +
        'that many tokens.',
    );
  }

  const inPlace = place<FlowToken>(ctx.names.entryIn(ctx.path, entry.id));
  /** The iteration allowance. Unit tokens: the count is the state, the value carries nothing. */
  const budget = place<null>(ctx.names.entryPlace(ctx.path, entry.id, 'budget'));
  /** Between iterations: the next iteration's input, waiting for an allowance token. */
  const ready = place<LoopState>(ctx.names.entryPlace(ctx.path, entry.id, 'ready'));
  /** While the body runs: the pending marker for the single in-flight iteration. */
  const running = place<IterationMarker>(ctx.names.entryPlace(ctx.path, entry.id, 'running'));
  /** The body's output, waiting for the condition. */
  const produced = place<FlowToken>(ctx.names.entryPlace(ctx.path, entry.id, 'produced'));
  /** Decided to leave, waiting for the allowance to be cleared. */
  const exiting = place<FlowToken>(ctx.names.entryPlace(ctx.path, entry.id, 'exiting'));
  /** Every way this loop can fail, funnelled to one place so cleanup lives in one transition. */
  const failing = place<FailureToken>(ctx.names.entryPlace(ctx.path, entry.id, 'failing'));

  // The body routes failure to the gadget's own place, never straight to the workflow terminal.
  // Straight to the terminal, the allowance tokens and the pending marker would have no enabled
  // consumer in any state that followed: stranded tokens, an unbounded-looking place, and a run
  // that reports `failed` only because `classify` reads that terminal first.
  const body = ctx.emitNested(entry.body, [...ctx.path, 0], produced, failing);

  // Seeded once per entry, spread into the output. Fixed `null`s, so there is nothing to alias
  // between firings.
  const allowance: readonly null[] = Array.from({ length: entry.maxIterations }, () => null);

  const start = Transition.builder(ctx.names.entryTransition(ctx.path, entry.id, 'start'))
    .inputs(one(inPlace))
    .reset(budget)
    .outputs(and(outPlace(ready), outPlace(budget)))
    .action(async (c) => {
      const incoming = c.input(inPlace);
      c.output(ready, { data: incoming.data, iteration: 0 });
      c.output(budget, ...allowance);
    })
    .build();

  // High priority is the budget idiom written out; the exclusion against `exhaust` is the
  // inhibitor arc, not this number.
  const enter = Transition.builder(ctx.names.entryTransition(ctx.path, entry.id, 'enter'))
    .inputs(one(ready), one(budget))
    .priority(1)
    .outputs(and(outPlace(body.inPlace), outPlace(running)))
    .action(async (c) => {
      const state = c.input(ready);
      c.output(body.inPlace, { data: state.data });
      c.output(running, { iteration: state.iteration + 1 });
    })
    .build();

  // The fallback leg of the budget idiom: fires only once the allowance is gone, which is
  // exactly when `enter` cannot fire. Together the two cover every marking in which `ready`
  // holds a token, so that token always has an enabled consumer.
  const exhaust = Transition.builder(ctx.names.entryTransition(ctx.path, entry.id, 'exhaust'))
    .inputs(one(ready))
    .inhibitor(budget)
    .priority(0)
    .outputs(outPlace(failing))
    .action(async (c) => {
      const state = c.input(ready);
      c.output(failing, {
        stepId: entry.id,
        error: new Error(
          `loop '${entry.id}' did not settle within maxIterations=${entry.maxIterations} ` +
            `(${state.iteration} iterations ran; the ${entry.loopType} condition still asked ` +
            'for another)',
        ),
      });
    })
    .build();

  // Three branches, because there are three outcomes. A condition that throws is one of them:
  // routing it to `exiting` would leave the loop, and the workflow, looking successful.
  const check = Transition.builder(ctx.names.entryTransition(ctx.path, entry.id, 'check'))
    .inputs(one(produced), one(running))
    .outputs(xor(outPlace(ready), outPlace(exiting), outPlace(failing)))
    .action(async (c) => {
      const output = c.input(produced);
      const marker = c.input(running);

      // Decide, then emit ([EXEC-031]): the inputs are already consumed and are not restored, so
      // the awaiting half writes nothing and the writing half cannot throw. A write in the `try`
      // and another in the `catch` would satisfy no branch of the `Xor`.
      let outcome:
        | { readonly kind: 'repeat' }
        | { readonly kind: 'exit' }
        | { readonly kind: 'failed'; readonly error: unknown };
      try {
        const held = await evaluate(entry.id, output.data, marker.iteration);
        const repeat = entry.loopType === 'dowhile' ? held : !held;
        outcome = repeat ? { kind: 'repeat' } : { kind: 'exit' };
      } catch (error) {
        outcome = { kind: 'failed', error };
      }

      if (outcome.kind === 'failed') c.output(failing, { stepId: entry.id, error: outcome.error });
      // Mastra feeds the body's own output back in as the next iteration's input
      // (`loopAgainData.prevResult = stepResult`), and hands the same value on at the end.
      else if (outcome.kind === 'repeat') {
        c.output(ready, { data: output.data, iteration: marker.iteration });
      } else c.output(exiting, { data: output.data });
    })
    .build();

  // The exit hop exists for the reset arc. A reset fires whenever its transition fires, so it
  // cannot sit on `check`, which also fires on the repeat branch and would wipe the allowance it
  // is about to spend. `exiting` splits "decided to leave" from "left", and the leftover
  // allowance — `maxIterations` minus the iterations actually run — is cleared exactly once, by
  // the transition that only ever fires on the way out.
  const finish = Transition.builder(ctx.names.entryTransition(ctx.path, entry.id, 'finish'))
    .inputs(one(exiting))
    .reset(budget)
    .outputs(outPlace(next))
    .action(async (c) => {
      c.output(next, { data: c.input(exiting).data });
    })
    .build();

  // The single failure boundary. `running` is reset rather than consumed because it holds a
  // token on the body-failure path and none on the condition-failure path, where `check` already
  // took it: a reset arc requires nothing and takes whatever is there, so one transition covers
  // both without an extra branch. Both resets are cleanup at a boundary, not bookkeeping inside
  // the loop.
  const abort = Transition.builder(ctx.names.entryTransition(ctx.path, entry.id, 'abort'))
    .inputs(one(failing))
    .resets(budget, running)
    .outputs(outPlace(ctx.failed))
    .action(async (c) => {
      c.output(ctx.failed, c.input(failing));
    })
    .build();

  // The body's transitions were collected by the builder when `emitNested` ran; returning them
  // again would add every one of them twice.
  return { inPlace, transitions: [start, enter, exhaust, check, finish, abort] };
};

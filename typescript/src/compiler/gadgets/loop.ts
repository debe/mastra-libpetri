import { Transition, and, one, outPlace, place, xor, type Place } from 'libpetri';
import { scopeOf, viewOf } from '../scope.js';
import type { BailToken, Exits, FailureToken, FlowToken, PauseToken, SuspendToken } from '../types.js';
import type { Gadget } from './types.js';

/**
 * The largest `iterationBound` a loop compiles with.
 *
 * The allowance is seeded as that many unit tokens when the loop starts, so the bound is also a
 * token count held in memory for the life of the loop. Without a ceiling, a caller reaching for
 * `Number.MAX_SAFE_INTEGER` to mean "as unbounded as Mastra" would get a run that hangs seeding
 * its allowance instead of an error at compile. Mastra has no ceiling because it has no bound.
 */
export const MAX_ITERATION_BOUND = 100_000;

/**
 * Between iterations: the value the next iteration is fed, and how many iterations have run.
 *
 * `iteration` is payload only. It is what the condition is told (`iterationCount`), and no
 * transition is enabled or disabled by it: the bound is the `budget` place, never this number.
 */
interface LoopState {
  readonly data: unknown;
  readonly iteration: number;
}

/**
 * The pending marker for the one iteration in flight.
 *
 * The body is a leaf gadget: it consumes a `FlowToken` and produces one, so nothing the loop
 * needs on the far side of the body can travel through it. The iteration number rides here
 * instead, beside the body's token, and every way out of the body consumes it.
 */
interface IterationMarker {
  readonly iteration: number;
}

/**
 * `.dowhile` / `.dountil`.
 *
 * **What Mastra does** (`handlers/control-flow.ts`, `executeLoop`):
 *
 * - The first iteration's input is the previous entry's output: `result` starts as
 *   `{ status: 'success', output: loopInput }` (:734), and `loopInput` is `prevOutput` (:730-733).
 * - Every later iteration is fed the previous iteration's output. The body is called with
 *   `prevOutput: (result as { output: any }).output` (:764), and `result` is reassigned to the
 *   body's own result after each call (:780).
 * - The body runs first; then the condition is evaluated with `inputData: result.output` (:843)
 *   and `iterationCount: iteration + 1` (:847). `iteration` starts at 0 (:728) and is incremented
 *   only after the condition (:883), so the first evaluation sees **1**. That holds for both loop
 *   types: there is one `do { body; condition } while (…)` (:739-901), and the two differ only in
 *   the test at :901, `dowhile ? isTrue : !isTrue`.
 * - A non-success body result ends the loop at once, returned as the loop's own result (:791-801).
 * - The loop's result is the last body result (:914), stored under the **body's** step id
 *   (`handlers/entry.ts:810-812`), which is where the next entry reads it
 *   (`default.ts:1150-1151`).
 * - The body runs under the loop's own `executionContext`, passed through unchanged (:760), so
 *   its `executionPath` is the loop's path. A `.parallel()` arm, by contrast, gets
 *   `[...executionPath, i]` (:244).
 *
 * **The shape.**
 *
 * ```text
 *   loop-in ─start─▶ ready + budget×N
 *   ready + budget ─enter─▶ body.in + running          ready ─exhaust (inhibited by budget)─▶ failed
 *   body ─success─▶ produced ; produced + running ─check─▶ ready | exiting | failing
 *   exiting ─finish (reset budget)─▶ next              failing ─abort (reset budget)─▶ failed
 *   body-X + running ─leave-X (reset budget)─▶ X        for X in failed, bailed, suspended, paused
 * ```
 *
 * **The body shares the loop's path.** That is what Mastra does (:760), and it is what the runner
 * hands on as the step's `executionPath` and what a suspension records in `suspendedPaths`. The
 * price is that a loop's id defaults to its body's id (the adapter falls back to it, as Mastra
 * keys the result by it), so both would claim `entryIn(path, id)`. The loop therefore never mints
 * `.in`: its input is `loop-in`, and its other roles are disjoint from the leaf's
 * (`in`, `run`, `run-n`, `retry-n`, `attempt-n`). A collision would throw at compile anyway,
 * because `NameVocabulary` refuses to mint one name twice.
 *
 * **The iteration allowance is a place.** `budget` is seeded with `iterationBound` unit tokens by
 * `start` and spent one per iteration by `enter`. `enter` needs a token and `exhaust` is
 * inhibited by one, so every marking with a token in `ready` enables exactly one of them. The
 * exclusion is that inhibitor arc, not the priorities, which are the budget idiom written out and
 * which no analysis sees by default. `tests/verify/loop.test.ts` removes the inhibitor and gets
 * `deadlockFree` violated while the run itself still passes — the proof rests on the arc.
 *
 * **Exceeding the bound fails the run.** Mastra's loop has no bound (:739, :901); ours exists so
 * that termination can be proved (`docs/divergences.md` row 13). Exiting normally at the bound
 * would hand a truncated result downstream with nothing to tell it from a settled condition, so
 * `exhaust` fails the run with an error naming the bound. It goes straight to `exits.failed`
 * with nothing to clean up: the inhibitor means `budget` is empty, and `check` already took
 * `running`.
 *
 * **Every other exit cleans up the allowance.** A loop that leaves with allowance to spare holds
 * leftover `budget` tokens, so `finish`, `abort` and the four `leave-*` transitions each carry a
 * reset arc on `budget`. The reset cannot sit on `check`, which also fires on the repeat branch
 * and would wipe the allowance the next iteration is about to spend — hence the `exiting` and
 * `failing` hops. `running` is never reset: it is consumed with `one()` on every path, because
 * it holds exactly one token whenever the body does, so the marker stays a conservation law
 * (`running` = the body's token count) rather than something a reset erases.
 *
 * **`start` carries no reset.** A loop entry is entered once per run: it cannot sit inside
 * another combinator (`types.ts`, `StepDescription`), and the top-level chain has no back-edge,
 * so there is never a stale allowance to clear and every exit clears its own anyway. The reset
 * the budget idiom puts on `start` would be unobservable here, and under a concurrent re-entry
 * it would wipe a live allowance.
 *
 * **Where the allowance has to be seeded for a proof to mean anything — read this before quoting
 * a bound.** [IO-016]: every branch-enumerating analysis models one token per place a branch
 * names, whatever the action wrote. `start` writes `iterationBound` tokens into a place its
 * branch names once — that conforms to [IO-015], and the executor reports it as the [IO-016] AC4
 * warning — but a query seeded at the workflow's entry place sees an allowance of **one** at any
 * bound. So from the entry place, the proof covers the topology (every transition and branch is
 * reachable at an allowance of one) and not the cycle running more than once, nor leaving with
 * allowance to spare, which is exactly what the exit resets are for. Seeding `ready` and `budget`
 * directly is the post-`start` marking, and `tests/verify/loop.test.ts` proves the cycle there at
 * genuine allowances. What stays unproven is one action's deposit count — that `start` writes
 * `iterationBound` tokens — which the executor tests pin.
 *
 * **Sequential by construction.** One flow token circulates: `start` emits one `ready`, `enter`
 * turns it into one `body.in` plus one `running`, and `check` consumes both halves.
 *
 * **[TIME-012] applies and is harmless.** The reset arcs on `budget` restart the clocks of
 * `enter` (input) and `exhaust` (inhibitor). Both are immediate, `[0, inf)`, so a restart changes
 * nothing. Giving either a timing without revisiting this would reintroduce the trap.
 *
 * **What the step results hold.** The body's leaf records every iteration's final outcome under
 * the body's id, and Mastra writes each iteration there too (`Object.assign(stepResults, …)`,
 * :779), so the next entry — and the condition, which runs after that write — see the latest
 * iteration. When the loop fails on its own account (bound exceeded, a throwing condition, a
 * runner that cannot evaluate conditions), it records that failure under the body's id as well,
 * because that is where Mastra writes a loop's result (`handlers/entry.ts:811`).
 */
export const loopGadget: Gadget = (entry, next, ctx) => {
  if (entry.kind !== 'loop') throw new Error(`loopGadget received a '${entry.kind}' entry`);

  const { iterationBound: bound, loopType, body } = entry;
  // The body always runs once before the condition is first asked, so a bound below 1 describes
  // no loop — and `start` would owe `budget` tokens its own `And` branch claims.
  if (!Number.isInteger(bound) || bound < 1 || bound > MAX_ITERATION_BOUND) {
    throw new Error(
      `loop '${entry.id}' has iterationBound=${String(bound)}; it must be a whole number in ` +
        `[1, ${MAX_ITERATION_BOUND}], because the body always runs at least once.`,
    );
  }
  if (loopType !== 'dowhile' && loopType !== 'dountil') {
    throw new Error(`loop '${entry.id}' has an unknown loopType '${String(loopType)}'`);
  }

  const { names, path, exits } = ctx;
  const own = <T>(role: string): Place<T> => place<T>(names.entryPlace(path, entry.id, role));
  const named = (role: string) => names.entryTransition(path, entry.id, role);

  const inPlace = own<FlowToken>('loop-in');
  /** The iteration allowance. Unit tokens: the count is the state, the value carries nothing. */
  const budget = own<null>('budget');
  const ready = own<LoopState>('ready');
  const running = own<IterationMarker>('running');
  /** The body's successful output, waiting for the condition. */
  const produced = own<FlowToken>('produced');
  /** The condition said stop. */
  const exiting = own<FlowToken>('exiting');
  /** The condition threw. `check` has already taken `running`. */
  const failing = own<FailureToken>('failing');
  /** The body's own non-success outcomes, each held until the marker and allowance are cleared. */
  const bodyExits: Exits = {
    failed: own<FailureToken>('body-failed'),
    bailed: own<BailToken>('body-bailed'),
    suspended: own<SuspendToken>('body-suspended'),
    paused: own<PauseToken>('body-paused'),
  };

  // Same path as the loop: see "The body shares the loop's path" above.
  const bodyIn = ctx.emitNested(body, path, produced, bodyExits).inPlace;

  const loopFailure = (error: unknown): FailureToken => ({ stepId: entry.id, error });

  // Decide, then emit ([EXEC-031]). A runner that cannot evaluate conditions is found here,
  // before the body runs, so no step's side effect executes for a loop that could never decide
  // whether to repeat.
  const start = Transition.builder(named('start'))
    .inputs(one(inPlace))
    .outputs(xor(and(outPlace(ready), outPlace(budget)), outPlace(exits.failed)))
    .action(async (c) => {
      const incoming = c.input(inPlace);
      const scope = scopeOf(c);
      // Probed inside a `try`: reading the capability can itself throw (a getter), and a throw
      // here would lose the consumed input and strand the run without naming a place.
      let capable = false;
      let probeError: unknown;
      try {
        capable = typeof scope.runner.evaluateLoopCondition === 'function';
      } catch (e) {
        probeError = e;
      }
      if (!capable) {
        const error =
          probeError ??
          new Error(
            `loop '${entry.id}' needs StepRunner.evaluateLoopCondition, which this run's runner ` +
              'does not implement; failing before the body runs',
          );
        scope.recordStepResult(body.id, { status: 'failed', error });
        c.output(exits.failed, loopFailure(error));
        return;
      }
      c.output(ready, { data: incoming.data, iteration: 0 });
      for (let i = 0; i < bound; i++) c.output(budget, null);
    })
    .build();

  const enter = Transition.builder(named('enter'))
    .inputs(one(ready), one(budget))
    .priority(1)
    .outputs(and(outPlace(bodyIn), outPlace(running)))
    .action(async (c) => {
      const state = c.input(ready);
      c.output(bodyIn, { data: state.data });
      c.output(running, { iteration: state.iteration + 1 });
    })
    .build();

  const exhaust = Transition.builder(named('exhaust'))
    .inputs(one(ready))
    .inhibitor(budget)
    .priority(0)
    .outputs(outPlace(exits.failed))
    .action(async (c) => {
      const state = c.input(ready);
      const scope = scopeOf(c);
      const error = new Error(
        `loop '${entry.id}' reached its iterationBound of ${bound} and the ${loopType} condition ` +
          `still asked for another iteration (${state.iteration} ran). The bound is this ` +
          "engine's, not Mastra's, whose loop has none.",
      );
      scope.recordStepResult(body.id, { status: 'failed', error });
      c.output(exits.failed, loopFailure(error));
    })
    .build();

  const check = Transition.builder(named('check'))
    .inputs(one(produced), one(running))
    .outputs(xor(outPlace(ready), outPlace(exiting), outPlace(failing)))
    .action(async (c) => {
      const output = c.input(produced);
      const marker = c.input(running);
      const scope = scopeOf(c);

      // Decide, then emit: the inputs are already consumed and are not restored, so the awaiting
      // half writes nothing and the writing half cannot throw.
      let decision: { readonly kind: 'repeat' | 'exit' } | { readonly kind: 'failed'; readonly error: unknown };
      try {
        const evaluate = scope.runner.evaluateLoopCondition;
        if (evaluate === undefined) {
          throw new Error(`loop '${entry.id}' needs StepRunner.evaluateLoopCondition`);
        }
        const held = await evaluate.call(scope.runner, entry.id, output.data, marker.iteration, viewOf(scope, path));
        // Truthiness, as `while (dowhile ? isTrue : !isTrue)` reads it (:901).
        decision = (loopType === 'dowhile' ? Boolean(held) : !held) ? { kind: 'repeat' } : { kind: 'exit' };
      } catch (error) {
        // Mastra does not catch this (:835, no try) and `run.start()` rejects with no status.
        // A net cannot reject; failing the run is the nearest outcome it can declare.
        decision = { kind: 'failed', error };
      }

      switch (decision.kind) {
        case 'repeat':
          // The body's own output is the next iteration's input (:764, :780).
          c.output(ready, { data: output.data, iteration: marker.iteration });
          return;
        case 'exit':
          c.output(exiting, output);
          return;
        case 'failed':
          scope.recordStepResult(body.id, { status: 'failed', error: decision.error });
          c.output(failing, loopFailure(decision.error));
          return;
      }
    })
    .build();

  const finish = Transition.builder(named('finish'))
    .inputs(one(exiting))
    .reset(budget)
    .outputs(outPlace(next))
    .action(async (c) => {
      c.output(next, c.input(exiting));
    })
    .build();

  const abort = Transition.builder(named('abort'))
    .inputs(one(failing))
    .reset(budget)
    .outputs(outPlace(exits.failed))
    .action(async (c) => {
      c.output(exits.failed, c.input(failing));
    })
    .build();

  // Any non-success iteration ends the loop with that result (:791-801). The body's leaf has
  // already recorded it under the body's id, which is also where Mastra keeps the loop's result.
  const leave = <T>(role: string, from: Place<T>, to: Place<T>) =>
    Transition.builder(named(`leave-${role}`))
      .inputs(one(from), one(running))
      .reset(budget)
      .outputs(outPlace(to))
      .action(async (c) => {
        c.output(to, c.input(from));
      })
      .build();

  return {
    inPlace,
    transitions: [
      start,
      enter,
      exhaust,
      check,
      finish,
      abort,
      leave('failed', bodyExits.failed, exits.failed),
      leave('bailed', bodyExits.bailed, exits.bailed),
      leave('suspended', bodyExits.suspended, exits.suspended),
      leave('paused', bodyExits.paused, exits.paused),
    ],
  };
};

import { Transition, and, one, outPlace, place, xor, type Place } from 'libpetri';
import { scopeOf, viewOf, type RunScope } from '../scope.js';
import type {
  BailToken,
  CanceledToken,
  Exits,
  FailureToken,
  FlowToken,
  PauseToken,
  StepRecord,
  SuspendToken,
} from '../types.js';
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
 * Between iterations: the value the next iteration is fed, and Mastra's `iteration` counter — the
 * number of iterations completed, so the next body run is iteration `iteration + 1`.
 *
 * `iteration` is payload only. It is what the body's record and the condition are told
 * (`iterationCount`), and no transition is enabled or disabled by it: the bound is the `budget`
 * place, never this number.
 */
interface LoopState {
  readonly data: unknown;
  readonly iteration: number;
}

/**
 * The pending marker for the one iteration in flight.
 *
 * The body is a leaf gadget: it consumes a `FlowToken` and produces one, so nothing the loop
 * needs on the far side of the body can be trusted to travel through it. The iteration number
 * rides here instead, beside the body's token, and every way out of the body consumes it.
 */
interface IterationMarker {
  readonly iteration: number;
}

/**
 * `.dowhile` / `.dountil`.
 *
 * **What Mastra does** (`handlers/control-flow.ts`, `executeLoop`):
 *
 * - **Where it starts.** `iteration` starts at `stepResults[body].metadata.iterationCount - 1`
 *   when that is truthy, else 0 (:727-728), and the first iteration's input is
 *   `stepResults[body].payload` when the body already has a record carrying one, else the
 *   previous entry's output (:729-733). Neither test looks at the record's status or at whether
 *   this is a resume: **any** record under the body's id with an own `payload` wins — so a loop
 *   that follows `.then(s)` over the same `s` re-feeds `s`'s *input*, not its output. Reproduced
 *   as written (`docs/divergences.md` row 27).
 * - Every later iteration is fed the previous iteration's output. The body is called with
 *   `prevOutput: result.output` (:764), and `result` is reassigned to the body's own result
 *   (:780).
 * - The body runs with `iterationCount: iteration + 1` (:771), which the step handler writes as
 *   `metadata.iterationCount` on the body's record (`handlers/step.ts:177`). The condition is then
 *   evaluated with `inputData: result.output` (:843) and the same `iterationCount` (:847);
 *   `iteration` is incremented after it (:883). Both loop types are one
 *   `do { body; condition } while (…)` (:739-901), differing only in the test at :901.
 * - A non-success body result ends the loop at once, returned as the loop's own result (:791-801).
 * - The loop's result is the last body result (:914), stored under the **body's** step id
 *   (`handlers/entry.ts:811-812`), which is where the next entry reads it
 *   (`default.ts:1150-1151`).
 * - The body runs under the loop's own `executionContext`, passed unchanged (:760), so its
 *   `executionPath` — what `handlers/step.ts:180,395` record — is the loop's. A `.parallel()`
 *   arm, by contrast, gets `[...executionPath, i]` (:244).
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
 * **Cancellation: Mastra's four checks, as arcs.** Mastra looks at its abort signal before the
 * entry (`default.ts:815`), before every body run (:742), after a body *success* (:807) and after
 * every condition (:889) — never inside the body, and never after a non-success body result,
 * which returns before :807 and is re-stamped `canceled` by the settle stage like any top-level
 * outcome (`handlers/entry.ts:815-817`). Given `ctx.cancel`, each check is a pair — the
 * transition that would continue is **inhibited** by the signal, and a **sweep** that reads it
 * consumes the waiting token into `exits.canceled`. The pair is what `cancelStructureViolations`
 * checks: each inhibited transition needs every input its sweep consumes, so stripping one of the
 * five inhibitors is refused before any proof runs.
 *
 * | Mastra's check          | waits in    | inhibited      | sweep            | also clears      |
 * |-------------------------|-------------|----------------|------------------|------------------|
 * | `default.ts:815`        | `loop-in`   | `start`        | `cancel-in`      | —                |
 * | :742 (and :889→repeat)  | `ready`     | `enter`, `exhaust` | `cancel-ready` | `budget` (reset) |
 * | :807                    | `produced`  | `check`        | `cancel-produced`| `running`, `budget` |
 * | :889 → exit             | `exiting`   | `finish`       | `cancel-exiting` | `budget` (reset) |
 *
 * `exhaust` is inhibited too because Mastra has no bound: its :889 check always comes before the
 * next iteration, so a cancel must win over our bound. The body is emitted **without** the
 * signal, so a body run that `enter` has started always runs — retries included, as
 * `executeStepWithRetry` never checks (`default.ts:455-460`). A canceled loop carries no output:
 * Mastra returns a bare `{ status: 'canceled' }` (:752, :817, :899).
 *
 * **The canceled record.** `handlers/entry.ts:810-812` then stores that bare result under the
 * body's id — `stepResults[getSingleStepEntryId(entry.step)] = execResults`, before the :815
 * re-stamp — **replacing** the last iteration's record: no `payload`, no timestamps, no
 * `metadata`. So `cancel-ready`, `cancel-produced` and `cancel-exiting` each write exactly
 * `{ status: 'canceled' }` under the body's id. `cancel-in` writes nothing: `default.ts:815`
 * returns before the entry runs, so `entry.ts` never stores a result. The record is written by the
 * sweep — the net has already decided the cancellation; the action only records it.
 *
 * **Every origin names the body.** The loop's own failure and its cancellation report
 * `stepId: body.id`, which is where Mastra keeps the loop's result — a named loop's own id has no
 * record, so an outcome naming it would name nothing the codec can find. The condition is still
 * asked by the loop's id, which is what the runner keys it by.
 *
 * **The body shares the loop's path.** The runner hands it on as the step's `executionPath`, and a
 * suspension records it in `suspendedPaths`. The price is that a loop's id defaults to its body's
 * id (the adapter falls back to it, as Mastra keys the result by it), so both would claim
 * `entryIn(path, id)`. The loop therefore never mints `.in`: its input is `loop-in`, and its other
 * roles are disjoint from the leaf's (`in`, `run`, `run-n`, `retry-n`, `attempt-n`, `cancel`). A
 * collision would throw at compile anyway, because `NameVocabulary` refuses to mint one name twice.
 *
 * **The iteration allowance is a place.** `budget` is seeded with `iterationBound` unit tokens by
 * `start` and spent one per iteration by `enter`. `enter` needs a token and `exhaust` is
 * inhibited by one, so every marking with a token in `ready` and no signal enables exactly one of
 * them. The exclusion is that inhibitor arc, not the priorities, which no analysis sees.
 *
 * **Exceeding the bound fails the run.** Mastra's loop has no bound (:739, :901); ours exists so
 * that termination can be guaranteed (`docs/divergences.md` row 13). Exiting normally at the bound
 * would hand a truncated result downstream with nothing to tell it from a settled condition, so
 * `exhaust` fails the run with an error naming the bound. The bound counts body runs of **this**
 * entry; a loop re-entered from a record continues Mastra's `iterationCount` but gets a fresh
 * allowance.
 *
 * **Every other exit cleans up the allowance.** `finish`, `abort`, every `leave-*` and the three
 * sweeps after `start` carry a reset arc on `budget`. The reset cannot sit on `check`, which also
 * fires on the repeat branch — hence the `exiting` and `failing` hops. `running` is never reset:
 * it is consumed with `one()` on every path, so it stays a conservation law (`running` = the
 * body's token count). `start` carries no reset: a loop is entered once per run (it cannot sit
 * inside another combinator, and the top-level chain has no back-edge), so there is never a stale
 * allowance to clear.
 *
 * **Where the allowance has to be seeded for a proof to mean anything.** [IO-016]: every
 * branch-enumerating analysis models one token per place a branch names. `start` writes
 * `iterationBound` tokens into a place its branch names once, so a query seeded at the entry place
 * sees an allowance of **one** at any bound. From the entry place the proof covers the topology;
 * seeding `ready` and `budget` directly — the post-`start` marking — proves the cycle at genuine
 * allowances (`tests/verify/loop.test.ts`). What stays unproven is `start`'s deposit count, which
 * the executor tests pin.
 *
 * **Declaration order.** The sweeps are declared after the transitions they race when an
 * inhibitor is missing, so the executor's tie-break (declaration order, [EXEC-002]) picks the
 * *wrong* one in a mutant. That is what lets a test show each inhibitor is load-bearing at run
 * time; with the inhibitors in place the order decides nothing.
 *
 * **[TIME-012] applies and is harmless.** Every reset on `budget` restarts the clocks of `enter`
 * and `exhaust`. Both are immediate, so a restart changes nothing.
 *
 * **What the step results hold.** The body's leaf records every iteration under the body's id,
 * with `metadata.iterationCount`, as Mastra's `Object.assign(stepResults, …)` (:779) does, so the
 * condition and the next entry see the latest iteration. When the loop fails on its own account
 * (bound exceeded, a throwing condition, a runner that cannot evaluate conditions), it records
 * that failure under the body's id, because that is where Mastra writes a loop's result; when it
 * is canceled after `start`, the bare canceled record above.
 *
 * **Re-entry reads whatever is there, `canceled` included.** `start` applies :727-734 to any
 * record, as Mastra does — it never looks at the status. A bare canceled record has no own
 * `payload` and no `iterationCount`, so a loop re-entered from one starts from the previous
 * entry's output at iteration 0, exactly as Mastra's would.
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

  const { names, path, viewPath, exits, cancel } = ctx;
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
  /**
   * The body's own non-success outcomes, each held until the marker and allowance are cleared.
   *
   * `canceled` is the loop's own exit, passed straight through, because nothing writes it: the
   * body is emitted without the signal, and a leaf writes `canceled` only from the sweep it gets
   * with one. Giving the body the signal would strand `running` and the allowance beside
   * `wf.canceled` — which `exactlyOneTerminal` under `cancel: true` reports — so a holding place
   * and a `leave-canceled` here would be structure no run or proof can reach.
   */
  const bodyExits: Exits = {
    failed: own<FailureToken>('body-failed'),
    bailed: own<BailToken>('body-bailed'),
    suspended: own<SuspendToken>('body-suspended'),
    paused: own<PauseToken>('body-paused'),
    canceled: exits.canceled,
  };

  // The loop's view path, and no signal: Mastra passes its `executionContext` unchanged (:760) and
  // never checks inside a body run.
  const bodyIn = ctx.emitNested(body, path, produced, bodyExits, { viewPath }).inPlace;

  // Named by the body: that is where the loop's result lives (`handlers/entry.ts:810-812`).
  const loopFailure = (error: unknown): FailureToken => ({ stepId: body.id, path: viewPath, error });
  // Before the loop's first transition nothing has run; between iterations a body has.
  const notStarted: CanceledToken = { origin: { stepId: body.id, path: viewPath }, started: false };
  const canceled: CanceledToken = { origin: { stepId: body.id, path: viewPath }, started: true };
  /**
   * Mastra's bare canceled result, replacing the last iteration's record (`handlers/entry.ts:811`).
   * Nothing else — no payload, no timestamps, no metadata — because Mastra's has nothing else.
   */
  const recordCanceled = (scope: RunScope): void => scope.recordStepResult(body.id, { status: 'canceled' });

  /** The loop's own failure, recorded where Mastra keeps a loop's result. */
  const recordFailure = (scope: RunScope, error: unknown, payload: unknown, iteration: number): void => {
    const record: StepRecord = {
      status: 'failed',
      error,
      payload,
      endedAt: scope.epochNow(),
      ...(iteration > 0 ? { metadata: { iterationCount: iteration } } : {}),
    };
    scope.recordStepResult(body.id, record);
  };

  // Decide, then emit ([EXEC-031]). A runner that cannot evaluate conditions is found here,
  // before the body runs, so no step's side effect executes for a loop that could never decide
  // whether to repeat.
  const start = Transition.builder(named('start'))
    .inputs(one(inPlace))
    .outputs(xor(and(outPlace(ready), outPlace(budget)), outPlace(exits.failed)))
    .action(async (c) => {
      const incoming = c.input(inPlace);
      const scope = scopeOf(c);

      // Re-entry from a record (:727-734): any record under the body's id with an own `payload`,
      // whatever its status — `canceled` included — and whether or not this is a resume.
      const previous = scope.getStepResult(body.id);
      const prevCount = previous?.metadata?.iterationCount;
      const iteration = prevCount ? prevCount - 1 : 0;
      const data = previous !== undefined && Object.hasOwn(previous, 'payload') ? previous.payload : incoming.data;

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
        recordFailure(scope, error, data, 0);
        c.output(exits.failed, loopFailure(error));
        return;
      }
      c.output(ready, { data, iteration });
      for (let i = 0; i < bound; i++) c.output(budget, null);
    });

  const enter = Transition.builder(named('enter'))
    .inputs(one(ready), one(budget))
    .priority(1)
    .outputs(and(outPlace(bodyIn), outPlace(running)))
    .action(async (c) => {
      const state = c.input(ready);
      const iteration = state.iteration + 1;
      // `iteration` on the flow token is what the leaf stamps as `metadata.iterationCount`.
      c.output(bodyIn, { data: state.data, iteration });
      c.output(running, { iteration });
    });

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
          `still asked for another iteration (iterationCount ${state.iteration}). The bound is ` +
          "this engine's, not Mastra's, whose loop has none.",
      );
      // The payload of the iteration that last ran, which is what Mastra's last body result holds.
      const last = scope.getStepResult(body.id);
      recordFailure(scope, error, last === undefined ? state.data : last.payload, state.iteration);
      c.output(exits.failed, loopFailure(error));
    });

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
        const held = await evaluate.call(scope.runner, entry.id, output.data, marker.iteration, viewOf(scope, viewPath));
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
          // The iteration stops here: the next entry is not an iteration of this loop.
          c.output(exiting, { data: output.data });
          return;
        case 'failed': {
          const last = scope.getStepResult(body.id);
          recordFailure(scope, decision.error, last === undefined ? output.data : last.payload, marker.iteration);
          c.output(failing, loopFailure(decision.error));
          return;
        }
      }
    });

  const finish = Transition.builder(named('finish'))
    .inputs(one(exiting))
    .reset(budget)
    .outputs(outPlace(next))
    .action(async (c) => {
      c.output(next, c.input(exiting));
    });

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
  // Not gated: that return precedes the :807 check, and the settle stage re-stamps it on cancel.
  const leave = <T>(role: string, from: Place<T>, to: Place<T>) =>
    Transition.builder(named(`leave-${role}`))
      .inputs(one(from), one(running))
      .reset(budget)
      .outputs(outPlace(to))
      .action(async (c) => {
        c.output(to, c.input(from));
      })
      .build();

  const transitions: Transition[] = [];
  const sweeps: Transition[] = [];
  if (cancel !== undefined) {
    start.inhibitor(cancel);
    enter.inhibitor(cancel);
    exhaust.inhibitor(cancel);
    check.inhibitor(cancel);
    finish.inhibitor(cancel);

    // Before the entry (`default.ts:815`): nothing has started, nothing is recorded — Mastra returns
    // before `entry.ts` stores a result.
    sweeps.push(
      Transition.builder(named('cancel-in'))
        .inputs(one(inPlace))
        .read(cancel)
        .outputs(outPlace(exits.canceled))
        .action(async (c) => {
          c.input(inPlace);
          c.output(exits.canceled, notStarted);
        })
        .build(),
    );
    // Before a body run (:742), which is also where a repeat decided under cancel lands (:889).
    // Each sweep after `start` records the bare canceled result, as `entry.ts:811` stores it.
    sweeps.push(
      Transition.builder(named('cancel-ready'))
        .inputs(one(ready))
        .read(cancel)
        .reset(budget)
        .outputs(outPlace(exits.canceled))
        .action(async (c) => {
          c.input(ready);
          recordCanceled(scopeOf(c));
          c.output(exits.canceled, canceled);
        })
        .build(),
    );
    // After a body success, before the condition (:807): the condition is never asked.
    sweeps.push(
      Transition.builder(named('cancel-produced'))
        .inputs(one(produced), one(running))
        .read(cancel)
        .reset(budget)
        .outputs(outPlace(exits.canceled))
        .action(async (c) => {
          c.input(produced);
          c.input(running);
          recordCanceled(scopeOf(c));
          c.output(exits.canceled, canceled);
        })
        .build(),
    );
    // After a condition that said stop (:889): the loop's success is not handed on.
    sweeps.push(
      Transition.builder(named('cancel-exiting'))
        .inputs(one(exiting))
        .read(cancel)
        .reset(budget)
        .outputs(outPlace(exits.canceled))
        .action(async (c) => {
          c.input(exiting);
          recordCanceled(scopeOf(c));
          c.output(exits.canceled, canceled);
        })
        .build(),
    );
  }

  transitions.push(
    start.build(),
    enter.build(),
    exhaust.build(),
    check.build(),
    finish.build(),
    abort,
    leave('failed', bodyExits.failed, exits.failed),
    leave('bailed', bodyExits.bailed, exits.bailed),
    leave('suspended', bodyExits.suspended, exits.suspended),
    leave('paused', bodyExits.paused, exits.paused),
    // Declared last: see "Declaration order" above.
    ...sweeps,
  );

  return { inPlace, transitions };
};

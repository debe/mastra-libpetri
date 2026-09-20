import { Transition, place, one, outPlace, xor, delayed, exact, type Place, type TransitionAction } from 'libpetri';
import type { FailureToken, FlowToken, StepRunner } from '../types.js';
import type { Gadget, GadgetContext } from './types.js';

/**
 * A single step.
 *
 * Failure is a declared branch, not an exception: `xor(success, failure)` means the verifier
 * sees both outcomes and a failing step deposits a token instead of unwinding. It also
 * satisfies [IO-015] — the declared branches are exactly the runtime outcomes, because the
 * action picks one and writes its complete set.
 */
export const stepGadget: Gadget = (entry, next, ctx) => {
  if (entry.kind !== 'step') throw new Error(`stepGadget received a '${entry.kind}' entry`);
  const inPlace = place<FlowToken>(ctx.names.entryIn(ctx.path, entry.id));
  const transition = Transition.builder(ctx.names.entryRun(ctx.path, entry.id))
    .inputs(one(inPlace))
    .outputs(xor(outPlace(next), outPlace(ctx.failed)))
    .action(stepAction(entry.id, inPlace, next, ctx.failed, ctx.runner))
    .build();
  return { inPlace, transitions: [transition] };
};

/**
 * `.sleep` / `.sleepUntil`.
 *
 * Both are lower bounds only. Neither emits `deadline` or `window`: under [CORE-073] a restore
 * starts every clock fresh, so an upper bound would receive a fresh full budget and a promised
 * deadline could be silently missed. A lower bound re-waits, which is safe.
 * See `docs/divergences.md` row 1.
 */
export const sleepGadget: Gadget = (entry, next, ctx) => {
  if (entry.kind !== 'sleep' && entry.kind !== 'sleepUntil') {
    throw new Error(`sleepGadget received a '${entry.kind}' entry`);
  }
  const inPlace = place<FlowToken>(ctx.names.entryIn(ctx.path, entry.id));
  const transition = Transition.builder(ctx.names.entryWake(ctx.path, entry.id))
    // `exact` is soft ([TIME-006]): it fires at the first opportunity at or after the instant
    // and is never force-disabled for being observed late.
    .timing(entry.kind === 'sleep' ? delayed(entry.durationMs) : exact(entry.atEpochMs))
    .inputs(one(inPlace))
    .outputs(outPlace(next))
    .action(async (ctx2) => { ctx2.output(next, ctx2.input(inPlace)); })
    .build();
  return { inPlace, transitions: [transition] };
};

/**
 * Decide, then emit.
 *
 * The executor consumes inputs before the action runs and does not restore them on failure
 * ([EXEC-031]), so the body computes first — where a throw writes nothing — and only then
 * writes exactly one branch's complete output set. A `try` that wrote in both halves would
 * produce duplicate tokens and satisfy neither branch of the `xor`.
 */
export function stepAction(
  stepId: string,
  from: Place<FlowToken>,
  next: Place<FlowToken>,
  failed: Place<FailureToken>,
  runner: StepRunner,
): TransitionAction {
  return async (ctx) => {
    const incoming = ctx.input(from);

    let outcome: Awaited<ReturnType<StepRunner['run']>>;
    try {
      outcome = await runner.run(stepId, incoming.data);
    } catch (error) {
      // A runner that throws is still a failed step, not a lost token. Converting here keeps
      // the failure on the declared branch instead of destroying the consumed input.
      outcome = { status: 'failed', error };
    }

    if (outcome.status === 'success') ctx.output(next, { data: outcome.output });
    else ctx.output(failed, { stepId, error: outcome.error });
  };
}

/** Placeholder for a gadget not yet built, so an unsupported entry fails loudly at compile. */
export function unimplemented(kind: string): Gadget {
  return (_entry, _next, ctx: GadgetContext) => {
    throw new Error(
      `'${kind}' entries are not compiled yet (entry at path ${ctx.path.join('-')}). ` +
        'See tasks/todo.md, M1 Track A.',
    );
  };
}

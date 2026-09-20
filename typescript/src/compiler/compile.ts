import { createHash } from 'node:crypto';
import {
  PetriNet,
  Transition,
  place,
  one,
  outPlace,
  xor,
  delayed,
  exact,
  type Place,
  type TransitionAction,
} from 'libpetri';
import { NameVocabulary, WF_DONE, WF_FAILED, type EntryPath } from './names.js';
import type {
  CompiledWorkflow,
  EntryDescription,
  FailureToken,
  FlowToken,
  NetMap,
  StepRunner,
  WorkflowDescription,
} from './types.js';

export interface CompileOptions {
  /** Delegate that actually runs a step. A verification build may pass one that never fires. */
  readonly runner: StepRunner;
}

/**
 * Compiles a workflow description into one Coloured Time Petri Net.
 *
 * **The emission rule.** Entry *i* owns an input place. Its transition consumes that place and
 * produces into entry *i+1*'s input place, or into `wf.done` for the last entry. Nothing else
 * connects them: the chain is the arcs, not a loop in the engine.
 *
 * **Failure is a branch, not an exception** — every run transition declares
 * `xor(success, failure)`, so the verifier sees both outcomes and a failing step deposits a
 * token rather than unwinding. That also satisfies [IO-015]: the declared branches are exactly
 * the runtime outcomes, because the action picks one and writes its complete set.
 *
 * **Timing is model timing.** `.sleep(ms)` compiles to `delayed(ms)` and `.sleepUntil(date)` to
 * `exact(at)`, rather than to a timer the model cannot see. Neither emits a hard bound
 * (`deadline` / `window`): under [CORE-073] a restore starts every clock fresh, so an upper
 * bound would receive a fresh full budget and a promised deadline could be silently missed.
 * Lower bounds re-wait, which is safe. See `docs/divergences.md` row 1.
 */
export function compile(description: WorkflowDescription, options: CompileOptions): CompiledWorkflow {
  if (description.entries.length === 0) {
    throw new Error(`workflow '${description.id}' has no entries; nothing to compile`);
  }

  const names = new NameVocabulary();
  const transitionToEntry = new Map<string, { path: EntryPath; id: string }>();
  const placeToEntry = new Map<string, { path: EntryPath; id: string }>();

  const donePlace = place<FlowToken>(names.reserve(WF_DONE, 'workflow success terminal'));
  const failedPlace = place<FailureToken>(names.reserve(WF_FAILED, 'workflow failure terminal'));

  // Input places first, so a transition can reference its successor's place by identity rather
  // than by name — name-only identity is what makes an accidental collision silent.
  const inPlaces = description.entries.map((entry, index) => {
    const path: EntryPath = [index];
    const name = names.entryIn(path, entry.id);
    placeToEntry.set(name, { path, id: entry.id });
    return place<FlowToken>(name);
  });

  const transitions = description.entries.map((entry, index) => {
    const path: EntryPath = [index];
    const from = inPlaces[index]!;
    const next = inPlaces[index + 1] ?? donePlace;
    const transition = emitEntry(entry, path, from, next, failedPlace, names, options.runner);
    transitionToEntry.set(transition.name, { path, id: entry.id });
    return transition;
  });

  const net = PetriNet.builder(description.id)
    .places(donePlace, failedPlace)
    .transitions(...transitions)
    .build();

  const netMap: NetMap = { transitionToEntry, placeToEntry };

  return {
    net,
    netMap,
    entryPlace: inPlaces[0]!,
    donePlace,
    failedPlace,
    structuralHash: structuralHash(description, names.names()),
  };
}

function emitEntry(
  entry: EntryDescription,
  path: EntryPath,
  from: Place<FlowToken>,
  next: Place<FlowToken>,
  failed: Place<FailureToken>,
  names: NameVocabulary,
  runner: StepRunner,
): Transition {
  switch (entry.kind) {
    case 'step':
      return Transition.builder(names.entryRun(path, entry.id))
        .inputs(one(from))
        .outputs(xor(outPlace(next), outPlace(failed)))
        .action(stepAction(entry.id, from, next, failed, runner))
        .build();

    case 'sleep':
      // A lower bound only. It re-waits in full across a restore, which is sound because
      // restores are occasional — see docs/divergences.md row 1.
      return Transition.builder(names.entryWake(path, entry.id))
        .inputs(one(from))
        .timing(delayed(entry.durationMs))
        .outputs(outPlace(next))
        .action(passThrough(from, next))
        .build();

    case 'sleepUntil':
      // `exact` is soft ([TIME-006]): it fires at the first opportunity at or after the
      // instant and is never force-disabled for being observed late.
      return Transition.builder(names.entryWake(path, entry.id))
        .inputs(one(from))
        .timing(exact(entry.atEpochMs))
        .outputs(outPlace(next))
        .action(passThrough(from, next))
        .build();
  }
}

/**
 * Decide, then emit.
 *
 * The executor consumes inputs before the action runs and does not restore them on failure
 * ([EXEC-031]), so the body computes first — where a throw writes nothing — and only then
 * writes exactly one branch's complete output set. A `try` that wrote in both halves would
 * produce duplicate tokens and satisfy neither branch of the `xor`.
 */
function stepAction(
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

function passThrough(from: Place<FlowToken>, next: Place<FlowToken>): TransitionAction {
  return async (ctx) => {
    ctx.output(next, ctx.input(from));
  };
}

/**
 * Keys the compile cache. Covers structure and the generated name set, never step actions or
 * payloads, so two runs of the same workflow shape hash alike.
 */
function structuralHash(description: WorkflowDescription, names: readonly string[]): string {
  const shape = description.entries.map((entry) =>
    entry.kind === 'sleep'
      ? `${entry.kind}:${entry.id}:${entry.durationMs}`
      : entry.kind === 'sleepUntil'
        ? `${entry.kind}:${entry.id}:${entry.atEpochMs}`
        : `${entry.kind}:${entry.id}`,
  );
  return createHash('sha256')
    .update(JSON.stringify({ v: 1, id: description.id, shape, names }))
    .digest('hex')
    .slice(0, 16);
}

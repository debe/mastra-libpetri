import { createHash } from 'node:crypto';
import { PetriNet, place, type Place, type Transition } from 'libpetri';
import { NameVocabulary, WF_DONE, WF_FAILED, type EntryPath } from './names.js';
import { stepGadget, sleepGadget } from './gadgets/leaf.js';
import { parallelGadget } from './gadgets/parallel.js';
import { branchGadget } from './gadgets/branch.js';
import { loopGadget } from './gadgets/loop.js';
import { foreachGadget } from './gadgets/foreach.js';
import type { Gadget, GadgetContext, GadgetResult } from './gadgets/types.js';
import type {
  CompiledWorkflow,
  EntryDescription,
  FailureToken,
  FlowToken,
  StepRunner,
  WorkflowDescription,
} from './types.js';

export interface CompileOptions {
  /** Delegate that actually runs a step. A verification build may pass one that never fires. */
  readonly runner: StepRunner;
  /** Override or extend the gadget registry — used by tests to compile one gadget in isolation. */
  readonly gadgets?: Partial<Record<EntryDescription['kind'], Gadget>>;
}

/** One gadget per entry kind. Composite gadgets land here as they are built. */
export function defaultGadgets(): Record<EntryDescription['kind'], Gadget> {
  return {
    step: stepGadget,
    sleep: sleepGadget,
    sleepUntil: sleepGadget,
    parallel: parallelGadget,
    branch: branchGadget,
    loop: loopGadget,
    foreach: foreachGadget,
  };
}

/**
 * Compiles a workflow description into one Coloured Time Petri Net.
 *
 * **The emission rule.** Entry *i* owns an input place. Its gadget produces into entry *i+1*'s
 * input place, or into `wf.done` for the last entry. Nothing else connects them: the chain is
 * the arcs, not a loop in the engine ([ADR 0001]).
 *
 * The walk is right to left, because an entry needs its successor's place to emit into. A
 * composite gadget recurses through `ctx.emitNested` without knowing what its children are.
 */
export function compile(description: WorkflowDescription, options: CompileOptions): CompiledWorkflow {
  if (description.entries.length === 0) {
    throw new Error(`workflow '${description.id}' has no entries; nothing to compile`);
  }

  const names = new NameVocabulary();
  const gadgets = { ...defaultGadgets(), ...options.gadgets };
  const transitionToEntry = new Map<string, { path: EntryPath; id: string }>();
  const placeToEntry = new Map<string, { path: EntryPath; id: string }>();

  const donePlace = place<FlowToken>(names.reserve(WF_DONE, 'workflow success terminal'));
  const failedPlace = place<FailureToken>(names.reserve(WF_FAILED, 'workflow failure terminal'));

  const extraPlaces: Place<unknown>[] = [];
  const transitions: Transition[] = [];

  const emit = (
    entry: EntryDescription,
    path: EntryPath,
    next: Place<FlowToken>,
    failed: Place<FailureToken> = failedPlace,
  ): GadgetResult => {
    const gadget = gadgets[entry.kind];
    if (gadget === undefined) throw new Error(`no gadget registered for '${entry.kind}'`);

    const ctx: GadgetContext = { path, names, runner: options.runner, failed, emitNested: emit };
    const result = gadget(entry, next, ctx);

    placeToEntry.set(result.inPlace.name, { path, id: entry.id });
    for (const t of result.transitions) {
      transitions.push(t);
      transitionToEntry.set(t.name, { path, id: entry.id });
    }
    if (result.places) extraPlaces.push(...result.places);
    return result;
  };

  // Right to left: entry i produces into entry i+1's place, so that place must exist first.
  let next: Place<FlowToken> = donePlace;
  let first: Place<FlowToken> = donePlace;
  for (let i = description.entries.length - 1; i >= 0; i--) {
    first = emit(description.entries[i]!, [i], next).inPlace;
    next = first;
  }

  const net = PetriNet.builder(description.id)
    .places(donePlace, failedPlace, ...extraPlaces)
    .transitions(...transitions)
    .build();

  return {
    net,
    netMap: { transitionToEntry, placeToEntry },
    entryPlace: first,
    donePlace,
    failedPlace,
    structuralHash: structuralHash(description, names.names()),
  };
}

/**
 * Keys the compile cache. Covers structure and the generated name set, never step actions or
 * payloads, so two runs of the same workflow shape hash alike.
 */
function structuralHash(description: WorkflowDescription, names: readonly string[]): string {
  const shape = (entry: EntryDescription): unknown => {
    switch (entry.kind) {
      case 'sleep': return [entry.kind, entry.id, entry.durationMs];
      case 'sleepUntil': return [entry.kind, entry.id, entry.atEpochMs];
      case 'parallel':
      case 'branch': return [entry.kind, entry.id, entry.arms.map(shape)];
      case 'loop': return [entry.kind, entry.id, entry.loopType, entry.maxIterations, shape(entry.body)];
      case 'foreach': return [entry.kind, entry.id, entry.concurrency, shape(entry.body)];
      default: return [entry.kind, entry.id];
    }
  };
  return createHash('sha256')
    .update(JSON.stringify({ v: 2, id: description.id, shape: description.entries.map(shape), names }))
    .digest('hex')
    .slice(0, 16);
}

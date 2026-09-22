import { createHash } from 'node:crypto';
import { PetriNet, place, type Place, type Transition } from 'libpetri';
import {
  NameVocabulary,
  WF_BAILED,
  WF_DONE,
  WF_FAILED,
  WF_PAUSED,
  WF_SUSPENDED,
  type EntryPath,
} from './names.js';
import { stepGadget, sleepGadget } from './gadgets/leaf.js';
import { parallelGadget } from './gadgets/parallel.js';
import { branchGadget } from './gadgets/branch.js';
import { loopGadget } from './gadgets/loop.js';
import { foreachGadget } from './gadgets/foreach.js';
import type { Gadget, GadgetContext, GadgetResult } from './gadgets/types.js';
import type {
  BailToken,
  CompiledWorkflow,
  EntryDescription,
  Exits,
  FailureToken,
  FlowToken,
  PauseToken,
  StepDescription,
  SuspendToken,
  Terminals,
  WorkflowDescription,
} from './types.js';

/**
 * The largest net `compile()` will emit, in places — a stopgap, not a design limit.
 *
 * libpetri's `PrecompiledNetExecutor` (the one the kernel runs) spins synchronously on some nets
 * a little over 4096 places: a bare chain of 4097 places completes in ~120ms and one of 4098
 * never returns, and `run(timeout, 'close')` cannot interrupt it because the loop never yields.
 * `BitmapNetExecutor` runs the same 4098-place chain in ~115ms. Reported upstream with that
 * repro; the exact trigger is not understood here, which is why the guard is conservative. A hang
 * no timeout can reach is the worst failure there is, so above this size compilation refuses by
 * name instead. Real workflows sit far below it; lift it when the executor is fixed.
 */
export const MAX_NET_PLACES = 4096;

export interface CompileOptions {
  /** Override or extend the gadget registry — used by tests to compile one gadget in isolation. */
  readonly gadgets?: Partial<Record<EntryDescription['kind'], Gadget>>;
}

/** One gadget per entry kind. */
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
 * input place, or into `wf.done` for the last entry; every other outcome goes to the workflow's
 * terminal for it. Nothing else connects them: the chain is the arcs, not a loop in the engine
 * ([ADR 0001]).
 *
 * The walk is right to left, because an entry needs its successor's place to emit into. A
 * combinator compiles its arms through `ctx.emitNested` without knowing what they are.
 *
 * **No runner.** The net is a function of the description alone; the kernel supplies the runner
 * per run. So two runs of one shape can share one compiled net, keyed by `structuralHash`.
 */
export function compile(description: WorkflowDescription, options: CompileOptions = {}): CompiledWorkflow {
  if (description.entries.length === 0) {
    // Mastra refuses this too, before persisting anything (`WORKFLOW_EXECUTE_EMPTY_GRAPH`).
    throw new Error(`workflow '${description.id}' has no entries; nothing to compile`);
  }

  const names = new NameVocabulary();
  const gadgets = { ...defaultGadgets(), ...options.gadgets };
  const transitionToEntry = new Map<string, { path: EntryPath; id: string }>();
  const placeToEntry = new Map<string, { path: EntryPath; id: string }>();

  const terminals: Terminals = {
    done: place<FlowToken>(names.reserve(WF_DONE, 'workflow success terminal')),
    failed: place<FailureToken>(names.reserve(WF_FAILED, 'workflow failure terminal')),
    bailed: place<BailToken>(names.reserve(WF_BAILED, 'workflow early-exit terminal')),
    suspended: place<SuspendToken>(names.reserve(WF_SUSPENDED, 'workflow suspend terminal')),
    paused: place<PauseToken>(names.reserve(WF_PAUSED, 'workflow pause terminal')),
  };
  const topLevelExits: Exits = {
    failed: terminals.failed,
    bailed: terminals.bailed,
    suspended: terminals.suspended,
    paused: terminals.paused,
  };

  const extraPlaces: Place<unknown>[] = [];
  const transitions: Transition[] = [];

  const emit = (
    entry: EntryDescription,
    path: EntryPath,
    next: Place<FlowToken>,
    exits: Exits,
    nextIsResult: boolean,
  ): GadgetResult => {
    const gadget = gadgets[entry.kind];
    if (gadget === undefined) throw new Error(`no gadget registered for '${entry.kind}'`);

    const ctx: GadgetContext = {
      path,
      names,
      exits,
      nextIsResult,
      // An arm's `next` is always a combinator-internal place, never the run's result.
      emitNested: (step: StepDescription, childPath, childNext, childExits) =>
        emit(step, childPath, childNext, childExits, false),
    };
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
  const last = description.entries.length - 1;
  let next: Place<FlowToken> = terminals.done;
  for (let i = last; i >= 0; i--) {
    next = emit(description.entries[i]!, [i], next, topLevelExits, i === last).inPlace;
  }

  const net = PetriNet.builder(description.id)
    .places(
      terminals.done,
      terminals.failed,
      terminals.bailed,
      terminals.suspended,
      terminals.paused,
      ...extraPlaces,
    )
    .transitions(...transitions)
    .build();

  if (net.places.size > MAX_NET_PLACES) {
    throw new Error(
      `workflow '${description.id}' compiles to ${net.places.size} places, above the ` +
        `${MAX_NET_PLACES} this engine can currently run (see MAX_NET_PLACES in compile.ts)`,
    );
  }

  return {
    net,
    netMap: { transitionToEntry, placeToEntry },
    entryPlace: next,
    terminals,
    structuralHash: structuralHash(description, names.names()),
  };
}

/**
 * Keys the compile cache. Covers structure and the generated name set, never step actions or
 * payloads, so two runs of the same workflow shape hash alike.
 *
 * A per-run wait hashes as `perRun`, not as a value — that is the point of it being per run.
 */
function structuralHash(description: WorkflowDescription, names: readonly string[]): string {
  const step = (s: StepDescription): unknown => [
    'step',
    s.id,
    s.source ?? 'step',
    s.retries ?? 0,
    s.retryDelayMs ?? 0,
  ];
  const shape = (entry: EntryDescription): unknown => {
    switch (entry.kind) {
      case 'step': return step(entry);
      case 'sleep': return [entry.kind, entry.id, entry.duration];
      case 'sleepUntil': return [entry.kind, entry.id, entry.until];
      case 'parallel':
      case 'branch': return [entry.kind, entry.id, entry.arms.map(step)];
      case 'loop': return [entry.kind, entry.id, entry.loopType, entry.iterationBound, step(entry.body)];
      case 'foreach': return [entry.kind, entry.id, entry.concurrency, step(entry.body)];
    }
  };
  return createHash('sha256')
    .update(JSON.stringify({ v: 3, id: description.id, shape: description.entries.map(shape), names }))
    .digest('hex')
    .slice(0, 16);
}

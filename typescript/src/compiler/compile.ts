import { createHash } from 'node:crypto';
import { PetriNet, PrecompiledNet, Transition, one, outPlace, place, type Place } from 'libpetri';
import {
  NameVocabulary,
  WF_BAILED,
  T_CANCEL_ARRIVE,
  WF_CANCEL,
  WF_CANCEL_REQUEST,
  WF_CANCELED,
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
import type { Gadget, GadgetContext, GadgetResult, NestedOptions } from './gadgets/types.js';
import type {
  BailToken,
  CanceledToken,
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
 * The largest net `compile()` will emit, in places — a guard against a libpetri defect.
 *
 * `PrecompiledNet` stored each transition's single-word needs index in an `Int8Array`, so a
 * transition whose input and read places all sit in one bitmap word at index 128 or above —
 * place ids from 4096 up — wrapped negative and was read as having no needs. On an input that
 * makes a transition fire with its place empty, fail synchronously and re-mark itself dirty
 * forever: a spin `run(timeout, 'close')` cannot interrupt, because the loop never yields. On an
 * inhibitor it is quieter and worse — the inhibitor is ignored and the run gives a wrong answer.
 * Root-caused upstream (`Int8Array` -> `Int32Array`, TypeScript only; Java uses `int[]`). Place
 * ids, not the place count, trigger it, but a net of at most 4096 places has every id below 4096,
 * so this bound excludes both failures exactly.
 *
 * **libpetri 6.1.0 does NOT carry the fix** — its `dist/index.js` still allocates
 * `needsSingleWordIndex` as an `Int8Array`. Lift this only after checking that line in the
 * release the package depends on, not on seeing a version number.
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
    canceled: place<CanceledToken>(names.reserve(WF_CANCELED, 'workflow cancel terminal')),
  };
  const cancel = place<null>(names.reserve(WF_CANCEL, 'cancellation signal'));
  const cancelRequest = place<null>(names.reserve(WF_CANCEL_REQUEST, 'cancellation arrival'));

  const extraPlaces: Place<unknown>[] = [];
  const transitions: Transition[] = [];

  // **The arrival is part of the net.** Registering `wf.cancel` itself as an environment place
  // would be the direct model, but libpetri routes any net with an environment place away from
  // enumeration to SMT — measured at 0 of 103 cancellation proofs enumerated, up to 411s each,
  // and `unknown` on mutants a closed proof refutes in 7ms. So a proof seeds `wf.cancel.request`
  // and this immediate transition, at default priority, moves it on: the net stays closed, and
  // because `arrive` is enabled until it fires and nothing ever consumes `wf.cancel`, the verifier
  // explores exactly one arrival at every reachable point. At runtime the kernel injects into
  // `wf.cancel` itself — the same event, without this hop. One net serves both ([ADR 0004]).
  transitions.push(
    Transition.builder(names.reserve(T_CANCEL_ARRIVE, 'cancellation arrival transition'))
      .inputs(one(cancelRequest))
      .outputs(outPlace(cancel))
      .action(async (tctx) => {
        tctx.input(cancelRequest);
        tctx.output(cancel, null);
      })
      .build(),
  );

  // **The settle stage — Mastra's after-entry abort check.** Mastra re-stamps *any* top-level
  // entry's result as `canceled` when the signal fired while the entry ran, whatever that result
  // was (`handlers/entry.ts:815-817`); the step's own record keeps the real outcome, stored just
  // before. So a top-level outcome does not reach its terminal directly: it settles first, and a
  // pair of structurally exclusive transitions — one inhibited by the signal, one reading it —
  // decides between its terminal and `wf.canceled`. A success that is not the last entry needs no
  // settle place: it lands in the next entry's input, whose sweep is the same check.
  const settleOf = <T>(outcome: string, terminal: Place<T>, origin: (value: T) => CanceledToken): Place<T> => {
    const settle = place<T>(names.settlePlace(outcome));
    transitions.push(
      Transition.builder(names.settleTransition(outcome, false))
        .inputs(one(settle))
        .inhibitor(cancel)
        .outputs(outPlace(terminal))
        .action(async (tctx) => {
          tctx.output(terminal, tctx.input(settle));
        })
        .build(),
      Transition.builder(names.settleTransition(outcome, true))
        .inputs(one(settle))
        .read(cancel)
        .outputs(outPlace(terminals.canceled))
        .action(async (tctx) => {
          tctx.output(terminals.canceled, origin(tctx.input(settle)));
        })
        .build(),
    );
    return settle;
  };
  // A settled outcome is work that ran: the entry finished and the re-stamp turns it canceled.
  const originOf = (t: { stepId: string; path: EntryPath; foreachIndex?: number }): CanceledToken => ({
    origin: t.foreachIndex === undefined
      ? { stepId: t.stepId, path: t.path }
      : { stepId: t.stepId, path: t.path, foreachIndex: t.foreachIndex },
    started: true,
  });

  const topLevelExits: Exits = {
    failed: settleOf('failed', terminals.failed, originOf),
    bailed: settleOf('bailed', terminals.bailed, originOf),
    suspended: settleOf('suspended', terminals.suspended, originOf),
    paused: settleOf('paused', terminals.paused, originOf),
    // Already canceled: nothing left to decide.
    canceled: terminals.canceled,
  };
  const settleDone = settleOf('done', terminals.done, () => ({ started: true }));

  const emit = (
    entry: EntryDescription,
    path: EntryPath,
    next: Place<FlowToken>,
    exits: Exits,
    nextIsResult: boolean,
    nested: NestedOptions,
  ): GadgetResult => {
    const gadget = gadgets[entry.kind];
    if (gadget === undefined) throw new Error(`no gadget registered for '${entry.kind}'`);

    const ctx: GadgetContext = {
      path,
      viewPath: nested.viewPath ?? path,
      cancel: nested.cancel,
      names,
      exits,
      nextIsResult,
      // An arm's `next` is always a combinator-internal place, never the run's result, and it is
      // not gated unless the combinator says so: Mastra checks abort where it checks, not per step.
      emitNested: (step: StepDescription, childPath, childNext, childExits, options = {}) =>
        emit(step, childPath, childNext, childExits, false, options),
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

  // Right to left: entry i produces into entry i+1's place, so that place must exist first. Every
  // top-level entry is gated: Mastra checks its signal before each one (`default.ts:815`).
  const last = description.entries.length - 1;
  let next: Place<FlowToken> = settleDone;
  for (let i = last; i >= 0; i--) {
    next = emit(description.entries[i]!, [i], next, topLevelExits, i === last, { cancel }).inPlace;
  }

  const net = PetriNet.builder(description.id)
    .places(
      terminals.done,
      terminals.failed,
      terminals.bailed,
      terminals.suspended,
      terminals.paused,
      terminals.canceled,
      cancel,
      cancelRequest,
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
    program: PrecompiledNet.compile(net),
    netMap: { transitionToEntry, placeToEntry },
    entryPlace: next,
    terminals,
    cancel,
    cancelRequest,
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
    .update(JSON.stringify({ v: 4, id: description.id, shape: description.entries.map(shape), names }))
    .digest('hex')
    .slice(0, 16);
}

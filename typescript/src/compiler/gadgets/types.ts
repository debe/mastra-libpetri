import type { Place, Transition } from 'libpetri';
import type { NameVocabulary, EntryPath } from '../names.js';
import type { EntryDescription, Exits, FlowToken, StepDescription } from '../types.js';

/**
 * What a gadget emitted.
 *
 * `inPlace` is where the gadget's caller deposits the token that starts it. Every other place
 * and transition the gadget needed is returned so the builder can collect them — a place the
 * builder never sees is a place no arc references, and libpetri would silently drop it.
 */
export interface GadgetResult {
  readonly inPlace: Place<FlowToken>;
  readonly transitions: readonly Transition[];
  /** Internal places that no arc reaches, if any. Arc-referenced places are auto-collected. */
  readonly places?: readonly Place<unknown>[];
}

/**
 * Everything a gadget needs, and deliberately nothing more.
 *
 * A gadget never reads external state and never decides ordering: it emits structure, and the
 * marking decides what runs ([ADR 0001]). It holds **no runner** — the runner arrives per run
 * through the run scope (`../scope.ts`), which is what lets one compiled net serve many runs.
 */
export interface GadgetContext {
  /** The positional path this entry's places and transitions are **named** by. */
  readonly path: EntryPath;
  /**
   * Mastra's `executionPath` for this entry — what the runner and every outcome token see. Equal
   * to `path` except where Mastra runs several net positions at one path: every `.foreach()` item
   * runs at the foreach's own path, however many lanes the net gives it.
   */
  readonly viewPath: EntryPath;
  /**
   * The cancellation signal, when this entry must honour it — `undefined` when Mastra would not
   * check its abort signal here.
   *
   * Mastra checks in exactly three places: before each top-level entry (`default.ts:815`),
   * between loop iterations (`handlers/control-flow.ts:742,807,889`) and before each foreach
   * dispatch (`:1160`). A step never checks before it runs, so once a `.parallel()` or `.branch()`
   * has started, every arm runs. A gadget given a signal puts an **inhibitor arc** on it on every
   * transition that starts new work, and a **sweep** — a transition that reads it and consumes
   * the waiting token into `exits.canceled` — on every place where work waits to start. Never an
   * action that checks a flag ([ADR 0003], CLAUDE.md: cancellation is structural).
   */
  readonly cancel: Place<null> | undefined;
  readonly names: NameVocabulary;
  /**
   * Where this entry's non-success outcomes go. At the top level these are the workflow's
   * terminals; a combinator passes its own places to its arms, so it can settle every arm before
   * it decides the block's outcome.
   */
  readonly exits: Exits;
  /**
   * True when `next` is the workflow's success terminal, so the value deposited there is **the
   * run's result** rather than the next entry's input.
   *
   * The two differ for `.parallel()` and `.branch()`. The next entry receives a record keyed by
   * *every declared arm*, each read from the step results (`default.ts:1141-1149`), so a skipped
   * or bailed arm is present as a key. The run's result is the block's own output, which keeps
   * only the arms that ran in this block and succeeded (`handlers/control-flow.ts:286-295`).
   */
  readonly nextIsResult: boolean;
  /**
   * Compiles one step so that its success lands in `next` and each other outcome in `exits`.
   *
   * A combinator must pass all four exits explicitly — where an arm's `bail` or `suspend` goes
   * is the combinator's decision, and making it choose is what keeps that decision visible.
   * Recording into the `NetMap` is handled by the builder.
   */
  readonly emitNested: (
    step: StepDescription,
    path: EntryPath,
    next: Place<FlowToken>,
    exits: Exits,
    options?: NestedOptions,
  ) => GadgetResult;
}

/**
 * How a nested step differs from its naming path. Both default the conservative way: the view
 * path to the naming path, and the cancel signal to **none** — a combinator that wants its child
 * gated must say so, because Mastra gates only where it checks.
 */
export interface NestedOptions {
  readonly viewPath?: EntryPath;
  readonly cancel?: Place<null>;
}

/**
 * Emits one entry.
 *
 * `next` is where a successful outcome goes — the gadget does not know or care whether that is
 * the following entry's input place or the workflow terminal. That is what makes the chain the
 * arcs rather than a loop in the engine.
 */
export type Gadget = (
  entry: EntryDescription,
  next: Place<FlowToken>,
  ctx: GadgetContext,
) => GadgetResult;

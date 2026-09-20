import type { Place, Transition } from 'libpetri';
import type { NameVocabulary, EntryPath } from '../names.js';
import type { EntryDescription, FailureToken, FlowToken, StepRunner } from '../types.js';

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
 * marking decides what runs ([ADR 0001]). `emitNested` is how a composite gadget compiles its
 * children without knowing what they are.
 */
export interface GadgetContext {
  readonly path: EntryPath;
  readonly names: NameVocabulary;
  readonly runner: StepRunner;
  /** The workflow's failure terminal. Every failure path ends here or at a gadget-local sink. */
  readonly failed: Place<FailureToken>;
  /**
   * Compiles a child entry so that its success token lands in `next`.
   *
   * `failed` overrides where the child routes failure. A composite gadget passes a
   * gadget-local failure place so a failing child cannot strand its siblings: the gadget then
   * waits for every branch to settle before deciding the composite's own outcome. Omitting it
   * routes to the workflow terminal. Recording into the `NetMap` is handled by the builder.
   */
  readonly emitNested: (
    entry: EntryDescription,
    path: EntryPath,
    next: Place<FlowToken>,
    failed?: Place<FailureToken>,
  ) => GadgetResult;
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

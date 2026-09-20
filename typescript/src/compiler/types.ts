import type { Place, PetriNet } from 'libpetri';
import type { EntryPath } from './names.js';

/**
 * A structural description of a Mastra workflow's step flow.
 *
 * Deliberately **not** Mastra's `StepFlowEntry` — the compiler takes a plain description so it
 * carries no Mastra runtime dependency and can be exercised without constructing a `Workflow`.
 * `src/mastra/` adapts one to the other.
 */
export type EntryDescription =
  | { readonly kind: 'step'; readonly id: string }
  | { readonly kind: 'sleep'; readonly id: string; readonly durationMs: number }
  | { readonly kind: 'sleepUntil'; readonly id: string; readonly atEpochMs: number };

export interface WorkflowDescription {
  readonly id: string;
  readonly entries: readonly EntryDescription[];
}

/** What a step's action produced. Failure is an outcome, never a thrown exception. */
export type StepOutcome =
  | { readonly status: 'success'; readonly output: unknown }
  | { readonly status: 'failed'; readonly error: unknown };

/**
 * How the kernel runs a step. The compiler emits actions that delegate here, so compilation is
 * independent of Mastra's step execution and a verification build can pass a runner that never
 * actually calls anything.
 */
export interface StepRunner {
  run(stepId: string, input: unknown): Promise<StepOutcome>;
}

/** The token travelling the success path: whatever the previous step produced. */
export interface FlowToken {
  readonly data: unknown;
}

/** The token travelling the failure path. */
export interface FailureToken {
  readonly stepId: string;
  readonly error: unknown;
}

/**
 * Relates net structure back to the workflow it came from, so a counterexample trace, an event
 * or a restored marking can be reported in Mastra's terms rather than in place names.
 */
export interface NetMap {
  /** Transition name -> the entry that emitted it. */
  readonly transitionToEntry: ReadonlyMap<string, { readonly path: EntryPath; readonly id: string }>;
  /** Place name -> the entry whose input it is. */
  readonly placeToEntry: ReadonlyMap<string, { readonly path: EntryPath; readonly id: string }>;
}

export interface CompiledWorkflow {
  readonly net: PetriNet;
  readonly netMap: NetMap;
  /** Where the initial token is injected to start a run. */
  readonly entryPlace: Place<FlowToken>;
  /** Terminal places, both declared as verification sinks. */
  readonly donePlace: Place<FlowToken>;
  readonly failedPlace: Place<FailureToken>;
  /** Stable over structure alone, so it keys a compile cache across runs. */
  readonly structuralHash: string;
}

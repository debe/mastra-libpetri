import type { Place, PetriNet } from 'libpetri';
import type { EntryPath } from './names.js';

/**
 * Where a unit of work comes from. The net shape is identical for every source — one step is
 * one step — and only the runner's dispatch differs, so this is data for the runner rather than
 * a reason for a different gadget. `workflow` is a nested `Workflow`, which Mastra runs opaquely
 * as a single step with its own run id (`docs/divergences.md` row 23).
 */
export type StepSource = 'step' | 'workflow' | 'agent' | 'tool' | 'mapping';

/**
 * One unit of work: Mastra's `SingleStepEntry` (`types.d.ts:536`).
 *
 * This is also the only thing a combinator may contain. Mastra types `.parallel()` and
 * `.branch()` arms and `loop` / `foreach` bodies as `SingleStepEntry`, never as a nested
 * combinator (`types.d.ts:577,583,601,619`), so the compiler cannot be asked to build a
 * `.parallel()` inside a `.foreach()` — the only way to nest is a nested workflow, which arrives
 * here as one step. Narrowing the type removes a class of nets Mastra cannot express.
 */
export interface StepDescription {
  readonly kind: 'step';
  readonly id: string;
  /** Defaults to `'step'`. */
  readonly source?: StepSource;
  /**
   * Retries **after** the first attempt: `retries: 2` means up to three executions
   * (`default.ts:455`, `for (let i = 0; i < retries + 1; i++)`). Already resolved by the adapter
   * as Mastra resolves it — `step.retries ?? retryConfig.attempts ?? 0`, where `??` means an
   * explicit step-level `0` beats a workflow-level `attempts`. Defaults to 0.
   */
  readonly retries?: number;
  /**
   * The fixed delay between attempts, from the workflow-level `retryConfig.delay`. No backoff,
   * no jitter, and Mastra's is not abortable. Defaults to 0.
   */
  readonly retryDelayMs?: number;
}

/**
 * A value known when the workflow is built, or one the runner computes per run.
 *
 * `.sleep()` and `.sleepUntil()` accept either a literal or a function of the previous step's
 * output (`workflow.ts:2085-2099,2135-2148`). Only the literal can become a transition's
 * timing, because libpetri timing belongs to the transition, not to the token.
 */
export type BuildOrRun<T> = { readonly fixed: T } | { readonly perRun: true };

export type EntryDescription =
  | StepDescription
  /** `.sleep(ms | fn)`. `fixed` is milliseconds. */
  | { readonly kind: 'sleep'; readonly id: string; readonly duration: BuildOrRun<number> }
  /** `.sleepUntil(date | fn)`. `fixed` is epoch milliseconds. */
  | { readonly kind: 'sleepUntil'; readonly id: string; readonly until: BuildOrRun<number> }
  /** `.parallel([...])` — every arm runs, every arm joins. An empty list is a legal success. */
  | { readonly kind: 'parallel'; readonly id: string; readonly arms: readonly StepDescription[] }
  /**
   * `.branch([[cond, step], ...])` — **inclusive**: conditions are evaluated concurrently and
   * *every* truthy arm runs, then all of them join (`handlers/control-flow.ts:395-498,540`).
   * An empty list, or no truthy condition, is a legal success.
   */
  | { readonly kind: 'branch'; readonly id: string; readonly arms: readonly StepDescription[] }
  /**
   * `.dowhile` / `.dountil` — strictly sequential.
   *
   * **`iterationBound` is ours, not Mastra's.** Mastra's loop is a bare `do { } while (cond)`
   * with no cap of any kind (`handlers/control-flow.ts:739,901`); a grep for `maxIterations`
   * over its source returns nothing. The bound guarantees at runtime that the loop stops, which
   * is why the adapter makes a caller choose it rather than defaulting one
   * (`docs/divergences.md` row 13). Exceeding it fails the run with an error that names the bound.
   *
   * Guaranteed at runtime, **not proven**: the verified properties range over quiescent markings
   * only ([VER-002]), and a loop that cycled forever would never reach one, so none of them would
   * notice. What the loop's proofs show is that every quiescent marking is clean — not that one
   * is always reached.
   */
  | {
      readonly kind: 'loop';
      readonly id: string;
      readonly body: StepDescription;
      readonly loopType: 'dowhile' | 'dountil';
      readonly iterationBound: number;
    }
  /** `.foreach(step, { concurrency })` — concurrency defaults to 1 in Mastra. */
  | {
      readonly kind: 'foreach';
      readonly id: string;
      readonly body: StepDescription;
      readonly concurrency: number;
    };

export interface WorkflowDescription {
  readonly id: string;
  readonly entries: readonly EntryDescription[];
}

/**
 * What a step produced — **five** outcomes, because a Mastra step handler assigns five
 * (`handlers/step.ts:516-529`, plus `failed` from `executeStepWithRetry`).
 *
 * `tripwire` is deliberately **not** a sixth variant. In Mastra it is a `failed` result carrying
 * a `tripwire` field, retried like any other error, forwarded through `.parallel()` and
 * `.branch()` on the failure path, and reclassified to run status `'tripwire'` only at the very
 * end, in `fmtReturnValue` (`default.ts:600-628`). It rides the failure path everywhere, so it is
 * a field on the failure — a separate outcome would need a separate path Mastra does not have.
 *
 * Failure is an outcome, never a thrown exception.
 */
export type StepOutcome =
  | { readonly status: 'success'; readonly output: unknown }
  | {
      readonly status: 'failed';
      readonly error: unknown;
      /** Present when the failure is a `TripWire`; the run then ends as `'tripwire'`. */
      readonly tripwire?: unknown;
      /** A `MastraNonRetryableError` — the only error class that skips remaining retries. */
      readonly nonRetryable?: boolean;
    }
  /** `bail(result)`: the run ends early *as a success* whose result is `output`. */
  | { readonly status: 'bailed'; readonly output: unknown }
  | { readonly status: 'suspended'; readonly payload: unknown; readonly output?: unknown }
  /** A nested workflow paused; only a `workflow`-sourced step produces it. */
  | { readonly status: 'paused' };

/**
 * A read-only view of the run, handed to every runner call.
 *
 * `getStepResult` is the run-scoped store — Mastra's own `stepResults`, keyed by step id and
 * holding the **latest** outcome of that id. It is what a `.map()` reads, what a declarative
 * branch predicate or loop condition reads, and what the record handed to the entry after a
 * `.parallel()` / `.branch()` is assembled from. It lives beside the marking, never inside a
 * `FlowToken`: the marking is control state and this is data, so the P-invariants over the flow
 * places are unaffected by what a step returns.
 */
export interface RunView {
  /** The positional path of the entry making the call — Mastra's `executionPath`. */
  readonly path: EntryPath;
  /** The workflow's input — Mastra's `getInitData()`. */
  readonly initData: unknown;
  getStepResult(stepId: string): StepOutcome | undefined;
}

/** A runner call that executes a step. */
export interface StepCall extends RunView {
  readonly source: StepSource;
  /** 0-based. Mastra's `retryCount`. */
  readonly attempt: number;
}

/**
 * How a step actually runs. The compiler emits actions that delegate here, and the kernel
 * supplies the runner **per run** through the run scope — so a compiled net holds no runner,
 * is independent of any one run, and can be cached by its structural hash.
 */
export interface StepRunner {
  run(stepId: string, input: unknown, call: StepCall): Promise<StepOutcome>;

  /**
   * Which arms of an inclusive `.branch` are truthy, by index. Mastra evaluates every condition
   * concurrently and runs every arm that passes, so this returns a set, not a choice.
   *
   * **A condition that throws is the runner's to report as falsy.** Mastra catches it, logs
   * `WORKFLOW_CONDITION_EVALUATION_FAILED` and skips the arm (`handlers/control-flow.ts:395-498`),
   * and a runner that delegates to Mastra's own `evaluateCondition` inherits that. A throw out of
   * `selectBranches` itself means the evaluation as a whole broke, and fails the run.
   */
  selectBranches?(entryId: string, input: unknown, view: RunView): Promise<readonly number[]>;

  /** Whether a `.dowhile` / `.dountil` runs another iteration, as `LoopConditionFunction`. */
  evaluateLoopCondition?(entryId: string, output: unknown, iteration: number, view: RunView): Promise<boolean>;

  /**
   * The wait of a per-run `.sleep` (milliseconds) or `.sleepUntil` (epoch milliseconds),
   * computed from the previous step's output. Required only when one is present.
   */
  resolveWait?(entryId: string, input: unknown, view: RunView): Promise<number>;
}

/** The token travelling the success path: whatever the previous entry produced. */
export interface FlowToken {
  readonly data: unknown;
}

/** The failure path. `tripwire` set means the run ends as `'tripwire'`, not `'failed'`. */
export interface FailureToken {
  readonly stepId: string;
  readonly error: unknown;
  readonly tripwire?: unknown;
}

/** The early-exit path of `bail(result)`. */
export interface BailToken {
  readonly stepId: string;
  readonly output: unknown;
}

/** A step that suspended. `path` is what Mastra records in `suspendedPaths`. */
export interface SuspendToken {
  readonly stepId: string;
  readonly path: EntryPath;
  readonly payload: unknown;
  readonly output?: unknown;
}

/** A nested workflow that paused. */
export interface PauseToken {
  readonly stepId: string;
  readonly path: EntryPath;
}

/**
 * Where each non-success outcome of an entry goes.
 *
 * **The destination is decided by the enclosing context, never by the step.** That is the whole
 * resolution of where `bail` belongs: at the top level it ends the run as a success; inside a
 * `loop` or `foreach` it exits that combinator and then the run; inside `.parallel()` or
 * `.branch()` it is swallowed — the arm settles, is left out of the block's own output, and the
 * block succeeds (`handlers/control-flow.ts:267-295`). One leaf gadget serves all three because
 * it routes to `exits` and does not know which of them it is in.
 */
export interface Exits {
  readonly failed: Place<FailureToken>;
  readonly bailed: Place<BailToken>;
  readonly suspended: Place<SuspendToken>;
  readonly paused: Place<PauseToken>;
}

/**
 * The workflow's terminal places, every one of them a declared verification sink.
 *
 * Separate places rather than one terminal with a status field, because the outcomes take
 * separate paths through the net and a proof about one should not silently cover another:
 * `donePlace` used to receive both a completed run and a bailed one, so every proof about
 * "reaches done" was narrower than it read.
 */
export interface Terminals extends Exits {
  readonly done: Place<FlowToken>;
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
  readonly terminals: Terminals;
  /** Stable over structure alone, so it keys a compile cache across runs. */
  readonly structuralHash: string;
}

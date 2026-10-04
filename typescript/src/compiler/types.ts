import type { Place, PetriNet, PrecompiledNet } from 'libpetri';
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
  /**
   * The top-level entries after which a checkpoint is taken ([ADR 0010]), ascending, each a valid
   * index, the last entry excluded (the terminal row covers it). Absent or empty compiles to exactly
   * the unmarked net. The adapter reads them from Mastra's `metadata.checkpoint` and refuses a mark
   * anywhere but on a top-level entry.
   */
  readonly checkpoints?: readonly number[];
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
export type StepOutcome = (
  | { readonly status: 'success'; readonly output: unknown }
  | {
      readonly status: 'failed';
      readonly error: unknown;
      /** Present when the failure is a `TripWire`; the run then ends as `'tripwire'`. */
      readonly tripwire?: unknown;
      /** A `MastraNonRetryableError` — the only error class that skips remaining retries. */
      readonly nonRetryable?: boolean;
      /**
       * A failed `.foreach()` aggregate's `__workflow_meta.foreachOutput`
       * (`handlers/control-flow.ts:1355-1369`), which the codec must not drop.
       */
      readonly suspendPayload?: unknown;
    }
  /** `bail(result)`: the run ends early *as a success* whose result is `output`. */
  | { readonly status: 'bailed'; readonly output: unknown }
  /**
   * `suspendPayload` and `suspendOutput`, as Mastra's `StepSuspended` names them
   * (`handlers/step.ts:516-522`). Not `payload`: on a record that key is the step's input, and an
   * earlier version of this type used it for both — the record lost the suspension.
   */
  | { readonly status: 'suspended'; readonly suspendPayload: unknown; readonly suspendOutput?: unknown }
  /** A nested workflow paused; only a `workflow`-sourced step produces it. */
  | { readonly status: 'paused' }
) & {
  /**
   * The host's own record of the step, carried verbatim — for Mastra, its `StepResult`, with the
   * fields this engine does not model (`suspendedAt`, `resumePayload`, scorer output …). The
   * engine never reads it; the codec prefers it when it rebuilds `WorkflowRunState`.
   */
  readonly host?: unknown;
  /**
   * The input the step actually ran on — Mastra's `payload`, which is the input **after** schema
   * validation, defaults and coercions applied (`handlers/step.ts:111,173`). Absent, the record
   * takes the flow token's data, which is the same thing for a runner that validates nothing.
   */
  readonly payload?: unknown;
  /**
   * Set by the runner exactly when the attempt is recorded as resumed (truthy resume data,
   * `handlers/step.ts:166-175`). Absent on a resumed attempt with falsy resume data, which Mastra
   * records as a fresh start: the leaf then stamps a fresh `startedAt` (row 82).
   */
  readonly resumedAt?: number;
};

/**
 * What the run-scoped store holds for a step: the outcome plus what Mastra's `StepResult` carries
 * beside it, so the codec can rebuild `WorkflowRunState.context` and a loop can re-enter from a
 * recorded result (`handlers/control-flow.ts:727-734`).
 */
export type StepRecord =
  | (StepOutcome & RecordFields)
  /**
   * A loop or foreach canceled mid-run. Mastra persists `{status: 'canceled'}` under the body's id
   * (`handlers/entry.ts:810-815`), with a foreach's partial results as `output`
   * (`handlers/control-flow.ts:1164-1169`). Only a combinator writes it — it is not a
   * `StepOutcome`, so a runner cannot return it.
   */
  | ({ readonly status: 'canceled'; readonly output?: unknown; readonly host?: unknown } & Partial<RecordFields>)
  /**
   * A sleep that has begun waiting. Mastra writes `{status: 'waiting', payload, startedAt}` when a
   * sleep begins (`handlers/entry.ts:602-609`) and leaves it there if the run is canceled mid-wait;
   * the sleep overwrites it with `success` when the wait ends. Only a sleep writes it.
   */
  | ({ readonly status: 'waiting'; readonly payload: unknown; readonly host?: unknown } & Partial<Omit<RecordFields, 'payload'>>);

/** What a record carries beside the outcome — the rest of Mastra's `StepResult`. */
export interface RecordFields {
  /** The input the step received — Mastra's `payload`. */
  readonly payload: unknown;
  /**
   * Epoch milliseconds on the run's clock ([TIME-015]). Taken **once**, when the first attempt
   * starts: a retried step keeps its first start, as Mastra stamps before its retry loop
   * (`handlers/step.ts:166,174`).
   */
  readonly startedAt?: number;
  /** When the step finished. Absent for `suspended` and `paused`, which Mastra never ends. */
  readonly endedAt?: number;
  /** When the step suspended — Mastra's `suspendedAt`. */
  readonly suspendedAt?: number;
  /**
   * `iterationCount` is stamped by a loop (1-based, as Mastra's `metadata.iterationCount`);
   * `foreachIndex` by a foreach. Absent outside those.
   */
  readonly metadata?: { readonly iterationCount?: number; readonly foreachIndex?: number };
}

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
  /**
   * Mastra's `executionPath` for the call — the **view path**, which is not always the path the
   * compiler names places by. Every `.foreach()` item runs at the foreach's own path
   * (`handlers/control-flow.ts:1101`), however many lanes the net gives it.
   */
  readonly path: EntryPath;
  /** The workflow's input — Mastra's `getInitData()`. */
  readonly initData: unknown;
  getStepResult(stepId: string): StepRecord | undefined;
  /**
   * The run's abort signal, which Mastra hands every step and every condition
   * (`handlers/step.ts:450`; `handlers/control-flow.ts:419-455,858-859`). Reading it cuts work
   * already running short; *raising* an abort is the runner's, through the run's own controller.
   */
  readonly abortSignal: AbortSignal;
}

/** A runner call that executes a step. */
export interface StepCall extends RunView {
  readonly source: StepSource;
  /** 0-based. Mastra's `retryCount`. */
  readonly attempt: number;
  /** Which `.foreach()` item this call runs — Mastra's `executionContext.foreachIndex`. */
  readonly foreachIndex?: number;
  /**
   * This call is the attempt a resume feeds ([ADR 0007]): the runner hands it the resume data and
   * the stored suspend data, and records it as a resumed step (`resumePayload`, `resumedAt`).
   */
  readonly resumed?: true;
  /**
   * The 1-based loop iteration this call runs, when a `.dowhile` / `.dountil` started it — Mastra's
   * `iterationCount` (`handlers/control-flow.ts:773,847`), which a step's start event carries as
   * `metadata.iterationCount` (`handlers/step.ts:176`).
   */
  readonly iteration?: number;
  /**
   * When the step's first attempt started, on the run's clock — the stamp its record takes as
   * `startedAt` unless the record is a resumed one. Mastra's start event and record share one
   * `startTime` (`handlers/step.ts:166,172`), so a runner publishing a start reads this rather than
   * the clock. The same on every attempt of the step.
   */
  readonly startedAt?: number;
}

/**
 * What the net tells the host about a step's life, at the points where Mastra's default engine
 * publishes a step event ([ADR 0008]). A step's **start** is not here: it is the runner's first
 * call for the step (`attempt === 0`), which Mastra's start event precedes (`handlers/step.ts:207-216`).
 *
 * **Observation only.** No arc, guard or branch reads what an observer does; an observer cannot
 * fail a firing (the scope swallows its throw, see `RunScope.observe`); and the net, its proofs and
 * its outcomes are the same with or without one. Each event is raised in the firing that writes
 * the record it carries, after the write and before the firing's outputs, so an observer sees the
 * record the run's store holds at that moment.
 */
export type LifecycleEvent =
  /** A sleep began waiting: its `waiting` record was just written (`handlers/entry.ts:586-609,694-711`). */
  | { readonly kind: 'sleep-waiting'; readonly stepId: string; readonly path: EntryPath; readonly record: StepRecord }
  /** A sleep's wait ended and its `success` record was written (`handlers/entry.ts:656-690,768-802`). */
  | { readonly kind: 'sleep-settled'; readonly stepId: string; readonly path: EntryPath; readonly record: StepRecord }
  /**
   * A step's final record, after every retry — never a retried attempt's (`handlers/step.ts:531-545`
   * emits once, after `executeStepWithRetry`). With `foreachIndex`, it is one `.foreach()` item's
   * (`handlers/control-flow.ts:1117-1152`, where Mastra publishes progress, not a step result).
   */
  | {
      readonly kind: 'step-settled';
      readonly stepId: string;
      readonly path: EntryPath;
      readonly foreachIndex?: number;
      readonly record: StepRecord;
    }
  /**
   * A `.foreach()` began — at `split` on a fresh run, at `re-enter` on a resume — before any item
   * starts (`handlers/control-flow.ts:990-1027`). `stepId` is the body's. `input` is the foreach's
   * input as it arrived, `startedAt` its start (absent on a resume whose stored aggregate had none),
   * `kept` a resumed foreach's stored aggregate less its completion fields, and `items` the number
   * of items — `undefined` when the input is not an array, which fails the foreach next.
   */
  | {
      readonly kind: 'foreach-entered';
      readonly stepId: string;
      readonly path: EntryPath;
      readonly input: unknown;
      readonly startedAt?: number;
      readonly kept?: Readonly<Record<string, unknown>>;
      readonly items: number | undefined;
      readonly resumed: boolean;
    }
  /**
   * A `.foreach()`'s aggregate record was written — success, failed, bailed, paused, suspended or
   * canceled (`handlers/control-flow.ts:1298-1480`). `stepId` is the body's.
   */
  | { readonly kind: 'foreach-settled'; readonly stepId: string; readonly path: EntryPath; readonly record: StepRecord };

/**
 * A checkpoint reached ([ADR 0010]): entry `after` succeeded, entry `after + 1` has not started, and
 * the net holds exactly the one flow token between them. `records` is every step's latest record at
 * that moment, as the run scope holds it.
 */
export interface CheckpointEvent {
  readonly after: number;
  readonly records: ReadonlyMap<string, StepRecord>;
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

  /**
   * A step's lifecycle, as it happens ([ADR 0008]). Optional, and observation only: the firing
   * awaits it, so what the observer publishes precedes what the firing enables, as Mastra awaits
   * its publish before moving on — but nothing it does, throws or returns changes the run.
   */
  observe?(event: LifecycleEvent): void | Promise<void>;

  /**
   * Take a checkpoint ([ADR 0010]). **Not** observation-only: the checkpoint transition awaits it,
   * so the row is durable before any effect of the next entry, and a rejection fails that firing —
   * the run ends and the engine rejects with the cause. Required when the workflow marks one; the
   * kernel refuses a marked workflow run with a runner that lacks it.
   */
  checkpoint?(event: CheckpointEvent): Promise<void>;
}

/**
 * The token travelling the success path: whatever the previous entry produced.
 *
 * `foreachIndex` and `iteration` ride along when a foreach or a loop starts the step, so the leaf
 * can hand them to the runner and stamp them on the step's record. A gadget that does not own
 * them passes them through untouched.
 */
export interface FlowToken {
  readonly data: unknown;
  readonly foreachIndex?: number;
  /** 1-based loop iteration, as Mastra's `metadata.iterationCount`. */
  readonly iteration?: number;
  /**
   * The one attempt a resume feeds its data to ([ADR 0007]) — Mastra's `resume.steps[0] ===
   * step.id` (`handlers/step.ts:140-142`), made positional. Colour only: no arc, branch or guard
   * reads it. A retry of that attempt keeps it, as `executeStepWithRetry` re-calls with the same
   * params; nothing downstream inherits it.
   */
  readonly resumed?: true;
}

/**
 * Where an outcome came from. `path` is the view path — Mastra's `executionPath` — so the codec
 * can write `suspendedPaths` and a failure can be ranked by arm without guessing from the id.
 */
export interface Origin {
  readonly stepId: string;
  readonly path: EntryPath;
  readonly foreachIndex?: number;
}

/** The failure path. `tripwire` set means the run ends as `'tripwire'`, not `'failed'`. */
export interface FailureToken extends Origin {
  /** The step's validated input, when the runner reported one — for a foreach's aggregate record. */
  readonly stepPayload?: unknown;
  /** When the step's first attempt started — a foreach item's own start, for the aggregate record. */
  readonly stepStartedAt?: number;
  readonly error: unknown;
  readonly tripwire?: unknown;
  readonly nonRetryable?: true;
  /** A failed `.foreach()`'s `__workflow_meta` (`handlers/control-flow.ts:1355-1369`). */
  readonly foreach?: ForeachMeta;
}

/** The early-exit path of `bail(result)`. */
export interface BailToken extends Origin {
  /** The step's validated input, when the runner reported one — for a foreach's aggregate record. */
  readonly stepPayload?: unknown;
  /** When the step's first attempt started — a foreach item's own start, for the aggregate record. */
  readonly stepStartedAt?: number;
  readonly output: unknown;
}

/**
 * A step that suspended. The suspension's output, if any, is on the step's record in the store —
 * the codec reads it there, as `fmtReturnValue` reads `stepResults` (`default.ts:630-643`).
 */
export interface SuspendToken extends Origin {
  readonly payload: unknown;
  /**
   * When the step suspended, on the run's clock. Always stamped by the leaf; optional in the type
   * so a hand-built token need not invent one. Mastra's `suspendedPaths` keeps the *last* suspension
   * in time per step id (`handlers/step.ts:395-397`), and this is how the codec orders them.
   */
  readonly suspendedAt?: number;
  /** The input the step ran on and when it started, as on `FailureToken` — a foreach aggregate's entry needs them. */
  readonly stepPayload?: unknown;
  readonly stepStartedAt?: number;
  /**
   * The other suspensions parked in the same block, in arm or item index order — the join reports
   * the lowest and carries the rest here instead of dropping them, so the result's `suspended`
   * list and the snapshot's `suspendedPaths` name every one (`default.ts:630-643`). Full tokens,
   * because their payloads are needed.
   */
  readonly pending?: readonly SuspendToken[];
  /** A suspended `.foreach()`'s `__workflow_meta` (`handlers/control-flow.ts:1432-1450`). */
  readonly foreach?: ForeachMeta;
}

/**
 * What a suspended or failed `.foreach()` carries in its aggregate record's `__workflow_meta`, so a
 * resume can skip the items that succeeded and re-run the one that suspended.
 */
export interface ForeachMeta {
  /** The lowest suspended item's index — Mastra's `__workflow_meta.foreachIndex`. */
  readonly foreachIndex: number;
  /** Every item's own record, by index — Mastra's `__workflow_meta.foreachOutput`. */
  readonly foreachOutput: readonly ForeachItemRecord[];
}

/** One `.foreach()` item's own outcome, as Mastra keeps it in `foreachOutput`. */
export interface ForeachItemRecord {
  readonly index: number;
  readonly record: StepRecord;
}

/** A nested workflow that paused. */
export interface PauseToken extends Origin {
  /** The step's validated input, when the runner reported one — for a foreach's aggregate record. */
  readonly stepPayload?: unknown;
  /** When the step's first attempt started — a foreach item's own start, for the aggregate record. */
  readonly stepStartedAt?: number;
}

/**
 * Work that stopped because the run was canceled. `origin` names the entry that was waiting or
 * running, when there was one; `output` carries a foreach's partial results
 * (`handlers/control-flow.ts:1160-1172`).
 */
export interface CanceledToken {
  readonly origin?: Origin;
  readonly output?: unknown;
  /**
   * Whether the work at `origin` had **started**. A sweep at a start gate reports work that never
   * ran; a sweep inside a running construct (a sleep mid-wait, a loop between iterations, a foreach
   * draining) and the settle stage report work that did. Mastra's persisted `executionPath` for a
   * canceled run names the last entry that ran, so the codec needs this — and it is structural: a
   * different place, never an inference from timing.
   */
  readonly started: boolean;
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
  readonly canceled: Place<CanceledToken>;
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
 * A place a resumed run can start from ([ADR 0007]). Every position Mastra can resume at has one: a
 * top-level step or loop (its own input place, gated and swept like any entry), an arm of a
 * `.parallel()` or `.branch()`, and a `.foreach()`. A resume seeds exactly **one** token here — the
 * kernel asserts it — and each site is proven as its own segment from that marking.
 */
export type ResumeSite = EntrySite | ArmSite | ForeachSite;

/**
 * A top-level boundary a restart may continue from ([ADR 0010]): the input place of entry `index`,
 * which the barrier guarantees is the only marked place outside the permits and the cancel signal
 * when it is marked. One per top-level entry, marked or not — a row from Mastra's own engine may name
 * any of them — and kept apart from `resumeSites`, whose key `"i"` may be a foreach's. Index 0 is the
 * entry place.
 */
export interface BoundarySite {
  readonly kind: 'boundary';
  readonly index: number;
  readonly entryId: string;
  readonly entryKind: EntryDescription['kind'];
  readonly place: Place<FlowToken>;
}

/** A top-level step (a nested workflow included) or loop. A sleep never suspends and has none. */
export interface EntrySite {
  readonly kind: 'entry';
  readonly path: readonly [number];
  readonly stepId: string;
  readonly construct: 'step' | 'loop';
  readonly place: Place<FlowToken>;
}

/** One arm of a `.parallel()` or `.branch()`. */
export interface ArmSite {
  readonly kind: 'arm';
  readonly block: 'parallel' | 'branch';
  readonly path: readonly [number, number];
  readonly stepId: string;
  readonly place: Place<ArmResume>;
}

/** A `.foreach()`. */
export interface ForeachSite {
  readonly kind: 'foreach';
  readonly path: readonly [number];
  readonly stepId: string;
  readonly place: Place<ForeachResume>;
  /**
   * The body is a nested workflow. Resuming inside it is refused (`foreach-nested`) whatever the
   * `steps` list says: Mastra accepts a single-id `steps` for a nested body (`workflow.ts:4613-4618`)
   * and then resumes the wrong child (row 77).
   */
  readonly nested?: true;
}

/**
 * The token that re-enters a block at one arm. `data` is the resumed arm's stored input; each
 * sibling's recorded outcome is replayed through the block's own join, so the block's interior is
 * rebuilt by transitions, never written by hand.
 */
export interface ArmResume {
  readonly data: unknown;
  readonly siblings: readonly SiblingVerdict[];
}

/** A sibling arm's stored outcome, mapped to the arrival a real collect would have produced. */
export type SiblingVerdict =
  | { readonly kind: 'ok'; readonly index: number; readonly output: unknown }
  | { readonly kind: 'suspended'; readonly index: number; readonly token: SuspendToken }
  | { readonly kind: 'failed'; readonly index: number; readonly token: FailureToken }
  /** Bailed or paused — swallowed by the block, as in a fresh run. */
  | { readonly kind: 'settled'; readonly index: number }
  /** A branch arm with no record: its condition was not truthy (`handlers/entry.ts:43-46`). */
  | { readonly kind: 'skipped'; readonly index: number };

/**
 * The token that re-enters a `.foreach()`: the stored item array, the items still to run (in
 * order, the resumed ones flagged), the items that succeeded (skipped, their outputs reused), and
 * the suspensions that stay parked (`handlers/control-flow.ts:1227-1270`).
 */
export interface ForeachResume {
  readonly items: readonly unknown[];
  readonly order: readonly { readonly index: number; readonly resumed?: true }[];
  readonly done: readonly ForeachItemRecord[];
  readonly parked: readonly SuspendToken[];
}

/**
 * One step's attempts, in order, as the leaf emitted them ([ADR 0009]). A step with `retries: R`
 * is `R + 1` attempt transitions joined by `R` retry hops, and nothing else can start an attempt —
 * which is the retry ceiling, checked on the arcs by `retryCeilingViolations`. Recorded for every
 * step occurrence: a `.parallel()` arm, a loop body and each `.foreach()` lane included.
 */
export interface StepChain {
  readonly stepId: string;
  /** The naming path — a foreach lane's own, not the view path. */
  readonly path: EntryPath;
  readonly retries: number;
  /** The step's input place: the only way into attempt 0. */
  readonly inPlace: string;
  /** Attempt transition names, attempt 0 first: `retries + 1` of them. */
  readonly attempts: readonly string[];
  /** Retry hop transition names: hop `j` moves a failed attempt `j` into attempt `j + 1`. */
  readonly hops: readonly string[];
}

/**
 * A gadget's claim about how many tokens one of its places can hold ([ADR 0009]). A place nobody
 * claims for is claimed at 1 — so a gadget states only its exceptions, and a new place is held to
 * the strictest bound until someone says otherwise.
 *
 * `unclaimed` is for a place whose count is **data** (a foreach's results, one per item) or is
 * deposited several at a time by one firing, which the analyses count as one ([IO-016]): a proof
 * of any bound there would be a proof about the model and not about the run, so the report lists
 * the place and its reason instead of a verdict.
 */
export type PlaceClaim =
  | { readonly place: string; readonly bound: number; readonly why: string }
  | { readonly place: string; readonly bound: 'unclaimed'; readonly why: string };

/** Two places a gadget says are never marked together ([ADR 0009]). */
export interface ExclusionClaim {
  readonly a: string;
  readonly b: string;
  readonly why: string;
}

/**
 * A top-level entry as the barrier sees it ([ADR 0009]): Mastra's `for` loop runs entry `i + 1`
 * only once entry `i` has returned, so no place of `interior` is marked while `next` is.
 */
export interface TopLevelEntry {
  readonly index: number;
  readonly id: string;
  readonly kind: EntryDescription['kind'];
  /** Every place the entry's gadget owns, its input included: named under `s.<index>`. */
  readonly interior: readonly string[];
  /** Where its success goes: the next entry's input, or the success settle place. */
  readonly next: string;
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
  /** A top-level path, joined with `.` -> the entry there — how a stored `resumePath` is resolved. */
  readonly pathToEntry: ReadonlyMap<string, { readonly entryId: string; readonly kind: EntryDescription['kind'] }>;
}

export interface CompiledWorkflow {
  readonly net: PetriNet;
  /**
   * The net compiled once for libpetri's executor, reused by every run of this workflow — the
   * compile cache's point. Without it the executor recompiles the net on every run.
   */
  readonly program: PrecompiledNet;
  readonly netMap: NetMap;
  /** Where the initial token is injected to start a run. */
  readonly entryPlace: Place<FlowToken>;
  readonly terminals: Terminals;
  /**
   * The cancellation signal. Nothing consumes it — every start transition where Mastra checks its
   * abort carries an inhibitor arc on it, and every place where work waits to start there a sweep
   * that reads it — so once marked it stays marked, and it is excluded from residue.
   */
  readonly cancel: Place<null>;
  /**
   * Where a cancellation **arrives, for a proof**. An immediate `arrive` transition moves its token
   * to `cancel`; the verifier's `cancel` segment seeds it, so `arrive` may fire at every reachable
   * point while the net stays closed and takes the enumeration route. At runtime the kernel does
   * not use it: the environment injects into `cancel` directly — the same event, without the extra
   * firing in which an already-enabled start could slip past the inhibitor. [ADR 0004]
   */
  readonly cancelRequest: Place<null>;
  /**
   * The run's step budget, when one was compiled in ([ADR 0006]): a place holding `k` permits.
   * Every step attempt consumes one when it fires and returns it in **every** outcome branch, so
   * permits plus steps in flight is `k` at every marking — a P-invariant, proven as
   * `permitsBounded` and `permitsReturned`. Absent, steps run unbounded, as Mastra's do.
   */
  readonly budget?: { readonly permits: Place<null>; readonly k: number };
  /**
   * The name of every step-attempt transition, recorded by the leaf whether or not a budget was
   * compiled in. The budget's structural check needs it: a check that looks only at transitions
   * already touching the permits cannot see an attempt compiled with none.
   */
  readonly stepAttempts: readonly string[];
  /** Every step occurrence's attempt chain, in emission order ([ADR 0009]). */
  readonly steps: readonly StepChain[];
  /** The gadgets' bound claims, by place name; every other place is claimed at 1 ([ADR 0009]). */
  readonly claims: ReadonlyMap<string, PlaceClaim>;
  /** The gadgets' exclusion claims ([ADR 0009]). The barrier's are derived from `entries`. */
  readonly exclusions: readonly ExclusionClaim[];
  /** The top-level entries, in order ([ADR 0009]). */
  readonly entries: readonly TopLevelEntry[];
  /** Every resume site, keyed by its path joined with `.` ([ADR 0007]). */
  readonly resumeSites: ReadonlyMap<string, ResumeSite>;
  /** Every top-level boundary, by entry index ([ADR 0010]). `boundaries[0].place` is `entryPlace`. */
  readonly boundaries: readonly BoundarySite[];
  /** The entries after which a checkpoint is taken, as the description marked them ([ADR 0010]). */
  readonly checkpoints: readonly number[];
  /** Stable over structure alone, so it keys a compile cache across runs. */
  readonly structuralHash: string;
}

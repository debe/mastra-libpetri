import type { Place, PetriNet, PrecompiledNet } from 'libpetri';
import type { EntryPath } from './names.js';
import type { StepPreemptedError } from './preempt.js';

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
  /**
   * A per-attempt deadline in milliseconds ([ADR 0013]) — Layer 3, from the petri `createStep({
   * timeout })`; Mastra has none (row 6). Each attempt races the step against the run's clock and,
   * on expiry, aborts the attempt's `StepCall.deadline`, waits for the step to settle, discards its
   * result and leaves by its `timedOut` branch, which is retried like a thrown error. A whole number
   * in [1, `MAX_WAIT_MS`]; the adapter refuses anything else as `timeout-value`. Absent, the leaf
   * emits exactly today's attempt.
   */
  readonly timeoutMs?: number;
  /**
   * The quotas every attempt of this step draws on ([ADR 0012]), from the petri `createStep({ uses
   * })`, in declaration order. Each is one run-wide set of canonical places that this step's own
   * member places are fused into, so two steps naming one quota share it. Absent or empty, the leaf
   * emits exactly today's attempt.
   */
  readonly quotas?: readonly QuotaRef[];
}

/**
 * A quota a step draws on ([ADR 0012]), as the compiler sees it: Mastra's `limit(n, {id})` and
 * `rateLimit(burst, per, {id})` objects reduced to data. The host's quota identity is the object;
 * here it is `id`, which names the canonical places (`wf.quota.<id>`), so the adapter refuses two
 * different quota objects sharing an id (`quota-id-collision`) before they get here, and the
 * compiler refuses two refs with one id and different parameters.
 *
 * - `limit`: at most `n` attempts of the using steps in flight at once — a pool of `n`, taken with
 *   the run permit in the attempt's firing and returned on every branch.
 * - `rate`: at most `burst` tokens at once, one back every `perMs` ms — every attempt spends one,
 *   retries included, and one compiler-emitted `refill` per quota returns them while there is
 *   demand.
 *
 * `n` and `burst` are whole numbers in [1, `MAX_CONCURRENCY`] — they are seeded as tokens, as the
 * run budget is — and `perMs` is a whole number in [1, `MAX_WAIT_MS`]. `id` matches
 * `QUOTA_ID_PATTERN` (`names.ts`), so it is a name segment verbatim (no slug, so no two ids can share places).
 */
export type QuotaRef =
  | { readonly id: string; readonly kind: 'limit'; readonly n: number }
  | { readonly id: string; readonly kind: 'rate'; readonly burst: number; readonly perMs: number };

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
  | {
      readonly kind: 'parallel';
      readonly id: string;
      readonly arms: readonly StepDescription[];
      /** At most this many arms in flight, admitted in arm order — see {@link BlockConcurrency}. */
      readonly concurrency?: BlockConcurrency;
      /**
       * A counted decision on the block ([ADR 0014]) — Layer 3, from `init().race` / `init().quorum`:
       * the block succeeds once `k` arms have succeeded and fails once `n − k + 1` have not, then
       * preempts every unsettled arm and waits for all `n`. Absent, the block is today's parallel and
       * compiles, and hashes, exactly as before M7b.
       */
      readonly decision?: BlockDecision;
    }
  /**
   * `.branch([[cond, step], ...])` — **inclusive**: conditions are evaluated concurrently and
   * *every* truthy arm runs, then all of them join (`handlers/control-flow.ts:395-498,540`).
   * An empty list, or no truthy condition, is a legal success.
   */
  | {
      readonly kind: 'branch';
      readonly id: string;
      readonly arms: readonly StepDescription[];
      /**
       * At most this many truthy arms in flight, admitted in arm order — see {@link BlockConcurrency}.
       * A skipped or reused arm passes the cursor without a slot.
       */
      readonly concurrency?: BlockConcurrency;
    }
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
      /**
       * The stages the body is compiled from ([ADR 0015]) — Layer 3, from `init().pipeline`: the
       * foreach's `body` stays the minted nested workflow (`source: 'workflow'`, what Mastra records the
       * aggregate under), and the net runs these stages instead, item by item, lane to lane. Absent,
       * the entry is today's foreach and compiles, and hashes, exactly as before M7b's second wave.
       */
      readonly pipeline?: ForeachPipeline;
    };

/**
 * A `.foreach()`'s stage chain ([ADR 0015]): `stages[0] -> … -> stages[s-1]`, each a single step
 * (a step, an agent or a tool — a nested workflow is refused, M8 compiles those), adapted with the
 * **parent's** options, so `retries`, `timeoutMs` and `quotas` are each stage's own at the parent's
 * run scope (maintainer decision 2). `bounds[j]` is stage `j`'s lane count `c_j`, a whole number ≥ 1;
 * `bounds.length === stages.length ≥ 1`, and Σ`bounds` — the item window W — equals the entry's
 * `concurrency` and is at most `MAX_FOREACH_LANES`. The adapter refuses anything else
 * (`pipeline-empty`, `pipeline-value`); the compiler throws on it, naming the foreach, in case a
 * hand-built description slips past.
 *
 * Stage `j`, lane `l` is flattened to `L = Σ_{i<j} c_i + l`, and its attempts are named at `[i, L]`
 * and viewed at the foreach's `[i]`, so the runner and suspension coverage keep a foreach's
 * `[i, lane]` shape. One proof covers every item count: the item index is colour.
 */
export interface ForeachPipeline {
  readonly stages: readonly StepDescription[];
  readonly bounds: readonly number[];
}

/**
 * A block's own bound on its fan-out ([ADR 0011]) — Layer 2, from `metadata: { concurrency: c }` in
 * the `.parallel()` / `.branch()` call's options, which Mastra's engine ignores. A whole number ≥ 1
 * (a safe integer; the adapter refuses anything else as `concurrency-value`). The compiler treats
 * `c ≥ arms` as absent — the limit cannot bind — so such a block compiles, and hashes, exactly as an
 * unannotated one; the adapter passes the value through as the author wrote it.
 */
export type BlockConcurrency = number;

/**
 * A `.parallel()` block's counted decision ([ADR 0014]): `race` is `{ k: 1 }`, `quorum(k)` is `{ k }`.
 * `n` is the block's arm count, never stored. `k` is a whole number in [1, n] — the adapter refuses
 * anything else as `quorum-value`, and an empty block as `race-empty`; the compiler throws on either,
 * naming the block, in case a hand-built description slips past.
 *
 * **What counts.** A `success` is a hit. A `failed`, `bailed`, `paused` or `suspended` arm, and an arm
 * preempted after the decision, is a miss (`Promise.any`). The block never suspends (wave 1).
 */
export interface BlockDecision {
  readonly k: number;
}

/**
 * An arm that left by its `preempted` branch ([ADR 0014]): its attempt ran after the block decided
 * and its outcome was discarded, or the attempt saw the fired signal and never ran. The leaf has
 * already written the arm's `canceled` record with `reason` (a {@link StepPreemptedError}, the
 * preemption signal's own reason); the block's collect counts the token as a miss and the decision's
 * absorb takes it.
 */
export interface PreemptedToken extends Origin {
  readonly reason: StepPreemptedError;
  /** The step's validated input, when an attempt ran — for the `canceled` record's `payload`. */
  readonly stepPayload?: unknown;
  /** When the step's first attempt started, when one did. */
  readonly stepStartedAt?: number;
}

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
  /**
   * The attempt's verdict, frozen by the host at one point ([ADR 0014], [ADR 0013]) — present when
   * the call carried a `deadline` or a `preempt`, and the host decided the attempt against them. The
   * leaf maps it to a branch and never reads a signal to second-guess it:
   *
   * - `own` — the status above stands, whatever fires later. Every effect the attempt had (state,
   *   resume labels, scorers, writer chunks) was applied by the host. A success a block's decision
   *   reaches only after this point is a surplus success, not a loser.
   * - `timedOut` — the deadline fired first: the leaf discards the status above and takes its
   *   `timedOut` branch with its own `StepTimeoutError`. The host applied no effect.
   * - `preempted` — the block's preemption fired before the run's abort and the deadline: the leaf
   *   discards the status above and leaves by the arm's `preempted` branch, recording `canceled`
   *   with `reason`. `started` is false when the host did not start the step at all (the block had
   *   decided before the attempt); the record then takes no start of its own. No effect applied.
   *
   * Absent — a runner that freezes nothing — the leaf decides a timeout from the deadline itself
   * ([ADR 0013]) and never takes the `preempted` branch: a preemption is only ever the host's verdict.
   */
  readonly verdict?:
    | { readonly kind: 'own' }
    | { readonly kind: 'timedOut' }
    | { readonly kind: 'preempted'; readonly reason: StepPreemptedError; readonly started: boolean };
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
  | ({
      readonly status: 'canceled';
      readonly output?: unknown;
      readonly host?: unknown;
      /**
       * Why it stopped, when that was not the run's cancel: a `race` / `quorum` loser ([ADR 0014]),
       * stamped by the leaf on its `preempted` branch, or by the join when it rewrites a suspended
       * loser. Absent on a loop's or a foreach's `canceled` record and on every run-cancel record.
       * `step-result.ts` writes it as the Mastra row's `error`, and restores it from a canceled row
       * whose `error.name` is `'StepPreemptedError'` (M7b W1 C).
       */
      readonly reason?: StepPreemptedError;
    } & Partial<RecordFields>)
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
  /**
   * The attempt's deadline ([ADR 0013]): present exactly when the step has a `timeoutMs`, aborted —
   * with a `StepTimeoutError` as its `reason` — when this attempt's deadline fires on the run's
   * clock, and **never** by the run's own abort (that is `abortSignal`; a run abort before expiry
   * disarms the deadline). A fresh signal per attempt.
   *
   * The runner links it with `abortSignal` into the one signal the step sees, so `signal.reason`
   * tells a step which fired, and once it has fired gates every late effect of the attempt by its
   * identity (`stepId`, `path`, `foreachIndex`, `attempt`): no `stateUpdate`, no scorers, no
   * `suspend` / `bail` / resume labels, no writer chunks. The leaf discards the attempt's outcome
   * and writes the `timedOut` branch itself.
   */
  readonly deadline?: AbortSignal;
  /**
   * The deciding block's preemption ([ADR 0014]): present exactly when this attempt runs as an arm of
   * a `race` / `quorum` block of two or more arms — every attempt of the arm, retries included — and
   * aborted, with a {@link StepPreemptedError}, when the block decides (`met` or `short`), by
   * `RunScope.preempt`. Never by
   * the run's abort, and never by a deadline. One signal per block per segment, shared by its arms.
   *
   * The runner adds it as one more source of the attempt's gate (`attemptGate`), beside `abortSignal`
   * and `deadline`. The step's own signal aborts once, with the reason of the first source to fire.
   * **The outcome is the host's verdict** (`StepOutcome.verdict`), frozen once, when the step settles,
   * and the first of the run's abort, the deadline and the preemption to fire decides it: the run's
   * abort lets the step's own outcome stand, the deadline is a timeout, the preemption is `preempted`.
   * A later signal never re-decides, and nothing after the freeze changes it.
   * Called with this signal already fired (and the run not aborted), the runner does not start the
   * step and returns `preempted` at once; with the run aborted it runs the step, as Mastra's default
   * engine runs a retry under an aborted signal.
   */
  readonly preempt?: AbortSignal;
  /**
   * The pipeline item this attempt runs ([ADR 0015]): present exactly when the attempt is a pipeline
   * stage's (the leaf's `GadgetContext.item`), and then {@link foreachIndex} is absent — a stage runs
   * as a step of the twin's child run, so the runner does no `foreachIdx` lookup of the input (the
   * input is the call's data), mints no `nestedRunId` and publishes no step start or result event.
   * `path` is still the foreach's view path; the runner resolves the stage by `stepId` within the
   * pipeline's body, and reads and writes the item's state snapshot (`openItem` / `closeItem`) by
   * `(path, pipelineItem)`.
   */
  readonly pipelineItem?: number;
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

  /**
   * Drops what the runner holds for `stepId`'s suspension ([ADR 0014]): its resume labels. Called
   * through `RunScope.forgetSuspension` by a `race` / `quorum` join when it rewrites a suspended
   * loser's record `canceled`, so the finished run names no label that `Run.resume()` could take
   * to an arm that is no longer suspended. Optional: a runner that keeps no labels needs none.
   *
   * It reaches only this run's own bookkeeping. A loser that is a **nested workflow** leaves its
   * child run's own snapshot suspended in storage — a residual ([ADR 0014], row 107).
   */
  forgetSuspension?(stepId: string): void;

  /**
   * A pipeline item was admitted ([ADR 0015], maintainer decision 3): snapshot the run's state for
   * item `k` of the pipeline at `path`, as the twin's child run does at its start (`workflow.ts:3006`).
   * Every stage attempt with `StepCall.pipelineItem === k` then runs against, and `setState`s into,
   * that snapshot. Called through `ItemRecords.open` at stage 0's `start`. Optional: a runner that
   * keeps no state needs none.
   */
  openItem?(path: EntryPath, k: number): void;

  /**
   * Item `k` left the pipeline at `path` ([ADR 0015]): `'merge'` `Object.assign`s its snapshot into
   * the run's state (`workflow.ts:3055`, `default.ts:709-713` — last to settle wins each key, as on
   * the default engine), `'discard'` drops it. Called through `ItemRecords.forget`; see there for
   * which transition says which.
   */
  closeItem?(path: EntryPath, k: number, state: 'merge' | 'discard'): void;
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
  /**
   * Timeout funnel transition names ([ADR 0013]), attempt 0 first: `t.timeout-j` consumes attempt
   * `j`'s `timedOut_j` and forwards it to the next attempt's link (`retry-{j+1}`) on a non-final
   * attempt, and to the failure exit on the final one. `retries + 1` of them when the step has a
   * timeout; empty when it has none. `retryCeilingViolations` reads them: link `j + 1` is produced
   * only by attempt `j` or funnel `j`.
   */
  readonly timeouts: readonly string[];
  /**
   * The `timedOut_j` place names, attempt 0 first, parallel to `timeouts`: each produced only by
   * attempt `j` and consumed only by funnel `j`. Empty when the step has no timeout.
   */
  readonly timedOut: readonly string[];
  /**
   * The ids of the quotas every attempt in `attempts` draws on ([ADR 0012]), in the step's
   * declaration order; empty when none. The compiler builds each quota pool's takers from these —
   * from the leaf's registration, never from the arcs the pool check then inspects, so an attempt
   * compiled without its quota arc is caught (as `stepAttempts` catches one without its permit).
   */
  readonly quotas: readonly string[];
}

/** What a pool conserves: run permits, a block's slots, a `limit` quota, a `rateLimit` bucket. */
export type PoolKind = 'permits' | 'slots' | 'limit' | 'bucket';

/** A place that holds a pool's tokens while they are out, and how many pool tokens one of its tokens stands for. */
export interface PoolHolder {
  readonly place: string;
  /** Pool tokens per token of `place` — 1 for every pool M7 compiles. */
  readonly weight: number;
}

/**
 * A conserved resource ([ADR 0006], [ADR 0011], [ADR 0012]): a place seeded with `seed` tokens in
 * every segment's initial marking — never deposited by an action ([IO-016]) — and a **conservation
 * vector**, the pool place at weight 1 plus its holders, whose weighted sum is `seed` at every
 * marking, with an attempt in flight counting as holding what its firing took.
 *
 * `verify/pools.ts` checks that on the arcs (`poolStructureViolations`): every branch of every
 * transition touching the vector preserves the weighted sum; a taker consumes exactly
 * `one(place)` and a giver produces exactly one token into it; every taker and giver is declared
 * here, and nothing else takes from or gives to the pool; nothing reads or resets a place of the
 * vector. Takers and givers are **declared by whoever emitted them**, never derived from the arcs the
 * check inspects.
 *
 * | kind | place | holders | takers | givers |
 * |---|---|---|---|---|
 * | `permits` | `wf.permits` | — | every step attempt | the same attempts (returned on every branch) |
 * | `slots` | `wf.slots.<path>` | the block's `active` | `admit-j`, `re-admit-j` (a resume; `re-enter-j` holds nothing, so a refused seed returns no slot) | the collects |
 * | `limit` | `wf.quota.<id>` | — | the using attempts | the same attempts |
 * | `bucket` | `wf.quota.<id>` | `wf.quota.<id>.spent` | the using attempts | the quota's `refill` |
 *
 * The verifier derives its claims from the pools: `placeBound(place, seed)` and
 * `quiescentCount([place], seed, seed)` for every pool but a bucket, and for a bucket
 * `placeBound(place, burst)`, `placeBound(spent, burst)`, `quiescentCount([demand], 0, 0)` — a
 * bucket's tokens rest in `spent` once demand is gone, by design ([TIME-011]).
 */
export type Pool = PoolCommon &
  (
    | { readonly kind: 'permits' }
    | { readonly kind: 'slots' }
    | { readonly kind: 'limit'; readonly quota: string }
    | {
        readonly kind: 'bucket';
        readonly quota: string;
        /** Where a spent token waits for the refill; also a holder at weight 1. */
        readonly spent: Place<null>;
        /** One token per attempt waiting on the bucket; read, never consumed, by the refill. */
        readonly demand: Place<null>;
        /** The quota's one refill: `one(spent), read(demand), delayed(perMs) -> place`. */
        readonly refill: string;
        readonly perMs: number;
      }
  );

/** What every {@link Pool} carries. */
export interface PoolCommon {
  /** The pool place: a canonical place, outside every entry's `s.<i>` namespace. */
  readonly place: Place<null>;
  /** Tokens in the pool place in every segment's initial marking; the vector's constant sum. */
  readonly seed: number;
  /** The holder places, beside the pool place, of the conservation vector. */
  readonly holders: readonly PoolHolder[];
  /** Transitions that consume one token from the pool place. */
  readonly takers: readonly string[];
  /** Transitions that produce one token into the pool place. */
  readonly givers: readonly string[];
}

/**
 * One `race` / `quorum` block as the verifier sees it ([ADR 0014], amended 2026-10-04): its counted
 * decision's places and transitions, by name, as `compiler/blueprints/first-k.ts` emitted them, so
 * `verify/decision.ts` can check them on the arcs and `verify/claims.ts` can name its targets —
 * declared by the gadget, never derived from the arcs the check inspects.
 *
 * ```text
 * fork:                     in -> armIn_* (or q_0 under concurrency) + permit
 * collect-i:                armDone_i                 -> okSeen
 * collect-{err,bail,susp,pause}, collect-preempted-i  -> miss
 * met:                      permit + exactly(k, okSeen)       -> won    (action: scope.preempt(path, reason))
 * short:                    permit + exactly(n-k+1, miss)     -> short  (action: scope.preempt(path, reason))
 * absorb-{ok,miss}-won:     one(okSeen | miss) + read(won)    -> settled   (omitted when k = n)
 * absorb-{ok,miss}-short:   one(okSeen | miss) + read(short)  -> settled   (omitted when k = 1)
 * join-met:                 won   + exactly(n-k, settled)     -> next
 * join-short:               short + exactly(k-1, settled)     -> exits.failed
 * ```
 *
 * **What is omitted, and why.** A count of 0 omits its arc, and a transition that could never fire
 * is not emitted: when `k = n`, `met` takes every arrival, so nothing is left to absorb after it and
 * the `absorb-*-won` pair is omitted; when `k = 1`, `short` takes every arrival (n misses), so the
 * `absorb-*-short` pair is omitted. `settled` is bounded by `max(n − k, k − 1)` (`settledBound`);
 * that is 0 only for `n = 1`, where every absorb is omitted and `settled` with them — the place is
 * not emitted and {@link settled} is `undefined`. For `n = 1` no other arm can decide first, so the
 * arm gets no preemption at all: no `preempted` place, no `collect-preempted`, no `StepCall.preempt`.
 *
 * No `arrived`, no reset: every decision place is monotone, so VER-004 splits no collect (the W0
 * spike; the ADR's amendment).
 */
export interface DecisionSite {
  /** The block's top-level path, `[i]`. */
  readonly path: EntryPath;
  readonly blockId: string;
  readonly k: number;
  readonly n: number;
  /** The one-token decision right, seeded by `fork`, consumed by `met` or `short`. */
  readonly permit: string;
  readonly okSeen: string;
  readonly miss: string;
  readonly won: string;
  readonly short: string;
  /** `undefined` exactly when `n = 1` (bound 0, every absorb omitted). */
  readonly settled: string | undefined;
  /**
   * Arm `i`'s `preempted` place, arm order: produced only by arm `i`'s leaf, consumed by
   * `collectPreempted[i]`. Empty when `n = 1`.
   */
  readonly preempted: readonly string[];
  readonly met: string;
  /** The `short` transition's name (the place shares the role name, in the place namespace). */
  readonly shortTransition: string;
  /** The success collects, arm order: the only producers of `okSeen`. */
  readonly collectOk: readonly string[];
  /** Every miss collect: `collect-err`, `-bail`, `-susp`, `-pause`, then `collect-preempted-i` in arm order. */
  readonly collectMiss: readonly string[];
  /** Arm order; empty when `n = 1`. */
  readonly collectPreempted: readonly string[];
  /**
   * The absorbs emitted: `absorb-ok-won`, `absorb-miss-won` unless `k = n`, then `absorb-ok-short`,
   * `absorb-miss-short` unless `k = 1` — four, two (`k = n` or `k = 1`, `n ≥ 2`) or none (`n = 1`).
   */
  readonly absorbs: readonly string[];
  readonly joinMet: string;
  readonly joinShort: string;
}

/**
 * One `pipeline()` as the verifier and the resume refusal see it ([ADR 0015], amended by the W0
 * spike): its places and transitions, by name, as `compiler/blueprints/pipeline.ts` emitted them, so
 * `verify/pipeline.ts` can check them on the arcs, `verify/claims.ts` can name its bounds, exclusions
 * and overlap query, and `compiler/resume.ts` can refuse a resume at it by name (`pipeline`) —
 * declared by the gadget, never derived from the arcs the check inspects.
 *
 * ```text
 * cancel                      ?cancel   in -> exits.canceled                         (only with a signal)
 * split                       ¬cancel   in -> xor(open(queue.open) | open(queue.closed) | exits.failed)
 *                                       open(q) = frame + q + no-fault + no-susp + every permit
 * stage0.lane{l}.start        ¬cancel   queue.open + permit_{0,l} -> body_{0,l} + slot_{0,l} + queue.{open|closed}
 * stage0.lane{l}.refuse       ?cancel   queue.open + permit_{0,l} -> queue.closed + permit_{0,l}
 * stage{j}.lane{l}.to{m}      ¬cancel   done_{j,l} + slot_{j,l} + permit_{j+1,m}
 *                                       -> body_{j+1,m} + slot_{j+1,m} + permit_{j,l}          (j < s-1)
 * stage{s-1}.lane{l}.collect  ¬cancel   done + slot + frame -> frame + permit
 * stage{j}.lane{l}.bail       ¬cancel   bailed + slot + frame -> frame + permit
 * stage{j}.lane{l}.pause      ¬cancel   paused + slot + frame -> frame + permit
 * stage{j}.lane{l}.{fail|suspend}[.queue-closed[.again]]   ¬cancel, priority 1
 *                                       exit + slot + frame + queue.{open|closed} + {no-K|K}
 *                                       -> frame + permit + queue.closed + K   (three variants: the
 *                                       open-queue `.again` is dead — `exclusive(queue.open, K)` — and
 *                                       not emitted)
 * stage{j}.lane{l}.drop.{done,failed,bailed,suspended,paused}  ?cancel   exit + slot -> permit
 * join, fail.{clean,s}, suspend, canceled.{clean,f,s,fs}
 *                                       queue.closed + frame + every permit + the flags -> next | exits.*
 * ```
 *
 * Every pipeline place is 1-bounded and none carries an inhibitor, reset, `all()`, drain or
 * `atLeast()`: the only non-monotone place stays `wf.cancel`, so under [VER-004] the only split is
 * `t.cancel.arrive`. No exit pair, no resume place, no window pool.
 */
export interface PipelineSite {
  /** The foreach's top-level path, `[i]` — every lane's view path, and the refused resume path. */
  readonly path: EntryPath;
  /** The foreach entry's id. */
  readonly foreachId: string;
  /** The minted body's id — what Mastra records the aggregate, and a suspension, under. */
  readonly bodyId: string;
  /** The stage step ids, stage order. */
  readonly stages: readonly string[];
  /** `c_j`, stage order; Σ is the item window. */
  readonly bounds: readonly number[];
  /** The one data token, `split` to finisher: input, results, recorded outcomes. */
  readonly frame: string;
  readonly queueOpen: string;
  readonly queueClosed: string;
  /** The complement pairs: exactly one of each marked from `split` to the finisher. */
  readonly fault: string;
  readonly noFault: string;
  readonly susp: string;
  readonly noSusp: string;
  /** The cancel sweep on the input; `undefined` when the foreach was compiled without a signal. */
  readonly cancelSweep: string | undefined;
  readonly split: string;
  /** Every lane, stage-major: `lanes[L]` is flattened lane `L`. */
  readonly lanes: readonly PipelineLaneSite[];
  /** `join`, `fail.clean`, `fail.s`, `suspend`, then `canceled.{clean,f,s,fs}` when a signal is given. */
  readonly finishers: readonly string[];
}

/** One lane of a {@link PipelineSite}: stage `stage`, lane `lane`, flattened `flat`. */
export interface PipelineLaneSite {
  readonly stage: number;
  readonly lane: number;
  /** `L = Σ_{i<stage} c_i + lane`: the lane body's naming path is `[...site.path, L]`. */
  readonly flat: number;
  readonly permit: string;
  /** `{item, k, startedAt, …}` while an item is at this lane. */
  readonly slot: string;
  /** The lane body's input place: produced only by `start` (stage 0) or stage-(j−1) hand-offs. */
  readonly body: string;
  /** The lane body's success place. */
  readonly done: string;
  /** The lane body's exits; `canceled` is unreachable (no step writes it), as in the foreach. */
  readonly exits: {
    readonly failed: string;
    readonly bailed: string;
    readonly suspended: string;
    readonly paused: string;
    readonly canceled: string;
  };
  /** Stage 0 only: `start`. */
  readonly start: string | undefined;
  /** Stage 0 only, and only with a signal: `refuse`, the worker's abort check closing the queue. */
  readonly refuse: string | undefined;
  /**
   * `stage{j}.lane{l}.to{m}`, `m` order — `handoffs[m]` feeds the lane at `lanes[Σ_{i≤j} c_i + m]`;
   * empty on the last stage.
   */
  readonly handoffs: readonly string[];
  /** The last stage only: `stage{s-1}.lane{l}.collect`. */
  readonly collect: string | undefined;
  /**
   * The `¬cancel` settles that write the frame, by the exit each consumes — so rules 4 and 7 check
   * an exit's consumers against the declaration, never against what the arcs say:
   * `bailed` -> `bail`, `paused` -> `pause`, `failed` -> `fail` (`[open, queue-closed,
   * queue-closed.again]`), `suspended` -> `suspend` (likewise). The open-queue `.again` variant is
   * dead (`exclusive(queue.open, K)`) and not emitted, hence three, not four. `done`'s `¬cancel`
   * consumers are {@link handoffs} (stage < s−1) or {@link collect} (the last stage).
   */
  readonly settles: {
    readonly bail: string;
    readonly pause: string;
    readonly fail: readonly [open: string, queueClosed: string, queueClosedAgain: string];
    readonly suspend: readonly [open: string, queueClosed: string, queueClosedAgain: string];
  };
  /**
   * `drop.{done,failed,bailed,suspended,paused}`, by the exit each consumes: read `cancel`, return the
   * permit, write nothing (the item is a hole, as the twin's entry-end re-stamp makes it) and merge
   * the item's state (`ItemRecords.forget('merge')`). `undefined` without a signal.
   */
  readonly drops:
    | {
        readonly done: string;
        readonly failed: string;
        readonly bailed: string;
        readonly suspended: string;
        readonly paused: string;
      }
    | undefined;
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
   * Every conserved resource of the net ([ADR 0012]), seeded by `initialCounts` (`engine/kernel.ts`): the run's
   * permits first when a budget was compiled in, then the block slot pools in emission order, then
   * one pool per quota in first-use order.
   *
   * **`budget` stays beside it.** The permits are listed here too — `{ kind: 'permits', place:
   * budget.permits, seed: budget.k }` — so the kernel's seeding, the residue scan and the pool check
   * are one generic loop, while `budget` keeps every reader that means the run budget specifically:
   * `permitsBounded` / `permitsReturned`, `budgetStructureViolations` (which keeps its export), the
   * report's `k` and the engine's cache key. Invariant: `budget` is present exactly when a `permits`
   * pool is, with the same place and `k === seed`, and there is at most one.
   */
  readonly pools: readonly Pool[];
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
  /** Every `race` / `quorum` block, in emission order ([ADR 0014]); empty when there is none. */
  readonly decisions: readonly DecisionSite[];
  /**
   * Every `pipeline()`, in emission order ([ADR 0015]); empty when there is none. A resume at one is
   * refused by name (`pipeline`) — no resume site is registered for it — and its lane attempts are
   * exempt from suspension coverage (`pipelineLaneAttempts`), held instead by its structure rule 7.
   */
  readonly pipelines: readonly PipelineSite[];
  /** Stable over structure alone, so it keys a compile cache across runs. */
  readonly structuralHash: string;
}

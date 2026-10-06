import type { Place, Transition } from 'libpetri';
import type { NameVocabulary, EntryPath, QuotaRole } from '../names.js';
import type {
  DecisionSite,
  EntryDescription,
  ExclusionClaim,
  Exits,
  FlowToken,
  PlaceClaim,
  PipelineSite,
  Pool,
  PreemptedToken,
  QuotaRef,
  ResumeSite,
  StepChain,
  StepDescription,
} from '../types.js';

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
  /** The resume sites this gadget registers ([ADR 0007]) — its arms, or itself. */
  readonly resumeSites?: readonly ResumeSite[];
  /** Bounds other than 1 on this gadget's own places ([ADR 0009]). A nested step's are its own. */
  readonly claims?: readonly PlaceClaim[];
  /** Pairs of this gadget's places that are never marked together ([ADR 0009]). */
  readonly exclusions?: readonly ExclusionClaim[];
  /**
   * The pools this gadget owns ([ADR 0011]): a block limit's `wf.slots.<path>`, with its `active`
   * holder, its admits and re-entries as takers and its collects as givers. Collected by the builder
   * into `CompiledWorkflow.pools`, as claims are. The pool place must be an arc-referenced place of
   * the net. A gadget never returns the run permits or a quota pool: those are the compiler's.
   *
   * A pool brings its own bound and quiescence claims (the verifier derives them from `pools`), so
   * the gadget claims only its holders' bounds — `placeBound(active, c)` — through `claims`.
   */
  readonly pools?: readonly Pool[];
  /**
   * The counted decisions this gadget owns ([ADR 0014]) — one per `race` / `quorum` block. Collected by
   * the builder into `CompiledWorkflow.decisions`; every name must be a place or transition of the net.
   */
  readonly decisions?: readonly DecisionSite[];
  /**
   * The pipelines this gadget owns ([ADR 0015]) — one per `.foreach()` carrying a `pipeline`. Collected
   * by the builder into `CompiledWorkflow.pipelines`; every name must be a place or transition of the
   * net.
   */
  readonly pipelines?: readonly PipelineSite[];
}

/**
 * Where an arm of a deciding block leaves when the block has decided without it ([ADR 0014]). Given
 * one, the leaf adds a `preempted` branch to **every** attempt (the permit and quotas back on it, as
 * on every branch), hands each attempt `StepCall.preempt` = `RunScope.preemption(block)`, and takes
 * that branch when the signal had fired before the call, or fired before the step settled and
 * neither the run's abort nor the attempt's deadline had (precedence: run abort, then deadline, then
 * preemption) — after awaiting the step and discarding its result, and after writing the arm's
 * `canceled` record with `reason` = the signal's `StepPreemptedError`.
 *
 * Given only to the arms of a block of `n ≥ 2`: a block of one arm has no other arm to decide first.
 * An attempt admitted after the decision still enters only once its quotas ([ADR 0012]) and its block
 * slot ([ADR 0011]) are drawn, then sees the fired signal and leaves at once (row 110).
 */
export interface ArmPreemption {
  /** Arm `i`'s own `preempted` place: the leaf's only producer, the block's `collect-preempted-i` its only consumer. */
  readonly place: Place<PreemptedToken>;
  /** The deciding block's naming path — the key of `RunScope.preempt` / `preemption`. */
  readonly block: EntryPath;
  readonly blockId: string;
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
  /**
   * The run's step permits ([ADR 0006]), or `undefined` when the run is unbounded. Only a step
   * consumes one — a step attempt is the unit of work the budget bounds — and it hands it back in
   * every outcome branch of the same firing, so no permit is held across a wait, a join or a retry
   * delay and the budget cannot deadlock the net. Combinators pass it through untouched.
   */
  readonly permits: Place<null> | undefined;
  /**
   * The deciding block's preemption, when this entry is an arm of a `race` / `quorum` ([ADR 0014]);
   * `undefined` everywhere else, and then the leaf emits exactly today's attempts. Only the leaf reads
   * it; a combinator passes it through `NestedOptions.preempt`, never on to a further nesting.
   */
  readonly preempt: ArmPreemption | undefined;
  /**
   * `true` when this entry is a pipeline stage's lane body ([ADR 0015]): the leaf reads and records
   * through the item's store (see `NestedOptions.item`). `undefined` everywhere else, and then the
   * leaf emits exactly today's attempts. Only the leaf reads it.
   */
  readonly item: true | undefined;
  /**
   * `true` when this entry is a compensator ([ADR 0017]): every attempt hands the runner
   * `StepCall.detached`, so the step's signal is not linked to the run's abort. Only the compiler sets
   * it, through `NestedOptions.detached` when the ladder emits a compensator leaf — always with no
   * cancel signal. `undefined` everywhere else, and then the leaf emits and acts exactly as before.
   * Only the leaf reads it; it changes the runner call, never an arc.
   */
  readonly detached: true | undefined;
  /**
   * One step occurrence's member of a quota place ([ADR 0012]) — the leaf calls it for each
   * `StepDescription.quotas` entry: `role: 'pool'` for every quota (a `limit`'s pool, a `rateLimit`'s
   * bucket), and `'spent'` / `'demand'` for a `rateLimit` only (asking either of a `limit` throws).
   *
   * Returns a fresh place local to this emission, named `s.<path>.<slug>.quota.<id>.<role>`, which
   * the compiler fuses into the quota's canonical `wf.quota.<id>[.<role>]` at build (`FusionSet`,
   * [MOD-060]/[MOD-061]); actions write to it by its own name, through the place alias fusion keeps
   * ([MOD-031]). The same `(ref.id, role)` asked twice in one emission returns the same place. The
   * first ref seen for an id fixes its parameters; a later ref with the same id and different
   * parameters throws, naming both.
   *
   * The member never survives into the net, so a gadget must not name it in a claim or exclusion,
   * and must not emit a refill — fusion merges places, not transitions; the compiler emits one per
   * quota. The leaf still records the quota ids on its `StepChain`, from which the pool's takers are
   * built.
   */
  readonly quotaMember: (ref: QuotaRef, role: QuotaRole) => Place<null>;
  /** Registers a step-attempt transition by name — the leaf calls it for every attempt it emits. */
  readonly stepAttempt: (transitionName: string) => void;
  /** Registers a step's whole attempt chain ([ADR 0009]) — the leaf calls it once per step. */
  readonly stepChain: (chain: StepChain) => void;
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
  /** The arm's preemption ([ADR 0014]); only `firstKGadget` passes one. Defaults to none. */
  readonly preempt?: ArmPreemption;
  /**
   * The step is a pipeline stage's lane body ([ADR 0015], maintainer decision 3: item scope at twin
   * parity); only `pipelineGadget` passes it. The leaf then reads and writes through the item's store,
   * `RunScope.itemRecords(viewPath, k)` with `k` the token's `foreachIndex`: the view's `initData` is
   * the item and its `getStepResult` the item's own records, and every record the attempt writes goes
   * there instead of `recordStepResult` — as a stage of the twin's child run sees only that child.
   * The runner call carries `StepCall.pipelineItem = k` and no `foreachIndex`; the token outputs keep
   * `foreachIndex = k`, so the hand-offs and settles know the item.
   * Absent (every other step), the leaf emits and acts exactly as before.
   */
  readonly item?: true;
  /**
   * The step is a compensator ([ADR 0017]); only the compiler passes it, for the ladder's compensator
   * leaves, which it emits with no `cancel` (structure rule S5). See `GadgetContext.detached`.
   */
  readonly detached?: true;
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

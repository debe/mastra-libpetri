/**
 * Mastra's workflow graph and step-result types, mirrored **structurally**.
 *
 * Nothing in this package imports `@mastra/core` at runtime: it is a type-only devDependency
 * and a tsup external, so a compiler or verification build never pulls Mastra in (CLAUDE.md,
 * *Source layout*). This file is that seam — a structural copy of exactly the fields the
 * adapter and the step-result translation (`step-result.ts`) read or write, and nothing else.
 * Types only: no runtime code but `entryId`.
 *
 * **Transcribed from `@mastra/core@1.67.0`.** Cited so drift is findable:
 * - `StepFlowEntry`, `SingleStepEntry`, `ForeachOptions`, `StepFlowEntryOptions` —
 *   `.mastra/package/dist/workflows/types.d.ts:505-645`
 * - `Step` — `.mastra/package/dist/workflows/step.d.ts:59-78`
 * - `ExecutionGraph` — `.mastra/package/dist/workflows/execution-engine.d.ts:13-16`
 * - `getEntryId` — `.mastra/src-extracted/src/workflows/step-entry.ts:23-25`
 * - `StepResult` and its members, `StepTripwireInfo`, `SerializedStepFailure` —
 *   `.mastra/package/dist/workflows/types.d.ts:65-162`; `SerializedError` —
 *   `dist/_types/@internal_core/dist/error/index.d.ts:12-17`
 *
 * **Deliberately loose.** Mastra's builder carries eight type parameters; every one of them is
 * erased by the time an entry sits in `stepFlow`, and the adapter works on the erased side.
 * Live references the adapter never calls — `condition`, `mapConfig`, `agent`, `tool`, `fn` —
 * are `unknown` rather than re-expressed, because they are read for their *presence* only.
 *
 * **Drift is loud, not silent.** Every variant is matched exhaustively and an unrecognised
 * `type` is refused, so a new Mastra entry kind surfaces as a refusal rather than as a
 * mis-mapping. `tests/mastra/adapt.test.ts` additionally asserts, at the type level only, that
 * Mastra's real `StepFlowEntry` is assignable to this mirror, and that `StepResult` is assignable
 * in both directions.
 */

/**
 * A step's structural identity.
 *
 * Mastra's `Step` also carries `inputSchema`, `outputSchema`, `execute`, `scorers` and the
 * suspend/resume schemas. None of them are structure, so none are mirrored: a real `Step` stays
 * assignable to this, which is the only direction that matters.
 *
 * `component` is `'WORKFLOW'` for a nested workflow — the one legal way to put control flow
 * under an arm or a loop body, because `Workflow implements Step`
 * (`workflow.ts:1721-1740`). The `Workflow` constructor sets it through `MastraBase`
 * (`workflow.ts:1789`), and Mastra tells a nested workflow apart by exactly this comparison
 * (`step-entry.ts:61-70`). Mastra runs it as one opaque step with its own run id. A `Workflow`
 * has no `retries` of its own, so it retries by the workflow-level `retryConfig`.
 */
export interface Step {
  readonly id: string;
  readonly description?: string;
  /** A *retry* count, not a total: Mastra runs the step `retries + 1` times (`default.ts:455`). */
  readonly retries?: number;
  readonly component?: string;
}

/**
 * Retry-bearing options on a declarative `agent` / `tool` entry. Mastra types the whole object
 * as `any` (`types.d.ts:528,534`); `retries` is the one field the adapter reads, as
 * `getEntryRetries` does (`step-entry.ts:35-45`), and the step Mastra materializes from the entry
 * carries the same value (`step-factories.ts:52,69,108`).
 */
export interface DeclarativeEntryOptions {
  readonly retries?: number;
}

/** A serialized condition label: `{ id: '<stepId>-condition', fn }` (`workflow.ts:2449`). */
export interface SerializedCondition {
  readonly id: string;
  readonly fn: string;
}

/**
 * The "single step-like" entries — a plain step plus the three declarative variants Mastra
 * materializes into a step at execution time.
 *
 * All four run through one shared runner (`handlers/entry.ts:336-343`,
 * `handlers/control-flow.ts:91-106`), and each is one-in / one-out. This is the only kind of
 * entry allowed under a `parallel`/`conditional` arm or a `loop`/`foreach` body
 * (`types.d.ts:577,583,601,619`) — control flow cannot nest directly.
 */
export type SingleStepEntry =
  | { readonly type: 'step'; readonly step: Step }
  | {
      readonly type: 'agent';
      readonly id: string;
      readonly agentId: string;
      readonly agent?: unknown;
      readonly options?: DeclarativeEntryOptions;
    }
  | {
      readonly type: 'tool';
      readonly id: string;
      readonly toolId: string;
      readonly tool?: unknown;
      readonly options?: DeclarativeEntryOptions;
    }
  | {
      readonly type: 'mapping';
      readonly id: string;
      readonly description?: string;
      /** `MappingConfig | ExecuteFunction` — read for presence, never called here. */
      readonly mapConfig: unknown;
    };

/** `.foreach(step, opts)` options (`types.d.ts:642-644`). */
export interface ForeachOptions {
  /**
   * A number, or a resolver Mastra calls **per run** with the actual input array
   * (`types.d.ts:623-641`, `utils.ts:786-796`). Mastra also keeps the caller's options object
   * by reference so an agentic workflow can mutate `concurrency` between build and execution
   * (`workflow.ts:2629-2636`).
   */
  readonly concurrency: number | ((context: ForeachConcurrencyContext) => number);
}

/** What a foreach concurrency resolver is handed (`types.d.ts:626-631`). */
export interface ForeachConcurrencyContext {
  readonly inputData: unknown;
  readonly getInitData: () => unknown;
}

/**
 * One entry of a committed workflow's `stepFlow`.
 *
 * Note the two asymmetries the adapter has to respect. `sleep` and `sleepUntil` always carry an
 * `id` (the builder generates one — `workflow.ts:2088`), while `parallel`, `conditional`, `loop`
 * and `foreach` carry one only when the author passed `options.id`. And Mastra's tag for
 * `.branch()` is `'conditional'`, never `'branch'`.
 */
export type StepFlowEntry =
  | SingleStepEntry
  | {
      readonly type: 'sleep';
      readonly id: string;
      readonly description?: string;
      /** Present for `.sleep(ms)`. Mutually exclusive with `fn` (`workflow.ts:2099-2102`). */
      readonly duration?: number;
      /** Present for `.sleep(fn)` — the duration is computed per run. */
      readonly fn?: unknown;
    }
  | {
      readonly type: 'sleepUntil';
      readonly id: string;
      readonly description?: string;
      readonly date?: Date;
      readonly fn?: unknown;
    }
  | {
      readonly type: 'parallel';
      readonly id?: string;
      readonly description?: string;
      readonly steps: readonly SingleStepEntry[];
    }
  | {
      readonly type: 'conditional';
      readonly id?: string;
      readonly description?: string;
      readonly steps: readonly SingleStepEntry[];
      /** Index-aligned with `steps` (`workflow.ts:2434-2454`). Evaluated by the host, not here. */
      readonly conditions: readonly unknown[];
      readonly serializedConditions: readonly SerializedCondition[];
      /** Present only when at least one arm used the declarative `{ predicate }` form. */
      readonly predicates?: readonly unknown[];
    }
  | {
      readonly type: 'loop';
      readonly id?: string;
      readonly description?: string;
      readonly step: SingleStepEntry;
      readonly condition: unknown;
      readonly serializedCondition: SerializedCondition;
      readonly loopType: 'dowhile' | 'dountil';
      readonly predicate?: unknown;
    }
  | {
      readonly type: 'foreach';
      readonly id?: string;
      readonly description?: string;
      readonly step: SingleStepEntry;
      readonly opts: ForeachOptions;
    };

/**
 * What `execute({ graph })` is handed (`execution-engine.d.ts:13-16`).
 *
 * `steps` is mirrored as optional although Mastra declares it required: the constructor builds
 * the graph one line before `stepFlow` is assigned (`workflow.ts:1798-1799`), so a workflow the
 * author never committed arrives with `steps === undefined`.
 */
export interface ExecutionGraph {
  readonly id: string;
  readonly steps?: readonly StepFlowEntry[];
}

/**
 * The id a single step-like entry is keyed by.
 *
 * Mastra's own rule, not one written from memory: a plain `step` keys off the wrapped step's
 * id, while the declarative variants carry their own (`step-entry.ts:23-25`, re-exported as
 * `getSingleStepEntryId` at `utils.ts:311`). An `agent` entry's `agentId` is *not* its id —
 * Mastra overrides the materialized step's id with `entry.id` (`default.ts:1182`).
 */
export function entryId(entry: SingleStepEntry): string {
  return entry.type === 'step' ? entry.step.id : entry.id;
}

// ---------------------------------------------------------------------------------------------
// Step results
// ---------------------------------------------------------------------------------------------

/**
 * `StepMetadata` (`types.d.ts:65`): open-ended. Mastra writes `iterationCount` for a loop body
 * (`handlers/step.ts:177`) and `nestedRunId` for a nested workflow (`handlers/step.ts:561-563`);
 * anything else is the author's.
 */
export type StepMetadata = Record<string, unknown>;

/**
 * `StepTripwireInfo` (`types.d.ts:80-85`) — a `TripWire` flattened to a plain object when the
 * failure is recorded, so it serialises (`default.ts:496-504`).
 */
export interface StepTripwireInfo {
  readonly reason: string;
  readonly retry?: boolean;
  readonly metadata?: Record<string, unknown>;
  readonly processorId?: string;
}

/**
 * `SerializedError` (`_types/@internal_core/dist/error/index.d.ts:12-17`): what a failure's
 * `error` becomes once a run has been through storage.
 */
export type SerializedError = {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: unknown;
} & Record<string, unknown>;

/**
 * The fields every recorded status shares, with Mastra's generic parameters erased — the
 * adapter's side of the seam never sees them.
 *
 * `payload` is the step's **input**, not a suspension's payload: that one is `suspendPayload`.
 * `suspendPayload`, `suspendOutput` and `suspendedAt` belong to a suspension and are modelled on
 * the engine's suspended record; `resumePayload` and `resumedAt` are the resume fields this
 * engine does not model, and survive a translation only through a record's `host`
 * (`../compiler/types.ts`, `StepOutcome.host`).
 */
interface StepResultBase {
  readonly payload: unknown;
  readonly resumePayload?: unknown;
  readonly suspendPayload?: unknown;
  readonly suspendOutput?: unknown;
  readonly startedAt: number;
  readonly suspendedAt?: number;
  readonly resumedAt?: number;
  readonly metadata?: StepMetadata;
}

/** `StepSuccess` (`types.d.ts:66-78`). */
export interface StepSuccess extends StepResultBase {
  readonly status: 'success';
  readonly output: unknown;
  readonly endedAt: number;
}

/**
 * `StepFailure` (`types.d.ts:86-102`). `error` is always an `Error` at run time: Mastra passes
 * whatever a step threw through `getErrorFromUnknown` before recording it (`default.ts:466-469`).
 */
export interface StepFailure extends StepResultBase {
  readonly status: 'failed';
  readonly error: Error;
  readonly endedAt: number;
  readonly tripwire?: StepTripwireInfo;
  readonly nonRetryable?: true;
}

/** `SerializedStepFailure` (`types.d.ts:156-158`): a failure read back from storage. */
export interface SerializedStepFailure extends Omit<StepFailure, 'error'> {
  readonly error: SerializedError;
}

/**
 * `StepSuspended` (`types.d.ts:103-111`). No `endedAt`: a suspended step has not ended, and
 * `suspendedAt` is its timestamp instead (`handlers/step.ts:516-521`).
 */
export interface StepSuspended extends StepResultBase {
  readonly status: 'suspended';
  readonly suspendedAt: number;
}

/** `StepRunning` (`types.d.ts:112-122`): a step in flight — the record written before it runs. */
export interface StepRunning extends StepResultBase {
  readonly status: 'running';
}

/** `StepWaiting` (`types.d.ts:123-131`): a `.sleep()` / `.sleepUntil()` in progress (`handlers/entry.ts:606`). */
export interface StepWaiting extends StepResultBase {
  readonly status: 'waiting';
}

/** `StepPaused` (`types.d.ts:132-140`): a nested workflow that paused. */
export interface StepPaused extends StepResultBase {
  readonly status: 'paused';
}

/**
 * `StepSkipped` (`types.d.ts:141-150`): written only by time travel, for a `.branch()` arm whose
 * condition was not truthy (`handlers/control-flow.ts:517-528`, `utils.ts:512-516`).
 */
export interface StepSkipped extends StepResultBase {
  readonly status: 'skipped';
  readonly endedAt: number;
}

/**
 * A step that called `bail(result)`. **Not in Mastra's declared union** — `StepResult` has no
 * `'bailed'` member — but it is what the step handler records (`handlers/step.ts:522-524`, cast
 * through `as StepResult` at `:566-569`), and it sits in `stepResults` under that status until a
 * top-level bail rewrites it to `'success'` in place (`default.ts:926-928`). Mirrored because the
 * translation must accept what Mastra actually stores, not only what it declares.
 */
export interface StepBailed extends StepResultBase {
  readonly status: 'bailed';
  readonly output: unknown;
  readonly endedAt: number;
}

/**
 * A loop or foreach canceled mid-run. **Not in Mastra's declared union** either: the loop returns
 * a bare `{ status: 'canceled' }` and the foreach `{...stepInfo, status: 'canceled', output,
 * endedAt}`, both cast through `as unknown as StepResult` (`handlers/control-flow.ts:752,817,899,
 * 1164-1169,1306`), and `handlers/entry.ts:810-812` stores it under the body's id. Hence every
 * field but `status` is optional: the loop's has none of them.
 */
export interface StepCanceled extends Partial<StepResultBase> {
  readonly status: 'canceled';
  readonly output?: unknown;
  readonly endedAt?: number;
}

/** `StepResult<any, any, any, any>` (`types.d.ts:151`). */
export type StepResult =
  | StepSuccess
  | StepFailure
  | StepSuspended
  | StepRunning
  | StepWaiting
  | StepPaused
  | StepSkipped;

/**
 * Everything a `stepResults` entry can hold: Mastra's declared union, its serialised failure
 * (`SerializedStepResult`, `types.d.ts:162`), and the undeclared `'bailed'` and `'canceled'`.
 */
export type StoredStepResult = StepResult | SerializedStepFailure | StepBailed | StepCanceled;

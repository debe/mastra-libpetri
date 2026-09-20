/**
 * Mastra's workflow graph types, mirrored **structurally**.
 *
 * Nothing in this package imports `@mastra/core` at runtime: it is a type-only devDependency
 * and a tsup external, so a compiler or verification build never pulls Mastra in (CLAUDE.md,
 * *Source layout*). This file is that seam — a structural copy of exactly the fields the
 * adapter reads, and nothing else.
 *
 * **Transcribed from `@mastra/core@1.67.0`.** Cited so drift is findable:
 * - `StepFlowEntry`, `SingleStepEntry`, `ForeachOptions`, `StepFlowEntryOptions` —
 *   `.mastra/package/dist/workflows/types.d.ts:505-645`
 * - `Step` — `.mastra/package/dist/workflows/step.d.ts:59-78`
 * - `ExecutionGraph` — `.mastra/package/dist/workflows/execution-engine.d.ts:13-16`
 * - `getEntryId` — `.mastra/src-extracted/src/workflows/step-entry.ts:23-25`
 *
 * **Deliberately loose.** Mastra's builder carries eight type parameters; every one of them is
 * erased by the time an entry sits in `stepFlow`, and the adapter works on the erased side.
 * Live references the adapter never calls — `condition`, `mapConfig`, `agent`, `tool`, `fn` —
 * are `unknown` rather than re-expressed, because they are read for their *presence* only.
 *
 * **Drift is loud, not silent.** Every variant is matched exhaustively and an unrecognised
 * `type` is refused, so a new Mastra entry kind surfaces as a refusal rather than as a
 * mis-mapping. `tests/mastra/adapt.test.ts` additionally asserts, at the type level only, that
 * Mastra's real `StepFlowEntry` is assignable to this mirror.
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
 * (`workflow.ts:1721-1740`). Mastra runs it as one opaque step with its own run id.
 */
export interface Step {
  readonly id: string;
  readonly description?: string;
  /** A *retry* count, not a total: Mastra runs the step `retries + 1` times (`default.ts:455`). */
  readonly retries?: number;
  readonly component?: string;
}

/** Retry-bearing options on a declarative `agent` / `tool` entry (`step-entry.ts:35-45`). */
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

/** `.foreach(step, opts)` options (`types.d.ts:645-647`). */
export interface ForeachOptions {
  /**
   * A number, or a resolver Mastra calls **per run** with the actual input array
   * (`types.d.ts:626-644`, `utils.ts:786-796`). Mastra also keeps the caller's options object
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

import {
  MAX_CONCURRENCY,
  MAX_FOREACH_LANES,
  MAX_ITERATION_BOUND,
  MAX_RETRIES,
  MAX_WAIT_MS,
  QUOTA_ID_PATTERN,
} from '../compiler/index.js';
import type {
  BlockConcurrency,
  BlockDecision,
  BuildOrRun,
  EntryDescription,
  QuotaRef,
  StepDescription,
  StepSource,
  WorkflowDescription,
} from '../compiler/types.js';
import { entryId, type ExecutionGraph, type SingleStepEntry, type StepFlowEntry } from './host.js';
import { Decision, decisionOf, Quota, resourcesOf } from './resources.js';

/**
 * Mastra's tag for `.branch()`. There is no `'branch'` entry type in `StepFlowEntry`; the
 * compiler's kind is `branch` and Mastra's tag is `conditional`, so the two vocabularies meet
 * here and nowhere else.
 */
export const MASTRA_BRANCH_ENTRY_TYPE = 'conditional';

/**
 * The `component` a nested `Workflow` carries. Its constructor passes
 * `component: RegisteredLogger.WORKFLOW` to `MastraBase` (`workflow.ts:1789`), whose value is
 * the string `'WORKFLOW'`, and Mastra itself detects a nested workflow by exactly this
 * comparison (`step-entry.ts:61-70`, `handlers/step.ts:351,472`).
 */
export const MASTRA_WORKFLOW_COMPONENT = 'WORKFLOW';

/**
 * The Layer 2 annotations: keys of Mastra's own `metadata` that this engine reads and Mastra's
 * engine ignores — it reads `metadata` only for span attributes (`handlers/control-flow.ts:62-81`;
 * `types.d.ts:500-503`). `checkpoint` on a top-level entry ([ADR 0010]); `concurrency` on a
 * `.parallel()` / `.branch()` call's own options ([ADR 0011]). `tests/engine/layer2-ignorable.test.ts`
 * is driven by this list: an annotated workflow on `DefaultExecutionEngine` returns what its
 * unannotated twin does, so each key stays meaningful there, merely unenforced.
 */
export const LAYER2_METADATA_KEYS = ['checkpoint', 'concurrency'] as const;

/** One of {@link LAYER2_METADATA_KEYS}. */
export type Layer2MetadataKey = (typeof LAYER2_METADATA_KEYS)[number];

/**
 * The refusals of a counted decision ([ADR 0014]) — Layer 3, so not a {@link LAYER2_METADATA_KEYS}
 * entry: the decision rides in `metadata` under a symbol (`BLOCK_DECISION`), which no string key
 * names and the default engine never reads. Each is a prefix of `UnsupportedWorkflowError.reason`,
 * as every refusal's name is, and recorded in `docs/divergences.md`.
 *
 * - `quorum-value` — `k` is not a whole number in [1, n] (a forged or altered `Decision`).
 * - `race-empty` — a decision over no arms.
 * - `blueprint-arms` — the entry's arms are not the minted arms, by identity and in order; an arm is
 *   listed twice, by object or by step id; or the value under the key is not a minted `Decision`.
 * - `blueprint-position` — the marker on any entry but a `.parallel()`: a `.branch()`, a `.foreach()`,
 *   a loop, a sleep, a step, or an arm's own metadata.
 * - `blueprint-reused` — one minted `Decision` marks more than one `.parallel()` of this workflow:
 *   `const r = race([a, b]); wf.parallel(...r).parallel(...r)` spreads the same `metadata` object
 *   twice, and both entries pass `blueprint-arms`, since their arms are the minted arms. Nothing else
 *   catches it: neither Mastra nor this adapter refuses two entries with one id (names are by path),
 *   so a decision is one block, and a second block needs its own `race` / `quorum` call. Scoped to
 *   this workflow's description, as `quota-id-collision` is: a nested workflow is adapted on its own.
 */
export const BLUEPRINT_REFUSALS = ['quorum-value', 'race-empty', 'blueprint-arms', 'blueprint-position', 'blueprint-reused'] as const;

/** One of {@link BLUEPRINT_REFUSALS}. */
export type BlueprintRefusal = (typeof BLUEPRINT_REFUSALS)[number];

export interface AdaptOptions {
  /** The workflow's id — `ExecutionGraph.id`, which is `Workflow.id`. */
  readonly workflowId: string;
  /**
   * An upper bound on `.dowhile` / `.dountil` iterations.
   *
   * **This has no counterpart in Mastra**, whose loop is a bare `do { … } while (…)` with no
   * cap of any kind (`handlers/control-flow.ts:739,901`). A `.dowhile` therefore cannot be
   * adapted unless a bound is chosen deliberately, because a run Mastra would continue past the
   * bound ends here instead. There is no default on purpose.
   */
  readonly iterationBound?: number;
  /**
   * The workflow-level retry config — `Workflow.retryConfig`, which `execute()` receives as
   * `retryConfig` (`workflow.ts:1797`, `default.ts:742-778`). It lives on the workflow, not on
   * any `StepFlowEntry`, so the caller passes it here.
   *
   * `attempts` is a **retry** count, so `attempts: 2` runs a step up to three times
   * (`default.ts:455`). It is only the fallback: a step's own count wins, including an explicit
   * `0`. `delay` is the fixed wait between attempts, and is used only by a step that retries.
   */
  readonly retryConfig?: { readonly attempts?: number; readonly delay?: number };
}

/**
 * Thrown when a workflow uses something Mastra can express and this engine cannot run faithfully.
 *
 * Every refusal names the entry, its Mastra type and the reason, and each one is recorded in
 * `docs/divergences.md`: refusing loudly when the workflow is prepared is the alternative to
 * running it and quietly getting a different answer.
 */
export class UnsupportedWorkflowError extends Error {
  override readonly name = 'UnsupportedWorkflowError';
  /** Mastra's entry type, as it appears in `stepFlow` — `'conditional'` for `.branch()`. */
  readonly entryType: string;
  readonly entryId: string;
  readonly reason: string;

  constructor(entryType: string, entryId: string, reason: string) {
    super(`cannot adapt Mastra '${entryType}' entry '${entryId}': ${reason}`);
    this.entryType = entryType;
    this.entryId = entryId;
    this.reason = reason;
  }
}

/**
 * Adapts a committed workflow's `stepFlow` into the compiler's structural description.
 *
 * `buildExecutionGraph()` is a pure pass-through — `{ id: this.id, steps: this.stepFlow }`,
 * with no normalization and no rewriting (`workflow.ts:2661-2666`) — so what arrives here is
 * verbatim what the builder pushed. The builder's own defaults are already applied (`.foreach()`'s
 * `concurrency: 1` at `workflow.ts:2636`); the defaults Mastra applies **at execution time** —
 * the retry fallback, a sleep's normalisation, `.foreach()`'s concurrency clamp — are applied
 * here, each with the expression Mastra uses, so the description says what Mastra would do.
 *
 * **Order is preserved everywhere.** `entries[i]` is `stepFlow[i]` and `arms[j]` is
 * `steps[j]`, so a positional `executionPath` and a `.branch()` condition index mean the same
 * thing on both sides.
 *
 * **Refusals are the point.** Where Mastra can express something the compiler's
 * `EntryDescription` cannot, this throws an {@link UnsupportedWorkflowError} naming the entry,
 * its type and the reason, rather than dropping the behaviour.
 */
export function adaptStepFlow(
  entries: readonly StepFlowEntry[],
  options: AdaptOptions,
): WorkflowDescription {
  const ctx: AdaptContext = { options, quotas: new Map() };
  const adapted = entries.map((entry, index) => adaptEntry(entry, index, ctx));
  refuseMisplacedConcurrency(entries, adapted);
  refuseMisplacedDecision(entries);
  const checkpoints = checkpointsOf(entries, adapted);
  return {
    id: options.workflowId,
    entries: adapted,
    // Absent rather than empty when nothing is marked: the engine keys its compile cache on the
    // description's JSON, and an unmarked workflow must key exactly as it did before checkpoints.
    ...(checkpoints.length > 0 ? { checkpoints } : {}),
  };
}

/**
 * The author's checkpoint marks ([ADR 0010]): `metadata: { checkpoint: true }` on a top-level entry
 * means *checkpoint once this entry succeeds*. The mark is Mastra's own `metadata`, so a marked
 * workflow runs unchanged on `DefaultExecutionEngine`, which reads metadata only for span attributes.
 *
 * Where the mark is read, per entry type, exactly where Mastra's builders put it:
 * - `.then(step)` — the step's own `createStep({ metadata })`, as `entry.step.metadata`;
 * - `.agent()` / `.tool()` and a step made from an agent or a tool — `entry.options.metadata`;
 * - `.map(…, { metadata })`, `.sleep`, `.sleepUntil`, `.parallel`, `.branch`, `.dowhile`, `.dountil`,
 *   `.foreach` — the entry's own `metadata`, from the builder's options (`toEntryOptionFields`,
 *   `workflow.ts:647-653`).
 *
 * **Only `true` marks.** `false` and an absent key are no mark. Any other value — `'true'`, `1`,
 * an object — is refused by name: a durability point is not something to guess at, and reading a
 * truthy string as a mark (or as none) would silently disagree with what its author meant.
 *
 * **Only at a top-level boundary.** A mark on a `.parallel()`/`.branch()` arm, a loop body or a
 * `.foreach()` body is refused (`checkpoint-position`): between those and what follows there is no
 * single flow token to seed from. The refusal names the enclosing entry's options as the place for
 * the mark, and `cloneStep` for a Step object shared with a top-level position, since the mark lives
 * on the object and goes wherever it is used.
 *
 * A mark on the **last** entry is accepted and omitted: the run's terminal row already records it.
 * The result is ascending, as the compiler requires.
 */
function checkpointsOf(entries: readonly StepFlowEntry[], adapted: readonly EntryDescription[]): number[] {
  const last = entries.length - 1;
  const out: number[] = [];
  entries.forEach((entry, index) => {
    const enclosing = adapted[index]!;
    for (const { inner, role } of innerSteps(entry)) {
      const mark = checkpointMark(metadataOfSingle(inner), inner.type, entryId(inner));
      if (mark) {
        refuse(
          entry.type,
          enclosing.id,
          `checkpoint-position: step '${entryId(inner)}' is marked metadata.checkpoint as ${role}, but a ` +
            'checkpoint is only taken between top-level entries. Mark the enclosing entry instead, through ' +
            `its own options (\`{ metadata: { checkpoint: true } }\` on the .${builderOf(entry)}() call), to ` +
            "checkpoint once the whole block succeeds. If this Step object is also used at the top level, " +
            "give that use its own copy with cloneStep(), since the mark travels with the object.",
        );
      }
    }
    const own = checkpointMark(metadataOfEntry(entry), entry.type, enclosing.id);
    if (own && index < last) out.push(index);
  });
  return out;
}

/** The single steps an entry nests, and how a refusal names their position. */
function innerSteps(entry: StepFlowEntry): { inner: SingleStepEntry; role: string }[] {
  switch (entry.type) {
    case 'parallel':
      return entry.steps.map((inner) => ({ inner, role: 'a .parallel() arm' }));
    case MASTRA_BRANCH_ENTRY_TYPE:
      return entry.steps.map((inner) => ({ inner, role: 'a .branch() arm' }));
    case 'loop':
      return [{ inner: entry.step, role: `the body of a .${entry.loopType}()` }];
    case 'foreach':
      return [{ inner: entry.step, role: 'the body of a .foreach()' }];
    default:
      return [];
  }
}

function builderOf(entry: StepFlowEntry): string {
  switch (entry.type) {
    case MASTRA_BRANCH_ENTRY_TYPE:
      return 'branch';
    case 'loop':
      return entry.loopType;
    default:
      return entry.type;
  }
}

/** Where a top-level entry's metadata lives: a single step's own, or the builder's options. */
function metadataOfEntry(entry: StepFlowEntry): unknown {
  switch (entry.type) {
    case 'step':
    case 'agent':
    case 'tool':
    case 'mapping':
      return metadataOfSingle(entry);
    default:
      return (entry as { metadata?: unknown }).metadata;
  }
}

/**
 * A single step's metadata. `host.ts` mirrors no `metadata` field — Mastra types it
 * `Record<string, any>` on the step, the declarative options and the mapping entry alike
 * (`types.d.ts:537-539`, `workflow.ts:144-157`) — so it is read structurally here.
 */
function metadataOfSingle(entry: SingleStepEntry): unknown {
  switch (entry.type) {
    case 'step':
      return (entry.step as { metadata?: unknown }).metadata;
    case 'agent':
    case 'tool':
      return (entry.options as { metadata?: unknown } | undefined)?.metadata;
    case 'mapping':
      return (entry as { metadata?: unknown }).metadata;
    default:
      return undefined;
  }
}

/** `true` marks; absent and `false` do not; anything else is refused by name. */
function checkpointMark(metadata: unknown, type: string, id: string): boolean {
  if (metadata === null || typeof metadata !== 'object') return false;
  if (!Object.prototype.hasOwnProperty.call(metadata, 'checkpoint')) return false;
  const value: unknown = (metadata as { checkpoint?: unknown }).checkpoint;
  if (value === true) return true;
  if (value === false || value === undefined) return false;
  return refuse(
    type,
    id,
    `checkpoint-value: metadata.checkpoint is ${describeValue(value)}; only \`true\` marks a checkpoint ` +
      '(and `false` or no key marks none). Anything else is refused rather than read one way or the other.',
  );
}

/**
 * A `.parallel()` / `.branch()` call's own bound on its fan-out ([ADR 0011]): `metadata: { concurrency:
 * c }` in the call's options, which `toEntryOptionFields` keeps on the entry (`workflow.ts:647-653`).
 * The options themselves take only `id`, `description` and `metadata` — `{ concurrency: c }` there is
 * a type error in Mastra's own types and dropped at run time — so the key rides where Mastra keeps
 * what it does not enforce, and the default engine runs an annotated block exactly as an unannotated
 * one: every arm at once (Layer 2).
 *
 * Absent (or `undefined`) is no bound. A safe integer ≥ 1 is passed through **as written**: the
 * compiler treats `c ≥ arms` as absent, so the description says what the author wrote. Anything
 * else is refused by name (`concurrency-value`) — a function in particular, since a block's bound,
 * unlike `.foreach()`'s resolver, is fixed when the workflow is compiled.
 */
function blockConcurrency(entry: StepFlowEntry, id: string): BlockConcurrency | undefined {
  const metadata = metadataOfEntry(entry);
  if (!hasConcurrency(metadata)) return undefined;
  const value: unknown = (metadata as { concurrency?: unknown }).concurrency;
  if (typeof value === 'function') {
    refuse(
      entry.type,
      id,
      'concurrency-value: metadata.concurrency is a function, but a block\'s bound is fixed when the ' +
        'workflow is compiled and one compiled form serves every run. Pass a whole number of at least 1.',
    );
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    refuse(
      entry.type,
      id,
      `concurrency-value: metadata.concurrency is ${describeValue(value)}; it must be a whole number of at ` +
        'least 1 — the most arms of this block in flight at once.',
    );
  }
  return value;
}

/** Whether `metadata` carries a `concurrency` key with a value; `undefined` counts as none. */
function hasConcurrency(metadata: unknown): boolean {
  if (metadata === null || typeof metadata !== 'object') return false;
  if (!Object.prototype.hasOwnProperty.call(metadata, 'concurrency')) return false;
  return (metadata as { concurrency?: unknown }).concurrency !== undefined;
}

/**
 * `metadata.concurrency` anywhere but a `.parallel()` / `.branch()` call's own options ([ADR 0011]).
 * Refused rather than ignored: Mastra's engine ignores it everywhere, so an author who put it on a
 * step expected this engine to read it, and reading it nowhere would quietly run unbounded.
 *
 * - `concurrency-position`: on a top-level `.then()` step, an agent, tool, `.map()`, sleep or loop
 *   entry, or on an arm's or a body's own step metadata. The message names the enclosing block's
 *   options as the place for a block bound, the engine's run-wide `concurrency` for a bound on the
 *   whole run, and `cloneStep()` for a Step object shared between positions, since metadata travels
 *   with the object.
 * - `concurrency-foreach`: on a `.foreach()` entry's metadata. Its bound is `.foreach(step, {
 *   concurrency })`, which Mastra itself enforces (Layer 1).
 */
function refuseMisplacedConcurrency(entries: readonly StepFlowEntry[], adapted: readonly EntryDescription[]): void {
  const runWide =
    'To bound how many steps of the whole run are in flight at once, use the engine\'s run-wide `concurrency` ' +
    'option (`init({ concurrency })` / `new PetriExecutionEngine({ concurrency })`).';
  const shared =
    'If this Step object is also used where the key belongs, give this use its own copy with cloneStep(), ' +
    'since metadata travels with the object.';
  entries.forEach((entry, index) => {
    const enclosing = adapted[index]!;
    for (const { inner, role } of innerSteps(entry)) {
      if (!hasConcurrency(metadataOfSingle(inner))) continue;
      const where =
        entry.type === 'parallel' || entry.type === MASTRA_BRANCH_ENTRY_TYPE
          ? `A bound on this block's arms goes in its own options: \`{ metadata: { concurrency: c } }\` on the .${builderOf(entry)}() call.`
          : entry.type === 'foreach'
            ? 'A bound on this block\'s items goes in its own options: `.foreach(step, { concurrency: c })`, which Mastra enforces.'
            : `A .${builderOf(entry)}() runs its body one iteration at a time; there is no fan-out to bound.`;
      refuse(
        entry.type,
        enclosing.id,
        `concurrency-position: step '${entryId(inner)}' carries metadata.concurrency as ${role}, but the key ` +
          `bounds a block's fan-out and is read only from a .parallel() or .branch() call's own options. ${where} ` +
          `${runWide} ${shared}`,
      );
    }
    if (entry.type === 'parallel' || entry.type === MASTRA_BRANCH_ENTRY_TYPE) return;
    if (!hasConcurrency(metadataOfEntry(entry))) return;
    if (entry.type === 'foreach') {
      refuse(
        entry.type,
        enclosing.id,
        'concurrency-foreach: metadata.concurrency is on a .foreach(), whose bound is its own option: ' +
          '`.foreach(step, { concurrency: c })`, which Mastra enforces itself. Move it there.',
      );
    }
    refuse(
      entry.type,
      enclosing.id,
      `concurrency-position: metadata.concurrency is on ${positionOf(entry)}, but the key bounds a block's ` +
        "fan-out and is read only from a .parallel() or .branch() call's own options " +
        `(\`{ metadata: { concurrency: c } }\`); this entry has no arms to bound. ${runWide} ${shared}`,
    );
  });
}

/** How a refusal names a top-level entry that is not a block. */
function positionOf(entry: StepFlowEntry): string {
  switch (entry.type) {
    case 'step':
      return entry.step.component === MASTRA_WORKFLOW_COMPONENT ? 'a nested workflow step' : 'a .then() step';
    case 'agent':
      return 'an agent step';
    case 'tool':
      return 'a tool step';
    case 'mapping':
      return 'a .map()';
    default:
      return `a .${builderOf(entry)}()`;
  }
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') return `the string '${value}'`;
  if (typeof value === 'number' || typeof value === 'bigint') return `the ${typeof value} ${String(value)}`;
  if (value === null) return 'null';
  return `a value of type ${typeof value}`;
}

/**
 * Adapts the `graph` parameter `execute()` is handed.
 *
 * The `steps === undefined` check is not defensive noise: `Workflow`'s constructor builds the
 * graph one line before it assigns `stepFlow` (`workflow.ts:1798-1799`), so a workflow whose
 * author never called `.commit()` really does arrive with no steps. Coercing that to an empty
 * workflow would run it successfully and hide the mistake.
 */
export function adaptExecutionGraph(
  graph: ExecutionGraph,
  options: Omit<AdaptOptions, 'workflowId'> = {},
): WorkflowDescription {
  if (graph.steps === undefined) {
    throw new Error(
      `workflow '${graph.id}' has no step flow: it was never committed. ` +
        'Call .commit() on the workflow before running it.',
    );
  }
  return adaptStepFlow(graph.steps, { ...options, workflowId: graph.id });
}

/**
 * What one adaptation carries beside the caller's options: every quota seen so far, by id, with the
 * step that first used it — the workflow-wide `quota-id-collision` check ([ADR 0012]).
 */
interface AdaptContext {
  readonly options: AdaptOptions;
  readonly quotas: Map<string, { readonly quota: Quota; readonly stepId: string }>;
}

function adaptEntry(entry: StepFlowEntry, index: number, ctx: AdaptContext): EntryDescription {
  const { options } = ctx;
  switch (entry.type) {
    case 'step':
    case 'agent':
    case 'tool':
    case 'mapping':
      return adaptSingleStep(entry, ctx);

    case 'sleep':
      return adaptSleep(entry);

    case 'sleepUntil':
      return adaptSleepUntil(entry);

    case 'parallel': {
      // An empty list is legal: Mastra reduces over no results and continues with `{}`
      // (`handlers/control-flow.ts:220,286-295`).
      const id = entry.id ?? `parallel_${index}`;
      const concurrency = blockConcurrency(entry, id);
      const decision = blockDecision(entry, id);
      return {
        kind: 'parallel',
        id,
        arms: entry.steps.map((s) => adaptSingleStep(s, ctx)),
        ...(concurrency !== undefined ? { concurrency } : {}),
        // Absent unless race / quorum marked the block ([ADR 0014]), so a plain .parallel() describes,
        // keys the compile cache and hashes exactly as before M7b.
        ...(decision !== undefined ? { decision } : {}),
      };
    }

    case MASTRA_BRANCH_ENTRY_TYPE: {
      // `arms[j]` pairs with `conditions[j]` (`workflow.ts:2436-2454`), which is what makes an
      // index returned by the runner's branch selection mean the same arm on both sides. An empty
      // list, like an empty `.parallel()`, is a success with `{}` (`handlers/control-flow.ts:540,616-624`).
      const id = entry.id ?? `branch_${index}`;
      const concurrency = blockConcurrency(entry, id);
      return {
        kind: 'branch',
        id,
        arms: entry.steps.map((s) => adaptSingleStep(s, ctx)),
        ...(concurrency !== undefined ? { concurrency } : {}),
      };
    }

    case 'loop': {
      // Mastra keys a loop's result by the body step's id, and the entry's own id is optional
      // display metadata (`handlers/entry.ts:810-812`). Falling back to the body's id therefore
      // names the key Mastra actually writes; a named loop keeps its name, and the key is still
      // `body.id`.
      const id = entry.id ?? entryId(entry.step);
      if (entry.loopType !== 'dowhile' && entry.loopType !== 'dountil') {
        refuse(
          'loop',
          id,
          `its loopType is '${String(entry.loopType)}'; Mastra 1.67.0 has only 'dowhile' and ` +
            "'dountil', and this engine will not guess at the semantics of a newer one.",
        );
      }
      const bound = options.iterationBound;
      if (bound === undefined) {
        refuse(
          'loop',
          id,
          `a .${entry.loopType}() runs until its condition says stop and Mastra imposes no ` +
            'limit on how many times that is, but this engine requires an explicit upper ' +
            'bound. Pass `iterationBound` to choose one, knowing that a run Mastra would ' +
            'continue past it fails here instead.',
        );
      }
      if (!Number.isInteger(bound) || bound < 1 || bound > MAX_ITERATION_BOUND) {
        refuse(
          'loop',
          id,
          `iterationBound is ${String(bound)}; it must be a whole number from 1 to ` +
            `${MAX_ITERATION_BOUND}, because the body always runs once before the condition is ` +
            'first evaluated, and a larger bound is not one this engine can run.',
        );
      }
      return {
        kind: 'loop',
        id,
        body: adaptSingleStep(entry.step, ctx),
        loopType: entry.loopType,
        iterationBound: bound,
      };
    }

    case 'foreach': {
      const id = entry.id ?? entryId(entry.step);
      return {
        kind: 'foreach',
        id,
        body: adaptSingleStep(entry.step, ctx),
        concurrency: foreachConcurrency(id, entry.opts),
      };
    }

    default:
      return refuse(
        String((entry as { type?: unknown }).type),
        String((entry as { id?: unknown }).id ?? `#${index}`),
        'Mastra has gained a step flow entry type this engine does not know, so it refuses ' +
          'rather than guessing at its behaviour.',
      );
  }
}

/**
 * A plain step, a nested workflow, or one of the three declarative entries Mastra materializes
 * into a step.
 *
 * All of them funnel into Mastra's one step runner (`default.ts:1165-1213`, `handlers/entry.ts:336-343`)
 * and each is one-in / one-out, so they share one shape and differ only in `source` — which tells
 * the runner how to dispatch, never the compiler what to build.
 *
 * This is also the only thing a `.parallel()` / `.branch()` arm or a loop / `.foreach()` body can
 * be (`types.d.ts:577,583,601,619`), so anything else in that position is refused.
 */
function adaptSingleStep(entry: SingleStepEntry, ctx: AdaptContext): StepDescription {
  const { options } = ctx;
  const source = sourceOf(entry);
  const id = entryId(entry);
  const retries = effectiveRetries(entry, id, options);
  const retryDelayMs = retries > 0 ? retryDelay(entry.type, id, options) : 0;
  const { timeoutMs, quotas } = stepResources(entry, id, ctx);
  return {
    kind: 'step',
    id,
    source,
    ...(retries > 0 ? { retries } : {}),
    ...(retryDelayMs > 0 ? { retryDelayMs } : {}),
    // Both keys absent unless the petri createStep attached them, so an unannotated step describes,
    // keys the compile cache and hashes exactly as before M7.
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(quotas.length > 0 ? { quotas } : {}),
  };
}

/**
 * A step's Layer 3 resources ([ADR 0012], [ADR 0013]): the `uses` and `timeout` the petri `createStep`
 * stripped from its parameters and attached under `STEP_RESOURCES` (`resources.ts`).
 *
 * **Where they are read.** A `step` entry: on the Step object (`resourcesOf` also looks at its
 * `__agentOptions` / `__toolOptions`). An `agent` / `tool` entry: on its `options`, which is the
 * object Mastra kept as `__agentOptions` / `__toolOptions` when the petri step was passed to
 * `.then()` / `.parallel()` / … and `toSingleStepEntry` rebuilt the declarative entry from it
 * (`workflow.ts:579-593`) — the Step object itself is not in the entry. A `.map()` has none.
 *
 * **A nested workflow** passed as a step takes them as the step as a whole, as the leaf already
 * treats it: the timeout races the whole child run (whose signal cancels it, `workflow.ts:2983,3045`)
 * and a quota is held by each attempt for the child run's whole length. The child's own steps are
 * not affected — they are another run's net.
 *
 * **Refusals.** `timeout-value` and `quota-value` catch what slipped past the factories (a hand-made
 * carrier, a forged `Quota`), each with the factories' own bounds. `quota-id-collision` is
 * workflow-wide — every arm and body included — because an id names the run's one set of quota
 * places (`wf.quota.<id>`), so two different objects with one id would silently become one quota.
 * It is **this workflow's description only**: a nested workflow is adapted on its own, as its own
 * run with its own net, so the same quota object used by a parent and a child is two quotas, one
 * per run, by the per-run scope of [ADR 0012] — never a collision, and never shared.
 *
 * `uses-position` is the one route that *is* detectable for resources that never reached a net:
 * `uses` or `timeout` on an options object or step that the petri `createStep` never saw. Mastra
 * keeps an agent's or tool's options verbatim — the declarative `.agent(…, options)` /
 * `.tool(…, options)` builders push them into the entry (`workflow.ts:2012`), and Mastra's own
 * `createStep(agent | tool, options)` keeps them as `__agentOptions` / `__toolOptions`
 * (`step-factories.ts:80,119`) — so the keys are still there to see, unattached. Mastra's types
 * refuse both keys in an object literal but not in an options object built in a variable. Neither
 * key is one of Mastra's (`AgentStepOptions` has neither; `tests/mastra/adapt-resources.test.ts`
 * pins it), so their presence can only mean resources the author expected to apply. A **params**
 * step built by Mastra's own `createStep({ …, uses })` is not detectable: Mastra copies named fields
 * into a fresh object (`workflow.ts:510-531`) and the keys are gone — the brand on the petri
 * factories is the gate there ([ADR 0002]).
 */
function stepResources(
  entry: SingleStepEntry,
  id: string,
  ctx: AdaptContext,
): { readonly timeoutMs?: number; readonly quotas: readonly QuotaRef[] } {
  const carrier = carrierOf(entry);
  if (carrier === undefined) return { quotas: [] };
  const resources = resourcesOf(carrier);
  if (resources === undefined) {
    refuseUnattachedResources(entry, id, carrier);
    return { quotas: [] };
  }

  const timeoutMs: unknown = resources.timeoutMs;
  if (timeoutMs !== undefined && !(Number.isInteger(timeoutMs) && (timeoutMs as number) >= 1 && (timeoutMs as number) <= MAX_WAIT_MS)) {
    refuse(
      entry.type,
      id,
      `timeout-value: its timeout is ${describeValue(timeoutMs)}; a step timeout is a whole number of ` +
        `milliseconds from 1 to ${MAX_WAIT_MS} (~24.9 days, the longest wait a JavaScript timer accepts).`,
    );
  }

  const quotas: QuotaRef[] = [];
  const listed: unknown = resources.quotas ?? [];
  if (!Array.isArray(listed)) {
    refuse(entry.type, id, `quota-value: its uses is ${describeValue(listed)}, not a list of quotas.`);
  }
  for (const quota of listed as readonly unknown[]) {
    const ref = quotaRef(quota, entry.type, id);
    if (quotas.some((q) => q.id === ref.id)) {
      refuse(
        entry.type,
        id,
        `quota-value: its uses lists quota '${ref.id}' twice. An attempt draws one token from each quota ` +
          'it uses; list each quota once.',
      );
    }
    const seen = ctx.quotas.get(ref.id);
    if (seen === undefined) {
      ctx.quotas.set(ref.id, { quota: quota as Quota, stepId: id });
    } else if (seen.quota !== quota) {
      refuse(
        entry.type,
        id,
        `quota-id-collision: it uses a quota with id '${ref.id}', and step '${seen.stepId}' uses a different ` +
          `quota object with the same id. A quota is its object — every step listing one object shares it — ` +
          `and its id names its places in the run, so two objects with one id would silently become one ` +
          'quota. Share one object between the steps, or give each quota its own id.',
      );
    }
    quotas.push(ref);
  }
  return { ...(timeoutMs !== undefined ? { timeoutMs: timeoutMs as number } : {}), quotas };
}

/** The object a single step's resources are attached to, or `undefined` for a `.map()`. */
function carrierOf(entry: SingleStepEntry): object | undefined {
  switch (entry.type) {
    case 'step':
      return entry.step;
    case 'agent':
    case 'tool':
      return entry.options;
    default:
      return undefined;
  }
}

/** A quota as the compiler sees it, refusing anything the petri factories would not have minted. */
function quotaRef(quota: unknown, type: string, id: string): QuotaRef {
  if (!(quota instanceof Quota)) {
    return refuse(
      type,
      id,
      `quota-value: its uses holds ${describeValue(quota)}, which is not a quota made by init().limit or ` +
        'init().rateLimit.',
    );
  }
  const ref: unknown = quota.ref;
  const r = (ref ?? {}) as { id?: unknown; kind?: unknown; n?: unknown; burst?: unknown; perMs?: unknown };
  const whole = (v: unknown, max: number) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max;
  const name = typeof r.id === 'string' ? `'${r.id}'` : describeValue(r.id);
  if (typeof r.id !== 'string' || !QUOTA_ID_PATTERN.test(r.id)) {
    refuse(type, id, `quota-value: a quota's id is ${name}; it must match [A-Za-z0-9_-]+, since it names the quota's places.`);
  }
  if (r.kind === 'limit') {
    if (!whole(r.n, MAX_CONCURRENCY)) {
      refuse(type, id, `quota-value: limit ${name} allows ${describeValue(r.n)}; it must be a whole number from 1 to ${MAX_CONCURRENCY}.`);
    }
    return { id: r.id as string, kind: 'limit', n: r.n as number };
  }
  if (r.kind === 'rate') {
    if (!whole(r.burst, MAX_CONCURRENCY)) {
      refuse(type, id, `quota-value: rateLimit ${name} has a burst of ${describeValue(r.burst)}; it must be a whole number from 1 to ${MAX_CONCURRENCY}.`);
    }
    if (!whole(r.perMs, MAX_WAIT_MS)) {
      refuse(
        type,
        id,
        `quota-value: rateLimit ${name} refills every ${describeValue(r.perMs)} ms; it must be a whole number ` +
          `of milliseconds from 1 to ${MAX_WAIT_MS}.`,
      );
    }
    return { id: r.id as string, kind: 'rate', burst: r.burst as number, perMs: r.perMs as number };
  }
  return refuse(type, id, `quota-value: quota ${name} is of kind ${describeValue(r.kind)}, neither 'limit' nor 'rate'.`);
}

/**
 * `uses-position`: `uses` or `timeout` on a carrier the petri `createStep` never attached resources to.
 * Only a plain object is looked at — an options object, or a step Mastra's own factories built — as
 * `init.ts`'s `asksForResources` does; an empty `uses` asks for nothing there, so not here either.
 */
function refuseUnattachedResources(entry: SingleStepEntry, id: string, carrier: object): void {
  const proto: unknown = Object.getPrototypeOf(carrier);
  if (proto !== Object.prototype && proto !== null) return;
  const { uses, timeout } = carrier as { uses?: unknown; timeout?: unknown };
  const asks = [
    ...((Array.isArray(uses) ? uses.length > 0 : uses !== undefined) ? ['`uses`'] : []),
    ...(timeout !== undefined ? ['`timeout`'] : []),
  ];
  if (asks.length === 0) return;
  const what = entry.type === 'step' ? 'step' : `${entry.type}'s options`;
  refuse(
    entry.type,
    id,
    `uses-position: this ${what} carries ${asks.join(' and ')}, but they never passed through the petri ` +
      'createStep, so nothing attached them and the step would run without them. Mastra passes the options ' +
      'of a declarative .agent() / .tool() entry, and of its own createStep(agent | tool, options), through ' +
      `unread. Build the step with init().createStep(${entry.type === 'tool' ? 'tool' : entry.type === 'agent' ? 'agent' : '…'}, ` +
      '{ uses, timeout }) and add that step with .then(), .parallel() or .branch().',
  );
}

function sourceOf(entry: SingleStepEntry): StepSource {
  switch (entry.type) {
    case 'step':
      // `Workflow implements Step`, so a nested workflow arrives as a plain `step` entry and is
      // told apart only by its component (`step-entry.ts:61-70`).
      return entry.step.component === MASTRA_WORKFLOW_COMPONENT ? 'workflow' : 'step';
    case 'agent':
      return 'agent';
    case 'tool':
      return 'tool';
    case 'mapping':
      return 'mapping';
    default: {
      const stray = entry as { type?: unknown; id?: unknown };
      return refuse(
        String(stray.type),
        String(stray.id ?? '?'),
        'only a single step can be a .parallel() or .branch() arm or a loop or .foreach() body ' +
          '— Mastra types all four as a single step. To nest control flow, nest a workflow.',
      );
    }
  }
}

/**
 * The retry count Mastra uses for this entry: its own, else the workflow's, else none.
 *
 * `step.retries ?? retryConfig.attempts ?? 0` (`handlers/step.ts:314`), where `??` means an
 * explicit `0` on the entry beats a workflow-level `attempts`. An `agent` or `tool` entry's own
 * count is `options.retries` — `getEntryRetries` (`step-entry.ts:35-45`), and the step Mastra
 * materializes from it carries the same value (`step-factories.ts:52,69,108`). A `.map()` never
 * has its own, so it always takes the workflow's (`step-factories.ts:130-141`). A nested workflow
 * has no `retries` of its own either, so it does too.
 */
function effectiveRetries(entry: SingleStepEntry, id: string, options: AdaptOptions): number {
  const own = ownRetries(entry);
  const workflow = options.retryConfig?.attempts;
  const retries = own ?? workflow ?? 0;
  if (!Number.isSafeInteger(retries) || retries < 0) {
    const from = own != null ? 'its own retries' : 'the workflow retryConfig.attempts';
    refuse(
      entry.type,
      id,
      `its retry count (${String(retries)}, from ${from}) ` +
        'is not a whole number of at least 0. Mastra counts attempts with `i < retries + 1` and ' +
        'stops at `i === retries`, so a count of -1 or below, or NaN, never runs the step at all; ' +
        "any other count that is not whole reports 'Unknown error' instead of the step's own " +
        'error once its attempts run out; and an infinite one never stops retrying. There is no ' +
        'behaviour there to reproduce.',
    );
  }
  if (retries > MAX_RETRIES) {
    const from = own != null ? 'its own retries' : 'the workflow retryConfig.attempts';
    refuse(
      entry.type,
      id,
      `its retry count is ${retries} (from ${from}), above the ${MAX_RETRIES} this engine ` +
        'supports for one step. Mastra has no such limit.',
    );
  }
  return retries;
}

function ownRetries(entry: SingleStepEntry): number | undefined {
  switch (entry.type) {
    case 'step':
      return entry.step.retries;
    case 'agent':
    case 'tool':
      return entry.options?.retries;
    case 'mapping':
      return undefined;
  }
}

/**
 * The wait between attempts, for a step that retries.
 *
 * Mastra waits with `if (i > 0 && params.delay) await setTimeout(…, params.delay)`
 * (`default.ts:456-457`) — so an absent, zero or `NaN` delay waits nothing. A negative one waits
 * a single timer tick, which this engine treats as nothing, as it does a zero `.sleep()`. Above
 * Node's timer ceiling `setTimeout` wakes after ~1ms instead, the same defect as a long
 * `.sleep()`, so that is refused.
 */
function retryDelay(type: string, id: string, options: AdaptOptions): number {
  const delay = options.retryConfig?.delay;
  if (delay != null && typeof delay !== 'number') {
    refuse(type, id, `the workflow retryConfig.delay is ${typeof delay}, not a number of milliseconds.`);
  }
  const ms = !delay || delay < 0 ? 0 : delay;
  if (ms > MAX_WAIT_MS) {
    refuse(
      type,
      id,
      `it retries after the workflow retryConfig.delay of ${String(ms)}ms, beyond the ` +
        `${MAX_WAIT_MS}ms (~24.9 day) maximum a JavaScript timer accepts. Mastra passes it ` +
        'straight to setTimeout, which retries after about a millisecond instead of waiting; ' +
        'this engine would wait the full time, so the two disagree completely.',
    );
  }
  return ms;
}

/** A wait the runner resolves per run, from the previous step's output. */
const PER_RUN: BuildOrRun<number> = { perRun: true };

/**
 * `.sleep(ms)` or `.sleep(fn)`.
 *
 * A function wins over a duration, as `if (fn)` does in Mastra (`handlers/sleep.ts:83`); the
 * builder never stores both (`workflow.ts:2096-2099`). A literal is normalised with Mastra's own
 * expression, `!duration || duration < 0 ? 0 : duration` (`handlers/sleep.ts:132`), so an
 * absent, zero, `NaN` or negative duration is a sleep of nothing.
 */
function adaptSleep(entry: Extract<StepFlowEntry, { type: 'sleep' }>): EntryDescription {
  if (entry.fn) return { kind: 'sleep', id: entry.id, duration: PER_RUN };

  const duration: unknown = entry.duration;
  if (duration != null && typeof duration !== 'number') {
    refuse('sleep', entry.id, `its duration is ${typeof duration}, not a number of milliseconds.`);
  }
  const ms = !duration || duration < 0 ? 0 : duration;
  if (ms > MAX_WAIT_MS) {
    refuse(
      'sleep',
      entry.id,
      `its duration is ${String(ms)}ms, beyond the ${MAX_WAIT_MS}ms (~24.9 day) ` +
        'maximum a JavaScript timer accepts. Mastra passes it straight to setTimeout, which ' +
        'wakes after about a millisecond instead of waiting; this engine would wait the full ' +
        'time, so the two disagree completely. Split the wait, or suspend the run instead.',
    );
  }
  return { kind: 'sleep', id: entry.id, duration: { fixed: ms } };
}

/**
 * `.sleepUntil(date)` or `.sleepUntil(fn)`.
 *
 * No date at all is an unconditional no-op in Mastra — it returns before waiting and the entry
 * still succeeds (`handlers/sleep.ts:267-273`). Any instant already past has the same effect,
 * since Mastra waits `max(0, date - now)` (`default.ts:151-158`, `utils.ts:230-251`), so both it
 * and a date before 1970 become epoch 0: the same past instant on every compile.
 */
function adaptSleepUntil(entry: Extract<StepFlowEntry, { type: 'sleepUntil' }>): EntryDescription {
  if (entry.fn) return { kind: 'sleepUntil', id: entry.id, until: PER_RUN };

  const date: unknown = entry.date;
  if (!date) return { kind: 'sleepUntil', id: entry.id, until: { fixed: 0 } };
  if (Object.prototype.toString.call(date) !== '[object Date]') {
    refuse('sleepUntil', entry.id, `its date is ${typeof date}, not a Date.`);
  }
  const epochMs = (date as Date).getTime();
  if (Number.isNaN(epochMs)) {
    refuse(
      'sleepUntil',
      entry.id,
      'it was given an invalid Date. Mastra rejects the run when it reaches this sleep — ' +
        '`date.toISOString()` throws a RangeError while naming its span ' +
        '(`handlers/sleep.ts:206`) — so there is no wait to reproduce.',
    );
  }
  return { kind: 'sleepUntil', id: entry.id, until: { fixed: Math.max(0, epochMs) } };
}

/**
 * `.foreach()`'s concurrency, clamped exactly as Mastra clamps it: `opts?.concurrency ?? 1`, then
 * anything that is not a finite number of at least 1 becomes 1, otherwise it is floored
 * (`resolveForeachConcurrency`, `utils.ts:786-796`).
 *
 * A resolver function is Mastra's per-run form (`types.d.ts:623-644`, called at
 * `handlers/control-flow.ts:983-986`) and stays refused: the number of items in flight is fixed
 * when the workflow is compiled, and one compiled workflow serves every run.
 */
function foreachConcurrency(id: string, opts: { readonly concurrency?: unknown } | undefined): number {
  const configured = opts?.concurrency ?? 1;
  if (typeof configured === 'function') {
    refuse(
      'foreach',
      id,
      'its concurrency is resolved per run from the input array, but this engine fixes ' +
        'concurrency once, when the workflow is compiled, and reuses that compiled form ' +
        'across runs. Pass a number instead.',
    );
  }
  const lanes =
    typeof configured !== 'number' || !Number.isFinite(configured) || configured < 1
      ? 1
      : Math.floor(configured);
  if (lanes > MAX_FOREACH_LANES) {
    refuse(
      'foreach',
      id,
      `its concurrency is ${lanes}, above the ${MAX_FOREACH_LANES} items in flight this engine ` +
        'supports. Mastra has no such limit.',
    );
  }
  return lanes;
}

/**
 * A `.parallel()` entry's counted decision ([ADR 0014]), read from its `metadata` under
 * `BLOCK_DECISION`; `undefined` when it carries none, so an unannotated block describes, keys the
 * compile cache and hashes exactly as before M7b. Refuses `blueprint-arms`, `race-empty` and
 * `quorum-value` by name.
 *
 * **Matching an entry arm to its minted arm.** The decision keeps the Step objects `race` / `quorum`
 * were given, in order. Mastra's `.parallel()` maps each through `toSingleStepEntry`
 * (`workflow.ts:579-592`), which keeps the Step object only for a plain step: a step built by
 * `createStep(agent | tool, options)` becomes a declarative `{ type: 'agent' | 'tool', id, agent |
 * tool: __agentRef | __toolRef, options: __agentOptions | __toolOptions }` and the Step object is
 * gone. So arm `i` of the entry matches minted arm `i` by its kind:
 *
 * - `{ type: 'step', step }` — `step === minted[i]`.
 * - `{ type: 'agent', id, agent, options }` — `minted[i].component === 'AGENT'`, `id ===
 *   minted[i].id`, `agent === minted[i].__agentRef` and `options === minted[i].__agentOptions`, each
 *   by identity (`options` may be `undefined` on both: `createStep(agent)` with no options).
 * - `{ type: 'tool', id, tool, options }` — the same with `'TOOL'`, `__toolRef`, `__toolOptions`.
 * - anything else — `blueprint-arms`. A nested workflow passed as an arm is `{ type: 'step' }` and
 *   matches by identity, as a plain step does.
 *
 * The options object is the carrier [ADR 0012] already relies on (`STEP_RESOURCES` rides on
 * `__agentOptions` / `__toolOptions`, `resourcesOf`), so its identity is as stable here as there.
 * Two `createStep(agent)` of one agent with no options are one id, which `race` / `quorum` already
 * refuse as `blueprint-arms` (an arm twice, by id). Pinned by `tests/mastra/adapt-decision.test.ts`,
 * "agent and tool arms match by ref and options identity" (and its negative: an equal but distinct
 * options object is `blueprint-arms`).
 *
 * @internal Exported for the tests.
 */
export function blockDecision(entry: StepFlowEntry, id: string): BlockDecision | undefined {
  const value = decisionOf(metadataOfEntry(entry));
  if (value === undefined) return undefined;
  const type = entry.type;
  if (!(value instanceof Decision) || !Array.isArray(value.arms)) {
    refuse(
      type,
      id,
      'blueprint-arms: this block\'s metadata carries a decision that init().race or init().quorum did not ' +
        'make. Build the block with `.parallel(...race(arms, options))` or `.parallel(...quorum(k, arms, options))`.',
    );
  }
  const minted: readonly unknown[] = value.arms;
  const n = minted.length;
  if (n === 0) {
    refuse(type, id, 'race-empty: the decision is over no arms; a block of none has nothing to decide.');
  }
  const k: unknown = value.k;
  if (typeof k !== 'number' || !Number.isInteger(k) || k < 1 || k > n) {
    refuse(type, id, `quorum-value: the decision's k is ${describeValue(k)}; it must be a whole number in [1, ${n}] (the arm count).`);
  }
  const steps = entry.type === 'parallel' ? entry.steps : [];
  const fix =
    `Spread the very result of race / quorum into this .parallel() — \`.parallel(...${value.kind}(...))\` — ` +
    'without changing its arms.';
  if (steps.length !== n) {
    refuse(type, id, `blueprint-arms: the block has ${steps.length} arm(s), but its decision was made over ${n}. ${fix}`);
  }
  const ids = new Set<string>();
  steps.forEach((arm, i) => {
    if (!armMatches(arm, minted[i])) {
      refuse(
        type,
        id,
        `blueprint-arms: arm ${i} ('${entryId(arm)}') is not the step the decision was made with at that position. ${fix}`,
      );
    }
    const armId = entryId(arm);
    if (ids.has(armId)) {
      refuse(type, id, `blueprint-arms: two arms have the id '${armId}'; a decision counts each arm once, by id.`);
    }
    ids.add(armId);
  });
  return { k: k as number };
}

/**
 * Whether entry arm `arm` is minted arm `minted`, by its kind (see {@link blockDecision}): a plain
 * step or nested workflow by identity; an agent or tool by its id, and its ref and options object by
 * identity, since Mastra's `toSingleStepEntry` keeps those and not the Step object.
 */
function armMatches(arm: SingleStepEntry, minted: unknown): boolean {
  if (minted === null || (typeof minted !== 'object' && typeof minted !== 'function')) return false;
  const m = minted as {
    readonly id?: unknown;
    readonly component?: unknown;
    readonly __agentRef?: unknown;
    readonly __agentOptions?: unknown;
    readonly __toolRef?: unknown;
    readonly __toolOptions?: unknown;
  };
  switch (arm.type) {
    case 'step':
      return arm.step === minted;
    case 'agent':
      return m.component === 'AGENT' && m.__agentRef !== undefined && arm.id === m.id && arm.agent === m.__agentRef && arm.options === m.__agentOptions;
    case 'tool':
      return m.component === 'TOOL' && m.__toolRef !== undefined && arm.id === m.id && arm.tool === m.__toolRef && arm.options === m.__toolOptions;
    default:
      return false;
  }
}

/**
 * `blueprint-position` ([ADR 0014]): a decision marker on any entry but a `.parallel()` call's own
 * options — including an arm's or a body's own `metadata`. And `blueprint-reused`: one minted
 * `Decision` on more than one `.parallel()` of `entries`. Workflow-wide, as
 * `refuseMisplacedConcurrency` is.
 *
 * Identity is the value under the key, so a spread copy of the metadata (which carries the same
 * `Decision`) is caught as well as the same options object passed twice.
 *
 * @internal Exported for the tests.
 */
export function refuseMisplacedDecision(entries: readonly StepFlowEntry[]): void {
  const fix =
    'A decision marks a .parallel() call\'s own options only: `.parallel(...race(arms, options))` or ' +
    '`.parallel(...quorum(k, arms, options))`.';
  const seen = new Map<unknown, string>();
  entries.forEach((entry, index) => {
    const id = topLevelId(entry, index);
    for (const { inner, role } of innerSteps(entry)) {
      if (decisionOf(metadataOfSingle(inner)) === undefined) continue;
      refuse(
        entry.type,
        id,
        `blueprint-position: step '${entryId(inner)}' carries a race / quorum decision in its own metadata as ${role}. ${fix}`,
      );
    }
    const decision = decisionOf(metadataOfEntry(entry));
    if (decision === undefined) return;
    if (entry.type !== 'parallel') {
      refuse(entry.type, id, `blueprint-position: a race / quorum decision is on ${positionOf(entry)}. ${fix}`);
    }
    const first = seen.get(decision);
    if (first !== undefined) {
      refuse(
        entry.type,
        id,
        `blueprint-reused: this block carries the same race / quorum decision as block '${first}'. A decision ` +
          'decides one block; call race / quorum again for each .parallel().',
      );
    }
    seen.set(decision, id);
  });
}

/** A top-level entry's id, as `adaptEntry` names it. */
function topLevelId(entry: StepFlowEntry, index: number): string {
  switch (entry.type) {
    case 'step':
    case 'agent':
    case 'tool':
    case 'mapping':
      return entryId(entry);
    case 'parallel':
      return entry.id ?? `parallel_${index}`;
    case MASTRA_BRANCH_ENTRY_TYPE:
      return entry.id ?? `branch_${index}`;
    case 'loop':
    case 'foreach':
      return entry.id ?? entryId(entry.step);
    default:
      return String((entry as { id?: unknown }).id ?? `#${index}`);
  }
}

/** Every refusal reads the same way: which entry, which Mastra type, and why. */
function refuse(type: string, id: string, why: string): never {
  throw new UnsupportedWorkflowError(type, id, why);
}

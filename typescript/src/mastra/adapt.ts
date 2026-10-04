import { MAX_FOREACH_LANES, MAX_ITERATION_BOUND, MAX_RETRIES, MAX_WAIT_MS } from '../compiler/index.js';
import type {
  BuildOrRun,
  EntryDescription,
  StepDescription,
  StepSource,
  WorkflowDescription,
} from '../compiler/types.js';
import { entryId, type ExecutionGraph, type SingleStepEntry, type StepFlowEntry } from './host.js';

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
  const adapted = entries.map((entry, index) => adaptEntry(entry, index, options));
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

function adaptEntry(entry: StepFlowEntry, index: number, options: AdaptOptions): EntryDescription {
  switch (entry.type) {
    case 'step':
    case 'agent':
    case 'tool':
    case 'mapping':
      return adaptSingleStep(entry, options);

    case 'sleep':
      return adaptSleep(entry);

    case 'sleepUntil':
      return adaptSleepUntil(entry);

    case 'parallel':
      // An empty list is legal: Mastra reduces over no results and continues with `{}`
      // (`handlers/control-flow.ts:220,286-295`).
      return {
        kind: 'parallel',
        id: entry.id ?? `parallel_${index}`,
        arms: entry.steps.map((s) => adaptSingleStep(s, options)),
      };

    case MASTRA_BRANCH_ENTRY_TYPE:
      // `arms[j]` pairs with `conditions[j]` (`workflow.ts:2436-2454`), which is what makes an
      // index returned by the runner's branch selection mean the same arm on both sides. An empty
      // list, like an empty `.parallel()`, is a success with `{}` (`handlers/control-flow.ts:540,616-624`).
      return {
        kind: 'branch',
        id: entry.id ?? `branch_${index}`,
        arms: entry.steps.map((s) => adaptSingleStep(s, options)),
      };

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
        body: adaptSingleStep(entry.step, options),
        loopType: entry.loopType,
        iterationBound: bound,
      };
    }

    case 'foreach': {
      const id = entry.id ?? entryId(entry.step);
      return {
        kind: 'foreach',
        id,
        body: adaptSingleStep(entry.step, options),
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
function adaptSingleStep(entry: SingleStepEntry, options: AdaptOptions): StepDescription {
  const source = sourceOf(entry);
  const id = entryId(entry);
  const retries = effectiveRetries(entry, id, options);
  const retryDelayMs = retries > 0 ? retryDelay(entry.type, id, options) : 0;
  return {
    kind: 'step',
    id,
    source,
    ...(retries > 0 ? { retries } : {}),
    ...(retryDelayMs > 0 ? { retryDelayMs } : {}),
  };
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

/** Every refusal reads the same way: which entry, which Mastra type, and why. */
function refuse(type: string, id: string, why: string): never {
  throw new UnsupportedWorkflowError(type, id, why);
}

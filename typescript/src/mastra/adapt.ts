import type { EntryDescription, WorkflowDescription } from '../compiler/types.js';
import { entryId, type ExecutionGraph, type SingleStepEntry, type StepFlowEntry } from './host.js';

/**
 * Mastra's tag for `.branch()`. There is no `'branch'` entry type in `StepFlowEntry`; the
 * compiler's kind is `branch` and Mastra's tag is `conditional`, so the two vocabularies meet
 * here and nowhere else.
 */
export const MASTRA_BRANCH_ENTRY_TYPE = 'conditional';

/**
 * Node's maximum `setTimeout` delay. Mastra sleeps with a bare `setTimeout`
 * (`utils.ts:230-251`), so anything above this fires after ~1ms instead of waiting.
 */
const MAX_TIMER_MS = 2_147_483_647;

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
   * Mastra's workflow-level retry config, as `execute()` receives it. `attempts` is a retry
   * count, so `attempts: 2` means up to three executions (`default.ts:455`).
   */
  readonly retryConfig?: { readonly attempts?: number; readonly delay?: number };
}

/**
 * Adapts a committed workflow's `stepFlow` into the compiler's structural description.
 *
 * `buildExecutionGraph()` is a pure pass-through — `{ id: this.id, steps: this.stepFlow }`,
 * with no normalization and no rewriting (`workflow.ts:2661-2666`) — so what arrives here is
 * verbatim what the builder pushed. Every default Mastra applies has already been applied by
 * the builder (`.foreach()`'s `concurrency: 1` at `workflow.ts:2636`), and this function does
 * not re-apply any of them.
 *
 * **Refusals are the point.** Where Mastra can express something the compiler's
 * `EntryDescription` cannot, this throws an error naming the entry, its type and the reason,
 * rather than dropping the behaviour. Each refusal is recorded in `docs/divergences.md`.
 */
export function adaptStepFlow(
  entries: readonly StepFlowEntry[],
  options: AdaptOptions,
): WorkflowDescription {
  return {
    id: options.workflowId,
    entries: entries.map((entry, index) => adaptEntry(entry, index, options)),
  };
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

    case 'parallel': {
      const id = entry.id ?? `parallel_${index}`;
      if (entry.steps.length === 0) {
        refuse('parallel', id, emptyBlockReason('.parallel([])'));
      }
      return { kind: 'parallel', id, arms: entry.steps.map((s) => adaptSingleStep(s, options)) };
    }

    case MASTRA_BRANCH_ENTRY_TYPE: {
      const id = entry.id ?? `branch_${index}`;
      if (entry.steps.length === 0) {
        refuse('conditional', id, emptyBlockReason('.branch([])'));
      }
      return { kind: 'branch', id, arms: entry.steps.map((s) => adaptSingleStep(s, options)) };
    }

    case 'loop': {
      // Mastra keys a loop's step result by the inner step's id, and the entry's own id is
      // optional display metadata (`handlers/entry.ts:810-812`). Falling back to the step id
      // therefore names the key Mastra actually writes.
      const id = entry.id ?? entryId(entry.step);
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
      if (!Number.isInteger(bound) || bound < 1) {
        refuse(
          'loop',
          id,
          `iterationBound is ${String(bound)}; it must be a whole number of at least 1, ` +
            'because the body always runs once before the condition is first evaluated.',
        );
      }
      return {
        kind: 'loop',
        id,
        loopType: entry.loopType,
        maxIterations: bound,
        body: adaptSingleStep(entry.step, options),
      };
    }

    case 'foreach': {
      const id = entry.id ?? entryId(entry.step);
      const configured = entry.opts.concurrency;
      if (typeof configured === 'function') {
        refuse(
          'foreach',
          id,
          'its concurrency is resolved per run from the input array, but this engine fixes ' +
            'concurrency once, when the workflow is compiled, and reuses that compiled form ' +
            'across runs. Pass a number instead.',
        );
      }
      // Mastra's own clamp: anything that is not a finite number of at least 1 becomes 1,
      // otherwise it is floored (`utils.ts:791-795`). Reproduced rather than re-invented.
      const concurrency =
        typeof configured !== 'number' || !Number.isFinite(configured) || configured < 1
          ? 1
          : Math.floor(configured);
      return { kind: 'foreach', id, concurrency, body: adaptSingleStep(entry.step, options) };
    }

    default:
      throw new Error(
        `cannot adapt Mastra entry of unknown type '${String((entry as { type: string }).type)}'. ` +
          'Mastra has gained a step flow entry this engine does not model; refusing rather ' +
          'than guessing at its behaviour.',
      );
  }
}

/**
 * A plain step, or one of the three declarative entries Mastra materializes into a step.
 *
 * `agent`, `tool` and `mapping` all funnel into the same runner as a plain step
 * (`handlers/entry.ts:336-343`) and are each one-in / one-out, so they need no shape of their
 * own — only a way for the host to tell them apart when it runs one. `EntryDescription` has no
 * field for that yet, so they are adapted to a plain step keyed by Mastra's own `getEntryId`
 * rule and the host resolves the kind from the entry id. `mapping` is the exception: it reads
 * data a step delegate cannot currently be handed, so it is refused.
 */
function adaptSingleStep(entry: SingleStepEntry, options: AdaptOptions): EntryDescription {
  const id = entryId(entry);

  switch (entry.type) {
    case 'step':
      assertNoRetries('step', id, entry.step.retries, options);
      return { kind: 'step', id };

    case 'agent':
      assertNoRetries('agent', id, entry.options?.retries, options);
      return { kind: 'step', id };

    case 'tool':
      assertNoRetries('tool', id, entry.options?.retries, options);
      return { kind: 'step', id };

    case 'mapping':
      return refuse(
        'mapping',
        id,
        'a .map() entry reads any earlier step\'s result and the workflow input, but a step ' +
          'delegate in this engine is handed only the previous entry\'s output, so the mapping ' +
          'would silently see the wrong data.',
      );
  }
}

/**
 * Refuses a step whose retries would change what a run does.
 *
 * Mastra resolves retries with `??`, so an explicit `0` on the entry beats a workflow-level
 * `attempts` (`handlers/step.ts:314`), and `attempts` is a *retry* count — `attempts: 2` runs
 * the step up to three times (`default.ts:455`). Anything above zero is a behaviour this
 * engine does not reproduce, so it is refused rather than dropped.
 */
function assertNoRetries(
  type: string,
  id: string,
  entryRetries: number | undefined,
  options: AdaptOptions,
): void {
  const retries = entryRetries ?? options.retryConfig?.attempts ?? 0;
  if (retries > 0) {
    refuse(
      type,
      id,
      `it is configured for ${retries} ${retries === 1 ? 'retry' : 'retries'}, so Mastra would ` +
        `run it up to ${retries + 1} times; this engine runs it once and would report the ` +
        'first failure as final.',
    );
  }
}

function adaptSleep(entry: Extract<StepFlowEntry, { type: 'sleep' }>): EntryDescription {
  if (entry.fn !== undefined) {
    refuse(
      'sleep',
      entry.id,
      'its duration is computed per run by a function, but this engine resolves a sleep once, ' +
        'when the workflow is compiled, and reuses that compiled form across runs — so one ' +
        "run's duration would be applied to every other run.",
    );
  }
  return { kind: 'sleep', id: entry.id, durationMs: sleepDurationMs(entry.id, entry.duration) };
}

/**
 * Mastra's effective sleep duration.
 *
 * `executeSleep` passes `!duration || duration < 0 ? 0 : duration` (`handlers/sleep.ts:131-136`),
 * so an absent, zero, `NaN` or negative duration is a sleep of nothing — reproduced here.
 * Above Node's timer ceiling Mastra does *not* wait either, but for a different and unhelpful
 * reason, so that case is refused instead of reproduced.
 */
function sleepDurationMs(id: string, duration: number | undefined): number {
  if (duration === undefined || Number.isNaN(duration) || duration <= 0) return 0;
  if (duration > MAX_TIMER_MS) {
    refuse(
      'sleep',
      id,
      `its duration is ${String(duration)}ms, beyond the ${MAX_TIMER_MS}ms (~24.9 day) ` +
        'maximum a JavaScript timer accepts. Mastra passes it straight to setTimeout, which ' +
        'wakes after about a millisecond instead of waiting; this engine would wait the full ' +
        'time, so the two disagree completely. Split the wait, or suspend the run instead.',
    );
  }
  return duration;
}

function adaptSleepUntil(entry: Extract<StepFlowEntry, { type: 'sleepUntil' }>): EntryDescription {
  if (entry.fn !== undefined) {
    refuse(
      'sleepUntil',
      entry.id,
      'its wake-up time is computed per run by a function, but this engine resolves it once, ' +
        'when the workflow is compiled, and reuses that compiled form across runs.',
    );
  }
  // No date at all is an unconditional no-op in Mastra — it returns before waiting and the
  // entry still records success (`handlers/sleep.ts:267-273`). An instant already past has the
  // same effect here, and epoch 0 is the one such instant that is the same on every compile.
  if (entry.date === undefined) return { kind: 'sleepUntil', id: entry.id, atEpochMs: 0 };

  const atEpochMs = entry.date.getTime();
  if (Number.isNaN(atEpochMs)) {
    refuse(
      'sleepUntil',
      entry.id,
      'it was given an invalid Date. Mastra treats that as a wait of about a millisecond ' +
        'rather than an error, which is almost certainly not what the workflow meant.',
    );
  }
  return { kind: 'sleepUntil', id: entry.id, atEpochMs };
}

function emptyBlockReason(call: string): string {
  return (
    `it has no branches. Mastra runs an empty ${call} and carries on with an empty result, ` +
    'but this engine has no form for a block that starts nothing and waits for nothing. ' +
    'Remove the empty block, or guard the call that produced it.'
  );
}

/** Every refusal reads the same way: which entry, which Mastra type, and why. */
function refuse(type: string, id: string, why: string): never {
  throw new Error(`cannot adapt Mastra '${type}' entry '${id}': ${why}`);
}

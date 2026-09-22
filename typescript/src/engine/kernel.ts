import {
  PrecompiledNetExecutor,
  tokenOf,
  seedToken,
  type Clock,
  type Marking,
  type Place,
} from 'libpetri';
import { RUN_SCOPE_KEY } from '../compiler/scope.js';
import type {
  BailToken,
  CompiledWorkflow,
  FailureToken,
  FlowToken,
  PauseToken,
  StepOutcome,
  StepRunner,
  SuspendToken,
} from '../compiler/types.js';
import type { EntryPath } from '../compiler/names.js';
import { KernelRunScope } from './scope.js';

/** Present only when non-empty — see {@link RunOutcome}. */
type Residue = { readonly residue?: readonly string[] };

/**
 * How a run ended, read from the terminal marking rather than from a return value — in Mastra's
 * run-status vocabulary.
 *
 * A bailed run is a `success` carrying `bailed: true`: Mastra rewrites `bailed` to `success` at
 * the top level (`default.ts:926-928`), and so do we, but a caller can still tell the two apart.
 * A failure carrying a `tripwire` is `tripwire`, as `fmtReturnValue` reclassifies it.
 *
 * `residue` names any place still holding a token at quiescence other than the one terminal
 * reported, and is **present only when it is non-empty**. A clean run has no `residue` key, so an
 * existing `toEqual({status, output})` assertion keeps passing — and starts failing the moment a
 * leak appears. A test does not have to opt in to catching one. A second marked terminal is
 * residue too: every entry ends in exactly one outcome, so two means the model is wrong.
 */
export type RunOutcome =
  | ({ readonly status: 'success'; readonly output: unknown; readonly bailed?: true } & Residue)
  | ({ readonly status: 'failed'; readonly stepId: string; readonly error: unknown } & Residue)
  | ({ readonly status: 'tripwire'; readonly stepId: string; readonly tripwire: unknown } & Residue)
  | ({ readonly status: 'suspended'; readonly stepId: string; readonly path: EntryPath; readonly payload: unknown } & Residue)
  | ({ readonly status: 'paused'; readonly stepId: string; readonly path: EntryPath } & Residue)
  | { readonly status: 'stranded'; readonly places: readonly string[] };

export interface RunOptions {
  /** Runs the steps. Supplied per run: a compiled net holds no runner. */
  readonly runner: StepRunner;
  /**
   * Per-executor clock ([TIME-015]). Supply one to make a timed run deterministic; two executors
   * in one process take independent clocks, which is what the differential harness needs and
   * what `vi.useFakeTimers` cannot express. `deadlineToleranceMs` is set to 0 alongside it — the
   * 5ms default absorbs real timer jitter and under a virtual clock would mask the very
   * behaviour being observed.
   */
  readonly clock?: Clock;
  /**
   * Wall-clock budget for the whole run — a harness safety net, not a workflow outcome. Mastra
   * has no run timeout, so there is no status to classify it as: when it expires the executor is
   * closed and `runWorkflow` **rejects**. It also cannot pre-empt a run that never yields to the
   * macrotask queue — a chain of zero-delay firings whose actions resolve as microtasks starves
   * the timer until the chain stops by itself. That is executor behaviour, not something this
   * file can bound.
   */
  readonly timeoutMs?: number;
  /** Step results carried in from an earlier segment. Each must be a recognised outcome. */
  readonly stepResults?: ReadonlyMap<string, StepOutcome>;
}

export interface RunReport {
  readonly outcome: RunOutcome;
  /** Every step's latest outcome, keyed by step id — Mastra's `stepResults`. */
  readonly stepResults: ReadonlyMap<string, StepOutcome>;
}

/**
 * Runs a compiled workflow to quiescence and classifies the terminal marking.
 *
 * **The net decides what runs.** There is no loop here — the kernel seeds the entry place, hands
 * the net to libpetri and reads the result. Ordering comes from the topology ([EXEC-002]), never
 * from this file.
 *
 * **The run scope travels with the firing**, through `executionContextProvider`: every action
 * reads its runner and the run's step results from it, so one compiled net serves every run.
 *
 * **Quiescence, not environment places.** No environment place is registered on this path, so
 * the executor terminates at quiescence ([ENV-010]) rather than requiring `drain()`.
 *
 * **Cancellation is `close()`, never `run(timeoutMs)` alone.** The default timeout policy is
 * `'abandon'`: it rejects while the loop keeps firing and mutating the marking. `'close'` is the
 * only policy that actually stops.
 */
export async function runWorkflowDetailed(
  compiled: CompiledWorkflow,
  input: unknown,
  options: RunOptions,
): Promise<RunReport> {
  if (options.stepResults) assertStepResults(options.stepResults);
  const scope = new KernelRunScope({
    runner: options.runner,
    initData: input,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.stepResults ? { stepResults: options.stepResults } : {}),
  });

  // A marking is built before any executor exists, so the ordinary constructor stamps wall time
  // and would differ on every replay — inside the marking. Seed through the clock.
  const seed = options.clock
    ? seedToken<FlowToken>(options.clock, { data: input })
    : tokenOf<FlowToken>({ data: input });

  const context = new Map<string, unknown>([[RUN_SCOPE_KEY, scope]]);
  const executor = new PrecompiledNetExecutor(compiled.net, new Map([[compiled.entryPlace, [seed]]]), {
    executionContextProvider: () => context,
    ...(options.clock ? { clock: options.clock, deadlineToleranceMs: 0 } : {}),
  });

  const marking = await executor.run(options.timeoutMs ?? 300_000, 'close');
  const outcome = classify(compiled, marking);

  // A top-level bail ends the run as a success, and Mastra rewrites the bailing entry's own
  // record to match: `lastOutput.result.status = 'success'` mutates the object `stepResults`
  // already holds (`default.ts:926-928`, stored at `handlers/entry.ts:812`). The bail token's
  // `stepId` is the id that record lives under — for a leaf, a loop and a foreach alike.
  if (outcome.status === 'success' && outcome.bailed === true) {
    const bail = marking.peekFirst(compiled.terminals.bailed) as { value: BailToken } | null;
    if (bail !== null) {
      scope.recordStepResult(bail.value.stepId, { status: 'success', output: bail.value.output });
    }
  }
  return { outcome, stepResults: scope.stepResults() };
}

const OUTCOME_STATUSES: ReadonlySet<string> = new Set(['success', 'failed', 'bailed', 'suspended', 'paused']);

/**
 * Refuses a malformed carried-in record at the boundary. A `null` in there would otherwise be
 * read deep inside a join's action, after its inputs were consumed, and strand the run with no
 * place named.
 */
function assertStepResults(results: ReadonlyMap<string, StepOutcome>): void {
  for (const [stepId, outcome] of results) {
    const status = (outcome as { status?: unknown } | null)?.status;
    if (outcome === null || typeof outcome !== 'object' || typeof status !== 'string' || !OUTCOME_STATUSES.has(status)) {
      throw new Error(`carried-in step result for '${stepId}' is not a recognised outcome`);
    }
  }
}

/**
 * Whether a failure's `tripwire` field makes the run a `'tripwire'` rather than a `'failed'`.
 *
 * Mastra's own test (`default.ts:611-626`) accepts exactly two shapes: a `TripWire` instance,
 * which is an `Error` subclass, and serialized tripwire data — an object carrying `reason`.
 * `TripWire` sets no `name`, so without importing Mastra the instance is recognised as an
 * `Error`; a runner therefore sets `tripwire` only from Mastra's own field. Anything else —
 * `null`, a string, `0`, `false` — is an ordinary failure.
 */
function isTripwire(value: unknown): boolean {
  return value instanceof Error || (typeof value === 'object' && value !== null && 'reason' in value);
}

/** {@link runWorkflowDetailed}, returning the outcome alone. */
export async function runWorkflow(
  compiled: CompiledWorkflow,
  input: unknown,
  options: RunOptions,
): Promise<RunOutcome> {
  return (await runWorkflowDetailed(compiled, input, options)).outcome;
}

/**
 * Reads the outcome out of the marking.
 *
 * The residue scan covers **every** place, terminals included, and the reported terminal then
 * removes exactly one token from it. Reaching a terminal and stranding a token are independent
 * facts, and a classifier that returns on the first terminal it finds can never report the
 * combination — which is the combination that hides a modelling defect behind a green test.
 *
 * Precedence among terminals only matters when the model is already wrong; it is fixed so the
 * report is deterministic, and the losers are reported as residue.
 */
export function classify(compiled: CompiledWorkflow, marking: Marking): RunOutcome {
  const { terminals } = compiled;
  const counts = new Map<string, number>();
  for (const p of compiled.net.places) {
    const count = marking.tokenCount(p);
    if (count > 0) counts.set(p.name, count);
  }

  // `peekFirst` returns null, not undefined, on an empty place ([CORE-013]).
  const head = <T>(p: Place<T>): T | null => {
    const token = marking.peekFirst(p) as { value: T } | null;
    return token === null ? null : token.value;
  };

  let outcome: Exclude<RunOutcome, { readonly status: 'stranded' }> | undefined;
  let reported: string | undefined;

  const failure = head<FailureToken>(terminals.failed);
  const suspension = head<SuspendToken>(terminals.suspended);
  const pause = head<PauseToken>(terminals.paused);
  const bail = head<BailToken>(terminals.bailed);
  const done = head<FlowToken>(terminals.done);

  if (failure !== null) {
    outcome =
      isTripwire(failure.tripwire)
        ? { status: 'tripwire', stepId: failure.stepId, tripwire: failure.tripwire }
        : { status: 'failed', stepId: failure.stepId, error: failure.error };
    reported = terminals.failed.name;
  } else if (suspension !== null) {
    outcome = { status: 'suspended', stepId: suspension.stepId, path: suspension.path, payload: suspension.payload };
    reported = terminals.suspended.name;
  } else if (pause !== null) {
    outcome = { status: 'paused', stepId: pause.stepId, path: pause.path };
    reported = terminals.paused.name;
  } else if (bail !== null) {
    outcome = { status: 'success', output: bail.output, bailed: true };
    reported = terminals.bailed.name;
  } else if (done !== null) {
    outcome = { status: 'success', output: done.data };
    reported = terminals.done.name;
  }

  if (reported !== undefined) {
    const left = (counts.get(reported) ?? 0) - 1;
    if (left > 0) counts.set(reported, left);
    else counts.delete(reported);
  }
  const residue = [...counts].map(([name, n]) => (n === 1 ? name : `${name}=${n}`)).sort();

  if (outcome === undefined) return { status: 'stranded', places: residue };
  return residue.length > 0 ? { ...outcome, residue } : outcome;
}

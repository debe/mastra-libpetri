import {
  PrecompiledNetExecutor,
  environmentPlace,
  tokenOf,
  seedToken,
  type Clock,
  type EventStore,
  type Marking,
  type NetEvent,
  type Place,
  type Token,
} from 'libpetri';
import { RUN_SCOPE_KEY } from '../compiler/scope.js';
import type {
  BailToken,
  CanceledToken,
  CompiledWorkflow,
  FailureToken,
  FlowToken,
  PauseToken,
  StepRecord,
  StepRunner,
  SuspendToken,
} from '../compiler/types.js';
import type { EntryPath } from '../compiler/names.js';
import { KernelRunScope } from './scope.js';
import type { ResumeSeed } from '../compiler/resume.js';

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
/**
 * Where the reported outcome came from: the step, its view path (Mastra's `executionPath`) and,
 * for a `.foreach()` item, its index — what the codec needs to write the snapshot's paths.
 */
type At = { readonly stepId: string; readonly path: EntryPath; readonly foreachIndex?: number };

export type RunOutcome =
  | ({ readonly status: 'success'; readonly output: unknown; readonly bailed?: undefined } & Residue)
  /** A top-level `bail`: Mastra reports it as a success; `At` names the step that bailed. */
  | ({ readonly status: 'success'; readonly output: unknown; readonly bailed: true } & At & Residue)
  | ({ readonly status: 'failed'; readonly error: unknown } & At & Residue)
  | ({ readonly status: 'tripwire'; readonly tripwire: unknown; readonly error: unknown } & At & Residue)
  | ({ readonly status: 'suspended'; readonly payload: unknown } & At & Residue)
  | ({ readonly status: 'paused' } & At & Residue)
  /** Mastra's canceled run carries no step id; `origin` names what was waiting or running. */
  | ({ readonly status: 'canceled'; readonly origin?: CanceledToken['origin']; readonly started: boolean } & Residue)
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
   *
   * `null` means **no budget**, which is what a Mastra run has. A run with a signal whose model
   * strands a token then waits forever — ruled out by the proven `exactlyOneTerminal`, not by a
   * timer. Omitted, the harness default of five minutes applies.
   */
  readonly timeoutMs?: number | null;
  /** Step records carried in from an earlier segment. Each must be a recognised outcome. */
  readonly stepResults?: ReadonlyMap<string, StepRecord>;
  /**
   * The run's abort signal — Mastra's `abortController.signal`. When it fires, one token is
   * injected into the net's cancellation place and the net itself decides what that stops.
   *
   * Supplying one registers that place as an environment place, and an executor with one does not
   * end at quiescence on its own ([ENV-010]): the kernel ends the run by calling `drain()` the
   * moment a terminal is marked. A run whose model strands a token therefore reaches no terminal
   * and ends only at `timeoutMs` — a model defect the proven `exactlyOneTerminal` rules out, and
   * the reason a run without a signal registers no environment place at all.
   */
  readonly signal?: AbortSignal;
  /**
   * Start a resumed segment ([ADR 0007]): one token at a registered resume site instead of the
   * entry place. The permits and a pre-aborted signal are seeded as for a fresh run; nothing is
   * restored from a marking.
   */
  readonly resume?: ResumeSeed;
}

export interface RunReport {
  readonly outcome: RunOutcome;
  /** Every step's latest record, keyed by step id — Mastra's `stepResults`. */
  readonly stepResults: ReadonlyMap<string, StepRecord>;
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
 * **How a run ends.** Without a signal no environment place is registered and the executor ends
 * at quiescence ([ENV-010]). With one, the cancel request place is an environment place, so the
 * executor would wait at quiescence for more; the kernel ends the run with `drain()` the moment a
 * terminal is marked ([ADR 0004]).
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
  if (compiled.program.compiled.net !== compiled.net) {
    // The executor runs `program` and ignores `net`, while the verifier proves `net`. A workflow
    // whose `net` was swapped after compiling would run one net and be proven on another — the
    // one thing "one net serves execution and verification" rules out.
    throw new Error(`compiled workflow '${compiled.net.name}': its program was compiled from a different net`);
  }
  if (options.resume !== undefined) {
    // CONTRACT STUB (ADR 0007): the kernel area implements the seeded segment. Refused rather than
    // silently run from the entry place.
    throw new Error('runWorkflowDetailed: resumed segments are not implemented yet (M4, ADR 0007)');
  }
  if (options.stepResults) assertStepResults(options.stepResults);
  const { signal } = options;
  const scope = new KernelRunScope({
    runner: options.runner,
    initData: input,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(signal ? { signal } : {}),
    ...(options.stepResults ? { stepResults: options.stepResults } : {}),
  });

  // A marking is built before any executor exists, so the ordinary constructor stamps wall time
  // and would differ on every replay — inside the marking. Seed through the clock.
  const seed = <T>(value: T): Token<T> => (options.clock ? seedToken<T>(options.clock, value) : tokenOf<T>(value));
  const initial = new Map<Place<unknown>, Token<unknown>[]>([[compiled.entryPlace, [seed<FlowToken>({ data: input })]]]);
  // Aborted before it began: the signal is already in the marking, so the first entry's sweep
  // takes the run straight to `wf.canceled`, as Mastra's check before the first entry does.
  // The SIGNAL, not the request: the arrival already happened, before the run. Seeding the request
  // would let `arrive` and the first entry's start fire in either order — they share no input — so
  // a pre-aborted run could start its first step, which Mastra's check before the first entry never
  // allows. (The `cancel` proof segment seeds the request on purpose: there the arrival may land
  // anywhere, including after the first start.)
  if (signal?.aborted) initial.set(compiled.cancel, [seed(null)]);
  // The run's step budget ([ADR 0006]): `k` permits in the initial marking, never deposited by an
  // action, so the analyses see exactly `k` — the multiplicity lives where [IO-016] models it.
  if (compiled.budget) initial.set(compiled.budget.permits, Array.from({ length: compiled.budget.k }, () => seed(null)));

  const context = new Map<string, unknown>([[RUN_SCOPE_KEY, scope]]);
  // At runtime the environment writes to the SIGNAL directly, not to the request place. The net's
  // `t.cancel.arrive` exists so a proof can land the arrival anywhere; a real arrival going through
  // it would cost an extra firing, and in that window a start enabled in the same cycle fires
  // before the inhibitor sees the signal — measured: a step started though its abort signal had
  // already fired, which Mastra, reading its signal synchronously before each entry, never does.
  // Injecting into `wf.cancel` is the same event the verifier models, with no hop.
  // A place NAME: libpetri's `environmentPlace` takes a string, and given a `Place` it registers
  // one that matches nothing in the net.
  const cancelPlace = environmentPlace<null>(compiled.cancel.name);
  const terminalNames = new Set(Object.values(compiled.terminals).map((p: Place<unknown>) => p.name));

  // `drain()` the moment a terminal is marked. It stops nothing: queued events are processed and
  // in-flight actions finish ([ENV-011]), so the run still comes to rest, and `exactlyOneTerminal`
  // covers the marking it rests in. Called from inside the firing cycle, which is safe: a wake-up
  // raised while the executor is not parked is latched, not lost (libpetri 6.1.0).
  let executor: PrecompiledNetExecutor | undefined;
  const drainOnTerminal: EventStore | undefined = signal
    ? terminalWatcher(terminalNames, () => executor?.drain())
    : undefined;

  executor = new PrecompiledNetExecutor(compiled.net, initial, {
    executionContextProvider: () => context,
    program: compiled.program,
    ...(options.clock ? { clock: options.clock, deadlineToleranceMs: 0 } : {}),
    ...(signal ? { environmentPlaces: new Set([cancelPlace]), eventStore: drainOnTerminal } : {}),
  });

  // After `drain()` or `close()` the executor rejects an injection silently — the run is already
  // finishing, so a late abort is "already terminal". What `injectNoAwait` *throws* is a wiring
  // error (the place is not registered), which must surface rather than lose the abort.
  const onAbort = (): void => {
    executor?.injectNoAwait(cancelPlace, null);
  };
  if (signal && !signal.aborted) signal.addEventListener('abort', onAbort, { once: true });

  let marking: Marking;
  try {
    marking = await executor.run(options.timeoutMs === null ? undefined : (options.timeoutMs ?? 300_000), 'close');
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  const outcome = classify(compiled, marking);

  // A top-level bail ends the run as a success, and Mastra rewrites the bailing entry's own
  // record to match: `lastOutput.result.status = 'success'` mutates the object `stepResults`
  // already holds (`default.ts:926-928`, stored at `handlers/entry.ts:812`). The bail token's
  // `stepId` is the id that record lives under — for a leaf, a loop and a foreach alike.
  if (outcome.status === 'success' && outcome.bailed === true) {
    const bail = marking.peekFirst(compiled.terminals.bailed) as { value: BailToken } | null;
    if (bail !== null) {
      const existing = scope.getStepResult(bail.value.stepId);
      scope.recordStepResult(bail.value.stepId, {
        payload: existing !== undefined && 'payload' in existing ? existing.payload : undefined,
        ...(existing?.startedAt === undefined ? {} : { startedAt: existing.startedAt }),
        ...(existing?.endedAt === undefined ? {} : { endedAt: existing.endedAt }),
        ...(existing?.metadata === undefined ? {} : { metadata: existing.metadata }),
        status: 'success',
        output: bail.value.output,
      });
    }
  }
  return { outcome, stepResults: scope.stepResults() };
}

/** Statuses a carried-in record may have: every outcome, and a combinator's `canceled`. */
const OUTCOME_STATUSES: ReadonlySet<string> = new Set(['success', 'failed', 'bailed', 'suspended', 'paused', 'canceled', 'waiting']);

/**
 * Refuses a malformed carried-in record at the boundary. A `null` in there would otherwise be
 * read deep inside a join's action, after its inputs were consumed, and strand the run with no
 * place named.
 */
function assertStepResults(results: ReadonlyMap<string, StepRecord>): void {
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
    // The cancellation signal stays marked once injected — it is the environment's, not work — and
    // the step permits are *supposed* to be all back at rest; a missing one is a leak, not residue
    // (`permitsReturned` proves it cannot happen).
    if (p.name === compiled.cancel.name) continue;
    if (p.name === compiled.budget?.permits.name) {
      // Exactly k at rest: every branch returns its permit in the same firing. Any other count is a
      // minted or leaked permit, and reported rather than hidden.
      const n = marking.tokenCount(p);
      if (n !== compiled.budget.k) counts.set(`${p.name} (k=${compiled.budget.k})`, n);
      continue;
    }
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

  const cancellation = head<CanceledToken>(terminals.canceled);
  const failure = head<FailureToken>(terminals.failed);
  const suspension = head<SuspendToken>(terminals.suspended);
  const pause = head<PauseToken>(terminals.paused);
  const bail = head<BailToken>(terminals.bailed);
  const done = head<FlowToken>(terminals.done);

  if (cancellation !== null) {
    // Canceled first: Mastra re-stamps whatever the interrupted entry produced
    // (`handlers/entry.ts:815-817`), so a canceled run is canceled whatever else it reached.
    outcome =
      cancellation.origin === undefined
        ? { status: 'canceled', started: cancellation.started }
        : { status: 'canceled', origin: cancellation.origin, started: cancellation.started };
    reported = terminals.canceled.name;
  } else if (failure !== null) {
    outcome = isTripwire(failure.tripwire)
      ? { status: 'tripwire', ...at(failure), tripwire: failure.tripwire, error: failure.error }
      : { status: 'failed', ...at(failure), error: failure.error };
    reported = terminals.failed.name;
  } else if (suspension !== null) {
    outcome = { status: 'suspended', ...at(suspension), payload: suspension.payload };
    reported = terminals.suspended.name;
  } else if (pause !== null) {
    outcome = { status: 'paused', ...at(pause) };
    reported = terminals.paused.name;
  } else if (bail !== null) {
    outcome = { status: 'success', output: bail.output, bailed: true, ...at(bail) };
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

/**
 * An event store that does one thing: calls `onTerminal` when a token lands in a terminal place.
 * It keeps no events — the kernel needs the signal, not the history.
 */
function terminalWatcher(terminalNames: ReadonlySet<string>, onTerminal: () => void): EventStore {
  let fired = false;
  return {
    append(event: NetEvent): void {
      if (!fired && event.type === 'token-added' && terminalNames.has(event.placeName)) {
        fired = true;
        onTerminal();
      }
    },
    events: () => [],
    isEnabled: () => true,
    size: () => 0,
    isEmpty: () => true,
  };
}

/** An exit token's origin, with `foreachIndex` only when there is one. */
function at(origin: At): At {
  return origin.foreachIndex === undefined
    ? { stepId: origin.stepId, path: origin.path }
    : { stepId: origin.stepId, path: origin.path, foreachIndex: origin.foreachIndex };
}

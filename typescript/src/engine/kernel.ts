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
import type { RestartSeed } from '../compiler/restart.js';

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
  /**
   * `pending` names the block's other suspensions, in arm or item order ([ADR 0007]) — present only
   * when there are any, so a single suspension reads as before.
   */
  | ({ readonly status: 'suspended'; readonly payload: unknown; readonly pending?: readonly SuspendToken[] } & At & Residue)
  | ({ readonly status: 'paused' } & At & Residue)
  /** Mastra's canceled run carries no step id; `origin` names what was waiting or running. */
  | ({ readonly status: 'canceled'; readonly origin?: CanceledToken['origin']; readonly started: boolean } & Residue)
  /**
   * No terminal to report — or a firing failed ({@link TransitionFailure}), which strands the run
   * whatever else it reached. `places` names every marked place but the cancel signal (and the
   * permits, when all `k` are back); `failure` is present only when a firing failed.
   */
  | { readonly status: 'stranded'; readonly places: readonly string[]; readonly failure?: TransitionFailure };

/** A firing that threw, from libpetri's `transition-failed` event: the action's error or an `OutViolationError`. */
export interface TransitionFailure {
  readonly transition: string;
  readonly exceptionType: string;
  readonly message: string;
}

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
   * the reason a run without a signal registers no environment place at all. A token lost to a
   * *failed firing* is not waited out: the kernel ends that run at once, as `stranded`.
   */
  readonly signal?: AbortSignal;
  /**
   * Start a resumed segment ([ADR 0007]): one token at a registered resume site instead of the
   * entry place. The permits and a pre-aborted signal are seeded as for a fresh run; nothing is
   * restored from a marking.
   */
  readonly resume?: ResumeSeed;
  /**
   * Start a restarted segment ([ADR 0010]): one `FlowToken` at a top-level boundary instead of the
   * entry place, proven as `restart@<index>`. Exclusive with `resume`.
   */
  readonly restart?: RestartSeed;
  /**
   * A second event store every net event is also appended to — the libpetri debug UI's
   * `DebugAwareEventStore` tee ([ADR 0008]). Observation only: the kernel's own watcher still sees
   * every event first, and a throw from this store is kept on the report, not raised in the
   * executor, where it would fail the firing that emitted the event.
   */
  readonly eventStore?: EventStore;
}

export interface RunReport {
  readonly outcome: RunOutcome;
  /** Every step's latest record, keyed by step id — Mastra's `stepResults`. */
  readonly stepResults: ReadonlyMap<string, StepRecord>;
  /**
   * The first error a lifecycle observer (`StepRunner.observe`) or the tee'd `eventStore` threw.
   * Present only when one did. It changed nothing about the run ([ADR 0008]); the host reports it.
   */
  readonly observerError?: { readonly error: unknown };
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
 * terminal is marked ([ADR 0004]). Either way a **failed firing** ends the run at once as
 * `stranded`, carrying the failure: its inputs are consumed and nothing was produced.
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
  if (options.stepResults) assertStepResults(options.stepResults);
  const { signal } = options;
  const scope = new KernelRunScope({
    runner: options.runner,
    initData: input,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(signal ? { signal } : {}),
    ...(options.stepResults ? { stepResults: options.stepResults } : {}),
  });

  const initial = initialMarking(compiled, input, options);

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
  //
  // A **failed firing** ends the run at once, signal or not: `drain()` then `close()`. A firing that
  // throws — an action's uncaught error, or an `OutViolationError` when it emits outside its `Out`
  // spec — consumed its inputs and produced nothing, so its token is gone and no terminal can be
  // counted on. With a signal the executor would then wait at quiescence forever (`timeoutMs` is
  // `null` under Mastra); without one, sibling work would keep running for a run already lost. The
  // proofs cannot see this — they model the `Out` spec, not the action — so the kernel does.
  let executor: PrecompiledNetExecutor | undefined;
  let failure: TransitionFailure | undefined;
  const watcher = runWatcher(
    signal ? terminalNames : new Set(),
    () => executor?.drain(),
    (event) => {
      failure ??= { transition: event.transitionName, exceptionType: event.exceptionType, message: event.errorMessage };
      executor?.drain();
      executor?.close();
    },
  );

  let teeError: { readonly error: unknown } | undefined;
  executor = new PrecompiledNetExecutor(compiled.net, initial, {
    executionContextProvider: () => context,
    program: compiled.program,
    eventStore: options.eventStore === undefined ? watcher : tee(watcher, options.eventStore, (error) => (teeError ??= { error })),
    ...(options.clock ? { clock: options.clock, deadlineToleranceMs: 0 } : {}),
    ...(signal ? { environmentPlaces: new Set([cancelPlace]) } : {}),
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
  if (failure !== undefined) {
    // Stranded whatever else the marking holds: a terminal a sibling reached is not this run's
    // outcome once one of its tokens was lost. Every marked place is named, terminals included.
    return {
      outcome: { status: 'stranded', places: markedPlaces(compiled, marking), failure },
      stepResults: scope.stepResults(),
      ...observerErrorOf(scope, teeError),
    };
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
  return { outcome, stepResults: scope.stepResults(), ...observerErrorOf(scope, teeError) };
}

/** `observerError` for the report, only when an observer or the tee threw — the observer's first. */
function observerErrorOf(scope: KernelRunScope, teeError: { readonly error: unknown } | undefined): Pick<RunReport, 'observerError'> {
  const first = scope.observerError ?? teeError;
  return first === undefined ? {} : { observerError: first };
}

/**
 * `primary` first, then `secondary`, on every append. `primary` is the kernel's watcher, whose
 * `isEnabled()` is always true, so the executor never skips building an event the tee wants. A
 * throw from `secondary` goes to `onError` and no further: inside `append` it would fail the
 * firing that emitted the event.
 */
function tee(primary: EventStore, secondary: EventStore, onError: (error: unknown) => void): EventStore {
  return {
    append(event: NetEvent): void {
      primary.append(event);
      try {
        secondary.append(event);
      } catch (error) {
        onError(error);
      }
    },
    events: () => primary.events(),
    isEnabled: () => true,
    size: () => primary.size(),
    isEmpty: () => primary.isEmpty(),
  };
}

/**
 * The token counts a run — and the proof of its segment — starts from: one token at `start`, one at
 * `cancel` when given, and `k` permits when a budget was compiled in. **The one definition of a
 * segment's initial marking**: the verifier's `segmentInitialMarking` calls it with the segment's
 * start place and, for a cancel segment, the cancel *request*; {@link initialMarking} checks every
 * run's tokens against it with the start it seeded and, for a pre-aborted run, the cancel *signal*.
 *
 * Insertion order is start, cancel, permits — the order a report's marking prints in. Counts are
 * set, not added, so a start place that collides with the permits, or with the cancel place when
 * the run is pre-aborted, counts once here and twice in a run's tokens, and the kernel refuses that
 * run. A collision with the cancel place on a run that is not pre-aborted is refused by the
 * one-token-of-work check instead. This does not check `k` independently: the kernel and the
 * verifier both read it from the compiled budget, and the guarantee is that they share these counts.
 */
export function initialCounts(
  compiled: CompiledWorkflow,
  start: Place<unknown>,
  cancel?: Place<unknown>,
): ReadonlyMap<Place<unknown>, number> {
  const counts = new Map<Place<unknown>, number>();
  counts.set(start, 1);
  if (cancel !== undefined) counts.set(cancel, 1);
  if (compiled.budget) counts.set(compiled.budget.permits, compiled.budget.k);
  return counts;
}

/**
 * The marking a run starts from — built before any executor exists, and the only place a run's
 * initial tokens are decided. Exported so a test can compare it with what the verifier seeds.
 *
 * - **Fresh run:** one `FlowToken` in the entry place.
 * - **Resumed segment** ([ADR 0007]): one token — the seed's value, as it is — in the site's place,
 *   **instead of** the entry place. Nothing is restored from a marking (no CORE-073), so clocks
 *   start fresh, as in Mastra.
 * - Either way: `k` permits when a budget was compiled in, and the cancel **signal** when the run's
 *   signal had already fired.
 *
 * **Checked, then returned.** Every check runs before any executor is built, so a refused run
 * starts nothing:
 * 1. A resume site must be the one this workflow registered at that path — by identity, so a site
 *    from another compile (even of the same workflow) cannot slip in.
 * 2. The token count of every place must equal {@link initialCounts} for the same start — the
 *    marking the `closed` or `resume@site` segment is proven from — plus the cancel signal when
 *    pre-aborted. A pre-aborted run's marking is therefore **not** the one a `+cancel` segment is
 *    proven from: it is that marking's successor after `t.cancel.arrive` (the request moved to the
 *    signal), so it is reachable from the proven one, which is what the `+cancel` proof covers.
 * 3. A resumed segment holds exactly one token outside the permits and the cancel signal, at its
 *    site — which (2) cannot see when a site is registered on the cancel place itself.
 * 4. An entry site's seed is a `FlowToken` (a non-null object with `data`). The verifier is
 *    value-blind, so a proof says nothing about a malformed seed; without this a `null` seed fails
 *    inside the step's first attempt. An arm's `ArmResume` and a foreach's `ForeachResume` are
 *    checked by their own gates, which refuse a misfit by name as the block's `failed` outcome.
 */
export function initialMarking(
  compiled: CompiledWorkflow,
  input: unknown,
  options: Pick<RunOptions, 'clock' | 'signal' | 'resume' | 'restart'>,
): Map<Place<unknown>, Token<unknown>[]> {
  const { resume, signal } = options;
  if (options.restart !== undefined) throw new Error('initialMarking: restart seeding is not implemented (M4b W2)');
  if (resume !== undefined) {
    const key = resume.site.path.join('.');
    if (compiled.resumeSites.get(key) !== resume.site) {
      throw new Error(
        `compiled workflow '${compiled.net.name}': the resume site at path ${key} ('${resume.site.stepId}') is not the one this workflow registered there`,
      );
    }
  }

  // A marking is built before any executor exists, so the ordinary constructor stamps wall time
  // and would differ on every replay — inside the marking. Seed through the clock.
  const seed = <T>(value: T): Token<T> => (options.clock ? seedToken<T>(options.clock, value) : tokenOf<T>(value));
  const start: Place<unknown> = resume === undefined ? compiled.entryPlace : resume.site.place;
  const initial = new Map<Place<unknown>, Token<unknown>[]>();
  initial.set(start, [resume === undefined ? seed<FlowToken>({ data: input }) : seed(resume.value)]);
  // Aborted before it began: the signal is already in the marking, so the first entry's sweep
  // takes the run straight to `wf.canceled`, as Mastra's check before the first entry does — and a
  // resume site's gate or sweep does the same, as Mastra's check before each entry holds for a
  // resumed run (`default.ts:815`).
  // The SIGNAL, not the request: the arrival already happened, before the run. Seeding the request
  // would let `arrive` and the first entry's start fire in either order — they share no input — so
  // a pre-aborted run could start its first step, which Mastra's check before the first entry never
  // allows. (The `cancel` proof segment seeds the request on purpose: there the arrival may land
  // anywhere, including after the first start.)
  const aborted = signal?.aborted === true;
  if (aborted) initial.set(compiled.cancel, [...(initial.get(compiled.cancel) ?? []), seed(null)]);
  // The run's step budget ([ADR 0006]): `k` permits in the initial marking, never deposited by an
  // action, so the analyses see exactly `k` — the multiplicity lives where [IO-016] models it.
  if (compiled.budget) {
    const { permits, k } = compiled.budget;
    initial.set(permits, [...(initial.get(permits) ?? []), ...Array.from({ length: k }, () => seed(null))]);
  }

  assertProvenCounts(compiled, initial, initialCounts(compiled, start, aborted ? compiled.cancel : undefined), resume, aborted);
  if (resume !== undefined) {
    let work = 0;
    for (const [p, tokens] of initial) {
      if (p === compiled.cancel || p === compiled.budget?.permits) continue;
      work += tokens.length;
    }
    if (work !== 1 || initial.get(resume.site.place)?.length !== 1) {
      throw new Error(
        `compiled workflow '${compiled.net.name}': a resumed segment must start from exactly one token at its site '${resume.site.place.name}', found ${work} outside the permits and the cancel signal`,
      );
    }
    const misfit = seedMisfit(resume.site, resume.value);
    if (misfit !== undefined) {
      throw new Error(
        `compiled workflow '${compiled.net.name}': the seed at resume site ${resume.site.path.join('.')} ('${resume.site.place.name}') ${misfit}`,
      );
    }
  }
  return initial;
}

/** Throws unless every place holds exactly the count the segment is proven from (see {@link initialMarking}). */
function assertProvenCounts(
  compiled: CompiledWorkflow,
  initial: ReadonlyMap<Place<unknown>, readonly Token<unknown>[]>,
  expected: ReadonlyMap<Place<unknown>, number>,
  resume: ResumeSeed | undefined,
  aborted: boolean,
): void {
  const differences: string[] = [];
  for (const p of new Set([...expected.keys(), ...initial.keys()])) {
    const want = expected.get(p) ?? 0;
    const have = initial.get(p)?.length ?? 0;
    if (want !== have) differences.push(`${p.name}: ${have}, proven from ${want}`);
  }
  if (differences.length === 0) return;
  const segment = resume === undefined ? 'closed' : `resume@${resume.site.path.join('.')}`;
  throw new Error(
    `compiled workflow '${compiled.net.name}': the initial marking is not the one segment ${segment} is proven from` +
      `${aborted ? ' plus the cancel signal' : ''} (${differences.join('; ')})`,
  );
}

/**
 * Why a seed's colour is not what its site's gate reads, or `undefined` when it is.
 *
 * Only an **entry** site is checked here: its gate is a step's first attempt, which reads `data`
 * off the token and has no refusal of its own, so a `null` would fail the firing. An **arm** or
 * **foreach** gate refuses a seed that does not fit by name, as the block's own `failed` outcome
 * before any step runs (`reentry.ts`, `foreach.ts` `seedMisfit`) — a Mastra-shaped failure the
 * gadget tests pin — so the kernel leaves those to it rather than pre-empt it with a rejection.
 */
function seedMisfit(site: ResumeSeed['site'], value: unknown): string | undefined {
  if (site.kind !== 'entry') return undefined;
  return typeof value === 'object' && value !== null && 'data' in value ? undefined : 'is not a FlowToken: a non-null object with `data`';
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
 * Token counts of every place that holds work at rest: the cancel signal is skipped (it stays
 * marked once injected — the environment's, not work), and the permits appear only when their
 * count is not `k` (every branch returns its permit in the same firing, so any other count is a
 * minted or leaked one; `permitsReturned` proves it cannot happen).
 */
function placeCounts(compiled: CompiledWorkflow, marking: Marking): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of compiled.net.places) {
    if (p.name === compiled.cancel.name) continue;
    if (p.name === compiled.budget?.permits.name) {
      const n = marking.tokenCount(p);
      if (n !== compiled.budget.k) counts.set(`${p.name} (k=${compiled.budget.k})`, n);
      continue;
    }
    const count = marking.tokenCount(p);
    if (count > 0) counts.set(p.name, count);
  }
  return counts;
}

/** Every marked place as {@link classify} names residue: `name` or `name=n`, sorted. */
function markedPlaces(compiled: CompiledWorkflow, marking: Marking): readonly string[] {
  return [...placeCounts(compiled, marking)].map(([name, n]) => (n === 1 ? name : `${name}=${n}`)).sort();
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
  const counts = placeCounts(compiled, marking);

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
    outcome =
      suspension.pending !== undefined && suspension.pending.length > 0
        ? { status: 'suspended', ...at(suspension), payload: suspension.payload, pending: suspension.pending }
        : { status: 'suspended', ...at(suspension), payload: suspension.payload };
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
 * An event store that does two things: calls `onTerminal` once when a token lands in one of
 * `terminalNames`, and `onFailure` on every `transition-failed` event. It keeps no events — the
 * kernel needs the signals, not the history.
 */
function runWatcher(
  terminalNames: ReadonlySet<string>,
  onTerminal: () => void,
  onFailure: (event: Extract<NetEvent, { readonly type: 'transition-failed' }>) => void,
): EventStore {
  let fired = false;
  return {
    append(event: NetEvent): void {
      if (event.type === 'transition-failed') onFailure(event);
      else if (!fired && event.type === 'token-added' && terminalNames.has(event.placeName)) {
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

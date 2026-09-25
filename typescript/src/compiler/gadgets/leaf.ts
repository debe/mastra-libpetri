import {
  Transition,
  and,
  place,
  one,
  outPlace,
  xor,
  delayed,
  type Out,
  type Place,
  type TransitionAction,
} from 'libpetri';
import type { EntryPath } from '../names.js';
import { scopeOf, viewOf, type RunScope } from '../scope.js';
import type { Exits, FlowToken, StepOutcome, StepRecord, StepSource } from '../types.js';
import type { Gadget, GadgetContext } from './types.js';

/**
 * Node's timer ceiling. Mastra waits with a bare `setTimeout`, and Node resets any delay above
 * this — or `Infinity`, or `NaN` — to **1ms** (`utils.ts:230-251`). A wait past it is a defect we
 * do not reproduce (`docs/divergences.md` rows 9 and 10), so it is refused rather than honoured.
 */
export const MAX_WAIT_MS = 2_147_483_647;

/**
 * The most retries one step may declare. Retries are unrolled — each attempt is a transition
 * and a place pair — so a retry count is net size, and Mastra, which loops, has no ceiling. A
 * hundred is far above any retry count a workflow uses in practice and keeps one step well under
 * the size at which a net becomes expensive to analyse. Above it the adapter refuses by name
 * (`docs/divergences.md`).
 */
export const MAX_RETRIES = 100;

/**
 * A single step, with its retries unrolled into the net.
 *
 * ```text
 *   in --(run)--> next | failed | bailed | suspended | paused | retry-1
 *   retry-1 --(retry-1, delayed(d))--> attempt-1 --(run-1)--> next | ... | retry-2
 *   ...                                 attempt-R --(run-R)--> next | failed | ...   (no retry)
 * ```
 *
 * **Every outcome is a declared branch.** A step may succeed, fail, bail, suspend or — if it is
 * a nested workflow — pause, and the `xor` names each destination, so the verifier sees all of
 * them and the action writes exactly one ([IO-015]). Where each goes is `ctx.exits`, chosen by
 * the enclosing context; the step does not know whether a bail ends the run or is swallowed by
 * a `.parallel()`.
 *
 * **Retries are topology, not a counter.** Attempt *i* is its own transition, so the ceiling is
 * the number of transitions: there is no budget place to seed, no multiplicity to deposit, and
 * nothing left over to drain on success, because a single token walks the chain and stops. The
 * retry wait is `delayed(d)` — a lower bound, which fails safe across a [CORE-073] restore. The
 * cost is one transition per attempt, and Mastra's retry counts are small. A step with no
 * retries emits exactly one transition and no retry branch, so the default costs nothing.
 *
 * What is retried matches `executeStepWithRetry` (`default.ts:455-511`): any failure, a
 * `TripWire` included, unless it is a `MastraNonRetryableError`. A `bailed`, `suspended` or
 * `paused` outcome is not a failure and is never retried. Only the final attempt's outcome is
 * recorded, as Mastra records only the final one.
 *
 * **Cancellation gates the first attempt only.** Given a signal, the step's first run is
 * inhibited by it and a sweep moves a waiting input to `exits.canceled` — that is Mastra's check
 * before an entry. A retry is not gated: `executeStepWithRetry` never looks at the signal between
 * attempts (`default.ts:455-460`), so a retrying step keeps retrying, and the step's own
 * `abortSignal` (`scope.signal`) is what cuts a well-behaved step short.
 */
export const stepGadget: Gadget = (entry, next, ctx) => {
  if (entry.kind !== 'step') throw new Error(`stepGadget received a '${entry.kind}' entry`);

  const retries = entry.retries ?? 0;
  const delayMs = entry.retryDelayMs ?? 0;
  if (!Number.isInteger(retries) || retries < 0 || retries > MAX_RETRIES) {
    throw new Error(`step '${entry.id}': retries must be an integer in [0, ${MAX_RETRIES}], got ${String(retries)}`);
  }
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > MAX_WAIT_MS) {
    throw new Error(`step '${entry.id}': retryDelayMs must be in [0, ${MAX_WAIT_MS}], got ${String(delayMs)}`);
  }

  const source = entry.source ?? 'step';
  const { names, path, viewPath, exits, cancel, permits } = ctx;
  const inPlace = place<FlowToken>(names.entryIn(path, entry.id));
  const transitions: Transition[] = [];
  if (cancel !== undefined) transitions.push(sweep(names.entryTransition(path, entry.id, 'cancel'), inPlace, cancel, exits, entry.id, viewPath));

  let attemptIn = inPlace;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const retry =
      attempt < retries ? place<FlowToken>(names.entryPlace(path, entry.id, `retry-${attempt + 1}`)) : undefined;

    // With a budget, every branch is its outcome *and* the permit back ([ADR 0006]): an Xor of
    // Ands, so each structural branch is exactly a runtime outcome and the verifier sees the permit
    // returned on every one of them — the P-invariant `permits + in flight = k` is in the arcs.
    const branch = (to: Place<unknown>): Out => (permits === undefined ? outPlace(to) : and(outPlace(to), outPlace(permits)));
    const outcomes: Out[] = [next, exits.failed, exits.bailed, exits.suspended, exits.paused].map(branch);
    if (retry !== undefined) outcomes.push(branch(retry));

    const run = Transition.builder(
      attempt === 0 ? names.entryRun(path, entry.id) : names.entryTransition(path, entry.id, `run-${attempt}`),
    )
      .inputs(...(permits === undefined ? [one(attemptIn)] : [one(attemptIn), one(permits)]))
      .outputs(xor(...outcomes))
      .action(stepAction({ stepId: entry.id, path: viewPath, source, attempt, from: attemptIn, next, exits, retry, permits }));
    if (attempt === 0 && cancel !== undefined) run.inhibitor(cancel);
    const built = run.build();
    ctx.stepAttempt(built.name);
    transitions.push(built);

    if (retry !== undefined) {
      const nextAttempt = place<FlowToken>(names.entryPlace(path, entry.id, `attempt-${attempt + 1}`));
      const wait = Transition.builder(names.entryTransition(path, entry.id, `retry-${attempt + 1}`))
        .inputs(one(retry))
        .outputs(outPlace(nextAttempt))
        .action(async (tctx) => {
          tctx.output(nextAttempt, tctx.input(retry));
        });
      if (delayMs > 0) wait.timing(delayed(delayMs));
      transitions.push(wait.build());
      attemptIn = nextAttempt;
    }
  }

  return { inPlace, transitions };
};

/**
 * `.sleep` / `.sleepUntil`.
 *
 * **Only a fixed `.sleep` is a timed transition.** libpetri timing is relative to when the
 * transition became enabled ([TIME-010]; `exact(t)` fires once `t` ms have elapsed since
 * enablement, `precompiled-net-executor.ts` compares `earliestMs <= now - enabledAtMs`), so a
 * relative wait maps onto `delayed(ms)` exactly. An absolute instant does not map onto anything:
 * there is no epoch-anchored timing, and a net compiled once and cached cannot turn the instant
 * into a relative delay at build time, because it is built long before it runs. An earlier
 * version emitted `exact(epochMs)` for a fixed `.sleepUntil`, which waits *epochMs after
 * enablement* — about fifty-four years for a real date. So a fixed `.sleepUntil` resolves its
 * wait against the run's epoch clock at firing time, the same way a per-run wait does.
 *
 * A wait resolved at firing time is an in-flight action, not a quiescent marking, and cannot be
 * checkpointed mid-wait. Neither can Mastra's: a sleep is an in-process `setTimeout`, not a
 * suspend, and has no resume path.
 *
 * The fixed `.sleep` emits `delayed` — a lower bound. Never `deadline` or `window`: under
 * [CORE-073] a restore starts every clock fresh, so an upper bound would receive a fresh full
 * budget and a promised deadline could be silently missed. A lower bound re-waits, which is safe
 * (`docs/divergences.md` row 1).
 *
 * Either way the sleep records `{status: 'success', output: <its input>}`, as Mastra's does
 * (`handlers/entry.ts:664-665`), so the entry after it reads the value that went in.
 */
export const sleepGadget: Gadget = (entry, next, ctx) => {
  if (entry.kind !== 'sleep' && entry.kind !== 'sleepUntil') {
    throw new Error(`sleepGadget received a '${entry.kind}' entry`);
  }
  const wait = entry.kind === 'sleep' ? entry.duration : entry.until;
  if ('fixed' in wait) {
    const value = wait.fixed;
    if (!Number.isFinite(value) || (entry.kind === 'sleep' && (value < 0 || value > MAX_WAIT_MS))) {
      throw new Error(
        `${entry.kind} '${entry.id}': a fixed wait must be a finite ` +
          `${entry.kind === 'sleep' ? `duration in [0, ${MAX_WAIT_MS}]ms` : 'epoch instant'}, got ${String(value)}`,
      );
    }
  }

  const { cancel, viewPath } = ctx;
  const inPlace = place<FlowToken>(ctx.names.entryIn(ctx.path, entry.id));
  // A sweep on `inPlace` reports a sleep that never began; the sweeps on `waiting` (fixed) and
  // `waited` (action-side) report one that had — separate places, so `CanceledToken.started` is
  // structural rather than guessed from timing.
  const extra: Transition[] =
    cancel === undefined ? [] : [sweep(ctx.names.entryTransition(ctx.path, entry.id, 'cancel'), inPlace, cancel, ctx.exits, entry.id, viewPath)];

  // Each write is followed by its lifecycle event ([ADR 0008]), awaited only when there is an
  // observer, so a run without one fires as it always did.
  const record = async (scope: RunScope, incoming: FlowToken, startedAt: number): Promise<void> => {
    const done: StepRecord = {
      status: 'success',
      output: incoming.data,
      payload: incoming.data,
      startedAt,
      endedAt: scope.epochNow(),
    };
    scope.recordStepResult(entry.id, done);
    const observed = scope.observe({ kind: 'sleep-settled', stepId: entry.id, path: viewPath, record: done });
    if (observed !== undefined) await observed;
  };
  // What Mastra writes when a sleep begins, and leaves if the run is canceled mid-wait
  // (`handlers/entry.ts:602-609`). The wait's end overwrites it with `success`.
  const recordWaiting = async (scope: RunScope, incoming: FlowToken, startedAt: number): Promise<void> => {
    const waiting: StepRecord = { status: 'waiting', payload: incoming.data, startedAt };
    scope.recordStepResult(entry.id, waiting);
    const observed = scope.observe({ kind: 'sleep-waiting', stepId: entry.id, path: viewPath, record: waiting });
    if (observed !== undefined) await observed;
  };

  if (entry.kind === 'sleep' && 'fixed' in wait) {
    // `begin` fires at once and records the wait; the token then waits in `waiting` for the
    // delayed `wake`. Before this split the token waited in `inPlace` itself, so a cancel sweep
    // could not tell a sleep that never began from one halfway through.
    const waiting = place<RetryToken>(ctx.names.entryPlace(ctx.path, entry.id, 'waiting'));
    const begin = Transition.builder(ctx.names.entryTransition(ctx.path, entry.id, 'begin'))
      .inputs(one(inPlace))
      .outputs(outPlace(waiting))
      .action(async (tctx) => {
        const incoming = tctx.input(inPlace);
        const scope = scopeOf(tctx);
        const startedAt = scope.epochNow();
        await recordWaiting(scope, incoming, startedAt);
        const started: RetryToken = { ...incoming, startedAt };
        tctx.output(waiting, started);
      });
    const wake = Transition.builder(ctx.names.entryWake(ctx.path, entry.id))
      .timing(delayed(wait.fixed))
      .inputs(one(waiting))
      .outputs(outPlace(next))
      .action(async (tctx) => {
        const done = tctx.input(waiting);
        const scope = scopeOf(tctx);
        await record(scope, done, done.startedAt ?? scope.epochNow());
        tctx.output(next, { ...carried(done), data: done.data });
      });
    if (cancel !== undefined) {
      begin.inhibitor(cancel);
      wake.inhibitor(cancel);
      extra.push(sweep(ctx.names.entryTransition(ctx.path, entry.id, 'cancel-waiting'), waiting, cancel, ctx.exits, entry.id, viewPath, true));
    }
    return { inPlace, transitions: [begin.build(), wake.build(), ...extra] };
  }

  const builder = Transition.builder(ctx.names.entryWake(ctx.path, entry.id)).inputs(one(inPlace));
  if (cancel !== undefined) builder.inhibitor(cancel);

  // **The wait's end is routed by the net, not by the action.** An action-side wait that the
  // signal cuts short must be canceled *at the sleep*, keeping the `waiting` record written when the
  // wait began — Mastra leaves `{status: 'waiting'}` there and returns the entry canceled
  // (`handlers/entry.ts:602-609,641-643`).
  // Deciding that in the action by reading `scope.signal.aborted` made `wf.canceled` reachable in
  // a run no cancel reaches, as far as a value-blind verifier can tell, and broke `neverCanceled`
  // — a flag deciding cancellation, which the hard rule forbids. So the action only waits and
  // deposits into `waited`; the same inhibitor/sweep pair as everywhere else then sends it on or
  // to `canceled`. By the time the wait has ended on abort, the kernel's abort listener —
  // registered before any action ran — has already injected the signal.
  const failed = ctx.exits.failed;
  const waited = place<RetryToken>(ctx.names.entryPlace(ctx.path, entry.id, 'waited'));
  builder.outputs(xor(outPlace(waited), outPlace(failed))).action(async (tctx) => {
    const incoming = tctx.input(inPlace);
    const scope = scopeOf(tctx);
    const startedAt = scope.epochNow();
    await recordWaiting(scope, incoming, startedAt);

    // Decide, then emit: resolve and wait first, where a throw writes no success record and leaves
    // the `waiting` one, as Mastra's does (`handlers/entry.ts:604-608`). `threw` is a
    // flag of its own because a rejection may carry `undefined` as its reason, and testing the
    // caught value would read that as success and skip the wait.
    let threw = false;
    let error: unknown;
    try {
      let resolved: unknown;
      if ('fixed' in wait) {
        resolved = wait.fixed;
      } else {
        const resolve = scope.runner.resolveWait;
        if (resolve === undefined) {
          throw new Error(`${entry.kind} '${entry.id}' is computed per run, and the runner has no resolveWait`);
        }
        resolved = await resolve.call(scope.runner, entry.id, incoming.data, viewOf(scope, viewPath));
      }
      await scope.wait(resolveWaitMs(entry.kind, entry.id, resolved, scope.epochNow()));
    } catch (e) {
      threw = true;
      error = e;
    }

    if (threw) {
      // Mastra has no status here: a throwing sleep `fn` rejects `run.start()` outright
      // (`handlers/sleep.ts:83-128`). Failing the run is the nearest outcome a net can declare.
      tctx.output(failed, withIndex({ stepId: entry.id, path: viewPath, error }, incoming));
      return;
    }
    const done: RetryToken = { ...incoming, startedAt };
    tctx.output(waited, done);
  });

  const resume = Transition.builder(ctx.names.entryTransition(ctx.path, entry.id, 'resume'))
    .inputs(one(waited))
    .outputs(outPlace(next))
    .action(async (tctx) => {
      const done = tctx.input(waited);
      await record(scopeOf(tctx), done, done.startedAt ?? scopeOf(tctx).epochNow());
      tctx.output(next, { ...carried(done), data: done.data });
    });
  if (cancel !== undefined) {
    resume.inhibitor(cancel);
    extra.push(sweep(ctx.names.entryTransition(ctx.path, entry.id, 'cancel-waited'), waited, cancel, ctx.exits, entry.id, viewPath, true));
  }
  return { inPlace, transitions: [builder.build(), resume.build(), ...extra] };
};

/**
 * The cancellation sweep: reads the signal, consumes the token waiting to start, and reports the
 * work that never ran. It records nothing — Mastra writes no step result for an entry it skipped.
 */
function sweep(
  name: string,
  from: Place<FlowToken>,
  cancel: Place<null>,
  exits: Exits,
  stepId: string,
  path: EntryPath,
  started = false,
): Transition {
  return Transition.builder(name)
    .inputs(one(from))
    .read(cancel)
    .outputs(outPlace(exits.canceled))
    .action(async (tctx) => {
      const incoming = tctx.input(from);
      tctx.output(exits.canceled, { origin: withIndex({ stepId, path }, incoming), started });
    })
    .build();
}

/** Carries a foreach item's index onto an origin, only when there is one. */
function withIndex<T extends object>(origin: T, incoming: FlowToken): T & { foreachIndex?: number } {
  return incoming.foreachIndex === undefined ? origin : { ...origin, foreachIndex: incoming.foreachIndex };
}

/**
 * Normalises a wait resolved at firing time exactly as Mastra does where Mastra is well-defined,
 * and refuses where it is not.
 *
 * A duration is tested for falsy-or-negative on the raw value and then coerced, as
 * `!duration || duration < 0 ? 0 : duration` followed by `setTimeout` does
 * (`handlers/sleep.ts:130`) — so `undefined`, `0`, `NaN` and any negative wait 0, and `'250'`
 * waits 250ms. A past instant waits 0 (`:256`). What Mastra's timer turns into a ~1ms wake — a
 * value that coerces to `NaN`, `Infinity`, or anything past the timer ceiling — is a defect we do
 * not reproduce, and fails the step with a message naming the actual problem.
 */
function resolveWaitMs(kind: 'sleep' | 'sleepUntil', id: string, resolved: unknown, epochNow: number): number {
  let ms: number;
  if (kind === 'sleep') {
    const raw = resolved as number;
    if (!raw || raw < 0) return 0;
    ms = Number(raw);
    if (Number.isNaN(ms)) {
      throw new Error(`sleep '${id}' resolved to ${describe(resolved)}, which is not a duration`);
    }
  } else {
    if (typeof resolved !== 'number' || Number.isNaN(resolved)) {
      throw new Error(`sleepUntil '${id}' resolved to ${describe(resolved)}, which is not a valid instant`);
    }
    ms = Math.max(0, resolved - epochNow);
  }
  if (!Number.isFinite(ms) || ms > MAX_WAIT_MS) {
    throw new Error(`${kind} '${id}' resolved to a wait of ${String(ms)}ms, past the ${MAX_WAIT_MS}ms timer ceiling`);
  }
  return ms;
}

/** A value rendered for an error message without ever throwing — `JSON.stringify` does on a BigInt. */
function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * The host refused a step before running it — a precondition of the call, not a failure of the
 * step. Mastra's own resume rejects at these points instead of recording a failed step: a truthy
 * primitive stored `suspendPayload` (`'__workflow_meta' in …` throws a `TypeError`,
 * `handlers/step.ts:160`), a resume position this engine refuses at run time, a resumed call on a
 * run given no resume. A runner throws this to say so.
 *
 * The leaf never retries it and writes no record; it leaves by the step's declared failure branch
 * carrying this marker (see {@link stepAction}), and the engine rejects the run with `cause`. It
 * is not rethrown out of the action: that would strand the consumed token and permit.
 */
export class HostPreconditionError extends Error {
  override readonly name = 'HostPreconditionError';
  constructor(
    readonly stepId: string,
    readonly path: EntryPath,
    cause: unknown,
  ) {
    super(
      `the host refused step '${stepId}' at [${path.join(', ')}] before it ran: ` +
        (cause instanceof Error ? cause.message : describe(cause)),
      { cause },
    );
  }
}

interface StepActionSpec {
  readonly stepId: string;
  /** The view path — Mastra's `executionPath` for the call, and every outcome token's `path`. */
  readonly path: EntryPath;
  readonly source: StepSource;
  readonly attempt: number;
  readonly from: Place<FlowToken>;
  readonly next: Place<FlowToken>;
  readonly exits: Exits;
  /** Where a retryable failure goes; absent on the final attempt. */
  readonly retry: Place<FlowToken> | undefined;
  /** The run's permits, handed back with every outcome; absent when the run is unbounded. */
  readonly permits: Place<null> | undefined;
}

const OUTCOME_STATUSES: ReadonlySet<string> = new Set(['success', 'failed', 'bailed', 'suspended', 'paused']);

/**
 * Decide, then emit.
 *
 * The executor consumes inputs before the action runs and does not restore them on failure
 * ([EXEC-031]), so the body computes first — where a throw writes nothing — and only then writes
 * exactly one branch's complete output set. A `try` that wrote in both halves would produce
 * duplicate tokens and satisfy none of the `xor`'s branches.
 */
export function stepAction(spec: StepActionSpec): TransitionAction {
  const { stepId, path, source, attempt, from, next, exits, retry, permits } = spec;
  return async (tctx) => {
    const incoming = tctx.input(from) as RetryToken;
    // The permit goes back with whichever branch is written — the same firing, never later.
    const release = (): void => {
      if (permits !== undefined) tctx.output(permits, null);
    };
    const scope = scopeOf(tctx);
    const resumed = incoming.resumed === true;
    // The record this step had before this call, if any — read before the runner can write one.
    const prior = scope.getStepResult(stepId);
    // Mastra stamps the step's start before its retry loop, `Date.now()` at `handlers/step.ts:166`,
    // so the first attempt reads the clock before the call and the stamp rides the retry token.
    const fresh = incoming.startedAt ?? scope.epochNow();

    let outcome: StepOutcome;
    try {
      outcome = await scope.runner.run(stepId, incoming.data, {
        ...viewOf(scope, path),
        source,
        attempt,
        ...(incoming.foreachIndex === undefined ? {} : { foreachIndex: incoming.foreachIndex }),
        // The attempt a resume feeds ([ADR 0007]); every retry of it too, as `executeStepWithRetry`
        // re-calls with the same params (`default.ts:455-511`).
        ...(resumed ? { resumed: true as const } : {}),
        ...(incoming.iteration === undefined ? {} : { iteration: incoming.iteration }),
        startedAt: fresh,
      });
      if (outcome === null || typeof outcome !== 'object' || !OUTCOME_STATUSES.has((outcome as { status: unknown }).status as string)) {
        throw new Error(`runner returned an unrecognised outcome for step '${stepId}': ${describe(outcome)}`);
      }
    } catch (error) {
      if (error instanceof HostPreconditionError) {
        // The host refused before the step ran — Mastra's resume rejects there, before it writes
        // the step's record or enters its retry loop (`handlers/step.ts:145-175`). A rethrow would
        // lose the consumed input and permit ([EXEC-031]): libpetri drops a failed action's inputs
        // and, under Mastra's abort signal, the executor never quiesces, so the run would hang
        // rather than reject. So the refusal leaves by the declared failure branch — no record, no
        // retry, the permit back — carrying the marker, which the engine turns into the rejection.
        tctx.output(exits.failed, { ...withIndex({ stepId, path }, incoming), error });
        release();
        return;
      }
      // A runner that throws is a failed step, not a lost token — and, like a step whose
      // `execute` throws in Mastra, it is retryable.
      outcome = { status: 'failed', error };
    }

    // A resumed attempt is recorded as resumed exactly when the runner says so, by `resumedAt`:
    // Mastra's truthiness test on the resume data (`handlers/step.ts:166-175`). Then the record
    // takes no new start and keeps the suspended record's `startedAt` — absent, if that record had
    // none. A resumed attempt with falsy resume data is a fresh start, and takes `fresh` (row 82).
    const recordedResumed = resumed && outcome.resumedAt !== undefined;
    const startedAt: number | undefined = incoming.startedAt ?? (recordedResumed ? prior?.startedAt : fresh);

    if (outcome.status === 'failed' && retry !== undefined && outcome.nonRetryable !== true) {
      // The whole token rides the retry chain — `resumed` included, so the next attempt is still
      // the resumed one. `carried()` is what stops it at the step's exit.
      const carry: RetryToken = { ...incoming, ...(startedAt === undefined ? {} : { startedAt }) };
      tctx.output(retry, carry);
      release();
      return;
    }

    // Carry-over (`docs/divergences.md` row 48): Mastra starts a step's record from the prior record
    // under the same id minus its completion fields (`handlers/step.ts:170-178`,
    // `utils.ts:759-775`), and replaces `metadata` only when the call has an iteration count. So a
    // loop's `iterationCount` survives a later `.then(s)` of the same step, and the next loop over
    // it continues from there.
    const priorMeta = prior?.metadata;
    const metadata = {
      ...(incoming.iteration === undefined ? (priorMeta?.iterationCount === undefined ? {} : { iterationCount: priorMeta.iterationCount }) : { iterationCount: incoming.iteration }),
      ...(incoming.foreachIndex === undefined ? {} : { foreachIndex: incoming.foreachIndex }),
    };
    // A suspended or paused step has not ended: Mastra stamps `suspendedAt` and no `endedAt`
    // (`handlers/step.ts:516-526`).
    const now = scope.epochNow();
    const when =
      outcome.status === 'suspended' ? { suspendedAt: now } : outcome.status === 'paused' ? {} : { endedAt: now };
    // A resumed attempt's record starts from the suspended one minus its completion fields
    // (`omitPriorCompletionFields`, `utils.ts:759-777`, spread first at `handlers/step.ts:170`).
    // Recorded as resumed, it writes no new `payload`: Mastra writes `resumePayload` in its place
    // (`:171`), so the record keeps the input the step suspended on. Recorded fresh (falsy resume
    // data), it writes the validated input, `payload: inputData`. `resumePayload` and `resumedAt`
    // are the runner's, on the host record. A fresh attempt writes its own `payload` and start.
    const kept = resumed && prior !== undefined ? withoutCompletion(prior) : {};
    // `resumedAt` is the runner's word to the leaf, not a record field: Mastra's own `resumedAt`
    // rides on the host record, which is what the codec writes.
    const { resumedAt: _resumedAt, ...reported } = outcome;
    const payload =
      recordedResumed && prior !== undefined && Object.hasOwn(prior, 'payload')
        ? prior.payload
        : 'payload' in outcome
          ? outcome.payload
          : incoming.data;
    const record = {
      ...kept,
      ...reported,
      payload,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...when,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    } as StepRecord;
    scope.recordStepResult(stepId, record);
    // The step's final record, for its result event ([ADR 0008]) — after the write, before the
    // outputs, as Mastra publishes before it returns the step's result (`handlers/step.ts:531-545`).
    const observed = scope.observe({ kind: 'step-settled', stepId, path, ...withIndex({}, incoming), record });
    if (observed !== undefined) await observed;

    const origin = withIndex({ stepId, path }, incoming);
    // A foreach's aggregate record takes the deciding item's payload and its own start
    // (`handlers/step.ts:166,174`, kept by `handlers/control-flow.ts:1360-1369,1406`), which is not
    // the item's dispatch when a run budget held it in its lane.
    const stepPayload = {
      ...('payload' in outcome ? { stepPayload: outcome.payload } : {}),
      ...(incoming.foreachIndex === undefined || startedAt === undefined ? {} : { stepStartedAt: startedAt }),
    };
    switch (outcome.status) {
      case 'success':
        // The item's index and the iteration ride on, so the combinator that started the step can
        // tell its results apart without trusting the step's output.
        tctx.output(next, { ...carried(incoming), data: outcome.output });
        release();
        return;
      case 'failed':
        tctx.output(exits.failed, {
          ...origin,
          ...stepPayload,
          error: outcome.error,
          ...(outcome.tripwire === undefined ? {} : { tripwire: outcome.tripwire }),
          ...(outcome.nonRetryable === true ? { nonRetryable: true as const } : {}),
        });
        release();
        return;
      case 'bailed':
        tctx.output(exits.bailed, { ...origin, ...stepPayload, output: outcome.output });
        release();
        return;
      case 'suspended':
        // `suspendedAt` on the run's clock ([TIME-015]) — the record's own instant — so the codec
        // can keep the last suspension per id, as `suspendedPaths` does (`handlers/step.ts:395-397`).
        // A `.foreach()` item's suspension also carries its validated input and start, for its
        // `foreachOutput` entry should a sibling overwrite this record before the settle; the
        // foreach consumes both. Anywhere else the token is as it was.
        tctx.output(exits.suspended, {
          ...origin,
          ...(incoming.foreachIndex === undefined ? {} : stepPayload),
          payload: outcome.suspendPayload,
          suspendedAt: now,
        });
        release();
        return;
      case 'paused':
        tctx.output(exits.paused, { ...origin, ...stepPayload });
        release();
        return;
    }
  };
}

/**
 * A flow token between attempts of one step. `startedAt` exists only on the retry chain's own
 * places; `carried()` never copies it, so it cannot leak downstream. `resumed` rides the chain the
 * same way — every retry of a resumed attempt is resumed — and stops at the step's exit.
 */
type RetryToken = FlowToken & { readonly startedAt?: number };

/**
 * The ride-along fields of a flow token, without its data. **Never `resumed`**: it marks the one
 * attempt a resume feeds, and Mastra feeds no later step (`handlers/step.ts:140-142` holds for
 * `resume.steps[0]` only; position-exact here, `docs/divergences.md`).
 */
function carried(incoming: FlowToken): Omit<FlowToken, 'data'> {
  return {
    ...(incoming.foreachIndex === undefined ? {} : { foreachIndex: incoming.foreachIndex }),
    ...(incoming.iteration === undefined ? {} : { iteration: incoming.iteration }),
  };
}

/**
 * A record minus what a finished, failed or suspended call wrote — Mastra's
 * `omitPriorCompletionFields` (`utils.ts:759-777`) — and minus `host`, which is the previous call's
 * own host record and would outlive it: the codec prefers a `host` when it rebuilds the snapshot.
 * `status` is always overwritten by the outcome.
 */
function withoutCompletion(record: StepRecord): Record<string, unknown> {
  const {
    output: _output,
    error: _error,
    endedAt: _endedAt,
    suspendedAt: _suspendedAt,
    suspendPayload: _suspendPayload,
    suspendOutput: _suspendOutput,
    tripwire: _tripwire,
    nonRetryable: _nonRetryable,
    host: _host,
    ...rest
  } = record as Record<string, unknown>;
  return rest;
}

/** Placeholder for a gadget not yet built, so an unsupported entry fails loudly at compile. */
export function unimplemented(kind: string): Gadget {
  return (_entry, _next, ctx: GadgetContext) => {
    throw new Error(
      `'${kind}' entries are not compiled yet (entry at path ${ctx.path.join('-')}). ` +
        'See tasks/todo.md, M1 Track A.',
    );
  };
}

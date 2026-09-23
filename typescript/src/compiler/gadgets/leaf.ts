import {
  Transition,
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
import type { Exits, FlowToken, StepOutcome, StepSource } from '../types.js';
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
  const { names, path, viewPath, exits, cancel } = ctx;
  const inPlace = place<FlowToken>(names.entryIn(path, entry.id));
  const transitions: Transition[] = [];
  if (cancel !== undefined) transitions.push(sweep(names.entryTransition(path, entry.id, 'cancel'), inPlace, cancel, exits, entry.id, viewPath));

  let attemptIn = inPlace;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const retry =
      attempt < retries ? place<FlowToken>(names.entryPlace(path, entry.id, `retry-${attempt + 1}`)) : undefined;

    const outcomes: Out[] = [
      outPlace(next),
      outPlace(exits.failed),
      outPlace(exits.bailed),
      outPlace(exits.suspended),
      outPlace(exits.paused),
    ];
    if (retry !== undefined) outcomes.push(outPlace(retry));

    const run = Transition.builder(
      attempt === 0 ? names.entryRun(path, entry.id) : names.entryTransition(path, entry.id, `run-${attempt}`),
    )
      .inputs(one(attemptIn))
      .outputs(xor(...outcomes))
      .action(stepAction({ stepId: entry.id, path: viewPath, source, attempt, from: attemptIn, next, exits, retry }));
    if (attempt === 0 && cancel !== undefined) run.inhibitor(cancel);
    transitions.push(run.build());

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
  const builder = Transition.builder(ctx.names.entryWake(ctx.path, entry.id)).inputs(one(inPlace));
  // A sleep in progress ends on cancel, as Mastra's `abortableSleep` resolves early and the entry
  // is re-stamped `canceled`. For a fixed sleep the token *waits in* `inPlace` while the delay
  // runs, so the sweep ends it the moment the signal lands; a wait resolved in the action ends
  // through `scope.signal` instead, and the settle stage or the next entry's sweep does the rest.
  const extra: Transition[] =
    cancel === undefined ? [] : [sweep(ctx.names.entryTransition(ctx.path, entry.id, 'cancel'), inPlace, cancel, ctx.exits, entry.id, viewPath)];
  if (cancel !== undefined) builder.inhibitor(cancel);

  const record = (scope: RunScope, incoming: FlowToken, startedAt: number): void =>
    scope.recordStepResult(entry.id, {
      status: 'success',
      output: incoming.data,
      payload: incoming.data,
      startedAt,
      endedAt: scope.epochNow(),
    });

  if (entry.kind === 'sleep' && 'fixed' in wait) {
    const ms = wait.fixed;
    builder
      .timing(delayed(ms))
      .outputs(outPlace(next))
      .action(async (tctx) => {
        const incoming = tctx.input(inPlace);
        const scope = scopeOf(tctx);
        // The wait already happened as the transition's timing; it began `ms` before now.
        record(scope, incoming, scope.epochNow() - ms);
        tctx.output(next, incoming);
      });
    return { inPlace, transitions: [builder.build(), ...extra] };
  }

  // **The wait's end is routed by the net, not by the action.** An action-side wait that the
  // signal cuts short must be canceled *at the sleep* with no record — Mastra leaves
  // `{status: 'waiting'}` and returns the entry canceled (`handlers/entry.ts:605-609,642-643`).
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

    // Decide, then emit: resolve and wait first, where a throw writes nothing. `threw` is a
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
      record(scopeOf(tctx), done, done.startedAt ?? scopeOf(tctx).epochNow());
      tctx.output(next, { ...carried(done), data: done.data });
    });
  if (cancel !== undefined) {
    resume.inhibitor(cancel);
    extra.push(sweep(ctx.names.entryTransition(ctx.path, entry.id, 'cancel-waited'), waited, cancel, ctx.exits, entry.id, viewPath));
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
): Transition {
  return Transition.builder(name)
    .inputs(one(from))
    .read(cancel)
    .outputs(outPlace(exits.canceled))
    .action(async (tctx) => {
      const incoming = tctx.input(from);
      tctx.output(exits.canceled, { origin: withIndex({ stepId, path }, incoming) });
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
  const { stepId, path, source, attempt, from, next, exits, retry } = spec;
  return async (tctx) => {
    const incoming = tctx.input(from) as RetryToken;
    const scope = scopeOf(tctx);
    // Stamped once, by the first attempt, and carried on the retry token: Mastra takes the step's
    // start before its retry loop (`handlers/step.ts:166,174`).
    const startedAt = incoming.startedAt ?? scope.epochNow();

    let outcome: StepOutcome;
    try {
      outcome = await scope.runner.run(stepId, incoming.data, {
        ...viewOf(scope, path),
        source,
        attempt,
        ...(incoming.foreachIndex === undefined ? {} : { foreachIndex: incoming.foreachIndex }),
      });
      if (outcome === null || typeof outcome !== 'object' || !OUTCOME_STATUSES.has((outcome as { status: unknown }).status as string)) {
        throw new Error(`runner returned an unrecognised outcome for step '${stepId}': ${describe(outcome)}`);
      }
    } catch (error) {
      // A runner that throws is a failed step, not a lost token — and, like a step whose
      // `execute` throws in Mastra, it is retryable.
      outcome = { status: 'failed', error };
    }

    if (outcome.status === 'failed' && retry !== undefined && outcome.nonRetryable !== true) {
      const carry: RetryToken = { ...incoming, startedAt };
      tctx.output(retry, carry);
      return;
    }

    const metadata = {
      ...(incoming.iteration === undefined ? {} : { iterationCount: incoming.iteration }),
      ...(incoming.foreachIndex === undefined ? {} : { foreachIndex: incoming.foreachIndex }),
    };
    // A suspended or paused step has not ended: Mastra stamps `suspendedAt` and no `endedAt`
    // (`handlers/step.ts:516-526`).
    const now = scope.epochNow();
    const when =
      outcome.status === 'suspended' ? { suspendedAt: now } : outcome.status === 'paused' ? {} : { endedAt: now };
    scope.recordStepResult(stepId, {
      ...outcome,
      payload: incoming.data,
      startedAt,
      ...when,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    });

    const origin = withIndex({ stepId, path }, incoming);
    switch (outcome.status) {
      case 'success':
        // The item's index and the iteration ride on, so the combinator that started the step can
        // tell its results apart without trusting the step's output.
        tctx.output(next, { ...carried(incoming), data: outcome.output });
        return;
      case 'failed':
        tctx.output(exits.failed, {
          ...origin,
          error: outcome.error,
          ...(outcome.tripwire === undefined ? {} : { tripwire: outcome.tripwire }),
          ...(outcome.nonRetryable === true ? { nonRetryable: true as const } : {}),
        });
        return;
      case 'bailed':
        tctx.output(exits.bailed, { ...origin, output: outcome.output });
        return;
      case 'suspended':
        tctx.output(exits.suspended, { ...origin, payload: outcome.suspendPayload });
        return;
      case 'paused':
        tctx.output(exits.paused, origin);
        return;
    }
  };
}

/**
 * A flow token between attempts of one step. `startedAt` exists only on the retry chain's own
 * places; `carried()` never copies it, so it cannot leak downstream.
 */
type RetryToken = FlowToken & { readonly startedAt?: number };

/** The ride-along fields of a flow token, without its data. */
function carried(incoming: FlowToken): Omit<FlowToken, 'data'> {
  return {
    ...(incoming.foreachIndex === undefined ? {} : { foreachIndex: incoming.foreachIndex }),
    ...(incoming.iteration === undefined ? {} : { iteration: incoming.iteration }),
  };
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

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
import { scopeOf, viewOf } from '../scope.js';
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
  const { names, path, exits } = ctx;
  const inPlace = place<FlowToken>(names.entryIn(path, entry.id));
  const transitions: Transition[] = [];

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

    transitions.push(
      Transition.builder(attempt === 0 ? names.entryRun(path, entry.id) : names.entryTransition(path, entry.id, `run-${attempt}`))
        .inputs(one(attemptIn))
        .outputs(xor(...outcomes))
        .action(stepAction({ stepId: entry.id, path, source, attempt, from: attemptIn, next, exits, retry }))
        .build(),
    );

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

  const inPlace = place<FlowToken>(ctx.names.entryIn(ctx.path, entry.id));
  const builder = Transition.builder(ctx.names.entryWake(ctx.path, entry.id)).inputs(one(inPlace));

  if (entry.kind === 'sleep' && 'fixed' in wait) {
    builder
      .timing(delayed(wait.fixed))
      .outputs(outPlace(next))
      .action(async (tctx) => {
        const incoming = tctx.input(inPlace);
        scopeOf(tctx).recordStepResult(entry.id, { status: 'success', output: incoming.data });
        tctx.output(next, incoming);
      });
    return { inPlace, transitions: [builder.build()] };
  }

  const failed = ctx.exits.failed;
  builder.outputs(xor(outPlace(next), outPlace(failed))).action(async (tctx) => {
    const incoming = tctx.input(inPlace);
    const scope = scopeOf(tctx);

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
        resolved = await resolve.call(scope.runner, entry.id, incoming.data, viewOf(scope, ctx.path));
      }
      await scope.wait(resolveWaitMs(entry.kind, entry.id, resolved, scope.epochNow()));
    } catch (e) {
      threw = true;
      error = e;
    }

    if (threw) {
      // Mastra has no status here: a throwing sleep `fn` rejects `run.start()` outright
      // (`handlers/sleep.ts:83-128`). Failing the run is the nearest outcome a net can declare.
      tctx.output(failed, { stepId: entry.id, error });
      return;
    }
    scope.recordStepResult(entry.id, { status: 'success', output: incoming.data });
    tctx.output(next, incoming);
  });
  return { inPlace, transitions: [builder.build()] };
};

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
    const incoming = tctx.input(from);
    const scope = scopeOf(tctx);

    let outcome: StepOutcome;
    try {
      outcome = await scope.runner.run(stepId, incoming.data, { ...viewOf(scope, path), source, attempt });
      if (outcome === null || typeof outcome !== 'object' || !OUTCOME_STATUSES.has((outcome as { status: unknown }).status as string)) {
        throw new Error(`runner returned an unrecognised outcome for step '${stepId}': ${describe(outcome)}`);
      }
    } catch (error) {
      // A runner that throws is a failed step, not a lost token — and, like a step whose
      // `execute` throws in Mastra, it is retryable.
      outcome = { status: 'failed', error };
    }

    if (outcome.status === 'failed' && retry !== undefined && outcome.nonRetryable !== true) {
      tctx.output(retry, { data: incoming.data });
      return;
    }

    scope.recordStepResult(stepId, outcome);
    switch (outcome.status) {
      case 'success':
        tctx.output(next, { data: outcome.output });
        return;
      case 'failed':
        tctx.output(
          exits.failed,
          outcome.tripwire === undefined
            ? { stepId, error: outcome.error }
            : { stepId, error: outcome.error, tripwire: outcome.tripwire },
        );
        return;
      case 'bailed':
        tctx.output(exits.bailed, { stepId, output: outcome.output });
        return;
      case 'suspended':
        tctx.output(
          exits.suspended,
          outcome.output === undefined
            ? { stepId, path, payload: outcome.payload }
            : { stepId, path, payload: outcome.payload, output: outcome.output },
        );
        return;
      case 'paused':
        tctx.output(exits.paused, { stepId, path });
        return;
    }
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

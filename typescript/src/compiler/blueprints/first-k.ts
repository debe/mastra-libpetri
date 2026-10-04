import { Transition, and, exactly, one, outPlace, place, type Place } from 'libpetri';
import type { EntryPath } from '../names.js';
import { StepPreemptedError } from '../preempt.js';
import { scopeOf, type RunScope } from '../scope.js';
import type {
  BailToken,
  BlockDecision,
  CanceledToken,
  DecisionSite,
  Exits,
  FailureToken,
  FlowToken,
  PauseToken,
  PlaceClaim,
  PreemptedToken,
  StepOutcome,
  StepRecord,
  SuspendToken,
} from '../types.js';
import { admissionClaims, admissionPools, admit, bindingLimit, blockAdmission, collect } from '../gadgets/admission.js';
import type { ArmPreemption, Gadget } from '../gadgets/types.js';

/**
 * One declared arm's status as it **arrived** at the block, as {@link QuorumNotMetError} reports it
 * ([ADR 0014]): read from the token its collect took, before the join rewrites a suspended loser's
 * record `canceled`. So `suspended` (the arm suspended; its record now reads `canceled`) and
 * `preempted` (the arm left by its `preempted` branch; its record was `canceled` from the start) stay
 * distinguishable, where the records alone would read `canceled` for both.
 */
export interface ArmStatus {
  readonly stepId: string;
  readonly index: number;
  readonly status: StepOutcome['status'] | 'preempted';
}

/**
 * A `race` / `quorum` block that ended with fewer than `k` successes and **no failed arm** ([ADR
 * 0014]): every miss was a bail, a pause, a suspension or a preemption. When an arm failed, the block
 * forwards the lowest-index failure unchanged instead — `tripwire` included — as `.parallel()`'s join
 * does, and this error is never built.
 *
 * Host-free, so the decision gadget constructs it; the Mastra layer re-exports it. It is the `error`
 * of the block's `exits.failed` token, not retried (a block is not a step).
 */
export class QuorumNotMetError extends Error {
  override readonly name = 'QuorumNotMetError';
  constructor(
    readonly blockId: string,
    /** The block's view path — Mastra's `executionPath`. */
    readonly path: EntryPath,
    /** `k`: the successes the block needed. */
    readonly need: number,
    /** How many arms succeeded: always below `need`. */
    readonly succeeded: number,
    /** Every declared arm, in arm order, with its arrival status (pre-rewrite, see {@link ArmStatus}). */
    readonly statuses: readonly ArmStatus[],
  ) {
    super(
      `block '${blockId}' at [${path.join(', ')}] needed ${need} of ${statuses.length} arms to succeed, ` +
        `${succeeded} did: ${statuses.map((s) => `${s.stepId}=${s.status}`).join(', ')}`,
    );
  }
}

/**
 * The bound `settled` is claimed at ([ADR 0014], amended): after `met`, the `n − k` surplus arrivals;
 * after `short`, the `k − 1`. Never both. It is 0 only for `n = 1` (`k = 1`), and then the place is
 * not emitted (`DecisionSite.settled` is `undefined`) and no bound is claimed.
 */
export function settledBound(decision: BlockDecision, n: number): number {
  return Math.max(n - decision.k, decision.k - 1);
}

/**
 * `.parallel()` with a counted decision ([ADR 0014], amended 2026-10-04) — `race` and `quorum(k)`.
 * `parallelGadget` delegates here when the entry carries `decision`; the M10 candidate, so it reads
 * nothing but the description and the context.
 *
 * ```text
 *   in --(fork, inhibitor cancel)--> armIn_* (or q_0 under concurrency) + permit
 *   armIn_i -> [step i, every attempt with a `preempted` branch] -> armDone_i | arm exits | arm-i-preempted
 *   armDone_i         --(collect-i)-----------> okSeen {index, data}       (slot back under concurrency)
 *   arm{err,bail,susp,pause} --(collect-*)----> miss {status, token}
 *   arm-i-preempted   --(collect-preempted-i)-> miss {preempted, index}
 *   permit + exactly(k, okSeen)      --(met)----> won   {winners, FIFO}   action: scope.preempt(path, reason)
 *   permit + exactly(n-k+1, miss)    --(short)--> short {misses}          action: scope.preempt(path, reason)
 *   one(okSeen|miss) + read(won)   --(absorb-*-won)---> settled   (omitted when k = n)
 *   one(okSeen|miss) + read(short) --(absorb-*-short)-> settled   (omitted when k = 1)
 *   won   + exactly(n-k, settled)  --(join-met)---> next          output from step records
 *   short + exactly(k-1, settled)  --(join-short)-> exits.failed  lowest-index failure, else QuorumNotMetError
 * ```
 *
 * `met` / `short` build one `StepPreemptedError(blockId, path, 'met' | 'short')` and call
 * `scope.preempt(path, reason)`. A count of 0 omits its arc and a dead absorb pair is not emitted —
 * see `DecisionSite`. For `n = 1` the arm gets no preemption (no `preempted` place, no collect, no
 * `scope.preempt` call) and `settled` is not emitted.
 *
 * **The join's record rewrite.** Each suspended loser's record is rewritten `canceled` with the
 * block's `StepPreemptedError` as `reason`, and `scope.forgetSuspension(stepId)` drops its resume
 * labels, in the same firing. A nested child's own suspended snapshot stays (row 107).
 *
 * Claims it returns: `okSeen`, `miss` at `n`; `settled` at {@link settledBound}; the arm exits as
 * `.parallel()` claims them; `exclusions: [{ a: won, b: short }]`; and one {@link DecisionSite}.
 * `permit`, `won`, `short` and each `arm-i-preempted` keep the default bound 1. `settled` is
 * claimed only when emitted (`n ≥ 2`).
 *
 * Each arm is emitted through `ctx.emitNested(…, { preempt })`, so its leaf adds the `preempted`
 * branch to every attempt and hands the attempt `StepCall.preempt`.
 */
export const firstKGadget: Gadget = (entry, next, ctx) => {
  if (entry.kind !== 'parallel' || entry.decision === undefined) {
    throw new Error(`firstKGadget('${entry.id}'): expects a .parallel() entry carrying a decision, got '${entry.kind}'`);
  }
  const { names, path, viewPath, cancel } = ctx;
  const arms = entry.arms;
  const n = arms.length;
  const k = entry.decision.k;
  // The adapter refuses both first (`race-empty`, `quorum-value`); a hand-built description that
  // slips past is refused here by name, never compiled into a net whose counts make no sense.
  if (n === 0) throw new Error(`block '${entry.id}': a race / quorum decision over no arms (race-empty)`);
  if (!Number.isSafeInteger(k) || k < 1 || k > n) {
    throw new Error(`block '${entry.id}': the decision's k is ${String(k)}; it must be a whole number in [1, ${n}] (quorum-value)`);
  }

  const role = (r: string): string => names.entryPlace(path, entry.id, r);
  const tname = (r: string): string => names.entryTransition(path, entry.id, r);
  // The block's own limit, where it binds ([ADR 0011]) — the same admission `.parallel()` compiles.
  const admission = blockAdmission(names, path, entry.id, bindingLimit(entry.id, entry.concurrency, n));
  const inPlace = place<FlowToken>(names.entryIn(path, entry.id));

  // --- decision places -------------------------------------------------------------------------
  /** The one decision right: seeded by `fork`, consumed by `met` or `short`. */
  const permit = place<null>(role('permit'));
  const okSeen = place<OkArrival>(role('ok-seen'));
  const miss = place<MissArrival>(role('miss'));
  const won = place<Won>(role('won'));
  const short = place<Short>(role('short'));
  /** The surplus absorbed after the decision; not emitted for `n = 1` (bound 0). */
  const settled = n >= 2 ? place<Arrival>(role('settled')) : undefined;

  /**
   * The arms' exits, shared by every arm as `.parallel()`'s are: no arm decides the run while its
   * siblings run. `canceled` is the enclosing exit and is never written — arms carry no cancel.
   */
  const armExits: Exits = {
    failed: place<FailureToken>(role('arm-err')),
    bailed: place<BailToken>(role('arm-bail')),
    suspended: place<SuspendToken>(role('arm-susp')),
    paused: place<PauseToken>(role('arm-pause')),
    canceled: ctx.exits.canceled,
  };

  /** The arm an outcome came from: its view path's element just below the block's own. */
  const armIndex = (o: { readonly path: EntryPath }): number => o.path[viewPath.length] ?? n;

  // --- arms and their collects ----------------------------------------------------------------
  const armIns: Place<FlowToken>[] = [];
  const collectOk: Transition[] = [];
  const preemptedPlaces: Place<PreemptedToken>[] = [];
  const collectPreempted: Transition[] = [];
  for (let i = 0; i < n; i++) {
    const armDone = place<FlowToken>(role(`arm-${i}-done`));
    // A block of one arm has no other arm to decide first, so it gets no preemption at all.
    let preempt: ArmPreemption | undefined;
    if (n >= 2) {
      const at = place<PreemptedToken>(role(`arm-${i}-preempted`));
      preemptedPlaces.push(at);
      preempt = { place: at, block: path, blockId: entry.id };
    }
    const arm = ctx.emitNested(arms[i]!, [...path, i], armDone, armExits, {
      viewPath: [...viewPath, i],
      ...(preempt === undefined ? {} : { preempt }),
    });
    armIns.push(arm.inPlace);
    collectOk.push(
      collect(admission, tname(`collect-${i}`), armDone, [okSeen], (tctx, done) => {
        tctx.output(okSeen, { status: 'success', index: i, data: done.data });
      }),
    );
    if (preempt !== undefined) {
      const from = preempt.place;
      collectPreempted.push(
        collect(admission, tname(`collect-preempted-${i}`), from, [miss], (tctx, token) => {
          tctx.output(miss, { status: 'preempted', index: i, token });
        }),
      );
    }
  }

  // Every other miss: one collect per kind, shared by the arms, as `.parallel()`'s.
  const collectMissKinds = [
    collect(admission, tname('collect-err'), armExits.failed, [miss], (tctx, token) => {
      tctx.output(miss, { status: 'failed', index: armIndex(token), token });
    }),
    collect(admission, tname('collect-bail'), armExits.bailed, [miss], (tctx, token) => {
      tctx.output(miss, { status: 'bailed', index: armIndex(token), token });
    }),
    collect(admission, tname('collect-susp'), armExits.suspended, [miss], (tctx, token) => {
      tctx.output(miss, { status: 'suspended', index: armIndex(token), token });
    }),
    collect(admission, tname('collect-pause'), armExits.paused, [miss], (tctx, token) => {
      tctx.output(miss, { status: 'paused', index: armIndex(token), token });
    }),
  ];

  // --- start: fork (+ admission) and the cancel sweep -----------------------------------------
  const cursors: Place<FlowToken>[] =
    admission === undefined ? [] : arms.map((_, j) => place<FlowToken>(role(`q-${j}`)));
  const admits: Transition[] =
    admission === undefined
      ? []
      : arms.map((_, j) =>
          admit(
            admission,
            tname(`admit-${j}`),
            cursors[j]!,
            armIns[j]!,
            j + 1 < n ? { place: cursors[j + 1]!, pass: ({ data }) => ({ data }) } : undefined,
          ),
        );
  const starts = admission === undefined ? armIns : [cursors[0]!];
  const forkBuilder = Transition.builder(tname('fork'))
    .inputs(one(inPlace))
    // One branch, exactly the set the action writes ([IO-015]): every arm (or the cursor) and the
    // one decision right.
    .outputs(and(...starts.map(outPlace), outPlace(permit)))
    .action(async (tctx) => {
      const { data } = tctx.input(inPlace);
      for (const start of starts) tctx.output(start, { data });
      tctx.output(permit, null);
    });
  if (cancel !== undefined) forkBuilder.inhibitor(cancel);
  const fork = forkBuilder.build();
  const cancelSweep: Transition[] =
    cancel === undefined ? [] : [sweep(tname('cancel'), inPlace, cancel, ctx.exits.canceled, entry.id, viewPath)];

  // --- the decision ------------------------------------------------------------------------------
  /** Builds the block's reason and preempts its unsettled arms — none to preempt when `n = 1`. */
  const decide = (scope: RunScope, outcome: 'met' | 'short'): StepPreemptedError => {
    const reason = new StepPreemptedError(entry.id, viewPath, outcome);
    if (n >= 2) scope.preempt(path, reason);
    return reason;
  };

  const met = Transition.builder(tname('met'))
    .inputs(one(permit), exactly(k, okSeen))
    .outputs(outPlace(won))
    .action(async (tctx) => {
      tctx.input(permit);
      // `exactly` takes the FIFO head ([IO-002]): the first k successes in collect order win.
      const winners = tctx.inputs(okSeen);
      const reason = decide(scopeOf(tctx), 'met');
      tctx.output(won, { winners, reason });
    })
    .build();

  const shortT = Transition.builder(tname('short'))
    .inputs(one(permit), exactly(n - k + 1, miss))
    .outputs(outPlace(short))
    .action(async (tctx) => {
      tctx.input(permit);
      const misses = tctx.inputs(miss);
      const reason = decide(scopeOf(tctx), 'short');
      tctx.output(short, { misses, reason });
    })
    .build();

  // A dead pair is not emitted: after `met` at k = n nothing is left, after `short` at k = 1 neither.
  const absorbs: Transition[] = [];
  const absorb = <T extends Arrival>(name: string, from: Place<T>, decided: Place<unknown>): Transition =>
    Transition.builder(tname(name))
      .inputs(one(from))
      .read(decided)
      .outputs(outPlace(settled!))
      .action(async (tctx) => {
        tctx.output(settled!, tctx.input(from));
      })
      .build();
  if (settled !== undefined) {
    if (k < n) absorbs.push(absorb('absorb-ok-won', okSeen, won), absorb('absorb-miss-won', miss, won));
    if (k > 1) absorbs.push(absorb('absorb-ok-short', okSeen, short), absorb('absorb-miss-short', miss, short));
  }

  // --- the joins -------------------------------------------------------------------------------
  /**
   * The join's rewrite ([ADR 0014]): every arm that arrived suspended is a loser, and its record is
   * rewritten `canceled` with the block's reason, its resume labels dropped — in the join's firing.
   */
  const rewriteSuspended = async (scope: RunScope, arrivals: readonly Arrival[], reason: StepPreemptedError): Promise<void> => {
    for (const arrival of arrivals) {
      if (arrival.status !== 'suspended') continue;
      const { stepId } = arrival.token;
      const prior = scope.getStepResult(stepId);
      // Only the suspension this arm wrote: a record another writer replaced since is left alone.
      if (prior?.status !== 'suspended') continue;
      const record = canceledFrom(prior, reason, scope.epochNow());
      scope.recordStepResult(stepId, record);
      scope.forgetSuspension(stepId);
      const observed = scope.observe({ kind: 'step-settled', stepId, path: arrival.token.path, record });
      if (observed !== undefined) await observed;
    }
  };

  const settledIn = (count: number) => (settled === undefined || count === 0 ? [] : [exactly(count, settled)]);

  const joinMet = Transition.builder(tname('join-met'))
    .inputs(one(won), ...settledIn(n - k))
    .outputs(outPlace(next))
    .action(async (tctx) => {
      const scope = scopeOf(tctx);
      const { winners, reason } = tctx.input(won);
      const rest = settled === undefined || n - k === 0 ? [] : tctx.inputs(settled);
      await rewriteSuspended(scope, rest, reason);
      let data: Record<string, unknown>;
      if (ctx.nextIsResult) {
        // The block's own output: the arms that succeeded — winners and any surplus success that
        // settled before its preemption — in arm order. `fromEntries`, never `record[id] =`.
        const byIndex = new Map<number, unknown>();
        for (const a of [...winners, ...rest]) if (a.status === 'success') byIndex.set(a.index, a.data);
        data = Object.fromEntries(
          arms.flatMap((arm, i) => (byIndex.has(i) ? [[arm.id, byIndex.get(i)] as const] : [])),
        );
      } else {
        // What the next entry receives: every declared arm, read from the step records, as
        // `getStepOutput` rebuilds it on a restart. A loser's key is present and `undefined`.
        data = Object.fromEntries(arms.map((arm) => [arm.id, outputOf(scope.getStepResult(arm.id))]));
      }
      tctx.output(next, { data });
    })
    .build();

  const joinShort = Transition.builder(tname('join-short'))
    .inputs(one(short), ...settledIn(k - 1))
    .outputs(outPlace(ctx.exits.failed))
    .action(async (tctx) => {
      const scope = scopeOf(tctx);
      const { misses, reason } = tctx.input(short);
      const rest = settled === undefined || k - 1 === 0 ? [] : tctx.inputs(settled);
      const arrivals: Arrival[] = [...misses, ...rest];
      await rewriteSuspended(scope, arrivals, reason);
      // The lowest-index failure, forwarded unchanged (tripwire included), as `.parallel()`'s join.
      let failure: FailureToken | undefined;
      let failureIndex = n;
      for (const a of arrivals) {
        if (a.status === 'failed' && a.index < failureIndex) {
          failure = a.token;
          failureIndex = a.index;
        }
      }
      if (failure === undefined) {
        const byIndex = new Map(arrivals.map((a) => [a.index, a.status] as const));
        const statuses: ArmStatus[] = arms.map((arm, i) => ({ stepId: arm.id, index: i, status: byIndex.get(i) ?? 'preempted' }));
        const succeeded = arrivals.filter((a) => a.status === 'success').length;
        failure = {
          stepId: entry.id,
          path: viewPath,
          error: new QuorumNotMetError(entry.id, viewPath, k, succeeded, statuses),
        };
      }
      tctx.output(ctx.exits.failed, failure);
    })
    .build();

  const site: DecisionSite = {
    path,
    blockId: entry.id,
    k,
    n,
    permit: permit.name,
    okSeen: okSeen.name,
    miss: miss.name,
    won: won.name,
    short: short.name,
    settled: settled?.name,
    preempted: preemptedPlaces.map((p) => p.name),
    met: met.name,
    shortTransition: shortT.name,
    collectOk: collectOk.map((t) => t.name),
    collectMiss: [...collectMissKinds, ...collectPreempted].map((t) => t.name),
    collectPreempted: collectPreempted.map((t) => t.name),
    absorbs: absorbs.map((t) => t.name),
    joinMet: joinMet.name,
    joinShort: joinShort.name,
  };

  const claims: PlaceClaim[] = [
    ...[okSeen, miss, armExits.failed, armExits.bailed, armExits.suspended, armExits.paused].map((p) => ({
      place: p.name,
      bound: n,
      why: `one settlement per arm (${n} arms)`,
    })),
    ...(settled === undefined
      ? []
      : [{ place: settled.name, bound: settledBound(entry.decision, n), why: `the surplus after met (n − k = ${n - k}) or short (k − 1 = ${k - 1})` }]),
    ...admissionClaims(admission),
  ];

  // The arms' own transitions are not returned: `emitNested` recorded them against their own entry.
  return {
    inPlace,
    claims,
    exclusions: [{ a: won.name, b: short.name, why: 'met and short both consume the one decision permit' }],
    pools: admissionPools(admission),
    decisions: [site],
    transitions: [
      fork,
      ...admits,
      ...cancelSweep,
      ...collectOk,
      ...collectMissKinds,
      ...collectPreempted,
      met,
      shortT,
      ...absorbs,
      joinMet,
      joinShort,
    ],
  };
};

// --- tokens ------------------------------------------------------------------------------------

/** A success, as its collect saw it: arm `index`'s output. */
interface OkArrival {
  readonly status: 'success';
  readonly index: number;
  readonly data: unknown;
}

/** A miss, with the token the arm left by — forwarded unchanged when it is the reported failure. */
type MissArrival =
  | { readonly status: 'failed'; readonly index: number; readonly token: FailureToken }
  | { readonly status: 'bailed'; readonly index: number; readonly token: BailToken }
  | { readonly status: 'suspended'; readonly index: number; readonly token: SuspendToken }
  | { readonly status: 'paused'; readonly index: number; readonly token: PauseToken }
  | { readonly status: 'preempted'; readonly index: number; readonly token: PreemptedToken };

type Arrival = OkArrival | MissArrival;

/** `won`: the first k successes in collect order, and the reason `met` preempted the rest with. */
interface Won {
  readonly winners: readonly OkArrival[];
  readonly reason: StepPreemptedError;
}

/** `short`: the n − k + 1 misses that decided it, and the reason `short` preempted the rest with. */
interface Short {
  readonly misses: readonly MissArrival[];
  readonly reason: StepPreemptedError;
}

// --- helpers -----------------------------------------------------------------------------------

/**
 * A suspended loser's record, rewritten `canceled` ([ADR 0014]): its input, start and metadata kept,
 * every suspension field dropped, ended now, with the block's reason.
 */
function canceledFrom(prior: StepRecord, reason: StepPreemptedError, endedAt: number): StepRecord {
  const p = prior as { payload?: unknown; startedAt?: number; metadata?: StepRecord['metadata'] };
  return {
    status: 'canceled',
    reason,
    payload: p.payload,
    ...(p.startedAt === undefined ? {} : { startedAt: p.startedAt }),
    endedAt,
    ...(p.metadata === undefined ? {} : { metadata: p.metadata }),
  };
}

/**
 * Mastra's `stepResults[id]?.output` (`default.ts:1141-1149`), as `.parallel()`'s join reads it: a
 * success's or a bail's `output`; a loser's `canceled` record has none, so its key is `undefined`.
 */
function outputOf(record: StepRecord | undefined): unknown {
  switch (record?.status) {
    case 'success':
    case 'bailed':
    case 'canceled':
      return record.output;
    default:
      return undefined;
  }
}

/** The block's cancellation sweep, as `.parallel()`'s: the input never reaches `fork`. */
function sweep(
  name: string,
  from: Place<FlowToken>,
  cancel: Place<null>,
  canceled: Place<CanceledToken>,
  stepId: string,
  path: EntryPath,
): Transition {
  return Transition.builder(name)
    .inputs(one(from))
    .read(cancel)
    .outputs(outPlace(canceled))
    .action(async (tctx) => {
      tctx.input(from);
      tctx.output(canceled, { origin: { stepId, path }, started: false });
    })
    .build();
}

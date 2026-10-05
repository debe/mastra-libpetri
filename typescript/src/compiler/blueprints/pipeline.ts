import { Transition, and, one, outPlace, place, xor, type Place, type TransitionContext } from 'libpetri';
import { scopeOf, type RunScope } from '../scope.js';
import {
  MAX_FOREACH_LANES,
  THREE_SETTLES,
  cancelSweep,
  canceledAggregate,
  cons,
  failedAggregate,
  finisherTransitions,
  flagPair,
  framePlaces,
  hostRefusal,
  itemRecordsOf,
  laneExits,
  openedOut,
  settleInto,
  settleSuffix,
  settleTransitions,
  splitAction,
  successAggregate,
  suspendedAggregate,
  takeAll,
  unlessCanceledBy,
  writeAggregate,
  type FinisherFlag,
  type FlagState,
  type ForeachCursor,
  type ForeachFrame,
  type LanePermit,
} from '../gadgets/foreach-frame.js';
import type { Gadget } from '../gadgets/types.js';
import type {
  EntryDescription,
  Exits,
  FailureToken,
  FlowToken,
  ForeachMeta,
  PipelineLaneSite,
  PipelineSite,
  StepRecord,
  SuspendToken,
} from '../types.js';

/**
 * What a pipeline lane is working on: the item, its index `k` and when stage 0 admitted it. Its
 * presence *is* "this lane is busy". A hand-off moves it, unchanged, to the next stage's lane, so
 * the item keeps one slot from `start` to the settle or drop that ends it (structure rule 3). The
 * item's `foreachOutput` entry is built from it — the twin's nested-step record runs from the item's
 * start, not from the stage's.
 */
export interface PipelineSlot {
  readonly item: unknown;
  readonly k: number;
  readonly startedAt: number;
}

/**
 * `pipeline()` ([ADR 0015], amended by the W0 spike): a `.foreach()` whose items run a chain of
 * stages, `c_j` lanes per stage, each item handed lane to lane — stage `j + 1` of one item runs
 * while stage `j` of another does. Host-free (an M10 candidate), as `firstKGadget` is; `foreachGadget`
 * delegates here when the entry carries a `pipeline`, as `parallelGadget` delegates to `firstKGadget`.
 *
 * ```text
 * cancel                      ?cancel   in -> exits.canceled                         (only with a signal)
 * split                       ¬cancel   in -> xor(open(queue.open) | open(queue.closed) | exits.failed)
 *                                       open(q) = frame + q + no-fault + no-susp + every permit
 * stage0.lane{l}.start        ¬cancel   queue.open + permit_{0,l} -> body_{0,l} + slot_{0,l} + queue.{open|closed}
 * stage0.lane{l}.refuse       ?cancel   queue.open + permit_{0,l} -> queue.closed + permit_{0,l}
 * stage{j}.lane{l}.to{m}      ¬cancel   done_{j,l} + slot_{j,l} + permit_{j+1,m}
 *                                       -> body_{j+1,m} + slot_{j+1,m} + permit_{j,l}          (j < s-1)
 * stage{s-1}.lane{l}.collect  ¬cancel   done + slot + frame -> frame + permit
 * stage{j}.lane{l}.bail       ¬cancel   bailed + slot + frame -> frame + permit
 * stage{j}.lane{l}.pause      ¬cancel   paused + slot + frame -> frame + permit
 * stage{j}.lane{l}.{fail|suspend}[.queue-closed[.again]]   ¬cancel, priority 1
 *                                       exit + slot + frame + queue.{open|closed} + {no-K|K}
 *                                       -> frame + permit + queue.closed + K   (three variants)
 * stage{j}.lane{l}.drop.{done,failed,bailed,suspended,paused}  ?cancel   exit + slot -> permit
 * join, fail.{clean,s}, suspend, canceled.{clean,f,s,fs}
 *                                       queue.closed + frame + every permit + the flags -> next | exits.*
 * ```
 * (`¬` an inhibitor arc on `wf.cancel`, `?` a read arc on it; those arcs exist only given a signal.
 * Every other arc takes one token.)
 *
 * **Lanes.** Stage `j`, lane `l` is flattened to `L = Σ_{i<j} c_i + l`; its places and transitions
 * are named `stage{j}.lane{l}.*` under the foreach, and its body is `ctx.emitNested(stages[j],
 * [...path, L], done, exits, { viewPath, item: true })`: named at `[i, L]`, viewed at the foreach's
 * `[i]`, so the runner and suspension coverage keep a foreach's `[i, lane]` shape. The body is
 * emitted without the signal — a running stage is never interrupted; Mastra checks only between
 * entries — so its local `canceled` exit is unreachable, as the foreach's is.
 *
 * **Item scope** (maintainer decision 3). `start` opens item `k`'s store
 * (`RunScope.itemRecords(viewPath, k).open(item)`), every stage's leaf reads and records there, and
 * whatever ends the item forgets it: `'discard'` at a fail settle (the twin merges nothing from a
 * child that threw), `'merge'` at a collect, a bail, a pause, a suspend settle and every drop (the
 * twin's `setState(res.state)` on every non-throwing return, the ADR's amendment).
 *
 * **Hand-offs** are a rendezvous: stage `j`'s finished lane holds its slot and its `done` until a
 * stage-`j + 1` lane frees. Hold-and-wait, but stage order is acyclic, the last stage collects,
 * settles or drops unconditionally, and a waiting lane holds no run permit and no quota (the leaf
 * returns both per attempt), so there is no circular wait. Hand-offs never take the frame, so items
 * at different stages do not serialize; they read no flag, so a failure drains every item already
 * admitted through every remaining stage, as the twin's children never see `killQueue()`.
 *
 * **Outcomes.** A last-stage success collects `results[k] = output`. A bail ends the item as a success
 * carrying the bail output, later stages skipped, the queue untouched — the twin's child turns its
 * `bailed` into `success` (`default.ts:926-928`). A pause leaves a hole (the twin's child returns
 * `undefined`; unreachable in wave 1). A failure or suspension settles at priority 1, takes the queue
 * and raises its flag. Each item's `foreachOutput` entry is recorded under the body id and published
 * as the item's progress, as Mastra's worker does (`:1179`, `:1117-1152`). After the drain:
 * canceled, then the first failure in time, then the lowest suspended index, else success.
 *
 * **Cancel** ([ADR 0004]). `split`, `start`, every hand-off and every frame-writing collect and
 * settle are inhibited; `refuse` closes the queue (the worker's check, `:1157-1172`); each lane exit
 * has a `drop` that returns the permit and writes nothing — the child's per-entry check
 * (`default.ts:815`) and entry-end re-stamp (`handlers/entry.ts:815-817`) make every unsettled item a
 * hole. `canceled.*` reports the partial array.
 *
 * **Bounded, monotone.** Every place holds at most one token — results and recorded outcomes ride the
 * frame; per lane exactly one of `permit` / `slot` is marked from `split` to the finisher — and no
 * pipeline place carries an inhibitor, reset, `all()`, drain or `atLeast()`: the only non-monotone
 * place stays `wf.cancel`, so under [VER-004] the only split is `t.cancel.arrive`. The open-queue
 * `.again` settle is not emitted: `exclusive(queue.open, K)` makes it dead (the W0 amendment). No
 * exit pair, no resume place, no window pool; no resume site is registered — a resume at the
 * pipeline is refused by name.
 *
 * Throws, naming the foreach, on a description the adapter would have refused: no stages
 * (`pipeline-empty`), a bound not a whole number ≥ 1, a bound vector whose length is not `s`, Σc_j
 * above `MAX_FOREACH_LANES` or not equal to the entry's `concurrency` (`pipeline-value`).
 */
export const pipelineGadget: Gadget = (entry, next, ctx) => {
  if (entry.kind !== 'foreach') throw new Error(`pipelineGadget received a '${entry.kind}' entry`);
  const { stages, bounds } = pipelineOf(entry);
  const s = stages.length;
  const bodyId = entry.body.id;
  const { names, path, viewPath, exits, cancel } = ctx;

  const p = (role: string): string => names.entryPlace(path, entry.id, role);
  const t = (role: string): string => names.entryTransition(path, entry.id, role);

  const inPlace = place<FlowToken>(names.entryIn(path, entry.id));
  const { frame, queueOpen, queueClosed } = framePlaces<ForeachFrame>(p);
  /** A recorded failure: the queue is killed, and the finisher reports the first in time. */
  const fault = flagPair(p, 'fault');
  /** A recorded suspension: the queue is killed, and the finisher reports the lowest index. */
  const susp = flagPair(p, 'susp');

  interface Lane {
    readonly stage: number;
    readonly lane: number;
    readonly flat: number;
    readonly role: string;
    readonly permit: Place<LanePermit>;
    readonly slot: Place<PipelineSlot>;
    readonly done: Place<FlowToken>;
    readonly out: Exits;
    readonly bodyIn: Place<FlowToken>;
  }

  // Stage-major, so `byStage.flat()[L]` is flattened lane `L`.
  const byStage: Lane[][] = [];
  let flat = 0;
  for (let j = 0; j < s; j++) {
    const row: Lane[] = [];
    for (let l = 0; l < bounds[j]!; l++, flat++) {
      const role = `stage${j}.lane${l}`;
      const r = (x: string): string => p(`${role}.${x}`);
      const done = place<FlowToken>(r('done'));
      const out = laneExits(r);
      const body = ctx.emitNested(stages[j]!, [...path, flat], done, out, { viewPath, item: true });
      row.push({ stage: j, lane: l, flat, role, permit: place<LanePermit>(r('permit')), slot: place<PipelineSlot>(r('slot')), done, out, bodyIn: body.inPlace });
    }
    byStage.push(row);
  }
  const lanes = byStage.flat();
  const permitPlaces = lanes.map((l) => l.permit);
  const everyPermit = lanes.map((l) => one(l.permit));
  /** What the canceled token names: the body the foreach runs, at the foreach's path. */
  const origin = { stepId: bodyId, path: viewPath };
  const unlessCanceled = unlessCanceledBy(cancel);

  const transitions: Transition[] = [];
  const cancelName = cancel === undefined ? undefined : t('cancel');
  if (cancel !== undefined) transitions.push(cancelSweep(cancelName!, inPlace, cancel, exits.canceled, origin));

  // ---------------------------------------------------------------------------------------------
  // split: the frame, the queue, both flags off, every permit of every stage — in one firing.
  // ---------------------------------------------------------------------------------------------
  const opened = (queue: Place<unknown>) => openedOut(frame, queue, [fault.off, susp.off], permitPlaces);
  const splitName = t('split');
  transitions.push(
    unlessCanceled(Transition.builder(splitName))
      .inputs(one(inPlace))
      .outputs(xor(opened(queueOpen), opened(queueClosed), outPlace(exits.failed)))
      .action(
        splitAction(entry.id, bodyId, viewPath, inPlace, exits.failed, (tctx, f, cursor) => {
          tctx.output(frame, f);
          if (cursor === undefined) tctx.output(queueClosed, null);
          else tctx.output(queueOpen, cursor);
          tctx.output(fault.off, null);
          tctx.output(susp.off, null);
          for (const l of lanes) tctx.output(l.permit, null);
        }),
      )
      .build(),
  );

  /** Item `k`'s store, at the foreach's path: what every stage's leaf reads and records through. */
  const itemStore = (scope: RunScope, k: number) => scope.itemRecords(viewPath, k);

  /**
   * The item has left the pipeline: its entry recorded under the body id — Mastra's worker
   * `Object.assign`s each item's result into the step results (`:1179`), and the aggregate later
   * overwrites it — its store forgotten, its state merged or discarded, and its progress published
   * (`:1117-1152`). Returns the frame with the item's `foreachOutput` entry.
   */
  const leave = async (scope: RunScope, f: ForeachFrame, k: number, entryRecord: StepRecord, state: 'merge' | 'discard'): Promise<ForeachFrame> => {
    scope.recordStepResult(bodyId, entryRecord);
    itemStore(scope, k).forget(state);
    const observed = scope.observe({ kind: 'step-settled', stepId: bodyId, path: viewPath, foreachIndex: k, record: entryRecord });
    if (observed !== undefined) await observed;
    return settleInto(f, k, entryRecord);
  };

  /** The fields every item entry shares: the item, its start (stage 0's admission) and its index. */
  const itemBase = (slot: PipelineSlot) => ({ payload: slot.item, startedAt: slot.startedAt, metadata: { foreachIndex: slot.k } });

  const laneSites: PipelineLaneSite[] = [];
  for (const l of lanes) {
    const lt = (x: string): string => t(`${l.role}.${x}`);
    const last = l.stage === s - 1;

    // -- stage 0: start and refuse --------------------------------------------------------------
    let start: string | undefined;
    let refuse: string | undefined;
    if (l.stage === 0) {
      start = lt('start');
      /**
       * Admits the next item into this lane, in input order through the one cursor (fluid, as
       * fastq), and opens its store. The `xor` is "more items" versus "this was the last"; a
       * value-blind analysis that takes the short branch early merely admits fewer items.
       */
      transitions.push(
        unlessCanceled(Transition.builder(start))
          .inputs(one(queueOpen), one(l.permit))
          .outputs(
            xor(
              and(outPlace(l.bodyIn), outPlace(l.slot), outPlace(queueOpen)),
              and(outPlace(l.bodyIn), outPlace(l.slot), outPlace(queueClosed)),
            ),
          )
          .action(async (tctx) => {
            const c: ForeachCursor = tctx.input(queueOpen);
            tctx.input(l.permit);
            const scope = scopeOf(tctx);
            const k = c.next;
            const item = c.items[k];
            itemStore(scope, k).open(item);
            tctx.output(l.bodyIn, { data: item, foreachIndex: k });
            tctx.output(l.slot, { item, k, startedAt: scope.epochNow() });
            if (k + 1 < c.items.length) tctx.output(queueOpen, { ...c, next: k + 1 });
            else tctx.output(queueClosed, null);
          })
          .build(),
      );
      if (cancel !== undefined) {
        refuse = lt('refuse');
        /** The worker's check once the signal has fired (`:1160-1172`): the queue closes, the permit returns. */
        transitions.push(
          Transition.builder(refuse)
            .inputs(one(queueOpen), one(l.permit))
            .read(cancel)
            .outputs(and(outPlace(queueClosed), outPlace(l.permit)))
            .action(async (tctx) => {
              tctx.input(queueOpen);
              tctx.input(l.permit);
              tctx.output(queueClosed, null);
              tctx.output(l.permit, null);
            })
            .build(),
        );
      }
    }

    // -- hand-offs: stage j lane l -> stage j+1 lane m (rendezvous, no buffer) -------------------
    const handoffs: string[] = [];
    if (!last) {
      for (const m of byStage[l.stage + 1]!) {
        const name = lt(`to${m.lane}`);
        handoffs.push(name);
        transitions.push(
          unlessCanceled(Transition.builder(name))
            .inputs(one(l.done), one(l.slot), one(m.permit))
            .outputs(and(outPlace(m.bodyIn), outPlace(m.slot), outPlace(l.permit)))
            .action(async (tctx) => {
              const d = tctx.input(l.done);
              const slot = tctx.input(l.slot);
              tctx.input(m.permit);
              tctx.output(m.bodyIn, { data: d.data, foreachIndex: slot.k });
              tctx.output(m.slot, slot);
              tctx.output(l.permit, null);
            })
            .build(),
        );
      }
    }

    // -- quiet settles: collect (last stage), bail, pause — the frame and the permit -------------
    const quiet = <T>(name: string, from: Place<T>, settle: (scope: RunScope, token: T, slot: PipelineSlot, f: ForeachFrame) => Promise<ForeachFrame>): string => {
      transitions.push(
        unlessCanceled(Transition.builder(name))
          .inputs(one(from), one(l.slot), one(frame))
          .outputs(and(outPlace(frame), outPlace(l.permit)))
          .action(async (tctx) => {
            const token = tctx.input(from);
            const slot = tctx.input(l.slot);
            const f = tctx.input(frame);
            tctx.output(frame, await settle(scopeOf(tctx), token, slot, f));
            tctx.output(l.permit, null);
          })
          .build(),
      );
      return name;
    };
    /** The item succeeded with `value`: `results[k] = value` (a hole when `undefined`, `:1189-1191`). */
    const succeeded = (scope: RunScope, slot: PipelineSlot, f: ForeachFrame, value: unknown): Promise<ForeachFrame> => {
      const entryRecord: StepRecord = { status: 'success', output: value, ...itemBase(slot), endedAt: scope.epochNow() };
      return leave(scope, { ...f, results: cons(f.results, { index: slot.k, value }) }, slot.k, entryRecord, 'merge');
    };
    const collect = last ? quiet(lt('collect'), l.done, (scope, d, slot, f) => succeeded(scope, slot, f, d.data)) : undefined;
    // A bail ends the item as a success carrying the bail output (`default.ts:926-928`, `workflow.ts:3116`).
    const bail = quiet(lt('bail'), l.out.bailed, (scope, b, slot, f) => succeeded(scope, slot, f, b.output));
    // A pause: the twin's child returns `undefined` — a hole, the item a success without output.
    const pause = quiet(lt('pause'), l.out.paused, (scope, _p, slot, f) => succeeded(scope, slot, f, undefined));

    // -- fail and suspend: priority 1, take the queue, raise the flag (three variants each) -------
    const settles = <T>(role: string, from: Place<T>, kind: typeof fault, record: (tctx: TransitionContext, token: T, slot: PipelineSlot, f: ForeachFrame) => Promise<ForeachFrame>) => {
      // Minted once each: the vocabulary refuses a name minted twice.
      const named = THREE_SETTLES.map((variant) => lt(`${role}${settleSuffix(variant)}`));
      transitions.push(
        ...settleTransitions({
          name: (variant) => named[THREE_SETTLES.indexOf(variant)]!,
          variants: THREE_SETTLES,
          gate: unlessCanceled,
          from,
          slot: l.slot,
          frame,
          permit: l.permit,
          queueOpen,
          queueClosed,
          kind,
          record,
        }),
      );
      return [named[0]!, named[1]!, named[2]!] as const;
    };
    const fail = settles('fail', l.out.failed, fault, async (tctx, arrived: FailureToken, slot, f) => {
      const scope = scopeOf(tctx);
      const endedAt = scope.epochNow();
      const { stepStartedAt: _started, stepPayload: _payload, ...rest } = arrived;
      // A host refusal wrote no record: Mastra's worker catches the throw as `thrownResult`
      // (`:1200-1217`) — the error, no payload, stamped now — as the foreach does.
      const refused = hostRefusal(rest);
      const failure: FailureToken = { ...rest, ...(refused === undefined ? {} : { error: refused.cause }), stepId: bodyId, path: viewPath, foreachIndex: slot.k };
      const entryRecord: StepRecord =
        refused !== undefined
          ? { status: 'failed', error: refused.cause, payload: undefined, startedAt: endedAt, endedAt, metadata: { foreachIndex: slot.k } }
          : {
              status: 'failed',
              error: failure.error,
              ...(failure.tripwire === undefined ? {} : { tripwire: failure.tripwire }),
              ...(failure.nonRetryable === true ? { nonRetryable: true } : {}),
              ...itemBase(slot),
              endedAt,
            };
      const withFault: ForeachFrame = { ...f, faults: cons(f.faults, { item: slot.item, startedAt: slot.startedAt, endedAt, failure, entry: entryRecord }) };
      return leave(scope, withFault, slot.k, entryRecord, 'discard');
    });
    const suspend = settles('suspend', l.out.suspended, susp, async (tctx, arrived: SuspendToken, slot, f) => {
      const scope = scopeOf(tctx);
      const { stepStartedAt: _started, stepPayload: _payload, ...rest } = arrived;
      const suspension: SuspendToken = { ...rest, stepId: bodyId, path: viewPath, foreachIndex: slot.k };
      const entryRecord: StepRecord = {
        status: 'suspended',
        suspendPayload: suspension.payload,
        ...itemBase(slot),
        suspendedAt: suspension.suspendedAt ?? scope.epochNow(),
      };
      return leave(scope, { ...f, suspensions: cons(f.suspensions, { suspension }) }, slot.k, entryRecord, 'merge');
    });

    // -- drops under cancel: every lane exit returns its permit and writes nothing ---------------
    let drops: PipelineLaneSite['drops'];
    if (cancel !== undefined) {
      const drop = <T>(kind: string, from: Place<T>): string => {
        const name = lt(`drop.${kind}`);
        transitions.push(
          Transition.builder(name)
            .inputs(one(from), one(l.slot))
            .read(cancel)
            .outputs(outPlace(l.permit))
            .action(async (tctx) => {
              tctx.input(from);
              const slot = tctx.input(l.slot);
              // A hole, as the twin's entry-end re-stamp makes the item; its state merges, as the
              // twin merges a canceled child's (the ADR's amendment).
              itemStore(scopeOf(tctx), slot.k).forget('merge');
              tctx.output(l.permit, null);
            })
            .build(),
        );
        return name;
      };
      drops = {
        done: drop('done', l.done),
        failed: drop('failed', l.out.failed),
        bailed: drop('bailed', l.out.bailed),
        suspended: drop('suspended', l.out.suspended),
        paused: drop('paused', l.out.paused),
      };
    }

    laneSites.push({
      stage: l.stage,
      lane: l.lane,
      flat: l.flat,
      permit: l.permit.name,
      slot: l.slot.name,
      body: l.bodyIn.name,
      done: l.done.name,
      exits: {
        failed: l.out.failed.name,
        bailed: l.out.bailed.name,
        suspended: l.out.suspended.name,
        paused: l.out.paused.name,
        canceled: l.out.canceled.name,
      },
      start,
      refuse,
      handoffs,
      collect,
      settles: { bail, pause, fail, suspend },
      drops,
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Finishers: the queue closed, the frame, every permit of every stage, one token of each flag.
  // ---------------------------------------------------------------------------------------------
  const finishers: string[] = [];
  const flags = (f: readonly FlagState[], sp: readonly FlagState[]): readonly FinisherFlag[] => [
    { pair: fault, letter: 'f', accepts: f },
    { pair: susp, letter: 's', accepts: sp },
  ];
  const finisher = (role: string, accepts: readonly FinisherFlag[], build: (b: ReturnType<typeof Transition.builder>, flagPlaces: readonly Place<null>[]) => Transition): void => {
    const built = finisherTransitions({ name: t, role, naming: 'varying', queueClosed, frame, flags: accepts, permits: everyPermit, build });
    for (const tr of built) finishers.push(tr.name);
    transitions.push(...built);
  };
  const takeFrame = (tctx: TransitionContext, flagPlaces: readonly Place<null>[]): ForeachFrame => takeAll(tctx, queueClosed, frame, flagPlaces, permitPlaces);

  /** Every admitted item collected (or bailed, or paused), nothing recorded, no cancel: the array. */
  finisher('join', flags(['off'], ['off']), (b, flagPlaces) =>
    unlessCanceled(b)
      .outputs(outPlace(next))
      .action(async (tctx) => {
        const f = takeFrame(tctx, flagPlaces);
        const scope = scopeOf(tctx);
        const { record, output } = successAggregate(f, scope.epochNow());
        await writeAggregate(scope, bodyId, viewPath, record);
        tctx.output(next, { data: output });
      })
      .build(),
  );

  /** A failure was recorded: the first in time, its own record plus `foreachOutput`, outranks a suspension. */
  finisher('fail', flags(['on'], ['off', 'on']), (b, flagPlaces) =>
    unlessCanceled(b)
      .outputs(outPlace(exits.failed))
      .action(async (tctx) => {
        const f = takeFrame(tctx, flagPlaces);
        const { record, first, foreachOutput } = failedAggregate(f);
        const scope = scopeOf(tctx);
        await writeAggregate(scope, bodyId, viewPath, record);
        const meta: ForeachMeta = { foreachIndex: first.failure.foreachIndex ?? 0, foreachOutput: itemRecordsOf(foreachOutput) };
        tctx.output(exits.failed, { ...first.failure, foreach: meta });
      })
      .build(),
  );

  /** Only suspensions: the lowest index, the foreach aggregate shape (`__workflow_meta.{foreachIndex, foreachOutput}`). */
  finisher('suspend', flags(['off'], ['on']), (b, flagPlaces) =>
    unlessCanceled(b)
      .outputs(outPlace(exits.suspended))
      .action(async (tctx) => {
        const f = takeFrame(tctx, flagPlaces);
        const scope = scopeOf(tctx);
        const { record, lowest, foreachIndex, foreachOutput } = suspendedAggregate(f, scope.epochNow());
        await writeAggregate(scope, bodyId, viewPath, record);
        const meta: ForeachMeta = { foreachIndex, foreachOutput: itemRecordsOf(foreachOutput) };
        tctx.output(exits.suspended, { ...lowest, foreach: meta });
      })
      .build(),
  );

  if (cancel !== undefined) {
    /** Canceled outranks everything: every combination of flags, after every lane is home; the partial array. */
    finisher('canceled', flags(['off', 'on'], ['off', 'on']), (b, flagPlaces) =>
      b
        .read(cancel)
        .outputs(outPlace(exits.canceled))
        .action(async (tctx) => {
          const f = takeFrame(tctx, flagPlaces);
          const scope = scopeOf(tctx);
          const { record, output } = canceledAggregate(f, scope.epochNow());
          await writeAggregate(scope, bodyId, viewPath, record);
          tctx.output(exits.canceled, { origin, output, started: true });
        })
        .build(),
    );
  }

  const site: PipelineSite = {
    path: [...path],
    foreachId: entry.id,
    bodyId,
    stages: stages.map((st) => st.id),
    bounds: [...bounds],
    frame: frame.name,
    queueOpen: queueOpen.name,
    queueClosed: queueClosed.name,
    fault: fault.on.name,
    noFault: fault.off.name,
    susp: susp.on.name,
    noSusp: susp.off.name,
    cancelSweep: cancelName,
    split: splitName,
    lanes: laneSites,
    finishers,
  };

  // Every place is 1-bounded — the default claim — so nothing is claimed beyond the exclusions.
  return {
    inPlace,
    transitions,
    // Each lane's `canceled` exit: no arc reaches it (the body is emitted without the signal), and
    // libpetri drops a place no arc references; the site names it, so the net must hold it.
    places: lanes.map((l) => l.out.canceled),
    pipelines: [site],
    exclusions: [
      { a: queueOpen.name, b: queueClosed.name, why: 'the queue is open or closed, never both' },
      // Fail-fast: a failure or suspension is recorded only by a settle that took the queue, and
      // without a resume path nothing raises a flag beside an open queue.
      { a: queueOpen.name, b: fault.on.name, why: 'a recorded failure has killed the queue' },
      { a: queueOpen.name, b: susp.on.name, why: 'a recorded suspension has killed the queue' },
      ...[fault, susp].map((k) => ({ a: k.off.name, b: k.on.name, why: `'${k.on.name}' is recorded or not, never both` })),
      ...lanes.map((l) => ({ a: l.permit.name, b: l.slot.name, why: `stage ${l.stage} lane ${l.lane} is idle or busy, never both` })),
    ],
  };
};

/**
 * The entry's pipeline, checked: what the adapter refuses, refused again here by name, in case a
 * hand-built description slips past it.
 */
function pipelineOf(entry: Extract<EntryDescription, { kind: 'foreach' }>): { readonly stages: readonly EntryStage[]; readonly bounds: readonly number[] } {
  const pipeline = entry.pipeline;
  const refuse = (code: 'pipeline-empty' | 'pipeline-value', why: string): never => {
    throw new Error(`.foreach '${entry.id}': ${why} (${code})`);
  };
  if (pipeline === undefined) throw new Error(`pipelineGadget: .foreach '${entry.id}' carries no pipeline`);
  const { stages, bounds } = pipeline;
  if (!Array.isArray(stages) || stages.length === 0) return refuse('pipeline-empty', 'a pipeline needs at least one stage');
  if (!Array.isArray(bounds) || bounds.length !== stages.length) {
    return refuse('pipeline-value', `a pipeline of ${stages.length} stage(s) needs as many bounds, got ${Array.isArray(bounds) ? bounds.length : String(bounds)}`);
  }
  bounds.forEach((c, j) => {
    if (typeof c !== 'number' || !Number.isSafeInteger(c) || c < 1) refuse('pipeline-value', `stage ${j}'s bound must be a whole number ≥ 1, got ${String(c)}`);
  });
  const width = bounds.reduce((a, c) => a + c, 0);
  if (width > MAX_FOREACH_LANES) refuse('pipeline-value', `the bounds sum to ${width}, above the ${MAX_FOREACH_LANES}-lane limit`);
  if (entry.concurrency !== width) refuse('pipeline-value', `the bounds sum to ${width}, but the entry's concurrency is ${String(entry.concurrency)}`);
  return { stages, bounds };
}

type EntryStage = NonNullable<Extract<EntryDescription, { kind: 'foreach' }>['pipeline']>['stages'][number];

/** The flattened lane index of stage `stage`, lane `lane`: `Σ_{i<stage} c_i + lane`. */
export function flatLane(bounds: readonly number[], stage: number, lane: number): number {
  let flat = lane;
  for (let i = 0; i < stage; i++) flat += bounds[i]!;
  return flat;
}

/** The stage a flattened lane `L` belongs to — what the runner resolves a lane path `[i, L]` by. */
export function stageOfLane(bounds: readonly number[], flat: number): number {
  let rest = flat;
  for (let j = 0; j < bounds.length; j++) {
    if (rest < bounds[j]!) return j;
    rest -= bounds[j]!;
  }
  throw new RangeError(`lane ${flat} is outside a pipeline of ${bounds.reduce((a, c) => a + c, 0)} lane(s)`);
}

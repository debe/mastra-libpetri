/**
 * **`compensate` on the default engine, the twin and the `onError` recipe** ([ADR 0017], W2; rows
 * 119-128): one saga — `reserve*` (undone by `release`), `note`, `hold*` (undone by `unhold`),
 * `charge`, `ship` — run through Mastra's own `Run` over a real `Mastra` and `InMemoryStore`:
 *
 * - **petri** — `init().createWorkflow` on `PetriExecutionEngine` (a `ManualClock`, [TIME-015], so
 *   the net's record stamps are virtual): a failure at `charge` undoes `hold`, then `reserve`, before
 *   the run settles.
 * - **clone (T0)** — Mastra's `cloneWorkflow` of that very workflow (`create.ts:105-135`): a `new
 *   Workflow` with no `executionEngine` over the same step graph, held by reference, with the source's
 *   `options` copied. The compensator rides on the step under `STEP_RESOURCES`, which
 *   `DefaultExecutionEngine` never reads: the same status, the same `error` **shape**
 *   (`formatResultError`, `default.ts:521`, builds a plain `Object`, called from `fmtReturnValue`'s
 *   failed branch, `default.ts:613-628`; identity is a property of neither engine), the same tripwire and forward records, no compensator record, the effects
 *   remain. The Layer 3 statement.
 * - **the recipe (T1)** — the same workflow with an `onError` that starts one undo workflow per
 *   completed compensated record, newest first, over the record's output: the oracle for the
 *   compensators' inputs and order. Its four differences from the ladder are recipe text (ADR 0017
 *   Context (c), T1): it runs outside the run (its own run ids, no records in the failed run), is
 *   lost on a crash between the terminal persist and the callback, has its failure swallowed, and
 *   never runs on a cancel. On a petri workflow with `compensate` it undoes **twice** — the warning
 *   the ADR gives, asserted as recorded.
 *
 * The callback order — terminal persist, `onFinish`, `onError`, then `start()` resolves
 * (`execution-engine.ts:172-205`; `default.ts:953-1000`; petri `src/mastra/engine.ts`) — on both
 * engines; the default engine writes its terminal row twice, petri once. State (row 128) on both: a
 * failing step's own `setState` is dropped, completed steps' writes persist, a compensator's write
 * applies (petri only — the twin runs none), and a failed petri child merges nothing into its parent.
 *
 * Row 124 (`Run.cancel()` mid-rollback lands compensator spans under an ended tree) is **not**
 * asserted here: it needs `@mastra/observability`, which is not a repo dependency, and without it no
 * span is created. Skipped, as W0 pinned it in scratch only.
 *
 * No real sleeps: no step waits on a timer; the cancel case parks a step on a promise gate and waits
 * for a condition over event-loop turns (`until`), never for milliseconds. Every case has a 10 s
 * timeout, so a mutant that strands a run fails rather than hangs.
 *
 * Each case names the `src/` mutant it kills; every kill was confirmed in a scratch copy of the tree.
 *
 * Environment: `@mastra/core` from the pinned registry package (1.67.0), libpetri 8.0.0 (registry,
 * not linked). Tested, not proven: these are values the value-blind verifier cannot see.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { TripWire } from '@mastra/core/agent';
import { cloneWorkflow, createStep as mastraCreateStep, createWorkflow as mastraCreateWorkflow } from '@mastra/core/workflows';
import { init } from '../../src/mastra/index.js';
import { compensatorOf } from '../../src/mastra/resources.js';
import { ManualClock } from '../support/manual-clock.js';

type Ctx = Record<string, any>;
type Mode = 'success' | 'fail' | 'tripwire' | 'undo-fails' | 'suspend';

const T = 10_000;
const ANY = z.any();
const N = z.object({ n: z.number() });

/** One event-loop turn: lets every ready promise and I/O callback run. No timer is involved. */
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
/** Waits, turn by turn, until `cond` holds or `max` turns pass; returns whether it held. */
async function until(cond: () => boolean, max = 2_000): Promise<boolean> {
  for (let i = 0; i < max; i++) {
    if (cond()) return true;
    await turn();
  }
  return cond();
}
/** A promise and its release. */
function gate(): { readonly wait: Promise<void>; open(): void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

/**
 * What the steps did: `effects` is the world (`seat`, `note`, `hold`, `charge`, `ship`; an undo
 * removes its own); `calls` every compensator call, `[id, input]`; `order` the run's timeline,
 * written by the steps, the callbacks, the store and the test; `seen` the record ids each lifecycle
 * callback was handed in `steps`, keyed `onFinish` / `onError`.
 */
interface World {
  readonly effects: string[];
  readonly calls: [string, unknown][];
  readonly order: string[];
  readonly seen: Record<string, string[]>;
}
const newWorld = (): World => ({ effects: [], calls: [], order: [], seen: {} });
const drop = (xs: string[], x: string) => {
  const i = xs.indexOf(x);
  if (i >= 0) xs.splice(i, 1);
};

/** The compensators' bodies, shared by the ladder's compensators and the recipe's undo steps. */
const undoBodies = (world: World, mode: Mode) => ({
  release: async ({ inputData, state, setState }: Ctx) => {
    world.calls.push(['release', inputData]);
    world.order.push('release');
    drop(world.effects, 'seat');
    await setState({ ...state, released: true });
    return { released: inputData.n };
  },
  unhold: async ({ inputData, state, setState }: Ctx) => {
    world.calls.push(['unhold', inputData]);
    world.order.push('unhold');
    // Writes before it throws, as `charge` does: a failing compensator's write is then dropped (row 128).
    await setState({ ...state, unheld: true });
    if (mode === 'undo-fails') throw Object.assign(new Error('hold is stuck'), { code: 'E_STUCK' });
    drop(world.effects, 'hold');
    return { unheld: inputData.n };
  },
});

/**
 * The forward steps' bodies. Each completed step writes its own state key; `charge` writes its key
 * and then throws or trips per `mode`, so its write is the failing step's own (row 128). `note` may
 * be parked on `hold` (for the cancel case).
 */
const forwardBodies = (world: World, mode: Mode, park?: Promise<void>) => ({
  reserve: async ({ inputData, state, setState }: Ctx) => {
    world.effects.push('seat');
    await setState({ ...state, reserved: true });
    return { n: inputData.n + 1 };
  },
  note: async ({ inputData, state, setState }: Ctx) => {
    world.order.push('note:in');
    if (park) await park;
    world.effects.push('note');
    await setState({ ...state, noted: true });
    return { n: inputData.n * 10 };
  },
  hold: async ({ inputData, state, setState }: Ctx) => {
    world.effects.push('hold');
    await setState({ ...state, held: true });
    return { n: inputData.n + 100 };
  },
  charge: async ({ inputData, state, setState, suspend, resumeData }: Ctx) => {
    await setState({ ...state, charged: true });
    if (mode === 'suspend' && resumeData === undefined) return suspend({ why: 'approval' });
    if (mode === 'fail' || mode === 'undo-fails') throw Object.assign(new Error('card declined'), { code: 'E_DECLINED' });
    if (mode === 'tripwire') throw new TripWire('blocked', { retry: false, metadata: { rule: 'r1' } }, 'proc-1');
    world.effects.push('charge');
    return inputData;
  },
  ship: async ({ inputData }: Ctx) => {
    world.effects.push('ship');
    return { shipped: inputData.n };
  },
});

/** The compensated forward steps and their compensators, oldest first: the recipe walks it backwards. */
const UNDO = [
  ['reserve', 'release'],
  ['hold', 'unhold'],
] as const;

interface Lifecycle {
  readonly status: string;
  readonly steps: Record<string, { status: string; output?: unknown }>;
  readonly stepExecutionPath?: readonly string[];
  readonly mastra?: { getWorkflow(id: string): { createRun(): Promise<{ runId: string; start(o: unknown): Promise<{ status: string }> }> } };
}

/**
 * **The T1 recipe** (ADR 0017 Context (c)): an `onError` that, newest first, starts the undo workflow
 * of every compensated step whose record is `success`, over its output — each a run of its own.
 * `runs` collects the undo runs' ids and statuses.
 */
function recipe(world: World, runs: { id: string; status: string }[]) {
  return async (info: Lifecycle) => {
    world.order.push(`onError:${info.status}`);
    world.seen['onError'] = Object.keys(info.steps);
    for (const [forward] of [...UNDO].reverse()) {
      const record = info.steps[forward];
      if (record?.status !== 'success') continue;
      const run = await info.mastra!.getWorkflow(`undo-${forward}`).createRun();
      const res = await run.start({ inputData: record.output });
      runs.push({ id: run.runId, status: res.status });
    }
  };
}

/** The recipe's undo workflows: plain Mastra, one step each, over the shared compensator bodies. */
function undoWorkflows(world: World, mode: Mode): Record<string, unknown> {
  const bodies = undoBodies(world, mode);
  return Object.fromEntries(
    UNDO.map(([forward, undo]) => [
      `undo-${forward}`,
      mastraCreateWorkflow({ id: `undo-${forward}`, inputSchema: N, outputSchema: ANY, stateSchema: ANY })
        .then(mastraCreateStep({ id: undo, inputSchema: N, outputSchema: ANY, stateSchema: ANY, execute: bodies[undo] as never }))
        .commit(),
    ]),
  );
}

interface Options {
  readonly mode: Mode;
  /** Put the T1 recipe in the workflow's `onError`. */
  readonly recipe?: boolean;
  /** Parks `note` until it resolves. */
  readonly park?: Promise<void>;
  /** An `onError` other than the recipe. */
  readonly onError?: (info: Lifecycle) => Promise<void>;
}
interface Saga {
  readonly workflow: any;
  readonly world: World;
  readonly undoRuns: { id: string; status: string }[];
  readonly mode: Mode;
}

/** The saga on the petri engine, under a `ManualClock`. */
function saga(id: string, o: Options): Saga {
  const { createStep, createWorkflow } = init({ clock: new ManualClock() });
  const world = newWorld();
  const undoRuns: { id: string; status: string }[] = [];
  const u = undoBodies(world, o.mode);
  const f = forwardBodies(world, o.mode, o.park);
  const step = (sid: string, execute: (c: Ctx) => Promise<unknown>, compensate?: unknown) =>
    createStep({ id: sid, inputSchema: ANY, outputSchema: ANY, stateSchema: ANY, execute: execute as never, ...(compensate ? { compensate } : {}) } as never);
  const release = step('release', u.release);
  const unhold = step('unhold', u.unhold);
  const onError = o.recipe ? recipe(world, undoRuns) : o.onError;
  const workflow = (createWorkflow as any)({
    id,
    inputSchema: N,
    outputSchema: ANY,
    stateSchema: ANY,
    options: {
      onFinish: (info: Lifecycle) => {
        world.order.push(`onFinish:${info.status}`);
        world.seen['onFinish'] = Object.keys(info.steps);
      },
      ...(onError ? { onError } : {}),
    },
  })
    .then(step('reserve', f.reserve, release))
    .then(step('note', f.note))
    .then(step('hold', f.hold, unhold))
    .then(step('charge', f.charge))
    .then(step('ship', f.ship))
    .commit();
  return { workflow, world, undoRuns, mode: o.mode };
}

/** Mastra's `cloneWorkflow` of a petri workflow — past the type checker, which refuses it (row 61). */
function clone(source: Saga, id: string): Saga {
  const workflow = (cloneWorkflow as unknown as (w: unknown, o: { id: string }) => any)(source.workflow, { id });
  return { ...source, workflow };
}

interface Row {
  readonly status: string;
  readonly context: Record<string, unknown>;
}
interface Result {
  readonly status: string;
  readonly runId: string;
  readonly error?: unknown;
  readonly tripwire?: unknown;
  readonly result?: unknown;
  readonly state?: Record<string, unknown>;
  readonly stepExecutionPath?: readonly string[];
  readonly steps: Record<string, { status: string; output?: unknown; payload?: unknown; error?: unknown }>;
}
interface Ran {
  readonly res: Result;
  /** Every row this run wrote, in order. */
  readonly rows: Row[];
  /** The stored row after the run. */
  readonly stored: Row | undefined;
  /** The run's `workflow-step-start` ids, in order. */
  readonly starts: string[];
  /** The run's workflows store. */
  readonly store: { loadWorkflowSnapshot(a: { workflowName: string; runId: string }): Promise<unknown> };
}
interface RunLike {
  readonly runId: string;
  watch(cb: (e: { type: string; payload?: { id?: string } }) => void): unknown;
  start(o: unknown): Promise<Result>;
  cancel(): Promise<void>;
}

/**
 * Runs `side` on a fresh Mastra over a fresh store, the recipe's undo workflows registered beside
 * it; every row the run writes is noted in `world.order` as `persist:<status>`, and the resolution
 * of `start()` as `resolved`. `during` sees the run before it starts.
 */
async function go(side: Saga, during?: (run: RunLike) => void, initialState: Record<string, unknown> = {}): Promise<Ran> {
  const id = side.workflow.id as string;
  const storage = new InMemoryStore();
  const mastra = new Mastra({ storage, workflows: { [id]: side.workflow, ...undoWorkflows(side.world, side.mode) } as never, logger: false });
  const store = (await storage.getStore('workflows'))!;
  const real = store.persistWorkflowSnapshot.bind(store);
  const rows: Row[] = [];
  (store as { persistWorkflowSnapshot: typeof real }).persistWorkflowSnapshot = async (args) => {
    if (args.workflowName === id) {
      const row = structuredClone(args.snapshot) as unknown as Row;
      rows.push(row);
      side.world.order.push(`persist:${row.status}`);
    }
    return real(args);
  };
  const run = (await (mastra as unknown as { getWorkflow(k: string): { createRun(): Promise<RunLike> } }).getWorkflow(id).createRun()) as RunLike;
  const starts: string[] = [];
  run.watch((e) => {
    if (e.type === 'workflow-step-start' && e.payload?.id !== undefined) starts.push(e.payload.id);
  });
  during?.(run);
  const res = await run.start({ inputData: { n: 1 }, initialState, outputOptions: { includeState: true } });
  side.world.order.push('resolved');
  const stored = (await store.loadWorkflowSnapshot({ workflowName: id, runId: run.runId })) as unknown as Row | undefined;
  return { res, rows, stored, starts, store };
}

/** By shape, never identity: JSON of the plain object Mastra builds. */
const json = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
/** A record without its stamps or payload (petri deduplicates payloads, row 120 aside): what the engines share. */
const fwd = (r: { status: string; output?: unknown; error?: unknown } | undefined) =>
  r === undefined ? undefined : { status: r.status, output: r.output, error: json(r.error) };
const FORWARD = ['input', 'reserve', 'note', 'hold', 'charge'] as const;
const forwardRecords = (res: Result) => Object.fromEntries(FORWARD.slice(1).map((k) => [k, fwd(res.steps[k])]));

/** reserve: 1 -> 2; note: 2 -> 20; hold: 20 -> 120. The compensators' inputs are these outputs. */
const OUT = { reserve: { n: 2 }, note: { n: 20 }, hold: { n: 120 } } as const;

describe('T0: the same workflow on DefaultExecutionEngine through a forced cloneWorkflow', () => {
  it(
    'a failure: same status, error shape and forward records; petri undoes hold then reserve, the clone undoes nothing and its effects remain (rows 119, 120)',
    async () => {
      // Kills F1 (`src/mastra/result.ts`, `formatWorkflowResult` returns `error: outcome.error` — the
      // thrown instance): petri's error is then an `Error`, whose JSON loses `name` and `message`.
      // Kills L1 (`src/compiler/blueprints/compensate.ts`, `start_j` hands u_j the bottom of the stack,
      // `stack[0]`, and keeps `stack.slice(1)`) and L2 (`arm_j` pushes k_j's output at the bottom,
      // `[flow.data, ...stack]`): `unhold` is then handed reserve's output. Kills C0
      // (`hasCompensation` returns false): petri then undoes nothing either. Kills N1
      // (`src/mastra/engine.ts`, `invokeLifecycleCallbacks` handed `input` and the forward-path
      // records only): `onFinish`'s `steps` then lack `unhold` and `release`.
      const ps = saga('t0-fail', { mode: 'fail' });
      const ours = await go(ps);
      const twin = clone(saga('t0-fail-src', { mode: 'fail' }), 't0-fail-c');
      expect(twin.workflow.executionEngine.constructor.name).toBe('DefaultExecutionEngine');
      expect(compensatorOf(twin.workflow.stepGraph[0].step)).toBeDefined(); // the key rides along, unread
      const theirs = await go(twin);

      for (const r of [ours, theirs]) {
        expect(r.res.status).toBe('failed');
        expect(json(r.res.error)).toEqual({ name: 'Error', message: 'card declined', code: 'E_DECLINED' });
        expect(Object.getPrototypeOf(r.res.error)).toBe(Object.prototype);
        expect(r.res.tripwire).toBeUndefined();
      }
      expect(json(ours.res.error)).toEqual(json(theirs.res.error));
      expect(forwardRecords(ours.res)).toEqual(forwardRecords(theirs.res));
      expect(forwardRecords(ours.res)).toMatchObject({
        reserve: { status: 'success', output: OUT.reserve },
        note: { status: 'success', output: OUT.note },
        hold: { status: 'success', output: OUT.hold },
        charge: { status: 'failed' },
      });

      expect(ours.res.steps['ship']).toBeUndefined();
      // The clone: Mastra stops at the first non-success (`default.ts:925-929`) — nothing undone.
      expect(Object.keys(theirs.res.steps)).toEqual([...FORWARD]);
      expect(theirs.starts).toEqual(['reserve', 'note', 'hold', 'charge']);
      expect(theirs.stored!.status).toBe('failed');
      expect(Object.keys(theirs.stored!.context)).toEqual([...FORWARD]);

      // Row 120, recorded: steps run after a failure. The compensator records follow the forward ones
      // in `steps`, the terminal row and the step events, newest first.
      expect(Object.keys(ours.res.steps)).toEqual([...FORWARD, 'unhold', 'release']);
      expect(ours.res.steps['unhold']).toMatchObject({ status: 'success', payload: OUT.hold, output: { unheld: 120 } });
      expect(ours.res.steps['release']).toMatchObject({ status: 'success', payload: OUT.reserve, output: { released: 2 } });
      expect(ours.starts).toEqual(['reserve', 'note', 'hold', 'charge', 'unhold', 'release']);
      expect(ours.stored!.status).toBe('failed');
      expect(Object.keys(ours.stored!.context)).toEqual([...FORWARD, 'unhold', 'release']);
      // `onFinish`'s `steps` carry them too; the clone's only the forward records.
      expect(ps.world.seen['onFinish']).toEqual([...FORWARD, 'unhold', 'release']);
      expect(twin.world.seen['onFinish']).toEqual([...FORWARD]);
      // `stepExecutionPath` is the forward path on both: the compensators are not in it.
      expect(ours.res.stepExecutionPath).toEqual(['reserve', 'note', 'hold', 'charge']);
      expect(ours.res.stepExecutionPath).toEqual(theirs.res.stepExecutionPath);
    },
    T,
  );

  it(
    'the effects: petri leaves only the uncompensated note, the clone leaves everything; compensator inputs are the forward outputs, newest first',
    async () => {
      // Kills L1 (as above) and L2 (`arm_j` pushes k_j's output at the bottom of the stack,
      // `[flow.data, ...stack]`): the two compensators then swap inputs. Kills C0.
      const p = saga('t0-eff', { mode: 'fail' });
      await go(p);
      const c = clone(saga('t0-eff-src', { mode: 'fail' }), 't0-eff-c');
      await go(c);
      expect(p.world.calls).toEqual([
        ['unhold', OUT.hold],
        ['release', OUT.reserve],
      ]);
      expect(p.world.effects).toEqual(['note']);
      expect(c.world.calls).toEqual([]);
      expect(c.world.effects).toEqual(['seat', 'note', 'hold']);
    },
    T,
  );

  it(
    'a tripwire: the same tripwire shape and no error on both; petri still rolls back (row 119)',
    async () => {
      // Kills F2 (`src/mastra/result.ts`, the `{ reason }` tripwire branch rebuilt as `{ reason, retry,
      // metadata }`, dropping `processorId`): petri's tripwire then lacks it, the clone's has it. (The
      // `instanceof TripWire` branch above it is not reached here: Mastra's executor hands the runner
      // the flattened object.) Kills C0.
      const p = saga('t0-trip', { mode: 'tripwire' });
      const ours = await go(p);
      const c = clone(saga('t0-trip-src', { mode: 'tripwire' }), 't0-trip-c');
      const theirs = await go(c);
      for (const r of [ours, theirs]) {
        expect(r.res.status).toBe('tripwire');
        expect(r.res.tripwire).toEqual({ reason: 'blocked', retry: false, metadata: { rule: 'r1' }, processorId: 'proc-1' });
        expect(r.res.error).toBeUndefined();
      }
      expect(forwardRecords(ours.res)).toEqual(forwardRecords(theirs.res));
      expect(p.world.calls).toEqual([
        ['unhold', OUT.hold],
        ['release', OUT.reserve],
      ]);
      expect(p.world.effects).toEqual(['note']);
      expect(c.world.calls).toEqual([]);
      expect(c.world.effects).toEqual(['seat', 'note', 'hold']);
    },
    T,
  );

  it(
    'a success: the same result, records and state on both; no compensator runs on either (row 119)',
    async () => {
      // Kills L6 (`compensate.ts`, `discharge_j.done` hands on the level's stack as the flow's data):
      // petri's result is then the stack, not ship's output.
      const p = saga('t0-ok', { mode: 'success' });
      const ours = await go(p);
      const c = clone(saga('t0-ok-src', { mode: 'success' }), 't0-ok-c');
      const theirs = await go(c);
      for (const r of [ours, theirs]) {
        expect(r.res.status).toBe('success');
        expect(r.res.result).toEqual({ shipped: 120 });
        expect(Object.keys(r.res.steps)).toEqual([...FORWARD, 'ship']);
        expect(r.res.state).toEqual({ reserved: true, noted: true, held: true, charged: true });
      }
      expect(forwardRecords(ours.res)).toEqual(forwardRecords(theirs.res));
      for (const s of [p, c]) {
        expect(s.world.calls).toEqual([]);
        expect(s.world.effects).toEqual(['seat', 'note', 'hold', 'charge', 'ship']);
      }
    },
    T,
  );

  it(
    'a compensator that fails: the rollback continues, and the run\'s error is still the clone\'s (row 122)',
    async () => {
      // Kills L7 (`compensate.ts`, `settle_j.failed` hands level j-1 an empty stack — decision 2 C's
      // "stop at the first failure", made to run): `release` is then handed `undefined` and fails
      // its input, and `reserve` stays held.
      const p = saga('t0-undo-fails', { mode: 'undo-fails' });
      const ours = await go(p);
      const c = clone(saga('t0-undo-fails-src', { mode: 'undo-fails' }), 't0-undo-fails-c');
      const theirs = await go(c);
      expect(ours.res.status).toBe('failed');
      expect(json(ours.res.error)).toEqual(json(theirs.res.error));
      expect(json(ours.res.error)).toEqual({ name: 'Error', message: 'card declined', code: 'E_DECLINED' });
      expect(ours.res.steps['unhold']).toMatchObject({ status: 'failed', error: { message: 'hold is stuck', code: 'E_STUCK' } });
      expect(ours.res.steps['release']).toMatchObject({ status: 'success', payload: OUT.reserve });
      expect(p.world.calls).toEqual([
        ['unhold', OUT.hold],
        ['release', OUT.reserve],
      ]);
      expect(p.world.effects).toEqual(['note', 'hold']); // the stuck hold remains; the seat was released
      expect(c.world.effects).toEqual(['seat', 'note', 'hold']);
    },
    T,
  );
});

describe('T1: the onError recipe, the oracle', () => {
  it(
    'on the clone the recipe hands the compensators the inputs petri does, in the same order, outside the run',
    async () => {
      // Kills L1 and L2 (as above): petri's inputs then differ from the recipe's. Kills R2
      // (`src/mastra/runner.ts`, a compensator's `setState` dropped — `!detached` added to the state
      // commit): petri's state then lacks `released` and `unheld`.
      const p = saga('t1-p', { mode: 'fail' });
      const ours = await go(p);
      const c = clone(saga('t1-src', { mode: 'fail', recipe: true }), 't1-c');
      const theirs = await go(c);
      expect(theirs.res.status).toBe('failed');
      expect(c.world.calls).toEqual(p.world.calls);
      expect(c.world.calls).toEqual([
        ['unhold', OUT.hold],
        ['release', OUT.reserve],
      ]);
      expect(c.world.effects).toEqual(p.world.effects);
      // Outside the run: two runs of their own; the failed run's row and result keep only the forward
      // records; the undo writes never reach the failed run's state.
      expect(c.undoRuns.map((r) => r.status)).toEqual(['success', 'success']);
      expect(new Set([...c.undoRuns.map((r) => r.id), theirs.res.runId]).size).toBe(3);
      expect(Object.keys(theirs.res.steps)).toEqual([...FORWARD]);
      expect(Object.keys(theirs.stored!.context)).toEqual([...FORWARD]);
      expect(theirs.res.state).toEqual({ reserved: true, noted: true, held: true });
      // Inside the run on petri: the compensators' writes apply (row 128).
      expect(ours.res.state).toEqual({ reserved: true, noted: true, held: true, unheld: true, released: true });
    },
    T,
  );

  for (const mode of ['fail', 'tripwire'] as const) {
    it(
      `${mode}: the callback order on both engines is terminal persist, onFinish, onError, then start() resolves; petri writes the terminal row once, the default engine twice`,
      async () => {
        // Kills E1 (`src/mastra/engine.ts`, `invokeLifecycleCallbacks` before the terminal
        // `persistRun`): petri's callbacks then come before its terminal row.
        const status = mode === 'fail' ? 'failed' : 'tripwire';
        const p = saga(`t1-order-${mode}-p`, { mode, onError: async (i) => void p.world.order.push(`onError:${i.status}`) });
        await go(p);
        const src = saga(`t1-order-${mode}-src`, { mode, recipe: true });
        const c = clone(src, `t1-order-${mode}-c`);
        await go(c);
        // Petri: the rollback runs inside the run, before its one terminal row.
        expect(p.world.order).toEqual(['persist:pending', 'persist:running', 'note:in', 'unhold', 'release', `persist:${status}`, `onFinish:${status}`, `onError:${status}`, 'resolved']);
        // The default engine: a row per entry, then two terminal rows — for a tripwire `failed` first,
        // so for a moment the stored row says `failed` (ADR 0017 T1) — then the callbacks; the
        // recipe's undo runs inside `onError`, and `start()` waits for it.
        const terminal = mode === 'fail' ? ['persist:failed', 'persist:failed'] : ['persist:failed', 'persist:tripwire'];
        expect(c.world.order.filter((x) => x.startsWith('persist:') && x !== 'persist:running' && x !== 'persist:pending')).toEqual(terminal);
        expect(c.world.order.slice(c.world.order.indexOf(terminal[0]!))).toEqual([...terminal, `onFinish:${status}`, `onError:${status}`, 'unhold', 'release', 'resolved']);
        expect(c.world.order.indexOf('persist:failed')).toBeGreaterThan(c.world.order.indexOf('note:in'));
      },
      T,
    );
  }

  it(
    'start() waits for onError, and a throw in it is swallowed, on both engines',
    async () => {
      // Kills E2 (`src/mastra/engine.ts`, `invokeLifecycleCallbacks` not awaited): petri's `start()`
      // then resolves before `onError` has finished.
      const slow = (world: World) => async (i: Lifecycle) => {
        world.order.push(`onError:${i.status}`);
        for (let k = 0; k < 20; k++) await turn();
        world.order.push('onError:end');
        throw new Error('the callback fails');
      };
      const p = saga('t1-throw-p', { mode: 'fail', onError: async (i) => slow(p.world)(i) });
      const pr = await go(p);
      const src = saga('t1-throw-src', { mode: 'fail', onError: async (i) => slow(src.world)(i) });
      const c = clone(src, 't1-throw-c');
      const cr = await go(c);
      for (const [s, r] of [
        [p, pr],
        [c, cr],
      ] as const) {
        expect(r.res.status).toBe('failed');
        expect(json(r.res.error)).toEqual({ name: 'Error', message: 'card declined', code: 'E_DECLINED' });
        expect(s.world.order.slice(-3)).toEqual(['onError:failed', 'onError:end', 'resolved']);
      }
    },
    T,
  );

  it(
    'a cancel with no failure: onError never called, onFinish gets canceled, nothing compensated on either (row 123)',
    async () => {
      // Kills L8 (`compensate.ts`, the ladder's `exits.canceled` is `wf.comp.failure` — decision 3 B,
      // "a cancel also compensates"): petri then runs `release` after the cancel.
      const run = async (make: (park: Promise<void>) => Saga) => {
        const g = gate();
        const side = make(g.wait);
        let r!: RunLike;
        const running = go(side, (x) => (r = x));
        expect(await until(() => side.world.order.includes('note:in'))).toBe(true);
        await r.cancel();
        g.open();
        return { side, ...(await running) };
      };
      const ours = await run((park) => saga('t1-cancel-p', { mode: 'fail', recipe: true, park }));
      const theirs = await run((park) => clone(saga('t1-cancel-src', { mode: 'fail', recipe: true, park }), 't1-cancel-c'));
      for (const { side, res, stored } of [ours, theirs]) {
        expect(res.status).toBe('canceled');
        expect(stored!.status).toBe('canceled');
        expect(side.world.order.filter((x) => x.startsWith('onError'))).toEqual([]);
        expect(side.world.order.filter((x) => x.startsWith('onFinish'))).toEqual(['onFinish:canceled']);
        expect(side.world.calls).toEqual([]);
        expect(side.undoRuns).toEqual([]);
        expect(side.world.effects).toEqual(['seat', 'note']); // `note` ignored the abort; nothing after it ran
        expect(res.steps['release']).toBeUndefined();
        expect(res.steps['hold']).toBeUndefined();
      }
    },
    T,
  );

  it(
    'a cancel of a suspended run: no callback, nothing compensated, the stored row canceled, on both (row 123)',
    async () => {
      // A pin, no `src/` mutant: Mastra's `Run.cancel()` (`workflow.ts:3595-3619`) only rewrites the
      // stored status of a run no engine is executing, so neither engine is asked to roll back.
      const cancelSuspended = async (side: Saga) => {
        let r!: RunLike;
        const ran = await go(side, (x) => (r = x));
        expect(ran.res.status).toBe('suspended');
        const before = side.world.order.length;
        await r.cancel();
        const store = ran.store;
        const row = (await store.loadWorkflowSnapshot({ workflowName: side.workflow.id, runId: r.runId })) as unknown as Row;
        return { ran, row, after: side.world.order.slice(before) };
      };
      const p = saga('t1-cancel-susp-p', { mode: 'suspend', recipe: true });
      const c = clone(saga('t1-cancel-susp-src', { mode: 'suspend', recipe: true }), 't1-cancel-susp-c');
      for (const side of [p, c]) {
        const { row, after } = await cancelSuspended(side);
        expect(row.status).toBe('canceled');
        expect(after).toEqual([]); // no callback, no compensator, no row through the engine
        expect(side.world.calls).toEqual([]);
        expect(side.undoRuns).toEqual([]);
        expect(side.world.effects).toEqual(['seat', 'note', 'hold']);
      }
    },
    T,
  );

  it(
    'the warning case: the recipe on a petri workflow with compensate undoes twice — once in the net, once in onError (ADR 0017 Context (c))',
    async () => {
      // Kills C0 (`hasCompensation` returns false): the net then undoes nothing, and each compensator
      // runs once, from the callback.
      const p = saga('t1-twice', { mode: 'fail', recipe: true });
      const ours = await go(p);
      expect(ours.res.status).toBe('failed');
      // In the net, before the terminal row; again from `onError`, after it, as runs of their own.
      expect(p.world.order).toEqual([
        'persist:pending',
        'persist:running',
        'note:in',
        'unhold',
        'release',
        'persist:failed',
        'onFinish:failed',
        'onError:failed',
        'unhold',
        'release',
        'resolved',
      ]);
      expect(p.world.calls).toEqual([
        ['unhold', OUT.hold],
        ['release', OUT.reserve],
        ['unhold', OUT.hold],
        ['release', OUT.reserve],
      ]);
      expect(p.undoRuns.map((r) => r.status)).toEqual(['success', 'success']);
      // The recipe walks the forward records it is handed — `onError`'s and `onFinish`'s `steps`
      // carry the compensators' records too (row 120), and it does not look at them. Kills N1.
      expect(Object.keys(ours.res.steps)).toEqual([...FORWARD, 'unhold', 'release']);
      expect(p.world.seen['onError']).toEqual([...FORWARD, 'unhold', 'release']);
      expect(p.world.seen['onFinish']).toEqual([...FORWARD, 'unhold', 'release']);
    },
    T,
  );
});

describe('state (row 128), on both engines', () => {
  it(
    'a failing step\'s own setState is dropped and completed steps\' writes persist, on both; a compensator\'s write applies on petri',
    async () => {
      // Kills R1 (`src/mastra/runner.ts`, the state commit without `raw.status !== 'failed'`): petri's
      // state then has `charged`. Kills R2 (a compensator's `setState` dropped): petri's then lacks
      // `unheld` and `released`. Kills N4 (`src/mastra/runner.ts`, the state commit as
      // `(raw.status !== 'failed' || detached) && stateUpdate !== undefined`): the failing `unhold`,
      // which writes before it throws, then leaves `unheld`.
      const ours = await go(saga('st-p', { mode: 'fail' }), undefined, { seed: 7 });
      const theirs = await go(clone(saga('st-src', { mode: 'fail' }), 'st-c'), undefined, { seed: 7 });
      expect(theirs.res.state).toEqual({ seed: 7, reserved: true, noted: true, held: true });
      expect(ours.res.state).toEqual({ seed: 7, reserved: true, noted: true, held: true, unheld: true, released: true });
      for (const r of [ours, theirs]) expect(r.res.state).not.toHaveProperty('charged');
      // A compensator that writes, then fails: its write is dropped like any failing step's.
      const stuck = await go(saga('st-stuck', { mode: 'undo-fails' }));
      expect(stuck.res.state).toEqual({ reserved: true, noted: true, held: true, released: true });
    },
    T,
  );

  /**
   * A parent `[p0, child, p2]` over a petri child `[c1* (undone by uc1), c2]`, every step writing a
   * key, `c2` writing then throwing when `fail`. The parent on petri, and on Mastra's own engine.
   */
  function family(id: string, parentEngine: 'petri' | 'default', fail: boolean) {
    const api = init({ clock: new ManualClock() });
    const calls: string[] = [];
    const write = (key: string, then?: () => unknown) => async ({ inputData, state, setState }: Ctx) => {
      calls.push(key);
      await setState({ ...state, [key]: true, seen: [...((state['seen'] as string[] | undefined) ?? []), key] });
      if (then) return then();
      return inputData;
    };
    const pc = (sid: string, execute: (c: Ctx) => Promise<unknown>, compensate?: unknown) =>
      api.createStep({ id: sid, inputSchema: ANY, outputSchema: ANY, stateSchema: ANY, execute: execute as never, ...(compensate ? { compensate } : {}) } as never);
    const uc1 = pc('uc1', write('uc1'));
    const child = (api.createWorkflow as any)({ id: `${id}-child`, inputSchema: ANY, outputSchema: ANY, stateSchema: ANY })
      .then(pc('c1', write('c1'), uc1))
      .then(
        pc(
          'c2',
          write('c2', () => {
            if (fail) throw Object.assign(new Error('child fails'), { code: 'E_CHILD' });
            return { ok: true };
          }),
        ),
      )
      .commit();
    const create = parentEngine === 'petri' ? (p: object) => api.createStep(p as never) : (p: object) => mastraCreateStep(p as never);
    const ps = (sid: string) => create({ id: sid, inputSchema: ANY, outputSchema: ANY, stateSchema: ANY, execute: write(sid) as never });
    const wf = parentEngine === 'petri' ? (api.createWorkflow as any) : (mastraCreateWorkflow as any);
    const parent = wf({ id, inputSchema: ANY, outputSchema: ANY, stateSchema: ANY }).then(ps('p0')).then(child).then(ps('p2')).commit();
    return { parent, child, calls };
  }

  async function runFamily(f: { parent: any; child: any }): Promise<Result> {
    const mastra = new Mastra({ storage: new InMemoryStore(), workflows: { [f.parent.id]: f.parent, [f.child.id]: f.child } as never, logger: false });
    const run = await (mastra as unknown as { getWorkflow(k: string): { createRun(): Promise<RunLike> } }).getWorkflow(f.parent.id).createRun();
    return run.start({ inputData: { n: 1 }, outputOptions: { includeState: true } });
  }

  it(
    'a failed petri child merges nothing into its parent, its rolled-back steps\' writes included, on both engines; a child that succeeds merges',
    async () => {
      // Kills R1 (the state commit without `raw.status !== 'failed'`): the petri parent then merges
      // the child's `res.state` (`workflow.ts:3054`), and has `c1`, `c2` and `uc1`.
      for (const engine of ['petri', 'default'] as const) {
        const failing = family(`fam-${engine}-fail`, engine, true);
        const res = await runFamily(failing);
        expect(res.status, engine).toBe('failed');
        // The child ran c1, c2, then undid c1 inside itself — and none of it reached the parent.
        expect(failing.calls, engine).toEqual(['p0', 'c1', 'c2', 'uc1']);
        expect(res.state, engine).toEqual({ p0: true, seen: ['p0'] });
        expect(res.steps['p2'], engine).toBeUndefined();

        const ok = family(`fam-${engine}-ok`, engine, false);
        const good = await runFamily(ok);
        expect(good.status, engine).toBe('success');
        expect(ok.calls, engine).toEqual(['p0', 'c1', 'c2', 'p2']);
        expect(good.state, engine).toEqual({ p0: true, c1: true, c2: true, p2: true, seen: ['p0', 'c1', 'c2', 'p2'] });
      }
    },
    T,
  );
});

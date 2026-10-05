/**
 * **`pipeline()` end to end** ([ADR 0015], W1): `init().pipeline` on `PetriExecutionEngine`, run
 * through Mastra's own `Run` over a real `Mastra` and `InMemoryStore`, with real Mastra steps, the
 * real pipeline gadget, leaf, run scope and runner — against **the twin**: the same three stages on
 * `DefaultExecutionEngine` as `.foreach(nestedWorkflow, { concurrency: Σc_j })`, the body minted by
 * `mintBody` (the factory's own builder: copying `stateSchema`, `validateInputs: true`) over
 * Mastra's own `createWorkflow` and `createStep`.
 *
 * - **Outcomes**: a success's results in input order; an empty input; a stage-1 failure after a
 *   stage-0 `setState` leaves the run's state unmerged; a stage-0 bail is the item's output; a
 *   suspension merges its state; a cancel merges what it drops (rows 111, 114).
 * - **Events**: one `workflow-step-progress` per settled item, the twin's set (row 112).
 * - **The body's record**: each item's `foreachOutput` entry under the body id as the item leaves,
 *   as Mastra's worker `Object.assign`s it (`handlers/control-flow.ts:1179`) — read from the kernel's
 *   step results at a firing that fails mid-pipeline, the one place it outlives the aggregate.
 * - **Resume** (row 117): refused by name, `pipeline`, however the suspension is named, the stored
 *   snapshot untouched; a stage's own id never reaches the engine.
 * - **`getInitData()`** in stage 1 is the body-validated item, defaults applied (row 112).
 * - **Hand-off order** (row 115): recorded, not required.
 *
 * W2 adds:
 *
 * - **The overlap** on the run's clock: stage b of item 0 and stage a of item 1 in flight together,
 *   read from the engine's own item stamps under timed retry delays.
 * - **The failure drain**: admission closes, admitted items finish every stage, unadmitted ones are
 *   holes; then precedence — canceled over a failure, canceled over a suspension, the first failure
 *   in time, the lowest suspended index (rows 111, 114) — each against the twin under the same gates.
 * - **Quotas and the run budget across items** (row 116): `limit(1)` on a two-lane stage peaks at 1
 *   and is the one pool a parent step also takes from; a run budget of 1 peaks at 1 over every
 *   stage. Each with its unbounded control, so the probe is shown to make the peak happen.
 * - **Per-stage retries** under the parent's `retryConfig` (row 113).
 * - **The entry `payload`** as the raw item: the current, recorded divergence (row 112).
 *
 * **No wall-clock time decides an assertion.** Every petri run is on a `ManualClock`; no stage
 * sleeps; no case sets a timer. An interleaving a case depends on is forced by a gate: a stage holds
 * on {@link must} until an event the run must produce — a stage entered or finished (the world's
 * log), or an item settled (its `workflow-step-progress` event) — and the twin, which publishes the
 * same progress events (`handlers/control-flow.ts`, `emitIterationProgress`), is gated on the same
 * events. Each case that runs a pipeline has a 10 s timeout: a mutant that strands the net hangs
 * the run (a Mastra run always carries a signal, so a stranded net waits rather than ends), and the
 * case then fails in seconds rather than at the suite's minute.
 *
 * Each case names the mutation that breaks it (G1–G7: `src/compiler/blueprints/pipeline.ts`; E1:
 * `src/mastra/engine.ts`'s decode-path branch; P1–P11, P4b, P6b, N3, N4, N6 and S1: the W2 cases', in
 * `compiler/blueprints/pipeline.ts`, `compiler/gadgets/foreach-frame.ts`, `compiler/gadgets/leaf.ts`
 * and `mastra/adapt.ts`).
 *
 * Environment: `@mastra/core` from the pinned registry package, libpetri 8.0.0 (registry, not
 * linked), a `ManualClock` for every petri run; the twin on `DefaultExecutionEngine` reads no
 * clock that any assertion depends on. Tested, not proven: these are values the value-blind
 * verifier cannot see.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import { InMemoryStore } from '@mastra/core/storage';
import { createStep as mastraCreateStep, createWorkflow as mastraCreateWorkflow } from '@mastra/core/workflows';
import type { ExecutionEngine } from '@mastra/core/workflows';
import { compile, type StepDescription, type WorkflowDescription } from '../../src/compiler/index.js';
import type { EntryPath } from '../../src/compiler/names.js';
import type { StepCall, StepOutcome, StepRunner } from '../../src/compiler/types.js';
import { runWorkflowDetailed } from '../../src/engine/index.js';
import { init, UnsupportedRunModeError } from '../../src/mastra/index.js';
import { mintBody, type BodyChain, type PipelineBodyParams } from '../../src/mastra/pipeline.js';
import { compileMastraWorkflow } from '../../src/mastra/verify.js';
import { ManualClock } from '../support/manual-clock.js';

const EPOCH = 1_700_000_000_000;

/** Per case that runs a pipeline: a stranding mutant fails here, not at the suite's 60 s. */
const RUN_TIMEOUT = 10_000;

/** The body's input: `tag` defaults, so a validated item differs from the raw one. */
const Item = z.object({
  n: z.number(),
  tag: z.string().default('dflt'),
  fail: z.boolean().optional(),
  bail: z.boolean().optional(),
  susp: z.boolean().optional(),
});
type ItemT = z.infer<typeof Item>;
type Mid = ItemT & { seen: string[]; init1?: unknown };

/** What a stage's `execute` is handed, as far as these stages read it. */
interface Ctx<I> {
  inputData: I;
  state: Record<string, unknown>;
  setState(s: unknown): Promise<void>;
  getInitData(): unknown;
  bail(v: unknown): unknown;
  suspend(p: unknown, o?: unknown): Promise<unknown>;
}

interface Event {
  readonly type: string;
  readonly payload?: Record<string, unknown>;
}

/**
 * One side of a case: every stage entry logged (`b1`, or `b1#1` for a retry), every entry that has
 * finished, attempts in flight per stage with peaks, and the run's events — what a gate waits on.
 */
class World {
  readonly log: string[] = [];
  readonly done = new Set<string>();
  readonly events: Event[] = [];
  readonly inFlight = new Map<string, number>();
  readonly peak = new Map<string, number>();
  /** A {@link must} that gave up, with its dump: the run's own outcome is then beside the point. */
  readonly stuck: string[] = [];
  total = 0;
  peakTotal = 0;

  begin(stage: string, entry: string): void {
    this.log.push(entry);
    const now = (this.inFlight.get(stage) ?? 0) + 1;
    this.inFlight.set(stage, now);
    this.peak.set(stage, Math.max(this.peak.get(stage) ?? 0, now));
    this.total++;
    this.peakTotal = Math.max(this.peakTotal, this.total);
  }

  end(stage: string, entry: string): void {
    this.inFlight.set(stage, this.inFlight.get(stage)! - 1);
    this.total--;
    this.done.add(entry);
  }

  /** Item `n` has left the pipeline with `status`, as its progress event says. */
  settled(n: number, status: string): boolean {
    return this.events.some((e) => e.type === 'workflow-step-progress' && e.payload?.currentIndex === n && e.payload?.iterationStatus === status);
  }

  entered(entry: string): boolean {
    return this.log.includes(entry);
  }

  finished(...entries: string[]): boolean {
    return entries.every((e) => this.done.has(e));
  }
}

/**
 * Polls `cond` on the macrotask queue for at most `turns` turns. No wall-clock time is read: a hold
 * waits for an event the run must produce, and `turns` only bounds how long a mutant may keep it
 * from coming. Returns whether `cond` held.
 */
async function until(cond: () => boolean, turns: number): Promise<boolean> {
  for (let i = 0; i < turns && !cond(); i++) await new Promise<void>((resolve) => setImmediate(resolve));
  return cond();
}

/**
 * The cap on a {@link must}, in macrotask turns. A correct run of this file needs very few — measured
 * over three runs, no wait took more than 2 turns, since an event a gate waits on is one the run
 * produces without the gate's help — so the cap only turns a mutant's hang into a named failure,
 * in well under a second.
 *
 * Unexplained, not reproduced: W2's first cut once saw `never held` at a cap of 20,000 turns, and
 * the cap was raised to 500,000 rather than explained; it is lowered again here, with the dump. No
 * real timer sits on the workflow path (Mastra's workflow handlers set none; `src` arms a deadline
 * `setTimeout(0)` only for a deadline, which no pipeline here has), and the failure has not recurred
 * since, so the likeliest cause is the environment — other sessions mutating the same tree mid-run.
 * Its cause is unknown; if it recurs, the dump says which event never came.
 */
const MUST_TURNS = 10_000;

/**
 * Waits for an event the run must produce. The wait ends as soon as the event comes, so it costs
 * nothing on a correct run; past {@link MUST_TURNS} it records a dump of the world in `w.stuck`
 * (which {@link go} raises once the run ends) and throws, which fails the stage holding it.
 */
async function must(w: World, cond: () => boolean, what: string): Promise<void> {
  if (await until(cond, MUST_TURNS)) return;
  const settled = progress(w.events).map((p) => `${String(p.currentIndex)}:${String(p.iterationStatus)}`);
  const dump = `never held in ${MUST_TURNS} turns: ${what}\n  log: [${w.log.join(' ')}]\n  done: [${[...w.done].join(' ')}]\n  settled: [${settled.join(' ')}]\n  events: [${w.events.map((e) => e.type).join(' ')}]`;
  w.stuck.push(dump);
  throw new Error(dump);
}

/** A stage's hold on item `n`: awaited before the stage does anything but log its entry. */
type Hold = (n: number) => Promise<void> | void;

interface Opts {
  /** Awaited by `a` after its `setState`, with the item's `n`. */
  readonly holdA?: Hold;
  /** Awaited by `b` as it enters, before its `setState`. */
  readonly holdB?: Hold;
}

/**
 * `a -> b -> c` over {@link Item}, built with `create` — the petri `createStep`, or Mastra's own for
 * the twin — from the same functions. `a` sets `a<n>` and may bail; `b` sets `b<n>`, reads
 * `getInitData()`, and may fail or suspend; `c` folds the trail into `out`. `w` takes every entry
 * and exit; the holds are the only thing that orders one item's stage against another's.
 */
function stagesWith(create: (params: unknown) => unknown, w: World, o: Opts = {}): [unknown, unknown, unknown] {
  const a = create({
    id: 'a',
    inputSchema: Item,
    outputSchema: z.any(),
    execute: async ({ inputData, state, setState, bail }: Ctx<ItemT>) => {
      const entry = `a${inputData.n}`;
      w.begin('a', entry);
      try {
        await setState({ ...state, [entry]: true });
        await o.holdA?.(inputData.n);
        if (inputData.bail) return bail({ out: `bail${inputData.n}` });
        return { ...inputData, seen: ['a'] };
      } finally {
        w.end('a', entry);
      }
    },
  });
  const b = create({
    id: 'b',
    inputSchema: z.any(),
    outputSchema: z.any(),
    resumeSchema: z.any(),
    execute: async ({ inputData, state, setState, suspend, getInitData }: Ctx<Mid>) => {
      const entry = `b${inputData.n}`;
      w.begin('b', entry);
      try {
        await o.holdB?.(inputData.n);
        await setState({ ...state, [entry]: true });
        if (inputData.fail) throw new Error(`item ${inputData.n} fails in b`);
        if (inputData.susp) return suspend({ why: inputData.n }, { resumeLabel: 'L' });
        return { ...inputData, seen: [...inputData.seen, 'b'], init1: getInitData() };
      } finally {
        w.end('b', entry);
      }
    },
  });
  const c = create({
    id: 'c',
    inputSchema: z.any(),
    outputSchema: z.any(),
    execute: async ({ inputData }: Ctx<Mid>) => {
      const entry = `c${inputData.n}`;
      w.begin('c', entry);
      w.end('c', entry);
      return { out: `${inputData.n}:${[...inputData.seen, 'c'].join('')}`, init1: inputData.init1 };
    },
  });
  return [a, b, c];
}

/** `.foreach(...pipeline([a, b, c], { id: 'per', concurrency: bounds }))` on the petri engine, on a `ManualClock`. */
function petri(id: string, bounds: readonly number[], w: World = new World(), o: Opts = {}) {
  const api = init({ clock: new ManualClock(EPOCH) });
  const stages = stagesWith(api.createStep as never, w, o);
  const workflow = api
    .createWorkflow({ id, inputSchema: z.array(z.any()), outputSchema: z.any() })
    .foreach(...(api.pipeline as unknown as (s: unknown[], p: unknown) => [never, never])(stages, { id: 'per', concurrency: bounds }))
    .commit();
  return { workflow, w };
}

/** The twin's body: the minted body over Mastra's own `createWorkflow`. */
const twinBody = (stages: unknown[]) => mintBody((params: PipelineBodyParams) => mastraCreateWorkflow(params as never) as unknown as BodyChain, 'per', stages);

/** The twin: the minted body over Mastra's own factories, `.foreach(body, { concurrency: Σc_j })`. */
function twin(id: string, bounds: readonly number[], w: World = new World(), o: Opts = {}) {
  const stages = stagesWith(mastraCreateStep as never, w, o);
  const width = bounds.reduce((x, y) => x + y, 0);
  const workflow = mastraCreateWorkflow({ id, inputSchema: z.array(z.any()), outputSchema: z.any() })
    .foreach(twinBody(stages) as never, { concurrency: width })
    .commit();
  return { workflow, w };
}

interface Result {
  readonly status: string;
  readonly result?: unknown[];
  readonly error?: { readonly message?: string };
  readonly state?: Record<string, unknown>;
  readonly suspended?: unknown;
  readonly steps: Record<string, { status: string; output?: unknown }>;
}
interface RunLike {
  readonly runId: string;
  watch(cb: (e: Event) => void): unknown;
  start(o: unknown): Promise<Result>;
  resume(o: unknown): Promise<Result>;
  cancel(): Promise<void>;
}

/**
 * Runs `workflow` on a fresh Mastra over a fresh store, every event into `w.events` so a stage can
 * wait on one; `during` sees the run before it starts. A {@link must} that gave up is raised here,
 * dump and all, ahead of whatever the run made of the stage it failed.
 */
async function go(workflow: unknown, items: unknown[], w: World = new World(), during?: (run: RunLike) => void) {
  const id = (workflow as { id: string }).id;
  const storage = new InMemoryStore();
  const mastra = new Mastra({ storage, workflows: { [id]: workflow } as never, logger: false });
  const run = (await (mastra as unknown as { getWorkflow(id: string): { createRun(): Promise<RunLike> } }).getWorkflow(id).createRun()) as RunLike;
  run.watch((e) => w.events.push(e));
  during?.(run);
  const res = await run.start({ inputData: items, initialState: {}, outputOptions: { includeState: true } });
  if (w.stuck.length > 0) throw new Error(`${id}: ${w.stuck.join('\n')}`);
  const snapshot = async (): Promise<unknown> =>
    (await storage.getStore('workflows'))!.loadWorkflowSnapshot({ workflowName: id, runId: run.runId });
  return { res, events: w.events, run, snapshot, w };
}

const items = (count: number, extra: Record<number, Partial<ItemT>> = {}) => Array.from({ length: count }, (_, n) => ({ n, ...extra[n] }));

/** The progress events, by item: index, status and output (`completedCount` follows settle order). */
const progress = (events: readonly Event[]) =>
  events
    .filter((e) => e.type === 'workflow-step-progress')
    .map((e) => {
      const { id, totalCount, currentIndex, iterationStatus, iterationOutput } = e.payload!;
      return { id, totalCount, currentIndex, iterationStatus, iterationOutput };
    })
    .sort((x, y) => (x.currentIndex as number) - (y.currentIndex as number));

describe('pipeline() against the twin', () => {
  it('a success: results in input order, the twin\'s, every stage seen, the twin\'s state', async () => {
    // Breaks if (G7): a hand-off passes `slot.item` instead of stage j's output — stage b then
    // reads no `seen`, and the item fails.
    const ours = await go(petri('ok', [2, 1, 1]).workflow, items(4));
    const theirs = await go(twin('ok-twin', [2, 1, 1]).workflow, items(4));
    expect(ours.res.status).toBe('success');
    expect(ours.res.result).toEqual([0, 1, 2, 3].map((n) => ({ out: `${n}:abc`, init1: { n, tag: 'dflt' } })));
    expect(ours.res.result).toEqual(theirs.res.result);
    expect(ours.res.steps['per']).toMatchObject({ status: 'success', output: theirs.res.steps['per']!.output });
    expect(ours.res.state).toEqual(theirs.res.state);
  }, RUN_TIMEOUT);

  it('an empty input: success with the twin\'s output, no stage run, no progress event', async () => {
    // Breaks if (S1): the split loses its queue-closed branch — an empty input then opens a queue
    // with no item behind it; the action then gives a place the transition does not declare, and
    // the run ends failed instead of succeeding.
    const ours = await go(petri('empty', [2, 1, 1]).workflow, []);
    const theirs = await go(twin('empty-twin', [2, 1, 1]).workflow, []);
    expect(ours.res.status).toBe('success');
    expect(theirs.res.status).toBe('success');
    expect(ours.res.result).toEqual([]);
    expect(ours.res.result).toEqual(theirs.res.result);
    expect(ours.res.steps['per']).toMatchObject({ status: 'success', output: theirs.res.steps['per']!.output });
    expect(ours.w.log).toEqual([]);
    expect(progress(ours.events)).toEqual(progress(theirs.events));
  }, RUN_TIMEOUT);

  it('getInitData() in stage 1 is the body-validated item, defaults applied, as on the twin', async () => {
    // Breaks if: a stage after 0 is handed the raw item as `initData` (runner M2 — no `initData`
    // override on the stage view): `tag` is then missing.
    const extra = { 1: { tag: 'mine' } };
    const ours = await go(petri('init', [1, 1, 1]).workflow, items(2, extra));
    const theirs = await go(twin('init-twin', [1, 1, 1]).workflow, items(2, extra));
    const inits = (r: Result) => (r.result as { init1: unknown }[]).map((x) => x.init1);
    expect(inits(ours.res)).toEqual([{ n: 0, tag: 'dflt' }, { n: 1, tag: 'mine' }]);
    expect(inits(ours.res)).toEqual(inits(theirs.res));
  }, RUN_TIMEOUT);

  it('one progress event per item, the twin\'s set', async () => {
    // Breaks if (G4): an item's leave publishes no `step-settled` with its `foreachIndex`.
    // Item 3 is admitted at a stage-a hand-off to b, before item 2 can reach b: all four settle.
    const ours = await go(petri('prog', [2, 1, 1]).workflow, items(4, { 2: { fail: true } }));
    const theirs = await go(twin('prog-twin', [2, 1, 1]).workflow, items(4, { 2: { fail: true } }));
    expect(progress(ours.events)).toHaveLength(4);
    expect(progress(ours.events)).toEqual(progress(theirs.events));
    expect(progress(ours.events)[2]).toMatchObject({ currentIndex: 2, iterationStatus: 'failed' });
  }, RUN_TIMEOUT);

  it('a stage-1 failure after a stage-0 setState: the item\'s state is not merged, as on the twin', async () => {
    // Breaks if (G1): a fail settle forgets the item with 'merge' — `a2` and `b2` then leak.
    // Four items: b2 holds until item 3 is in stage a, so item 3 is admitted before the failure
    // closes admission on either side, and drains through every stage.
    const failing = (w: World): Opts => ({ holdB: (n) => (n === 2 ? must(w, () => w.entered('a3'), 'item 3 in stage a') : undefined) });
    const ws = [new World(), new World()] as const;
    const ours = await go(petri('fail', [2, 1, 1], ws[0], failing(ws[0])).workflow, items(4, { 2: { fail: true } }), ws[0]);
    const theirs = await go(twin('fail-twin', [2, 1, 1], ws[1], failing(ws[1])).workflow, items(4, { 2: { fail: true } }), ws[1]);
    expect(ours.res.status).toBe('failed');
    expect(ours.res.error?.message).toBe('item 2 fails in b');
    expect(ours.res.error?.message).toBe(theirs.res.error?.message);
    expect(ours.res.state).toEqual({ a0: true, b0: true, a1: true, b1: true, a3: true, b3: true });
    expect(ours.res.state).toEqual(theirs.res.state);
  }, RUN_TIMEOUT);

  it('a stage-0 bail: the item succeeds with the bail output, later stages skipped, as on the twin', async () => {
    // Breaks if (G6): a bail settles as a hole (`undefined`) instead of the bail output.
    const side = petri('bail', [2, 1, 1]);
    const ours = await go(side.workflow, items(3, { 1: { bail: true } }));
    const theirs = await go(twin('bail-twin', [2, 1, 1]).workflow, items(3, { 1: { bail: true } }));
    expect(ours.res.status).toBe('success');
    expect(ours.res.result![1]).toEqual({ out: 'bail1' });
    expect(ours.res.result).toEqual(theirs.res.result);
    expect(side.w.log).not.toContain('b1');
    expect(ours.res.state).toEqual(theirs.res.state);
  }, RUN_TIMEOUT);

  it('a cancel with every admitted item in flight: each dropped item\'s state is merged, as the twin merges a canceled child\'s', async () => {
    // Breaks if (G2 = N6): a drop forgets its item with 'discard' — `a1`, `a2` (waiting at the
    // hand-off) and `a0`, `b0` (in stage b when the cancel lands) then vanish. Breaks if (N4): the
    // join finisher is not gated by the cancel and outranks the canceled one — no item failed or
    // suspended, so only the gate tells a cancel from a success.
    //
    // Bounds [2, 1, 1], four items. b0 holds until a1 and a2 have finished (both parked at the
    // hand-off; item 3 is not admitted, both stage-0 lanes being held), then cancels the run from
    // inside b and finishes. The twin, at concurrency 4, holds b0 on the same events.
    const cancelling = (w: World) => {
      let run: RunLike | undefined;
      const opts: Opts = {
        holdB: async (n) => {
          if (n !== 0) return;
          await must(w, () => w.finished('a1', 'a2'), 'a1 and a2 finished');
          await run!.cancel();
        },
      };
      return { opts, during: (r: RunLike) => void (run = r) };
    };
    const ws = [new World(), new World()] as const;
    const [oc, tc] = [cancelling(ws[0]), cancelling(ws[1])];
    const ours = await go(petri('cancel', [2, 1, 1], ws[0], oc.opts).workflow, items(4), ws[0], oc.during);
    const theirs = await go(twin('cancel-twin', [2, 1, 1], ws[1], tc.opts).workflow, items(4), ws[1], tc.during);
    expect(ours.res.status).toBe('canceled');
    expect(theirs.res.status).toBe('canceled');
    expect([...ours.w.log].sort()).toEqual(['a0', 'a1', 'a2', 'b0']);
    expect(ours.res.state).toEqual({ a0: true, b0: true, a1: true, a2: true });
    // The twin admitted all four (concurrency 4) and merged every canceled child, these among them.
    expect(theirs.res.state).toMatchObject({ a0: true, b0: true, a1: true, a2: true });
    expect(ours.res.steps['per']).toMatchObject({ status: 'canceled', output: [] });
    expect(ours.res.steps['per']!.output).toEqual(theirs.res.steps['per']!.output);
  }, RUN_TIMEOUT);
});

describe('a suspended pipeline: the twin\'s outcome; every resume refused by name', () => {
  const its = () => items(3, { 1: { susp: true } });
  const comparable = (s: unknown) => JSON.parse(JSON.stringify(s)) as unknown;

  it('suspends at the body, merging the item\'s state, and refuses every resume naming it', async () => {
    // Breaks if (G3): a suspend settle discards — `a1`, `b1` then vanish. Breaks if the label, the
    // auto-detected step, the body id or the twin's own path reaches anything but the `pipeline` refusal.
    // Item 2 is admitted at a stage-a hand-off to b, before item 1 can reach b: it drains.
    const ours = await go(petri('susp', [2, 1, 1]).workflow, its());
    const theirs = await go(twin('susp-twin', [2, 1, 1]).workflow, its());
    expect(ours.res.status).toBe('suspended');
    expect(ours.res.suspended).toEqual([['per']]); // the twin's [['per', 'b']] — row 117
    expect(theirs.res.suspended).toEqual([['per', 'b']]);
    expect(ours.res.state).toEqual({ a0: true, b0: true, a1: true, b1: true, a2: true, b2: true });
    expect(ours.res.state).toEqual(theirs.res.state);

    const before = comparable(await ours.snapshot());
    expect(before).toMatchObject({ status: 'suspended', suspendedPaths: { per: [0] }, resumeLabels: { L: { stepId: 'per', foreachIndex: 1 } } });
    for (const how of [{}, { step: 'per' }, { step: ['per', 'b'] }, { label: 'L' }]) {
      const error = await ours.run.resume({ ...how, resumeData: { ok: true } }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error, JSON.stringify(how)).toBeInstanceOf(UnsupportedRunModeError);
      expect((error as UnsupportedRunModeError).resume, JSON.stringify(how)).toMatchObject({ stepId: 'per', reason: 'pipeline' });
      expect(comparable(await ours.snapshot()), JSON.stringify(how)).toEqual(before);
    }
  }, RUN_TIMEOUT);

  it('a resume naming a stage\'s own id is Mastra\'s refusal: the stage was never suspended', async () => {
    // Breaks if: the suspension is stored under the stage's id rather than the body's.
    const ours = await go(petri('susp-stage', [2, 1, 1]).workflow, its());
    const before = comparable(await ours.snapshot());
    await expect(ours.run.resume({ step: 'b', resumeData: {} })).rejects.toThrow('This workflow step "b" was not suspended');
    expect(comparable(await ours.snapshot())).toEqual(before);
  }, RUN_TIMEOUT);

  it('a resume with no stored position, naming the body: refused as pipeline, not no-site', async () => {
    // Breaks if (E1): `placeResume` no longer turns the codec's `no-site` under a pipeline's body id
    // into the `pipeline` refusal. `Run.resume` always hands a stored path, so the engine is called
    // directly, `resumePath` absent.
    const { workflow } = petri('decode', [1, 1, 1]);
    const engine = (workflow as unknown as { executionEngine: ExecutionEngine }).executionEngine;
    const error = await engine
      .execute({
        workflowId: 'decode',
        runId: 'x',
        graph: (workflow as unknown as { buildExecutionGraph(): unknown }).buildExecutionGraph(),
        serializedStepGraph: [],
        input: items(1),
        pubsub: {},
        requestContext: new RequestContext(),
        abortController: new AbortController(),
        resume: { steps: ['per'], stepResults: { input: items(1) }, resumePayload: {} },
      } as never)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(UnsupportedRunModeError);
    expect((error as UnsupportedRunModeError).resume).toMatchObject({ stepId: 'per', path: [], reason: 'pipeline' });
  }, RUN_TIMEOUT);
});

describe('the body\'s record as each item leaves (handlers/control-flow.ts:1179)', () => {
  /** `[pipeline 'per' over a, b at bounds [1, 1], step 'report']`, as the compiler's tests describe it. */
  const description: WorkflowDescription = {
    id: 'records',
    entries: [
      {
        kind: 'foreach',
        id: 'per',
        body: { kind: 'step', id: 'per', source: 'workflow' },
        concurrency: 2,
        pipeline: { stages: [{ kind: 'step', id: 'a' }, { kind: 'step', id: 'b' }] as StepDescription[], bounds: [1, 1] },
      },
      { kind: 'step', id: 'report' },
    ],
  };

  /** Stages double their input; `closeItem` throws as item `failAt` leaves — a firing that fails. */
  class Runner implements StepRunner {
    constructor(readonly failAt: number) {}
    async run(stepId: string, input: unknown, _call: StepCall): Promise<StepOutcome> {
      return { status: 'success', output: stepId === 'report' ? input : (input as number) * 2 };
    }
    openItem(_path: EntryPath, _k: number): void {}
    closeItem(_path: EntryPath, k: number): void {
      if (k === this.failAt) throw new Error(`closeItem ${k}`);
    }
  }

  it('holds the leaving item\'s entry, not the aggregate, when the run stops there', async () => {
    // Breaks if (G5): an item's leave records no entry under the body id — Mastra's worker
    // `Object.assign`s it into the step results — and the body id then has no record at all.
    // Only a firing that fails mid-pipeline shows it: the aggregate overwrites it at the finisher.
    const report = await runWorkflowDetailed(compile(description), [1, 2], { runner: new Runner(1), clock: new ManualClock(EPOCH) });
    expect(report.outcome.status).toBe('stranded');
    expect(report.stepResults.get('per')).toMatchObject({ status: 'success', output: 8, payload: 2, metadata: { foreachIndex: 1 } });
  }, RUN_TIMEOUT);
});

describe('the hand-off order (row 115) — recorded, not required', () => {
  it('bounds [2, 1, 1], six items: with two stage-0 lanes done, the lower lane hands off first', async () => {
    // Recorded divergence, not a requirement: when several stage-0 lanes are done and the stage-1
    // lane frees, the lowest lane wins, so item 1 — parked on lane 1 since the start — waits until
    // stage 0's queue drains and runs last. The twin bounds no stage and runs b in arrival order.
    // A change here is a change to row 115, not a regression by itself.
    //
    // Gated, not timed: the i-th entry into b holds until min(i + 3, 6) stage-a entries have
    // finished — the one in b, the one parked on lane 1, and the one the lane b's item left admitted
    // — so at every hand-off both stage-0 lanes are done and competing. Each hold is reachable
    // whichever lane wins, so a changed order fails the pin rather than hanging.
    const w = new World();
    let entries = 0;
    const holdB: Hold = async () => {
      const want = Math.min(entries++ + 3, 6);
      await must(w, () => [...w.done].filter((e) => e.startsWith('a')).length >= want, `${want} stage-a entries finished`);
    };
    const ours = await go(petri('order', [2, 1, 1], w, { holdB }).workflow, items(6), w);
    expect(ours.res.status).toBe('success');
    expect(w.log.filter((c) => c.startsWith('b'))).toEqual(['b0', 'b2', 'b3', 'b4', 'b5', 'b1']);
  }, RUN_TIMEOUT);
});

// --- W2: overlap, failure drain, precedence, quotas, the run budget, retries, the entry payload ----

/**
 * How long a probe holds an attempt for a second one to arrive, in turns: long enough that an attempt
 * the engine would admit gets inside, short enough that four held attempts cost tens of milliseconds.
 */
const PROBE = 1_000;

/** What a scripted stage sees: its id, the item's `n`, the attempt (Mastra's `retryCount`). */
interface At {
  readonly stage: string;
  readonly n: number;
  readonly attempt: number;
}

type Api = ReturnType<typeof init>;

/**
 * Steps `ids` in a chain over {@link Item}, on the petri engine (`on` an {@link Api}) or for the
 * twin (`'twin'`, Mastra's own `createStep`): each logs its entry, holds the gauge while it runs,
 * sets `<id><n>` in the item's state, then runs `script`. A script's return value, when defined, is
 * the step's; otherwise the step passes the item on with its id appended to `seen`.
 */
function scripted(
  on: Api | 'twin',
  w: World,
  ids: readonly string[],
  script: (at: At, ctx: Ctx<Mid>) => Promise<unknown> = async () => undefined,
  extra: (id: string) => Record<string, unknown> = () => ({}),
  first: z.ZodType = Item,
): unknown[] {
  const create = (on === 'twin' ? mastraCreateStep : on.createStep) as unknown as (p: unknown) => unknown;
  return ids.map((id, j) =>
    create({
      id,
      inputSchema: j === 0 ? first : z.any(),
      outputSchema: z.any(),
      resumeSchema: z.any(),
      ...extra(id),
      execute: async (ctx: Ctx<Mid> & { retryCount: number }) => {
        const at: At = { stage: id, n: ctx.inputData.n, attempt: ctx.retryCount };
        const entry = `${id}${at.n}${at.attempt > 0 ? `#${at.attempt}` : ''}`;
        w.begin(id, entry);
        try {
          await ctx.setState({ ...ctx.state, [`${id}${at.n}`]: true });
          const value = await script(at, ctx);
          return value !== undefined ? value : { ...ctx.inputData, seen: [...(ctx.inputData.seen ?? []), id] };
        } finally {
          w.end(id, entry);
        }
      },
    }),
  );
}

/** `.foreach(...pipeline(stages, { id: 'per', concurrency: bounds }))`, then `after` when given. */
function piped(api: Api, id: string, stages: unknown[], bounds: readonly number[], o: { retryConfig?: { attempts?: number; delay?: number }; after?: unknown } = {}) {
  const chain = (api.createWorkflow as unknown as (p: unknown) => { foreach(...a: unknown[]): { then(s: unknown): unknown; commit(): unknown } })({
    id,
    inputSchema: z.array(z.any()),
    outputSchema: z.any(),
    ...(o.retryConfig ? { retryConfig: o.retryConfig } : {}),
  }).foreach(...(api.pipeline as unknown as (s: unknown[], p: unknown) => [never, never])(stages, { id: 'per', concurrency: bounds }));
  return (o.after === undefined ? chain : (chain.then(o.after) as typeof chain)).commit();
}

/** The twin of {@link piped}: the minted body at `.foreach(body, { concurrency: Σc_j })`. */
function pipedTwin(id: string, stages: unknown[], bounds: readonly number[]) {
  return mastraCreateWorkflow({ id, inputSchema: z.array(z.any()), outputSchema: z.any() })
    .foreach(twinBody(stages) as never, { concurrency: bounds.reduce((x, y) => x + y, 0) })
    .commit();
}

/**
 * Runs one scripted case on both engines, each side with its own world and its own run, the script
 * gated on its own side's events: `script(w, run)` builds it for a side.
 */
async function both(
  id: string,
  bounds: readonly number[],
  count: number,
  script: (w: World, run: () => RunLike) => (at: At, ctx: Ctx<Mid>) => Promise<unknown>,
) {
  const side = async (on: Api | 'twin') => {
    const w = new World();
    let run: RunLike | undefined;
    const stages = scripted(on, w, ['a', 'b', 'c'], script(w, () => run!));
    const workflow = on === 'twin' ? pipedTwin(`${id}-twin`, stages, bounds) : piped(on, id, stages, bounds);
    return go(workflow, items(count), w, (r) => void (run = r));
  };
  return { ours: await side(init({ clock: new ManualClock(EPOCH) })), theirs: await side('twin') };
}

interface ItemEntry {
  readonly status: string;
  readonly payload?: unknown;
  readonly startedAt: number;
  readonly endedAt?: number;
}
/** The failed aggregate's per-item entries: `suspendPayload.__workflow_meta.foreachOutput`. */
const entriesOf = (r: Result): (ItemEntry | null | undefined)[] =>
  (r.steps['per'] as unknown as { suspendPayload: { __workflow_meta: { foreachOutput: (ItemEntry | null | undefined)[] } } }).suspendPayload.__workflow_meta.foreachOutput;

describe('the overlap, on the run\'s ManualClock', () => {
  it('stage b of item 0 runs while stage a of item 1 does: item 1 is admitted before item 0 leaves', async () => {
    // Breaks if (P1): stage 0's `start` is inhibited while any later-stage lane is busy — the
    // stages then run one item at a time, and item 1 is admitted at the instant item 0 collects.
    //
    // Every stage attempt fails once and retries after the parent's `retryConfig.delay` of 1000 ms,
    // a timed transition on the injected clock, so each stage spans ≥ 1000 virtual ms. The stamps
    // compared are the engine's, from firing actions on that clock: an item entry's `startedAt` is
    // stage 0's admission, its `endedAt` the collect. Item 1 fails b on its retry too, so the failed
    // aggregate carries both item entries (a success keeps only the results array).
    const clock = new ManualClock(EPOCH);
    const api = init({ clock });
    const w = new World();
    const stages = scripted(api, w, ['a', 'b'], async ({ stage, n, attempt }) => {
      if (attempt === 0) throw new Error(`${stage}${n} transient`);
      if (stage === 'b' && n === 1) throw new Error('item 1 fails in b');
      return undefined;
    });
    const { res } = await go(piped(api, 'overlap', stages, [1, 1], { retryConfig: { attempts: 1, delay: 1_000 } }), items(2), w);
    expect(res.status).toBe('failed');
    expect(res.error?.message).toBe('item 1 fails in b');
    const [e0, e1] = entriesOf(res);
    expect(e0).toMatchObject({ status: 'success', startedAt: EPOCH });
    expect(e1).toMatchObject({ status: 'failed' });
    // Item 1 waited for stage a's one lane: item 0's a spent at least the retry delay in it.
    expect(e1!.startedAt).toBeGreaterThanOrEqual(EPOCH + 1_000);
    // The overlap: item 1 entered stage a strictly before item 0 left stage b. Run one item at a
    // time, item 1's admission would be no earlier than item 0's collect.
    expect(e1!.startedAt).toBeLessThan(e0!.endedAt!);
    // Virtual time, not wall time: the run took thousands of virtual milliseconds.
    expect(clock.elapsed()).toBeGreaterThanOrEqual(3_000);
  }, RUN_TIMEOUT);
});

describe('a failure drains the pipeline', () => {
  it('closes admission: admitted items finish every stage, unadmitted items are holes', async () => {
    // Breaks if (P3): a fail settle with the queue open puts it back open — items 3 to 5 are then
    // admitted after the failure. Breaks if (P2): a hand-off is inhibited by the fault — items 0
    // and 1, admitted before the failure, are stranded mid-pipeline, and the case fails at its
    // timeout.
    //
    // Bounds [2, 1, 1], six items. Item 0 passes stage a and holds in b; item 2, admitted on the
    // lane item 0 left, fails a; item 1 holds in a. Both holds release on item 2's progress event,
    // so the failure has settled — admission closed — while items 0 and 1 are still in flight.
    const api = init({ clock: new ManualClock(EPOCH) });
    const w = new World();
    const stages = scripted(api, w, ['a', 'b', 'c'], async ({ stage, n }) => {
      if (stage === 'a' && n === 2) {
        await must(w, () => w.entered('b0'), 'item 0 in stage b');
        throw new Error('item 2 fails in a');
      }
      if ((stage === 'b' && n === 0) || (stage === 'a' && n === 1)) await must(w, () => w.settled(2, 'failed'), 'item 2 settled');
      return undefined;
    });
    const { res } = await go(piped(api, 'drain', stages, [2, 1, 1]), items(6), w);
    expect(res.status).toBe('failed');
    expect(res.error?.message).toBe('item 2 fails in a');
    // Items 0 and 1 ran every stage after the failure; nothing past item 2 was admitted.
    expect([...w.log].sort()).toEqual(['a0', 'a1', 'a2', 'b0', 'b1', 'c0', 'c1']);
    // Drained items merge their state; the failed item's `a2` is discarded (row 114).
    expect(res.state).toEqual({ a0: true, b0: true, c0: true, a1: true, b1: true, c1: true });
    const entries = entriesOf(res);
    expect(entries.slice(0, 3).map((e) => e?.status)).toEqual(['success', 'success', 'failed']);
    // Unadmitted items are holes: no entry, and no progress event.
    for (const k of [3, 4, 5]) expect(entries[k] ?? undefined, `item ${k}`).toBeUndefined();
    expect(progress(w.events).map((p) => p.currentIndex)).toEqual([0, 1, 2]);
  }, RUN_TIMEOUT);
});

describe('precedence after the drain: canceled, then the first failure in time, then the lowest suspension', () => {
  it('a cancel during the drain outranks the failure; the dropped item merges, the failed one does not', async () => {
    // Breaks if (P4b): the fail finisher ignores the signal and outranks the canceled one — the
    // body then records the failure. Breaks if (N6): a drop forgets with 'discard' — `a0`, `b0`
    // vanish. (P4, the canceled finisher accepting only a clean fault flag, strands the run and
    // fails this case at its timeout.)
    //
    // Bounds [2, 1, 1], two items. Item 1 fails a while item 0 is in b; item 0 then cancels the
    // run from inside b and finishes, so its outcome is dropped as a hole. The twin, under the same
    // gates, checks its canceled result before its error result.
    const { ours, theirs } = await both('p-cancel', [2, 1, 1], 2, (w, run) => async ({ stage, n }) => {
      if (stage === 'a' && n === 1) {
        await must(w, () => w.entered('b0'), 'item 0 in stage b');
        throw new Error('item 1 fails in a');
      }
      if (stage === 'b' && n === 0) {
        await must(w, () => w.settled(1, 'failed'), 'item 1 settled');
        await run().cancel();
      }
      return undefined;
    });
    expect(ours.res.status).toBe('canceled');
    expect(ours.w.log).not.toContain('c0');
    expect(ours.res.steps['per']).toMatchObject({ status: 'canceled', output: [] });
    expect(ours.res.state).toEqual({ a0: true, b0: true });
    expect(theirs.res.status).toBe('canceled');
    expect(ours.res.steps['per']!.output).toEqual(theirs.res.steps['per']!.output);
    expect(ours.res.state).toEqual(theirs.res.state);
  }, RUN_TIMEOUT);

  it('a cancel outranks a suspension', async () => {
    // Breaks if (N3): the suspend finisher is not gated by the cancel and outranks the canceled one
    // — the run then suspends. Mastra checks `canceledResult` before `foreachIndexObj`.
    //
    // Bounds [2, 1, 1], two items. Item 1 suspends in a while item 0 is in b; item 0 then cancels
    // the run from inside b. The suspended item's state merges, as does the dropped one's.
    const { ours, theirs } = await both('p-cancel-susp', [2, 1, 1], 2, (w, run) => async ({ stage, n }, ctx) => {
      if (stage === 'a' && n === 1) {
        await must(w, () => w.entered('b0'), 'item 0 in stage b');
        return ctx.suspend({ why: 1 });
      }
      if (stage === 'b' && n === 0) {
        await must(w, () => w.settled(1, 'suspended'), 'item 1 suspended');
        await run().cancel();
      }
      return undefined;
    });
    expect(ours.res.status).toBe('canceled');
    expect(ours.res.steps['per']).toMatchObject({ status: 'canceled', output: [] });
    expect(ours.res.state).toEqual({ a0: true, b0: true, a1: true });
    expect(theirs.res.status).toBe('canceled');
    expect(ours.res.steps['per']!.output).toEqual(theirs.res.steps['per']!.output);
    expect(ours.res.state).toEqual(theirs.res.state);
  }, RUN_TIMEOUT);

  it('the first failure in time wins — over a lower index failing later, and over an earlier suspension', async () => {
    // Breaks if (P5): the failed aggregate reports the last failure — item 0's. Breaks if (P6b):
    // a suspension outranks a failure — the fail finisher takes only a clean suspension flag and
    // the suspend finisher takes either fault flag. (P6, the fail finisher taking only a clean
    // suspension flag, strands the run and fails this case at its timeout.)
    //
    // Bounds [3, 1, 1], three items, all in stage a at once: item 2 suspends, then item 1 fails,
    // then item 0 fails — each step waiting for the previous item's progress event. The twin,
    // under the same gates, keeps its first `errorResult` too.
    const { ours, theirs } = await both('p-fail', [3, 1, 1], 3, (w) => async ({ stage, n }, ctx) => {
      if (stage !== 'a') return undefined;
      if (n === 2) return ctx.suspend({ why: 2 });
      if (n === 1) {
        await must(w, () => w.settled(2, 'suspended'), 'item 2 suspended');
        throw new Error('item 1 fails in a');
      }
      await must(w, () => w.settled(1, 'failed'), 'item 1 settled');
      throw new Error('item 0 fails in a');
    });
    expect(ours.res.status).toBe('failed');
    expect(ours.res.error?.message).toBe('item 1 fails in a');
    expect(entriesOf(ours.res).map((e) => e?.status)).toEqual(['failed', 'failed', 'suspended']);
    expect(theirs.res.status).toBe('failed');
    expect(ours.res.error?.message).toBe(theirs.res.error?.message);
  }, RUN_TIMEOUT);

  it('only suspensions: the lowest index, not the first in time', async () => {
    // Breaks if (P7): the suspended aggregate picks the highest index (`<` turned `>`) — item 1,
    // which suspended first.
    const { ours, theirs } = await both('p-susp', [2, 1, 1], 2, (w) => async ({ stage, n }, ctx) => {
      if (stage !== 'a') return undefined;
      if (n === 0) await must(w, () => w.settled(1, 'suspended'), 'item 1 suspended');
      return ctx.suspend({ why: n });
    });
    expect(ours.res.status).toBe('suspended');
    const meta = (r: Result) => (r.steps['per'] as unknown as { suspendPayload: { why: number; __workflow_meta: { foreachIndex: number } } }).suspendPayload;
    expect(meta(ours.res)).toMatchObject({ why: 0, __workflow_meta: { foreachIndex: 0 } });
    expect(await ours.snapshot()).toMatchObject({ status: 'suspended', suspendedPaths: { per: [0] } });
    expect(theirs.res.status).toBe('suspended');
    expect(meta(theirs.res)).toMatchObject({ why: 0, __workflow_meta: { foreachIndex: 0 } });
  }, RUN_TIMEOUT);
});

describe('quotas and the run budget bind across items (row 116)', () => {
  /**
   * Stage `b` of a [1, 2, 1] pipeline over four items holds each attempt until a second `b` is
   * inside, or {@link PROBE} turns pass: two lanes of `b`, so any second attempt the engine would admit
   * arrives. With `uses` the peak is 1; without it — the control that shows the hold makes the
   * peak happen — 2.
   */
  async function bPeak(withLimit: boolean) {
    const api = init({ clock: new ManualClock(EPOCH) });
    const w = new World();
    const gpu = api.limit(1, { id: 'gpu' });
    const uses = (id: string) => (withLimit && (id === 'b' || id === 'after') ? { uses: [gpu] } : {});
    const hold = async ({ stage }: At) => {
      if (stage === 'b') await until(() => (w.inFlight.get('b') ?? 0) >= 2, PROBE);
      return undefined;
    };
    const stages = scripted(api, w, ['a', 'b', 'c'], hold, uses);
    const [after] = scripted(api, w, ['after'], async () => ({ done: true }), uses, z.any());
    const workflow = piped(api, `limit-${withLimit}`, stages, [1, 2, 1], { after });
    const { res } = await go(workflow, items(4), w);
    return { res, w, workflow };
  }

  it('limit(1) on a stage of two lanes: never two attempts of it at once, and a parent step shares the quota', async () => {
    // Breaks if (P8): a pipeline stage's leaf takes no quota — b's peak is then 2, and the gpu
    // pool loses the stage's takers.
    const limited = await bPeak(true);
    expect(limited.res.status).toBe('success');
    expect(limited.w.peak.get('b')).toBe(1);
    expect(limited.w.log.filter((x) => x.startsWith('b'))).toHaveLength(4);
    // One quota, one pool: both b lanes' attempts and the parent's `after` take from it.
    const compiled = compileMastraWorkflow(limited.workflow as never);
    const pools = compiled.pools.filter((p) => p.kind === 'limit');
    expect(pools.map((p) => (p as { quota: string }).quota)).toEqual(['gpu']);
    const takers = compiled.steps.filter((c) => c.quotas.includes('gpu')).map((c) => c.stepId);
    expect(takers.sort()).toEqual(['after', 'b', 'b']);
    expect([...pools[0]!.takers].sort()).toEqual(compiled.steps.filter((c) => c.quotas.includes('gpu')).flatMap((c) => c.attempts).sort());

    const free = await bPeak(false);
    expect(free.res.status).toBe('success');
    expect(free.w.peak.get('b')).toBe(2);
  }, RUN_TIMEOUT);

  it('run budget 1: one stage attempt at a time across the whole run', async () => {
    // Breaks if (P9): a pipeline stage's leaf takes no run permit — stages of different items then
    // run together. Every attempt holds until a second attempt of any stage is inside, or PROBE turns.
    const peakAt = async (concurrency: number | undefined) => {
      const api = init({ clock: new ManualClock(EPOCH), ...(concurrency === undefined ? {} : { concurrency }) });
      const w = new World();
      const stages = scripted(api, w, ['a', 'b', 'c'], async () => {
        await until(() => w.total >= 2, PROBE);
        return undefined;
      });
      const { res } = await go(piped(api, `budget-${String(concurrency)}`, stages, [2, 2, 1]), items(4), w);
      expect(res.status).toBe('success');
      expect(res.result).toEqual([0, 1, 2, 3].map((n) => ({ n, tag: 'dflt', seen: ['a', 'b', 'c'] })));
      return w.peakTotal;
    };
    expect(await peakAt(1)).toBe(1);
    // The control: unbudgeted, the same hold puts stages of different items in flight together.
    expect(await peakAt(undefined)).toBeGreaterThanOrEqual(2);
  }, RUN_TIMEOUT);
});

describe('per-stage retries under the parent\'s retryConfig (row 113)', () => {
  it('a failing stage retries itself; earlier stages are not re-run', async () => {
    // Breaks if (P10): stages are adapted without the parent's `retryConfig.attempts` — b's first
    // failure then fails the item. The twin re-runs the whole item from stage 0 under the parent's
    // retryConfig; here `a1` runs once (row 113, a recorded divergence).
    const clock = new ManualClock(EPOCH);
    const api = init({ clock });
    const w = new World();
    const stages = scripted(api, w, ['a', 'b', 'c'], async ({ stage, n, attempt }) => {
      if (stage === 'b' && n === 1 && attempt < 2) throw new Error(`b1 attempt ${attempt}`);
      return undefined;
    });
    const { res } = await go(piped(api, 'retries', stages, [1, 1, 1], { retryConfig: { attempts: 2, delay: 500 } }), items(3), w);
    expect(res.status).toBe('success');
    expect(res.result![1]).toEqual({ n: 1, tag: 'dflt', seen: ['a', 'b', 'c'] });
    expect(w.log.filter((x) => x.startsWith('a1') || x.startsWith('b1') || x.startsWith('c1'))).toEqual(['a1', 'b1', 'b1#1', 'b1#2', 'c1']);
    // Two retry delays of b1, on the run's clock.
    expect(clock.elapsed()).toBeGreaterThanOrEqual(1_000);
  }, RUN_TIMEOUT);
});

describe('the entry payload is the raw item (row 112) — recorded divergence, not a requirement', () => {
  it('an item entry\'s and a failed aggregate\'s payload: the raw item here, the body-validated item on the twin', async () => {
    // RECORDED DIVERGENCE (row 112): the twin records the item once validated by the body's input
    // schema (`handlers/step.ts:111-115`, `:173`), so `tag` takes its default there; here the
    // payload is the raw item. This pins the CURRENT behaviour: when row 112 is fixed, this case
    // flips to the twin's value, with the row.
    // Breaks if (P11): an item entry carries no payload.
    const raw = items(2, { 1: { fail: true } });
    const api = init({ clock: new ManualClock(EPOCH) });
    const w = new World();
    const stages = scripted(api, w, ['a', 'b', 'c'], async ({ stage, n }) => {
      if (stage === 'b' && n === 1) throw new Error('item 1 fails in b');
      return undefined;
    });
    const ours = await go(piped(api, 'payload', stages, [1, 1, 1]), raw, w);
    expect(ours.res.status).toBe('failed');
    expect((ours.res.steps['per'] as { payload?: unknown }).payload).toEqual({ n: 1, fail: true });
    expect(entriesOf(ours.res).map((e) => e?.payload)).toEqual([{ n: 0 }, { n: 1, fail: true }]);

    const theirs = await go(twin('payload-twin', [1, 1, 1]).workflow, raw);
    expect(theirs.res.status).toBe('failed');
    expect((theirs.res.steps['per'] as { payload?: unknown }).payload).toEqual({ n: 1, tag: 'dflt', fail: true });
  }, RUN_TIMEOUT);
});

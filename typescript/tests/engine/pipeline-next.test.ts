/**
 * **`pipeline()` on the default engine, and the twin differential** ([ADR 0015], W2; rows 111-115):
 * one pipeline workflow — `.foreach(...pipeline([a, b, c], { id: 'per', concurrency: [2, 1, 1] }))`,
 * then `.then(next)` — run three ways through Mastra's own `Run` over a real `Mastra` and
 * `InMemoryStore`:
 *
 * - **petri** — `init().createWorkflow` on `PetriExecutionEngine` (a `ManualClock`, [TIME-015], so the
 *   net's record stamps are virtual, and stage `b` moves it 10 ms per call): the stages compiled into
 *   the parent's net, c_j lanes per stage.
 * - **clone** — Mastra's `cloneWorkflow` of that very workflow (`create.ts:105-135`): a `new Workflow`
 *   with no `executionEngine`, so it runs on `DefaultExecutionEngine` over the same step graph. The
 *   pipeline mark rides in the entry's `metadata` under a symbol, which that engine never reads, so
 *   the entry runs as `.foreach(body, { concurrency: Σc_j })` — **the twin**, Layer 3's brand
 *   surviving cloning (ADR 0015 maintainer decision 1, as `race-next.test.ts` pins for a race). The
 *   body is the minted petri workflow, so each item runs as a child run on the petri engine (ADR
 *   0015 Consequences).
 * - **twin** — the pure-Mastra oracle: the same body parameters (`mintBody`: copying `stateSchema`,
 *   `validateInputs: true`) over Mastra's own `createWorkflow` / `createStep`, the same stage
 *   functions, `.foreach(body, { concurrency: Σc_j }).then(next)` on `DefaultExecutionEngine`.
 *
 * The differential covers a success, a stage failure, a stage bail, a cancel, a stage suspension and
 * an item's state copy: run status, the results, `next`'s input, the run's state (from a seeded
 * `initialState`, which every stage sees through its item's copy, row 114), the body id's aggregate
 * (`result.steps.per`), and the progress events where the engines agree. The body's input schema
 * counts its validation passes, so `getInitData()` pins the body's two. Where the engines differ,
 * the difference is the recorded divergence, asserted as recorded and citing its row: the item
 * entry's raw `payload` and absent `nestedRunId` (row 112); no progress for a dropped item (row 112);
 * per-stage retries (row 113); the twin bounding no stage, so admitting earlier and copying the state
 * before a merge petri's later admission sees (rows 111, 115); a suspended path naming the body only
 * (row 117).
 *
 * No real sleeps: stages never wait on a timer, and a test that needs items parked uses promise gates
 * and waits for a condition over event-loop turns (`until`), never for milliseconds. The cancel case
 * asserts only order-free facts.
 *
 * Each case names the `src/` mutant it kills; every kill was confirmed by a backup-and-restore of the
 * source file, byte-compared after the restore.
 *
 * Environment: `@mastra/core` from the pinned registry package, libpetri 8.0.0 (registry, not
 * linked). Tested, not proven: these are values the value-blind verifier cannot see.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { cloneWorkflow, createStep as mastraCreateStep, createWorkflow as mastraCreateWorkflow } from '@mastra/core/workflows';
import { init } from '../../src/mastra/index.js';
import { mintBody, Pipeline, pipelineOf, type BodyChain, type PipelineBodyParams } from '../../src/mastra/pipeline.js';
import { ManualClock } from '../support/manual-clock.js';

/**
 * The body's input: `tag` defaults, so a body-validated item differs from the raw one (row 112), and
 * every validation pass appends a `+`, so the passes are counted: the body's two (the foreach's, then
 * the child's start — `getInitData()`), then stage `a`'s own.
 */
const Item = z.object({
  n: z.number(),
  tag: z
    .string()
    .default('dflt')
    .transform((t) => `${t}+`),
  fail: z.boolean().optional(),
  bail: z.boolean().optional(),
  susp: z.boolean().optional(),
});
type ItemT = z.infer<typeof Item>;
type Mid = ItemT & { seen: string[] };

const BOUNDS = [2, 1, 1] as const;
const WIDTH = 4; // Σc_j

/** What a stage's `execute` is handed, as far as these stages read it. */
interface Ctx<I> {
  inputData: I;
  state: Record<string, unknown>;
  setState(s: unknown): Promise<void>;
  getInitData(): unknown;
  bail(v: unknown): unknown;
  suspend(p: unknown): Promise<unknown>;
}

/** A promise and its release. */
function gate(): { readonly wait: Promise<void>; open(): void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

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

interface Hooks {
  /** Awaited by `a` before it does anything else; {@link Trace.aIn} counts the items waiting on it. */
  aGate?: (n: number) => Promise<void> | undefined;
  /** Awaited by `b` after it logs its entry. */
  bGate?: Promise<void>;
  /** Items whose `b` throws on its first attempt only. */
  flaky?: ReadonlySet<number>;
  /** Called by `b` on entry: the petri side advances its clock there. */
  tick?: () => void;
}
interface Trace {
  /** Every `a` completion and every `b` and `c` entry, as `<stage><n>`. */
  readonly log: string[];
  /** Every `b` attempt, as `b<n>`, in order. */
  readonly attempts: string[];
  /** `a` currently inside its gate, and the most seen at once. */
  aIn: number;
  aPeak: number;
}

/**
 * `a -> b -> c` over {@link Item}, built with `create` — the petri `createStep`, or Mastra's own for
 * the twin — from the same functions. `a` sets `a<n>` and may bail; `b` copies the state it is handed
 * into `view`, sets `b<n>`, and may fail or suspend; `c` folds the trail into `out` beside `a`'s
 * `tag`, the `getInitData()` and the `view` that `b` read.
 */
function stagesWith(create: (params: unknown) => unknown, trace: Trace, hooks: Hooks): [unknown, unknown, unknown] {
  const a = create({
    id: 'a',
    inputSchema: Item,
    outputSchema: z.any(),
    execute: async ({ inputData, state, setState, bail }: Ctx<ItemT>) => {
      trace.aIn++;
      trace.aPeak = Math.max(trace.aPeak, trace.aIn);
      const held = hooks.aGate?.(inputData.n);
      if (held) await held;
      trace.aIn--;
      await setState({ ...state, [`a${inputData.n}`]: true });
      trace.log.push(`a${inputData.n}`);
      if (inputData.bail) return bail({ out: `bail${inputData.n}` });
      return { ...inputData, seen: ['a'] };
    },
  });
  const b = create({
    id: 'b',
    inputSchema: z.any(),
    outputSchema: z.any(),
    execute: async ({ inputData, state, setState, getInitData, suspend }: Ctx<Mid>) => {
      trace.log.push(`b${inputData.n}`);
      hooks.tick?.();
      const view = { ...state };
      const first = !trace.attempts.includes(`b${inputData.n}`);
      trace.attempts.push(`b${inputData.n}`);
      if (hooks.bGate) await hooks.bGate;
      await setState({ ...state, [`b${inputData.n}`]: true });
      if (inputData.fail) throw new Error(`item ${inputData.n} fails in b`);
      if (inputData.susp) return suspend({ why: inputData.n });
      if (first && hooks.flaky?.has(inputData.n)) throw new Error(`item ${inputData.n} flakes in b`);
      return { ...inputData, seen: [...inputData.seen, 'b'], init: getInitData(), view };
    },
  });
  const c = create({
    id: 'c',
    inputSchema: z.any(),
    outputSchema: z.any(),
    execute: async ({ inputData }: Ctx<Mid & { init: unknown; view: unknown }>) => {
      trace.log.push(`c${inputData.n}`);
      return { out: `${inputData.n}:${[...inputData.seen, 'c'].join('')}`, tag: inputData.tag, init: inputData.init, view: inputData.view };
    },
  });
  return [a, b, c];
}

/** `next` records the array it was handed. */
function nextWith(create: (params: unknown) => unknown, seen: unknown[]): unknown {
  return create({
    id: 'next',
    inputSchema: z.array(z.any()),
    outputSchema: z.any(),
    execute: async ({ inputData }: { inputData: unknown }) => {
      seen.push(inputData);
      return { count: (inputData as unknown[]).length };
    },
  });
}

const RETRY = { attempts: 1, delay: 0 } as const;
type Chain = { foreach(step: unknown, opts?: unknown): Chain; then(step: unknown): Chain; commit(): unknown };

interface Side {
  readonly workflow: unknown;
  readonly trace: Trace;
  /** What `next` was handed. */
  readonly seen: unknown[];
}
const newTrace = (): Trace => ({ log: [], attempts: [], aIn: 0, aPeak: 0 });

/** {@link ManualClock}'s epoch at virtual zero: every petri stamp before the clock first moves. */
const ORIGIN = 1_700_000_000_000;
/** A {@link ManualClock} the test can also move by hand, from inside a stage. */
class SteppedClock extends ManualClock {
  #skew = 0;
  advance(ms: number): void {
    this.#skew += ms;
  }
  override now(): number {
    return super.now() + this.#skew;
  }
  override epochNow(): number {
    return super.epochNow() + this.#skew;
  }
}

/** The petri workflow; `retry` puts {@link RETRY} on the parent. `b` advances its clock 10 ms per call. */
function petri(id: string, hooks: Hooks = {}, retry = false): Side {
  const clock = new SteppedClock(ORIGIN);
  hooks = { ...hooks, tick: () => clock.advance(10) };
  const api = init({ clock });
  const trace = newTrace();
  const seen: unknown[] = [];
  const stages = stagesWith(api.createStep as never, trace, hooks);
  const [body, options] = (api.pipeline as unknown as (s: unknown[], o: unknown) => [unknown, unknown])(stages, { id: 'per', concurrency: [...BOUNDS] });
  const workflow = (
    (api.createWorkflow as unknown as (p: unknown) => Chain)({ id, inputSchema: z.array(z.any()), outputSchema: z.any(), ...(retry ? { retryConfig: RETRY } : {}) })
      .foreach(body, options)
      .then(nextWith(api.createStep as never, seen))
  ).commit();
  return { workflow, trace, seen };
}

interface Cloned {
  engineType: string;
  executionEngine: { constructor: { name: string } };
  stepGraph: readonly { type: string; step?: { type: string; step: unknown }; opts?: { concurrency?: unknown }; metadata?: unknown }[];
  serializedStepGraph: unknown;
}
/** Mastra's `cloneWorkflow` of a fresh petri workflow — past the type checker, which refuses it (row 61). */
function clone(id: string, hooks: Hooks = {}): Side & { readonly workflow: Cloned; readonly source: Cloned } {
  const side = petri(`${id}-src`, hooks);
  const workflow = (cloneWorkflow as unknown as (w: unknown, o: { id: string }) => Cloned)(side.workflow, { id });
  return { ...side, workflow, source: side.workflow as Cloned };
}

/** The pure-Mastra twin over the factory's own body parameters. */
function twin(id: string, hooks: Hooks = {}, retry = false): Side {
  const trace = newTrace();
  const seen: unknown[] = [];
  const stages = stagesWith(mastraCreateStep as never, trace, hooks);
  const body = mintBody((params: PipelineBodyParams) => mastraCreateWorkflow(params as never) as unknown as BodyChain, 'per', stages);
  const workflow = (
    (mastraCreateWorkflow as unknown as (p: unknown) => Chain)({ id, inputSchema: z.array(z.any()), outputSchema: z.any(), ...(retry ? { retryConfig: RETRY } : {}) })
      .foreach(body, { concurrency: WIDTH })
      .then(nextWith(mastraCreateStep as never, seen))
  ).commit();
  return { workflow, trace, seen };
}

interface Event {
  readonly type: string;
  readonly payload?: Record<string, unknown>;
}
interface Entry {
  readonly status: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly output?: unknown;
  readonly payload?: unknown;
  readonly error?: { readonly message?: string };
  readonly metadata?: Record<string, unknown>;
}
interface Aggregate extends Entry {
  readonly suspendPayload?: { readonly __workflow_meta?: { readonly foreachOutput?: readonly Entry[] } };
}
interface Result {
  readonly status: string;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
  readonly state?: Record<string, unknown>;
  readonly suspended?: unknown;
  readonly steps: Record<string, Aggregate | undefined>;
}
interface RunLike {
  watch(cb: (e: Event) => void): unknown;
  start(o: unknown): Promise<Result>;
  cancel(): Promise<void>;
}

/** The run's initial state: every item's stages see it, through the item's copy (row 114). */
const SEED = { seed: 7 } as const;

/**
 * Runs `workflow` on a fresh Mastra over a fresh store, from {@link SEED}; `during` sees the run
 * before it starts; `events` collects the parent stream as it arrives.
 */
async function go(workflow: unknown, items: unknown[], during?: (run: RunLike) => void, events: Event[] = []): Promise<{ res: Result; events: Event[] }> {
  const id = (workflow as { id: string }).id;
  const storage = new InMemoryStore();
  const mastra = new Mastra({ storage, workflows: { [id]: workflow } as never, logger: false });
  const run = await (mastra as unknown as { getWorkflow(id: string): { createRun(): Promise<RunLike> } }).getWorkflow(id).createRun();
  run.watch((e) => events.push(e));
  during?.(run);
  const res = await run.start({ inputData: items, initialState: { ...SEED }, outputOptions: { includeState: true } });
  return { res, events };
}

const items = (count: number, extra: Record<number, Partial<ItemT>> = {}) => Array.from({ length: count }, (_, n) => ({ n, ...extra[n] }));

/** The progress events by item — index, status, output — sorted by index (arrival order differs). */
const progress = (events: readonly Event[]) =>
  events
    .filter((e) => e.type === 'workflow-step-progress')
    .map((e) => {
      const { id, totalCount, currentIndex, iterationStatus, iterationOutput } = e.payload!;
      return { id, totalCount, currentIndex, iterationStatus, iterationOutput };
    })
    .sort((x, y) => (x.currentIndex as number) - (y.currentIndex as number));

/** The parent stream's event types, progress collapsed: the shape all three engines share. */
const shape = (events: readonly Event[]) => [...new Set(events.map((e) => e.type))].sort();

/** An item entry without its clock stamps, `payload` and `metadata` — the parts the engines share. */
const comparable = (e: Entry) => ({ status: e.status, output: e.output, error: e.error?.message });
const foreachOutput = (a: Aggregate | undefined): readonly Entry[] => a?.suspendPayload?.__workflow_meta?.foreachOutput ?? [];

const sorted = (xs: readonly string[]) => [...xs].sort();
/**
 * Item `n`'s result: `a` saw the tag after three passes, `getInitData()` is the body's two, and `b`
 * saw the run's initial state through the item's copy plus `a`'s own write — no other item's.
 */
const out = (n: number) => ({ out: `${n}:abc`, tag: 'dflt+++', init: { n, tag: 'dflt++' }, view: { ...SEED, [`a${n}`]: true } });

describe('a forced cloneWorkflow of a petri pipeline', () => {
  it('is the twin by construction: a default-engine .foreach over the minted body at Σc_j, the mark only in metadata', () => {
    // Kills M1 (`src/mastra/pipeline.ts`, `Pipeline.width` returns `this.bounds.length`): the entry's
    // `concurrency` is then 3, not Σc_j = 4. Kills M2 (`FOREACH_PIPELINE` a string key, not a
    // symbol): the serialized graph then carries the pipeline.
    const { workflow, source } = clone('shape');
    expect(workflow.engineType).toBe('default');
    expect(workflow.executionEngine.constructor.name).toBe('DefaultExecutionEngine');
    const entry = workflow.stepGraph[0]!;
    expect(entry.type).toBe('foreach');
    const pipeline = pipelineOf(entry.metadata);
    expect(pipeline).toBeInstanceOf(Pipeline);
    const p = pipeline as Pipeline;
    expect(p.bounds).toEqual([2, 1, 1]);
    expect(entry.opts?.concurrency).toBe(WIDTH);
    expect(entry.step).toMatchObject({ type: 'step' });
    expect(entry.step!.step).toBe(p.body);
    // The body is the minted petri workflow: on the clone each item is a child run on the petri engine.
    expect((p.body as { engineType: string }).engineType).toBe('petri');
    expect((p.body as { stepGraph: readonly { step: unknown }[] }).stepGraph.map((s) => s.step)).toEqual([...p.stages]);
    // The serialized graph — what a snapshot stores — is a plain foreach. (Mastra's clone rebuilds
    // only the live step flow, so its own serialized graph is empty; the source's is the one to read.)
    const serialized = JSON.stringify(source.serializedStepGraph);
    expect(JSON.parse(serialized)).toMatchObject([{ type: 'foreach', step: { id: 'per' }, opts: { concurrency: WIDTH } }, { type: 'step', step: { id: 'next' } }]);
    expect(serialized).not.toContain('bounds');
    expect(serialized).not.toContain('stages');
  });

  it('admits Σc_j items to stage a at once, where the petri engine admits c_0 (rows 111, 115)', async () => {
    // Kills M1 (`Pipeline.width` returns `this.bounds.length`) only by the adapter's refusal of the
    // petri side (`pipeline-value`: the entry's concurrency 3 is not Σc_j = 4), before the clone runs;
    // the first case is what pins the clone's width. Kills P3
    // (`src/compiler/blueprints/pipeline.ts`, stage 0's lanes built from `bounds[1]`): petri then
    // admits 1.
    for (const [make, want] of [
      [(h: Hooks) => petri('peak-petri', h), BOUNDS[0]],
      [(h: Hooks) => clone('peak-clone', h), WIDTH],
      [(h: Hooks) => twin('peak-twin', h), WIDTH],
    ] as const) {
      const a = gate();
      const side = make({ aGate: () => a.wait });
      const running = go(side.workflow, items(6));
      await until(() => side.trace.aIn >= want);
      for (let i = 0; i < 50; i++) await turn(); // room for any surplus admission to show
      const parked = side.trace.aIn;
      a.open();
      const { res } = await running;
      expect(parked, (side.workflow as { id: string }).id).toBe(want);
      expect(side.trace.aPeak).toBe(want);
      expect(res.status).toBe('success');
    }
  });
});

describe('the twin differential: petri, clone, twin', () => {
  it('a success: results, next\'s input, the aggregate, the state and the progress set agree', async () => {
    // Kills P1 (`src/compiler/blueprints/pipeline.ts`, collect settles with `slot.item` instead of
    // the last stage's output): petri's results are then the raw items. Kills N1 (`src/mastra/runner.ts`
    // `openItem` opens an item on `{}`, not a copy of the run's state): `b`'s view then lacks `seed`.
    // Kills N3 (`runner.ts`, stage 0 validates against the body once, not twice): `init`'s tag is
    // then `dflt+`, `a`'s `dflt++`.
    const runs = await Promise.all([petri('ok-p'), clone('ok-c'), twin('ok-t')].map(async (side) => ({ side, ...(await go(side.workflow, items(4))) })));
    const want = [0, 1, 2, 3].map(out);
    for (const { side, res, events } of runs) {
      const id = (side.workflow as { id: string }).id;
      expect(res.status, id).toBe('success');
      expect(res.result, id).toEqual({ count: 4 });
      expect(side.seen, id).toEqual([want]);
      expect(res.steps['per'], id).toMatchObject({ status: 'success', output: want });
      expect(res.state, id).toEqual({ ...SEED, a0: true, b0: true, a1: true, b1: true, a2: true, b2: true, a3: true, b3: true });
      expect(progress(events), id).toEqual(want.map((o, k) => ({ id: 'per', totalCount: 4, currentIndex: k, iterationStatus: 'success', iterationOutput: o })));
      expect(sorted(side.trace.log), id).toEqual(sorted(['a0', 'a1', 'a2', 'a3', 'b0', 'b1', 'b2', 'b3', 'c0', 'c1', 'c2', 'c3']));
      // No stage records reach the parent: the body id is the only key beside the run's own.
      expect(Object.keys(res.steps).sort(), id).toEqual(['input', 'next', 'per']);
    }
    // The parent stream is the twin's (row 112): the foreach's start, a progress per item, the aggregate.
    expect(shape(runs[0]!.events)).toEqual(shape(runs[2]!.events));
    expect(shape(runs[1]!.events)).toEqual(shape(runs[2]!.events));
  });

  it('a stage failure: the drained items\' results, the error, the unmerged state and the progress set agree; payload and nestedRunId differ as row 112 records', async () => {
    // Kills M3 (`src/mastra/pipeline.ts`, `pipelineBodyParams` without `stateSchema`): the twin's
    // children then write the parent's state in place (`workflow.ts:3646-3648`), and the failed item's
    // `a1`, `b1` leak. (The clone's children run on the petri engine, which does not leak there.)
    // Kills G1 (`src/compiler/blueprints/pipeline.ts`, a fail settle forgets the item with 'merge'):
    // petri's state then has them. Kills N7 (`pipeline.ts` `itemBase` stamps `startedAt: 0`, not
    // stage 0's admission): items 0 and 1, admitted at once before any `b` moved the clock, then
    // start at 0.
    const its = items(3, { 1: { fail: true } });
    const runs = await Promise.all([petri('fail-p'), clone('fail-c'), twin('fail-t')].map(async (side) => ({ side, ...(await go(side.workflow, its)) })));
    const [ours, cloned, theirs] = runs;
    for (const { side, res, events } of runs) {
      const id = (side.workflow as { id: string }).id;
      expect(res.status, id).toBe('failed');
      expect(res.error?.message, id).toBe('item 1 fails in b');
      expect(side.seen, id).toEqual([]); // next never ran
      expect(res.state, id).toEqual({ ...SEED, a0: true, b0: true, a2: true, b2: true });
      const agg = res.steps['per'];
      expect(agg, id).toMatchObject({ status: 'failed', error: { message: 'item 1 fails in b' } });
      expect(foreachOutput(agg).map(comparable), id).toEqual([
        { status: 'success', output: out(0), error: undefined },
        { status: 'failed', output: undefined, error: 'item 1 fails in b' },
        { status: 'success', output: out(2), error: undefined },
      ]);
      expect(progress(events).map((p) => [p.currentIndex, p.iterationStatus]), id).toEqual([
        [0, 'success'],
        [1, 'failed'],
        [2, 'success'],
      ]);
      expect(res.steps['next'], id).toBeUndefined();
    }
    // Row 112, recorded: an item entry's and the failed aggregate's `payload` is the raw item here,
    // the body-validated one (defaults applied) on the twin; and no entry names a child run.
    expect(ours!.res.steps['per']!.payload).toEqual({ n: 1, fail: true });
    expect(theirs!.res.steps['per']!.payload).toEqual({ n: 1, tag: 'dflt+', fail: true });
    expect(cloned!.res.steps['per']!.payload).toEqual(theirs!.res.steps['per']!.payload);
    expect(foreachOutput(ours!.res.steps['per']).map((e) => e.payload)).toEqual(its);
    expect(foreachOutput(theirs!.res.steps['per']).map((e) => e.payload)).toEqual(its.map((i) => ({ ...i, tag: 'dflt+' })));
    for (const e of foreachOutput(ours!.res.steps['per'])) expect(e.metadata?.['nestedRunId']).toBeUndefined();
    for (const r of [cloned!, theirs!]) for (const e of foreachOutput(r.res.steps['per'])) expect(typeof e.metadata?.['nestedRunId']).toBe('string');
    // An item entry starts at stage 0's admission on the run's clock: items 0 and 1 were admitted at
    // once, before the first `b` advanced it; every entry ends after its `b` did.
    const stamps = foreachOutput(ours!.res.steps['per']).map((e) => [e.startedAt!, e.endedAt!] as const);
    expect(stamps[0]![0]).toBe(ORIGIN);
    expect(stamps[1]![0]).toBe(ORIGIN);
    for (const [startedAt, endedAt] of stamps) {
      expect(startedAt).toBeGreaterThanOrEqual(ORIGIN);
      expect(endedAt).toBeGreaterThan(startedAt);
    }
  });

  it('a stage-0 bail: the item succeeds with the bail value, later stages skipped, on all three; an item admitted after the bail sees its state', async () => {
    // Kills K1 (`src/engine/kernel.ts`, a top-level bail's outcome `output: undefined`): the clone's
    // child — a petri run of the body — then returns no result, and item 1 is a hole. Kills G6 (a
    // pipeline bail settles as a hole): petri's item 1 is then `undefined`.
    // Item 0 is held in `a` until item 1's bail has settled, so petri's second stage-0 lane frees on
    // that bail, after its merge, and item 2's copy has `a1`. The twin and the clone admitted all
    // three at once (rows 111, 115), before any merge.
    const its = items(3, { 1: { bail: true } });
    const runs = await Promise.all(
      [(h: Hooks) => petri('bail-p', h), (h: Hooks) => clone('bail-c', h), (h: Hooks) => twin('bail-t', h)].map(async (make) => {
        const events: Event[] = [];
        const bailed = async (): Promise<void> => {
          await until(() => progress(events).some((p) => p.currentIndex === 1));
        };
        const side = make({ aGate: (n) => (n === 0 ? bailed() : undefined) });
        return { side, ...(await go(side.workflow, its, undefined, events)) };
      }),
    );
    const ours = runs[0]!;
    for (const { side, res, events } of runs) {
      const id = (side.workflow as { id: string }).id;
      const want = [out(0), { out: 'bail1' }, side === ours.side ? { ...out(2), view: { ...SEED, a1: true, a2: true } } : out(2)];
      expect(res.status, id).toBe('success');
      expect(side.seen, id).toEqual([want]);
      expect(res.steps['per'], id).toMatchObject({ status: 'success', output: want });
      expect(res.state, id).toEqual({ ...SEED, a0: true, b0: true, a1: true, a2: true, b2: true });
      expect(side.trace.log, id).not.toContain('b1');
      expect(progress(events).map((p) => [p.currentIndex, p.iterationStatus, p.iterationOutput]), id).toEqual(want.map((o, k) => [k, 'success', o]));
    }
  });

  it('a cancel with every b parked: an empty aggregate on all three; the twin admits and merges more, and publishes a progress per canceled child (rows 112, 115)', async () => {
    // Kills, all in `src/compiler/blueprints/pipeline.ts`: N6 (the canceled finisher's output
    // `undefined`, not the results): petri's aggregate output is then missing. P2 (a drop forgets its item with
    // 'discard'): petri's state then loses the dropped items' `a1`, `a2`, `b0`. P5 (stage 0's `start`
    // without its inhibitor on the cancel): a freed stage-0 lane then admits item 3 after the cancel,
    // and `a3` runs. P6 (a hand-off without its inhibitor): item 0 is then handed to `c` after the
    // cancel, and `c0` runs.
    const mk = <S extends Side>(make: (h: Hooks) => S) => {
      const b = gate();
      const side = make({ bGate: b.wait });
      return { side, b };
    };
    const cancel = async ({ side, b }: { side: Side; b: ReturnType<typeof gate> }, parked: (log: readonly string[]) => boolean) => {
      let run!: RunLike;
      const running = go(side.workflow, items(4), (r) => (run = r));
      expect(await until(() => parked(side.trace.log)), (side.workflow as { id: string }).id).toBe(true);
      await run.cancel();
      b.open();
      return { side, ...(await running) };
    };
    // Petri: item 0 in b, items 1 and 2 done with a and waiting at the hand-off (row 115), item 3
    // never admitted — both stage-0 lanes are held.
    const ours = await cancel(mk((h) => petri('cancel-p', h)), (log) => ['a1', 'a2', 'b0'].every((x) => log.includes(x)));
    // The twin and the clone: all four items in b at once — Σc_j = 4 child runs, no stage bound.
    const all = (log: readonly string[]) => ['b0', 'b1', 'b2', 'b3'].every((x) => log.includes(x));
    const cloned = await cancel(mk((h) => clone('cancel-c', h)), all);
    const theirs = await cancel(mk((h) => twin('cancel-t', h)), all);

    for (const { side, res } of [ours, cloned, theirs]) {
      const id = (side.workflow as { id: string }).id;
      expect(res.status, id).toBe('canceled');
      expect(side.seen, id).toEqual([]);
      // No item reached c, so nothing was collected: the aggregate's output is the empty results array.
      expect(res.steps['per'], id).toMatchObject({ status: 'canceled' });
      expect(res.steps['per']!.output, id).toEqual([]);
      expect(side.trace.log.filter((x) => x.startsWith('c')), id).toEqual([]);
    }
    expect(sorted(ours.side.trace.log)).toEqual(['a0', 'a1', 'a2', 'b0']);
    // Every dropped item's state merges, as the twin merges a canceled child's (row 114).
    expect(ours.res.state).toEqual({ ...SEED, a0: true, b0: true, a1: true, a2: true });
    const everything = { ...SEED, a0: true, a1: true, a2: true, a3: true, b0: true, b1: true, b2: true, b3: true };
    expect(theirs.res.state).toEqual(everything);
    expect(cloned.res.state).toEqual(everything);
    // Row 112, recorded: a dropped item publishes no progress here; the twin publishes a `success`
    // progress without output for each child the cancel stamped `canceled`.
    expect(progress(ours.events)).toEqual([]);
    for (const r of [cloned, theirs]) {
      expect(progress(r.events).map((p) => [p.currentIndex, p.iterationStatus, p.iterationOutput])).toEqual([0, 1, 2, 3].map((k) => [k, 'success', undefined]));
    }
  });

  it('an item\'s state is a copy taken at admission: a merge after it stays out of the item\'s view (row 114)', async () => {
    // Kills N9 (`src/mastra/runner.ts` `#stateOf` hands a stage the run's state, not its item's copy)
    // and N9b (the item's copy refreshed from the run's state at each stage call): item 1's `b` then
    // sees `a0` and `b0`, which item 0 merged while item 1 was held in `a`. Both items are admitted at
    // once on all three (c_0 = 2, Σc_j = 4), so all three agree.
    const runs = [];
    for (const make of [(h: Hooks) => petri('copy-p', h), (h: Hooks) => clone('copy-c', h), (h: Hooks) => twin('copy-t', h)]) {
      const events: Event[] = [];
      const merged = async (): Promise<void> => {
        await until(() => progress(events).some((p) => p.currentIndex === 0));
      };
      const side = make({ aGate: (n) => (n === 1 ? merged() : undefined) });
      runs.push({ side, ...(await go(side.workflow, items(2), undefined, events)) });
    }
    for (const { side, res } of runs) {
      const id = (side.workflow as { id: string }).id;
      expect(res.status, id).toBe('success');
      expect(side.seen, id).toEqual([[out(0), out(1)]]);
      expect(res.state, id).toEqual({ ...SEED, a0: true, b0: true, a1: true, b1: true });
      expect(side.trace.log.indexOf('c0'), id).toBeLessThan(side.trace.log.indexOf('a1'));
    }
  });

  it('a stage suspension: the run suspends at the lowest suspended index, the item\'s state merged; the paths differ as row 117 records', async () => {
    // Kills N8 (`src/compiler/blueprints/pipeline.ts`, a suspend settle forgets the item with
    // 'discard'): petri's state then lacks `a1`, `b1`.
    const its = items(3, { 1: { susp: true } });
    const runs = await Promise.all([petri('susp-p'), clone('susp-c'), twin('susp-t')].map(async (side) => ({ side, ...(await go(side.workflow, its)) })));
    const [ours, cloned, theirs] = runs;
    for (const { side, res, events } of runs) {
      const id = (side.workflow as { id: string }).id;
      expect(res.status, id).toBe('suspended');
      expect(side.seen, id).toEqual([]);
      expect(res.state, id).toEqual({ ...SEED, a0: true, b0: true, a1: true, b1: true, a2: true, b2: true });
      expect(Object.keys(res.steps).sort(), id).toEqual(['input', 'per']);
      const agg = res.steps['per'];
      expect(agg, id).toMatchObject({ status: 'suspended', suspendPayload: { why: 1, __workflow_meta: { foreachIndex: 1 } } });
      expect(foreachOutput(agg).map((e) => [e.status, e.output, (e as { suspendPayload?: { why?: unknown } }).suspendPayload?.why]), id).toEqual([
        ['success', out(0), undefined],
        ['suspended', undefined, 1],
        ['success', out(2), undefined],
      ]);
      expect(progress(events).map((p) => [p.currentIndex, p.iterationStatus, p.iterationOutput]), id).toEqual([
        [0, 'success', out(0)],
        [1, 'suspended', undefined],
        [2, 'success', out(2)],
      ]);
    }
    // Row 117, recorded: the suspended path names the body only, and `__workflow_meta` carries no
    // child run id or path; the twin's, and the clone's (whose child is a petri run of the body), name
    // the stage.
    expect(ours!.res.suspended).toEqual([['per']]);
    for (const r of [cloned!, theirs!]) {
      expect(r.res.suspended).toEqual([['per', 'b']]);
      expect(r.res.steps['per']!.suspendPayload!.__workflow_meta).toMatchObject({ runId: expect.any(String), path: ['b'] });
    }
    const meta = ours!.res.steps['per']!.suspendPayload!.__workflow_meta as Record<string, unknown>;
    expect(meta['runId']).toBeUndefined();
    expect(meta['path']).toBeUndefined();
  });

  it('a stage that fails once under the parent\'s retryConfig: the same results; petri retries the stage, the twin the whole item (row 113)', async () => {
    // Kills R1 (`src/mastra/adapt.ts`, stages adapted without the parent's `retryConfig` — decision
    // 2 B): petri's item 1 then fails on its first b attempt.
    const hooks: Hooks = { flaky: new Set([1]) };
    const ours = petri('retry-p', hooks, true);
    const theirs = twin('retry-t', hooks, true);
    const [p, t] = await Promise.all([go(ours.workflow, items(3)), go(theirs.workflow, items(3))]);
    const want = [0, 1, 2].map(out);
    for (const [side, r] of [
      [ours, p],
      [theirs, t],
    ] as const) {
      expect(r.res.status, (side.workflow as { id: string }).id).toBe('success');
      expect(side.seen).toEqual([want]);
      expect(r.res.steps['per']).toMatchObject({ status: 'success', output: want });
      expect(side.trace.attempts.filter((x) => x === 'b1')).toHaveLength(2);
    }
    // Recorded: stage a ran once for item 1 here, twice on the twin, which re-ran the item from stage 0.
    expect(ours.trace.log.filter((x) => x === 'a1')).toHaveLength(1);
    expect(theirs.trace.log.filter((x) => x === 'a1')).toHaveLength(2);
  });
});

/**
 * **`pipeline()` end to end** ([ADR 0015], W1): `init().pipeline` on `PetriExecutionEngine`, run
 * through Mastra's own `Run` over a real `Mastra` and `InMemoryStore`, with real Mastra steps, the
 * real pipeline gadget, leaf, run scope and runner — against **the twin**: the same three stages on
 * `DefaultExecutionEngine` as `.foreach(nestedWorkflow, { concurrency: Σc_j })`, the body minted by
 * `mintBody` (the factory's own builder: copying `stateSchema`, `validateInputs: true`) over
 * Mastra's own `createWorkflow` and `createStep`.
 *
 * - **Outcomes**: a success's results in input order; a stage-1 failure after a stage-0 `setState`
 *   leaves the run's state unmerged; a stage-0 bail is the item's output; a suspension merges its
 *   state; a cancel merges what it drops (rows 111, 114).
 * - **Events**: one `workflow-step-progress` per settled item, the twin's set (row 112).
 * - **The body's record**: each item's `foreachOutput` entry under the body id as the item leaves,
 *   as Mastra's worker `Object.assign`s it (`handlers/control-flow.ts:1179`) — read from the kernel's
 *   step results at a firing that fails mid-pipeline, the one place it outlives the aggregate.
 * - **Resume** (row 117): refused by name, `pipeline`, however the suspension is named, the stored
 *   snapshot untouched; a stage's own id never reaches the engine.
 * - **`getInitData()`** in stage 1 is the body-validated item, defaults applied (row 112).
 * - **Hand-off order** (row 115): recorded, not required.
 *
 * Each case names the mutation that breaks it (G1–G7: `src/compiler/blueprints/pipeline.ts`; E1:
 * `src/mastra/engine.ts`'s decode-path branch).
 *
 * Environment: `@mastra/core` from the pinned registry package, libpetri 8.0.0 (registry, not
 * linked), the machine clock (small real timers; the kernel case a `ManualClock`). Tested, not
 * proven: these are values the value-blind verifier cannot see.
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
import { ManualClock } from '../support/manual-clock.js';

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** What a stage's `execute` is handed, as far as these stages read it. */
interface Ctx<I> {
  inputData: I;
  state: Record<string, unknown>;
  setState(s: unknown): Promise<void>;
  getInitData(): unknown;
  bail(v: unknown): unknown;
  suspend(p: unknown, o?: unknown): Promise<unknown>;
}

interface Opts {
  readonly aMs?: number;
  readonly bMs?: number;
  /** Awaited by `b` before it does anything else. */
  gate?: Promise<void>;
  /** Called as `b` enters, with the item's `n`. */
  onB?: (n: number) => void;
}

/**
 * `a -> b -> c` over {@link Item}, built with `create` — the petri `createStep`, or Mastra's own for
 * the twin — from the same functions. `a` sets `a<n>` and may bail; `b` sets `b<n>`, reads
 * `getInitData()`, and may fail or suspend; `c` folds the trail into `out`. `log` takes every entry.
 */
function stagesWith(create: (params: unknown) => unknown, log: string[], o: Opts = {}): [unknown, unknown, unknown] {
  const a = create({
    id: 'a',
    inputSchema: Item,
    outputSchema: z.any(),
    execute: async ({ inputData, state, setState, bail }: Ctx<ItemT>) => {
      log.push(`a${inputData.n}`);
      await setState({ ...state, [`a${inputData.n}`]: true });
      await sleep(o.aMs ?? 2);
      if (inputData.bail) return bail({ out: `bail${inputData.n}` });
      return { ...inputData, seen: ['a'] };
    },
  });
  const b = create({
    id: 'b',
    inputSchema: z.any(),
    outputSchema: z.any(),
    resumeSchema: z.any(),
    execute: async ({ inputData, state, setState, suspend, getInitData }: Ctx<Mid>) => {
      log.push(`b${inputData.n}`);
      o.onB?.(inputData.n);
      if (o.gate) await o.gate;
      await sleep(o.bMs ?? 4);
      await setState({ ...state, [`b${inputData.n}`]: true });
      if (inputData.fail) throw new Error(`item ${inputData.n} fails in b`);
      if (inputData.susp) return suspend({ why: inputData.n }, { resumeLabel: 'L' });
      return { ...inputData, seen: [...inputData.seen, 'b'], init1: getInitData() };
    },
  });
  const c = create({
    id: 'c',
    inputSchema: z.any(),
    outputSchema: z.any(),
    execute: async ({ inputData }: Ctx<Mid>) => ({ out: `${inputData.n}:${[...inputData.seen, 'c'].join('')}`, init1: inputData.init1 }),
  });
  return [a, b, c];
}

/** `.foreach(...pipeline([a, b, c], { id: 'per', concurrency: bounds }))` on the petri engine. */
function petri(id: string, bounds: readonly number[], o: Opts = {}) {
  const api = init();
  const log: string[] = [];
  const stages = stagesWith(api.createStep as never, log, o);
  const workflow = api
    .createWorkflow({ id, inputSchema: z.array(z.any()), outputSchema: z.any() })
    .foreach(...(api.pipeline as unknown as (s: unknown[], p: unknown) => [never, never])(stages, { id: 'per', concurrency: bounds }))
    .commit();
  return { workflow, log };
}

/** The twin: the minted body over Mastra's own factories, `.foreach(body, { concurrency: Σc_j })`. */
function twin(id: string, bounds: readonly number[], o: Opts = {}) {
  const log: string[] = [];
  const stages = stagesWith(mastraCreateStep as never, log, o);
  const body = mintBody((params: PipelineBodyParams) => mastraCreateWorkflow(params as never) as unknown as BodyChain, 'per', stages);
  const width = bounds.reduce((x, y) => x + y, 0);
  const workflow = mastraCreateWorkflow({ id, inputSchema: z.array(z.any()), outputSchema: z.any() })
    .foreach(body as never, { concurrency: width })
    .commit();
  return { workflow, log };
}

interface Event {
  readonly type: string;
  readonly payload?: Record<string, unknown>;
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

/** Runs `workflow` on a fresh Mastra over a fresh store; `during` sees the run before it starts. */
async function go(workflow: unknown, items: unknown[], during?: (run: RunLike) => void) {
  const id = (workflow as { id: string }).id;
  const storage = new InMemoryStore();
  const mastra = new Mastra({ storage, workflows: { [id]: workflow } as never, logger: false });
  const run = (await (mastra as unknown as { getWorkflow(id: string): { createRun(): Promise<RunLike> } }).getWorkflow(id).createRun()) as RunLike;
  const events: Event[] = [];
  run.watch((e) => events.push(e));
  during?.(run);
  const res = await run.start({ inputData: items, initialState: {}, outputOptions: { includeState: true } });
  const snapshot = async (): Promise<unknown> =>
    (await storage.getStore('workflows'))!.loadWorkflowSnapshot({ workflowName: id, runId: run.runId });
  return { res, events, run, snapshot };
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
  });

  it('getInitData() in stage 1 is the body-validated item, defaults applied, as on the twin', async () => {
    // Breaks if: a stage after 0 is handed the raw item as `initData` (runner M2 — no `initData`
    // override on the stage view): `tag` is then missing.
    const extra = { 1: { tag: 'mine' } };
    const ours = await go(petri('init', [1, 1, 1]).workflow, items(2, extra));
    const theirs = await go(twin('init-twin', [1, 1, 1]).workflow, items(2, extra));
    const inits = (r: Result) => (r.result as { init1: unknown }[]).map((x) => x.init1);
    expect(inits(ours.res)).toEqual([{ n: 0, tag: 'dflt' }, { n: 1, tag: 'mine' }]);
    expect(inits(ours.res)).toEqual(inits(theirs.res));
  });

  it('one progress event per item, the twin\'s set', async () => {
    // Breaks if (G4): an item's leave publishes no `step-settled` with its `foreachIndex`.
    const ours = await go(petri('prog', [2, 1, 1]).workflow, items(4, { 2: { fail: true } }));
    const theirs = await go(twin('prog-twin', [2, 1, 1]).workflow, items(4, { 2: { fail: true } }));
    expect(progress(ours.events)).toHaveLength(4);
    expect(progress(ours.events)).toEqual(progress(theirs.events));
    expect(progress(ours.events)[2]).toMatchObject({ currentIndex: 2, iterationStatus: 'failed' });
  });

  it('a stage-1 failure after a stage-0 setState: the item\'s state is not merged, as on the twin', async () => {
    // Breaks if (G1): a fail settle forgets the item with 'merge' — `a2` and `b2` then leak.
    // Four items: item 2 reaching stage b frees a stage-0 lane, which admits item 3 before b fails.
    const ours = await go(petri('fail', [2, 1, 1]).workflow, items(4, { 2: { fail: true } }));
    const theirs = await go(twin('fail-twin', [2, 1, 1]).workflow, items(4, { 2: { fail: true } }));
    expect(ours.res.status).toBe('failed');
    expect(ours.res.error?.message).toBe('item 2 fails in b');
    expect(ours.res.error?.message).toBe(theirs.res.error?.message);
    expect(ours.res.state).toEqual({ a0: true, b0: true, a1: true, b1: true, a3: true, b3: true });
    expect(ours.res.state).toEqual(theirs.res.state);
  });

  it('a stage-0 bail: the item succeeds with the bail output, later stages skipped, as on the twin', async () => {
    // Breaks if (G6): a bail settles as a hole (`undefined`) instead of the bail output.
    const side = petri('bail', [2, 1, 1]);
    const ours = await go(side.workflow, items(3, { 1: { bail: true } }));
    const theirs = await go(twin('bail-twin', [2, 1, 1]).workflow, items(3, { 1: { bail: true } }));
    expect(ours.res.status).toBe('success');
    expect(ours.res.result![1]).toEqual({ out: 'bail1' });
    expect(ours.res.result).toEqual(theirs.res.result);
    expect(side.log).not.toContain('b1');
    expect(ours.res.state).toEqual(theirs.res.state);
  });

  it('a cancel: every dropped item\'s state is merged, as the twin merges a canceled child\'s', async () => {
    // Breaks if (G2): a drop forgets its item with 'discard' — `a1`, `a2` (waiting at the hand-off)
    // and `a0`, `b0` (in stage b when the cancel lands) then vanish.
    const cancelled = (o: Opts) => {
      let release!: () => void;
      let run: RunLike | undefined;
      o.gate = new Promise<void>((resolve) => (release = resolve));
      o.onB = (n) => {
        if (n === 0) setTimeout(() => void run!.cancel().then(release), 15);
      };
      return (r: RunLike) => void (run = r);
    };
    const ourOpts: Opts = {};
    const ourSide = petri('cancel', [2, 1, 1], ourOpts);
    const ours = await go(ourSide.workflow, items(4), cancelled(ourOpts));
    const theirOpts: Opts = {};
    const theirs = await go(twin('cancel-twin', [2, 1, 1], theirOpts).workflow, items(4), cancelled(theirOpts));
    expect(ours.res.status).toBe('canceled');
    expect(theirs.res.status).toBe('canceled');
    // Order-free: the b gate holds stage b until the cancel, so exactly these four ran.
    expect([...ourSide.log].sort()).toEqual(['a0', 'a1', 'a2', 'b0']);
    expect(ours.res.state).toEqual({ a0: true, b0: true, a1: true, a2: true });
    // The twin admitted all four (concurrency 4) and merged every canceled child, these among them.
    expect(theirs.res.state).toMatchObject({ a0: true, b0: true, a1: true, a2: true });
    expect(ours.res.steps['per']).toMatchObject({ status: 'canceled', output: theirs.res.steps['per']!.output });
  });
});

describe('a suspended pipeline: the twin\'s outcome; every resume refused by name', () => {
  const its = () => items(3, { 1: { susp: true } });
  const comparable = (s: unknown) => JSON.parse(JSON.stringify(s)) as unknown;

  it('suspends at the body, merging the item\'s state, and refuses every resume naming it', async () => {
    // Breaks if (G3): a suspend settle discards — `a1`, `b1` then vanish. Breaks if the label, the
    // auto-detected step, the body id or the twin's own path reaches anything but the `pipeline` refusal.
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
  });

  it('a resume naming a stage\'s own id is Mastra\'s refusal: the stage was never suspended', async () => {
    // Breaks if: the suspension is stored under the stage's id rather than the body's.
    const ours = await go(petri('susp-stage', [2, 1, 1]).workflow, its());
    const before = comparable(await ours.snapshot());
    await expect(ours.run.resume({ step: 'b', resumeData: {} })).rejects.toThrow('This workflow step "b" was not suspended');
    expect(comparable(await ours.snapshot())).toEqual(before);
  });

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
  });
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
    const report = await runWorkflowDetailed(compile(description), [1, 2], { runner: new Runner(1), clock: new ManualClock(1_700_000_000_000) });
    expect(report.outcome.status).toBe('stranded');
    expect(report.stepResults.get('per')).toMatchObject({ status: 'success', output: 8, payload: 2, metadata: { foreachIndex: 1 } });
  });
});

describe('the hand-off order (row 115) — recorded, not required', () => {
  it('bounds [2, 1, 1], six items, a fast stage 0 and a slower stage 1: the order stage 1 sees', async () => {
    // Recorded divergence, not a requirement: when several stage-0 lanes are done and the stage-1
    // lane frees, the lowest lane wins, so item 1 — parked on lane 1 since the start — waits until
    // stage 0's queue drains and runs last. The twin bounds no stage and runs b in arrival order.
    // A change here is a change to row 115, not a regression by itself.
    // Pinned loosely, so a loaded runner cannot flake it: item 2 overtakes item 1 at stage 1. Seen
    // unloaded: ['b0', 'b2', 'b3', 'b4', 'b5', 'b1'].
    const side = petri('order', [2, 1, 1], { aMs: 1, bMs: 25 });
    const ours = await go(side.workflow, items(6));
    expect(ours.res.status).toBe('success');
    const b = side.log.filter((c) => c.startsWith('b'));
    expect([...b].sort()).toEqual(['b0', 'b1', 'b2', 'b3', 'b4', 'b5']);
    expect(b[0]).toBe('b0');
    expect(b.indexOf('b2')).toBeLessThan(b.indexOf('b1'));
  });
});

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EventEmitterPubSub } from '@mastra/core/events';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import type { ExecutionEngineOptions } from '@mastra/core/workflows';
import { PetriExecutionEngine } from '../../src/mastra/engine.js';

/**
 * Step watch events ([ADR 0008]) against the default engine as the ORACLE: the same workflow is
 * built on `DefaultExecutionEngine` and on `PetriExecutionEngine`, run through Mastra's own `Run`,
 * and every `run.watch()` event is captured. What is compared, per step id and in order: the
 * event's type and its whole payload. Masked: what a clock stamps (`startedAt`, `endedAt`,
 * `suspendedAt`, `resumedAt`, `timestamp` — as present / absent), the run id, and `stepCallId`,
 * which is checked separately to correlate each start with its result (a retried step keeps one).
 */

type Engine = 'default' | 'petri';
type Loose = Record<string, unknown>;
interface WatchEvent {
  readonly type: string;
  readonly payload?: Loose;
  readonly data?: unknown;
}

const num = z.object({ n: z.number() });
const STAMPS = new Set(['startedAt', 'endedAt', 'suspendedAt', 'resumedAt', 'timestamp']);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** An engine config for `createWorkflow`: the default engine with Mastra's options, or ours with the same. */
function on(engine: Engine, options: Partial<ExecutionEngineOptions> = {}, petri: { concurrency?: number } = {}): object {
  return engine === 'default' ? { options } : { executionEngine: new PetriExecutionEngine({ options, iterationBound: 20, ...petri }) };
}

/** A value with every stamp masked, every error reduced to its message, every uuid replaced. */
function norm(value: unknown, runId: string): unknown {
  if (value instanceof Error) return { error: value.message };
  if (Array.isArray(value)) return value.map((v) => norm(v, runId));
  if (typeof value === 'string') return value.split(runId).join('<run>').replace(UUID, '<uuid>');
  if (value === null || typeof value !== 'object') return value;
  const out: Loose = {};
  for (const [k, v] of Object.entries(value as Loose)) {
    if (STAMPS.has(k)) out[k] = typeof v === 'number' ? '<t>' : v;
    else if (k === 'stepCallId') out[k] = typeof v === 'string' ? '<call>' : v;
    else if (k === 'runId' || k === 'nestedRunId') out[k] = typeof v === 'string' ? '<run>' : v;
    else out[k] = norm(v, runId);
  }
  return out;
}

interface Captured {
  readonly events: readonly WatchEvent[];
  readonly result: Loose;
  readonly runId: string;
}

interface Startable {
  createRun(options?: { runId?: string }): Promise<{
    readonly runId: string;
    watch(cb: (e: unknown) => void): () => void;
    start(args: Loose): Promise<unknown>;
    resume(args: Loose): Promise<unknown>;
    cancel(): Promise<void>;
    stream(args: Loose): { fullStream: AsyncIterable<unknown> };
  }>;
}

/** Runs `wf` once with `run.watch()` attached, and returns every event it saw. */
async function capture(wf: unknown, inputData: unknown, during?: (run: Awaited<ReturnType<Startable['createRun']>>) => void): Promise<Captured> {
  const run = await (wf as Startable).createRun();
  const events: WatchEvent[] = [];
  const unwatch = run.watch((e) => void events.push(e as WatchEvent));
  const started = run.start({ inputData });
  during?.(run);
  const result = (await started) as Loose;
  // Let any trailing un-awaited publish land before comparing.
  await new Promise((r) => setTimeout(r, 5));
  unwatch();
  return { events, result, runId: run.runId };
}

const STEP_EVENT = /^workflow-(step-|canceled)/;

/** The step events of one capture, normalised, grouped by step id in the order they arrived. */
function byStep(c: Captured): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const e of c.events) {
    if (!STEP_EVENT.test(e.type)) continue;
    const id = typeof e.payload?.['id'] === 'string' ? (e.payload['id'] as string).replace(UUID, '<uuid>') : '(run)';
    (out[id] ??= []).push({ type: e.type, payload: norm(e.payload, c.runId) });
  }
  return out;
}

/** The event types of one capture, in the order they arrived. */
const types = (c: Captured): string[] => c.events.map((e) => e.type);

/** Every step start's `stepCallId` equals its own result's: each start is closed by the next result/suspended under its id. */
function expectCorrelated(c: Captured): void {
  const open = new Map<string, string>();
  for (const e of c.events) {
    const id = e.payload?.['id'] as string | undefined;
    const call = e.payload?.['stepCallId'] as string | undefined;
    if (id === undefined || call === undefined) continue;
    if (e.type === 'workflow-step-start') {
      expect(open.has(id), `a second start for '${id}' before its result`).toBe(false);
      open.set(id, call);
    } else if (e.type === 'workflow-step-result' || e.type === 'workflow-step-suspended') {
      expect(call).toBe(open.get(id));
    } else if (e.type === 'workflow-step-finish') {
      expect(call).toBe(open.get(id));
      open.delete(id);
    }
    if (e.type === 'workflow-step-suspended') open.delete(id);
  }
  expect([...open.keys()]).toEqual([]);
}

/** Runs the workflow on both engines and asserts the petri engine's step events equal the oracle's. */
async function differential(make: (engine: Engine) => unknown, inputData: unknown, during?: Parameters<typeof capture>[2]) {
  const oracle = await capture(make('default'), inputData, during);
  const ours = await capture(make('petri'), inputData, during);
  expect(ours.result['status']).toBe(oracle.result['status']);
  expect(byStep(ours)).toEqual(byStep(oracle));
  expectCorrelated(oracle);
  expectCorrelated(ours);
  return { oracle, ours };
}

const plus = (id: string, by = 1) =>
  createStep({ id, inputSchema: num, outputSchema: num, execute: async ({ inputData }) => ({ n: inputData.n + by }) });

// ---------------------------------------------------------------------------------------------

describe('step watch events — the default engine as the oracle', () => {
  it('a linear chain: start, result, finish per step, in the oracle order', async () => {
    const make = (engine: Engine) =>
      createWorkflow({ id: 'ev-linear', inputSchema: num, outputSchema: num, ...on(engine) })
        .then(plus('a'))
        .then(plus('b', 10))
        .commit();
    const { oracle, ours } = await differential(make, { n: 1 });
    expect(types(ours)).toEqual(types(oracle));
    expect(types(ours)).toEqual([
      'workflow-step-start',
      'workflow-step-result',
      'workflow-step-finish',
      'workflow-step-start',
      'workflow-step-result',
      'workflow-step-finish',
    ]);
  });

  it('a failing step: start, a failed result carrying the error, finish', async () => {
    const boom = createStep({
      id: 'boom',
      inputSchema: num,
      outputSchema: num,
      execute: async () => {
        throw new Error('kaboom');
      },
    });
    const make = (engine: Engine) => createWorkflow({ id: 'ev-fail', inputSchema: num, outputSchema: num, ...on(engine) }).then(boom).commit();
    const { ours } = await differential(make, { n: 1 });
    expect(byStep(ours)['boom']).toMatchObject([{}, { type: 'workflow-step-result', payload: { status: 'failed', error: { error: 'kaboom' } } }, {}]);
  });

  it('retries: one start and one result for the step, the last attempt\'s, under one stepCallId', async () => {
    const tries = { default: 0, petri: 0 };
    const make = (engine: Engine) =>
      createWorkflow({ id: 'ev-retry', inputSchema: num, outputSchema: num, retryConfig: { attempts: 2 }, ...on(engine) })
        .then(
          createStep({
            id: 'flaky',
            inputSchema: num,
            outputSchema: num,
            execute: async ({ inputData, retryCount }) => {
              tries[engine]++;
              if (retryCount < 2) throw new Error(`try ${retryCount}`);
              return { n: inputData.n + retryCount };
            },
          }),
        )
        .commit();
    const { ours } = await differential(make, { n: 1 });
    expect(tries).toEqual({ default: 3, petri: 3 });
    expect(byStep(ours)['flaky']!.map((e) => (e as Loose)['type'])).toEqual(['workflow-step-start', 'workflow-step-result', 'workflow-step-finish']);
  });

  it('parallel arms: each arm starts and settles on its own', async () => {
    const make = (engine: Engine) =>
      createWorkflow({ id: 'ev-par', inputSchema: num, outputSchema: z.any(), ...on(engine) })
        .parallel([plus('p1'), plus('p2', 2), plus('p3', 3)])
        .commit();
    const { ours } = await differential(make, { n: 1 });
    expect(Object.keys(byStep(ours)).sort()).toEqual(['p1', 'p2', 'p3']);
  });

  it('a branch: only the taken arm publishes', async () => {
    const make = (engine: Engine) =>
      createWorkflow({ id: 'ev-branch', inputSchema: num, outputSchema: z.any(), ...on(engine) })
        .branch([
          [async ({ inputData }) => inputData.n > 5, plus('big')],
          [async ({ inputData }) => inputData.n <= 5, plus('small')],
        ])
        .commit();
    const { ours } = await differential(make, { n: 1 });
    expect(Object.keys(byStep(ours))).toEqual(['small']);
  });

  it('a dowhile loop: one start per iteration carrying metadata.iterationCount, the prior iteration\'s fields dropped', async () => {
    const make = (engine: Engine) =>
      createWorkflow({ id: 'ev-loop', inputSchema: num, outputSchema: num, ...on(engine) })
        .dowhile(plus('inc'), async ({ inputData }) => inputData.n < 4)
        .commit();
    const { ours } = await differential(make, { n: 1 });
    const starts = byStep(ours)['inc']!.filter((e) => (e as Loose)['type'] === 'workflow-step-start') as { payload: Loose }[];
    expect(starts.map((s) => s.payload['metadata'])).toEqual([{ iterationCount: 1 }, { iterationCount: 2 }, { iterationCount: 3 }]);
  });

  it('a dountil loop', async () => {
    const make = (engine: Engine) =>
      createWorkflow({ id: 'ev-until', inputSchema: num, outputSchema: num, ...on(engine) })
        .dountil(plus('inc2', 2), async ({ inputData }) => inputData.n >= 5)
        .commit();
    await differential(make, { n: 0 });
  });

  it('bail: the bailing step\'s result is bailed', async () => {
    const make = (engine: Engine) =>
      createWorkflow({ id: 'ev-bail', inputSchema: num, outputSchema: num, ...on(engine) })
        .then(createStep({ id: 'quit', inputSchema: num, outputSchema: num, execute: async ({ inputData, bail }) => bail({ n: inputData.n * 100 }) }))
        .then(plus('never'))
        .commit();
    const { ours } = await differential(make, { n: 1 });
    expect(Object.keys(byStep(ours))).toEqual(['quit']);
  });

  it('input validation failure: the start carries the raw input, then the failure', async () => {
    const strict = createStep({ id: 'strict', inputSchema: z.object({ s: z.string() }), outputSchema: num, execute: async () => ({ n: 1 }) });
    const make = (engine: Engine) =>
      createWorkflow({ id: 'ev-invalid', inputSchema: num, outputSchema: num, ...on(engine) }).then(strict as never).commit();
    await differential(make, { n: 1 });
  });

  it('schema defaults: the start carries the validated input', async () => {
    const defaults = createStep({
      id: 'defaults',
      inputSchema: z.object({ n: z.number(), extra: z.string().default('x') }),
      outputSchema: num,
      execute: async ({ inputData }) => ({ n: inputData.n }),
    });
    const make = (engine: Engine) =>
      createWorkflow({ id: 'ev-defaults', inputSchema: num, outputSchema: num, ...on(engine) }).then(defaults as never).commit();
    const { ours } = await differential(make, { n: 1 });
    expect((byStep(ours)['defaults']![0] as { payload: Loose }).payload['payload']).toEqual({ n: 1, extra: 'x' });
  });

  it('.map(): a mapping step publishes as a step', async () => {
    const make = (engine: Engine) =>
      createWorkflow({ id: 'ev-map', inputSchema: num, outputSchema: z.any(), ...on(engine) })
        .then(plus('m0'))
        .map(async ({ inputData }) => ({ n: inputData.n * 3 }))
        .then(plus('m1'))
        .commit();
    await differential(make, { n: 1 });
  });
});

describe('step watch events — sleeps', () => {
  it('.sleep(ms): waiting, then result and finish', async () => {
    const make = (engine: Engine) =>
      createWorkflow({ id: 'ev-sleep', inputSchema: num, outputSchema: num, ...on(engine) })
        .then(plus('s0'))
        .sleep(5)
        .then(plus('s1'))
        .commit();
    const { oracle, ours } = await differential(make, { n: 1 });
    expect(types(ours)).toEqual(types(oracle));
  });

  it('.sleep(fn)', async () => {
    const make = (engine: Engine) =>
      createWorkflow({ id: 'ev-sleepfn', inputSchema: num, outputSchema: num, ...on(engine) })
        .then(plus('s0'))
        .sleep(async ({ inputData }) => inputData.n)
        .commit();
    await differential(make, { n: 1 });
  });

  it('.sleepUntil(date) and .sleepUntil(fn)', async () => {
    const make = (engine: Engine) =>
      createWorkflow({ id: 'ev-until-date', inputSchema: num, outputSchema: num, ...on(engine) })
        .sleepUntil(new Date(Date.now() + 5))
        .then(plus('u0'))
        .sleepUntil(async () => new Date(Date.now() + 3))
        .commit();
    const { oracle, ours } = await differential(make, { n: 1 });
    expect(types(ours)).toEqual(types(oracle));
  });
});

// ---------------------------------------------------------------------------------------------

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Doubles an item after a delay chosen so the items settle in one order, with no ties, at
 * concurrency 1 and 3 alike: at 3, item 3 at 20 ms, item 4 (started then) at 50, item 2 at 100,
 * item 1 at 150. Every gap is at least 30 ms: at 3 / 10 / 13 / 25 ms Mastra's own engine, the
 * oracle, once settled items out of this order on a machine at load ~20, so the spacing is widened
 * rather than the test retried.
 */
const DELAYS: Record<number, number> = { 1: 150, 2: 100, 3: 20, 4: 30 };
const doubler = (id: string, fail?: number) =>
  createStep({
    id,
    inputSchema: z.number(),
    outputSchema: z.number(),
    execute: async ({ inputData }) => {
      await delay(DELAYS[inputData] ?? 1);
      if (inputData === fail) throw new Error(`item ${inputData} failed`);
      return inputData * 2;
    },
  });

describe('step watch events — .foreach()', () => {
  const items = z.array(z.number());
  for (const concurrency of [1, 3]) {
    it(`concurrency ${concurrency}: one start, a progress per item with Mastra's counts, one aggregate result`, async () => {
      const make = (engine: Engine) =>
        createWorkflow({ id: `ev-fe-${concurrency}`, inputSchema: items, outputSchema: z.any(), ...on(engine) })
          .foreach(doubler('dbl'), { concurrency })
          .commit();
      const { ours } = await differential(make, [1, 2, 3, 4]);
      const seq = byStep(ours)['dbl'] as { type: string; payload: Loose }[];
      expect(seq.map((e) => e.type)).toEqual([
        'workflow-step-start',
        ...Array(4).fill('workflow-step-progress'),
        'workflow-step-result',
        'workflow-step-finish',
      ]);
      expect(seq.filter((e) => e.type === 'workflow-step-progress').map((e) => e.payload['completedCount'])).toEqual([1, 2, 3, 4]);
    });

    it(`concurrency ${concurrency}: a failing item — a failed progress, then the failed aggregate`, async () => {
      const make = (engine: Engine) =>
        createWorkflow({ id: `ev-fe-fail-${concurrency}`, inputSchema: items, outputSchema: z.any(), ...on(engine) })
          .foreach(doubler('dblf', 3), { concurrency })
          .commit();
      const { ours } = await differential(make, [1, 2, 3, 4]);
      const seq = byStep(ours)['dblf'] as { type: string; payload: Loose }[];
      expect(seq.at(-2)).toMatchObject({ type: 'workflow-step-result', payload: { status: 'failed', error: { error: 'item 3 failed' } } });
      expect(Object.keys(seq.at(-2)!.payload).sort()).toEqual(['endedAt', 'error', 'id', 'status', 'suspendPayload', 'suspendedAt']);
    });
  }

  it('a suspended item: a suspended progress not counted, then only workflow-step-suspended for the aggregate', async () => {
    const gateItem = createStep({
      id: 'gi',
      inputSchema: z.number(),
      outputSchema: z.number(),
      suspendSchema: z.object({ item: z.number() }),
      resumeSchema: z.object({ ok: z.boolean() }),
      execute: async ({ inputData, resumeData, suspend }) => {
        if (inputData === 2 && !resumeData) return suspend({ item: inputData });
        return inputData * 10;
      },
    });
    const make = (engine: Engine) =>
      createWorkflow({ id: 'ev-fe-susp', inputSchema: items, outputSchema: z.any(), ...on(engine) }).foreach(gateItem, { concurrency: 1 }).commit();
    const { ours } = await differential(make, [1, 2, 3]);
    const seq = byStep(ours)['gi'] as { type: string; payload: Loose }[];
    expect(seq.map((e) => e.type)).toEqual(['workflow-step-start', 'workflow-step-progress', 'workflow-step-progress', 'workflow-step-suspended']);
    expect(seq[2]!.payload).toMatchObject({ completedCount: 1, iterationStatus: 'suspended', currentIndex: 1 });
  });

  it('a bailing item: a failed progress, then the item\'s own record as the aggregate result', async () => {
    const bailer = createStep({
      id: 'bi',
      inputSchema: z.number(),
      outputSchema: z.number(),
      execute: async ({ inputData, bail }) => (inputData === 2 ? bail(99) : inputData),
    });
    const make = (engine: Engine) =>
      createWorkflow({ id: 'ev-fe-bail', inputSchema: items, outputSchema: z.any(), ...on(engine) }).foreach(bailer, { concurrency: 1 }).commit();
    await differential(make, [1, 2, 3]);
  });

  it('canceled while an item runs: the item\'s progress, no aggregate event, then workflow-canceled', async () => {
    const holds = createStep({
      id: 'hold',
      inputSchema: z.number(),
      outputSchema: z.number(),
      execute: async ({ inputData, abortSignal }) => {
        if (inputData === 2) {
          await new Promise<void>((resolve) => (abortSignal.aborted ? resolve() : abortSignal.addEventListener('abort', () => resolve(), { once: true })));
        }
        return inputData;
      },
    });
    const make = (engine: Engine) =>
      createWorkflow({ id: 'ev-fe-cancel', inputSchema: items, outputSchema: z.any(), ...on(engine) }).foreach(holds, { concurrency: 1 }).commit();
    const { oracle, ours } = await differential(make, [1, 2, 3], (run) => void delay(20).then(() => run.cancel()));
    expect(ours.result['status']).toBe('canceled');
    expect(types(ours)).toEqual(types(oracle));
    expect(types(ours)).toEqual(['workflow-step-start', 'workflow-step-progress', 'workflow-step-progress', 'workflow-canceled']);
  });

  it('an empty input: start, then the empty aggregate', async () => {
    const make = (engine: Engine) =>
      createWorkflow({ id: 'ev-fe-empty', inputSchema: items, outputSchema: z.any(), ...on(engine) }).foreach(doubler('dble')).commit();
    await differential(make, []);
  });
});

// ---------------------------------------------------------------------------------------------

type AnyRun = Awaited<ReturnType<Startable['createRun']>>;

/** `wf` registered on a new `Mastra` over `storage`, as the resume tests register it. */
function registered(storage: InMemoryStore, wf: unknown): Startable {
  const mastra = new Mastra({ storage, workflows: { wf } as never, logger: false });
  return (mastra as unknown as { getWorkflow(key: string): Startable }).getWorkflow('wf');
}

/** start(), then resume(): the events each phase's watcher saw, on one registered workflow. */
async function resumeCapture(wf: unknown, inputData: unknown, resume: Loose): Promise<{ start: Captured; resume: Captured }> {
  const run = await registered(new InMemoryStore(), wf).createRun();
  const phase = async (go: (r: AnyRun) => Promise<unknown>): Promise<Captured> => {
    const events: WatchEvent[] = [];
    const unwatch = run.watch((e) => void events.push(e as WatchEvent));
    const result = (await go(run)) as Loose;
    await delay(5);
    unwatch();
    return { events, result, runId: run.runId };
  };
  const start = await phase((r) => r.start({ inputData }));
  const resumed = await phase((r) => r.resume(resume));
  return { start, resume: resumed };
}

async function resumeDifferential(make: (engine: Engine) => unknown, inputData: unknown, resume: Loose) {
  const oracle = await resumeCapture(make('default'), inputData, resume);
  const ours = await resumeCapture(make('petri'), inputData, resume);
  for (const phase of ['start', 'resume'] as const) {
    expect(ours[phase].result['status'], phase).toBe(oracle[phase].result['status']);
    expect(byStep(ours[phase]), phase).toEqual(byStep(oracle[phase]));
    expectCorrelated(ours[phase]);
  }
  return { oracle, ours };
}

const gate = (id: string) =>
  createStep({
    id,
    inputSchema: num,
    outputSchema: num,
    resumeSchema: z.object({ add: z.number() }),
    suspendSchema: z.object({ ask: z.string() }),
    execute: async ({ inputData, resumeData, suspend }) => {
      if (!resumeData) return suspend({ ask: id });
      return { n: inputData.n + resumeData.add };
    },
  });

describe('step watch events — suspend and resume', () => {
  it('a suspended step publishes only workflow-step-suspended; its resumed start carries resumePayload and resumedAt', async () => {
    const make = (engine: Engine) =>
      createWorkflow({ id: 'ev-resume', inputSchema: num, outputSchema: num, ...on(engine) })
        .then(plus('before'))
        .then(gate('g'))
        .then(plus('after'))
        .commit();
    const { ours } = await resumeDifferential(make, { n: 1 }, { step: 'g', resumeData: { add: 5 } });
    expect((byStep(ours.start)['g'] as { type: string }[]).map((e) => e.type)).toEqual(['workflow-step-start', 'workflow-step-suspended']);
    const resumedStart = (byStep(ours.resume)['g'] as { type: string; payload: Loose }[])[0]!;
    expect(resumedStart.type).toBe('workflow-step-start');
    expect(resumedStart.payload).toMatchObject({ resumePayload: { add: 5 }, resumedAt: '<t>', payload: { n: 2 }, status: 'running' });
    expect(resumedStart.payload).not.toHaveProperty('suspendPayload');
  });

  it('a parallel arm resumed', async () => {
    const make = (engine: Engine) =>
      createWorkflow({ id: 'ev-resume-par', inputSchema: num, outputSchema: z.any(), ...on(engine) })
        .parallel([gate('pa'), plus('pb')])
        .commit();
    await resumeDifferential(make, { n: 1 }, { step: 'pa', resumeData: { add: 2 } });
  });

  it('a resumed .foreach(): the foreach start carries the resume payload; only the resumed item progresses', async () => {
    const gi = createStep({
      id: 'fgi',
      inputSchema: z.number(),
      outputSchema: z.number(),
      suspendSchema: z.object({ item: z.number() }),
      resumeSchema: z.object({ ok: z.boolean() }),
      execute: async ({ inputData, resumeData, suspend }) => {
        if (inputData === 2 && !resumeData) return suspend({ item: inputData });
        return inputData * 10;
      },
    });
    const make = (engine: Engine) =>
      createWorkflow({ id: 'ev-resume-fe', inputSchema: z.array(z.number()), outputSchema: z.any(), ...on(engine) })
        .foreach(gi, { concurrency: 1 })
        .commit();
    const { ours } = await resumeDifferential(make, [1, 2, 3], { step: 'fgi', resumeData: { ok: true }, forEachIndex: 1 });
    const seq = byStep(ours.resume)['fgi'] as { type: string; payload: Loose }[];
    expect(seq[0]).toMatchObject({ type: 'workflow-step-start', payload: { resumePayload: { ok: true }, resumedAt: '<t>', status: 'running' } });
  });
});

describe('step watch events — nested workflows, the emitStepEvents gate, cancel, stream', () => {
  it('a nested workflow: its step as a step, and the nested run\'s events republished under `<workflowId>.<id>`', async () => {
    const make = (engine: Engine) => {
      const inner = createWorkflow({ id: 'ev-inner', inputSchema: num, outputSchema: num, ...on(engine) })
        .then(plus('i1'))
        .then(plus('i2'))
        .commit();
      return createWorkflow({ id: 'ev-outer', inputSchema: num, outputSchema: num, ...on(engine) })
        .then(plus('o1'))
        .then(inner)
        .then(plus('o2'))
        .commit();
    };
    const { ours } = await differential(make, { n: 1 });
    expect(Object.keys(byStep(ours))).toEqual(expect.arrayContaining(['o1', 'ev-inner', 'ev-inner.i1', 'ev-inner.i2', 'o2']));
  });

  it('emitStepEvents: false publishes no step event, as on the default engine', async () => {
    const quiet = (engine: Engine) =>
      createWorkflow({ id: 'ev-quiet', inputSchema: num, outputSchema: num, ...on(engine, { emitStepEvents: false }) })
        .then(plus('q1'))
        .sleep(1)
        .then(createStep({ id: 'q2', inputSchema: num, outputSchema: z.array(z.number()), execute: async ({ inputData }) => [inputData.n] }))
        .foreach(doubler('q3'))
        .commit();
    const { oracle, ours } = await differential(quiet, { n: 1 });
    expect(byStep(oracle)).toEqual({});
    expect(byStep(ours)).toEqual({});
  });

  it('a cancel mid-run: the running step settles, then workflow-canceled, as on the default engine', async () => {
    const make = (engine: Engine) =>
      createWorkflow({ id: 'ev-cancel', inputSchema: num, outputSchema: num, ...on(engine) })
        .then(
          createStep({
            id: 'waits',
            inputSchema: num,
            outputSchema: num,
            execute: async ({ inputData, abortSignal }) => {
              await new Promise<void>((resolve) => {
                if (abortSignal.aborted) resolve();
                else abortSignal.addEventListener('abort', () => resolve(), { once: true });
              });
              return inputData;
            },
          }),
        )
        .then(plus('never'))
        .commit();
    const { oracle, ours } = await differential(make, { n: 1 }, (run) => void delay(20).then(() => run.cancel()));
    expect(ours.result['status']).toBe('canceled');
    expect(types(ours)).toEqual(types(oracle));
    expect(types(ours)).toContain('workflow-canceled');
  });

  it('a cancel mid-sleep: waiting, no result, workflow-canceled', async () => {
    const make = (engine: Engine) =>
      createWorkflow({ id: 'ev-cancel-sleep', inputSchema: num, outputSchema: num, ...on(engine) })
        .then(plus('c0'))
        .sleep(200)
        .then(plus('c1'))
        .commit();
    const { oracle, ours } = await differential(make, { n: 1 }, (run) => void delay(30).then(() => run.cancel()));
    expect(types(ours)).toEqual(types(oracle));
    expect(types(ours)).toEqual([
      'workflow-step-start',
      'workflow-step-result',
      'workflow-step-finish',
      'workflow-step-waiting',
      'workflow-canceled',
    ]);
  });
});

describe('step watch events — run.stream(), the writer (row 58), a cancel before the first entry, a throwing publish', () => {
  const writes = (engine: Engine) =>
    createWorkflow({ id: 'ev-writes', inputSchema: num, outputSchema: num, ...on(engine) })
      .then(
        createStep({
          id: 'w',
          inputSchema: num,
          outputSchema: num,
          execute: async ({ inputData, writer }) => {
            await writer.write({ hello: inputData.n });
            return inputData;
          },
        }),
      )
      .branch([[async ({ writer }) => (await writer.write({ from: 'condition' }), true), plus('taken')]])
      .commit();

  it('run.stream() carries the step chunks and the writer chunks, as on the default engine', async () => {
    const chunks = async (engine: Engine) => {
      const run = await (writes(engine) as unknown as Startable).createRun();
      const out: Loose[] = [];
      for await (const c of run.stream({ inputData: { n: 7 } }).fullStream) out.push(c as Loose);
      return out.map((c) => ({ type: c['type'], payload: norm(c['payload'], run.runId) }));
    };
    const [oracle, ours] = [await chunks('default'), await chunks('petri')];
    expect(ours).toEqual(oracle);
    expect(ours.map((c) => c.type)).toEqual([
      'workflow-start',
      'workflow-step-start',
      'workflow-step-output',
      'workflow-step-result',
      'workflow-step-output',
      'workflow-step-start',
      'workflow-step-result',
      'workflow-finish',
    ]);
    // `workflow-step-finish` is a watch event the stream does not forward; the condition's writer
    // chunk is named `conditional`, as the default engine names it.
    expect(ours.filter((c) => c.type === 'workflow-step-output').map((c) => (c.payload as Loose)['stepName'])).toEqual(['w', 'conditional']);
  });

  it('under start(), a writer chunk reaches no watcher — the default engine drops it (no output writer)', async () => {
    const [oracle, ours] = [await capture(writes('default'), { n: 7 }), await capture(writes('petri'), { n: 7 })];
    expect(types(oracle).filter((t) => t === 'workflow-step-output')).toEqual([]);
    expect(types(ours)).toEqual(types(oracle));
  });

  it('a cancel before the first entry: no workflow-canceled — the default engine\'s loop-top branch publishes none', async () => {
    const make = (engine: Engine) => createWorkflow({ id: 'ev-cancel-top', inputSchema: num, outputSchema: num, ...on(engine) }).then(plus('x')).commit();
    const { oracle, ours } = await differential(make, { n: 1 }, (run) => void run.cancel());
    expect(oracle.result['status']).toBe('canceled');
    expect(types(ours)).toEqual(types(oracle));
    expect(types(ours)).not.toContain('workflow-canceled');
  });

  it('a publish that throws leaves the run as it was, and is logged through the engine logger', async () => {
    class Throwing extends PetriExecutionEngine {
      override execute<S, I, O>(params: Parameters<PetriExecutionEngine['execute']>[0]): Promise<O> {
        const pubsub = params.pubsub;
        const wrapped = Object.create(pubsub, {
          publish: {
            value: async (topic: string, event: { data?: { type?: string } }) => {
              if (event.data?.type?.startsWith('workflow-step-')) throw new Error('bus down');
              return pubsub.publish(topic, event as never);
            },
          },
        }) as typeof pubsub;
        return super.execute<S, I, O>({ ...params, pubsub: wrapped });
      }
    }
    const engine = new Throwing({ iterationBound: 20 });
    const logged: unknown[][] = [];
    engine.getLogger().error = ((...args: unknown[]) => void logged.push(args)) as never;
    const wf = createWorkflow({ id: 'ev-throws', inputSchema: num, outputSchema: num, executionEngine: engine })
      .then(plus('a'))
      .sleep(1)
      .then(plus('b', 10))
      .commit();
    const c = await capture(wf, { n: 1 });
    expect(c.result['status']).toBe('success');
    expect(c.result['result']).toEqual({ n: 12 });
    expect(byStep(c)).toEqual({});
    expect(logged).toHaveLength(1);
    expect(String(logged[0]![0])).toContain('an observer of run');
    expect((logged[0]![1] as { error: Error }).error.message).toBe('bus down');
  });
});

describe('step watch events — a nested workflow under run.stream()', () => {
  it("the nested step's writer chunk and the nested run's events reach the outer stream, as on the default engine", async () => {
    const make = (engine: Engine) => {
      const inner = createWorkflow({ id: 'ev-inner-w', inputSchema: num, outputSchema: num, ...on(engine) })
        .then(
          createStep({
            id: 'iw',
            inputSchema: num,
            outputSchema: num,
            execute: async ({ inputData, writer }) => {
              await writer.write({ inner: inputData.n });
              return inputData;
            },
          }),
        )
        .commit();
      return createWorkflow({ id: 'ev-outer-w', inputSchema: num, outputSchema: num, ...on(engine) }).then(inner).commit();
    };
    const chunks = async (engine: Engine) => {
      const run = await (make(engine) as unknown as Startable).createRun();
      const out: Loose[] = [];
      for await (const c of run.stream({ inputData: { n: 3 } }).fullStream) out.push(c as Loose);
      return out.map((c) => ({ type: c['type'], payload: norm(c['payload'], run.runId) }));
    };
    const [oracle, ours] = [await chunks('default'), await chunks('petri')];
    expect(ours).toEqual(oracle);
    expect(ours.map((c) => c.type)).toContain('workflow-step-output');
  });
});

// ---------------------------------------------------------------------------------------------

/**
 * A pubsub whose step-event publishes each take `latencyMs` to resolve, and which rejects the
 * publishes `reject` selects before delivering them — a remote bus, as the engines see one.
 */
class SlowPubSub extends EventEmitterPubSub {
  constructor(
    readonly latencyMs: number,
    readonly reject: (type: string, payload: Loose) => boolean = () => false,
  ) {
    super();
  }
  override async publish(topic: string, event: Parameters<EventEmitterPubSub['publish']>[1]): Promise<void> {
    const data = (event as { data?: { type?: string; payload?: Loose } }).data;
    if (topic.startsWith('workflow.events.v2.') && data?.type?.startsWith('workflow-step-') === true) {
      await delay(this.latencyMs);
      if (this.reject(data.type, data.payload ?? {})) throw new Error(`bus rejected ${data.type}`);
    }
    return super.publish(topic, event);
  }
}

/** One run on `pubsub` with `run.watch()` attached; its events, result and wall time. */
async function captureOn(wf: unknown, inputData: unknown, pubsub: SlowPubSub): Promise<Captured & { readonly wallMs: number }> {
  const run = await (wf as { createRun(o: Loose): ReturnType<Startable['createRun']> }).createRun({ pubsub });
  const events: WatchEvent[] = [];
  const unwatch = run.watch((e) => void events.push(e as WatchEvent));
  const t0 = Date.now();
  const result = (await run.start({ inputData })) as Loose;
  const wallMs = Date.now() - t0;
  await delay(pubsub.latencyMs + 10);
  unwatch();
  return { events, result, runId: run.runId, wallMs };
}

describe('step watch events — publishes are awaited per step, not queued run-wide', () => {
  const LATENCY = 20;
  const WORK = 50;
  const ARMS = ['a1', 'a2', 'a3', 'a4', 'a5'];

  /** Each arm records when its execute began, relative to the run's start. */
  const timedArm = (id: string, starts: Map<string, number>, t0: () => number) =>
    createStep({
      id,
      inputSchema: num,
      outputSchema: num,
      execute: async ({ inputData }) => {
        starts.set(id, Date.now() - t0());
        await delay(WORK);
        return inputData;
      },
    });
  const spread = (starts: Map<string, number>) => Math.max(...starts.values()) - Math.min(...starts.values());

  it('.parallel() arms start together under a slow pubsub, as on the default engine', async () => {
    const observed: Record<Engine, { spread: number; wall: number }> = {} as never;
    for (const engine of ['default', 'petri'] as const) {
      const starts = new Map<string, number>();
      let began = 0;
      const wf = createWorkflow({ id: `ev-slow-par-${engine}`, inputSchema: num, outputSchema: z.any(), ...on(engine) })
        .parallel(ARMS.map((id) => timedArm(id, starts, () => began)))
        .commit();
      began = Date.now();
      const c = await captureOn(wf, { n: 1 }, new SlowPubSub(LATENCY));
      expect(c.result['status']).toBe('success');
      expect([...starts.keys()].sort()).toEqual(ARMS);
      observed[engine] = { spread: spread(starts), wall: c.wallMs };
    }
    // Serialised start publishes put 4 x LATENCY between the first and last arm; concurrent ones none.
    expect(observed.default.spread).toBeLessThan(LATENCY);
    expect(observed.petri.spread, JSON.stringify(observed)).toBeLessThan(LATENCY);
    expect(observed.petri.wall, JSON.stringify(observed)).toBeLessThan(observed.default.wall + 2 * LATENCY);
  });

  it('.foreach() at concurrency 5: items start together and the run is not stretched by its progress publishes', async () => {
    const observed: Record<Engine, { spread: number; wall: number }> = {} as never;
    for (const engine of ['default', 'petri'] as const) {
      const starts = new Map<string, number>();
      let began = 0;
      const item = createStep({
        id: 'item',
        inputSchema: z.number(),
        outputSchema: z.number(),
        execute: async ({ inputData }) => {
          starts.set(String(inputData), Date.now() - began);
          await delay(WORK);
          return inputData;
        },
      });
      const wf = createWorkflow({ id: `ev-slow-fe-${engine}`, inputSchema: z.array(z.number()), outputSchema: z.any(), ...on(engine) })
        .foreach(item, { concurrency: 5 })
        .commit();
      began = Date.now();
      const c = await captureOn(wf, [1, 2, 3, 4, 5], new SlowPubSub(LATENCY));
      expect(c.result['status']).toBe('success');
      expect(starts.size).toBe(5);
      observed[engine] = { spread: spread(starts), wall: c.wallMs };
    }
    expect(observed.petri.spread, JSON.stringify(observed)).toBeLessThan(LATENCY);
    // Serialised progress publishes added 4 x LATENCY or more to the run.
    expect(observed.petri.wall, JSON.stringify(observed)).toBeLessThan(observed.default.wall + 2 * LATENCY);
  });

  it('a result publish that rejects publishes no finish for that step; the run is unaffected', async () => {
    const pubsub = () => new SlowPubSub(1, (type, payload) => type === 'workflow-step-result' && payload['id'] === 'a');
    const make = (engine: Engine) =>
      createWorkflow({ id: 'ev-reject-result', inputSchema: num, outputSchema: num, ...on(engine) })
        .then(plus('a'))
        .then(plus('b', 10))
        .commit();
    const ours = await captureOn(make('petri'), { n: 1 }, pubsub());
    expect(ours.result['status']).toBe('success');
    expect(ours.result['result']).toEqual({ n: 12 });
    const seen = ours.events.map((e) => `${e.type}:${String(e.payload?.['id'])}`).filter((t) => t.startsWith('workflow-step-'));
    expect(seen).toEqual(['workflow-step-start:a', 'workflow-step-start:b', 'workflow-step-result:b', 'workflow-step-finish:b']);
  });
});

describe('step watch events — the input is validated once per step call', () => {
  it('an impure transform runs once; the step, the start and the result carry its one value', async () => {
    const observed: Record<Engine, { calls: number; stepSaw: unknown[]; start: unknown; result: unknown }> = {} as never;
    for (const engine of ['default', 'petri'] as const) {
      let calls = 0;
      const stepSaw: unknown[] = [];
      const counted = z.object({ n: z.number() }).transform((v) => ({ ...v, call: ++calls }));
      const wf = createWorkflow({ id: `ev-impure-${engine}`, inputSchema: num, outputSchema: z.any(), retryConfig: { attempts: 2 }, ...on(engine) })
        .then(
          createStep({
            id: 'impure',
            inputSchema: counted as unknown as typeof num,
            outputSchema: z.any(),
            execute: async ({ inputData, retryCount }) => {
              stepSaw.push(inputData);
              if (retryCount < 2) throw new Error(`try ${retryCount}`);
              return inputData;
            },
          }),
        )
        .commit();
      const c = await capture(wf, { n: 1 });
      expect(c.result['status']).toBe('success');
      const start = c.events.find((e) => e.type === 'workflow-step-start')?.payload;
      const result = c.events.find((e) => e.type === 'workflow-step-result')?.payload;
      observed[engine] = { calls, stepSaw, start: start?.['payload'], result: result?.['payload'] };
    }
    expect(observed.default).toEqual({
      calls: 1,
      stepSaw: [{ n: 1, call: 1 }, { n: 1, call: 1 }, { n: 1, call: 1 }],
      start: { n: 1, call: 1 },
      result: { n: 1, call: 1 },
    });
    expect(observed.petri).toEqual(observed.default);
  });

  for (const tracing of [false, true]) {
    it(`a generated default is drawn once: the step, the start and the record share it${tracing ? ' (traced)' : ''}`, async () => {
      for (const engine of ['default', 'petri'] as const) {
        let draws = 0;
        const stepSaw: string[] = [];
        const schema = z.object({ n: z.number(), id: z.string().default(() => (draws++, randomUUID())) });
        const wf = createWorkflow({ id: `ev-default-${engine}-${tracing}`, inputSchema: num, outputSchema: z.any(), ...on(engine) })
          .then(
            createStep({
              id: 'drawn',
              inputSchema: schema as unknown as typeof num,
              outputSchema: z.any(),
              execute: async ({ inputData }) => (stepSaw.push((inputData as unknown as { id: string }).id), inputData),
            }),
          )
          .commit();
        const run = await (wf as unknown as Startable).createRun();
        const events: WatchEvent[] = [];
        const unwatch = run.watch((e) => void events.push(e as WatchEvent));
        const result = (await run.start({ inputData: { n: 1 }, ...(tracing ? { tracingContext: { currentSpan: recordingRoot() } } : {}) })) as Loose;
        await delay(5);
        unwatch();
        expect(result['status']).toBe('success');
        expect(draws, engine).toBe(1);
        const start = events.find((e) => e.type === 'workflow-step-start')?.payload;
        const res = events.find((e) => e.type === 'workflow-step-result')?.payload;
        expect(stepSaw).toHaveLength(1);
        expect((start?.['payload'] as Loose)['id'], engine).toBe(stepSaw[0]);
        expect((res?.['payload'] as Loose)['id'], engine).toBe(stepSaw[0]);
        expect(((result['steps'] as Loose)['drawn'] as Loose)['payload']).toEqual({ n: 1, id: stepSaw[0] });
      }
    });
  }

  it('with emitStepEvents: false the schema still runs once', async () => {
    for (const engine of ['default', 'petri'] as const) {
      let calls = 0;
      const counted = z.object({ n: z.number() }).transform((v) => ({ ...v, call: ++calls }));
      const wf = createWorkflow({ id: `ev-impure-quiet-${engine}`, inputSchema: num, outputSchema: z.any(), ...on(engine, { emitStepEvents: false } as never) })
        .then(createStep({ id: 'q', inputSchema: counted as unknown as typeof num, outputSchema: z.any(), execute: async ({ inputData }) => inputData }))
        .commit();
      const c = await capture(wf, { n: 1 });
      expect(c.result['result'], engine).toEqual({ n: 1, call: 1 });
      expect(calls, engine).toBe(1);
    }
  });

  it("a start's startedAt is its result's, as on the default engine — a retried step's included", async () => {
    for (const engine of ['default', 'petri'] as const) {
      const wf = createWorkflow({ id: `ev-started-${engine}`, inputSchema: num, outputSchema: num, retryConfig: { attempts: 1 }, ...on(engine) })
        .then(
          createStep({
            id: 'slow',
            inputSchema: num,
            outputSchema: num,
            execute: async ({ inputData, retryCount }) => {
              await delay(15);
              if (retryCount === 0) throw new Error('once');
              return inputData;
            },
          }),
        )
        .then(plus('b'))
        .commit();
      const c = await capture(wf, { n: 1 });
      for (const id of ['slow', 'b']) {
        const start = c.events.find((e) => e.type === 'workflow-step-start' && e.payload?.['id'] === id)?.payload;
        const result = c.events.find((e) => e.type === 'workflow-step-result' && e.payload?.['id'] === id)?.payload;
        expect(typeof start?.['startedAt'], `${engine} ${id}`).toBe('number');
        expect(start?.['startedAt'], `${engine} ${id}`).toBe(result?.['startedAt']);
      }
    }
  });
});

/** A minimal root span for `tracingContext`: enough for both engines to create step spans under it. */
function recordingRoot(): object {
  const span = (): object => ({
    id: randomUUID(),
    traceId: 'trace-1',
    isValid: true,
    isInternal: false,
    get externalTraceId() {
      return 'trace-1';
    },
    isRootSpan: false,
    getParentSpanId: () => undefined,
    createChildSpan: () => span(),
    createEventSpan: () => span(),
    end: () => {},
    endTree: () => {},
    error: () => {},
    update: () => {},
  });
  return span();
}

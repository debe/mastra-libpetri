import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { createTool } from '@mastra/core/tools';
import { RequestContext } from '@mastra/core/di';
import { Agent, TripWire } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { MastraNonRetryableError } from '@mastra/core/error';
import { EventEmitterPubSub } from '@mastra/core/events';
import { StepExecutor } from '@mastra/core/workflows/evented';
import { DefaultExecutionEngine, type ExecutionGraph } from '@mastra/core/workflows';
import { PetriExecutionEngine } from '../../src/mastra/engine.js';
import { MastraStepRunner } from '../../src/mastra/runner.js';
import type { StepCall } from '../../src/compiler/types.js';

/**
 * `MastraStepRunner` against the default engine, entry kind by entry kind.
 *
 * Every case builds a **real** Mastra workflow twice — once on `DefaultExecutionEngine` (the
 * oracle), once on `PetriExecutionEngine` — runs both through Mastra's own `Run.start()`, and
 * compares what a caller sees: the result, every step record, and the workflow state. Where the
 * two differ by design, the test is named `DIVERGENCE` and pins both sides.
 */

type Engine = 'default' | 'petri';
const ENGINES: readonly Engine[] = ['default', 'petri'];
/**
 * The builder surface, loosened on purpose: every schema here is `z.any()`, so Mastra's typed
 * chaining would check nothing, and its generics would bury each case in casts.
 */
type Wf = any;
type Ctx = Record<string, unknown> & {
  readonly inputData: unknown;
  readonly state: Record<string, unknown>;
  readonly setState: (s: Record<string, unknown>) => Promise<void>;
  readonly retryCount: number;
  readonly suspend: (p: unknown, options?: { resumeLabel?: string | string[] }) => Promise<unknown>;
  readonly bail: (r: unknown) => unknown;
  readonly abort: () => void;
  readonly abortSignal: AbortSignal;
  readonly requestContext: RequestContext;
  readonly runId: string;
  readonly mastra: unknown;
};

const engineConfig = (e: Engine) => (e === 'petri' ? { executionEngine: new PetriExecutionEngine({ iterationBound: 20 }) } : {});
const wf = (e: Engine, extra: Record<string, unknown> = {}, id = 'w'): Wf =>
  createWorkflow({ id, inputSchema: z.any(), outputSchema: z.any(), ...engineConfig(e), ...extra } as never);
const step = (id: string, fn: (ctx: Ctx) => unknown, extra: Record<string, unknown> = {}) =>
  createStep({ id, inputSchema: z.any(), outputSchema: z.any(), execute: async (ctx: unknown) => fn(ctx as Ctx), ...extra } as never);

/**
 * Engine identity. Runs `run` — one side of an oracle comparison — with both engines' `execute()`
 * spied on the prototype, and asserts that the side's own engine ran at least once and the other
 * engine never did. Without it, a petri side that silently ran on `DefaultExecutionEngine` would
 * compare the default engine with itself and every oracle test here would pass vacuously. With no
 * `workflowIds`, every call counts: each nested workflow here is built with the same `e` as its
 * parent, so it runs on the side's engine too. A workflow Mastra builds internally on its own
 * engine (an agent's loop) is excluded by naming the workflows under test in `workflowIds`.
 */
async function onEngine<T>(side: Engine, run: () => Promise<T>, workflowIds?: readonly string[]): Promise<T> {
  const petri = vi.spyOn(PetriExecutionEngine.prototype, 'execute');
  const dflt = vi.spyOn(DefaultExecutionEngine.prototype, 'execute');
  try {
    const value = await run();
    const ids = (spy: { mock: { calls: unknown[][] } }): string[] =>
      spy.mock.calls
        .map(([params]) => String((params as { workflowId?: unknown }).workflowId))
        .filter((id) => workflowIds === undefined || workflowIds.includes(id));
    const own = side === 'petri' ? ids(petri) : ids(dflt);
    const other = side === 'petri' ? ids(dflt) : ids(petri);
    expect({ side, ranOnOwnEngine: own.length >= 1, callsOnOtherEngine: other }).toEqual({ side, ranOnOwnEngine: true, callsOnOtherEngine: [] });
    return value;
  } finally {
    petri.mockRestore();
    dflt.mockRestore();
  }
}

/** Time and identity fields differ between any two runs; a sleep's id is minted per build. */
const VOLATILE = new Set(['startedAt', 'endedAt', 'suspendedAt', 'runId', 'stack']);
function comparable(value: unknown): unknown {
  const json = JSON.stringify(value, (k, v: unknown) => (VOLATILE.has(k) ? undefined : v));
  return JSON.parse(json.replace(/sleep_[0-9a-f-]{36}/g, 'sleep_ID')) as unknown;
}

type Outcome = { readonly result?: Record<string, unknown>; readonly threw?: string };

/**
 * Builds and runs the workflow once per engine. `start` extras (initialState, requestContext …)
 * pass through **as a structured clone per engine**: the default engine merges state updates into
 * the very `initialState` object it was handed (see the DIVERGENCE test below), so one shared
 * object would carry the first run's state into the second.
 */
async function both(build: (e: Engine) => Wf, inputData: unknown, extra: Record<string, unknown> = {}) {
  const out = {} as Record<Engine, Outcome>;
  for (const e of ENGINES) {
    await onEngine(e, async () => {
      try {
        const run = await build(e).createRun();
        const own = { ...extra, ...('initialState' in extra ? { initialState: structuredClone(extra['initialState']) } : {}) };
        const result = (await run.start({ inputData, outputOptions: { includeState: true }, ...own })) as Record<string, unknown>;
        out[e] = { result: comparable(result) as Record<string, unknown> };
      } catch (error) {
        out[e] = { threw: String(error) };
      }
    });
  }
  return out;
}

/** The two engines agree on everything a caller sees. */
async function agree(build: (e: Engine) => Wf, inputData: unknown, extra: Record<string, unknown> = {}) {
  const out = await both(build, inputData, extra);
  expect(out.default.threw).toBeUndefined();
  expect(out.petri).toEqual(out.default);
  return out.default.result!;
}

/** Collects what each engine's step or condition saw, keyed by engine. */
function probe<T>() {
  const seen: Record<Engine, T[]> = { default: [], petri: [] };
  let current: Engine = 'default';
  return {
    seen,
    as(e: Engine) {
      current = e;
    },
    push(value: T) {
      seen[current].push(value);
    },
  };
}

describe('a plain step', () => {
  it('a chain of steps: result, every step record and the state agree', async () => {
    const r = await agree(
      (e) =>
        wf(e)
          .then(step('a', ({ inputData }) => (inputData as number) + 1))
          .then(step('b', ({ inputData }) => (inputData as number) * 2))
          .commit(),
      1,
    );
    expect(r['status']).toBe('success');
    expect(r['result']).toBe(4);
  });

  it('input validation fails the step exactly as the default engine records it', async () => {
    const r = await agree(
      (e) => wf(e).then(createStep({ id: 'a', inputSchema: z.number(), outputSchema: z.any(), execute: async () => 1 })).commit(),
      'not a number',
    );
    expect(r['status']).toBe('failed');
    expect((r['error'] as { code?: string }).code).toBe('WORKFLOW_STEP_INPUT_VALIDATION_FAILED');
  });
});

describe("a step's payload is its validated input (handlers/step.ts:111,173)", () => {
  /** Fails on the value its schema's default supplies, so the failed record shows the payload. */
  const defaulted = () =>
    createStep({
      id: 'f',
      inputSchema: z.object({ n: z.number().default(5) }),
      outputSchema: z.any(),
      execute: async ({ inputData }) => {
        if (inputData.n === 5) throw new Error('five');
        return inputData.n;
      },
    });

  it('a plain step: a schema default is in the recorded payload', async () => {
    const r = await agree((e) => wf(e).then(defaulted()).commit(), {});
    expect(r['status']).toBe('failed');
    expect((r['steps'] as Record<string, Record<string, unknown>>)['f']!['payload']).toEqual({ n: 5 });
  });

  it('a .foreach() item: the failing item is recorded validated, not raw', async () => {
    // Compared field by field: the failed aggregate's `__workflow_meta.foreachOutput` is
    // divergences.md row 35 (M4), not this.
    const out = await both((e) => wf(e).foreach(defaulted()).commit(), [{ n: 1 }, {}]);
    const record = (e: Engine) => (out[e].result?.['steps'] as Record<string, Record<string, unknown>>)['f']!;
    for (const e of ENGINES) expect({ engine: e, status: record(e)['status'], payload: record(e)['payload'] }).toEqual({ engine: e, status: 'failed', payload: { n: 5 } });
  });
});

describe('validateInputs: false', () => {
  /** The option as each engine is given it: the default engine through the workflow, this one through its own options. */
  const unvalidated = (e: Engine): Wf =>
    createWorkflow({
      id: 'w',
      inputSchema: z.any(),
      outputSchema: z.any(),
      options: { validateInputs: false },
      ...(e === 'petri' ? { executionEngine: new PetriExecutionEngine({ options: { validateInputs: false } }) } : {}),
    } as never);
  const typeOf = () => createStep({ id: 'n', inputSchema: z.number(), outputSchema: z.any(), execute: async ({ inputData }) => typeof inputData });

  it('a step whose input fails its schema runs with the input as given', async () => {
    const r = await agree((e) => unvalidated(e).then(typeOf()).commit(), 'a');
    expect(r).toMatchObject({ status: 'success', result: 'string' });
  });

  it('a .foreach() item is not validated either', async () => {
    const r = await agree((e) => unvalidated(e).foreach(typeOf()).commit(), ['a', 1]);
    expect(r).toMatchObject({ status: 'success', result: ['string', 'number'] });
  });
});

describe('a nested workflow as a step', () => {
  const inner = (e: Engine, id: string, seen?: (runId: string) => void) =>
    wf(e, { stateSchema: z.object({ n: z.number().optional() }) }, id)
      .then(
        step('i', async ({ inputData, state, setState, runId }) => {
          seen?.(runId);
          await setState({ ...state, n: inputData as number });
          return (inputData as number) * 10;
        }),
      )
      .commit();

  it("runs under the parent's run id, and its final state becomes the parent's", async () => {
    const ids = probe<string>();
    const parents: Record<Engine, string> = { default: '', petri: '' };
    for (const e of ENGINES) {
      await onEngine(e, async () => {
        ids.as(e);
        const run = await wf(e).then(step('a', ({ inputData }) => (inputData as number) + 1)).then(inner(e, 'inner', (id) => ids.push(id))).commit().createRun();
        parents[e] = run.runId as string;
        await run.start({ inputData: 1 });
      });
    }
    expect(ids.seen.petri).toEqual([parents.petri]);
    expect(ids.seen.default).toEqual([parents.default]);

    const r = await agree((e) => wf(e).then(step('a', ({ inputData }) => (inputData as number) + 1)).then(inner(e, 'inner')).commit(), 1);
    expect(r['result']).toBe(20);
    expect(r['state']).toEqual({ n: 2 });
  });

  it('inside a .foreach(), every item runs under a fresh run id of its own (handlers/step.ts:108)', async () => {
    const ids = probe<string>();
    const parents: Record<Engine, string> = { default: '', petri: '' };
    for (const e of ENGINES) {
      await onEngine(e, async () => {
        ids.as(e);
        const run = await wf(e).foreach(inner(e, 'inner', (id) => ids.push(id)), { concurrency: 2 }).commit().createRun();
        parents[e] = run.runId as string;
        const r = await run.start({ inputData: [1, 2, 3] });
        expect(r.status).toBe('success');
      });
    }
    for (const e of ENGINES) {
      expect(new Set(ids.seen[e]).size).toBe(3);
      expect(ids.seen[e]).not.toContain(parents[e]);
    }
    await agree((e) => wf(e).foreach(inner(e, 'inner'), { concurrency: 2 }).commit(), [1, 2, 3]);
  });

  it('an unregistered workflow: the nested workflow and its steps see no mastra, as on the default engine', async () => {
    // Before the runner replaced it, step code saw the engine's pubsub stand-in, and a nested
    // workflow failed on `mastra?.getServer is not a function` (`workflow.ts:2914`).
    const r = await agree(
      (e) =>
        wf(e)
          .then(wf(e, {}, 'inner').then(step('i', ({ mastra }) => mastra === undefined)).commit())
          .commit(),
      0,
    );
    expect(r['result']).toBe(true);
  });

  it("the parent's cancel reaches the nested run, whose step sees its own signal fire (workflow.ts:2978-2983)", async () => {
    const out: Record<Engine, unknown> = { default: undefined, petri: undefined };
    for (const e of ENGINES) {
      await onEngine(e, async () => {
        const nested = wf(e, {}, 'inner')
          .then(step('waits', ({ abortSignal }) => new Promise((res) => abortSignal.addEventListener('abort', () => res('inner saw abort')))))
          .commit();
        const run = await wf(e).then(nested).then(step('after', () => 'never')).commit().createRun();
        const started = run.start({ inputData: 0 });
        setTimeout(() => void run.cancel(), 10);
        out[e] = comparable(await started);
      });
    }
    expect(out.petri).toEqual(out.default);
    expect(out.petri).toMatchObject({ status: 'canceled' });
    expect(out.petri).not.toHaveProperty('steps.after');
  });

  it("a nested suspension keeps the nested run's __workflow_meta, whose path is the inner step's (workflow.ts:3056-3089)", async () => {
    const r = await agree(
      (e) =>
        wf(e)
          .then(wf(e, {}, 'nested').then(step('inner', ({ suspend }) => suspend({ ask: 1 }))).commit())
          .commit(),
      0,
    );
    expect(r).toMatchObject({ status: 'suspended', suspended: [['nested', 'inner']], suspendPayload: { nested: { ask: 1 } } });
    // `comparable` drops `runId`; the path is the inner step's alone, as `default.ts:636` extends it.
    expect((r['steps'] as Record<string, Record<string, unknown>>)['nested']!['suspendPayload']).toEqual({ ask: 1, __workflow_meta: { path: ['inner'] } });
  });

  it('a registered workflow: steps see the registered Mastra', async () => {
    const results: Record<Engine, unknown> = { default: undefined, petri: undefined };
    for (const e of ENGINES) {
      await onEngine(e, async () => {
        const reg = wf(e, {}, 'reg').then(step('m', ({ mastra }) => mastra instanceof Mastra)).commit();
        const mastra = new Mastra({ workflows: { reg }, logger: false });
        const r = await (await mastra.getWorkflow('reg').createRun()).start({ inputData: 0 });
        results[e] = r.status === 'success' ? r.result : r.status;
      });
    }
    expect(results).toEqual({ default: true, petri: true });
  });
});

describe('a tool', () => {
  const tool = createTool({
    id: 'double',
    description: 'doubles x',
    inputSchema: z.object({ x: z.number() }),
    outputSchema: z.object({ y: z.number(), inWorkflow: z.boolean() }),
    execute: async (input, ctx) => ({ y: input.x * 2, inWorkflow: typeof ctx?.workflow?.runId === 'string' }),
  });

  it('createStep(tool) — a step built from a tool', async () => {
    const r = await agree((e) => wf(e).then(createStep(tool)).commit(), { x: 3 });
    expect(r['result']).toEqual({ y: 6, inWorkflow: true });
  });

  it('.tool(tool) — the declarative entry, resolved to the step the default engine builds', async () => {
    const r = await agree((e) => wf(e).tool(tool).commit(), { x: 3 });
    expect(r['result']).toEqual({ y: 6, inWorkflow: true });
  });
});

describe('a tool that suspends', () => {
  const asking = createTool({
    id: 'asker',
    description: 'asks before it answers',
    inputSchema: z.object({ x: z.number() }),
    outputSchema: z.any(),
    execute: async (input, ctx) => ctx?.workflow?.suspend?.({ q: input.x }, { resumeLabel: 'approve' }),
  });

  it('.tool(tool, _, { id }): the suspension and its resume label are under the entry id, not the tool id', async () => {
    const r = await agree((e) => wf(e).tool(asking, undefined, { id: 'custom' }).commit(), { x: 3 }, { outputOptions: { includeState: true, includeResumeLabels: true } });
    expect(r).toMatchObject({ status: 'suspended', suspended: [['custom']], suspendPayload: { custom: { q: 3 } } });
    expect(r['resumeLabels']).toEqual({ approve: { stepId: 'custom' } });
  });
});

describe('a mapping', () => {
  it('.map({...}): a step path, getInitData, a constant, a function and a request-context path', async () => {
    const r = await agree(
      (e) => {
        const inc = step('inc', ({ inputData }) => (inputData as number) + 1);
        return wf(e)
          .then(inc)
          .map({
            fromStep: { step: inc, path: '.' },
            fromInit: { initData: wf('default'), path: '.' },
            constant: { value: 7, schema: z.number() },
            computed: { fn: async ({ inputData }: Ctx) => (inputData as number) * 3, schema: z.number() },
            fromContext: { requestContextPath: 'who', schema: z.string() },
          })
          .commit();
      },
      5,
      { requestContext: new RequestContext([['who', 'me']]) },
    );
    expect(r['result']).toEqual({ fromStep: 6, fromInit: 5, constant: 7, computed: 18, fromContext: 'me' });
  });

  it('.map(fn): the function sees inputData, getStepResult and getInitData', async () => {
    const r = await agree(
      (e) => {
        const inc = step('inc', ({ inputData }) => (inputData as number) + 1);
        return wf(e)
          .then(inc)
          .map(async ({ inputData, getStepResult, getInitData }: Ctx & { getStepResult: (s: unknown) => unknown; getInitData: () => unknown }) => ({
            prev: inputData,
            inc: getStepResult(inc),
            init: getInitData(),
          }))
          .commit();
      },
      5,
    );
    expect(r['result']).toEqual({ prev: 6, inc: 6, init: 5 });
  });
});

describe('an agent (a stub model: no provider, no network)', () => {
  /** An AI SDK v2 language model that streams one text part — enough for Mastra's agent step. */
  const stubModel = {
    specificationVersion: 'v2',
    provider: 'stub',
    modelId: 'stub',
    supportedUrls: {},
    async doGenerate() {
      return { content: [{ type: 'text', text: 'hello' }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
    },
    async doStream() {
      return {
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] });
            c.enqueue({ type: 'text-start', id: '1' });
            c.enqueue({ type: 'text-delta', id: '1', delta: 'hello' });
            c.enqueue({ type: 'text-end', id: '1' });
            c.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
            c.close();
          },
        }),
      };
    },
  };
  const agent = () => new Agent({ id: 'stubby', name: 'stubby', instructions: 'be brief', model: stubModel as never });
  const prompt = z.object({ prompt: z.string() });

  it('createStep(agent), .agent(agent) and .agent(id) on a registered Mastra all resolve and run', async () => {
    const results: Record<Engine, unknown[]> = { default: [], petri: [] };
    for (const e of ENGINES) {
      await onEngine(e, async () => {
        const a = agent();
        const viaStep = wf(e, { inputSchema: prompt }, 'a1').then(createStep(a)).commit();
        const viaEntry = wf(e, { inputSchema: prompt }, 'a2').agent(a).commit();
        const byId = wf(e, { inputSchema: prompt }, 'a3').agent('stubby').commit();
        const mastra = new Mastra({ agents: { stubby: a }, workflows: { a3: byId }, logger: false });
        for (const w of [viaStep, viaEntry, mastra.getWorkflow('a3')]) {
          const r = await (await w.createRun()).start({ inputData: { prompt: 'hi' } });
          results[e].push(r.status === 'success' ? r.result : r.status);
        }
        // The agent's own internal workflows (`agentic-loop`, `execution-workflow` …) always run on
        // the default engine; only the three workflows under test are the side's.
      }, ['a1', 'a2', 'a3']);
    }
    expect(results.petri).toEqual(results.default);
    expect(results.petri).toEqual([{ text: 'hello' }, { text: 'hello' }, { text: 'hello' }]);
  });
});

describe('.foreach() input — the double-index regression', () => {
  it('each call gets the item, not item[index]; the step record matches the default engine', async () => {
    // StepExecutor indexes `input[foreachIdx]` (`evented/step-executor.ts:96`). Handed the item and
    // the index, it indexed twice: every item arrived as `undefined` and failed its schema.
    const items = probe<unknown>();
    for (const e of ENGINES) {
      await onEngine(e, async () => {
        items.as(e);
        const w = wf(e)
          .foreach(
            createStep({
              id: 'inc',
              inputSchema: z.number(),
              outputSchema: z.number(),
              execute: async ({ inputData }) => {
                items.push(inputData);
                return inputData + 1;
              },
            }),
            { concurrency: 2 },
          )
          .commit();
        await (await w.createRun()).start({ inputData: [10, 20, 30] });
      });
    }
    expect([...items.seen.petri].sort()).toEqual([10, 20, 30]);
    expect([...items.seen.default].sort()).toEqual([10, 20, 30]);

    const r = await agree(
      (e) => wf(e).foreach(createStep({ id: 'inc', inputSchema: z.number(), outputSchema: z.number(), execute: async ({ inputData }) => inputData + 1 }), { concurrency: 2 }).commit(),
      [10, 20, 30],
    );
    expect(r['result']).toEqual([11, 21, 31]);
    expect((r['steps'] as Record<string, unknown>)['inc']).toEqual({ payload: [10, 20, 30], status: 'success', output: [11, 21, 31] });
  });

  it('retryCount counts per item', async () => {
    const counts = probe<string>();
    for (const e of ENGINES) {
      await onEngine(e, async () => {
        counts.as(e);
        const w = wf(e, { retryConfig: { attempts: 1 } })
          .foreach(
            step('flaky', ({ inputData, retryCount }) => {
              counts.push(`${String(inputData)}:${retryCount}`);
              if (retryCount === 0) throw new Error('first attempt');
              return inputData;
            }),
          )
          .commit();
        await (await w.createRun()).start({ inputData: [1, 2] });
      });
    }
    expect(counts.seen.petri).toEqual(counts.seen.default);
    expect(counts.seen.petri).toEqual(['1:0', '1:1', '2:0', '2:1']);
  });
});

describe('.branch() conditions', () => {
  it('the truthy set runs; a throwing sync condition and a rejecting async one are both falsy', async () => {
    const r = await agree(
      (e) =>
        wf(e)
          .branch([
            [async ({ inputData }: Ctx) => (inputData as number) > 0, step('positive', () => 'positive')],
            [async () => false, step('never', () => 'never')],
            [
              async () => {
                throw new Error('rejects');
              },
              step('rejected', () => 'rejected'),
            ],
            [
              (() => {
                throw new Error('throws');
              }) as never,
              step('thrown', () => 'thrown'),
            ],
            [async ({ state }: Ctx) => state['go'] === true, step('byState', () => 'byState')],
          ])
          .commit(),
      1,
      { initialState: { go: true } },
    );
    expect(r['result']).toEqual({ positive: 'positive', byState: 'byState' });
  });

  it("a condition's context is the default engine's: retryCount -1, no iterationCount, a bail that does nothing", async () => {
    const ctx = probe<unknown>();
    for (const e of ENGINES) {
      await onEngine(e, async () => {
        ctx.as(e);
        const w = wf(e)
          .branch([
            [
              async (c: Ctx) => {
                (c['bail'] as (x: unknown) => unknown)('ignored');
                ctx.push({ retryCount: c.retryCount, iterationCount: c['iterationCount'], mastra: c.mastra, input: c.inputData });
                return true;
              },
              step('a', () => 'a'),
            ],
          ])
          .commit();
        const r = await (await w.createRun()).start({ inputData: 3 });
        expect(r.status).toBe('success');
      });
    }
    expect(ctx.seen.petri).toEqual(ctx.seen.default);
    expect(ctx.seen.petri).toEqual([{ retryCount: -1, iterationCount: undefined, mastra: undefined, input: 3 }]);
  });
});

describe('.dowhile() / .dountil() conditions', () => {
  it('the condition sees the 1-based iterationCount, the iteration output and retryCount -1', async () => {
    const seen = probe<[number, unknown, number]>();
    for (const e of ENGINES) {
      await onEngine(e, async () => {
        seen.as(e);
        const w = wf(e)
          .dountil(step('body', ({ inputData }) => (inputData as number) + 1), async (c: Ctx) => {
            seen.push([c['iterationCount'] as number, c.inputData, c.retryCount]);
            return (c.inputData as number) >= 3;
          })
          .commit();
        await (await w.createRun()).start({ inputData: 0 });
      });
    }
    expect(seen.seen.petri).toEqual(seen.seen.default);
    expect(seen.seen.petri).toEqual([
      [1, 1, -1],
      [2, 2, -1],
      [3, 3, -1],
    ]);
    const r = await agree((e) => wf(e).dowhile(step('body', ({ inputData }) => (inputData as number) + 1), async ({ inputData }: Ctx) => (inputData as number) < 3).commit(), 0);
    expect(r['result']).toBe(3);
  });

  it('a body failing in a later iteration: the record is the failed iteration, as on the default engine', async () => {
    const r = await agree(
      (e) =>
        wf(e)
          .dountil(
            step('body', ({ inputData }) => {
              if ((inputData as number) >= 1) throw new Error('second iteration');
              return (inputData as number) + 1;
            }),
            async () => false,
          )
          .commit(),
      0,
    );
    expect((r['steps'] as Record<string, unknown>)['body']).toMatchObject({ status: 'failed', payload: 1, metadata: { iterationCount: 2 } });
  });

  it('DIVERGENCE: a loop condition that throws rejects run.start() on the default engine and fails the run here', async () => {
    const out = await both(
      (e) =>
        wf(e)
          .dowhile(step('body', ({ inputData }) => (inputData as number) + 1), async () => {
            throw new Error('condition broke');
          })
          .commit(),
      0,
    );
    expect(out.default.threw).toBe('Error: condition broke');
    expect(out.petri.result).toMatchObject({ status: 'failed', error: { message: 'condition broke' } });
  });
});

describe('.sleep(fn) and .sleepUntil(fn)', () => {
  it(".sleep(fn): the function's context (retryCount -1, setState) and the wait", async () => {
    const r = await agree(
      (e) =>
        wf(e)
          .then(step('a', () => 5))
          .sleep(async (c: Ctx) => {
            await c.setState({ slept: c.inputData, retryCount: c.retryCount });
            return c.inputData as number;
          })
          .then(step('b', ({ inputData, state }) => ({ inputData, state })))
          .commit(),
      0,
      { initialState: { before: true } },
    );
    // `setState` in a sleep function replaces the state (`handlers/sleep.ts:93-95`): `before` is gone.
    expect(r['state']).toEqual({ slept: 5, retryCount: -1 });
    expect(r['result']).toEqual({ inputData: 5, state: { slept: 5, retryCount: -1 } });
  });

  it('a literal .sleep(ms) runs without the runner and agrees with the default engine', async () => {
    const r = await agree((e) => wf(e).then(step('a', () => 5)).sleep(5).then(step('b', ({ inputData }) => inputData)).commit(), 0);
    expect(r['result']).toBe(5);
  });

  it('.sleepUntil(fn): a Date and a date string both become the instant to wait for', async () => {
    for (const until of [() => new Date(Date.now() + 5), () => new Date(Date.now() + 5).toISOString()]) {
      const r = await agree(
        (e) =>
          wf(e)
            .then(step('a', () => 5))
            .sleepUntil((async () => until()) as never)
            .then(step('b', ({ inputData }) => inputData))
            .commit(),
        0,
      );
      expect(r['result']).toBe(5);
    }
  });

  it('.sleepUntil(fn) waits for the instant it returns', async () => {
    const started = Date.now();
    const r = await (await wf('petri').sleepUntil(async () => new Date(Date.now() + 60)).then(step('b', () => Date.now())).commit().createRun()).start({ inputData: 0 });
    expect(r.status).toBe('success');
    expect((r as { result: number }).result - started).toBeGreaterThanOrEqual(55);
  });

  it('DIVERGENCE: a throwing sleep function rejects run.start() on the default engine and fails the run here', async () => {
    const out = await both(
      (e) =>
        wf(e)
          .then(step('a', () => 5))
          .sleep(async () => {
            throw new Error('no duration');
          })
          .commit(),
      0,
    );
    expect(out.default.threw).toBe('Error: no duration');
    // `StepExecutor.resolveSleep` alone would have swallowed it as a zero wait and run on.
    expect(out.petri.result).toMatchObject({ status: 'failed', error: { message: 'no duration' } });
  });
});

describe('workflow state', () => {
  it('applied after each step, merged key by key; the last setState of a step wins; initialState seeds it', async () => {
    const r = await agree(
      (e) =>
        wf(e)
          .then(
            step('a', async ({ state, setState }) => {
              await setState({ ...state, a: 1 });
              return { ...state };
            }),
          )
          .then(
            step('b', async ({ state, setState }) => {
              await setState({ b: 2 });
              await setState({ c: 3 }); // replaces the pending { b: 2 }: only the last call counts
              return { ...state };
            }),
          )
          .then(step('c', ({ state }) => ({ ...state })))
          .commit(),
      0,
      { initialState: { k: 0 } },
    );
    const steps = r['steps'] as Record<string, { output: unknown }>;
    expect(steps['a']!.output).toEqual({ k: 0 });
    expect(steps['b']!.output).toEqual({ k: 0, a: 1 });
    expect(r['state']).toEqual({ k: 0, a: 1, c: 3 });
  });

  it('parallel arms merge their updates key by key, and a running arm sees a finished sibling\'s update (#22319)', async () => {
    const r = await agree(
      (e) =>
        wf(e)
          .parallel([
            step('x', async ({ setState }) => {
              await new Promise((res) => setTimeout(res, 5));
              await setState({ x: 1 });
              return 'x';
            }),
            step('y', async ({ setState, state }) => {
              await new Promise((res) => setTimeout(res, 40));
              const seen = { ...state };
              await setState({ y: 2 });
              return seen;
            }),
          ])
          .then(step('z', ({ state }) => ({ ...state })))
          .commit(),
      0,
      { initialState: { k: 0 } },
    );
    expect((r['steps'] as Record<string, { output: unknown }>)['y']!.output).toEqual({ k: 0, x: 1 });
    expect(r['state']).toEqual({ k: 0, x: 1, y: 2 });
  });

  it('a failed step applies nothing; a suspended one applies its update', async () => {
    const failed = await agree(
      (e) =>
        wf(e)
          .then(
            step('a', async ({ setState }) => {
              await setState({ a: 1 });
              throw new Error('after setState');
            }),
          )
          .commit(),
      0,
      { initialState: { k: 0 } },
    );
    expect(failed['state']).toEqual({ k: 0 });
    const suspended = await agree(
      (e) =>
        wf(e)
          .then(
            step('a', async ({ setState, suspend }) => {
              await setState({ s: 1 });
              await suspend({ why: 'approval' });
            }),
          )
          .commit(),
      0,
      { initialState: { k: 0 } },
    );
    expect(suspended['state']).toEqual({ k: 0, s: 1 });
  });

  it("DIVERGENCE: the default engine merges updates into the caller's initialState object; this engine copies it", async () => {
    const seeds: Record<Engine, Record<string, unknown>> = { default: { k: 0 }, petri: { k: 0 } };
    for (const e of ENGINES) {
      await onEngine(e, async () => {
        const w = wf(e)
          .then(
            step('a', async ({ setState }) => {
              await setState({ a: 1 });
              return 1;
            }),
          )
          .commit();
        const r = await (await w.createRun()).start({ inputData: 0, initialState: seeds[e], outputOptions: { includeState: true } });
        expect((r as { state?: unknown }).state).toEqual({ k: 0, a: 1 });
      });
    }
    // `default.ts:811,872` seeds `executionContext.state` with the object itself and
    // `applyMutableContext` (`:709-713`) `Object.assign`s into it.
    expect(seeds.default).toEqual({ k: 0, a: 1 });
    expect(seeds.petri).toEqual({ k: 0 });
  });

  it("setState is validated against the step's stateSchema (handlers/step.ts:367-375)", async () => {
    const r = await agree(
      (e) =>
        wf(e, { stateSchema: z.object({ n: z.number() }) })
          .then(
            createStep({
              id: 'a',
              inputSchema: z.any(),
              outputSchema: z.any(),
              stateSchema: z.object({ n: z.number() }),
              execute: async ({ setState }) => {
                await setState({ n: 'not a number' } as never);
                return 1;
              },
            }),
          )
          .commit(),
      0,
      { initialState: { n: 0 } },
    );
    expect(r['status']).toBe('failed');
    expect((r['error'] as { message: string }).message).toMatch(/^Step state data validation failed/);
    expect(r['state']).toEqual({ n: 0 });
  });
});

describe('outcomes', () => {
  it('retryCount is the attempt number, 0-based, one call per attempt', async () => {
    const counts = probe<number>();
    for (const e of ENGINES) {
      await onEngine(e, async () => {
        counts.as(e);
        const w = wf(e, { retryConfig: { attempts: 2 } })
          .then(
            step('a', ({ retryCount }) => {
              counts.push(retryCount);
              if (retryCount < 2) throw new Error('again');
              return retryCount;
            }),
          )
          .commit();
        await (await w.createRun()).start({ inputData: 0 });
      });
    }
    expect(counts.seen.petri).toEqual(counts.seen.default);
    expect(counts.seen.petri).toEqual([0, 1, 2]);
  });

  it('MastraNonRetryableError stops at the first attempt and marks the record nonRetryable', async () => {
    const calls = probe<number>();
    const build = (e: Engine) => {
      calls.as(e);
      return wf(e, { retryConfig: { attempts: 3 } })
        .then(
          step('a', ({ retryCount }) => {
            calls.push(retryCount);
            throw new MastraNonRetryableError('nope');
          }),
        )
        .commit();
    };
    const r = await agree(build, 0);
    expect(calls.seen.petri).toEqual([0]);
    expect(calls.seen.default).toEqual([0]);
    expect((r['steps'] as Record<string, unknown>)['a']).toMatchObject({ status: 'failed', nonRetryable: true });
  });

  it('a TripWire ends the run as tripwire, with the flattened tripwire on the record', async () => {
    const r = await agree(
      (e) =>
        wf(e)
          .then(
            step('a', () => {
              throw new TripWire('blocked', { retry: false, metadata: { m: 1 } }, 'processor');
            }),
          )
          .commit(),
      0,
    );
    expect(r['status']).toBe('tripwire');
    expect(r['tripwire']).toEqual({ reason: 'blocked', retry: false, metadata: { m: 1 }, processorId: 'processor' });
  });

  it('bail(result) ends the run as a success with that result', async () => {
    const r = await agree(
      (e) =>
        wf(e)
          .then(step('a', ({ bail }) => bail({ early: true })))
          .then(step('b', () => 'never'))
          .commit(),
      0,
    );
    expect(r).toMatchObject({ status: 'success', result: { early: true } });
  });

  it('suspend(payload) at start: status, suspended path and payload', async () => {
    const r = await agree((e) => wf(e).then(step('a', ({ suspend }) => suspend({ q: 1 }))).commit(), 0);
    expect(r).toMatchObject({ status: 'suspended', suspended: [['a']], suspendPayload: { a: { q: 1 } } });
  });

  it("a step that suspends and then returns a value: the value is the record's suspendOutput (handlers/step.ts:520)", async () => {
    const r = await agree(
      (e) =>
        wf(e)
          .then(
            step('a', async ({ suspend }) => {
              await suspend({ q: 1 });
              return 7;
            }),
          )
          .commit(),
      0,
    );
    expect(r).toMatchObject({ status: 'suspended', steps: { a: { status: 'suspended', suspendPayload: { q: 1 }, suspendOutput: 7 } } });
  });
});

describe('what reaches a step', () => {
  it('requestContext and abortSignal reach the step; mastra is undefined when unregistered', async () => {
    const r = await agree(
      (e) =>
        wf(e)
          .then(step('a', ({ requestContext, abortSignal, mastra }) => ({ who: requestContext.get('who'), signal: abortSignal instanceof AbortSignal, mastra: mastra === undefined })))
          .commit(),
      0,
      { requestContext: new RequestContext([['who', 'me']]) },
    );
    expect(r['result']).toEqual({ who: 'me', signal: true, mastra: true });
  });

  it("a step's requestContextSchema is enforced (handlers/step.ts:117-124)", async () => {
    const r = await agree(
      (e) =>
        wf(e)
          .then(createStep({ id: 'a', inputSchema: z.any(), outputSchema: z.any(), requestContextSchema: z.object({ who: z.number() }), execute: async () => 1 }))
          .commit(),
      0,
      { requestContext: new RequestContext([['who', 'me']]) },
    );
    expect((r['error'] as { code?: string }).code).toBe('WORKFLOW_STEP_REQUEST_CONTEXT_VALIDATION_FAILED');
  });

  it("requestContext is the run's one object: a step's set() is what the next step reads", async () => {
    const r = await agree(
      (e) =>
        wf(e)
          .then(step('a', ({ requestContext }) => void requestContext.set('seen', 'by a')))
          .then(step('b', ({ requestContext }) => requestContext.get('seen')))
          .commit(),
      0,
      { requestContext: new RequestContext() },
    );
    expect(r['result']).toBe('by a');
  });

  it("abortSignal is the run's own: a step's abort() fires the signal that step holds", async () => {
    const r = await agree(
      (e) =>
        wf(e)
          .then(
            step('a', ({ abort, abortSignal }) => {
              const before = abortSignal.aborted;
              abort();
              return { before, after: abortSignal.aborted };
            }),
          )
          .commit(),
      0,
    );
    expect(r).toMatchObject({ status: 'canceled', steps: { a: { status: 'success', output: { before: false, after: true } } } });
  });

  it("a step's abort() cancels the run once the step returns", async () => {
    const r = await agree(
      (e) =>
        wf(e)
          .then(
            step('a', ({ abort }) => {
              abort();
              return 1;
            }),
          )
          .then(step('b', () => 2))
          .commit(),
      0,
    );
    expect(r['status']).toBe('canceled');
    expect(r['steps']).not.toHaveProperty('b');
  });

  it('run.cancel() fires the abortSignal a running step holds', async () => {
    const out: Record<Engine, unknown> = { default: undefined, petri: undefined };
    for (const e of ENGINES) {
      await onEngine(e, async () => {
        const run = await wf(e)
          .then(step('slow', ({ abortSignal }) => new Promise((res) => abortSignal.addEventListener('abort', () => res('saw abort')))))
          .then(step('after', () => 'never'))
          .commit()
          .createRun();
        const started = run.start({ inputData: 0 });
        setTimeout(() => void run.cancel(), 10);
        out[e] = comparable(await started);
      });
    }
    expect(out.petri).toEqual(out.default);
    expect(out.petri).toMatchObject({ status: 'canceled', steps: { slow: { status: 'success', output: 'saw abort' } } });
  });
});

describe('the runner called directly (what an end-to-end run cannot reach)', () => {
  /** A runner over a committed workflow's own graph, with the executor the engine builds unregistered. */
  const direct = (w: Wf, extra: Partial<ConstructorParameters<typeof MastraStepRunner>[0]> = {}) => {
    const graph = w.buildExecutionGraph() as ExecutionGraph;
    const executor = new StepExecutor({ mastra: { pubsub: new EventEmitterPubSub() } as never });
    const initialState = { k: 0 };
    const runner = new MastraStepRunner({
      executor,
      graph,
      workflowId: graph.id,
      runId: 'run-1',
      requestContext: new RequestContext(),
      abortController: new AbortController(),
      initialState,
      validateInputs: true,
      resourceId: undefined,
      mastra: undefined,
      ...extra,
    });
    return { runner, graph, initialState };
  };
  const call = (path: readonly number[], extra: Partial<StepCall> = {}): StepCall => ({
    path,
    initData: 0,
    getStepResult: () => undefined,
    abortSignal: new AbortController().signal,
    source: 'step',
    attempt: 0,
    ...extra,
  });

  it('resourceId reaches the step when the engine supplies it (Run.start({ resourceId }))', async () => {
    const w = wf('petri').then(step('a', (c) => c['resourceId'])).commit();
    expect(await direct(w, { resourceId: 'tenant-7' }).runner.run('a', 0, call([0]))).toMatchObject({ status: 'success', output: 'tenant-7' });
    expect(await direct(w).runner.run('a', 0, call([0]))).toMatchObject({ status: 'success', output: undefined });
  });

  it("a step's mastra is the one the engine hands the runner, never the executor's own", async () => {
    const w = wf('petri').then(step('a', ({ mastra }) => mastra)).commit();
    const registered = new Mastra({ logger: false });
    expect(await direct(w, { mastra: registered }).runner.run('a', 0, call([0]))).toMatchObject({ status: 'success', output: registered });
    // The executor here holds a stand-in; the runner was told there is none, so the step sees none.
    expect(await direct(w).runner.run('a', 0, call([0]))).toMatchObject({ status: 'success', output: undefined });
  });

  it('a foreach call: host.payload is the validated item', async () => {
    const w = wf('petri').foreach(createStep({ id: 'a', inputSchema: z.object({ n: z.number().default(5) }), outputSchema: z.any(), execute: async ({ inputData }) => inputData })).commit();
    const outcome = await direct(w).runner.run('a', {}, call([0], { foreachIndex: 1 }));
    expect(outcome).toMatchObject({ status: 'success', output: { n: 5 }, host: { payload: { n: 5 } } });
  });

  it('a failed input validation leaves the raw input as host.payload', async () => {
    const w = wf('petri').then(createStep({ id: 'a', inputSchema: z.number(), outputSchema: z.any(), execute: async () => 1 })).commit();
    const outcome = await direct(w).runner.run('a', 'x', call([0]));
    expect(outcome).toMatchObject({ status: 'failed', host: { payload: 'x' } });
  });

  it("a plain step's suspension is stored bare, and its resume labels go to the run", async () => {
    const w = wf('petri').then(step('a', ({ suspend }) => suspend({ q: 1 }, { resumeLabel: ['go', 'also'] }))).commit();
    const { runner } = direct(w);
    const outcome = await runner.run('a', 0, call([0]));
    expect(outcome).toMatchObject({ status: 'suspended', suspendPayload: { q: 1 } });
    expect((outcome as { suspendPayload: object }).suspendPayload).not.toHaveProperty('__workflow_meta');
    expect((outcome.host as Record<string, unknown>)['suspendPayload']).toEqual({ q: 1 });
    expect(runner.resumeLabels).toEqual({ go: { stepId: 'a', foreachIndex: undefined }, also: { stepId: 'a', foreachIndex: undefined } });
  });

  it("a foreach item's resume label carries its index", async () => {
    const w = wf('petri').foreach(step('a', ({ suspend }) => suspend({ q: 1 }, { resumeLabel: 'go' }))).commit();
    const { runner } = direct(w);
    await runner.run('a', 'x', call([0], { foreachIndex: 2 }));
    expect(runner.resumeLabels).toEqual({ go: { stepId: 'a', foreachIndex: 2 } });
  });

  it("a nested workflow in a .foreach(): host.metadata.nestedRunId is the run id its steps saw", async () => {
    const seen: string[] = [];
    const inner = wf('petri', {}, 'inner').then(step('i', ({ runId }) => void seen.push(runId))).commit();
    const w = wf('petri').foreach(inner).commit();
    const outcome = await direct(w).runner.run('inner', 1, call([0], { foreachIndex: 0, source: 'workflow' }));
    expect(outcome.status).toBe('success');
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe('run-1');
    expect((outcome.host as { metadata?: { nestedRunId?: string } }).metadata?.nestedRunId).toBe(seen[0]);
  });

  it('a foreach call: the step gets the item, and the record keeps the item as its payload', async () => {
    const w = wf('petri').foreach(step('a', ({ inputData }) => inputData)).commit();
    const outcome = await direct(w).runner.run('a', 'item-2', call([0], { foreachIndex: 2 }));
    expect(outcome).toMatchObject({ status: 'success', output: 'item-2', host: { payload: 'item-2' } });
  });

  it("the state is one object, merged in place; the caller's initialState is not touched", async () => {
    const w = wf('petri').then(step('a', async ({ setState }) => void (await setState({ a: 1 })))).commit();
    const { runner, initialState } = direct(w);
    const before = runner.state;
    await runner.run('a', 0, call([0]));
    expect(runner.state).toBe(before);
    expect(runner.state).toEqual({ k: 0, a: 1 });
    expect(initialState).toEqual({ k: 0 });
  });

  it('a literal .sleep() never needs the runner: asked about one, it refuses rather than guess', async () => {
    const w = wf('petri').sleep(10).commit();
    const { runner, graph } = direct(w);
    const id = (graph.steps[0] as { id: string }).id;
    await expect(runner.resolveWait(id, 0, call([0]))).rejects.toThrow(/no per-run sleep/);
  });

  it('an entry that is not at the path it names is refused, not run', async () => {
    const w = wf('petri').then(step('a', () => 1)).commit();
    await expect(direct(w).runner.run('b', 0, call([0]))).rejects.toThrow(/no step 'b' at path 0/);
  });
});

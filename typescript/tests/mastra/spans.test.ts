import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createScorer } from '@mastra/core/evals';
import { AvailableHooks, deregisterHook, registerHook } from '@mastra/core/hooks';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { getCurrentSpan } from '@mastra/core/observability/context-storage';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { PetriExecutionEngine } from '../../src/mastra/engine.js';

/**
 * Spans ([ADR 0008]; `docs/divergences.md` rows 30, 59, 60) against the default engine as the
 * ORACLE: the same workflow is built on `DefaultExecutionEngine` and on `PetriExecutionEngine`, run
 * through Mastra's own `Run` under a hand-built recording span handed in as `tracingContext`
 * (`@mastra/core` ships no in-memory exporter; `getOrCreateSpan` makes the run's span a child of the
 * given one, `observability/utils.ts:143-152`), and the whole span tree is compared: name, type,
 * entity, attributes, input, output, how it ended (ended / errored / open) and the error's id and
 * message — children order-independent, since parallel arms race.
 */

type Engine = 'default' | 'petri';
type Loose = Record<string, unknown>;
const num = z.object({ n: z.number() });
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const STAMPS = new Set(['startedAt', 'endedAt', 'suspendedAt', 'resumedAt']);

let nextId = 0;

/** A span that records what the engine does to it. Enough of Mastra's `Span` for workflows. */
class RecordingSpan {
  readonly id = `span-${++nextId}`;
  readonly traceId = 'trace-1';
  readonly isValid = true;
  readonly isInternal = false;
  readonly children: RecordingSpan[] = [];
  readonly name: string;
  readonly type: unknown;
  readonly entityType: unknown;
  readonly entityId: unknown;
  attributes: Loose;
  input: unknown;
  output: unknown;
  /** What `error()` recorded — not named `error`, which would shadow the method. */
  failure: unknown;
  state: 'open' | 'ended' | 'errored' = 'open';
  /** How many times end/error was called: once each, or the engine double-closed a span. */
  closes = 0;

  constructor(
    options: Loose,
    readonly parent?: RecordingSpan,
  ) {
    this.name = options['name'] as string;
    this.type = options['type'];
    this.entityType = options['entityType'];
    this.entityId = options['entityId'];
    this.attributes = { ...(options['attributes'] as Loose | undefined) };
    this.input = options['input'];
  }

  get externalTraceId(): string {
    return this.traceId;
  }
  get isRootSpan(): boolean {
    return this.parent === undefined;
  }
  getParentSpanId(): string | undefined {
    return this.parent?.id;
  }
  createChildSpan(options: Loose): RecordingSpan {
    const child = new RecordingSpan(options, this);
    this.children.push(child);
    return child;
  }
  createEventSpan(options: Loose): RecordingSpan {
    return this.createChildSpan(options);
  }
  end(options?: Loose): void {
    this.closes++;
    if (this.state === 'open') this.state = 'ended';
    if (options && 'output' in options) this.output = options['output'];
    Object.assign(this.attributes, options?.['attributes'] as Loose | undefined);
  }
  endTree(options?: Loose): void {
    this.end(options);
  }
  error(options: Loose): void {
    this.closes++;
    this.state = 'errored';
    this.failure = options['error'];
    Object.assign(this.attributes, options['attributes'] as Loose | undefined);
  }
  update(options: Loose): void {
    Object.assign(this.attributes, options['attributes'] as Loose | undefined);
    if ('input' in options) this.input = options['input'];
    if ('output' in options) this.output = options['output'];
  }
}

function norm(value: unknown, runId: string): unknown {
  if (value instanceof Error) {
    const id = (value as { id?: unknown }).id;
    return { error: value.message, ...(id === undefined ? {} : { id }) };
  }
  if (Array.isArray(value)) return value.map((v) => norm(v, runId));
  if (typeof value === 'string') return value.split(runId).join('<run>').replace(UUID, '<uuid>');
  if (value === null || typeof value !== 'object') return value;
  const out: Loose = {};
  for (const [k, v] of Object.entries(value as Loose)) {
    if (STAMPS.has(k)) out[k] = typeof v === 'number' ? '<t>' : v;
    else if (k === 'runId' || k === 'nestedRunId') out[k] = typeof v === 'string' ? '<run>' : v;
    else out[k] = norm(v, runId);
  }
  return out;
}

interface Node {
  readonly name: string;
  readonly type: unknown;
  readonly entity: unknown;
  readonly attributes: unknown;
  readonly input: unknown;
  readonly output: unknown;
  readonly state: string;
  readonly closes: number;
  readonly error?: unknown;
  readonly children: readonly Node[];
}

/** The span tree under `span`, normalised; siblings sorted so racing arms compare equal. */
function tree(span: RecordingSpan, runIds: readonly string[]): Node {
  const n = (v: unknown) => runIds.reduce((acc, id) => norm(acc, id), v);
  const children = span.children.map((c) => tree(c, runIds));
  children.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {
    name: span.name,
    type: span.type,
    entity: [span.entityType, span.entityId],
    attributes: n(span.attributes),
    input: n(span.input),
    output: n(span.output),
    state: span.state,
    closes: span.closes,
    ...(span.failure === undefined ? {} : { error: n(span.failure) }),
    children,
  };
}

/** Every span name in the tree, depth first, as `parent > child` paths — for readable asserts. */
function outline(node: Node, prefix = ''): string[] {
  const here = prefix ? `${prefix} > ${node.name}` : node.name;
  return [here, ...node.children.flatMap((c) => outline(c, here))];
}

function on(engine: Engine): object {
  return engine === 'default' ? {} : { executionEngine: new PetriExecutionEngine({ iterationBound: 20 }) };
}

interface Startable {
  createRun(options?: Loose): Promise<{ readonly runId: string; start(args: Loose): Promise<unknown>; resume(args: Loose): Promise<unknown> }>;
}

interface Traced {
  readonly root: RecordingSpan;
  readonly result: Loose;
  readonly tree: Node;
}

/** One run under a fresh recording root; `extra` goes to `start()`, `runOptions` to `createRun()`. */
async function traced(wf: unknown, inputData: unknown, extra: Loose = {}, runOptions: Loose = {}): Promise<Traced> {
  const root = new RecordingSpan({ name: 'root', type: 'generic' });
  const run = await (wf as Startable).createRun(runOptions);
  const result = (await run.start({ inputData, tracingContext: { currentSpan: root }, ...extra })) as Loose;
  await new Promise((r) => setTimeout(r, 5));
  // A nested run's id appears in its span's metadata; collect every run id seen.
  const ids = [run.runId];
  collectRunIds(root, ids);
  return { root, result, tree: tree(root, ids) };
}

function collectRunIds(span: RecordingSpan, into: string[]): void {
  const meta = (span.attributes['metadata'] ?? undefined) as Loose | undefined;
  if (typeof meta?.['runId'] === 'string') into.push(meta['runId']);
  for (const c of span.children) collectRunIds(c, into);
}

async function differential(make: (engine: Engine) => unknown, inputData: unknown, extra: Loose = {}): Promise<{ oracle: Traced; ours: Traced }> {
  const oracle = await traced(make('default'), inputData, extra);
  const ours = await traced(make('petri'), inputData, extra);
  expect(ours.result['status']).toBe(oracle.result['status']);
  expect(ours.tree).toEqual(oracle.tree);
  return { oracle, ours };
}

const plus = (id: string, by = 1) =>
  createStep({ id, inputSchema: num, outputSchema: num, execute: async ({ inputData }) => ({ n: inputData.n + by }) });

describe('spans — the default engine as the oracle', () => {
  it('a linear chain: one WORKFLOW_STEP span per step under the run span, ended with output and status', async () => {
    // The ambient span needs Mastra's AsyncLocalStorage resolver, which a `Mastra` installs
    // (`observability/context-storage.ts`, `initContextStorage`); without one neither engine has it.
    new Mastra({ logger: false });
    const seen: Record<Engine, unknown[]> = { default: [], petri: [] };
    const make = (engine: Engine) =>
      createWorkflow({ id: 'sp-linear', inputSchema: num, outputSchema: num, ...on(engine) })
        .then(
          createStep({
            id: 'a',
            inputSchema: num,
            outputSchema: num,
            execute: async (ctx) => {
              // The step's span is the context's current span and the ambient one (`handlers/step.ts:302-311,382`).
              const c = ctx as unknown as { tracingContext?: { currentSpan?: RecordingSpan }; tracing?: { currentSpan?: RecordingSpan } };
              seen[engine].push(c.tracingContext?.currentSpan?.name, c.tracing?.currentSpan?.name, (getCurrentSpan() as RecordingSpan | undefined)?.name);
              return { n: ctx.inputData.n + 1 };
            },
          }),
        )
        .then(plus('b', 10))
        .commit();
    const { ours } = await differential(make, { n: 1 });
    expect(outline(ours.tree)).toEqual(["root", "root > workflow run: 'sp-linear'", "root > workflow run: 'sp-linear' > workflow step: 'a'", "root > workflow run: 'sp-linear' > workflow step: 'b'"]);
    const a = ours.tree.children[0]!.children[0]!;
    expect(a).toMatchObject({ type: 'workflow_step', input: { n: 1 }, output: { n: 2 }, state: 'ended', closes: 1, attributes: { status: 'success' } });
    expect(seen.petri).toEqual(seen.default);
    expect(seen.petri).toEqual(["workflow step: 'a'", "workflow step: 'a'", "workflow step: 'a'"]);
  });

  it('a step retried then succeeding: one span for every attempt, ended once', async () => {
    const make = (engine: Engine) =>
      createWorkflow({ id: 'sp-retry', inputSchema: num, outputSchema: num, retryConfig: { attempts: 2 }, ...on(engine) })
        .then(
          createStep({
            id: 'flaky',
            inputSchema: num,
            outputSchema: num,
            execute: async ({ inputData, retryCount }) => {
              if (retryCount < 2) throw new Error(`try ${retryCount}`);
              return { n: inputData.n + retryCount };
            },
          }),
        )
        .commit();
    const { ours } = await differential(make, { n: 1 });
    expect(ours.tree.children[0]!.children).toHaveLength(1);
    expect(ours.tree.children[0]!.children[0]).toMatchObject({ state: 'ended', closes: 1, output: { n: 3 } });
  });

  it('an impure input schema runs once: the span, the step and every retry see its one value', async () => {
    const calls: Record<Engine, number> = { default: 0, petri: 0 };
    const make = (engine: Engine) =>
      createWorkflow({ id: 'sp-impure', inputSchema: num, outputSchema: z.any(), retryConfig: { attempts: 1 }, ...on(engine) })
        .then(
          createStep({
            id: 'impure',
            inputSchema: num.transform((v) => ({ ...v, call: ++calls[engine] })) as unknown as typeof num,
            outputSchema: z.any(),
            execute: async ({ inputData, retryCount }) => {
              if (retryCount === 0) throw new Error('once');
              return inputData;
            },
          }),
        )
        .commit();
    const { ours } = await differential(make, { n: 1 });
    expect(calls).toEqual({ default: 1, petri: 1 });
    expect(ours.tree.children[0]!.children[0]).toMatchObject({ input: { n: 1, call: 1 }, output: { n: 1, call: 1 }, closes: 1 });
  });

  it('a failing step: its span errored with WORKFLOW_STEP_INVOKE_FAILED and status failed, never ended', async () => {
    const make = (engine: Engine) =>
      createWorkflow({ id: 'sp-fail', inputSchema: num, outputSchema: num, ...on(engine) })
        .then(
          createStep({
            id: 'boom',
            inputSchema: num,
            outputSchema: num,
            execute: async () => {
              throw new Error('kaboom');
            },
          }),
        )
        .commit();
    const { ours } = await differential(make, { n: 1 });
    expect(ours.tree.children[0]!.children[0]).toMatchObject({
      state: 'errored',
      closes: 1,
      attributes: { status: 'failed' },
      error: { id: 'WORKFLOW_STEP_INVOKE_FAILED', error: 'kaboom' },
    });
  });

  it('parallel: a WORKFLOW_PARALLEL span holding each arm\'s span, ended with the outputs by id', async () => {
    const make = (engine: Engine) =>
      createWorkflow({ id: 'sp-par', inputSchema: num, outputSchema: z.any(), ...on(engine) })
        .parallel([plus('p1'), plus('p2', 2), plus('p3', 3)])
        .commit();
    const { ours } = await differential(make, { n: 1 });
    const par = ours.tree.children[0]!.children[0]!;
    expect(par).toMatchObject({
      type: 'workflow_parallel',
      name: "parallel: '3 branches'",
      attributes: { branchCount: 3, parallelSteps: ['p1', 'p2', 'p3'] },
      output: { p1: { n: 2 }, p2: { n: 3 }, p3: { n: 4 } },
      state: 'ended',
    });
    expect(par.children.map((c) => c.name)).toEqual(["workflow step: 'p1'", "workflow step: 'p2'", "workflow step: 'p3'"]);
  });

  it('parallel with a failing arm: the block span errored with the arm\'s error, every arm still closed', async () => {
    const bad = createStep({
      id: 'bad',
      inputSchema: num,
      outputSchema: num,
      execute: async () => {
        throw new Error('arm down');
      },
    });
    const make = (engine: Engine) =>
      createWorkflow({ id: 'sp-par-fail', inputSchema: num, outputSchema: z.any(), ...on(engine) })
        .parallel([plus('ok'), bad])
        .commit();
    const { ours } = await differential(make, { n: 1 });
    expect(ours.tree.children[0]!.children[0]).toMatchObject({ state: 'errored', error: { error: 'arm down' } });
  });

  it('foreach: a WORKFLOW_LOOP span with one step span per item, ended with the outputs', async () => {
    const make = (engine: Engine) =>
      createWorkflow({ id: 'sp-foreach', inputSchema: z.array(num), outputSchema: z.any(), ...on(engine) })
        .foreach(plus('item'), { concurrency: 2 })
        .commit();
    const { ours } = await differential(make, [{ n: 1 }, { n: 2 }, { n: 3 }]);
    const loop = ours.tree.children[0]!.children[0]!;
    expect(loop).toMatchObject({
      type: 'workflow_loop',
      name: "loop: 'foreach'",
      attributes: { loopType: 'foreach', concurrency: 2 },
      output: [{ n: 2 }, { n: 3 }, { n: 4 }],
      state: 'ended',
    });
    expect(loop.children).toHaveLength(3);
  });

  it('a dowhile loop: a WORKFLOW_LOOP span, a step span and a condition eval span per iteration', async () => {
    const make = (engine: Engine) =>
      createWorkflow({ id: 'sp-loop', inputSchema: num, outputSchema: num, ...on(engine) })
        .dowhile(plus('inc'), async ({ inputData }) => inputData.n < 3)
        .commit();
    const { ours } = await differential(make, { n: 0 });
    const loop = ours.tree.children[0]!.children[0]!;
    expect(loop).toMatchObject({ type: 'workflow_loop', attributes: { loopType: 'dowhile', totalIterations: 3 }, output: { n: 3 }, state: 'ended' });
    expect(loop.children).toHaveLength(6);
  });

  it('a nested workflow: its run span under the step span that runs it, its steps under that', async () => {
    const make = (engine: Engine) => {
      const inner = createWorkflow({ id: 'sp-inner', inputSchema: num, outputSchema: num, ...on(engine) }).then(plus('in1')).then(plus('in2')).commit();
      return createWorkflow({ id: 'sp-outer', inputSchema: num, outputSchema: num, ...on(engine) }).then(plus('pre')).then(inner).commit();
    };
    const { ours } = await differential(make, { n: 1 });
    expect(outline(ours.tree)).toContain(
      "root > workflow run: 'sp-outer' > workflow step: 'sp-inner' > workflow run: 'sp-inner' > workflow step: 'in2'",
    );
  });

  it('a suspending step: its span ended with status suspended and no output', async () => {
    const make = (engine: Engine) =>
      createWorkflow({ id: 'sp-susp', inputSchema: num, outputSchema: num, ...on(engine) })
        .then(
          createStep({
            id: 'wait',
            inputSchema: num,
            outputSchema: num,
            suspendSchema: z.object({ why: z.string() }),
            execute: async ({ suspend }) => suspend({ why: 'later' }) as never,
          }),
        )
        .commit();
    const { ours } = await differential(make, { n: 1 });
    expect(ours.tree.children[0]!.children[0]).toMatchObject({ state: 'ended', attributes: { status: 'suspended' }, output: undefined });
  });

  it('a .foreach() whose item fails: the item span errored, the loop span errored with the item\'s error', async () => {
    const odd = createStep({
      id: 'odd',
      inputSchema: num,
      outputSchema: num,
      execute: async ({ inputData }) => {
        if (inputData.n === 2) throw new Error('item 2 failed');
        return inputData;
      },
    });
    const make = (engine: Engine) =>
      createWorkflow({ id: 'sp-foreach-fail', inputSchema: z.array(num), outputSchema: z.any(), ...on(engine) }).foreach(odd).commit();
    const { ours } = await differential(make, [{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(ours.tree.children[0]!.children[0]).toMatchObject({ type: 'workflow_loop', state: 'errored', error: { error: 'item 2 failed' } });
  });

  it('a .dountil() whose body fails in iteration 2: the loop span ended early with totalIterations 1', async () => {
    const make = (engine: Engine) =>
      createWorkflow({ id: 'sp-loop-fail', inputSchema: num, outputSchema: num, ...on(engine) })
        .dountil(
          createStep({
            id: 'body',
            inputSchema: num,
            outputSchema: num,
            execute: async ({ inputData }) => {
              if (inputData.n >= 1) throw new Error('second pass');
              return { n: inputData.n + 1 };
            },
          }),
          async ({ inputData }) => inputData.n > 5,
        )
        .commit();
    const { ours } = await differential(make, { n: 0 });
    expect(ours.tree.children[0]!.children[0]).toMatchObject({ state: 'ended', attributes: { loopType: 'dountil', totalIterations: 1 } });
  });

  it('a resumed .parallel() arm: no parallel span on the resume, the arm\'s span under the run span', async () => {
    const gate = createStep({
      id: 'gate',
      inputSchema: num,
      outputSchema: num,
      resumeSchema: z.object({ add: z.number() }),
      execute: async ({ inputData, resumeData, suspend }) => (resumeData ? { n: inputData.n + resumeData.add } : (suspend({}) as never)),
    });
    const make = (engine: Engine) =>
      createWorkflow({ id: 'sp-par-resume', inputSchema: num, outputSchema: z.any(), ...on(engine) })
        .parallel([plus('free'), gate])
        .then(createStep({ id: 'after', inputSchema: z.any(), outputSchema: z.any(), execute: async ({ inputData }) => inputData }))
        .commit();
    const phases = async (engine: Engine) => {
      const wf = make(engine);
      new Mastra({ storage: new InMemoryStore(), workflows: { wf } as never, logger: false });
      const run = await (wf as unknown as Startable).createRun();
      const first = new RecordingSpan({ name: 'root', type: 'generic' });
      await run.start({ inputData: { n: 1 }, tracingContext: { currentSpan: first } });
      const second = new RecordingSpan({ name: 'root', type: 'generic' });
      const resumed = (await run.resume({ step: 'gate', resumeData: { add: 10 }, tracingContext: { currentSpan: second } })) as Loose;
      return { status: resumed['status'], start: tree(first, [run.runId]), resume: tree(second, [run.runId]) };
    };
    const oracle = await phases('default');
    const ours = await phases('petri');
    expect(ours).toEqual(oracle);
    expect(outline(ours.resume)).toEqual([
      'root',
      "root > workflow run: 'sp-par-resume' (resumed)",
      "root > workflow run: 'sp-par-resume' (resumed) > workflow step: 'after'",
      "root > workflow run: 'sp-par-resume' (resumed) > workflow step: 'gate'",
    ]);
  });

  describe('scorers, disableScorers and actor', () => {
    const payloads: Loose[] = [];
    const hook = (p: unknown) => void payloads.push(p as Loose);
    afterEach(() => {
      deregisterHook(AvailableHooks.ON_SCORER_RUN, hook);
      payloads.length = 0;
    });

    const scorer = createScorer({ id: 'stub-scorer', name: 'stub', description: 'a stub' }).generateScore(() => 1);
    const make = (seen: Loose[]) => (engine: Engine) =>
      createWorkflow({ id: 'sp-score', inputSchema: num, outputSchema: num, ...on(engine) })
        .then(
          createStep({
            id: 'scored',
            inputSchema: num,
            outputSchema: num,
            scorers: { stub: { scorer } },
            execute: async (ctx) => {
              const c = ctx as unknown as Loose;
              seen.push({ actor: c['actor'], scorers: c['scorers'] === undefined ? 'none' : Object.keys(c['scorers'] as Loose) });
              return { n: ctx.inputData.n * 2 };
            },
          }),
        )
        .commit();

    /** One scorer hook payload, normalised: the tracing context reduced to its span's name. */
    const scored = (p: Loose, runId: string) => {
      const { tracing, tracingContext, loggerVNext: _l, metrics: _m, ...rest } = p;
      return {
        ...(norm(rest, runId) as Loose),
        tracing: (tracing as { currentSpan?: RecordingSpan } | undefined)?.currentSpan?.name,
        tracingContext: (tracingContext as { currentSpan?: RecordingSpan } | undefined)?.currentSpan?.name,
      };
    };

    it('step.scorers run once after the step, under its span, as runScorersForStep fires them', async () => {
      registerHook(AvailableHooks.ON_SCORER_RUN, hook);
      const seen: Loose[] = [];
      const oracle = await traced(make(seen)('default'), { n: 3 });
      await new Promise((r) => setImmediate(r));
      const oracleRun = (payloads[0]?.['runId'] as string) ?? '';
      const fromOracle = payloads.splice(0).map((p) => scored(p, oracleRun));
      const ours = await traced(make(seen)('petri'), { n: 3 });
      await new Promise((r) => setImmediate(r));
      const oursRun = (payloads[0]?.['runId'] as string) ?? '';
      const fromOurs = payloads.splice(0).map((p) => scored(p, oursRun));
      expect(ours.tree).toEqual(oracle.tree);
      expect(fromOracle).toHaveLength(1);
      expect(fromOurs).toEqual(fromOracle);
      expect(fromOurs[0]).toMatchObject({
        scorer: { id: 'stub-scorer', name: 'stub', description: 'a stub' },
        input: { n: 3 },
        output: { n: 6 },
        source: 'LIVE',
        entityType: 'WORKFLOW',
        entity: { id: 'sp-score', stepId: 'scored' },
        structuredOutput: true,
        tracing: "workflow step: 'scored'",
      });
      expect(seen[1]).toEqual(seen[0]);
    });

    it('disableScorers: no scorer runs, and the step sees the scorers exactly as the default engine hands them', async () => {
      registerHook(AvailableHooks.ON_SCORER_RUN, hook);
      for (const disableScorers of [true, false]) {
        const seen: Loose[] = [];
        // `disableScorers` is a `createRun` option (`workflow.ts:2753`), which `Run` hands `execute()` (`:3785`).
        await traced(make(seen)('default'), { n: 1 }, {}, { disableScorers });
        await traced(make(seen)('petri'), { n: 1 }, {}, { disableScorers });
        await new Promise((r) => setImmediate(r));
        expect(payloads).toHaveLength(disableScorers ? 0 : 2);
        payloads.length = 0;
        expect(seen[1]).toEqual(seen[0]);
      }
    });

    it('actor reaches the step as the default engine forwards it', async () => {
      const seen: Loose[] = [];
      const actor = { type: 'user', id: 'u-1' };
      await traced(make(seen)('default'), { n: 1 }, { actor });
      await traced(make(seen)('petri'), { n: 1 }, { actor });
      expect(seen[0]).toMatchObject({ actor });
      expect(seen[1]).toEqual(seen[0]);
    });
  });

  it('mastra handed to a step is wrapped with the step span, as the default engine wraps it', async () => {
    const seen: Record<Engine, unknown> = { default: undefined, petri: undefined };
    for (const engine of ['default', 'petri'] as const) {
      const wf = createWorkflow({ id: `sp-mastra-${engine}`, inputSchema: num, outputSchema: num, ...on(engine) })
        .then(
          createStep({
            id: 'm',
            inputSchema: num,
            outputSchema: num,
            execute: async ({ inputData, mastra }) => {
              seen[engine] = mastra !== undefined && mastra !== registered[engine] && typeof mastra.getWorkflow === 'function';
              return inputData;
            },
          }),
        )
        .commit();
      const registered: Record<Engine, Mastra | undefined> = { default: undefined, petri: undefined };
      const mastra = new Mastra({ workflows: { wf }, logger: false });
      registered[engine] = mastra;
      await traced(mastra.getWorkflow('wf'), { n: 1 });
    }
    // A proxy over the registered instance (`wrapMastra`, `observability/context.ts:54-100`).
    expect(seen).toEqual({ default: true, petri: true });
  });

  describe('a branch', () => {
    it('conditions each get an eval span, the conditional span records truthyIndexes and holds the taken arm', async () => {
      const make = (engine: Engine) =>
        createWorkflow({ id: 'sp-branch', inputSchema: num, outputSchema: z.any(), ...on(engine) })
          .branch([
            [async ({ inputData }) => inputData.n > 5, plus('big')],
            [async ({ inputData }) => inputData.n <= 5, plus('small')],
          ])
          .commit();
      const { ours } = await differential(make, { n: 1 });
      const cond = ours.tree.children[0]!.children[0]!;
      expect(cond).toMatchObject({
        type: 'workflow_conditional',
        attributes: { conditionCount: 2, truthyIndexes: [1], selectedSteps: ['small'] },
        output: { small: { n: 2 } },
        state: 'ended',
      });
      expect(cond.children.map((c) => [c.name, c.output])).toEqual([
        ["condition '0'", false],
        ["condition '1'", true],
        ["workflow step: 'small'", { n: 2 }],
      ]);
    });

    it('a throwing condition: WORKFLOW_CONDITION_EVALUATION_FAILED tracked and logged, its eval span errored, read as false', async () => {
      const logs: Record<Engine, { method: string; arg: unknown }[]> = { default: [], petri: [] };
      const spy = (engine: Engine) =>
        new Proxy(
          {},
          {
            get: (_, method) => (arg: unknown) => {
              if (method === 'trackException' || method === 'error') logs[engine].push({ method: String(method), arg });
              return method === 'getTransports' ? new Map() : undefined;
            },
          },
        );
      const make = (engine: Engine) => {
        const wf = createWorkflow({ id: 'sp-branch-throw', inputSchema: num, outputSchema: z.any(), ...on(engine) })
          .branch([
            [
              async () => {
                throw new Error('bad condition');
              },
              plus('never'),
            ],
            [async () => true, plus('taken')],
          ])
          .commit();
        (wf as unknown as { __setLogger(l: unknown): void }).__setLogger(spy(engine));
        return wf;
      };
      const { ours } = await differential(make, { n: 1 });
      const summary = (engine: Engine) =>
        logs[engine].map(({ method, arg }) =>
          method === 'trackException'
            ? { method, id: (arg as { id: string }).id, message: (arg as Error).message, details: norm((arg as { details: unknown }).details, 'x') }
            : { method, text: String(arg).split('\n')[0] },
        );
      expect(summary('petri')).toEqual(summary('default'));
      expect(summary('petri')).toEqual([
        { method: 'trackException', id: 'WORKFLOW_CONDITION_EVALUATION_FAILED', message: 'bad condition', details: expect.any(Object) },
        { method: 'error', text: 'Error evaluating condition: Error: bad condition' },
      ]);
      const cond = ours.tree.children[0]!.children[0]!;
      expect(cond.children.find((c) => c.name === "condition '0'")).toMatchObject({
        state: 'errored',
        attributes: { result: false },
        error: { id: 'WORKFLOW_CONDITION_EVALUATION_FAILED', error: 'bad condition' },
      });
      expect(cond.attributes).toMatchObject({ truthyIndexes: [1], selectedSteps: ['taken'] });
    });
  });
});

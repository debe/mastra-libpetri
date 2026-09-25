import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import type { ExecutionEngine, ExecutionEngineOptions } from '@mastra/core/workflows';
import { StepExecutor } from '@mastra/core/workflows/evented';
import { TripWire } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/di';
import { Mastra } from '@mastra/core/mastra';
import { PetriExecutionEngine, StrandedRunError, UnsupportedRunModeError } from '../../src/mastra/engine.js';
import * as persist from '../../src/mastra/persist.js';
import * as kernel from '../../src/engine/kernel.js';

// persistRun is observed, never replaced: every call goes through to persist.ts's implementation.
vi.mock('../../src/mastra/persist.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/mastra/persist.js')>();
  return { ...actual, persistRun: vi.fn(actual.persistRun) };
});

// The kernel too: observed with call-through, and replaced for one call only where a test needs an
// outcome no real workflow produces (a stranded run, a leaked token).
vi.mock('../../src/engine/kernel.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/engine/kernel.js')>();
  return { ...actual, runWorkflowDetailed: vi.fn(actual.runWorkflowDetailed) };
});
const realPersistRun = vi.mocked(persist.persistRun).getMockImplementation()!;
const realRunWorkflowDetailed = vi.mocked(kernel.runWorkflowDetailed).getMockImplementation()!;

// ---------------------------------------------------------------------------------------------
// Fixtures: real Mastra workflows, built once per engine so the default engine is the oracle.
// ---------------------------------------------------------------------------------------------

type Engine = 'default' | 'petri';
type Callbacks = Pick<ExecutionEngineOptions, 'onFinish' | 'onError'>;

/**
 * A workflow on either engine. The petri engine takes its callbacks through its own options: a
 * custom `executionEngine` never sees `createWorkflow({ options })` (`workflow.ts:1819-1827`).
 */
function build<W>(engine: Engine, callbacks: Callbacks, make: (cfg: object) => W): W {
  return engine === 'default'
    ? make({ options: { ...callbacks } })
    : make({ executionEngine: new PetriExecutionEngine({ options: { ...callbacks } }) });
}

const num = z.object({ n: z.number() });

function linear(engine: Engine, callbacks: Callbacks = {}) {
  const a = createStep({
    id: 'a',
    inputSchema: num,
    outputSchema: num,
    stateSchema: z.object({ seen: z.array(z.string()).optional() }),
    execute: async ({ inputData, state, setState }) => {
      await setState({ ...state, seen: [...(state.seen ?? []), 'a'] });
      return { n: inputData.n + 1 };
    },
  });
  const b = createStep({
    id: 'b',
    inputSchema: num,
    outputSchema: num,
    stateSchema: z.object({ seen: z.array(z.string()).optional() }),
    execute: async ({ inputData, state, setState }) => {
      await setState({ ...state, seen: [...(state.seen ?? []), 'b'] });
      return { n: inputData.n * 10 };
    },
  });
  return build(engine, callbacks, (cfg) =>
    createWorkflow({
      id: 'linear',
      inputSchema: num,
      outputSchema: num,
      stateSchema: z.object({ seen: z.array(z.string()).optional() }),
      ...cfg,
    })
      .then(a)
      .then(b)
      .commit(),
  );
}

function failing(engine: Engine, callbacks: Callbacks = {}) {
  const boom = createStep({
    id: 'boom',
    inputSchema: num,
    outputSchema: num,
    execute: async () => {
      throw new Error('kaboom');
    },
  });
  return build(engine, callbacks, (cfg) =>
    createWorkflow({ id: 'failing', inputSchema: num, outputSchema: num, ...cfg }).then(boom).commit(),
  );
}

function tripping(engine: Engine, callbacks: Callbacks = {}) {
  const guard = createStep({
    id: 'guard',
    inputSchema: num,
    outputSchema: num,
    execute: async () => {
      throw new TripWire('blocked', { retry: false, metadata: { rule: 'r1' } }, 'proc-1');
    },
  });
  return build(engine, callbacks, (cfg) =>
    createWorkflow({ id: 'tripping', inputSchema: num, outputSchema: num, ...cfg }).then(guard).commit(),
  );
}

/** `first` waits for the run's abort; `second` must never run. */
function abortable(engine: Engine, started: () => void, callbacks: Callbacks = {}) {
  const ran: string[] = [];
  const first = createStep({
    id: 'first',
    inputSchema: num,
    outputSchema: num,
    execute: async ({ inputData, abortSignal }) => {
      ran.push('first');
      started();
      await new Promise<void>((resolve) => {
        if (abortSignal.aborted) resolve();
        else abortSignal.addEventListener('abort', () => resolve(), { once: true });
      });
      return inputData;
    },
  });
  const second = createStep({
    id: 'second',
    inputSchema: num,
    outputSchema: num,
    execute: async ({ inputData }) => {
      ran.push('second');
      return inputData;
    },
  });
  const wf = build(engine, callbacks, (cfg) =>
    createWorkflow({ id: 'abortable', inputSchema: num, outputSchema: num, ...cfg })
      .then(first)
      .then(second)
      .commit(),
  );
  return { wf, ran };
}

// ---------------------------------------------------------------------------------------------
// A recording workflow span, handed in as the parent so `Run._start` creates the run's span from
// it (`observability/utils.ts:144`) — the span `execute()` must end.
// ---------------------------------------------------------------------------------------------

interface SpanCall {
  readonly span: string;
  readonly method: 'end' | 'error' | 'endTree';
  readonly args: unknown;
}

function recordingSpan(name: string, calls: SpanCall[]): object {
  let children = 0;
  const target: Record<string, unknown> = {
    id: name,
    name,
    traceId: 'trace-1',
    externalTraceId: 'trace-1',
    isInternal: false,
    isValid: true,
    end: (args: unknown) => calls.push({ span: name, method: 'end', args }),
    error: (args: unknown) => calls.push({ span: name, method: 'error', args }),
    endTree: (args: unknown) => calls.push({ span: name, method: 'endTree', args }),
    createChildSpan: () => recordingSpan(`${name}/${children++}`, calls),
    createEventSpan: () => recordingSpan(`${name}/event${children++}`, calls),
    getParentSpanId: () => undefined,
    findParent: () => undefined,
    exportSpan: () => undefined,
    isRootSpan: false,
    executeInContext: (fn: () => Promise<unknown>) => fn(),
    executeInContextSync: (fn: () => unknown) => fn(),
  };
  return new Proxy(target, {
    get: (t, key) => {
      if (key in t) return t[key as string];
      if (key === 'then' || typeof key === 'symbol') return undefined;
      return () => undefined;
    },
  });
}

/** The run's own span: the first child of the recording parent. */
const RUN_SPAN = 'parent/0';
const runSpanEnds = (calls: readonly SpanCall[]): SpanCall[] =>
  calls.filter((c) => c.span === RUN_SPAN && (c.method === 'end' || c.method === 'error'));

/** Start options that make `Run._start` build the run span from a recording parent. */
function traced(calls: SpanCall[]): { tracingContext: { currentSpan: never } } {
  return { tracingContext: { currentSpan: recordingSpan('parent', calls) as never } };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(persist.persistRun).mockReset().mockImplementation(realPersistRun);
  vi.mocked(kernel.runWorkflowDetailed).mockReset().mockImplementation(realRunWorkflowDetailed);
});

// ---------------------------------------------------------------------------------------------

describe('PetriExecutionEngine.execute — a linear workflow through Mastra\'s own Run', () => {
  it('matches the default engine: status, result, every step output and the workflow state', async () => {
    const results = await Promise.all(
      (['default', 'petri'] as const).map(async (engine) => {
        const run = await linear(engine).createRun();
        return run.start({ inputData: { n: 1 }, outputOptions: { includeState: true } });
      }),
    );
    const [oracle, ours] = results as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(ours['status']).toBe('success');
    expect(ours['status']).toBe(oracle['status']);
    expect(ours['result']).toEqual({ n: 20 });
    expect(ours['result']).toEqual(oracle['result']);
    expect(ours['state']).toEqual({ seen: ['a', 'b'] });
    expect(ours['state']).toEqual(oracle['state']);
    const outputs = (r: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(r['steps'] as Record<string, { status?: string; output?: unknown }>)
          .filter(([id]) => id !== 'input')
          .map(([id, s]) => [id, [s.status, s.output]]),
      );
    expect(outputs(ours)).toEqual(outputs(oracle));
  });

  it.each(['linear', 'failing', 'tripping'] as const)('%s: returns the default engine\'s whole result, timestamps aside', async (which) => {
    const strip = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(strip)
        : v !== null && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v as Record<string, unknown>)
                .filter(([k]) => !['startedAt', 'endedAt', 'runId', 'traceId', 'spanId'].includes(k))
                .map(([k, x]) => [k, strip(x)]),
            )
          : v;
    const [oracle, ours] = await Promise.all(
      (['default', 'petri'] as const).map(async (engine) =>
        (await (which === 'linear' ? linear(engine) : which === 'failing' ? failing(engine) : tripping(engine)).createRun()).start({
          inputData: { n: 1 },
          outputOptions: { includeState: true },
        }),
      ),
    );
    expect(strip(ours)).toEqual(strip(oracle));
  });

  it('adds runId to the result and omits state unless includeState asks for it, as the default engine', async () => {
    const run = await linear('petri').createRun();
    const result = (await run.start({ inputData: { n: 1 } })) as Record<string, unknown>;
    expect(result['runId']).toBe(run.runId);
    expect('state' in result).toBe(false);
  });

  it('ends the run span once, with the result as output and status success (default.ts:1095-1100)', async () => {
    const calls: SpanCall[] = [];
    const run = await linear('petri').createRun();
    await run.start({ inputData: { n: 1 }, ...traced(calls) });
    expect(runSpanEnds(calls)).toEqual([
      { span: RUN_SPAN, method: 'end', args: { output: { n: 20 }, attributes: { status: 'success' } } },
    ]);
  });

  it('ends the run span as the default engine does, argument for argument', async () => {
    const both = await Promise.all(
      (['default', 'petri'] as const).map(async (engine) => {
        const calls: SpanCall[] = [];
        const run = await linear(engine).createRun();
        await run.start({ inputData: { n: 1 }, ...traced(calls) });
        return runSpanEnds(calls);
      }),
    );
    expect(both[1]).toEqual(both[0]);
  });

  it('reads validateInputs from the engine options at run time, never at construction', async () => {
    const wf = linear('petri');
    const engine = (wf as unknown as { executionEngine: ExecutionEngine }).executionEngine;
    const seen: boolean[] = [];
    const real = StepExecutor.prototype.execute;
    vi.spyOn(StepExecutor.prototype, 'execute').mockImplementation(function (this: StepExecutor, p) {
      seen.push(p.validateInputs ?? true);
      return real.call(this, p);
    });
    const r1 = await wf.createRun();
    await r1.start({ inputData: { n: 1 } });
    engine.options = { ...engine.options, validateInputs: false };
    // Run._start leaves the engine's options alone; init() and Workflow.execute (the nested path,
    // workflow.ts:2939-2949) replace them. Flip them inside execute() to show the read is per run.
    const original = engine.execute.bind(engine);
    vi.spyOn(engine, 'execute').mockImplementation((params) => {
      engine.options = { ...engine.options, validateInputs: false };
      return original(params);
    });
    const r2 = await wf.createRun();
    await r2.start({ inputData: { n: 1 } });
    expect(seen).toEqual([true, true, false, false]);
  });
});

describe('PetriExecutionEngine.execute — refusals', () => {
  async function direct(extra: Record<string, unknown>) {
    const calls: SpanCall[] = [];
    const wf = linear('petri');
    const engine = (wf as unknown as { executionEngine: ExecutionEngine }).executionEngine;
    const run = await wf.createRun();
    const span = recordingSpan('run', calls);
    const params = {
      workflowId: wf.id,
      runId: run.runId,
      graph: wf.buildExecutionGraph(),
      serializedStepGraph: wf.serializedStepGraph,
      input: { n: 1 },
      pubsub: (run as unknown as { pubsub: unknown }).pubsub,
      requestContext: new RequestContext(),
      abortController: new AbortController(),
      workflowSpan: span,
      ...extra,
    } as unknown as Parameters<ExecutionEngine['execute']>[0];
    const outcome = await engine.execute(params).then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    return { outcome, calls };
  }

  // Resume is implemented (ADR 0007), so it is not a mode refused by name; the refusal of one
  // position it cannot place is asserted on its own below.
  it.each([
    ['restart', { restart: { activePaths: [0], activeStepsPath: {}, stepResults: {}, state: {} } }],
    ['timeTravel', { timeTravel: { executionPath: [0], steps: ['a'], stepResults: {}, state: {} } }],
    ['perStep', { perStep: true }],
  ] as const)('refuses %s by name, rejecting, and errors the run span once', async (mode, extra) => {
    const { outcome, calls } = await direct(extra);
    expect(outcome.ok).toBe(false);
    const error = (outcome as { e: unknown }).e;
    expect(error).toBeInstanceOf(UnsupportedRunModeError);
    expect((error as UnsupportedRunModeError).mode).toBe(mode);
    expect(calls).toEqual([{ span: 'run', method: 'error', args: { error } }]);
  });

  it('refuses a resume whose resumed step has no stored record, naming the step, its position and the reason', async () => {
    // Mastra falls back to the previous entry's output, or the run input at index 0, as the
    // step's input (`handlers/entry.ts:111-128`); this engine refuses by name (divergence row
    // 80(c)) and errors the span once. That nothing runs or persists is pinned for every refusal by
    // engine-resume.test.ts ("a refused resume persists nothing, and Run releases its claim").
    const { outcome, calls } = await direct({ resume: { steps: ['a'], stepResults: {}, resumePayload: {}, resumePath: [0] } });
    expect(outcome.ok).toBe(false);
    const error = (outcome as { e: unknown }).e;
    expect(error).toBeInstanceOf(UnsupportedRunModeError);
    expect((error as UnsupportedRunModeError).mode).toBe('resume');
    expect((error as UnsupportedRunModeError).resume).toStrictEqual({ stepId: 'a', path: [0], reason: 'unsupported' });
    // Refused for the missing record, not for anything else about the request.
    expect((error as Error).message).toContain("no stored input for step 'a' at [0]: its record is missing");
    expect(calls).toEqual([{ span: 'run', method: 'error', args: { error } }]);
  });

  it('refuses perStep through Run.start: start() rejects, as Run lets execute() rejections through', async () => {
    const calls: SpanCall[] = [];
    const run = await linear('petri').createRun();
    await expect(run.start({ inputData: { n: 1 }, perStep: true, ...traced(calls) })).rejects.toBeInstanceOf(
      UnsupportedRunModeError,
    );
    expect(runSpanEnds(calls).map((c) => c.method)).toEqual(['error']);
  });

  it('an empty graph rejects with Mastra\'s own error id (default.ts:777-787), span errored', async () => {
    // Run.createRun refuses an empty workflow before execute() on both engines (workflow.ts:2720);
    // a direct caller of execute() still gets the default engine's error.
    const { outcome, calls } = await direct({ graph: { id: 'linear', steps: [] } });
    expect(outcome.ok).toBe(false);
    const error = (outcome as { e: unknown }).e as { id?: string };
    expect(error.id).toBe('WORKFLOW_EXECUTE_EMPTY_GRAPH');
    expect(calls).toEqual([{ span: 'run', method: 'error', args: { error } }]);
  });

  it('an adapter refusal (an unbounded loop without iterationBound) rejects and errors the span', async () => {
    const calls: SpanCall[] = [];
    const step = createStep({ id: 's', inputSchema: num, outputSchema: num, execute: async ({ inputData }) => inputData });
    const wf = createWorkflow({
      id: 'loopy',
      inputSchema: num,
      outputSchema: num,
      executionEngine: new PetriExecutionEngine(),
    })
      .dowhile(step, async () => false)
      .commit();
    const run = await wf.createRun();
    await expect(run.start({ inputData: { n: 1 }, ...traced(calls) })).rejects.toThrow();
    expect(runSpanEnds(calls).map((c) => c.method)).toEqual(['error']);
  });
});

describe('PetriExecutionEngine.execute — a failing step, a tripwire, an abort', () => {
  it('a failing step: status failed on both engines, span errored with the result error', async () => {
    const both = await Promise.all(
      (['default', 'petri'] as const).map(async (engine) => {
        const calls: SpanCall[] = [];
        const run = await failing(engine).createRun();
        const r = (await run.start({ inputData: { n: 1 }, ...traced(calls) })) as Record<string, unknown>;
        return { r, ends: runSpanEnds(calls) };
      }),
    );
    const [oracle, ours] = both as [(typeof both)[0], (typeof both)[0]];
    expect(ours.r['status']).toBe('failed');
    expect(ours.r['status']).toBe(oracle.r['status']);
    expect(ours.ends).toHaveLength(1);
    expect(ours.ends[0]!.method).toBe('error');
    expect(ours.ends[0]!.method).toBe(oracle.ends[0]!.method);
    const args = ours.ends[0]!.args as { error: unknown; attributes: unknown };
    expect(args.attributes).toEqual({ status: 'failed' });
    expect(args.error).toBe(ours.r['error']);
    expect((ours.r['error'] as { message?: string }).message).toBe('kaboom');
  });

  it('a tripwire: status tripwire with Mastra\'s tripwire data, span ENDED not errored (no result.error)', async () => {
    const both = await Promise.all(
      (['default', 'petri'] as const).map(async (engine) => {
        const calls: SpanCall[] = [];
        const run = await tripping(engine).createRun();
        const r = (await run.start({ inputData: { n: 1 }, ...traced(calls) })) as Record<string, unknown>;
        return { r, ends: runSpanEnds(calls) };
      }),
    );
    const [oracle, ours] = both as [(typeof both)[0], (typeof both)[0]];
    expect(ours.r['status']).toBe('tripwire');
    expect(ours.r['tripwire']).toEqual({ reason: 'blocked', retry: false, metadata: { rule: 'r1' }, processorId: 'proc-1' });
    expect(ours.r['tripwire']).toEqual(oracle.r['tripwire']);
    expect(ours.ends).toEqual(oracle.ends);
  });

  it('abort mid-run: status canceled on both engines, the second step never runs, span ended canceled', async () => {
    const both = await Promise.all(
      (['default', 'petri'] as const).map(async (engine) => {
        const calls: SpanCall[] = [];
        let signalStarted!: () => void;
        const started = new Promise<void>((resolve) => (signalStarted = resolve));
        const { wf, ran } = abortable(engine, () => signalStarted());
        const run = await wf.createRun();
        const pending = run.start({ inputData: { n: 1 }, ...traced(calls) });
        await started;
        await run.cancel();
        const r = (await pending) as Record<string, unknown>;
        return { r, ran, ends: runSpanEnds(calls) };
      }),
    );
    const [oracle, ours] = both as [(typeof both)[0], (typeof both)[0]];
    expect(ours.r['status']).toBe('canceled');
    expect(ours.r['status']).toBe(oracle.r['status']);
    expect(ours.ran).toEqual(['first']);
    expect(ours.ran).toEqual(oracle.ran);
    // Strict, because the two canceled endings differ only in an `output: undefined` key. An abort
    // that lands while an entry runs turns that entry's result into `canceled` (handlers/entry.ts:
    // 815-817), and the run ends through the generic branch: `end({ output: result.result, ... })`
    // (default.ts:977-982). Only an abort seen at the top of the loop takes the dedicated branch
    // with no output key (default.ts:815-844) — the test below.
    expect(oracle.ends).toStrictEqual([
      { span: RUN_SPAN, method: 'end', args: { output: undefined, attributes: { status: 'canceled' } } },
    ]);
    expect(ours.ends).toStrictEqual(oracle.ends);
  });

  it('cancel before start: canceled on both engines, no step runs, span ended by the dedicated branch (no output key)', async () => {
    const both = await Promise.all(
      (['default', 'petri'] as const).map(async (engine) => {
        const calls: SpanCall[] = [];
        const { wf, ran } = abortable(engine, () => undefined);
        const run = await wf.createRun();
        await run.cancel();
        const r = (await run.start({ inputData: { n: 1 }, ...traced(calls) })) as Record<string, unknown>;
        return { status: r['status'], ran, ends: runSpanEnds(calls) };
      }),
    );
    const [oracle, ours] = both as [(typeof both)[0], (typeof both)[0]];
    expect(oracle.ends).toStrictEqual([{ span: RUN_SPAN, method: 'end', args: { attributes: { status: 'canceled' } } }]);
    expect(ours).toStrictEqual(oracle);
    expect(ours.ran).toEqual([]);
  });
});

describe('PetriExecutionEngine.execute — the runner itself throws', () => {
  it('a StepExecutor that rejects (not a step failure) still ends the run span exactly once', async () => {
    vi.spyOn(StepExecutor.prototype, 'execute').mockRejectedValue(new Error('executor broke'));
    const calls: SpanCall[] = [];
    const run = await linear('petri').createRun();
    const settled = await run.start({ inputData: { n: 1 }, ...traced(calls) }).then(
      (r) => ({ ok: true as const, status: (r as { status: string }).status }),
      (e: unknown) => ({ ok: false as const, message: (e as Error).message }),
    );
    // The kernel reads a runner rejection as the step failing: the run resolves 'failed'.
    expect(settled).toEqual({ ok: true, status: 'failed' });
    expect(runSpanEnds(calls)).toHaveLength(1);
    expect(runSpanEnds(calls)[0]!.method).toBe('error');
  });
});

describe('PetriExecutionEngine.execute — lifecycle callbacks', () => {
  /** A callback argument with the live references and closures replaced by what they say. */
  function plain(info: Record<string, unknown>): Record<string, unknown> {
    const { mastra: _m, logger, requestContext, getInitData, steps, ...rest } = info;
    return {
      ...rest,
      logger: logger !== undefined,
      requestContext: requestContext instanceof RequestContext,
      initData: (getInitData as () => unknown)(),
      stepStatuses: Object.fromEntries(
        Object.entries(steps as Record<string, { status?: string }>).map(([k, v]) => [k, k === 'input' ? v : v.status]),
      ),
    };
  }

  async function capture(engine: Engine, which: 'linear' | 'failing' | 'tripping' | 'abort') {
    const finish: Record<string, unknown>[] = [];
    const error: Record<string, unknown>[] = [];
    const callbacks: Callbacks = {
      onFinish: (r) => void finish.push(plain(r as unknown as Record<string, unknown>)),
      onError: (r) => void error.push(plain(r as unknown as Record<string, unknown>)),
    };
    if (which === 'abort') {
      let go!: () => void;
      const started = new Promise<void>((resolve) => (go = resolve));
      const { wf } = abortable(engine, () => go(), callbacks);
      const run = await wf.createRun({ runId: 'run-1' });
      const pending = run.start({ inputData: { n: 1 } });
      await started;
      await run.cancel();
      await pending;
    } else {
      const wf = which === 'linear' ? linear(engine, callbacks) : which === 'failing' ? failing(engine, callbacks) : tripping(engine, callbacks);
      const run = await wf.createRun({ runId: 'run-1' });
      await run.start({ inputData: { n: 1 } });
    }
    return { finish, error };
  }

  /** `stepExecutionPath` is the result formatter's (result.ts); compared separately below. */
  const withoutPath = (xs: Record<string, unknown>[]) => xs.map(({ stepExecutionPath: _p, ...rest }) => rest);

  it.each(['linear', 'failing', 'tripping', 'abort'] as const)(
    '%s: onFinish/onError fire with the default engine\'s arguments (stepExecutionPath aside)',
    async (which) => {
      const [oracle, ours] = await Promise.all([capture('default', which), capture('petri', which)]);
      expect(ours.finish).toHaveLength(1);
      expect(ours.error).toHaveLength(which === 'failing' || which === 'tripping' ? 1 : 0);
      expect(withoutPath(ours.finish)).toEqual(withoutPath(oracle.finish));
      // `error` is the formatted SerializedError on the default engine; compare it by message.
      const msg = (xs: Record<string, unknown>[]) =>
        xs.map((x) => ({ ...x, error: (x['error'] as { message?: string } | undefined)?.message }));
      expect(withoutPath(msg(ours.error))).toEqual(withoutPath(msg(oracle.error)));
    },
  );

  it('onFinish receives the stepExecutionPath the default engine passes', async () => {
    const [oracle, ours] = await Promise.all([capture('default', 'linear'), capture('petri', 'linear')]);
    expect(oracle.finish[0]!['stepExecutionPath']).toEqual(['a', 'b']);
    expect(ours.finish[0]!['stepExecutionPath']).toEqual(oracle.finish[0]!['stepExecutionPath']);
  });

  it('a paused run fires neither callback and publishes workflow-paused (default.ts:985-1009)', async () => {
    const finish = vi.fn();
    const error = vi.fn();
    const calls: SpanCall[] = [];
    vi.spyOn(StepExecutor.prototype, 'execute').mockResolvedValue({
      status: 'paused',
      payload: { n: 1 },
      startedAt: Date.now(),
    } as never);
    const wf = linear('petri', { onFinish: finish, onError: error });
    const run = await wf.createRun();
    const events: unknown[] = [];
    const unwatch = run.watch((e) => void events.push(e));
    const r = (await run.start({ inputData: { n: 1 }, ...traced(calls) })) as Record<string, unknown>;
    unwatch();
    expect(r['status']).toBe('paused');
    expect(finish).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ type: 'workflow-paused' }));
    // Strict: the default engine passes `output: result.result`, key present (default.ts:977-982).
    expect(runSpanEnds(calls)).toStrictEqual([
      { span: RUN_SPAN, method: 'end', args: { output: undefined, attributes: { status: 'paused' } } },
    ]);
  });

  it('onStart is Run\'s, not execute()\'s: invoked once per start, before execute()', async () => {
    const order: string[] = [];
    const engine = new PetriExecutionEngine({ options: { onStart: () => void order.push('onStart') } });
    const original = engine.execute.bind(engine);
    vi.spyOn(engine, 'execute').mockImplementation((p) => {
      order.push('execute');
      return original(p);
    });
    const step = createStep({ id: 's', inputSchema: num, outputSchema: num, execute: async ({ inputData }) => inputData });
    const wf = createWorkflow({ id: 'started', inputSchema: num, outputSchema: num, executionEngine: engine }).then(step).commit();
    await (await wf.createRun()).start({ inputData: { n: 1 } });
    expect(order).toEqual(['onStart', 'execute']);
  });
});

describe('PetriExecutionEngine.execute — persistence moments', () => {
  const phases = () =>
    vi.mocked(persist.persistRun).mock.calls.map(([engine, ctx]) => ({
      engine: engine instanceof PetriExecutionEngine,
      phase: ctx.phase,
      runId: ctx.runId,
      status: ctx.phase === 'terminal' ? ctx.result.status : undefined,
      hasReport: 'report' in ctx && ctx.report !== undefined,
    }));

  it.each([
    ['linear', 'success'],
    ['failing', 'failed'],
    ['tripping', 'tripwire'],
  ] as const)('%s: persists at start, then once at the terminal with the formatted result', async (which, status) => {
    const wf = which === 'linear' ? linear('petri') : which === 'failing' ? failing('petri') : tripping('petri');
    const run = await wf.createRun({ runId: `persist-${which}` });
    await run.start({ inputData: { n: 1 } });
    expect(phases()).toEqual([
      { engine: true, phase: 'start', runId: `persist-${which}`, status: undefined, hasReport: false },
      { engine: true, phase: 'terminal', runId: `persist-${which}`, status, hasReport: true },
    ]);
  });

  it('a refused run persists nothing', async () => {
    const run = await linear('petri').createRun();
    await expect(run.start({ inputData: { n: 1 }, perStep: true })).rejects.toBeInstanceOf(UnsupportedRunModeError);
    expect(phases()).toEqual([]);
  });

  it('the terminal snapshot carries the state after the run and the serialized step graph', async () => {
    const wf = linear('petri');
    const run = await wf.createRun();
    await run.start({ inputData: { n: 1 } });
    const terminal = vi.mocked(persist.persistRun).mock.calls.at(-1)![1];
    expect(terminal.state).toEqual({ seen: ['a', 'b'] });
    expect(terminal.input).toEqual({ n: 1 });
    expect(terminal.serializedStepGraph).toBe(wf.serializedStepGraph);
  });
});

describe('PetriExecutionEngine — the compile cache', () => {
  it('a cache hit costs far less than a compile (measured, not asserted tightly)', async () => {
    const { compile } = await import('../../src/compiler/compile.js');
    const { adaptExecutionGraph } = await import('../../src/mastra/adapt.js');
    const wf = linear('petri');
    const description = adaptExecutionGraph(wf.buildExecutionGraph() as never);
    const N = 50;
    let t = performance.now();
    for (let i = 0; i < N; i++) compile(description);
    const compileMs = (performance.now() - t) / N;
    t = performance.now();
    for (let i = 0; i < N; i++) JSON.stringify(description);
    const keyMs = (performance.now() - t) / N;
    console.log(`compile ${compileMs.toFixed(3)} ms/call; description key ${keyMs.toFixed(4)} ms/call`);
    expect(keyMs).toBeLessThan(compileMs);
  });
});

// ---------------------------------------------------------------------------------------------
// Oracle tests for what execute() forwards: each kills a mutant the M2 verifier saw survive.
// ---------------------------------------------------------------------------------------------

type Loose = Record<string, unknown>;

describe('PetriExecutionEngine.execute — what reaches the run', () => {
  it('initialState reaches the steps and the result, as on the default engine', async () => {
    const make = (engine: Engine) => {
      const s = createStep({
        id: 's',
        inputSchema: num,
        outputSchema: num,
        stateSchema: z.object({ k: z.number() }),
        execute: async ({ inputData, state, setState }) => {
          await setState({ k: state.k + inputData.n });
          return { n: state.k + inputData.n };
        },
      });
      return build(engine, {}, (cfg) =>
        createWorkflow({ id: 'stateful', inputSchema: num, outputSchema: num, stateSchema: z.object({ k: z.number() }), ...cfg })
          .then(s)
          .commit(),
      );
    };
    const [oracle, ours] = (await Promise.all(
      (['default', 'petri'] as const).map(async (engine) =>
        (await make(engine).createRun()).start({ inputData: { n: 1 }, initialState: { k: 10 }, outputOptions: { includeState: true } }),
      ),
    )) as unknown as [Loose, Loose];
    expect(ours['status']).toBe('success');
    expect(ours['result']).toEqual({ n: 11 });
    expect(ours['state']).toEqual({ k: 11 });
    expect([ours['result'], ours['state']]).toEqual([oracle['result'], oracle['state']]);
  });

  it("the workflow's retryConfig reaches the net: a step failing twice succeeds on its third try", async () => {
    const make = (engine: Engine) => {
      let tries = 0;
      const flaky = createStep({
        id: 'flaky',
        inputSchema: num,
        outputSchema: num,
        execute: async ({ inputData }) => {
          tries += 1;
          if (tries < 3) throw new Error(`try ${tries}`);
          return inputData;
        },
      });
      const wf = build(engine, {}, (cfg) =>
        createWorkflow({ id: 'retrying', inputSchema: num, outputSchema: num, retryConfig: { attempts: 2, delay: 0 }, ...cfg })
          .then(flaky)
          .commit(),
      );
      return { wf, tries: () => tries };
    };
    const both = await Promise.all(
      (['default', 'petri'] as const).map(async (engine) => {
        const { wf, tries } = make(engine);
        const r = (await (await wf.createRun()).start({ inputData: { n: 1 } })) as Loose;
        return { status: r['status'], tries: tries() };
      }),
    );
    expect(both[1]).toEqual({ status: 'success', tries: 3 });
    expect(both[1]).toEqual(both[0]);
  });

  it('one engine instance runs two workflows of different shape, each on its own net', async () => {
    const engine = new PetriExecutionEngine();
    const add = createStep({ id: 'add', inputSchema: num, outputSchema: num, execute: async ({ inputData }) => ({ n: inputData.n + 1 }) });
    const mul = createStep({ id: 'mul', inputSchema: num, outputSchema: num, execute: async ({ inputData }) => ({ n: inputData.n * 10 }) });
    const neg = createStep({ id: 'neg', inputSchema: num, outputSchema: num, execute: async ({ inputData }) => ({ n: -inputData.n }) });
    const two = createWorkflow({ id: 'two', inputSchema: num, outputSchema: num, executionEngine: engine }).then(add).then(mul).commit();
    const one = createWorkflow({ id: 'one', inputSchema: num, outputSchema: num, executionEngine: engine }).then(neg).commit();
    const r1 = (await (await two.createRun()).start({ inputData: { n: 1 } })) as Loose;
    const r2 = (await (await one.createRun()).start({ inputData: { n: 1 } })) as Loose;
    const r3 = (await (await two.createRun()).start({ inputData: { n: 2 } })) as Loose;
    expect([r1['status'], r1['result']]).toEqual(['success', { n: 20 }]);
    expect([r2['status'], r2['result']]).toEqual(['success', { n: -1 }]);
    expect(Object.keys(r2['steps'] as Loose).sort()).toEqual(['input', 'neg']);
    expect([r3['status'], r3['result']]).toEqual(['success', { n: 30 }]);
  });

  it('resourceId reaches step code, both snapshots and onFinish, as on the default engine', async () => {
    const make = (engine: Engine, finish: Loose[]) => {
      const seen: unknown[] = [];
      const s = createStep({
        id: 's',
        inputSchema: num,
        outputSchema: num,
        execute: async (ctx) => {
          seen.push((ctx as unknown as Loose)['resourceId']);
          return ctx.inputData;
        },
      });
      const wf = build(engine, { onFinish: (r) => void finish.push(r as unknown as Loose) }, (cfg) =>
        createWorkflow({ id: 'resourced', inputSchema: num, outputSchema: num, ...cfg }).then(s).commit(),
      );
      return { wf, seen };
    };
    const both = await Promise.all(
      (['default', 'petri'] as const).map(async (engine) => {
        const finish: Loose[] = [];
        const { wf, seen } = make(engine, finish);
        await (await wf.createRun({ resourceId: 'res-1' })).start({ inputData: { n: 1 } });
        return { seen, onFinish: finish.map((f) => f['resourceId']) };
      }),
    );
    expect(both[1]).toEqual({ seen: ['res-1'], onFinish: ['res-1'] });
    expect(both[1]).toEqual(both[0]);
    const persisted = vi.mocked(persist.persistRun).mock.calls
      .filter(([engine]) => engine instanceof PetriExecutionEngine)
      .map(([, ctx]) => [ctx.phase, ctx.resourceId]);
    expect(persisted).toEqual([
      ['start', 'res-1'],
      ['terminal', 'res-1'],
    ]);
  });

  it('orders the ending as the default engine does: terminal persist, then span end, then onFinish', async () => {
    const order: string[] = [];
    vi.mocked(persist.persistRun).mockImplementation(async (engine, ctx) => {
      order.push(`persist:${ctx.phase}`);
      return realPersistRun(engine, ctx);
    });
    const calls: SpanCall[] = [];
    const parent = recordingSpan('parent', calls);
    const wf = linear('petri', { onFinish: () => void order.push('onFinish') });
    const run = await wf.createRun();
    const recorded = calls.length;
    const pending = run.start({ inputData: { n: 1 }, tracingContext: { currentSpan: parent as never } });
    // Span ends land in `calls`; interleave them into `order` as they happen.
    const push = calls.push.bind(calls);
    calls.push = (...xs: SpanCall[]) => {
      for (const x of xs) if (x.span === RUN_SPAN && (x.method === 'end' || x.method === 'error')) order.push(`span:${x.method}`);
      return push(...xs);
    };
    await pending;
    expect(recorded).toBe(0);
    expect(order).toEqual(['persist:start', 'persist:terminal', 'span:end', 'onFinish']);
  });
});

describe('PetriExecutionEngine.execute — a workflow registered with a Mastra', () => {
  /** A step that writes one chunk, registered or not; the chunk types run.stream() yields. */
  async function streamed(engine: Engine, register: boolean) {
    const seenMastra: unknown[] = [];
    const s = createStep({
      id: 'w',
      inputSchema: num,
      outputSchema: num,
      execute: async ({ inputData, writer, mastra }) => {
        seenMastra.push(mastra);
        await writer.write({ hello: inputData.n });
        return inputData;
      },
    });
    const wf = build(engine, {}, (cfg) => createWorkflow({ id: 'writes', inputSchema: num, outputSchema: num, ...cfg }).then(s).commit());
    const m = register ? new Mastra({ workflows: { wf }, logger: false }) : undefined;
    const run = await (m ? m.getWorkflow('wf') : wf).createRun();
    const out = run.stream({ inputData: { n: 7 } });
    const chunks: Loose[] = [];
    for await (const c of out.fullStream as AsyncIterable<Loose>) chunks.push(c);
    return { chunks, seenMastra, m };
  }

  const outputs = (chunks: readonly Loose[]) => chunks.filter((c) => c['type'] === 'workflow-step-output').map((c) => c['payload']);

  it("a step's writer chunk reaches run.stream(), as on the default engine (the run's pubsub, not mastra.pubsub)", async () => {
    const [oracle, ours] = await Promise.all([streamed('default', true), streamed('petri', true)]);
    expect(outputs(oracle.chunks)).toHaveLength(1);
    expect(outputs(ours.chunks)).toHaveLength(1);
    const strip = (p: unknown) => {
      const { runId: _r, ...rest } = p as Loose;
      return rest;
    };
    expect(outputs(ours.chunks).map(strip)).toEqual(outputs(oracle.chunks).map(strip));
  });

  it('registered and unregistered petri runs stream the same writer chunk', async () => {
    const [reg, unreg] = await Promise.all([streamed('petri', true), streamed('petri', false)]);
    expect(outputs(reg.chunks)).toEqual(outputs(unreg.chunks).map((p) => ({ ...(p as Loose), runId: (outputs(reg.chunks)[0] as Loose)['runId'] })));
  });

  it('step code sees the registered Mastra itself, or undefined unregistered, as on the default engine', async () => {
    const [reg, unreg, oracleUnreg] = await Promise.all([streamed('petri', true), streamed('petri', false), streamed('default', false)]);
    expect(reg.seenMastra).toHaveLength(1);
    expect(reg.seenMastra[0]).toBe(reg.m);
    expect(unreg.seenMastra).toEqual([undefined]);
    expect(unreg.seenMastra).toEqual(oracleUnreg.seenMastra);
  });

  it('PINNED DIVERGENCE (open, M5): no workflow-step-start / -result / -finish watch events', async () => {
    const events = async (engine: Engine) => {
      const run = await failing(engine).createRun();
      const seen: string[] = [];
      const unwatch = run.watch((e) => void seen.push((e as { type: string }).type));
      await run.start({ inputData: { n: 1 } });
      unwatch();
      return seen.filter((t) => t.startsWith('workflow-step-'));
    };
    const [oracle, ours] = await Promise.all([events('default'), events('petri')]);
    expect(oracle).toEqual(['workflow-step-start', 'workflow-step-result', 'workflow-step-finish']);
    expect(ours).toEqual([]);
  });
});

describe('PetriExecutionEngine.execute — outcomes no Mastra run has', () => {
  it('a stranded run rejects with StrandedRunError naming the places: span errored once, no callbacks, no terminal write', async () => {
    vi.mocked(kernel.runWorkflowDetailed).mockImplementationOnce(async (...args) => ({
      ...(await realRunWorkflowDetailed(...args)),
      outcome: { status: 'stranded', places: ['p.one', 'p.two'] },
    }));
    const onFinish = vi.fn();
    const onError = vi.fn();
    const calls: SpanCall[] = [];
    const run = await linear('petri', { onFinish, onError }).createRun();
    const error = await run.start({ inputData: { n: 1 }, ...traced(calls) }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(StrandedRunError);
    expect((error as StrandedRunError).places).toEqual(['p.one', 'p.two']);
    expect((error as StrandedRunError).runId).toBe(run.runId);
    expect(runSpanEnds(calls)).toStrictEqual([{ span: RUN_SPAN, method: 'error', args: { error } }]);
    expect(onFinish).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(vi.mocked(persist.persistRun).mock.calls.map(([, ctx]) => ctx.phase)).toEqual(['start']);
  });

  it("a leaked token beside the terminal is logged through the engine's logger; the result stands", async () => {
    const wf = linear('petri');
    const engine = (wf as unknown as { executionEngine: PetriExecutionEngine }).executionEngine;
    const logged = vi.spyOn(engine.getLogger(), 'error').mockImplementation(() => undefined);

    const clean = (await (await wf.createRun()).start({ inputData: { n: 1 } })) as Loose;
    expect(clean['status']).toBe('success');
    expect(logged).not.toHaveBeenCalled();

    vi.mocked(kernel.runWorkflowDetailed).mockImplementationOnce(async (...args) => {
      const report = await realRunWorkflowDetailed(...args);
      return { ...report, outcome: { ...report.outcome, residue: ['leak.place'] } as typeof report.outcome };
    });
    const run = await wf.createRun();
    const r = (await run.start({ inputData: { n: 1 } })) as Loose;
    expect([r['status'], r['result']]).toEqual(['success', { n: 20 }]);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]![0])).toContain('leak.place');
    expect(logged.mock.calls[0]![1]).toEqual({ workflowId: 'linear', runId: run.runId, status: 'success', residue: ['leak.place'] });
  });

  it('passes the kernel no run budget (timeoutMs null): Mastra has no run timeout', async () => {
    await (await linear('petri').createRun()).start({ inputData: { n: 1 } });
    const options = vi.mocked(kernel.runWorkflowDetailed).mock.calls.at(-1)![2];
    expect(options.timeoutMs).toBeNull();
  });
});

describe('PetriExecutionEngine — createWorkflow({ options }) on a hand-constructed engine', () => {
  /** A step whose input fails its schema: validated, the run fails; not validated, it runs. */
  async function unvalidated(which: 'default' | 'hand' | 'init') {
    const s = createStep({ id: 's', inputSchema: num, outputSchema: z.any(), execute: async ({ inputData }) => inputData });
    const params = { id: 'loose', inputSchema: z.any(), outputSchema: z.any(), options: { validateInputs: false } };
    const wf =
      which === 'default'
        ? createWorkflow(params).then(s).commit()
        : which === 'hand'
          ? createWorkflow({ ...params, executionEngine: new PetriExecutionEngine() }).then(s).commit()
          : (await import('../../src/mastra/init.js')).init().createWorkflow(params as never).then(s as never).commit();
    return ((await (await wf.createRun()).start({ inputData: { n: 'not a number' } as never })) as Loose)['status'];
  }

  it('init() matches the default engine for validateInputs: false', async () => {
    expect(await unvalidated('default')).toBe('success');
    expect(await unvalidated('init')).toBe('success');
  });

  it('PINNED DIVERGENCE (Mastra contract for any supplied engine): a hand-constructed engine still validates', async () => {
    // workflow.ts:1819-1827 hands the workflow's options only to a DefaultExecutionEngine it builds.
    expect(await unvalidated('hand')).toBe('failed');
  });
});

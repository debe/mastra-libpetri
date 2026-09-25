import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import type { NetEvent } from 'libpetri';
import { DebugEventStore, DebugProtocolHandler, DebugSessionRegistry, type DebugResponse } from 'libpetri/debug';
import { init } from '../../src/mastra/init.js';
import type { PetriExecutionEngine } from '../../src/mastra/engine.js';
import * as kernel from '../../src/engine/kernel.js';

/**
 * The debug tee ([ADR 0008]): the engine option `debug` registers one libpetri debug session per
 * run segment and appends every net event of that segment to the session's `DebugEventStore`. It
 * is observation only — these tests check the session, and that the run is the same without it.
 */

// The kernel is observed with call-through, and replaced for one call where a test needs a run
// that rejects after the net has run.
vi.mock('../../src/engine/kernel.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/engine/kernel.js')>();
  return { ...actual, runWorkflowDetailed: vi.fn(actual.runWorkflowDetailed) };
});
const realRunWorkflowDetailed = vi.mocked(kernel.runWorkflowDetailed).getMockImplementation()!;

afterEach(() => {
  vi.restoreAllMocks();
});

const num = z.object({ n: z.number() });

type Loose = Record<string, unknown>;

interface AnyRun {
  readonly runId: string;
  start(args: object): Promise<unknown>;
  resume(args: object): Promise<unknown>;
}

interface AnyWorkflow {
  createRun(options?: { runId?: string }): Promise<AnyRun>;
  readonly executionEngine: PetriExecutionEngine;
}

/** `a -> b` on the petri engine, with `debug` set through `init()` as an app sets it. */
function linear(registry: DebugSessionRegistry, id = 'dbg-linear'): AnyWorkflow {
  const { createWorkflow, createStep } = init({ debug: registry });
  const a = createStep({ id: 'a', inputSchema: num, outputSchema: num, execute: async ({ inputData }) => ({ n: inputData.n + 1 }) });
  const b = createStep({ id: 'b', inputSchema: num, outputSchema: num, execute: async ({ inputData }) => ({ n: inputData.n * 10 }) });
  return createWorkflow({ id, inputSchema: num, outputSchema: num }).then(a).then(b).commit() as unknown as AnyWorkflow;
}

/** A step that suspends until resumed with `{ ok: true }`, twice over: it suspends again on `ok: false`. */
function approval(registry: DebugSessionRegistry, storage: InMemoryStore): AnyWorkflow {
  const { createWorkflow, createStep } = init({ debug: registry });
  const ask = createStep({
    id: 'ask',
    inputSchema: num,
    outputSchema: num,
    resumeSchema: z.object({ ok: z.boolean() }),
    suspendSchema: z.object({ question: z.string() }),
    execute: async ({ inputData, resumeData, suspend }) => {
      if (resumeData?.ok !== true) return suspend({ question: 'approve?' });
      return { n: inputData.n + 100 };
    },
  });
  const wf = createWorkflow({ id: 'dbg-approval', inputSchema: num, outputSchema: num }).then(ask).commit();
  const mastra = new Mastra({ storage, workflows: { wf } as never, logger: false });
  return (mastra as unknown as { getWorkflow(key: string): AnyWorkflow }).getWorkflow('wf');
}

const types = (store: DebugEventStore): string[] => store.events().map((e: NetEvent) => e.type);

describe('PetriExecutionEngine — the debug tee (ADR 0008)', () => {
  it('registers one session per run, named by the run id and tagged with the workflow, completed when the run ends', async () => {
    const registry = new DebugSessionRegistry();
    const wf = linear(registry);
    const run = await wf.createRun();
    const result = (await run.start({ inputData: { n: 1 } })) as Loose;
    expect(result['status']).toBe('success');
    expect(result['result']).toEqual({ n: 20 });

    expect(registry.size).toBe(1);
    const session = registry.getSession(run.runId);
    expect(session).toBeDefined();
    expect(session!.active).toBe(false);
    expect(session!.endTime).toBeTypeOf('number');
    expect(registry.tagsFor(run.runId)).toEqual({ workflowId: 'dbg-linear', runId: run.runId, segment: 'start' });
    // The session carries the net the run executed: its DOT diagram and every transition.
    expect(session!.dotDiagram).toContain('digraph');
    expect(session!.transitions.size).toBeGreaterThan(0);
  });

  it("appends the run's net events to the session's store: execution bounds, firings, tokens, the marking snapshot", async () => {
    const registry = new DebugSessionRegistry();
    const run = await linear(registry).createRun();
    await run.start({ inputData: { n: 1 } });
    const store = registry.getSession(run.runId)!.eventStore;

    const seen = types(store);
    expect(seen[0]).toBe('execution-started');
    expect(seen.at(-1)).toBe('execution-completed');
    for (const type of ['marking-snapshot', 'transition-enabled', 'transition-started', 'transition-completed', 'token-added', 'token-removed']) {
      expect([type, seen.includes(type)]).toEqual([type, true]);
    }
    // Every transition that fired is one of the registered net's.
    const names = new Set([...registry.getSession(run.runId)!.transitions].map((t) => t.name));
    const fired = store.events().flatMap((e) => (e.type === 'transition-completed' ? [e.transitionName] : []));
    expect(fired.length).toBeGreaterThan(0);
    for (const name of fired) expect([name, names.has(name)]).toEqual([name, true]);
  });

  it('serves the session over the debug protocol: listed, and subscribing returns the net and its final marking', async () => {
    const registry = new DebugSessionRegistry();
    const run = await linear(registry).createRun();
    await run.start({ inputData: { n: 1 } });

    const handler = new DebugProtocolHandler(registry);
    const sent: DebugResponse[] = [];
    handler.clientConnected('c', (r) => sent.push(r));
    handler.handleCommand('c', { type: 'listSessions', limit: 10 });
    handler.handleCommand('c', { type: 'subscribe', sessionId: run.runId, mode: 'live' });

    const list = sent.find((r) => r.type === 'sessionList');
    expect(list?.type === 'sessionList' && list.sessions.map((s) => [s.sessionId, s.active])).toEqual([[run.runId, false]]);
    const subscribed = sent.find((r) => r.type === 'subscribed');
    expect(subscribed?.type).toBe('subscribed');
    if (subscribed?.type !== 'subscribed') return;
    expect(subscribed.structure.transitions.length).toBeGreaterThan(0);
    expect(subscribed.eventCount).toBe(registry.getSession(run.runId)!.eventStore.eventCount());
    // At rest the run's tokens sit on its terminal: the marking is not empty.
    expect(Object.values(subscribed.currentMarking).some((tokens) => tokens.length > 0)).toBe(true);
    expect(subscribed.inFlightTransitions).toEqual([]);
  });

  it('a live subscriber sees the events while the run is in flight', async () => {
    const registry = new DebugSessionRegistry();
    const handler = new DebugProtocolHandler(registry);
    const sent: DebugResponse[] = [];
    handler.clientConnected('c', (r) => sent.push(r));
    const wf = linear(registry);
    const run = await wf.createRun();
    // Subscribe the moment the session registers: before the first firing.
    const register = registry.register.bind(registry);
    vi.spyOn(registry, 'register').mockImplementation((...args) => {
      const session = register(...args);
      handler.handleCommand('c', { type: 'subscribe', sessionId: session.sessionId, mode: 'live' });
      expect(session.active).toBe(true);
      return session;
    });
    await run.start({ inputData: { n: 1 } });
    // Events are broadcast on a microtask; let them land.
    await new Promise((r) => setTimeout(r, 0));

    const live = sent.filter((r): r is Extract<DebugResponse, { type: 'event' }> => r.type === 'event');
    expect(live.length).toBe(registry.getSession(run.runId)!.eventStore.eventCount());
    expect(live.map((r) => r.index)).toEqual(live.map((_, i) => i));
  });

  it('completes the session when the run rejects', async () => {
    const registry = new DebugSessionRegistry();
    const run = await linear(registry, 'dbg-rejects').createRun();
    vi.mocked(kernel.runWorkflowDetailed).mockImplementationOnce(async (...args) => {
      await realRunWorkflowDetailed(...args);
      throw new Error('boom after the net ran');
    });
    await expect(run.start({ inputData: { n: 1 } })).rejects.toThrow('boom after the net ran');
    const session = registry.getSession(run.runId);
    expect(session?.active).toBe(false);
    expect(types(session!.eventStore)).toContain('execution-completed');
  });

  it('completes the session when a step fails, and records the failure as net events', async () => {
    const registry = new DebugSessionRegistry();
    const { createWorkflow, createStep } = init({ debug: registry });
    const bad = createStep({
      id: 'bad',
      inputSchema: num,
      outputSchema: num,
      execute: async () => {
        throw new Error('step failed');
      },
    });
    const wf = createWorkflow({ id: 'dbg-fails', inputSchema: num, outputSchema: num }).then(bad).commit();
    const run = await wf.createRun();
    const result = (await run.start({ inputData: { n: 1 } })) as Loose;
    expect(result['status']).toBe('failed');
    const session = registry.getSession(run.runId);
    expect(session?.active).toBe(false);
    expect(types(session!.eventStore)).toContain('execution-completed');
  });

  it('a resumed segment is its own session, `<runId>~resume-<n>`, tagged `resume`; the first keeps the start', async () => {
    const registry = new DebugSessionRegistry();
    const storage = new InMemoryStore();
    const wf = approval(registry, storage);
    const run = await wf.createRun({ runId: 'r-approve' });

    expect(((await run.start({ inputData: { n: 1 } })) as Loose)['status']).toBe('suspended');
    expect(((await (await wf.createRun({ runId: 'r-approve' })).resume({ step: 'ask', resumeData: { ok: false } })) as Loose)['status']).toBe('suspended');
    const done = (await (await wf.createRun({ runId: 'r-approve' })).resume({ step: 'ask', resumeData: { ok: true } })) as Loose;
    expect(done['status']).toBe('success');
    expect(done['result']).toEqual({ n: 101 });

    const ids = registry.listSessions(10).map((s) => s.sessionId);
    expect([...ids].sort()).toEqual(['r-approve', 'r-approve~resume-1', 'r-approve~resume-2']);
    expect(registry.tagsFor('r-approve')).toMatchObject({ runId: 'r-approve', segment: 'start' });
    expect(registry.tagsFor('r-approve~resume-1')).toMatchObject({ runId: 'r-approve', segment: 'resume' });
    expect(registry.tagsFor('r-approve~resume-2')).toMatchObject({ runId: 'r-approve', segment: 'resume' });
    for (const id of ids) {
      const session = registry.getSession(id)!;
      expect([id, session.active, types(session.eventStore).at(-1)]).toEqual([id, false, 'execution-completed']);
    }
  });

  it("a debug store that throws leaves the run unaffected and is reported through the engine's logger", async () => {
    class ThrowingStore extends DebugEventStore {
      override append(_event: NetEvent): void {
        throw new Error('debug store is down');
      }
    }
    const registry = new DebugSessionRegistry(50, (id) => new ThrowingStore(id));
    const wf = linear(registry, 'dbg-throwing');
    const logged = vi.spyOn(wf.executionEngine.getLogger(), 'error').mockImplementation(() => undefined);
    const run = await wf.createRun();
    const result = (await run.start({ inputData: { n: 1 } })) as Loose;

    // The same outcome as without the tee.
    const plain = (await (await linear(new DebugSessionRegistry(), 'dbg-plain').createRun()).start({ inputData: { n: 1 } })) as Loose;
    expect(result['status']).toBe('success');
    expect(result['result']).toEqual(plain['result']);
    expect(result['steps']).toMatchObject({ a: { status: 'success', output: { n: 2 } }, b: { status: 'success', output: { n: 20 } } });

    expect(logged).toHaveBeenCalledTimes(1);
    const [message, context] = logged.mock.calls[0]!;
    expect(message).toContain(`run '${run.runId}'`);
    expect(message).toContain('the run is unaffected');
    expect((context as { error: Error }).error.message).toBe('debug store is down');
    expect(registry.getSession(run.runId)?.active).toBe(false);
  });

  it('without `debug`, no session is registered anywhere and nothing is logged', async () => {
    const registry = new DebugSessionRegistry();
    const register = vi.spyOn(registry, 'register');
    const { createWorkflow, createStep } = init();
    const a = createStep({ id: 'a', inputSchema: num, outputSchema: num, execute: async ({ inputData }) => ({ n: inputData.n + 1 }) });
    const wf = createWorkflow({ id: 'dbg-none', inputSchema: num, outputSchema: num }).then(a).commit();
    const logged = vi.spyOn((wf as unknown as AnyWorkflow).executionEngine.getLogger(), 'error');
    const result = (await (await wf.createRun()).start({ inputData: { n: 1 } })) as Loose;
    expect(result['status']).toBe('success');
    expect(register).not.toHaveBeenCalled();
    expect(logged).not.toHaveBeenCalled();
    const call = vi.mocked(kernel.runWorkflowDetailed).mock.calls.at(-1)!;
    expect(call[2].eventStore).toBeUndefined();
  });
});

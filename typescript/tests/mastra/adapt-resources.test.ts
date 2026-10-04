import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { createStep as mastraCreateStep, createWorkflow as mastraCreateWorkflow } from '@mastra/core/workflows';
import type { AgentStepOptions } from '@mastra/core/workflows';
import { createTool } from '@mastra/core/tools';
import { Agent } from '@mastra/core/agent';
import { MAX_CONCURRENCY, MAX_WAIT_MS } from '../../src/compiler/index.js';
import type { QuotaRef, StepDescription } from '../../src/compiler/types.js';
import { adaptExecutionGraph, adaptStepFlow, init, Quota, UnsupportedWorkflowError } from '../../src/mastra/index.js';
import type { ExecutionGraph, StepFlowEntry } from '../../src/mastra/index.js';
import { attachResources } from '../../src/mastra/resources.js';

/**
 * Reading a step's Layer 3 resources ([ADR 0012], [ADR 0013], M7 W1): `uses` and `timeout` from the
 * petri `createStep`, attached under `STEP_RESOURCES`, read into `StepDescription.quotas` /
 * `timeoutMs` from every builder and position; the refusals by name; and that a step without them
 * describes exactly as before.
 */

const { createWorkflow, createStep, cloneStep, limit, rateLimit } = init({ iterationBound: 3 });

const num = z.object({ n: z.number() });
const body = { inputSchema: num, outputSchema: num, execute: async ({ inputData }: { inputData: { n: number } }) => ({ n: inputData.n + 1 }) };

type Graph = { buildExecutionGraph(): unknown };
const adaptWf = (wf: Graph) => adaptExecutionGraph(wf.buildExecutionGraph() as ExecutionGraph, { iterationBound: 3 });
const refusal = (fn: () => unknown): UnsupportedWorkflowError => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(UnsupportedWorkflowError);
    return error as UnsupportedWorkflowError;
  }
  throw new Error('expected a refusal');
};

const tool = createTool({
  id: 'double',
  description: 'doubles n',
  inputSchema: num,
  outputSchema: num,
  execute: async (input) => ({ n: input.n * 2 }),
});
const agent = new Agent({ id: 'stubby', name: 'stubby', instructions: 'be brief', model: {} as never });

const db = limit(2, { id: 'db' });
const api = rateLimit(3, 1000, { id: 'api' });
const DB: QuotaRef = { id: 'db', kind: 'limit', n: 2 };
const API: QuotaRef = { id: 'api', kind: 'rate', burst: 3, perMs: 1000 };

describe('reading the resources', () => {
  it('from a params step, in declaration order', () => {
    const a = createStep({ id: 'a', ...body, uses: [api, db], timeout: 250 });
    const d = adaptWf(createWorkflow({ id: 'w', inputSchema: num, outputSchema: num }).then(a).commit());
    expect(d.entries[0]).toEqual({ kind: 'step', id: 'a', source: 'step', timeoutMs: 250, quotas: [API, DB] });
  });

  it('a timeout alone, and quotas alone', () => {
    const t = createStep({ id: 't', ...body, timeout: 1 });
    const q = createStep({ id: 'q', ...body, uses: [db] });
    const d = adaptWf(createWorkflow({ id: 'w', inputSchema: num, outputSchema: num }).then(t).then(q).commit());
    expect(d.entries).toEqual([
      { kind: 'step', id: 't', source: 'step', timeoutMs: 1 },
      { kind: 'step', id: 'q', source: 'step', quotas: [DB] },
    ]);
  });

  it('from an agent step: the declarative entry\'s options, which Mastra kept as __agentOptions', () => {
    const s = createStep(agent, { uses: [api], timeout: 5000, retries: 1 });
    const wf = createWorkflow({ id: 'w', inputSchema: z.object({ prompt: z.string() }), outputSchema: z.any() }).then(s).commit();
    const graph = wf.buildExecutionGraph() as ExecutionGraph;
    expect(graph.steps![0]!.type).toBe('agent');
    expect(adaptExecutionGraph(graph).entries[0]).toEqual({ kind: 'step', id: 'stubby', source: 'agent', retries: 1, timeoutMs: 5000, quotas: [API] });
  });

  it('from a tool step: the declarative entry\'s options, which Mastra kept as __toolOptions', () => {
    const s = createStep(tool, { uses: [db], timeout: 10 });
    const wf = createWorkflow({ id: 'w', inputSchema: num, outputSchema: num }).then(s).commit();
    const graph = wf.buildExecutionGraph() as ExecutionGraph;
    expect(graph.steps![0]!.type).toBe('tool');
    expect(adaptExecutionGraph(graph).entries[0]).toEqual({ kind: 'step', id: 'double', source: 'tool', timeoutMs: 10, quotas: [DB] });
  });

  it('from every arm and body position', () => {
    const r = (id: string) => createStep({ id, ...body, uses: [db], timeout: 7 });
    const wf = createWorkflow({ id: 'w', inputSchema: num, outputSchema: z.any() })
      .parallel([r('p1'), r('p2')])
      .map(async () => ({ n: 1 }))
      .branch([[async () => true, r('b1')]])
      .map(async () => ({ n: 1 }))
      .dowhile(r('lw'), async () => false)
      .dountil(r('lu'), async () => true)
      .map(async () => [{ n: 1 }])
      .foreach(createStep({ id: 'fe', ...body, uses: [db], timeout: 7 }))
      .commit();
    const d = adaptWf(wf);
    const steps: StepDescription[] = d.entries.flatMap((e) =>
      e.kind === 'parallel' || e.kind === 'branch' ? [...e.arms] : e.kind === 'loop' || e.kind === 'foreach' ? [e.body] : [],
    );
    expect(steps.map((s) => s.id)).toEqual(['p1', 'p2', 'b1', 'lw', 'lu', 'fe']);
    for (const s of steps) expect(s).toMatchObject({ timeoutMs: 7, quotas: [DB] });
  });

  it('through the petri cloneStep', () => {
    const original = createStep({ id: 'o', ...body, uses: [db], timeout: 9 });
    const clone = cloneStep(original, { id: 'c' });
    const d = adaptWf(createWorkflow({ id: 'w', inputSchema: num, outputSchema: num }).then(original).then(clone).commit());
    expect(d.entries[1]).toEqual({ kind: 'step', id: 'c', source: 'step', timeoutMs: 9, quotas: [DB] });
  });

  it('a nested workflow step takes them as the step as a whole', () => {
    const child = createWorkflow({ id: 'child', inputSchema: num, outputSchema: num }).then(createStep({ id: 'c', ...body })).commit();
    attachResources(child, { quotas: [db], timeoutMs: 100 });
    const d = adaptWf(createWorkflow({ id: 'w', inputSchema: num, outputSchema: num }).then(createStep(child)).commit());
    expect(d.entries[0]).toEqual({ kind: 'step', id: 'child', source: 'workflow', timeoutMs: 100, quotas: [DB] });
  });
});

describe('a step without resources describes exactly as before', () => {
  it('adds no key — petri or Mastra factories, empty uses, every source', () => {
    const steps = [
      createStep({ id: 'a', ...body }),
      createStep({ id: 'b', ...body, uses: [] }),
      mastraCreateStep({ id: 'c', ...body }),
      createStep(tool),
    ];
    const wf = createWorkflow({ id: 'w', inputSchema: num, outputSchema: num });
    for (const s of steps) wf.then(s as never);
    const d = adaptWf(wf.map(async () => ({ n: 1 })).commit());
    for (const e of d.entries) {
      expect('timeoutMs' in e).toBe(false);
      expect('quotas' in e).toBe(false);
    }
    expect(JSON.stringify(d.entries[0])).toBe(JSON.stringify({ kind: 'step', id: 'a', source: 'step' }));
  });
});

describe('quota-id-collision', () => {
  it('one object on many steps is one quota', () => {
    const wf = createWorkflow({ id: 'w', inputSchema: num, outputSchema: z.any() })
      .then(createStep({ id: 'a', ...body, uses: [db] }))
      .parallel([createStep({ id: 'b', ...body, uses: [db] }), createStep({ id: 'c', ...body, uses: [db] })])
      .commit();
    expect(() => adaptWf(wf)).not.toThrow();
  });

  it('two objects with one id are refused, naming both steps, wherever the second is', () => {
    const other = limit(5, { id: 'db' });
    const wf = createWorkflow({ id: 'w', inputSchema: num, outputSchema: z.any() })
      .then(createStep({ id: 'a', ...body, uses: [db] }))
      .parallel([createStep({ id: 'b', ...body }), createStep({ id: 'c', ...body, uses: [other] })])
      .commit();
    const e = refusal(() => adaptWf(wf));
    expect(e.entryType).toBe('step');
    expect(e.entryId).toBe('c');
    expect(e.reason).toMatch(/^quota-id-collision: it uses a quota with id 'db', and step 'a' uses a different quota object/);
    // Same parameters do not make two objects one quota: identity is the object.
    const twin = limit(2, { id: 'db' });
    const same = createWorkflow({ id: 'w', inputSchema: num, outputSchema: num })
      .then(createStep({ id: 'a', ...body, uses: [db] }))
      .then(createStep({ id: 'b', ...body, uses: [twin] }))
      .commit();
    expect(refusal(() => adaptWf(same)).reason).toMatch(/^quota-id-collision: /);
    // A limit and a rate with one id collide too.
    const kinds = createWorkflow({ id: 'w', inputSchema: num, outputSchema: num })
      .then(createStep({ id: 'a', ...body, uses: [db] }))
      .then(createStep({ id: 'b', ...body, uses: [rateLimit(1, 1, { id: 'db' })] }))
      .commit();
    expect(refusal(() => adaptWf(kinds)).reason).toMatch(/^quota-id-collision: /);
  });

  it('a nested workflow is its own run: a parent and a child never collide', () => {
    const child = createWorkflow({ id: 'child', inputSchema: num, outputSchema: num })
      .then(createStep({ id: 'c', ...body, uses: [limit(9, { id: 'db' })] }))
      .commit();
    const parent = createWorkflow({ id: 'p', inputSchema: num, outputSchema: num })
      .then(createStep({ id: 'a', ...body, uses: [db] }))
      .then(createStep(child))
      .commit();
    expect(adaptWf(parent).entries[1]).toEqual({ kind: 'step', id: 'child', source: 'workflow' });
    expect(adaptWf(child).entries[0]).toMatchObject({ quotas: [{ id: 'db', kind: 'limit', n: 9 }] });
  });
});

describe('quota-value and timeout-value: what slipped past the factories', () => {
  const carrying = (resources: Parameters<typeof attachResources>[1]) => {
    const s = createStep({ id: 'x', ...body });
    attachResources(s, resources);
    return createWorkflow({ id: 'w', inputSchema: num, outputSchema: num }).then(s).commit();
  };
  const forged = (ref: unknown): Quota => Object.assign(Object.create(Quota.prototype) as Quota, { ref }) as Quota;

  it.each([0, -5, 1.5, Number.NaN, MAX_WAIT_MS + 1, '100'])('refuses a timeout of %s', (timeoutMs) => {
    const e = refusal(() => adaptWf(carrying({ timeoutMs: timeoutMs as number })));
    expect(e.entryId).toBe('x');
    expect(e.reason).toMatch(/^timeout-value: its timeout is /);
    expect(e.reason).toMatch(new RegExp(`from 1 to ${MAX_WAIT_MS}`));
  });

  it('accepts the ends of the timeout range', () => {
    for (const timeoutMs of [1, MAX_WAIT_MS]) expect(adaptWf(carrying({ timeoutMs })).entries[0]).toMatchObject({ timeoutMs });
  });

  it('refuses the factory\'s own bad values, through the factory first', () => {
    expect(() => limit(0, { id: 'a' })).toThrow(/quota-value/);
    expect(() => rateLimit(1, MAX_WAIT_MS + 1, { id: 'a' })).toThrow(/quota-value/);
  });

  const bad: [string, unknown, RegExp][] = [
    ['not a Quota', { id: 'q', kind: 'limit', n: 1 }, /is not a quota made by init\(\)\.limit or init\(\)\.rateLimit/],
    ['a bad id', forged({ id: 'a.b', kind: 'limit', n: 1 }), /id is 'a\.b'; it must match/],
    ['a limit of 0', forged({ id: 'q', kind: 'limit', n: 0 }), /limit 'q' allows the number 0/],
    ['a limit above MAX_CONCURRENCY', forged({ id: 'q', kind: 'limit', n: MAX_CONCURRENCY + 1 }), /limit 'q' allows/],
    ['a burst of 1.5', forged({ id: 'q', kind: 'rate', burst: 1.5, perMs: 1 }), /burst of the number 1\.5/],
    ['a period of 0', forged({ id: 'q', kind: 'rate', burst: 1, perMs: 0 }), /refills every the number 0 ms/],
    ['an unknown kind', forged({ id: 'q', kind: 'mutex' }), /neither 'limit' nor 'rate'/],
  ];

  it.each(bad)('refuses %s', (_, quota, named) => {
    const e = refusal(() => adaptWf(carrying({ quotas: [quota as Quota] })));
    expect(e.entryId).toBe('x');
    expect(e.reason).toMatch(/^quota-value: /);
    expect(e.reason).toMatch(named);
  });

  it('refuses one quota listed twice by one step', () => {
    const e = refusal(() => adaptWf(createWorkflow({ id: 'w', inputSchema: num, outputSchema: num }).then(createStep({ id: 'x', ...body, uses: [db, db] })).commit()));
    expect(e.reason).toMatch(/^quota-value: its uses lists quota 'db' twice/);
  });
});

describe('uses-position: resources that never passed through the petri createStep', () => {
  // Mastra's types refuse both keys in a literal, but not in an options object held in a variable.
  const asked = { retries: 0, uses: [db], timeout: 50 };

  it('on a declarative .agent(agent, options)', () => {
    const wf = mastraCreateWorkflow({ id: 'w', inputSchema: z.object({ prompt: z.string() }), outputSchema: z.any() }).agent(agent, asked).commit();
    const e = refusal(() => adaptWf(wf));
    expect(e.entryType).toBe('agent');
    expect(e.entryId).toBe('stubby');
    expect(e.reason).toMatch(/^uses-position: this agent's options carries `uses` and `timeout`/);
    expect(e.reason).toMatch(/init\(\)\.createStep\(agent, \{ uses, timeout \}\)/);
  });

  it('on a declarative .tool(tool, options), and .tool(id, options)', () => {
    const t = { timeout: 50 };
    const builds = [
      () => mastraCreateWorkflow({ id: 'w', inputSchema: num, outputSchema: num }).tool(tool, t as never),
      () => mastraCreateWorkflow({ id: 'w', inputSchema: num, outputSchema: num }).tool('double', t as never),
    ];
    for (const build of builds) {
      const e = refusal(() => adaptWf(build().commit()));
      expect(e.entryType).toBe('tool');
      expect(e.reason).toMatch(/^uses-position: this tool's options carries `timeout`,/);
      expect(e.reason).toMatch(/init\(\)\.createStep\(tool, \{ uses, timeout \}\)/);
    }
  });

  it('on a step from Mastra\'s own createStep(tool, options)', () => {
    const s = mastraCreateStep(tool, { uses: [db] } as never);
    const e = refusal(() => adaptWf(mastraCreateWorkflow({ id: 'w', inputSchema: num, outputSchema: num }).then(s).commit()));
    expect(e.entryType).toBe('tool');
    expect(e.reason).toMatch(/^uses-position: this tool's options carries `uses`,/);
  });

  it('on a hand-built step object', () => {
    const entries = [{ type: 'step', step: { id: 'h', timeout: 5 } }] as unknown as StepFlowEntry[];
    expect(refusal(() => adaptStepFlow(entries, { workflowId: 'w' })).reason).toMatch(/^uses-position: this step carries `timeout`/);
  });

  it('an empty uses asks for nothing, as at the factory', () => {
    const wf = mastraCreateWorkflow({ id: 'w', inputSchema: num, outputSchema: num }).tool(tool, { uses: [] } as never).commit();
    expect(adaptWf(wf).entries[0]).toEqual({ kind: 'step', id: 'double', source: 'tool' });
  });

  it('a params step from Mastra\'s own createStep loses the keys: not detectable, and described without them', () => {
    const s = mastraCreateStep({ id: 'm', ...body, uses: [db], timeout: 5 } as never);
    expect(adaptWf(mastraCreateWorkflow({ id: 'w', inputSchema: num, outputSchema: num }).then(s).commit()).entries[0]).toEqual({
      kind: 'step',
      id: 'm',
      source: 'step',
    });
  });

  it('neither key is one of Mastra\'s own agent options, so their presence is never Mastra\'s', () => {
    expectTypeOf<'uses' extends keyof AgentStepOptions<unknown> ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<'timeout' extends keyof AgentStepOptions<unknown> ? true : false>().toEqualTypeOf<false>();
  });
});

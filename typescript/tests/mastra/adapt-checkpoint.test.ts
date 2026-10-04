import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { cloneStep, createStep, createWorkflow } from '@mastra/core/workflows';
import { InMemoryStore } from '@mastra/core/storage';
import { Mastra } from '@mastra/core/mastra';
import { adaptExecutionGraph, adaptStepFlow, UnsupportedWorkflowError } from '../../src/mastra/index.js';
import type { ExecutionGraph, StepFlowEntry } from '../../src/mastra/index.js';

/**
 * Reading `metadata.checkpoint` ([ADR 0010], M4b W1): where Mastra's builders put it, which values
 * mark, where a mark is refused, and that a marked workflow is still an ordinary Mastra workflow.
 */

const num = z.object({ n: z.number() });
const nums = z.array(num);
const mk = (id: string, metadata?: Record<string, unknown>) =>
  createStep({ id, inputSchema: num, outputSchema: num, ...(metadata ? { metadata } : {}), execute: async ({ inputData }) => ({ n: inputData.n + 1 }) });
const CP = { checkpoint: true } as const;

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

describe('reading the mark', () => {
  it('reads a .then() step\'s own createStep({ metadata })', () => {
    const wf = createWorkflow({ id: 'w', inputSchema: num, outputSchema: num }).then(mk('a', CP)).then(mk('b')).commit();
    expect(adaptWf(wf).checkpoints).toEqual([0]);
  });

  it('reads the entry options of every control-flow builder', () => {
    const wf = createWorkflow({ id: 'w', inputSchema: num, outputSchema: z.any() })
      .then(mk('a'))
      .parallel([mk('p1'), mk('p2')], { metadata: CP })
      .map(async () => ({ n: 1 }), { metadata: CP })
      .branch([[async () => true, mk('b1')]], { metadata: CP })
      .map(async () => ({ n: 1 }))
      .sleep(1, { metadata: CP })
      .sleepUntil(new Date(0), { metadata: CP })
      .dountil(mk('body'), async () => true, { metadata: CP })
      .map(async () => [{ n: 1 }])
      .foreach(mk('item'), { concurrency: 1, metadata: CP })
      .then(createStep({ id: 'z', inputSchema: nums, outputSchema: nums, execute: async ({ inputData }) => inputData }))
      .commit();
    const d = adaptWf(wf);
    expect(d.entries.map((e) => e.kind)).toEqual(['step', 'parallel', 'step', 'branch', 'step', 'sleep', 'sleepUntil', 'loop', 'step', 'foreach', 'step']);
    expect(d.checkpoints).toEqual([1, 2, 3, 5, 6, 7, 9]);
  });

  it('reads an .agent()/.tool() entry\'s options.metadata', () => {
    const entries: StepFlowEntry[] = [
      { type: 'agent', id: 'ag', agentId: 'ag', options: { metadata: CP } as never },
      { type: 'tool', id: 'tl', toolId: 'tl', options: { metadata: CP } as never },
      { type: 'step', step: { id: 'end' } },
    ];
    expect(adaptStepFlow(entries, { workflowId: 'w' }).checkpoints).toEqual([0, 1]);
  });

  it('omits the key when nothing is marked, so the description serialises as before', () => {
    const wf = createWorkflow({ id: 'w', inputSchema: num, outputSchema: num }).then(mk('a', { other: 1 })).then(mk('b')).commit();
    const d = adaptWf(wf);
    expect('checkpoints' in d).toBe(false);
    expect(JSON.stringify(d)).toBe(JSON.stringify({ id: 'w', entries: d.entries }));
  });

  it('accepts a mark on the last entry and omits it: the terminal row covers it', () => {
    const wf = createWorkflow({ id: 'w', inputSchema: num, outputSchema: num }).then(mk('a', CP)).then(mk('b', CP)).commit();
    expect(adaptWf(wf).checkpoints).toEqual([0]);
    const lastOnly = createWorkflow({ id: 'w2', inputSchema: num, outputSchema: num }).then(mk('a')).then(mk('b', CP)).commit();
    expect('checkpoints' in adaptWf(lastOnly)).toBe(false);
  });

  it('treats `false` as no mark and refuses any other value by name', () => {
    const off = createWorkflow({ id: 'w', inputSchema: num, outputSchema: num }).then(mk('a', { checkpoint: false })).then(mk('b')).commit();
    expect('checkpoints' in adaptWf(off)).toBe(false);
    for (const [value, named] of [['true', /the string 'true'/], [1, /the number 1/], [{}, /type object/], [null, /null/]] as const) {
      const wf = createWorkflow({ id: 'w', inputSchema: num, outputSchema: num }).then(mk('a', { checkpoint: value })).then(mk('b')).commit();
      const e = refusal(() => adaptWf(wf));
      expect(e.entryId).toBe('a');
      expect(e.reason).toMatch(/^checkpoint-value: /);
      expect(e.reason).toMatch(named);
    }
  });
});

describe('refusing a mark that is not on a top-level boundary', () => {
  const cases: [string, () => Graph, string, RegExp][] = [
    ['a .parallel() arm', () => createWorkflow({ id: 'w', inputSchema: num, outputSchema: z.any() }).parallel([mk('x', CP), mk('y')]).commit(), 'parallel', /as a \.parallel\(\) arm.*\.parallel\(\) call/],
    ['a .branch() arm', () => createWorkflow({ id: 'w', inputSchema: num, outputSchema: z.any() }).branch([[async () => true, mk('x', CP)]]).commit(), 'conditional', /as a \.branch\(\) arm.*\.branch\(\) call/],
    ['a .dowhile() body', () => createWorkflow({ id: 'w', inputSchema: num, outputSchema: num }).dowhile(mk('x', CP), async () => false).commit(), 'loop', /body of a \.dowhile\(\).*\.dowhile\(\) call/],
    ['a .dountil() body', () => createWorkflow({ id: 'w', inputSchema: num, outputSchema: num }).dountil(mk('x', CP), async () => true).commit(), 'loop', /body of a \.dountil\(\)/],
    ['a .foreach() body', () => createWorkflow({ id: 'w', inputSchema: nums, outputSchema: z.any() }).foreach(mk('x', CP)).commit(), 'foreach', /body of a \.foreach\(\).*\.foreach\(\) call/],
  ];

  it.each(cases)('on %s, naming the enclosing entry\'s options and cloneStep', (_, build, type, where) => {
    const e = refusal(() => adaptWf(build()));
    expect(e.entryType).toBe(type);
    expect(e.reason).toMatch(/^checkpoint-position: step 'x' /);
    expect(e.reason).toMatch(where);
    expect(e.reason).toMatch(/metadata: \{ checkpoint: true \}/);
    expect(e.reason).toMatch(/cloneStep\(\)/);
  });

  it('a Step object shared with an arm is refused; cloneStep gives the arm an unmarked copy', () => {
    const shared = mk('s', CP);
    const bad = createWorkflow({ id: 'w', inputSchema: num, outputSchema: z.any() }).then(shared).parallel([shared, mk('y')]).commit();
    expect(refusal(() => adaptWf(bad)).reason).toMatch(/checkpoint-position/);
    const clone = cloneStep(mk('s'), { id: 's2' });
    const good = createWorkflow({ id: 'w', inputSchema: num, outputSchema: z.any() }).then(shared).parallel([clone, mk('y')]).commit();
    expect(adaptWf(good).checkpoints).toEqual([0]);
  });
});

describe('the Layer test: a marked workflow on the default engine', () => {
  it('runs exactly as its unmarked twin, the mark merely redundant', async () => {
    const build = (id: string, mark: boolean) =>
      createWorkflow({ id, inputSchema: num, outputSchema: z.any() })
        .then(mk('a', mark ? CP : undefined))
        .parallel([mk('p1'), mk('p2')], mark ? { metadata: CP } : {})
        .map(async ({ inputData }) => ({ n: (inputData as { p1: { n: number } }).p1.n }), mark ? { metadata: CP } : {})
        .then(mk('z'))
        .commit();
    const marked = build('marked', true);
    const plain = build('plain', false);
    // Mastra's default engine: no executionEngine given.
    const mastra = new Mastra({ storage: new InMemoryStore(), workflows: { marked, plain }, logger: false });
    const results = await Promise.all(
      (['marked', 'plain'] as const).map(async (id) => (await mastra.getWorkflow(id).createRun()).start({ inputData: { n: 1 } })),
    );
    const [m, p] = results.map((r) => ({ status: r.status, result: r.status === 'success' ? r.result : undefined }));
    expect(m).toEqual({ status: 'success', result: { n: 4 } });
    expect(m).toEqual(p);
    // And the adapter reads the marks off the very same workflow.
    expect(adaptWf(marked).checkpoints).toEqual([0, 1, 2]);
  });
});

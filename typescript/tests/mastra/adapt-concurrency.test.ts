import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { cloneStep, createStep, createWorkflow } from '@mastra/core/workflows';
import { InMemoryStore } from '@mastra/core/storage';
import { Mastra } from '@mastra/core/mastra';
import { adaptExecutionGraph, adaptStepFlow, LAYER2_METADATA_KEYS, UnsupportedWorkflowError } from '../../src/mastra/index.js';
import type { ExecutionGraph, StepFlowEntry } from '../../src/mastra/index.js';

/**
 * Reading `metadata.concurrency` ([ADR 0011], M7 W1): from a `.parallel()` / `.branch()` call's own
 * options, passed through as written; the values and positions refused by name; that an annotated
 * block is an ordinary Mastra block on the default engine; and why the key lives in `metadata`.
 */

const num = z.object({ n: z.number() });
const nums = z.array(num);
const mk = (id: string, metadata?: Record<string, unknown>) =>
  createStep({ id, inputSchema: num, outputSchema: num, ...(metadata ? { metadata } : {}), execute: async ({ inputData }) => ({ n: inputData.n + 1 }) });

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
const wfAny = (id = 'w') => createWorkflow({ id, inputSchema: num, outputSchema: z.any() });

describe('reading the bound', () => {
  it('is a Layer 2 key', () => {
    expect(LAYER2_METADATA_KEYS).toContain('concurrency');
  });

  it('reads a .parallel() call\'s own metadata', () => {
    const d = adaptWf(wfAny().parallel([mk('a'), mk('b'), mk('c')], { metadata: { concurrency: 2 } }).commit());
    expect(d.entries[0]).toMatchObject({ kind: 'parallel', concurrency: 2 });
  });

  it('reads a .branch() call\'s own metadata', () => {
    const d = adaptWf(
      wfAny()
        .branch(
          [
            [async () => true, mk('a')],
            [async () => true, mk('b')],
          ],
          { metadata: { concurrency: 1 } },
        )
        .commit(),
    );
    expect(d.entries[0]).toMatchObject({ kind: 'branch', concurrency: 1 });
  });

  it('passes the bound through as written, even at or above the number of arms', () => {
    for (const c of [2, 5, Number.MAX_SAFE_INTEGER]) {
      const d = adaptWf(wfAny().parallel([mk('a'), mk('b')], { metadata: { concurrency: c } }).commit());
      expect(d.entries[0]).toMatchObject({ kind: 'parallel', concurrency: c });
    }
  });

  it('sits beside other metadata, and with a checkpoint mark', () => {
    const d = adaptWf(
      wfAny().parallel([mk('a'), mk('b')], { metadata: { concurrency: 1, checkpoint: true, owner: 'x' } }).map(async () => ({ n: 1 })).then(mk('z')).commit(),
    );
    expect(d.entries[0]).toMatchObject({ kind: 'parallel', concurrency: 1 });
    expect(d.checkpoints).toEqual([0]);
  });

  it('adds no key to an unannotated block, so the description serialises as before', () => {
    const plain = adaptWf(wfAny().parallel([mk('a'), mk('b')], { metadata: { owner: 'x' } }).map(async () => ({ n: 1 })).branch([[async () => true, mk('c')]]).commit());
    for (const e of plain.entries) expect('concurrency' in e).toBe(false);
    // An explicit `undefined` is no bound, as for `checkpoint`.
    const undef = adaptWf(wfAny().parallel([mk('a'), mk('b')], { metadata: { concurrency: undefined } }).commit());
    expect('concurrency' in undef.entries[0]!).toBe(false);
    expect(JSON.stringify(undef)).toBe(JSON.stringify(adaptWf(wfAny().parallel([mk('a'), mk('b')]).commit())));
  });

  it('reads the bound from a hand-built entry too, under its own id', () => {
    const entries = [
      { type: 'parallel', id: 'fan', metadata: { concurrency: 3 }, steps: [{ type: 'step', step: { id: 'a' } }] },
    ] as unknown as StepFlowEntry[];
    expect(adaptStepFlow(entries, { workflowId: 'w' }).entries[0]).toEqual({
      kind: 'parallel',
      id: 'fan',
      arms: [{ kind: 'step', id: 'a', source: 'step' }],
      concurrency: 3,
    });
  });
});

describe('concurrency-value', () => {
  const bad: [unknown, RegExp][] = [
    [0, /the number 0/],
    [-1, /the number -1/],
    [1.5, /the number 1\.5/],
    [Number.NaN, /the number NaN/],
    [Number.POSITIVE_INFINITY, /the number Infinity/],
    [2 ** 53, /the number 9007199254740992/],
    ['2', /the string '2'/],
    [null, /null/],
    [{ n: 2 }, /type object/],
  ];

  it.each(bad)('refuses %s on a .parallel()', (value, named) => {
    const e = refusal(() => adaptWf(wfAny().parallel([mk('a'), mk('b')], { id: 'fan', metadata: { concurrency: value } }).commit()));
    expect(e.entryType).toBe('parallel');
    expect(e.entryId).toBe('fan');
    expect(e.reason).toMatch(/^concurrency-value: metadata\.concurrency is /);
    expect(e.reason).toMatch(named);
    expect(e.reason).toMatch(/whole number of at least 1/);
  });

  it('refuses a function, on a .branch() too: the bound is fixed at compile time', () => {
    const e = refusal(() => adaptWf(wfAny().branch([[async () => true, mk('a')]], { metadata: { concurrency: () => 2 } }).commit()));
    expect(e.entryType).toBe('conditional');
    expect(e.reason).toMatch(/^concurrency-value: metadata\.concurrency is a function/);
    expect(e.reason).toMatch(/fixed when the workflow is compiled/);
  });
});

describe('concurrency-position', () => {
  const C = { concurrency: 2 } as const;
  const common = (e: UnsupportedWorkflowError) => {
    expect(e.reason).toMatch(/^concurrency-position: /);
    expect(e.reason).toMatch(/\.parallel\(\) or \.branch\(\) call's own options/);
    expect(e.reason).toMatch(/run-wide `concurrency`/);
    expect(e.reason).toMatch(/cloneStep\(\)/);
  };

  const topLevel: [string, () => Graph, string, string, RegExp][] = [
    ['a .then() step', () => wfAny().then(mk('a', C)).commit(), 'step', 'a', /on a \.then\(\) step/],
    ['a .map()', () => wfAny().map(async () => ({ n: 1 }), { id: 'm', metadata: C }).commit(), 'mapping', 'm', /on a \.map\(\)/],
    ['a .sleep()', () => wfAny().sleep(1, { id: 's', metadata: C }).commit(), 'sleep', 's', /on a \.sleep\(\)/],
    ['a .sleepUntil()', () => wfAny().sleepUntil(new Date(0), { id: 'su', metadata: C }).commit(), 'sleepUntil', 'su', /on a \.sleepUntil\(\)/],
    ['a .dowhile()', () => wfAny().dowhile(mk('b'), async () => false, { metadata: C }).commit(), 'loop', 'b', /on a \.dowhile\(\)/],
    ['a .dountil()', () => wfAny().dountil(mk('b'), async () => true, { metadata: C }).commit(), 'loop', 'b', /on a \.dountil\(\)/],
    [
      'a nested workflow step',
      () => {
        const child = createWorkflow({ id: 'child', inputSchema: num, outputSchema: num, metadata: C }).then(mk('c')).commit();
        return wfAny().then(child).commit();
      },
      'step',
      'child',
      /on a nested workflow step/,
    ],
  ];

  it.each(topLevel)('on %s', (_, build, type, id, where) => {
    const e = refusal(() => adaptWf(build()));
    expect(e.entryType).toBe(type);
    expect(e.entryId).toBe(id);
    expect(e.reason).toMatch(where);
    expect(e.reason).toMatch(/no arms to bound/);
    common(e);
  });

  it('on an agent or a tool entry\'s options.metadata', () => {
    for (const type of ['agent', 'tool'] as const) {
      const entry = type === 'agent'
        ? { type, id: 'x', agentId: 'x', options: { metadata: C } }
        : { type, id: 'x', toolId: 'x', options: { metadata: C } };
      const e = refusal(() => adaptStepFlow([entry as StepFlowEntry], { workflowId: 'w' }));
      expect(e.entryType).toBe(type);
      expect(e.reason).toMatch(type === 'agent' ? /on an agent step/ : /on a tool step/);
      common(e);
    }
  });

  const inner: [string, () => Graph, string, RegExp, RegExp][] = [
    ['a .parallel() arm', () => wfAny().parallel([mk('x', C), mk('y')]).commit(), 'parallel', /as a \.parallel\(\) arm/, /`\{ metadata: \{ concurrency: c \} \}` on the \.parallel\(\) call/],
    ['a .branch() arm', () => wfAny().branch([[async () => true, mk('x', C)]]).commit(), 'conditional', /as a \.branch\(\) arm/, /on the \.branch\(\) call/],
    ['a .dowhile() body', () => wfAny().dowhile(mk('x', C), async () => false).commit(), 'loop', /body of a \.dowhile\(\)/, /one iteration at a time/],
    ['a .dountil() body', () => wfAny().dountil(mk('x', C), async () => true).commit(), 'loop', /body of a \.dountil\(\)/, /one iteration at a time/],
    [
      'a .foreach() body',
      () => createWorkflow({ id: 'w', inputSchema: nums, outputSchema: z.any() }).foreach(mk('x', C)).commit(),
      'foreach',
      /body of a \.foreach\(\)/,
      /`\.foreach\(step, \{ concurrency: c \}\)`/,
    ],
  ];

  it.each(inner)('on %s\'s own step metadata, naming the enclosing block\'s options', (_, build, type, role, where) => {
    const e = refusal(() => adaptWf(build()));
    expect(e.entryType).toBe(type);
    expect(e.reason).toMatch(/^concurrency-position: step 'x' carries metadata\.concurrency /);
    expect(e.reason).toMatch(role);
    expect(e.reason).toMatch(where);
    common(e);
  });

  it('a value that would be refused is refused for its position first', () => {
    const e = refusal(() => adaptWf(wfAny().then(mk('a', { concurrency: 'lots' })).commit()));
    expect(e.reason).toMatch(/^concurrency-position: /);
  });

  it('cloneStep gives a shared Step object an unannotated copy', () => {
    const annotated = mk('s', C);
    expect(refusal(() => adaptWf(wfAny().parallel([annotated, mk('y')]).commit())).reason).toMatch(/concurrency-position/);
    const clean = cloneStep(mk('s'), { id: 's2' });
    expect(() => adaptWf(wfAny().parallel([clean, mk('y')]).commit())).not.toThrow();
  });
});

describe('concurrency-foreach', () => {
  it('refuses the key in a .foreach() entry\'s metadata, pointing at its own option', () => {
    const wf = createWorkflow({ id: 'w', inputSchema: nums, outputSchema: z.any() })
      .foreach(mk('item'), { id: 'each', metadata: { concurrency: 2 } })
      .commit();
    const e = refusal(() => adaptWf(wf));
    expect(e.entryType).toBe('foreach');
    expect(e.entryId).toBe('each');
    expect(e.reason).toMatch(/^concurrency-foreach: /);
    expect(e.reason).toMatch(/`\.foreach\(step, \{ concurrency: c \}\)`, which Mastra enforces/);
  });

  it('the option itself is still read, unchanged', () => {
    const wf = createWorkflow({ id: 'w', inputSchema: nums, outputSchema: z.any() }).foreach(mk('item'), { concurrency: 2 }).commit();
    expect(adaptWf(wf).entries[0]).toMatchObject({ kind: 'foreach', concurrency: 2 });
  });
});

describe('the Layer test: an annotated block on the default engine', () => {
  it('runs exactly as its unannotated twin — every arm at once, the bound merely unenforced', async () => {
    let inFlight = 0;
    const peaks: Record<string, number> = {};
    const slow = (id: string, run: string) =>
      createStep({
        id,
        inputSchema: num,
        outputSchema: num,
        execute: async ({ inputData }) => {
          inFlight += 1;
          peaks[run] = Math.max(peaks[run] ?? 0, inFlight);
          await new Promise((r) => setTimeout(r, 10));
          inFlight -= 1;
          return { n: inputData.n + id.length };
        },
      });
    const build = (id: string, annotated: boolean) =>
      createWorkflow({ id, inputSchema: num, outputSchema: z.any() })
        .parallel([slow('a', id), slow('bb', id), slow('ccc', id)], annotated ? { metadata: { concurrency: 1 } } : {})
        .map(async ({ inputData }) => ({ n: (inputData as { ccc: { n: number } }).ccc.n }), { id: 'join' })
        .branch(
          [
            [async () => true, slow('d', id)],
            [async () => true, slow('ee', id)],
          ],
          annotated ? { metadata: { concurrency: 1 } } : {},
        )
        .commit();
    const annotated = build('annotated', true);
    const plain = build('plain', false);
    // Mastra's default engine: no executionEngine given.
    const mastra = new Mastra({ storage: new InMemoryStore(), workflows: { annotated, plain }, logger: false });
    const runs = [];
    for (const id of ['annotated', 'plain'] as const) {
      const r = await (await mastra.getWorkflow(id).createRun()).start({ inputData: { n: 1 } });
      runs.push({ status: r.status, result: r.status === 'success' ? r.result : undefined, steps: Object.keys(r.steps).sort() });
    }
    const [a, p] = runs;
    expect(a!.status).toBe('success');
    expect(a).toEqual(p);
    expect(a!.result).toEqual({ d: { n: 5 }, ee: { n: 6 } });
    expect(peaks).toEqual({ annotated: 3, plain: 3 });
    // And the adapter reads the bound off the very same workflow.
    expect(adaptWf(annotated).entries.map((e) => (e as { concurrency?: number }).concurrency)).toEqual([1, undefined, 1]);
  });
});

describe('why the key lives in metadata: Mastra\'s own types', () => {
  it('a block\'s options take no concurrency; metadata does, and Mastra drops the stray key', () => {
    // @ts-expect-error — StepFlowEntryOptions is { id, description, metadata } (types.d.ts:505-509).
    const stray = wfAny().parallel([mk('a'), mk('b')], { concurrency: 2 }).commit();
    // @ts-expect-error — the same options type on .branch().
    const strayBranch = wfAny().branch([[async () => true, mk('a')]], { concurrency: 2 }).commit();
    const ok = wfAny().parallel([mk('a'), mk('b')], { metadata: { concurrency: 2 } }).map(async () => ({ n: 1 })).branch([[async () => true, mk('c')]], { metadata: { concurrency: 1 } });
    void ok;
    // `toEntryOptionFields` keeps only id, description and metadata (workflow.ts:647-653).
    expect('concurrency' in adaptWf(stray).entries[0]!).toBe(false);
    expect('concurrency' in adaptWf(strayBranch).entries[0]!).toBe(false);
  });
});

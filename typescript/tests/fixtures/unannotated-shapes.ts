import { createHash } from 'node:crypto';
import { z } from 'zod';
import { compile, type CompiledWorkflow, type EntryDescription, type StepDescription, type WorkflowDescription } from '../../src/compiler/index.js';
import { adaptExecutionGraph, init, type ExecutionGraph } from '../../src/mastra/index.js';

/**
 * Workflows with no `pipeline()` on them, each compiled, with its `structuralHash` and a digest of its
 * net (every place name, and every transition's name, arcs, timing and priority — never its action).
 * `tests/compiler/pipeline-contract.test.ts` pins both, computed **before** the ADR 0015 W0 contract
 * landed, so a contract or W1 change that moves an unannotated net or its hash fails there.
 */
export interface Shape {
  readonly label: string;
  readonly compiled: CompiledWorkflow;
}

/** The net, by name and arcs: sorted places, sorted transitions without their actions. */
export function netDigest(compiled: CompiledWorkflow): string {
  const strip = (value: unknown): unknown =>
    JSON.parse(
      JSON.stringify(value, (_key, v: unknown) => {
        if (typeof v === 'function') return undefined;
        if (v instanceof Map) return [...v.keys()].sort();
        return v;
      }),
    );
  const places = [...compiled.net.places].map((p) => p.name).sort();
  const transitions = [...compiled.net.transitions]
    .map((t) => ({
      name: t.name,
      inputs: strip(t.inputSpecs),
      outputs: strip(t.outputSpec),
      inhibitors: strip(t.inhibitors),
      reads: strip(t.reads),
      resets: strip(t.resets),
      timing: strip(t.timing),
      priority: t.priority,
      alias: strip(t.placeAlias),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return createHash('sha256').update(JSON.stringify({ places, transitions })).digest('hex').slice(0, 16);
}

const step = (id: string, extra: Partial<StepDescription> = {}): StepDescription => ({ kind: 'step', id, ...extra });
const wf = (id: string, ...entries: EntryDescription[]): WorkflowDescription => ({ id, entries });

/** Hand-built descriptions: every entry kind, foreach bodies with retries, a timeout and quotas. */
function described(): Shape[] {
  const gpu = { id: 'gpu', kind: 'limit', n: 1 } as const;
  const rate = { id: 'rate', kind: 'rate', burst: 2, perMs: 50 } as const;
  const plainForeach = wf('fe', step('a'), { kind: 'foreach', id: 'each', body: step('b'), concurrency: 3 }, step('c'));
  const resourcedForeach = wf(
    'fe-res',
    { kind: 'foreach', id: 'each', body: step('fetch', { retries: 2, retryDelayMs: 5, timeoutMs: 100, quotas: [gpu, rate] }), concurrency: 2 },
    step('embed', { quotas: [gpu] }),
  );
  const nestedForeach = wf('fe-nested', { kind: 'foreach', id: 'per-doc', body: step('per-doc', { source: 'workflow' }), concurrency: 4 });
  const mixed: WorkflowDescription = {
    ...wf(
      'mixed',
      step('a'),
      { kind: 'parallel', id: 'p', arms: [step('p1'), step('p2'), step('p3')], concurrency: 2 },
      { kind: 'parallel', id: 'r', arms: [step('r1'), step('r2')], decision: { k: 1 } },
      { kind: 'branch', id: 'b', arms: [step('b1'), step('b2')] },
      { kind: 'loop', id: 'l', body: step('lb'), loopType: 'dowhile', iterationBound: 3 },
      { kind: 'foreach', id: 'f', body: step('fb', { retries: 1 }), concurrency: 1 },
      { kind: 'sleep', id: 's', duration: { fixed: 10 } },
      step('z'),
    ),
    checkpoints: [0, 5],
  };
  return [
    { label: 'foreach, three lanes', compiled: compile(plainForeach) },
    { label: 'foreach, three lanes, run budget 2', compiled: compile(plainForeach, { concurrency: 2 }) },
    { label: 'foreach, retries, timeout, limit and rateLimit', compiled: compile(resourcedForeach) },
    { label: 'foreach over a nested workflow', compiled: compile(nestedForeach) },
    { label: 'every entry kind, checkpointed', compiled: compile(mixed) },
  ];
}

/** Through `init()` and the adapter: a `.foreach(step)` and a `.foreach(nestedWorkflow)`. */
function adapted(): Shape[] {
  const { createWorkflow, createStep, limit } = init();
  const gpu = limit(1, { id: 'gpu' });
  const Url = z.object({ url: z.string() });
  const Ref = z.object({ ref: z.string() });
  const fetchDoc = createStep({ id: 'fetch', inputSchema: Url, outputSchema: Url, execute: async ({ inputData }) => inputData });
  const store = createStep({ id: 'store', inputSchema: Url, outputSchema: Ref, uses: [gpu], execute: async ({ inputData }) => ({ ref: inputData.url }) });
  const body = createWorkflow({ id: 'per-doc', inputSchema: Url, outputSchema: Ref }).then(fetchDoc).then(store).commit();
  const outer = createWorkflow({ id: 'ingest', inputSchema: z.array(Url), outputSchema: z.array(Ref) })
    .foreach(fetchDoc, { concurrency: 2 })
    .foreach(createStep(body), { concurrency: 3 })
    .commit();
  const graph = (outer as unknown as { buildExecutionGraph(): unknown }).buildExecutionGraph() as ExecutionGraph;
  return [{ label: 'init(): .foreach(step) then .foreach(nestedWorkflow)', compiled: compile(adaptExecutionGraph(graph)) }];
}

export function unannotatedShapes(): Shape[] {
  return [...described(), ...adapted()];
}

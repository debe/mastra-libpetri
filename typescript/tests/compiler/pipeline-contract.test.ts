import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createStep as mastraCreateStep } from '@mastra/core/workflows';
import {
  compile,
  foreachGadget,
  UnresumablePositionError,
  type EntryDescription,
  type Gadget,
  type StepDescription,
  type WorkflowDescription,
} from '../../src/compiler/index.js';
import { KernelRunScope } from '../../src/engine/index.js';
import { BLUEPRINT_REFUSALS, init, type PetriStep, type PipelineStage } from '../../src/mastra/index.js';
import { FOREACH_PIPELINE, pipelineOf } from '../../src/mastra/pipeline.js';
import { pipelineLaneAttempts, pipelineStructureViolations } from '../../src/verify/index.js';
import { RecordingRunner } from '../fixtures/runner.js';
import { netDigest, unannotatedShapes } from '../fixtures/unannotated-shapes.js';

/**
 * The `pipeline()` contract ([ADR 0015], M7b W0): the types and stubs W1 builds against. What it pins:
 * an unannotated workflow compiles to the very net, and the very hash, it did before the contract
 * landed; a description carrying a `pipeline` hashes apart from one without it (and by its bounds);
 * the verify side never reaches a pipeline rule without a pipeline (the W0 stubs, built in W1, are
 * checked to be reached); the two new refusal names; and the surface's types — `Chained<S>` and the brand — as
 * `@ts-expect-error` under `npm run check`.
 */

/**
 * Computed before the contract landed (libpetri 8.0.0 from npm, not linked): `structuralHash` and
 * `netDigest` of each `unannotatedShapes()` entry, in order.
 */
const BEFORE: readonly (readonly [label: string, hash: string, digest: string])[] = [
  ['foreach, three lanes', '4d2fb6c330243db7', 'de496606abe2d07e'],
  ['foreach, three lanes, run budget 2', '9aea7db62b475e38', '1263cec672b28466'],
  ['foreach, retries, timeout, limit and rateLimit', '3900f1b2c4ed4e9b', '70d9e57d2e571438'],
  ['foreach over a nested workflow', 'e688d65db3833ee8', '7345e8f39ebf7c92'],
  ['every entry kind, checkpointed', '999c0e8f3c54713c', '5412d7a17bc75a3c'],
  ['init(): .foreach(step) then .foreach(nestedWorkflow)', 'b860cdef99196dc1', '8d45355fa24e6af6'],
];

const step = (id: string, extra: Partial<StepDescription> = {}): StepDescription => ({ kind: 'step', id, ...extra });
const piped = (bounds: readonly number[], stages = bounds.map((_, j) => step(`s${j}`))): WorkflowDescription => ({
  id: 'ingest',
  entries: [
    {
      kind: 'foreach',
      id: 'per-doc',
      body: step('per-doc', { source: 'workflow' }),
      concurrency: bounds.reduce((a, b) => a + b, 0),
      pipeline: { stages, bounds },
    },
    step('report'),
  ],
});
const unpiped = (description: WorkflowDescription): WorkflowDescription => ({
  ...description,
  entries: description.entries.map((entry): EntryDescription => {
    if (entry.kind !== 'foreach') return entry;
    const { pipeline: _pipeline, ...plain } = entry;
    return plain;
  }),
});
/** The foreach as today's, the pipeline ignored: the net without W1's gadget, the hash from the description. */
const ignoringPipeline: Gadget = (entry, next, ctx) => {
  if (entry.kind !== 'foreach') throw new Error('not a foreach');
  const { pipeline: _pipeline, ...plain } = entry;
  return foreachGadget(plain, next, ctx);
};

describe('an unannotated workflow is untouched', () => {
  it('compiles to the net and the hash it had before the contract', () => {
    // Breaks if: structuralHash folds in an absent pipeline, the leaf or foreach emits differently
    // for `item: undefined`, or quotaRefsOf reorders the quota pools.
    const now = unannotatedShapes().map((s) => [s.label, s.compiled.structuralHash, netDigest(s.compiled)] as const);
    expect(now).toEqual(BEFORE);
  });

  it('has no pipelines, and the verify stubs answer for it without throwing', () => {
    for (const { compiled } of unannotatedShapes()) {
      expect(compiled.pipelines).toEqual([]);
      expect(pipelineStructureViolations(compiled)).toEqual([]);
      expect(pipelineLaneAttempts(compiled).size).toBe(0);
    }
  });
});

describe('structuralHash carries the pipeline only when present', () => {
  it('a pipeline hashes apart from the bare foreach, and by its bounds and stages', () => {
    // Compiled with the foreach gadget ignoring the pipeline, so the net is the same and only the
    // description differs. Breaks if: the foreach case drops `pipeline`, or hashes only its presence.
    const opts = { gadgets: { foreach: ignoringPipeline } };
    const a = compile(piped([2, 1]), opts);
    const bare = compile(unpiped(piped([2, 1])), opts);
    expect(netDigest(a)).toBe(netDigest(bare));
    expect(a.structuralHash).not.toBe(bare.structuralHash);
    expect(compile(piped([1, 2]), opts).structuralHash).not.toBe(a.structuralHash);
    expect(compile(piped([2, 1], [step('s0'), step('s1', { retries: 1 })]), opts).structuralHash).not.toBe(a.structuralHash);
    expect(compile(piped([2, 1]), opts).structuralHash).toBe(a.structuralHash);
  });
});

describe('the W0 stubs are built (W1)', () => {
  it('compiling a pipeline reaches pipelineGadget and records its site', () => {
    // Breaks if: foreachGadget stops delegating, and a pipeline silently compiles as a plain foreach.
    const compiled = compile(piped([1, 1]));
    expect(compiled.pipelines.map((p) => [p.path, p.foreachId, p.bounds])).toEqual([[[0], 'per-doc', [1, 1]]]);
  });

  it('RunScope.itemRecords hands out an unopened store', () => {
    const scope = new KernelRunScope({ runner: new RecordingRunner(), initData: [] });
    const records = scope.itemRecords([0], 0);
    expect(records.initData).toBeUndefined();
    expect(scope.itemRecords([0], 0)).toBe(records);
  });

  it('the verify side answers for a compiled pipeline', () => {
    const compiled = compile(piped([1, 1]));
    expect(pipelineStructureViolations(compiled)).toEqual([]);
    expect(pipelineLaneAttempts(compiled).size).toBeGreaterThan(0);
  });

  it('init() binds pipeline without calling it; calling it mints the entry', () => {
    const { pipeline, createStep } = init();
    expect(typeof pipeline).toBe('function');
    const s = createStep({ id: 's', inputSchema: z.number(), outputSchema: z.number(), execute: async ({ inputData }) => inputData });
    const [body, options] = pipeline([s], { id: 'p' });
    expect(body.id).toBe('p');
    expect(options.concurrency).toBe(1);
    expect((pipelineOf(options.metadata) as { bounds: readonly number[] }).bounds).toEqual([1]);
  });
});

describe('the surface names', () => {
  it('BLUEPRINT_REFUSALS gains pipeline-empty and pipeline-value, and keeps the decision five', () => {
    expect([...BLUEPRINT_REFUSALS].sort()).toEqual(
      ['blueprint-arms', 'blueprint-position', 'blueprint-reused', 'pipeline-empty', 'pipeline-value', 'quorum-value', 'race-empty'],
    );
  });

  it("UnresumablePositionError has the reason 'pipeline'", () => {
    expect(new UnresumablePositionError('pipeline', [0], 'x').reason).toBe('pipeline');
  });

  it('pipelineOf reads only the symbol key', () => {
    // Breaks if: pipelineOf reads a string key, or an inherited one.
    expect(pipelineOf(undefined)).toBeUndefined();
    expect(pipelineOf({ concurrency: 2, checkpoint: true })).toBeUndefined();
    expect(pipelineOf(Object.create({ [FOREACH_PIPELINE]: 1 }))).toBeUndefined();
    expect(pipelineOf({ [FOREACH_PIPELINE]: 'forged' })).toBe('forged');
    expect(JSON.stringify({ concurrency: 3, [FOREACH_PIPELINE]: 'x' })).toBe('{"concurrency":3}');
  });
});

/**
 * The types, checked by `npm run check` (never run: the factory is a stub). Pinned before W1 C: the
 * spread infers into `.foreach()` and the next step sees the last stage's output array; `Chained<S>`
 * rejects a broken chain on the offending stage; a default-engine stage, a bound vector of the wrong
 * length, an empty tuple and a non-tuple array are type errors.
 */
export function surfaceTypes(): void {
  const { createWorkflow, createStep, pipeline } = init();
  const Url = z.object({ url: z.string() });
  const Html = z.object({ html: z.string() });
  const Vec = z.object({ v: z.array(z.number()) });
  const Ref = z.object({ ref: z.string() });
  const fetchDoc = createStep({ id: 'fetch', inputSchema: Url, outputSchema: Html, execute: async () => ({ html: '' }) });
  const embed = createStep({ id: 'embed', inputSchema: Html, outputSchema: Vec, execute: async () => ({ v: [] }) });
  const store = createStep({ id: 'store', inputSchema: Vec, outputSchema: Ref, execute: async () => ({ ref: '' }) });
  const plain = mastraCreateStep({ id: 'plain', inputSchema: Html, outputSchema: Vec, execute: async () => ({ v: [] }) });
  const report = createStep({ id: 'report', inputSchema: z.array(Ref), outputSchema: z.number(), execute: async ({ inputData }) => inputData.length });
  const ingest = () => createWorkflow({ id: 'ingest', inputSchema: z.array(Url), outputSchema: z.number() });

  ingest()
    .foreach(...pipeline([fetchDoc, embed, store], { id: 'per-doc', concurrency: [2, 1, 1] }))
    .then(report)
    .commit();
  const [body, options] = pipeline([fetchDoc, embed, store], { id: 'per-doc', concurrency: 2 });
  const typed: PetriStep<'per-doc', any, { url: string }, { ref: string }, any, any> = body;
  const window: number = options.concurrency;
  void typed;
  void window;
  const held = [fetchDoc, embed] as const;
  pipeline(held, { id: 'held', concurrency: [1, 2] });

  // @ts-expect-error — embed's output (Vec) is not fetch's input (Url)
  pipeline([fetchDoc, embed, fetchDoc], { id: 'broken' });
  // @ts-expect-error — order swapped: embed's output (Vec) is not fetch's input (Url)
  pipeline([embed, fetchDoc], { id: 'swapped' });
  // @ts-expect-error — Mastra's own createStep brands DefaultEngineType: not a petri stage
  pipeline([fetchDoc, plain], { id: 'default-stage' });
  // @ts-expect-error — two bounds for three stages
  pipeline([fetchDoc, embed, store], { id: 'length', concurrency: [1, 1] });
  // @ts-expect-error — at least one stage
  pipeline([], { id: 'empty' });
  // @ts-expect-error — the id is required: it is the body's
  pipeline([fetchDoc], {});
  const loose: PipelineStage[] = [fetchDoc];
  // @ts-expect-error — not a tuple: the stage count must be known
  pipeline(loose, { id: 'array' });
  // @ts-expect-error — the body takes Html; the items are Url
  ingest().foreach(...pipeline([embed, store], { id: 'wrong-element' }));
}

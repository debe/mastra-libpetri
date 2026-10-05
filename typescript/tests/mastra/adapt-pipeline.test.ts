/**
 * Reading a `pipeline()` off a `.foreach()` entry ([ADR 0015], M7b W1 C): the description's
 * `pipeline` — every stage adapted with the **parent's** options, the bounds — matching each body
 * entry to its minted stage by kind (a step by identity, an agent or tool by id, ref and options
 * identity), every refusal of the ADR's table by name against a forged or altered entry, the
 * positions `innerSteps` now sees (a pipeline stage), and the `pipeline` resume refusal at seed time.
 *
 * Each case notes the adapter mutation that breaks it.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent } from '@mastra/core/agent';
import { createStep as mastraCreateStep } from '@mastra/core/workflows';
import { createTool } from '@mastra/core/tools';
import { compile, MAX_FOREACH_LANES, type CompiledWorkflow, type PipelineSite } from '../../src/compiler/index.js';
import { pipelineRefusal, resumeSeed, UnresumablePositionError } from '../../src/compiler/resume.js';
import { adaptExecutionGraph, adaptStepFlow, init, UnsupportedWorkflowError } from '../../src/mastra/index.js';
import type { ExecutionGraph, StepFlowEntry } from '../../src/mastra/index.js';
import { foreachPipeline, matchMinted, refuseMisplacedBlueprints } from '../../src/mastra/adapt.js';
import { FOREACH_PIPELINE, Pipeline, pipelineOf } from '../../src/mastra/pipeline.js';
import { BLOCK_DECISION } from '../../src/mastra/resources.js';

const { createWorkflow, createStep, pipeline, race, limit } = init({ iterationBound: 3 });

const num = z.object({ n: z.number() });
const prompt = z.object({ prompt: z.string() });
const mk = (id: string, extra: Record<string, unknown> = {}) =>
  createStep({ id, inputSchema: num, outputSchema: num, ...extra, execute: async ({ inputData }) => ({ n: inputData.n + 1 }) });
const wf = (id = 'w') => createWorkflow({ id, inputSchema: z.array(num), outputSchema: z.any() });
const back = async () => [{ n: 1 }];

type Graph = { buildExecutionGraph(): unknown };
const graphOf = (w: Graph) => w.buildExecutionGraph() as ExecutionGraph;
const adaptWf = (w: Graph, retryConfig?: { attempts?: number; delay?: number }) =>
  adaptExecutionGraph(graphOf(w), { iterationBound: 3, ...(retryConfig ? { retryConfig } : {}) });
const refusal = (fn: () => unknown): UnsupportedWorkflowError => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(UnsupportedWorkflowError);
    return error as UnsupportedWorkflowError;
  }
  throw new Error('expected a refusal');
};

/** A `Pipeline` the factory did not check: past its constructor guard, as a forgery would be. */
function forge(fields: { body: object; stages: readonly unknown[]; bounds: readonly unknown[] }): Pipeline {
  return Object.create(Pipeline.prototype, {
    body: { value: fields.body },
    stages: { value: fields.stages },
    bounds: { value: fields.bounds },
  }) as Pipeline;
}
/** Foreach options carrying `p`, with `concurrency` Σ of its (numeric) bounds unless given. */
function carrying(p: unknown, concurrency?: unknown) {
  const bounds = (p as { bounds?: unknown[] }).bounds ?? [];
  const sum = bounds.reduce<number>((a, c) => a + (typeof c === 'number' ? c : 0), 0);
  return { concurrency: concurrency ?? sum, metadata: { [FOREACH_PIPELINE]: p } } as never;
}

const agent = new Agent({ id: 'writer', name: 'writer', instructions: 'be brief', model: {} as never });
const tool = createTool({ id: 'double', description: 'doubles n', inputSchema: num, outputSchema: num, execute: async (input) => ({ n: input.n * 2 }) });

describe('reading the pipeline', () => {
  it('the foreach gains { stages, bounds }; the body stays the nested workflow; concurrency is Σc_j', () => {
    // Breaks if: the foreach case drops `pipeline`, adapts the stages in another order, or derives
    // concurrency from anything but the entry's opts.
    const d = adaptWf(wf().foreach(...pipeline([mk('a'), mk('b'), mk('c')], { id: 'per', concurrency: [2, 1, 1] })).commit());
    const entry = d.entries[0]!;
    expect(entry).toMatchObject({
      kind: 'foreach',
      id: 'per',
      body: { kind: 'step', id: 'per', source: 'workflow' },
      concurrency: 4,
      pipeline: { bounds: [2, 1, 1] },
    });
    if (entry.kind !== 'foreach') throw new Error('not a foreach');
    expect(entry.pipeline!.stages.map((s) => [s.id, s.source])).toEqual([
      ['a', 'step'],
      ['b', 'step'],
      ['c', 'step'],
    ]);
  });

  it('a plain .foreach() has no pipeline key at all', () => {
    // Breaks if: the foreach case writes `pipeline: undefined`.
    const d = adaptWf(wf().foreach(mk('x'), { concurrency: 2 }).commit());
    expect('pipeline' in d.entries[0]!).toBe(false);
    expect(foreachPipeline(graphOf(wf().foreach(mk('x')).commit()).steps![0]!, 'x')).toBeUndefined();
  });

  it("each stage with the parent's options: retries ?? retryConfig.attempts, delay, timeout and uses", () => {
    // Breaks if: stages are adapted with the body's (child's) options — retries 0 — or skip
    // stepResources.
    const gpu = limit(1, { id: 'gpu' });
    const stages = [mk('fetch'), mk('embed', { uses: [gpu], timeout: 500 }), mk('store', { retries: 0 })] as const;
    const d = adaptWf(wf().foreach(...pipeline(stages, { id: 'per' })).then(mk('after', { uses: [gpu] }) as never).commit(), {
      attempts: 2,
      delay: 5,
    });
    const entry = d.entries[0]!;
    if (entry.kind !== 'foreach') throw new Error('not a foreach');
    expect(entry.pipeline!.stages).toEqual([
      { kind: 'step', id: 'fetch', source: 'step', retries: 2, retryDelayMs: 5 },
      { kind: 'step', id: 'embed', source: 'step', retries: 2, retryDelayMs: 5, timeoutMs: 500, quotas: [{ id: 'gpu', kind: 'limit', n: 1 }] },
      { kind: 'step', id: 'store', source: 'step' },
    ]);
  });

  it('a quota shared by a stage and a parent step is one quota; another object with its id collides', () => {
    // Breaks if: stages are adapted with a fresh AdaptContext (their quotas then never meet the parent's).
    const gpu = limit(1, { id: 'gpu' });
    const lookalike = limit(1, { id: 'gpu' });
    const w = wf().foreach(...pipeline([mk('a', { uses: [lookalike] })], { id: 'per' })).then(mk('after', { uses: [gpu] }) as never).commit();
    expect(refusal(() => adaptWf(w)).reason).toMatch(/^quota-id-collision/);
  });

  it('a pipeline description compiles to the hash its own bounds give', () => {
    // Breaks if: the adapter's description is not what the compiler hashes (bounds or stages lost).
    const one = adaptWf(wf().foreach(...pipeline([mk('a'), mk('b')], { id: 'per', concurrency: [2, 1] })).commit());
    const two = adaptWf(wf().foreach(...pipeline([mk('a'), mk('b')], { id: 'per', concurrency: [1, 2] })).commit());
    expect(JSON.stringify(one)).not.toBe(JSON.stringify(two));
  });
});

describe('agent and tool stages match by ref and options identity', () => {
  it('an agent stage with and without options, a tool stage, beside a plain step', () => {
    // Breaks if: an agent or tool stage is compared as `entry.step === minted` (it has no `step`).
    const a1 = createStep(agent);
    const a2 = createStep(new Agent({ id: 'other', name: 'other', instructions: 'x', model: {} as never }), { retries: 1 });
    const t = createStep(tool);
    const plain = createStep({ id: 'plain', inputSchema: z.object({ text: z.string() }), outputSchema: num, execute: async () => ({ n: 1 }) });
    const [body, options] = pipeline([a1 as never, a2 as never, plain as never, t as never], { id: 'per' });
    const w = createWorkflow({ id: 'w', inputSchema: z.array(prompt), outputSchema: z.any() }).foreach(body as never, options).commit();
    const graph = (body as unknown as { stepGraph: { type: string }[] }).stepGraph;
    expect(graph.map((e) => e.type)).toEqual(['agent', 'agent', 'step', 'tool']);
    const d = adaptWf(w);
    const entry = d.entries[0]!;
    if (entry.kind !== 'foreach') throw new Error('not a foreach');
    expect(entry.pipeline!.stages.map((s) => [s.id, s.source, s.retries])).toEqual([
      ['writer', 'agent', undefined],
      ['other', 'agent', 1],
      ['plain', 'step', undefined],
      ['double', 'tool', undefined],
    ]);
  });

  it('negative: an equal but distinct options object in the body is refused (blueprint-arms)', () => {
    // Breaks if: options are compared by value rather than identity.
    const options = { retries: 1 };
    const [body, opts] = pipeline([createStep(agent, options) as never], { id: 'per' });
    const graph = (body as unknown as { stepGraph: { options: unknown }[] }).stepGraph;
    graph[0]!.options = { ...options };
    const w = createWorkflow({ id: 'w', inputSchema: z.array(prompt), outputSchema: z.any() }).foreach(body as never, opts).commit();
    expect(refusal(() => adaptWf(w)).reason).toMatch(/^blueprint-arms: entry 0 of the pipeline's body \('writer'\)/);
  });

  it('negative: the same options but another agent ref is refused (blueprint-arms)', () => {
    // Breaks if: the agent case omits the ref comparison.
    const options = { retries: 1 };
    const [body, opts] = pipeline([createStep(agent, options) as never], { id: 'per' });
    const graph = (body as unknown as { stepGraph: { agent: unknown }[] }).stepGraph;
    graph[0]!.agent = new Agent({ id: 'writer', name: 'writer', instructions: 'x', model: {} as never });
    const w = createWorkflow({ id: 'w', inputSchema: z.array(prompt), outputSchema: z.any() }).foreach(body as never, opts).commit();
    expect(refusal(() => adaptWf(w)).reason).toMatch(/^blueprint-arms/);
  });

  it('matchMinted is the decision\'s matcher too', () => {
    // Breaks if: blockDecision and foreachPipeline match by different rules.
    const s = mk('s');
    expect(matchMinted({ type: 'step', step: s } as never, s)).toBe(true);
    expect(matchMinted({ type: 'step', step: mk('s') } as never, s)).toBe(false);
    expect(matchMinted({ type: 'mapping' } as never, s)).toBe(false);
  });
});

describe('the refusals', () => {
  it('blueprint-arms: something under the key that pipeline did not make', () => {
    // Breaks if: foreachPipeline trusts any `{ stages, bounds }` under the key (no `instanceof Pipeline`).
    const [body] = pipeline([mk('a')], { id: 'per' });
    const fake = { body, stages: [], bounds: [1], id: 'per', width: 1 };
    const e = refusal(() => adaptWf(wf().foreach(body, carrying(fake, 1)).commit()));
    expect(e.entryType).toBe('foreach');
    expect(e.reason).toMatch(/^blueprint-arms: .*did not make/);
  });

  it('pipeline-empty: a forged Pipeline of no stages', () => {
    // Breaks if: foreachPipeline drops the empty check.
    const [body] = pipeline([mk('a')], { id: 'per' });
    const e = refusal(() => adaptWf(wf().foreach(body, carrying(forge({ body, stages: [], bounds: [] }), 1)).commit()));
    expect(e.reason).toMatch(/^pipeline-empty/);
  });

  it('pipeline-value: a bound that is not a whole number ≥ 1, a vector of the wrong length, Σ above the lane cap', () => {
    // Breaks if: foreachPipeline drops any of the three bound checks (the factory refuses them; a forgery does not).
    const a = mk('a'), b = mk('b');
    const [body] = pipeline([a, b], { id: 'per' });
    const cases: [readonly unknown[], RegExp][] = [
      [[1, 0], /^pipeline-value: stage 1's concurrency is the number 0/],
      [[1.5, 1], /^pipeline-value: stage 0's concurrency/],
      [['1', 1], /^pipeline-value: stage 0's concurrency is the string '1'/],
      [[1], /^pipeline-value: the pipeline has 1 bound\(s\) for 2 stage\(s\)/],
      [[MAX_FOREACH_LANES, 1], new RegExp(`^pipeline-value: .* adds up to ${MAX_FOREACH_LANES + 1}`)],
    ];
    for (const [bounds, why] of cases) {
      const e = refusal(() => adaptWf(wf().foreach(body, carrying(forge({ body, stages: [a, b], bounds }), 2)).commit()));
      expect(e.reason, JSON.stringify(bounds)).toMatch(why);
    }
  });

  it("pipeline-value: the entry's opts.concurrency altered by hand, or a resolver function", () => {
    // Breaks if: the adapter reads the window from the Pipeline instead of checking the entry's
    // opts against Σc_j — Mastra keeps the options object by reference, so the edit reaches the entry.
    const [body, options] = pipeline([mk('a'), mk('b')], { id: 'per', concurrency: [2, 1] });
    const w = wf().foreach(body, options).commit();
    expect(() => adaptWf(w)).not.toThrow();
    (options as { concurrency: unknown }).concurrency = 2;
    expect(refusal(() => adaptWf(w)).reason).toMatch(/^pipeline-value: the \.foreach\(\)'s concurrency is the number 2, but .* 3 items/);
    (options as { concurrency: unknown }).concurrency = () => 3;
    expect(refusal(() => adaptWf(w)).reason).toMatch(/^pipeline-value: the \.foreach\(\)'s concurrency is a function/);
  });

  it('blueprint-arms: a stage listed twice, two stages sharing an id, a nested-workflow stage (forged)', () => {
    // Breaks if: foreachPipeline drops the per-stage checks the factory makes.
    const a = mk('a');
    const [body] = pipeline([a], { id: 'per' });
    const child = createWorkflow({ id: 'child', inputSchema: num, outputSchema: num }).then(mk('in')).commit();
    const cases: [readonly unknown[], RegExp][] = [
      [[a, a], /^blueprint-arms: stage 1 is the same step as stage 0/],
      [[a, mk('a')], /^blueprint-arms: two stages have the id 'a'/],
      [[child], /^blueprint-arms: stage 0 \('child'\) is a nested workflow/],
    ];
    for (const [stages, why] of cases) {
      const bounds = stages.map(() => 1);
      const e = refusal(() => adaptWf(wf().foreach(body, carrying(forge({ body, stages, bounds }))).commit()));
      expect(e.reason).toMatch(why);
    }
  });

  it("blueprint-arms: the pipeline's options spread onto another step or another body", () => {
    // Breaks if: foreachPipeline does not check the entry's step against the minted body.
    const [, options] = pipeline([mk('a')], { id: 'per' });
    const [otherBody] = pipeline([mk('a')], { id: 'per' });
    for (const step of [mk('per'), otherBody]) {
      const e = refusal(() => adaptWf(wf().foreach(step, options).commit()));
      expect(e.reason).toMatch(/^blueprint-arms: the \.foreach\(\)'s step is not the body its pipeline minted/);
    }
  });

  it("blueprint-arms: the body's step graph altered — a stage swapped, added, or not a single step", () => {
    // Breaks if: foreachPipeline skips the body-graph match, its length check, or its kind check.
    const a = mk('a'), b = mk('b');
    const alter = (edit: (graph: unknown[]) => void, why: RegExp) => {
      const [body, options] = pipeline([a, b], { id: 'per' });
      edit((body as unknown as { stepGraph: unknown[] }).stepGraph);
      const e = refusal(() => adaptWf(wf().foreach(body, options).commit()));
      expect(e.reason).toMatch(why);
    };
    alter((g) => g.reverse(), /^blueprint-arms: entry 0 of the pipeline's body \('b'\) is not the stage/);
    alter((g) => g.push({ type: 'step', step: mk('c') }), /^blueprint-arms: the pipeline's body has 3 entr\(ies\), but .* 2 stage/);
    alter((g) => (g[1] = { type: 'sleep', id: 'nap', duration: 1 }), /^blueprint-arms: entry 1 of the pipeline's body \(a 'sleep' entry\)/);
  });

  it('blueprint-position: the pipeline marker on a .then() step, a .parallel(), a .dowhile(), a .map()', () => {
    // Breaks if: refuseMisplacedBlueprints checks only decisions, or only `.foreach()` entries.
    const [, options] = pipeline([mk('a')], { id: 'per' });
    const numWf = () => createWorkflow({ id: 'w', inputSchema: num, outputSchema: z.any() });
    const cases: [Graph, RegExp][] = [
      [numWf().then(mk('x', { metadata: options.metadata })).commit(), /a pipeline is on a \.then\(\) step/],
      [numWf().parallel([mk('x'), mk('y')], { metadata: options.metadata } as never).commit(), /a pipeline is on a \.parallel\(\)/],
      [numWf().dowhile(mk('x'), async () => false, { metadata: options.metadata } as never).commit(), /a pipeline is on a \.dowhile\(\)/],
      [numWf().parallel([mk('x', { metadata: options.metadata }), mk('y')]).commit(), /step 'x' carries a pipeline in its own metadata as a \.parallel\(\) arm/],
    ];
    for (const [w, why] of cases) {
      const e = refusal(() => adaptWf(w));
      expect(e.reason).toMatch(/^blueprint-position/);
      expect(e.reason).toMatch(why);
    }
  });

  it('blueprint-position: any blueprint marker on a stage\'s own metadata, placed after minting', () => {
    // Breaks if: innerSteps does not return a marked foreach's stages, so stage metadata is never read.
    for (const [marker, what] of [
      [{ ...race([mk('r')])[1].metadata }, 'race / quorum decision'],
      [{ ...pipeline([mk('q')], { id: 'q' })[1].metadata }, 'pipeline'],
    ] as const) {
      const a = mk('a');
      const [body, options] = pipeline([mk('first'), a], { id: 'per' });
      (a as { metadata?: unknown }).metadata = marker;
      const e = refusal(() => adaptWf(wf().foreach(body, options).commit()));
      expect(e.reason).toMatch(new RegExp(`^blueprint-position: step 'a' carries a ${what.replace('/', '\\/')} in its own metadata as a pipeline stage`));
    }
  });

  it('blueprint-position: a race decision on a pipeline-marked .foreach()', () => {
    // Breaks if: the decision row of the table is not checked on foreach entries.
    const [body, options] = pipeline([mk('a')], { id: 'per' });
    const both = { ...options, metadata: { ...options.metadata, [BLOCK_DECISION]: race([mk('r')])[1].metadata[BLOCK_DECISION] } };
    expect(refusal(() => adaptWf(wf().foreach(body, both).commit())).reason).toMatch(/^blueprint-position: a race \/ quorum decision is on a \.foreach\(\)/);
  });

  it('blueprint-reused: one pipeline spread into two .foreach() calls, or its metadata copied', () => {
    // Breaks if: refuseMisplacedBlueprints does not track the pipelines it has seen.
    const p = pipeline([mk('a')], { id: 'per' });
    const e = refusal(() => adaptWf(wf().foreach(...p).map(back).foreach(...p).commit()));
    expect(e.reason).toMatch(/^blueprint-reused: this \.foreach\(\) carries the same pipeline as \.foreach\(\) 'per'/);
    const copied = { ...p[1], metadata: { ...p[1].metadata } };
    expect(refusal(() => adaptWf(wf().foreach(...p).map(back).foreach(p[0], copied).commit())).reason).toMatch(/^blueprint-reused/);
  });

  it('two pipeline calls over the same stages are two pipelines, not a reuse', () => {
    // Breaks if: reuse is keyed by stages rather than by the minted Pipeline.
    const a = mk('a');
    const d = adaptWf(wf().foreach(...pipeline([a], { id: 'one' })).map(back).foreach(...pipeline([a], { id: 'two' })).commit());
    expect(d.entries.filter((x) => x.kind === 'foreach' && x.pipeline !== undefined).map((x) => x.id)).toEqual(['one', 'two']);
  });

  it('refuseMisplacedBlueprints on a hand-built step flow, and adaptStepFlow runs it', () => {
    // Breaks if: adaptStepFlow does not call refuseMisplacedBlueprints.
    const [, options] = pipeline([mk('a')], { id: 'per' });
    const flow: StepFlowEntry[] = [{ type: 'sleep', id: 'nap', duration: 1, metadata: options.metadata } as StepFlowEntry];
    expect(() => refuseMisplacedBlueprints(flow)).toThrow(/blueprint-position: a pipeline is on a \.sleep\(\)/);
    expect(() => adaptStepFlow(flow, { workflowId: 'w' })).toThrow(/blueprint-position/);
  });
});

describe('the positions a stage is checked at', () => {
  it('metadata.checkpoint on the pipeline entry passes; on a stage it is checkpoint-position', () => {
    // Breaks if: innerSteps leaves a marked foreach's stages out, or the entry's own mark is not read.
    const d = adaptWf(wf().foreach(...pipeline([mk('a')], { id: 'per', metadata: { checkpoint: true } })).map(back).commit());
    expect(d.checkpoints).toEqual([0]);
    const e = refusal(() => adaptWf(wf().foreach(...pipeline([mk('a', { metadata: { checkpoint: true } })], { id: 'per' })).map(back).commit()));
    expect(e.reason).toMatch(/^checkpoint-position: step 'a' is marked metadata\.checkpoint as a pipeline stage/);
  });

  it('metadata.concurrency on the pipeline entry is concurrency-foreach; on a stage, concurrency-position', () => {
    // Breaks if: a stage's metadata.concurrency is not read, or the message points at the wrong place.
    const e = refusal(() => adaptWf(wf().foreach(...pipeline([mk('a')], { id: 'per', metadata: { concurrency: 2 } })).commit()));
    expect(e.reason).toMatch(/^concurrency-foreach/);
    const s = refusal(() => adaptWf(wf().foreach(...pipeline([mk('a', { metadata: { concurrency: 2 } })], { id: 'per' })).commit()));
    expect(s.reason).toMatch(/^concurrency-position: step 'a' carries metadata\.concurrency as a pipeline stage/);
    expect(s.reason).toMatch(/pipeline\(stages, \{ id, concurrency: \[/);
  });

  it('uses-position: a stage whose uses never passed through the petri createStep', () => {
    // Breaks if: stages are not adapted through adaptSingleStep (stepResources).
    const gpu = limit(1, { id: 'gpu' });
    const st = mastraCreateStep(tool, { uses: [gpu] } as never);
    const [body, options] = pipeline([st as never], { id: 'per' });
    expect(refusal(() => adaptWf(wf().foreach(body as never, options).commit())).reason).toMatch(/^uses-position/);
  });
});

describe("the 'pipeline' resume refusal", () => {
  /** An unannotated net with one pipeline site declared on it, as the contract test builds one. */
  function withSite(): CompiledWorkflow {
    // A sleep at [1] stands in for the pipeline's foreach: neither registers a resume site there.
    const compiled = compile({ id: 'w', entries: [{ kind: 'step', id: 'first' }, { kind: 'sleep', id: 'per', duration: { fixed: 0 } }] });
    expect(compiled.resumeSites.has('1')).toBe(false);
    const site = { path: [1], foreachId: 'per', bodyId: 'per', stages: ['a', 'b'], bounds: [1, 1] } as unknown as PipelineSite;
    return { ...compiled, pipelines: [site] };
  }
  const request = (path: number[], steps: string[]) => ({ path, steps, records: new Map() });

  it('a resume at the pipeline\'s path, or under its body id, is refused by name before no-site', () => {
    // Breaks if: resumeSeed says `no-site` for a pipeline, or matches only one of path and body id.
    const compiled = withSite();
    for (const [path, steps] of [
      [[1], ['per']],
      [[1], ['other']],
      [[1, 0], ['a']],
      [[7], ['per']],
    ] as const) {
      let error: unknown;
      try {
        resumeSeed(compiled, request([...path], [...steps]));
      } catch (e) {
        error = e;
      }
      expect(error, JSON.stringify(path)).toBeInstanceOf(UnresumablePositionError);
      expect((error as UnresumablePositionError).reason).toBe('pipeline');
      expect((error as Error).message).toMatch(/pipeline 'per' at \[1\] \(stages 'a', 'b'\)/);
    }
  });

  it('anywhere else is still no-site, and a net without pipelines is unchanged', () => {
    // Breaks if: the pipeline check matches every path.
    const compiled = withSite();
    expect(pipelineRefusal(compiled, [0], ['first'])).toBeUndefined();
    expect(() => resumeSeed(compiled, request([5], ['nothing']))).toThrow(expect.objectContaining({ reason: 'no-site' }));
    const plain = { ...compiled, pipelines: [] };
    expect(() => resumeSeed(plain, request([1], ['per']))).toThrow(expect.objectContaining({ reason: 'no-site' }));
  });
});

// Keep the symbols referenced for the reader: both markers ride in metadata under a symbol key.
void pipelineOf;

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { adaptExecutionGraph, adaptStepFlow, BLUEPRINT_REFUSALS, init, UnsupportedWorkflowError } from '../../src/mastra/index.js';
import type { ExecutionGraph, StepFlowEntry } from '../../src/mastra/index.js';
import { blockDecision, refuseMisplacedDecision } from '../../src/mastra/adapt.js';
import { BLOCK_DECISION, Decision } from '../../src/mastra/resources.js';

/**
 * Reading a `race` / `quorum` decision off a `.parallel()` entry ([ADR 0014], M7b W1 D): the
 * description's `decision`, matching each entry arm to its minted arm by kind — a plain step or a
 * nested workflow by identity, an agent or tool by id, ref and options identity — and the five
 * refusals by name.
 *
 * Each case notes the adapter mutation that breaks it.
 */

const { createWorkflow, createStep, cloneStep, race, quorum } = init({ iterationBound: 3 });

const num = z.object({ n: z.number() });
const prompt = z.object({ prompt: z.string() });
const mk = (id: string, metadata?: Record<string, unknown>) =>
  createStep({ id, inputSchema: num, outputSchema: num, ...(metadata ? { metadata } : {}), execute: async ({ inputData }) => ({ n: inputData.n + 1 }) });
/** Back to `{ n }` after a block, so the next block's arms type-check against it. */
const back = async () => ({ n: 1 });
const wf = (id = 'w') => createWorkflow({ id, inputSchema: num, outputSchema: z.any() });

type Graph = { buildExecutionGraph(): unknown };
const graphOf = (w: Graph) => w.buildExecutionGraph() as ExecutionGraph;
const adaptWf = (w: Graph) => adaptExecutionGraph(graphOf(w), { iterationBound: 3 });
const refusal = (fn: () => unknown): UnsupportedWorkflowError => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(UnsupportedWorkflowError);
    return error as UnsupportedWorkflowError;
  }
  throw new Error('expected a refusal');
};

const agent = new Agent({ id: 'stubby', name: 'stubby', instructions: 'be brief', model: {} as never });
const agent2 = new Agent({ id: 'other', name: 'other', instructions: 'be brief', model: {} as never });
const tool = createTool({ id: 'double', description: 'doubles n', inputSchema: num, outputSchema: num, execute: async (input) => ({ n: input.n * 2 }) });

describe('reading the decision', () => {
  it('race is { k: 1 } and quorum(k) is { k }, beside a Layer 2 concurrency', () => {
    // Breaks if: the parallel case drops `decision`, or blockDecision returns a fixed k.
    const a = mk('a'), b = mk('b'), c = mk('c');
    const d = adaptWf(
      wf()
        .parallel(...race([a, b, c], { id: 'fastest' }))
        .map(back)
        .parallel(...quorum(2, [mk('d'), mk('e'), mk('f')], { metadata: { concurrency: 2 } }))
        .commit(),
    );
    expect(d.entries[0]).toMatchObject({ kind: 'parallel', id: 'fastest', decision: { k: 1 } });
    expect(d.entries[2]).toMatchObject({ kind: 'parallel', id: 'parallel_2', concurrency: 2, decision: { k: 2 } });
    expect((d.entries[0] as unknown as { arms: { id: string }[] }).arms.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('a plain .parallel() has no decision key at all, so it describes as before M7b', () => {
    // Breaks if: the parallel case writes `decision: undefined`.
    const d = adaptWf(wf().parallel([mk('a'), mk('b')]).commit());
    expect('decision' in d.entries[0]!).toBe(false);
    expect(blockDecision(graphOf(wf().parallel([mk('a')]).commit()).steps![0]!, 'p')).toBeUndefined();
  });

  it('a race of one arm is a decision of k = 1', () => {
    // Breaks if: blockDecision refuses n = 1 (the compiler omits its preemption; the adapter accepts it).
    expect(adaptWf(wf().parallel(...race([mk('only')])).commit()).entries[0]).toMatchObject({ decision: { k: 1 } });
  });

  it('a nested workflow arm matches by identity, as a plain step', () => {
    // Breaks if: armMatches compares a `step` arm by anything but identity with the minted object.
    const child = createWorkflow({ id: 'child', inputSchema: num, outputSchema: num }).then(mk('in')).commit();
    // A petri child workflow is not a `PetriStep` to the type checker (its `execute` keeps Mastra's
    // default engine type), as on `.then(child)`; the cast is about that, not about race.
    const d = adaptWf(wf().parallel(...race([child as never, mk('b')])).commit());
    expect(d.entries[0]).toMatchObject({ decision: { k: 1 } });
  });
});

describe('agent and tool arms match by ref and options identity', () => {
  it('an agent-arm race: createStep(agent) with no options, and with options, beside a plain step', () => {
    // Breaks if: an agent arm is compared as `entry.step === minted` (it has no `step`), or the
    // options comparison treats `undefined` on both sides as a mismatch.
    const bare = createStep(agent);
    const withOptions = createStep(agent2, { retries: 1 });
    const plain = createStep({ id: 'plain', inputSchema: prompt, outputSchema: z.object({ text: z.string() }), execute: async () => ({ text: '' }) });
    const w = createWorkflow({ id: 'w', inputSchema: prompt, outputSchema: z.any() }).parallel(...race([bare, withOptions, plain])).commit();
    const entry = graphOf(w).steps![0]! as Extract<StepFlowEntry, { type: 'parallel' }>;
    expect(entry.steps.map((s) => s.type)).toEqual(['agent', 'agent', 'step']);
    expect((entry.steps[0] as { options?: unknown }).options).toBeUndefined();
    const d = adaptWf(w);
    expect(d.entries[0]).toMatchObject({ kind: 'parallel', decision: { k: 1 } });
    expect((d.entries[0] as unknown as { arms: { id: string; source: string }[] }).arms.map((s) => [s.id, s.source])).toEqual([
      ['stubby', 'agent'],
      ['other', 'agent'],
      ['plain', 'step'],
    ]);
  });

  it('a tool arm, with and without options', () => {
    // Breaks if: the tool case reads `__agentRef` / `__agentOptions`, or compares `toolId` for `tool`.
    const t1 = createStep(tool);
    const t2 = cloneStep(createStep(tool), { id: 'double-again' });
    const w = wf().parallel(...quorum(2, [t1, t2, mk('c')])).commit();
    const entry = graphOf(w).steps![0]! as Extract<StepFlowEntry, { type: 'parallel' }>;
    expect(entry.steps.map((s) => s.type)).toEqual(['tool', 'step', 'step']);
    expect(adaptWf(w).entries[0]).toMatchObject({ decision: { k: 2 } });
  });

  it('negative: an equal but distinct options object is refused (blueprint-arms)', () => {
    // Breaks if: options are compared by value (deep equality) rather than identity.
    const options = { retries: 1 };
    const minted = createStep(agent, options);
    const lookalike = createStep(agent, { ...options });
    const [, opts] = race([minted]);
    const w = createWorkflow({ id: 'w', inputSchema: prompt, outputSchema: z.any() }).parallel([lookalike], opts).commit();
    const e = refusal(() => adaptWf(w));
    expect(e.entryType).toBe('parallel');
    expect(e.reason).toMatch(/^blueprint-arms: arm 0 \('stubby'\)/);
  });

  it('negative: the same options but another agent ref is refused (blueprint-arms)', () => {
    // Breaks if: the agent case omits the ref comparison.
    const options = { retries: 1 };
    const [, opts] = race([createStep(agent, options)]);
    const impostor = createStep(new Agent({ id: 'stubby', name: 'stubby', instructions: 'x', model: {} as never }), options);
    const w = createWorkflow({ id: 'w', inputSchema: prompt, outputSchema: z.any() }).parallel([impostor], opts).commit();
    expect(refusal(() => adaptWf(w)).reason).toMatch(/^blueprint-arms/);
  });
});

describe('the refusals', () => {
  it('are named in BLUEPRINT_REFUSALS', () => {
    // The decision's five; ADR 0015 adds the pipeline's two (pinned in tests/compiler/pipeline-contract.test.ts).
    expect([...BLUEPRINT_REFUSALS]).toEqual(
      expect.arrayContaining(['blueprint-arms', 'blueprint-position', 'blueprint-reused', 'quorum-value', 'race-empty']),
    );
  });

  it('blueprint-arms: the options spread onto other arms, reordered arms, fewer arms', () => {
    // Breaks if: blockDecision skips the per-arm identity check, or the length check.
    const a = mk('a'), b = mk('b');
    const [, opts] = race([a, b]);
    for (const arms of [[mk('a'), mk('b')], [b, a], [a]]) {
      const e = refusal(() => adaptWf(wf().parallel(arms, opts).commit()));
      expect(e.reason).toMatch(/^blueprint-arms/);
    }
  });

  it('blueprint-arms: something under the key that race / quorum did not make', () => {
    // Breaks if: blockDecision trusts any `{ k }` under the key (no `instanceof Decision`).
    const a = mk('a');
    const forged = { metadata: { [BLOCK_DECISION]: { kind: 'race', k: 1, arms: [a], n: 1 } } };
    const e = refusal(() => adaptWf(wf().parallel([a], forged as never).commit()));
    expect(e.reason).toMatch(/^blueprint-arms: .*did not make/);
  });

  it('blueprint-arms: an entry listing one id twice under a forged Decision', () => {
    // Breaks if: blockDecision drops the duplicate-id check (the factories refuse it, a forgery does not).
    const a = mk('a');
    const twin = mk('a');
    const decision = Object.create(Decision.prototype, { kind: { value: 'quorum' }, k: { value: 1 }, arms: { value: [a, twin] } }) as Decision;
    const e = refusal(() => adaptWf(wf().parallel([a, twin], { metadata: { [BLOCK_DECISION]: decision } } as never).commit()));
    expect(e.reason).toMatch(/^blueprint-arms: two arms have the id 'a'/);
  });

  it('quorum-value and race-empty: an altered Decision', () => {
    // Breaks if: blockDecision drops the k range check, or the empty check.
    const a = mk('a');
    const forge = (k: unknown, arms: unknown[]) =>
      ({ metadata: { [BLOCK_DECISION]: Object.create(Decision.prototype, { kind: { value: 'quorum' }, k: { value: k }, arms: { value: arms } }) } }) as never;
    for (const k of [0, 2, 1.5, Number.NaN, '1']) {
      const e = refusal(() => adaptWf(wf().parallel([a], forge(k, [a])).commit()));
      expect(e.reason, String(k)).toMatch(/^quorum-value/);
    }
    expect(refusal(() => adaptWf(wf().parallel([], forge(1, [])).commit())).reason).toMatch(/^race-empty/);
  });

  it('blueprint-position: on a .branch(), a .dowhile(), a .foreach(), and on an arm\'s or a top-level step\'s own metadata', () => {
    // Breaks if: refuseMisplacedDecision checks only `.parallel()` entries, or skips inner steps.
    const [, opts] = race([mk('a'), mk('b')]);
    const cases: [Graph, RegExp][] = [
      [wf().branch([[async () => true, mk('x')]], opts).commit(), /on a \.branch\(\)/],
      [wf().dowhile(mk('x'), async () => false, opts).commit(), /on a \.dowhile\(\)/],
      [createWorkflow({ id: 'w', inputSchema: z.array(num), outputSchema: z.any() }).foreach(mk('x'), opts).commit(), /on a \.foreach\(\)/],
      [wf().parallel([mk('x', opts.metadata), mk('y')]).commit(), /step 'x' .* as a \.parallel\(\) arm/],
      [wf().then(mk('x', opts.metadata)).commit(), /on a \.then\(\) step/],
    ];
    for (const [w, why] of cases) {
      const e = refusal(() => adaptWf(w));
      expect(e.reason).toMatch(/^blueprint-position/);
      expect(e.reason).toMatch(why);
    }
  });

  it('blueprint-reused: one decision spread into two .parallel() calls, or its metadata copied', () => {
    // Breaks if: refuseMisplacedDecision does not track decisions it has seen.
    const a = mk('a'), b = mk('b');
    const r = race([a, b], { id: 'once' });
    const e = refusal(() => adaptWf(wf().parallel(...r).map(back).parallel(...r).commit()));
    expect(e.reason).toMatch(/^blueprint-reused: .* as block 'once'/);
    const copied = { ...r[1], id: 'twice', metadata: { ...r[1].metadata } };
    expect(refusal(() => adaptWf(wf().parallel(...r).map(back).parallel(r[0], copied).commit())).reason).toMatch(/^blueprint-reused/);
  });

  it('two separate race calls over the same steps are two decisions, not a reuse', () => {
    // Breaks if: reuse is keyed by arms (or by step ids) rather than by the minted decision.
    const a = mk('a'), b = mk('b');
    const d = adaptWf(wf().parallel(...race([a, b], { id: 'p' })).map(back).parallel(...quorum(2, [a, b], { id: 'q' })).commit());
    expect(d.entries.map((x) => (x as { decision?: unknown }).decision)).toEqual([{ k: 1 }, undefined, { k: 2 }]);
  });

  it('refuseMisplacedDecision on a hand-built step flow, and adaptStepFlow runs it', () => {
    // Breaks if: adaptStepFlow does not call refuseMisplacedDecision.
    const [, opts] = race([mk('a')]);
    const flow: StepFlowEntry[] = [{ type: 'sleep', id: 'nap', duration: 1, metadata: opts.metadata } as StepFlowEntry];
    expect(() => refuseMisplacedDecision(flow)).toThrow(/blueprint-position: a race \/ quorum decision is on a \.sleep\(\)/);
    expect(() => adaptStepFlow(flow, { workflowId: 'w' })).toThrow(/blueprint-position/);
  });
});

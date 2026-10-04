import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createStep as mastraCreateStep, createWorkflow as mastraCreateWorkflow } from '@mastra/core/workflows';
import { init } from '../../src/mastra/init.js';
import { isMastraWorkflow, nestedWorkflows, verifyMastraWorkflow, workflowsIn } from '../../src/mastra/verify.js';
import { describeClaim, segmentLabel, type ClaimReport, type VerificationReport } from '../../src/verify/index.js';

const num = z.object({ n: z.number() });

/**
 * Each claim's verdict, explicitly: a proof is `proven`, a witness a `violated` whose replay
 * confirmed the firing sequence. Never "not violated" — that passes on `unknown`.
 */
function expectEveryClaimBacked(report: VerificationReport): void {
  expect(report.claims.length).toBeGreaterThan(0);
  for (const claim of report.claims) {
    const why = describeClaim(claim);
    if (claim.kind === 'proof') {
      expect(claim.result.verdict.type, why).toBe('proven');
    } else {
      expect(claim.result.verdict.type, why).toBe('violated');
      expect(claim.result.counterexampleConfirmed, why).toBe(true);
    }
    expect(claim.holds, why).toBe(true);
  }
  expect(report.holds).toBe(true);
}

const familiesOf = (claims: readonly ClaimReport[]): string[] => [...new Set(claims.map((c) => c.family))].sort();

/**
 * A two-step outer workflow, one step retried once, then a nested workflow — all on engines built
 * by `init({ concurrency: 2 })`. `verifyMastraWorkflow` compiles the net `execute()` would run:
 * `k` comes from the workflow's own engine, and the nested workflow is its own run, verified too.
 */
describe('verifyMastraWorkflow', () => {
  const { createWorkflow, createStep } = init({ concurrency: 2 });
  const double = createStep({ id: 'double', inputSchema: num, outputSchema: num, retries: 1, execute: async ({ inputData }) => ({ n: inputData.n * 2 }) });
  const inc = createStep({ id: 'inc', inputSchema: num, outputSchema: num, execute: async ({ inputData }) => ({ n: inputData.n + 1 }) });
  const inner = createWorkflow({ id: 'inner', inputSchema: num, outputSchema: num }).then(inc).commit();
  const outer = createWorkflow({ id: 'outer', inputSchema: num, outputSchema: num }).then(double).then(createStep(inner)).commit();

  it('proves every family of claim about the workflow and its nested workflow, at the engine\'s k', async () => {
    const verification = await verifyMastraWorkflow(outer);

    expect(verification.workflow.workflow).toBe('outer');
    expect(verification.workflow.k).toBe(2);
    expect(familiesOf(verification.workflow.claims)).toEqual(['bounds', 'completion', 'exclusion', 'liveness']);
    // `double` retries once: two attempts, each shown live.
    expect(verification.workflow.claims.filter((c) => c.family === 'liveness')).toHaveLength(3);
    expect(verification.workflow.segments.map(segmentLabel).slice(0, 2)).toEqual(['closed', 'cancel']);
    expectEveryClaimBacked(verification.workflow);

    expect(Object.keys(verification.nested)).toEqual(['inner']);
    const nested = verification.nested['inner']!;
    expect(nested.workflow).toBe('inner');
    expect(nested.k).toBe(2);
    expectEveryClaimBacked(nested);

    expect(verification.holds).toBe(true);
  });

  it('an explicit concurrency overrides the engine\'s, for the nested workflow too', async () => {
    const verification = await verifyMastraWorkflow(outer, { concurrency: 1, families: ['completion'], resume: 'none', restart: 'none' });
    expect(verification.workflow.k).toBe(1);
    expect(verification.nested['inner']!.k).toBe(1);
    expect(verification.workflow.segments.map(segmentLabel)).toEqual(['closed', 'cancel']);
    expect(familiesOf(verification.workflow.claims)).toEqual(['completion']);
    expectEveryClaimBacked(verification.workflow);
    expectEveryClaimBacked(verification.nested['inner']!);
  }, 60_000);

  it('a workflow on the default engine is compiled unbounded, as no petri engine configures it', async () => {
    const step = mastraCreateStep({ id: 'only', inputSchema: num, outputSchema: num, execute: async ({ inputData }) => inputData });
    const plain = mastraCreateWorkflow({ id: 'plain', inputSchema: num, outputSchema: num }).then(step).commit();
    const verification = await verifyMastraWorkflow(plain, { families: ['completion'], resume: 'none' });
    expect(verification.workflow.k).toBe('unbounded');
    expect(verification.nested).toEqual({});
    expectEveryClaimBacked(verification.workflow);
  }, 60_000);

  it('refuses a loop when neither the options nor the engine give an iteration bound', async () => {
    const step = mastraCreateStep({ id: 'body', inputSchema: num, outputSchema: num, execute: async ({ inputData }) => inputData });
    const looping = mastraCreateWorkflow({ id: 'looping', inputSchema: num, outputSchema: num })
      .dountil(step, async ({ inputData }) => inputData.n > 3)
      .commit();
    await expect(verifyMastraWorkflow(looping)).rejects.toMatchObject({ name: 'UnsupportedWorkflowError' });
  });
});

describe('nestedWorkflows and workflowsIn — structure only, no solver', () => {
  const { createWorkflow, createStep } = init();
  const leaf = createStep({ id: 'leaf', inputSchema: num, outputSchema: num, execute: async ({ inputData }) => inputData });
  const deep = createWorkflow({ id: 'deep', inputSchema: num, outputSchema: num }).then(leaf).commit();
  const armA = createWorkflow({ id: 'arm-a', inputSchema: num, outputSchema: num }).then(createStep(deep)).commit();
  const armB = createWorkflow({ id: 'arm-b', inputSchema: num, outputSchema: num }).then(leaf).commit();
  const body = createWorkflow({ id: 'body', inputSchema: num, outputSchema: num }).then(leaf).commit();
  const top = createWorkflow({ id: 'top', inputSchema: num, outputSchema: z.object({ 'arm-a': num.optional(), 'arm-b': num.optional() }) })
    .then(createStep(deep))
    .branch([
      [async () => true, createStep(armA)],
      [async () => false, createStep(armB)],
    ])
    .map(async () => ({ n: 1 }))
    .foreach(createStep(body) as never)
    .commit();

  it('finds workflows at every single-step position and every depth, each once, in step-flow order', () => {
    expect([...nestedWorkflows(top as never).keys()]).toEqual(['deep', 'arm-a', 'arm-b', 'body']);
    expect(nestedWorkflows(deep as never).size).toBe(0);
  });

  it('tells a workflow from a step', () => {
    expect(isMastraWorkflow(top)).toBe(true);
    expect(isMastraWorkflow(leaf)).toBe(false);
    expect(isMastraWorkflow(null)).toBe(false);
  });

  it('collects exported workflows and a Mastra instance\'s, once each', () => {
    const mastra = { getWorkflows: () => ({ registered: deep, again: top }) };
    const found = workflowsIn({ top, mastra, leaf, n: 3 });
    expect(found.map((f) => f.name)).toEqual(['top', 'mastra.registered']);
    expect(workflowsIn({ top, deep }, 'deep').map((f) => f.name)).toEqual(['deep']);
    expect(() => workflowsIn({ top }, 'missing')).toThrow(/no export 'missing'/);
    expect(() => workflowsIn({ leaf }, 'leaf')).toThrow(/neither a Mastra Workflow nor a Mastra instance/);
  });
});

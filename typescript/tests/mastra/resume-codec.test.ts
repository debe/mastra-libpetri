import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import type { ExecutionEngine } from '@mastra/core/workflows';
import { z } from 'zod';
import { compile } from '../../src/compiler/compile.js';
import { UnresumablePositionError } from '../../src/compiler/resume.js';
import { adaptExecutionGraph } from '../../src/mastra/adapt.js';
import { decodeResume } from '../../src/mastra/resume-codec.js';
import { toMastraStepResult } from '../../src/mastra/step-result.js';

/**
 * `decodeResume` — the one reader of Mastra's `resume` parameter ([ADR 0007]): what `Run._resume`
 * hands `execute()` (`workflow.ts:4815-4826`, typed at `default.ts:732-740`), decoded for the net.
 */

type ExecuteParams = Parameters<ExecutionEngine['execute']>[0];

const num = z.object({ n: z.number() });
const a = createStep({ id: 'a', inputSchema: num, outputSchema: num, execute: async ({ inputData }) => ({ n: inputData.n + 1 }) });
const g = createStep({
  id: 'g',
  inputSchema: num,
  outputSchema: num,
  resumeSchema: z.object({ add: z.number() }),
  execute: async ({ inputData, resumeData, suspend }) => (resumeData ? { n: inputData.n + resumeData.add } : suspend({ ask: 'g' })),
});
const wf = createWorkflow({ id: 'codec', inputSchema: num, outputSchema: num }).then(a).then(g).commit();
const compiled = compile(adaptExecutionGraph(wf.buildExecutionGraph()));

const stepResults = {
  input: { n: 1 },
  a: { payload: { n: 1 }, startedAt: 1, status: 'success', output: { n: 2 }, endedAt: 2 },
  g: { payload: { n: 2 }, startedAt: 3, status: 'suspended', suspendPayload: { ask: 'g' }, suspendedAt: 4 },
  // In flight or not taken: kept in the context, no record.
  r: { payload: {}, startedAt: 5, status: 'running' },
};

const paramsWith = (resume: Record<string, unknown>): ExecuteParams => ({ workflowId: 'codec', runId: 'r', resume }) as unknown as ExecuteParams;

describe('decodeResume', () => {
  it('decodes every field Run hands over, copying what it keeps', () => {
    const resumePath = Object.freeze([1]) as unknown as number[];
    const steps = ['g'];
    const decoded = decodeResume(
      paramsWith({ steps, stepResults, resumePayload: { add: 5 }, resumePath, stepExecutionPath: ['a', 'g'], label: 'L', forEachIndex: 3 }),
      compiled,
    );

    expect(decoded.request.path).toEqual([1]);
    expect(decoded.request.path).not.toBe(resumePath);
    expect(decoded.request.steps).toEqual(['g']);
    expect(decoded.request.steps).not.toBe(steps);
    expect(decoded.request.forEachIndex).toBe(3);
    expect(decoded.request.records).toBe(decoded.records);
    expect(decoded.carriedPath).toEqual(['a', 'g']);
    expect(decoded.runnerResume).toEqual({ payload: { add: 5 }, steps: ['g'], label: 'L', forEachIndex: 3 });
    expect(decoded.context).toEqual(stepResults);
    expect(Object.keys(decoded.context)).toEqual(['input', 'a', 'g', 'r']);
  });

  it('never mutates resumePath — Mastra consumes its own with shift() (default.ts:800-802)', () => {
    const resumePath = [1, 0];
    decodeResume(paramsWith({ steps: ['g'], stepResults, resumePayload: {}, resumePath }), compiled);
    expect(resumePath).toEqual([1, 0]);
    // Frozen, a shift() would throw.
    expect(() => decodeResume(paramsWith({ steps: ['g'], stepResults, resumePayload: {}, resumePath: Object.freeze([1]) }), compiled)).not.toThrow();
  });

  it('records: every stored outcome as a StepRecord carrying its StepResult as host; input and a running entry are not records', () => {
    const { records } = decodeResume(paramsWith({ steps: ['g'], stepResults, resumePayload: {}, resumePath: [1] }), compiled);
    expect([...records.keys()]).toEqual(['a', 'g']);
    expect(records.get('g')).toMatchObject({ status: 'suspended', payload: { n: 2 }, suspendPayload: { ask: 'g' }, suspendedAt: 4, host: stepResults.g });
    // The round trip gives the stored result back.
    expect(toMastraStepResult(records.get('a')!)).toEqual(stepResults.a);
    expect(toMastraStepResult(records.get('g')!)).toEqual(stepResults.g);
  });

  it('absent label, forEachIndex and stepExecutionPath: no keys, and an empty carried path', () => {
    const decoded = decodeResume(paramsWith({ steps: ['g'], stepResults, resumePayload: 0, resumePath: [1] }), compiled);
    expect('forEachIndex' in decoded.request).toBe(false);
    expect(decoded.runnerResume).toEqual({ payload: 0, steps: ['g'] });
    expect(decoded.carriedPath).toEqual([]);
  });

  it.each([
    ['absent', undefined],
    ['empty', []],
    ['negative', [-1]],
    ['fractional', [1.5]],
    ['not an array', 1],
  ])('refuses a resumePath that is %s as no-site, naming the step', (_what, resumePath) => {
    const run = () => decodeResume(paramsWith({ steps: ['g'], stepResults, resumePayload: {}, resumePath }), compiled);
    expect(run).toThrow(UnresumablePositionError);
    try {
      run();
    } catch (e) {
      expect((e as UnresumablePositionError).reason).toBe('no-site');
      expect((e as Error).message).toContain("resume of step 'g'");
    }
  });

  it('refuses a stored status Mastra does not declare, naming it', () => {
    const bad = { ...stepResults, x: { status: 'exploded', payload: {}, startedAt: 0 } };
    expect(() => decodeResume(paramsWith({ steps: ['g'], stepResults: bad, resumePayload: {}, resumePath: [1] }), compiled)).toThrow(/'exploded'/);
  });

  it('refuses a call that is not a resume', () => {
    expect(() => decodeResume({ workflowId: 'codec', runId: 'r' } as unknown as ExecuteParams, compiled)).toThrow(/not handed a resume/);
  });

  it('decodes the very parameter Mastra\'s Run hands a real resume', async () => {
    const storage = new InMemoryStore();
    const engine = new (await import('../../src/mastra/engine.js')).PetriExecutionEngine();
    const live = createWorkflow({ id: 'codec', inputSchema: num, outputSchema: num, executionEngine: engine }).then(a).then(g).commit();
    const mastra = new Mastra({ storage, workflows: { live }, logger: false });
    const run = await mastra.getWorkflow('live').createRun({ runId: 'real' });
    await run.start({ inputData: { n: 1 } });

    const seen: ExecuteParams[] = [];
    const original = engine.execute.bind(engine);
    engine.execute = (async (params: ExecuteParams) => {
      seen.push(params);
      return original(params);
    }) as typeof engine.execute;
    await (await mastra.getWorkflow('live').createRun({ runId: 'real' })).resume({ step: 'g', resumeData: { add: 5 } });

    const params = seen[0]!;
    const decoded = decodeResume(params, compiled);
    expect(decoded.request.path).toEqual([1]);
    expect(decoded.request.steps).toEqual(['g']);
    expect(decoded.carriedPath).toEqual(['a', 'g']);
    expect(decoded.runnerResume.payload).toEqual({ add: 5 });
    expect(params.resume?.resumePath).toEqual([1]);
    expect([...decoded.records.keys()]).toEqual(['a', 'g']);
  });
});

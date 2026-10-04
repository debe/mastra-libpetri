import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { cloneStep as mastraCloneStep, createStep as mastraCreateStep } from '@mastra/core/workflows';
import { init, Quota } from '../../src/mastra/index.js';
import { STEP_RESOURCES, resourcesOf } from '../../src/mastra/resources.js';
import { MAX_CONCURRENCY, MAX_WAIT_MS } from '../../src/compiler/index.js';

/**
 * The Layer 3 surface of [ADR 0012] and [ADR 0013]: `init().limit` / `init().rateLimit`, and the
 * petri `createStep({ uses, timeout })`, which strips both before Mastra's `createStep` and carries
 * them under `STEP_RESOURCES` — without changing what Mastra builds or how it binds `execute`.
 */

const num = z.object({ n: z.number() });
const { createStep, createWorkflow, cloneStep, limit, rateLimit } = init();

describe('limit and rateLimit', () => {
  it('mint quotas whose ref is the compiler data, one object per call', () => {
    const db = limit(2, { id: 'db' });
    const api = rateLimit(3, 1_000, { id: 'api-1' });
    expect(db).toBeInstanceOf(Quota);
    expect(db.ref).toEqual({ id: 'db', kind: 'limit', n: 2 });
    expect([db.id, db.kind]).toEqual(['db', 'limit']);
    expect(api.ref).toEqual({ id: 'api-1', kind: 'rate', burst: 3, perMs: 1_000 });
    expect(limit(2, { id: 'db' })).not.toBe(db);
  });

  it('refuse a value that is not a whole number in range (quota-value)', () => {
    for (const n of [0, -1, 1.5, Number.NaN, Infinity, MAX_CONCURRENCY + 1, '2' as unknown as number]) {
      expect(() => limit(n, { id: 'q' }), String(n)).toThrow(/quota-value/);
      expect(() => rateLimit(n, 10, { id: 'q' }), String(n)).toThrow(/quota-value/);
    }
    for (const per of [0, 0.5, MAX_WAIT_MS + 1]) expect(() => rateLimit(1, per, { id: 'q' }), String(per)).toThrow(/quota-value/);
    expect(limit(MAX_CONCURRENCY, { id: 'q' }).ref).toMatchObject({ n: MAX_CONCURRENCY });
    expect(rateLimit(1, MAX_WAIT_MS, { id: 'q' }).ref).toMatchObject({ perMs: MAX_WAIT_MS });
  });

  it('refuse an id that is not a name segment (quota-value)', () => {
    for (const id of ['', 'a.b', 'a b', 'ä', undefined as unknown as string]) {
      expect(() => limit(1, { id }), String(id)).toThrow(/quota-value/);
      expect(() => rateLimit(1, 1, { id }), String(id)).toThrow(/quota-value/);
    }
  });

  it('a Quota cannot be constructed directly', () => {
    expect(() => new Quota(Symbol('x') as never, { id: 'x', kind: 'limit', n: 1 })).toThrow(TypeError);
  });
});

describe('createStep({ uses, timeout }) — types', () => {
  it('the default engine rejects uses/timeout; petri accepts quotas; a string is not a quota', () => {
    const db = limit(1, { id: 'db' });
    const execute = async () => ({ n: 1 });
    // @ts-expect-error — Mastra's own createStep has no `uses`
    mastraCreateStep({ id: 'm1', inputSchema: num, outputSchema: num, execute, uses: [db] });
    // @ts-expect-error — Mastra's own createStep has no `timeout`
    mastraCreateStep({ id: 'm2', inputSchema: num, outputSchema: num, execute, timeout: 10 });
    createStep({ id: 'p1', inputSchema: num, outputSchema: num, execute, uses: [db], timeout: 10 });
    expect(() =>
      // @ts-expect-error — `uses` takes quotas, not names
      createStep({ id: 'p2', inputSchema: num, outputSchema: num, execute, uses: ['db'] }),
    ).toThrow(/quotas made by init/);
  });
});

describe('createStep({ uses, timeout }) — a params step', () => {
  it('attaches the resources to the Step, non-enumerable, and nothing else changes', () => {
    const db = limit(1, { id: 'db' });
    const params = { id: 's', inputSchema: num, outputSchema: num, execute: async () => ({ n: 1 }), uses: [db], timeout: 50 };
    const step = createStep(params);
    expect(resourcesOf(step)).toEqual({ quotas: [db], timeoutMs: 50 });
    expect(resourcesOf(step)!.quotas![0]).toBe(db);
    expect(Object.keys(step)).not.toContain('uses');
    expect(Object.keys(step)).not.toContain('timeout');
    expect(Object.getOwnPropertySymbols({ ...step })).not.toContain(STEP_RESOURCES);
    // The same Step Mastra builds from the same params, field for field.
    const plain = mastraCreateStep({ id: 's', inputSchema: num, outputSchema: num, execute: params.execute });
    expect(Object.keys(step).sort()).toEqual(Object.keys(plain).sort());
  });

  it('`this` inside execute is the params object the author wrote (workflow.ts:523)', async () => {
    const params = {
      id: 'self',
      inputSchema: num,
      outputSchema: num,
      timeout: 25,
      factor: 3,
      async execute(this: { factor: number }, { inputData }: { inputData: { n: number } }) {
        return { n: inputData.n * this.factor, self: this };
      },
    };
    const step = createStep(params);
    const out = (await (step.execute as (c: unknown) => Promise<{ n: number; self: unknown }>)({ inputData: { n: 2 } }));
    expect(out.n).toBe(6);
    expect(out.self).toBe(params);
  });

  it('no uses (or an empty one) and no timeout: no resources, exactly Mastra\'s step', () => {
    const execute = async () => ({ n: 1 });
    expect(resourcesOf(createStep({ id: 'a', inputSchema: num, outputSchema: num, execute }))).toBeUndefined();
    expect(resourcesOf(createStep({ id: 'b', inputSchema: num, outputSchema: num, execute, uses: [] }))).toBeUndefined();
    expect(resourcesOf(mastraCreateStep({ id: 'c', inputSchema: num, outputSchema: num, execute }))).toBeUndefined();
  });

  it('the petri cloneStep copies the resources; Mastra\'s does not', () => {
    const api = rateLimit(2, 100, { id: 'api' });
    const step = createStep({ id: 's', inputSchema: num, outputSchema: num, execute: async () => ({ n: 1 }), uses: [api], timeout: 9 });
    expect(resourcesOf(cloneStep(step, { id: 's2' }))).toEqual({ quotas: [api], timeoutMs: 9 });
    expect(resourcesOf(cloneStep(step, { id: 's3' }))!.quotas![0]).toBe(api);
    expect(resourcesOf(mastraCloneStep(step as never, { id: 's4' }))).toBeUndefined();
  });
});

describe('createStep(agent | tool, { uses, timeout })', () => {
  const agent = () => new Agent({ id: 'stubby', name: 'stubby', instructions: 'be brief', model: {} as never });
  const tool = createTool({
    id: 'double',
    description: 'doubles x',
    inputSchema: z.object({ x: z.number() }),
    outputSchema: z.object({ y: z.number() }),
    execute: async (input) => ({ y: input.x * 2 }),
  });

  it('an agent: resources on the Step and on the options Mastra keeps, which no longer carry the keys', () => {
    const db = limit(1, { id: 'db' });
    const options = { retries: 2, uses: [db], timeout: 40 };
    const step = createStep(agent(), options) as unknown as { __agentOptions: Record<string, unknown> };
    expect(resourcesOf(step)).toEqual({ quotas: [db], timeoutMs: 40 });
    expect(step.__agentOptions).toEqual({ retries: 2 });
    expect(resourcesOf(step.__agentOptions)).toEqual({ quotas: [db], timeoutMs: 40 });
    expect(options).toEqual({ retries: 2, uses: [db], timeout: 40 }); // the author's object is untouched
  });

  it('a tool: the same, and the declarative step-flow entry carries them on its options', () => {
    const api = rateLimit(1, 10, { id: 'api' });
    const step = createStep(tool, { retries: 1, uses: [api] });
    expect((step as unknown as { __toolOptions: unknown }).__toolOptions).toEqual({ retries: 1 });
    const wf = createWorkflow({ id: 'w', inputSchema: z.object({ x: z.number() }), outputSchema: z.any() }).then(step).commit();
    const entry = wf.buildExecutionGraph().steps[0] as { type: string; options?: unknown };
    expect(entry.type).toBe('tool');
    expect(resourcesOf(entry.options)).toEqual({ quotas: [api] });
  });

  it('options without uses/timeout reach Mastra as the very object given', () => {
    const options = { retries: 3 };
    const step = createStep(agent(), options) as unknown as { __agentOptions: unknown };
    expect(step.__agentOptions).toBe(options);
    expect(resourcesOf(step)).toBeUndefined();
  });

  it('cloneStep keeps an agent step\'s resources (Mastra\'s clone drops __agentOptions)', () => {
    const db = limit(4, { id: 'db' });
    const clone = cloneStep(createStep(agent(), { uses: [db], timeout: 7 }), { id: 'again' });
    expect((clone as unknown as { __agentOptions?: unknown }).__agentOptions).toBeUndefined();
    expect(resourcesOf(clone)).toEqual({ quotas: [db], timeoutMs: 7 });
  });
});

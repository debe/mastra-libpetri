import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { InMemoryStore } from '@mastra/core/storage';
import { Mastra } from '@mastra/core/mastra';
import { createStep as mastraCreateStep, createWorkflow as mastraCreateWorkflow } from '@mastra/core/workflows';
import { adaptExecutionGraph, init } from '../../src/mastra/index.js';
import type { DecisionEntryOptions, ExecutionGraph, PetriQuorum, PetriRace } from '../../src/mastra/index.js';
import { BLOCK_DECISION, Decision, decisionOf, quorum as quorumImpl, race as raceImpl } from '../../src/mastra/resources.js';

/**
 * The Layer 3 surface of [ADR 0014] (M7b W1 D): `init().race` / `init().quorum`, which return
 * `[arms, options]` for Mastra's own `.parallel()` with a fresh `metadata` carrying the minted
 * `Decision` under a symbol; the factories' own refusals; the brand gate, checked by `npm run check`
 * through `@ts-expect-error`; and the Layer test — the same workflow on Mastra's default engine runs
 * as a plain `.parallel()`.
 *
 * Each case notes the mutation that breaks it.
 */

const num = z.object({ n: z.number() });
const { createStep, createWorkflow, race, quorum } = init({ iterationBound: 3 });
const mk = (id: string) => createStep({ id, inputSchema: num, outputSchema: num, execute: async ({ inputData }) => ({ n: inputData.n + 1 }) });
const decisionIn = (options: DecisionEntryOptions): Decision => options.metadata[BLOCK_DECISION];

describe('race and quorum', () => {
  it('are on init(), the module\'s own functions', () => {
    // Breaks if: init() stops returning them, or wraps them in something else.
    expect(race).toBe(raceImpl as unknown as PetriRace);
    expect(quorum).toBe(quorumImpl as unknown as PetriQuorum);
  });

  it('return the very arms and options carrying one minted Decision over them', () => {
    // Breaks if: the arms are copied, the decision drops an arm, or k is not 1 for race.
    const a = mk('a'), b = mk('b');
    const arms = [a, b] as const;
    const [out, options] = race(arms, { id: 'fastest', description: 'first wins' });
    expect(out).toBe(arms);
    expect(options.id).toBe('fastest');
    expect(options.description).toBe('first wins');
    const decision = decisionIn(options);
    expect(decision).toBeInstanceOf(Decision);
    expect([decision.kind, decision.k, decision.n]).toEqual(['race', 1, 2]);
    expect(decision.arms[0]).toBe(a);
    expect(decision.arms[1]).toBe(b);
    expect(Object.isFrozen(decision) && Object.isFrozen(decision.arms)).toBe(true);
    const q = decisionIn(quorum(2, [mk('x'), mk('y'), mk('z')])[1]);
    expect([q.kind, q.k, q.n]).toEqual(['quorum', 2, 3]);
  });

  it('copy the author\'s metadata into a fresh object, keeping its keys, and never write to it', () => {
    // Breaks if: mint writes the symbol into the author's object, or drops their keys.
    const metadata = { concurrency: 2, note: 'mine' };
    const [, options] = quorum(1, [mk('a'), mk('b')], { metadata });
    expect(options.metadata).not.toBe(metadata);
    expect(options.metadata).toMatchObject({ concurrency: 2, note: 'mine' });
    expect(Object.getOwnPropertySymbols(metadata)).toEqual([]);
    expect(decisionOf(options.metadata)).toBeInstanceOf(Decision);
  });

  it('omit id and description when not given, so Mastra keeps its own defaults', () => {
    // Breaks if: mint writes `id: undefined` (Mastra's toEntryOptionFields would still skip it, but the
    // options would no longer be what was asked for).
    const [, options] = race([mk('a')]);
    expect(Object.keys(options)).toEqual(['metadata']);
  });

  it('a race is a quorum of one', () => {
    // Breaks if: race mints any k but 1.
    const arms = [mk('a'), mk('b'), mk('c')];
    expect(decisionIn(race(arms)[1]).k).toBe(decisionIn(quorum(1, arms)[1]).k);
  });

  it('refuse no arms (race-empty), k outside [1, n] (quorum-value), an arm twice (blueprint-arms)', () => {
    // Breaks if: any of mint's three checks is dropped or reordered.
    expect(() => race([])).toThrow(/^race: race-empty/);
    expect(() => quorum(1, [], { id: 'q' })).toThrow(/^quorum\('q'\): race-empty/);
    for (const k of [0, -1, 3, 1.5, Number.NaN, Infinity, '1' as unknown as number]) {
      expect(() => quorum(k, [mk('a'), mk('b')]), String(k)).toThrow(/quorum-value: k must be a whole number in \[1, 2\]/);
    }
    const a = mk('a');
    expect(() => race([a, a])).toThrow(/blueprint-arms: arm 1 is the same step as arm 0/);
    expect(() => race([mk('a'), mk('a')])).toThrow(/blueprint-arms: two arms have the id "a"/);
    expect(() => race('ab' as never)).toThrow(/blueprint-arms: the arms must be an array/);
  });

  it('a Decision cannot be constructed directly', () => {
    // Breaks if: the constructor guard is removed.
    expect(() => new Decision(Symbol('x') as never, 'race', 1, [])).toThrow(TypeError);
  });

  it('decisionOf reads only the symbol key', () => {
    // Breaks if: decisionOf reads a string key, or throws on a non-object.
    expect(decisionOf(undefined)).toBeUndefined();
    expect(decisionOf({ decision: { k: 1 } })).toBeUndefined();
    expect(decisionOf({ [BLOCK_DECISION]: 'x' })).toBe('x');
  });
});

describe('the brand gate (checked by npm run check)', () => {
  it('a default-engine step is not a petri arm, and a petri race does not fit a default workflow', () => {
    const plain = mastraCreateStep({ id: 'plain', inputSchema: num, outputSchema: num, execute: async ({ inputData }) => inputData });
    // @ts-expect-error — race takes PetriStep arms; Mastra's own createStep brands DefaultEngineType.
    race([plain, mk('b')]);
    // @ts-expect-error — the same for quorum.
    quorum(1, [plain]);
    // @ts-expect-error — the default engine's .parallel() takes no petri arms.
    mastraCreateWorkflow({ id: 'd', inputSchema: num, outputSchema: z.any() }).parallel(...race([mk('a'), mk('b')]));
    // And the petri workflow takes the spread as it is.
    const ok = createWorkflow({ id: 'p', inputSchema: num, outputSchema: z.any() }).parallel(...race([mk('a'), mk('b')]));
    expect(ok).toBeDefined();
  });
});

describe('the Layer test: a race on the default engine', () => {
  it('runs exactly as its plain .parallel() twin — every arm runs, every key present — and serializes the same', async () => {
    // Breaks if: the decision rides anywhere the default engine or the serialized graph sees it
    // (a string metadata key, an enumerable `decision` on the options), or race changes the arms.
    const ran: Record<string, string[]> = {};
    const arm = (id: string, run: string, ms: number) =>
      createStep({
        id,
        inputSchema: num,
        outputSchema: num,
        execute: async ({ inputData }) => {
          await new Promise((r) => setTimeout(r, ms));
          (ran[run] ??= []).push(id);
          return { n: inputData.n + ms };
        },
      });
    const next = (run: string) =>
      createStep({
        id: 'next',
        inputSchema: z.object({ fast: num.optional(), slow: num.optional() }),
        outputSchema: num,
        execute: async ({ inputData }) => ({ n: (inputData.fast?.n ?? 0) + (inputData.slow?.n ?? 0) + (ran[run]?.length ?? 0) }),
      });
    const build = (id: string, raced: boolean) => {
      const arms = [arm('fast', id, 1), arm('slow', id, 15)] as const;
      const options = raced ? race(arms, { id: 'pick', metadata: { concurrency: 2 } })[1] : { id: 'pick', metadata: { concurrency: 2 } };
      // Built on Mastra's own createWorkflow: what a forced run of a petri workflow on the default
      // engine amounts to (the brand makes this a type error, hence the casts).
      return (mastraCreateWorkflow({ id, inputSchema: num, outputSchema: z.any() }) as unknown as {
        parallel(steps: readonly unknown[], options: unknown): { then(step: unknown): { commit(): unknown } };
      })
        .parallel(arms, options)
        .then(next(id))
        .commit() as ReturnType<typeof mastraCreateWorkflow>;
    };
    const raced = build('raced', true);
    const plain = build('plain', false);
    const mastra = new Mastra({ storage: new InMemoryStore(), workflows: { raced, plain }, logger: false });
    const runs = [];
    for (const id of ['raced', 'plain'] as const) {
      const r = await (await mastra.getWorkflow(id).createRun()).start({ inputData: { n: 1 } });
      const steps = r.steps as Record<string, { status: string; output?: unknown }>;
      runs.push({
        status: r.status,
        result: r.status === 'success' ? r.result : undefined,
        steps: Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, [v.status, v.output]])),
      });
    }
    const [x, y] = runs;
    expect(x!.status).toBe('success');
    expect(x).toEqual(y);
    // The slow arm ran to completion and the next step saw both keys: no preemption here.
    expect(x!.steps).toMatchObject({ fast: ['success', { n: 2 }], slow: ['success', { n: 16 }] });
    expect(x!.result).toEqual({ n: 2 + 16 + 2 });
    // The serialized graph carries no trace of the decision.
    const serialized = (w: unknown) => JSON.stringify((w as { serializedStepGraph: unknown }).serializedStepGraph).replaceAll(/"(raced|plain)"/g, '"w"');
    expect(serialized(raced)).toBe(serialized(plain));
    // And the adapter reads the decision off the very same workflow — and none off its twin.
    const adapt = (w: unknown) => adaptExecutionGraph((w as { buildExecutionGraph(): ExecutionGraph }).buildExecutionGraph(), { iterationBound: 3 });
    expect(adapt(raced).entries[0]).toMatchObject({ kind: 'parallel', id: 'pick', concurrency: 2, decision: { k: 1 } });
    expect('decision' in adapt(plain).entries[0]!).toBe(false);
  });
});

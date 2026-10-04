/**
 * **Layer 2 is ignorable** ([ADR 0002], [ADR 0011]): every annotation this engine reads from a
 * block's `metadata` — each key of `LAYER2_METADATA_KEYS` — and the engine's own run-wide
 * `concurrency` option leave a workflow meaning the same thing on Mastra's `DefaultExecutionEngine`.
 *
 * Per annotation, three variants — a block that succeeds, one whose first arm fails, and one that
 * suspends and is resumed — each run three ways through a real `Mastra` over an `InMemoryStore`:
 *
 * - the annotated workflow on the default engine,
 * - its unannotated twin on the default engine,
 * - the annotated workflow on the petri engine.
 *
 * The default engine's annotated run returns what its twin returns, phase by phase — status, result,
 * error, and every step record's status and data — and the petri run returns the same. Peak steps in
 * flight is `n` (every arm) on the default engine, annotated or not, and at most the bound on the
 * petri engine, exactly the bound where it binds.
 *
 * Environment: `@mastra/core` from the pinned registry package, libpetri 8.0.0 (registry, not
 * linked), the machine clock; every arm waits a real timer, so the default engine's overlap is the
 * block's width rather than an accident of microtask order. Tested, not proven.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { LAYER2_METADATA_KEYS, type Layer2MetadataKey } from '../../src/mastra/adapt.js';
import { PetriExecutionEngine, type PetriEngineOptions } from '../../src/mastra/engine.js';

const N = z.object({ n: z.number() });
type N = z.infer<typeof N>;
const Add = z.object({ add: z.number() });
const Ask = z.object({ ask: z.string() });

/** Arms per block: `n`, which the default engine overlaps in full. */
const ARMS = 4;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One annotation under test. `metadata` goes on the block's own options; `engine` configures the
 * petri engine only (the default engine has no such option); `bound` is what the petri engine must
 * respect — `ARMS` when the annotation bounds nothing.
 */
interface Annotation {
  readonly name: string;
  readonly metadata?: Record<string, unknown>;
  readonly engine?: Partial<PetriEngineOptions>;
  readonly bound: number;
}

/**
 * One case per `LAYER2_METADATA_KEYS` entry — a meta-assertion below fails when a key lacks one —
 * plus the engine's run-wide `concurrency`, which a workflow does not carry at all.
 */
const METADATA_CASES: Readonly<Record<Layer2MetadataKey, Annotation>> = {
  // ADR 0010: a restart point. It bounds nothing; it must change nothing either.
  checkpoint: { name: 'metadata.checkpoint', metadata: { checkpoint: true }, bound: ARMS },
  // ADR 0011: at most c arms at once.
  concurrency: { name: 'metadata.concurrency', metadata: { concurrency: 2 }, bound: 2 },
};
const ENGINE_CASE: Annotation = { name: 'engine concurrency', engine: { concurrency: 2 }, bound: 2 };
const CASES: readonly Annotation[] = [...Object.values(METADATA_CASES), ENGINE_CASE];

type Variant = 'succeeds' | 'failing-arm' | 'suspend-resume';
const VARIANTS: readonly Variant[] = ['succeeds', 'failing-arm', 'suspend-resume'];

/** Steps in flight within one run: every arm counts itself in and out around its timer. */
class InFlight {
  #now = 0;
  peak = 0;
  async around<T>(body: () => Promise<T>): Promise<T> {
    this.#now += 1;
    this.peak = Math.max(this.peak, this.#now);
    try {
      return await body();
    } finally {
      this.#now -= 1;
    }
  }
}

function build(variant: Variant, metadata: Record<string, unknown> | undefined, engine: Partial<PetriEngineOptions> | undefined, flight: InFlight) {
  const arm = (id: string, factor: number) =>
    createStep({
      id,
      inputSchema: N,
      outputSchema: N,
      execute: async ({ inputData }) => flight.around(async () => (await delay(4), { n: inputData.n * factor })),
    });
  const bad = createStep({
    id: 'bad',
    inputSchema: N,
    outputSchema: N,
    execute: async (): Promise<N> =>
      flight.around(async () => {
        await delay(2);
        throw new Error('bad failed');
      }),
  });
  const gate = (id: string) =>
    createStep({
      id,
      inputSchema: N,
      outputSchema: N,
      resumeSchema: Add,
      suspendSchema: Ask,
      execute: async ({ inputData, resumeData, suspend }) =>
        flight.around(async () => {
          await delay(4);
          if (!resumeData) return suspend({ ask: id });
          return { n: inputData.n + resumeData.add };
        }),
    });
  const arms =
    variant === 'succeeds'
      ? [arm('a1', 1), arm('a2', 2), arm('a3', 3), arm('a4', 4)]
      : variant === 'failing-arm'
        ? [bad, arm('a2', 2), arm('a3', 3), arm('a4', 4)]
        : [gate('g1'), arm('a2', 2), gate('g3'), arm('a4', 4)];
  const sum = createStep({
    id: 'sum',
    inputSchema: z.record(z.string(), N),
    outputSchema: N,
    execute: async ({ inputData }) => ({ n: Object.values(inputData).reduce((acc, v) => acc + v.n, 0) }),
  });
  return createWorkflow({
    id: 'layer2',
    inputSchema: N,
    outputSchema: z.any(),
    ...(engine === undefined ? {} : { executionEngine: new PetriExecutionEngine(engine) }),
  })
    .then(createStep({ id: 'pre', inputSchema: N, outputSchema: N, execute: async ({ inputData }) => ({ n: inputData.n + 1 }) }))
    .parallel(arms, metadata === undefined ? {} : { metadata })
    .then(sum)
    .commit();
}

/** What a phase returned, without clock stamps or run ids: status, result, error, every step record. */
function view(result: unknown): unknown {
  const r = result as { status: string; result?: unknown; error?: unknown; steps: Record<string, Record<string, unknown>> };
  const steps = Object.fromEntries(
    Object.entries(r.steps)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, s]) => [
        id,
        {
          status: s['status'],
          payload: s['payload'],
          ...('output' in s ? { output: s['output'] } : {}),
          ...('resumePayload' in s ? { resumePayload: s['resumePayload'] } : {}),
          ...(s['error'] === undefined ? {} : { error: (s['error'] as { message?: unknown }).message ?? s['error'] }),
          ...(s['suspendPayload'] === undefined ? {} : { suspendPayload: { ask: (s['suspendPayload'] as { ask?: unknown }).ask } }),
        },
      ]),
  );
  return {
    status: r.status,
    ...(r.result === undefined ? {} : { result: r.result }),
    ...(r.error === undefined ? {} : { error: (r.error as { message?: unknown }).message ?? r.error }),
    steps,
  };
}

interface Observed {
  readonly phases: readonly unknown[];
  readonly peak: number;
}

/** Start, then (for the suspend variant) resume each gate in turn; one Mastra, one store. */
async function observe(variant: Variant, metadata: Record<string, unknown> | undefined, engine: Partial<PetriEngineOptions> | undefined): Promise<Observed> {
  const flight = new InFlight();
  const workflow = build(variant, metadata, engine, flight);
  const mastra = new Mastra({ storage: new InMemoryStore(), workflows: { layer2: workflow }, logger: false });
  const registered = mastra.getWorkflow('layer2');
  const runId = 'layer2-run';
  const phases: unknown[] = [];
  phases.push(view(await (await registered.createRun({ runId })).start({ inputData: { n: 1 } })));
  if (variant === 'suspend-resume') {
    for (const [step, add] of [['g3', 30], ['g1', 10]] as const) {
      const run = await registered.createRun({ runId });
      phases.push(view(await run.resume({ step, resumeData: { add } })));
    }
  }
  return { phases, peak: flight.peak };
}

describe('the Layer 2 table', () => {
  it('has a case for every key of LAYER2_METADATA_KEYS, and no other', () => {
    expect(Object.keys(METADATA_CASES).sort()).toEqual([...LAYER2_METADATA_KEYS].sort());
    for (const key of LAYER2_METADATA_KEYS) expect(Object.keys(METADATA_CASES[key].metadata ?? {})).toEqual([key]);
  });
});

/** What each variant must end as on the default engine, so a broken fixture cannot pass by agreeing. */
const EXPECTED: Readonly<Record<Variant, readonly string[]>> = {
  succeeds: ['success'],
  'failing-arm': ['failed'],
  'suspend-resume': ['suspended', 'suspended', 'success'],
};

for (const annotation of CASES) {
  describe(`${annotation.name}: ignorable on the default engine, enforced on the petri engine`, () => {
    for (const variant of VARIANTS) {
      it(variant, async () => {
        const annotatedDefault = await observe(variant, annotation.metadata, undefined);
        const twinDefault = await observe(variant, undefined, undefined);
        const petri = await observe(variant, annotation.metadata, { ...annotation.engine });

        // The oracle exercised what the variant means.
        expect(annotatedDefault.phases.map((p) => (p as { status: string }).status)).toEqual(EXPECTED[variant]);

        // Ignorable: the annotated workflow on Mastra's engine is its unannotated twin, phase by phase.
        expect(annotatedDefault.phases).toEqual(twinDefault.phases);
        // And the petri engine returns the same, annotated.
        expect(petri.phases).toEqual(annotatedDefault.phases);

        // Every arm ran on every side — no fail-fast, nothing skipped.
        const steps = (o: Observed) => Object.keys((o.phases.at(-1) as { steps: object }).steps).sort();
        expect(steps(petri)).toEqual(steps(annotatedDefault));
        expect(steps(annotatedDefault).filter((s) => /^(a\d|g\d|bad)$/.test(s))).toHaveLength(ARMS);

        // Unenforced on Mastra's engine: every arm at once, annotated or not.
        expect(annotatedDefault.peak).toBe(ARMS);
        expect(twinDefault.peak).toBe(ARMS);
        // Enforced here: never above the bound, and exactly it where it binds.
        expect(petri.peak).toBeLessThanOrEqual(annotation.bound);
        expect(petri.peak).toBe(annotation.bound);
      });
    }
  });
}

/**
 * **What follows a race** ([ADR 0014], rows 103 and 61): a `race` / `quorum(k)` block followed by
 * `.then(next)`, run through Mastra's `Run` on `PetriExecutionEngine` over a real `Mastra` and
 * `InMemoryStore`, with real Mastra steps (`MastraStepRunner` on Mastra's `StepExecutor`) and the
 * real decision gadget, leaf and run scope.
 *
 * - **Output rule** (row 103): the next entry gets every declared arm from the step records, as
 *   after any `.parallel()`. A loser's key holds `undefined`, so under `validateInputs` (Mastra's
 *   default, `workflow.ts:1806`) the next step's input schema must make every arm key optional. With
 *   the keys optional, `next` runs and sees the winners' outputs; with them required, the run fails
 *   in `next` with Mastra's own `validateStepInput` error (`utils.ts:63-75`). Both are compared with
 *   Mastra's default engine running a plain `.parallel()` whose third arm returns `undefined`, the
 *   same input `next` gets after a race.
 * - **A forced `cloneWorkflow`** (ADR 0014 Consequences, row 61): Mastra's `cloneWorkflow`
 *   (`create.ts:105-135`) builds a `new Workflow` with no `executionEngine`, so the clone of a petri
 *   workflow runs on `DefaultExecutionEngine`, over the same step graph — the decision still rides
 *   in the `.parallel()` entry's `metadata`, which that engine ignores. The race runs as a plain
 *   `.parallel()`: every arm runs to `success`, every key is present. The Layer test survives
 *   cloning.
 *
 * Environment: `@mastra/core` from the pinned registry package, libpetri 8.0.0 (registry, not
 * linked), the system clock (real milliseconds, small). Tested, not proven: these are values the
 * value-blind verifier cannot see. Each case names the mutation that breaks it.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import {
  cloneWorkflow,
  createStep as mastraCreateStep,
  createWorkflow as mastraCreateWorkflow,
} from '@mastra/core/workflows';
import { init } from '../../src/mastra/index.js';
import { decisionOf } from '../../src/mastra/resources.js';

const N = z.object({ n: z.number() });
const ANY = z.any();
/** `next`'s input with every arm key optional, as row 103 asks. */
const OPTIONAL = z.object({ fast: N.optional(), mid: N.optional(), slow: N.optional() });
/** `next`'s input with every arm key required: a loser's `undefined` fails it. */
const REQUIRED = z.object({ fast: N, mid: N, slow: N });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** Resolves when `signal` aborts (at once if it already has). */
function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

/** Registers `workflows` on a fresh Mastra over a fresh store. */
function host(workflows: Record<string, unknown>) {
  const storage = new InMemoryStore();
  const mastra = new Mastra({ storage, workflows: workflows as never, logger: false });
  const get = (id: string) =>
    (mastra as unknown as { getWorkflow(id: string): { createRun(o?: { runId?: string }): Promise<RunLike> } }).getWorkflow(id);
  return { get };
}
interface RunLike {
  start(o: { inputData: unknown; initialState?: unknown }): Promise<RunResult>;
}
interface RunResult {
  readonly status: string;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly steps: Record<string, { status: string; output?: unknown; error?: unknown }>;
}
const errorName = (record: { error?: unknown } | undefined): unknown => (record?.error as { name?: unknown } | undefined)?.name;
const message = (error: unknown): string => (typeof error === 'object' && error !== null ? String((error as { message?: unknown }).message) : String(error));
const run = async (id: string, workflow: unknown): Promise<RunResult> => {
  const { get } = host({ [id]: workflow });
  return (await get(id).createRun()).start({ inputData: { n: 1 } });
};

/**
 * The three arms, for either factory. `fast` settles at once, `mid` after `ms.mid` (10 ms), `slow`
 * after `ms.slow` (40 ms), each unless its signal aborts first (a cooperative loser). On the default
 * engine nothing aborts them, so every arm succeeds. A race's losers are given 1 s, which the abort
 * cuts short: a loaded runner cannot let one settle before the decision and become a surplus success.
 */
const LOSERS = { mid: 1000, slow: 1000 } as const;
function arms(step: (o: never) => unknown, ms: { readonly mid: number; readonly slow: number } = { mid: 10, slow: 40 }) {
  const arm = (id: string, add: number, ms: number) =>
    step({
      id,
      inputSchema: N,
      outputSchema: N,
      execute: async ({ inputData, abortSignal }: { inputData: { n: number }; abortSignal: AbortSignal }) => {
        if (ms > 0) await Promise.race([sleep(ms), aborted(abortSignal)]);
        return { n: inputData.n + add };
      },
    } as never);
  return { fast: arm('fast', 1, 0), mid: arm('mid', 10, ms.mid), slow: arm('slow', 100, ms.slow) };
}

/** A `next` step that records the input it was handed, after validation. */
function nextStep(step: (o: never) => unknown, inputSchema: z.ZodType) {
  const seen: unknown[] = [];
  const next = step({
    id: 'next',
    inputSchema,
    outputSchema: ANY,
    execute: async ({ inputData }: { inputData: unknown }) => {
      seen.push(inputData);
      return { got: inputData };
    },
  } as never);
  return { seen, next };
}

type Chain = { parallel(...a: unknown[]): Chain; then(s: unknown): Chain; commit(): unknown };

/**
 * The default-engine oracle: a plain `.parallel([fast, mid, gone])` whose `gone` arm (id `slow`)
 * returns `undefined`, so `next` is handed `{ fast, mid, slow: undefined }` — what a race with
 * `slow` preempted hands it.
 */
function oracle(inputSchema: z.ZodType) {
  const { fast, mid } = arms(mastraCreateStep as never);
  const gone = mastraCreateStep({ id: 'slow', inputSchema: N, outputSchema: ANY, execute: async () => undefined });
  const { seen, next } = nextStep(mastraCreateStep as never, inputSchema);
  const workflow = (mastraCreateWorkflow({ id: 'oracle', inputSchema: N, outputSchema: ANY, options: { validateInputs: true } }) as unknown as Chain)
    .parallel([fast, mid, gone])
    .then(next)
    .commit();
  return { seen, workflow };
}

describe('race, then next, under validateInputs', () => {
  it('next with every arm key optional runs and sees the winner under its key, the losers undefined', async () => {
    // Mutation: the join handing `next` the winners only, or the `won` token's data (A's rejected
    // output rule) -> `mid` / `slow` keys absent from the input the default engine's oracle shows;
    // or a loser's record keeping an `output` -> `slow` defined.
    const { createWorkflow, createStep, race } = init();
    const { fast, mid, slow } = arms(createStep as never, LOSERS);
    const { seen, next } = nextStep(createStep as never, OPTIONAL);
    const workflow = (createWorkflow({ id: 'opt', inputSchema: N, outputSchema: ANY, options: { validateInputs: true } }) as unknown as Chain)
      .parallel(...race([fast, mid, slow] as never, { id: 'pick' }))
      .then(next)
      .commit();
    expect((workflow as { options: { validateInputs: boolean } }).options.validateInputs).toBe(true);
    const result = await run('opt', workflow);
    expect(result.status).toBe('success');
    expect(result.steps['fast']).toMatchObject({ status: 'success', output: { n: 2 } });
    expect(result.steps['mid']!.status).toBe('canceled');
    expect(result.steps['slow']!.status).toBe('canceled');
    expect(errorName(result.steps['slow'])).toBe('StepPreemptedError');
    expect(seen).toHaveLength(1);
    const input = seen[0] as Record<string, unknown>;
    expect(input['fast']).toEqual({ n: 2 });
    expect(input['mid']).toBeUndefined();
    expect(input['slow']).toBeUndefined();
    expect(result.steps['next']).toMatchObject({ status: 'success' });
    expect(result.result).toEqual({ got: input });

    // The default engine, handed the same shape by a plain `.parallel()`, gives `next` the same keys.
    const want = oracle(OPTIONAL);
    const got = await run('oracle', want.workflow);
    expect(got.status).toBe('success');
    const oracleInput = want.seen[0] as Record<string, unknown>;
    expect(oracleInput['slow']).toBeUndefined();
    expect(Object.keys(input).sort()).toEqual(Object.keys(oracleInput).sort());
    expect(Object.keys(input).sort()).toEqual(['fast', 'mid', 'slow']);
  });

  it('next with every arm key required fails the run with Mastra\'s input validation error naming a loser', async () => {
    // Mutation: the runner skipping `validateStepInput` (or passing `validateInputs: false`) -> next
    // runs with `slow: undefined` and the run succeeds; or the join filling a loser's key with a
    // stale or placeholder output -> validation passes.
    const { createWorkflow, createStep, race } = init();
    const { fast, mid, slow } = arms(createStep as never, LOSERS);
    const { seen, next } = nextStep(createStep as never, REQUIRED);
    const workflow = (createWorkflow({ id: 'req', inputSchema: N, outputSchema: ANY, options: { validateInputs: true } }) as unknown as Chain)
      .parallel(...race([fast, mid, slow] as never, { id: 'pick' }))
      .then(next)
      .commit();
    const result = await run('req', workflow);
    expect(result.status).toBe('failed');
    expect(seen).toHaveLength(0); // never ran
    expect(result.steps['fast']!.status).toBe('success');
    expect(result.steps['next']!.status).toBe('failed');
    const text = message(result.error);
    expect(text).toContain('Step input validation failed');
    expect(text).toContain('slow');
    expect(text).toContain('mid');

    // The default engine fails the same `next` on the same shape with the same kind of message.
    const want = oracle(REQUIRED);
    const got = await run('oracle', want.workflow);
    expect(got.status).toBe('failed');
    expect(got.steps['next']!.status).toBe('failed');
    expect(message(got.error)).toContain('Step input validation failed');
    expect(message(got.error)).toContain('slow');
  });
});

describe('quorum, then next', () => {
  it('quorum(2) of 3: next receives both winners; the loser is undefined and recorded canceled', async () => {
    // Mutation: `met` firing on one success (k ignored), or the join reading only the first winner
    // -> `mid` absent or `undefined` in next's input; `slow` not preempted -> its record `success`.
    const { createWorkflow, createStep, quorum } = init();
    const { fast, mid, slow } = arms(createStep as never, { mid: 10, slow: LOSERS.slow });
    const { seen, next } = nextStep(createStep as never, OPTIONAL);
    const workflow = (createWorkflow({ id: 'q2', inputSchema: N, outputSchema: ANY, options: { validateInputs: true } }) as unknown as Chain)
      .parallel(...quorum(2, [fast, mid, slow] as never, { id: 'two' }))
      .then(next)
      .commit();
    const result = await run('q2', workflow);
    expect(result.status).toBe('success');
    expect(result.steps['fast']).toMatchObject({ status: 'success', output: { n: 2 } });
    expect(result.steps['mid']).toMatchObject({ status: 'success', output: { n: 11 } });
    expect(result.steps['slow']!.status).toBe('canceled');
    expect(errorName(result.steps['slow'])).toBe('StepPreemptedError');
    expect(seen).toHaveLength(1);
    const input = seen[0] as Record<string, unknown>;
    expect(input['fast']).toEqual({ n: 2 });
    expect(input['mid']).toEqual({ n: 11 });
    expect(input['slow']).toBeUndefined();
    expect(Object.keys(input).sort()).toEqual(['fast', 'mid', 'slow']); // present, not just undefined
  });
});

describe('a forced cloneWorkflow of a petri race', () => {
  it('runs on the default engine as a plain .parallel(): every arm runs, every key present', async () => {
    // Mutation: the decision carried anywhere the default engine reads (the entry's `type`, the
    // serialized graph, the step list) -> the clone refuses, or runs something other than a plain
    // parallel; `cloneWorkflow` keeping the petri engine -> `slow` canceled on the clone.
    const { createWorkflow, createStep, race } = init();
    const { fast, mid, slow } = arms(createStep as never);
    const { seen, next } = nextStep(createStep as never, OPTIONAL);
    const raced = (createWorkflow({ id: 'raced', inputSchema: N, outputSchema: ANY, options: { validateInputs: true } }) as unknown as Chain)
      .parallel(...race([fast, mid, slow] as never, { id: 'pick' }))
      .then(next)
      .commit();
    // Past the type checker: the types refuse a petri workflow here (row 61).
    const clone = (cloneWorkflow as unknown as (w: unknown, o: { id: string }) => unknown)(raced, { id: 'cloned' }) as {
      engineType: string;
      executionEngine: { constructor: { name: string } };
      stepGraph: readonly { type: string; metadata?: unknown }[];
    };
    expect(clone.engineType).toBe('default');
    expect(clone.executionEngine.constructor.name).toBe('DefaultExecutionEngine');
    // The mark rides along in the entry's metadata, which the default engine ignores.
    expect(clone.stepGraph[0]!.type).toBe('parallel');
    expect(decisionOf(clone.stepGraph[0]!.metadata)).toBeDefined();

    const result = await run('cloned', clone);
    expect(result.status).toBe('success');
    expect(result.steps['fast']).toMatchObject({ status: 'success', output: { n: 2 } });
    expect(result.steps['mid']).toMatchObject({ status: 'success', output: { n: 11 } });
    expect(result.steps['slow']).toMatchObject({ status: 'success', output: { n: 101 } });
    expect(seen).toEqual([{ fast: { n: 2 }, mid: { n: 11 }, slow: { n: 101 } }]);

    // The original, on the petri engine, still races.
    seen.length = 0;
    const original = await run('raced', raced);
    expect(original.status).toBe('success');
    expect(original.steps['slow']!.status).toBe('canceled');
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0] as object).sort()).toEqual(['fast', 'mid', 'slow']);
    expect((seen[0] as Record<string, unknown>)['slow']).toBeUndefined();
  });
});

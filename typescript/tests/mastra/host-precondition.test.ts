import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { PetriExecutionEngine } from '../../src/mastra/engine.js';

/**
 * A host precondition refused on resume from inside a block (row 84): a step whose stored suspend
 * payload is a truthy primitive cannot be resumed — Mastra's `'__workflow_meta' in suspendData`
 * throws a `TypeError` before the step runs (`handlers/step.ts:160`). The runner raises it as a
 * `HostPreconditionError`, the leaf routes it out by the declared failure branch, and the engine
 * rejects with the cause. Top-level steps and `.foreach()` items are covered in
 * `runner-resume.test.ts`; here, a `.parallel()` arm and a loop body. Each case runs the same
 * workflow on `DefaultExecutionEngine` — the oracle — and on the petri engine, through Mastra's own
 * `Run.start()` / `Run.resume()` with a store.
 */

type Wf = any;
type Ctx = Record<string, any>;
type EngineName = 'default' | 'petri';

const MESSAGE = "Cannot use 'in' operator to search for '__workflow_meta' in why?";

const step = (id: string, fn: (ctx: Ctx) => unknown) =>
  createStep({ id, inputSchema: z.any(), outputSchema: z.any(), execute: async (ctx: unknown) => fn(ctx as Ctx) } as never);

const wf = (id: string, engine: EngineName): Wf =>
  createWorkflow({
    id,
    inputSchema: z.any(),
    outputSchema: z.any(),
    ...(engine === 'petri' ? { executionEngine: new PetriExecutionEngine({ iterationBound: 5 }) } : {}),
  } as never);

interface Settled {
  readonly first: string;
  readonly settled: { readonly resolved: string; readonly error?: unknown } | { readonly rejected: unknown };
  readonly calls: readonly unknown[];
}

async function suspendThenResume(w: Wf, id: string, calls: unknown[], resumeStep: string): Promise<Settled> {
  new Mastra({ storage: new InMemoryStore(), workflows: { [id]: w }, logger: false });
  const run = await w.createRun();
  const first = (await run.start({ inputData: 1 })) as { status: string };
  const settled = await run.resume({ step: resumeStep, resumeData: 'go' }).then(
    (result: { status: string; error?: unknown }) => ({ resolved: result.status, error: result.error }),
    (error: unknown) => ({ rejected: error }),
  );
  return { first: first.status, settled, calls };
}

/** A `.parallel()` of `p` (suspends with a primitive) and `q` (succeeds). */
async function parallelArm(engine: EngineName): Promise<Settled> {
  const calls: unknown[] = [];
  const w = wf('hp-par', engine)
    .parallel([
      step('p', (ctx) => {
        calls.push('p');
        return ctx['resumeData'] ? 'ok' : ctx['suspend']('why?');
      }),
      step('q', () => {
        calls.push('q');
        return 'q';
      }),
    ])
    .commit();
  return suspendThenResume(w, 'hp-par', calls, 'p');
}

/** A `.dountil()` whose body suspends with a primitive on its first iteration. */
async function loopBody(engine: EngineName): Promise<Settled> {
  const calls: unknown[] = [];
  const w = wf('hp-loop', engine)
    .dountil(
      step('body', (ctx) => {
        calls.push('body');
        return ctx['resumeData'] ? 'ok' : ctx['suspend']('why?');
      }),
      async () => true,
    )
    .commit();
  return suspendThenResume(w, 'hp-loop', calls, 'body');
}

function expectRejectedWithTypeError(side: Settled): void {
  expect(side.first).toBe('suspended');
  expect(side.settled).toHaveProperty('rejected');
  const error = (side.settled as { rejected: unknown }).rejected;
  expect(error).toBeInstanceOf(TypeError);
  expect((error as Error).message).toBe(MESSAGE);
}

describe('host preconditions inside a block reject the resume, as on the default engine (row 84)', () => {
  it('a .parallel() arm: oracle and petri reject with the same TypeError, and the arm never runs again', async () => {
    const [o, p] = [await parallelArm('default'), await parallelArm('petri')];
    expectRejectedWithTypeError(o);
    expectRejectedWithTypeError(p);
    // Both arms ran once at start; on resume neither runs: the refusal comes before `p` runs, and
    // `q` succeeded in the first segment.
    expect(o.calls).toStrictEqual(['p', 'q']);
    expect(p.calls).toStrictEqual(o.calls);
  });

  it('a loop body: oracle and petri reject with the same TypeError, and the body never runs again', async () => {
    const [o, p] = [await loopBody('default'), await loopBody('petri')];
    expectRejectedWithTypeError(o);
    expectRejectedWithTypeError(p);
    expect(o.calls).toStrictEqual(['body']);
    expect(p.calls).toStrictEqual(o.calls);
  });
});

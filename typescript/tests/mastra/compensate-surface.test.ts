/**
 * The `compensate` step option's surface ([ADR 0017], M7b W1): where the key goes, what the default
 * engine sees of it, and its types.
 *
 * - **The carrier.** The petri `createStep` attaches the compensator under `STEP_RESOURCES`, by
 *   identity; Mastra's `createStep` builds the Step from a fixed field list (`workflow.ts:510-530`)
 *   and `serializedStepGraph` emits a fixed list (`:629-640`), so the key reaches neither.
 * - **T0, the Layer 3 statement.** A forced `cloneWorkflow` (`create.ts:105-135`) is a `new Workflow`
 *   with no engine — `DefaultExecutionEngine` — over the same step graph, held by reference, so the
 *   compensator still rides on the step, where that engine never looks. On success, failure and
 *   tripwire the clone returns what the same workflow without the key returns: the same status, the
 *   same `error` **shape** (`formatResultError` builds a plain `Object`, `default.ts:613-628`, so
 *   identity is a property of neither run), the same tripwire, the same step records and keys; no
 *   compensator record exists, the compensator never runs, and the effects remain.
 * - **`Undoable`.** The compensator's input must accept the forward step's output, on the params,
 *   agent and tool overloads; a default-engine compensator is a type error (the brand). Checked by
 *   `npm run check` (`@ts-expect-error`).
 *
 * Environment: `@mastra/core` from the pinned registry package (1.67.0), a real `Mastra` over an
 * `InMemoryStore`, the system clock; libpetri 8.0.0 from npm, not linked (only the clone runs, on
 * Mastra's own engine). Tested, not proven. Each case names the mutation that breaks it.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { Agent, TripWire } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { cloneWorkflow, createStep as mastraCreateStep } from '@mastra/core/workflows';
import { init, type PetriStep, type Undoable } from '../../src/mastra/index.js';
import { compensatorOf, STEP_RESOURCES } from '../../src/mastra/resources.js';

const N = z.object({ n: z.number() });
const ANY = z.any();

type Mode = 'success' | 'fail' | 'tripwire';

interface RunResult {
  readonly status: string;
  readonly error?: unknown;
  readonly tripwire?: unknown;
  readonly result?: unknown;
  readonly steps: Record<string, { status: string; output?: unknown; payload?: unknown; error?: unknown; tripwire?: unknown }>;
}
interface Cloned {
  readonly executionEngine: object;
  readonly engineType: string;
  readonly serializedStepGraph: unknown;
  readonly stepGraph: readonly { type: string; step?: object }[];
}

/**
 * `reserve` (compensated by `release` when `keyed`) then `charge`, which succeeds, throws, or trips
 * per `mode`. `effects` is what the steps did to the world; `released` every input `release` saw.
 */
function saga(keyed: boolean, mode: Mode, id: string) {
  const { createStep, createWorkflow } = init();
  const effects: string[] = [];
  const released: unknown[] = [];
  const release = createStep({
    id: 'release',
    inputSchema: N,
    outputSchema: ANY,
    execute: async ({ inputData }) => {
      released.push(inputData);
      effects.splice(effects.indexOf('seat'), 1);
    },
  });
  const reserve = createStep({
    id: 'reserve',
    inputSchema: N,
    outputSchema: N,
    ...(keyed ? { compensate: release } : {}),
    execute: async ({ inputData }) => {
      effects.push('seat');
      return { n: inputData.n + 1 };
    },
  });
  const charge = createStep({
    id: 'charge',
    inputSchema: N,
    outputSchema: N,
    execute: async ({ inputData }) => {
      if (mode === 'fail') throw Object.assign(new Error('card declined'), { code: 'E_DECLINED' });
      if (mode === 'tripwire') throw new TripWire('blocked', { retry: false, metadata: { rule: 'r1' } }, 'proc-1');
      effects.push('charge');
      return inputData;
    },
  });
  const workflow = createWorkflow({ id, inputSchema: N, outputSchema: ANY }).then(reserve).then(charge).commit();
  return { workflow, release, reserve, effects, released };
}

/** Mastra's `cloneWorkflow` of a petri workflow — past the type checker, which refuses it (row 61). */
const clone = (workflow: unknown, id: string): Cloned =>
  (cloneWorkflow as unknown as (w: unknown, o: { id: string }) => Cloned)(workflow, { id });

async function run(id: string, workflow: unknown): Promise<RunResult> {
  const mastra = new Mastra({ storage: new InMemoryStore(), workflows: { [id]: workflow } as never, logger: false });
  const registered = (mastra as unknown as { getWorkflow(id: string): { createRun(): Promise<{ start(o: { inputData: unknown }): Promise<RunResult> }> } }).getWorkflow(id);
  return (await registered.createRun()).start({ inputData: { n: 1 } });
}

/** A run's result without timestamps: what T0 compares. The error by shape — JSON — never by identity. */
function shape(result: RunResult) {
  return {
    status: result.status,
    error: result.error === undefined ? undefined : JSON.parse(JSON.stringify(result.error)),
    tripwire: result.tripwire,
    result: result.result,
    stepKeys: Object.keys(result.steps),
    steps: Object.fromEntries(
      Object.entries(result.steps).map(([k, r]) => [
        k,
        {
          status: r.status,
          output: r.output,
          payload: r.payload,
          error: r.error === undefined ? undefined : JSON.parse(JSON.stringify(r.error)),
          tripwire: r.tripwire,
        },
      ]),
    ),
  };
}

describe('the carrier', () => {
  it('the compensator rides on the Step under STEP_RESOURCES, by identity, and nowhere Mastra reads', () => {
    // Breaks if: init() hands `compensate` to Mastra (a Step key, a serialized-graph field), or
    // attaches a copy instead of the object.
    const { workflow, release, reserve } = saga(true, 'success', 'w');
    expect(compensatorOf(reserve)).toBe(release);
    expect(Object.getOwnPropertyDescriptor(reserve, STEP_RESOURCES)?.enumerable).toBe(false);
    expect(Object.keys(reserve)).not.toContain('compensate');
    expect(JSON.stringify((workflow as unknown as Cloned).serializedStepGraph)).toBe(
      JSON.stringify((saga(false, 'success', 'w').workflow as unknown as Cloned).serializedStepGraph),
    );
  });
});

describe('T0: a forced cloneWorkflow onto DefaultExecutionEngine ignores compensate', () => {
  for (const mode of ['success', 'fail', 'tripwire'] as const) {
    it(`${mode}: the same result as without the key, and nothing undone`, async () => {
      // Breaks if: the key reaches Mastra's step or graph (the clone would differ from its twin), or
      // the symbol is lost on the clone's step (`compensatorOf` below).
      const keyed = saga(true, mode, `keyed-${mode}`);
      const bare = saga(false, mode, `bare-${mode}`);
      const keyedClone = clone(keyed.workflow, `c-keyed-${mode}`);
      const bareClone = clone(bare.workflow, `c-bare-${mode}`);
      expect(keyedClone.executionEngine.constructor.name).toBe('DefaultExecutionEngine');
      expect(keyedClone.engineType).toBe('default');
      // The step graph is held by reference: the compensator is still there, unread.
      expect(compensatorOf(keyedClone.stepGraph[0]!.step)).toBe(keyed.release);
      expect(JSON.stringify(keyedClone.serializedStepGraph)).toBe(JSON.stringify(bareClone.serializedStepGraph));

      const withKey = shape(await run(`c-keyed-${mode}`, keyedClone));
      const without = shape(await run(`c-bare-${mode}`, bareClone));
      expect(withKey).toEqual(without);
      expect(withKey.stepKeys).toEqual(['input', 'reserve', 'charge']);
      expect(withKey.steps).not.toHaveProperty('release');
      expect(keyed.released).toEqual([]);
      expect(keyed.effects).toEqual(bare.effects);
      expect(keyed.effects).toEqual(mode === 'success' ? ['seat', 'charge'] : ['seat']);

      if (mode === 'success') expect(withKey.status).toBe('success');
      if (mode === 'fail') {
        expect(withKey.status).toBe('failed');
        // A plain object of the thrown error's fields, custom ones included — the shape the petri
        // engine must match (decision 2 A).
        expect(withKey.error).toEqual({ name: 'Error', message: 'card declined', code: 'E_DECLINED' });
        expect(withKey.tripwire).toBeUndefined();
      }
      if (mode === 'tripwire') {
        expect(withKey.status).toBe('tripwire');
        expect(withKey.tripwire).toEqual({ reason: 'blocked', retry: false, metadata: { rule: 'r1' }, processorId: 'proc-1' });
        expect(withKey.error).toBeUndefined();
      }
    });
  }

  it('the error is never the thrown instance, on either twin: shape is the property, identity is not', async () => {
    // Breaks if: the comparison above were made by identity — it would fail on Mastra's own engine.
    let thrownError: unknown;
    const { createStep, createWorkflow } = init();
    const boom = createStep({
      id: 'boom',
      inputSchema: N,
      outputSchema: N,
      execute: async () => {
        thrownError = new Error('card declined');
        throw thrownError;
      },
    });
    const w = createWorkflow({ id: 'ident', inputSchema: N, outputSchema: ANY })
      .then(createStep({ id: 'a', inputSchema: N, outputSchema: N, compensate: createStep({ id: 'u', inputSchema: N, outputSchema: ANY, execute: async () => undefined }), execute: async ({ inputData }) => inputData }))
      .then(boom)
      .commit();
    const result = await run('c-ident', clone(w, 'c-ident'));
    expect(result.status).toBe('failed');
    expect(result.error).not.toBe(thrownError);
    expect(Object.getPrototypeOf(result.error)).toBe(Object.prototype);
  });
});

describe('a compensated step used twice, as the compensate-ids refusal says', () => {
  it('cloneStep(step, { id, compensate: cloneStep(compensator, { id }) }): both uses undone, newest first, each with its own output', async () => {
    // Breaks if: the petri cloneStep ignores `compensate` (adapting refuses compensate-ids), or attaches
    // it anywhere the runner does not resolve it (the clone's undo never runs).
    const { createStep, cloneStep, createWorkflow } = init();
    const seen: [string, unknown][] = [];
    const release = createStep({
      id: 'release',
      inputSchema: N,
      outputSchema: ANY,
      execute: async ({ inputData }) => {
        seen.push(['release', inputData]);
      },
    });
    const reserve = createStep({ id: 'reserve', inputSchema: N, outputSchema: N, compensate: release, execute: async ({ inputData }) => ({ n: inputData.n * 10 }) });
    const reserveAgain = cloneStep(reserve, { id: 'reserve-2', compensate: cloneStep(release, { id: 'release-2' }) });
    const charge = createStep({
      id: 'charge',
      inputSchema: N,
      outputSchema: N,
      execute: async () => {
        throw new Error('card declined');
      },
    });
    const w = createWorkflow({ id: 'twice', inputSchema: N, outputSchema: ANY }).then(reserve).then(reserveAgain).then(charge).commit();
    const result = await run('twice', w);
    expect(result.status).toBe('failed');
    // The clone shares release's execute, so both calls land in `seen` under 'release'.
    expect(seen).toEqual([
      ['release', { n: 100 }],
      ['release', { n: 10 }],
    ]);
    expect(result.steps['release-2']?.status).toBe('success');
    expect(result.steps['release']?.status).toBe('success');
  });
});

describe('Undoable', () => {
  it('is checked by npm run check (see surfaceTypes below)', () => {
    expect(typeof surfaceTypes).toBe('function');
  });
});

/**
 * Types only, checked by `npm run check`, never run. Beyond the contract's (`compensate-contract.test.ts`):
 * the agent and tool overloads, a clone as a compensator, and the slot on the forward step's output.
 */
export function surfaceTypes(): void {
  const { createStep, cloneStep } = init();
  const Seat = z.object({ seat: z.string() });
  const Num = z.object({ n: z.number() });
  const release = createStep({ id: 'release', inputSchema: Seat, outputSchema: z.void(), execute: async () => undefined });
  const undoNum = createStep({ id: 'undo-num', inputSchema: Num, outputSchema: z.void(), execute: async () => undefined });
  const undoText = createStep({ id: 'undo-text', inputSchema: z.object({ text: z.string() }), outputSchema: z.void(), execute: async () => undefined });
  const plain = mastraCreateStep({ id: 'plain', inputSchema: Num, outputSchema: z.void(), execute: async () => undefined });

  const tool = createTool({ id: 'double', description: 'doubles n', inputSchema: Num, outputSchema: Num, execute: async (input) => ({ n: input.n * 2 }) });
  const agent = new Agent({ id: 'stubby', name: 'stubby', instructions: 'be brief', model: {} as never });

  // A tool step's output is its outputSchema; an agent step's is `{ text }`.
  createStep(tool, { compensate: undoNum });
  createStep(agent, { compensate: undoText });
  // @ts-expect-error — release takes a Seat; the tool outputs `{ n }`
  createStep(tool, { compensate: release });
  // @ts-expect-error — undo-num takes `{ n }`; an agent step outputs `{ text }`
  createStep(agent, { compensate: undoNum });
  // @ts-expect-error — Mastra's own createStep brands DefaultEngineType: not a petri compensator
  createStep(tool, { compensate: plain });

  // A petri clone is a compensator (its schemas are `any`).
  const release2 = cloneStep(release, { id: 'release-2' });
  createStep({ id: 'reserve', inputSchema: Num, outputSchema: Seat, execute: async () => ({ seat: '1A' }), compensate: release2 });

  // cloneStep takes a replacement compensator, typed against the step's output.
  const reserve = createStep({ id: 'reserve', inputSchema: Num, outputSchema: Seat, execute: async () => ({ seat: '1A' }), compensate: release });
  cloneStep(reserve, { id: 'reserve-2', compensate: release2 });
  cloneStep(reserve, { id: 'reserve-3', compensate: release });
  // @ts-expect-error — undo-num takes `{ n }`; reserve outputs a Seat
  cloneStep(reserve, { id: 'reserve-4', compensate: undoNum });
  // @ts-expect-error — Mastra's own createStep brands DefaultEngineType: not a petri compensator
  cloneStep(reserve, { id: 'reserve-5', compensate: plain });

  const slot: Undoable<{ n: number }> = { compensate: undoNum };
  const asStep: PetriStep<string, any, { n: number }, any, any, any, any> | undefined = slot.compensate;
  void asStep;
}

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createStep as mastraCreateStep } from '@mastra/core/workflows';
import { createTool } from '@mastra/core/tools';
import {
  compile,
  hasCompensation,
  ladderLevel,
  type CompensationSite,
  type CompiledWorkflow,
  type Ladder,
  type LadderArgs,
  type StepDescription,
  type WorkflowDescription,
} from '../../src/compiler/index.js';
import {
  adaptExecutionGraph,
  BLUEPRINT_REFUSALS,
  COMPENSATE_REFUSALS,
  init,
  type ExecutionGraph,
  type PetriStep,
  type Undoable,
} from '../../src/mastra/index.js';
import { compensateStructureViolations, compensatorAttempts } from '../../src/verify/index.js';
import { netDigest, unannotatedShapes, type Shape } from '../fixtures/unannotated-shapes.js';

/**
 * The `compensate` contract ([ADR 0017], M7b W0): the types and stubs W1 builds against. What it pins:
 * an unannotated workflow compiles to the very net, and the very hash, it did before the contract
 * landed, and carries no `compensations`; `compile()` reaches the ladder exactly when some step carries
 * a `compensate`, and its stubs throw where called (the ladder, the seed, the verify side, the petri
 * `createStep`); with a pass-through ladder standing in for W1's, `structuralHash` carries the
 * compensator only when present and `quotaRefsOf` registers a quota only a compensator uses; the five
 * refusal names; and the surface's types — `Undoable` and the brand — as `@ts-expect-error` under
 * `npm run check`.
 */

/**
 * When set, `compensateLadder` is a pass-through ladder (below) instead of the W0 stub: the spine is
 * today's, the site a placeholder. Lets the compile wiring be pinned before W1 builds the net.
 */
const ladderMode = vi.hoisted(() => ({ passThrough: false, calls: 0 }));
vi.mock('../../src/compiler/blueprints/compensate.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/compiler/blueprints/compensate.js')>();
  return {
    ...real,
    compensateLadder: (args: LadderArgs): Ladder => {
      ladderMode.calls++;
      return ladderMode.passThrough ? passThroughLadder(args) : real.compensateLadder(args);
    },
  };
});

/** A ladder that changes nothing: today's exits and success place, no arming, an empty site. */
function passThroughLadder(args: LadderArgs): Ladder {
  return {
    exits: args.settles,
    done: args.settleDone,
    armAt: (_i, successor) => successor,
    finish: () => ({ site: { m: 0, levels: [], compensators: [] } as unknown as CompensationSite, exclusions: [] }),
  };
}

function withPassThrough<T>(body: () => T): T {
  ladderMode.passThrough = true;
  try {
    return body();
  } finally {
    ladderMode.passThrough = false;
  }
}

/**
 * Computed on `467c0a9`, before the contract landed (libpetri 8.0.0 from npm, not linked):
 * `structuralHash` and `netDigest` of each `unannotatedShapes()` entry, then of each {@link spines}
 * entry, in order. The first six equal `pipeline-contract.test.ts`'s `BEFORE`.
 */
const BEFORE: readonly (readonly [label: string, hash: string, digest: string])[] = [
  ['foreach, three lanes', '4d2fb6c330243db7', 'de496606abe2d07e'],
  ['foreach, three lanes, run budget 2', '9aea7db62b475e38', '1263cec672b28466'],
  ['foreach, retries, timeout, limit and rateLimit', '3900f1b2c4ed4e9b', '70d9e57d2e571438'],
  ['foreach over a nested workflow', 'e688d65db3833ee8', '7345e8f39ebf7c92'],
  ['every entry kind, checkpointed', '999c0e8f3c54713c', '5412d7a17bc75a3c'],
  ['init(): .foreach(step) then .foreach(nestedWorkflow)', 'b860cdef99196dc1', '8d45355fa24e6af6'],
  ['three top-level steps', 'd67271ddf2a5c07e', 'b0ff677d9e39fb12'],
  ['three top-level steps, run budget 1', '763e7e0f865a6dc2', '119c723dc9f4bc5d'],
  ['top-level retries, timeout, limit, a parallel, checkpointed', '8f9cbb1527c35646', 'cdc1c28cf0208932'],
  ['init(): reserve, charge (uses, timeout, retries), ship', '425214ce6b549f02', '0341d5222a9e0bf8'],
];

const step = (id: string, extra: Partial<StepDescription> = {}): StepDescription => ({ kind: 'step', id, ...extra });

/** Saga-shaped spines with no `compensate`: what a compensated workflow is before its keys. */
function spines(): Shape[] {
  const gpu = { id: 'gpu', kind: 'limit', n: 1 } as const;
  const three: WorkflowDescription = { id: 'saga', entries: [step('a'), step('b'), step('c')] };
  const resourced: WorkflowDescription = {
    id: 'saga-res',
    entries: [
      step('reserve', { retries: 2, retryDelayMs: 5 }),
      step('charge', { timeoutMs: 50, quotas: [gpu] }),
      { kind: 'parallel', id: 'p', arms: [step('p1'), step('p2')] },
      step('ship', { quotas: [gpu] }),
    ],
    checkpoints: [0],
  };
  const { createWorkflow, createStep, limit } = init();
  const pay = limit(1, { id: 'pay' });
  const S = z.object({ s: z.string() });
  const reserve = createStep({ id: 'reserve', inputSchema: S, outputSchema: S, execute: async ({ inputData }) => inputData });
  const charge = createStep({ id: 'charge', inputSchema: S, outputSchema: S, uses: [pay], timeout: 100, retries: 1, execute: async ({ inputData }) => inputData });
  const ship = createStep({ id: 'ship', inputSchema: S, outputSchema: S, execute: async ({ inputData }) => inputData });
  const book = createWorkflow({ id: 'book', inputSchema: S, outputSchema: S }).then(reserve).then(charge).then(ship).commit();
  const graph = (book as unknown as { buildExecutionGraph(): unknown }).buildExecutionGraph() as ExecutionGraph;
  return [
    { label: 'three top-level steps', compiled: compile(three) },
    { label: 'three top-level steps, run budget 1', compiled: compile(three, { concurrency: 1 }) },
    { label: 'top-level retries, timeout, limit, a parallel, checkpointed', compiled: compile(resourced) },
    { label: 'init(): reserve, charge (uses, timeout, retries), ship', compiled: compile(adaptExecutionGraph(graph)) },
  ];
}

const shapes = (): Shape[] => [...unannotatedShapes(), ...spines()];

/** `[a*, b, c]`, `a` compensated by `undo-a`, with whatever else the test adds. */
const saga = (undo: Partial<StepDescription> = {}, extra: Partial<WorkflowDescription> = {}): WorkflowDescription => ({
  id: 'saga',
  entries: [step('a', { compensate: step('undo-a', undo) }), step('b'), step('c')],
  ...extra,
});
const bare = (description: WorkflowDescription): WorkflowDescription => ({
  ...description,
  entries: description.entries.map((entry) => {
    if (entry.kind !== 'step') return entry;
    const { compensate: _compensate, ...plain } = entry;
    return plain;
  }),
});

describe('an unannotated workflow is untouched', () => {
  it('compiles to the net and the hash it had before the contract', () => {
    // Breaks if: structuralHash folds in an absent compensator, the spine emits differently with no
    // ladder (exits, success place, checkpoint sweep target), the leaf emits differently for
    // `detached: undefined`, or quotaRefsOf reorders the quota pools.
    const now = shapes().map((s) => [s.label, s.compiled.structuralHash, netDigest(s.compiled)] as const);
    expect(now).toEqual(BEFORE);
  });

  it('has no compensations key, no ladder names, and the verify stubs answer for it', () => {
    for (const { compiled } of shapes()) {
      expect('compensations' in compiled).toBe(false);
      expect([...compiled.net.places].filter((p) => p.name.startsWith('wf.comp.'))).toEqual([]);
      expect([...compiled.net.transitions].filter((t) => t.name.startsWith('t.comp.'))).toEqual([]);
      expect(compensateStructureViolations(compiled)).toEqual([]);
      expect(compensatorAttempts(compiled).size).toBe(0);
    }
  });

  it('never reaches the ladder', () => {
    // Breaks if: compile() calls compensateLadder unconditionally (the stub would throw above), or
    // hasCompensation finds a key that is not there.
    const before = ladderMode.calls;
    for (const shape of shapes()) expect(shape.compiled.compensations).toBeUndefined();
    expect(ladderMode.calls).toBe(before);
    expect(hasCompensation({ id: 'w', entries: [step('a'), step('b')] })).toBe(false);
    // An explicit `compensate: undefined` is no key.
    expect(hasCompensation({ id: 'w', entries: [step('a', { compensate: undefined }), step('b')] })).toBe(false);
  });
});

describe('the W0 stubs throw where called (M7b W1)', () => {
  it('compiling a compensated step reaches compensateLadder', () => {
    expect(() => compile(saga())).toThrow("compensateLadder('saga'): not implemented (M7b W1)");
  });

  it('a compensate key anywhere reaches the ladder, whose refusal W1 builds — never silently ignored', () => {
    // Breaks if: hasCompensation looks at top-level steps only, so a key on an arm, a body, a stage
    // or a compensator compiles as if it were not there.
    const undo = step('undo');
    const keyed = step('x', { compensate: undo });
    const positions: WorkflowDescription[] = [
      { id: 'arm', entries: [{ kind: 'parallel', id: 'p', arms: [keyed, step('y')] }, step('z')] },
      { id: 'branch', entries: [{ kind: 'branch', id: 'b', arms: [step('y'), keyed] }, step('z')] },
      { id: 'loop', entries: [{ kind: 'loop', id: 'l', body: keyed, loopType: 'dountil', iterationBound: 2 }, step('z')] },
      { id: 'foreach', entries: [{ kind: 'foreach', id: 'f', body: keyed, concurrency: 1 }, step('z')] },
      {
        id: 'stage',
        entries: [{ kind: 'foreach', id: 'f', body: step('f', { source: 'workflow' }), concurrency: 1, pipeline: { stages: [keyed], bounds: [1] } }, step('z')],
      },
      { id: 'last', entries: [step('a'), keyed] },
    ];
    for (const description of positions) {
      expect(hasCompensation(description)).toBe(true);
      expect(() => compile(description)).toThrow(`compensateLadder('${description.id}'): not implemented (M7b W1)`);
    }
  });

  it('ladderLevel, the one seed, is a stub', () => {
    const site = { m: 1, levels: ['wf.comp.level.0', 'wf.comp.level.1'], compensators: [] } as unknown as CompensationSite;
    expect(() => ladderLevel(site, 0)).toThrow('ladderLevel(m=1, at=0): not implemented (M7b W1)');
  });

  it('the verify side throws for a net with a ladder', () => {
    const forged = { ...compile(bare(saga())), compensations: { m: 1 } } as unknown as CompiledWorkflow;
    expect(() => compensateStructureViolations(forged)).toThrow('compensateStructureViolations: not implemented (M7b W1)');
    expect(() => compensatorAttempts(forged)).toThrow('compensatorAttempts: not implemented (M7b W1)');
  });

  it("the petri createStep refuses the key until W1 attaches it, on a params object and on a tool's options", () => {
    // Breaks if: the key reaches Mastra's createStep, which drops it — a step that undoes nothing.
    const { createStep } = init();
    const S = z.object({ s: z.string() });
    const undo = createStep({ id: 'undo', inputSchema: S, outputSchema: z.void(), execute: async () => undefined });
    expect(() =>
      createStep({ id: 'reserve', inputSchema: S, outputSchema: S, execute: async ({ inputData }) => inputData, compensate: undo }),
    ).toThrow("createStep('reserve'): compensate: not implemented (M7b W1)");
    const tool = createTool({ id: 'charge', description: 'charges', inputSchema: S, outputSchema: S, execute: async (input) => input });
    expect(() => createStep(tool, { compensate: undo })).toThrow("createStep('charge'): compensate: not implemented (M7b W1)");
    // Without the key, or with it undefined, nothing changes.
    expect(createStep({ id: 'plain', inputSchema: S, outputSchema: S, execute: async ({ inputData }) => inputData }).id).toBe('plain');
    expect(createStep({ id: 'undef', inputSchema: S, outputSchema: S, execute: async ({ inputData }) => inputData, compensate: undefined }).id).toBe('undef');
    expect(createStep(tool, { retries: 1 }).id).toBe('charge');
  });
});

describe('the compile wiring, with a pass-through ladder standing in for W1', () => {
  it('records the site W1 returns, and keeps the spine when the ladder changes nothing', () => {
    // Breaks if: compile() drops `finish`'s site, or wires the spine to something other than what the
    // ladder hands back.
    const compiled = withPassThrough(() => compile(saga()));
    expect(compiled.compensations).toBeDefined();
    expect(netDigest(compiled)).toBe(netDigest(compile(bare(saga()))));
  });

  it('structuralHash carries the compensator only when present, and by its options', () => {
    // Breaks if: the step shape drops `compensate`, or hashes only its presence.
    withPassThrough(() => {
      const plain = compile(bare(saga())).structuralHash;
      const keyed = compile(saga()).structuralHash;
      expect(keyed).not.toBe(plain);
      expect(compile(saga()).structuralHash).toBe(keyed);
      expect(compile(saga({ retries: 1 })).structuralHash).not.toBe(keyed);
      expect(compile(saga({ timeoutMs: 50 })).structuralHash).not.toBe(keyed);
      expect(compile({ ...saga(), entries: [step('a', { compensate: step('undo-b') }), step('b'), step('c')] }).structuralHash).not.toBe(keyed);
    });
  });

  it('a quota used only by a compensator is registered (quotaRefsOf walks compensators)', () => {
    // Breaks if: quotaRefsOf skips `compensate`, so the compensator's leaf asks for a member of a quota
    // whose canonical places were never minted (the W0 finding).
    const refund = { id: 'refund', kind: 'limit', n: 1 } as const;
    const compiled = withPassThrough(() => compile(saga({ quotas: [refund] })));
    expect([...compiled.net.places].map((p) => p.name)).toContain('wf.quota.refund');
    expect(compiled.pools.map((p) => p.kind === 'limit' && p.quota)).toContain('refund');
  });
});

describe('the surface names', () => {
  it('COMPENSATE_REFUSALS names the five, and BLUEPRINT_REFUSALS is unchanged', () => {
    expect([...COMPENSATE_REFUSALS]).toEqual([
      'compensate-position',
      'compensate-value',
      'compensate-ids',
      'compensate-suspend',
      'compensate-checkpoint',
    ]);
    expect([...BLUEPRINT_REFUSALS].sort()).toEqual(
      ['blueprint-arms', 'blueprint-position', 'blueprint-reused', 'pipeline-empty', 'pipeline-value', 'quorum-value', 'race-empty'],
    );
  });
});

/**
 * The types, checked by `npm run check` (never run: the key is refused until W1). `Undoable`: the
 * compensator's input must accept the forward step's output; a default-engine compensator is a type
 * error (the brand), as for `race` and `pipeline`.
 */
export function surfaceTypes(): void {
  const { createStep } = init();
  const Req = z.object({ flight: z.string() });
  const Seat = z.object({ seat: z.string() });
  const Charge = z.object({ charge: z.number() });
  const release = createStep({ id: 'release-seat', inputSchema: Seat, outputSchema: z.void(), execute: async () => undefined });
  const refund = createStep({ id: 'refund', inputSchema: Charge, outputSchema: z.void(), retries: 3, execute: async () => undefined });
  const plainRelease = mastraCreateStep({ id: 'plain-release', inputSchema: Seat, outputSchema: z.void(), execute: async () => undefined });

  const reserve = createStep({ id: 'reserve-seat', inputSchema: Req, outputSchema: Seat, execute: async () => ({ seat: '1A' }), compensate: release });
  const charge = createStep({ id: 'charge', inputSchema: Seat, outputSchema: Charge, execute: async () => ({ charge: 1 }), compensate: refund });
  const typed: PetriStep<'reserve-seat', any, { flight: string }, { seat: string }, any, any> = reserve;
  void typed;
  void charge;
  const slot: Undoable<{ seat: string }> = { compensate: release };
  void slot;
  // A compensator whose input is wider than the output accepts it: an optional extra field, or any.
  const Noted = z.object({ seat: z.string(), note: z.string().optional() });
  const noted = createStep({ id: 'noted', inputSchema: Noted, outputSchema: z.void(), execute: async () => undefined });
  const loose = createStep({ id: 'loose', inputSchema: z.any(), outputSchema: z.void(), execute: async () => undefined });
  createStep({ id: 'wider', inputSchema: Req, outputSchema: Seat, execute: async () => ({ seat: '1A' }), compensate: noted });
  createStep({ id: 'any', inputSchema: Req, outputSchema: Seat, execute: async () => ({ seat: '1A' }), compensate: loose });
  const Rowed = z.object({ seat: z.string(), row: z.number() });
  const rowed = createStep({ id: 'rowed', inputSchema: Rowed, outputSchema: z.void(), execute: async () => undefined });
  // @ts-expect-error — rowed needs a row the Seat output does not have
  createStep({ id: 'narrower', inputSchema: Req, outputSchema: Seat, execute: async () => ({ seat: '1A' }), compensate: rowed });

  // @ts-expect-error — refund takes a Charge; reserve-seat outputs a Seat
  createStep({ id: 'wrong-input', inputSchema: Req, outputSchema: Seat, execute: async () => ({ seat: '1A' }), compensate: refund });
  // @ts-expect-error — Mastra's own createStep brands DefaultEngineType: not a petri compensator
  createStep({ id: 'default-undo', inputSchema: Req, outputSchema: Seat, execute: async () => ({ seat: '1A' }), compensate: plainRelease });
  // @ts-expect-error — not a step
  createStep({ id: 'not-a-step', inputSchema: Req, outputSchema: Seat, execute: async () => ({ seat: '1A' }), compensate: { id: 'x' } });
  // @ts-expect-error — the slot is typed by the forward output
  const wrongSlot: Undoable<{ charge: number }> = { compensate: release };
  void wrongSlot;
}

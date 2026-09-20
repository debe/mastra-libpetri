import { describe, expect, it } from 'vitest';
import type { StepFlowEntry as MastraStepFlowEntry } from '@mastra/core/workflows';
import { adaptExecutionGraph, adaptStepFlow } from '../../src/mastra/index.js';
import type { ExecutionGraph, SingleStepEntry, StepFlowEntry } from '../../src/mastra/index.js';
import { compile } from '../../src/compiler/index.js';
import { runWorkflow } from '../../src/engine/index.js';
import { RecordingRunner } from '../fixtures/runner.js';

const adapt = (entries: readonly StepFlowEntry[], options = {}) =>
  adaptStepFlow(entries, { workflowId: 'orders', ...options });

const step = (id: string): SingleStepEntry => ({ type: 'step', step: { id } });

/**
 * The mirror in `src/mastra/host.ts` is hand-transcribed from Mastra's declarations, so the
 * thing that can rot is assignability: a widened `StepFlowEntry` upstream must not silently
 * stop matching. `@mastra/core` is a **type-only** devDependency, and this import is erased —
 * nothing here loads Mastra at run time.
 */
type MirrorsMastra = MastraStepFlowEntry extends StepFlowEntry ? true : false;

describe('the structural mirror', () => {
  it("accepts every shape Mastra's own StepFlowEntry can take", () => {
    // If Mastra widens `StepFlowEntry`, this stops type-checking — `npm run check` fails
    // before any test runs, which is the point.
    const mirrored: MirrorsMastra = true;
    expect(mirrored).toBe(true);
  });
});

describe('single-step entries', () => {
  it('keys a plain step by the wrapped step id, not by the entry', () => {
    expect(adapt([step('validate')])).toEqual({
      id: 'orders',
      entries: [{ kind: 'step', id: 'validate' }],
    });
  });

  it('keys an agent entry by its own id, never by the agent it names', () => {
    // `getEntryId` (step-entry.ts:23-25): declarative entries carry their own id, and Mastra
    // overrides the materialized step's id with it (default.ts:1182). Using `agentId` here
    // would key every result under the wrong name.
    const entries: StepFlowEntry[] = [{ type: 'agent', id: 'summarise', agentId: 'writer' }];
    expect(adapt(entries).entries).toEqual([{ kind: 'step', id: 'summarise' }]);
  });

  it('keys a tool entry by its own id, never by the tool it names', () => {
    const entries: StepFlowEntry[] = [{ type: 'tool', id: 'notify', toolId: 'slack' }];
    expect(adapt(entries).entries).toEqual([{ kind: 'step', id: 'notify' }]);
  });

  it('refuses a .map() entry rather than feeding it the wrong data', () => {
    const entries: StepFlowEntry[] = [{ type: 'mapping', id: 'shape', mapConfig: {} }];
    expect(() => adapt(entries)).toThrow("cannot adapt Mastra 'mapping' entry 'shape'");
    expect(() => adapt(entries)).toThrow("reads any earlier step's result");
  });

  it('refuses a step whose retries would let Mastra run it more than once', () => {
    const entries: StepFlowEntry[] = [{ type: 'step', step: { id: 'charge', retries: 2 } }];
    expect(() => adapt(entries)).toThrow("cannot adapt Mastra 'step' entry 'charge'");
    expect(() => adapt(entries)).toThrow('run it up to 3 times');
  });

  it('refuses a step that a workflow-level retryConfig would retry', () => {
    expect(() => adapt([step('charge')], { retryConfig: { attempts: 1 } })).toThrow(
      'up to 2 times',
    );
  });

  it("honours Mastra's `??`: an explicit retries: 0 beats a workflow-level attempts", () => {
    // handlers/step.ts:314 — `step.retries ?? retryConfig.attempts ?? 0`.
    const entries: StepFlowEntry[] = [{ type: 'step', step: { id: 'charge', retries: 0 } }];
    expect(adapt(entries, { retryConfig: { attempts: 5 } }).entries).toEqual([
      { kind: 'step', id: 'charge' },
    ]);
  });

  it('refuses a declarative entry whose own options carry retries', () => {
    const entries: StepFlowEntry[] = [
      { type: 'tool', id: 'notify', toolId: 'slack', options: { retries: 3 } },
    ];
    expect(() => adapt(entries)).toThrow("cannot adapt Mastra 'tool' entry 'notify'");
  });
});

describe('.sleep() and .sleepUntil()', () => {
  it('carries a static duration through', () => {
    const entries: StepFlowEntry[] = [{ type: 'sleep', id: 'cool_off', duration: 250 }];
    expect(adapt(entries).entries).toEqual([{ kind: 'sleep', id: 'cool_off', durationMs: 250 }]);
  });

  it.each([
    ['absent', undefined],
    ['zero', 0],
    ['negative', -5],
    ['NaN', Number.NaN],
  ])('sleeps for nothing when the duration is %s, exactly as Mastra does', (_label, duration) => {
    // handlers/sleep.ts:131-136 — `!duration || duration < 0 ? 0 : duration`.
    const entries: StepFlowEntry[] = [{ type: 'sleep', id: 'wait', duration }];
    expect(adapt(entries).entries).toEqual([{ kind: 'sleep', id: 'wait', durationMs: 0 }]);
  });

  it('refuses a duration computed per run', () => {
    const entries: StepFlowEntry[] = [{ type: 'sleep', id: 'backoff', fn: () => 1 }];
    expect(() => adapt(entries)).toThrow("cannot adapt Mastra 'sleep' entry 'backoff'");
    expect(() => adapt(entries)).toThrow('computed per run by a function');
  });

  it('refuses a duration past the maximum a JavaScript timer accepts', () => {
    const entries: StepFlowEntry[] = [
      { type: 'sleep', id: 'a_month', duration: 30 * 24 * 60 * 60 * 1000 },
    ];
    expect(() => adapt(entries)).toThrow('maximum a JavaScript timer accepts');
  });

  it('refuses an infinite duration for the same reason', () => {
    const entries: StepFlowEntry[] = [
      { type: 'sleep', id: 'forever', duration: Number.POSITIVE_INFINITY },
    ];
    expect(() => adapt(entries)).toThrow('maximum a JavaScript timer accepts');
  });

  it('converts a sleepUntil date to an instant', () => {
    const date = new Date('2030-01-01T00:00:00.000Z');
    const entries: StepFlowEntry[] = [{ type: 'sleepUntil', id: 'new_year', date }];
    expect(adapt(entries).entries).toEqual([
      { kind: 'sleepUntil', id: 'new_year', atEpochMs: date.getTime() },
    ]);
  });

  it('treats a sleepUntil with no date as no wait at all, as Mastra does', () => {
    // handlers/sleep.ts:267-273 — it returns before waiting, and the entry still succeeds.
    const entries: StepFlowEntry[] = [{ type: 'sleepUntil', id: 'noop' }];
    expect(adapt(entries).entries).toEqual([{ kind: 'sleepUntil', id: 'noop', atEpochMs: 0 }]);
  });

  it('refuses an invalid date rather than reproducing a one-millisecond wait', () => {
    const entries: StepFlowEntry[] = [
      { type: 'sleepUntil', id: 'whenever', date: new Date('not a date') },
    ];
    expect(() => adapt(entries)).toThrow('invalid Date');
  });

  it('refuses a wake-up time computed per run', () => {
    const entries: StepFlowEntry[] = [
      { type: 'sleepUntil', id: 'whenever', fn: () => new Date() },
    ];
    expect(() => adapt(entries)).toThrow("cannot adapt Mastra 'sleepUntil' entry 'whenever'");
  });
});

describe('.parallel() and .branch()', () => {
  it('adapts a parallel block and its arms', () => {
    const entries: StepFlowEntry[] = [
      { type: 'parallel', id: 'fan', steps: [step('a'), { type: 'tool', id: 'b', toolId: 't' }] },
    ];
    expect(adapt(entries).entries).toEqual([
      { kind: 'parallel', id: 'fan', arms: [{ kind: 'step', id: 'a' }, { kind: 'step', id: 'b' }] },
    ]);
  });

  it("adapts Mastra's 'conditional' tag to the compiler's branch", () => {
    // There is no 'branch' entry type in Mastra: `.branch()` pushes `type: 'conditional'`
    // (workflow.ts:2438). The two vocabularies meet in the adapter and nowhere else.
    const entries: StepFlowEntry[] = [
      {
        type: 'conditional',
        id: 'route',
        steps: [step('cheap'), step('premium')],
        conditions: [() => true, () => false],
        serializedConditions: [
          { id: 'cheap-condition', fn: '() => true' },
          { id: 'premium-condition', fn: '() => false' },
        ],
      },
    ];
    expect(adapt(entries).entries).toEqual([
      {
        kind: 'branch',
        id: 'route',
        arms: [{ kind: 'step', id: 'cheap' }, { kind: 'step', id: 'premium' }],
      },
    ]);
  });

  it('names a block the author left unnamed by its position', () => {
    // `parallel.id` / `conditional.id` are optional: the builder only sets one when the author
    // passed `options.id` (workflow.ts:2394).
    const entries: StepFlowEntry[] = [step('first'), { type: 'parallel', steps: [step('a')] }];
    expect(adapt(entries).entries[1]).toEqual({
      kind: 'parallel',
      id: 'parallel_1',
      arms: [{ kind: 'step', id: 'a' }],
    });
  });

  it('refuses an empty .parallel([]) that Mastra would run', () => {
    const entries: StepFlowEntry[] = [{ type: 'parallel', id: 'fan', steps: [] }];
    expect(() => adapt(entries)).toThrow("cannot adapt Mastra 'parallel' entry 'fan'");
    expect(() => adapt(entries)).toThrow('has no branches');
  });

  it('refuses an empty .branch([]) that Mastra would run', () => {
    const entries: StepFlowEntry[] = [
      { type: 'conditional', id: 'route', steps: [], conditions: [], serializedConditions: [] },
    ];
    expect(() => adapt(entries)).toThrow("cannot adapt Mastra 'conditional' entry 'route'");
  });

  it('refuses a .map() used as an arm', () => {
    const entries: StepFlowEntry[] = [
      {
        type: 'parallel',
        id: 'fan',
        steps: [step('a'), { type: 'mapping', id: 'shape', mapConfig: {} }],
      },
    ];
    expect(() => adapt(entries)).toThrow("cannot adapt Mastra 'mapping' entry 'shape'");
  });
});

describe('.dowhile() / .dountil() and .foreach()', () => {
  const loop = (overrides: Record<string, unknown> = {}): StepFlowEntry => ({
    type: 'loop',
    step: step('poll'),
    condition: () => true,
    serializedCondition: { id: 'poll-condition', fn: '() => true' },
    loopType: 'dowhile',
    ...overrides,
  });

  it('adapts a loop once an iteration bound is chosen', () => {
    expect(adapt([loop({ id: 'polling' })], { iterationBound: 8 }).entries).toEqual([
      {
        kind: 'loop',
        id: 'polling',
        loopType: 'dowhile',
        maxIterations: 8,
        body: { kind: 'step', id: 'poll' },
      },
    ]);
  });

  it("names an unnamed loop by its body step, which is the key Mastra writes results under", () => {
    // handlers/entry.ts:810-812 — `stepResults[getSingleStepEntryId(entry.step)] = …`.
    const adapted = adapt([loop()], { iterationBound: 2 }).entries[0];
    expect(adapted).toMatchObject({ kind: 'loop', id: 'poll' });
  });

  it('refuses a loop when no bound was chosen, because Mastra has none', () => {
    expect(() => adapt([loop({ id: 'polling' })])).toThrow(
      "cannot adapt Mastra 'loop' entry 'polling'",
    );
    expect(() => adapt([loop({ id: 'polling' })])).toThrow('Mastra imposes no limit');
  });

  it.each([0, -1, 2.5])('refuses an iteration bound of %s', (iterationBound) => {
    expect(() => adapt([loop({ id: 'polling' })], { iterationBound })).toThrow(
      'must be a whole number of at least 1',
    );
  });

  const foreach = (concurrency: unknown, id?: string): StepFlowEntry => ({
    type: 'foreach',
    ...(id === undefined ? {} : { id }),
    step: step('charge'),
    opts: { concurrency: concurrency as number },
  });

  it('carries a static concurrency through', () => {
    expect(adapt([foreach(4, 'charge_all')]).entries).toEqual([
      { kind: 'foreach', id: 'charge_all', concurrency: 4, body: { kind: 'step', id: 'charge' } },
    ]);
  });

  it.each([
    ['zero', 0, 1],
    ['negative', -3, 1],
    ['fractional', 2.7, 2],
    ['not a number', 'lots', 1],
  ])("applies Mastra's own clamp to a %s concurrency", (_label, configured, expected) => {
    // utils.ts:791-795 — non-number / non-finite / < 1 becomes 1, otherwise floored.
    expect(adapt([foreach(configured, 'f')]).entries[0]).toMatchObject({ concurrency: expected });
  });

  it('refuses a concurrency resolved per run', () => {
    expect(() => adapt([foreach(() => 4, 'f')])).toThrow("cannot adapt Mastra 'foreach' entry 'f'");
    expect(() => adapt([foreach(() => 4, 'f')])).toThrow('resolved per run');
  });
});

describe('the graph itself', () => {
  it('adapts an execution graph, taking the workflow id from it', () => {
    const graph: ExecutionGraph = { id: 'billing', steps: [step('charge')] };
    expect(adaptExecutionGraph(graph)).toEqual({
      id: 'billing',
      entries: [{ kind: 'step', id: 'charge' }],
    });
  });

  it('refuses an uncommitted workflow instead of running an empty one', () => {
    // workflow.ts:1798-1799 — the graph is built one line before `stepFlow` is assigned.
    expect(() => adaptExecutionGraph({ id: 'billing' })).toThrow('it was never committed');
  });

  it('refuses an entry type it has never seen', () => {
    const unknownEntry = { type: 'waitForEvent', id: 'approval' } as unknown as StepFlowEntry;
    expect(() => adapt([unknownEntry])).toThrow("unknown type 'waitForEvent'");
  });
});

describe('end to end: adapt, compile, run', () => {
  it('runs a linear flow of step, agent and tool entries in order', async () => {
    const entries: StepFlowEntry[] = [
      step('validate'),
      { type: 'agent', id: 'summarise', agentId: 'writer' },
      { type: 'tool', id: 'notify', toolId: 'slack' },
    ];
    const runner = new RecordingRunner({
      validate: (input) => ({ status: 'success', output: `${input as string}+validated` }),
      summarise: (input) => ({ status: 'success', output: `${input as string}+summarised` }),
      notify: (input) => ({ status: 'success', output: `${input as string}+notified` }),
    });

    const outcome = await runWorkflow(compile(adapt(entries), { runner }), 'order');

    expect(runner.calls).toEqual(['validate', 'summarise', 'notify']);
    expect(outcome).toEqual({
      status: 'success',
      output: 'order+validated+summarised+notified',
    });
  });

  it('carries a failure from an adapted flow to the failure terminal', async () => {
    const runner = new RecordingRunner({
      charge: () => ({ status: 'failed', error: 'card declined' }),
    });

    const outcome = await runWorkflow(
      compile(adapt([step('validate'), step('charge'), step('ship')]), { runner }),
      'order',
    );

    expect(runner.calls).toEqual(['validate', 'charge']);
    expect(outcome).toEqual({ status: 'failed', stepId: 'charge', error: 'card declined' });
  });

  it('fans out an adapted .parallel() and joins it keyed by arm id', async () => {
    const entries: StepFlowEntry[] = [
      step('fetch'),
      {
        type: 'parallel',
        id: 'fan',
        steps: [step('score'), { type: 'tool', id: 'enrich', toolId: 'clearbit' }],
      },
      step('report'),
    ];
    const runner = new RecordingRunner({
      fetch: () => ({ status: 'success', output: 'seed' }),
      score: (input) => ({ status: 'success', output: `${input as string}/scored` }),
      enrich: (input) => ({ status: 'success', output: `${input as string}/enriched` }),
    });

    const outcome = await runWorkflow(compile(adapt(entries), { runner }), 'order');

    expect(runner.calls[0]).toBe('fetch');
    expect(runner.calls.slice(1, 3).sort()).toEqual(['enrich', 'score']);
    expect(runner.calls[3]).toBe('report');
    // Mastra keys a `.parallel()` aggregate by arm id, and so does the join.
    expect(outcome).toEqual({
      status: 'success',
      output: { score: 'seed/scored', enrich: 'seed/enriched' },
    });
  });
});

import { describe, expect, it } from 'vitest';
import { place, Transition } from 'libpetri';
import type {
  SerializedStepResult,
  StepFlowEntry as MastraStepFlowEntry,
  StepResult as MastraStepResult,
} from '@mastra/core/workflows';
import {
  adaptExecutionGraph,
  adaptStepFlow,
  getStepResultView,
  toMastraStepResult,
  UnsupportedWorkflowError,
} from '../../src/mastra/index.js';
import type {
  AdaptOptions,
  ExecutionGraph,
  OutcomeStepResult,
  SingleStepEntry,
  StepBailed,
  StepCanceled,
  StepFlowEntry,
  StepResult,
  StoredStepResult,
} from '../../src/mastra/index.js';
import {
  compile,
  MAX_FOREACH_LANES,
  MAX_ITERATION_BOUND,
  MAX_RETRIES,
  MAX_WAIT_MS,
  sleepGadget,
  stepGadget,
} from '../../src/compiler/index.js';
import type { CompiledWorkflow, FailureToken, Gadget, StepSource } from '../../src/compiler/index.js';
import { runWorkflow, runWorkflowDetailed } from '../../src/engine/index.js';
import {
  cancelStructureViolations,
  describeReport,
  resumeGateViolations,
  segmentLabel,
  segmentsFor,
  verifyWorkflow,
} from '../../src/verify/index.js';
import { RecordingRunner } from '../fixtures/runner.js';
import { ManualClock } from '../support/manual-clock.js';

const adapt = (entries: readonly StepFlowEntry[], options: Omit<AdaptOptions, 'workflowId'> = {}) =>
  adaptStepFlow(entries, { workflowId: 'orders', ...options });

const step = (id: string, extra: { retries?: number; component?: string } = {}): SingleStepEntry => ({
  type: 'step',
  step: { id, ...extra },
});

/** A nested workflow as Mastra hands it over: `Workflow implements Step`, `component: 'WORKFLOW'`. */
const nested = (id: string): SingleStepEntry => step(id, { component: 'WORKFLOW' });

/** The single adapted entry of a one-entry flow. */
const only = (entry: StepFlowEntry, options: Omit<AdaptOptions, 'workflowId'> = {}) => adapt([entry], options).entries[0];

/**
 * The mirror in `src/mastra/host.ts` is hand-transcribed from Mastra's declarations, so the
 * thing that can rot is assignability: a widened `StepFlowEntry` upstream must not silently
 * stop matching. `@mastra/core` is a **type-only** devDependency, and this import is erased —
 * nothing here loads Mastra at run time.
 */
type MirrorsMastra = MastraStepFlowEntry extends StepFlowEntry ? true : false;

/**
 * `StepResult` must hold in **both** directions: what Mastra stores must be readable by
 * `fromMastraStepResult`, and what `toMastraStepResult` produces must be something Mastra's
 * `stepResults` accepts. `'bailed'` and `'canceled'` are left out of the second check because
 * Mastra's union declares neither — it records both anyway (`handlers/step.ts:524`;
 * `handlers/control-flow.ts:752,1164-1169`, cast through `as unknown as StepResult`), which is why
 * the mirror has them.
 */
type ReadsMastraResults = MastraStepResult<any, any, any, any> extends StepResult ? true : false;
type ReadsStoredResults = SerializedStepResult<any, any, any, any> extends StoredStepResult ? true : false;
type WritesMastraResults = Exclude<OutcomeStepResult, StepBailed | StepCanceled> extends MastraStepResult<any, any, any, any>
  ? true
  : false;
type MirrorsEveryStatus = MastraStepResult<any, any, any, any>['status'] extends StepResult['status']
  ? StepResult['status'] extends MastraStepResult<any, any, any, any>['status']
    ? true
    : false
  : false;

describe('the structural mirror', () => {
  it("accepts every shape Mastra's own StepFlowEntry can take", () => {
    // If Mastra widens `StepFlowEntry`, this stops type-checking — `npm run check` fails
    // before any test runs, which is the point.
    const mirrored: MirrorsMastra = true;
    expect(mirrored).toBe(true);
  });

  it("reads and writes Mastra's StepResult, and knows exactly its statuses", () => {
    const checks: [ReadsMastraResults, ReadsStoredResults, WritesMastraResults, MirrorsEveryStatus] = [true, true, true, true];
    expect(checks).toEqual([true, true, true, true]);
  });
});

describe('single-step entries carry their source', () => {
  it('keys a plain step by the wrapped step id, not by the entry', () => {
    expect(adapt([step('validate')])).toEqual({
      id: 'orders',
      entries: [{ kind: 'step', id: 'validate', source: 'step' }],
    });
  });

  it('keys an agent entry by its own id, never by the agent it names', () => {
    // `getEntryId` (step-entry.ts:23-25): declarative entries carry their own id, and Mastra
    // overrides the materialized step's id with it (default.ts:1182). Using `agentId` here
    // would key every result under the wrong name.
    expect(only({ type: 'agent', id: 'summarise', agentId: 'writer' })).toEqual({
      kind: 'step',
      id: 'summarise',
      source: 'agent',
    });
  });

  it('keys a tool entry by its own id, never by the tool it names', () => {
    expect(only({ type: 'tool', id: 'notify', toolId: 'slack' })).toEqual({
      kind: 'step',
      id: 'notify',
      source: 'tool',
    });
  });

  it("marks a nested workflow by Mastra's own test, component === 'WORKFLOW'", () => {
    // step-entry.ts:61-70 and handlers/step.ts:351 — `Workflow` sets it through `MastraBase`
    // (workflow.ts:1789).
    expect(only(nested('fulfil'))).toEqual({ kind: 'step', id: 'fulfil', source: 'workflow' });
  });

  it('keeps any other component a plain step: only the entry type selects agent or tool', () => {
    // A `Step` built from an agent but stripped of its reference arrives as `type: 'step'` and
    // Mastra runs its own `execute` (workflow.ts:579-593), so it is a step, whatever it says.
    expect(only(step('summarise', { component: 'AGENT' }))).toEqual({
      kind: 'step',
      id: 'summarise',
      source: 'step',
    });
  });

  it('adapts a .map() entry as a mapping step (refusal lifted: the runner reads the run)', () => {
    expect(only({ type: 'mapping', id: 'shape', mapConfig: {} })).toEqual({
      kind: 'step',
      id: 'shape',
      source: 'mapping',
    });
  });

  it('passes a __proto__ step id through as an ordinary id', () => {
    expect(only(step('__proto__'))).toEqual({ kind: 'step', id: '__proto__', source: 'step' });
  });
});

describe('retries, resolved as Mastra resolves them', () => {
  // handlers/step.ts:314 — `step.retries ?? executionContext.retryConfig.attempts ?? 0`.

  it("uses the step's own retries", () => {
    expect(only(step('charge', { retries: 2 }))).toEqual({
      kind: 'step',
      id: 'charge',
      source: 'step',
      retries: 2,
    });
  });

  it('falls back to the workflow-level retryConfig.attempts', () => {
    expect(only(step('charge'), { retryConfig: { attempts: 3 } })).toMatchObject({ retries: 3 });
  });

  it('adds nothing for a step that does not retry', () => {
    expect(only(step('charge'))).toEqual({ kind: 'step', id: 'charge', source: 'step' });
    expect(only(step('charge'), { retryConfig: { attempts: 0, delay: 500 } })).toEqual({
      kind: 'step',
      id: 'charge',
      source: 'step',
    });
  });

  it("honours `??`: an explicit retries: 0 on the step beats a workflow-level attempts", () => {
    expect(only(step('charge', { retries: 0 }), { retryConfig: { attempts: 5, delay: 100 } })).toEqual({
      kind: 'step',
      id: 'charge',
      source: 'step',
    });
  });

  it("lets the step's own count win in either direction", () => {
    expect(only(step('charge', { retries: 1 }), { retryConfig: { attempts: 4 } })).toMatchObject({ retries: 1 });
    expect(only(step('charge', { retries: 6 }), { retryConfig: { attempts: 4 } })).toMatchObject({ retries: 6 });
  });

  it('treats a null count as absent, because `??` does', () => {
    const entry = { type: 'step', step: { id: 'charge', retries: null } } as unknown as StepFlowEntry;
    expect(only(entry, { retryConfig: { attempts: 2 } })).toMatchObject({ retries: 2 });
  });

  it("reads an agent or tool entry's own count from options.retries", () => {
    // `getEntryRetries` (step-entry.ts:35-45); the materialized step carries the same value
    // (step-factories.ts:52,69,108).
    expect(
      only({ type: 'agent', id: 'summarise', agentId: 'writer', options: { retries: 2 } }, { retryConfig: { attempts: 5 } }),
    ).toMatchObject({ source: 'agent', retries: 2 });
    expect(
      only({ type: 'tool', id: 'notify', toolId: 'slack', options: { retries: 0 } }, { retryConfig: { attempts: 5 } }),
    ).toEqual({ kind: 'step', id: 'notify', source: 'tool' });
    expect(only({ type: 'agent', id: 'summarise', agentId: 'writer' }, { retryConfig: { attempts: 1 } })).toMatchObject({
      retries: 1,
    });
  });

  it('gives a .map() and a nested workflow the workflow-level count, having none of their own', () => {
    // createMappingStep sets no `retries` (step-factories.ts:130-141); a `Workflow` has none.
    expect(only({ type: 'mapping', id: 'shape', mapConfig: {} }, { retryConfig: { attempts: 2 } })).toMatchObject({
      source: 'mapping',
      retries: 2,
    });
    expect(only(nested('fulfil'), { retryConfig: { attempts: 2 } })).toMatchObject({ source: 'workflow', retries: 2 });
  });

  it('carries the workflow-level delay onto a step that retries', () => {
    expect(only(step('charge'), { retryConfig: { attempts: 2, delay: 250 } })).toEqual({
      kind: 'step',
      id: 'charge',
      source: 'step',
      retries: 2,
      retryDelayMs: 250,
    });
  });

  it.each([
    ['absent', undefined],
    ['zero', 0],
    ['NaN', Number.NaN],
    ['negative', -50],
  ])('waits nothing between attempts when the delay is %s', (_label, delay) => {
    // default.ts:456-457 — `if (i > 0 && params.delay) await setTimeout(…, params.delay)`. A
    // negative delay is one timer tick in Node, which is modelled as nothing, as a zero sleep is.
    const adapted = only(step('charge'), { retryConfig: { attempts: 1, ...(delay === undefined ? {} : { delay }) } });
    expect(adapted).toEqual({ kind: 'step', id: 'charge', source: 'step', retries: 1 });
  });

  it('refuses a delay past the timer ceiling on a step that retries', () => {
    const tooLong = { retryConfig: { attempts: 1, delay: MAX_WAIT_MS + 1 } };
    expect(() => only(step('charge'), tooLong)).toThrow(UnsupportedWorkflowError);
    expect(() => only(step('charge'), tooLong)).toThrow('maximum a JavaScript timer accepts');
    expect(() => only(step('charge'), { retryConfig: { attempts: 1, delay: Infinity } })).toThrow(
      'maximum a JavaScript timer accepts',
    );
  });

  it('accepts that same delay on a step that never retries, where Mastra never waits it', () => {
    expect(only(step('charge', { retries: 0 }), { retryConfig: { attempts: 1, delay: Infinity } })).toEqual({
      kind: 'step',
      id: 'charge',
      source: 'step',
    });
  });

  it('accepts a delay of exactly the ceiling', () => {
    expect(only(step('charge'), { retryConfig: { attempts: 1, delay: MAX_WAIT_MS } })).toMatchObject({
      retryDelayMs: MAX_WAIT_MS,
    });
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['infinite', Infinity],
  ])("refuses a %s retry count, for which Mastra's attempt loop has no sound meaning", (_label, retries) => {
    expect(() => only(step('charge', { retries }))).toThrow(UnsupportedWorkflowError);
    expect(() => only(step('charge', { retries }))).toThrow('from its own retries');
    expect(() => only(step('charge'), { retryConfig: { attempts: retries } })).toThrow(
      'from the workflow retryConfig.attempts',
    );
    expect(() => only(step('charge'), { retryConfig: { attempts: retries } })).toThrow(
      'is not a whole number of at least 0',
    );
  });
});

describe('.sleep() and .sleepUntil()', () => {
  it('carries a literal duration through as fixed', () => {
    expect(only({ type: 'sleep', id: 'cool_off', duration: 250 })).toEqual({
      kind: 'sleep',
      id: 'cool_off',
      duration: { fixed: 250 },
    });
  });

  it.each([
    ['absent', undefined],
    ['zero', 0],
    ['negative', -5],
    ['NaN', Number.NaN],
  ])('sleeps for nothing when the duration is %s, exactly as Mastra does', (_label, duration) => {
    // handlers/sleep.ts:132 — `!duration || duration < 0 ? 0 : duration`.
    expect(only({ type: 'sleep', id: 'wait', duration })).toEqual({
      kind: 'sleep',
      id: 'wait',
      duration: { fixed: 0 },
    });
  });

  it('adapts a duration computed per run (refusal lifted)', () => {
    expect(only({ type: 'sleep', id: 'backoff', fn: () => 1 })).toEqual({
      kind: 'sleep',
      id: 'backoff',
      duration: { perRun: true },
    });
  });

  it('lets a function win over a duration, as `if (fn)` does', () => {
    // handlers/sleep.ts:83. The builder never stores both (workflow.ts:2096-2099).
    expect(only({ type: 'sleep', id: 'backoff', duration: 10, fn: () => 1 })).toMatchObject({
      duration: { perRun: true },
    });
  });

  it('accepts a duration of exactly the timer ceiling', () => {
    expect(only({ type: 'sleep', id: 'long', duration: MAX_WAIT_MS })).toMatchObject({
      duration: { fixed: MAX_WAIT_MS },
    });
  });

  it('refuses a duration past the maximum a JavaScript timer accepts', () => {
    const entry: StepFlowEntry = { type: 'sleep', id: 'a_month', duration: 30 * 24 * 60 * 60 * 1000 };
    expect(() => only(entry)).toThrow(UnsupportedWorkflowError);
    expect(() => only(entry)).toThrow("cannot adapt Mastra 'sleep' entry 'a_month'");
    expect(() => only(entry)).toThrow('maximum a JavaScript timer accepts');
  });

  it('refuses an infinite duration for the same reason', () => {
    expect(() => only({ type: 'sleep', id: 'forever', duration: Infinity })).toThrow(
      'maximum a JavaScript timer accepts',
    );
  });

  it('refuses a duration that is not a number', () => {
    const entry = { type: 'sleep', id: 'wait', duration: '100' } as unknown as StepFlowEntry;
    expect(() => only(entry)).toThrow('not a number of milliseconds');
  });

  it('carries a sleepUntil date through as a fixed instant', () => {
    const date = new Date('2030-01-01T00:00:00.000Z');
    expect(only({ type: 'sleepUntil', id: 'new_year', date })).toEqual({
      kind: 'sleepUntil',
      id: 'new_year',
      until: { fixed: date.getTime() },
    });
  });

  it('treats a sleepUntil with no date as no wait at all, as Mastra does', () => {
    // handlers/sleep.ts:267-273 — it returns before waiting, and the entry still succeeds.
    expect(only({ type: 'sleepUntil', id: 'noop' })).toEqual({
      kind: 'sleepUntil',
      id: 'noop',
      until: { fixed: 0 },
    });
  });

  it('treats a date before 1970 as the past it is', () => {
    // Mastra waits `max(0, date - now)` (default.ts:151-158, utils.ts:230-251): any past instant
    // is no wait, so it is normalised to the one past instant that is the same on every compile.
    expect(only({ type: 'sleepUntil', id: 'then', date: new Date('1960-01-01T00:00:00Z') })).toMatchObject({
      until: { fixed: 0 },
    });
  });

  it('refuses an invalid date rather than reproducing a one-millisecond wait', () => {
    const entry: StepFlowEntry = { type: 'sleepUntil', id: 'whenever', date: new Date('not a date') };
    expect(() => only(entry)).toThrow(UnsupportedWorkflowError);
    expect(() => only(entry)).toThrow('invalid Date');
  });

  it('refuses a date that is not a Date', () => {
    const entry = { type: 'sleepUntil', id: 'whenever', date: '2030-01-01' } as unknown as StepFlowEntry;
    expect(() => only(entry)).toThrow('not a Date');
  });

  it('adapts a wake-up time computed per run (refusal lifted)', () => {
    expect(only({ type: 'sleepUntil', id: 'whenever', fn: () => new Date() })).toEqual({
      kind: 'sleepUntil',
      id: 'whenever',
      until: { perRun: true },
    });
  });
});

describe('.parallel() and .branch()', () => {
  it('adapts a parallel block and its arms, each with its source', () => {
    const entries: StepFlowEntry[] = [
      { type: 'parallel', id: 'fan', steps: [step('a'), { type: 'tool', id: 'b', toolId: 't' }, nested('c')] },
    ];
    expect(adapt(entries).entries).toEqual([
      {
        kind: 'parallel',
        id: 'fan',
        arms: [
          { kind: 'step', id: 'a', source: 'step' },
          { kind: 'step', id: 'b', source: 'tool' },
          { kind: 'step', id: 'c', source: 'workflow' },
        ],
      },
    ]);
  });

  it("adapts Mastra's 'conditional' tag to the compiler's branch, keeping arm order", () => {
    // There is no 'branch' entry type in Mastra: `.branch()` pushes `type: 'conditional'`, with
    // `conditions[j]` index-aligned to `steps[j]` (workflow.ts:2436-2454).
    const entries: StepFlowEntry[] = [
      {
        type: 'conditional',
        id: 'route',
        steps: [step('cheap'), step('premium'), step('manual')],
        conditions: [() => true, () => false, () => true],
        serializedConditions: [
          { id: 'cheap-condition', fn: '() => true' },
          { id: 'premium-condition', fn: '() => false' },
          { id: 'manual-condition', fn: '() => true' },
        ],
      },
    ];
    expect(adapt(entries).entries).toEqual([
      {
        kind: 'branch',
        id: 'route',
        arms: [
          { kind: 'step', id: 'cheap', source: 'step' },
          { kind: 'step', id: 'premium', source: 'step' },
          { kind: 'step', id: 'manual', source: 'step' },
        ],
      },
    ]);
  });

  it('names a block the author left unnamed by its position', () => {
    // `parallel.id` / `conditional.id` are optional: the builder only sets one when the author
    // passed `options.id` (workflow.ts:647-653).
    const entries: StepFlowEntry[] = [
      step('first'),
      { type: 'parallel', steps: [step('a')] },
      { type: 'conditional', steps: [step('b')], conditions: [() => true], serializedConditions: [] },
    ];
    expect(adapt(entries).entries.slice(1)).toEqual([
      { kind: 'parallel', id: 'parallel_1', arms: [{ kind: 'step', id: 'a', source: 'step' }] },
      { kind: 'branch', id: 'branch_2', arms: [{ kind: 'step', id: 'b', source: 'step' }] },
    ]);
  });

  it('adapts an empty .parallel([]) (refusal lifted: Mastra continues with {})', () => {
    expect(only({ type: 'parallel', id: 'fan', steps: [] })).toEqual({ kind: 'parallel', id: 'fan', arms: [] });
  });

  it('adapts an empty .branch([]) (refusal lifted)', () => {
    expect(
      only({ type: 'conditional', id: 'route', steps: [], conditions: [], serializedConditions: [] }),
    ).toEqual({ kind: 'branch', id: 'route', arms: [] });
  });

  it('adapts a .map() used as an arm (refusal lifted)', () => {
    const entries: StepFlowEntry[] = [
      { type: 'parallel', id: 'fan', steps: [step('a'), { type: 'mapping', id: 'shape', mapConfig: {} }] },
    ];
    expect(adapt(entries).entries[0]).toEqual({
      kind: 'parallel',
      id: 'fan',
      arms: [
        { kind: 'step', id: 'a', source: 'step' },
        { kind: 'step', id: 'shape', source: 'mapping' },
      ],
    });
  });

  it('resolves retries per arm', () => {
    const entries: StepFlowEntry[] = [
      { type: 'parallel', id: 'fan', steps: [step('a', { retries: 0 }), step('b')] },
    ];
    expect(adapt(entries, { retryConfig: { attempts: 2, delay: 10 } }).entries[0]).toEqual({
      kind: 'parallel',
      id: 'fan',
      arms: [
        { kind: 'step', id: 'a', source: 'step' },
        { kind: 'step', id: 'b', source: 'step', retries: 2, retryDelayMs: 10 },
      ],
    });
  });

  it('refuses control flow smuggled in as an arm, which Mastra types as a single step', () => {
    const entries = [
      { type: 'parallel', id: 'outer', steps: [{ type: 'parallel', id: 'inner', steps: [] }] },
    ] as unknown as StepFlowEntry[];
    expect(() => adapt(entries)).toThrow(UnsupportedWorkflowError);
    expect(() => adapt(entries)).toThrow("cannot adapt Mastra 'parallel' entry 'inner'");
    expect(() => adapt(entries)).toThrow('To nest control flow, nest a workflow');
  });
});

describe('.dowhile() / .dountil() and .foreach()', () => {
  const loop = (overrides: Record<string, unknown> = {}): StepFlowEntry =>
    ({
      type: 'loop',
      step: step('poll'),
      condition: () => true,
      serializedCondition: { id: 'poll-condition', fn: '() => true' },
      loopType: 'dowhile',
      ...overrides,
    }) as StepFlowEntry;

  it('adapts a loop once an iteration bound is chosen', () => {
    expect(only(loop({ id: 'polling' }), { iterationBound: 8 })).toEqual({
      kind: 'loop',
      id: 'polling',
      body: { kind: 'step', id: 'poll', source: 'step' },
      loopType: 'dowhile',
      iterationBound: 8,
    });
  });

  it('carries dountil through', () => {
    expect(only(loop({ loopType: 'dountil' }), { iterationBound: 3 })).toMatchObject({ loopType: 'dountil' });
  });

  it('names an unnamed loop by its body step, which is the key Mastra writes results under', () => {
    // handlers/entry.ts:810-812 — `stepResults[getSingleStepEntryId(entry.step)] = …`.
    expect(only(loop(), { iterationBound: 2 })).toMatchObject({ kind: 'loop', id: 'poll' });
  });

  it('resolves the body retries like any other step', () => {
    expect(only(loop({ step: step('poll', { retries: 1 }) }), { iterationBound: 2 })).toMatchObject({
      body: { kind: 'step', id: 'poll', source: 'step', retries: 1 },
    });
  });

  it('refuses a loop when no bound was chosen, because Mastra has none', () => {
    expect(() => only(loop({ id: 'polling' }))).toThrow(UnsupportedWorkflowError);
    expect(() => only(loop({ id: 'polling' }))).toThrow("cannot adapt Mastra 'loop' entry 'polling'");
    expect(() => only(loop({ id: 'polling' }))).toThrow('Mastra imposes no limit');
  });

  it.each([0, -1, 2.5, Number.NaN])('refuses an iteration bound of %s', (iterationBound) => {
    expect(() => only(loop({ id: 'polling' }), { iterationBound })).toThrow('must be a whole number from 1 to 100000');
  });

  it('refuses a loop type Mastra 1.67.0 does not have', () => {
    expect(() => only(loop({ loopType: 'while' }), { iterationBound: 2 })).toThrow("its loopType is 'while'");
  });

  const foreach = (concurrency: unknown, id?: string): StepFlowEntry => ({
    type: 'foreach',
    ...(id === undefined ? {} : { id }),
    step: step('charge'),
    opts: { concurrency: concurrency as number },
  });

  it('carries a static concurrency through', () => {
    expect(only(foreach(4, 'charge_all'))).toEqual({
      kind: 'foreach',
      id: 'charge_all',
      body: { kind: 'step', id: 'charge', source: 'step' },
      concurrency: 4,
    });
  });

  it('names an unnamed foreach by its body step', () => {
    expect(only(foreach(2))).toMatchObject({ kind: 'foreach', id: 'charge' });
  });

  it.each([
    ['absent', undefined, 1],
    ['zero', 0, 1],
    ['negative', -3, 1],
    ['fractional', 2.7, 2],
    ['infinite', Infinity, 1],
    ['NaN', Number.NaN, 1],
    ['not a number', 'lots', 1],
  ])("applies Mastra's own clamp to a %s concurrency", (_label, configured, expected) => {
    // utils.ts:786-796 — `opts?.concurrency ?? 1`, then non-number / non-finite / < 1 becomes
    // 1, otherwise floored.
    expect(only(foreach(configured, 'f'))).toMatchObject({ concurrency: expected });
  });

  it('refuses a concurrency resolved per run', () => {
    expect(() => only(foreach(() => 4, 'f'))).toThrow(UnsupportedWorkflowError);
    expect(() => only(foreach(() => 4, 'f'))).toThrow("cannot adapt Mastra 'foreach' entry 'f'");
    expect(() => only(foreach(() => 4, 'f'))).toThrow('resolved per run');
  });

  it("reads the options object Mastra keeps by reference at the moment it adapts", () => {
    // workflow.ts:2629-2636 keeps the caller's `opts` by reference so it can be raised between
    // build and execution. Adapting reads it live, so adapting at execution time sees the raise.
    const opts = { concurrency: 1 };
    const entries: StepFlowEntry[] = [{ type: 'foreach', id: 'f', step: step('charge'), opts }];
    expect(adapt(entries).entries[0]).toMatchObject({ concurrency: 1 });
    opts.concurrency = 4;
    expect(adapt(entries).entries[0]).toMatchObject({ concurrency: 4 });
  });
});

describe('limits this engine has and Mastra does not', () => {
  // Each is refused by the adapter, in its own words, before a plain compiler Error could reach a
  // Mastra user. Mastra runs all of these; they are divergences, recorded as such.
  it('refuses a retry count above MAX_RETRIES, from the step or from the workflow', () => {
    expect(() => only(step('charge', { retries: MAX_RETRIES + 1 }))).toThrow(UnsupportedWorkflowError);
    expect(() => only(step('charge', { retries: MAX_RETRIES + 1 }))).toThrow(`above the ${MAX_RETRIES}`);
    expect(() => only(step('charge'), { retryConfig: { attempts: MAX_RETRIES + 1 } })).toThrow(
      'from the workflow retryConfig.attempts',
    );
    expect(only(step('charge', { retries: MAX_RETRIES }))).toMatchObject({ retries: MAX_RETRIES });
  });

  it('refuses foreach concurrency above MAX_FOREACH_LANES, after Mastra\'s own clamping', () => {
    const foreach = (concurrency: number): StepFlowEntry =>
      ({ type: 'foreach', id: 'f', step: step('charge'), opts: { concurrency } }) as StepFlowEntry;
    expect(() => only(foreach(MAX_FOREACH_LANES + 1))).toThrow(UnsupportedWorkflowError);
    // 256.9 floors to the limit itself, as resolveForeachConcurrency floors it.
    expect(only(foreach(MAX_FOREACH_LANES + 0.9))).toMatchObject({ concurrency: MAX_FOREACH_LANES });
  });

  it('refuses an iterationBound above MAX_ITERATION_BOUND', () => {
    const loop = {
      type: 'loop',
      id: 'polling',
      step: step('poll'),
      condition: () => true,
      serializedCondition: { id: 'c', fn: '() => true' },
      loopType: 'dowhile',
    } as StepFlowEntry;
    expect(() => only(loop, { iterationBound: MAX_ITERATION_BOUND + 1 })).toThrow(UnsupportedWorkflowError);
    expect(only(loop, { iterationBound: MAX_ITERATION_BOUND })).toMatchObject({ iterationBound: MAX_ITERATION_BOUND });
  });
});

describe('the graph itself', () => {
  it('adapts an execution graph, taking the workflow id from it and the retry config from the caller', () => {
    const graph: ExecutionGraph = { id: 'billing', steps: [step('charge')] };
    expect(adaptExecutionGraph(graph, { retryConfig: { attempts: 1, delay: 5 } })).toEqual({
      id: 'billing',
      entries: [{ kind: 'step', id: 'charge', source: 'step', retries: 1, retryDelayMs: 5 }],
    });
  });

  it('refuses an uncommitted workflow instead of running an empty one', () => {
    // workflow.ts:1798-1799 — the graph is built one line before `stepFlow` is assigned.
    expect(() => adaptExecutionGraph({ id: 'billing' })).toThrow('it was never committed');
  });

  it('refuses an entry type it has never seen', () => {
    const unknownEntry = { type: 'waitForEvent', id: 'approval' } as unknown as StepFlowEntry;
    expect(() => adapt([unknownEntry])).toThrow(UnsupportedWorkflowError);
    expect(() => adapt([unknownEntry])).toThrow("cannot adapt Mastra 'waitForEvent' entry 'approval'");
  });

  it('says what it refused in fields, not only in prose', () => {
    let caught: unknown;
    try {
      only({ type: 'sleep', id: 'a_month', duration: Infinity });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnsupportedWorkflowError);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toMatchObject({ name: 'UnsupportedWorkflowError', entryType: 'sleep', entryId: 'a_month' });
    expect((caught as UnsupportedWorkflowError).reason).toContain('maximum a JavaScript timer accepts');
  });

  it("speaks Mastra's language: no refusal mentions the engine's internals", () => {
    // CLAUDE.md: no Petri vocabulary in any Mastra-facing surface, and a refusal is one.
    const refusals: (() => unknown)[] = [
      () => only({ type: 'loop', id: 'l', step: step('p'), condition: 0, serializedCondition: { id: 'x', fn: '' }, loopType: 'dowhile' }),
      () => only({ type: 'loop', id: 'l', step: step('p'), condition: 0, serializedCondition: { id: 'x', fn: '' }, loopType: 'dowhile' }, { iterationBound: 0 }),
      () => only({ type: 'loop', id: 'l', step: step('p'), condition: 0, serializedCondition: { id: 'x', fn: '' }, loopType: 'x' as 'dowhile' }, { iterationBound: 1 }),
      () => only({ type: 'foreach', id: 'f', step: step('c'), opts: { concurrency: () => 2 } }),
      () => only({ type: 'sleep', id: 's', duration: Infinity }),
      () => only({ type: 'sleep', id: 's', duration: 'x' as unknown as number }),
      () => only({ type: 'sleepUntil', id: 'u', date: new Date('nope') }),
      () => only({ type: 'sleepUntil', id: 'u', date: 'x' as unknown as Date }),
      () => only(step('c', { retries: -1 })),
      () => only(step('c'), { retryConfig: { attempts: 1, delay: Infinity } }),
      () => only(step('c'), { retryConfig: { attempts: 1, delay: 'x' as unknown as number } }),
      () => only({ type: 'waitForEvent', id: 'w' } as unknown as StepFlowEntry),
      () => only({ type: 'parallel', id: 'p', steps: [{ type: 'parallel', steps: [] } as unknown as SingleStepEntry] }),
      () => adaptExecutionGraph({ id: 'billing' }),
    ];
    const internals = /\b(petri|nets?|places?|tokens?|transitions?|markings?|arcs?|inhibitors?|gadgets?|firings?|sinks?)\b/i;
    for (const refusal of refusals) {
      let message = '';
      try {
        refusal();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, 'every case here must be refused').not.toBe('');
      expect(message).not.toMatch(internals);
    }
  });
});

/**
 * End to end, through leaf-shaped workflows only — steps, retries, sleeps and mappings. The
 * combinator gadgets are being rebuilt separately, so a run through them here could fail for
 * reasons that have nothing to do with the adapter.
 */
describe('end to end: adapt, compile, run', () => {
  it('runs a linear flow of step, agent and tool entries in order, telling the runner each source', async () => {
    const sources: [string, StepSource][] = [];
    const tag = (suffix: string) => (input: unknown, call: { source: StepSource }) => {
      sources.push([suffix, call.source]);
      return { status: 'success' as const, output: `${input as string}+${suffix}` };
    };
    const runner = new RecordingRunner({
      steps: { validate: tag('validated'), summarise: tag('summarised'), notify: tag('notified') },
    });
    const entries: StepFlowEntry[] = [
      step('validate'),
      { type: 'agent', id: 'summarise', agentId: 'writer' },
      { type: 'tool', id: 'notify', toolId: 'slack' },
    ];

    const outcome = await runWorkflow(compile(adapt(entries)), 'order', { runner });

    expect(runner.calls).toEqual(['validate', 'summarise', 'notify']);
    expect(sources).toEqual([
      ['validated', 'step'],
      ['summarised', 'agent'],
      ['notified', 'tool'],
    ]);
    expect(outcome).toEqual({ status: 'success', output: 'order+validated+summarised+notified' });
  });

  it('carries a failure from an adapted flow to the failure terminal', async () => {
    const runner = new RecordingRunner({ steps: { charge: () => ({ status: 'failed', error: 'card declined' }) } });

    const outcome = await runWorkflow(compile(adapt([step('validate'), step('charge'), step('ship')])), 'order', {
      runner,
    });

    expect(runner.calls).toEqual(['validate', 'charge']);
    expect(outcome).toEqual({ status: 'failed', stepId: 'charge', path: [1], error: 'card declined' });
  });

  it('runs a nested workflow as one step the runner knows is a workflow, and reports its pause', async () => {
    const seen: StepSource[] = [];
    const runner = new RecordingRunner({
      steps: {
        fulfil: (_input, call) => {
          seen.push(call.source);
          return { status: 'paused' };
        },
      },
    });

    const outcome = await runWorkflow(compile(adapt([step('charge'), nested('fulfil'), step('ship')])), 'order', {
      runner,
    });

    expect(seen).toEqual(['workflow']);
    expect(runner.calls).toEqual(['charge', 'fulfil']);
    expect(outcome).toEqual({ status: 'paused', stepId: 'fulfil', path: [1] });
  });

  it('retries by the workflow retryConfig, waiting the delay between attempts and not before the first', async () => {
    const clock = new ManualClock();
    const runner = new RecordingRunner({
      steps: {
        charge: (_input, call) =>
          call.attempt < 2 ? { status: 'failed', error: `declined ${call.attempt}` } : { status: 'success', output: 'charged' },
      },
    });
    const description = adapt([step('validate'), step('charge'), step('ship', { retries: 0 })], {
      retryConfig: { attempts: 2, delay: 500 },
    });

    const outcome = await runWorkflow(compile(description), 'order', { runner, clock });

    expect(runner.attempts).toEqual([
      { stepId: 'validate', attempt: 0 },
      { stepId: 'charge', attempt: 0 },
      { stepId: 'charge', attempt: 1 },
      { stepId: 'charge', attempt: 2 },
      { stepId: 'ship', attempt: 0 },
    ]);
    expect(outcome).toEqual({ status: 'success', output: 'charged' });
    // Two waits of 500 between three attempts, and nothing else: default.ts:456 `i > 0 && delay`.
    expect(clock.elapsed()).toBe(1_000);
  });

  it('runs a step once when its own retries: 0 beats the workflow attempts', async () => {
    const runner = new RecordingRunner({ steps: { charge: () => ({ status: 'failed', error: 'declined' }) } });
    const description = adapt([step('charge', { retries: 0 })], { retryConfig: { attempts: 5 } });

    const outcome = await runWorkflow(compile(description), 'order', { runner });

    expect(runner.attempts).toEqual([{ stepId: 'charge', attempt: 0 }]);
    expect(outcome).toEqual({ status: 'failed', stepId: 'charge', path: [0], error: 'declined' });
  });

  it("retries a tool entry by its own options.retries and reports the last attempt's error", async () => {
    const runner = new RecordingRunner({
      steps: { notify: (_input, call) => ({ status: 'failed', error: `timeout ${call.attempt}` }) },
    });
    const description = adapt([{ type: 'tool', id: 'notify', toolId: 'slack', options: { retries: 1 } }]);

    const outcome = await runWorkflow(compile(description), 'order', { runner });

    expect(runner.attempts).toEqual([
      { stepId: 'notify', attempt: 0 },
      { stepId: 'notify', attempt: 1 },
    ]);
    expect(outcome).toEqual({ status: 'failed', stepId: 'notify', path: [0], error: 'timeout 1' });
  });

  it('stops retrying at a non-retryable failure', async () => {
    const runner = new RecordingRunner({
      steps: { charge: () => ({ status: 'failed', error: 'fraud', nonRetryable: true }) },
    });
    const description = adapt([step('charge')], { retryConfig: { attempts: 3 } });

    const outcome = await runWorkflow(compile(description), 'order', { runner });

    expect(runner.attempts).toEqual([{ stepId: 'charge', attempt: 0 }]);
    expect(outcome).toEqual({ status: 'failed', stepId: 'charge', path: [0], error: 'fraud' });
  });

  it('retries a tripwire like any failure, then ends the run as a tripwire', async () => {
    // default.ts:463-505 — only MastraNonRetryableError skips retries; TripWire does not.
    const runner = new RecordingRunner({
      steps: { screen: () => ({ status: 'failed', error: 'blocked', tripwire: { reason: 'pii' } }) },
    });
    const description = adapt([step('screen')], { retryConfig: { attempts: 1 } });

    const outcome = await runWorkflow(compile(description), 'order', { runner });

    expect(runner.attempts).toHaveLength(2);
    // The failure's own error rides beside the tripwire.
    expect(outcome).toEqual({ status: 'tripwire', stepId: 'screen', path: [0], tripwire: { reason: 'pii' }, error: 'blocked' });
  });

  it("hands a .map() the run's input and any earlier step's result, and retries it by the workflow config", async () => {
    const runner = new RecordingRunner({
      steps: {
        validate: () => ({ status: 'success', output: { valid: true } }),
        enrich: () => ({ status: 'success', output: { tier: 'gold' } }),
        shape: (input, call) => {
          if (call.attempt === 0) return { status: 'failed', error: 'flaky' };
          const validated = call.getStepResult('validate');
          return {
            status: 'success',
            output: {
              source: call.source,
              order: call.initData,
              valid: validated?.status === 'success' ? validated.output : null,
              previous: input,
            },
          };
        },
      },
    });
    const description = adapt(
      [step('validate'), step('enrich', { retries: 0 }), { type: 'mapping', id: 'shape', mapConfig: {} }],
      { retryConfig: { attempts: 1 } },
    );

    const report = await runWorkflowDetailed(compile(description), { id: 'order-1' }, { runner });

    expect(report.outcome).toEqual({
      status: 'success',
      output: { source: 'mapping', order: { id: 'order-1' }, valid: { valid: true }, previous: { tier: 'gold' } },
    });
    expect(runner.attempts.filter((a) => a.stepId === 'shape')).toHaveLength(2);
    expect(report.stepResults.get('shape')).toMatchObject({ status: 'success' });
  });

  it('elapses a literal sleep exactly and hands the next entry the value that went in', async () => {
    const clock = new ManualClock();
    const runner = new RecordingRunner({
      steps: {
        charge: () => ({ status: 'success', output: 'charged' }),
        ship: (input) => ({ status: 'success', output: `${input as string}+shipped` }),
      },
    });
    const description = adapt([step('charge'), { type: 'sleep', id: 'settle', duration: 60_000 }, step('ship')]);

    const report = await runWorkflowDetailed(compile(description), 'order', { runner, clock });

    expect(report.outcome).toEqual({ status: 'success', output: 'charged+shipped' });
    expect(clock.elapsed()).toBe(60_000);
    // handlers/entry.ts records the sleep as a success whose output is its input; it began when
    // the entry was reached and ended when the wait did, on the run's clock.
    expect(report.stepResults.get('settle')).toEqual({
      status: 'success',
      output: 'charged',
      payload: 'charged',
      startedAt: clock.epochNow() - 60_000,
      endedAt: clock.epochNow(),
    });
  });

  it('sleeps for nothing after normalising a negative duration', async () => {
    const clock = new ManualClock();
    const description = adapt([{ type: 'sleep', id: 'wait', duration: -5 }, step('ship')]);

    const outcome = await runWorkflow(compile(description), 'order', { runner: new RecordingRunner(), clock });

    expect(outcome).toEqual({ status: 'success', output: 'order' });
    expect(clock.elapsed()).toBe(0);
  });

  it("waits a per-run duration that the runner resolves from the previous step's output", async () => {
    const clock = new ManualClock();
    const runner = new RecordingRunner({
      steps: { quote: () => ({ status: 'success', output: { backoffMs: 300 } }) },
      waits: { backoff: (input) => (input as { backoffMs: number }).backoffMs },
    });
    const description = adapt([step('quote'), { type: 'sleep', id: 'backoff', fn: () => 0 }, step('retry_quote')]);

    const outcome = await runWorkflow(compile(description), 'order', { runner, clock });

    expect(runner.calls).toEqual(['quote', 'retry_quote']);
    expect(outcome).toEqual({ status: 'success', output: { backoffMs: 300 } });
    expect(clock.elapsed()).toBe(300);
  });

  it('passes straight through a sleepUntil with no date', async () => {
    const clock = new ManualClock();
    const description = adapt([{ type: 'sleepUntil', id: 'noop' }, step('ship')]);

    const outcome = await runWorkflow(compile(description), 'order', { runner: new RecordingRunner(), clock });

    expect(outcome).toEqual({ status: 'success', output: 'order' });
    expect(clock.elapsed()).toBe(0);
  });

  /**
   * A literal `.sleepUntil` waits until the instant, measured on the run's clock when the entry is
   * reached — Mastra's `max(0, date - now)` (`default.ts:151-158`). This was an `it.fails` while
   * the leaf lowered it to `exact(fixed)`: libpetri timing is relative to enabling, so that waited
   * `fixed` milliseconds, about fifty-four years for a real date.
   */
  it('waits until a literal sleepUntil instant, not for that many milliseconds', async () => {
    const clock = new ManualClock();
    const date = new Date(clock.epochNow() + 1_000);
    const description = adapt([{ type: 'sleepUntil', id: 'open', date }, step('ship')]);

    const outcome = await runWorkflow(compile(description), 'order', { runner: new RecordingRunner(), clock });

    expect(outcome).toEqual({ status: 'success', output: 'order' });
    expect(clock.elapsed()).toBe(1_000);
  });

  it('keeps a __proto__ step id an ordinary key in the step results', async () => {
    const runner = new RecordingRunner({ steps: { ['__proto__']: () => ({ status: 'success', output: 'ok' }) } });
    const report = await runWorkflowDetailed(compile(adapt([step('__proto__')])), 'order', { runner });

    expect(report.outcome).toEqual({ status: 'success', output: 'ok' });
    expect(report.stepResults.get('__proto__')).toMatchObject({ status: 'success', output: 'ok', payload: 'order' });
  });
});

/** Each property's verdict, by segment and name — asserted whole, so `unknown` can never pass for `proven`. */
const verdicts = (reports: Awaited<ReturnType<typeof verifyWorkflow>>) =>
  Object.fromEntries(reports.map((r) => [`${segmentLabel(r.segment)}/${r.property}`, r.result.verdict.type]));
/** The fresh segments' verdicts, pinned literally, never derived. */
const FRESH_PROVEN = {
  'closed/deadlockFree': 'proven',
  'closed/terminatesAtSink': 'proven',
  'closed/exactlyOneTerminal': 'proven',
  'closed/neverCanceled': 'proven',
  'cancel/deadlockFree': 'proven',
  'cancel/terminatesAtSink': 'proven',
  'cancel/exactlyOneTerminal': 'proven',
};
/**
 * Every verdict `verifyWorkflow` returns by default for `compiled`, each `proven`: the fresh
 * segments, then `resume@s` and `resume@s+cancel` per registered site ([ADR 0007]). Keys come
 * from `segmentsFor`/`segmentLabel`; `neverCanceled` only where no cancel arrives; no budget here.
 */
function allProven(compiled: CompiledWorkflow): Record<string, string> {
  expect(compiled.budget).toBeUndefined();
  const keys = segmentsFor(compiled).flatMap((segment) => {
    const cancels = typeof segment === 'string' ? segment === 'cancel' : segment.cancel;
    return ['deadlockFree', 'terminatesAtSink', 'exactlyOneTerminal', ...(cancels ? [] : ['neverCanceled'])].map(
      (property) => `${segmentLabel(segment)}/${property}`,
    );
  });
  expect(keys.slice(0, 7)).toStrictEqual(Object.keys(FRESH_PROVEN));
  expect(keys).toHaveLength(7 + 7 * compiled.resumeSites.size);
  return Object.fromEntries(keys.map((key) => [key, 'proven']));
}
/** `property` in each of `segments`, with `verdict`: the exact flips a mutant causes. */
const each = (verdict: string, segments: readonly string[], ...properties: readonly string[]) =>
  Object.fromEntries(segments.flatMap((seg) => properties.map((p) => [`${seg}/${p}`, verdict])));
/** Every step of the flow can suspend, so every step's input is a resume site; a sleep is not. */
const SITES = ['0', '1', '2', '3', '8', '9'];
const routes = (reports: Awaited<ReturnType<typeof verifyWorkflow>>) => reports.map(describeReport).join('; ');

/**
 * A copy of the transition without its inhibitor on the cancel place; inputs, output, timing,
 * priority, action, reads, resets and every other inhibitor kept.
 */
function withoutCancelInhibitor(t: Transition, cancelName: string): Transition {
  const b = Transition.builder(t.name).inputs(...t.inputSpecs).timing(t.timing).priority(t.priority).action(t.action);
  if (t.outputSpec !== null) b.outputs(t.outputSpec);
  for (const a of t.inhibitors) if (a.place.name !== cancelName) b.inhibitor(a.place);
  for (const a of t.resets) b.reset(a.place);
  for (const a of t.reads) b.read(a.place);
  return b.build();
}

/** The real gadget, with the cancel inhibitor stripped from every transition whose name ends in `suffix`. */
const stripInhibitor = (gadget: Gadget, suffix: string): Gadget => (entry, next, ctx) => {
  const emitted = gadget(entry, next, ctx);
  if (ctx.cancel === undefined) return emitted;
  const cancelName = ctx.cancel.name;
  return {
    ...emitted,
    transitions: emitted.transitions.map((t) => (t.name.endsWith(suffix) ? withoutCancelInhibitor(t, cancelName) : t)),
  };
};

/**
 * A leaf-shaped workflow, adapted from Mastra's step flow and compiled with the default gadgets.
 *
 * Properties: `deadlockFree`, `terminatesAtSink` and `exactlyOneTerminal` in both segments, and
 * `neverCanceled` (`placeBound(wf.canceled, 0)`) in the closed one — `verifyWorkflow`'s default.
 * All six workflow terminals and the cancel place are declared sinks. Initial marking: one token
 * in the entry place; the `closed` segment leaves the cancel request place empty, the `cancel`
 * segment seeds it with one token whose arrival may fire at every reachable point. Environment
 * mode: none — every segment runs on the one closed net. The resume segments ([ADR 0007]):
 * `resume@s` and `resume@s+cancel` for every step's input (sites 0, 1, 2, 3, 8, 9), from one token
 * at the site, with the same property set. Route and time: printed by `describeReport`, on failure
 * and to the log. Before any proof, `verifyWorkflow` runs the structural checks and throws on a
 * violation.
 */
describe('an adapted leaf-shaped workflow, proved', () => {
  const flow: StepFlowEntry[] = [
    step('validate'),
    step('charge', { retries: 2 }),
    { type: 'agent', id: 'summarise', agentId: 'writer', options: { retries: 0 } },
    { type: 'mapping', id: 'shape', mapConfig: {} },
    { type: 'sleep', id: 'settle', duration: 250 },
    { type: 'sleep', id: 'backoff', fn: () => 1 },
    { type: 'sleepUntil', id: 'noop' },
    { type: 'sleepUntil', id: 'open', date: new Date(0) },
    nested('fulfil'),
    { type: 'tool', id: 'notify', toolId: 'slack' },
  ];
  const options = { retryConfig: { attempts: 1, delay: 100 } };

  it('is deadlock-free, terminates at a declared sink and marks exactly one terminal, with and without a cancel', async () => {
    const compiled = compile(adapt(flow, options));
    expect(cancelStructureViolations(compiled)).toEqual([]);

    const reports = await verifyWorkflow(compiled, { timeoutMs: 30_000 });
    console.log(`[proof] adapted leaf flow: ${routes(reports)}`);

    expect([...compiled.resumeSites.keys()].sort()).toStrictEqual(SITES);
    expect(verdicts(reports), routes(reports)).toStrictEqual(allProven(compiled));
  }, 180_000);

  it('is not proved vacuously: a step whose failure is routed nowhere breaks the properties that see it', async () => {
    // The safeguard the adapted flow relies on is the leaf routing each outcome to an exit. This
    // copy sends a step's failure to a place of its own that is no terminal; the same flow must
    // then stop proving, or the proof above says nothing. `cancel/terminatesAtSink` is blind by
    // design — the marked cancel place is a sink — and `neverCanceled` is about another thing.
    const orphaningStep: Gadget = (entry, next, ctx) =>
      stepGadget(entry, next, {
        ...ctx,
        exits: { ...ctx.exits, failed: place<FailureToken>(ctx.names.entryPlace(ctx.path, entry.id, 'orphan')) },
      });

    const mutant = compile(adapt(flow, options), { gadgets: { step: orphaningStep } });
    const reports = await verifyWorkflow(mutant, { timeoutMs: 30_000 });

    // Every site is a step, so every resumed segment can reach an orphaned failure too: the same
    // flips, segment for segment.
    const resumed = SITES.map((site) => `resume@${site}`);
    expect(verdicts(reports), routes(reports)).toStrictEqual({
      ...allProven(mutant),
      ...each('violated', ['closed', ...resumed], 'deadlockFree', 'terminatesAtSink', 'exactlyOneTerminal'),
      ...each('violated', ['cancel', ...resumed.map((r) => `${r}+cancel`)], 'deadlockFree', 'exactlyOneTerminal'),
    });
  }, 180_000);

  it('is not proved vacuously under cancellation: without the sweeps, a cancel strands the run', async () => {
    // The cancel safeguard this flow relies on is the sweep on every place where work waits to
    // start — a step's input, a sleep's, and a finished action-side wait's. Without them the
    // closed segment must stay green (a sweep never fires unless a cancel lands) and the cancel
    // segment must break.
    const withoutSweep = (gadget: Gadget): Gadget => (entry, next, ctx) => {
      const emitted = gadget(entry, next, ctx);
      return { ...emitted, transitions: emitted.transitions.filter((t) => !/\.cancel(-waited)?$/.test(t.name)) };
    };
    const compiled = compile(adapt(flow, options), {
      gadgets: { step: withoutSweep(stepGadget), sleep: withoutSweep(sleepGadget), sleepUntil: withoutSweep(sleepGadget) },
    });

    // Each step's input is also a resume site ([ADR 0007]), and a site with no sweep is what the
    // resume gate check names, exactly: `verifyWorkflow` refuses the mutant first, so the proofs
    // are asked for with the structural checks skipped.
    expect(resumeGateViolations(compiled)).toStrictEqual([
      "resume site 9 ('s.9.notify.in') has no sweep: nothing reads 'wf.cancel' and consumes it",
      "resume site 8 ('s.8.fulfil.in') has no sweep: nothing reads 'wf.cancel' and consumes it",
      "resume site 3 ('s.3.shape.in') has no sweep: nothing reads 'wf.cancel' and consumes it",
      "resume site 2 ('s.2.summarise.in') has no sweep: nothing reads 'wf.cancel' and consumes it",
      "resume site 1 ('s.1.charge.in') has no sweep: nothing reads 'wf.cancel' and consumes it",
      "resume site 0 ('s.0.validate.in') has no sweep: nothing reads 'wf.cancel' and consumes it",
    ]);
    await expect(verifyWorkflow(compiled)).rejects.toThrow(/resume gate structure is unsound/);
    const reports = await verifyWorkflow(compiled, { timeoutMs: 30_000, structure: 'skip' });
    console.log(`[proof] adapted leaf flow without sweeps: ${routes(reports)}`);
    // Every segment a cancel arrives in breaks, the resumed ones included; none without one does.
    expect(verdicts(reports), routes(reports)).toStrictEqual({
      ...allProven(compiled),
      ...each('violated', ['cancel', ...SITES.map((site) => `resume@${site}+cancel`)], 'deadlockFree', 'exactlyOneTerminal'),
    });
  }, 180_000);

  /**
   * No proof sees these: a start that lost its inhibitor still drains to exactly one terminal,
   * because the sweep beside it or the next entry's sweep ends the extra work. The structural
   * check names every one of them, exactly — and each has a run below that the stripped net
   * gets wrong.
   */
  it.each([
    ["a step's first attempt", 'step' as const, '.run', ['t.0.validate.run', 't.1.charge.run', 't.2.summarise.run', 't.3.shape.run', 't.8.fulfil.run', 't.9.notify.run']],
    ["a sleep's wake", 'sleep' as const, '.wake', ['t.4.settle.wake', 't.5.backoff.wake']],
    ["a sleepUntil's wake", 'sleepUntil' as const, '.wake', ['t.6.noop.wake', 't.7.open.wake']],
    ["a finished action-side wait's resume", 'sleep' as const, '.resume', ['t.5.backoff.resume']],
  ])('flags %s without its cancel inhibitor, naming the transition', async (_label, kind, suffix, expected) => {
    const base = kind === 'step' ? stepGadget : sleepGadget;
    const compiled = compile(adapt(flow, options), { gadgets: { [kind]: stripInhibitor(base, suffix) } });
    const violations = cancelStructureViolations(compiled);

    const named = [...new Set(violations.map((v) => /^'([^']+)'/.exec(v)?.[1]))].sort();
    expect(named, violations.join('\n')).toEqual([...expected].sort());
    await expect(verifyWorkflow(compiled)).rejects.toThrow(/cancellation structure is unsound/);
  });
});

/**
 * Cancellation through an adapted flow, end to end: `adapt` -> `compile` -> `runWorkflow` with a
 * signal. Mastra checks its abort signal before each top-level entry (`default.ts:815`) and
 * re-stamps an entry's result `canceled` after it returns while the step's record keeps its real
 * outcome (`handlers/entry.ts:810-817`); it never checks inside a step or between retries
 * (`default.ts:455-460`), and a sleep ends early through `abortableSleep`.
 */
describe('an adapted flow, canceled', () => {
  const flow: StepFlowEntry[] = [
    step('validate'),
    step('charge'),
    { type: 'sleep', id: 'settle', duration: 60_000 },
    { type: 'sleep', id: 'backoff', fn: () => 0 },
    { type: 'tool', id: 'ship', toolId: 'courier' },
  ];
  const options = { retryConfig: { attempts: 1, delay: 100 } };
  const compiled = compile(adapt(flow, options));
  const noWait = { backoff: () => 0 };

  it('runs nothing when the signal is already aborted, and cancels at the first entry', async () => {
    // default.ts:815 checks before the first entry. Red while the kernel seeds a pre-aborted run's
    // signal into the cancel *request* place: the first entry's start and the arrival are then
    // both enabled at once, and the start wins. Seeding `compiled.cancel` itself fixes it.
    const aborted = new AbortController();
    aborted.abort();
    const runner = new RecordingRunner({ waits: noWait });

    const report = await runWorkflowDetailed(compiled, 'order', { runner, signal: aborted.signal });

    expect(report.outcome).toEqual({ status: 'canceled', origin: { stepId: 'validate', path: [0] }, started: false });
    expect(runner.calls).toEqual([]);
    expect(report.stepResults.size).toBe(0);
  });

  it('lets the step in flight finish and be recorded, then starts nothing after it', async () => {
    const controller = new AbortController();
    const clock = new ManualClock();
    const runner = new RecordingRunner({
      steps: {
        validate: (input) => {
          controller.abort();
          return { status: 'success', output: `${input as string}+valid` };
        },
      },
      waits: noWait,
    });

    const report = await runWorkflowDetailed(compiled, 'order', { runner, clock, signal: controller.signal });

    expect(report.outcome).toEqual({ status: 'canceled', origin: { stepId: 'charge', path: [1] }, started: false });
    expect(runner.calls).toEqual(['validate']);
    expect([...report.stepResults.keys()]).toEqual(['validate']);
    // The record keeps its real outcome, and Mastra reads it as the success it was.
    expect(toMastraStepResult(report.stepResults.get('validate')!)).toEqual({
      status: 'success',
      output: 'order+valid',
      payload: 'order',
      startedAt: clock.epochNow(),
      endedAt: clock.epochNow(),
    });
  });

  it('keeps retrying a step after the abort, as Mastra never checks between attempts', async () => {
    const controller = new AbortController();
    const clock = new ManualClock();
    const runner = new RecordingRunner({
      steps: {
        charge: (_input, call) => {
          if (call.attempt === 0) {
            controller.abort();
            return { status: 'failed', error: 'declined' };
          }
          return { status: 'success', output: 'charged' };
        },
      },
      waits: noWait,
    });

    const report = await runWorkflowDetailed(compiled, 'order', { runner, clock, signal: controller.signal });

    expect(runner.attempts.filter((a) => a.stepId === 'charge').map((a) => a.attempt)).toEqual([0, 1]);
    expect(clock.elapsed()).toBe(100);
    expect(report.stepResults.get('charge')).toMatchObject({ status: 'success', output: 'charged' });
    // The literal sleep after it never starts: the run ends at it, not sixty seconds later.
    expect(report.outcome).toEqual({ status: 'canceled', origin: { stepId: 'settle', path: [2] }, started: false });
    expect(report.stepResults.has('settle')).toBe(false);
  });

  it('re-stamps a failure that lands with the abort as canceled, keeping the failure on the record', async () => {
    const controller = new AbortController();
    const runner = new RecordingRunner({
      steps: {
        validate: () => {
          controller.abort();
          return { status: 'failed', error: 'invalid', nonRetryable: true };
        },
      },
      waits: noWait,
    });

    const report = await runWorkflowDetailed(compiled, 'order', { runner, signal: controller.signal });

    expect(report.outcome).toEqual({ status: 'canceled', origin: { stepId: 'validate', path: [0] }, started: true });
    expect(toMastraStepResult(report.stepResults.get('validate')!)).toMatchObject({
      status: 'failed',
      error: expect.objectContaining({ message: 'invalid' }),
      nonRetryable: true,
    });
  });

  it('ends a literal sleep in progress at once', async () => {
    const controller = new AbortController();
    const runner = new RecordingRunner({
      steps: {
        charge: (input) => {
          setTimeout(() => controller.abort(), 50);
          return { status: 'success', output: input };
        },
      },
      waits: noWait,
    });
    const started = performance.now();

    const outcome = await runWorkflow(compiled, 'order', { runner, signal: controller.signal, timeoutMs: 10_000 });

    expect(outcome).toEqual({ status: 'canceled', origin: { stepId: 'settle', path: [2] }, started: true });
    expect(runner.calls).toEqual(['validate', 'charge']);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('ends a per-run sleep in progress early and cancels at the sleep, keeping only its waiting record', async () => {
    // handlers/entry.ts:605-609 writes `{status: 'waiting'}` before the wait; :642-643 then takes
    // the aborted branch — `execResults = { status: 'canceled' }` — and never reaches the success
    // write at :665. `isSingleStepEntry` excludes a sleep (utils.ts:301), so :812 does not
    // overwrite it either: a sleep cut short is never a success, and the entry itself is canceled.
    const controller = new AbortController();
    const short = compile(adapt([step('quote'), { type: 'sleep', id: 'backoff', fn: () => 0 }, step('ship')]));
    const runner = new RecordingRunner({
      waits: {
        backoff: () => {
          setTimeout(() => controller.abort(), 50);
          return 60_000;
        },
      },
    });
    const started = performance.now();

    const report = await runWorkflowDetailed(short, 'order', { runner, signal: controller.signal, timeoutMs: 10_000 });

    expect(report.outcome).toEqual({ status: 'canceled', origin: { stepId: 'backoff', path: [1] }, started: true });
    expect(runner.calls).toEqual(['quote']);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(report.stepResults.get('backoff')).toEqual({ status: 'waiting', payload: 'order', startedAt: expect.any(Number) });
    // Mastra's accessor answers `null` for anything but a success (`step.ts:179-193`).
    expect(getStepResultView({ getStepResult: (id) => report.stepResults.get(id), initData: 'order' })('backoff')).toBeNull();
    expect([...report.stepResults.keys()]).toEqual(['quote', 'backoff']);
    expect(toMastraStepResult(report.stepResults.get('backoff')!)).toEqual({
      status: 'waiting',
      payload: 'order',
      startedAt: expect.any(Number),
    });
  });

  it('ends a literal sleepUntil in progress early and cancels at it, keeping only its waiting record', async () => {
    // A literal sleepUntil waits in the action, like a per-run one (entry.ts:752-776 is the same
    // aborted branch as :642 for the sleepUntil path).
    const controller = new AbortController();
    const until = compile(adapt([step('quote'), { type: 'sleepUntil', id: 'open', date: new Date(Date.now() + 60_000) }, step('ship')]));
    const runner = new RecordingRunner({
      steps: {
        quote: (input) => {
          setTimeout(() => controller.abort(), 50);
          return { status: 'success', output: input };
        },
      },
    });
    const started = performance.now();

    const report = await runWorkflowDetailed(until, 'order', { runner, signal: controller.signal, timeoutMs: 10_000 });

    expect(report.outcome).toEqual({ status: 'canceled', origin: { stepId: 'open', path: [1] }, started: true });
    expect(runner.calls).toEqual(['quote']);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(report.stepResults.get('open')).toEqual({ status: 'waiting', payload: 'order', startedAt: expect.any(Number) });
    expect([...report.stepResults.keys()]).toEqual(['quote', 'open']);
  });

  it('never asks for a per-run wait once the abort landed before the sleep', async () => {
    // default.ts:815 checks before the entry; Mastra never calls the sleep's `fn`.
    const controller = new AbortController();
    const waited: string[] = [];
    const runner = new RecordingRunner({
      steps: {
        quote: (input) => {
          controller.abort();
          return { status: 'success', output: input };
        },
      },
      waits: { backoff: () => (waited.push('backoff'), 0) },
    });

    const report = await runWorkflowDetailed(
      compile(adapt([step('quote'), { type: 'sleep', id: 'backoff', fn: () => 0 }, step('ship')])),
      'order',
      { runner, signal: controller.signal },
    );

    expect(report.outcome).toEqual({ status: 'canceled', origin: { stepId: 'backoff', path: [1] }, started: false });
    expect(waited).toEqual([]);
    expect([...report.stepResults.keys()]).toEqual(['quote']);
  });

  /**
   * The runs the structurally flagged mutants get wrong. A stripped sleep wake asks for the wait
   * after the abort; a stripped resume records the cut-short sleep as a success and cancels at the
   * next entry — the defect this adapter's tests once pinned as fidelity. A stripped first-attempt
   * inhibitor on a step has **no** run that shows it: the sweep beside it takes the token first,
   * so the structural check above is its only witness.
   */
  describe('without the inhibitors the structural check demands', () => {
    const sleepy = [step('quote'), { type: 'sleep', id: 'backoff', fn: () => 0 }, step('ship')] as const satisfies readonly StepFlowEntry[];

    it('asks for a per-run wait after the abort once the wake is ungated', async () => {
      const controller = new AbortController();
      const waited: string[] = [];
      const runner = new RecordingRunner({
        steps: { quote: (input) => (controller.abort(), { status: 'success', output: input }) },
        waits: { backoff: () => (waited.push('backoff'), 0) },
      });
      const mutant = compile(adapt(sleepy), { gadgets: { sleep: stripInhibitor(sleepGadget, '.wake') } });

      const report = await runWorkflowDetailed(mutant, 'order', { runner, signal: controller.signal, timeoutMs: 10_000 });

      expect(waited).toEqual(['backoff']);
      expect(report.outcome.status).toBe('canceled');
    });

    it('records a cut-short sleep as a success once the resume is ungated', async () => {
      const controller = new AbortController();
      const runner = new RecordingRunner({
        waits: { backoff: () => (setTimeout(() => controller.abort(), 50), 60_000) },
      });
      const mutant = compile(adapt(sleepy), { gadgets: { sleep: stripInhibitor(sleepGadget, '.resume') } });

      const report = await runWorkflowDetailed(mutant, 'order', { runner, signal: controller.signal, timeoutMs: 10_000 });

      expect(report.stepResults.get('backoff')).toMatchObject({ status: 'success' });
      expect(report.outcome).toEqual({ status: 'canceled', origin: { stepId: 'ship', path: [2] }, started: false });
    });
  });

  it('re-stamps a run whose last step succeeded as canceled, naming no entry', async () => {
    const controller = new AbortController();
    const runner = new RecordingRunner({
      steps: {
        ship: (input) => {
          controller.abort();
          return { status: 'success', output: `${input as string}+shipped` };
        },
      },
      waits: noWait,
    });

    const report = await runWorkflowDetailed(compile(adapt([step('pack'), { type: 'tool', id: 'ship', toolId: 'courier' }])), 'order', {
      runner,
      signal: controller.signal,
    });

    expect(report.outcome).toEqual({ status: 'canceled', started: true });
    expect(report.stepResults.get('ship')).toMatchObject({ status: 'success', output: 'order+shipped' });
  });

  it('runs to success with a signal that never fires, and a late abort changes nothing', async () => {
    const controller = new AbortController();
    const clock = new ManualClock();
    const runner = new RecordingRunner({ waits: noWait });

    const outcome = await runWorkflow(compiled, 'order', { runner, clock, signal: controller.signal });
    controller.abort();

    expect(outcome).toEqual({ status: 'success', output: 'order' });
    expect(runner.calls).toEqual(['validate', 'charge', 'ship']);
    expect(clock.elapsed()).toBe(60_000);
  });
});

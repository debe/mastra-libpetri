import { describe, expect, it } from 'vitest';
import { Transition, one, outPlace, place, xor } from 'libpetri';
import {
  compile,
  MAX_NET_PLACES, MAX_RETRIES, MAX_WAIT_MS,
  stepAction,
  stepGadget,
  type Gadget,
} from '../../src/compiler/index.js';
import { runWorkflow, runWorkflowDetailed } from '../../src/engine/index.js';
import { describeReport, verifyWorkflow, type PropertyReport } from '../../src/verify/index.js';
import type {
  EntryDescription,
  FlowToken,
  RunView,
  StepDescription,
  StepOutcome,
  SuspendToken,
  WorkflowDescription,
} from '../../src/compiler/types.js';
import { RecordingRunner, type Behaviour } from '../fixtures/runner.js';
import { ManualClock } from '../support/manual-clock.js';

/**
 * The leaf gadgets — a step with its retries, and `.sleep` / `.sleepUntil` — tested against
 * Mastra's own source (`@mastra/core@1.67.0`, recovered from its sourcemaps):
 *
 * - `default.ts:455-511` `executeStepWithRetry`: `retries + 1` executions, a fixed delay before
 *   every attempt but the first, `MastraNonRetryableError` the only short-circuit, a `TripWire`
 *   retried like any error and serialised onto the final failure only.
 * - `handlers/step.ts:514-529`: suspend > bail > paused > success, none of them a failure, so none
 *   of them retried.
 * - `handlers/entry.ts:810`: `stepResults[id]` is written once, after the retry loop returns.
 * - `default.ts:926-928`: a top-level `bailed` ends the run and is rewritten to `success`.
 * - `default.ts:609-628`: a failure carrying a tripwire is reported as run status `tripwire`,
 *   with `tripwire` set and `error` unset.
 * - `handlers/sleep.ts:130-136,256-276`, `utils.ts:230-251`: a missing/zero/NaN/negative duration
 *   and a past instant wait 0; an Invalid Date or a wait past the timer ceiling wakes after ~1ms
 *   in Mastra, a defect this engine refuses rather than reproduces (divergence rows 9, 10).
 * - `handlers/entry.ts:664-665,775-776`: a sleep records `{status:'success', output: <its input>}`.
 */

const EPOCH = 1_700_000_000_000;

const wf = (...entries: EntryDescription[]): WorkflowDescription => ({ id: 'leaf', entries });
const step = (id: string, extra: Omit<StepDescription, 'kind' | 'id'> = {}): StepDescription => ({
  kind: 'step',
  id,
  ...extra,
});

interface Stamp {
  readonly id: string;
  readonly attempt: number;
  readonly at: number;
}

/**
 * Wraps each named step so every attempt records the virtual instant it started at. Built with
 * `Object.fromEntries`, never `obj[id] = v`, so a step called `__proto__` is an own key.
 */
function stamped(
  clock: ManualClock,
  log: Stamp[],
  ids: readonly string[],
  behaviours: Readonly<Record<string, Behaviour>> = {},
): Record<string, Behaviour> {
  return Object.fromEntries(
    ids.map((id): [string, Behaviour] => [
      id,
      (input, call) => {
        log.push({ id, attempt: call.attempt, at: clock.now() });
        const behaviour = Object.hasOwn(behaviours, id) ? behaviours[id] : undefined;
        return behaviour !== undefined ? behaviour(input, call) : { status: 'success', output: input };
      },
    ]),
  );
}

/** The first instant `id` started, from a {@link stamped} log. */
function firstAt(log: readonly Stamp[], id: string): number | undefined {
  return log.find((s) => s.id === id)?.at;
}

/** A failure outcome whose error is an `Error` with a message matching `message`. */
function failedWith(stepId: string, message: RegExp): unknown {
  return {
    status: 'failed',
    stepId,
    error: expect.objectContaining({ message: expect.stringMatching(message) }),
  };
}

function expectBothProven(reports: readonly PropertyReport[]): void {
  expect(reports.map((r) => r.property)).toEqual(['deadlockFree', 'terminatesAtSink', 'exactlyOneTerminal']);
  for (const report of reports) {
    // `proven`, explicitly: `isViolated()` is false for `unknown` too.
    expect(report.result.verdict.type, describeReport(report)).toBe('proven');
  }
}

function verdictOf(reports: readonly PropertyReport[], property: string): string | undefined {
  return reports.find((r) => r.property === property)?.result.verdict.type;
}

// ---------------------------------------------------------------------------------------------

describe('step retries (executeStepWithRetry, default.ts:455-511)', () => {
  it('runs a step retries + 1 times, handing each attempt its 0-based number', async () => {
    const errors = [new Error('e0'), new Error('e1'), new Error('e2')];
    const runner = new RecordingRunner({
      steps: { charge: (_input, call) => ({ status: 'failed', error: errors[call.attempt] }) },
    });

    const outcome = await runWorkflow(compile(wf(step('charge', { retries: 2 }))), 'order', { runner });

    // `for (let i = 0; i < retries + 1; i++)`: retries: 2 is three executions, not two.
    expect(runner.attempts).toEqual([
      { stepId: 'charge', attempt: 0 },
      { stepId: 'charge', attempt: 1 },
      { stepId: 'charge', attempt: 2 },
    ]);
    // The run reports the LAST attempt's error.
    expect(outcome).toEqual({ status: 'failed', stepId: 'charge', error: errors[2] });
  });

  it('stops retrying at the first success and hands every attempt the same input', async () => {
    const inputs: unknown[] = [];
    const runner = new RecordingRunner({
      steps: {
        charge: (input, call) => {
          inputs.push(input);
          return call.attempt < 2
            ? { status: 'failed', error: `declined ${call.attempt}` }
            : { status: 'success', output: `${input as string}+charged` };
        },
      },
    });

    const outcome = await runWorkflow(
      compile(wf(step('charge', { retries: 5 }), step('ship'))),
      'order',
      { runner },
    );

    expect(runner.calls).toEqual(['charge', 'charge', 'charge', 'ship']);
    expect(inputs).toEqual(['order', 'order', 'order']);
    expect(outcome).toEqual({ status: 'success', output: 'order+charged' });
  });

  it('waits retryDelayMs between attempts in virtual time, and never before the first', async () => {
    const clock = new ManualClock();
    const log: Stamp[] = [];
    const runner = new RecordingRunner({
      steps: stamped(clock, log, ['prep', 'charge', 'ship'], {
        charge: (_input, call) =>
          call.attempt < 2 ? { status: 'failed', error: 'busy' } : { status: 'success', output: 'charged' },
      }),
    });

    const outcome = await runWorkflow(
      compile(wf(step('prep'), step('charge', { retries: 3, retryDelayMs: 250 }), step('ship'))),
      'order',
      { runner, clock },
    );

    expect(outcome).toEqual({ status: 'success', output: 'charged' });
    // `if (i > 0 && params.delay) await setTimeout(delay)`: attempt 0 runs at once, each later
    // attempt exactly one fixed delay after the previous one finished. No backoff.
    expect(log).toEqual([
      { id: 'prep', attempt: 0, at: 0 },
      { id: 'charge', attempt: 0, at: 0 },
      { id: 'charge', attempt: 1, at: 250 },
      { id: 'charge', attempt: 2, at: 500 },
      { id: 'ship', attempt: 0, at: 500 },
    ]);
    // The unused fourth attempt's delay is never waited.
    expect(clock.elapsed()).toBe(500);
  });

  it('retries at the same instant when retryDelayMs is 0', async () => {
    const clock = new ManualClock();
    const log: Stamp[] = [];
    const runner = new RecordingRunner({
      steps: stamped(clock, log, ['charge'], { charge: () => ({ status: 'failed', error: 'busy' }) }),
    });

    await runWorkflow(compile(wf(step('charge', { retries: 2 }))), 'order', { runner, clock });

    expect(log.map((s) => s.at)).toEqual([0, 0, 0]);
    expect(clock.elapsed()).toBe(0);
  });

  it('short-circuits the remaining retries on a nonRetryable failure', async () => {
    const fatal = new Error('permanent');
    const runner = new RecordingRunner({
      steps: { charge: () => ({ status: 'failed', error: fatal, nonRetryable: true }) },
    });

    const { outcome, stepResults } = await runWorkflowDetailed(
      compile(wf(step('charge', { retries: 3 }), step('ship'))),
      'order',
      { runner },
    );

    expect(runner.calls).toEqual(['charge']);
    expect(outcome).toEqual({ status: 'failed', stepId: 'charge', error: fatal });
    expect(stepResults.get('charge')).toEqual({ status: 'failed', error: fatal, nonRetryable: true });
  });

  it('honours nonRetryable on a later attempt, after ordinary failures were retried', async () => {
    const runner = new RecordingRunner({
      steps: {
        charge: (_input, call) =>
          call.attempt === 0
            ? { status: 'failed', error: 'transient' }
            : { status: 'failed', error: 'permanent', nonRetryable: true },
      },
    });

    const outcome = await runWorkflow(compile(wf(step('charge', { retries: 4 }))), 'order', { runner });

    expect(runner.attempts.map((a) => a.attempt)).toEqual([0, 1]);
    expect(outcome).toEqual({ status: 'failed', stepId: 'charge', error: 'permanent' });
  });

  it('retries a TripWire like any error, and ends the run as tripwire when the last attempt carries one', async () => {
    const runner = new RecordingRunner({
      steps: {
        guard: (_input, call) => ({
          status: 'failed',
          error: new Error(`blocked ${call.attempt}`),
          tripwire: { reason: `blocked ${call.attempt}`, processorId: 'moderation' },
        }),
      },
    });

    const outcome = await runWorkflow(compile(wf(step('guard', { retries: 2 }), step('reply'))), 'q', { runner });

    // TripWire is not in the nonRetryable check (`default.ts:463`), so all three attempts run.
    expect(runner.calls).toEqual(['guard', 'guard', 'guard']);
    // `fmtReturnValue` sets `tripwire` and leaves `error` unset (`default.ts:622-628`).
    expect(outcome).toEqual({
      status: 'tripwire',
      stepId: 'guard',
      tripwire: { reason: 'blocked 2', processorId: 'moderation' },
    });
  });

  it('forgets a tripwire from an earlier attempt when a later one succeeds', async () => {
    const runner = new RecordingRunner({
      steps: {
        guard: (input, call) =>
          call.attempt === 0
            ? { status: 'failed', error: 'blocked', tripwire: { reason: 'blocked' } }
            : { status: 'success', output: input },
      },
    });

    const outcome = await runWorkflow(compile(wf(step('guard', { retries: 1 }))), 'q', { runner });

    expect(outcome).toEqual({ status: 'success', output: 'q' });
  });

  it('reports failed, not tripwire, when only an earlier attempt carried the tripwire', async () => {
    const runner = new RecordingRunner({
      steps: {
        guard: (_input, call) =>
          call.attempt === 0
            ? { status: 'failed', error: 'blocked', tripwire: { reason: 'blocked' } }
            : { status: 'failed', error: 'plain' },
      },
    });

    const outcome = await runWorkflow(compile(wf(step('guard', { retries: 1 }))), 'q', { runner });

    // Only the final `e` is inspected for `instanceof TripWire` (`default.ts:498-506`).
    expect(outcome).toEqual({ status: 'failed', stepId: 'guard', error: 'plain' });
  });

  it.each([
    [
      'bailed',
      { status: 'bailed', output: 'early' },
      { status: 'success', output: 'early', bailed: true },
    ],
    [
      'suspended',
      { status: 'suspended', payload: { ask: 'approve' } },
      { status: 'suspended', stepId: 'charge', path: [0], payload: { ask: 'approve' } },
    ],
    ['paused', { status: 'paused' }, { status: 'paused', stepId: 'charge', path: [0] }],
  ] as const)('never retries a %s outcome', async (_name, result, expected) => {
    const runner = new RecordingRunner({ steps: { charge: () => result as StepOutcome } });

    const outcome = await runWorkflow(compile(wf(step('charge', { retries: 3 }), step('ship'))), 'o', { runner });

    // None of the three is a thrown error, so `executeStepWithRetry` returns `ok: true` on the
    // first attempt (`handlers/step.ts:514-529`).
    expect(runner.calls).toEqual(['charge']);
    expect(outcome).toEqual(expected);
  });

  it('records only the final attempt in stepResults, never an intermediate failure', async () => {
    const seenOwnResult: (StepOutcome | undefined)[] = [];
    const runner = new RecordingRunner({
      steps: {
        charge: (_input, call) => {
          seenOwnResult.push(call.getStepResult('charge'));
          return call.attempt < 2
            ? { status: 'failed', error: `e${call.attempt}` }
            : { status: 'success', output: 'ok' };
        },
      },
    });

    const { outcome, stepResults } = await runWorkflowDetailed(
      compile(wf(step('charge', { retries: 2 }))),
      'order',
      { runner },
    );

    expect(outcome).toEqual({ status: 'success', output: 'ok' });
    // `stepResults[id] = execResults` runs once, after the retry loop (`handlers/entry.ts:810`),
    // so no attempt ever sees an earlier attempt's failure recorded under its own id.
    expect(seenOwnResult).toEqual([undefined, undefined, undefined]);
    expect([...stepResults]).toEqual([['charge', { status: 'success', output: 'ok' }]]);
  });

  it('records the final failure, not the first, when every attempt fails', async () => {
    const runner = new RecordingRunner({
      steps: { charge: (_input, call) => ({ status: 'failed', error: `e${call.attempt}` }) },
    });

    const { stepResults } = await runWorkflowDetailed(compile(wf(step('charge', { retries: 2 }))), 'o', { runner });

    expect(stepResults.get('charge')).toEqual({ status: 'failed', error: 'e2' });
  });

  it('retries a throwing runner, as Mastra retries a throwing execute', async () => {
    const runner = new RecordingRunner({
      steps: {
        charge: (input, call) => {
          if (call.attempt === 0) throw new Error('provider down');
          return { status: 'success', output: input };
        },
      },
    });

    const outcome = await runWorkflow(compile(wf(step('charge', { retries: 1 }))), 'order', { runner });

    expect(runner.calls).toEqual(['charge', 'charge']);
    expect(outcome).toEqual({ status: 'success', output: 'order' });
  });

  it('emits exactly one transition and no retry places for retries: 0', () => {
    const explicitZero = compile(wf(step('charge', { retries: 0 })));
    const absent = compile(wf(step('charge')));

    expect([...explicitZero.net.transitions].map((t) => t.name)).toEqual(['t.0.charge.run']);
    const placeNames = [...explicitZero.net.places].map((p) => p.name).sort();
    expect(placeNames).toEqual(['s.0.charge.in', 'wf.bailed', 'wf.done', 'wf.failed', 'wf.paused', 'wf.suspended']);
    // The run transition has exactly the five outcome branches and no retry branch.
    const run = [...explicitZero.net.transitions][0]!;
    expect([...run.outputPlaces()].map((p) => p.name).sort()).toEqual([
      'wf.bailed',
      'wf.done',
      'wf.failed',
      'wf.paused',
      'wf.suspended',
    ]);
    // An explicit 0 and an absent value are the same net.
    expect(explicitZero.structuralHash).toBe(absent.structuralHash);
  });

  it('unrolls retries into one run transition per attempt, the last without a retry branch', () => {
    const compiled = compile(wf(step('charge', { retries: 2, retryDelayMs: 250 })));
    const byName = new Map([...compiled.net.transitions].map((t) => [t.name, t]));

    expect([...byName.keys()].sort()).toEqual([
      't.0.charge.retry-1',
      't.0.charge.retry-2',
      't.0.charge.run',
      't.0.charge.run-1',
      't.0.charge.run-2',
    ]);
    const outputs = (name: string) => [...byName.get(name)!.outputPlaces()].map((p) => p.name).sort();
    expect(outputs('t.0.charge.run')).toContain('s.0.charge.retry-1');
    expect(outputs('t.0.charge.run-1')).toContain('s.0.charge.retry-2');
    expect(outputs('t.0.charge.run-2')).toEqual(['wf.bailed', 'wf.done', 'wf.failed', 'wf.paused', 'wf.suspended']);
    // The delay sits on the retry arcs only.
    expect(byName.get('t.0.charge.run')!.timing).toEqual({ type: 'immediate' });
    expect(byName.get('t.0.charge.retry-1')!.timing).toEqual({ type: 'delayed', afterMs: 250 });
    expect(byName.get('t.0.charge.retry-2')!.timing).toEqual({ type: 'delayed', afterMs: 250 });
    // Every attempt maps back to the one entry that emitted it.
    for (const name of byName.keys()) {
      expect(compiled.netMap.transitionToEntry.get(name)).toEqual({ path: [0], id: 'charge' });
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe('step outcomes at the top level', () => {
  const chain = wf(step('a'), step('b'), step('c'));

  it('carries each output into the next step and ends in success', async () => {
    const runner = new RecordingRunner({
      steps: {
        a: (input) => ({ status: 'success', output: `${input as string}+a` }),
        b: (input) => ({ status: 'success', output: `${input as string}+b` }),
        c: (input) => ({ status: 'success', output: `${input as string}+c` }),
      },
    });

    const { outcome, stepResults } = await runWorkflowDetailed(compile(chain), 'x', { runner });

    expect(outcome).toEqual({ status: 'success', output: 'x+a+b+c' });
    expect([...stepResults]).toEqual([
      ['a', { status: 'success', output: 'x+a' }],
      ['b', { status: 'success', output: 'x+a+b' }],
      ['c', { status: 'success', output: 'x+a+b+c' }],
    ]);
  });

  it('ends the run on a failure and never calls the steps after it', async () => {
    const runner = new RecordingRunner({ steps: { b: () => ({ status: 'failed', error: 'declined' }) } });

    const { outcome, stepResults } = await runWorkflowDetailed(compile(chain), 'x', { runner });

    expect(runner.calls).toEqual(['a', 'b']);
    expect(outcome).toEqual({ status: 'failed', stepId: 'b', error: 'declined' });
    expect(stepResults.get('b')).toEqual({ status: 'failed', error: 'declined' });
    expect(stepResults.has('c')).toBe(false);
  });

  it('ends the run as tripwire, with no error field, when the failure carries one', async () => {
    const runner = new RecordingRunner({
      steps: { b: () => ({ status: 'failed', error: new Error('blocked'), tripwire: { reason: 'blocked' } }) },
    });

    const outcome = await runWorkflow(compile(chain), 'x', { runner });

    expect(runner.calls).toEqual(['a', 'b']);
    expect(outcome).toEqual({ status: 'tripwire', stepId: 'b', tripwire: { reason: 'blocked' } });
  });

  it('ends the run as a success carrying bailed: true on bail, and stops the chain', async () => {
    const runner = new RecordingRunner({ steps: { b: () => ({ status: 'bailed', output: 'early' }) } });

    const { outcome, stepResults } = await runWorkflowDetailed(compile(chain), 'x', { runner });

    // `if (status === 'bailed') status = 'success'` and return (`default.ts:926-928`): the bail
    // payload is the run's result and every later entry is skipped.
    expect(runner.calls).toEqual(['a', 'b']);
    expect(outcome).toEqual({ status: 'success', output: 'early', bailed: true });
    // Mastra rewrites the bailing entry's own record to 'success' when the bail ends the run
    // (`default.ts:926-928` mutates the object `stepResults` holds), and so does the kernel.
    expect(stepResults.get('b')).toEqual({ status: 'success', output: 'early' });
    expect(stepResults.has('c')).toBe(false);
  });

  it('ends the run suspended, carrying the step and its execution path', async () => {
    const runner = new RecordingRunner({
      steps: { b: () => ({ status: 'suspended', payload: { ask: 'approve' }, output: { draft: 1 } }) },
    });

    const { outcome, stepResults } = await runWorkflowDetailed(compile(chain), 'x', { runner });

    expect(runner.calls).toEqual(['a', 'b']);
    // `suspendedPaths[step.id] = executionPath` (`handlers/step.ts:395-397`).
    expect(outcome).toEqual({ status: 'suspended', stepId: 'b', path: [1], payload: { ask: 'approve' } });
    expect(stepResults.get('b')).toEqual({ status: 'suspended', payload: { ask: 'approve' }, output: { draft: 1 } });
  });

  it('ends the run paused when a nested-workflow step pauses', async () => {
    const runner = new RecordingRunner({ steps: { b: () => ({ status: 'paused' }) } });

    const outcome = await runWorkflow(
      compile(wf(step('a'), step('b', { source: 'workflow' }), step('c'))),
      'x',
      { runner },
    );

    expect(runner.calls).toEqual(['a', 'b']);
    expect(outcome).toEqual({ status: 'paused', stepId: 'b', path: [1] });
  });

  it('hands the runner what Mastra hands execute: initData, path, source, and earlier step results', async () => {
    const views: { stepId: string; path: readonly number[]; source: string; initData: unknown; a: unknown }[] = [];
    const record: Behaviour = (input, call) => {
      views.push({
        stepId: views.length === 0 ? 'a' : 'b',
        path: call.path,
        source: call.source,
        initData: call.initData,
        a: call.getStepResult('a'),
      });
      return { status: 'success', output: `${input as string}!` };
    };
    const runner = new RecordingRunner({ steps: { a: record, b: record } });

    await runWorkflow(compile(wf(step('a'), step('b', { source: 'agent' }))), 'init', { runner });

    expect(views).toEqual([
      { stepId: 'a', path: [0], source: 'step', initData: 'init', a: undefined },
      { stepId: 'b', path: [1], source: 'agent', initData: 'init', a: { status: 'success', output: 'init!' } },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------

describe('fixed sleep and sleepUntil in virtual time', () => {
  it('wakes a fixed sleep exactly its duration later', async () => {
    const clock = new ManualClock(EPOCH);
    const log: Stamp[] = [];
    const runner = new RecordingRunner({ steps: stamped(clock, log, ['a', 'b']) });

    const outcome = await runWorkflow(
      compile(wf(step('a'), { kind: 'sleep', id: 'nap', duration: { fixed: 60_000 } }, step('b'))),
      'x',
      { runner, clock },
    );

    expect(outcome).toEqual({ status: 'success', output: 'x' });
    expect(log).toEqual([
      { id: 'a', attempt: 0, at: 0 },
      { id: 'b', attempt: 0, at: 60_000 },
    ]);
    expect(clock.elapsed()).toBe(60_000);
  });

  it('wakes a fixed sleep of 0 at once', async () => {
    const clock = new ManualClock(EPOCH);
    const log: Stamp[] = [];
    const runner = new RecordingRunner({ steps: stamped(clock, log, ['b']) });

    await runWorkflow(compile(wf({ kind: 'sleep', id: 'nap', duration: { fixed: 0 } }, step('b'))), 'x', {
      runner,
      clock,
    });

    expect(firstAt(log, 'b')).toBe(0);
  });

  it('wakes a fixed sleepUntil at its epoch instant', async () => {
    const clock = new ManualClock(EPOCH);
    const log: Stamp[] = [];
    const runner = new RecordingRunner({ steps: stamped(clock, log, ['a', 'b']) });

    const outcome = await runWorkflow(
      compile(wf(step('a'), { kind: 'sleepUntil', id: 'until', until: { fixed: EPOCH + 60_000 } }, step('b'))),
      'x',
      { runner, clock },
    );

    // `abortableSleep(date.getTime() - Date.now())` (`default.ts:151-158`): the wait is the
    // instant minus now — 60s here — not the instant read as a duration.
    expect(outcome).toEqual({ status: 'success', output: 'x' });
    expect(firstAt(log, 'b')).toBe(60_000);
    expect(clock.elapsed()).toBe(60_000);
  });

  it('wakes a fixed sleepUntil whose instant has already passed at once', async () => {
    const clock = new ManualClock(EPOCH);
    const log: Stamp[] = [];
    const runner = new RecordingRunner({ steps: stamped(clock, log, ['b']) });

    const outcome = await runWorkflow(
      compile(wf({ kind: 'sleepUntil', id: 'until', until: { fixed: EPOCH - 5_000 } }, step('b'))),
      'x',
      { runner, clock },
    );

    // `setTimeout(resolve, Math.max(0, negative))` (`utils.ts:246`): a past instant waits 0.
    expect(outcome).toEqual({ status: 'success', output: 'x' });
    expect(firstAt(log, 'b')).toBe(0);
    expect(clock.elapsed()).toBe(0);
  });

  it('fails the run on a fixed sleepUntil further away than the timer ceiling', async () => {
    const clock = new ManualClock(EPOCH);
    const runner = new RecordingRunner();

    const outcome = await runWorkflow(
      compile(wf({ kind: 'sleepUntil', id: 'until', until: { fixed: EPOCH + MAX_WAIT_MS + 1 } }, step('b'))),
      'x',
      { runner, clock },
    );

    // `setTimeout(resolve, date - now)` past 2^31-1 wakes after ~1ms in Mastra (`utils.ts:230-251`)
    // — the defect of divergence row 9, which the per-run form refuses at run time. The instant
    // is fixed but the remaining wait is not known until the run reaches it, so it cannot be
    // refused at compile time; it must fail the run as the per-run form does.
    expect(outcome).toEqual(failedWith('until', /timer ceiling/));
    expect(runner.calls).toEqual([]);
  });

  it.each([
    ['sleep', { kind: 'sleep', id: 'nap', duration: { fixed: 1_000 } }],
    ['sleepUntil', { kind: 'sleepUntil', id: 'nap', until: { fixed: EPOCH + 1_000 } }],
  ] as const)('a fixed %s records success with its own input as output', async (_kind, sleep) => {
    const clock = new ManualClock(EPOCH);
    const runner = new RecordingRunner({ steps: { a: () => ({ status: 'success', output: 'A' }) } });

    const { outcome, stepResults } = await runWorkflowDetailed(compile(wf(step('a'), sleep, step('b'))), 'x', {
      runner,
      clock,
    });

    // `stepResults[entry.id] = { status: 'success', output: prevOutput }` (`handlers/entry.ts:665,776`).
    expect(stepResults.get('nap')).toEqual({ status: 'success', output: 'A' });
    expect(outcome).toEqual({ status: 'success', output: 'A' });
  });
});

// ---------------------------------------------------------------------------------------------

describe('per-run sleep and sleepUntil (resolveWait)', () => {
  const perRunSleep = (id = 'nap'): EntryDescription => ({ kind: 'sleep', id, duration: { perRun: true } });
  const perRunUntil = (id = 'until'): EntryDescription => ({ kind: 'sleepUntil', id, until: { perRun: true } });

  it('waits the duration resolved for this run, handing resolveWait the previous output and the run view', async () => {
    const clock = new ManualClock(EPOCH);
    const log: Stamp[] = [];
    const seen: { input: unknown; view: Omit<RunView, 'getStepResult'>; a: unknown }[] = [];
    const runner = new RecordingRunner({
      steps: stamped(clock, log, ['a', 'b'], { a: () => ({ status: 'success', output: { waitMs: 250 } }) }),
      waits: {
        nap: (input, view) => {
          seen.push({ input, view: { path: view.path, initData: view.initData }, a: view.getStepResult('a') });
          return (input as { waitMs: number }).waitMs;
        },
      },
    });

    const { outcome, stepResults } = await runWorkflowDetailed(compile(wf(step('a'), perRunSleep(), step('b'))), 'init', {
      runner,
      clock,
    });

    // `fn({ inputData: prevOutput, getInitData, getStepResult, ... })` (`handlers/sleep.ts:86-99`).
    expect(seen).toEqual([
      {
        input: { waitMs: 250 },
        view: { path: [1], initData: 'init' },
        a: { status: 'success', output: { waitMs: 250 } },
      },
    ]);
    expect(firstAt(log, 'b')).toBe(250);
    expect(clock.elapsed()).toBe(250);
    expect(stepResults.get('nap')).toEqual({ status: 'success', output: { waitMs: 250 } });
    expect(outcome).toEqual({ status: 'success', output: { waitMs: 250 } });
  });

  it('waits until the instant resolved for this run', async () => {
    const clock = new ManualClock(EPOCH);
    const log: Stamp[] = [];
    const runner = new RecordingRunner({
      steps: stamped(clock, log, ['b']),
      waits: { until: () => clock.epochNow() + 7_000 },
    });

    const { outcome, stepResults } = await runWorkflowDetailed(compile(wf(perRunUntil(), step('b'))), 'x', {
      runner,
      clock,
    });

    expect(outcome).toEqual({ status: 'success', output: 'x' });
    expect(firstAt(log, 'b')).toBe(7_000);
    expect(stepResults.get('until')).toEqual({ status: 'success', output: 'x' });
  });

  it('waits 0 for a per-run instant already in the past', async () => {
    const clock = new ManualClock(EPOCH);
    const log: Stamp[] = [];
    const runner = new RecordingRunner({
      steps: stamped(clock, log, ['b']),
      waits: { until: () => clock.epochNow() - 5_000 },
    });

    const outcome = await runWorkflow(compile(wf(perRunUntil(), step('b'))), 'x', { runner, clock });

    expect(outcome).toEqual({ status: 'success', output: 'x' });
    expect(firstAt(log, 'b')).toBe(0);
    expect(clock.elapsed()).toBe(0);
  });

  it.each([
    ['NaN', Number.NaN],
    ['negative', -100],
    ['zero', 0],
    ['undefined', undefined as unknown as number],
  ])('waits 0 for a %s per-run duration, as Mastra\'s !duration || duration < 0', async (_name, value) => {
    const clock = new ManualClock(EPOCH);
    const log: Stamp[] = [];
    const runner = new RecordingRunner({ steps: stamped(clock, log, ['b']), waits: { nap: () => value } });

    const outcome = await runWorkflow(compile(wf(perRunSleep(), step('b'))), 'x', { runner, clock });

    // `!duration || duration < 0 ? 0 : duration` (`handlers/sleep.ts:132`): NaN is falsy.
    expect(outcome).toEqual({ status: 'success', output: 'x' });
    expect(firstAt(log, 'b')).toBe(0);
    expect(clock.elapsed()).toBe(0);
  });

  it('honours a per-run duration of exactly the timer ceiling', async () => {
    const clock = new ManualClock(EPOCH);
    const log: Stamp[] = [];
    const runner = new RecordingRunner({ steps: stamped(clock, log, ['b']), waits: { nap: () => MAX_WAIT_MS } });

    const outcome = await runWorkflow(compile(wf(perRunSleep(), step('b'))), 'x', { runner, clock });

    // Node accepts delays up to 2^31-1 inclusive; only a larger one is reset to 1ms.
    expect(outcome).toEqual({ status: 'success', output: 'x' });
    expect(firstAt(log, 'b')).toBe(MAX_WAIT_MS);
  });

  it('fails the run on a per-run NaN instant rather than waking after ~1ms', async () => {
    const clock = new ManualClock(EPOCH);
    const runner = new RecordingRunner({ waits: { until: () => Number.NaN } });

    const { outcome, stepResults } = await runWorkflowDetailed(compile(wf(perRunUntil(), step('b'))), 'x', {
      runner,
      clock,
    });

    // Mastra: an Invalid Date is truthy, `NaN - Date.now()` reaches `setTimeout(NaN)`, which
    // Node resets to 1ms (`handlers/sleep.ts:256-276`). A defect, refused (divergence row 10).
    expect(outcome).toEqual(failedWith('until', /not a valid instant/));
    expect(runner.calls).toEqual([]);
    expect(stepResults.get('until')?.status).not.toBe('success');
  });

  it.each([
    ['sleep', 'nap', () => MAX_WAIT_MS + 1],
    ['sleep', 'nap', () => Number.POSITIVE_INFINITY],
    ['sleepUntil', 'until', (clock: ManualClock) => clock.epochNow() + MAX_WAIT_MS + 1],
  ] as const)('fails the run on a per-run %s past the timer ceiling (%#)', async (kind, id, resolve) => {
    const clock = new ManualClock(EPOCH);
    const runner = new RecordingRunner({ waits: { [id]: () => resolve(clock) } });
    const entry = kind === 'sleep' ? perRunSleep(id) : perRunUntil(id);

    const outcome = await runWorkflow(compile(wf(entry, step('b'))), 'x', { runner, clock });

    // Mastra wakes after ~1ms here (`utils.ts:230-251`); divergence row 9.
    expect(outcome).toEqual(failedWith(id, /timer ceiling/));
    expect(runner.calls).toEqual([]);
    expect(clock.elapsed()).toBe(0);
  });

  it('fails the run with the thrown error when resolveWait throws', async () => {
    const boom = new Error('bad wait fn');
    const runner = new RecordingRunner({
      waits: {
        nap: () => {
          throw boom;
        },
      },
    });

    const outcome = await runWorkflow(compile(wf(step('a'), perRunSleep(), step('b'))), 'x', { runner });

    // Mastra rejects `run.start()` outright here, with no run status at all
    // (`handlers/sleep.ts:83-128`); a failed run is the nearest outcome a net can declare.
    expect(outcome).toEqual({ status: 'failed', stepId: 'nap', error: boom });
    expect(runner.calls).toEqual(['a']);
  });

  it('fails the run when the runner has no resolveWait', async () => {
    const runner = new RecordingRunner();
    expect(runner.resolveWait).toBeUndefined();

    const outcome = await runWorkflow(compile(wf(step('a'), perRunSleep(), step('b'))), 'x', { runner });

    expect(outcome).toEqual(failedWith('nap', /no resolveWait/));
    expect(runner.calls).toEqual(['a']);
  });
});

// ---------------------------------------------------------------------------------------------

describe('compile-time refusals', () => {
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_RETRIES + 1])('refuses retries of %s', (retries) => {
    expect(() => compile(wf(step('charge', { retries })))).toThrow(
      new RegExp(`step 'charge': retries must be an integer in \\[0, ${MAX_RETRIES}\\]`),
    );
  });

  it('accepts retries at the ceiling', () => {
    expect(() => compile(wf(step('charge', { retries: MAX_RETRIES })))).not.toThrow();
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, MAX_WAIT_MS + 1])('refuses retryDelayMs of %s', (retryDelayMs) => {
    expect(() => compile(wf(step('charge', { retries: 1, retryDelayMs })))).toThrow(
      /step 'charge': retryDelayMs must be in \[0, 2147483647\]/,
    );
  });

  it('accepts retryDelayMs at both ends of its range', () => {
    expect(() => compile(wf(step('charge', { retries: 1, retryDelayMs: 0 })))).not.toThrow();
    expect(() => compile(wf(step('charge', { retries: 1, retryDelayMs: MAX_WAIT_MS })))).not.toThrow();
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, MAX_WAIT_MS + 1])('refuses a fixed sleep of %s', (fixed) => {
    expect(() => compile(wf({ kind: 'sleep', id: 'nap', duration: { fixed } }))).toThrow(
      /sleep 'nap': a fixed wait must be a finite duration in \[0, 2147483647\]ms/,
    );
  });

  it('accepts a fixed sleep at both ends of its range', () => {
    expect(() => compile(wf({ kind: 'sleep', id: 'nap', duration: { fixed: 0 } }))).not.toThrow();
    expect(() => compile(wf({ kind: 'sleep', id: 'nap', duration: { fixed: MAX_WAIT_MS } }))).not.toThrow();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'refuses a fixed sleepUntil of %s',
    (fixed) => {
      expect(() => compile(wf({ kind: 'sleepUntil', id: 'until', until: { fixed } }))).toThrow(
        /sleepUntil 'until': a fixed wait must be a finite epoch instant/,
      );
    },
  );
});

// ---------------------------------------------------------------------------------------------

describe('structuralHash over leaf entries', () => {
  const hash = (...entries: EntryDescription[]) => compile(wf(...entries)).structuralHash;

  it('is equal for equal shapes built from distinct objects', () => {
    const build = (): EntryDescription[] => [
      step('a', { retries: 2, retryDelayMs: 100, source: 'tool' }),
      { kind: 'sleep', id: 'nap', duration: { fixed: 500 } },
      { kind: 'sleepUntil', id: 'until', until: { perRun: true } },
    ];
    expect(hash(...build())).toBe(hash(...build()));
  });

  it('treats an absent retries / source as their defaults', () => {
    expect(hash(step('a'))).toBe(hash(step('a', { retries: 0, retryDelayMs: 0, source: 'step' })));
  });

  it.each([
    ['retries', step('a', { retries: 1 })],
    ['retryDelayMs', step('a', { retries: 1, retryDelayMs: 100 })],
    ['source', step('a', { source: 'workflow' })],
    ['id', step('b')],
  ] as const)('differs when %s differs', (_field, changed) => {
    expect(hash(changed)).not.toBe(hash(step('a')));
  });

  it('differs when retryDelayMs differs at equal retries', () => {
    expect(hash(step('a', { retries: 1, retryDelayMs: 100 }))).not.toBe(hash(step('a', { retries: 1, retryDelayMs: 200 })));
  });

  it('differs when a fixed duration or instant differs', () => {
    expect(hash({ kind: 'sleep', id: 'nap', duration: { fixed: 100 } })).not.toBe(
      hash({ kind: 'sleep', id: 'nap', duration: { fixed: 200 } }),
    );
    expect(hash({ kind: 'sleepUntil', id: 'nap', until: { fixed: EPOCH } })).not.toBe(
      hash({ kind: 'sleepUntil', id: 'nap', until: { fixed: EPOCH + 1 } }),
    );
  });

  it('hashes a per-run wait without a value', () => {
    const perRun = hash({ kind: 'sleep', id: 'nap', duration: { perRun: true } });

    expect(perRun).toBe(hash({ kind: 'sleep', id: 'nap', duration: { perRun: true } }));
    for (const fixed of [0, 1, 1_000]) {
      expect(perRun).not.toBe(hash({ kind: 'sleep', id: 'nap', duration: { fixed } }));
    }
    // The kind still counts: a per-run sleep is not a per-run sleepUntil.
    expect(perRun).not.toBe(hash({ kind: 'sleepUntil', id: 'nap', until: { perRun: true } }));
  });
});

// ---------------------------------------------------------------------------------------------

/**
 * Every proof below: properties `deadlockFree` and `terminatesAtSink`, initial marking one token
 * in the entry place, no environment places (a closed net), all five terminals declared as sinks,
 * route reported by `describeReport` on failure.
 */
describe('leaf chains, proved', () => {
  it('proves a plain chain', async () => {
    expectBothProven(await verifyWorkflow(compile(wf(step('a'), step('b'), step('c')))));
  }, 90_000);

  it('proves a chain with unrolled retries and a retry delay', async () => {
    expectBothProven(
      await verifyWorkflow(
        compile(wf(step('a', { retries: 2, retryDelayMs: 100 }), step('b'), step('c', { retries: 1 }))),
      ),
    );
  }, 90_000);

  it('proves a chain with a fixed sleep', async () => {
    expectBothProven(
      await verifyWorkflow(compile(wf(step('a'), { kind: 'sleep', id: 'nap', duration: { fixed: 60_000 } }, step('b')))),
    );
  }, 90_000);

  it('proves a chain with a per-run sleep and a per-run sleepUntil', async () => {
    expectBothProven(
      await verifyWorkflow(
        compile(
          wf(
            step('a'),
            { kind: 'sleep', id: 'nap', duration: { perRun: true } },
            { kind: 'sleepUntil', id: 'until', until: { perRun: true } },
            step('b', { retries: 1 }),
          ),
        ),
      ),
    );
  }, 90_000);
});

describe('non-vacuity of the leaf', () => {
  /**
   * A copy of `stepGadget` (no-retry path) whose `xor` drops the `failed` branch while the action
   * still routes a failure there. The declared structure no longer says a step can fail.
   */
  const withoutFailedBranch: Gadget = (entry, next, ctx) => {
    if (entry.kind !== 'step') throw new Error(`mutant received a '${entry.kind}' entry`);
    const inPlace = place<FlowToken>(ctx.names.entryIn(ctx.path, entry.id));
    const run = Transition.builder(ctx.names.entryRun(ctx.path, entry.id))
      .inputs(one(inPlace))
      .outputs(
        xor(outPlace(next), outPlace(ctx.exits.bailed), outPlace(ctx.exits.suspended), outPlace(ctx.exits.paused)),
      )
      .action(
        stepAction({
          stepId: entry.id,
          path: ctx.path,
          source: entry.source ?? 'step',
          attempt: 0,
          from: inPlace,
          next,
          exits: ctx.exits,
          retry: undefined,
        }),
      )
      .build();
    return { inPlace, transitions: [run] };
  };

  it('dropping the failed branch flips a failing run from failed to a lost token', async () => {
    const description = wf(step('a'), step('b'), step('c'));
    const failing = () => new RecordingRunner({ steps: { b: () => ({ status: 'failed', error: 'declined' }) } });

    const intact = await runWorkflow(compile(description), 'x', { runner: failing() });
    const mutantRunner = failing();
    const mutant = await runWorkflow(compile(description, { gadgets: { step: withoutFailedBranch } }), 'x', {
      runner: mutantRunner,
    });

    expect(intact).toEqual({ status: 'failed', stepId: 'b', error: 'declined' });
    // The Out spec is enforced at run time: the undeclared write is refused, the consumed input
    // is not restored ([EXEC-031]), and the run reaches no terminal at all.
    expect(mutant).toEqual({ status: 'stranded', places: [] });
    expect(mutantRunner.calls).toEqual(['a', 'b']);
  });

  it('the proofs cannot see that drop: they reason over the declared branches only', async () => {
    // Why the hard rule "every transition carries a real Out spec, never skipOutputValidation"
    // matters: the mutant still proves, because the verifier reads the Out spec, and only the
    // run-time validation above catches an action that writes outside it.
    expectBothProven(
      await verifyWorkflow(compile(wf(step('a'), step('b')), { gadgets: { step: withoutFailedBranch } })),
    );
  }, 90_000);

  it('routing one exit to a place that is not a terminal flips deadlockFree to violated', async () => {
    const lost = place<SuspendToken>('lost.suspended');
    const suspendsNowhere: Gadget = (entry, next, ctx) =>
      stepGadget(entry, next, { ...ctx, exits: { ...ctx.exits, suspended: lost } });
    const description = wf(step('a'), step('b'));

    const reports = await verifyWorkflow(compile(description, { gadgets: { step: suspendsNowhere } }));
    const runner = new RecordingRunner({ steps: { b: () => ({ status: 'suspended', payload: 'p' }) } });
    const outcome = await runWorkflow(compile(description, { gadgets: { step: suspendsNowhere } }), 'x', { runner });

    // Baseline (same shape, intact gadget) is proven in 'proves a plain chain'.
    expect(verdictOf(reports, 'deadlockFree'), reports.map(describeReport).join('; ')).toBe('violated');
    expect(verdictOf(reports, 'terminatesAtSink'), reports.map(describeReport).join('; ')).toBe('violated');
    expect(outcome).toEqual({ status: 'stranded', places: ['lost.suspended'] });
  }, 90_000);
});

describe('a rejection carrying no reason is still a rejection', () => {
  it.each([
    ['throws undefined', () => { throw undefined; }],
    ['rejects with no reason', () => Promise.reject()],
  ])('resolveWait that %s fails the sleep instead of skipping the wait', async (_label, wait) => {
    const runner = new RecordingRunner({ waits: { nap: wait as unknown as () => number } });
    const description = wf({ kind: 'sleep', id: 'nap', duration: { perRun: true } }, step('b'));
    const report = await runWorkflowDetailed(compile(description), 'x', { runner });

    expect(report.outcome).toEqual({ status: 'failed', stepId: 'nap', error: undefined });
    expect(runner.calls).toEqual([]);
    expect(report.stepResults.has('nap')).toBe(false);
  });
});

describe('a per-run duration is coerced as setTimeout coerces it', () => {
  it("waits 250ms for the string '250', as Mastra's timer would", async () => {
    const clock = new ManualClock();
    const runner = new RecordingRunner({ waits: { nap: () => '250' as unknown as number } });
    const outcome = await runWorkflow(compile(wf({ kind: 'sleep', id: 'nap', duration: { perRun: true } })), 'x', {
      runner,
      clock,
    });
    expect(outcome).toEqual({ status: 'success', output: 'x' });
    expect(clock.elapsed()).toBe(250);
  });

  it('fails with a message naming the value for a non-numeric string', async () => {
    const runner = new RecordingRunner({ waits: { nap: () => 'soon' as unknown as number } });
    const outcome = await runWorkflow(compile(wf({ kind: 'sleep', id: 'nap', duration: { perRun: true } })), 'x', { runner });
    expect(outcome).toEqual(failedWith('nap', /resolved to "soon", which is not a duration/));
  });
});

describe('the net-size stopgap', () => {
  // A chain of 4092 steps is 4092 input places plus the five terminals: 4097, one over.
  it('refuses a workflow whose net exceeds MAX_NET_PLACES, naming the limit', () => {
    const entries = Array.from({ length: MAX_NET_PLACES - 4 }, (_, i) => step(`s${i}`));
    expect(() => compile(wf(...entries))).toThrow(new RegExp(`compiles to ${MAX_NET_PLACES + 1} places, above the ${MAX_NET_PLACES}`));
  });

  it('compiles one exactly at the limit', () => {
    const entries = Array.from({ length: MAX_NET_PLACES - 5 }, (_, i) => step(`s${i}`));
    expect(compile(wf(...entries)).net.places.size).toBe(MAX_NET_PLACES);
  });
});

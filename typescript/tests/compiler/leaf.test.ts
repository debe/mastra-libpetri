import { describe, expect, it } from 'vitest';
import { Transition, one, outPlace, place, xor, type Place } from 'libpetri';
import {
  compile,
  MAX_NET_PLACES, MAX_RETRIES, MAX_WAIT_MS,
  stepAction,
  sleepGadget,
  stepGadget,
  type Gadget,
} from '../../src/compiler/index.js';
import { runWorkflow, runWorkflowDetailed } from '../../src/engine/index.js';
import { cancelStructureViolations, describeReport, verifyWorkflow, type PropertyReport } from '../../src/verify/index.js';
import type {
  CanceledToken,
  EntryDescription,
  Exits,
  FlowToken,
  RunView,
  StepCall,
  StepDescription,
  StepOutcome,
  StepRecord,
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
 * - `handlers/entry.ts:602-609`: before that, when the sleep BEGINS, `{status:'waiting', payload,
 *   startedAt}` — left in place when the run is canceled mid-wait or the sleep fn throws. A fixed
 *   sleep is `begin` -> `waiting` -> `wake`, so a sweep on `in` (never began, `started: false`) is
 *   a different transition from one on `waiting` (mid-wait, `started: true`).
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
function failedWith(stepId: string, message: RegExp, path: readonly number[] = [0]): unknown {
  return {
    status: 'failed',
    stepId,
    path,
    error: expect.objectContaining({ message: expect.stringMatching(message) }),
  };
}

/** Every report `verifyWorkflow` returns by default, in order: both segments on one closed net. */
const ALL_REPORTS = [
  'closed/deadlockFree',
  'closed/terminatesAtSink',
  'closed/exactlyOneTerminal',
  'closed/neverCanceled',
  'cancel/deadlockFree',
  'cancel/terminatesAtSink',
  'cancel/exactlyOneTerminal',
];

function expectAllProven(reports: readonly PropertyReport[]): void {
  expect(reports.map((r) => `${r.segment}/${r.property}`)).toEqual(ALL_REPORTS);
  for (const report of reports) {
    // `proven`, explicitly: `isViolated()` is false for `unknown` too.
    expect(report.result.verdict.type, describeReport(report)).toBe('proven');
  }
}

/**
 * Proves the default property set: the structural cancel check first (it throws on a violation),
 * then the closed segment (no cancel request: `deadlockFree`, `terminatesAtSink`,
 * `exactlyOneTerminal`, `neverCanceled`) and the cancel segment (one request seeded, so the arrival
 * lands at every reachable point: the first three). All seven must be `proven`.
 */
async function expectProvenBothSegments(description: WorkflowDescription): Promise<void> {
  expectAllProven(await verifyWorkflow(compile(description)));
}

/**
 * A step's record as the store holds it (`StepRecord`): the outcome, the input it received as
 * `payload`, and timestamps on the run's clock. `toEqual`, not `toMatchObject`, so a field the
 * record should not carry still fails the assertion.
 */
function rec(fields: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
  return { ...fields, startedAt: expect.any(Number), endedAt: expect.any(Number), ...extra };
}

function verdictOf(reports: readonly PropertyReport[], property: string, segment = 'closed'): string | undefined {
  return reports.find((r) => r.property === property && r.segment === segment)?.result.verdict.type;
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
    expect(outcome).toEqual({ status: 'failed', stepId: 'charge', path: [0], error: errors[2] });
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
    expect(outcome).toEqual({ status: 'failed', stepId: 'charge', path: [0], error: fatal });
    expect(stepResults.get('charge')).toEqual(rec({ status: 'failed', error: fatal, nonRetryable: true, payload: 'order' }));
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
    expect(outcome).toEqual({ status: 'failed', stepId: 'charge', path: [0], error: 'permanent' });
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
    // `fmtReturnValue` sets `tripwire` and leaves the run result's `error` unset
    // (`default.ts:622-628`). The kernel's outcome still carries the final attempt's `error` beside
    // it — the contract changed so `result.ts` can fall back to it when the value is an `Error` but
    // not a Mastra `TripWire`; dropping `error` from the run result is the formatter's job.
    expect(outcome).toEqual({
      status: 'tripwire',
      stepId: 'guard',
      path: [0],
      tripwire: { reason: 'blocked 2', processorId: 'moderation' },
      error: expect.objectContaining({ message: 'blocked 2' }),
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
    expect(outcome).toEqual({ status: 'failed', stepId: 'guard', path: [0], error: 'plain' });
  });

  it.each([
    [
      'bailed',
      { status: 'bailed', output: 'early' },
      // A bail now names the step that bailed (`At`), so the result can place it on the path.
      { status: 'success', output: 'early', bailed: true, stepId: 'charge', path: [0] },
    ],
    [
      'suspended',
      { status: 'suspended', suspendPayload: { ask: 'approve' } },
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
    const seenOwnResult: (StepRecord | undefined)[] = [];
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
    expect([...stepResults]).toEqual([['charge', rec({ status: 'success', output: 'ok', payload: 'order' })]]);
  });

  it('records the final failure, not the first, when every attempt fails', async () => {
    const runner = new RecordingRunner({
      steps: { charge: (_input, call) => ({ status: 'failed', error: `e${call.attempt}` }) },
    });

    const { stepResults } = await runWorkflowDetailed(compile(wf(step('charge', { retries: 2 }))), 'o', { runner });

    expect(stepResults.get('charge')).toEqual(rec({ status: 'failed', error: 'e2', payload: 'o' }));
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

  it('emits one run transition, its cancel sweep, and no retry places for retries: 0', () => {
    const explicitZero = compile(wf(step('charge', { retries: 0 })));
    const absent = compile(wf(step('charge')));

    const own = [...explicitZero.net.transitions].filter((t) => explicitZero.netMap.transitionToEntry.has(t.name));
    expect(own.map((t) => t.name).sort()).toEqual(['t.0.charge.cancel', 't.0.charge.run']);
    const placeNames = [...explicitZero.net.places].map((p) => p.name).sort();
    expect(placeNames).toEqual([
      's.0.charge.in',
      'wf.bailed',
      'wf.cancel',
      'wf.cancel.request',
      'wf.canceled',
      'wf.done',
      'wf.failed',
      'wf.paused',
      'wf.settle.bailed',
      'wf.settle.done',
      'wf.settle.failed',
      'wf.settle.paused',
      'wf.settle.suspended',
      'wf.suspended',
    ]);
    // The run transition has exactly the five outcome branches — each into the settle stage, where
    // the after-entry abort check lives — and no retry branch and no canceled branch: a step that
    // ran reports what it did, and only the settle stage re-stamps it.
    const run = own.find((t) => t.name === 't.0.charge.run')!;
    expect([...run.outputPlaces()].map((p) => p.name).sort()).toEqual([
      'wf.settle.bailed',
      'wf.settle.done',
      'wf.settle.failed',
      'wf.settle.paused',
      'wf.settle.suspended',
    ]);
    // An explicit 0 and an absent value are the same net.
    expect(explicitZero.structuralHash).toBe(absent.structuralHash);
  });

  it('gates the first attempt on the cancel place, sweeps the waiting input, and leaves retries ungated', () => {
    const compiled = compile(wf(step('charge', { retries: 2, retryDelayMs: 250 })));
    const byName = new Map([...compiled.net.transitions].map((t) => [t.name, t]));
    const inhibitors = (name: string) => byName.get(name)!.inhibitors.map((a) => a.place.name);
    const reads = (name: string) => byName.get(name)!.reads.map((a) => a.place.name);

    // Mastra checks the signal before a top-level entry (`default.ts:815`) ...
    expect(inhibitors('t.0.charge.run')).toEqual(['wf.cancel']);
    // ... and never between attempts (`default.ts:455-460`): no retry and no later run is gated.
    for (const name of ['t.0.charge.retry-1', 't.0.charge.run-1', 't.0.charge.retry-2', 't.0.charge.run-2']) {
      expect(inhibitors(name), name).toEqual([]);
      expect(reads(name), name).toEqual([]);
    }
    // The sweep reads the signal, consumes the waiting input, and writes only the canceled exit.
    const sweep = byName.get('t.0.charge.cancel')!;
    expect(reads('t.0.charge.cancel')).toEqual(['wf.cancel']);
    expect([...sweep.inputPlaces()].map((p) => p.name)).toEqual(['s.0.charge.in']);
    expect([...sweep.outputPlaces()].map((p) => p.name)).toEqual(['wf.canceled']);
    // Nothing consumes the signal: it stays marked once injected.
    for (const t of compiled.net.transitions) {
      expect([...t.inputPlaces()].map((p) => p.name), t.name).not.toContain('wf.cancel');
    }
  });

  it('unrolls retries into one run transition per attempt, the last without a retry branch', () => {
    const compiled = compile(wf(step('charge', { retries: 2, retryDelayMs: 250 })));
    const byName = new Map([...compiled.net.transitions].map((t) => [t.name, t]));

    expect([...byName.keys()].filter((n) => n.startsWith('t.0.')).sort()).toEqual([
      't.0.charge.cancel',
      't.0.charge.retry-1',
      't.0.charge.retry-2',
      't.0.charge.run',
      't.0.charge.run-1',
      't.0.charge.run-2',
    ]);
    const outputs = (name: string) => [...byName.get(name)!.outputPlaces()].map((p) => p.name).sort();
    expect(outputs('t.0.charge.run')).toContain('s.0.charge.retry-1');
    expect(outputs('t.0.charge.run-1')).toContain('s.0.charge.retry-2');
    expect(outputs('t.0.charge.run-2')).toEqual([
      'wf.settle.bailed',
      'wf.settle.done',
      'wf.settle.failed',
      'wf.settle.paused',
      'wf.settle.suspended',
    ]);
    // The delay sits on the retry arcs only.
    expect(byName.get('t.0.charge.run')!.timing).toEqual({ type: 'immediate' });
    expect(byName.get('t.0.charge.retry-1')!.timing).toEqual({ type: 'delayed', afterMs: 250 });
    expect(byName.get('t.0.charge.retry-2')!.timing).toEqual({ type: 'delayed', afterMs: 250 });
    // Every attempt maps back to the one entry that emitted it.
    for (const name of [...byName.keys()].filter((n) => n.startsWith('t.0.'))) {
      expect(compiled.netMap.transitionToEntry.get(name)).toEqual({ path: [0], id: 'charge' });
    }
    // The settle stage belongs to the workflow, not to any entry.
    for (const name of [...byName.keys()].filter((n) => n.startsWith('t.settle.'))) {
      expect(compiled.netMap.transitionToEntry.has(name), name).toBe(false);
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
      ['a', rec({ status: 'success', output: 'x+a', payload: 'x' })],
      ['b', rec({ status: 'success', output: 'x+a+b', payload: 'x+a' })],
      ['c', rec({ status: 'success', output: 'x+a+b+c', payload: 'x+a+b' })],
    ]);
  });

  it('ends the run on a failure and never calls the steps after it', async () => {
    const runner = new RecordingRunner({ steps: { b: () => ({ status: 'failed', error: 'declined' }) } });

    const { outcome, stepResults } = await runWorkflowDetailed(compile(chain), 'x', { runner });

    expect(runner.calls).toEqual(['a', 'b']);
    expect(outcome).toEqual({ status: 'failed', stepId: 'b', path: [1], error: 'declined' });
    expect(stepResults.get('b')).toEqual(rec({ status: 'failed', error: 'declined', payload: 'x' }));
    expect(stepResults.has('c')).toBe(false);
  });

  // Was "with no error field": the kernel's outcome now carries the failure's `error` beside the
  // tripwire (contract change); Mastra's run result still has none, which `result.ts` enforces.
  it('ends the run as tripwire, carrying the failure\'s error beside it, when the failure carries one', async () => {
    const runner = new RecordingRunner({
      steps: { b: () => ({ status: 'failed', error: new Error('blocked'), tripwire: { reason: 'blocked' } }) },
    });

    const outcome = await runWorkflow(compile(chain), 'x', { runner });

    expect(runner.calls).toEqual(['a', 'b']);
    expect(outcome).toEqual({
      status: 'tripwire',
      stepId: 'b',
      path: [1],
      tripwire: { reason: 'blocked' },
      error: expect.objectContaining({ message: 'blocked' }),
    });
  });

  it('ends the run as a success carrying bailed: true on bail, and stops the chain', async () => {
    const runner = new RecordingRunner({ steps: { b: () => ({ status: 'bailed', output: 'early' }) } });

    const { outcome, stepResults } = await runWorkflowDetailed(compile(chain), 'x', { runner });

    // `if (status === 'bailed') status = 'success'` and return (`default.ts:926-928`): the bail
    // payload is the run's result and every later entry is skipped.
    expect(runner.calls).toEqual(['a', 'b']);
    // The bail carries its origin: the step that bailed and its view path.
    expect(outcome).toEqual({ status: 'success', output: 'early', bailed: true, stepId: 'b', path: [1] });
    // Mastra rewrites the bailing entry's own record to 'success' when the bail ends the run
    // (`default.ts:926-928` mutates the object `stepResults` holds), and so does the kernel.
    expect(stepResults.get('b')).toEqual(rec({ status: 'success', output: 'early', payload: 'x' }));
    expect(stepResults.has('c')).toBe(false);
  });

  it('ends the run suspended, carrying the step and its execution path', async () => {
    const clock = new ManualClock(EPOCH);
    const runner = new RecordingRunner({
      steps: { b: () => ({ status: 'suspended', suspendPayload: { ask: 'approve' }, suspendOutput: { draft: 1 } }) },
    });

    const { outcome, stepResults } = await runWorkflowDetailed(compile(chain), 'x', { runner, clock });

    expect(runner.calls).toEqual(['a', 'b']);
    // `suspendedPaths[step.id] = executionPath` (`handlers/step.ts:395-397`).
    expect(outcome).toEqual({ status: 'suspended', stepId: 'b', path: [1], payload: { ask: 'approve' } });
    // The record keeps both payloads Mastra keeps apart — the step's input as `payload`
    // (`handlers/step.ts:173`) and the suspension's as `suspendPayload` (`:519`) — and the
    // suspension's output, which the exit token does not carry. A suspended step has not ended:
    // `suspendedAt`, and no `endedAt` (`:516-522`). `toEqual`, so an `endedAt` fails.
    expect(stepResults.get('b')).toEqual({
      status: 'suspended',
      suspendPayload: { ask: 'approve' },
      suspendOutput: { draft: 1 },
      payload: 'x',
      startedAt: EPOCH,
      suspendedAt: EPOCH,
    });
  });

  it('records a paused step with a start and neither endedAt nor suspendedAt', async () => {
    const clock = new ManualClock(EPOCH);
    const runner = new RecordingRunner({ steps: { b: () => ({ status: 'paused' }) } });

    const { stepResults } = await runWorkflowDetailed(
      compile(wf(step('a'), step('b', { source: 'workflow' }))),
      'x',
      { runner, clock },
    );

    // `handlers/step.ts:523-526` writes neither for a paused nested workflow.
    expect(stepResults.get('b')).toEqual({ status: 'paused', payload: 'x', startedAt: EPOCH });
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
      {
        stepId: 'b',
        path: [1],
        source: 'agent',
        initData: 'init',
        a: rec({ status: 'success', output: 'init!', payload: 'init' }),
      },
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
    expect(stepResults.get('nap')).toEqual(rec({ status: 'success', output: 'A', payload: 'A' }));
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
    const seen: { input: unknown; view: Pick<RunView, 'path' | 'initData'>; a: unknown; signal: AbortSignal }[] = [];
    const runner = new RecordingRunner({
      steps: stamped(clock, log, ['a', 'b'], { a: () => ({ status: 'success', output: { waitMs: 250 } }) }),
      waits: {
        nap: (input, view) => {
          seen.push({ input, view: { path: view.path, initData: view.initData }, a: view.getStepResult('a'), signal: view.abortSignal });
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
        a: rec({ status: 'success', output: { waitMs: 250 }, payload: 'init' }),
        // Mastra hands a sleep fn the run's `abortSignal` too (`handlers/sleep.ts:103-109`); a run
        // with no signal gets one that never aborts.
        signal: expect.any(AbortSignal),
      },
    ]);
    expect(seen[0]!.signal.aborted).toBe(false);
    expect(firstAt(log, 'b')).toBe(250);
    expect(clock.elapsed()).toBe(250);
    expect(stepResults.get('nap')).toEqual(rec({ status: 'success', output: { waitMs: 250 }, payload: { waitMs: 250 } }));
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
    expect(stepResults.get('until')).toEqual(rec({ status: 'success', output: 'x', payload: 'x' }));
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
    expect(outcome).toEqual({ status: 'failed', stepId: 'nap', path: [1], error: boom });
    expect(runner.calls).toEqual(['a']);
  });

  it('records waiting before resolveWait runs, so the fn sees it, and success overwrites it at the end', async () => {
    const clock = new ManualClock(EPOCH);
    const seen: (StepRecord | undefined)[] = [];
    const runner = new RecordingRunner({
      waits: {
        nap: (_input, view) => {
          seen.push(view.getStepResult('nap'));
          return 250;
        },
      },
    });

    const { stepResults } = await runWorkflowDetailed(compile(wf(step('a'), perRunSleep(), step('b'))), 'x', {
      runner,
      clock,
    });

    // `stepResults[entry.id] = {status: 'waiting', payload: prevOutput, startedAt}` is stored before
    // `executeSleep` calls the fn (`handlers/entry.ts:602-609`, `handlers/sleep.ts:83-99`), and the
    // fn's `getStepResult` reads that same object.
    expect(seen).toEqual([{ status: 'waiting', payload: 'x', startedAt: EPOCH }]);
    expect(stepResults.get('nap')).toEqual({
      status: 'success',
      output: 'x',
      payload: 'x',
      startedAt: EPOCH,
      endedAt: EPOCH + 250,
    });
  });

  it('fails the run when the runner has no resolveWait', async () => {
    const runner = new RecordingRunner();
    expect(runner.resolveWait).toBeUndefined();

    const outcome = await runWorkflow(compile(wf(step('a'), perRunSleep(), step('b'))), 'x', { runner });

    expect(outcome).toEqual(failedWith('nap', /no resolveWait/, [1]));
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
 * Every proof below: properties `deadlockFree`, `terminatesAtSink` and `exactlyOneTerminal`;
 * initial marking one token in the entry place; all six terminals and the cancel place declared as
 * sinks; proved twice — the closed net (no environment place), then `wf.cancel` as an environment
 * place under `bounded(1)`. Route reported by `describeReport` on failure.
 */
describe('leaf chains, proved', () => {
  it('proves a plain chain', async () => {
    await expectProvenBothSegments(wf(step('a'), step('b'), step('c')));
  }, 90_000);

  it('proves a chain with unrolled retries and a retry delay', async () => {
    await expectProvenBothSegments(
      wf(step('a', { retries: 2, retryDelayMs: 100 }), step('b'), step('c', { retries: 1 })),
    );
  }, 90_000);

  it('proves a chain with a fixed sleep', async () => {
    await expectProvenBothSegments(
      wf(step('a'), { kind: 'sleep', id: 'nap', duration: { fixed: 60_000 } }, step('b')),
    );
  }, 90_000);

  it('proves a chain with a per-run sleep and a per-run sleepUntil', async () => {
    await expectProvenBothSegments(
      wf(
        step('a'),
        { kind: 'sleep', id: 'nap', duration: { perRun: true } },
        { kind: 'sleepUntil', id: 'until', until: { perRun: true } },
        step('b', { retries: 1 }),
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

    expect(intact).toEqual({ status: 'failed', stepId: 'b', path: [1], error: 'declined' });
    // The Out spec is enforced at run time: the undeclared write is refused, the consumed input
    // is not restored ([EXEC-031]), and the run reaches no terminal at all.
    expect(mutant).toEqual({ status: 'stranded', places: [] });
    expect(mutantRunner.calls).toEqual(['a', 'b']);
  });

  it('the proofs cannot see that drop: they reason over the declared branches only', async () => {
    // Why the hard rule "every transition carries a real Out spec, never skipOutputValidation"
    // matters: the mutant still proves, because the verifier reads the Out spec, and only the
    // run-time validation above catches an action that writes outside it.
    expectAllProven(
      await verifyWorkflow(compile(wf(step('a'), step('b')), { gadgets: { step: withoutFailedBranch } })),
    );
  }, 90_000);

  it('routing one exit to a place that is not a terminal flips deadlockFree to violated', async () => {
    const lost = place<SuspendToken>('lost.suspended');
    const suspendsNowhere: Gadget = (entry, next, ctx) =>
      stepGadget(entry, next, { ...ctx, exits: { ...ctx.exits, suspended: lost } });
    const description = wf(step('a'), step('b'));

    const reports = await verifyWorkflow(compile(description, { gadgets: { step: suspendsNowhere } }));
    const runner = new RecordingRunner({ steps: { b: () => ({ status: 'suspended', suspendPayload: 'p' }) } });
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

    expect(report.outcome).toEqual({ status: 'failed', stepId: 'nap', path: [0], error: undefined });
    expect(runner.calls).toEqual([]);
    // Was `has('nap') === false`. The contract now writes the `waiting` record when the sleep
    // BEGINS, before its fn is called — as Mastra does (`handlers/entry.ts:602-609` stores it, then
    // `executeSleep` calls the fn, `handlers/sleep.ts:83`). A throwing fn never reaches the
    // overwrite with `success`, so the `waiting` record is what is left, in both engines.
    expect(report.stepResults.get('nap')).toEqual({ status: 'waiting', payload: 'x', startedAt: expect.any(Number) });
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
  // A chain of n steps is n input places plus 13 of the workflow's own: six terminals, the cancel
  // place, the cancel request place and five settle places. 4084 steps is 4097 places, one over.
  const OWN = 13;
  it('refuses a workflow whose net exceeds MAX_NET_PLACES, naming the limit', () => {
    const entries = Array.from({ length: MAX_NET_PLACES - OWN + 1 }, (_, i) => step(`s${i}`));
    expect(() => compile(wf(...entries))).toThrow(new RegExp(`compiles to ${MAX_NET_PLACES + 1} places, above the ${MAX_NET_PLACES}`));
  });

  it('compiles one exactly at the limit', () => {
    const entries = Array.from({ length: MAX_NET_PLACES - OWN }, (_, i) => step(`s${i}`));
    expect(compile(wf(...entries)).net.places.size).toBe(MAX_NET_PLACES);
  });
});

// ---------------------------------------------------------------------------------------------

/**
 * Exposes the tokens a step writes to its non-success exits, which the kernel otherwise folds
 * into a `RunOutcome`: each exit is redirected to a probe place, and a probe transition forwards
 * the raw token to `next` as data. Used on a one-step workflow only (the probe names are fixed).
 */
function probing(inner: Gadget): Gadget {
  return (entry, next, ctx) => {
    const kinds = ['failed', 'bailed', 'suspended', 'paused'] as const;
    const probes = Object.fromEntries(kinds.map((k) => [k, place<unknown>(`probe.${k}`)])) as Record<
      (typeof kinds)[number],
      Place<unknown>
    >;
    const result = inner(entry, next, { ...ctx, exits: { ...(probes as unknown as Exits), canceled: ctx.exits.canceled } });
    const forward = kinds.map((k) =>
      Transition.builder(`t.probe.${k}`)
        .inputs(one(probes[k]))
        .outputs(outPlace(next))
        .action(async (tctx) => {
          tctx.output(next, { data: { exit: k, token: tctx.input(probes[k]) } });
        })
        .build(),
    );
    return { ...result, transitions: [...result.transitions, ...forward] };
  };
}

/**
 * Stamps the ride-along fields a foreach or a loop would put on the token that starts a step, so
 * the leaf's handling of them can be tested at the top level. Applies to the step `only`.
 */
function stamping(only: string, fields: Omit<FlowToken, 'data'>, inner: Gadget = stepGadget): Gadget {
  return (entry, next, ctx) => {
    if (entry.id !== only) return stepGadget(entry, next, ctx);
    const result = inner(entry, next, ctx);
    const pre = place<FlowToken>(ctx.names.entryPlace(ctx.path, entry.id, 'stamp'));
    const stamp = Transition.builder(ctx.names.entryTransition(ctx.path, entry.id, 'stamp'))
      .inputs(one(pre))
      .outputs(outPlace(result.inPlace))
      .action(async (tctx) => {
        tctx.output(result.inPlace, { ...tctx.input(pre), ...fields });
      })
      .build();
    return { inPlace: pre, transitions: [...result.transitions, stamp] };
  };
}

describe('the exit tokens a step writes carry their Origin', () => {
  const exitOf = async (outcome: StepOutcome, fields: Omit<FlowToken, 'data'> = {}) => {
    const gadget = stamping('s', fields, probing(stepGadget));
    const probed = await runWorkflow(compile(wf(step('s', { retries: 1 })), { gadgets: { step: gadget } }), 'in', {
      runner: new RecordingRunner({ steps: { s: () => outcome } }),
    });
    return { probed };
  };

  it('a final failure: stepId, view path, error — and nonRetryable only when set', async () => {
    const { probed } = await exitOf({ status: 'failed', error: 'no', nonRetryable: true });
    expect(probed).toEqual({
      status: 'success',
      output: { exit: 'failed', token: { stepId: 's', path: [0], error: 'no', nonRetryable: true } },
    });
    const plain = await exitOf({ status: 'failed', error: 'no' });
    // Retried once (retries: 1), then the final failure — with no `nonRetryable` key at all.
    expect(plain.probed).toEqual({
      status: 'success',
      output: { exit: 'failed', token: { stepId: 's', path: [0], error: 'no' } },
    });
  });

  it('a tripwire rides the failure token', async () => {
    const { probed } = await exitOf({ status: 'failed', error: 'e', tripwire: { reason: 'r' }, nonRetryable: true });
    expect(probed).toEqual({
      status: 'success',
      output: { exit: 'failed', token: { stepId: 's', path: [0], error: 'e', tripwire: { reason: 'r' }, nonRetryable: true } },
    });
  });

  it('a suspension carries its payload but not its output, which lives on the record', async () => {
    const { probed } = await exitOf({ status: 'suspended', suspendPayload: { ask: 1 }, suspendOutput: 'partial' });
    expect(probed).toEqual({
      status: 'success',
      output: { exit: 'suspended', token: { stepId: 's', path: [0], payload: { ask: 1 } } },
    });
  });

  it('a bail carries its output; a pause carries its origin alone', async () => {
    expect((await exitOf({ status: 'bailed', output: 'b' })).probed).toEqual({
      status: 'success',
      output: { exit: 'bailed', token: { stepId: 's', path: [0], output: 'b' } },
    });
    expect((await exitOf({ status: 'paused' })).probed).toEqual({
      status: 'success',
      output: { exit: 'paused', token: { stepId: 's', path: [0] } },
    });
  });

  it('carries a foreach index onto every exit token', async () => {
    const fields = { foreachIndex: 3 };
    expect((await exitOf({ status: 'failed', error: 'x', nonRetryable: true }, fields)).probed).toEqual({
      status: 'success',
      output: { exit: 'failed', token: { stepId: 's', path: [0], foreachIndex: 3, error: 'x', nonRetryable: true } },
    });
    expect((await exitOf({ status: 'suspended', suspendPayload: 'p' }, fields)).probed).toEqual({
      status: 'success',
      output: { exit: 'suspended', token: { stepId: 's', path: [0], foreachIndex: 3, payload: 'p' } },
    });
    expect((await exitOf({ status: 'bailed', output: 'o' }, fields)).probed).toEqual({
      status: 'success',
      output: { exit: 'bailed', token: { stepId: 's', path: [0], foreachIndex: 3, output: 'o' } },
    });
    expect((await exitOf({ status: 'paused' }, fields)).probed).toEqual({
      status: 'success',
      output: { exit: 'paused', token: { stepId: 's', path: [0], foreachIndex: 3 } },
    });
  });
});

describe('ride-along foreachIndex and iteration', () => {
  it('hands foreachIndex to the runner, stamps both on the record, and carries both onto success', async () => {
    const calls: { id: string; foreachIndex: number | undefined }[] = [];
    const seeing: Behaviour = (input, call) => {
      calls.push({ id: calls.length === 0 ? 'a' : 'b', foreachIndex: call.foreachIndex });
      return { status: 'success', output: input };
    };
    const runner = new RecordingRunner({ steps: { a: seeing, b: seeing } });
    const compiled = compile(wf(step('a'), step('b')), { gadgets: { step: stamping('a', { foreachIndex: 3, iteration: 2 }) } });

    const { outcome, stepResults } = await runWorkflowDetailed(compiled, 'x', { runner });

    expect(outcome).toEqual({ status: 'success', output: 'x' });
    // `executionContext.foreachIndex` reaches the step (`handlers/step.ts:152`).
    expect(calls[0]).toEqual({ id: 'a', foreachIndex: 3 });
    expect(stepResults.get('a')).toEqual(
      rec({ status: 'success', output: 'x', payload: 'x' }, { metadata: { iterationCount: 2, foreachIndex: 3 } }),
    );
    // The success token kept both, so the next gadget — here a plain step — sees them untouched.
    expect(calls[1]).toEqual({ id: 'b', foreachIndex: 3 });
    expect(stepResults.get('b')).toEqual(
      rec({ status: 'success', output: 'x', payload: 'x' }, { metadata: { iterationCount: 2, foreachIndex: 3 } }),
    );
  });

  it('keeps metadata and foreachIndex off a record and a call that has none', async () => {
    let seen: StepCall | undefined;
    const runner = new RecordingRunner({ steps: { a: (i, call) => ((seen = call), { status: 'success', output: i }) } });
    const { stepResults } = await runWorkflowDetailed(compile(wf(step('a'))), 'x', { runner });
    expect(stepResults.get('a')).not.toHaveProperty('metadata');
    expect(seen).not.toHaveProperty('foreachIndex');
  });

  it('carries the foreach index onto the canceled origin when the settle stage re-stamps', async () => {
    const ac = new AbortController();
    const runner = new RecordingRunner({
      steps: { a: () => (ac.abort(), { status: 'failed', error: 'x', nonRetryable: true }) },
    });
    const compiled = compile(wf(step('a')), { gadgets: { step: stamping('a', { foreachIndex: 5 }) } });

    const outcome = await runWorkflow(compiled, 'x', { runner, signal: ac.signal });

    // The settle stage re-stamps an outcome that ran: `started: true`.
    expect(outcome).toEqual({ status: 'canceled', origin: { stepId: 'a', path: [0], foreachIndex: 5 }, started: true });
  });
});

describe('sleeps honour the cancel place at the top level', () => {
  it.each([
    ['a fixed sleep', { kind: 'sleep', id: 'nap', duration: { fixed: 1_000 } }],
    ['a per-run sleep', { kind: 'sleep', id: 'nap', duration: { perRun: true } }],
    ['a fixed sleepUntil', { kind: 'sleepUntil', id: 'nap', until: { fixed: EPOCH } }],
    ['a per-run sleepUntil', { kind: 'sleepUntil', id: 'nap', until: { perRun: true } }],
  ] as const)('%s: wake inhibited by wf.cancel, a sweep reads it', (_label, entry) => {
    const compiled = compile(wf(entry));
    const byName = new Map([...compiled.net.transitions].map((t) => [t.name, t]));
    expect(byName.get('t.0.nap.wake')!.inhibitors.map((a) => a.place.name)).toEqual(['wf.cancel']);
    const sweep = byName.get('t.0.nap.cancel')!;
    expect(sweep.reads.map((a) => a.place.name)).toEqual(['wf.cancel']);
    expect([...sweep.inputPlaces()].map((p) => p.name)).toEqual(['s.0.nap.in']);
    expect([...sweep.outputPlaces()].map((p) => p.name)).toEqual(['wf.canceled']);
  });

  it.each([
    ['a per-run sleep', { kind: 'sleep', id: 'nap', duration: { perRun: true } }],
    ['a fixed sleepUntil', { kind: 'sleepUntil', id: 'nap', until: { fixed: EPOCH } }],
    ['a per-run sleepUntil', { kind: 'sleepUntil', id: 'nap', until: { perRun: true } }],
  ] as const)('%s waits in the action: its end is routed by resume (inhibited) or cancel-waited (reads)', (_label, entry) => {
    const compiled = compile(wf(entry));
    const byName = new Map([...compiled.net.transitions].map((t) => [t.name, t]));
    const names = (ps: Iterable<{ name: string }>) => [...ps].map((p) => p.name).sort();

    // The wake only waits: it writes `waited` or, on a throwing wait fn, the failure — never a
    // canceled outcome, and it reads no flag to choose one.
    expect(names(byName.get('t.0.nap.wake')!.outputPlaces())).toEqual(['s.0.nap.waited', 'wf.settle.failed']);
    const resume = byName.get('t.0.nap.resume')!;
    expect(resume.inhibitors.map((a) => a.place.name)).toEqual(['wf.cancel']);
    expect(names(resume.inputPlaces())).toEqual(['s.0.nap.waited']);
    expect(names(resume.outputPlaces())).toEqual(['wf.settle.done']);
    const cancelWaited = byName.get('t.0.nap.cancel-waited')!;
    expect(cancelWaited.reads.map((a) => a.place.name)).toEqual(['wf.cancel']);
    expect(names(cancelWaited.inputPlaces())).toEqual(['s.0.nap.waited']);
    expect(names(cancelWaited.outputPlaces())).toEqual(['wf.canceled']);
  });

  // Was "a timed wake alone": the contract split the fixed sleep into an immediate `begin` that
  // records `waiting`, a `waiting` place, and the delayed `wake` — so a sweep can tell a sleep that
  // never began (on `in`) from one mid-wait (on `waiting`). Still no `waited` place and no resume.
  it('a fixed sleep is begin -> waiting -> timed wake: no waited place, no resume', () => {
    const compiled = compile(wf({ kind: 'sleep', id: 'nap', duration: { fixed: 1_000 } }));
    const own = [...compiled.net.transitions].map((t) => t.name).filter((n) => n.startsWith('t.0.'));
    expect(own.sort()).toEqual(['t.0.nap.begin', 't.0.nap.cancel', 't.0.nap.cancel-waiting', 't.0.nap.wake']);
    const places = [...compiled.net.places].map((p) => p.name).filter((n) => n.startsWith('s.0.'));
    expect(places.sort()).toEqual(['s.0.nap.in', 's.0.nap.waiting']);
    expect([...compiled.net.transitions].find((t) => t.name === 't.0.nap.wake')!.timing).toEqual({
      type: 'delayed',
      afterMs: 1_000,
    });
  });
});

// ---------------------------------------------------------------------------------------------

/** Rebuilt without its inhibitor arcs — the lead's pattern, every other arc kept. */
function withoutInhibitors(t: Transition): Transition {
  const b = Transition.builder(t.name)
    .inputs(...t.inputSpecs)
    .outputs(t.outputSpec!)
    .action(t.action)
    .timing(t.timing)
    .priority(t.priority);
  for (const arc of t.reads) b.read(arc.place);
  for (const arc of t.resets) b.reset(arc.place);
  return b.build();
}

/** `inner`, with the inhibitors of every transition whose name ends in `suffix` stripped. */
function stripping(inner: Gadget, suffix: string): Gadget {
  return (entry, next, ctx) => {
    const r = inner(entry, next, ctx);
    return { ...r, transitions: r.transitions.map((t) => (t.name.endsWith(suffix) ? withoutInhibitors(t) : t)) };
  };
}

/**
 * Every inhibitor the leaf gadgets add on `wf.cancel` is load-bearing, and no quiescence proof can
 * see one go — the extra work it lets start still drains to exactly one terminal. The structural
 * check sees it exactly, by name; `verifyWorkflow` refuses the net before proving anything.
 */
describe('cancelStructureViolations flags every leaf inhibitor stripped', () => {
  const perRunSleep: EntryDescription = { kind: 'sleep', id: 'nap', duration: { perRun: true } };
  const fixedSleep: EntryDescription = { kind: 'sleep', id: 'nap', duration: { fixed: 1_000 } };
  const fixedUntil: EntryDescription = { kind: 'sleepUntil', id: 'nap', until: { fixed: EPOCH } };
  const perRunUntil: EntryDescription = { kind: 'sleepUntil', id: 'nap', until: { perRun: true } };

  it('the intact leaf nets are sound: no violation for any leaf form', () => {
    for (const entries of [
      [step('a'), step('b', { retries: 2, retryDelayMs: 5 })],
      [step('a'), fixedSleep, step('b')],
      [step('a'), perRunSleep, fixedUntil, perRunUntil, step('b')],
    ]) {
      expect(cancelStructureViolations(compile(wf(...entries)))).toEqual([]);
    }
  });

  it.each([
    [
      "the step's first attempt",
      [step('a', { retries: 1 }), step('b')],
      { step: stripping(stepGadget, '.run') },
      [
        "'t.0.a.run' competes with sweep 't.0.a.cancel' for [s.0.a.in] without an inhibitor on 'wf.cancel'",
        "'t.1.b.run' competes with sweep 't.1.b.cancel' for [s.1.b.in] without an inhibitor on 'wf.cancel'",
      ],
    ],
    // The fixed sleep's wake now consumes `waiting`, so it competes with `cancel-waiting` there
    // (it used to consume `in` and compete with `cancel`); `begin` took over the start gate.
    [
      "a fixed sleep's wake",
      [fixedSleep],
      { sleep: stripping(sleepGadget, '.wake') },
      ["'t.0.nap.wake' competes with sweep 't.0.nap.cancel-waiting' for [s.0.nap.waiting] without an inhibitor on 'wf.cancel'"],
    ],
    [
      "a fixed sleep's begin",
      [fixedSleep],
      { sleep: stripping(sleepGadget, '.begin') },
      ["'t.0.nap.begin' competes with sweep 't.0.nap.cancel' for [s.0.nap.in] without an inhibitor on 'wf.cancel'"],
    ],
    [
      "a per-run sleep's wake",
      [perRunSleep],
      { sleep: stripping(sleepGadget, '.wake') },
      ["'t.0.nap.wake' competes with sweep 't.0.nap.cancel' for [s.0.nap.in] without an inhibitor on 'wf.cancel'"],
    ],
    [
      "a per-run sleep's resume",
      [perRunSleep],
      { sleep: stripping(sleepGadget, '.resume') },
      ["'t.0.nap.resume' competes with sweep 't.0.nap.cancel-waited' for [s.0.nap.waited] without an inhibitor on 'wf.cancel'"],
    ],
    [
      "a fixed sleepUntil's resume",
      [fixedUntil],
      { sleepUntil: stripping(sleepGadget, '.resume') },
      ["'t.0.nap.resume' competes with sweep 't.0.nap.cancel-waited' for [s.0.nap.waited] without an inhibitor on 'wf.cancel'"],
    ],
    [
      "a per-run sleepUntil's wake",
      [perRunUntil],
      { sleepUntil: stripping(sleepGadget, '.wake') },
      ["'t.0.nap.wake' competes with sweep 't.0.nap.cancel' for [s.0.nap.in] without an inhibitor on 'wf.cancel'"],
    ],
  ] as const)('%s', async (_label, entries, gadgets, expected) => {
    const mutant = compile(wf(...entries), { gadgets });
    // The mutant really lost an arc: same transitions, one inhibitor fewer per stripped name.
    const intact = compile(wf(...entries));
    const count = (c: typeof intact) => [...c.net.transitions].reduce((n, t) => n + t.inhibitors.length, 0);
    expect(count(mutant)).toBe(count(intact) - expected.length);

    expect([...cancelStructureViolations(mutant)].sort()).toEqual([...expected].sort());
    await expect(verifyWorkflow(mutant)).rejects.toThrow(/cancellation structure is unsound/);
  });
});

describe('the sweep carries the foreach index onto the canceled origin', () => {
  it('a pre-aborted run sweeps a stamped step with its foreachIndex', async () => {
    const ac = new AbortController();
    ac.abort();
    const runner = new RecordingRunner();
    const compiled = compile(wf(step('a')), { gadgets: { step: stamping('a', { foreachIndex: 5 }) } });

    const { outcome, stepResults } = await runWorkflowDetailed(compiled, 'x', { runner, signal: ac.signal });

    // The sweep — not the settle stage: nothing ran and nothing was recorded.
    expect(runner.calls).toEqual([]);
    expect(stepResults.size).toBe(0);
    // Swept at its start gate: the step never began, `started: false`.
    expect(outcome).toEqual({ status: 'canceled', origin: { stepId: 'a', path: [0], foreachIndex: 5 }, started: false });
  });
});

// ---------------------------------------------------------------------------------------------

/**
 * Observes every token a gadget writes to its `canceled` exit without changing what happens
 * next: the gadget is compiled with a local tap in that exit's stead, and one forwarding
 * transition copies each token on. The canceled token's `started` is the thing observed —
 * structural, from which sweep fired — so a mutant that flips one sweep's flag fails here even
 * where the outcome does not show it.
 */
function tappedCanceled(inner: Gadget): { gadget: Gadget; seen: unknown[] } {
  const seen: unknown[] = [];
  const gadget: Gadget = (entry, next, ctx) => {
    const tap = place<CanceledToken>(ctx.names.reserve(`test.tap.canceled.${entry.id}`, 'test observation tap'));
    const result = inner(entry, next, { ...ctx, exits: { ...ctx.exits, canceled: tap } });
    const forward = Transition.builder(`test.tap.canceled.${entry.id}.forward`)
      .inputs(one(tap))
      .outputs(outPlace(ctx.exits.canceled))
      .action(async (tctx) => {
        const token = tctx.input(tap);
        seen.push(token);
        tctx.output(ctx.exits.canceled, token);
      })
      .build();
    return { ...result, transitions: [...result.transitions, forward] };
  };
  return { gadget, seen };
}

/**
 * `inner`, with every transition whose name ends in `suffix` rebuilt so the `started` flag of any
 * canceled token it writes is inverted — every arc, the timing and the priority kept. A mutant for
 * the non-vacuity of the `started` assertions.
 */
function flippingStarted(inner: Gadget, suffix: string): Gadget {
  return (entry, next, ctx) => {
    const r = inner(entry, next, ctx);
    const flip = (t: Transition): Transition => {
      const b = Transition.builder(t.name)
        .inputs(...t.inputSpecs)
        .outputs(t.outputSpec!)
        .timing(t.timing)
        .priority(t.priority)
        .action((tctx) =>
          t.action(
            new Proxy(tctx, {
              get(target, prop) {
                if (prop === 'output') {
                  return (p: Place<unknown>, value: unknown) =>
                    target.output(
                      p,
                      value !== null && typeof value === 'object' && 'started' in value
                        ? { ...value, started: !(value as CanceledToken).started }
                        : value,
                    );
                }
                const v: unknown = Reflect.get(target, prop, target);
                return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
              },
            }),
          ),
        );
      for (const arc of t.reads) b.read(arc.place);
      for (const arc of t.inhibitors) b.inhibitor(arc.place);
      for (const arc of t.resets) b.reset(arc.place);
      return b.build();
    };
    return { ...r, transitions: r.transitions.map((t) => (t.name.endsWith(suffix) ? flip(t) : t)) };
  };
}

/**
 * A {@link ManualClock} that, the first time it is asked to wait a finite time, aborts `ac`
 * instead of advancing — the abort lands *during* the first timed wait, at virtual time 0 past
 * it, deterministically. Every later wait advances as usual.
 */
class AbortingClock extends ManualClock {
  #fired = false;
  constructor(private readonly ac: AbortController, epochOrigin = EPOCH) {
    super(epochOrigin);
  }
  override async sleep(delayMs: number, ready: () => boolean, signal: AbortSignal): Promise<void> {
    if (!this.#fired && Number.isFinite(delayMs) && delayMs > 0 && !signal.aborted && !ready()) {
      this.#fired = true;
      this.ac.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      return;
    }
    return super.sleep(delayMs, ready, signal);
  }
}

describe('a fixed sleep is begin -> waiting -> wake, and its cancel sweeps say whether it began', () => {
  const nap = (ms = 60_000): EntryDescription => ({ kind: 'sleep', id: 'nap', duration: { fixed: ms } });
  const at0 = { stepId: 'nap', path: [0] };
  const at1 = { stepId: 'nap', path: [1] };

  it('begin is immediate and gated; wake is delayed and gated; each place has its own sweep', () => {
    const compiled = compile(wf(nap(1_000), step('b')));
    const byName = new Map([...compiled.net.transitions].map((t) => [t.name, t]));
    const names = (ps: Iterable<{ name: string }>) => [...ps].map((p) => p.name).sort();
    const begin = byName.get('t.0.nap.begin')!;
    const wake = byName.get('t.0.nap.wake')!;

    expect(begin.timing).toEqual({ type: 'immediate' });
    expect(names(begin.inputPlaces())).toEqual(['s.0.nap.in']);
    expect(names(begin.outputPlaces())).toEqual(['s.0.nap.waiting']);
    expect(begin.inhibitors.map((a) => a.place.name)).toEqual(['wf.cancel']);

    expect(wake.timing).toEqual({ type: 'delayed', afterMs: 1_000 });
    expect(names(wake.inputPlaces())).toEqual(['s.0.nap.waiting']);
    expect(names(wake.outputPlaces())).toEqual(['s.1.b.in']);
    expect(wake.inhibitors.map((a) => a.place.name)).toEqual(['wf.cancel']);

    for (const [sweep, from] of [['t.0.nap.cancel', 's.0.nap.in'], ['t.0.nap.cancel-waiting', 's.0.nap.waiting']] as const) {
      const t = byName.get(sweep)!;
      expect(t.reads.map((a) => a.place.name), sweep).toEqual(['wf.cancel']);
      expect(names(t.inputPlaces()), sweep).toEqual([from]);
      expect(names(t.outputPlaces()), sweep).toEqual(['wf.canceled']);
    }
  });

  it('records waiting at begin and success at wake, exactly its duration after begin, in virtual time', async () => {
    const clock = new ManualClock(EPOCH);
    const log: Stamp[] = [];
    // `a` fails once and retries 250ms later, so the sleep begins at 250, not 0: the wake is timed
    // from `begin`, not from the run's start.
    const runner = new RecordingRunner({
      steps: stamped(clock, log, ['a', 'b'], {
        a: (input, call) => (call.attempt === 0 ? { status: 'failed', error: 'once' } : { status: 'success', output: input }),
      }),
    });

    const { outcome, stepResults } = await runWorkflowDetailed(
      compile(wf(step('a', { retries: 1, retryDelayMs: 250 }), { kind: 'sleep', id: 'nap', duration: { fixed: 60_000 } }, step('b'))),
      'x',
      { runner, clock },
    );

    expect(outcome).toEqual({ status: 'success', output: 'x' });
    expect(firstAt(log, 'b')).toBe(250 + 60_000);
    expect(clock.elapsed()).toBe(250 + 60_000);
    // The `waiting` record `begin` wrote is overwritten by `wake`'s success; `startedAt` is the
    // instant `begin` fired, `endedAt` the instant `wake` did (`handlers/entry.ts:602-609,655-665`).
    expect(stepResults.get('nap')).toEqual({
      status: 'success',
      output: 'x',
      payload: 'x',
      startedAt: EPOCH + 250,
      endedAt: EPOCH + 250 + 60_000,
    });
  });

  it('canceled before it begins: the start-gate sweep, no record, started false', async () => {
    const ac = new AbortController();
    ac.abort();
    const clock = new ManualClock(EPOCH);
    const tap = tappedCanceled(sleepGadget);
    const runner = new RecordingRunner();

    const { outcome, stepResults } = await runWorkflowDetailed(
      compile(wf(nap(), step('b')), { gadgets: { sleep: tap.gadget } }),
      'x',
      { runner, clock, signal: ac.signal },
    );

    // Mastra's check before the entry (`default.ts:815`): the sleep never began, so there is no
    // `waiting` record and nothing on the path.
    expect(tap.seen).toEqual([{ origin: at0, started: false }]);
    expect(stepResults.size).toBe(0);
    expect(runner.calls).toEqual([]);
    expect(clock.elapsed()).toBe(0);
    // Last, so every assertion above runs even while the kernel drops `started` (contractIssues).
    expect(outcome).toEqual({ status: 'canceled', origin: at0, started: false });
  });

  it('canceled mid-wait: the waiting sweep, the waiting record kept, started true, wake never fires', async () => {
    const ac = new AbortController();
    const clock = new AbortingClock(ac);
    const tap = tappedCanceled(sleepGadget);
    const runner = new RecordingRunner();

    const { outcome, stepResults } = await runWorkflowDetailed(
      compile(wf(step('a'), nap(), step('b')), { gadgets: { sleep: tap.gadget } }),
      'x',
      { runner, clock, signal: ac.signal },
    );

    // `abortableSleep` resolves early, the entry is re-stamped canceled, and the `waiting` record
    // written when the sleep began is left in place (`handlers/entry.ts:602-609,638-643`).
    expect(tap.seen).toEqual([{ origin: at1, started: true }]);
    expect(stepResults.get('nap')).toEqual({ status: 'waiting', payload: 'x', startedAt: EPOCH });
    expect(runner.calls).toEqual(['a']);
    // The wake never fired: no virtual time passed.
    expect(clock.elapsed()).toBe(0);
    // Last, so every assertion above runs even while the kernel drops `started` (contractIssues).
    expect(outcome).toEqual({ status: 'canceled', origin: at1, started: true });
  });

  it('a mutant whose waiting sweep reports started false is caught', async () => {
    const ac = new AbortController();
    const tap = tappedCanceled(flippingStarted(sleepGadget, '.cancel-waiting'));
    await runWorkflowDetailed(compile(wf(step('a'), nap(), step('b')), { gadgets: { sleep: tap.gadget } }), 'x', {
      runner: new RecordingRunner(),
      clock: new AbortingClock(ac),
      signal: ac.signal,
    });
    // The intact gadget reports `started: true` here (test above); the mutant reports false.
    expect(tap.seen).toEqual([{ origin: at1, started: false }]);
  });

  it('a mutant whose start-gate sweep reports started true is caught', async () => {
    const ac = new AbortController();
    ac.abort();
    const tap = tappedCanceled(flippingStarted(sleepGadget, '.cancel'));
    await runWorkflowDetailed(compile(wf(nap(), step('b')), { gadgets: { sleep: tap.gadget } }), 'x', {
      runner: new RecordingRunner(),
      clock: new ManualClock(EPOCH),
      signal: ac.signal,
    });
    expect(tap.seen).toEqual([{ origin: at0, started: true }]);
  });
});

describe('the action-side sleeps and the step: which sweep reports started', () => {
  const perRun: EntryDescription = { kind: 'sleep', id: 'nap', duration: { perRun: true } };
  const perRunUntil: EntryDescription = { kind: 'sleepUntil', id: 'nap', until: { perRun: true } };
  const fixedUntil: EntryDescription = { kind: 'sleepUntil', id: 'nap', until: { fixed: EPOCH + 60_000 } };
  const at1 = { stepId: 'nap', path: [1] };

  it.each([
    ['a per-run sleep', perRun],
    ['a per-run sleepUntil', perRunUntil],
    ['a fixed sleepUntil', fixedUntil],
  ] as const)('%s canceled before it begins: `cancel` on in, no record, started false', async (_label, entry) => {
    const ac = new AbortController();
    const tap = tappedCanceled(sleepGadget);
    const runner = new RecordingRunner({
      steps: { a: (x) => (ac.abort(), { status: 'success', output: x }) },
      waits: { nap: () => { throw new Error('resolveWait must not run'); } },
    });
    const kind = entry.kind;

    const { outcome, stepResults } = await runWorkflowDetailed(
      compile(wf(step('a'), entry, step('b')), { gadgets: { [kind]: tap.gadget } }),
      'x',
      { runner, clock: new ManualClock(EPOCH), signal: ac.signal },
    );

    // `a` aborted during its own run, then succeeded: the settle stage passes a success through
    // (only the non-success exits are re-stamped at the top level), and the sleep's gate sweeps it.
    expect(tap.seen).toEqual([{ origin: at1, started: false }]);
    expect(stepResults.has('nap')).toBe(false);
    expect(runner.calls).toEqual(['a']);
    // Last, so every assertion above runs even while the kernel drops `started` (contractIssues).
    expect(outcome).toEqual({ status: 'canceled', origin: at1, started: false });
  });

  it.each([
    ['a per-run sleep', perRun],
    ['a per-run sleepUntil', perRunUntil],
    ['a fixed sleepUntil', fixedUntil],
  ] as const)('%s canceled mid-wait: `cancel-waited`, the waiting record kept, started true', async (_label, entry) => {
    const ac = new AbortController();
    const clock = new AbortingClock(ac);
    const tap = tappedCanceled(sleepGadget);
    const runner = new RecordingRunner({
      waits: { nap: () => (entry.kind === 'sleep' ? 60_000 : EPOCH + 60_000) },
    });

    const { outcome, stepResults } = await runWorkflowDetailed(
      compile(wf(step('a'), entry, step('b')), { gadgets: { [entry.kind]: tap.gadget } }),
      'x',
      { runner, clock, signal: ac.signal },
    );

    expect(tap.seen).toEqual([{ origin: at1, started: true }]);
    expect(stepResults.get('nap')).toEqual({ status: 'waiting', payload: 'x', startedAt: EPOCH });
    expect(runner.calls).toEqual(['a']);
    expect(clock.elapsed()).toBe(0);
    // Last, so every assertion above runs even while the kernel drops `started` (contractIssues).
    expect(outcome).toEqual({ status: 'canceled', origin: at1, started: true });
  });

  it('a step swept at its gate reports started false', async () => {
    const ac = new AbortController();
    ac.abort();
    const tap = tappedCanceled(stepGadget);
    const { outcome } = await runWorkflowDetailed(compile(wf(step('a')), { gadgets: { step: tap.gadget } }), 'x', {
      runner: new RecordingRunner(),
      signal: ac.signal,
    });
    expect(tap.seen).toEqual([{ origin: { stepId: 'a', path: [0] }, started: false }]);
    // Last, so every assertion above runs even while the kernel drops `started` (contractIssues).
    expect(outcome).toEqual({ status: 'canceled', origin: { stepId: 'a', path: [0] }, started: false });
  });

  it.each([
    ['failed', { status: 'failed', error: 'x' }],
    ['bailed', { status: 'bailed', output: 'b' }],
    ['suspended', { status: 'suspended', suspendPayload: 'p' }],
    ['paused', { status: 'paused' }],
  ] as const)('a step that %s after the abort is re-stamped by the settle stage: started true', async (_label, result) => {
    const ac = new AbortController();
    const runner = new RecordingRunner({ steps: { a: () => (ac.abort(), result as StepOutcome) } });
    const { outcome } = await runWorkflowDetailed(compile(wf(step('a'), step('b'))), 'x', { runner, signal: ac.signal });
    // Mastra's entry-end check re-stamps the entry that ran (`handlers/entry.ts:815-817`).
    expect(runner.calls).toEqual(['a']);
    // Last, so every assertion above runs even while the kernel drops `started` (contractIssues).
    expect(outcome).toEqual({ status: 'canceled', origin: { stepId: 'a', path: [0] }, started: true });
  });

  it('the last entry\'s success re-stamped after the run: no origin, started true', async () => {
    const ac = new AbortController();
    const runner = new RecordingRunner({ steps: { a: (x) => (ac.abort(), { status: 'success', output: x }) } });
    const { outcome } = await runWorkflowDetailed(compile(wf(step('a'))), 'x', { runner, signal: ac.signal });
    // `settleDone`: every entry ran; the run-end check re-stamps it.
    // Last, so every assertion above runs even while the kernel drops `started` (contractIssues).
    expect(outcome).toEqual({ status: 'canceled', started: true });
  });
});

describe('sleeps proven with the begin/waiting/wake split', () => {
  const fixed = (id: string, ms = 1_000): EntryDescription => ({ kind: 'sleep', id, duration: { fixed: ms } });

  it('proves a fixed sleep first, last, back to back, and beside every other leaf form', async () => {
    await expectProvenBothSegments(
      wf(
        fixed('s0'),
        step('a', { retries: 1, retryDelayMs: 5 }),
        fixed('s1', 0),
        fixed('s2'),
        { kind: 'sleep', id: 's3', duration: { perRun: true } },
        { kind: 'sleepUntil', id: 's4', until: { fixed: EPOCH } },
        fixed('s5'),
      ),
    );
  }, 180_000);

  it('the structural check is clean for every sleep form in every position', () => {
    for (const entries of [
      [fixed('s0')],
      [fixed('s0'), fixed('s1')],
      [step('a'), fixed('s0'), step('b')],
      [fixed('s0'), { kind: 'sleepUntil', id: 'u', until: { perRun: true } } as EntryDescription, fixed('s1')],
    ]) {
      expect(cancelStructureViolations(compile(wf(...entries)))).toEqual([]);
    }
  });
});

/**
 * **Deterministic runs under injected clocks ([TIME-015]), applied to this repo's nets (M3 item 2).**
 *
 * (a) The sharpest clock in libpetri's own suite is the `SuspendingClock` of
 * `libpetri/typescript/tests/runtime/injectable-clock.test.ts`: its `sleep` resolves **only** on
 * abort — it never advances and never times out. Anything a net achieves under it, it achieves
 * through the executor's own wake sources (an action settling, an injection, `drain`/`close`)
 * alone. Transcribed below and pointed at compiled workflows:
 *
 * - every **untimed** shape — chain, parallel, branch, loop, foreach, retries without a delay,
 *   and each of those under a step budget ([ADR 0006]) — completes, with exactly the outcome and
 *   records a `ManualClock` run produces, and never once asks the clock for a finite boundary;
 * - every **timed** shape — a fixed `.sleep`, a retry delay, a per-run `.sleep` — does **not**
 *   complete: it stays pending with the clock parked on the boundary, and is then ended cleanly
 *   inside a bounded wall-clock wait (an abort where the net routes one, `close()` where it
 *   deliberately does not — row 44).
 *
 * (b) Two executors in one process on independent `ManualClock`s run one compiled workflow with a
 * fixed sleep and a retry delay: each observes only its own virtual time, and identical inputs give
 * identical records, `startedAt`/`endedAt` included.
 *
 * Environment: in-process `PrecompiledNetExecutor` via `runWorkflowDetailed`, libpetri 6.1.0 from
 * the registry. These are executions, not proofs: every claim here is "tested", never "proven".
 */
import { describe, expect, it } from 'vitest';
import type { Clock } from 'libpetri';
import { compile } from '../../src/compiler/index.js';
import { runWorkflowDetailed, type RunReport } from '../../src/engine/index.js';
import type { CompileOptions } from '../../src/compiler/compile.js';
import type { EntryDescription, StepDescription, StepRecord, WorkflowDescription } from '../../src/compiler/types.js';
import { RecordingRunner, type RecordingRunnerOptions } from '../fixtures/runner.js';
import { ManualClock } from '../support/manual-clock.js';

const EPOCH = 1_700_000_000_000;

/**
 * libpetri's `SuspendingClock`, verbatim in behaviour: `sleep` resolves only on abort. It records
 * every delay it was asked for, so a test can tell "parked on a timed boundary" (finite) from
 * "parked on an in-flight action" (`Infinity`).
 */
class SuspendingClock implements Clock {
  readonly sleeps: number[] = [];

  now(): number {
    return 0;
  }

  epochNow(): number {
    return EPOCH;
  }

  sleep(delayMs: number, _ready: () => boolean, signal: AbortSignal): Promise<void> {
    this.sleeps.push(delayMs);
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  /** The finite boundaries the executor (or an action-side wait) asked this clock to wait for. */
  finite(): number[] {
    return this.sleeps.filter((ms) => Number.isFinite(ms));
  }
}

/** Resolves after `ms` of real time — the bound on every wait in this file. */
const realDelay = (ms: number): Promise<'timeout'> => new Promise((resolve) => setTimeout(() => resolve('timeout'), ms));

/** A promise with its settlement observable synchronously. */
function track<T>(promise: Promise<T>): { readonly promise: Promise<T>; settled: () => boolean } {
  let settled = false;
  promise.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  return { promise, settled: () => settled };
}

const step = (id: string, extra: Partial<StepDescription> = {}): StepDescription => ({ kind: 'step', id, ...extra });
const wf = (id: string, ...entries: EntryDescription[]): WorkflowDescription => ({ id, entries });

interface Shape {
  readonly name: string;
  readonly description: WorkflowDescription;
  readonly input: unknown;
  /** A fresh runner per run: `RecordingRunner` accumulates calls. */
  readonly runner: () => RecordingRunner;
}

const plain = (options: RecordingRunnerOptions = {}) => () => new RecordingRunner(options);

/** Every untimed shape the IR can express, each exercising a different gadget. */
const UNTIMED: readonly Shape[] = [
  {
    name: 'a chain',
    description: wf('chain', step('a'), step('b'), step('c')),
    input: 'x',
    runner: plain({ steps: { a: (i) => ({ status: 'success', output: `${String(i)}a` }), b: (i) => ({ status: 'success', output: `${String(i)}b` }) } }),
  },
  {
    name: 'a parallel of four arms',
    description: wf('par', step('pre'), { kind: 'parallel', id: 'fan', arms: [step('p1'), step('p2'), step('p3'), step('p4')] }, step('post')),
    input: 1,
    runner: plain(),
  },
  {
    name: 'an inclusive branch',
    description: wf('br', { kind: 'branch', id: 'pick', arms: [step('b1'), step('b2'), step('b3')] }, step('after')),
    input: 'v',
    runner: plain({ branches: { pick: () => [0, 2] } }),
  },
  {
    name: 'a dowhile loop',
    description: wf('lp', { kind: 'loop', id: 'count', loopType: 'dowhile', iterationBound: 10, body: step('inc') }, step('done')),
    input: 0,
    runner: plain({
      steps: { inc: (i) => ({ status: 'success', output: (i as number) + 1 }) },
      loops: { count: (out) => (out as number) < 4 },
    }),
  },
  {
    name: 'a foreach at concurrency 2',
    description: wf('fe', { kind: 'foreach', id: 'each', concurrency: 2, body: step('item') }),
    input: ['a', 'b', 'c', 'd', 'e'],
    runner: plain({ steps: { item: (i) => ({ status: 'success', output: `${String(i)}!` }) } }),
  },
  {
    name: 'retries without a delay',
    description: wf('rt', step('flaky', { retries: 3 }), step('after')),
    input: 'r',
    runner: plain({
      steps: { flaky: (i, call) => (call.attempt < 2 ? { status: 'failed', error: 'busy' } : { status: 'success', output: i }) },
    }),
  },
  {
    name: 'a failure after exhausted retries',
    description: wf('rf', step('doomed', { retries: 1 }), step('never')),
    input: 'f',
    runner: plain({ steps: { doomed: () => ({ status: 'failed', error: 'no' }) } }),
  },
];

const BUDGETS: readonly (number | undefined)[] = [undefined, 1, 2];
const budgetName = (k: number | undefined): string => (k === undefined ? 'unbounded' : `k=${k}`);
const compileOpts = (k: number | undefined): CompileOptions => (k === undefined ? {} : { concurrency: k });

/** Records, keyed and in first-recorded order, as plain data. */
const recordsOf = (report: RunReport): [string, StepRecord][] => [...report.stepResults];

describe('(a) untimed nets complete through the executor\'s own wake sources alone', () => {
  for (const shape of UNTIMED) {
    for (const k of BUDGETS) {
      for (const withSignal of [false, true]) {
        it(`${shape.name}, ${budgetName(k)}, ${withSignal ? 'with a live signal (drain on terminal)' : 'no signal (quiescence)'}`, async () => {
          const compiled = compile(shape.description, compileOpts(k));
          expect(compiled.budget?.k).toBe(k);

          // The oracle: the same compiled net on a ManualClock, which can advance.
          const oracle = await runWorkflowDetailed(compiled, shape.input, { runner: shape.runner(), clock: new ManualClock(EPOCH), timeoutMs: 10_000 });
          expect(oracle.outcome.status).not.toBe('stranded');

          const clock = new SuspendingClock();
          const ac = new AbortController();
          const runner = shape.runner();
          const running = runWorkflowDetailed(compiled, shape.input, {
            runner,
            clock,
            timeoutMs: 10_000,
            ...(withSignal ? { signal: ac.signal } : {}),
          });
          // Bounded: a hang fails the test rather than wedging it. The clock does not spin, so the
          // real timer can fire.
          const report = await Promise.race([running, realDelay(5_000)]);
          if (report === 'timeout') throw new Error(`${shape.name} did not complete under a suspending clock`);

          // Nothing timed in the net, so the executor never asked for a boundary: every wait was on
          // an in-flight action (`Infinity`), and each was ended by the executor's own wake source.
          expect(clock.finite()).toEqual([]);
          // Not vacuous: the executor did park on the clock, and something other than the clock
          // woke it every time — the clock itself never resolves unless aborted.
          expect(clock.sleeps.length).toBeGreaterThan(0);
          expect(ac.signal.aborted).toBe(false);
          // Same outcome and the same records, stamps included — the clock never moved in either.
          expect(report.outcome).toEqual(oracle.outcome);
          expect(recordsOf(report)).toEqual(recordsOf(oracle));
          expect(report.outcome).not.toHaveProperty('residue');
        });
      }
    }
  }

  it('the budget still bounds steps in flight under a suspending clock: a four-arm parallel peaks at k', async () => {
    for (const k of [1, 2, 3]) {
      let inFlight = 0;
      let peak = 0;
      const slow = async (i: unknown) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { status: 'success' as const, output: i };
      };
      const runner = new RecordingRunner({ steps: { p1: slow, p2: slow, p3: slow, p4: slow } });
      const compiled = compile(wf('par4', { kind: 'parallel', id: 'fan', arms: [step('p1'), step('p2'), step('p3'), step('p4')] }), { concurrency: k });
      const clock = new SuspendingClock();
      const report = await Promise.race([runWorkflowDetailed(compiled, 'x', { runner, clock, timeoutMs: 10_000 }), realDelay(5_000)]);
      if (report === 'timeout') throw new Error(`k=${k} did not complete`);
      expect(report.outcome.status).toBe('success');
      expect(peak).toBe(k);
      expect(clock.finite()).toEqual([]);
    }
  });
});

describe('(a) timed nets do not complete under a suspending clock, and end cleanly', () => {
  /** Starts a run, lets real time pass, and checks it is parked on exactly `boundary`. */
  async function expectParked(
    clock: SuspendingClock,
    run: { settled: () => boolean },
    boundary: number,
  ): Promise<void> {
    await realDelay(150);
    expect(run.settled()).toBe(false);
    // The run is waiting on the timed boundary, and the clock has not granted it.
    expect(clock.finite()).toContain(boundary);
  }

  it('a fixed .sleep stays pending; an abort cancels it mid-wait (row 46)', async () => {
    const compiled = compile(wf('nap', step('a'), { kind: 'sleep', id: 'nap', duration: { fixed: 60_000 } }, step('b')), { concurrency: 1 });
    const clock = new SuspendingClock();
    const ac = new AbortController();
    const runner = new RecordingRunner();
    const run = track(runWorkflowDetailed(compiled, 'x', { runner, clock, signal: ac.signal, timeoutMs: 10_000 }));

    await expectParked(clock, run, 60_000);
    expect(runner.calls).toEqual(['a']);

    const t0 = performance.now();
    ac.abort();
    const report = await Promise.race([run.promise, realDelay(2_000)]);
    if (report === 'timeout') throw new Error('abort did not end the parked sleep');
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(report.outcome).toEqual({ status: 'canceled', origin: { stepId: 'nap', path: [1] }, started: true });
    expect(runner.calls).toEqual(['a']);
    expect(report.stepResults.get('nap')).toEqual({ status: 'waiting', payload: 'x', startedAt: EPOCH });
  });

  it('a fixed .sleep with no signal stays pending; the run budget closes the executor and the run rejects', async () => {
    const compiled = compile(wf('nap2', { kind: 'sleep', id: 'nap', duration: { fixed: 60_000 } }));
    const clock = new SuspendingClock();
    const run = track(runWorkflowDetailed(compiled, 'x', { runner: new RecordingRunner(), clock, timeoutMs: 400 }));

    await expectParked(clock, run, 60_000);
    const settled = await Promise.race([run.promise.then(() => 'resolved', () => 'rejected'), realDelay(3_000)]);
    expect(settled).toBe('rejected');
  });

  it('a retry delay stays pending; an abort does NOT end it (row 44), close() does', async () => {
    const compiled = compile(wf('rd', step('b', { retries: 1, retryDelayMs: 1_000 }), step('c')));
    const clock = new SuspendingClock();
    const ac = new AbortController();
    const runner = new RecordingRunner({ steps: { b: (i, call) => (call.attempt === 0 ? { status: 'failed', error: 'busy' } : { status: 'success', output: i }) } });
    const run = track(runWorkflowDetailed(compiled, 'x', { runner, clock, signal: ac.signal, timeoutMs: 800 }));

    await expectParked(clock, run, 1_000);
    expect(runner.calls).toEqual(['b']);

    // Mastra's retry backoff is a bare setTimeout, not abortable (`default.ts:455-460`), and the
    // net reproduces that: no sweep on the delayed retry. So the abort changes nothing here...
    ac.abort();
    await realDelay(100);
    expect(run.settled()).toBe(false);
    expect(runner.calls).toEqual(['b']);

    // ...and only `close()` — the run budget — ends it, which rejects: there is no outcome.
    const settled = await Promise.race([run.promise.then(() => 'resolved', () => 'rejected'), realDelay(3_000)]);
    expect(settled).toBe('rejected');
    expect(runner.calls).toEqual(['b']);
  });

  it('a per-run .sleep waits on the run clock inside its action, stays pending, and an abort cancels it', async () => {
    const compiled = compile(wf('pr', { kind: 'sleep', id: 'wait', duration: { perRun: true } }, step('after')));
    const clock = new SuspendingClock();
    const ac = new AbortController();
    const runner = new RecordingRunner({ waits: { wait: () => 5_000 } });
    const run = track(runWorkflowDetailed(compiled, 'x', { runner, clock, signal: ac.signal, timeoutMs: 10_000 }));

    await expectParked(clock, run, 5_000);
    ac.abort();
    const report = await Promise.race([run.promise, realDelay(2_000)]);
    if (report === 'timeout') throw new Error('abort did not end the per-run sleep');
    expect(report.outcome).toEqual({ status: 'canceled', origin: { stepId: 'wait', path: [0] }, started: true });
    expect(runner.calls).toEqual([]);
  });
});

describe('(b) two executors on independent ManualClocks', () => {
  const description = wf(
    'timed',
    step('charge'),
    { kind: 'sleep', id: 'settle', duration: { fixed: 60_000 } },
    step('flaky', { retries: 2, retryDelayMs: 1_000 }),
    step('ship'),
  );
  const runner = () =>
    new RecordingRunner({
      steps: { flaky: (i, call) => (call.attempt < 2 ? { status: 'failed', error: 'busy' } : { status: 'success', output: `${String(i)}+` }) },
    });

  /** The records a run on a clock with epoch origin `e` must produce: exact virtual instants. */
  const expected = (e: number, input: string): [string, StepRecord][] => [
    ['charge', { status: 'success', output: input, payload: input, startedAt: e, endedAt: e }],
    ['settle', { status: 'success', output: input, payload: input, startedAt: e, endedAt: e + 60_000 }],
    ['flaky', { status: 'success', output: `${input}+`, payload: input, startedAt: e + 60_000, endedAt: e + 62_000 }],
    ['ship', { status: 'success', output: `${input}+`, payload: `${input}+`, startedAt: e + 62_000, endedAt: e + 62_000 }],
  ];

  for (const k of [undefined, 1] as const) {
    it(`concurrent runs of one compiled net, identical inputs: identical records, stamps included (${budgetName(k)})`, async () => {
      const compiled = compile(description, compileOpts(k));
      const left = new ManualClock(EPOCH);
      const right = new ManualClock(EPOCH);
      const wall = Date.now();
      const [l, r] = await Promise.all([
        runWorkflowDetailed(compiled, 'o', { runner: runner(), clock: left, timeoutMs: 10_000 }),
        runWorkflowDetailed(compiled, 'o', { runner: runner(), clock: right, timeoutMs: 10_000 }),
      ]);
      expect(Date.now() - wall).toBeLessThan(5_000);

      expect(l.outcome).toEqual({ status: 'success', output: 'o+' });
      expect(recordsOf(l)).toEqual(expected(EPOCH, 'o'));
      expect(recordsOf(r)).toEqual(recordsOf(l));
      // Each clock moved by exactly its own run's waits: 60s of sleep plus two 1s retry delays.
      expect(left.elapsed()).toBe(62_000);
      expect(right.elapsed()).toBe(62_000);
    });
  }

  it('each executor observes only its own clock: one run moves nothing of the other\'s', async () => {
    const compiled = compile(description);
    const a = new ManualClock(EPOCH);
    const b = new ManualClock(EPOCH + 5_000_000);

    const ra = await runWorkflowDetailed(compiled, 'a', { runner: runner(), clock: a, timeoutMs: 10_000 });
    expect(a.elapsed()).toBe(62_000);
    // B has not run: advancing A advanced nothing of B's.
    expect(b.elapsed()).toBe(0);

    const rb = await runWorkflowDetailed(compiled, 'b', { runner: runner(), clock: b, timeoutMs: 10_000 });
    expect(b.elapsed()).toBe(62_000);
    expect(a.elapsed()).toBe(62_000);
    expect(recordsOf(ra)).toEqual(expected(EPOCH, 'a'));
    // B's stamps are B's epoch, not A's and not the machine's.
    expect(recordsOf(rb)).toEqual(expected(EPOCH + 5_000_000, 'b'));
  });

  it('two concurrent runs on different epochs each stamp their own records', async () => {
    const compiled = compile(description, { concurrency: 2 });
    const a = new ManualClock(EPOCH);
    const b = new ManualClock(EPOCH + 1);
    const [ra, rb] = await Promise.all([
      runWorkflowDetailed(compiled, 'o', { runner: runner(), clock: a, timeoutMs: 10_000 }),
      runWorkflowDetailed(compiled, 'o', { runner: runner(), clock: b, timeoutMs: 10_000 }),
    ]);
    expect(recordsOf(ra)).toEqual(expected(EPOCH, 'o'));
    expect(recordsOf(rb)).toEqual(expected(EPOCH + 1, 'o'));
  });
});

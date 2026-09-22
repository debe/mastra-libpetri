import { describe, expect, it } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { runWorkflow } from '../../src/engine/index.js';
import type { WorkflowDescription } from '../../src/compiler/types.js';
import { RecordingRunner, type Behaviour } from '../fixtures/runner.js';
import { ManualClock } from '../support/manual-clock.js';

/** A behaviour that records the virtual instant each call started at and echoes its input. */
function stampAt(clock: ManualClock, into: number[]): Behaviour {
  return (input) => {
    into.push(clock.now());
    return { status: 'success', output: input };
  };
}

describe('virtual time', () => {
  it('elapses a long sleep instantly and exactly', async () => {
    const clock = new ManualClock();
    const shipAt: number[] = [];
    const runner = new RecordingRunner({ steps: { ship: stampAt(clock, shipAt) } });
    const compiled = compile({
      id: 'delayed-ship',
      entries: [
        { kind: 'step', id: 'charge' },
        { kind: 'sleep', id: 'settlement-window', duration: { fixed: 60_000 } },
        { kind: 'step', id: 'ship' },
      ],
    });

    const startedWall = Date.now();
    const outcome = await runWorkflow(compiled, 'order', { runner, clock });

    expect(outcome).toEqual({ status: 'success', output: 'order' });
    expect(runner.calls).toEqual(['charge', 'ship']);
    // A minute of model time, none of it real. Without the injected clock this test would
    // take a real minute, which is why the suite could not have one.
    expect(shipAt).toEqual([60_000]);
    expect(clock.elapsed()).toBe(60_000);
    expect(Date.now() - startedWall).toBeLessThan(5_000);
  });

  it('gives two runs in one process independent clocks', async () => {
    const slow = new ManualClock();
    const fast = new ManualClock();
    const build = (ms: number) =>
      compile({ id: `sleep-${ms}`, entries: [{ kind: 'sleep', id: 'wait', duration: { fixed: ms } }] });

    const outcomes = await Promise.all([
      runWorkflow(build(90_000), 'a', { runner: new RecordingRunner(), clock: slow }),
      runWorkflow(build(1_000), 'b', { runner: new RecordingRunner(), clock: fast }),
    ]);

    // Per-executor, not per-net or process-global: this is exactly what the differential
    // harness needs and what `vi.useFakeTimers` cannot express.
    expect(outcomes).toEqual([
      { status: 'success', output: 'a' },
      { status: 'success', output: 'b' },
    ]);
    expect(slow.elapsed()).toBe(90_000);
    expect(fast.elapsed()).toBe(1_000);
  });

  it('gives two concurrent runs of ONE compiled net their own clocks and their own per-run waits', async () => {
    const description: WorkflowDescription = {
      id: 'shared',
      entries: [
        { kind: 'sleep', id: 'fixed', duration: { fixed: 1_000 } },
        { kind: 'sleep', id: 'computed', duration: { perRun: true } },
        { kind: 'step', id: 'ship' },
      ],
    };
    const compiled = compile(description);
    const left = new ManualClock();
    const right = new ManualClock();
    const leftAt: number[] = [];
    const rightAt: number[] = [];
    const run = (clock: ManualClock, at: number[], waitMs: number, input: string) =>
      runWorkflow(compiled, input, {
        clock,
        runner: new RecordingRunner({ steps: { ship: stampAt(clock, at) }, waits: { computed: () => waitMs } }),
      });

    const outcomes = await Promise.all([run(left, leftAt, 7_000, 'L'), run(right, rightAt, 250, 'R')]);

    // The per-run wait travels with the run, not with the cached net: each run gets its own.
    expect(outcomes).toEqual([
      { status: 'success', output: 'L' },
      { status: 'success', output: 'R' },
    ]);
    expect(leftAt).toEqual([8_000]);
    expect(rightAt).toEqual([1_250]);
    expect(left.elapsed()).toBe(8_000);
    expect(right.elapsed()).toBe(1_250);
  });

  it('elapses a retry delay on the injected clock, not the wall clock', async () => {
    const clock = new ManualClock();
    const at: number[] = [];
    const runner = new RecordingRunner({
      steps: {
        flaky: (input, call) => {
          at.push(clock.now());
          return call.attempt < 2 ? { status: 'failed', error: 'busy' } : { status: 'success', output: input };
        },
      },
    });

    const startedWall = Date.now();
    const outcome = await runWorkflow(
      compile({ id: 'retry', entries: [{ kind: 'step', id: 'flaky', retries: 2, retryDelayMs: 3_600_000 }] }),
      'x',
      { runner, clock },
    );

    expect(outcome).toEqual({ status: 'success', output: 'x' });
    expect(at).toEqual([0, 3_600_000, 7_200_000]);
    expect(Date.now() - startedWall).toBeLessThan(5_000);
  });
});

import { describe, expect, it } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { runWorkflow } from '../../src/engine/index.js';
import { RecordingRunner } from '../fixtures/runner.js';
import { ManualClock } from '../support/manual-clock.js';

describe('virtual time', () => {
  it('elapses a long sleep instantly and exactly', async () => {
    const clock = new ManualClock();
    const runner = new RecordingRunner();
    const compiled = compile(
      {
        id: 'delayed-ship',
        entries: [
          { kind: 'step', id: 'charge' },
          { kind: 'sleep', id: 'settlement-window', durationMs: 60_000 },
          { kind: 'step', id: 'ship' },
        ],
      },
      { runner },
    );

    const startedWall = Date.now();
    const outcome = await runWorkflow(compiled, 'order', { clock });

    expect(outcome.status).toBe('success');
    expect(runner.calls).toEqual(['charge', 'ship']);
    // A minute of model time, none of it real. Without the injected clock this test would
    // take a real minute, which is why the suite could not have one.
    expect(clock.elapsed()).toBeGreaterThanOrEqual(60_000);
    expect(Date.now() - startedWall).toBeLessThan(5_000);
  });

  it('gives two runs in one process independent clocks', async () => {
    const slow = new ManualClock();
    const fast = new ManualClock();
    const build = (ms: number) =>
      compile(
        { id: `sleep-${ms}`, entries: [{ kind: 'sleep', id: 'wait', durationMs: ms }] },
        { runner: new RecordingRunner() },
      );

    await Promise.all([
      runWorkflow(build(90_000), 'a', { clock: slow }),
      runWorkflow(build(1_000), 'b', { clock: fast }),
    ]);

    // Per-executor, not per-net or process-global: this is exactly what the differential
    // harness needs and what `vi.useFakeTimers` cannot express.
    expect(slow.elapsed()).toBeGreaterThanOrEqual(90_000);
    expect(fast.elapsed()).toBeLessThan(90_000);
  });
});

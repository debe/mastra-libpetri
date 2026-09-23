import { describe, expect, it, vi } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { runWorkflow, runWorkflowDetailed } from '../../src/engine/index.js';
import type { WorkflowDescription } from '../../src/compiler/types.js';
import { RecordingRunner } from '../fixtures/runner.js';

/**
 * Timing of an abort against the net, at the granularity Mastra reads its signal: synchronously,
 * before each entry and between loop iterations. The kernel injects straight into `wf.cancel`
 * ([ADR 0004]); routing a real abort through `t.cancel.arrive` cost one firing, in which a start
 * enabled in the same cycle got past its inhibitor. Each case runs 20 times, because a window
 * like that shows as an occasional extra start, not a steady one.
 */
describe('an abort raised inside a loop condition (control-flow.ts:889)', () => {
  const loop: WorkflowDescription = {
    id: 'l',
    entries: [
      { kind: 'loop', id: 'lp', body: { kind: 'step', id: 't' }, loopType: 'dowhile', iterationBound: 5 },
      { kind: 'step', id: 'z' },
    ],
  };

  it.each(['synchronously', 'a microtask later', 'two microtasks later'] as const)(
    'stops after the one body that ran, when raised %s',
    async (when) => {
      for (let i = 0; i < 20; i++) {
        const ac = new AbortController();
        const runner = new RecordingRunner({
          loops: {
            lp: () => {
              if (when === 'synchronously') ac.abort();
              else if (when === 'a microtask later') queueMicrotask(() => ac.abort());
              else queueMicrotask(() => queueMicrotask(() => ac.abort()));
              return true;
            },
          },
        });
        const report = await runWorkflowDetailed(compile(loop), 0, { runner, signal: ac.signal, timeoutMs: 5_000 });
        expect(runner.calls, `run ${i}`).toEqual(['t']);
        expect(report.outcome.status, `run ${i}`).toBe('canceled');
      }
    },
  );
});

describe('the kernel does not leak its abort listener (kernel.ts, the finally block)', () => {
  const chain: WorkflowDescription = { id: 'c', entries: [{ kind: 'step', id: 'a' }, { kind: 'step', id: 'b' }] };

  it('removes exactly the listener it added, whether the run ends normally or by throwing', async () => {
    for (const fails of [false, true]) {
      const ac = new AbortController();
      const add = vi.spyOn(ac.signal, 'addEventListener');
      const remove = vi.spyOn(ac.signal, 'removeEventListener');
      const runner = new RecordingRunner({
        a: () => {
          if (fails) throw new Error('boom');
          return { status: 'success', output: 1 };
        },
      });
      await runWorkflow(compile(chain), 0, { runner, signal: ac.signal });

      const added = add.mock.calls.filter(([type]) => type === 'abort').map(([, fn]) => fn);
      const removed = remove.mock.calls.filter(([type]) => type === 'abort').map(([, fn]) => fn);
      // One per run: the kernel's own listener. A shared controller reused across many runs must
      // not accumulate one listener per run that ever used it.
      expect(added).toHaveLength(1);
      expect(removed).toEqual(added);
    }
  });
});

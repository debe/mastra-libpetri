import { describe, expect, it, vi } from 'vitest';
import { KernelRunScope } from '../../src/engine/scope.js';
import { StepPreemptedError } from '../../src/compiler/preempt.js';
import type { StepRunner } from '../../src/compiler/types.js';

/**
 * The scope's half of [ADR 0014]: one preemption signal per deciding block per segment, aborted
 * only by `preempt` with the block's `StepPreemptedError`, never touching the run's signal; and
 * `forgetSuspension`, forwarded to the runner's optional hook. The decision gadget and the leaf that
 * call these are not exercised here (W2 `race.test.ts` does that end to end). Each case names the
 * mutation that breaks it.
 */

const runner = (extra: Partial<StepRunner> = {}): StepRunner => ({ run: async () => ({ status: 'success', output: 1 }), ...extra });

describe('preemption', () => {
  it('is one signal per block, the same for every ask, distinct across blocks', () => {
    // Mutation: a fresh controller on every ask -> the first expectation fails.
    const scope = new KernelRunScope({ runner: runner(), initData: 0 });
    expect(scope.preemption([1])).toBe(scope.preemption([1]));
    expect(scope.preemption([1])).not.toBe(scope.preemption([2]));
    expect(scope.preemption([1]).aborted).toBe(false);
  });

  it('does not collide on paths whose joined digits agree', () => {
    // Mutation: key by `path.join('')` -> [1, 2] and [12] share a signal.
    const scope = new KernelRunScope({ runner: runner(), initData: 0 });
    expect(scope.preemption([1, 2])).not.toBe(scope.preemption([12]));
  });

  it('preempt aborts the block with its reason and leaves other blocks and the run alone', () => {
    // Mutation: abort `this.signal`'s source, or every block -> the run / block [2] reads aborted.
    const run = new AbortController();
    const scope = new KernelRunScope({ runner: runner(), initData: 0, signal: run.signal });
    const one = scope.preemption([1]);
    const two = scope.preemption([2]);
    const reason = new StepPreemptedError('pick', [1], 'met');
    scope.preempt([1], reason);
    expect(one.aborted).toBe(true);
    expect(one.reason).toBe(reason);
    expect(two.aborted).toBe(false);
    expect(scope.signal.aborted).toBe(false);
    expect(run.signal.aborted).toBe(false);
  });

  it('a second preempt is a no-op: the first reason stands', () => {
    // Mutation: re-create the controller on a second call -> the arm's signal and the new one differ.
    const scope = new KernelRunScope({ runner: runner(), initData: 0 });
    const signal = scope.preemption([0]);
    const first = new StepPreemptedError('pick', [0], 'met');
    scope.preempt([0], first);
    scope.preempt([0], new StepPreemptedError('pick', [0], 'short'));
    expect(signal.reason).toBe(first);
    expect(scope.preemption([0])).toBe(signal);
  });

  it('preempt before any arm asked: the arm then gets a signal already fired', () => {
    // Mutation: return early from preempt when no controller exists -> the later ask is not aborted.
    const scope = new KernelRunScope({ runner: runner(), initData: 0 });
    const reason = new StepPreemptedError('pick', [3], 'short');
    scope.preempt([3], reason);
    const late = scope.preemption([3]);
    expect(late.aborted).toBe(true);
    expect(late.reason).toBe(reason);
  });

  it('a run abort does not fire a preemption', () => {
    // Mutation: link the block's controller to the run signal -> the block reads aborted.
    const run = new AbortController();
    const scope = new KernelRunScope({ runner: runner(), initData: 0, signal: run.signal });
    const signal = scope.preemption([0]);
    run.abort('cancel');
    expect(signal.aborted).toBe(false);
  });

  it('a new scope — the next segment — starts undecided', () => {
    // Mutation: a module-level map of controllers -> the second scope's block is already aborted.
    const a = new KernelRunScope({ runner: runner(), initData: 0 });
    a.preempt([0], new StepPreemptedError('pick', [0], 'met'));
    const b = new KernelRunScope({ runner: runner(), initData: 0 });
    expect(b.preemption([0]).aborted).toBe(false);
  });
});

describe('forgetSuspension', () => {
  it("forwards to the runner's hook, bound to the runner", () => {
    // Mutation: make forgetSuspension a no-op -> the hook is never called.
    const seen: unknown[] = [];
    const r = runner({
      forgetSuspension(this: StepRunner, stepId: string) {
        seen.push([this, stepId]);
      },
    });
    const scope = new KernelRunScope({ runner: r, initData: 0 });
    scope.forgetSuspension('loser');
    expect(seen).toEqual([[r, 'loser']]);
  });

  it('reaches the runner through the checkpoint proxy too', () => {
    // Mutation: forward to the options' runner property under another name -> not called.
    const forget = vi.fn();
    const scope = new KernelRunScope({ runner: runner({ checkpoint: async () => {}, forgetSuspension: forget }), initData: 0 });
    scope.forgetSuspension('loser');
    expect(forget).toHaveBeenCalledWith('loser');
  });

  it('is a no-op for a runner without the hook', () => {
    // Mutation: call `this.runner.forgetSuspension!(…)` unguarded -> throws.
    const scope = new KernelRunScope({ runner: runner(), initData: 0 });
    expect(() => scope.forgetSuspension('loser')).not.toThrow();
  });
});

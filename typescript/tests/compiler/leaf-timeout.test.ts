import { describe, expect, it } from 'vitest';
import type { Place, Transition } from 'libpetri';
import { SmtVerifier, unreachable } from 'libpetri/verification';
import { compile, StepTimeoutError } from '../../src/compiler/index.js';
import { runWorkflowDetailed } from '../../src/engine/index.js';
import { segmentInitialMarking, verifyWorkflow } from '../../src/verify/index.js';
import type {
  CompiledWorkflow,
  EntryDescription,
  LifecycleEvent,
  StepCall,
  StepDescription,
  StepOutcome,
  StepRunner,
  WorkflowDescription,
} from '../../src/compiler/types.js';
import { ManualClock } from '../support/manual-clock.js';

/**
 * A step timeout ([ADR 0013]): each attempt's output Xor gains `timedOut_j`, written by the action
 * itself after racing the step against `scope.armDeadline` on the run's clock; an immediate funnel
 * forwards it to the retry (non-final) or the failure exit (final).
 *
 * Environment: the kernel (`runWorkflowDetailed`) with a scripted runner and the tests'
 * `ManualClock` (virtual time; a finite `sleep` advances it), libpetri 8.0.0 from the registry
 * (not linked). The runtime cases are tested, not proven; the proofs below name their property,
 * segment and route.
 */

const EPOCH = 1_700_000_000_000;
const wf = (...entries: EntryDescription[]): WorkflowDescription => ({ id: 'timeout', entries });
const step = (id: string, extra: Omit<StepDescription, 'kind' | 'id'> = {}): StepDescription => ({ kind: 'step', id, ...extra });

/** A promise with its resolver, for a step the test releases by hand. */
function latch<T = void>(): { readonly promise: Promise<T>; readonly release: (value: T) => void } {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Resolves when `signal` aborts (at once if it already has). */
function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

/** Several macrotask turns — long enough for the executor and every armed deadline to move. */
async function turns(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

type Script = (input: unknown, call: StepCall) => StepOutcome | Promise<StepOutcome>;

/** A runner that keeps every call and every lifecycle event. */
class ScriptedRunner implements StepRunner {
  readonly calls: StepCall[] = [];
  readonly events: LifecycleEvent[] = [];
  constructor(readonly script: Readonly<Record<string, Script>>) {}
  async run(stepId: string, input: unknown, call: StepCall): Promise<StepOutcome> {
    this.calls.push(call);
    const fn = Object.hasOwn(this.script, stepId) ? this.script[stepId] : undefined;
    return fn === undefined ? { status: 'success', output: input } : fn(input, call);
  }
  observe(event: LifecycleEvent): void {
    this.events.push(event);
  }
}

/** A step that honours its deadline: it waits on the signal it is handed and fails with its reason. */
const cooperative: Script = async (_input, call) => {
  await aborted(call.deadline!);
  return { status: 'failed', error: call.deadline!.reason };
};

const transitionNamed = (compiled: CompiledWorkflow, name: string): Transition => {
  const t = [...compiled.net.transitions].find((x) => x.name === name);
  if (t === undefined) throw new Error(`no transition '${name}'`);
  return t;
};
/** Every place, transition and arc of a net, as one comparable value. */
const signature = (compiled: CompiledWorkflow): unknown => ({
  places: [...compiled.net.places].map((p) => p.name),
  transitions: [...compiled.net.transitions].map((t) => ({
    name: t.name,
    in: t.inputSpecs.map((s) => s.place.name),
    out: [...t.outputPlaces()].map((p) => p.name),
    inhibitors: t.inhibitors.map((a) => a.place.name),
    reads: t.reads.map((a) => a.place.name),
    timing: t.timing,
  })),
});

describe('leaf timeout — structure', () => {
  it('a step without timeoutMs or quotas compiles to exactly the net it did before M7', () => {
    for (const extra of [{}, { retries: 2, retryDelayMs: 10 }]) {
      for (const k of [undefined, 2]) {
        const opts = k === undefined ? {} : { concurrency: k };
        const plain = compile(wf(step('a', extra)), opts);
        const empty = compile(wf(step('a', { ...extra, quotas: [] })), opts);
        expect(signature(empty)).toEqual(signature(plain));
        expect(plain.steps[0]).toMatchObject({ timeouts: [], timedOut: [], quotas: [] });
        expect([...plain.net.places].some((p) => p.name.includes('timed-out'))).toBe(false);
      }
    }
  });

  it('every attempt gains a timedOut branch and a funnel: to the retry, then to the failure exit', () => {
    const compiled = compile(wf(step('a', { retries: 1, retryDelayMs: 50, timeoutMs: 100 })), { concurrency: 1 });
    const chain = compiled.steps[0]!;
    expect(chain.timeouts).toEqual(['t.0.a.timeout-0', 't.0.a.timeout-1']);
    expect(chain.timedOut).toEqual(['s.0.a.timed-out-0', 's.0.a.timed-out-1']);

    // Attempt j produces into timedOut_j, with the permit, as one Xor branch among the others.
    chain.attempts.forEach((name, j) => {
      const outs = [...transitionNamed(compiled, name).outputPlaces()].map((p) => p.name);
      expect(outs).toContain(chain.timedOut[j]);
      expect(outs).toContain('wf.permits');
    });
    // Funnel 0 -> retry-1 (then the delayed hop); funnel 1 (final) -> the failure exit. Immediate, ungated.
    const f0 = transitionNamed(compiled, chain.timeouts[0]!);
    const f1 = transitionNamed(compiled, chain.timeouts[1]!);
    expect(f0.inputSpecs.map((s) => s.place.name)).toEqual(['s.0.a.timed-out-0']);
    expect([...f0.outputPlaces()].map((p) => p.name)).toEqual(['s.0.a.retry-1']);
    // The failure exit the attempts' own `failed` branch uses — top level, the settle place before `wf.failed`.
    expect([...f1.outputPlaces()].map((p) => p.name)).toEqual(['wf.settle.failed']);
    expect([...transitionNamed(compiled, chain.attempts[1]!).outputPlaces()].map((p) => p.name)).toContain('wf.settle.failed');
    for (const f of [f0, f1]) {
      expect(f.timing.type).toBe('immediate');
      expect(f.inhibitors).toEqual([]);
    }
  });

  it('refuses a timeout that is not a whole number of ms in [1, MAX_WAIT_MS]', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, 2_147_483_648]) {
      expect(() => compile(wf(step('a', { timeoutMs: bad })))).toThrow(/timeoutMs must be a whole number/);
    }
  });
});

describe('leaf timeout — runtime (ManualClock)', () => {
  it('a cooperative step is aborted at its deadline, retried per retries, and fails with a StepTimeoutError', async () => {
    const clock = new ManualClock(EPOCH);
    const runner = new ScriptedRunner({ a: cooperative });
    const { outcome, stepResults } = await runWorkflowDetailed(
      compile(wf(step('a', { retries: 2, retryDelayMs: 100, timeoutMs: 1000 }))),
      'in',
      { runner, clock },
    );

    expect(runner.calls.map((c) => c.attempt)).toEqual([0, 1, 2]);
    // Three deadlines and two retry delays, all virtual.
    expect(clock.elapsed()).toBe(3 * 1000 + 2 * 100);
    for (const call of runner.calls) {
      expect(call.deadline?.aborted).toBe(true);
      expect(call.deadline?.reason).toBeInstanceOf(StepTimeoutError);
      expect(call.abortSignal.aborted).toBe(false); // the run was never canceled
    }
    expect((runner.calls[2]!.deadline!.reason as StepTimeoutError).attempt).toBe(2);

    expect(outcome.status).toBe('failed');
    const error = (outcome as { error: unknown }).error;
    expect(error).toBeInstanceOf(StepTimeoutError);
    expect(error).toMatchObject({ stepId: 'a', path: [0], timeoutMs: 1000, attempt: 2 });
    // Only the final attempt is recorded, as for any failure.
    expect(stepResults.get('a')).toEqual({ status: 'failed', error, payload: 'in', startedAt: EPOCH, endedAt: EPOCH + 3200 });
    const settled = runner.events.filter((e) => e.kind === 'step-settled');
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ stepId: 'a', record: { status: 'failed', error } });
  });

  it('a step that ignores its signal holds the run until it returns; its late success is discarded', async () => {
    const clock = new ManualClock(EPOCH);
    const release = latch();
    let returned = false;
    const runner = new ScriptedRunner({
      a: async () => {
        await release.promise;
        returned = true;
        return { status: 'success', output: 'late' };
      },
    });
    let done = false;
    const run = runWorkflowDetailed(compile(wf(step('a', { timeoutMs: 500 }), step('b'))), 'in', { runner, clock }).finally(() => {
      done = true;
    });

    await turns();
    const deadline = runner.calls[0]!.deadline!;
    await aborted(deadline);
    expect(deadline.reason).toBeInstanceOf(StepTimeoutError);
    await turns();
    // Fired, but the attempt is still in flight: the run waits for the step.
    expect(done).toBe(false);
    expect(returned).toBe(false);

    release.release();
    const { outcome, stepResults } = await run;
    expect(returned).toBe(true);
    expect(outcome.status).toBe('failed');
    expect((outcome as { error: unknown }).error).toBeInstanceOf(StepTimeoutError);
    expect(stepResults.get('a')).toMatchObject({ status: 'failed', payload: 'in', startedAt: EPOCH, endedAt: EPOCH + 500 });
    expect(stepResults.get('a')).not.toHaveProperty('output');
    // `b` never ran: the late success went nowhere.
    expect(runner.calls.map((c) => c.attempt)).toEqual([0]);
    expect(stepResults.has('b')).toBe(false);
  });

  it('a step that returns before its deadline proceeds as today and moves no virtual time', async () => {
    const clock = new ManualClock(EPOCH);
    const runner = new ScriptedRunner({ a: async (input) => ({ status: 'success', output: `${String(input)}!` }) });
    const { outcome, stepResults } = await runWorkflowDetailed(compile(wf(step('a', { timeoutMs: 1000 }))), 'in', { runner, clock });
    expect(outcome).toMatchObject({ status: 'success', output: 'in!' });
    expect(stepResults.get('a')).toMatchObject({ status: 'success', output: 'in!', endedAt: EPOCH });
    expect(runner.calls[0]!.deadline?.aborted).toBe(false);
    expect(clock.elapsed()).toBe(0);
  });

  it('a run abort before expiry disarms the deadline: the step\'s own outcome stands', async () => {
    const clock = new ManualClock(EPOCH);
    const controller = new AbortController();
    const runner = new ScriptedRunner({
      a: async (_input, call) => {
        controller.abort(new Error('user cancel'));
        await aborted(call.abortSignal);
        return { status: 'success', output: 'mine' };
      },
    });
    const { stepResults } = await runWorkflowDetailed(compile(wf(step('a', { timeoutMs: 1000, retries: 1 }))), 'in', {
      runner,
      clock,
      signal: controller.signal,
    });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.deadline?.aborted).toBe(false);
    expect(stepResults.get('a')).toMatchObject({ status: 'success', output: 'mine' });
    expect(clock.elapsed()).toBe(0);
  });

  it('the permit is held until a timed-out step settles: the next arm waits for the step, not the deadline', async () => {
    const clock = new ManualClock(EPOCH);
    const release = latch();
    const order: string[] = [];
    const runner = new ScriptedRunner({
      a: async () => {
        order.push('a:start');
        await release.promise;
        order.push('a:return');
        return { status: 'success', output: 'a' };
      },
      b: async () => {
        order.push('b:start');
        return { status: 'success', output: 'b' };
      },
    });
    const run = runWorkflowDetailed(
      compile(wf({ kind: 'parallel', id: 'p', arms: [step('a', { timeoutMs: 100 }), step('b')] }), { concurrency: 1 }),
      'in',
      { runner, clock },
    );
    await turns();
    await aborted(runner.calls[0]!.deadline!);
    await turns();
    expect(order).toEqual(['a:start']); // `a` timed out, still holds the one permit
    release.release();
    const { outcome } = await run;
    expect(order).toEqual(['a:start', 'a:return', 'b:start']);
    expect(outcome.status).toBe('failed');
  });
});

describe('leaf timeout — proofs', () => {
  const nets: readonly [string, () => CompiledWorkflow][] = [
    ['timeout, no retries', () => compile(wf(step('a', { timeoutMs: 100 }), step('b')))],
    ['timeout, 2 retries with a delay, k=2', () => compile(wf(step('a', { timeoutMs: 100, retries: 2, retryDelayMs: 50 })), { concurrency: 2 })],
    ['timeout inside a parallel, k=1', () => compile(wf({ kind: 'parallel', id: 'p', arms: [step('a', { timeoutMs: 100, retries: 1 }), step('b')] }), { concurrency: 1 })],
  ];

  for (const [label, build] of nets) {
    it(`${label}: every completion property is proven in the closed and cancel segments`, async () => {
      const compiled = build();
      const started = performance.now();
      const reports = await verifyWorkflow(compiled, { restart: 'none' });
      const ms = Math.round(performance.now() - started);
      const lines = reports.map((r) => `${typeof r.segment === 'string' ? r.segment : JSON.stringify(r.segment)}/${r.property}: ${r.result.verdict.type}`);
      console.log(`[leaf-timeout] ${label}: ${reports.length} completion proofs in ${ms} ms (libpetri 8.0.0, registry)\n  ${lines.join('\n  ')}`);
      expect(reports.length).toBeGreaterThan(0);
      for (const r of reports) expect(`${r.property}: ${r.result.verdict.type}`).toBe(`${r.property}: proven`);
    });
  }

  it('the liveness witness reaches every timedOut_j (closed segment, SMT route, replay-confirmed)', async () => {
    const compiled = compile(wf(step('a', { timeoutMs: 100, retries: 2, retryDelayMs: 50 })), { concurrency: 1 });
    const initial = segmentInitialMarking(compiled, 'closed');
    const t = compiled.terminals;
    const byName = new Map([...compiled.net.places].map((p) => [p.name, p as Place<unknown>]));
    for (const name of compiled.steps[0]!.timedOut) {
      const started = performance.now();
      const result = await SmtVerifier.forNet(compiled.net)
        .initialMarking((m) => {
          for (const [p, n] of initial) m.tokens(p, n);
        })
        .sinkPlaces(t.done, t.failed, t.bailed, t.suspended, t.paused, t.canceled, compiled.cancel, compiled.budget!.permits)
        .semiflowInvariants(true)
        .timeout(30_000)
        .property(unreachable(new Set([byName.get(name)!])))
        .verify();
      console.log(`[leaf-timeout] witness ${name}: ${result.verdict.type}, confirmed=${String(result.counterexampleConfirmed)}, ${result.counterexampleTransitions.length} firings, ${Math.round(performance.now() - started)} ms (libpetri 8.0.0, registry)`);
      // "Unreachable" violated with a confirmed trace = a run that reaches the place.
      expect(result.verdict.type).toBe('violated');
      expect(result.counterexampleConfirmed).toBe(true);
    }
  });
});

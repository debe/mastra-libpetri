import { describe, expect, it } from 'vitest';
import {
  PrecompiledNetExecutor,
  environmentPlace,
  tokenOf,
  type EventStore,
  type Marking,
  type NetEvent,
  type Place,
  type Token,
} from 'libpetri';
import { compile, RUN_SCOPE_KEY } from '../../src/compiler/index.js';
import { KernelRunScope, classify, runWorkflowDetailed, type RunOutcome, type RunReport } from '../../src/engine/index.js';
import type { CompiledWorkflow, EntryDescription, FlowToken, StepCall, StepDescription, StepOutcome } from '../../src/compiler/types.js';
import { RecordingRunner } from '../fixtures/runner.js';
import { ManualClock } from '../support/manual-clock.js';

/**
 * The run's step budget ([ADR 0006]), measured on the executor.
 *
 * "In flight" is counted by the runner: `run()` entered and not yet returned — one step attempt.
 * Every figure below comes from that gauge on a real `PrecompiledNetExecutor` run against
 * libpetri 6.1.0 from npm (`typescript/node_modules/libpetri`), never from the net's arcs.
 *
 * **How peaks are made to happen rather than hoped for.** A step does not sleep a fixed time; it
 * holds until the expected number of attempts are inside (or every attempt has started) and then
 * yields once more, so any extra attempt the executor would admit has the chance to arrive. A
 * budget that admits too few therefore hangs into the run's timeout, and one that admits too many
 * shows up as a higher peak — both fail.
 */

const step = (id: string, extra: Partial<Omit<StepDescription, 'kind' | 'id'>> = {}): StepDescription => ({ kind: 'step', id, ...extra });
const armsOf = (n: number): StepDescription[] => Array.from({ length: n }, (_, i) => step(`a${i + 1}`));
const parallel = (n: number): EntryDescription => ({ kind: 'parallel', id: 'fan', arms: armsOf(n) });
const foreach = (c: number, body: StepDescription = step('body')): EntryDescription => ({ kind: 'foreach', id: 'items', body, concurrency: c });

const build = (entries: readonly EntryDescription[], k: number | undefined): CompiledWorkflow =>
  compile({ id: 'budget', entries }, k === undefined ? {} : { concurrency: k });

/** Resolves when `cond` holds, polling on the macrotask queue; rejects after `ms` real time. */
async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('until: condition never held');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2));

/** Steps-in-flight gauge. `hold` decides when an attempt may leave. */
class Gauge {
  inFlight = 0;
  peak = 0;
  started = 0;
  readonly trace: string[] = [];
  /** Each attempt's input, in start order. */
  readonly inputs: unknown[] = [];

  wrap(behaviour: (input: unknown, call: StepCall, stepId: string) => StepOutcome | Promise<StepOutcome>, hold: () => Promise<void>) {
    return async (stepId: string, input: unknown, call: StepCall): Promise<StepOutcome> => {
      this.inFlight++;
      this.started++;
      this.peak = Math.max(this.peak, this.inFlight);
      this.trace.push(`enter:${stepId}#${call.attempt}`);
      this.inputs.push(input);
      try {
        await hold();
        await tick();
        return await behaviour(input, call, stepId);
      } finally {
        this.inFlight--;
        this.trace.push(`exit:${stepId}#${call.attempt}`);
      }
    };
  }
}

/** A runner whose every listed step goes through the gauge, holding until `target` are inside. */
function gaugedRunner(
  ids: readonly string[],
  gauge: Gauge,
  target: number,
  total: number,
  behaviour: (input: unknown, call: StepCall, stepId: string) => StepOutcome | Promise<StepOutcome> = (input, _c, id) => ({
    status: 'success',
    output: `${id}(${String(input)})`,
  }),
): RecordingRunner {
  const run = gauge.wrap(behaviour, () => until(() => gauge.inFlight >= target || gauge.started >= total));
  return new RecordingRunner({ steps: Object.fromEntries(ids.map((id) => [id, (input: unknown, call: StepCall) => run(id, input, call)])) });
}

/** Unbounded is `undefined`; `min(k, work)` is the expected peak. */
const expectedPeak = (k: number | undefined, work: number): number => (k === undefined ? work : Math.min(k, work));

describe('parallel: peak in flight = min(k, arms), results identical at every k', () => {
  const KS = [1, 2, 3, 4, 5, undefined] as const;

  it.each([[2], [4]])('%i arms', async (n) => {
    const outcomes: RunOutcome[] = [];
    for (const k of KS) {
      const gauge = new Gauge();
      const ids = armsOf(n).map((a) => a.id);
      const runner = gaugedRunner(ids, gauge, expectedPeak(k, n), n);
      const report = await runWorkflowDetailed(build([parallel(n)], k), 'x', { runner, timeoutMs: 10_000 });
      expect(gauge.peak, `k=${String(k)} n=${n}`).toBe(expectedPeak(k, n));
      expect(gauge.started).toBe(n);
      expect(gauge.inFlight).toBe(0);
      outcomes.push(report.outcome);
    }
    // Same result at every budget, and no residue: the permits are excluded from residue by
    // design, every other place must be empty.
    for (const o of outcomes) expect(o).toEqual(outcomes[outcomes.length - 1]);
    expect(outcomes[0]).toMatchObject({ status: 'success' });
    expect('residue' in outcomes[0]!).toBe(false);
  });
});

describe('k=1 serialises a parallel, with identical results', () => {
  /** Arm outcomes vary by id so the join sees a mix; a failing arm must fail the block alike. */
  const mixed = (failing: boolean) => (input: unknown, _call: StepCall, id: string): StepOutcome =>
    failing && id === 'a3' ? { status: 'failed', error: `boom:${id}` } : { status: 'success', output: `${id}(${String(input)})` };

  it.each([['all succeed', false], ['one arm fails', true]] as const)('%s', async (_label, failing) => {
    const run = async (k: number | undefined): Promise<{ report: RunReport; gauge: Gauge }> => {
      const gauge = new Gauge();
      const runner = gaugedRunner(['a1', 'a2', 'a3', 'a4'], gauge, expectedPeak(k, 4), 4, mixed(failing));
      const report = await runWorkflowDetailed(build([step('first'), parallel(4), step('last')], k), 'x', { runner, timeoutMs: 10_000 });
      return { report, gauge };
    };
    const serial = await run(1);
    const free = await run(undefined);

    expect(serial.gauge.peak).toBe(1);
    expect(free.gauge.peak).toBe(4);
    // Serialised: every enter is followed by its own exit before the next enter.
    const trace = serial.gauge.trace;
    for (let i = 0; i < trace.length; i += 2) {
      expect(trace[i]!.replace('enter:', '')).toBe(trace[i + 1]!.replace('exit:', ''));
    }
    expect(serial.report.outcome).toEqual(free.report.outcome);
    // Records compared as a set, keyed by id: their insertion order is completion order, which the
    // unbounded run leaves to timing — serialising may only strengthen an order, and does.
    const strip = (r: RunReport) =>
      [...r.stepResults]
        .map(([id, rec]) => [id, rec.status, 'output' in rec ? rec.output : undefined, 'error' in rec ? rec.error : undefined] as const)
        .sort(([a], [b]) => a.localeCompare(b));
    expect(strip(serial.report)).toEqual(strip(free.report));
    expect(serial.report.outcome.status).toBe(failing ? 'failed' : 'success');
  });
});

describe('foreach: lanes against the budget', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f'];

  it.each([
    [3, 2, 2],
    [3, 1, 1],
    [3, 4, 3],
    [3, undefined, 3],
    [1, 2, 1],
    [2, 2, 2],
  ] as const)('c=%i lanes, k=%s: peak %i', async (c, k, peak) => {
    const gauge = new Gauge();
    const runner = gaugedRunner(['body'], gauge, peak, items.length);
    const report = await runWorkflowDetailed(build([foreach(c)], k), items, { runner, timeoutMs: 10_000 });
    expect(gauge.peak).toBe(peak);
    expect(gauge.started).toBe(items.length);
    expect(report.outcome).toEqual({ status: 'success', output: items.map((i) => `body(${i})`) });
  });
});

describe('retries: a retry delay holds no permit', () => {
  it('k=1, two arms each failing once with a 50ms delay: the second arm runs during the first arm\'s delay', async () => {
    // Under a virtual clock, so "during the delay" is exact: the time an attempt starts.
    const clock = new ManualClock();
    const starts: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const flaky = async (input: unknown, call: StepCall, id: string): Promise<StepOutcome> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      starts.push(`${id}#${call.attempt}@${clock.now()}`);
      await new Promise<void>((resolve) => setImmediate(resolve));
      inFlight--;
      return call.attempt === 0 ? { status: 'failed', error: 'first' } : { status: 'success', output: `${id}(${String(input)})` };
    };
    const runner = new RecordingRunner({
      steps: { a: (i, c) => flaky(i, c, 'a'), b: (i, c) => flaky(i, c, 'b') },
    });
    const description = [{ kind: 'parallel', id: 'fan', arms: [step('a', { retries: 1, retryDelayMs: 50 }), step('b', { retries: 1, retryDelayMs: 50 })] }] as const;
    const report = await runWorkflowDetailed(build(description, 1), 'x', { runner, clock, timeoutMs: 10_000 });

    expect(peak).toBe(1);
    // Both first attempts at t=0: whichever went first released its permit into its delay, and
    // the other took it. Were the delay holding the permit, the second first attempt would start
    // at t=50 at the earliest. (The retries land at 50 and 100, not both at 50: `ManualClock`
    // jumps to the next timed transition while an action is still in flight, so the second arm's
    // first attempt "ends" at t=50 and its own delay runs from there. Measured, and pinned.)
    expect(starts.map((s) => s.replace(/^[ab]/, 'X'))).toEqual(['X#0@0', 'X#0@0', 'X#1@50', 'X#1@100']);
    expect(new Set(starts.slice(0, 2).map((s) => s[0]))).toEqual(new Set(['a', 'b']));
    expect(starts[2]![0]).toBe(starts[0]![0]);
    expect(report.outcome).toMatchObject({ status: 'success' });
    expect('residue' in report.outcome).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Cancellation mid-run: the permits are all back. `classify` excludes `wf.permits` from residue,
// so the public report cannot show a lost permit; this hand-runs the kernel's own wiring — the
// same initial marking, run scope, environment place and drain-on-terminal — to read the final
// marking, and checks the public kernel agrees on the outcome.
// ---------------------------------------------------------------------------------------------

async function handRun(compiled: CompiledWorkflow, input: unknown, runner: RecordingRunner, signal: AbortSignal): Promise<{ marking: Marking; outcome: RunOutcome }> {
  const scope = new KernelRunScope({ runner, initData: input, signal });
  const initial = new Map<Place<unknown>, Token<unknown>[]>([[compiled.entryPlace, [tokenOf<FlowToken>({ data: input })]]]);
  if (compiled.budget) initial.set(compiled.budget.permits, Array.from({ length: compiled.budget.k }, () => tokenOf<null>(null)));
  const context = new Map<string, unknown>([[RUN_SCOPE_KEY, scope]]);
  const cancelPlace = environmentPlace<null>(compiled.cancel.name);
  const terminalNames = new Set(Object.values(compiled.terminals).map((p: Place<unknown>) => p.name));
  let executor: PrecompiledNetExecutor | undefined;
  let fired = false;
  const watcher: EventStore = {
    append(event: NetEvent): void {
      if (!fired && event.type === 'token-added' && terminalNames.has(event.placeName)) {
        fired = true;
        executor?.drain();
      }
    },
    events: () => [],
    isEnabled: () => true,
    size: () => 0,
    isEmpty: () => true,
  };
  executor = new PrecompiledNetExecutor(compiled.net, initial, {
    executionContextProvider: () => context,
    program: compiled.program,
    environmentPlaces: new Set([cancelPlace]),
    eventStore: watcher,
  });
  const onAbort = (): void => executor?.injectNoAwait(cancelPlace, null);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const marking = await executor.run(10_000, 'close');
    return { marking, outcome: classify(compiled, marking) };
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

describe('cancellation mid-run with a budget: every permit is back', () => {
  /** Runs twice — hand-run for the marking, the public kernel for the outcome — on fresh signals. */
  async function both(compiled: CompiledWorkflow, input: unknown, make: (controller: AbortController, gauge: Gauge) => RecordingRunner) {
    const c1 = new AbortController();
    const g1 = new Gauge();
    const hand = await handRun(compiled, input, make(c1, g1), c1.signal);
    const c2 = new AbortController();
    const g2 = new Gauge();
    const pub = await runWorkflowDetailed(compiled, input, { runner: make(c2, g2), signal: c2.signal, timeoutMs: 10_000 });
    return { hand, pub, g1, g2 };
  }

  it('a parallel of 4 at k=2, aborted by its first arm: every arm runs, 2 at a time, and 2 permits rest', async () => {
    const compiled = build([step('first'), parallel(4), step('after')], 2);
    const { hand, pub, g1, g2 } = await both(compiled, 'x', (controller, gauge) =>
      gaugedRunner(['a1', 'a2', 'a3', 'a4'], gauge, 2, 4, (input, _call, id) => {
        if (id === 'a1') controller.abort();
        return { status: 'success', output: `${id}(${String(input)})` };
      }),
    );
    expect(hand.marking.tokenCount(compiled.budget!.permits)).toBe(2);
    expect(hand.outcome).toEqual(pub.outcome);
    expect(hand.outcome.status).toBe('canceled');
    expect('residue' in hand.outcome).toBe(false);
    for (const g of [g1, g2]) {
      // Mastra runs every arm of a started block; nothing after it starts (`after` is not gauged,
      // so the gauge sees the arms only, and the step records show `after` never ran).
      expect(g.trace.filter((t) => t.startsWith('enter:')).sort()).toEqual(['enter:a1#0', 'enter:a2#0', 'enter:a3#0', 'enter:a4#0']);
      expect(g.peak).toBe(2);
    }
  });

  it('a foreach of 6 items, 3 lanes, k=2, aborted by its first item: dispatched items finish, 2 permits rest', async () => {
    // `a` aborts; every other item holds until the abort has landed, so no lane frees before it.
    // Lanes dispatch a, b, c before the abort (Mastra's queue starts all three at once); the budget
    // admits a and b, and c takes a's permit after the abort — a step never checks the signal, and
    // Mastra ran c too. d, e and f are never dispatched: the lane start is gated (`:1160`).
    const compiled = build([foreach(3)], 2);
    const items = ['a', 'b', 'c', 'd', 'e', 'f'];
    const { hand, pub, g1, g2 } = await both(compiled, items, (controller, gauge) =>
      gaugedRunner(['body'], gauge, 2, 2, async (input) => {
        if (input === 'a') controller.abort();
        else await until(() => controller.signal.aborted);
        return { status: 'success', output: `body(${String(input)})` };
      }),
    );
    expect(hand.marking.tokenCount(compiled.budget!.permits)).toBe(2);
    expect(hand.outcome).toEqual(pub.outcome);
    expect(hand.outcome.status).toBe('canceled');
    expect('residue' in hand.outcome).toBe(false);
    for (const g of [g1, g2]) {
      expect(g.peak).toBe(2);
      expect(g.inputs).toEqual(['a', 'b', 'c']);
    }
  });

  it('a step aborted in its first attempt keeps retrying (Mastra does not check between attempts) and returns its permit', async () => {
    const compiled = build([step('a', { retries: 2, retryDelayMs: 5 }), step('after')], 1);
    const { hand, pub, g1 } = await both(compiled, 'x', (controller, gauge) =>
      gaugedRunner(['a', 'after'], gauge, 1, 1, (_input, call) => {
        if (call.attempt === 0) controller.abort();
        return call.attempt < 2 ? { status: 'failed', error: `try ${call.attempt}` } : { status: 'success', output: 'ok' };
      }),
    );
    expect(hand.marking.tokenCount(compiled.budget!.permits)).toBe(1);
    expect(hand.outcome).toEqual(pub.outcome);
    expect(hand.outcome.status).toBe('canceled');
    expect('residue' in hand.outcome).toBe(false);
    expect(g1.trace.filter((t) => t.startsWith('enter:'))).toEqual(['enter:a#0', 'enter:a#1', 'enter:a#2']);
    expect(g1.peak).toBe(1);
  });
});

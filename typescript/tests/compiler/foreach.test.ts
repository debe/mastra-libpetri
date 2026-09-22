import { describe, expect, it } from 'vitest';
import { Transition, delayed, type Timing } from 'libpetri';
import { compile, type Gadget } from '../../src/compiler/index.js';
import { foreachGadget, itemsOf, MAX_FOREACH_LANES } from '../../src/compiler/gadgets/foreach.js';
import { runWorkflowDetailed, type RunReport } from '../../src/engine/index.js';
import type {
  CompiledWorkflow,
  EntryDescription,
  StepCall,
  StepDescription,
  StepOutcome,
} from '../../src/compiler/types.js';
import { RecordingRunner } from '../fixtures/runner.js';

/**
 * `.foreach`, run — against Mastra's `executeForeach` (`@mastra/core@1.67.0`,
 * `handlers/control-flow.ts:952-1495`, recovered from its sourcemaps):
 *
 * - `:1225`, `:1228-1272`: a fastq queue of width `concurrency`, items pushed in index order,
 *   admission fluid.
 * - `:1087-1090`, `:1141`, `:1217`: the first non-success item — failed, bailed, paused or
 *   suspended — kills the queue: nothing queued starts, in-flight items finish.
 * - `:1130`, `:1210`: the reported failure is the first **in time**.
 * - `:1136`, `:1373-1406`: a bail or pause is the foreach's result, first in time.
 * - `:1119-1124`, `:1411-1412`: a suspension reports the **lowest** suspended index.
 * - `:1315-1316`, `:1373`, `:1410`: precedence failed > bailed/paused > suspended > success.
 * - `:1189-1191`: `results[k] = output` only for a defined output — an `undefined` leaves a hole.
 * - `:1050`, `:1228`, `:1272`: no array check; `length` and `[k]` are read directly.
 * - `entry.ts:811-812`, `default.ts:1152-1153`: the aggregate is recorded under the **body** id.
 * - `utils.ts:786-796`: concurrency clamps to 1 when not a finite number >= 1, else floors.
 *
 * Every run asserts the outcome with `toEqual`, and `classify` adds a `residue` key whenever a
 * token is left anywhere, so each of these is also a stranded-token check.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Polls a condition; the deadline is a backstop, so a net that cannot get there fails instead of hanging. */
async function until(condition: () => boolean, graceMs = 2_000): Promise<void> {
  const deadline = Date.now() + graceMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached within the grace period');
    await sleep(1);
  }
}

const body = (extra: Omit<StepDescription, 'kind' | 'id'> = {}): StepDescription => ({ kind: 'step', id: 'body', ...extra });
const foreach = (concurrency: number, b: StepDescription = body()): EntryDescription => ({
  kind: 'foreach',
  id: 'items',
  body: b,
  concurrency,
});

function build(entries: readonly EntryDescription[], gadget?: Gadget): CompiledWorkflow {
  return compile({ id: 'batch', entries }, gadget ? { gadgets: { foreach: gadget } } : {});
}

type Plan = (label: string, call: StepCall) => StepOutcome | Promise<StepOutcome>;
const succeed: Plan = (label) => ({ status: 'success', output: `${label}!` });

/**
 * A runner whose `body` step follows `plan` per item and logs every item that starts and
 * finishes. Other steps echo their input, so a step before a foreach hands it the array intact.
 */
function itemRunner(plan: Plan = succeed) {
  const log = {
    trace: [] as string[],
    started: [] as string[],
    finished: [] as string[],
    inFlight: 0,
    maxInFlight: 0,
  };
  const runner = new RecordingRunner({
    steps: {
      body: async (input, call) => {
        const label = String(input);
        log.started.push(label);
        log.trace.push(`enter:${label}`);
        log.inFlight++;
        log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
        try {
          return await plan(label, call);
        } finally {
          log.inFlight--;
          log.finished.push(label);
          log.trace.push(`exit:${label}`);
        }
      },
    },
  });
  return { runner, log };
}

async function run(
  entries: readonly EntryDescription[],
  input: unknown,
  runner: RecordingRunner,
  gadget?: Gadget,
): Promise<RunReport> {
  return runWorkflowDetailed(build(entries, gadget), input, { runner, timeoutMs: 10_000 });
}

// -------------------------------------------------------------------------------------------
// Mutated copies, for the non-vacuity checks. The gadget is wrapped, never edited: the wrapper
// compiles the real foreach and rebuilds the named transitions with one safeguard removed.
// -------------------------------------------------------------------------------------------

interface Mutation {
  readonly transition: RegExp;
  readonly dropInhibitor?: RegExp;
  readonly dropReset?: RegExp;
  readonly dropInput?: RegExp;
  readonly timing?: Timing;
}

function rebuild(t: Transition, m: Mutation): Transition {
  const b = Transition.builder(t.name)
    .inputs(...t.inputSpecs.filter((spec) => !(m.dropInput?.test(spec.place.name) ?? false)))
    .outputs(t.outputSpec!)
    .timing(m.timing ?? t.timing)
    .priority(t.priority)
    .action(t.action);
  for (const arc of t.inhibitors) if (!(m.dropInhibitor?.test(arc.place.name) ?? false)) b.inhibitor(arc.place);
  for (const arc of t.reads) b.read(arc.place);
  for (const arc of t.resets) if (!(m.dropReset?.test(arc.place.name) ?? false)) b.reset(arc.place);
  return b.build();
}

function mutated(...mutations: Mutation[]): Gadget {
  return (entry, next, ctx) => {
    const result = foreachGadget(entry, next, ctx);
    let touched = 0;
    const transitions = result.transitions.map((t) =>
      mutations.reduce((acc, m) => {
        if (!m.transition.test(acc.name)) return acc;
        touched++;
        return rebuild(acc, m);
      }, t),
    );
    if (touched === 0) throw new Error('mutation matched no transition — the check would be vacuous');
    return { ...result, transitions };
  };
}

// ===========================================================================================

describe('foreach: dispatch and order', () => {
  it('runs items one at a time at concurrency 1, and records the array under the body id', async () => {
    const { runner, log } = itemRunner();
    const report = await run([foreach(1)], ['a', 'b', 'c'], runner);

    expect(log.trace).toEqual(['enter:a', 'exit:a', 'enter:b', 'exit:b', 'enter:c', 'exit:c']);
    expect(report.outcome).toEqual({ status: 'success', output: ['a!', 'b!', 'c!'] });
    // The leaf recorded each item under `body` as it ran; the aggregate is the last write.
    expect(report.stepResults.get('body')).toEqual({ status: 'success', output: ['a!', 'b!', 'c!'] });
  });

  it('admits fluidly: a freed lane takes the next item while its sibling is still running', async () => {
    const aMayFinish = deferred();
    const { runner, log } = itemRunner(async (label) => {
      if (label === 'a') await aMayFinish.promise;
      // `c` can only start once `b`'s lane is free — and it releases `a`, so the run completing
      // at all proves `c` started while `a` was still in flight.
      if (label === 'c') aMayFinish.resolve();
      return { status: 'success', output: `${label}!` };
    });
    const report = await run([foreach(2)], ['a', 'b', 'c'], runner);

    expect(log.trace.indexOf('enter:c')).toBeLessThan(log.trace.indexOf('exit:a'));
    expect(report.outcome).toEqual({ status: 'success', output: ['a!', 'b!', 'c!'] });
  });

  it('never has more items in flight than the concurrency', async () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const { runner, log } = itemRunner(async (label) => {
      // Hold each item until three are inside or every item has started: reaching the end at all
      // is the overlap, and `maxInFlight` is the cap.
      await until(() => log.inFlight >= 3 || log.started.length === items.length);
      return { status: 'success', output: `${label}!` };
    });
    const report = await run([foreach(3)], items, runner);

    expect(log.maxInFlight).toBe(3);
    expect(report.outcome).toEqual({ status: 'success', output: items.map((i) => `${i}!`) });
  });

  it('keeps input order when items finish in reverse', async () => {
    const finished = new Map([['quick', deferred()], ['medium', deferred()], ['slow', deferred()]]);
    const { runner, log } = itemRunner(async (label) => {
      await until(() => log.started.length === 3);
      if (label === 'medium') await finished.get('quick')!.promise;
      if (label === 'slow') await finished.get('medium')!.promise;
      finished.get(label)!.resolve();
      return { status: 'success', output: `${label}!` };
    });
    const report = await run([foreach(3)], ['slow', 'medium', 'quick'], runner);

    expect(log.finished).toEqual(['quick', 'medium', 'slow']);
    expect(report.outcome).toEqual({ status: 'success', output: ['slow!', 'medium!', 'quick!'] });
  });

  it('leaves a hole where an item produced undefined, as results[k] = output does', async () => {
    const { runner } = itemRunner((label) => ({ status: 'success', output: label === 'b' ? undefined : `${label}!` }));

    const middle = await run([foreach(1)], ['a', 'b', 'c'], runner);
    const output = (middle.outcome as { output: unknown[] }).output;
    expect(output).toHaveLength(3);
    expect(1 in output).toBe(false);
    expect(output[0]).toBe('a!');
    expect(output[2]).toBe('c!');

    // A trailing `undefined` shortens the array: its length is one past the last defined index.
    const trailing = await run([foreach(1)], ['a', 'b'], runner);
    expect(trailing.outcome).toEqual({ status: 'success', output: ['a!'] });
    expect((trailing.outcome as { output: unknown[] }).output).toHaveLength(1);
  });

  it('succeeds with [] on an empty array without running the body', async () => {
    const { runner } = itemRunner();
    const report = await run([foreach(3)], [], runner);

    expect(runner.calls).toEqual([]);
    expect(report.outcome).toEqual({ status: 'success', output: [] });
    expect(report.stepResults.get('body')).toEqual({ status: 'success', output: [] });
  });

  it('hands the array to the entry after it, and runs nothing after a failure', async () => {
    const entries: EntryDescription[] = [{ kind: 'step', id: 'before' }, foreach(2), { kind: 'step', id: 'after' }];

    const ok = itemRunner();
    const passed = await run(entries, ['a', 'b', 'c'], ok.runner);
    expect(passed.outcome).toEqual({ status: 'success', output: ['a!', 'b!', 'c!'] });
    expect(ok.runner.calls.filter((c) => c !== 'body')).toEqual(['before', 'after']);

    const bad = itemRunner((label) =>
      label === 'b' ? { status: 'failed', error: 'boom:b' } : { status: 'success', output: `${label}!` },
    );
    const failed = await run(entries, ['a', 'b', 'c'], bad.runner);
    expect(failed.outcome).toEqual({ status: 'failed', stepId: 'body', error: 'boom:b' });
    expect(bad.runner.calls).not.toContain('after');
  });
});

describe('foreach: input that is not an array (row 22)', () => {
  it('iterates a string by UTF-16 code unit, as prevOutput[k] does', async () => {
    const { runner } = itemRunner();
    const report = await run([foreach(2)], 'abc', runner);
    expect(report.outcome).toEqual({ status: 'success', output: ['a!', 'b!', 'c!'] });
  });

  it('iterates an array-like by its length', async () => {
    const { runner } = itemRunner();
    const report = await run([foreach(1)], { length: 2, 0: 'x', 1: 'y' }, runner);
    expect(report.outcome).toEqual({ status: 'success', output: ['x!', 'y!'] });
  });

  it.each([
    ['a plain object', { a: 1 }],
    ['a number', 42],
    ['a boolean', true],
    ['a NaN length', { length: 'many' }],
  ])('succeeds with [] on %s, whose length is not a positive number', async (_what, input) => {
    const { runner } = itemRunner();
    const report = await run([foreach(2)], input, runner);
    expect(runner.calls).toEqual([]);
    expect(report.outcome).toEqual({ status: 'success', output: [] });
  });

  it.each([
    ['null', null, TypeError],
    ['undefined', undefined, TypeError],
    ['an infinite length', { length: Infinity }, RangeError],
  ])('fails on %s, where Mastra rejects the run or never finishes', async (_what, input, kind) => {
    const { runner } = itemRunner();
    const report = await run([foreach(2)], input, runner);

    expect(runner.calls).toEqual([]);
    expect(report.outcome).toEqual({ status: 'failed', stepId: 'body', error: expect.any(kind) });
    expect(report.stepResults.get('body')).toEqual({ status: 'failed', error: expect.any(kind) });
  });

  it('reads items exactly as the for-loop does', () => {
    expect(itemsOf('i', [1, , 3])).toEqual([1, undefined, 3]);
    expect(itemsOf('i', { length: 2.5, 0: 'a' })).toEqual(['a', undefined, undefined]);
    expect(itemsOf('i', { length: '2', 0: 'a', 1: 'b' })).toEqual(['a', 'b']);
    expect(itemsOf('i', { length: -1 })).toEqual([]);
    expect(() => itemsOf('i', { length: Symbol('n') })).toThrow(TypeError);
  });
});

describe('foreach: fail-fast (row 18)', () => {
  it('starts no item after a failure at concurrency 1', async () => {
    const { runner, log } = itemRunner((label) =>
      label === 'a' ? { status: 'failed', error: 'boom:a' } : { status: 'success', output: `${label}!` },
    );
    const report = await run([foreach(1)], ['a', 'b', 'c'], runner);

    expect(runner.calls).toEqual(['body']);
    expect(log.started).toEqual(['a']);
    expect(report.outcome).toEqual({ status: 'failed', stepId: 'body', error: 'boom:a' });
    expect(report.stepResults.get('body')).toEqual({ status: 'failed', error: 'boom:a' });
  });

  it('stops after a later failure too, having run everything before it', async () => {
    const { runner, log } = itemRunner((label) =>
      label === 'b' ? { status: 'failed', error: 'boom:b' } : { status: 'success', output: `${label}!` },
    );
    const report = await run([foreach(1)], ['a', 'b', 'c', 'd'], runner);

    expect(log.started).toEqual(['a', 'b']);
    expect(report.outcome).toEqual({ status: 'failed', stepId: 'body', error: 'boom:b' });
  });

  it('lets in-flight items finish and starts none of the queued ones at concurrency 3', async () => {
    let failedAt = 0;
    const { runner, log } = itemRunner(async (label) => {
      await until(() => log.started.length >= 3);
      if (label === 'a') {
        failedAt = Date.now();
        return { status: 'failed', error: 'boom:a' };
      }
      // `b` and `c` are still running when `a`'s failure lands, and finish well after it.
      await until(() => failedAt > 0);
      await sleep(20);
      return { status: 'success', output: `${label}!` };
    });
    const report = await run([foreach(3)], ['a', 'b', 'c', 'd', 'e', 'f'], runner);

    expect(log.started).toEqual(['a', 'b', 'c']);
    expect([...log.finished].sort()).toEqual(['a', 'b', 'c']);
    expect(runner.calls).toHaveLength(3);
    expect(report.outcome).toEqual({ status: 'failed', stepId: 'body', error: 'boom:a' });
    expect(report.stepResults.get('body')).toEqual({ status: 'failed', error: 'boom:a' });
  });

  it('reports the first failure in time, not the lowest index', async () => {
    const { runner, log } = itemRunner(async (label) => {
      await until(() => log.started.length >= 3);
      if (label === 'c') return { status: 'failed', error: 'boom:c' };
      await until(() => log.finished.includes('c'));
      await sleep(5);
      return label === 'a' ? { status: 'failed', error: 'boom:a' } : { status: 'success', output: `${label}!` };
    });
    const report = await run([foreach(3)], ['a', 'b', 'c'], runner);

    // `.parallel()` would say `a` here (lowest arm index); a foreach keeps the first to settle.
    expect(report.outcome).toEqual({ status: 'failed', stepId: 'body', error: 'boom:c' });
  });

  it('ends as tripwire when the failing item carries one, and stops dispatch', async () => {
    const { runner, log } = itemRunner((label) =>
      label === 'a'
        ? { status: 'failed', error: new Error('blocked'), tripwire: { reason: 'policy' } }
        : { status: 'success', output: `${label}!` },
    );
    const report = await run([foreach(1)], ['a', 'b'], runner);

    expect(log.started).toEqual(['a']);
    expect(report.outcome).toEqual({ status: 'tripwire', stepId: 'body', tripwire: { reason: 'policy' } });
  });

  it('treats a throwing runner as a failed item', async () => {
    const { runner, log } = itemRunner((label) => {
      if (label === 'a') throw new Error('crashed');
      return { status: 'success', output: `${label}!` };
    });
    const report = await run([foreach(1)], ['a', 'b'], runner);

    expect(log.started).toEqual(['a']);
    expect(report.outcome).toEqual({ status: 'failed', stepId: 'body', error: new Error('crashed') });
  });

  it('retries an item inside its own lane before anything counts as a failure', async () => {
    const { runner, log } = itemRunner((label, call) =>
      label === 'a' && call.attempt === 0
        ? { status: 'failed', error: 'flaky' }
        : { status: 'success', output: `${label}!` },
    );
    const report = await run([foreach(1, body({ retries: 1 }))], ['a', 'b'], runner);

    expect(runner.attempts).toEqual([
      { stepId: 'body', attempt: 0 },
      { stepId: 'body', attempt: 1 },
      { stepId: 'body', attempt: 0 },
    ]);
    expect(log.started).toEqual(['a', 'a', 'b']);
    expect(report.outcome).toEqual({ status: 'success', output: ['a!', 'b!'] });
  });

  it('fails fast on a non-retryable failure without spending the retries', async () => {
    const { runner, log } = itemRunner((label) =>
      label === 'a' ? { status: 'failed', error: 'fatal', nonRetryable: true } : { status: 'success', output: `${label}!` },
    );
    const report = await run([foreach(1, body({ retries: 3 }))], ['a', 'b'], runner);

    expect(log.started).toEqual(['a']);
    expect(report.outcome).toEqual({ status: 'failed', stepId: 'body', error: 'fatal' });
  });
});

describe('foreach: bail, pause and suspend', () => {
  it('ends the run as a success carrying the bail output, and stops dispatch', async () => {
    const { runner, log } = itemRunner((label) =>
      label === 'b' ? { status: 'bailed', output: 'early' } : { status: 'success', output: `${label}!` },
    );
    const report = await run([foreach(1)], ['a', 'b', 'c'], runner);

    expect(log.started).toEqual(['a', 'b']);
    expect(report.outcome).toEqual({ status: 'success', output: 'early', bailed: true });
    // Rewritten to 'success' when the bail ends the run, as Mastra rewrites the object its
    // stepResults holds (`default.ts:926-928`).
    expect(report.stepResults.get('body')).toEqual({ status: 'success', output: 'early' });
  });

  it('pauses at the foreach path when a nested workflow item pauses', async () => {
    const { runner, log } = itemRunner((label) =>
      label === 'a' ? { status: 'paused' } : { status: 'success', output: `${label}!` },
    );
    const report = await run([{ kind: 'step', id: 'before' }, foreach(1, body({ source: 'workflow' }))], ['a', 'b'], runner);

    expect(log.started).toEqual(['a']);
    // Mastra runs each item at the foreach's own execution path, so [1], not the lane's [1, 0].
    expect(report.outcome).toEqual({ status: 'paused', stepId: 'body', path: [1] });
    expect(report.stepResults.get('body')).toEqual({ status: 'paused' });
  });

  it('takes the first bail or pause in time', async () => {
    // `a` pauses and `b` bails; `first` settles, then the other one.
    const race = (first: string) => {
      const r = itemRunner(async (label) => {
        await until(() => r.log.started.length >= 2);
        if (label !== first) {
          await until(() => r.log.finished.includes(first));
          await sleep(5);
        }
        return label === 'a' ? { status: 'paused' } : { status: 'bailed', output: 'bail:b' };
      });
      return r;
    };

    const pauseFirst = race('a');
    const paused = await run([foreach(2)], ['a', 'b'], pauseFirst.runner);
    expect(paused.outcome).toEqual({ status: 'paused', stepId: 'body', path: [0] });

    const bailFirst = race('b');
    const bailed = await run([foreach(2)], ['a', 'b'], bailFirst.runner);
    expect(bailed.outcome).toEqual({ status: 'success', output: 'bail:b', bailed: true });
  });

  it('lets a failure outrank a bail that happened first', async () => {
    const { runner, log } = itemRunner(async (label) => {
      await until(() => log.started.length >= 2);
      if (label === 'a') return { status: 'bailed', output: 'early' };
      await until(() => log.finished.includes('a'));
      await sleep(5);
      return { status: 'failed', error: 'boom:b' };
    });
    const report = await run([foreach(2)], ['a', 'b'], runner);

    expect(report.outcome).toEqual({ status: 'failed', stepId: 'body', error: 'boom:b' });
    expect(report.stepResults.get('body')).toEqual({ status: 'failed', error: 'boom:b' });
  });

  it('lets a bail outrank a suspension that happened first', async () => {
    const { runner, log } = itemRunner(async (label) => {
      await until(() => log.started.length >= 2);
      if (label === 'a') return { status: 'suspended', payload: { ask: 'a' } };
      await until(() => log.finished.includes('a'));
      await sleep(5);
      return { status: 'bailed', output: 'early' };
    });
    const report = await run([foreach(2)], ['a', 'b'], runner);

    expect(report.outcome).toEqual({ status: 'success', output: 'early', bailed: true });
  });

  it('suspends at the lowest suspended index, whatever order they suspended in', async () => {
    const { runner, log } = itemRunner(async (label) => {
      await until(() => log.started.length >= 3);
      if (label === 'c') return { status: 'suspended', payload: { ask: 'c' } };
      await until(() => log.finished.includes('c'));
      await sleep(5);
      return label === 'a'
        ? { status: 'suspended', payload: { ask: 'a' }, output: 'partial' }
        : { status: 'success', output: `${label}!` };
    });
    const report = await run([foreach(3)], ['a', 'b', 'c'], runner);

    expect(report.outcome).toEqual({ status: 'suspended', stepId: 'body', path: [0], payload: { ask: 'a' } });
    // Mastra's per-index record keeps no `suspendOutput`, so the foreach's suspension has none.
    expect(report.stepResults.get('body')).toEqual({ status: 'suspended', payload: { ask: 'a' } });
  });

  it('stops dispatch on a suspension too', async () => {
    const { runner, log } = itemRunner((label) =>
      label === 'a' ? { status: 'suspended', payload: 'wait' } : { status: 'success', output: `${label}!` },
    );
    const report = await run([foreach(1)], ['a', 'b', 'c'], runner);

    expect(log.started).toEqual(['a']);
    expect(report.outcome).toEqual({ status: 'suspended', stepId: 'body', path: [0], payload: 'wait' });
  });
});

describe('foreach: structure', () => {
  const lanesOf = (compiled: CompiledWorkflow): number =>
    [...compiled.net.places].filter((p) => /^s\.0\.items\.lane\d+\.permit$/.test(p.name)).length;

  it.each([
    [1, 1],
    [3, 3],
    [2.9, 2],
    [0, 1],
    [-2, 1],
    [0.5, 1],
    [Number.NaN, 1],
    [Infinity, 1],
  ])('clamps concurrency %s to %s lanes, as resolveForeachConcurrency does', (concurrency, lanes) => {
    expect(lanesOf(build([foreach(concurrency)]))).toBe(lanes);
  });

  it('refuses more lanes than it can compile', () => {
    expect(lanesOf(build([foreach(MAX_FOREACH_LANES)]))).toBe(MAX_FOREACH_LANES);
    expect(() => build([foreach(MAX_FOREACH_LANES + 1)])).toThrow(/lane limit/);
  });

  it('instantiates the body once per lane', () => {
    const runs = [...build([foreach(3)]).net.transitions]
      .map((t) => t.name)
      .filter((name) => name.endsWith('.body.run'))
      .sort();
    expect(runs).toEqual(['t.0-0.body.run', 't.0-1.body.run', 't.0-2.body.run']);
  });

  it('cannot be given a combinator as its body', () => {
    const nested = { kind: 'foreach', id: 'inner', body: body(), concurrency: 1 };
    // @ts-expect-error — a foreach body is a single step, as Mastra's SingleStepEntry is.
    const typed: EntryDescription = { kind: 'foreach', id: 'items', body: nested, concurrency: 2 };
    expect(() => build([typed])).toThrow(/body must be a single step/);
  });

  it('inhibits every start on every other lane’s non-success outcome, and kills the queue on each settle', () => {
    const lanes = [0, 1, 2];
    const transitions = [...build([foreach(lanes.length)]).net.transitions];
    const outcomesOf = (l: number): string[] =>
      ['failed', 'bailed', 'suspended', 'paused'].map((o) => `s.0.items.lane${l}.${o}`);

    for (const lane of lanes) {
      const start = transitions.find((t) => t.name === `t.0.items.lane${lane}.start`)!;
      // Its own lane needs no arc: while that outcome is pending the lane holds a slot, not a permit.
      const others = lanes.filter((l) => l !== lane).flatMap(outcomesOf);
      expect(start.inhibitors.map((a) => a.place.name).sort()).toEqual(others.sort());
    }
    const settles = transitions.filter((t) => /\.lane\d+\.(fail|bail|pause|suspend)$/.test(t.name));
    expect(settles).toHaveLength(4 * lanes.length);
    for (const settle of settles) expect(settle.resets.map((a) => a.place.name)).toEqual(['s.0.items.cursor']);
  });
});

describe('foreach: each safeguard is load-bearing (mutated copies)', () => {
  const failA: Plan = (label) =>
    label === 'a' ? { status: 'failed', error: 'boom:a' } : { status: 'success', output: `${label}!` };

  it('without the reset on the cursor, items after a failure run', async () => {
    const intact = itemRunner(failA);
    await run([foreach(1)], ['a', 'b', 'c'], intact.runner);
    expect(intact.log.started).toEqual(['a']);

    const broken = itemRunner(failA);
    await run([foreach(1)], ['a', 'b', 'c'], broken.runner, mutated({ transition: /\.lane\d+\.fail$/, dropReset: /cursor/ }));
    expect(broken.log.started).toEqual(['a', 'b', 'c']);
  });

  it('without the start inhibitors, an item starts in the window before a failure is recorded', async () => {
    // The window is ordinarily one firing wide. Widening it — delaying the failure's settle by
    // 50ms in both copies — makes it observable: `b` finishes inside it and frees its lane.
    const slowSettle: Mutation = { transition: /\.lane\d+\.fail$/, timing: delayed(50) };
    const plan: Plan = async (label) => {
      if (label === 'a') return { status: 'failed', error: 'boom:a' };
      await sleep(10);
      return { status: 'success', output: `${label}!` };
    };

    const intact = itemRunner(plan);
    const kept = await run([foreach(2)], ['a', 'b', 'c'], intact.runner, mutated(slowSettle));
    expect(intact.log.started).toEqual(['a', 'b']);
    expect(kept.outcome).toEqual({ status: 'failed', stepId: 'body', error: 'boom:a' });

    const broken = itemRunner(plan);
    await run(
      [foreach(2)],
      ['a', 'b', 'c'],
      broken.runner,
      mutated(slowSettle, { transition: /\.lane\d+\.start$/, dropInhibitor: /./ }),
    );
    expect(broken.log.started).toEqual(['a', 'b', 'c']);
  });

  it('without waiting for every lane, the failure is decided under a running item and a token strands', async () => {
    const plan: Plan = async (label) => {
      if (label === 'a') return { status: 'failed', error: 'boom:a' };
      await sleep(20);
      return { status: 'success', output: `${label}!` };
    };

    const intact = itemRunner(plan);
    const kept = await run([foreach(2)], ['a', 'b'], intact.runner);
    expect(kept.outcome).toEqual({ status: 'failed', stepId: 'body', error: 'boom:a' });

    const broken = itemRunner(plan);
    const lost = await run([foreach(2)], ['a', 'b'], broken.runner, mutated({ transition: /\.items\.fail$/, dropInput: /permit/ }));
    expect(lost.outcome).toMatchObject({ status: 'failed', residue: expect.any(Array) });
  });
});

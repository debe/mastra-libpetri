import { describe, expect, it } from 'vitest';
import { Transition, delayed, one, outPlace, place, type Place, type Timing } from 'libpetri';
import { compile, type Gadget } from '../../src/compiler/index.js';
import { foreachGadget, itemsOf, MAX_FOREACH_LANES } from '../../src/compiler/gadgets/foreach.js';
import { runWorkflowDetailed, type RunReport } from '../../src/engine/index.js';
import type {
  CanceledToken,
  CompiledWorkflow,
  EntryDescription,
  Exits,
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
  signal?: AbortSignal,
): Promise<RunReport> {
  return runWorkflowDetailed(build(entries, gadget), input, { runner, timeoutMs: 10_000, ...(signal ? { signal } : {}) });
}

/**
 * Observes what the foreach puts on one of its exits, without changing what happens next: the
 * real gadget is compiled with a local place in that exit's stead, and one forwarding transition
 * copies each token to the real exit. `RunOutcome` does not carry a canceled foreach's partial
 * array or a failure's `nonRetryable`, and this is how a test reads them.
 */
function tapped<K extends keyof Exits>(which: K, inner: Gadget = foreachGadget) {
  const seen: unknown[] = [];
  const gadget: Gadget = (entry, next, ctx) => {
    const tap = place(ctx.names.reserve(`test.tap.${which}`, 'test observation tap')) as Exits[K];
    const result = inner(entry, next, { ...ctx, exits: { ...ctx.exits, [which]: tap } });
    const forward = Transition.builder(`test.tap.${which}.forward`)
      .inputs(one(tap as Place<unknown>))
      .outputs(outPlace(ctx.exits[which] as Place<unknown>))
      .action(async (tctx) => {
        const token = tctx.input(tap as Place<unknown>);
        seen.push(token);
        tctx.output(ctx.exits[which] as Place<unknown>, token);
      })
      .build();
    return { ...result, transitions: [...result.transitions, forward] };
  };
  return { gadget, seen };
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
    // The leaf recorded each item under `body` as it ran; the aggregate is the last write, and it
    // is Mastra's `{...stepInfo, status, output, endedAt}`: the foreach's input as payload, no metadata.
    const record = report.stepResults.get('body')!;
    expect(record).toMatchObject({ status: 'success', output: ['a!', 'b!', 'c!'], payload: ['a', 'b', 'c'] });
    expect(typeof record.startedAt).toBe('number');
    expect(typeof record.endedAt).toBe('number');
    expect(record.metadata).toBeUndefined();
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
    expect(report.stepResults.get('body')).toMatchObject({ status: 'success', output: [], payload: [] });
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
    expect(failed.outcome).toEqual({ status: 'failed', stepId: 'body', path: [1], foreachIndex: 1, error: 'boom:b' });
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
    expect(report.outcome).toEqual({ status: 'failed', stepId: 'body', path: [0], error: expect.any(kind) });
    expect(report.stepResults.get('body')).toMatchObject({ status: 'failed', error: expect.any(kind), payload: input });
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
    expect(report.outcome).toEqual({ status: 'failed', stepId: 'body', path: [0], foreachIndex: 0, error: 'boom:a' });
    // The failing item's own result, as `{...finalErrorResult}` is (`:1360-1369`): its payload is the item.
    expect(report.stepResults.get('body')).toMatchObject({ status: 'failed', error: 'boom:a', payload: 'a', metadata: { foreachIndex: 0 } });
  });

  it('stops after a later failure too, having run everything before it', async () => {
    const { runner, log } = itemRunner((label) =>
      label === 'b' ? { status: 'failed', error: 'boom:b' } : { status: 'success', output: `${label}!` },
    );
    const report = await run([foreach(1)], ['a', 'b', 'c', 'd'], runner);

    expect(log.started).toEqual(['a', 'b']);
    expect(report.outcome).toEqual({ status: 'failed', stepId: 'body', path: [0], foreachIndex: 1, error: 'boom:b' });
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
    expect(report.outcome).toEqual({ status: 'failed', stepId: 'body', path: [0], foreachIndex: 0, error: 'boom:a' });
    // `b` and `c` finished after `a` and their leaf wrote over `body`; the aggregate is still `a`'s.
    expect(report.stepResults.get('body')).toMatchObject({ status: 'failed', error: 'boom:a', payload: 'a', metadata: { foreachIndex: 0 } });
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
    expect(report.outcome).toEqual({ status: 'failed', stepId: 'body', path: [0], foreachIndex: 2, error: 'boom:c' });
  });

  it('ends as tripwire when the failing item carries one, and stops dispatch', async () => {
    const { runner, log } = itemRunner((label) =>
      label === 'a'
        ? { status: 'failed', error: new Error('blocked'), tripwire: { reason: 'policy' } }
        : { status: 'success', output: `${label}!` },
    );
    const report = await run([foreach(1)], ['a', 'b'], runner);

    expect(log.started).toEqual(['a']);
    // The outcome carries the failure's `error` beside the tripwire (contract change).
    expect(report.outcome).toEqual({
      status: 'tripwire',
      stepId: 'body',
      path: [0],
      foreachIndex: 0,
      tripwire: { reason: 'policy' },
      error: expect.objectContaining({ message: 'blocked' }),
    });
  });

  it('treats a throwing runner as a failed item', async () => {
    const { runner, log } = itemRunner((label) => {
      if (label === 'a') throw new Error('crashed');
      return { status: 'success', output: `${label}!` };
    });
    const report = await run([foreach(1)], ['a', 'b'], runner);

    expect(log.started).toEqual(['a']);
    expect(report.outcome).toEqual({ status: 'failed', stepId: 'body', path: [0], foreachIndex: 0, error: new Error('crashed') });
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
    expect(report.outcome).toEqual({ status: 'failed', stepId: 'body', path: [0], foreachIndex: 0, error: 'fatal' });
  });
});

describe('foreach: bail, pause and suspend', () => {
  it('ends the run as a success carrying the bail output, and stops dispatch', async () => {
    const { runner, log } = itemRunner((label) =>
      label === 'b' ? { status: 'bailed', output: 'early' } : { status: 'success', output: `${label}!` },
    );
    const report = await run([foreach(1)], ['a', 'b', 'c'], runner);

    expect(log.started).toEqual(['a', 'b']);
    // A bail names its origin (contract change): the body, at the foreach's path, item 1.
    expect(report.outcome).toEqual({ status: 'success', output: 'early', bailed: true, stepId: 'body', path: [0], foreachIndex: 1 });
    // Rewritten to 'success' when the bail ends the run, as Mastra rewrites the object its
    // stepResults holds (`default.ts:926-928`).
    expect(report.stepResults.get('body')).toMatchObject({ status: 'success', output: 'early', payload: 'b', metadata: { foreachIndex: 1 } });
  });

  it('pauses at the foreach path when a nested workflow item pauses', async () => {
    const { runner, log } = itemRunner((label) =>
      label === 'a' ? { status: 'paused' } : { status: 'success', output: `${label}!` },
    );
    const report = await run([{ kind: 'step', id: 'before' }, foreach(1, body({ source: 'workflow' }))], ['a', 'b'], runner);

    expect(log.started).toEqual(['a']);
    // Mastra runs each item at the foreach's own execution path, so [1], not the lane's [1, 0].
    expect(report.outcome).toEqual({ status: 'paused', stepId: 'body', path: [1], foreachIndex: 0 });
    // Mastra's paused item result is `{...stepInfo, status}` — no `endedAt` (`handlers/step.ts:525`).
    const record = report.stepResults.get('body')!;
    expect(record).toMatchObject({ status: 'paused', payload: 'a', metadata: { foreachIndex: 0 } });
    expect(record.endedAt).toBeUndefined();
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
    expect(paused.outcome).toEqual({ status: 'paused', stepId: 'body', path: [0], foreachIndex: 0 });

    const bailFirst = race('b');
    const bailed = await run([foreach(2)], ['a', 'b'], bailFirst.runner);
    expect(bailed.outcome).toEqual({ status: 'success', output: 'bail:b', bailed: true, stepId: 'body', path: [0], foreachIndex: 1 });
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

    expect(report.outcome).toEqual({ status: 'failed', stepId: 'body', path: [0], foreachIndex: 1, error: 'boom:b' });
    expect(report.stepResults.get('body')).toMatchObject({ status: 'failed', error: 'boom:b', payload: 'b' });
  });

  it('lets a bail outrank a suspension that happened first', async () => {
    const { runner, log } = itemRunner(async (label) => {
      await until(() => log.started.length >= 2);
      if (label === 'a') return { status: 'suspended', suspendPayload: { ask: 'a' } };
      await until(() => log.finished.includes('a'));
      await sleep(5);
      return { status: 'bailed', output: 'early' };
    });
    const report = await run([foreach(2)], ['a', 'b'], runner);

    expect(report.outcome).toEqual({ status: 'success', output: 'early', bailed: true, stepId: 'body', path: [0], foreachIndex: 1 });
  });

  it('suspends at the lowest suspended index, whatever order they suspended in', async () => {
    const { runner, log } = itemRunner(async (label) => {
      await until(() => log.started.length >= 3);
      if (label === 'c') return { status: 'suspended', suspendPayload: { ask: 'c' } };
      await until(() => log.finished.includes('c'));
      await sleep(5);
      return label === 'a'
        ? { status: 'suspended', suspendPayload: { ask: 'a' }, suspendOutput: 'partial' }
        : { status: 'success', output: `${label}!` };
    });
    const report = await run([foreach(3)], ['a', 'b', 'c'], runner);

    expect(report.outcome).toEqual({ status: 'suspended', stepId: 'body', path: [0], foreachIndex: 0, payload: { ask: 'a' } });
    // `{...stepInfo, suspendedAt, status, suspendPayload}` (`:1432-1450`): the foreach's input and
    // start, the lowest item's suspend payload, `suspendedAt`, and no `endedAt`. No `suspendOutput`
    // either — Mastra reads it from `foreachIndexObj`, which never stores one (`:1119-1124`).
    const record = report.stepResults.get('body')!;
    expect(record).toMatchObject({ status: 'suspended', payload: ['a', 'b', 'c'], suspendPayload: { ask: 'a' } });
    expect(typeof record.startedAt).toBe('number');
    expect(typeof record.suspendedAt).toBe('number');
    expect(record.endedAt).toBeUndefined();
    expect('suspendOutput' in record).toBe(false);
  });

  it('stops dispatch on a suspension too', async () => {
    const { runner, log } = itemRunner((label) =>
      label === 'a' ? { status: 'suspended', suspendPayload: 'wait' } : { status: 'success', output: `${label}!` },
    );
    const report = await run([foreach(1)], ['a', 'b', 'c'], runner);

    expect(log.started).toEqual(['a']);
    expect(report.outcome).toEqual({ status: 'suspended', stepId: 'body', path: [0], foreachIndex: 0, payload: 'wait' });
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
      // Plus the signal: Mastra's worker checks it before each task (`:1160`).
      const others = [...lanes.filter((l) => l !== lane).flatMap(outcomesOf), 'wf.cancel'];
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
    expect(kept.outcome).toEqual({ status: 'failed', stepId: 'body', path: [0], foreachIndex: 0, error: 'boom:a' });

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
    expect(kept.outcome).toEqual({ status: 'failed', stepId: 'body', path: [0], foreachIndex: 0, error: 'boom:a' });

    const broken = itemRunner(plan);
    const lost = await run([foreach(2)], ['a', 'b'], broken.runner, mutated({ transition: /\.items\.fail$/, dropInput: /permit/ }));
    expect(lost.outcome).toMatchObject({ status: 'failed', residue: expect.any(Array) });
  });
});

describe('foreach: per-item context (row 32)', () => {
  it('runs every item at the foreach\'s own path, told apart by foreachIndex', async () => {
    const calls: { path: readonly number[]; foreachIndex: number | undefined; input: unknown }[] = [];
    const { runner } = itemRunner((label, call) => {
      calls.push({ path: call.path, foreachIndex: call.foreachIndex, input: label });
      return { status: 'success', output: `${label}!` };
    });
    const report = await run([{ kind: 'step', id: 'before' }, foreach(3)], ['a', 'b', 'c', 'd'], runner);

    expect(report.outcome).toEqual({ status: 'success', output: ['a!', 'b!', 'c!', 'd!'] });
    // Mastra: `executionContext: { ...executionContext, foreachIndex: k }` (`:1101`) — the path is
    // the foreach's, whichever lane the net ran the item in.
    expect([...calls].sort((x, y) => x.foreachIndex! - y.foreachIndex!)).toEqual([
      { path: [1], foreachIndex: 0, input: 'a' },
      { path: [1], foreachIndex: 1, input: 'b' },
      { path: [1], foreachIndex: 2, input: 'c' },
      { path: [1], foreachIndex: 3, input: 'd' },
    ]);
  });

  it('places results by foreachIndex when items finish out of order', async () => {
    const { runner, log } = itemRunner(async (_label, call) => {
      await until(() => log.started.length === 3);
      await sleep(5 * (3 - call.foreachIndex!));
      return { status: 'success', output: call.foreachIndex };
    });
    const report = await run([foreach(3)], ['x', 'y', 'z'], runner);
    expect(log.finished).toEqual(['z', 'y', 'x']);
    expect(report.outcome).toEqual({ status: 'success', output: [0, 1, 2] });
  });

  it('reports the foreach\'s path and the item\'s index on a suspension', async () => {
    const s = tapped('suspended');
    const { runner } = itemRunner((label) =>
      label === 'b' ? { status: 'suspended', suspendPayload: 'wait' } : { status: 'success', output: `${label}!` },
    );
    const report = await run([{ kind: 'step', id: 'before' }, foreach(1)], ['a', 'b', 'c'], runner, s.gadget);
    expect(report.outcome).toEqual({ status: 'suspended', stepId: 'body', path: [1], foreachIndex: 1, payload: 'wait' });
    expect(s.seen).toEqual([{ stepId: 'body', path: [1], foreachIndex: 1, payload: 'wait' }]);
  });
});

describe('foreach: nonRetryable on the aggregate failure (row 36)', () => {
  it('keeps nonRetryable on the failure and on the record, as {...finalErrorResult} does', async () => {
    const f = tapped('failed');
    const { runner, log } = itemRunner(async (label) => {
      await until(() => log.started.length >= 2);
      if (label === 'a') return { status: 'failed', error: 'fatal', nonRetryable: true };
      // `b` finishes after `a` failed, and its leaf writes a success over `body`.
      await until(() => log.finished.includes('a'));
      await sleep(10);
      return { status: 'success', output: 'b!' };
    });
    const report = await run([foreach(2, body({ retries: 3 }))], ['a', 'b'], runner, f.gadget);

    expect(runner.attempts.filter((a) => a.attempt > 0)).toEqual([]);
    expect(report.outcome).toEqual({ status: 'failed', stepId: 'body', path: [0], foreachIndex: 0, error: 'fatal' });
    expect(f.seen).toEqual([{ stepId: 'body', path: [0], foreachIndex: 0, error: 'fatal', nonRetryable: true }]);
    expect(report.stepResults.get('body')).toMatchObject({
      status: 'failed',
      error: 'fatal',
      nonRetryable: true,
      payload: 'a',
      metadata: { foreachIndex: 0 },
    });
  });

  it('keeps a retryable failure retryable', async () => {
    const f = tapped('failed');
    const { runner } = itemRunner(() => ({ status: 'failed', error: 'plain' }));
    await run([foreach(1)], ['a'], runner, f.gadget);
    expect(f.seen).toEqual([{ stepId: 'body', path: [0], foreachIndex: 0, error: 'plain' }]);
    expect('nonRetryable' in (f.seen[0] as object)).toBe(false);
  });
});

describe('foreach: cancellation (row 28)', () => {
  const origin = { stepId: 'body', path: [0] };
  // The cancel finisher reports a foreach that had opened (`started: true`); the sweep on the
  // foreach's input, one that never did (`started: false`).
  const canceledAt0 = { status: 'canceled', origin, started: true } as const;
  const canceledBeforeAt0 = { status: 'canceled', origin, started: false } as const;

  /** `{...stepInfo, status: 'canceled', output: results, endedAt}` (`:1164-1169`, `:1298-1312`). */
  const expectCanceledRecord = (report: RunReport, payload: unknown, output: unknown[]): void => {
    const record = report.stepResults.get('body')!;
    expect(record).toMatchObject({ status: 'canceled', payload });
    expect(record.status === 'canceled' ? record.output : 'not canceled').toEqual(output);
    expect(typeof record.startedAt).toBe('number');
    expect(typeof record.endedAt).toBe('number');
    expect(record.metadata).toBeUndefined();
  };

  /** A `before` step that aborts the run and passes its input on; `body` follows `plan`. */
  const abortingBefore = (ac: AbortController, plan: Plan = succeed) =>
    new RecordingRunner({
      steps: {
        before: (x) => {
          ac.abort();
          return { status: 'success', output: x };
        },
        body: (input, call) => plan(String(input), call),
      },
    });

  it('cancels before any dispatch when the step before it aborts: no item runs, nothing recorded', async () => {
    const ac = new AbortController();
    const c = tapped('canceled');
    const runner = abortingBefore(ac);
    const report = await run([{ kind: 'step', id: 'before' }, foreach(3)], ['a', 'b'], runner, c.gadget, ac.signal);

    expect(runner.calls).toEqual(['before']);
    expect(report.outcome).toEqual({ status: 'canceled', origin: { stepId: 'body', path: [1] }, started: false });
    // Mastra's check before the entry (`default.ts:815`): the foreach never started — the sweep
    // took its input, so there is no partial array and no record under the body id.
    expect(c.seen).toEqual([{ origin: { stepId: 'body', path: [1] }, started: false }]);
    expect(report.stepResults.has('body')).toBe(false);
  });

  /**
   * A signal aborted before the run starts is seeded into the cancel *signal*, so the foreach's
   * `split` is inhibited from the first marking — Mastra's check before the first entry. This was
   * an `it.fails` while the kernel seeded the *request* place instead, where `split` and the
   * arrival were enabled together and `split` could open the foreach.
   */
  it('a run aborted before it starts never opens the foreach', async () => {
    const ac = new AbortController();
    ac.abort();
    const c = tapped('canceled');
    const { runner } = itemRunner();
    const report = await run([foreach(2)], ['a', 'b'], runner, c.gadget, ac.signal);

    expect(runner.calls).toEqual([]);
    expect(report.outcome).toEqual(canceledBeforeAt0);
    expect(c.seen).toEqual([{ origin, started: false }]);
    expect(report.stepResults.has('body')).toBe(false);
  });

  it('at concurrency 1, an abort during item 0 records the foreach canceled with item 0 and starts nothing after it', async () => {
    const ac = new AbortController();
    const c = tapped('canceled');
    const { runner, log } = itemRunner((label) => {
      if (label === 'a') ac.abort();
      return { status: 'success', output: `${label}!` };
    });
    const report = await run([foreach(1)], ['a', 'b', 'c'], runner, c.gadget, ac.signal);

    expect(log.started).toEqual(['a']);
    expect(report.outcome).toEqual(canceledAt0);
    // `canceledResult.output` is the workers' `results` array (`:1160-1172`): `a` finished.
    expect(c.seen).toEqual([{ origin, output: ['a!'], started: true }]);
    // ... and it is what Mastra stores under the body id (`entry.ts:811-812`), over item 0's own record.
    expectCanceledRecord(report, ['a', 'b', 'c'], ['a!']);
  });

  it('at concurrency 3, in-flight items finish and queued ones never start; holes stay holes', async () => {
    const ac = new AbortController();
    const c = tapped('canceled');
    const { runner, log } = itemRunner(async (label) => {
      await until(() => log.started.length >= 3);
      if (label === 'a') {
        ac.abort();
        return { status: 'success', output: 'a!' };
      }
      // `b` and `c` are still running when the abort lands, and finish after it.
      await sleep(20);
      return { status: 'success', output: label === 'b' ? undefined : `${label}!` };
    });
    const items = ['a', 'b', 'c', 'd', 'e', 'f'];
    const report = await run([foreach(3)], items, runner, c.gadget, ac.signal);

    expect(log.started).toEqual(['a', 'b', 'c']);
    expect([...log.finished].sort()).toEqual(['a', 'b', 'c']);
    expect(report.outcome).toEqual(canceledAt0);
    expect(c.seen).toHaveLength(1);
    expect((c.seen[0] as CanceledToken).started).toBe(true);
    const output = (c.seen[0] as CanceledToken).output as unknown[];
    expect(output).toHaveLength(3);
    expect(1 in output).toBe(false);
    expect(output[0]).toBe('a!');
    expect(output[2]).toBe('c!');
    const recorded = (report.stepResults.get('body') as { readonly output?: unknown }).output as unknown[];
    expect(recorded).toEqual(output);
    expect(1 in recorded).toBe(false);
    expectCanceledRecord(report, items, output);
  });

  it('outranks a failure recorded before the drain, as the check after the drain does (:1298)', async () => {
    const ac = new AbortController();
    const c = tapped('canceled');
    const { runner, log } = itemRunner(async (label) => {
      await until(() => log.started.length >= 2);
      if (label === 'a') return { status: 'failed', error: 'boom:a' };
      await until(() => log.finished.includes('a'));
      await sleep(10);
      ac.abort();
      return { status: 'success', output: 'b!' };
    });
    const report = await run([foreach(2)], ['a', 'b', 'c'], runner, c.gadget, ac.signal);

    expect(log.started).toEqual(['a', 'b']);
    expect(report.outcome).toEqual(canceledAt0);
    expect(c.seen).toEqual([{ origin, output: [undefined, 'b!'], started: true }]);
    expectCanceledRecord(report, ['a', 'b', 'c'], [undefined, 'b!']);
  });

  /**
   * An item that ends badly **after** the abort. Mastra's worker records it regardless
   * (`handleNonSuccessResult`, `:1176-1191` — the settle is never gated), then the check after the
   * drain (`:1298-1312`) runs before the error check (`:1315`), so canceled wins over the failure,
   * bail, pause, suspension or throw. Each would hang the run if a settle were gated on the signal:
   * the lane would never give its permit back.
   */
  it.each<[string, (label: string) => StepOutcome]>([
    ['fails', () => ({ status: 'failed', error: 'late' })],
    ['fails non-retryably', () => ({ status: 'failed', error: 'late', nonRetryable: true })],
    ['bails', () => ({ status: 'bailed', output: 'late' })],
    ['suspends', () => ({ status: 'suspended', suspendPayload: 'late' })],
    ['throws', () => {
      throw new Error('late');
    }],
  ])('an item that %s after the abort still settles, and the foreach leaves canceled', async (_what, outcome) => {
    const ac = new AbortController();
    const c = tapped('canceled');
    const { runner, log } = itemRunner(async (label) => {
      await until(() => log.started.length >= 2);
      if (label === 'a') {
        ac.abort();
        return outcome(label);
      }
      // `b` is still running when `a` lands its outcome, and succeeds after it.
      await until(() => log.finished.includes('a'));
      await sleep(20);
      return { status: 'success', output: 'b!' };
    });
    const report = await run([foreach(2)], ['a', 'b', 'c'], runner, c.gadget, ac.signal);

    expect(log.started).toEqual(['a', 'b']);
    expect(report.outcome).toEqual(canceledAt0);
    expect(c.seen).toEqual([{ origin, output: [undefined, 'b!'], started: true }]);
    expectCanceledRecord(report, ['a', 'b', 'c'], [undefined, 'b!']);
  });

  it('an item that pauses after the abort still settles, and the foreach leaves canceled', async () => {
    const ac = new AbortController();
    const c = tapped('canceled');
    const { runner } = itemRunner((label) => {
      if (label === 'a') {
        ac.abort();
        return { status: 'paused' };
      }
      return { status: 'success', output: `${label}!` };
    });
    const report = await run([foreach(1, body({ source: 'workflow' }))], ['a', 'b'], runner, c.gadget, ac.signal);
    expect(report.outcome).toEqual(canceledAt0);
    expect(c.seen).toEqual([{ origin, output: [], started: true }]);
    expectCanceledRecord(report, ['a', 'b'], []);
  });

  it('without the cancel inhibitor gated onto the settles, an item failing after the abort hangs the run (mutant)', async () => {
    // Over-gating: the settle is inhibited by the signal, so the failed item never gives its lane
    // back and no finisher can fire. The intact gadget ends at once; the mutant only at the timeout.
    const gateSettles: Gadget = (entry, next, ctx) => {
      const r = foreachGadget(entry, next, ctx);
      const transitions = r.transitions.map((t) => {
        if (!/\.lane\d+\.(fail|bail|pause|suspend)$/.test(t.name)) return t;
        const b = Transition.builder(t.name).inputs(...t.inputSpecs).outputs(t.outputSpec!).action(t.action).timing(t.timing);
        for (const a of t.inhibitors) b.inhibitor(a.place);
        for (const a of t.reads) b.read(a.place);
        for (const a of t.resets) b.reset(a.place);
        b.inhibitor(ctx.cancel!);
        return b.build();
      });
      return { ...r, transitions };
    };
    const once = async (gadget: Gadget) => {
      const ac = new AbortController();
      const { runner } = itemRunner((label) => {
        if (label === 'a') {
          ac.abort();
          return { status: 'failed', error: 'late' };
        }
        return { status: 'success', output: `${label}!` };
      });
      return runWorkflowDetailed(build([foreach(1)], gadget), ['a', 'b'], { runner, timeoutMs: 300, signal: ac.signal });
    };

    expect((await once(foreachGadget)).outcome).toEqual(canceledAt0);
    await expect(once(gateSettles)).rejects.toThrow();
  });

  it('outranks success when the abort lands during the last item', async () => {
    const ac = new AbortController();
    const c = tapped('canceled');
    const { runner } = itemRunner((label) => {
      if (label === 'b') ac.abort();
      return { status: 'success', output: `${label}!` };
    });
    const report = await run([foreach(1), { kind: 'step', id: 'after' }], ['a', 'b'], runner, c.gadget, ac.signal);
    expect(report.outcome).toEqual(canceledAt0);
    expect(runner.calls).not.toContain('after');
    expect(c.seen).toEqual([{ origin, output: ['a!', 'b!'], started: true }]);
    expectCanceledRecord(report, ['a', 'b'], ['a!', 'b!']);
  });

  it('with a signal that never fires, runs to success and leaves nothing behind', async () => {
    const ac = new AbortController();
    const { runner } = itemRunner();
    const report = await run([foreach(2)], ['a', 'b', 'c'], runner, undefined, ac.signal);
    expect(report.outcome).toEqual({ status: 'success', output: ['a!', 'b!', 'c!'] });
    expect(report.stepResults.get('body')).toMatchObject({ status: 'success', output: ['a!', 'b!', 'c!'] });
  });

  it('never gates the body: a retry after the abort still runs', async () => {
    const ac = new AbortController();
    const { runner } = itemRunner((label, call) => {
      if (call.attempt === 0) {
        ac.abort();
        return { status: 'failed', error: 'flaky' };
      }
      return { status: 'success', output: `${label}!` };
    });
    const report = await run([foreach(1, body({ retries: 1 }))], ['a', 'b'], runner, undefined, ac.signal);
    expect(runner.attempts).toEqual([
      { stepId: 'body', attempt: 0 },
      { stepId: 'body', attempt: 1 },
    ]);
    expect(report.outcome).toEqual(canceledAt0);
    expectCanceledRecord(report, ['a', 'b'], ['a!']);
  });

  it('never gates the body: no transition of any lane\'s body touches the signal', () => {
    // Mastra never checks between an item's start and its end, so the body is emitted without the
    // signal. A gated first attempt would be invisible to these runs (the abort lands inside it);
    // the arcs say it directly, and the cancel proof would strand the lane's slot.
    const compiled = build([foreach(3)]);
    const bodies = [...compiled.net.transitions].filter((t) => /^t\.0-\d+\./.test(t.name));
    expect(bodies.length).toBeGreaterThanOrEqual(3);
    for (const t of bodies) {
      const arcs = [...t.inhibitors, ...t.reads].map((a) => a.place.name);
      expect(arcs, t.name).not.toContain(compiled.cancel.name);
    }
  });

  it('without the start inhibitors on the signal, queued items start after the abort (mutant)', async () => {
    const plan = (ac: AbortController): Plan => (label) => {
      if (label === 'a') ac.abort();
      return { status: 'success', output: `${label}!` };
    };

    const keptAc = new AbortController();
    const intact = itemRunner(plan(keptAc));
    await run([foreach(1)], ['a', 'b', 'c'], intact.runner, undefined, keptAc.signal);
    expect(intact.log.started).toEqual(['a']);

    const brokenAc = new AbortController();
    const broken = itemRunner(plan(brokenAc));
    // The start is also moved ahead of `refuse` in declaration order, so the tie-break
    // ([EXEC-002]) hands it the cursor the arc would have kept from it.
    const startFirst = (inner: Gadget): Gadget => (entry, next, ctx) => {
      const r = inner(entry, next, ctx);
      const starts = r.transitions.filter((t) => /\.lane\d+\.start$/.test(t.name));
      return { ...r, transitions: [...starts, ...r.transitions.filter((t) => !starts.includes(t))] };
    };
    const report = await run(
      [foreach(1)],
      ['a', 'b', 'c'],
      broken.runner,
      startFirst(mutated({ transition: /\.lane\d+\.start$/, dropInhibitor: /^wf\.cancel$/ })),
      brokenAc.signal,
    );
    expect(broken.log.started).toEqual(['a', 'b', 'c']);
    // The run is still canceled — the foreach's cancel finisher still decides — so only dispatch shows the arc.
    expect(report.outcome).toEqual(canceledAt0);
  });

  it('without split\'s inhibitor on the signal, a canceled run opens the foreach anyway (mutant)', async () => {
    // Both copies declare `split` ahead of the sweep, so the tie-break ([EXEC-002]: equal priority
    // and enablement time, then declaration order) would let `split` win the race the arc prevents.
    const splitFirst = (inner: Gadget): Gadget => (entry, next, ctx) => {
      const r = inner(entry, next, ctx);
      const split = r.transitions.filter((t) => t.name.endsWith('.items.split'));
      return { ...r, transitions: [...split, ...r.transitions.filter((t) => !split.includes(t))] };
    };
    const entries: EntryDescription[] = [{ kind: 'step', id: 'before' }, foreach(2)];
    const at1 = { stepId: 'body', path: [1] };

    const intactAc = new AbortController();
    const intact = tapped('canceled', splitFirst(foreachGadget));
    const kept = await run(entries, ['a', 'b'], abortingBefore(intactAc), intact.gadget, intactAc.signal);
    // The sweep took the input: the foreach never opened, so there is no partial array and no record.
    expect(intact.seen).toEqual([{ origin: at1, started: false }]);
    expect(kept.stepResults.has('body')).toBe(false);

    const brokenAc = new AbortController();
    const broken = tapped('canceled', splitFirst(mutated({ transition: /\.items\.split$/, dropInhibitor: /^wf\.cancel$/ })));
    const runner = abortingBefore(brokenAc);
    const lost = await run(entries, ['a', 'b'], runner, broken.gadget, brokenAc.signal);
    expect(runner.calls).toEqual(['before']);
    // It opened — frame, cursor, permits — and the cancel finisher closed it with an empty array.
    // `cancel-empty` reports a foreach that had opened: `started: true`.
    expect(broken.seen).toEqual([{ origin: at1, output: [], started: true }]);
    expect(lost.stepResults.get('body')).toMatchObject({ status: 'canceled', output: [] });
  });

  /**
   * Each ordinary finisher is inhibited by the signal — Mastra's check after the drain (`:1298`)
   * outranks every other outcome. Remove the arc and, when the last lane comes home, the finisher
   * (declared before the cancel finishers, so it wins the tie-break) decides instead: the foreach
   * never leaves through its own canceled exit, the run is canceled only by the settle stage, and
   * the record under the body id is the ordinary outcome where Mastra's is `canceled`.
   */
  it.each<[string, RegExp, Plan, string]>([
    ['join', /\.items\.join$/, (label) => ({ status: 'success', output: `${label}!` }), 'success'],
    ['fail', /\.items\.fail$/, (label) => (label === 'a' ? { status: 'failed', error: 'boom' } : { status: 'success', output: 'b!' }), 'failed'],
    ['exit', /\.items\.exit$/, (label) => (label === 'a' ? { status: 'bailed', output: 'early' } : { status: 'success', output: 'b!' }), 'bailed'],
    ['suspend', /\.items\.suspend$/, (label) => (label === 'a' ? { status: 'suspended', suspendPayload: 'p' } : { status: 'success', output: 'b!' }), 'suspended'],
  ])('without %s\'s inhibitor on the signal, the foreach does not leave canceled (mutant)', async (_name, transition, outcomeOf, brokenStatus) => {
    const once = async (gadget: Gadget) => {
      const ac = new AbortController();
      const tap = tapped('canceled', gadget);
      const { runner, log } = itemRunner(async (label, call) => {
        await until(() => log.started.length >= 2);
        if (label === 'b') {
          // `a` has settled; the abort lands while `b` is the last item in flight.
          await until(() => log.finished.includes('a'));
          await sleep(5);
          ac.abort();
        }
        return outcomeOf(label, call);
      });
      const report = await run([foreach(2)], ['a', 'b'], runner, tap.gadget, ac.signal);
      return { report, seen: tap.seen };
    };

    const kept = await once(foreachGadget);
    expect(kept.report.outcome).toEqual(canceledAt0);
    expect(kept.seen).toHaveLength(1);
    expect(kept.report.stepResults.get('body')?.status).toBe('canceled');

    const broken = await once(mutated({ transition, dropInhibitor: /^wf\.cancel$/ }));
    expect(broken.report.outcome.status).toBe('canceled');
    expect(broken.report.outcome).not.toHaveProperty('residue');
    expect(broken.seen).toEqual([]);
    // What a host sees: the body id holds the ordinary aggregate, not Mastra's `canceled`.
    expect(broken.report.stepResults.get('body')?.status).toBe(brokenStatus);
  });
});

// ---------------------------------------------------------------------------------------------
// `CanceledToken.started`: the sweep on the input reports a foreach that never opened; both
// cancel finishers, one that had. A mutant flipping any one is caught.
// ---------------------------------------------------------------------------------------------

/**
 * `inner`, with every transition whose name ends in `suffix` rebuilt so the `started` flag of any
 * canceled token it writes is inverted — every arc, the timing and the priority kept. The mutant
 * that shows a `started` assertion is not vacuous.
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
    const transitions = r.transitions.map((t) => (t.name.endsWith(suffix) ? flip(t) : t));
    expect(transitions.filter((t, i) => t !== r.transitions[i]).length, `no transition ends in '${suffix}'`).toBeGreaterThan(0);
    return { ...r, transitions };
  };
}

describe('foreach: a mutant flipping any sweep\'s `started` is caught', () => {
  const origin = { stepId: 'body', path: [0] };

  it('the input sweep (`.cancel`): intact false, flipped true', async () => {
    const once = async (gadget: Gadget) => {
      const ac = new AbortController();
      ac.abort();
      const c = tapped('canceled', gadget);
      await run([foreach(2)], ['a', 'b'], itemRunner().runner, c.gadget, ac.signal);
      return c.seen;
    };
    expect(await once(foreachGadget)).toEqual([{ origin, started: false }]);
    expect(await once(flippingStarted(foreachGadget, '.cancel'))).toEqual([{ origin, started: true }]);
  });

  it('the finisher with results (`.canceled`): intact true, flipped false', async () => {
    const once = async (gadget: Gadget) => {
      const ac = new AbortController();
      const c = tapped('canceled', gadget);
      const { runner } = itemRunner((label) => {
        if (label === 'a') ac.abort();
        return { status: 'success', output: `${label}!` };
      });
      await run([foreach(1)], ['a', 'b'], runner, c.gadget, ac.signal);
      return c.seen;
    };
    expect(await once(foreachGadget)).toEqual([{ origin, output: ['a!'], started: true }]);
    expect(await once(flippingStarted(foreachGadget, '.canceled'))).toEqual([{ origin, output: ['a!'], started: false }]);
  });

  it('the finisher with no results (`.canceled-empty`): intact true, flipped false', async () => {
    const once = async (gadget: Gadget) => {
      const ac = new AbortController();
      const c = tapped('canceled', gadget);
      const { runner } = itemRunner((label) => {
        if (label === 'a') ac.abort();
        return label === 'a' ? { status: 'paused' } : { status: 'success', output: `${label}!` };
      });
      await run([foreach(1, body({ source: 'workflow' }))], ['a', 'b'], runner, c.gadget, ac.signal);
      return c.seen;
    };
    expect(await once(foreachGadget)).toEqual([{ origin, output: [], started: true }]);
    expect(await once(flippingStarted(foreachGadget, '.canceled-empty'))).toEqual([{ origin, output: [], started: false }]);
  });
});

// ===========================================================================================
// Row 49 and the run budget (M3).
// ===========================================================================================

/**
 * A [TIME-015] clock the test drives, with one addition over `tests/support/manual-clock.ts`: a
 * step can spend model time (`advance`). That is what makes "when did this item start" a question
 * with more than one answer — the only way a dispatch and an item's first attempt can be apart
 * under a virtual clock is a sibling spending time while this item waits for a run permit.
 */
class SteppingClock {
  #now = 0;
  constructor(readonly epochOrigin: number) {}
  now(): number {
    return this.#now;
  }
  epochNow(): number {
    return this.epochOrigin + this.#now;
  }
  advance(ms: number): void {
    this.#now += ms;
  }
  async sleep(delayMs: number, ready: () => boolean, signal: AbortSignal): Promise<void> {
    if (signal.aborted || ready()) return;
    if (Number.isFinite(delayMs)) {
      this.#now += delayMs;
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const EPOCH = 1_700_000_000_000;

/**
 * An array-like whose `length` aborts the run when read. Mastra reads `prevOutput.length` inside
 * `executeForeach` (`:1053`, and again in the enqueue loop `:1228`), after the check before the
 * entry (`default.ts:815`) and after `startTime` (`:988`), so reading it is the one deterministic
 * way to land an abort **during** the foreach, before any item is queued. Here `itemsOf` reads it
 * inside `split`'s action — the same instant in the foreach's life.
 */
function abortingLength(ac: AbortController, length: number): { readonly length: number; readonly [k: number]: unknown } {
  const target: Record<number, unknown> = {};
  for (let k = 0; k < length; k++) target[k] = `item${k}`;
  return Object.defineProperty(target, 'length', {
    get() {
      ac.abort();
      return length;
    },
    enumerable: false,
  }) as unknown as { readonly length: number };
}

describe('foreach over no items, canceled (row 49)', () => {
  const origin = { stepId: 'body', path: [0] };

  /**
   * **When Mastra records `canceled []`.** Three windows, read from the source:
   *
   * 1. Aborted before the entry: `default.ts:815` stops the run before `executeEntry`; the foreach
   *    never starts and nothing is recorded under the body id. (Here: the input sweep.)
   * 2. Aborted after the entry began and before the check after the drain: with no items nothing
   *    is enqueued (`:1228`), `inFlight` is 0 so the wait is skipped (`:1276`), `canceledResult`
   *    is still null (only a worker sets it, `:1160-1172`), and `:1298` sees the signal —
   *    `{...stepInfo, status: 'canceled', output: [], endedAt}`, stored by `entry.ts:811-812`. The
   *    window holds `executeForeach`'s awaits (span, `workflow-step-start` publish) and its read of
   *    `prevOutput.length`. (Here: `split` opened the foreach, `canceled-empty` decides it.)
   * 3. Aborted after `executeForeach` returned `success []`: `entry.ts:815-817` relabels the entry
   *    `canceled` but has already stored the success record — an entry-level window every entry
   *    kind shares, not the foreach's. (Here: the run is canceled whatever else it reached, the
   *    kernel's rule; not re-tested here.)
   */
  it('an abort during the foreach — while it reads its input — records canceled [] under the body id', async () => {
    const ac = new AbortController();
    const clock = new SteppingClock(EPOCH);
    const c = tapped('canceled');
    const { runner } = itemRunner();
    const input = abortingLength(ac, 0);
    const report = await runWorkflowDetailed(build([foreach(2)], c.gadget), input, { runner, clock, timeoutMs: 10_000, signal: ac.signal });

    expect(ac.signal.aborted).toBe(true);
    expect(runner.calls).toEqual([]);
    expect(report.outcome).toEqual({ status: 'canceled', origin, started: true });
    expect(c.seen).toEqual([{ origin, output: [], started: true }]);
    const record = report.stepResults.get('body')!;
    expect(record).toEqual({ status: 'canceled', output: [], payload: input, startedAt: EPOCH, endedAt: EPOCH });
  });

  it('an abort while it reads a non-empty input starts no item and records canceled [] (the worker\'s check, :1160)', async () => {
    const ac = new AbortController();
    const c = tapped('canceled');
    const { runner } = itemRunner();
    const input = abortingLength(ac, 2);
    const report = await runWorkflowDetailed(build([foreach(2)], c.gadget), input, { runner, timeoutMs: 10_000, signal: ac.signal });

    expect(runner.calls).toEqual([]);
    expect(report.outcome).toEqual({ status: 'canceled', origin, started: true });
    expect(c.seen).toEqual([{ origin, output: [], started: true }]);
    expect(report.stepResults.get('body')).toMatchObject({ status: 'canceled', output: [], payload: input });
  });

  it('an abort before the entry never opens an empty foreach: no record (default.ts:815)', async () => {
    const ac = new AbortController();
    const c = tapped('canceled');
    const runner = new RecordingRunner({
      steps: {
        before: (x) => {
          ac.abort();
          return { status: 'success', output: x };
        },
      },
    });
    const report = await run([{ kind: 'step', id: 'before' }, foreach(2)], [], runner, c.gadget, ac.signal);

    expect(report.outcome).toEqual({ status: 'canceled', origin: { stepId: 'body', path: [1] }, started: false });
    expect(c.seen).toEqual([{ origin: { stepId: 'body', path: [1] }, started: false }]);
    expect(report.stepResults.has('body')).toBe(false);
  });

  it('with a signal that never fires, an empty foreach succeeds with [] at its own instants', async () => {
    const ac = new AbortController();
    const clock = new SteppingClock(EPOCH);
    const runner = new RecordingRunner({
      steps: {
        before: (x) => {
          clock.advance(250);
          return { status: 'success', output: x };
        },
      },
    });
    const report = await runWorkflowDetailed(build([{ kind: 'step', id: 'before' }, foreach(2), { kind: 'step', id: 'after' }]), [], {
      runner,
      clock,
      timeoutMs: 10_000,
      signal: ac.signal,
    });
    expect(report.outcome).toEqual({ status: 'success', output: [] });
    expect(runner.calls).toEqual(['before', 'after']);
    // `{...stepInfo, status: 'success', output: results, endedAt}` (`:1486-1492`).
    expect(report.stepResults.get('body')).toEqual({ status: 'success', output: [], payload: [], startedAt: EPOCH + 250, endedAt: EPOCH + 250 });
  });

  it('without join-empty\'s inhibitor on the signal, the abort during an empty foreach is lost to success (mutant)', async () => {
    const once = async (gadget: Gadget) => {
      const ac = new AbortController();
      const c = tapped('canceled', gadget);
      const report = await runWorkflowDetailed(build([foreach(2)], c.gadget), abortingLength(ac, 0), {
        runner: itemRunner().runner,
        timeoutMs: 10_000,
        signal: ac.signal,
      });
      return { status: report.outcome.status, recorded: report.stepResults.get('body')?.status, seen: c.seen };
    };
    expect(await once(foreachGadget)).toEqual({ status: 'canceled', recorded: 'canceled', seen: [{ origin, output: [], started: true }] });
    // `join-empty` is declared before `canceled-empty`, so without the arc the tie-break
    // ([EXEC-002]) takes it: the foreach records success though the run was aborted inside it.
    // The kernel still reports the run canceled (the entry-level rule), which is why the record is
    // what this checks.
    const mutant = await once(mutated({ transition: /\.items\.join-empty$/, dropInhibitor: /^wf\.cancel$/ }));
    expect(mutant.recorded).toBe('success');
    expect(mutant.seen).toEqual([]);
  });
});

describe('foreach: a deciding item\'s startedAt is its own (row 49)', () => {
  /**
   * Mastra's failed aggregate is `{...finalErrorResult, suspendPayload}` (`:1360-1369`) and its
   * bail `return exitResult` (`:1406`) — the item's own `StepResult`, whose `startedAt` is
   * `Date.now()` taken once by the item's `executeStep` before its retry loop
   * (`handlers/step.ts:166,174`). It is not the foreach's `stepInfo.startedAt`: that object is
   * local to `executeForeach` and is never written into `stepResults` before items run, so the
   * item's `omitPriorCompletionFields(stepResults[id])` has nothing of it to carry on a fresh run.
   *
   * Under a run budget ([ADR 0006]) an item can be dispatched into its lane and then wait for a
   * permit while a sibling spends model time: the dispatch instant and the item's own start
   * differ, and only the latter is Mastra's. k = 1, c = 2: both items are dispatched at EPOCH; the
   * first to get the permit spends 100 ms and succeeds; the second starts at EPOCH + 100, spends
   * 50 ms and ends badly.
   *
   * These were `it.fails` until the leaf reported the start: the settle stamped the *dispatch*
   * (EPOCH). The leaf's exit tokens now carry `stepStartedAt`, which the gadget prefers. Contract change requested: `stepAction` (leaf.ts) adds
   * `stepStartedAt: startedAt` to the failed / bailed / paused token of an item
   * (`incoming.foreachIndex !== undefined`), and `FailureToken`, `BailToken`, `PauseToken` declare
   * `readonly stepStartedAt?: number`. With that applied to a scratch copy both assertions hold
   * exactly as written; drop the `.fails` then. Row 49 stays open for this until it lands.
   */
  const scenario = async (last: StepOutcome) => {
    const clock = new SteppingClock(EPOCH);
    const startedAt: number[] = [];
    const runner = new RecordingRunner({
      steps: {
        body: async (input) => {
          startedAt.push(clock.epochNow());
          if (startedAt.length === 1) {
            // Real time only, no model time: lets the executor dispatch the second item into its
            // lane at EPOCH, where it waits for the one permit this step holds.
            await sleep(10);
            clock.advance(100);
            return { status: 'success', output: `${String(input)}!` };
          }
          clock.advance(50);
          return last;
        },
      },
    });
    const compiled = compile({ id: 'batch', entries: [foreach(2)] }, { concurrency: 1 });
    const report = await runWorkflowDetailed(compiled, ['a', 'b'], { runner, clock, timeoutMs: 10_000 });
    return { report, startedAt };
  };

  it('a failed aggregate takes the failing item\'s first-attempt instant, not its dispatch', async () => {
    const { report, startedAt } = await scenario({ status: 'failed', error: 'boom' });
    expect(startedAt).toEqual([EPOCH, EPOCH + 100]);
    expect(report.outcome.status).toBe('failed');
    expect(report.stepResults.get('body')).toMatchObject({ status: 'failed', payload: 'b', startedAt: EPOCH + 100, endedAt: EPOCH + 150 });
  });

  it('a bailed aggregate takes the bailing item\'s first-attempt instant, not its dispatch', async () => {
    const { report, startedAt } = await scenario({ status: 'bailed', output: 'out' });
    expect(startedAt).toEqual([EPOCH, EPOCH + 100]);
    // `success`: a bail that ends the run is rewritten so (`default.ts:926-928`), times untouched.
    expect(report.stepResults.get('body')).toMatchObject({ status: 'success', output: 'out', payload: 'b', startedAt: EPOCH + 100, endedAt: EPOCH + 150 });
  });

  it('unbounded, dispatch and first attempt coincide and the aggregate is exact', async () => {
    const clock = new SteppingClock(EPOCH);
    const runner = new RecordingRunner({
      steps: {
        body: (input) => {
          clock.advance(input === 'a' ? 100 : 50);
          return input === 'a' ? { status: 'success', output: 'a!' } : { status: 'failed', error: 'boom' };
        },
      },
    });
    const report = await runWorkflowDetailed(build([foreach(1)]), ['a', 'b'], { runner, clock, timeoutMs: 10_000 });
    expect(report.stepResults.get('body')).toMatchObject({ status: 'failed', payload: 'b', startedAt: EPOCH + 100, endedAt: EPOCH + 150 });
  });
});

describe('foreach under a run budget (ADR 0006): each item takes a permit on top of its lane', () => {
  /** Peak items in flight, measured by the runner, for c = 2 at each k; each item holds 25 ms. */
  it.each<[number | undefined, number]>([
    [1, 1],
    [2, 2],
    [3, 2],
    [undefined, 2],
  ])('c = 2, k = %s: peak items in flight is %i = min(c, k), and the output is unchanged', async (k, peak) => {
    const { runner, log } = itemRunner(async (label) => {
      await sleep(25);
      return { status: 'success', output: `${label}!` };
    });
    const compiled = compile({ id: 'batch', entries: [foreach(2)] }, k === undefined ? {} : { concurrency: k });
    const report = await runWorkflowDetailed(compiled, ['a', 'b', 'c', 'd'], { runner, timeoutMs: 10_000 });
    expect(report.outcome).toEqual({ status: 'success', output: ['a!', 'b!', 'c!', 'd!'] });
    expect(log.maxInFlight).toBe(peak);
    expect(log.started).toEqual(['a', 'b', 'c', 'd']);
  });
});

import { describe, expect, it } from 'vitest';
import { Transition, and, one, outPlace, place, type Place } from 'libpetri';
import { compile, stepGadget, type Gadget } from '../../src/compiler/index.js';
import { scopeOf } from '../../src/compiler/scope.js';
import type { EntryPath } from '../../src/compiler/names.js';
import { KernelRunScope, runWorkflowDetailed } from '../../src/engine/index.js';
import type {
  FailureToken,
  FlowToken,
  LifecycleEvent,
  StepCall,
  StepDescription,
  StepOutcome,
  StepRecord,
  StepRunner,
  WorkflowDescription,
} from '../../src/compiler/types.js';
import { ManualClock } from '../support/manual-clock.js';
import { netDigest } from '../fixtures/unannotated-shapes.js';

/**
 * Item scope ([ADR 0015], maintainer decision 3; W1 B): `RunScope.itemRecords` in the kernel's scope,
 * and the leaf's `item` option — a pipeline stage reads its item as `initData` and its own item's
 * records through `getStepResult`, records into the item's store and never the run's, writes no
 * `metadata.foreachIndex`, raises no `step-settled`, and calls the runner with `pipelineItem = k` and
 * no `foreachIndex`, while its outcome tokens keep `foreachIndex = k`.
 *
 * The pipeline gadget is W1 A's, not in this file's scope: a test gadget stands in for it — `split`
 * admits every item at once (opening each item's store), each item walks its own chain of stage
 * leaves emitted with `{ viewPath, item: true }`, `join` forgets every store with `'merge'`, and a
 * stage failure forgets its item with `'discard'`. It is a harness, not the pipeline net, and nothing
 * here is a claim about it.
 *
 * Environment: the kernel (`runWorkflowDetailed`) with a scripted runner and the tests'
 * `ManualClock`, libpetri 8.0.0 from the registry (not linked). Everything here is tested, not proven.
 */

const EPOCH = 1_700_000_000_000;
const step = (id: string, extra: Omit<StepDescription, 'kind' | 'id'> = {}): StepDescription => ({ kind: 'step', id, ...extra });

// --- the stand-in pipeline -------------------------------------------------------------------------

/**
 * The step entry `pipe` becomes `items` items × `stages` stages of item-scoped leaves, item `i` stage
 * `j` at naming path `[...path, i * s + j]` and view path `path`. `item: false` emits the same shape
 * without the option, for the arcs comparison.
 */
function standIn(items: number, stages: readonly StepDescription[], options: { readonly item?: boolean } = {}): Gadget {
  const s = stages.length;
  return (entry, next, ctx) => {
    if (entry.kind !== 'step' || entry.id !== 'pipe') return stepGadget(entry, next, ctx);
    const { names, path } = ctx;
    const inPlace = place<FlowToken>(names.entryIn(path, entry.id));
    const transitions: Transition[] = [];
    const heads: Place<FlowToken>[] = [];
    const dones: Place<FlowToken>[] = [];
    for (let i = 0; i < items; i++) {
      const done = place<FlowToken>(names.entryPlace(path, entry.id, `item${i}.done`));
      const failed = place<FailureToken>(names.entryPlace(path, entry.id, `item${i}.failed`));
      let to: Place<FlowToken> = done;
      for (let j = s - 1; j >= 0; j--) {
        const result = ctx.emitNested(stages[j]!, [...path, i * s + j], to, { ...ctx.exits, failed }, {
          viewPath: path,
          ...(options.item === false ? {} : { item: true as const }),
        });
        to = result.inPlace;
      }
      heads.push(to);
      dones.push(done);
      const k = i;
      transitions.push(
        Transition.builder(names.entryTransition(path, entry.id, `item${i}.fail`))
          .inputs(one(failed))
          .outputs(outPlace(ctx.exits.failed))
          .action(async (tctx) => {
            const token = tctx.input(failed);
            scopeOf(tctx).itemRecords(path, k).forget('discard');
            tctx.output(ctx.exits.failed, token);
          })
          .build(),
      );
    }
    transitions.push(
      Transition.builder(names.entryTransition(path, entry.id, 'split'))
        .inputs(one(inPlace))
        .outputs(and(...heads.map((h) => outPlace(h))))
        .action(async (tctx) => {
          const list = tctx.input(inPlace).data as unknown[];
          const scope = scopeOf(tctx);
          heads.forEach((h, i) => {
            scope.itemRecords(path, i).open(list[i]);
            tctx.output(h, { data: list[i], foreachIndex: i });
          });
        })
        .build(),
      Transition.builder(names.entryTransition(path, entry.id, 'join'))
        .inputs(...dones.map((d) => one(d)))
        .outputs(outPlace(next))
        .action(async (tctx) => {
          const scope = scopeOf(tctx);
          const out = dones.map((d, i) => {
            const token = tctx.input(d);
            scope.itemRecords(path, i).forget('merge');
            return { k: token.foreachIndex, data: token.data };
          });
          tctx.output(next, { data: out });
        })
        .build(),
    );
    return { inPlace, transitions };
  };
}

// --- a scripted runner with the item hooks -----------------------------------------------------------

type Script = (input: unknown, call: StepCall) => StepOutcome | Promise<StepOutcome>;

class ItemRunner implements StepRunner {
  readonly calls: { readonly stepId: string; readonly input: unknown; readonly call: StepCall; readonly seen: Record<string, unknown> }[] = [];
  readonly hooks: unknown[][] = [];
  readonly events: LifecycleEvent[] = [];
  constructor(
    readonly script: Readonly<Record<string, Script>> = {},
    /** Record ids each call reads through its view at call time, kept with the call. */
    readonly reads: readonly string[] = [],
  ) {}
  async run(stepId: string, input: unknown, call: StepCall): Promise<StepOutcome> {
    const seen: Record<string, unknown> = { initData: call.initData };
    for (const id of this.reads) seen[id] = call.getStepResult(id);
    this.calls.push({ stepId, input, call, seen });
    const fn = Object.hasOwn(this.script, stepId) ? this.script[stepId] : undefined;
    if (fn !== undefined) return fn(input, call);
    // `before` hands the run's input on, so the pipeline receives the list itself.
    return { status: 'success', output: stepId === 'before' ? input : { by: stepId, from: input } };
  }
  observe(event: LifecycleEvent): void {
    this.events.push(event);
  }
  openItem(path: EntryPath, k: number): void {
    this.hooks.push(['open', [...path], k]);
  }
  closeItem(path: EntryPath, k: number, state: 'merge' | 'discard'): void {
    this.hooks.push(['close', [...path], k, state]);
  }
}

const description = (..._stages: StepDescription[]): WorkflowDescription => ({
  id: 'items',
  entries: [step('before'), step('pipe'), step('after')],
});

const run = (runner: StepRunner, items: number, stages: readonly StepDescription[], input: unknown) =>
  runWorkflowDetailed(compile(description(...stages), { gadgets: { step: standIn(items, stages) } }), input, {
    runner,
    clock: new ManualClock(EPOCH),
  });

// ---------------------------------------------------------------------------------------------------

describe('RunScope.itemRecords (kernel scope)', () => {
  it('is one store per (path, k) until forgotten, and a fresh one afterwards', () => {
    const runner = new ItemRunner();
    const scope = new KernelRunScope({ runner, initData: 'run' });
    const a = scope.itemRecords([1], 0);
    expect(scope.itemRecords([1], 0)).toBe(a);
    expect(scope.itemRecords([1], 1)).not.toBe(a);
    expect(scope.itemRecords([2], 0)).not.toBe(a);
    expect(scope.itemRecords([1, 0], 0)).not.toBe(scope.itemRecords([10], 0));

    expect(a.initData).toBeUndefined();
    a.open({ url: 'u0' });
    expect(a.initData).toEqual({ url: 'u0' });
    const rec: StepRecord = { status: 'success', output: 1, payload: 0 };
    a.recordStepResult('fetch', rec);
    expect(a.getStepResult('fetch')).toBe(rec);
    // The run's store and its step map stay untouched.
    expect(scope.getStepResult('fetch')).toBeUndefined();
    expect([...scope.stepResults().keys()]).toEqual([]);

    a.forget('merge');
    const b = scope.itemRecords([1], 0);
    expect(b).not.toBe(a);
    expect(b.getStepResult('fetch')).toBeUndefined();
    expect(b.initData).toBeUndefined();
    expect(runner.hooks).toEqual([
      ['open', [1], 0],
      ['close', [1], 0, 'merge'],
    ]);
  });

  it('forwards open and forget to the runner, merge or discard as told', () => {
    const runner = new ItemRunner();
    const scope = new KernelRunScope({ runner, initData: null });
    scope.itemRecords([0], 2).open('x');
    scope.itemRecords([0], 3).open('y');
    scope.itemRecords([0], 3).forget('discard');
    scope.itemRecords([0], 2).forget('merge');
    expect(runner.hooks).toEqual([
      ['open', [0], 2],
      ['open', [0], 3],
      ['close', [0], 3, 'discard'],
      ['close', [0], 2, 'merge'],
    ]);
  });

  it('works with a runner that has no item hooks', () => {
    const scope = new KernelRunScope({ runner: { run: async () => ({ status: 'success', output: null }) }, initData: null });
    const store = scope.itemRecords([0], 0);
    store.open(1);
    expect(store.initData).toBe(1);
    expect(() => store.forget('merge')).not.toThrow();
  });

  it('refuses a second open, a second forget, an open after forget, and a bad index', () => {
    const scope = new KernelRunScope({ runner: new ItemRunner(), initData: null });
    const store = scope.itemRecords([0], 0);
    store.open(1);
    expect(() => store.open(2)).toThrow(/item 0 at \[0\] was opened twice/);
    store.forget('merge');
    expect(() => store.forget('merge')).toThrow(/forgotten twice/);
    expect(() => store.open(3)).toThrow(/opened after it was forgotten/);
    // The stale handle's failed forget never drops the fresh store that replaced it.
    const fresh = scope.itemRecords([0], 0);
    expect(() => store.forget('discard')).toThrow();
    expect(scope.itemRecords([0], 0)).toBe(fresh);
    expect(() => scope.itemRecords([0], -1)).toThrow(/whole number/);
    expect(() => scope.itemRecords([0], 1.5)).toThrow(/whole number/);
  });
});

describe('the leaf with item: true', () => {
  // Mutation: let `item` change the leaf's arcs (a branch, a place) -> the digests differ.
  it('emits exactly the arcs of the plain leaf', () => {
    const stages = [step('fetch', { retries: 1, retryDelayMs: 5, timeoutMs: 50 }), step('embed', { quotas: [{ id: 'gpu', kind: 'limit', n: 1 }] })];
    const scoped = compile(description(...stages), { concurrency: 2, gadgets: { step: standIn(2, stages) } });
    const plain = compile(description(...stages), { concurrency: 2, gadgets: { step: standIn(2, stages, { item: false }) } });
    expect(netDigest(scoped)).toBe(netDigest(plain));
  });

  // Mutation: hand the runner `foreachIndex` (or drop `pipelineItem`) -> fails.
  it('calls the runner with pipelineItem = k and the view path, never foreachIndex', async () => {
    const runner = new ItemRunner();
    const report = await run(runner, 2, [step('fetch'), step('embed')], ['u0', 'u1']);
    expect(report.outcome.status).toBe('success');
    const stageCalls = runner.calls.filter((c) => c.stepId === 'fetch' || c.stepId === 'embed');
    expect(stageCalls).toHaveLength(4);
    for (const c of stageCalls) {
      expect(c.call.path).toEqual([1]);
      expect(c.call).not.toHaveProperty('foreachIndex');
      expect(typeof c.call.pipelineItem).toBe('number');
    }
    expect(stageCalls.map((c) => [c.stepId, c.call.pipelineItem, c.input]).sort()).toEqual(
      [
        ['embed', 0, { by: 'fetch', from: 'u0' }],
        ['embed', 1, { by: 'fetch', from: 'u1' }],
        ['fetch', 0, 'u0'],
        ['fetch', 1, 'u1'],
      ].sort(),
    );
    // The run's own steps are untouched: no pipelineItem, the run's initData.
    for (const c of runner.calls.filter((x) => x.stepId === 'before' || x.stepId === 'after')) {
      expect(c.call).not.toHaveProperty('pipelineItem');
      expect(c.call.initData).toEqual(['u0', 'u1']);
    }
    // The outcome tokens kept the item: the stand-in's join reads it back.
    expect(report.outcome.status === 'success' && (report.outcome.output as { from: unknown }).from).toEqual([
      { k: 0, data: { by: 'embed', from: { by: 'fetch', from: 'u0' } } },
      { k: 1, data: { by: 'embed', from: { by: 'fetch', from: 'u1' } } },
    ]);
  });

  // Mutation: read `scope.getStepResult` / `scope.initData` in the view -> a stage sees the run's.
  it("reads the item as initData and the item's own records, never another item's or the run's", async () => {
    const runner = new ItemRunner({}, ['fetch', 'before']);
    const report = await run(runner, 2, [step('fetch'), step('embed')], ['u0', 'u1']);
    expect(report.outcome.status).toBe('success');
    for (const k of [0, 1]) {
      const embed = runner.calls.find((c) => c.stepId === 'embed' && c.call.pipelineItem === k)!;
      expect(embed.seen['initData']).toBe(`u${k}`);
      expect(embed.seen['fetch']).toMatchObject({ status: 'success', output: { by: 'fetch', from: `u${k}` }, payload: `u${k}` });
      // The run's `before` is not in the item's scope, as a parent step is not in the twin's child.
      expect(embed.seen['before']).toBeUndefined();
      // Twin parity: a child record carries no foreachIndex.
      expect((embed.seen['fetch'] as StepRecord).metadata).toBeUndefined();
      const fetch = runner.calls.find((c) => c.stepId === 'fetch' && c.call.pipelineItem === k)!;
      expect(fetch.seen['initData']).toBe(`u${k}`);
      expect(fetch.seen['fetch']).toBeUndefined();
    }
    // `after` reads the run's store: no stage keys there.
    const after = runner.calls.find((c) => c.stepId === 'after')!;
    expect(after.seen['fetch']).toBeUndefined();
    expect([...report.stepResults.keys()]).toEqual(['before', 'after']);
  });

  // Mutation: raise `step-settled` for an item attempt -> fails.
  it('raises no step-settled for a stage, and does for the run steps', async () => {
    const runner = new ItemRunner();
    await run(runner, 2, [step('fetch'), step('embed')], ['u0', 'u1']);
    const settled = runner.events.filter((e) => e.kind === 'step-settled').map((e) => (e as { stepId: string }).stepId);
    expect(settled).toEqual(['before', 'after']);
  });

  it('opens each item at admission and merges it when it leaves', async () => {
    const runner = new ItemRunner();
    await run(runner, 2, [step('fetch'), step('embed')], ['u0', 'u1']);
    expect(runner.hooks).toEqual([
      ['open', [1], 0],
      ['open', [1], 1],
      ['close', [1], 0, 'merge'],
      ['close', [1], 1, 'merge'],
    ]);
  });

  // Mutation: let a retry read the run's store for its prior -> its record loses the first start.
  it("retries a stage within its item: the same pipelineItem, the item's store, one start", async () => {
    const clock = new ManualClock(EPOCH);
    const runner = new ItemRunner(
      {
        fetch: (input, call) => (call.attempt === 0 ? { status: 'failed', error: new Error('flaky') } : { status: 'success', output: `ok:${String(input)}` }),
      },
      ['fetch'],
    );
    const stages = [step('fetch', { retries: 1, retryDelayMs: 10 }), step('embed')];
    const report = await runWorkflowDetailed(compile(description(...stages), { gadgets: { step: standIn(1, stages) } }), ['u0'], { runner, clock });
    expect(report.outcome.status).toBe('success');
    const fetches = runner.calls.filter((c) => c.stepId === 'fetch');
    expect(fetches.map((c) => [c.call.attempt, c.call.pipelineItem, c.call.startedAt])).toEqual([
      [0, 0, fetches[0]!.call.startedAt],
      [1, 0, fetches[0]!.call.startedAt],
    ]);
    const embed = runner.calls.find((c) => c.stepId === 'embed')!;
    expect(embed.seen['fetch']).toMatchObject({ status: 'success', output: 'ok:u0', startedAt: fetches[0]!.call.startedAt });
  });

  // Mutation: record a failed stage into the run's store -> `wf` gains a `fetch` key.
  it('a failed stage records into its item, leaves with the item index, and its item is discarded', async () => {
    const runner = new ItemRunner({ embed: () => ({ status: 'failed', error: new Error('embed broke') }) });
    const report = await run(runner, 1, [step('fetch'), step('embed')], ['u0']);
    expect(report.outcome.status).toBe('failed');
    expect(report.outcome).toMatchObject({ stepId: 'embed', path: [1] });
    expect(runner.hooks).toEqual([
      ['open', [1], 0],
      ['close', [1], 0, 'discard'],
    ]);
    expect([...report.stepResults.keys()]).toEqual(['before']);
  });

  it('a stage token without its item index strands the run rather than reading the run scope', async () => {
    // A stand-in that forgets the index: the leaf throws before calling the runner.
    const broken: Gadget = (entry, next, ctx) => {
      if (entry.kind !== 'step' || entry.id !== 'pipe') return stepGadget(entry, next, ctx);
      return ctx.emitNested(step('fetch'), [...ctx.path, 0], next, ctx.exits, { viewPath: ctx.path, item: true });
    };
    const runner = new ItemRunner();
    const report = await runWorkflowDetailed(compile(description(step('fetch')), { gadgets: { step: broken } }), 'x', {
      runner,
      clock: new ManualClock(EPOCH),
    });
    expect(report.outcome.status).toBe('stranded');
    expect(report.outcome.status === 'stranded' && report.outcome.failure?.message).toMatch(/without its item index/);
    expect(runner.calls.map((c) => c.stepId)).toEqual(['before']);
  });
});

describe('a stage id the run used before', () => {
  // Mutation: read the attempt's prior record from the run's store (`scope.getStepResult`) -> the
  // stage's record inherits the run's `fetch` loop record's `metadata.iterationCount`.
  it("reads its prior record from the item's store, not from the run step of the same id", async () => {
    class LoopRunner extends ItemRunner {
      async evaluateLoopCondition(): Promise<boolean> {
        return false;
      }
    }
    const runner = new LoopRunner(
      // The run's loop body `fetch` hands the list on; the stage `fetch` is the default.
      { fetch: (input, call) => ({ status: 'success', output: call.pipelineItem === undefined ? input : { by: 'fetch', from: input } }) },
      ['fetch'],
    );
    const stages = [step('fetch'), step('embed')];
    const wf: WorkflowDescription = {
      id: 'items',
      entries: [{ kind: 'loop', id: 'lp', body: step('fetch'), loopType: 'dowhile', iterationBound: 2 }, step('pipe'), step('after')],
    };
    const report = await runWorkflowDetailed(compile(wf, { gadgets: { step: standIn(1, stages) } }), ['u0'], { runner, clock: new ManualClock(EPOCH) });
    expect(report.outcome.status).toBe('success');
    // The run's own `fetch` carries the loop's iteration count.
    expect(report.stepResults.get('fetch')?.metadata).toEqual({ iterationCount: 1 });
    const embed = runner.calls.find((c) => c.stepId === 'embed')!;
    expect(embed.seen['fetch']).toMatchObject({ status: 'success', output: { by: 'fetch', from: 'u0' } });
    expect((embed.seen['fetch'] as StepRecord).metadata).toBeUndefined();
  });
});

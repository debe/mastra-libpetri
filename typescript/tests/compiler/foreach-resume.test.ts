import { describe, expect, it } from 'vitest';
import { Transition, one, outPlace, place, type Place } from 'libpetri';
import { compile, type Gadget } from '../../src/compiler/index.js';
import { foreachGadget } from '../../src/compiler/gadgets/foreach.js';
import { foreachSeed } from '../../src/compiler/resume-foreach.js';
import { UnresumablePositionError } from '../../src/compiler/resume.js';
import { runWorkflowDetailed, type RunReport } from '../../src/engine/index.js';
import type {
  CompiledWorkflow,
  EntryDescription,
  Exits,
  ForeachResume,
  ForeachSite,
  StepCall,
  StepDescription,
  StepOutcome,
  StepRecord,
  SuspendToken,
} from '../../src/compiler/types.js';
import { RecordingRunner } from '../fixtures/runner.js';
import { ManualClock } from '../support/manual-clock.js';

/**
 * `.foreach()` resumed ([ADR 0007], contract C8/C14/C15), against Mastra's `executeForeach`
 * (`@mastra/core@1.67.0`, `handlers/control-flow.ts:952-1495`, from its sourcemaps):
 *
 * - `:1030-1031`: `resumeIndex` is the stored aggregate's `__workflow_meta.foreachIndex || 0` when
 *   that aggregate is suspended, else 0.
 * - `:1040-1041`: `prevForeachOutput` is the stored `__workflow_meta.foreachOutput`.
 * - `:1227-1272`: each item is classified before any runs — success skipped and reused, suspended
 *   and not named by `forEachIndex` kept, the rest queued; the named item (or, with none named,
 *   every suspended item and `resumeIndex`) is fed the resume.
 * - `:1087-1090`, `:1141`: a non-success outcome **of this segment** kills the queue; a carried
 *   suspension does not.
 * - `:1355-1369`, `:1432-1450`: the failed and suspended aggregates carry `foreachOutput`, and the
 *   suspended one the lowest suspended index as `foreachIndex`.
 *
 * Every resumed run is a **seeded segment**: one `ForeachResume` token at the registered site,
 * through `runWorkflowDetailed({ resume })`, with the stored records as the run's step results.
 * Outcomes are asserted whole with `toStrictEqual`, so a `residue` key — any token left anywhere
 * but the one terminal, the cancel signal and the permits — fails the test.
 */

const EPOCH = 1_700_000_000_000;
const STORED_AT = EPOCH - 60_000;

const body = (extra: Omit<StepDescription, 'kind' | 'id'> = {}): StepDescription => ({ kind: 'step', id: 'body', ...extra });
const foreach = (concurrency: number, b: StepDescription = body()): EntryDescription => ({
  kind: 'foreach',
  id: 'items',
  body: b,
  concurrency,
});
const build = (entries: readonly EntryDescription[], gadget?: Gadget, concurrency?: number): CompiledWorkflow =>
  compile({ id: 'batch', entries }, { ...(gadget ? { gadgets: { foreach: gadget } } : {}), ...(concurrency ? { concurrency } : {}) });

const siteOf = (compiled: CompiledWorkflow, key = '0'): ForeachSite => {
  const site = compiled.resumeSites.get(key);
  if (site === undefined || site.kind !== 'foreach') throw new Error(`no foreach site at ${key}`);
  return site;
};

type Plan = (label: string, call: StepCall) => StepOutcome | Promise<StepOutcome>;

/** A runner whose `body` follows `plan` per item and logs each call: the item, its index, `resumed`. */
function itemRunner(plan: Plan = (label) => ({ status: 'success', output: `${label}!` })) {
  const calls: { readonly item: string; readonly index: number | undefined; readonly resumed: boolean; readonly attempt: number }[] = [];
  const runner = new RecordingRunner({
    steps: {
      body: async (input, call) => {
        calls.push({ item: String(input), index: call.foreachIndex, resumed: call.resumed === true, attempt: call.attempt });
        return plan(String(input), call);
      },
    },
  });
  return { runner, calls };
}

/** A Mastra-shaped stored `foreachOutput` entry. */
const okEntry = (item: string, output: unknown): Record<string, unknown> => ({
  status: 'success',
  output,
  payload: item,
  startedAt: STORED_AT,
  endedAt: STORED_AT + 1,
  suspendPayload: {},
});
const suspendedEntry = (item: string, suspendPayload: unknown): Record<string, unknown> => ({
  status: 'suspended',
  payload: item,
  startedAt: STORED_AT,
  suspendPayload,
  suspendedAt: STORED_AT + 2,
});

/** A stored suspended aggregate, as Mastra writes it (`:1432-1450`). */
function aggregate(items: readonly unknown[], foreachIndex: number, foreachOutput: readonly unknown[]): StepRecord {
  const lowest = foreachOutput[foreachIndex] as { suspendPayload?: object } | undefined;
  return {
    status: 'suspended',
    payload: items,
    startedAt: STORED_AT,
    suspendedAt: STORED_AT + 3,
    suspendPayload: { ...(lowest?.suspendPayload ?? {}), __workflow_meta: { foreachIndex, foreachOutput } },
  };
}

interface Resumed {
  readonly compiled: CompiledWorkflow;
  readonly seed: ForeachResume;
  readonly records: ReadonlyMap<string, StepRecord>;
  readonly runner: RecordingRunner;
  readonly aborted?: boolean;
  readonly site?: string;
}

const resumeRun = (r: Resumed): Promise<RunReport> => {
  const controller = new AbortController();
  if (r.aborted === true) controller.abort();
  return runWorkflowDetailed(r.compiled, 'init', {
    runner: r.runner,
    clock: new ManualClock(EPOCH),
    resume: { site: siteOf(r.compiled, r.site), value: r.seed },
    stepResults: r.records,
    ...(r.aborted === true ? { signal: controller.signal } : {}),
    timeoutMs: 10_000,
  });
};

/** Observes what the foreach puts on one exit, forwarding it unchanged (as foreach.test.ts's `tapped`). */
function tapped<K extends keyof Exits>(which: K) {
  const seen: unknown[] = [];
  const gadget: Gadget = (entry, next, ctx) => {
    const tap = place(ctx.names.reserve(`test.tap.${which}`, 'test observation tap')) as Exits[K];
    const result = foreachGadget(entry, next, { ...ctx, exits: { ...ctx.exits, [which]: tap } });
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

// ---------------------------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------------------------

describe('foreach resume: structure', () => {
  it('registers one foreach site at the foreach\'s top-level path, for the body id', () => {
    const compiled = build([{ kind: 'step', id: 'before' }, foreach(2)]);
    const site = siteOf(compiled, '1');
    expect([site.kind, site.path, site.stepId, site.place.name]).toStrictEqual(['foreach', [1], 'body', 's.1.items.resume']);
    expect([...compiled.resumeSites.keys()].sort()).toStrictEqual(['0', '1']);
  });

  it('gates the site on the cancel signal and sweeps it; nothing but a seed marks it', () => {
    const compiled = build([foreach(2)]);
    const byName = new Map([...compiled.net.transitions].map((t) => [t.name, t]));
    const gate = byName.get('t.0.items.re-enter')!;
    const sweep = byName.get('t.0.items.re-enter.cancel')!;
    expect(gate.inputSpecs.map((i) => [i.type, i.place.name])).toStrictEqual([['one', 's.0.items.resume']]);
    expect(gate.inhibitors.map((a) => a.place.name)).toStrictEqual(['wf.cancel']);
    expect(gate.reads).toStrictEqual([]);
    expect([...gate.outputPlaces()].map((p) => p.name).sort()).toStrictEqual(
      [
        's.0.items.frame',
        's.0.items.lane0.permit',
        's.0.items.lane1.permit',
        's.0.items.queue.open',
        's.0.items.queue.closed',
        's.0.items.no-fault',
        's.0.items.no-exit',
        's.0.items.no-susp',
        's.0.items.susp',
        'wf.settle.failed',
      ].sort(),
    );
    expect(sweep.inputSpecs.map((i) => [i.type, i.place.name])).toStrictEqual([['one', 's.0.items.resume']]);
    expect(sweep.reads.map((a) => a.place.name)).toStrictEqual(['wf.cancel']);
    expect([...sweep.outputPlaces()].map((p) => p.name)).toStrictEqual(['wf.canceled']);
    for (const t of compiled.net.transitions) {
      expect([...t.outputPlaces()].some((p) => p.name === 's.0.items.resume'), t.name).toBe(false);
    }
  });

  it('a carried suspension raises `susp` and leaves the queue open: only a settle of this segment kills it', () => {
    for (const lanes of [1, 2, 3]) {
      const compiled = build([foreach(lanes)]);
      const transitions = [...compiled.net.transitions];
      const gate = transitions.find((t) => t.name === 't.0.items.re-enter')!;
      // The four reopenings: the queue open or closed, `susp` on (a suspension stays) or off.
      if (gate.outputSpec?.type !== 'xor') throw new Error('re-enter must decide among reopenings');
      const branches = gate.outputSpec.children.map((c) => (c.type === 'and' ? c.children.map((x) => (x.type === 'place' ? x.place.name : '?')).filter((n) => /queue|susp/.test(n)).sort().join('+') : c.type === 'place' ? c.place.name : '?'));
      expect(branches, `lanes=${lanes}`).toStrictEqual([
        's.0.items.no-susp+s.0.items.queue.open',
        's.0.items.queue.open+s.0.items.susp',
        's.0.items.no-susp+s.0.items.queue.closed',
        's.0.items.queue.closed+s.0.items.susp',
        'wf.settle.failed',
      ]);
      // Who raises `susp`: the gate, and each lane's suspend settle — nothing a start reads.
      const raising = transitions.filter((t) => [...t.outputPlaces()].some((p) => p.name === 's.0.items.susp')).map((t) => t.name.replace('t.0.items.', '')).sort();
      expect(raising, `lanes=${lanes}`).toStrictEqual(
        ['re-enter', ...Array.from({ length: lanes }, (_, l) => ['', '.queue-closed', '.again', '.queue-closed.again'].map((v) => `lane${l}.suspend${v}`)).flat()].sort(),
      );
      for (const t of transitions.filter((x) => /\.lane\d+\.start$/.test(x.name))) {
        expect([...t.inputSpecs, ...t.reads, ...t.inhibitors].some((a) => /susp/.test(a.place.name)), t.name).toBe(false);
      }
    }
  });

  it('inhibitors: one per lane start, a constant number otherwise — none between lanes', () => {
    const inhibitors = (lanes: number): number =>
      [...build([foreach(lanes)]).net.transitions].reduce((n, t) => n + t.inhibitors.length, 0);
    // Every inhibitor is on the signal: split, each start, re-enter, and the ordinary finishers
    // (join, fail x4, exit x2, suspend); plus the top-level settle's own. None is on a lane's
    // outcome or a recorded one: precedence lives in the flags, which every arc takes one at a time.
    const baseline = inhibitors(1) - 1;
    for (const lanes of [2, 3, 4, 8]) expect(inhibitors(lanes) - lanes, `lanes=${lanes}`).toBe(baseline);
    for (const t of build([foreach(3)]).net.transitions) {
      for (const a of t.inhibitors) expect(a.place.name, t.name).toBe('wf.cancel');
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The seed: Mastra's classification, item by item
// ---------------------------------------------------------------------------------------------

describe('foreachSeed: control-flow.ts:1227-1270, item by item', () => {
  const site = siteOf(build([foreach(1)]));
  const none = new Map<string, StepRecord>();

  it('skips a success, runs a suspended item resumed and a never-started one fresh (no forEachIndex)', () => {
    const agg = aggregate(['a', 'b', 'c'], 1, [okEntry('a', 'a!'), suspendedEntry('b', { ask: 'b' })]);
    expect(foreachSeed(site, agg, none)).toStrictEqual({
      items: ['a', 'b', 'c'],
      order: [{ index: 1, resumed: true }, { index: 2 }],
      done: [{ index: 0, record: okEntry('a', 'a!') }],
      parked: [],
    });
  });

  it('with no forEachIndex, feeds every suspended item and resumeIndex, in index order', () => {
    // Items 0 and 2 suspended; resumeIndex 0 (the lowest). Item 1 was killed before it started.
    const agg = aggregate(['a', 'b', 'c'], 0, [suspendedEntry('a', 'pa'), undefined, suspendedEntry('c', 'pc')]);
    expect(foreachSeed(site, agg, none).order).toStrictEqual([
      { index: 0, resumed: true },
      { index: 1 },
      { index: 2, resumed: true },
    ]);
  });

  it('with forEachIndex, runs that item resumed and keeps every other suspension parked', () => {
    const agg = aggregate(['a', 'b', 'c', 'd'], 0, [suspendedEntry('a', 'pa'), okEntry('b', 'b!'), suspendedEntry('c', { ask: 'c' })]);
    const seed = foreachSeed(site, agg, none, 2);
    expect(seed.order).toStrictEqual([{ index: 2, resumed: true }, { index: 3 }]);
    expect(seed.done).toStrictEqual([{ index: 1, record: okEntry('b', 'b!') }]);
    expect(seed.parked).toStrictEqual([
      { stepId: 'body', path: [0], foreachIndex: 0, payload: 'pa', suspendedAt: STORED_AT + 2 } satisfies SuspendToken,
    ]);
  });

  it('with forEachIndex naming an item with no record, runs it resumed', () => {
    const agg = aggregate(['a', 'b'], 0, [suspendedEntry('a', 'pa')]);
    const seed = foreachSeed(site, agg, none, 1);
    expect(seed.order).toStrictEqual([{ index: 1, resumed: true }]);
    expect(seed.parked.map((p) => p.foreachIndex)).toStrictEqual([0]);
  });

  it('takes resumeIndex with `|| 0`, and only from a suspended aggregate', () => {
    // A stored foreachIndex of 2 on a suspended aggregate: item 2 has no record and is still fed.
    const suspended = aggregate(['a', 'b', 'c'], 2, [okEntry('a', 1), okEntry('b', 2)]);
    expect(foreachSeed(site, suspended, none).order).toStrictEqual([{ index: 2, resumed: true }]);
    // The same meta on an aggregate that is not suspended: resumeIndex is 0, which succeeded, so
    // item 2 runs fresh.
    const notSuspended = { ...suspended, status: 'success', output: [] } as unknown as StepRecord;
    expect(foreachSeed(site, notSuspended, none).order).toStrictEqual([{ index: 2 }]);
  });

  it('reads a JSON-stored array — holes as null — as items with no record', () => {
    const agg = aggregate(['a', 'b', 'c'], 0, JSON.parse(JSON.stringify([suspendedEntry('a', 'pa'), undefined, okEntry('c', 'c!')])));
    const seed = foreachSeed(site, agg, none, 0);
    expect(seed.order).toStrictEqual([{ index: 0, resumed: true }, { index: 1 }]);
    expect(seed.done.map((d) => d.index)).toStrictEqual([2]);
  });

  it('keeps a stored success entry verbatim as the done record, unknown fields included', () => {
    const entry = { ...okEntry('a', 'a!'), resumePayload: { ok: true }, resumedAt: STORED_AT + 9 };
    const seed = foreachSeed(site, aggregate(['a', 'b'], 1, [entry, suspendedEntry('b', 'pb')]), none);
    expect(seed.done).toStrictEqual([{ index: 0, record: entry }]);
  });

  it('refuses by name an aggregate with no payload, or one that cannot be iterated', () => {
    const { payload: _p, ...noPayload } = aggregate(['a'], 0, [suspendedEntry('a', 'pa')]) as StepRecord & { payload: unknown };
    expect(() => foreachSeed(site, noPayload as unknown as StepRecord, none)).toThrow(UnresumablePositionError);
    expect(() => foreachSeed(site, noPayload as unknown as StepRecord, none)).toThrow(/has no payload/);
    const nullItems = { ...aggregate(['a'], 0, []), payload: null } as StepRecord;
    try {
      foreachSeed(site, nullItems, none);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UnresumablePositionError);
      expect((error as UnresumablePositionError).reason).toBe('unsupported');
      expect((error as UnresumablePositionError).path).toStrictEqual([0]);
      expect((error as Error).message).toMatch(/cannot be iterated/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// A fresh run's aggregate: the meta a resume reads (row 35)
// ---------------------------------------------------------------------------------------------

describe('foreach: the suspended and failed aggregates carry Mastra\'s __workflow_meta', () => {
  it('suspended: foreachIndex is the lowest suspended item, foreachOutput every settled item, success entries cleared', async () => {
    const s = tapped('suspended');
    const { runner } = itemRunner((label) =>
      label === 'b' ? { status: 'suspended', suspendPayload: { ask: 'b' } } : { status: 'success', output: `${label}!` },
    );
    const report = await runWorkflowDetailed(build([foreach(1)], s.gadget), ['a', 'b', 'c'], {
      runner,
      clock: new ManualClock(EPOCH),
      timeoutMs: 10_000,
    });
    expect(report.outcome).toStrictEqual({ status: 'suspended', stepId: 'body', path: [0], foreachIndex: 1, payload: { ask: 'b' } });
    const foreachOutput = [
      { status: 'success', output: 'a!', payload: 'a', startedAt: EPOCH, endedAt: EPOCH, suspendPayload: {} },
      { status: 'suspended', suspendPayload: { ask: 'b' }, payload: 'b', startedAt: EPOCH, suspendedAt: EPOCH },
    ];
    expect(report.stepResults.get('body')).toStrictEqual({
      status: 'suspended',
      payload: ['a', 'b', 'c'],
      startedAt: EPOCH,
      suspendedAt: EPOCH,
      suspendPayload: { ask: 'b', __workflow_meta: { foreachIndex: 1, foreachOutput } },
    });
    expect(s.seen).toStrictEqual([
      {
        stepId: 'body',
        path: [0],
        foreachIndex: 1,
        payload: { ask: 'b' },
        suspendedAt: EPOCH,
        foreach: { foreachIndex: 1, foreachOutput: foreachOutput.map((record, index) => ({ index, record })) },
      },
    ]);
  });

  it('suspended with two lanes: the lower index reports, both suspensions are listed', async () => {
    const { runner } = itemRunner((label) => (label === 'x' ? { status: 'success', output: 'x!' } : { status: 'suspended', suspendPayload: `p-${label}` }));
    const report = await runWorkflowDetailed(build([foreach(2)]), ['a', 'b', 'x'], { runner, clock: new ManualClock(EPOCH), timeoutMs: 10_000 });
    expect(report.outcome).toMatchObject({ status: 'suspended', foreachIndex: 0, payload: 'p-a' });
    const meta = (report.stepResults.get('body') as { suspendPayload: { __workflow_meta: { foreachIndex: number; foreachOutput: unknown[] } } })
      .suspendPayload.__workflow_meta;
    expect(meta.foreachIndex).toBe(0);
    // `x` never started: the queue was killed by the first suspension (`:1141`). A hole, not an entry.
    expect(meta.foreachOutput.length).toBe(2);
    expect(meta.foreachOutput.map((e) => (e as { status: string }).status)).toStrictEqual(['suspended', 'suspended']);
    // A primitive suspend payload spreads as JS spreads it (`{...'p-a'}`), exactly as Mastra's does.
    expect((report.stepResults.get('body') as { suspendPayload: Record<string, unknown> }).suspendPayload).toMatchObject({ 0: 'p', 1: '-', 2: 'a' });
  });

  it('failed: the failing item\'s own record, plus foreachOutput of every settled item', async () => {
    const f = tapped('failed');
    const { runner } = itemRunner((label) => (label === 'b' ? { status: 'failed', error: 'boom' } : { status: 'success', output: `${label}!` }));
    const report = await runWorkflowDetailed(build([foreach(1)], f.gadget), ['a', 'b', 'c'], {
      runner,
      clock: new ManualClock(EPOCH),
      timeoutMs: 10_000,
    });
    expect(report.outcome).toStrictEqual({ status: 'failed', stepId: 'body', path: [0], foreachIndex: 1, error: 'boom' });
    const foreachOutput = [
      { status: 'success', output: 'a!', payload: 'a', startedAt: EPOCH, endedAt: EPOCH, suspendPayload: {} },
      { status: 'failed', error: 'boom', payload: 'b', startedAt: EPOCH, endedAt: EPOCH, suspendPayload: {} },
    ];
    expect(report.stepResults.get('body')).toStrictEqual({
      status: 'failed',
      error: 'boom',
      payload: 'b',
      startedAt: EPOCH,
      endedAt: EPOCH,
      metadata: { foreachIndex: 1 },
      suspendPayload: { __workflow_meta: { foreachOutput } },
    });
    expect((f.seen[0] as { foreach: unknown }).foreach).toStrictEqual({
      foreachIndex: 1,
      foreachOutput: foreachOutput.map((record, index) => ({ index, record })),
    });
  });

  it('a success aggregate is unchanged: no meta', async () => {
    const { runner } = itemRunner();
    const report = await runWorkflowDetailed(build([foreach(2)]), ['a', 'b'], { runner, clock: new ManualClock(EPOCH), timeoutMs: 10_000 });
    expect(report.stepResults.get('body')).toStrictEqual({
      status: 'success',
      output: ['a!', 'b!'],
      payload: ['a', 'b'],
      startedAt: EPOCH,
      endedAt: EPOCH,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Resumed segments
// ---------------------------------------------------------------------------------------------

describe('foreach resume: a seeded segment runs exactly the items Mastra re-runs', () => {
  it('skips the succeeded item, feeds the suspended one, runs the killed one fresh, and succeeds with the whole array', async () => {
    const compiled = build([foreach(1)]);
    const agg = aggregate(['a', 'b', 'c'], 1, [okEntry('a', 'a!'), suspendedEntry('b', { ask: 'b' })]);
    const seed = foreachSeed(siteOf(compiled), agg, new Map());
    const { runner, calls } = itemRunner();
    const report = await resumeRun({ compiled, seed, records: new Map([['body', agg]]), runner });

    expect(report.outcome).toStrictEqual({ status: 'success', output: ['a!', 'b!', 'c!'] });
    expect(calls).toStrictEqual([
      { item: 'b', index: 1, resumed: true, attempt: 0 },
      { item: 'c', index: 2, resumed: false, attempt: 0 },
    ]);
    // `{...stepInfo, status, output, endedAt}`: the stored aggregate's payload and start, kept.
    expect(report.stepResults.get('body')).toStrictEqual({
      status: 'success',
      output: ['a!', 'b!', 'c!'],
      payload: ['a', 'b', 'c'],
      startedAt: STORED_AT,
      endedAt: EPOCH,
    });
  });

  it('keeps a parked suspension: the named item succeeds, the foreach suspends again at the parked item', async () => {
    const compiled = build([foreach(2)]);
    const stored = [suspendedEntry('a', { ask: 'a' }), okEntry('b', 'b!'), suspendedEntry('c', { ask: 'c' })];
    const agg = aggregate(['a', 'b', 'c', 'd'], 0, stored);
    const seed = foreachSeed(siteOf(compiled), agg, new Map(), 2);
    const { runner, calls } = itemRunner();
    const report = await resumeRun({ compiled, seed, records: new Map([['body', agg]]), runner });

    expect(calls.map((c) => [c.item, c.resumed])).toStrictEqual([
      ['c', true],
      ['d', false],
    ]);
    expect(report.outcome).toStrictEqual({ status: 'suspended', stepId: 'body', path: [0], foreachIndex: 0, payload: { ask: 'a' } });
    const record = report.stepResults.get('body') as StepRecord & { suspendPayload: { __workflow_meta: { foreachIndex: number; foreachOutput: unknown[] } } };
    expect(record.status).toBe('suspended');
    expect(record.payload).toStrictEqual(['a', 'b', 'c', 'd']);
    expect(record.startedAt).toBe(STORED_AT);
    expect(record.suspendPayload.__workflow_meta.foreachIndex).toBe(0);
    const out = record.suspendPayload.__workflow_meta.foreachOutput as Record<string, unknown>[];
    // The parked item's entry is the stored one, verbatim; the reused success likewise.
    expect(out[0]).toStrictEqual(stored[0]);
    expect(out[1]).toStrictEqual(stored[1]);
    expect(out.slice(2).map((e) => [e['status'], e['output']])).toStrictEqual([
      ['success', 'c!'],
      ['success', 'd!'],
    ]);
  });

  it('a resumed item that suspends again re-suspends the foreach at the lowest index, parked or new', async () => {
    const compiled = build([foreach(1)]);
    const agg = aggregate(['a', 'b'], 0, [suspendedEntry('a', 'pa'), suspendedEntry('b', 'pb')]);
    const seed = foreachSeed(siteOf(compiled), agg, new Map(), 1);
    const { runner } = itemRunner(() => ({ status: 'suspended', suspendPayload: 'again' }));
    const report = await resumeRun({ compiled, seed, records: new Map([['body', agg]]), runner });
    expect(report.outcome).toStrictEqual({ status: 'suspended', stepId: 'body', path: [0], foreachIndex: 0, payload: 'pa' });
  });

  it('a new failure outranks the carried suspensions, and its aggregate lists them', async () => {
    const compiled = build([foreach(1)]);
    const stored = [suspendedEntry('a', 'pa'), suspendedEntry('b', 'pb')];
    const agg = aggregate(['a', 'b'], 0, stored);
    const seed = foreachSeed(siteOf(compiled), agg, new Map(), 1);
    const { runner } = itemRunner(() => ({ status: 'failed', error: 'late' }));
    const report = await resumeRun({ compiled, seed, records: new Map([['body', agg]]), runner });
    expect(report.outcome).toStrictEqual({ status: 'failed', stepId: 'body', path: [0], foreachIndex: 1, error: 'late' });
    const out = (report.stepResults.get('body') as unknown as { suspendPayload: { __workflow_meta: { foreachOutput: Record<string, unknown>[] } } })
      .suspendPayload.__workflow_meta.foreachOutput;
    expect(out[0]).toStrictEqual(stored[0]);
    expect(out[1]).toMatchObject({ status: 'failed', error: 'late', suspendPayload: {} });
  });

  it('a new suspension kills the queue; a carried one did not', async () => {
    // No forEachIndex: a (0) and c (2) are fed; b (1) is queued fresh between them. a suspends
    // again, which kills the queue: b and c never start.
    const compiled = build([foreach(1)]);
    const agg = aggregate(['a', 'b', 'c'], 0, [suspendedEntry('a', 'pa'), undefined, suspendedEntry('c', 'pc')]);
    const seed = foreachSeed(siteOf(compiled), agg, new Map());
    const { runner, calls } = itemRunner(() => ({ status: 'suspended', suspendPayload: 'again' }));
    const report = await resumeRun({ compiled, seed, records: new Map([['body', agg]]), runner });
    expect(calls.map((c) => c.item)).toStrictEqual(['a']);
    expect(report.outcome).toStrictEqual({ status: 'suspended', stepId: 'body', path: [0], foreachIndex: 0, payload: 'again' });
    // Mastra's `prevForeachOutput[2]` stays the stored entry: the killed item never overwrote it.
    const out = (report.stepResults.get('body') as unknown as { suspendPayload: { __workflow_meta: { foreachOutput: unknown[] } } })
      .suspendPayload.__workflow_meta.foreachOutput;
    expect(out[2]).toStrictEqual(suspendedEntry('c', 'pc'));
  });

  it('feeds a retried resumed item on every attempt, and no other item', async () => {
    const compiled = build([foreach(1, body({ retries: 2 }))]);
    const agg = aggregate(['a', 'b'], 0, [suspendedEntry('a', 'pa')]);
    const seed = foreachSeed(siteOf(compiled), agg, new Map());
    let failures = 0;
    const { runner, calls } = itemRunner((label) =>
      label === 'a' && failures++ < 2 ? { status: 'failed', error: 'flaky' } : { status: 'success', output: `${label}!` },
    );
    const report = await resumeRun({ compiled, seed, records: new Map([['body', agg]]), runner });
    expect(report.outcome).toStrictEqual({ status: 'success', output: ['a!', 'b!'] });
    expect(calls.map((c) => [c.item, c.attempt, c.resumed])).toStrictEqual([
      ['a', 0, true],
      ['a', 1, true],
      ['a', 2, true],
      ['b', 0, false],
    ]);
  });

  it('runs the queue across lanes, fed items flagged, results in input order', async () => {
    const compiled = build([foreach(3)]);
    const agg = aggregate(['a', 'b', 'c', 'd', 'e'], 1, [okEntry('a', 'a!'), suspendedEntry('b', 'pb'), undefined, okEntry('d', 'd!')]);
    const seed = foreachSeed(siteOf(compiled), agg, new Map());
    const { runner, calls } = itemRunner();
    const report = await resumeRun({ compiled, seed, records: new Map([['body', agg]]), runner });
    expect(report.outcome).toStrictEqual({ status: 'success', output: ['a!', 'b!', 'c!', 'd!', 'e!'] });
    expect(calls.map((c) => [c.item, c.resumed]).sort()).toStrictEqual([
      ['b', true],
      ['c', false],
      ['e', false],
    ]);
  });

  it('a resume that arrives canceled never re-enters: nothing runs, canceled at the foreach, not started', async () => {
    const compiled = build([foreach(2)]);
    const agg = aggregate(['a', 'b'], 0, [suspendedEntry('a', 'pa')]);
    const seed = foreachSeed(siteOf(compiled), agg, new Map());
    const { runner, calls } = itemRunner();
    const report = await resumeRun({ compiled, seed, records: new Map([['body', agg]]), runner, aborted: true });
    expect(calls).toStrictEqual([]);
    expect(report.outcome).toStrictEqual({ status: 'canceled', origin: { stepId: 'body', path: [0] }, started: false });
    // The stored aggregate is untouched: Mastra writes no result for an entry it never started.
    expect(report.stepResults.get('body')).toStrictEqual(agg);
  });

  it('a seed that does not fit the stored items fails the run by name, stranding nothing', async () => {
    const compiled = build([foreach(2)]);
    const bad: ForeachResume = { items: ['a'], order: [{ index: 0 }, { index: 0, resumed: true }], done: [], parked: [] };
    const { runner, calls } = itemRunner();
    const report = await resumeRun({ compiled, seed: bad, records: new Map(), runner });
    expect(calls).toStrictEqual([]);
    expect(report.outcome).toMatchObject({ status: 'failed', stepId: 'body', path: [0] });
    expect(Object.keys(report.outcome).sort()).toStrictEqual(['error', 'path', 'status', 'stepId']);
    expect(String((report.outcome as { error: unknown }).error)).toMatch(/cannot resume from this seed: item 0 is listed twice/);
  });

  it('continues past the foreach to the entries after it', async () => {
    const compiled = build([foreach(1), { kind: 'step', id: 'after' }]);
    const agg = aggregate(['a', 'b'], 1, [okEntry('a', 'a!'), suspendedEntry('b', 'pb')]);
    const seed = foreachSeed(siteOf(compiled), agg, new Map());
    const { runner } = itemRunner();
    const report = await resumeRun({ compiled, seed, records: new Map([['body', agg]]), runner });
    expect(report.outcome).toStrictEqual({ status: 'success', output: ['a!', 'b!'] });
    expect(runner.calls).toStrictEqual(['body', 'after']);
  });
});

describe('foreach resume: the aggregate and its entries, from the stored aggregate and the item records', () => {
  type Meta = { readonly foreachIndex?: number; readonly foreachOutput: unknown[] };
  const metaOf = (report: RunReport): Meta =>
    (report.stepResults.get('body') as unknown as { suspendPayload: { __workflow_meta: Meta } }).suspendPayload.__workflow_meta;

  it("a string input stays the aggregate's payload: the frame's input is the stored payload, not the seed's items", async () => {
    const compiled = build([foreach(1)]);
    // `.foreach()` over 'ab' iterates its code units (`itemsOf`); the stored payload is the string.
    const agg = aggregate('ab' as unknown as readonly unknown[], 1, [okEntry('a', 'a!'), suspendedEntry('b', { ask: 'b' })]);
    const seed = foreachSeed(siteOf(compiled), agg, new Map());
    expect(seed.items).toStrictEqual(['a', 'b']);
    const { runner } = itemRunner();
    const report = await resumeRun({ compiled, seed, records: new Map([['body', agg]]), runner });
    expect(report.outcome).toStrictEqual({ status: 'success', output: ['a!', 'b!'] });
    expect(report.stepResults.get('body')).toStrictEqual({
      status: 'success',
      output: ['a!', 'b!'],
      payload: 'ab',
      startedAt: STORED_AT,
      endedAt: EPOCH,
    });
  });

  it("a resumed item that fails: the failed aggregate is its own record, so it and its entry agree on payload and start (control-flow.ts:1360-1370)", async () => {
    const compiled = build([foreach(1)]);
    const agg = aggregate('ab' as unknown as readonly unknown[], 1, [okEntry('a', 'a!'), suspendedEntry('b', { ask: 'b' })]);
    const seed = foreachSeed(siteOf(compiled), agg, new Map());
    // Recorded as resumed (truthy resume data): the leaf keeps the stored record's payload and
    // start, as Mastra's resumed item spreads `stepResults[step.id]` — the aggregate.
    const { runner } = itemRunner((_label, call) =>
      call.resumed === true ? { status: 'failed', error: 'late', resumedAt: EPOCH } : { status: 'success', output: 'x' },
    );
    const report = await resumeRun({ compiled, seed, records: new Map([['body', agg]]), runner });
    expect(report.outcome).toStrictEqual({ status: 'failed', stepId: 'body', path: [0], foreachIndex: 1, error: 'late' });
    const foreachOutput = [
      okEntry('a', 'a!'),
      { status: 'failed', error: 'late', payload: 'ab', startedAt: STORED_AT, endedAt: EPOCH, suspendPayload: {} },
    ];
    expect(report.stepResults.get('body')).toStrictEqual({
      status: 'failed',
      error: 'late',
      payload: 'ab',
      startedAt: STORED_AT,
      endedAt: EPOCH,
      metadata: { foreachIndex: 1 },
      suspendPayload: { __workflow_meta: { foreachOutput } },
    });
  });

  it('a hand-built seed: a succeeded item and a parked one with no stored entry are written into foreachOutput', async () => {
    const compiled = build([foreach(1)]);
    // The stored aggregate lists item 0 only; the seed names item 1 done and item 2 parked.
    const agg = aggregate(['a', 'b', 'c'], 0, [suspendedEntry('a', { ask: 'a' })]);
    const done: StepRecord = { status: 'success', output: 'b!', payload: 'b', startedAt: STORED_AT, endedAt: STORED_AT + 1 };
    const parked: SuspendToken = { stepId: 'body', path: [0], foreachIndex: 2, payload: { ask: 'c' }, suspendedAt: STORED_AT + 2 };
    const seed: ForeachResume = { items: ['a', 'b', 'c'], order: [{ index: 0, resumed: true }], done: [{ index: 1, record: done }], parked: [parked] };
    const { runner, calls } = itemRunner();
    const report = await resumeRun({ compiled, seed, records: new Map([['body', agg]]), runner });
    expect(calls.map((c) => [c.item, c.resumed])).toStrictEqual([['a', true]]);
    expect(report.outcome).toStrictEqual({ status: 'suspended', stepId: 'body', path: [0], foreachIndex: 2, payload: { ask: 'c' } });
    expect(metaOf(report)).toStrictEqual({
      foreachIndex: 2,
      foreachOutput: [
        { status: 'success', output: 'a!', payload: 'a', startedAt: EPOCH, endedAt: EPOCH, suspendPayload: {} },
        { ...done, suspendPayload: {} },
        { status: 'suspended', suspendPayload: { ask: 'c' }, suspendedAt: STORED_AT + 2 },
      ],
    });
  });

  it("an entry is the item's record as the host holds it: host-only fields and metadata kept, the engine's foreachIndex dropped", async () => {
    const { runner } = itemRunner((label) =>
      label === 'b'
        ? { status: 'suspended', suspendPayload: { ask: 'b' } }
        : { status: 'success', output: `${label}!`, host: { status: 'success', output: 'stale', metadata: { nestedRunId: 'run-a' }, resumePayload: 'go' } },
    );
    const report = await runWorkflowDetailed(build([foreach(1)]), ['a', 'b'], { runner, clock: new ManualClock(EPOCH), timeoutMs: 10_000 });
    expect(metaOf(report).foreachOutput[0]).toStrictEqual({
      resumePayload: 'go',
      status: 'success',
      output: 'a!',
      payload: 'a',
      startedAt: EPOCH,
      endedAt: EPOCH,
      metadata: { nestedRunId: 'run-a' },
      suspendPayload: {},
    });
  });

  it("the stored aggregate's resumePayload and resumedAt are not carried into this segment's aggregate", async () => {
    const compiled = build([foreach(1)]);
    const agg = { ...aggregate(['a', 'b'], 1, [okEntry('a', 'a!'), suspendedEntry('b', 'pb')]), resumePayload: { old: 1 }, resumedAt: STORED_AT + 5 } as unknown as StepRecord;
    const seed = foreachSeed(siteOf(compiled), agg, new Map());
    const { runner } = itemRunner();
    const report = await resumeRun({ compiled, seed, records: new Map([['body', agg]]), runner });
    expect(report.stepResults.get('body')).toStrictEqual({ status: 'success', output: ['a!', 'b!'], payload: ['a', 'b'], startedAt: STORED_AT, endedAt: EPOCH });
  });
});

describe('foreach resume: suspend on this engine, resume on this engine, from the records alone', () => {
  it.for([1, 2, 3])('round trip at %i lane(s): the second segment runs only what did not succeed', async (lanes) => {
    const compiled = build([foreach(lanes), { kind: 'step', id: 'after' }]);
    const items = ['a', 'b', 'c', 'd'];
    // First segment: b suspends; with one lane c and d are killed, with more some may have run.
    const first = itemRunner((label) => (label === 'b' ? { status: 'suspended', suspendPayload: { ask: label } } : { status: 'success', output: `${label}!` }));
    const one = await runWorkflowDetailed(compiled, items, { runner: first.runner, clock: new ManualClock(EPOCH), timeoutMs: 10_000 });
    expect(one.outcome).toMatchObject({ status: 'suspended', stepId: 'body', path: [0], foreachIndex: 1 });

    // Second segment: seeded from the first segment's records only, as a resume is.
    const records = one.stepResults;
    const seed = foreachSeed(siteOf(compiled), records.get('body')!, records);
    const ranBefore = new Set(first.calls.filter((c) => c.item !== 'b').map((c) => c.item));
    expect(seed.done.map((d) => items[d.index]).sort()).toStrictEqual([...ranBefore].sort());
    expect(seed.order.filter((o) => o.resumed === true).map((o) => o.index)).toStrictEqual([1]);

    const second = itemRunner((label, call) => ({ status: 'success', output: call.resumed === true ? `${label}+` : `${label}!` }));
    const two = await resumeRun({ compiled, seed, records, runner: second.runner });
    expect(two.outcome).toStrictEqual({ status: 'success', output: ['a!', 'b+', 'c!', 'd!'] });
    expect(second.calls.map((c) => c.item).sort()).toStrictEqual(items.filter((i) => i === 'b' || !ranBefore.has(i)).sort());
    expect(second.runner.calls.at(-1)).toBe('after');
  });
});

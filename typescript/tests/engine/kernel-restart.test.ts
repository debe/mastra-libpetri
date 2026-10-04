import { describe, expect, it } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { restartSeed } from '../../src/compiler/restart.js';
import { initialMarking, runWorkflowDetailed } from '../../src/engine/kernel.js';
import { restartSegment, segmentInitialMarking } from '../../src/verify/index.js';
import type {
  CheckpointEvent,
  CompiledWorkflow,
  EntryDescription,
  FlowToken,
  StepRecord,
  WorkflowDescription,
} from '../../src/compiler/types.js';
import type { RestartSeed } from '../../src/compiler/restart.js';
import { RecordingRunner } from '../fixtures/runner.js';
import { ManualClock } from '../support/manual-clock.js';

/**
 * The kernel's half of a restarted segment ([ADR 0010]): `RunOptions.restart` seeds one `FlowToken`
 * at a top-level boundary **instead of** the entry place, checked by identity against
 * `compiled.boundaries`, with the permits and a pre-aborted signal exactly as for a fresh run — the
 * marking `restart@p` is proven from (`tests/verify/restart-segments.test.ts`). Exclusive with
 * `resume`. A workflow that marks checkpoints is refused, by name, when its runner cannot write one;
 * a write that rejects ends the run as a failed firing (`stranded`) and the report keeps the
 * original error object for the engine to reject with.
 *
 * The checkpoint tests compile marked workflows, so they need M4b W1's compiler
 * (`compile({checkpoints})`); they are skipped, and say so, on a tree where it refuses them.
 */

const EPOCH = 1_700_000_000_000;
const chain: readonly EntryDescription[] = [
  { kind: 'step', id: 'a' },
  { kind: 'step', id: 'b' },
  { kind: 'step', id: 'c' },
];
const fanThenZ: readonly EntryDescription[] = [
  { kind: 'step', id: 'a' },
  { kind: 'parallel', id: 'fan', arms: [{ kind: 'step', id: 'x' }, { kind: 'step', id: 'y' }] },
  { kind: 'step', id: 'z' },
];
const build = (id: string, entries: readonly EntryDescription[], extra: Partial<WorkflowDescription> = {}, k?: number): CompiledWorkflow =>
  compile({ id, entries, ...extra }, k === undefined ? {} : { concurrency: k });
const seedAt = (c: CompiledWorkflow, p: number, input: unknown): RestartSeed => restartSeed(c, { activePaths: [p], records: new Map(), input });
const counts = (m: Map<{ name: string }, readonly unknown[]>): Record<string, number> =>
  Object.fromEntries([...m].map(([p, tokens]) => [p.name, tokens.length]));
const record = (output: unknown): StepRecord => ({ status: 'success', payload: output, output, startedAt: EPOCH, endedAt: EPOCH });

/** Whether this tree's compiler emits checkpoints (M4b W1). */
const checkpointsCompile = ((): boolean => {
  try {
    compile({ id: 'probe', entries: chain, checkpoints: [0] });
    return true;
  } catch {
    return false;
  }
})();

describe('a restarted segment is seeded at a boundary', () => {
  it.each([undefined, 2])('seeds one FlowToken at boundary p instead of the entry place (k=%s) — the restart@p marking', (k) => {
    const c = build('chain', chain, {}, k);
    for (const p of [0, 1, 2]) {
      const seed = seedAt(c, p, { from: p });
      const marking = initialMarking(c, { init: 1 }, { restart: seed });
      const proven = Object.fromEntries([...segmentInitialMarking(c, restartSegment(p, false))].map(([pl, n]) => [pl.name, n]));
      expect(counts(marking)).toEqual(proven);
      expect(counts(marking)).toEqual({ [c.boundaries[p]!.place.name]: 1, ...(k === undefined ? {} : { 'wf.permits': k }) });
      // The seed's value as it is — the kernel neither wraps nor rebuilds it.
      expect(marking.get(c.boundaries[p]!.place)?.[0]?.value).toBe(seed.value);
      if (p > 0) expect(marking.has(c.entryPlace)).toBe(false);
    }
  });

  it('refuses a boundary from another compile of the same workflow, by identity', () => {
    const c = build('chain', chain);
    const other = build('chain', chain);
    expect(() => initialMarking(c, null, { restart: seedAt(other, 1, null) })).toThrow(
      "compiled workflow 'chain': the restart boundary at 1 ('b') is not the one this workflow registered there",
    );
    // A forged site with the right index and place, but not the registered object.
    const forged: RestartSeed = { site: { ...c.boundaries[1]! }, value: { data: null } };
    expect(() => initialMarking(c, null, { restart: forged })).toThrow(/is not the one this workflow registered there/);
  });

  it('refuses a run that is both resumed and restarted, before anything runs', async () => {
    const c = build('chain', chain);
    const site = c.resumeSites.get('1');
    if (site === undefined || site.kind !== 'entry') throw new Error('expected an entry site at 1');
    const resume = { site, value: { data: 1 } as FlowToken };
    const runner = new RecordingRunner();
    const message = "compiled workflow 'chain': a run is either resumed or restarted, not both";
    expect(() => initialMarking(c, null, { resume, restart: seedAt(c, 1, 1) })).toThrow(message);
    await expect(runWorkflowDetailed(c, null, { runner, resume, restart: seedAt(c, 1, 1) })).rejects.toThrow(message);
    expect(runner.calls).toEqual([]);
  });

  it('refuses a seed that is not a FlowToken', () => {
    const c = build('chain', chain);
    const bad = { site: c.boundaries[1]!, value: null as unknown as FlowToken };
    expect(() => initialMarking(c, null, { restart: bad })).toThrow(
      "compiled workflow 'chain': the seed at restart boundary 1 ('s.1.b.in') is not a FlowToken: a non-null object with `data`",
    );
  });

  it('runs from the boundary: the entries before it never run, the carried-in records survive', async () => {
    const c = build('chain', chain, {}, 2);
    const runner = new RecordingRunner({ steps: { b: (input) => ({ status: 'success', output: { b: input } }) } });
    const report = await runWorkflowDetailed(c, { init: 1 }, {
      runner,
      clock: new ManualClock(EPOCH),
      restart: seedAt(c, 1, 'from-a'),
      stepResults: new Map([['a', record('from-a')]]),
    });
    expect(report.outcome).toEqual({ status: 'success', output: { b: 'from-a' } });
    expect(runner.calls).toEqual(['b', 'c']);
    expect([...report.stepResults.keys()]).toEqual(['a', 'b', 'c']);
    expect(report.stepResults.get('a')).toEqual(record('from-a'));
    expect(report.checkpointError).toBeUndefined();
  });

  it('restarting at a parallel re-runs every arm, completed ones included', async () => {
    const c = build('fan', fanThenZ);
    const runner = new RecordingRunner();
    const report = await runWorkflowDetailed(c, 'in', { runner, restart: seedAt(c, 1, 'after-a'), stepResults: new Map([['x', record('old-x')]]) });
    expect(report.outcome).toEqual({ status: 'success', output: { x: 'after-a', y: 'after-a' } });
    expect([...runner.calls].sort()).toEqual(['x', 'y', 'z']);
  });

  it('restarting at 0 is the fresh run on the stored input', async () => {
    const c = build('chain', chain);
    const runner = new RecordingRunner();
    expect((await runWorkflowDetailed(c, 'ignored', { runner, restart: seedAt(c, 0, 'stored') })).outcome).toEqual({ status: 'success', output: 'stored' });
    expect(runner.calls).toEqual(['a', 'b', 'c']);
  });

  it('a pre-aborted restart is canceled before its first entry starts, as a pre-aborted resume is', async () => {
    const c = build('chain', chain, {}, 1);
    const controller = new AbortController();
    controller.abort();
    const runner = new RecordingRunner();
    const marking = initialMarking(c, null, { restart: seedAt(c, 2, 'x'), signal: controller.signal });
    expect(counts(marking)).toEqual({ 's.2.c.in': 1, 'wf.cancel': 1, 'wf.permits': 1 });
    const report = await runWorkflowDetailed(c, null, { runner, restart: seedAt(c, 2, 'x'), signal: controller.signal, timeoutMs: 10_000 });
    expect(report.outcome).toMatchObject({ status: 'canceled', started: false });
    expect(report.outcome).not.toHaveProperty('residue');
    expect(runner.calls).toEqual([]);
  });
});

describe.skipIf(!checkpointsCompile)('checkpoints at run time (needs M4b W1: compile({checkpoints}))', () => {
  class CheckpointingRunner extends RecordingRunner {
    readonly events: CheckpointEvent[] = [];
    constructor(private readonly write: (event: CheckpointEvent) => Promise<void> = async () => {}) {
      super();
    }
    async checkpoint(event: CheckpointEvent): Promise<void> {
      this.calls.push(`checkpoint@${event.after}`);
      this.events.push(event);
      return this.write(event);
    }
  }

  it('a marked workflow run with a runner that has no checkpoint() is refused before anything runs, by name', async () => {
    const c = build('marked', chain, { checkpoints: [0, 1] });
    const runner = new RecordingRunner();
    await expect(runWorkflowDetailed(c, 1, { runner })).rejects.toThrow(
      "compiled workflow 'marked' takes checkpoints after entries [0, 1], and its runner has no checkpoint()",
    );
    expect(runner.calls).toEqual([]);
    // The same workflow unmarked runs with that runner.
    expect((await runWorkflowDetailed(build('plain', chain), 1, { runner })).outcome).toEqual({ status: 'success', output: 1 });
  });

  it('the write is awaited between the two entries, with the records so far', async () => {
    const c = build('marked', chain, { checkpoints: [1] });
    const runner = new CheckpointingRunner();
    const report = await runWorkflowDetailed(c, 'v', { runner });
    expect(report.outcome).toEqual({ status: 'success', output: 'v' });
    expect(runner.calls).toEqual(['a', 'b', 'checkpoint@1', 'c']);
    expect(runner.events.map((e) => [e.after, [...e.records.keys()]])).toEqual([[1, ['a', 'b']]]);
    expect(report.checkpointError).toBeUndefined();
  });

  it('a rejected write fails its firing: the run is stranded and the report keeps the original error object', async () => {
    const c = build('marked', chain, { checkpoints: [0] });
    const storage = new Error('storage down');
    const runner = new CheckpointingRunner(async () => {
      throw storage;
    });
    const report = await runWorkflowDetailed(c, 'v', { runner });
    expect(report.outcome.status).toBe('stranded');
    if (report.outcome.status !== 'stranded') return;
    expect(report.outcome.failure).toMatchObject({ transition: 't.0.checkpoint', message: 'storage down' });
    expect(report.checkpointError?.error).toBe(storage);
    // Entry 1 never started: the row was never durable, so nothing after it ran.
    expect(runner.calls).toEqual(['a', 'checkpoint@0']);
  });

  it('a write that throws synchronously is kept the same way', async () => {
    const c = build('marked', chain, { checkpoints: [0] });
    const thrown = new TypeError('sync');
    const runner = new RecordingRunner() as RecordingRunner & { checkpoint(event: CheckpointEvent): Promise<void> };
    runner.checkpoint = () => {
      throw thrown;
    };
    const report = await runWorkflowDetailed(c, 'v', { runner });
    expect(report.outcome.status).toBe('stranded');
    expect(report.checkpointError?.error).toBe(thrown);
  });

  it('only the first rejection is kept, and a write that never rejects leaves no checkpointError', async () => {
    const c = build('marked', fanThenZ, { checkpoints: [0, 1] });
    const first = new Error('first');
    let n = 0;
    const runner = new CheckpointingRunner(async () => {
      n++;
      if (n === 1) throw first;
      throw new Error('never reached');
    });
    const report = await runWorkflowDetailed(c, 'v', { runner });
    expect(report.checkpointError?.error).toBe(first);
    expect(n).toBe(1);
  });

  it('a restart from the boundary after a checkpoint runs the rest and writes the later checkpoints', async () => {
    const c = build('marked', chain, { checkpoints: [0, 1] });
    const runner = new CheckpointingRunner();
    const report = await runWorkflowDetailed(c, null, { runner, restart: seedAt(c, 1, 'after-a'), stepResults: new Map([['a', record('after-a')]]) });
    expect(report.outcome).toEqual({ status: 'success', output: 'after-a' });
    expect(runner.calls).toEqual(['b', 'checkpoint@1', 'c']);
  });

  it('a cancel that arrived before the checkpoint takes no write and ends canceled', async () => {
    const c = build('marked', chain, { checkpoints: [0] });
    const controller = new AbortController();
    const runner = new CheckpointingRunner();
    const aborting = new RecordingRunner({
      a: (input) => {
        controller.abort();
        return { status: 'success', output: input };
      },
    });
    const both = Object.assign(aborting, { checkpoint: runner.checkpoint.bind(runner) });
    const report = await runWorkflowDetailed(c, 'v', { runner: both, signal: controller.signal, timeoutMs: 10_000 });
    expect(report.outcome).toMatchObject({ status: 'canceled' });
    expect(report.outcome).not.toHaveProperty('residue');
    expect(runner.events).toEqual([]);
  });
});

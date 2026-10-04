import { describe, expect, it } from 'vitest';
import type { Transition } from 'libpetri';
import { compile } from '../../src/compiler/index.js';
import { runWorkflow, runWorkflowDetailed } from '../../src/engine/index.js';
import { describeClaim, segmentLabel, verify, type VerificationReport } from '../../src/verify/index.js';
import type {
  CheckpointEvent,
  CompiledWorkflow,
  EntryDescription,
  StepDescription,
  WorkflowDescription,
} from '../../src/compiler/types.js';
import { RecordingRunner, type RecordingRunnerOptions } from '../fixtures/runner.js';

/**
 * Checkpoints in the net ([ADR 0010], M4b W1): the place, the write and its cancel sweep after each
 * marked top-level entry; an unmarked description compiles to exactly the net it compiled to before
 * checkpoints existed.
 */

const s = (id: string, extra: Partial<StepDescription> = {}): StepDescription => ({ kind: 'step', id, ...extra });

const chain: WorkflowDescription = { id: 'orders', entries: [s('validate'), s('charge'), s('ship')] };
const mixedEntries: EntryDescription[] = [
  s('a', { retries: 2, retryDelayMs: 5 }),
  { kind: 'parallel', id: 'p', arms: [s('x'), s('y')] },
  { kind: 'branch', id: 'b', arms: [s('l'), s('r')] },
  { kind: 'sleep', id: 'nap', duration: { fixed: 10 } },
  { kind: 'loop', id: 'lp', loopType: 'dountil', iterationBound: 3, body: s('body') },
  { kind: 'foreach', id: 'fe', concurrency: 2, body: s('item') },
  { kind: 'sleepUntil', id: 'until', until: { perRun: true } },
];
const mixed: WorkflowDescription = { id: 'mixed', entries: mixedEntries };
const single: WorkflowDescription = { id: 'one', entries: [s('only')] };

const marked = (d: WorkflowDescription, checkpoints: readonly number[]): WorkflowDescription => ({ ...d, checkpoints });
const transition = (c: CompiledWorkflow, name: string): Transition => {
  const t = [...c.net.transitions].find((x) => x.name === name);
  if (t === undefined) throw new Error(`no transition '${name}'`);
  return t;
};
const placeNames = (c: CompiledWorkflow): string[] => [...c.net.places].map((p) => p.name).sort();
const transitionNames = (c: CompiledWorkflow): string[] => [...c.net.transitions].map((t) => t.name).sort();
const arcNames = (arcs: readonly { readonly place: { readonly name: string } }[]): string[] => arcs.map((a) => a.place.name);
const outputs = (t: Transition): string[] => [...t.outputPlaces()].map((p) => p.name).sort();

/** A recording runner that also takes checkpoints, logging each one into `calls` as `checkpoint@i`. */
class CheckpointingRunner extends RecordingRunner {
  readonly checkpoints: CheckpointEvent[] = [];
  constructor(options: RecordingRunnerOptions = {}, readonly onCheckpoint?: (event: CheckpointEvent) => void | Promise<void>) {
    super(options);
  }
  async checkpoint(event: CheckpointEvent): Promise<void> {
    this.calls.push(`checkpoint@${event.after}`);
    this.checkpoints.push(event);
    await this.onCheckpoint?.(event);
  }
}

describe('an unmarked description compiles to exactly the net it compiled to before', () => {
  // Taken by compiling these descriptions at 9676227 (the W0 contract), before checkpoints were emitted.
  const atHead: [string, WorkflowDescription, string, string][] = [
    ['chain', chain, '9c8007e08cc83a79', '9a1333931313f890'],
    ['mixed', mixed, '2cd22e40d1b9c62c', '3cd66c9107f1d8b7'],
    ['single', single, 'd10d6bf4ee4dd7b1', 'e400813b86b68e16'],
  ];

  it.each(atHead)('%s: the structural hash is byte-identical, unbounded and with k = 2', (_, d, unbounded, k2) => {
    expect(compile(d).structuralHash).toBe(unbounded);
    expect(compile(d, { concurrency: 2 }).structuralHash).toBe(k2);
  });

  it.each(atHead)('%s: an empty checkpoints list is no list at all', (_, d, unbounded) => {
    const compiled = compile(marked(d, []));
    expect(compiled.structuralHash).toBe(unbounded);
    expect(compiled.checkpoints).toEqual([]);
    expect(placeNames(compiled)).toEqual(placeNames(compile(d)));
    expect(transitionNames(compiled)).toEqual(transitionNames(compile(d)));
  });
});

describe('a marked description', () => {
  it('adds exactly one place and two transitions per mark, and nothing else', () => {
    const plain = compile(mixed);
    const withMarks = compile(marked(mixed, [0, 1, 2, 3, 4, 5]));
    const extraPlaces = placeNames(withMarks).filter((n) => !placeNames(plain).includes(n));
    const extraTransitions = transitionNames(withMarks).filter((n) => !transitionNames(plain).includes(n));
    expect(placeNames(plain).every((n) => placeNames(withMarks).includes(n))).toBe(true);
    expect(transitionNames(plain).every((n) => transitionNames(withMarks).includes(n))).toBe(true);
    expect(extraPlaces).toEqual([0, 1, 2, 3, 4, 5].map((i) => `s.${i}.checkpoint`).sort());
    expect(extraTransitions).toEqual([0, 1, 2, 3, 4, 5].flatMap((i) => [`t.${i}.checkpoint`, `t.${i}.checkpoint-cancel`]).sort());
    expect(withMarks.checkpoints).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('routes the entry\'s success through the checkpoint: a write inhibited by the signal, a sweep that reads it', () => {
    const compiled = compile(marked(chain, [0]));
    // validate's success now lands in the checkpoint place, not in charge's input.
    expect(outputs(transition(compiled, 't.0.validate.run'))).toContain('s.0.checkpoint');
    expect(outputs(transition(compiled, 't.0.validate.run'))).not.toContain('s.1.charge.in');

    const write = transition(compiled, 't.0.checkpoint');
    expect(arcNames(write.inputSpecs)).toEqual(['s.0.checkpoint']);
    expect(arcNames(write.inhibitors)).toEqual(['wf.cancel']);
    expect(arcNames(write.reads)).toEqual([]);
    expect(outputs(write)).toEqual(['s.1.charge.in']);

    const sweep = transition(compiled, 't.0.checkpoint-cancel');
    expect(arcNames(sweep.inputSpecs)).toEqual(['s.0.checkpoint']);
    // Read, never consumed: the signal stays for every later check. It reports the cancel as
    // charge's own sweep would, straight into wf.canceled, like every other sweep in the net.
    expect(arcNames(sweep.reads)).toEqual(['wf.cancel']);
    expect(arcNames(sweep.inhibitors)).toEqual([]);
    expect(outputs(sweep)).toEqual(['wf.canceled']);

    for (const t of [write, sweep]) expect(compiled.netMap.transitionToEntry.get(t.name)).toEqual({ path: [0], id: 'validate' });
  });

  it('keeps the boundaries at the entries\' inputs and the checkpoint in the entry before it', () => {
    const compiled = compile(marked(chain, [0, 1]));
    expect(compiled.boundaries.map((b) => b.place.name)).toEqual(['s.0.validate.in', 's.1.charge.in', 's.2.ship.in']);
    expect(compiled.boundaries[0]!.place).toBe(compiled.entryPlace);
    // `next` stays the next entry's input; the checkpoint place is the entry's own interior.
    expect(compiled.entries.map((e) => e.next)).toEqual(['s.1.charge.in', 's.2.ship.in', 'wf.settle.done']);
    expect(compiled.entries[0]!.interior).toContain('s.0.checkpoint');
    expect(compiled.entries[1]!.interior).toContain('s.1.checkpoint');
    expect(compiled.entries[2]!.interior.some((n) => n.endsWith('.checkpoint'))).toBe(false);
  });

  it('hashes apart from the unmarked net, and by which entries are marked', () => {
    const hashes = [[], [0], [1], [0, 1]].map((cps) => compile(marked(chain, cps)).structuralHash);
    expect(new Set(hashes).size).toBe(4);
    expect(compile(marked(chain, [0])).structuralHash).toBe(compile(marked(chain, [0])).structuralHash);
  });

  it('marks a step whose id is `checkpoint` without a name collision', () => {
    const compiled = compile({ id: 'c', entries: [s('checkpoint'), s('after')], checkpoints: [0] });
    expect(transitionNames(compiled)).toEqual(
      expect.arrayContaining(['t.0.checkpoint', 't.0.checkpoint-cancel', 't.0.checkpoint.cancel', 't.0.checkpoint.run']),
    );
    expect(placeNames(compiled)).toEqual(expect.arrayContaining(['s.0.checkpoint', 's.0.checkpoint.in']));
  });

  it.each<[string, readonly number[]]>([
    ['the last entry', [2]],
    ['an index past the end', [5]],
    ['a negative index', [-1]],
    ['a fraction', [0.5]],
    ['a duplicate', [0, 0]],
    ['a descending list', [1, 0]],
  ])('refuses a mark on %s', (_, cps) => {
    expect(() => compile(marked(chain, cps))).toThrow(/checkpoint/);
  });
});

describe('a marked run', () => {
  it('awaits the write between the two entries, with every record so far', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runner = new CheckpointingRunner(
      { steps: { validate: (i) => ({ status: 'success', output: `${i as string}+v` }) } },
      async (event) => {
        if (event.after !== 0) return;
        // charge must not start while the row is being written.
        setTimeout(release, 10);
        await gate;
        expect(runner.calls).toEqual(['validate', 'checkpoint@0']);
      },
    );
    const outcome = await runWorkflow(compile(marked(chain, [0, 1])), 'o', { runner });

    expect(outcome).toEqual({ status: 'success', output: 'o+v' });
    expect(runner.calls).toEqual(['validate', 'checkpoint@0', 'charge', 'checkpoint@1', 'ship']);
    expect(runner.checkpoints.map((c) => [c.after, [...c.records.keys()]])).toEqual([
      [0, ['validate']],
      [1, ['validate', 'charge']],
    ]);
    expect(runner.checkpoints[0]!.records.get('validate')).toMatchObject({ status: 'success', output: 'o+v' });
  });

  it('takes no checkpoint once canceled, and ends exactly as the unmarked net does', async () => {
    const run = async (d: WorkflowDescription) => {
      const ac = new AbortController();
      const runner = new CheckpointingRunner({ steps: { validate: (i) => (ac.abort(), { status: 'success', output: i }) } });
      const detailed = await runWorkflowDetailed(compile(d), 'o', { runner, signal: ac.signal });
      return { ...detailed, calls: runner.calls };
    };
    const plain = await run(chain);
    const withMark = await run(marked(chain, [0]));
    expect(withMark.calls).toEqual(['validate']);
    expect(withMark.outcome).toEqual(plain.outcome);
    expect(withMark.outcome).toEqual({ status: 'canceled', origin: { stepId: 'charge', path: [1] }, started: false });
  });

  it('a rejected write fails its firing: the next entry never runs', async () => {
    const runner = new CheckpointingRunner({}, () => Promise.reject(new Error('storage down')));
    const outcome = await runWorkflow(compile(marked(chain, [0])), 'o', { runner });
    expect(outcome).toMatchObject({ status: 'stranded', failure: { transition: 't.0.checkpoint', message: 'storage down' } });
    expect(runner.calls).toEqual(['validate', 'checkpoint@0']);
  });

  // The sweep reports what entry i+1's own input sweep would: one case per kind of entry i+1.
  const following: [string, EntryDescription, RecordingRunnerOptions][] = [
    ['step', s('next'), {}],
    ['sleep', { kind: 'sleep', id: 'nap', duration: { fixed: 0 } }, {}],
    ['sleepUntil', { kind: 'sleepUntil', id: 'until', until: { fixed: 0 } }, {}],
    ['parallel', { kind: 'parallel', id: 'par', arms: [s('x'), s('y')] }, {}],
    ['branch', { kind: 'branch', id: 'br', arms: [s('l'), s('r')] }, { branches: { br: () => [0] } }],
    ['loop', { kind: 'loop', id: 'lp', loopType: 'dountil', iterationBound: 2, body: s('body') }, { loops: { lp: () => true } }],
    ['foreach', { kind: 'foreach', id: 'fe', concurrency: 1, body: s('item') }, {}],
  ];
  it.each(following)('canceled before a %s: the same outcome and records marked or not, and no write', async (_, entry, options) => {
    const run = async (checkpoints: readonly number[]) => {
      const ac = new AbortController();
      const runner = new CheckpointingRunner({ ...options, steps: { first: () => (ac.abort(), { status: 'success', output: [1] }) } });
      const { outcome, stepResults } = await runWorkflowDetailed(compile({ id: 'k', entries: [s('first'), entry, s('last')], checkpoints }), 'in', { runner, signal: ac.signal });
      return { outcome, records: [...stepResults.keys()], calls: runner.calls };
    };
    const plain = await run([]);
    const withMark = await run([0, 1]);
    expect(withMark).toEqual(plain);
    expect(withMark.calls).toEqual(['first']);
    expect(withMark.outcome).toMatchObject({ status: 'canceled', started: false, origin: { path: [1] } });
  });

  it('a failure before the checkpoint takes none', async () => {
    const runner = new CheckpointingRunner({ steps: { validate: () => ({ status: 'failed', error: 'no' }) } });
    const outcome = await runWorkflow(compile(marked(chain, [0])), 'o', { runner });
    expect(outcome).toMatchObject({ status: 'failed', stepId: 'validate' });
    expect(runner.calls).toEqual(['validate']);
  });
});

/**
 * The claims of [ADR 0009] on marked nets. Property: all four families (completion: deadlock-free +
 * one terminal; bounds; exclusion incl. the barrier with the checkpoint place in entry i's interior;
 * liveness). Initial markings: `closed` — the entry place; `cancel` — the entry place plus
 * `wf.cancel.request`. Environment mode: none (closed net). Routes and times: printed per claim.
 * Only `closed` and `cancel` here: restart segments belong to W3.
 */
describe('a marked workflow still proves', () => {
  const expectHolds = (report: VerificationReport): void => {
    for (const c of report.claims) {
      if (c.kind === 'proof') expect(c.result.verdict.type, describeClaim(c)).toBe('proven');
      else {
        expect(c.result.verdict.type, describeClaim(c)).toBe('violated');
        expect(c.result.counterexampleConfirmed, describeClaim(c)).toBe(true);
      }
    }
    expect(report.holds).toBe(true);
  };
  const timed = async (label: string, compiled: CompiledWorkflow): Promise<VerificationReport> => {
    const started = performance.now();
    const report = await verify(compiled, { segments: ['closed', 'cancel'], timeoutMs: 30_000, jobs: 2 });
    const ms = Math.round(performance.now() - started);
    const slowest = [...report.claims].sort((x, y) => y.result.elapsedMs - x.result.elapsedMs)[0];
    const routes = [...new Set(report.claims.map((c) => c.result.route))].join('/');
    console.log(
      `[checkpoint proofs] ${label}: ${report.claims.length} claims over ${report.segments.map(segmentLabel).join(', ')} ` +
        `in ${ms}ms wall (routes ${routes})` +
        (slowest ? `; slowest ${segmentLabel(slowest.segment)}/${slowest.property} ${slowest.result.elapsedMs}ms via ${slowest.result.route}` : ''),
    );
    return report;
  };

  it('a chain marked after every entry but the last', async () => {
    const report = await timed('chain [0,1]', compile(marked(chain, [0, 1])));
    expect(report.claims.some((c) => c.property.includes('s.0.checkpoint'))).toBe(true);
    expectHolds(report);
  }, 120_000);

  it('a chain marked after every entry, with k = 1', async () => {
    expectHolds(await timed('chain [0,1] k=1', compile(marked(chain, [0, 1]), { concurrency: 1 })));
  }, 120_000);

  // One small workflow per construct, every boundary marked. `mixed` above is near the budget
  // unmarked already (148s wall, deadlockFree 24.7s; at k = 2 deadlockFree is `unknown` unmarked), so
  // it would test that fixture, not the checkpoints.
  const P: EntryDescription = { kind: 'parallel', id: 'p', arms: [s('x'), s('y')] };
  const B: EntryDescription = { kind: 'branch', id: 'b', arms: [s('l'), s('r')] };
  const L: EntryDescription = { kind: 'loop', id: 'lp', loopType: 'dountil', iterationBound: 2, body: s('body') };
  const F: EntryDescription = { kind: 'foreach', id: 'fe', concurrency: 2, body: s('item') };
  const N: EntryDescription = { kind: 'sleep', id: 'nap', duration: { fixed: 10 } };
  const small: [string, EntryDescription[]][] = [
    ['a(retries 1, delay 5); parallel; z', [s('a', { retries: 1, retryDelayMs: 5 }), P, s('z')]],
    ['a; branch; sleep; z', [s('a'), B, N, s('z')]],
    ['a; dountil; z', [s('a'), L, s('z')]],
    ['a; foreach; z', [s('a'), F, s('z')]],
  ];
  for (const [label, entries] of small) {
    const all = entries.slice(0, -1).map((_, i) => i);
    for (const k of [undefined, 1]) {
      it(`${label}, marked ${JSON.stringify(all)}${k === undefined ? '' : `, k = ${k}`}`, async () => {
        const compiled = compile({ id: 'small', entries, checkpoints: all }, k === undefined ? {} : { concurrency: k });
        expectHolds(await timed(`${label} ${JSON.stringify(all)}${k === undefined ? '' : ` k=${k}`}`, compiled));
      }, 120_000);
    }
  }
});

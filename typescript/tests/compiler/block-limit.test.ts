import { afterAll, describe, expect, it } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { runWorkflowDetailed } from '../../src/engine/index.js';
import { describeClaim, describeReport, segmentLabel, segmentsFor, verify, verifyWorkflow, type PropertyReport } from '../../src/verify/index.js';
import type {
  ArmSite,
  CompiledWorkflow,
  EntryDescription,
  StepCall,
  StepDescription,
  StepOutcome,
  StepRecord,
  WorkflowDescription,
} from '../../src/compiler/types.js';
import { RecordingRunner, type Behaviour } from '../fixtures/runner.js';

/**
 * A block's `concurrency` ([ADR 0011]): a pool `wf.slots.<path>` of `c` slots, admitted in arm order
 * by a cursor that passes only at `admit-j` (or, in a branch, at a skipping gate), every collect
 * returning its slot, and a resumed arm taking one through `re-admit-j`.
 *
 * Proofs name the property, the segment (initial marking), the environment mode (the cancel
 * segments seed a request whose arrival may fire anywhere) and the route (`verifyWorkflow`: SMT,
 * semiflow invariants on), and assert `verdict.type === 'proven'` — never `!isViolated()`.
 */

const step = (id: string): StepDescription => ({ kind: 'step', id });
const steps = (n: number): StepDescription[] => Array.from({ length: n }, (_, i) => step(`a${i}`));
const fan = (arms: readonly StepDescription[], concurrency?: number): EntryDescription =>
  concurrency === undefined ? { kind: 'parallel', id: 'fan', arms } : { kind: 'parallel', id: 'fan', arms, concurrency };
const route = (arms: readonly StepDescription[], concurrency?: number): EntryDescription =>
  concurrency === undefined ? { kind: 'branch', id: 'route', arms } : { kind: 'branch', id: 'route', arms, concurrency };
const wf = (...entries: EntryDescription[]): WorkflowDescription => ({ id: 'w', entries });
const ok = (output: unknown): StepOutcome => ({ status: 'success', output });
const after = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const placeNames = (c: CompiledWorkflow): string[] => [...c.net.places].map((p) => p.name).sort();
const transitionNames = (c: CompiledWorkflow): string[] => [...c.net.transitions].map((t) => t.name).sort();

/** Counts arms in flight, and the order they started and settled in. */
class Gauge {
  inFlight = 0;
  peak = 0;
  readonly started: string[] = [];
  readonly aborted = new Map<string, boolean>();

  arm(id: string, ms: number, then: (call: StepCall) => StepOutcome = () => ok(id)): Behaviour {
    return async (_input, call) => {
      this.started.push(id);
      this.aborted.set(id, call.abortSignal.aborted);
      this.inFlight += 1;
      this.peak = Math.max(this.peak, this.inFlight);
      try {
        await after(ms);
        return then(call);
      } finally {
        this.inFlight -= 1;
      }
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------------------------

describe('block limit: structure', () => {
  for (const [label, block] of [['parallel', fan], ['branch', route]] as const) {
    it(`${label}: absent, and c >= arms, compile today's net and hash`, () => {
      const plain = compile(wf(step('pre'), block(steps(3))));
      for (const c of [3, 4, 1024]) {
        const same = compile(wf(step('pre'), block(steps(3), c)));
        expect(placeNames(same)).toStrictEqual(placeNames(plain));
        expect(transitionNames(same)).toStrictEqual(transitionNames(plain));
        expect(same.structuralHash).toBe(plain.structuralHash);
        expect(same.pools).toStrictEqual([]);
        expect([...same.claims.keys()].sort()).toStrictEqual([...plain.claims.keys()].sort());
      }
      expect(plain.pools).toStrictEqual([]);
    });

    it(`${label}: c < arms changes the hash, and c=1 differs from c=2`, () => {
      const plain = compile(wf(block(steps(3))));
      const one = compile(wf(block(steps(3), 1)));
      const two = compile(wf(block(steps(3), 2)));
      expect(one.structuralHash).not.toBe(plain.structuralHash);
      expect(two.structuralHash).not.toBe(one.structuralHash);
    });
  }

  it('parallel, 3 arms, c=2: slots + active + q-0..2 + resumed-0..2; admit-0..2 and re-admit-0..2', () => {
    const plain = compile(wf(fan(steps(3))));
    const limited = compile(wf(fan(steps(3), 2)));
    const added = placeNames(limited).filter((p) => !placeNames(plain).includes(p));
    expect(added).toStrictEqual(
      ['s.0.fan.active', 's.0.fan.q-0', 's.0.fan.q-1', 's.0.fan.q-2', 's.0.fan.resumed-0', 's.0.fan.resumed-1', 's.0.fan.resumed-2', 'wf.slots.0'].sort(),
    );
    expect(placeNames(plain).filter((p) => !placeNames(limited).includes(p))).toStrictEqual([]);
    const addedT = transitionNames(limited).filter((t) => !transitionNames(plain).includes(t));
    expect(addedT).toStrictEqual(
      ['t.0.fan.admit-0', 't.0.fan.admit-1', 't.0.fan.admit-2', 't.0.fan.re-admit-0', 't.0.fan.re-admit-1', 't.0.fan.re-admit-2'],
    );
    expect(limited.net.places.size).toBe(plain.net.places.size + 8);
    expect(limited.net.transitions.size).toBe(plain.net.transitions.size + 6);

    const byName = new Map([...limited.net.transitions].map((t) => [t.name, t]));
    const fork = byName.get('t.0.fan.fork')!;
    expect([...fork.outputPlaces()].map((p) => p.name)).toStrictEqual(['s.0.fan.q-0']);
    expect(fork.inhibitors.map((a) => a.place.name)).toStrictEqual(['wf.cancel']);
    const admit1 = byName.get('t.0.fan.admit-1')!;
    expect(admit1.inputSpecs.map((i) => [i.type, i.place.name])).toStrictEqual([['one', 's.0.fan.q-1'], ['one', 'wf.slots.0']]);
    expect([...admit1.outputPlaces()].map((p) => p.name).sort()).toStrictEqual(['s.0-1.a1.in', 's.0.fan.active', 's.0.fan.q-2']);
    // Queued arms are not gated: admission happens inside a started block.
    for (const j of [0, 1, 2]) {
      expect(byName.get(`t.0.fan.admit-${j}`)!.inhibitors).toStrictEqual([]);
      expect(byName.get(`t.0.fan.re-admit-${j}`)!.inhibitors).toStrictEqual([]);
    }
    expect([...byName.get('t.0.fan.admit-2')!.outputPlaces()].map((p) => p.name).sort()).toStrictEqual(['s.0-2.a2.in', 's.0.fan.active']);

    expect(limited.pools).toStrictEqual([
      {
        kind: 'slots',
        place: expect.objectContaining({ name: 'wf.slots.0' }),
        seed: 2,
        holders: [{ place: 's.0.fan.active', weight: 1 }],
        takers: ['t.0.fan.admit-0', 't.0.fan.admit-1', 't.0.fan.admit-2', 't.0.fan.re-admit-0', 't.0.fan.re-admit-1', 't.0.fan.re-admit-2'],
        givers: ['t.0.fan.collect-0', 't.0.fan.collect-1', 't.0.fan.collect-2', 't.0.fan.collect-err', 't.0.fan.collect-susp', 't.0.fan.collect-bail', 't.0.fan.collect-pause'],
      },
    ]);
    expect(limited.claims.get('s.0.fan.active')).toMatchObject({ bound: 2 });
    // Every collect takes one `active` and gives one slot back, in one firing.
    for (const giver of limited.pools[0]!.givers) {
      const t = byName.get(giver)!;
      expect(t.inputSpecs.filter((i) => i.place.name === 's.0.fan.active').map((i) => i.type)).toStrictEqual(['one']);
      expect([...t.outputPlaces()].map((p) => p.name)).toContain('wf.slots.0');
    }
    // The pool is outside the block's interior; `active`, the cursors and `resumed-j` are inside.
    const interior = limited.entries[0]!.interior;
    expect(interior).not.toContain('wf.slots.0');
    for (const p of added.filter((p) => p !== 'wf.slots.0')) expect(interior).toContain(p);
  });

  it('branch, 3 arms, c=1: slots + active + q-0..2 + ready-0..2 + resumed-0..2; a gate takes the cursor', () => {
    const plain = compile(wf(route(steps(3))));
    const limited = compile(wf(route(steps(3), 1)));
    expect(limited.net.places.size).toBe(plain.net.places.size + 11);
    expect(limited.net.transitions.size).toBe(plain.net.transitions.size + 6);
    const byName = new Map([...limited.net.transitions].map((t) => [t.name, t]));
    expect([...byName.get('t.0.route.decide')!.outputPlaces()].map((p) => p.name).sort()).toStrictEqual(
      ['s.0.route.gate-0', 's.0.route.gate-1', 's.0.route.gate-2', 's.0.route.q-0', 'wf.settle.failed'],
    );
    const gate1 = byName.get('t.0.route.gate-1')!;
    expect(gate1.inputSpecs.map((i) => i.place.name)).toStrictEqual(['s.0.route.gate-1', 's.0.route.q-1']);
    // Run waits for a slot at ready-1; skip or reuse arrives and passes the cursor, slot-free.
    expect([...gate1.outputPlaces()].map((p) => p.name).sort()).toStrictEqual(['s.0.route.arrived', 's.0.route.q-2', 's.0.route.ready-1']);
    expect(gate1.inputSpecs.some((i) => i.place.name === 'wf.slots.0')).toBe(false);
    expect(byName.get('t.0.route.admit-1')!.inputSpecs.map((i) => i.place.name)).toStrictEqual(['s.0.route.ready-1', 'wf.slots.0']);
    expect(limited.pools.map((p) => [p.kind, p.seed, p.takers.length, p.givers.length])).toStrictEqual([['slots', 1, 6, 7]]);
  });

  it('refuses a concurrency that is not a whole number >= 1', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => compile(wf(fan(steps(3), bad)))).toThrow(/concurrency must be a whole number/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------

describe('block limit: runs', () => {
  const n = 5;
  for (const c of [1, 2, 3]) {
    for (const k of [undefined, 1, 2]) {
      const expected = Math.min(c, n, k ?? Infinity);
      it(`parallel, ${n} arms, c=${c}, k=${k ?? 'unbounded'}: FIFO admission, peak in flight ${expected}`, async () => {
        const g = new Gauge();
        const behaviours = Object.fromEntries(steps(n).map((s, i) => [s.id, g.arm(s.id, 15 + 5 * ((n - i) % 3))]));
        const runner = new RecordingRunner({ steps: behaviours });
        const compiled = compile(wf(fan(steps(n), c)), k === undefined ? {} : { concurrency: k });
        const { outcome } = await runWorkflowDetailed(compiled, 'x', { runner, timeoutMs: 10_000 });
        expect(outcome).toStrictEqual({ status: 'success', output: Object.fromEntries(steps(n).map((s) => [s.id, s.id])) });
        expect(g.peak).toBe(expected);
        // With one slot (or one permit) the start order is the arm order exactly; with more, the
        // admission order is, and a start never precedes an earlier arm's admission.
        if (expected === 1) expect(g.started).toStrictEqual(steps(n).map((s) => s.id));
        else expect(g.started.slice(0, expected).sort()).toStrictEqual(steps(n).slice(0, expected).map((s) => s.id));
      });
    }
  }

  it('parallel, c=1: admission is in arm order even when later arms would finish first', async () => {
    const g = new Gauge();
    const runner = new RecordingRunner({ steps: { a0: g.arm('a0', 30), a1: g.arm('a1', 0), a2: g.arm('a2', 10) } });
    const { outcome } = await runWorkflowDetailed(compile(wf(fan(steps(3), 1))), 'x', { runner, timeoutMs: 10_000 });
    expect(outcome).toMatchObject({ status: 'success' });
    expect(g.started).toStrictEqual(['a0', 'a1', 'a2']);
    expect(g.peak).toBe(1);
  });

  it('branch, c=1: skipped and reused arms pass the cursor without a slot; truthy arms run one at a time, in order', async () => {
    const g = new Gauge();
    const runner = new RecordingRunner({
      steps: Object.fromEntries(steps(5).map((s) => [s.id, g.arm(s.id, 10)])),
      branches: { route: () => [0, 1, 3, 4] },
    });
    // a1 already succeeded earlier in the run, so its truthy arm is reused, not run.
    const records = new Map<string, StepRecord>([['a1', { status: 'success', output: 'earlier', payload: 'x', startedAt: 0, endedAt: 0 }]]);
    const { outcome } = await runWorkflowDetailed(compile(wf(route(steps(5), 1))), 'x', { runner, stepResults: records, timeoutMs: 10_000 });
    expect(outcome).toStrictEqual({ status: 'success', output: { a0: 'a0', a1: 'earlier', a3: 'a3', a4: 'a4' } });
    expect(g.started).toStrictEqual(['a0', 'a3', 'a4']);
    expect(g.peak).toBe(1);
  });

  it('branch, 4 arms, c=2, k=unbounded: peak 2 over the three truthy arms', async () => {
    const g = new Gauge();
    const runner = new RecordingRunner({
      steps: Object.fromEntries(steps(4).map((s) => [s.id, g.arm(s.id, 15)])),
      branches: { route: () => [0, 2, 3] },
    });
    const { outcome } = await runWorkflowDetailed(compile(wf(route(steps(4), 2))), 'x', { runner, timeoutMs: 10_000 });
    expect(outcome).toStrictEqual({ status: 'success', output: { a0: 'a0', a2: 'a2', a3: 'a3' } });
    expect(g.peak).toBe(2);
    expect(g.started.slice(0, 2)).toStrictEqual(['a0', 'a2']);
  });

  it('a slot is held across the arm\'s failure and returned by collect-err: the block still settles', async () => {
    const g = new Gauge();
    const runner = new RecordingRunner({
      steps: { a0: g.arm('a0', 5, () => ({ status: 'failed', error: 'boom' })), a1: g.arm('a1', 5), a2: g.arm('a2', 5) },
    });
    const { outcome } = await runWorkflowDetailed(compile(wf(fan(steps(3), 1))), 'x', { runner, timeoutMs: 10_000 });
    expect(outcome).toMatchObject({ status: 'failed', error: 'boom' });
    expect(g.started).toStrictEqual(['a0', 'a1', 'a2']);
    expect(g.peak).toBe(1);
  });

  for (const [label, block, extra] of [
    ['parallel', fan, {}],
    ['branch', route, { branches: { route: () => [0, 1, 2] } }],
  ] as const) {
    it(`${label}, c=1, cancel mid-block: queued arms start with the aborted signal, every arm gets a record`, async () => {
      const ac = new AbortController();
      const g = new Gauge();
      const runner = new RecordingRunner({
        ...extra,
        steps: {
          a0: g.arm('a0', 5, () => {
            ac.abort();
            return ok('a0');
          }),
          a1: g.arm('a1', 5),
          a2: g.arm('a2', 5),
        },
      });
      const { outcome, stepResults } = await runWorkflowDetailed(compile(wf(block(steps(3), 1), step('after'))), 'x', {
        runner,
        signal: ac.signal,
        timeoutMs: 10_000,
      });
      expect(g.started).toStrictEqual(['a0', 'a1', 'a2']);
      expect([...g.aborted]).toStrictEqual([['a0', false], ['a1', true], ['a2', true]]);
      expect(runner.calls).not.toContain('after');
      expect(outcome).toStrictEqual({ status: 'canceled', origin: { stepId: 'after', path: [1] }, started: false });
      for (const id of ['a0', 'a1', 'a2']) expect(stepResults.get(id)).toMatchObject({ status: 'success', output: id });
    });
  }

  it('parallel, c=1, resumed at arm 1: the resumed arm takes a slot, siblings replay without one', async () => {
    const g = new Gauge();
    const runner = new RecordingRunner({ steps: { a1: g.arm('a1', 5) } });
    const compiled = compile(wf(fan(steps(3), 1)));
    const site = compiled.resumeSites.get('0.1') as ArmSite;
    const { outcome } = await runWorkflowDetailed(compiled, 'x', {
      runner,
      resume: {
        site,
        value: {
          data: 'x',
          siblings: [
            { kind: 'ok', index: 0, output: 'old0' },
            { kind: 'ok', index: 2, output: 'old2' },
          ],
        },
      },
      timeoutMs: 10_000,
    });
    // Strict: a residue key — a slot not returned, an `active` left — would fail this.
    expect(outcome).toStrictEqual({ status: 'success', output: { a0: 'old0', a1: 'a1', a2: 'old2' } });
    expect(runner.calls).toStrictEqual(['a1']);
  });

  it('branch, c=1, a misfit resume seed is refused before a slot is taken', async () => {
    const runner = new RecordingRunner({ branches: { route: () => [] } });
    const compiled = compile(wf(route(steps(2), 1)));
    const site = compiled.resumeSites.get('0.0') as ArmSite;
    const { outcome } = await runWorkflowDetailed(compiled, 'x', {
      runner,
      resume: { site, value: { data: 'x', siblings: [] } },
      timeoutMs: 10_000,
    });
    expect(outcome).toMatchObject({ status: 'failed' });
    expect(outcome).not.toHaveProperty('residue');
    expect(runner.calls).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Proofs
// ---------------------------------------------------------------------------------------------

const timings: string[] = [];
afterAll(() => {
  if (timings.length > 0) console.log(`block-limit proofs:\n  ${timings.join('\n  ')}`);
});

/**
 * Every segment `verifyWorkflow` proves by default — `closed`, `cancel`, `resume@s` /
 * `resume@s+cancel` per arm site, `restart@p` / `restart@p+cancel` per boundary — each property
 * `proven`.
 */
async function expectProven(label: string, compiled: CompiledWorkflow): Promise<readonly PropertyReport[]> {
  const t0 = performance.now();
  const reports = await verifyWorkflow(compiled, { timeoutMs: 30_000 });
  const ms = performance.now() - t0;
  const labels = new Set(reports.map((r) => segmentLabel(r.segment)));
  expect([...labels]).toStrictEqual(segmentsFor(compiled).map(segmentLabel));
  for (const report of reports) expect(report.result.verdict.type, describeReport(report)).toBe('proven');
  timings.push(`${label}: ${reports.length} reports over ${labels.size} segments in ${ms.toFixed(0)} ms`);
  return reports;
}

describe('block limit: proofs', () => {
  for (const [label, block] of [['parallel', fan], ['branch', route]] as const) {
    for (const c of [1, 2]) {
      for (const k of [undefined, 1, 2]) {
        const name = `${label}, 3 arms, c=${c}, k=${k ?? 'unbounded'}`;
        it(`${name}: completion proven in closed, cancel, resume@0.j(+cancel), restart@p(+cancel)`, async () => {
          const compiled = compile(wf(block(steps(3), c)), k === undefined ? {} : { concurrency: k });
          const reports = await expectProven(name, compiled);
          expect(new Set(reports.map((r) => segmentLabel(r.segment)))).toContain('resume@0.2+cancel');
        });
      }
    }
  }

  // The gadget's own claim, `placeBound(active, c)`, and the barrier over the new interior places
  // (`active`, the cursors, `ready-j`, `resumed-j`): empty once the block's `next` is marked.
  for (const [label, block] of [['parallel', fan], ['branch', route]] as const) {
    for (const c of [1, 2]) {
      const name = `${label}, 3 arms, c=${c}, k=2, then a step`;
      it(`${name}: bounds and exclusion families proven in every segment`, async () => {
        const compiled = compile(wf(block(steps(3), c), step('after')), { concurrency: 2 });
        const t0 = performance.now();
        const report = await verify(compiled, { families: ['bounds', 'exclusion'], timeoutMs: 30_000 });
        const ms = performance.now() - t0;
        for (const claim of report.claims) expect(claim.result.verdict.type, describeClaim(claim)).toBe('proven');
        const active = report.claims.filter((cl) => cl.property.includes('s.0.' + (label === 'parallel' ? 'fan' : 'route') + '.active'));
        expect(active.some((cl) => cl.family === 'bounds' && cl.property.includes(`<=${c}`))).toBe(true);
        expect(active.some((cl) => cl.family === 'exclusion')).toBe(true);
        timings.push(`${name}: ${report.claims.length} bound/exclusion claims in ${ms.toFixed(0)} ms`);
      });
    }
  }
});

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createWorkflow } from '@mastra/core/workflows';
import {
  compareObservations,
  eventModel,
  formatDifferentialReport,
  formatVerdicts,
  peakInFlight,
  matches,
  normalise,
  runBoth,
  type Execution,
  type Observation,
  type TraceEvent,
  type Verdict,
} from '../../src/conformance/differential.js';
import { binds, BUDGETS, FIXTURES, observe, toCase, widthOf, type MastraFixture } from '../fixtures/mastra-workflows.js';

const DIVERGENCES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/divergences.md');
const documentedRows = new Set(
  [...readFileSync(DIVERGENCES, 'utf8').matchAll(/^\| (\d+) \|/gm)].map((m) => Number(m[1])),
);

/** Label patterns a fixture declared independent, or none: then no weakening is allowed. */
const independentOf = (f: MastraFixture) => f.independent ?? [];

const budgetName = (k: number | undefined) => (k === undefined ? 'unbounded' : String(k));

/** Every verdict, at every budget: the M3 differential report is written from these. */
const ALL: Verdict[] = [];
afterAll(() => {
  const report = formatDifferentialReport(ALL);
  console.log(report);
  const out = process.env['DIFFERENTIAL_REPORT'];
  if (out !== undefined && out !== '') writeFileSync(out, `${report}\n`);
});

for (const k of BUDGETS) {
  describe(`the corpus, both engines, candidate budget k = ${budgetName(k)}`, () => {
    for (const fixture of FIXTURES) {
      it(fixture.name, async () => {
        const verdict = await runBoth(toCase(fixture, k));
        ALL.push(verdict);
        expect(verdict.oracleOutcome).toBe(fixture.expected);
        expect(verdict.ordering.oracleStarts.length).toBeGreaterThan(0);

        // Engine identity: the oracle never touched ours, the candidate never touched Mastra's,
        // and every workflow — nested ones included — ran as often on each side.
        expect(verdict.identity).toEqual([]);
        expect(verdict.executions.oracle.petri).toBe(0);
        expect(verdict.executions.candidate.default).toBe(0);
        expect(verdict.executions.oracle.default).toBeGreaterThanOrEqual(1);
        expect(verdict.executions.candidate.petri).toBe(verdict.executions.oracle.default);

        for (const d of verdict.differences) if (d.row !== undefined) expect(documentedRows.has(d.row)).toBe(true);
        expect(verdict.unusedAttributions).toEqual([]);

        // Happens-before: nothing reversed, nothing inverted; a weakening only on a declared pair.
        // A strengthening is allowed and lands in the report.
        expect(verdict.ordering.reversed).toEqual([]);
        expect(verdict.ordering.inverted).toEqual([]);
        if (independentOf(fixture).length === 0) expect(verdict.ordering.weakened).toEqual([]);
        // Where the budget does not bind, the candidate keeps every oracle order, declared or not.
        if (!binds(fixture, k)) expect(verdict.ordering.weakened).toEqual([]);

        // The budget: never more than k steps in flight on the candidate.
        expect(verdict.budget).toEqual([]);
        expect(verdict.measurements.concurrency).toBe(k ?? 'unbounded');
        if (k !== undefined) expect(verdict.measurements.peakInFlight.candidate).toBeLessThanOrEqual(k);
        expect(verdict.measurements.wallMs.oracle).not.toBeNull();
        expect(verdict.measurements.wallMs.candidate).not.toBeNull();

        expect(verdict.verdict).not.toBe('fail');
      });
    }
  });
}

describe('the budget binds where the corpus is wide', () => {
  // Peak steps in flight on the candidate, per budget: exactly min(k, width) where Mastra overlaps
  // `width` steps. Without these, a corpus that never overlapped would pass the <= k gate vacuously.
  // The timer-driven wide fixtures: every overlapped step waits on a timer, so Mastra's overlap is
  // the fixture's width and not an accident of microtask order.
  for (const name of ['parallel-wide', 'foreach-c5', 'foreach-c3']) {
    const f = FIXTURES.find((x) => x.name === name)!;
    const width = widthOf(f);
    for (const k of BUDGETS) {
      const peak = k === undefined ? width : Math.min(k, width);
      it(`${name} at k = ${budgetName(k)}: candidate peak ${peak}, oracle ${width}`, async () => {
        expect(width).toBeGreaterThan(1);
        const v = await runBoth(toCase(f, k));
        expect(v.verdict).toBe('pass');
        expect(v.measurements.peakInFlight.oracle).toBe(width);
        expect(v.measurements.peakInFlight.candidate).toBe(peak);
        // Serialising what Mastra overlapped is a strengthening, and it is reported, never silent.
        if (binds(f, k)) {
          expect(v.ordering.strengthened.length).toBeGreaterThan(0);
          expect(formatDifferentialReport([v])).toContain(`${name} k=${k} (${v.ordering.strengthened.length}):`);
        } else {
          expect(v.ordering.strengthened).toEqual([]);
        }
      });
    }
  }

  it('the wide parallel returns the same sum at every budget', async () => {
    const f = FIXTURES.find((x) => x.name === 'parallel-wide')!;
    for (const k of BUDGETS) {
      const o = await observe(f, 'petri', f.input, k);
      expect(o.kind).toBe('resolved');
      // pre: 2; arms 2*1 .. 2*6 sum to 42.
      expect(o.kind === 'resolved' ? (o.result as { result?: unknown }).result : undefined).toEqual({ n: 42 });
    }
  });
});

describe('the events dimension on real runs', () => {
  const types = (o: Observation) => (o.events ?? []).map((e) => `${(e as { type: string }).type}:${(e as { payload?: { id?: string; stepName?: string } }).payload?.id ?? (e as { payload?: { stepName?: string } }).payload?.stepName ?? ''}`);
  const lifecycle = (id: string) => [`workflow-step-start:${id}`, `workflow-step-result:${id}`, `workflow-step-finish:${id}`];

  it('positive control: the oracle publishes each step lifecycle, and a candidate missing one fails', async () => {
    const linear = FIXTURES.find((f) => f.name === 'linear')!;
    const o = await observe(linear, 'default', linear.input);
    const c = await observe(linear, 'petri', linear.input);
    expect(types(o)).toEqual([...lifecycle('a'), ...lifecycle('b'), ...lifecycle('c')]);
    const mutant = { ...c, events: (c.events ?? []).filter((e) => !((e as { type: string }).type === 'workflow-step-finish' && (e as { payload: { id: string } }).payload.id === 'b')) };
    const v = compareObservations('linear', o, mutant, []);
    expect(v.differences.map((d) => d.path)).toEqual(['events.b.length']);
    expect(v.verdict).toBe('fail');
  });

  it('the stream fixture sees writer chunks, the custom chunk and the stream bracket; the watch fixture sees none of the chunks', async () => {
    const streamed = FIXTURES.find((f) => f.name === 'writer-stream')!;
    const o = await observe(streamed, 'default', streamed.input);
    expect(types(o)).toEqual([
      'workflow-start:',
      'workflow-step-start:w',
      'workflow-step-output:w',
      'data-progress:',
      'workflow-step-output:w',
      'workflow-step-result:w',
      'workflow-step-start:after',
      'workflow-step-result:after',
      'workflow-finish:',
    ]);
    const watched = FIXTURES.find((f) => f.name === 'writer')!;
    expect(types(await observe(watched, 'default', watched.input))).toEqual([...lifecycle('w'), ...lifecycle('after')]);
  });

  type Ev = { type: string; payload: Record<string, unknown> };
  const ev = (o: Observation) => (o.events ?? []) as Ev[];
  const at = (xs: readonly Ev[], type: string, id: string) => xs.findIndex((e) => e.type === type && (e.payload['id'] ?? e.payload['stepName']) === id);
  /** `xs` with the event at `from` moved to just before index `to` of the original list. */
  const move = (xs: readonly Ev[], from: number, to: number): Ev[] => {
    const out = xs.filter((_, i) => i !== from);
    out.splice(to > from ? to - 1 : to, 0, xs[from]!);
    return out;
  };

  it("positive control: a real candidate whose successor starts before its predecessor's result is an inversion across groups", async () => {
    const linear = FIXTURES.find((f) => f.name === 'linear')!;
    const o = await observe(linear, 'default', linear.input);
    const c = await observe(linear, 'petri', linear.input);
    expect(compareObservations('linear', o, c, []).verdict).toBe('pass');
    const xs = ev(c);
    const mutant = { ...c, events: move(xs, at(xs, 'workflow-step-start', 'b'), at(xs, 'workflow-step-result', 'a')) };
    const v = compareObservations('linear', o, mutant, []);
    expect(v.differences.map((d) => d.path)).toEqual(['events.$order.a#0.b#0']);
    expect(v.verdict).toBe('fail');
  });

  it("positive control: a real writer chunk moved after its step's result is outside the step", async () => {
    const streamed = FIXTURES.find((f) => f.name === 'writer-stream')!;
    const o = await observe(streamed, 'default', streamed.input);
    const c = await observe(streamed, 'petri', streamed.input);
    expect(compareObservations('writer-stream', o, c, []).verdict).toBe('pass');
    const xs = ev(c);
    // The last chunk: the group's own order is unchanged, so only its place against the step shows.
    const last = xs.map((e) => e.type === 'workflow-step-output' && e.payload['stepName'] === 'w').lastIndexOf(true);
    const mutant = { ...c, events: move(xs, last, at(xs, 'workflow-step-result', 'w') + 1) };
    const v = compareObservations('writer-stream', o, mutant, []);
    expect(v.differences.map((d) => d.path)).toEqual(['events.$within.w@output#1']);
    expect(v.verdict).toBe('fail');
  });

  it("positive control: a real nested child's events moved after the parent step's result are outside it", async () => {
    const nested = FIXTURES.find((f) => f.name === 'nested-workflow')!;
    const o = await observe(nested, 'default', nested.input);
    const c = await observe(nested, 'petri', nested.input);
    expect(compareObservations('nested-workflow', o, c, []).verdict).toBe('pass');
    const children = [...eventModel(ev(c)).within.entries()].filter(([k]) => k.includes('/'));
    expect(children.length).toBeGreaterThan(0);
    const [key, { owner }] = children[0]!;
    const xs = ev(c);
    const prefix = `${owner}.`;
    const child = xs.filter((e) => typeof e.payload['id'] === 'string' && (e.payload['id'] as string).startsWith(prefix));
    const rest = xs.filter((e) => !child.includes(e));
    const r = at(rest, 'workflow-step-result', owner);
    const mutant = { ...c, events: [...rest.slice(0, r + 1), ...child, ...rest.slice(r + 1)] };
    const v = compareObservations('nested-workflow', o, mutant, []);
    expect(v.differences.map((d) => d.path)).toContain(`events.$within.${key}`);
    expect(v.verdict).toBe('fail');
  });

  it('positive control: a real clock stamp or step call id the candidate drops, or a call id it does not correlate, fails', async () => {
    const linear = FIXTURES.find((f) => f.name === 'linear')!;
    const o = await observe(linear, 'default', linear.input);
    const c = await observe(linear, 'petri', linear.input);
    const xs = ev(c);
    const without = (i: number, key: string) => xs.map((e, j) => (j === i ? { ...e, payload: Object.fromEntries(Object.entries(e.payload).filter(([k]) => k !== key)) } : e));
    const start = at(xs, 'workflow-step-start', 'a');
    const result = at(xs, 'workflow-step-result', 'a');
    expect(compareObservations('linear', o, { ...c, events: without(start, 'startedAt') }, []).differences.map((d) => d.path)).toEqual(['events.a.0.payload.startedAt']);
    expect(compareObservations('linear', o, { ...c, events: without(result, 'stepCallId') }, []).differences.map((d) => d.path)).toEqual(['events.a.1.payload.stepCallId']);
    const recalled = xs.map((e, j) => (j === result ? { ...e, payload: { ...e.payload, stepCallId: '00000000-0000-4000-8000-000000000000' } } : e));
    const v = compareObservations('linear', o, { ...c, events: recalled }, []);
    expect(v.differences.map((d) => d.path)).toEqual(['events.a.1.payload.stepCallId', 'events.$calls.a#0']);
    expect(v.verdict).toBe('fail');
  });

  it('the corpus cannot be switched to reporting event differences: toCase takes no mode and reads no environment', async () => {
    const prior = process.env['DIFFERENTIAL_EVENTS'];
    process.env['DIFFERENTIAL_EVENTS'] = 'report';
    try {
      const linear = FIXTURES.find((f) => f.name === 'linear')!;
      const kase = toCase(linear);
      expect('events' in kase).toBe(false);
      const o = await kase.run('default', kase.input);
      const c = await kase.run('petri', kase.input);
      const mutant = { ...c, events: ev(c).filter((e) => !(e.type === 'workflow-step-finish' && e.payload['id'] === 'b')) };
      expect(compareObservations(kase.name, o, mutant, []).verdict).toBe('fail');
    } finally {
      if (prior === undefined) delete process.env['DIFFERENTIAL_EVENTS'];
      else process.env['DIFFERENTIAL_EVENTS'] = prior;
    }
  });

  it('emitStepEvents: false silences the oracle, so the fixture pins that the candidate is silent too', async () => {
    const off = FIXTURES.find((f) => f.name === 'emit-step-events-off')!;
    const o = await observe(off, 'default', off.input);
    expect(o.kind).toBe('resolved');
    expect(o.events).toEqual([]);
  });
});

describe('the nested fixtures', () => {
  it('ran their inner workflow on the petri engine too, at every budget', async () => {
    for (const k of BUDGETS) {
      for (const name of ['nested-workflow', 'nested-suspend']) {
        const f = FIXTURES.find((x) => x.name === name)!;
        const petri = await observe(f, 'petri', f.input, k);
        const def = await observe(f, 'default', f.input);
        expect(petri.executions.length).toBe(2);
        expect(petri.executions.every((e) => e.engine === 'petri')).toBe(true);
        expect(def.executions.every((e) => e.engine === 'default')).toBe(true);
        expect(new Set(petri.executions.map((e) => e.workflowId))).toEqual(new Set(def.executions.map((e) => e.workflowId)));
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------

const PETRI: readonly Execution[] = [{ engine: 'petri', workflowId: 'w' }];
const DEFAULT: readonly Execution[] = [{ engine: 'default', workflowId: 'w' }];

function traceOf(labels: string[]): TraceEvent[] {
  return labels.flatMap((l) => [
    { kind: 'start' as const, label: l },
    { kind: 'end' as const, label: l },
  ]);
}

/** An oracle-side observation; `cand` is the same on the candidate side. */
const ora = (result: unknown, labels: string[] = [], executions: readonly Execution[] = DEFAULT): Observation => ({
  kind: 'resolved',
  result,
  trace: traceOf(labels),
  executions,
});
const cand = (result: unknown, labels: string[] = [], executions: readonly Execution[] = PETRI): Observation => ({
  kind: 'resolved',
  result,
  trace: traceOf(labels),
  executions,
});
const withTrace = (o: Observation, trace: TraceEvent[]): Observation => ({ ...o, trace });
const s = (label: string): TraceEvent => ({ kind: 'start', label });
const e = (label: string): TraceEvent => ({ kind: 'end', label });

const U1 = '0b6f3a6e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const U2 = '11111111-2222-4333-8444-555555555555';
const U3 = '99999999-2222-4333-8444-555555555555';

describe('the harness itself', () => {
  describe('engine identity', () => {
    it('a candidate that ran on the default engine fails, and no attribution can rescue it', () => {
      const at = [{ row: 4, paths: ['**'], reason: 'test' }];
      const v = compareObservations('x', ora({ a: 1 }), ora({ a: 1 }), at);
      expect(v.verdict).toBe('fail');
      expect(v.identity).toEqual(["candidate executed 'w' on the default engine"]);
    });

    it('an oracle that ran on the petri engine fails', () => {
      const v = compareObservations('x', cand({ a: 1 }), cand({ a: 1 }), []);
      expect(v.identity).toEqual(["oracle executed 'w' on the petri engine"]);
      expect(v.verdict).toBe('fail');
    });

    it('a nested workflow that fell back to the default engine fails', () => {
      const oracle = ora({}, [], [...DEFAULT, { engine: 'default', workflowId: 'inner' }]);
      const candidate = cand({}, [], [...PETRI, { engine: 'default', workflowId: 'inner' }]);
      expect(compareObservations('x', oracle, candidate, []).identity).toEqual(["candidate executed 'inner' on the default engine"]);
    });

    it('a nested workflow the candidate never executed fails', () => {
      const oracle = ora({}, [], [...DEFAULT, { engine: 'default', workflowId: 'inner' }]);
      expect(compareObservations('x', oracle, cand({}), []).identity).toEqual([
        "'inner' executed 1 time(s) by the oracle, 0 by the candidate",
      ]);
    });

    it('a resolved observation without any execute() call fails', () => {
      const v = compareObservations('x', ora({}), cand({}, [], []), []);
      expect(v.identity).toContain("candidate resolved without any engine's execute()");
      expect(v.verdict).toBe('fail');
    });

    it('positive control on a real run: the default engine observed as the candidate fails identity', async () => {
      const linear = FIXTURES.find((f) => f.name === 'linear')!;
      const oracle = await observe(linear, 'default', linear.input);
      const petri = await observe(linear, 'petri', linear.input);
      expect(oracle.executions).toEqual([{ engine: 'default', workflowId: 'linear' }]);
      expect(petri.executions).toEqual([{ engine: 'petri', workflowId: 'linear' }]);
      expect(compareObservations('linear', oracle, petri, []).verdict).toBe('pass');
      // The mutant: the candidate built on Mastra's engine. Data and order agree; identity does not.
      const mutant = await observe(linear, 'default', linear.input);
      const v = compareObservations('linear', oracle, mutant, []);
      expect(v.differences).toEqual([]);
      expect(v.verdict).toBe('fail');
      expect(v.identity).toEqual(["candidate executed 'linear' on the default engine"]);
    });

    it('a build that throws is an observation, not a harness error', async () => {
      const empty: MastraFixture = {
        name: 'empty-graph',
        expected: 'rejected',
        input: { n: 1 },
        build: (cfg) => createWorkflow({ id: 'empty', inputSchema: z.object({ n: z.number() }), outputSchema: z.any(), ...cfg }).commit(),
      };
      const v = await runBoth(toCase(empty));
      expect(v.oracleOutcome).toBe('rejected');
      expect(v.identity).toEqual([]);
      expect(v.verdict).toBe('pass');
    });
  });

  describe('data', () => {
    it('timestamps and ids are excluded at Mastra record positions, and only there', () => {
      const a = { status: 'success', runId: 'r1', steps: { s: { status: 'success', output: 1, startedAt: 1, endedAt: 2 } } };
      const b = { status: 'success', runId: 'r2', steps: { s: { status: 'success', output: 1, startedAt: 7, endedAt: 9 } } };
      expect(compareObservations('x', ora(a), cand(b), []).verdict).toBe('pass');
      const c = { ...b, steps: { s: { status: 'success', output: 2, startedAt: 7, endedAt: 9 } } };
      const v = compareObservations('x', ora(a), cand(c), []);
      expect(v.verdict).toBe('fail');
      expect(v.differences.map((d) => d.path)).toEqual(['result.steps.s.output']);
    });

    it("a step record's clock stamps are masked, not dropped: present on one side only is a difference", () => {
      const a = { status: 'success', steps: { s: { status: 'success', output: 1, startedAt: 1, endedAt: 2 } } };
      const b = { status: 'success', steps: { s: { status: 'success', output: 1, startedAt: 7 } } };
      const v = compareObservations('x', ora(a), cand(b), []);
      expect(v.differences).toEqual([{ path: 'result.steps.s.endedAt', oracle: '<clock:number>', candidate: '<absent>' }]);
      expect(v.verdict).toBe('fail');
      const suspended = (extra: Record<string, unknown>) => ({ status: 'suspended', steps: { g: { status: 'suspended', startedAt: 1, ...extra } } });
      expect(compareObservations('x', ora(suspended({ suspendedAt: 3 })), cand(suspended({ suspendedAt: '3' })), []).differences.map((d) => [d.path, d.candidate])).toEqual([
        ['result.steps.g.suspendedAt', '<clock:string>'],
      ]);
    });

    it('the same keys inside user data are compared', () => {
      const out = (timestamp: number, runId: string) => ({ steps: { s: { output: { timestamp, runId } } }, state: { startedAt: timestamp } });
      const v = compareObservations('x', ora(out(1, 'x')), cand(out(2, 'y')), []);
      expect(v.differences.map((d) => d.path)).toEqual([
        'result.state.startedAt',
        'result.steps.s.output.runId',
        'result.steps.s.output.timestamp',
      ]);
    });

    it('the suspend stamp run id is excluded; its path is not', () => {
      const stamp = (runId: string, path: string[]) => ({ steps: { s: { suspendPayload: { __workflow_meta: { runId, path } } } } });
      expect(compareObservations('x', ora(stamp('r1', ['s'])), cand(stamp('r2', ['s'])), []).verdict).toBe('pass');
      expect(compareObservations('x', ora(stamp('r1', ['s'])), cand(stamp('r1', ['t'])), []).verdict).toBe('fail');
    });

    it('an absent key and an undefined one differ', () => {
      expect(compareObservations('x', ora({ a: 1 }), cand({ a: 1, b: undefined }), []).differences.map((d) => d.path)).toEqual(['result.b']);
    });

    it('the error key of a step record is compared', () => {
      const v = compareObservations('x', ora({ steps: { s: { error: new Error('a') } } }), cand({ steps: { s: { error: new Error('b') } } }), []);
      expect(v.differences.map((d) => d.path)).toEqual(['result.steps.s.error.$message']);
    });

    it('an array length difference is a difference', () => {
      expect(compareObservations('x', ora({ p: ['a', 'b'] }), cand({ p: ['a'] }), []).differences.map((d) => d.path)).toEqual(['result.p.length']);
    });

    it('UUIDs become per-observation ordinals: equal structure passes, a different structure fails', () => {
      const keyed = (x: string, y: string) => ({ [`sleep_${x}`]: { status: 'success' }, [`sleep_${y}`]: { status: 'success' } });
      expect(normalise(keyed(U1, U2))).toEqual(normalise(keyed(U3, U1)));
      // Two sleeps whose records collapsed onto one key used to hide this.
      const failedFirst = { [`sleep_${U1}`]: { status: 'failed' }, [`sleep_${U2}`]: { status: 'success' } };
      const v = compareObservations('x', ora({ steps: keyed(U1, U2) }), cand({ steps: failedFirst }), []);
      expect(v.differences.map((d) => d.path)).toEqual(['result.steps.sleep_<uuid#0>.status']);
      // One UUID used twice is not two distinct UUIDs.
      expect(compareObservations('x', ora({ id: U1, same: U1 }), cand({ id: U2, same: U3 }), []).verdict).toBe('fail');
      expect(compareObservations('x', ora({ id: U1, same: U1 }), cand({ id: U2, same: U2 }), []).verdict).toBe('pass');
    });

    it('a key that collides after rewriting throws rather than drops a record', () => {
      expect(() => normalise({ 'k_<uuid#0>': 1, [`k_${U1}`]: 2 })).toThrow(/collide/);
    });

    it('a UUID inside an error message is an ordinal too', () => {
      expect(normalise(new Error(`run ${U1} failed`))).toEqual(normalise(new Error(`run ${U2} failed`)));
      expect(normalise(new Error(`run ${U1} failed`))).not.toEqual(normalise(new Error(`step ${U2} failed`)));
    });

    it('a Map compares by entries, a Set by values, a Date by instant', () => {
      expect(compareObservations('x', ora(new Map([['k', 1]])), cand(new Map([['k', 2]])), []).verdict).toBe('fail');
      expect(compareObservations('x', ora(new Set([1])), cand(new Set([2, 3])), []).verdict).toBe('fail');
      expect(compareObservations('x', ora(new Set([1])), cand(new Set([1])), []).verdict).toBe('pass');
      expect(compareObservations('x', ora(new Date(1)), cand(new Date(2)), []).verdict).toBe('fail');
      expect(compareObservations('x', ora(new Date(1)), cand(new Date(1)), []).verdict).toBe('pass');
    });

    it('two classes with equal fields differ; a hole is not undefined', () => {
      class P {
        constructor(readonly v: number) {}
      }
      class Q {
        constructor(readonly v: number) {}
      }
      expect(compareObservations('x', ora(new P(1)), cand(new Q(1)), []).differences.map((d) => d.path)).toEqual(['result.$class']);
      // eslint-disable-next-line no-sparse-arrays
      expect(compareObservations('x', ora([, 1]), cand([undefined, 1]), []).verdict).toBe('fail');
    });

    it("an Error's name, message and cause are compared; a non-enumerable stack is not, an enumerable one is", () => {
      const named = (name: string) => Object.assign(new Error('m'), { name });
      expect(compareObservations('x', ora(named('A')), cand(named('B')), []).verdict).toBe('fail');
      const caused = (c: string) => new Error('m', { cause: new Error(c) });
      expect(compareObservations('x', ora(caused('a')), cand(caused('b')), []).differences.map((d) => d.path)).toEqual(['result.$cause.$message']);
      expect(compareObservations('x', ora(new Error('m')), cand(new Error('m')), []).verdict).toBe('pass');
      const enumerableStack = (stack: string) => Object.defineProperty(new Error('m'), 'stack', { value: stack, enumerable: true });
      expect(compareObservations('x', ora(enumerableStack('at a')), cand(enumerableStack('at b')), []).differences.map((d) => d.path)).toEqual(['result.stack']);
    });

    it("a rejected start()'s error is compared", () => {
      const rej = (m: string, executions: readonly Execution[]): Observation => ({ kind: 'rejected', error: new Error(m), trace: [], executions });
      expect(compareObservations('x', rej('a', DEFAULT), rej('b', PETRI), []).differences.map((d) => d.path)).toEqual(['error.$message']);
    });

    it('a rejection on one engine and a result on the other is a difference of kind', () => {
      const v = compareObservations('x', { kind: 'rejected', error: new Error('x'), trace: [], executions: DEFAULT }, cand({ status: 'failed' }), []);
      expect(v.differences.map((d) => d.path)).toEqual(['kind']);
    });
  });

  describe('the run budget', () => {
    const overlapping = (labels: string[]): TraceEvent[] => [...labels.map(s), ...labels.map(e)];

    it('peak in flight counts open spans, closing each end against an open start of its label', () => {
      expect(peakInFlight([])).toBe(0);
      expect(peakInFlight(traceOf(['a', 'b', 'c']))).toBe(1);
      expect(peakInFlight(overlapping(['a', 'b', 'c']))).toBe(3);
      expect(peakInFlight([s('a'), s('a'), e('a'), s('b'), e('a'), e('b')])).toBe(2);
      // An end with no open start is not a negative: it closes nothing.
      expect(peakInFlight([e('x'), s('a'), s('b')])).toBe(2);
    });

    it('a candidate above its budget fails, and no attribution can rescue it', () => {
      const at = [{ row: 70, paths: ['**'], reason: 'test' }];
      const v = compareObservations('x', withTrace(ora(1), overlapping(['a', 'b'])), withTrace(cand(1), overlapping(['a', 'b'])), at, [], { concurrency: 1 });
      expect(v.budget).toEqual(['candidate had 2 steps in flight at once, above its budget of 1']);
      expect(v.measurements.peakInFlight).toEqual({ oracle: 2, candidate: 2 });
      expect(v.verdict).toBe('fail');
      expect(formatVerdicts([v])).toContain('BUDGET: candidate had 2 steps in flight at once');
    });

    it('the oracle is never held to the budget: it has none', () => {
      const v = compareObservations('x', withTrace(ora(1), overlapping(['a', 'b'])), cand(1, ['a', 'b']), [], [], { concurrency: 1 });
      expect(v.budget).toEqual([]);
      expect(v.ordering.strengthened).toEqual([['a#0', 'b#0']]);
      expect(v.verdict).toBe('pass');
    });

    it('unbounded gates nothing and says so', () => {
      const v = compareObservations('x', ora(1), withTrace(cand(1), overlapping(['a', 'b', 'c'])), [], [['a', 'b'], ['a', 'c'], ['b', 'c']]);
      expect(v.budget).toEqual([]);
      expect(v.measurements.concurrency).toBe('unbounded');
      expect(v.measurements.wallMs).toEqual({ oracle: null, candidate: null });
    });

    it('runBoth times each side and carries the case budget', async () => {
      const v = await runBoth({
        name: 'timed',
        input: 0,
        concurrency: 2,
        run: async (engine) => (engine === 'default' ? ora(1, ['a']) : cand(1, ['a'])),
      });
      expect(v.measurements.concurrency).toBe(2);
      expect(v.measurements.wallMs.oracle).toBeGreaterThanOrEqual(0);
      expect(v.measurements.wallMs.candidate).toBeGreaterThanOrEqual(0);
    });

    it('the differential report lists every strengthening per fixture and budget, and every verdict in the table', () => {
      const parallelOracle = withTrace(ora(1), overlapping(['a', 'b']));
      const at1 = compareObservations('fx', parallelOracle, cand(1, ['a', 'b']), [], [], { concurrency: 1 });
      const atInf = compareObservations('fx', parallelOracle, withTrace(cand(1), overlapping(['a', 'b'])), []);
      const broken = compareObservations('gx', ora(1), cand(2), [], [], { concurrency: 1 });
      const report = formatDifferentialReport([at1, atInf, broken]);
      expect(report).toContain('fx k=1 (1): a#0<b#0');
      expect(report).not.toContain('fx k=inf (');
      expect(report).toMatch(/^fx\s+pass 1\/2\s+pass 2\/2/m);
      expect(report).toMatch(/^gx\s+fail 0\/0/m);
      expect(report).toContain('k=1: 1 pass, 0 divergent, 1 fail');
      expect(report).toContain('FINDING: result');
    });
  });

  describe('attribution', () => {
    it('an attributed difference is divergent; unattributed is fail', () => {
      const at = [{ row: 4, paths: ['result.steps.*.output'], reason: 'test' }];
      expect(compareObservations('x', ora({ steps: { s: { output: 1 } } }), cand({ steps: { s: { output: 2 } } }), at).verdict).toBe('divergent');
      expect(compareObservations('x', ora({ status: 'a' }), cand({ status: 'b' }), at).verdict).toBe('fail');
    });

    it('an attribution that matched nothing is reported as unused', () => {
      const at = [{ row: 26, paths: ['kind'], reason: 'test' }];
      const v = compareObservations('x', ora({ a: 1 }), cand({ a: 1 }), at);
      expect(v.verdict).toBe('pass');
      expect(v.unusedAttributions).toEqual(at);
    });

    it('path patterns: * is one segment, a trailing ** any rest', () => {
      expect(matches('result.*.a', 'result.x.a')).toBe(true);
      expect(matches('result.*.a', 'result.x.y.a')).toBe(false);
      expect(matches('result.**', 'result')).toBe(true);
      expect(matches('result.**', 'result.a.b')).toBe(true);
      expect(matches('result', 'result.a')).toBe(false);
    });
  });

  describe('happens-before', () => {
    const oracle = ora(1, ['a', 'b', 'c']);

    it('overlapping a dependent pair is an inversion and fails; declared independent it is a weakening and passes', () => {
      const overlapping = withTrace(cand(1), [s('a'), e('a'), s('b'), s('c'), e('b'), e('c')]);
      const v = compareObservations('x', oracle, overlapping, []);
      expect(v.ordering.inverted).toEqual([['b#0', 'c#0']]);
      expect(v.differences.map((d) => d.path)).toEqual(['order.b#0.c#0']);
      expect(v.verdict).toBe('fail');

      const ok = compareObservations('x', oracle, overlapping, [], [['c', 'b']]);
      expect(ok.ordering.weakened).toEqual([['b#0', 'c#0']]);
      expect(ok.ordering.inverted).toEqual([]);
      expect(ok.verdict).toBe('pass');
    });

    it('starting b before a, or starting b and never ending a, fails', () => {
      const early = withTrace(cand(1), [s('b'), s('a'), e('a'), e('b'), s('c'), e('c')]);
      expect(compareObservations('x', oracle, early, []).verdict).toBe('fail');
      const hung = withTrace(cand(1), [s('a'), s('b'), e('b'), s('c'), e('c')]);
      const v = compareObservations('x', oracle, hung, []);
      expect(v.ordering.inverted).toEqual([
        ['a#0', 'b#0'],
        ['a#0', 'c#0'],
      ]);
      expect(v.verdict).toBe('fail');
    });

    it('a reversal fails', () => {
      const reordered = compareObservations('x', oracle, cand(1, ['a', 'c', 'b']), []);
      expect(reordered.verdict).toBe('fail');
      expect(reordered.ordering.reversed).toEqual([['b#0', 'c#0']]);
      expect(reordered.differences.map((d) => d.path)).toEqual(['order.b#0.c#0']);
    });

    it('a candidate ordering the oracle lacks is reported as strengthened, not gated', () => {
      const parallelOracle = withTrace(ora(1), [s('a'), s('b'), e('a'), e('b')]);
      const v = compareObservations('x', parallelOracle, cand(1, ['a', 'b']), []);
      expect(v.ordering.strengthened).toEqual([['a#0', 'b#0']]);
      expect(v.verdict).toBe('pass');
    });

    it('a step that ran on one engine only is a gated difference, either way round', () => {
      const v = compareObservations('x', ora(1, ['a', 'b']), cand(1, ['a']), []);
      expect(v.differences.map((d) => d.path)).toEqual(['trace.b#0']);
      expect(v.verdict).toBe('fail');
      expect(compareObservations('x', ora(1, ['a']), cand(1, ['a', 'b']), []).differences.map((d) => d.path)).toEqual(['trace.b#0']);
    });

    it('positive control on a real run: a candidate trace with two steps swapped is a reversal and fails', async () => {
      const linear = FIXTURES.find((f) => f.name === 'linear')!;
      const o = await observe(linear, 'default', linear.input);
      const c = await observe(linear, 'petri', linear.input);
      expect(compareObservations('linear', o, c, []).verdict).toBe('pass');
      const swap = (l: string) => (l === 'b' ? 'c' : l === 'c' ? 'b' : l);
      const swapped = { ...c, trace: c.trace.map((ev) => ({ ...ev, label: swap(ev.label) })) };
      const v = compareObservations('linear', o, swapped, []);
      expect(v.ordering.reversed).toEqual([['b#0', 'c#0']]);
      expect(v.verdict).toBe('fail');
    });
  });
});

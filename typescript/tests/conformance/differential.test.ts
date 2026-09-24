import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createWorkflow } from '@mastra/core/workflows';
import {
  compareObservations,
  formatVerdicts,
  matches,
  normalise,
  runBoth,
  type Execution,
  type Observation,
  type TraceEvent,
  type Verdict,
} from '../../src/conformance/differential.js';
import { FIXTURES, observe, toCase, type MastraFixture } from '../fixtures/mastra-workflows.js';

const DIVERGENCES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/divergences.md');
const documentedRows = new Set(
  [...readFileSync(DIVERGENCES, 'utf8').matchAll(/^\| (\d+) \|/gm)].map((m) => Number(m[1])),
);

/** Label patterns a fixture declared independent, or none: at k = 1 no weakening is expected. */
const independentOf = (f: MastraFixture) => f.independent ?? [];

describe('the corpus, both engines, concurrency k = 1', () => {
  const verdicts: Verdict[] = [];
  afterAll(() => {
    // The report, every fixture: its verdict and rows, each difference with its row or as a FINDING, and the ordering.
    const report = formatVerdicts(verdicts);
    console.log(report);
    const out = process.env['DIFFERENTIAL_REPORT'];
    if (out !== undefined && out !== '') writeFileSync(out, `${report}\n`);
  });

  for (const fixture of FIXTURES) {
    it(fixture.name, async () => {
      const verdict = await runBoth(toCase(fixture));
      verdicts.push(verdict);
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
      expect(verdict.ordering.reversed).toEqual([]);
      expect(verdict.ordering.inverted).toEqual([]);
      if (independentOf(fixture).length === 0) expect(verdict.ordering.weakened).toEqual([]);

      expect(verdict.verdict).not.toBe('fail');
    });
  }

  it('the nested fixtures ran their inner workflow on the petri engine too', async () => {
    for (const name of ['nested-workflow', 'nested-suspend']) {
      const f = FIXTURES.find((x) => x.name === name)!;
      const petri = await observe(f, 'petri', f.input);
      const def = await observe(f, 'default', f.input);
      expect(petri.executions.length).toBe(2);
      expect(petri.executions.every((e) => e.engine === 'petri')).toBe(true);
      expect(def.executions.every((e) => e.engine === 'default')).toBe(true);
      expect(new Set(petri.executions.map((e) => e.workflowId))).toEqual(new Set(def.executions.map((e) => e.workflowId)));
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

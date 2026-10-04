import { describe, expect, it } from 'vitest';
import { runBoth, runResume, peakInFlight } from '../../src/conformance/differential.js';
import { blockLimit, BUDGETS, FIXTURES, RESUME_FIXTURES, toCase, toResumeCase, widthOf } from '../fixtures/mastra-workflows.js';

/**
 * The block-limited fixtures of the differential corpus ([ADR 0011], M7 W2), held to what the
 * corpus-wide gate in `differential.test.ts` does not check: the bound **binds**. The corpus gate
 * already requires each to pass with nothing reversed or inverted at k in {1, 2, 4, unbounded}; here
 * the candidate's peak is exactly `min(c, k)` while Mastra overlaps every arm, so a block limit that
 * silently stopped binding — or a corpus that never overlapped — cannot pass the `<= k` gate
 * vacuously. Every arm runs on both engines, the failing one included.
 *
 * Environment: real Mastra runs, both engines, the machine clock; every arm waits a timer.
 * Tested, not proven — the nets are proven by `tests/verify/corpus.test.ts`.
 */

const budgetName = (k: number | undefined) => (k === undefined ? 'unbounded' : String(k));
const FRESH = ['parallel-limited', 'branch-limited', 'parallel-limited-failing'] as const;

describe('the block limit binds in the differential', () => {
  for (const name of FRESH) {
    const f = FIXTURES.find((x) => x.name === name)!;
    for (const k of BUDGETS) {
      const c = blockLimit();
      const peak = Math.min(c, k ?? Infinity);
      it(`${name} at k = ${budgetName(k)}: candidate peak ${peak}, oracle ${widthOf(f)}`, async () => {
        expect(f).toBeDefined();
        expect(c).toBeLessThan(widthOf(f));
        const v = await runBoth(toCase(f, k));
        expect(v.verdict).toBe('pass');
        expect(v.oracleOutcome).toBe(f.expected);
        expect(v.differences).toEqual([]);
        expect(v.ordering.reversed).toEqual([]);
        expect(v.ordering.inverted).toEqual([]);
        expect(v.measurements.peakInFlight.oracle).toBe(widthOf(f));
        expect(v.measurements.peakInFlight.candidate).toBe(peak);
        // Serialising what Mastra overlapped is a strengthening, reported, never silent.
        expect(v.ordering.strengthened.length).toBeGreaterThan(0);
      });
    }
  }

  it('parallel-limited-failing: every arm still runs on the candidate, after the failure too', async () => {
    const f = FIXTURES.find((x) => x.name === 'parallel-limited-failing')!;
    const c = toCase(f);
    const petri = await c.run('petri', c.input);
    const started = petri.trace.filter((e) => e.kind === 'start').map((e) => e.label);
    expect(started).toEqual(['bad', 'f1', 'f2', 'f3']);
    // The failing arm settled before the third arm was admitted: its slot came back.
    const badEnd = petri.trace.findIndex((e) => e.kind === 'end' && e.label === 'bad');
    const f2Start = petri.trace.findIndex((e) => e.kind === 'start' && e.label === 'f2');
    expect(badEnd).toBeLessThan(f2Start);
    expect(peakInFlight(petri.trace)).toBe(blockLimit());
  });
});

describe('the block limit binds across suspend and resume', () => {
  const f = RESUME_FIXTURES.find((x) => x.name === 'parallel-limited-suspend')!;
  for (const k of BUDGETS) {
    it(`parallel-limited-suspend at k = ${budgetName(k)}: every route passes, the petri side one arm at a time`, async () => {
      const verdicts = await runResume(toResumeCase(f, k));
      for (const v of verdicts) {
        expect(v.verdict).toBe('pass');
        expect(v.oraclePhases).toEqual(f.expected);
        expect(v.measurements.peakInFlight.oracle).toBe(3);
        // c = 1 on every route that started on the petri engine; the default>petri route starts on
        // Mastra's, which runs all three arms at once, and resumes one arm at a time on either.
        if (v.route.suspendOn === 'petri') expect(v.measurements.peakInFlight.candidate).toBe(1);
      }
    });
  }
});

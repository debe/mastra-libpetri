import { describe, expect, it } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { verifyWorkflow, describeReport } from '../../src/verify/index.js';
import { inertRunner } from '../fixtures/runner.js';

const chain = {
  id: 'orders',
  entries: [
    { kind: 'step', id: 'validate' },
    { kind: 'step', id: 'charge' },
    { kind: 'sleep', id: 'cooldown', durationMs: 50 },
    { kind: 'step', id: 'ship' },
  ],
} as const;

describe('compiled linear chain, proved', () => {
  it('is deadlock-free and terminates at a declared sink', async () => {
    const reports = await verifyWorkflow(compile(chain, { runner: inertRunner }));

    // Assert `proven` explicitly. `isViolated()` is false for `unknown` too, so asserting
    // "not violated" would pass on a query that timed out.
    for (const report of reports) {
      expect(report.result.verdict.type, describeReport(report)).toBe('proven');
    }
    expect(reports.map((r) => r.property)).toEqual(['deadlockFree', 'terminatesAtSink']);
  }, 90_000);
});

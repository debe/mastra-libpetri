import { describe, expect, it } from 'vitest';
import { Transition, and, one, outPlace, place } from 'libpetri';
import { compile, type Gadget } from '../../src/compiler/index.js';
import { runWorkflow } from '../../src/engine/index.js';
import { verifyWorkflow, describeReport, type PropertyReport } from '../../src/verify/index.js';
import type { FlowToken, WorkflowDescription } from '../../src/compiler/types.js';
import { RecordingRunner } from '../fixtures/runner.js';

function expectBothProven(reports: readonly PropertyReport[]): void {
  expect(reports.map((r) => r.property)).toEqual(['deadlockFree', 'terminatesAtSink', 'exactlyOneTerminal']);
  for (const report of reports) {
    // Assert `proven` explicitly. `isViolated()` is false for `unknown` too, so asserting
    // "not violated" would pass on a query that timed out.
    expect(report.result.verdict.type, describeReport(report)).toBe('proven');
  }
}

/**
 * Properties `deadlockFree`, `terminatesAtSink` and `exactlyOneTerminal`; initial marking one token in the entry place;
 * no environment places (closed net); sinks `wf.done`, `wf.failed`, `wf.bailed`, `wf.suspended`,
 * `wf.paused`. The route is reported by `describeReport` if an assertion fails.
 */
describe('compiled linear chain, proved', () => {
  it('is deadlock-free and terminates at a declared sink', async () => {
    const chain: WorkflowDescription = {
      id: 'orders',
      entries: [
        { kind: 'step', id: 'validate' },
        { kind: 'step', id: 'charge' },
        { kind: 'sleep', id: 'cooldown', duration: { fixed: 50 } },
        { kind: 'step', id: 'ship' },
      ],
    };

    // `compile` takes no runner: a net compiled only to be verified never fires.
    expectBothProven(await verifyWorkflow(compile(chain)));
  }, 90_000);

  it('proves a chain using every leaf form at once', async () => {
    const chain: WorkflowDescription = {
      id: 'every-leaf',
      entries: [
        { kind: 'step', id: 'validate', retries: 2, retryDelayMs: 1_000 },
        { kind: 'step', id: 'sub', source: 'workflow' },
        { kind: 'sleep', id: 'cooldown', duration: { fixed: 50 } },
        { kind: 'sleep', id: 'backoff', duration: { perRun: true } },
        { kind: 'sleepUntil', id: 'window', until: { perRun: true } },
        { kind: 'step', id: 'ship', retries: 1 },
      ],
    };

    expectBothProven(await verifyWorkflow(compile(chain)));
  }, 90_000);
});

/**
 * Why `exactlyOneTerminal` exists, pinned: a step that deposits on success **and** on failure in
 * one firing reaches two terminals. Every sink is marked and nothing is stranded, so
 * `deadlockFree` and `terminatesAtSink` both stay proven — only `quiescentCount(terminals, 1, 1)`
 * sees it. Property, marking, environment and sinks as above; the mutant replaces the step gadget
 * through the `gadgets` override and touches nothing in `src/`.
 */
describe('exactlyOneTerminal catches what the other two cannot', () => {
  const doubleExit: Gadget = (entry, next, ctx) => {
    if (entry.kind !== 'step') throw new Error('step only');
    const inPlace = place<FlowToken>(ctx.names.entryIn(ctx.path, entry.id));
    const run = Transition.builder(ctx.names.entryRun(ctx.path, entry.id))
      .inputs(one(inPlace))
      .outputs(and(outPlace(next), outPlace(ctx.exits.failed)))
      .action(async (tctx) => {
        const incoming = tctx.input(inPlace);
        tctx.output(next, incoming);
        tctx.output(ctx.exits.failed, { stepId: entry.id, error: 'both' });
      })
      .build();
    return { inPlace, transitions: [run] };
  };
  const chain: WorkflowDescription = { id: 'double', entries: [{ kind: 'step', id: 'a' }] };

  it('the intact chain proves all three', async () => {
    expectBothProven(await verifyWorkflow(compile(chain)));
  });

  it('a step reaching two terminals is violated by exactlyOneTerminal alone, and shows as residue', async () => {
    const compiled = compile(chain, { gadgets: { step: doubleExit } });
    const reports = await verifyWorkflow(compiled);
    const verdict = (p: string) => reports.find((r) => r.property === p)!.result.verdict.type;

    expect(verdict('deadlockFree'), reports.map(describeReport).join('; ')).toBe('proven');
    expect(verdict('terminatesAtSink'), reports.map(describeReport).join('; ')).toBe('proven');
    expect(verdict('exactlyOneTerminal'), reports.map(describeReport).join('; ')).toBe('violated');

    // The run agrees: classify reports the failure and names the second terminal as residue.
    const outcome = await runWorkflow(compiled, 'x', { runner: new RecordingRunner() });
    expect(outcome).toEqual({ status: 'failed', stepId: 'a', error: 'both', residue: ['wf.done'] });
  });
});

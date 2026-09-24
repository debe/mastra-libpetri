import { describe, expect, it } from 'vitest';
import { Transition, and, one, outPlace, place } from 'libpetri';
import { compile, type Gadget } from '../../src/compiler/index.js';
import { runWorkflow } from '../../src/engine/index.js';
import { cancelStructureViolations, verifyWorkflow, describeReport, type PropertyReport } from '../../src/verify/index.js';
import type { EntryDescription, FlowToken, WorkflowDescription } from '../../src/compiler/types.js';
import { RecordingRunner } from '../fixtures/runner.js';

/** Every report `verifyWorkflow` returns by default, in order: both segments on one closed net. */
const ALL_REPORTS = [
  'closed/deadlockFree',
  'closed/terminatesAtSink',
  'closed/exactlyOneTerminal',
  'closed/neverCanceled',
  'cancel/deadlockFree',
  'cancel/terminatesAtSink',
  'cancel/exactlyOneTerminal',
];

function expectAllProven(reports: readonly PropertyReport[]): void {
  expect(reports.map((r) => `${r.segment}/${r.property}`)).toEqual(ALL_REPORTS);
  for (const report of reports) {
    // Assert `proven` explicitly. `isViolated()` is false for `unknown` too, so asserting
    // "not violated" would pass on a query that timed out.
    expect(report.result.verdict.type, describeReport(report)).toBe('proven');
  }
}

/** The structural cancel check, then both segments, through `verifyWorkflow`'s default. */
async function expectProvenBothSegments(description: WorkflowDescription): Promise<readonly PropertyReport[]> {
  const reports = await verifyWorkflow(compile(description));
  expectAllProven(reports);
  return reports;
}

const verdict = (reports: readonly PropertyReport[], key: string): string | undefined =>
  reports.find((r) => `${r.segment}/${r.property}` === key)?.result.verdict.type;

/**
 * `verifyWorkflow`'s default. First the structural cancel check, which throws on a violation.
 * Then two segments on one closed net, sinks the six terminals (`wf.done`, `wf.failed`,
 * `wf.bailed`, `wf.suspended`, `wf.paused`, `wf.canceled`) and `wf.cancel`:
 * - `closed` — initial marking one token in the entry place, `wf.cancel.request` empty (no
 *   cancellation): `deadlockFree`, `terminatesAtSink`, `exactlyOneTerminal`, and `neverCanceled`
 *   (`placeBound(wf.canceled, 0)`, a reachability bound).
 * - `cancel` — one token in the entry place and one in `wf.cancel.request`, so `t.cancel.arrive`
 *   lands the signal at every reachable point: the first three.
 * The route is reported by `describeReport` if an assertion fails.
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
    await expectProvenBothSegments(chain);
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

    await expectProvenBothSegments(chain);
  }, 180_000);
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
        tctx.output(ctx.exits.failed, { stepId: entry.id, path: ctx.viewPath, error: 'both' });
      })
      .build();
    return { inPlace, transitions: [run] };
  };
  const chain: WorkflowDescription = { id: 'double', entries: [{ kind: 'step', id: 'a' }] };

  it('the intact chain proves every property in both segments', async () => {
    await expectProvenBothSegments(chain);
  });

  it('a step reaching two terminals is violated by exactlyOneTerminal alone, and shows as residue', async () => {
    const compiled = compile(chain, { gadgets: { step: doubleExit } });
    // The mutant has no gate and no sweep: nothing the structural check could flag.
    const reports = await verifyWorkflow(compiled);
    const all = reports.map(describeReport).join('; ');

    expect(verdict(reports, 'closed/deadlockFree'), all).toBe('proven');
    expect(verdict(reports, 'closed/terminatesAtSink'), all).toBe('proven');
    expect(verdict(reports, 'closed/exactlyOneTerminal'), all).toBe('violated');
    expect(verdict(reports, 'closed/neverCanceled'), all).toBe('proven');
    // Under cancellation too: two settle tokens each re-stamped is two canceled terminals.
    expect(verdict(reports, 'cancel/deadlockFree'), all).toBe('proven');
    expect(verdict(reports, 'cancel/terminatesAtSink'), all).toBe('proven');
    expect(verdict(reports, 'cancel/exactlyOneTerminal'), all).toBe('violated');

    // The run agrees: classify reports the failure and names the second terminal as residue.
    const outcome = await runWorkflow(compiled, 'x', { runner: new RecordingRunner() });
    expect(outcome).toEqual({ status: 'failed', stepId: 'a', path: [0], error: 'both', residue: ['wf.done'] });
  });
});

/**
 * The fixed sleep is now `begin` (immediate, records `waiting`) -> `waiting` -> `wake` (delayed),
 * with a sweep on each place. Proved beside every combinator, the sleep on both sides of it:
 * properties, initial marking, environment and sinks as `verifyWorkflow`'s default above (the
 * structural check first, then the closed and the cancel segment).
 */
describe('fixed sleeps around every gadget, proved', () => {
  const nap = (id: string): EntryDescription => ({ kind: 'sleep', id, duration: { fixed: 25 } });
  const arms = [{ kind: 'step', id: 'a' }, { kind: 'step', id: 'b', retries: 1 }] as const;
  const gadgets: ReadonlyArray<readonly [string, EntryDescription]> = [
    ['parallel', { kind: 'parallel', id: 'fan', arms }],
    ['branch', { kind: 'branch', id: 'route', arms }],
    ['dowhile', { kind: 'loop', id: 'poll', loopType: 'dowhile', iterationBound: 2, body: { kind: 'step', id: 'tick' } }],
    ['foreach', { kind: 'foreach', id: 'items', concurrency: 2, body: { kind: 'step', id: 'item' } }],
  ];

  // Each query's solver budget is 300s — what `tests/verify/foreach.test.ts` gives a two-lane
  // foreach, whose queries the 30s default leaves `unknown`.
  it.concurrent.for(gadgets)('a fixed sleep before and after a %s', { timeout: 1_800_000 }, async ([, entry], { expect }) => {
    const description: WorkflowDescription = { id: 'sleepy', entries: [nap('before'), entry, nap('after')] };
    expect(cancelStructureViolations(compile(description))).toEqual([]);
    const reports = await verifyWorkflow(compile(description), { timeoutMs: 300_000 });
    expect(reports.map((r) => `${r.segment}/${r.property}`)).toEqual(ALL_REPORTS);
    for (const report of reports) expect(report.result.verdict.type, describeReport(report)).toBe('proven');
  });
});

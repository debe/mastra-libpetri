import { describe, expect, it } from 'vitest';
import { Transition, and, one, outPlace, place } from 'libpetri';
import { compile, type Gadget } from '../../src/compiler/index.js';
import { runWorkflow } from '../../src/engine/index.js';
import {
  cancelStructureViolations,
  describeReport,
  resumeGateViolations,
  segmentLabel,
  segmentsFor,
  verifyWorkflow,
  type PropertyReport,
  type Segment,
} from '../../src/verify/index.js';
import type { CompiledWorkflow, EntryDescription, FlowToken, WorkflowDescription } from '../../src/compiler/types.js';
import { RecordingRunner } from '../fixtures/runner.js';

/** The property set `verifyWorkflow` proves in a segment with no cancel arriving, and in one with. */
const UNCANCELED = ['deadlockFree', 'terminatesAtSink', 'exactlyOneTerminal', 'neverCanceled'] as const;
const CANCELED = ['deadlockFree', 'terminatesAtSink', 'exactlyOneTerminal'] as const;
const cancels = (segment: Segment): boolean => (typeof segment === 'string' ? segment === 'cancel' : segment.cancel);
const keyOf = (r: PropertyReport): string => `${segmentLabel(r.segment)}/${r.property}`;

/**
 * Every report `verifyWorkflow` returns by default, in order, on one closed net: `closed`,
 * `cancel`, then `resume@s` and `resume@s+cancel` for every resume site ([ADR 0007]).
 */
const allReports = (compiled: CompiledWorkflow): string[] =>
  segmentsFor(compiled).flatMap((segment) => (cancels(segment) ? CANCELED : UNCANCELED).map((p) => `${segmentLabel(segment)}/${p}`));

function expectAllProven(compiled: CompiledWorkflow, reports: readonly PropertyReport[]): void {
  expect(reports.map(keyOf)).toEqual(allReports(compiled));
  for (const report of reports) {
    // Assert `proven` explicitly. `isViolated()` is false for `unknown` too, so asserting
    // "not violated" would pass on a query that timed out.
    expect(report.result.verdict.type, describeReport(report)).toBe('proven');
  }
}

/** The structural cancel check, then both segments, through `verifyWorkflow`'s default. */
async function expectProvenBothSegments(description: WorkflowDescription): Promise<readonly PropertyReport[]> {
  const compiled = compile(description);
  const reports = await verifyWorkflow(compiled);
  expectAllProven(compiled, reports);
  return reports;
}

const verdict = (reports: readonly PropertyReport[], key: string): string | undefined =>
  reports.find((r) => keyOf(r) === key)?.result.verdict.type;

/**
 * `verifyWorkflow`'s default. First the structural cancel check, which throws on a violation.
 * Then two segments on one closed net, sinks the six terminals (`wf.done`, `wf.failed`,
 * `wf.bailed`, `wf.suspended`, `wf.paused`, `wf.canceled`) and `wf.cancel`:
 * - `closed` — initial marking one token in the entry place, `wf.cancel.request` empty (no
 *   cancellation): `deadlockFree`, `terminatesAtSink`, `exactlyOneTerminal`, and `neverCanceled`
 *   (`placeBound(wf.canceled, 0)`, a reachability bound).
 * - `cancel` — one token in the entry place and one in `wf.cancel.request`, so `t.cancel.arrive`
 *   lands the signal at every reachable point: the first three.
 * - `resume@s` and `resume@s+cancel` for every resume site ([ADR 0007]) — one token at the site
 *   instead of the entry place, the same property sets. Each step's input place is a site.
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
  });

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
  });
});

/**
 * Why `exactlyOneTerminal` exists, pinned: a step that deposits on success **and** on failure in
 * one firing reaches two terminals. Every sink is marked and nothing is stranded, so
 * `deadlockFree` and `terminatesAtSink` both stay proven — only `quiescentCount(terminals, 1, 1)`
 * sees it. Property, marking, environment and sinks as above; the mutant replaces the step gadget
 * through the `gadgets` override and touches nothing in `src/`.
 */
describe('exactlyOneTerminal catches what the other two cannot', () => {
  // The step's cancellation structure is kept as the real leaf builds it — the run inhibited by the
  // signal, and a sweep of the waiting input to `canceled` — so the double exit is the only defect.
  // The input place is also resume site 0 ([ADR 0007]); without the gate and the sweep the resume
  // gate check would refuse the net before any proof ran.
  const doubleExit: Gadget = (entry, next, ctx) => {
    if (entry.kind !== 'step') throw new Error('step only');
    const { cancel } = ctx;
    if (cancel === undefined) throw new Error('the mutant expects a cancellable top-level step');
    const inPlace = place<FlowToken>(ctx.names.entryIn(ctx.path, entry.id));
    const run = Transition.builder(ctx.names.entryRun(ctx.path, entry.id))
      .inputs(one(inPlace))
      .inhibitor(cancel)
      .outputs(and(outPlace(next), outPlace(ctx.exits.failed)))
      .action(async (tctx) => {
        const incoming = tctx.input(inPlace);
        tctx.output(next, incoming);
        tctx.output(ctx.exits.failed, { stepId: entry.id, path: ctx.viewPath, error: 'both' });
      })
      .build();
    const sweep = Transition.builder(ctx.names.entryTransition(ctx.path, entry.id, 'cancel'))
      .inputs(one(inPlace))
      .read(cancel)
      .outputs(outPlace(ctx.exits.canceled))
      .action(async (tctx) => {
        tctx.input(inPlace);
        tctx.output(ctx.exits.canceled, { origin: { stepId: entry.id, path: ctx.viewPath }, started: false });
      })
      .build();
    return { inPlace, transitions: [run, sweep] };
  };
  const chain: WorkflowDescription = { id: 'double', entries: [{ kind: 'step', id: 'a' }] };

  it('the intact chain proves every property in both segments', async () => {
    await expectProvenBothSegments(chain);
  });

  it('a step reaching two terminals is violated by exactlyOneTerminal alone, and shows as residue', async () => {
    const compiled = compile(chain, { gadgets: { step: doubleExit } });
    // The mutant's gate and sweep are the real leaf's: nothing the structural checks could flag.
    expect(cancelStructureViolations(compiled)).toEqual([]);
    expect(resumeGateViolations(compiled)).toEqual([]);
    const reports = await verifyWorkflow(compiled);
    const all = reports.map(describeReport).join('; ');
    expect(reports.map(keyOf), all).toEqual(allReports(compiled));

    expect(verdict(reports, 'closed/deadlockFree'), all).toBe('proven');
    expect(verdict(reports, 'closed/terminatesAtSink'), all).toBe('proven');
    expect(verdict(reports, 'closed/exactlyOneTerminal'), all).toBe('violated');
    expect(verdict(reports, 'closed/neverCanceled'), all).toBe('proven');
    // Under cancellation too: two settle tokens each re-stamped is two canceled terminals.
    expect(verdict(reports, 'cancel/deadlockFree'), all).toBe('proven');
    expect(verdict(reports, 'cancel/terminatesAtSink'), all).toBe('proven');
    expect(verdict(reports, 'cancel/exactlyOneTerminal'), all).toBe('violated');
    // Resume site 0 is the step's input, the entry place itself: the resumed segments start where
    // the fresh ones do, and see the same.
    expect(verdict(reports, 'resume@0/deadlockFree'), all).toBe('proven');
    expect(verdict(reports, 'resume@0/terminatesAtSink'), all).toBe('proven');
    expect(verdict(reports, 'resume@0/exactlyOneTerminal'), all).toBe('violated');
    expect(verdict(reports, 'resume@0/neverCanceled'), all).toBe('proven');
    expect(verdict(reports, 'resume@0+cancel/deadlockFree'), all).toBe('proven');
    expect(verdict(reports, 'resume@0+cancel/terminatesAtSink'), all).toBe('proven');
    expect(verdict(reports, 'resume@0+cancel/exactlyOneTerminal'), all).toBe('violated');

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
  it.concurrent.for(gadgets)('a fixed sleep before and after a %s', async ([, entry], { expect }) => {
    const description: WorkflowDescription = { id: 'sleepy', entries: [nap('before'), entry, nap('after')] };
    expect(cancelStructureViolations(compile(description))).toEqual([]);
    const compiled = compile(description);
    const reports = await verifyWorkflow(compiled, { timeoutMs: 30_000 });
    expect(reports.map(keyOf)).toEqual(allReports(compiled));
    for (const report of reports) expect(report.result.verdict.type, describeReport(report)).toBe('proven');
  });
});

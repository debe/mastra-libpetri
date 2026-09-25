import { appendFileSync } from 'node:fs';
import { describe, it, type ExpectStatic } from 'vitest';
import { Transition, one, type Out, type Place } from 'libpetri';
import {
  SmtVerifier,
  mutualExclusion,
  type SmtProperty,
  type SmtVerificationResult,
} from 'libpetri/verification';
import { compile, type Gadget } from '../../src/compiler/index.js';
import { foreachGadget } from '../../src/compiler/gadgets/foreach.js';
import {
  cancelStructureViolations,
  describeReport,
  resumeGateViolations,
  resumeSegment,
  resumeTimingViolations,
  segmentInitialMarking,
  segmentLabel,
  suspensionCoverageViolations,
  thresholdOnlyViolations,
  verifyWorkflow,
  type PropertyReport,
  type Segment,
} from '../../src/verify/index.js';
import { budgetStructureViolations } from '../../src/verify/budget.js';
import type { CompiledWorkflow, EntryDescription, StepDescription } from '../../src/compiler/types.js';

/**
 * `.foreach()` resume, proved ([ADR 0007], contract C14/C15).
 *
 * **What every proof here is about.** `verifyWorkflow`'s route: the structural checks first
 * (cancel, budget, resume gate, threshold-only, suspension coverage, resume timing), then every
 * segment — `closed` and `cancel` from one token at the workflow's entry, and for each resume site
 * `s`, `resume@s` from `{site: 1[, wf.permits: k]}` and `resume@s+cancel` from the same plus one
 * cancel request. Environment closed, untimed, value-blind, semiflow invariants on, every terminal,
 * the cancel place and the permits declared sinks. The route is whatever libpetri reports (SMT for
 * every foreach shape measured), and every verdict is asserted `=== 'proven'` by string — never
 * `!isViolated()`, which passes on `unknown`.
 *
 * **Why one seed covers every resume.** `re-enter` chooses among the eight subsets of {cursor,
 * results, parked} by an `xor`, which the value-blind proof explores in full; `results` and
 * `parked` are touched by threshold arcs only (`all()`, resets, inhibitors, outputs — checked
 * structurally by `thresholdOnlyViolations`), so the one token the analysis deposits there stands
 * exactly for any count from one up ([IO-016]). The item count is free as in the fresh segments.
 *
 * **Figures** are against libpetri 6.1.0 from the npm registry (not linked;
 * `scripts/link-libpetri.sh --provenance` reports "not linked"). Set `PROOF_LOG` to a file to
 * record every figure with its route. Three lanes run only with `SLOW_PROOFS=1`.
 */

const body = (extra: Omit<StepDescription, 'kind' | 'id'> = {}): StepDescription => ({ kind: 'step', id: 'body', ...extra });
const foreach = (concurrency: number, b: StepDescription = body()): EntryDescription => ({
  kind: 'foreach',
  id: 'items',
  body: b,
  concurrency,
});
const build = (entries: readonly EntryDescription[], gadget?: Gadget, concurrency?: number): CompiledWorkflow =>
  compile({ id: 'batch', entries }, { ...(gadget ? { gadgets: { foreach: gadget } } : {}), ...(concurrency ? { concurrency } : {}) });

const PROVENANCE = 'libpetri 6.1.0 (npm registry, not linked)';
const proofLog = (line: string): void => {
  const file = process.env['PROOF_LOG'];
  if (file) appendFileSync(file, `${PROVENANCE} ${line}\n`);
};

const SLOW_LANE = process.env['SLOW_PROOFS'] === '1';
const BUDGET = { timeout: 3_600_000 } as const;

const CLOSED = ['deadlockFree', 'terminatesAtSink', 'exactlyOneTerminal', 'neverCanceled'];
const CANCEL = ['deadlockFree', 'terminatesAtSink', 'exactlyOneTerminal'];
const PERMITS = ['permitsBounded', 'permitsReturned'];
const keyOf = (r: PropertyReport): string => `${segmentLabel(r.segment)}/${r.property}`;

/** Every key `verifyWorkflow` must report for these sites: fresh ±cancel, then each site ±cancel. */
function everyKey(compiled: CompiledWorkflow, sites: readonly string[]): string[] {
  const extra = compiled.budget ? PERMITS : [];
  return ['closed', 'cancel', ...sites.flatMap((s) => [`resume@${s}`, `resume@${s}+cancel`])].flatMap((segment) =>
    (segment === 'closed' || !segment.endsWith('cancel') ? CLOSED : CANCEL).concat(extra).map((p) => `${segment}/${p}`),
  );
}

/** `verifyWorkflow`'s default, every structural check clean, every property of every segment proven. */
async function proveAll(expect: ExpectStatic, label: string, compiled: CompiledWorkflow, sites: readonly string[], timeoutMs = 600_000): Promise<void> {
  expect([...compiled.resumeSites.keys()].sort()).toStrictEqual([...sites].sort());
  for (const check of [
    cancelStructureViolations,
    budgetStructureViolations,
    resumeGateViolations,
    thresholdOnlyViolations,
    suspensionCoverageViolations,
    resumeTimingViolations,
  ]) {
    expect(check(compiled), check.name).toStrictEqual([]);
  }
  const started = Date.now();
  const reports = await verifyWorkflow(compiled, { timeoutMs });
  proofLog(`[${label}] total ${Date.now() - started}ms; ${reports.map(describeReport).join('; ')}`);
  expect(reports.map(keyOf).sort()).toStrictEqual(everyKey(compiled, sites).sort());
  for (const r of reports) expect(r.result.verdict.type, `${label}: ${describeReport(r)}`).toBe('proven');
}

/** One property from exactly a segment's initial marking, under `verifyWorkflow`'s hypotheses. */
function check(compiled: CompiledWorkflow, property: SmtProperty, segment: Segment, timeoutMs = 600_000): Promise<SmtVerificationResult> {
  const t = compiled.terminals;
  return SmtVerifier.forNet(compiled.net)
    .initialMarking((m) => {
      for (const [p, n] of segmentInitialMarking(compiled, segment)) m.tokens(p, n);
    })
    .sinkPlaces(t.done, t.failed, t.bailed, t.suspended, t.paused, t.canceled, compiled.cancel, ...(compiled.budget ? [compiled.budget.permits] : []))
    .semiflowInvariants(true)
    .timeout(timeoutMs)
    .property(property)
    .verify();
}
const verdictOf = (r: SmtVerificationResult): string =>
  `${r.verdict.type} via ${r.route} in ${r.elapsedMs}ms${r.verdict.type === 'unknown' ? ` (${r.verdict.reason})` : ''}`;

function placeNamed(compiled: CompiledWorkflow, name: string): Place<unknown> {
  const found = [...compiled.net.places].find((p) => p.name === name);
  if (found === undefined) throw new Error(`no place '${name}' in the compiled net`);
  return found as Place<unknown>;
}

// -------------------------------------------------------------------------------------------
// Mutated copies: the real gadget compiled, then one arc or transition removed. A mutation that
// matches nothing throws, so a renamed transition cannot make a check vacuous. `src` is never
// edited.
// -------------------------------------------------------------------------------------------

interface Mutation {
  readonly transition: RegExp;
  readonly dropInhibitor?: RegExp;
  readonly dropReset?: RegExp;
  /** Replaces an `all()` input on a matching place with `one()`. */
  readonly oneInsteadOfAll?: RegExp;
  /** Removes the whole transition. */
  readonly remove?: true;
}

function rebuild(t: Transition, m: Mutation): Transition {
  const b = Transition.builder(t.name)
    .inputs(
      ...t.inputSpecs.map((spec) =>
        m.oneInsteadOfAll?.test(spec.place.name) === true && spec.type === 'all' ? one(spec.place) : spec,
      ),
    )
    .outputs(t.outputSpec as Out)
    .timing(t.timing)
    .priority(t.priority)
    .action(t.action);
  for (const arc of t.inhibitors) if (!(m.dropInhibitor?.test(arc.place.name) ?? false)) b.inhibitor(arc.place);
  for (const arc of t.reads) b.read(arc.place);
  for (const arc of t.resets) if (!(m.dropReset?.test(arc.place.name) ?? false)) b.reset(arc.place);
  return b.build();
}

function mutated(m: Mutation): Gadget {
  return (entry, next, ctx) => {
    const result = foreachGadget(entry, next, ctx);
    let touched = 0;
    const transitions: Transition[] = [];
    for (const t of result.transitions) {
      if (!m.transition.test(t.name)) {
        transitions.push(t);
        continue;
      }
      touched++;
      if (m.remove !== true) transitions.push(rebuild(t, m));
    }
    if (touched === 0) throw new Error(`mutation ${String(m.transition)} matched no transition`);
    return { ...result, transitions };
  };
}

/** Each verdict by `segment/property`, structure skipped — for a mutant expected to flip some. */
async function verdicts(label: string, compiled: CompiledWorkflow): Promise<Record<string, string>> {
  const reports = await verifyWorkflow(compiled, { timeoutMs: 300_000, structure: 'skip' });
  proofLog(`[${label}] ${reports.map(describeReport).join('; ')}`);
  return Object.fromEntries(reports.map((r) => [keyOf(r), r.result.verdict.type]));
}

// ===========================================================================================

describe.concurrent('foreach resume: every segment proven, from the foreach site', () => {
  it.for([1, 2])('foreach(c=%i): closed, cancel, resume@0, resume@0+cancel', { timeout: 1_800_000 }, async (lanes, { expect }) => {
    await proveAll(expect, `foreach(c=${lanes})`, build([foreach(lanes)]), ['0']);
  });

  it('before; foreach(c=1); after — every site: 0, 1, 2', { timeout: 1_800_000 }, async ({ expect }) => {
    await proveAll(expect, 'before;foreach(c=1);after', build([{ kind: 'step', id: 'before' }, foreach(1), { kind: 'step', id: 'after' }]), ['0', '1', '2']);
  });

  it('foreach(c=2) under a run budget of k=1: permits bounded and returned from the site too', { timeout: 1_800_000 }, async ({ expect }) => {
    await proveAll(expect, 'foreach(c=2) k=1', build([foreach(2)], undefined, 1), ['0']);
  });

  it('a retrying body (delayed hop) keeps the resume timing structure clean and every segment proven', { timeout: 1_800_000 }, async ({ expect }) => {
    await proveAll(expect, 'foreach(c=1, retries 1 delay 5)', build([foreach(1, body({ retries: 1, retryDelayMs: 5 }))]), ['0']);
  });

  /**
   * The cursor never sits beside a recorded outcome of this segment — `mutualExclusion(cursor,
   * suspensions | faults | exits)` — from the resume seed too, where the cursor and the carried
   * suspensions *do* coexist: `parked` is what makes that possible without breaking this.
   */
  it.for<[number, boolean]>([
    [1, false],
    [1, true],
    [2, false],
    [2, true],
  ])('never holds the cursor beside a recorded outcome, foreach(c=%i) resume@0 (cancel: %s)', { timeout: 1_800_000 }, async ([lanes, cancel], { expect }) => {
    const compiled = build([foreach(lanes)]);
    const segment = resumeSegment('0', cancel);
    const cursor = placeNamed(compiled, 's.0.items.cursor');
    for (const record of ['suspensions', 'faults', 'exits']) {
      const r = await check(compiled, mutualExclusion(cursor, placeNamed(compiled, `s.0.items.${record}`)), segment);
      proofLog(`[foreach(c=${lanes}) ${segmentLabel(segment)} mutualExclusion(cursor, ${record})] ${verdictOf(r)}`);
      expect(r.verdict.type, `${record}: ${verdictOf(r)}`).toBe('proven');
    }
  });
});

describe.runIf(SLOW_LANE).concurrent('SLOW LANE (SLOW_PROOFS=1): foreach resume with three lanes', () => {
  it('foreach(c=3): closed, cancel, resume@0, resume@0+cancel', BUDGET, async ({ expect }) => {
    await proveAll(expect, 'foreach(c=3)', build([foreach(3)]), ['0'], 1_800_000);
  });

  it.for([false, true])('never holds the cursor beside a recorded outcome, foreach(c=3) resume@0 (cancel: %s)', BUDGET, async (cancel, { expect }) => {
    const compiled = build([foreach(3)]);
    const segment = resumeSegment('0', cancel);
    const cursor = placeNamed(compiled, 's.0.items.cursor');
    const r = await check(compiled, mutualExclusion(cursor, placeNamed(compiled, 's.0.items.suspensions')), segment, 1_800_000);
    proofLog(`[foreach(c=3) ${segmentLabel(segment)} mutualExclusion(cursor, suspensions)] ${verdictOf(r)}`);
    expect(r.verdict.type, verdictOf(r)).toBe('proven');
  });
});

describe.concurrent('foreach resume: every new arc has teeth', () => {
  it('unpark without its cursor inhibitor: a carried suspension sits beside the cursor — at the site only', { timeout: 600_000 }, async ({ expect }) => {
    const mutant = build([foreach(1)], mutated({ transition: /\.items\.unpark$/, dropInhibitor: /\.cursor$/ }));
    const cursor = placeNamed(mutant, 's.0.items.cursor');
    const suspensions = placeNamed(mutant, 's.0.items.suspensions');
    const fresh = await check(mutant, mutualExclusion(cursor, suspensions), 'closed');
    const resumed = await check(mutant, mutualExclusion(cursor, suspensions), resumeSegment('0', false));
    proofLog(`[mutant unpark ¬cursor] closed ${verdictOf(fresh)}; resume@0 ${verdictOf(resumed)}`);
    // Fresh runs never mark `parked`, so they cannot see it; the site's own segment does.
    expect(fresh.verdict.type).toBe('proven');
    expect(resumed.verdict.type).toBe('violated');
  });

  it.for<[string, Mutation]>([
    ['suspend without its parked inhibitor', { transition: /\.items\.suspend$/, dropInhibitor: /\.parked$/ }],
    ['join without its parked inhibitor', { transition: /\.items\.join$/, dropInhibitor: /\.parked$/ }],
    ['fail without its reset on parked', { transition: /\.items\.fail$/, dropReset: /\.parked$/ }],
    ['exit without its reset on parked', { transition: /\.items\.exit$/, dropReset: /\.parked$/ }],
  ])('%s: a carried suspension is stranded — resume@0/deadlockFree violated, closed proven', { timeout: 900_000 }, async ([label, m], { expect }) => {
    const v = await verdicts(`mutant ${label}`, build([foreach(1)], mutated(m)));
    expect(v['closed/deadlockFree']).toBe('proven');
    expect(v['resume@0/deadlockFree']).toBe('violated');
  });

  it('canceled without its reset on parked: stranded only when a cancel arrives — resume@0+cancel violated', { timeout: 900_000 }, async ({ expect }) => {
    const v = await verdicts('mutant canceled ¬reset(parked)', build([foreach(1)], mutated({ transition: /\.items\.canceled(-empty)?$/, dropReset: /\.parked$/ })));
    expect(v['resume@0/deadlockFree']).toBe('proven');
    expect(v['resume@0+cancel/deadlockFree']).toBe('violated');
  });

  it('without unpark, a carried suspension never leaves: resume@0 violated, fresh segments unaffected', { timeout: 900_000 }, async ({ expect }) => {
    const v = await verdicts('mutant no unpark', build([foreach(1)], mutated({ transition: /\.items\.unpark$/, remove: true })));
    expect(v['closed/deadlockFree']).toBe('proven');
    expect(v['cancel/deadlockFree']).toBe('proven');
    expect(v['resume@0/deadlockFree']).toBe('violated');
  });

  it('without the re-enter sweep: the gate check names it, and a cancel that arrives first strands the seed', { timeout: 900_000 }, async ({ expect }) => {
    const mutant = build([foreach(1)], mutated({ transition: /\.items\.re-enter\.cancel$/, remove: true }));
    expect(resumeGateViolations(mutant)).toStrictEqual([
      "resume site 0 ('s.0.items.resume') has no sweep: nothing reads 'wf.cancel' and consumes it",
    ]);
    await expect(verifyWorkflow(mutant, { timeoutMs: 1_000 })).rejects.toThrow('resume gate structure is unsound');
    const v = await verdicts('mutant no re-enter.cancel', mutant);
    expect(v['resume@0/deadlockFree']).toBe('proven');
    expect(v['resume@0+cancel/deadlockFree']).toBe('violated');
  });

  it('re-enter without its cancel inhibitor: both the cancel check and the gate check name it', async ({ expect }) => {
    const mutant = build([foreach(1)], mutated({ transition: /\.items\.re-enter$/, dropInhibitor: /^wf\.cancel$/ }));
    expect(cancelStructureViolations(mutant)).toStrictEqual([
      "'t.0.items.re-enter' competes with sweep 't.0.items.re-enter.cancel' for [s.0.items.resume] without an inhibitor on 'wf.cancel'",
    ]);
    expect(resumeGateViolations(mutant)).toStrictEqual([
      "'t.0.items.re-enter' consumes resume site 0 ('s.0.items.resume') without an inhibitor on 'wf.cancel'",
    ]);
    // The cancel check runs first, so it is the one `verifyWorkflow` refuses with.
    await expect(verifyWorkflow(mutant, { timeoutMs: 1_000 })).rejects.toThrow('cancellation structure is unsound');
  });

  it('one() instead of all() on parked: the threshold check names it — the one-token seed would no longer be exact', async ({ expect }) => {
    const mutant = build([foreach(2)], mutated({ transition: /\.items\.unpark$/, oneInsteadOfAll: /\.parked$/ }));
    expect(thresholdOnlyViolations(mutant)).toStrictEqual([
      "'t.0.items.unpark' consumes 's.0.items.parked' with one(); a foreach parked place takes only all()",
    ]);
    await expect(verifyWorkflow(mutant, { timeoutMs: 1_000 })).rejects.toThrow('foreach threshold structure is unsound');
  });

  it('the real net passes every structural check at 1-4 lanes', ({ expect }) => {
    for (const lanes of [1, 2, 3, 4]) {
      const compiled = build([foreach(lanes)]);
      for (const c of [cancelStructureViolations, resumeGateViolations, thresholdOnlyViolations, suspensionCoverageViolations, resumeTimingViolations]) {
        expect(c(compiled), `${c.name} at ${lanes} lanes`).toStrictEqual([]);
      }
    }
  });
});


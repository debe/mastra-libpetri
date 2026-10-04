import { appendFileSync } from 'node:fs';
import { describe, it, type ExpectStatic } from 'vitest';
import { Transition, and, xor, type Out, type Place } from 'libpetri';
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
  verifyWorkflow,
  type PropertyReport,
  type Segment,
} from '../../src/verify/index.js';
import { budgetStructureViolations } from '../../src/verify/budget.js';
import type { CompiledWorkflow, EntryDescription, StepDescription } from '../../src/compiler/types.js';

/**
 * `.foreach()` resume, proved ([ADR 0007], contract C14/C15) — under libpetri 8.0.0's in-flight
 * firing ([VER-004]), 30 s per query.
 *
 * **What every proof here is about.** `verifyWorkflow`'s route: the structural checks first
 * (cancel, budget, resume gate, suspension coverage, resume timing), then every segment — `closed`
 * and `cancel` from one token at the workflow's entry, and for each resume site `s`, `resume@s`
 * from `{site: 1[, wf.permits: k]}` and `resume@s+cancel` from the same plus one cancel request.
 * Environment closed, untimed, value-blind, semiflow invariants on, every terminal, the cancel
 * place and the permits declared sinks. Every verdict is asserted `=== 'proven'` by string — never
 * `!isViolated()`, which passes on `unknown`.
 *
 * **Why one seed covers every resume.** `re-enter` chooses among four reopenings — the queue open
 * or closed, `susp` on or off — by an `xor`, which the value-blind proof explores in full. What
 * the seed carries (the items that succeeded, the suspensions that stay) rides the frame as data,
 * so no place holds more than one token and nothing stands for a count the proof cannot see.
 *
 * Set `PROOF_LOG` to a file to record every figure with its route.
 */

const BUDGET_MS = 30_000;
const T = { timeout: 60_000 } as const;

const body = (extra: Omit<StepDescription, 'kind' | 'id'> = {}): StepDescription => ({ kind: 'step', id: 'body', ...extra });
const foreach = (concurrency: number, b: StepDescription = body()): EntryDescription => ({
  kind: 'foreach',
  id: 'items',
  body: b,
  concurrency,
});
const build = (entries: readonly EntryDescription[], gadget?: Gadget, concurrency?: number): CompiledWorkflow =>
  compile({ id: 'batch', entries }, { ...(gadget ? { gadgets: { foreach: gadget } } : {}), ...(concurrency ? { concurrency } : {}) });

const proofLog = (line: string): void => {
  const file = process.env['PROOF_LOG'];
  if (file) appendFileSync(file, `${line}\n`);
};

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

/** `verifyWorkflow`'s default less the restarts, every structural check clean, every property of every segment proven. */
async function proveAll(expect: ExpectStatic, label: string, compiled: CompiledWorkflow, sites: readonly string[]): Promise<void> {
  expect([...compiled.resumeSites.keys()].sort()).toStrictEqual([...sites].sort());
  for (const check of [cancelStructureViolations, budgetStructureViolations, resumeGateViolations, suspensionCoverageViolations, resumeTimingViolations]) {
    expect(check(compiled), check.name).toStrictEqual([]);
  }
  const started = Date.now();
  // The fresh and resume segments alone: the restart segments ([ADR 0010]) are restart-segments.test.ts's.
  const reports = await verifyWorkflow(compiled, { timeoutMs: BUDGET_MS, restart: 'none' });
  proofLog(`[${label}] total ${Date.now() - started}ms; ${reports.map(describeReport).join('; ')}`);
  expect(reports.map(keyOf).sort()).toStrictEqual(everyKey(compiled, sites).sort());
  for (const r of reports) expect(r.result.verdict.type, `${label}: ${describeReport(r)}`).toBe('proven');
}

/** One property from exactly a segment's initial marking, under `verifyWorkflow`'s hypotheses. */
function check(compiled: CompiledWorkflow, property: SmtProperty, segment: Segment): Promise<SmtVerificationResult> {
  const t = compiled.terminals;
  return SmtVerifier.forNet(compiled.net)
    .initialMarking((m) => {
      for (const [p, n] of segmentInitialMarking(compiled, segment)) m.tokens(p, n);
    })
    .sinkPlaces(t.done, t.failed, t.bailed, t.suspended, t.paused, t.canceled, compiled.cancel, ...(compiled.budget ? [compiled.budget.permits] : []))
    .semiflowInvariants(true)
    .timeout(BUDGET_MS)
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
  readonly dropInput?: RegExp;
  /** Removes matching places from every `and` in the output spec. */
  readonly dropOutput?: RegExp;
  /** Removes the whole transition. */
  readonly remove?: true;
}

function pruneOut(out: Out, drop: RegExp): Out {
  switch (out.type) {
    case 'and':
      return and(...out.children.filter((c) => !(c.type === 'place' && drop.test(c.place.name))).map((c) => pruneOut(c, drop)));
    case 'xor':
      return xor(...out.children.map((c) => pruneOut(c, drop)));
    default:
      return out;
  }
}

function rebuild(t: Transition, m: Mutation): Transition {
  const b = Transition.builder(t.name)
    .inputs(...t.inputSpecs.filter((spec) => !(m.dropInput?.test(spec.place.name) ?? false)))
    .outputs(m.dropOutput ? pruneOut(t.outputSpec as Out, m.dropOutput) : (t.outputSpec as Out))
    .timing(t.timing)
    .priority(t.priority)
    .action(t.action);
  for (const arc of t.inhibitors) if (!(m.dropInhibitor?.test(arc.place.name) ?? false)) b.inhibitor(arc.place);
  for (const arc of t.reads) b.read(arc.place);
  for (const arc of t.resets) b.reset(arc.place);
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
  const reports = await verifyWorkflow(compiled, { timeoutMs: BUDGET_MS, structure: 'skip' });
  proofLog(`[${label}] ${reports.map(describeReport).join('; ')}`);
  return Object.fromEntries(reports.map((r) => [keyOf(r), r.result.verdict.type]));
}

// ===========================================================================================

describe('foreach resume: every segment proven, from the foreach site', () => {
  it.for([1, 2, 3])('foreach(c=%i): closed, cancel, resume@0, resume@0+cancel', T, async (lanes, { expect }) => {
    await proveAll(expect, `foreach(c=${lanes})`, build([foreach(lanes)]), ['0']);
  });

  it('before; foreach(c=2); after — every site: 0, 1, 2', T, async ({ expect }) => {
    await proveAll(expect, 'before;foreach(c=2);after', build([{ kind: 'step', id: 'before' }, foreach(2), { kind: 'step', id: 'after' }]), ['0', '1', '2']);
  });

  it('foreach(c=2) under a run budget of k=1: permits bounded and returned from the site too', T, async ({ expect }) => {
    await proveAll(expect, 'foreach(c=2) k=1', build([foreach(2)], undefined, 1), ['0']);
  });

  it('a retrying body (delayed hop) keeps the resume timing structure clean and every segment proven', T, async ({ expect }) => {
    await proveAll(expect, 'foreach(c=1, retries 1 delay 5)', build([foreach(1, body({ retries: 1, retryDelayMs: 5 }))]), ['0']);
  });

  /**
   * Fail-fast from the resume seed too: the open queue never sits beside a recorded failure, bail
   * or pause of this segment — the seed reopens with every one of those off, and only a settle that
   * took the queue raises one.
   */
  it.for<[number, boolean]>([
    [1, false],
    [2, false],
    [2, true],
  ])('the open queue never sits beside a recorded failure, bail or pause, foreach(c=%i) resume@0 (cancel: %s)', T, async ([lanes, cancel], { expect }) => {
    const compiled = build([foreach(lanes)]);
    const segment = resumeSegment('0', cancel);
    const open = placeNamed(compiled, 's.0.items.queue.open');
    for (const recorded of ['fault', 'exit']) {
      const r = await check(compiled, mutualExclusion(open, placeNamed(compiled, `s.0.items.${recorded}`)), segment);
      proofLog(`[foreach(c=${lanes}) ${segmentLabel(segment)} mutualExclusion(queue.open, ${recorded})] ${verdictOf(r)}`);
      expect(r.verdict.type, `${recorded}: ${verdictOf(r)}`).toBe('proven');
    }
  });

  /**
   * A carried suspension kills no queue, as Mastra's `killQueue()` fires only for this segment's
   * outcomes (`:1242-1250`): from the site the open queue *can* sit beside `susp`; in a fresh run,
   * where only a settle raises it, it cannot.
   */
  it('a carried suspension leaves the queue open: reachable from the site, never in a fresh run', T, async ({ expect }) => {
    const compiled = build([foreach(2)]);
    const pair = mutualExclusion(placeNamed(compiled, 's.0.items.queue.open'), placeNamed(compiled, 's.0.items.susp'));
    const fresh = await check(compiled, pair, 'closed');
    const resumed = await check(compiled, pair, resumeSegment('0', false));
    proofLog(`[foreach(c=2) queue.open vs susp] closed ${verdictOf(fresh)}; resume@0 ${verdictOf(resumed)}`);
    expect(fresh.verdict.type, verdictOf(fresh)).toBe('proven');
    expect(resumed.verdict.type, verdictOf(resumed)).toBe('violated');
  });
});

describe('foreach resume: every new arc has teeth', () => {
  it('re-enter without the `susp` flag on its reopenings: the resumed foreach can never decide — resume@0 violated, fresh segments unaffected', T, async ({ expect }) => {
    const v = await verdicts('mutant re-enter ¬susp', build([foreach(1)], mutated({ transition: /\.items\.re-enter$/, dropOutput: /\.items\.(no-)?susp$/ })));
    expect(v['closed/deadlockFree']).toBe('proven');
    expect(v['cancel/deadlockFree']).toBe('proven');
    expect(v['resume@0/deadlockFree']).toBe('violated');
  });

  it('a cancel finisher that does not take a carried suspension\'s flag strands it — resume@0+cancel violated', T, async ({ expect }) => {
    const v = await verdicts('mutant canceled.s ¬susp', build([foreach(1)], mutated({ transition: /\.items\.canceled\.s$/, dropInput: /\.items\.susp$/ })));
    expect(v['resume@0/deadlockFree']).toBe('proven');
    expect(v['resume@0+cancel/deadlockFree']).toBe('violated');
  });

  it('without the re-enter sweep: the gate check names it, and a cancel that arrives first strands the seed', T, async ({ expect }) => {
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

  it('the real net passes every structural check at 1-4 lanes', ({ expect }) => {
    for (const lanes of [1, 2, 3, 4]) {
      const compiled = build([foreach(lanes)]);
      for (const c of [cancelStructureViolations, resumeGateViolations, suspensionCoverageViolations, resumeTimingViolations]) {
        expect(c(compiled), `${c.name} at ${lanes} lanes`).toStrictEqual([]);
      }
    }
  });
});

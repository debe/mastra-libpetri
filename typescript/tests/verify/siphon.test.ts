import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PetriNet, Transition, delayed, one, outPlace, place, type Place } from 'libpetri';
import { SmtVerifier, deadlockFree, mutualExclusion, placeBound, unreachable, type SmtProperty } from 'libpetri/verification';
import { compile } from '../../src/compiler/index.js';
import { dischargeBySiphon, emptySiphon } from '../../src/verify/siphon.js';
import { resumeSegment, segmentInitialMarking, segmentLabel, verifyWorkflow, describeReport, type Segment } from '../../src/verify/properties.js';
import { describeClaim, verify } from '../../src/verify/workflow.js';
import type { CompiledWorkflow, StepDescription, WorkflowDescription } from '../../src/compiler/types.js';

/**
 * The initially-empty-siphon discharge (`src/verify/siphon.ts`).
 *
 * **What is claimed.** For a net and an initial marking, `emptySiphon` returns the maximal siphon
 * inside the unmarked places — every producer into it requires it, by input or read arc — and the
 * transitions it kills; `dischargeBySiphon` answers `placeBound(p, n)` as `proven` on the
 * `structural` route exactly when `p` is in it, and leaves everything else to the verifier. Hand-built
 * nets pin the boundary: read arcs count as a requirement, inhibitors never; a timed sweep and a
 * reset arc change nothing. Where the discharge says `proven` the solver is asked too and must agree,
 * and where it declines on a reachable mark the solver must say `violated`.
 *
 * **The real case.** `parallel n=4, every arm retrying twice with a timed delay` (the shape
 * `tests/verify/resume-segments.test.ts` proves), `closed/neverCanceled` = `placeBound(wf.canceled, 0)`
 * from `{s.0.fan.in: 1[, wf.permits: k]}`, environment closed (no cancel arrives), untimed and
 * value-blind. Before this discharge it went to the `smt` route (IC3): measured on libpetri 8.0.0 from
 * npm, not linked — 9.6 s at k=1, 7.5 s at k=2, 4.6 s unbounded, 11.8 s at k=4. Set `PROOF_LOG` to a
 * file to record what it takes now.
 */

const proofLog = (line: string): void => {
  const file = process.env['PROOF_LOG'];
  if (file) appendFileSync(file, `${line}\n`);
};
const noop = async (): Promise<void> => {};

/** A cancel request, its arrival into the signal, and one waiting token that a gated step or a sweep takes. */
function sweepNet(opts: { sweepTiming?: 'immediate' | 'delayed'; rogue?: 'none' | 'inhibits' | 'resets' } = {}) {
  const request = place<null>('wf.cancel.request');
  const cancel = place<null>('wf.cancel');
  const canceled = place<null>('wf.canceled');
  const waiting = place<null>('s.0.a.in');
  const done = place<null>('wf.done');
  const arrive = Transition.builder('t.cancel.arrive').inputs(one(request)).outputs(outPlace(cancel)).action(noop).build();
  const run = Transition.builder('t.0.a.run').inputs(one(waiting)).inhibitor(cancel).outputs(outPlace(done)).action(noop).build();
  const sweep = Transition.builder('t.0.a.cancel').inputs(one(waiting)).read(cancel).outputs(outPlace(canceled)).action(noop);
  if (opts.sweepTiming === 'delayed') sweep.timing(delayed(5));
  const transitions = [arrive, run, sweep.build()];
  // A producer of `wf.canceled` that only *inhibits* on the signal: enabled exactly when it is empty.
  if (opts.rogue === 'inhibits') {
    transitions.push(Transition.builder('t.rogue').inputs(one(done)).inhibitor(cancel).outputs(outPlace(canceled)).action(noop).build());
  }
  // A transition that resets the signal: removes tokens, produces none, so the siphon is untouched.
  if (opts.rogue === 'resets') {
    transitions.push(Transition.builder('t.clear').inputs(one(done)).reset(cancel).outputs(outPlace(done)).action(noop).build());
  }
  const net = PetriNet.builder('siphon').places(request, cancel, canceled, waiting, done).transitions(...transitions).build();
  return { net, request, cancel, canceled, waiting, done };
}

const marking = (entries: readonly (readonly [Place<unknown>, number])[]): ReadonlyMap<Place<unknown>, number> => new Map(entries);

/** The solver's own answer, on the same net and marking: the cross-check, never the claim. */
async function solve(net: PetriNet, initial: ReadonlyMap<Place<unknown>, number>, p: Place<unknown> | SmtProperty) {
  return SmtVerifier.forNet(net)
    .initialMarking((m) => {
      for (const [q, n] of initial) m.tokens(q, n);
    })
    .property('type' in p ? p : placeBound(p, 0))
    .timeout(30_000)
    .totalBudget(30_000)
    .verify();
}

describe('emptySiphon and dischargeBySiphon on hand-built nets', () => {
  it('closed segment: the sweep reads an unmarked signal nothing produces, so it is dead and wf.canceled stays empty', async () => {
    const n = sweepNet();
    const initial = marking([[n.waiting, 1]]);
    const siphon = emptySiphon(n.net, initial);
    expect(siphon.places).toEqual(['wf.cancel', 'wf.cancel.request', 'wf.canceled']);
    expect(siphon.dead).toEqual(['t.0.a.cancel', 't.cancel.arrive']);
    const result = dischargeBySiphon(n.net, initial, placeBound(n.canceled, 0));
    expect(result?.verdict.type).toBe('proven');
    expect(result?.route).toBe('structural');
    expect(result?.report).toContain('{wf.cancel, wf.cancel.request, wf.canceled}');
    expect(result?.report).toContain('t.0.a.cancel');
    // Any bound holds of a place that never holds a token.
    expect(dischargeBySiphon(n.net, initial, placeBound(n.canceled, 3))?.verdict.type).toBe('proven');
    // The solver, asked the same question on the same net and marking, agrees.
    expect((await solve(n.net, initial, n.canceled)).verdict.type).toBe('proven');
  });

  it('cancel segment: the request seeded, the arrival can fire, and nothing is discharged', async () => {
    const n = sweepNet();
    const initial = marking([[n.waiting, 1], [n.request, 1]]);
    expect(emptySiphon(n.net, initial).places).toEqual([]);
    expect(dischargeBySiphon(n.net, initial, placeBound(n.canceled, 0))).toBeUndefined();
    expect(dischargeBySiphon(n.net, initial, placeBound(n.cancel, 0))).toBeUndefined();
    // And rightly: the arrival then the sweep marks wf.canceled.
    expect((await solve(n.net, initial, n.canceled)).verdict.type).toBe('violated');
  });

  it('the signal seeded directly (a pre-aborted run): not discharged either', () => {
    const n = sweepNet();
    const initial = marking([[n.waiting, 1], [n.cancel, 1]]);
    expect(emptySiphon(n.net, initial).places).toEqual(['wf.cancel.request']);
    expect(dischargeBySiphon(n.net, initial, placeBound(n.canceled, 0))).toBeUndefined();
  });

  it('a producer that only inhibits on the signal is not dead, so wf.canceled leaves the siphon', async () => {
    const n = sweepNet({ rogue: 'inhibits' });
    const initial = marking([[n.waiting, 1]]);
    const siphon = emptySiphon(n.net, initial);
    expect(siphon.places).toEqual(['wf.cancel', 'wf.cancel.request']);
    expect(siphon.dead).not.toContain('t.rogue');
    expect(dischargeBySiphon(n.net, initial, placeBound(n.canceled, 0))).toBeUndefined();
    // The sweep is still dead — but the rogue marks wf.canceled after the step: the solver sees it.
    expect(siphon.dead).toContain('t.0.a.cancel');
    expect((await solve(n.net, initial, n.canceled)).verdict.type).toBe('violated');
  });

  it('a timed sweep and a reset arc on the signal change nothing: dead is never enabled', () => {
    for (const opts of [{ sweepTiming: 'delayed' as const }, { rogue: 'resets' as const }]) {
      const n = sweepNet(opts);
      const initial = marking([[n.waiting, 1]]);
      expect(emptySiphon(n.net, initial).places, JSON.stringify(opts)).toEqual(['wf.cancel', 'wf.cancel.request', 'wf.canceled']);
      expect(dischargeBySiphon(n.net, initial, placeBound(n.canceled, 0))?.route, JSON.stringify(opts)).toBe('structural');
    }
  });

  it('settles an exclusion with either place in the siphon, in either order; the solver agrees', async () => {
    const n = sweepNet();
    const initial = marking([[n.waiting, 1]]);
    for (const prop of [mutualExclusion(n.waiting, n.canceled), mutualExclusion(n.canceled, n.waiting), mutualExclusion(n.cancel, n.done)]) {
      const result = dischargeBySiphon(n.net, initial, prop);
      const label = `${prop.p1.name},${prop.p2.name}`;
      expect(result?.verdict.type, label).toBe('proven');
      expect(result?.route, label).toBe('structural');
      expect(result?.report, label).toContain('never both marked');
      expect(result?.report, label).toContain('initially empty siphon');
      expect((await solve(n.net, initial, prop)).verdict.type, label).toBe('proven');
    }
  });

  it('leaves an exclusion of a marked or refillable place to the verifier', async () => {
    // Marked: the cancel segment seeds the request, so neither place of the pair is in a siphon.
    const plain = sweepNet();
    const seeded = marking([[plain.waiting, 1], [plain.request, 1]]);
    expect(dischargeBySiphon(plain.net, seeded, mutualExclusion(plain.waiting, plain.canceled))).toBeUndefined();
    expect(dischargeBySiphon(plain.net, seeded, mutualExclusion(plain.request, plain.waiting))).toBeUndefined();
    // Refillable: the rogue refills wf.canceled with the signal empty. Two waiting tokens: one run,
    // the rogue, a second run — both places marked at once, which the solver finds.
    const n = sweepNet({ rogue: 'inhibits' });
    const twice = marking([[n.waiting, 2]]);
    const prop = mutualExclusion(n.canceled, n.done);
    expect(dischargeBySiphon(n.net, twice, prop)).toBeUndefined();
    expect((await solve(n.net, twice, prop)).verdict.type).toBe('violated');
  });

  it('settles only place bounds and exclusions: every other property is left to the verifier', () => {
    const n = sweepNet();
    const initial = marking([[n.waiting, 1]]);
    // Neither place in the siphon.
    expect(dischargeBySiphon(n.net, initial, mutualExclusion(n.waiting, n.done))).toBeUndefined();
    expect(dischargeBySiphon(n.net, initial, placeBound(n.done, 0))).toBeUndefined();
    // Other shapes, even on siphon places.
    expect(dischargeBySiphon(n.net, initial, unreachable(new Set([n.canceled])))).toBeUndefined();
    expect(dischargeBySiphon(n.net, initial, deadlockFree())).toBeUndefined();
  });

  it('reports elapsedMs in whole milliseconds, as describeReport prints every route', () => {
    const n = sweepNet();
    const initial = marking([[n.waiting, 1]]);
    for (const prop of [placeBound(n.canceled, 0), mutualExclusion(n.waiting, n.canceled)]) {
      expect(Number.isInteger(dischargeBySiphon(n.net, initial, prop)!.elapsedMs)).toBe(true);
    }
    const line = describeReport({ property: 'p', segment: 'closed', marking: '{}', result: { verdict: { type: 'proven' }, route: 'smt', elapsedMs: 12.3456 } } as never);
    expect(line).toContain(' in 12ms ');
  });
});

// =============================================================================================
// The real nets: the same compiled net the executor runs, every segment's own initial marking.
// =============================================================================================

const step = (id: string, extra: Partial<Omit<StepDescription, 'kind' | 'id'>> = {}): StepDescription => ({ kind: 'step', id, ...extra });
const retryingFan: WorkflowDescription = {
  id: 'w',
  entries: [{ kind: 'parallel', id: 'fan', arms: ['a', 'b', 'c', 'd'].map((id) => step(id, { retries: 2, retryDelayMs: 5 })) }],
};
const kLabel = (k: number | undefined): string => (k === undefined ? 'unbounded' : `k=${k}`);

describe('parallel n=4, every arm retrying twice with a timed delay: closed/neverCanceled', () => {
  for (const k of [1, 2, undefined, 4] as const) {
    it(`is proven by the empty siphon, ${kLabel(k)}`, () => {
      const c = compile(retryingFan, k === undefined ? {} : { concurrency: k });
      const started = performance.now();
      const initial = segmentInitialMarking(c, 'closed');
      const result = dischargeBySiphon(c.net, initial, placeBound(c.terminals.canceled, 0));
      const ms = performance.now() - started;
      expect(result?.verdict.type).toBe('proven');
      expect(result?.route).toBe('structural');
      const siphon = emptySiphon(c.net, initial);
      for (const p of [c.cancelRequest.name, c.cancel.name, c.terminals.canceled.name]) expect(siphon.places).toContain(p);
      // Every transition that reads the signal — every sweep — is among the dead.
      const sweeps = [...c.net.transitions].filter((t) => t.reads.some((r) => r.place.name === c.cancel.name)).map((t) => t.name);
      expect(sweeps.length).toBeGreaterThan(0);
      for (const s of sweeps) expect(siphon.dead).toContain(s);
      // No step attempt is dead: the siphon kills cancellation, not work.
      for (const a of c.stepAttempts) expect(siphon.dead).not.toContain(a);
      proofLog(`[siphon] retrying parallel n=4, ${kLabel(k)}: closed/neverCanceled ${result!.verdict.type} via ${result!.route} in ${ms.toFixed(1)}ms (libpetri 8.0.0 from npm); ${result!.statistics.structuralResult}`);
    });
  }

  it('every segment without a cancel is discharged; every segment with one is not', () => {
    const c = compile(retryingFan, { concurrency: 2 });
    const segments: Segment[] = ['closed', 'cancel', ...['0.0', '0.1', '0.2', '0.3'].flatMap((s) => [resumeSegment(s, false), resumeSegment(s, true)])];
    for (const segment of segments) {
      const cancels = typeof segment === 'string' ? segment === 'cancel' : segment.cancel;
      const result = dischargeBySiphon(c.net, segmentInitialMarking(c, segment), placeBound(c.terminals.canceled, 0));
      if (cancels) expect(result, `${segment}`).toBeUndefined();
      else expect(result?.route, `${segment}`).toBe('structural');
    }
  });
});

describe('wired into verifyWorkflow and verify', () => {
  it('verifyWorkflow: closed/neverCanceled is structural; the rest is still asked', async () => {
    const c = compile({ id: 'w', entries: [step('a')] });
    const reports = await verifyWorkflow(c, { segments: ['closed', 'cancel'], timeoutMs: 30_000 });
    for (const r of reports) expect(r.result.verdict.type, describeReport(r)).toBe('proven');
    const never = reports.find((r) => r.segment === 'closed' && r.property === 'neverCanceled')!;
    expect(never.result.route).toBe('structural');
    expect(never.result.report).toContain('initially empty siphon');
    // The cancel segment has no neverCanceled, and nothing else there is settled by a siphon.
    for (const r of reports.filter((x) => x.segment === 'cancel')) expect(r.result.report, describeReport(r)).not.toContain('initially empty siphon');
  });

  it('verify: the completion claim and every bound on a cancel-only place are structural in closed', async () => {
    const c = compile({ id: 'w', entries: [step('a')] });
    const report = await verify(c, { segments: ['closed'], families: ['completion', 'bounds'], timeoutMs: 30_000 });
    for (const claim of report.claims) expect(claim.result.verdict.type, describeClaim(claim)).toBe('proven');
    const never = report.claims.find((x) => x.property === 'neverCanceled')!;
    expect(never.result.route).toBe('structural');
    for (const p of [c.terminals.canceled.name, c.cancel.name, c.cancelRequest.name]) {
      const bound = report.claims.find((x) => x.property.startsWith(`bound(${p}<=`));
      expect(bound, p).toBeDefined();
      expect(bound!.result.route, describeClaim(bound!)).toBe('structural');
      expect(bound!.result.report, describeClaim(bound!)).toContain('initially empty siphon');
    }
  });
});

// =============================================================================================
// Each segment's own siphon: the cache in `verify` and the per-segment siphon in `verifyWorkflow`.
// =============================================================================================

const mentionsSiphon = (report: string): boolean => report.includes('initially empty siphon');

describe('the siphon is the segment\'s own', () => {
  it('verify, bounds over closed and cancel: closed discharges every cancel-place bound, cancel none', async () => {
    const c = compile({ id: 'w', entries: [step('a')] });
    const report = await verify(c, { segments: ['closed', 'cancel'], families: ['bounds'], timeoutMs: 30_000 });
    for (const claim of report.claims) expect(claim.result.verdict.type, describeClaim(claim)).toBe('proven');
    const cancelPlaces = [c.terminals.canceled.name, c.cancel.name, c.cancelRequest.name];
    for (const p of cancelPlaces) {
      const closed = report.claims.find((x) => segmentLabel(x.segment) === 'closed' && x.property.startsWith(`bound(${p}<=`));
      expect(closed, p).toBeDefined();
      expect(closed!.result.route, describeClaim(closed!)).toBe('structural');
      expect(mentionsSiphon(closed!.result.report), describeClaim(closed!)).toBe(true);
    }
    const inCancel = report.claims.filter((x) => segmentLabel(x.segment) === 'cancel');
    expect(inCancel.length).toBeGreaterThan(0);
    for (const claim of inCancel) {
      expect(mentionsSiphon(claim.result.report), describeClaim(claim)).toBe(false);
      expect(claim.result.route, describeClaim(claim)).not.toBe('structural');
    }
  });

  it('verifyWorkflow over closed and cancel: only closed cites the siphon', async () => {
    const c = compile({ id: 'w', entries: [step('a')] });
    const reports = await verifyWorkflow(c, { segments: ['closed', 'cancel'], timeoutMs: 30_000 });
    expect(reports.some((r) => r.segment === 'closed' && mentionsSiphon(r.result.report))).toBe(true);
    for (const r of reports.filter((x) => x.segment === 'cancel')) expect(mentionsSiphon(r.result.report), describeReport(r)).toBe(false);
  });

  // A rogue that marks wf.canceled from a resume place: unmarked and unproduced in `closed`, so there
  // wf.canceled is still in the siphon; seeded in `resume@0.0`, so there it is not, and wf.canceled is
  // reachable. A siphon taken from the wrong marking would prove the resumed segment's claims.
  function rogueResume(): { readonly compiled: CompiledWorkflow; readonly resumed: Segment } {
    const c = compile({ id: 'w', entries: [{ kind: 'parallel', id: 'fan', arms: [step('x'), step('y')] }] });
    const resumed = resumeSegment('0.0', false);
    const [gate] = [...segmentInitialMarking(c, resumed).keys()];
    const rogue = Transition.builder('t.rogue').inputs(one(gate!)).outputs(outPlace(c.terminals.canceled)).action(noop).build();
    const net = PetriNet.builder(c.net.name).places(...c.net.places).transitions(...c.net.transitions, rogue).build();
    expect(emptySiphon(net, segmentInitialMarking(c, 'closed')).places).toContain(c.terminals.canceled.name);
    expect(emptySiphon(net, segmentInitialMarking(c, resumed)).places).not.toContain(c.terminals.canceled.name);
    return { compiled: { ...c, net }, resumed };
  }

  it('verifyWorkflow: a resumed segment whose own marking refills wf.canceled is asked, and violated', async () => {
    const { compiled, resumed } = rogueResume();
    const reports = await verifyWorkflow(compiled, { segments: ['closed', resumed], structure: 'skip', timeoutMs: 30_000 });
    const closed = reports.find((r) => r.segment === 'closed' && r.property === 'neverCanceled')!;
    expect(closed.result.route, describeReport(closed)).toBe('structural');
    const resumedNever = reports.find((r) => r.segment !== 'closed' && r.property === 'neverCanceled')!;
    expect(resumedNever.result.route, describeReport(resumedNever)).not.toBe('structural');
    expect(resumedNever.result.verdict.type, describeReport(resumedNever)).toBe('violated');
  });

  it('verify: the same rogue — the resumed segment\'s canceled bound is asked, closed\'s is structural', async () => {
    const { compiled, resumed } = rogueResume();
    const report = await verify(compiled, { segments: ['closed', resumed], families: ['bounds'], structure: 'skip', timeoutMs: 30_000 });
    const bound = (label: string) => report.claims.find((x) => segmentLabel(x.segment) === label && x.property.startsWith(`bound(${compiled.terminals.canceled.name}<=`))!;
    expect(bound('closed').result.route, describeClaim(bound('closed'))).toBe('structural');
    const r = bound(segmentLabel(resumed));
    expect(r.result.route, describeClaim(r)).not.toBe('structural');
    expect(mentionsSiphon(r.result.report), describeClaim(r)).toBe(false);
  });
});

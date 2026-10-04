import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PetriNet,
  Transition,
  and,
  delayed,
  one,
  outPlace,
  place,
  xor,
  type In,
  type Out,
  type Place,
} from 'libpetri';
import { compile } from '../../src/compiler/index.js';
import {
  describeReport,
  resumeGateViolations,
  resumeSegment,
  resumeTimingViolations,
  segmentInitialMarking,
  segmentLabel,
  segmentsFor,
  suspensionCoverageViolations,
  verifyWorkflow,
  type PropertyReport,
  type Segment,
} from '../../src/verify/index.js';
import type {
  ArmSite,
  CompiledWorkflow,
  EntryDescription,
  EntrySite,
  ForeachSite,
  ResumeSite,
  StepDescription,
  WorkflowDescription,
} from '../../src/compiler/types.js';

/**
 * Resume segments ([ADR 0007], contract C24 and C25): the four structural checks, each with a net
 * that breaks it and one that does not, then every resume site of every shape proven.
 *
 * **What is claimed, and from where.** For a compiled workflow at budget `k`, every property below
 * is `proven` — asserted as `verdict.type === 'proven'`, never "not violated" — in every segment:
 * - `closed`, from `{entry: 1[, wf.permits: k]}`;
 * - `cancel`, from that plus `{wf.cancel.request: 1}`, whose immediate arrival may fire at every
 *   reachable point;
 * - for every registered site `s`, `resume@s` from `{s.place: 1[, wf.permits: k]}` and
 *   `resume@s+cancel` from that plus `{wf.cancel.request: 1}` — before the gate included.
 *
 * The properties: `deadlockFree` (strict; the six terminals, `wf.cancel` and the permits are the
 * sinks), `terminatesAtSink`, `exactlyOneTerminal` (`quiescentCount` over the six terminals, 1..1),
 * `neverCanceled` (`placeBound(wf.canceled, 0)`) in the segments without a cancel, and with a budget
 * `permitsBounded(k)` and `permitsReturned(k)`. Environment: closed (the cancel arrival is a
 * transition of the net). Untimed, value-blind. The route is what libpetri reports and each report
 * names it; set `PROOF_LOG` to a file to record every line. Figures come from libpetri 6.1.0 as
 * installed from npm (not a linked tree).
 *
 * **Not claimed here.** That a seeded marking is reachable from the fresh one (it is not claimed at
 * all: a resume segment is proven from its seed, CORE-073's route); the decoder's mapping from
 * records to a site and its colour (unit-tested in `tests/compiler/resume-seed.test.ts`); timing;
 * termination of a loop (VER-002); the `.foreach()` site's proofs, which are the foreach area's
 * (`tests/verify/foreach-resume.test.ts`); the restart segments ([ADR 0010]), which the proofs here
 * leave out with `restart: 'none'` and `tests/verify/restart-segments.test.ts` proves.
 */

const step = (id: string, extra: Partial<Omit<StepDescription, 'kind' | 'id'>> = {}): StepDescription =>
  ({ kind: 'step', id, ...extra });
const fan = (id: string, arms: readonly StepDescription[]): EntryDescription => ({ kind: 'parallel', id, arms });
const branch = (id: string, arms: readonly StepDescription[]): EntryDescription => ({ kind: 'branch', id, arms });
const loop = (id: string, body: StepDescription, iterationBound = 2): EntryDescription =>
  ({ kind: 'loop', id, loopType: 'dowhile', iterationBound, body });
const foreach = (id: string, body: StepDescription, concurrency = 2): EntryDescription =>
  ({ kind: 'foreach', id, concurrency, body });
const wf = (...entries: EntryDescription[]): WorkflowDescription => ({ id: 'w', entries });
const ids = (...names: string[]): StepDescription[] => names.map((n) => step(n));

const noop = async (): Promise<void> => {};

/** Appends a proof line to the file `PROOF_LOG` names, when it names one. */
const proofLog = (line: string): void => {
  const file = process.env['PROOF_LOG'];
  if (file) appendFileSync(file, `${line}\n`);
};

/** `c` with its transitions edited (a `null` drops one), `extra` added, and optionally new sites. */
function edited(
  c: CompiledWorkflow,
  edit: (t: Transition) => Transition | null = (t) => t,
  extra: readonly Transition[] = [],
  extraPlaces: readonly Place<unknown>[] = [],
): CompiledWorkflow {
  const transitions = [...[...c.net.transitions].map(edit).filter((t): t is Transition => t !== null), ...extra];
  return {
    ...c,
    net: PetriNet.builder(c.net.name).places(...c.net.places, ...extraPlaces).transitions(...transitions).build(),
  };
}

interface Rebuild {
  readonly inputs?: readonly In[];
  readonly output?: Out;
  readonly inhibitors?: readonly Place<unknown>[];
  readonly reads?: readonly Place<unknown>[];
}

/** A copy of `t` with some arcs replaced; action, timing, priority and resets kept. */
function rebuild(t: Transition, change: Rebuild = {}): Transition {
  const b = Transition.builder(t.name)
    .inputs(...(change.inputs ?? t.inputSpecs))
    .outputs(change.output ?? t.outputSpec!)
    .action(t.action)
    .timing(t.timing)
    .priority(t.priority);
  for (const p of change.reads ?? t.reads.map((a) => a.place)) b.read(p);
  for (const arc of t.resets) b.reset(arc.place);
  for (const p of change.inhibitors ?? t.inhibitors.map((a) => a.place)) b.inhibitor(p);
  return b.build();
}

const withSites = (c: CompiledWorkflow, sites: ReadonlyMap<string, ResumeSite>): CompiledWorkflow => ({ ...c, resumeSites: sites });
const without = (c: CompiledWorkflow, key: string): CompiledWorkflow =>
  withSites(c, new Map([...c.resumeSites].filter(([k]) => k !== key)));
const siteAt = (c: CompiledWorkflow, key: string): ResumeSite => {
  const site = c.resumeSites.get(key);
  if (site === undefined) throw new Error(`no site '${key}'; sites: ${[...c.resumeSites.keys()].join(', ')}`);
  return site;
};
const transitionNamed = (c: CompiledWorkflow, name: string): Transition => {
  const t = [...c.net.transitions].find((x) => x.name === name);
  if (t === undefined) throw new Error(`no transition '${name}'`);
  return t;
};
/** The consumers of a site's place: its gate(s), inhibited by the signal, and its sweep(s), reading it. */
const consumersOf = (c: CompiledWorkflow, p: Place<unknown>): Transition[] =>
  [...c.net.transitions].filter((t) => t.inputSpecs.some((i) => i.place.name === p.name));
const gateOf = (c: CompiledWorkflow, site: ResumeSite): Transition => {
  const gates = consumersOf(c, site.place).filter((t) => !t.reads.some((a) => a.place.name === c.cancel.name));
  expect(gates.length, `one gate at ${site.path.join('.')}`).toBe(1);
  return gates[0]!;
};
const sweepOf = (c: CompiledWorkflow, site: ResumeSite): Transition => {
  const sweeps = consumersOf(c, site.place).filter((t) => t.reads.some((a) => a.place.name === c.cancel.name));
  expect(sweeps.length, `one sweep at ${site.path.join('.')}`).toBe(1);
  return sweeps[0]!;
};

// =============================================================================================
// Segments: the API the kernel and every proof share.
// =============================================================================================

describe('segments', () => {
  const c = compile(wf(step('a'), fan('fan', ids('x', 'y')), loop('l', step('b'))), { concurrency: 2 });

  it('the default is closed, cancel, then resume@s and resume@s+cancel for every site in path order, then the restarts', () => {
    expect([...c.resumeSites.keys()].sort()).toEqual(['0', '1.0', '1.1', '2']);
    const resumes = [
      'closed', 'cancel',
      'resume@0', 'resume@0+cancel',
      'resume@1.0', 'resume@1.0+cancel',
      'resume@1.1', 'resume@1.1+cancel',
      'resume@2', 'resume@2+cancel',
    ];
    expect(segmentsFor(c, { restart: 'none' }).map(segmentLabel)).toEqual(resumes);
    // The restart segments ([ADR 0010]) follow by default, one pair per top-level boundary.
    expect(c.boundaries.map((b) => b.index)).toEqual([0, 1, 2]);
    expect(segmentsFor(c).map(segmentLabel)).toEqual([
      ...resumes,
      'restart@0', 'restart@0+cancel',
      'restart@1', 'restart@1+cancel',
      'restart@2', 'restart@2+cancel',
    ]);
    expect(segmentsFor(c, { resume: 'all' }).map(segmentLabel)).toEqual(segmentsFor(c).map(segmentLabel));
  });

  it("'none' leaves the fresh segments; a list selects sites; explicit segments win", () => {
    expect(segmentsFor(c, { resume: 'none', restart: 'none' })).toEqual(['closed', 'cancel']);
    expect(segmentsFor(c, { resume: ['1.1'], restart: 'none' }).map(segmentLabel)).toEqual(['closed', 'cancel', 'resume@1.1', 'resume@1.1+cancel']);
    // `resume: 'none'` alone still leaves the default restarts.
    expect(segmentsFor(c, { resume: 'none' }).map(segmentLabel)).toEqual([
      'closed', 'cancel', 'restart@0', 'restart@0+cancel', 'restart@1', 'restart@1+cancel', 'restart@2', 'restart@2+cancel',
    ]);
    const only: readonly Segment[] = [resumeSegment('2', true)];
    expect(segmentsFor(c, { segments: only, resume: 'all' })).toBe(only);
  });

  it('an unknown site key throws before any check or proof runs', async () => {
    expect(() => segmentsFor(c, { resume: ['7'] })).toThrow("no resume site '7' in workflow 'w' (sites: 0, 1.0, 1.1, 2)");
    await expect(verifyWorkflow(c, { resume: ['1.2'] })).rejects.toThrow("no resume site '1.2'");
    await expect(verifyWorkflow(c, { segments: [resumeSegment('9', false)] })).rejects.toThrow("no resume site '9'");
  });

  it('a resume segment prints as its label, and compares by its fields alone', () => {
    const s = resumeSegment('1.0', true);
    expect(`${s}`).toBe('resume@1.0+cancel');
    expect(String(resumeSegment('2', false))).toBe('resume@2');
    expect(s).toEqual({ resume: '1.0', cancel: true });
    expect(Object.keys(s)).toEqual(['resume', 'cancel']);
  });

  it('the initial marking is {site: 1, permits: k[, cancel request: 1]} and nothing else', () => {
    const names = (seg: Segment) => Object.fromEntries([...segmentInitialMarking(c, seg)].map(([p, n]) => [p.name, n]));
    expect(names('closed')).toEqual({ [c.entryPlace.name]: 1, 'wf.permits': 2 });
    expect(names('cancel')).toEqual({ [c.entryPlace.name]: 1, 'wf.cancel.request': 1, 'wf.permits': 2 });
    expect(names(resumeSegment('1.1', false))).toEqual({ 's.1.fan.resume-1': 1, 'wf.permits': 2 });
    expect(names(resumeSegment('1.1', true))).toEqual({ 's.1.fan.resume-1': 1, 'wf.cancel.request': 1, 'wf.permits': 2 });
    expect(names(resumeSegment('0', false))).toEqual({ [siteAt(c, '0').place.name]: 1, 'wf.permits': 2 });
    // Unbudgeted: no permits at all.
    const free = compile(wf(step('a')));
    expect(Object.fromEntries([...segmentInitialMarking(free, resumeSegment('0', true))].map(([p, n]) => [p.name, n])))
      .toEqual({ 's.0.a.in': 1, 'wf.cancel.request': 1 });
  });

  it('the property set: neverCanceled only without a cancel; the report names segment, marking and route', async () => {
    const reports = await verifyWorkflow(compile(wf(step('a')), { concurrency: 1 }), { timeoutMs: 30_000 });
    expect(reports.map((r) => `${r.segment}/${r.property}`)).toEqual([
      'closed/deadlockFree', 'closed/terminatesAtSink', 'closed/exactlyOneTerminal', 'closed/neverCanceled',
      'closed/permitsBounded', 'closed/permitsReturned',
      'cancel/deadlockFree', 'cancel/terminatesAtSink', 'cancel/exactlyOneTerminal',
      'cancel/permitsBounded', 'cancel/permitsReturned',
      'resume@0/deadlockFree', 'resume@0/terminatesAtSink', 'resume@0/exactlyOneTerminal', 'resume@0/neverCanceled',
      'resume@0/permitsBounded', 'resume@0/permitsReturned',
      'resume@0+cancel/deadlockFree', 'resume@0+cancel/terminatesAtSink', 'resume@0+cancel/exactlyOneTerminal',
      'resume@0+cancel/permitsBounded', 'resume@0+cancel/permitsReturned',
      'restart@0/deadlockFree', 'restart@0/terminatesAtSink', 'restart@0/exactlyOneTerminal', 'restart@0/neverCanceled',
      'restart@0/permitsBounded', 'restart@0/permitsReturned',
      'restart@0+cancel/deadlockFree', 'restart@0+cancel/terminatesAtSink', 'restart@0+cancel/exactlyOneTerminal',
      'restart@0+cancel/permitsBounded', 'restart@0+cancel/permitsReturned',
    ]);
    for (const r of reports) expect(r.result.verdict.type, describeReport(r)).toBe('proven');
    // One step: site 0 and boundary 0 are the entry place, so every segment but the two fresh ones
    // has a fresh segment's marking and cites its proof rather than asking again.
    const cited = Object.fromEntries(reports.map((r) => [`${r.segment}/${r.property}`, r.sameProofAs === undefined ? '-' : segmentLabel(r.sameProofAs)]));
    for (const r of reports) {
      const label = segmentLabel(r.segment);
      const expected = label === 'closed' || label === 'cancel' ? '-' : label.endsWith('+cancel') ? 'cancel' : 'closed';
      expect(cited[`${r.segment}/${r.property}`], `${r.segment}/${r.property}`).toBe(expected);
      if (r.sameProofAs !== undefined) {
        const source = reports.find((x) => segmentLabel(x.segment) === expected && x.property === r.property)!;
        expect(r.result).toBe(source.result);
        expect(r.marking).toBe(source.marking);
      }
    }
    const resumed = reports.find((r) => `${r.segment}/${r.property}` === 'resume@0+cancel/permitsReturned')!;
    expect(describeReport(resumed)).toMatch(
      /^resume@0\+cancel\/permitsReturned: proven via \S+ in [\d.]+ms from \{s\.0\.a\.in: 1, wf\.cancel\.request: 1, wf\.permits: 1\} \(the proof of cancel, same marking\)$/,
    );
    const last = reports[reports.length - 1]!;
    expect(describeReport(last)).toMatch(
      /^restart@0\+cancel\/permitsReturned: proven via \S+ in [\d.]+ms from \{s\.0\.a\.in: 1, wf\.cancel\.request: 1, wf\.permits: 1\} \(the proof of cancel, same marking\)$/,
    );
    expect(describeReport(reports[0]!)).toMatch(/^closed\/deadlockFree: proven via \S+ in [\d.]+ms from \{s\.0\.a\.in: 1, wf\.permits: 1\}$/);
  });
});

// =============================================================================================
// The structural checks. Each is clean on every compiled shape (the negative controls) and flags
// each mutant with its exact line (the positive cases). Mutants are hand-edited copies of compiled
// nets; nothing in src/ is touched.
// =============================================================================================

const cleanShapes: ReadonlyArray<readonly [string, WorkflowDescription]> = [
  ['one step', wf(step('a'))],
  ['a chain with a timed retry and a fixed sleep', wf(step('a', { retries: 2, retryDelayMs: 5 }), { kind: 'sleep', id: 'z', duration: { fixed: 5 } }, step('b'))],
  ['a nested-workflow step', wf(step('sub', { source: 'workflow' }))],
  ['a loop', wf(loop('l', step('b', { retries: 1, retryDelayMs: 3 })))],
  ['a parallel of 3 with a timed-retry arm', wf(fan('fan', [step('a', { retries: 2, retryDelayMs: 5 }), step('b'), step('c')]))],
  ['a branch of 2', wf(branch('br', ids('a', 'b')))],
  ['everything in series', wf(step('s'), fan('fan', ids('a', 'b')), branch('br', ids('c', 'd')), loop('l', step('e')), step('t'))],
  ['a foreach', wf(foreach('each', step('x')))],
];

describe('negative controls: every compiled shape passes all three checks', () => {
  it.each(cleanShapes)('%s', (_label, description) => {
    for (const k of [undefined, 1, 2]) {
      const c = compile(description, k === undefined ? {} : { concurrency: k });
      expect(resumeGateViolations(c), `gate k=${k}`).toEqual([]);
      expect(suspensionCoverageViolations(c), `coverage k=${k}`).toEqual([]);
      expect(resumeTimingViolations(c), `timing k=${k}`).toEqual([]);
    }
  });
});

describe('resumeGateViolations', () => {
  const top = compile(wf(step('a'), fan('fan', ids('x', 'y'))));

  it('flags a re-enter gate without its cancel inhibitor, and verifyWorkflow refuses the net', async () => {
    // The cancel check (rule 3: an ungated start competing with a sweep) sees this mutant too and
    // runs first; the gate check names the site as well, so neither depends on the other.
    const site = siteAt(top, '1.0');
    const gate = gateOf(top, site);
    expect(gate.name).toBe('t.1.fan.re-enter-0');
    const mutant = edited(top, (t) => (t.name === gate.name ? rebuild(t, { inhibitors: [] }) : t));
    expect(resumeGateViolations(mutant)).toEqual([
      "'t.1.fan.re-enter-0' consumes resume site 1.0 ('s.1.fan.resume-0') without an inhibitor on 'wf.cancel'",
    ]);
    await expect(verifyWorkflow(mutant, { resume: 'none' })).rejects.toThrow(
      /^cancellation structure is unsound:\n {2}'t\.1\.fan\.re-enter-0' competes with sweep 't\.1\.fan\.re-enter-0\.cancel'/,
    );
  });

  it('a gate the cancel check cannot see — no sweep to compete with — is refused by the gate check', async () => {
    // With the sweep gone too, nothing competes, so the cancel check is silent; only this one speaks.
    const mutant = edited(top, (t) =>
      t.name === 't.1.fan.re-enter-0' ? rebuild(t, { inhibitors: [] }) : t.name === 't.1.fan.re-enter-0.cancel' ? null : t,
    );
    await expect(verifyWorkflow(mutant, { resume: 'none' })).rejects.toThrow(
      "resume gate structure is unsound:\n  't.1.fan.re-enter-0' consumes resume site 1.0 ('s.1.fan.resume-0') without an inhibitor on 'wf.cancel'\n  " +
        "resume site 1.0 ('s.1.fan.resume-0') has no sweep: nothing reads 'wf.cancel' and consumes it",
    );
  });

  it("flags a top-level step's first attempt without its inhibitor (the entry site's gate)", () => {
    const mutant = edited(top, (t) => (t.name === 't.0.a.run' ? rebuild(t, { inhibitors: [] }) : t));
    expect(resumeGateViolations(mutant)).toEqual([
      "'t.0.a.run' consumes resume site 0 ('s.0.a.in') without an inhibitor on 'wf.cancel'",
    ]);
  });

  it('flags a site with its sweep dropped', () => {
    const sweep = sweepOf(top, siteAt(top, '1.1'));
    expect(sweep.name).toBe('t.1.fan.re-enter-1.cancel');
    expect(resumeGateViolations(edited(top, (t) => (t.name === sweep.name ? null : t)))).toEqual([
      "resume site 1.1 ('s.1.fan.resume-1') has no sweep: nothing reads 'wf.cancel' and consumes it",
    ]);
  });

  it('flags a site with its gate dropped', () => {
    expect(resumeGateViolations(edited(top, (t) => (t.name === 't.1.fan.re-enter-1' ? null : t)))).toEqual([
      "resume site 1.1 ('s.1.fan.resume-1') has no gate: nothing consumes it without reading 'wf.cancel'",
    ]);
  });

  it('flags a transition that produces into an arm site: a site is marked only by the seed', () => {
    const site = siteAt(top, '1.0') as ArmSite;
    const leak = Transition.builder('t.leak').inputs(one(top.terminals.done)).outputs(outPlace(site.place)).action(noop).build();
    expect(resumeGateViolations(edited(top, undefined, [leak]))).toEqual([
      "'t.leak' produces into resume site 1.0 ('s.1.fan.resume-0'); an arm site is marked only by a resume seed",
    ]);
  });

  it('flags a reset on a site place', () => {
    const site = siteAt(top, '0');
    const clear = Transition.builder('t.clear').inputs(one(top.terminals.done)).reset(site.place).outputs(outPlace(top.terminals.done)).action(noop).build();
    expect(resumeGateViolations(edited(top, undefined, [clear]))).toEqual(["'t.clear' resets resume site 0 ('s.0.a.in')"]);
  });

  // Rule 6: a site's sweep outputs into the enclosing canceled exit — `wf.canceled`, for every
  // site — and nothing else. The negative controls above run every compiled shape through it.
  it('flags an arm sweep re-routed to wf.done — which every proof of both its segments misses', async () => {
    const sweep = sweepOf(top, siteAt(top, '1.0'));
    expect(sweep.name).toBe('t.1.fan.re-enter-0.cancel');
    expect([...sweep.outputPlaces()].map((p) => p.name)).toEqual(['wf.canceled']);
    const mutant = edited(top, (t) => (t.name === sweep.name ? rebuild(t, { output: outPlace(top.terminals.done) }) : t));
    const line = "sweep 't.1.fan.re-enter-0.cancel' of resume site 1.0 ('s.1.fan.resume-0') outputs into 'wf.done'; a site sweep outputs only into 'wf.canceled'";
    expect(resumeGateViolations(mutant)).toEqual([line]);
    await expect(verifyWorkflow(mutant, { resume: ['1.0'] })).rejects.toThrow(`resume gate structure is unsound:\n  ${line}`);

    // What the check is for: with it skipped, the mutant's own segments are proven, every property.
    const segments = [resumeSegment('1.0', false), resumeSegment('1.0', true)];
    const reports = await verifyWorkflow(mutant, { segments, structure: 'skip', timeoutMs: 30_000 });
    for (const r of reports) proofLog(`rule-6 mutant ${describeReport(r)}`);
    expect(reports.map((r) => `${segmentLabel(r.segment)}/${r.property}`)).toStrictEqual(
      segmentsFor(mutant, { segments }).flatMap((seg) =>
        ['deadlockFree', 'terminatesAtSink', 'exactlyOneTerminal', ...(typeof seg !== 'string' && seg.cancel ? [] : ['neverCanceled'])].map(
          (property) => `${segmentLabel(seg)}/${property}`,
        ),
      ),
    );
    for (const r of reports) expect(r.result.verdict.type, describeReport(r)).toBe('proven');
  });

  it("flags an entry site's sweep writing a second place, and a sweep with no output at all", () => {
    const sweep = sweepOf(top, siteAt(top, '0'));
    expect(sweep.name).toBe('t.0.a.cancel');
    const both = edited(top, (t) =>
      t.name === sweep.name ? rebuild(t, { output: and(outPlace(top.terminals.canceled), outPlace(top.terminals.failed)) }) : t,
    );
    expect(resumeGateViolations(both)).toEqual([
      "sweep 't.0.a.cancel' of resume site 0 ('s.0.a.in') outputs into 'wf.failed'; a site sweep outputs only into 'wf.canceled'",
    ]);
    const silent = (t: Transition): Transition => {
      const b = Transition.builder(t.name).inputs(...t.inputSpecs).action(noop).timing(t.timing).priority(t.priority);
      for (const a of t.reads) b.read(a.place);
      for (const a of t.inhibitors) b.inhibitor(a.place);
      return b.build();
    };
    expect(resumeGateViolations(edited(top, (t) => (t.name === sweep.name ? silent(t) : t)))).toEqual([
      "sweep 't.0.a.cancel' of resume site 0 ('s.0.a.in') outputs nothing; it must output into 'wf.canceled'",
    ]);
  });

  it('flags a foreach sweep re-routed into the foreach interior', () => {
    const each = compile(wf(foreach('each', step('x'))));
    const sweep = sweepOf(each, siteAt(each, '0'));
    expect(sweep.name).toBe('t.0.each.re-enter.cancel');
    const frame = [...each.net.places].find((p) => p.name === 's.0.each.frame');
    if (frame === undefined) throw new Error('no frame place');
    const mutant = edited(each, (t) => (t.name === sweep.name ? rebuild(t, { output: outPlace(frame) }) : t));
    expect(resumeGateViolations(mutant)).toEqual([
      "sweep 't.0.each.re-enter.cancel' of resume site 0 ('s.0.each.resume') outputs into 's.0.each.frame'; a site sweep outputs only into 'wf.canceled'",
    ]);
  });

  it('flags a key that is not the path, a place not in the net, and an entry site on the wrong place', () => {
    const entry = siteAt(top, '0') as EntrySite;
    const ghost = place<never>('s.0.a.ghost');
    expect(resumeGateViolations(withSites(top, new Map<string, ResumeSite>([['5', entry]])))).toEqual([
      'resume site 5 is registered at path [0]; the key must be the path',
    ]);
    expect(resumeGateViolations(withSites(top, new Map<string, ResumeSite>([['0', { ...entry, place: ghost }]])))).toEqual([
      "resume site 0 ('s.0.a.ghost') is not a place in the net",
    ]);
    // An arm's input place is not gated at all, so an entry site pointed there fails three ways:
    // an ungated consumer, no sweep, and not the input place of the entry at that path.
    const armIn = [...top.net.places].find((p) => p.name === 's.1-0.x.in')!;
    expect(resumeGateViolations(withSites(top, new Map<string, ResumeSite>([['0', { ...entry, place: armIn as EntrySite['place'] }]])))).toEqual([
      "'t.1-0.x.run' consumes resume site 0 ('s.1-0.x.in') without an inhibitor on 'wf.cancel'",
      "resume site 0 ('s.1-0.x.in') has no sweep: nothing reads 'wf.cancel' and consumes it",
      "resume site 0 ('s.1-0.x.in') is not the input place of the entry at [0]",
    ]);
  });
});

describe('suspensionCoverageViolations', () => {
  const c = compile(wf(step('a', { retries: 1 }), fan('fan', ids('x', 'y')), branch('br', ids('p', 'q')), loop('l', step('b'))));

  it('an unregistered top-level step, arm, branch arm or loop body is flagged, once per path', async () => {
    expect(suspensionCoverageViolations(without(c, '0'))).toEqual([
      "step 'a' at [0] ('t.0.a.run') can suspend, and no resume site covers it",
    ]);
    expect(suspensionCoverageViolations(without(c, '1.1'))).toEqual([
      "step 'y' at [1, 1] ('t.1-1.y.run') can suspend, and no resume site covers it",
    ]);
    expect(suspensionCoverageViolations(without(c, '2.0'))).toEqual([
      "step 'p' at [2, 0] ('t.2-0.p.run') can suspend, and no resume site covers it",
    ]);
    expect(suspensionCoverageViolations(without(c, '3'))).toEqual([
      "step 'b' at [3] ('t.3.b.run') can suspend, and no resume site covers it",
    ]);
    await expect(verifyWorkflow(without(c, '1.1'), { resume: 'none' })).rejects.toThrow(/suspension coverage is unsound/);
  });

  it('a site at the wrong path does not cover: a foreach site covers its lanes, an entry site does not', () => {
    const each = compile(wf(foreach('each', step('x'), 2)));
    const bare = withSites(each, new Map());
    expect(suspensionCoverageViolations(bare)).toEqual([
      "step 'x' at [0, 0] ('t.0-0.x.run') can suspend, and no resume site covers it",
      "step 'x' at [0, 1] ('t.0-1.x.run') can suspend, and no resume site covers it",
    ]);
    const asForeach: ForeachSite = { kind: 'foreach', path: [0], stepId: 'x', place: place('s.0.each.resume') };
    expect(suspensionCoverageViolations(withSites(each, new Map([['0', asForeach]])))).toEqual([]);
    const asEntry: EntrySite = { kind: 'entry', path: [0], stepId: 'x', construct: 'step', place: each.entryPlace };
    expect(suspensionCoverageViolations(withSites(each, new Map([['0', asEntry]])))).toHaveLength(2);
  });

  it('flags a step attempt the net map does not know', () => {
    expect(suspensionCoverageViolations({ ...c, stepAttempts: [...c.stepAttempts, 't.9.ghost.run'] })).toEqual([
      "step attempt 't.9.ghost.run' has no entry in the net map",
    ]);
  });
});

describe('resumeTimingViolations', () => {
  const c = compile(wf(step('a', { retries: 2, retryDelayMs: 5 }), fan('fan', ids('x', 'y'))));

  it('exempts a top-level step\'s own retry hop, and nothing else', () => {
    expect(transitionNamed(c, 't.0.a.retry-1').timing).toEqual({ type: 'delayed', afterMs: 5 });
    expect(resumeTimingViolations(c)).toEqual([]);
  });

  it('flags a timed transition on a site place', () => {
    const site = siteAt(c, '1.0');
    const gate = gateOf(c, site);
    const mutant = edited(c, (t) => (t.name === gate.name ? Transition.builder(t.name).inputs(...t.inputSpecs).outputs(t.outputSpec!).inhibitor(c.cancel).timing(delayed(10)).action(t.action).build() : t));
    expect(resumeTimingViolations(mutant)).toEqual([
      "'t.1.fan.re-enter-0' is timed (delayed(10)) and consumes resume site 1.0 ('s.1.fan.resume-0')",
    ]);
  });

  it('flags a timed replay: a gate\'s direct output feeding a timed transition', () => {
    const mutant = edited(c, (t) => (t.name === 't.1.fan.replay-1' ? Transition.builder(t.name).inputs(...t.inputSpecs).outputs(t.outputSpec!).action(t.action).timing(delayed(7)).build() : t));
    expect(resumeTimingViolations(mutant)).toEqual([
      "'t.1.fan.replay-1' is timed (delayed(7)) and consumes 's.1.fan.replay-1', which gate 't.1.fan.re-enter-0' of resume site 1.0 emits into",
    ]);
  });

  it('flags a timed transition on the resumed arm\'s input, which is not a retry hop', () => {
    const armIn = [...c.net.places].find((p) => p.name === 's.1-1.y.in')!;
    const lazy = Transition.builder('t.lazy').inputs(one(armIn)).outputs(outPlace(c.terminals.done)).timing(delayed(3)).action(noop).build();
    expect(resumeTimingViolations(edited(c, undefined, [lazy]))).toEqual([
      "'t.lazy' is timed (delayed(3)) and consumes 's.1-1.y.in', which gate 't.1.fan.re-enter-1' of resume site 1.1 emits into",
    ]);
  });

  it('a delayed hop out of a step attempt that feeds a non-attempt is not a retry hop', () => {
    // `t.0.a.run` is the gate of site 0; its `retry-1` output feeds a delayed wait into
    // `attempt-1`. Re-point the wait into the settle place instead: no longer a retry hop.
    const settle = [...c.net.places].find((p) => p.name === 'wf.settle.failed')!;
    const mutant = edited(c, (t) => (t.name === 't.0.a.retry-1' ? rebuild(t, { output: outPlace(settle) }) : t));
    expect(resumeTimingViolations(mutant)).toEqual([
      "'t.0.a.retry-1' is timed (delayed(5)) and consumes 's.0.a.retry-1', which gate 't.0.a.run' of resume site 0 emits into",
    ]);
  });
});

// =============================================================================================
// Proofs: every site of every shape, at k in {1, 2, unbounded}.
// =============================================================================================

const FRESH = ['closed', 'cancel'];
/** Every report key `verifyWorkflow` must return for `c`, in order. */
function expectedKeys(c: CompiledWorkflow, sites: readonly string[]): string[] {
  const budget = c.budget ? ['permitsBounded', 'permitsReturned'] : [];
  const props = (cancel: boolean) => ['deadlockFree', 'terminatesAtSink', 'exactlyOneTerminal', ...(cancel ? [] : ['neverCanceled']), ...budget];
  const labels = [...FRESH, ...sites.flatMap((s) => [`resume@${s}`, `resume@${s}+cancel`])];
  return labels.flatMap((label) => props(label.endsWith('cancel')).map((p) => `${label}/${p}`));
}

async function proveAll(label: string, description: WorkflowDescription, k: number | undefined, sites: readonly string[], timeoutMs: number): Promise<readonly PropertyReport[]> {
  const c = compile(description, k === undefined ? {} : { concurrency: k });
  expect([...c.resumeSites.keys()].sort(), `${label}: registered sites`).toEqual([...sites].sort());
  const started = performance.now();
  // The resume segments alone: the restart segments are `tests/verify/restart-segments.test.ts`'s.
  const reports = await verifyWorkflow(c, { timeoutMs, restart: 'none' });
  const ms = performance.now() - started;
  expect(reports.map((r) => `${r.segment}/${r.property}`), label).toEqual(expectedKeys(c, sites));
  for (const r of reports) expect(r.result.verdict.type, `${label}: ${describeReport(r)}`).toBe('proven');
  proofLog(`[resume-segments] ${label} (${ms.toFixed(0)}ms, libpetri 6.1.0 from npm): ${reports.map(describeReport).join('; ')}`);
  return reports;
}

const KS = [1, 2, undefined] as const;
const kLabel = (k: number | undefined): string => (k === undefined ? 'unbounded' : `k=${k}`);

const proofShapes: ReadonlyArray<readonly [string, WorkflowDescription, readonly string[]]> = [
  ['leaf: one step', wf(step('a')), ['0']],
  ['leaf: a chain of three', wf(step('a'), step('b'), step('c')), ['0', '1', '2']],
  ['leaf: retries 2 with a timed delay, then a fixed sleep', wf(step('a', { retries: 2, retryDelayMs: 5 }), { kind: 'sleep', id: 'z', duration: { fixed: 5 } }, step('b')), ['0', '2']],
  ['leaf: a nested-workflow step', wf(step('sub', { source: 'workflow' }), step('after')), ['0', '1']],
  ['loop: dowhile, bound 2', wf(loop('l', step('b'))), ['0']],
  ['loop: dountil bound 3 between steps', wf(step('s'), { kind: 'loop', id: 'l', loopType: 'dountil', iterationBound: 3, body: step('b') }, step('t')), ['0', '1', '2']],
  ['parallel n=2', wf(fan('fan', ids('a', 'b'))), ['0.0', '0.1']],
  ['parallel n=3 then a successor', wf(fan('fan', ids('a', 'b', 'c')), step('after')), ['0.0', '0.1', '0.2', '1']],
  ['parallel n=4', wf(fan('fan', ids('a', 'b', 'c', 'd'))), ['0.0', '0.1', '0.2', '0.3']],
  ['parallel n=2, arms sharing a step id', wf(fan('fan', ids('a', 'a'))), ['0.0', '0.1']],
  ['branch k=2', wf(branch('br', ids('a', 'b'))), ['0.0', '0.1']],
  ['branch k=3 between steps', wf(step('s'), branch('br', ids('a', 'b', 'c')), step('t')), ['0', '1.0', '1.1', '1.2', '2']],
];

describe('every resume site of every shape, proven at k in {1, 2, unbounded}', () => {
  for (const [label, description, sites] of proofShapes) {
    for (const k of KS) {
      it(`${label}, ${kLabel(k)}`, async () => {
        await proveAll(`${label}, ${kLabel(k)}`, description, k, sites, 30_000);
      });
    }
  }
});

// One at a time: each proof is a few seconds alone, and twelve of them at once beside the rest of
// the suite starve the solver past its 30 s — which reads as `unknown`, not as a slow proof.
describe('larger shapes, every site, 30 s per query', () => {
  const slowShapes: ReadonlyArray<readonly [string, WorkflowDescription, readonly string[]]> = [
    ['parallel n=4, every arm retrying twice with a timed delay', wf(fan('fan', ['a', 'b', 'c', 'd'].map((id) => step(id, { retries: 2, retryDelayMs: 5 })))), ['0.0', '0.1', '0.2', '0.3']],
    ['branch k=3, every arm retrying once', wf(branch('br', ['a', 'b', 'c'].map((id) => step(id, { retries: 1 })))), ['0.0', '0.1', '0.2']],
    [
      'step, parallel 3, branch 3, loop, step in series',
      wf(step('s'), fan('fan', ids('a', 'b', 'c')), branch('br', ids('d', 'e', 'f')), loop('l', step('g')), step('t')),
      ['0', '1.0', '1.1', '1.2', '2.0', '2.1', '2.2', '3', '4'],
    ],
  ];
  for (const [label, description, sites] of slowShapes) {
    for (const k of [...KS, 4]) {
      it(`${label}, ${kLabel(k)}`, async () => {
        await proveAll(`${label}, ${kLabel(k)}`, description, k, sites, 30_000);
      });
    }
  }
});

// =============================================================================================
// Mutants a proof must see (the proof story's list, W8's share). Each verdict is asserted to be
// `violated` — not "not proven", which `unknown` would satisfy.
// =============================================================================================

describe('non-vacuity: the resume segments discriminate', () => {
  const verdictOf = (reports: readonly PropertyReport[], key: string): string => {
    const r = reports.find((x) => `${x.segment}/${x.property}` === key);
    if (r === undefined) throw new Error(`no '${key}' report`);
    return r.result.verdict.type;
  };

  it('a dropped sweep: resume@s+cancel strands the seed; resume@s alone cannot see it', async () => {
    const c = compile(wf(fan('fan', ids('a', 'b'))));
    const sweep = sweepOf(c, siteAt(c, '0.1'));
    const mutant = edited(c, (t) => (t.name === sweep.name ? null : t));
    const reports = await verifyWorkflow(mutant, {
      structure: 'skip',
      segments: [resumeSegment('0.1', false), resumeSegment('0.1', true)],
      timeoutMs: 30_000,
    });
    // Without a cancel the gate always fires: the sweep's absence is invisible.
    for (const p of ['deadlockFree', 'terminatesAtSink', 'exactlyOneTerminal', 'neverCanceled']) {
      expect(verdictOf(reports, `resume@0.1/${p}`), p).toBe('proven');
    }
    // With a cancel arriving before the gate, the seed has no consumer: no terminal at all.
    expect(verdictOf(reports, 'resume@0.1+cancel/exactlyOneTerminal')).toBe('violated');
    expect(verdictOf(reports, 'resume@0.1+cancel/deadlockFree')).toBe('violated');
    // And the structural check names it before any proof would run.
    expect(resumeGateViolations(mutant)).toEqual([
      "resume site 0.1 ('s.0.fan.resume-1') has no sweep: nothing reads 'wf.cancel' and consumes it",
    ]);
  });

  it('a replay that loses its arrival on the suspended branch strands the join at resume@[i,a]', async () => {
    // The proof story's "drop one replay-i xor branch" as a *weakening*: removing an alternative
    // only removes behaviour and stays proven, so the mutant keeps the branch but drops the
    // `arrived` from it — the join's `exactly(n)` then never sees n arrivals.
    const c = compile(wf(fan('fan', ids('a', 'b', 'c'))));
    const replay = transitionNamed(c, 't.0.fan.replay-2');
    const suspSeen = [...c.net.places].find((p) => p.name === 's.0.fan.susp-seen')!;
    const arrived = [...c.net.places].find((p) => p.name === 's.0.fan.arrived')!;
    const errSeen = [...c.net.places].find((p) => p.name === 's.0.fan.err-seen')!;
    const mutant = edited(c, (t) =>
      t.name === replay.name
        ? rebuild(t, { output: xor(outPlace(arrived), outPlace(suspSeen), and(outPlace(arrived), outPlace(errSeen))) })
        : t,
    );
    const reports = await verifyWorkflow(mutant, { segments: [resumeSegment('0.0', false), resumeSegment('0.1', false)], timeoutMs: 30_000 });
    for (const site of ['0.0', '0.1']) {
      expect(verdictOf(reports, `resume@${site}/deadlockFree`), site).toBe('violated');
      expect(verdictOf(reports, `resume@${site}/exactlyOneTerminal`), site).toBe('violated');
    }
    // The fresh segments never reach `replay-2`: only a resume segment can see this defect.
    const fresh = await verifyWorkflow(mutant, { resume: 'none', restart: 'none', timeoutMs: 30_000 });
    for (const r of fresh) expect(r.result.verdict.type, describeReport(r)).toBe('proven');
  });

  it('a resume gate that ignores the signal is refused before any proof', async () => {
    const c = compile(wf(branch('br', ids('a', 'b'))));
    const gate = gateOf(c, siteAt(c, '0.1'));
    const mutant = edited(c, (t) => (t.name === gate.name ? rebuild(t, { inhibitors: [] }) : t));
    await expect(verifyWorkflow(mutant)).rejects.toThrow(/^cancellation structure is unsound:\n {2}'t\.0\.br\.re-enter-1' competes with sweep/);
    expect(resumeGateViolations(mutant)).toEqual([
      "'t.0.br.re-enter-1' consumes resume site 0.1 ('s.0.br.resume-1') without an inhibitor on 'wf.cancel'",
    ]);
  });

  it('an unregistered suspendable arm is refused before any proof', async () => {
    const c = compile(wf(branch('br', ids('a', 'b'))));
    await expect(verifyWorkflow(without(c, '0.0'))).rejects.toThrow(
      "suspension coverage is unsound:\n  step 'a' at [0, 0] ('t.0-0.a.run') can suspend, and no resume site covers it",
    );
  });
});

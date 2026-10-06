import { describe, expect, it } from 'vitest';
import { place, type Out, type Place, type Transition } from 'libpetri';
import { SmtVerifier, deadlockFree, inFlightTransitions, placeBound, type SmtProperty } from 'libpetri/verification';
import {
  NameVocabulary,
  compensateLadder,
  compile,
  ladderLevel,
  type CompensationSite,
  type CompiledWorkflow,
  type EntryDescription,
  type Exits,
  type FlowToken,
  type Ladder,
  type StepDescription,
  type Terminals,
  type WorkflowDescription,
} from '../../src/compiler/index.js';
import { initialCounts } from '../../src/engine/kernel.js';
import { poolSinks } from '../../src/verify/pools.js';

/**
 * The compensation ladder ([ADR 0017], amended by the W0 spike) from the compiled net alone — no step
 * runs here (`tests/engine/compensate.test.ts` runs them, W2; `tests/verify/compensate.test.ts` holds
 * S1–S8 and C1–C4).
 *
 * What it pins: the exact `t.comp.*` transition list (five settle kinds, `discharge_j.canceled` at
 * every level, no `release`); every ladder arc as the ADR draws it; the site naming exactly what was
 * emitted; the stack the level token carries, pushed and popped by the actions; every ladder place
 * 1-bounded from the arcs (and proven, closed and cancel); no ladder inhibitor, read or reset, the
 * inhibited and read places those of the bare spine, and under [VER-004] only `t.cancel.arrive` split;
 * intercept mode — every top-level, checkpoint and foreach sweep feeds `wf.comp.exit.canceled` and
 * only the settle pairs and `discharge_j.canceled` produce `wf.canceled`; state-class counts equal to
 * the Amendment's table; `ladderLevel`; the compiler's four refusals.
 *
 * Proofs are judged by verdict string, never by `isViolated()` — `unknown` fails. libpetri 8.0.0 from
 * npm, not linked; class counts are that release's.
 */

const BUDGET_MS = 30_000;
const T = { timeout: 60_000 } as const;

const step = (id: string, extra: Partial<StepDescription> = {}): StepDescription => ({ kind: 'step', id, ...extra });
/** A compensated step: `forward` its own options, `undo` the compensator's (`undo-<id>`). */
const cs = (id: string, forward: Partial<StepDescription> = {}, undo: Partial<StepDescription> = {}): StepDescription =>
  step(id, { ...forward, compensate: step(`undo-${id}`, undo) });
const foreach = (id: string, body: StepDescription, concurrency: number): EntryDescription => ({ kind: 'foreach', id, body, concurrency });
const strip = (description: WorkflowDescription): WorkflowDescription => ({
  ...description,
  entries: description.entries.map((entry) => {
    if (entry.kind !== 'step') return entry;
    const { compensate: _compensate, ...plain } = entry;
    return plain;
  }),
});

const m2: WorkflowDescription = { id: 'm2', entries: [cs('a'), step('x'), cs('b'), step('z')] };

function siteOf(compiled: CompiledWorkflow): CompensationSite {
  const site = compiled.compensations;
  if (site === undefined) throw new Error(`'${compiled.net.name}' compiled no ladder`);
  return site;
}
const transitionsOf = (compiled: CompiledWorkflow): Map<string, Transition> => new Map([...compiled.net.transitions].map((t) => [t.name, t]));
const ladderTransitions = (compiled: CompiledWorkflow): string[] => [...compiled.net.transitions].map((t) => t.name).filter((n) => n.startsWith('t.comp.')).sort();

function branches(out: Out): string[][] {
  switch (out.type) {
    case 'place':
      return [[out.place.name]];
    case 'forward-input':
      return [[out.to.name]];
    case 'timeout':
      return branches(out.child);
    case 'xor':
      return out.children.flatMap(branches);
    case 'and':
      return out.children.reduce<string[][]>((acc, c) => acc.flatMap((prefix) => branches(c).map((b) => [...prefix, ...b])), [[]]);
  }
}
const outputsOf = (t: Transition): string[] => [...new Set(t.outputSpec === null ? [] : branches(t.outputSpec).flat())];

/** A transition's arcs, by place name: `inputs` sorted, `outputs` as its one `and` branch, sorted. */
function arcs(t: Transition): { inputs: string[]; outputs: string[][]; inhibitors: string[]; reads: string[]; resets: string[] } {
  return {
    inputs: t.inputSpecs.map((s) => `${s.type}:${s.place.name}`).sort(),
    outputs: t.outputSpec === null ? [] : branches(t.outputSpec).map((b) => [...b].sort()),
    inhibitors: t.inhibitors.map((a) => a.place.name),
    reads: t.reads.map((a) => a.place.name),
    resets: t.resets.map((a) => a.place.name),
  };
}
const pure = (inputs: string[], outputs: string[]) => ({
  inputs: inputs.map((p) => `one:${p}`).sort(),
  outputs: [[...outputs].sort()],
  inhibitors: [],
  reads: [],
  resets: [],
});

describe('the net the ADR draws', () => {
  it('m2 [a*,x,b*,z]: exactly these ladder transitions — five settle kinds, discharge_j.canceled at every level, no release', () => {
    // Breaks if: a sixth `settle_j.canceled` (W0 amendment 3: dead, a compensator has no signal), a
    // `release.canceled` read arc (W0's first draft, deleted), a level without its discharges, or any
    // other ladder transition is emitted or dropped.
    const kinds = ['done', 'failed', 'bailed', 'suspended', 'paused'];
    const discharge = ['done', 'bailed', 'suspended', 'paused', 'canceled'];
    const expected = [
      't.comp.raise',
      't.comp.finish',
      ...[1, 2].flatMap((j) => [`t.comp.${j}.arm`, `t.comp.${j}.start`, ...kinds.map((k) => `t.comp.${j}.settle.${k}`)]),
      ...[0, 1, 2].flatMap((j) => discharge.map((k) => `t.comp.${j}.discharge.${k}`)),
    ].sort();
    const compiled = compile(m2);
    expect(ladderTransitions(compiled)).toEqual(expected);
    expect(ladderTransitions(compiled).filter((n) => n.includes('release') || n.endsWith('settle.canceled'))).toEqual([]);
  });

  it('m2: the rest of the net is the bare spine, by name, plus the two compensator leaves at [4] and [5]', () => {
    // Breaks if: the ladder renames or drops a spine transition or place, or a compensator is named
    // inside a top-level interior (`s.<i>.` for i < n) instead of at `[n + j - 1]` (W0 amendment 5).
    const compiled = compile(m2);
    const bare = compile(strip(m2));
    const bareT = [...bare.net.transitions].map((t) => t.name).sort();
    const bareP = [...bare.net.places].map((p) => p.name).sort();
    const restT = [...compiled.net.transitions].map((t) => t.name).filter((n) => !n.startsWith('t.comp.') && !/^t\.[45]\./.test(n)).sort();
    const restP = [...compiled.net.places].map((p) => p.name).filter((n) => !n.startsWith('wf.comp.') && !/^s\.[45]\./.test(n)).sort();
    expect(restT).toEqual(bareT);
    expect(restP).toEqual(bareP);
    expect([...compiled.net.transitions].map((t) => t.name).filter((n) => /^t\.[45]\./.test(n)).sort()).toEqual(['t.4.undo-a.run', 't.5.undo-b.run']);
    expect([...compiled.net.places].map((p) => p.name).filter((n) => /^s\.[45]\./.test(n)).sort()).toEqual(['s.4.undo-a.in', 's.5.undo-b.in']);
    // Five exits per compensator, no `canceled`: every `wf.comp` place is named here.
    const ladderPlaces = [
      ...[0, 1, 2].map((j) => `wf.comp.level.${j}`),
      'wf.comp.failure',
      'wf.comp.fault',
      'wf.comp.pending',
      ...['done', 'bailed', 'suspended', 'paused', 'canceled'].map((k) => `wf.comp.exit.${k}`),
      ...[1, 2].flatMap((j) => [`wf.comp.${j}.arming`, `wf.comp.${j}.undoing`, ...['done', 'failed', 'bailed', 'suspended', 'paused'].map((k) => `wf.comp.${j}.${k}`)]),
    ].sort();
    expect([...compiled.net.places].map((p) => p.name).filter((n) => n.startsWith('wf.comp.')).sort()).toEqual(ladderPlaces);
    expect([compiled.net.places.size, compiled.net.transitions.size]).toEqual([44, 52]);
  });

  it('m2: every ladder transition has exactly the arcs of the ADR table', () => {
    // Breaks if: `arm` skips the lower level (MUT6) or forgets the successor; a settle returns to its
    // own level (MUT5) or forgets `pending`; `start` keeps `pending`; `finish` runs without `level.0`
    // (MUT7) or delivers past the settle stage; a discharge lands in another kind's settle place (S6)
    // or delivers `canceled` anywhere but `wf.canceled`.
    const compiled = compile(m2);
    const t = transitionsOf(compiled);
    const of = (name: string) => arcs(t.get(name)!);
    expect(of('t.comp.1.arm')).toEqual(pure(['wf.comp.1.arming', 'wf.comp.level.0'], ['s.1.x.in', 'wf.comp.level.1']));
    expect(of('t.comp.2.arm')).toEqual(pure(['wf.comp.2.arming', 'wf.comp.level.1'], ['s.3.z.in', 'wf.comp.level.2']));
    expect(of('t.comp.raise')).toEqual(pure(['wf.comp.failure'], ['wf.comp.fault', 'wf.comp.pending']));
    expect(of('t.comp.finish')).toEqual(pure(['wf.comp.pending', 'wf.comp.level.0', 'wf.comp.fault'], ['wf.settle.failed']));
    for (const [j, u] of [[1, 's.4.undo-a.in'], [2, 's.5.undo-b.in']] as const) {
      expect(of(`t.comp.${j}.start`)).toEqual(pure(['wf.comp.pending', `wf.comp.level.${j}`], [u, `wf.comp.${j}.undoing`]));
      for (const kind of ['done', 'failed', 'bailed', 'suspended', 'paused']) {
        expect(of(`t.comp.${j}.settle.${kind}`)).toEqual(pure([`wf.comp.${j}.${kind}`, `wf.comp.${j}.undoing`], [`wf.comp.level.${j - 1}`, 'wf.comp.pending']));
      }
    }
    const into = { done: 'wf.settle.done', bailed: 'wf.settle.bailed', suspended: 'wf.settle.suspended', paused: 'wf.settle.paused', canceled: 'wf.canceled' };
    for (const j of [0, 1, 2]) {
      for (const [kind, to] of Object.entries(into)) {
        expect(of(`t.comp.${j}.discharge.${kind}`)).toEqual(pure([`wf.comp.exit.${kind}`, `wf.comp.level.${j}`], [to]));
      }
    }
    // Every top-level outcome lands in the ladder: failures raised, the rest intercepted.
    const exitsOf = (name: string) => outputsOf(t.get(name)!).sort();
    expect(exitsOf('t.0.a.run')).toEqual(['wf.comp.1.arming', 'wf.comp.exit.bailed', 'wf.comp.exit.paused', 'wf.comp.exit.suspended', 'wf.comp.failure']);
    expect(exitsOf('t.1.x.run')).toEqual(['s.2.b.in', 'wf.comp.exit.bailed', 'wf.comp.exit.paused', 'wf.comp.exit.suspended', 'wf.comp.failure']);
    expect(exitsOf('t.3.z.run')).toEqual(['wf.comp.exit.bailed', 'wf.comp.exit.done', 'wf.comp.exit.paused', 'wf.comp.exit.suspended', 'wf.comp.failure']);
    // A compensator's outcomes go to its own five exits, and nowhere else.
    expect(exitsOf('t.4.undo-a.run')).toEqual(['wf.comp.1.bailed', 'wf.comp.1.done', 'wf.comp.1.failed', 'wf.comp.1.paused', 'wf.comp.1.suspended']);
    // `wf.settle.failed` has one producer, `finish`.
    expect([...compiled.net.transitions].filter((x) => outputsOf(x).includes('wf.settle.failed')).map((x) => x.name)).toEqual(['t.comp.finish']);
  });

  it('the site names exactly what was emitted, and maps each compensator to its paths', () => {
    // Breaks if: the site and the net disagree on a name; a compensator's view path is its naming
    // path (its events would carry `[n + j - 1]`, an entry that does not exist); its attempts are not
    // the leaf's, retries included; `forwardId` is not the compensated step's.
    const description: WorkflowDescription = { id: 'm2r', entries: [cs('a'), step('x'), cs('b', {}, { retries: 2 }), step('z')] };
    const compiled = compile(description);
    const site = siteOf(compiled);
    const t = new Set([...compiled.net.transitions].map((x) => x.name));
    const p = new Set([...compiled.net.places].map((x) => x.name));
    expect(site.m).toBe(2);
    expect(site.levels).toEqual(['wf.comp.level.0', 'wf.comp.level.1', 'wf.comp.level.2']);
    for (const name of [site.failure, site.fault, site.pending, ...site.levels, ...Object.values(site.exits)]) expect(p.has(name), name).toBe(true);
    for (const name of [site.raise, site.finish, ...site.discharges.flatMap((d) => Object.values(d))]) expect(t.has(name), name).toBe(true);
    expect(site.discharges).toHaveLength(3);
    const declared = new Set([site.raise, site.finish, ...site.discharges.flatMap((d) => Object.values(d)), ...site.compensators.flatMap((c) => [c.arm, c.start, ...Object.values(c.settles)])]);
    expect([...declared].sort()).toEqual(ladderTransitions(compiled));
    expect(site.compensators.map((c) => [c.j, c.k, c.forwardId, c.stepId, c.path, c.viewPath, c.inPlace, c.attempts])).toEqual([
      [1, 0, 'a', 'undo-a', [4], [0], 's.4.undo-a.in', ['t.4.undo-a.run']],
      [2, 2, 'b', 'undo-b', [5], [2], 's.5.undo-b.in', ['t.5.undo-b.run', 't.5.undo-b.run-1', 't.5.undo-b.run-2']],
    ]);
    for (const c of site.compensators) {
      for (const name of [c.arming, c.undoing, c.inPlace, ...Object.values(c.exits)]) expect(p.has(name), name).toBe(true);
      expect(Object.keys(c.exits)).toEqual(['done', 'failed', 'bailed', 'suspended', 'paused']);
      // The compiler registered the compensator as a step: attempts, chain, and its transitions mapped
      // to its own path.
      for (const a of c.attempts) expect(compiled.stepAttempts).toContain(a);
      expect(compiled.steps.find((s) => s.stepId === c.stepId)?.attempts).toEqual(c.attempts);
      expect(compiled.netMap.transitionToEntry.get(c.attempts[0]!)).toEqual({ path: c.path, id: c.stepId });
    }
  });

  it('a compensator is a step to the run scope: its quota is drawn, and its attempts take the run budget', () => {
    // Breaks if: the compensator leaf is emitted outside the compiler's `emit` (no quota member, no
    // chain), so a quota used only by a compensator has no taker, or the permits miss its attempts.
    const refund = { id: 'refund', kind: 'limit', n: 1 } as const;
    const compiled = compile({ id: 'q', entries: [cs('a', {}, { quotas: [refund] }), step('z')] }, { concurrency: 1 });
    const site = siteOf(compiled);
    const pool = compiled.pools.find((p) => p.kind === 'limit' && p.quota === 'refund');
    expect(pool?.takers).toEqual(site.compensators[0]!.attempts);
    const permits = compiled.pools.find((p) => p.kind === 'permits');
    for (const a of site.compensators[0]!.attempts) expect(permits?.takers).toContain(a);
  });

  it('C2–C4 are handed to compile() as exclusions, and nothing else', () => {
    // Breaks if: C2 misses a level or includes `level.0`; C3 misses an entry input, a settle place or
    // a terminal; C4 pairs `wf.canceled` with anything but `failure` and `pending`.
    const compiled = compile(m2);
    const bare = compile(strip(m2));
    const ours = compiled.exclusions.slice(bare.exclusions.length);
    expect(compiled.exclusions.slice(0, bare.exclusions.length)).toEqual(bare.exclusions);
    const pairs = ours.map((e) => `${e.a} ~ ${e.b}`).sort();
    const c3 = [
      's.0.a.in', 's.1.x.in', 's.2.b.in', 's.3.z.in',
      'wf.settle.failed', 'wf.settle.bailed', 'wf.settle.suspended', 'wf.settle.paused', 'wf.settle.done',
      'wf.done', 'wf.failed', 'wf.bailed', 'wf.suspended', 'wf.paused', 'wf.canceled',
    ];
    expect(pairs).toEqual([
      'wf.comp.level.1 ~ wf.settle.failed',
      'wf.comp.level.2 ~ wf.settle.failed',
      ...c3.map((b) => `wf.comp.fault ~ ${b}`),
      'wf.canceled ~ wf.comp.failure',
      'wf.canceled ~ wf.comp.pending',
    ].sort());
  });
});

describe('the stack the level token carries', () => {
  /** Fires one transition's action against named input values; returns its outputs by place name. */
  async function fire(compiled: CompiledWorkflow, name: string, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    const t = transitionsOf(compiled).get(name)!;
    const out: Record<string, unknown> = {};
    const ctx = {
      input: (p: Place<unknown>) => {
        if (!(p.name in inputs)) throw new Error(`${name} read ${p.name}, not given`);
        return inputs[p.name];
      },
      output: (p: Place<unknown>, value: unknown) => {
        if (p.name in out) throw new Error(`${name} wrote ${p.name} twice`);
        out[p.name] = value;
      },
    };
    await (t.action as unknown as (c: typeof ctx) => Promise<void>)(ctx);
    return out;
  }

  it('arm pushes the output on top, start pops the top into the compensator and keeps the rest, settle hands it down', async () => {
    // Breaks if: `arm` pushes at the bottom or drops the forward token; `start` hands the compensator
    // the bottom of the stack, or `undoing` the whole stack; a settle reads its level instead of
    // `undoing`; `finish` settles anything but the held original failure.
    const compiled = compile(m2);
    const a = { data: { seat: '1A' } };
    const b = { data: { charge: 7 } };
    expect(await fire(compiled, 't.comp.1.arm', { 'wf.comp.1.arming': a, 'wf.comp.level.0': [] })).toEqual({ 's.1.x.in': a, 'wf.comp.level.1': [a.data] });
    expect(await fire(compiled, 't.comp.2.arm', { 'wf.comp.2.arming': b, 'wf.comp.level.1': [a.data] })).toEqual({ 's.3.z.in': b, 'wf.comp.level.2': [a.data, b.data] });
    const failure = { stepId: 'z', path: [3], error: new Error('boom') };
    expect(await fire(compiled, 't.comp.raise', { 'wf.comp.failure': failure })).toEqual({ 'wf.comp.fault': failure, 'wf.comp.pending': null });
    expect(await fire(compiled, 't.comp.2.start', { 'wf.comp.pending': null, 'wf.comp.level.2': [a.data, b.data] }))
      .toEqual({ 's.5.undo-b.in': { data: b.data }, 'wf.comp.2.undoing': [a.data] });
    expect(await fire(compiled, 't.comp.2.settle.failed', { 'wf.comp.2.failed': { stepId: 'undo-b', path: [2], error: 'x' }, 'wf.comp.2.undoing': [a.data] }))
      .toEqual({ 'wf.comp.level.1': [a.data], 'wf.comp.pending': null });
    expect(await fire(compiled, 't.comp.1.start', { 'wf.comp.pending': null, 'wf.comp.level.1': [a.data] }))
      .toEqual({ 's.4.undo-a.in': { data: a.data }, 'wf.comp.1.undoing': [] });
    expect(await fire(compiled, 't.comp.1.settle.done', { 'wf.comp.1.done': { data: undefined }, 'wf.comp.1.undoing': [] }))
      .toEqual({ 'wf.comp.level.0': [], 'wf.comp.pending': null });
    expect(await fire(compiled, 't.comp.finish', { 'wf.comp.pending': null, 'wf.comp.level.0': [], 'wf.comp.fault': failure })).toEqual({ 'wf.settle.failed': failure });
    const bail = { stepId: 'x', path: [1], output: 1 };
    expect(await fire(compiled, 't.comp.1.discharge.bailed', { 'wf.comp.exit.bailed': bail, 'wf.comp.level.1': [a.data] })).toEqual({ 'wf.settle.bailed': bail });
  });

  it('arm hands the successor the very token it took, and finish settles the very failure it held', async () => {
    // Breaks if: `arm` rebuilds the token as `{ data }` (every other FlowToken field — here
    // `iteration` — silently dropped on the way to the successor), or `finish` settles a copy of the
    // held failure instead of the original (the ADR's "original token"; `toEqual` cannot tell them
    // apart, `toBe` can).
    const compiled = compile(m2);
    const a: FlowToken = { data: { seat: '1A' }, iteration: 2 };
    const armed = await fire(compiled, 't.comp.1.arm', { 'wf.comp.1.arming': a, 'wf.comp.level.0': [] });
    expect(armed['s.1.x.in']).toBe(a);
    expect(armed['wf.comp.level.1']).toEqual([a.data]);
    const failure = { stepId: 'z', path: [3], error: new Error('boom') };
    const settled = await fire(compiled, 't.comp.finish', { 'wf.comp.pending': null, 'wf.comp.level.0': [], 'wf.comp.fault': failure });
    expect(settled['wf.settle.failed']).toBe(failure);
    const raised = await fire(compiled, 't.comp.raise', { 'wf.comp.failure': failure });
    expect(raised['wf.comp.fault']).toBe(failure);
  });
});

describe('every ladder place is 1-bounded, and the ladder adds no inhibitor, read or reset', () => {
  const fixtures: [string, WorkflowDescription][] = [
    ['m2', m2],
    ['m3 with retries and timeouts', {
      id: 'm3rt',
      entries: [cs('a', { retries: 1 }, { retries: 2 }), step('x', { timeoutMs: 50 }), cs('b', {}, { timeoutMs: 50, retries: 1 }), step('y'), cs('c'), step('z', { retries: 1 })],
    }],
  ];

  it.for(fixtures)('%s: by construction — one-token arcs; levels and undoing conserved; the control token conserved', ([, description]) => {
    // Breaks if: an `all()`, `atLeast()` or `exactly(n)` arc, a read or a reset lands on a ladder
    // place; one firing deposits twice into one; a transition makes a level token (`arm` skipping the
    // lower level, MUT6) or a control token (`raise` without `fault` accounted, a settle that keeps
    // the compensator's exit). Steps-only spines: every non-ladder transition moves one token.
    const compiled = compile(description);
    const site = siteOf(compiled);
    const isLadder = (name: string): boolean => name.startsWith('wf.comp.');
    for (const t of compiled.net.transitions) {
      for (const spec of t.inputSpecs) if (isLadder(spec.place.name)) expect(spec.type, `${t.name} <- ${spec.place.name}`).toBe('one');
      for (const arc of [...t.resets, ...t.reads, ...t.inhibitors]) expect(isLadder(arc.place.name), `${t.name}: arc on ${arc.place.name}`).toBe(false);
      if (t.outputSpec !== null) for (const branch of branches(t.outputSpec)) expect(new Set(branch).size, `${t.name} deposits twice`).toBe(branch.length);
    }
    // y·post <= y·pre on every branch of every transition, and y·M0 = 1, so every place in y is <= 1.
    const pools = new Set(compiled.pools.map((p) => p.place.name));
    const fixed = new Set([...pools, compiled.cancel.name, compiled.cancelRequest.name]);
    const stack = new Set([...site.levels, ...site.compensators.map((c) => c.undoing)]);
    const compensatorPlace = (name: string): boolean =>
      site.compensators.some((c) => name.startsWith(`s.${c.path[0]}.`) || Object.values(c.exits).includes(name));
    const all = [...compiled.net.places].map((p) => p.name);
    const control = new Set(all.filter((p) => !fixed.has(p) && !stack.has(p) && p !== site.fault));
    const held = new Set([...[...control].filter((p) => p !== site.pending && !compensatorPlace(p)), site.fault]);
    const seed = new Map<string, number>([[compiled.entryPlace.name, 1], [ladderLevel(site, 0).place, 1]]);
    for (const [label, y] of [['stack', stack], ['control', control], ['held failure', held]] as const) {
      expect([...seed].filter(([p]) => y.has(p)).reduce((s, [, k]) => s + k, 0), `${label}: y·M0`).toBe(1);
      for (const t of compiled.net.transitions) {
        const takes = t.inputSpecs.filter((s) => y.has(s.place.name)).length;
        for (const branch of t.outputSpec === null ? [[]] : branches(t.outputSpec)) {
          expect(branch.filter((p) => y.has(p)).length, `${label}: ${t.name} gives more than it takes`).toBeLessThanOrEqual(takes);
        }
      }
    }
    // Every ladder place is in one of them.
    for (const p of all.filter(isLadder)) expect(stack.has(p) || control.has(p) || held.has(p), p).toBe(true);
  });

  it('m2: placeBound(p, 1) proven for every wf.comp place and compensator place, closed and cancel', T, async () => {
    // Breaks if: the arcs argument above is wrong about the net the verifier sees. Proven, never
    // `!isViolated()`.
    const compiled = compile(m2);
    const places = [...compiled.net.places].filter((p) => p.name.startsWith('wf.comp.') || /^s\.[45]\./.test(p.name));
    expect(places.length).toBe(27);
    for (const cancel of [false, true]) {
      for (const p of places) {
        const r = await check(compiled, cancel, placeBound(p, 1));
        expect(r.verdict, `${p.name} ${cancel ? 'cancel' : 'closed'}`).toBe('proven');
      }
    }
  });

  it('no t.comp transition carries an inhibitor, a read or a reset; inhibited and read places are the bare spine’s', () => {
    // Breaks if: the ladder or a compensator leaf gates on `wf.cancel` (a compensator emitted with the
    // signal, S5) or on any place of its own — [VER-004] would split it, and a cancel would preempt a
    // rollback against maintainer decision 3 A.
    for (const description of [m2, ...fixtures.map(([, d]) => d)]) {
      const compiled = compile(description);
      const bare = compile(strip(description));
      for (const t of compiled.net.transitions) {
        if (t.name.startsWith('t.comp.')) expect([t.inhibitors.length, t.reads.length, t.resets.length], t.name).toEqual([0, 0, 0]);
      }
      const used = (c: CompiledWorkflow, arc: 'inhibitors' | 'reads') => [...new Set([...c.net.transitions].flatMap((t) => t[arc].map((a) => a.place.name)))].sort();
      expect(used(compiled, 'inhibitors')).toEqual(used(bare, 'inhibitors'));
      expect(used(compiled, 'reads')).toEqual(used(bare, 'reads'));
      expect(used(compiled, 'inhibitors')).toEqual(['wf.cancel']);
      // Each compensator transition: no arc on wf.cancel at all.
      const site = siteOf(compiled);
      const examined = [...compiled.net.transitions].filter((t) => site.compensators.some((c) => t.name.startsWith(`t.${c.path[0]}.`)));
      // Not vacuous: at least every compensator's attempts are examined.
      expect(examined.length, description.id).toBeGreaterThanOrEqual(site.compensators.flatMap((c) => c.attempts).length);
      expect(site.compensators.length, description.id).toBeGreaterThan(0);
      for (const t of examined) {
        const touched = [...t.inputSpecs.map((s) => s.place.name), ...outputsOf(t), ...t.inhibitors.map((a) => a.place.name), ...t.reads.map((a) => a.place.name)];
        expect(touched, t.name).not.toContain('wf.cancel');
      }
    }
  });
});

describe('VER-004 splits only t.cancel.arrive', () => {
  const shapes: [string, WorkflowDescription][] = [
    ['m1 [a*,x,z]', { id: 'm1', entries: [cs('a'), step('x'), step('z')] }],
    ['m2', m2],
    ['m2 beside foreach(2)', { id: 'm2f', entries: [cs('a'), foreach('items', step('item'), 2), cs('b'), step('z')] }],
    ['m2, checkpoint at 0 before k_1', { id: 'm2c', checkpoints: [0], entries: [step('w'), cs('a'), step('x'), cs('b'), step('z')] }],
  ];
  it.for(shapes)('%s', ([, description]) => {
    // Breaks if: any ladder or compensator transition outputs into a place another transition
    // inhibits or reads ([VER-004] would split it into start and completion).
    expect(inFlightTransitions(compile(description).net)).toEqual(['t.cancel.arrive']);
  });

  it('beside parallel(3): the gadget’s own splits, and only those, with and without compensation', () => {
    const description: WorkflowDescription = {
      id: 'cp',
      entries: [cs('a'), { kind: 'parallel', id: 'p', arms: [step('b1'), step('b2'), step('b3')] }, cs('c'), step('d')],
    };
    const split = inFlightTransitions(compile(description).net);
    expect(split).toEqual(inFlightTransitions(compile(strip(description)).net));
    expect(split).toEqual(['t.cancel.arrive', 't.1.p.collect-err', 't.1.p.collect-susp', 't.1.p.replay-0', 't.1.p.replay-1', 't.1.p.replay-2']);
  });
});

describe('intercept mode: every sweep feeds wf.comp.exit.canceled', () => {
  /** `[w, a*, each(2), b*, z]`, a checkpoint after `w` (before `k_1`): top-level, checkpoint and foreach sweeps. */
  const swept: WorkflowDescription = {
    id: 'swept',
    checkpoints: [0],
    entries: [step('w'), cs('a'), foreach('items', step('item', { retries: 1 }), 2), cs('b'), step('z')],
  };

  it('each transition that fed wf.canceled in the bare spine feeds wf.comp.exit.canceled instead, settle pairs excepted', () => {
    // Breaks if: the ladder hands the spine `wf.canceled` as its canceled exit (a sweep would end the
    // run with the level token stranded), or the checkpoint sweep is not handed the ladder's place.
    const compiled = compile(swept);
    const bare = compile(strip(swept));
    const into = (c: CompiledWorkflow, p: string) => [...c.net.transitions].filter((t) => outputsOf(t).includes(p)).map((t) => t.name).sort();
    const pairs = ['done', 'failed', 'bailed', 'suspended', 'paused'].map((k) => `t.settle.${k}.canceled`);
    const sweeps = into(bare, 'wf.canceled').filter((n) => !pairs.includes(n));
    // Not vacuous: top-level sweeps, the checkpoint's, and the foreach's own.
    expect(sweeps).toContain('t.0.w.cancel');
    expect(sweeps).toContain('t.4.z.cancel');
    expect(sweeps).toContain('t.0.checkpoint-cancel');
    expect(sweeps.filter((n) => n.startsWith('t.2.')).length).toBeGreaterThan(1);
    expect(into(compiled, 'wf.comp.exit.canceled')).toEqual(sweeps);
    // `wf.canceled` now has only the settle pairs and the discharges as producers.
    const discharges = [0, 1, 2].map((j) => `t.comp.${j}.discharge.canceled`);
    expect(into(compiled, 'wf.canceled')).toEqual([...pairs, ...discharges].sort());
    // And no ladder transition consumes, reads, inhibits or resets a terminal.
    const terminals = new Set(Object.values(compiled.terminals).map((p) => p.name));
    for (const t of compiled.net.transitions) {
      if (!t.name.startsWith('t.comp.')) continue;
      const touched = [...t.inputSpecs, ...t.reads, ...t.inhibitors, ...t.resets].map((a) => a.place.name);
      expect(touched.filter((p) => terminals.has(p)), t.name).toEqual([]);
    }
  });
});

/**
 * One libpetri query from the fresh-run marking — the entry, the pools, the request when `cancel` —
 * plus `ladderLevel(site, 0)` when there is a ladder, with `verify()`'s sinks (terminals, the signal,
 * the pools).
 */
async function check(compiled: CompiledWorkflow, cancel: boolean, property: SmtProperty) {
  const marking = new Map(initialCounts(compiled, compiled.entryPlace, cancel ? compiled.cancelRequest : undefined));
  if (compiled.compensations !== undefined) {
    const level = [...compiled.net.places].find((p) => p.name === ladderLevel(compiled.compensations!, 0).place)!;
    marking.set(level, 1);
  }
  const t = compiled.terminals;
  const result = await SmtVerifier.forNet(compiled.net)
    .initialMarking((m) => {
      for (const [p, k] of marking) m.tokens(p, k);
    })
    .sinkPlaces(t.done, t.failed, t.bailed, t.suspended, t.paused, t.canceled, compiled.cancel, ...poolSinks(compiled))
    .semiflowInvariants(true)
    .timeout(BUDGET_MS)
    .property(property)
    .verify();
  return { verdict: result.verdict.type, classes: Number(/State classes: (\d+)/.exec(result.report)?.[1] ?? NaN), route: result.route };
}

describe('state classes, closed / cancel, against the Amendment', () => {
  // The Amendment's table (W0, intercept mode; libpetri 8.0.0 from npm, not linked). Its places and
  // transitions were measured with six compensator exits, before amendment 3 removed the dead
  // `canceled` one: m fewer of each here, the same classes (the removed transition never fired).
  const chain = (m: number): WorkflowDescription => ({ id: `c${m}`, entries: [...'abcdefghijkl'.slice(0, m)].map((x) => cs(x)).concat([step('end')]) });
  const table: [string, WorkflowDescription, number | undefined, number, number][] = [
    ['m1 [a*,x,z]', { id: 'm1', entries: [cs('a'), step('x'), step('z')] }, undefined, 31, 96],
    ['m2 [a*,x,b*,z]', m2, undefined, 44, 136],
    ['m3 [a*,x,b*,y,c*,z]', { id: 'm3', entries: [cs('a'), step('x'), cs('b'), step('y'), cs('c'), step('z')] }, undefined, 58, 179],
    ['m2, retries 2 (immediate)', { id: 'm2r', entries: [cs('a', { retries: 2 }, { retries: 2 }), step('x', { retries: 2 }), cs('b', {}, { retries: 2 }), step('z', { retries: 2 })] }, undefined, 64, 196],
    ['m2 beside foreach(2)', { id: 'm2f', entries: [cs('a'), foreach('items', step('item'), 2), cs('b'), step('z')] }, undefined, 184, 556],
    ['m2, run budget 1', m2, 1, 44, 136],
    ['m2, timeoutMs 50 on b and on undo-a', { id: 'm2o', entries: [cs('a', {}, { timeoutMs: 50 }), step('x'), cs('b', { timeoutMs: 50 }), step('z')] }, undefined, 46, 142],
    ['m2, checkpoint at 0 before k_1', { id: 'm2c', checkpoints: [0], entries: [step('w'), cs('a'), step('x'), cs('b'), step('z')] }, undefined, 46, 142],
    ['none [a,b,c]', { id: 'c0', entries: [step('a'), step('b'), step('c')] }, undefined, 13, 40],
    ['m1 chain [a*,end]', chain(1), undefined, 30, 93],
    ['m2 chain', chain(2), undefined, 43, 133],
    ['m5 chain', chain(5), undefined, 82, 253],
    ['m12 chain', chain(12), undefined, 173, 533],
    ['[a*,parallel(3),c*,d]', { id: 'cp', entries: [cs('a'), { kind: 'parallel', id: 'p', arms: [step('b1'), step('b2'), step('b3')] }, cs('c'), step('d')] }, undefined, 595, 1789],
  ];

  it.for(table)('%s', T, async ([, description, k, closed, cancel]) => {
    // Breaks if: the ladder adds or loses a reachable state anywhere — an extra interleaving (a
    // discharge racing a settle), a lost level, a transition the W0 net did not have.
    const compiled = compile(description, k === undefined ? {} : { concurrency: k });
    const [c0, c1] = [await check(compiled, false, deadlockFree()), await check(compiled, true, deadlockFree())];
    expect([c0.verdict, c1.verdict]).toEqual(['proven', 'proven']);
    expect([c0.classes, c1.classes]).toEqual([closed, cancel]);
  });

  it('cost: the first compensator +17 / +53 classes, each later one +13 / +40', T, async () => {
    const classesOf = async (m: number) => {
      const compiled = compile({ id: `c${m}`, entries: [...'abcdefghijkl'.slice(0, m)].map((x) => cs(x)).concat([step('end')]) });
      return [(await check(compiled, false, deadlockFree())).classes, (await check(compiled, true, deadlockFree())).classes];
    };
    // The bare baseline is [a,b,c] (13 / 40): one compensated step plus its successor replaces it.
    const [one, two, three] = [await classesOf(1), await classesOf(2), await classesOf(3)];
    expect(one).toEqual([30, 93]);
    expect([two[0]! - one[0]!, two[1]! - one[1]!]).toEqual([13, 40]);
    expect([three[0]! - two[0]!, three[1]! - two[1]!]).toEqual([13, 40]);
  });
});

describe('ladderLevel: the one seed', () => {
  it('a = |{j : k_j < at}|, the place level.a, the stack the forward ids k_1..k_a bottom first', () => {
    // Breaks if: `<` becomes `<=` (a resume at k_j would seed k_j armed before it completed), the
    // stack is top first, or the place is not `levels[a]`.
    const site = siteOf(compile({ id: 'w', entries: [step('p'), cs('a'), step('x'), cs('b'), step('z')] }));
    const at = (i: number) => ladderLevel(site, i);
    expect([0, 1, 2, 3, 4, 5].map((i) => [at(i).level, at(i).place, at(i).stack])).toEqual([
      [0, 'wf.comp.level.0', []],
      [0, 'wf.comp.level.0', []],
      [1, 'wf.comp.level.1', ['a']],
      [1, 'wf.comp.level.1', ['a']],
      [2, 'wf.comp.level.2', ['a', 'b']],
      [2, 'wf.comp.level.2', ['a', 'b']],
    ]);
  });

  it('a restart at a marked checkpoint seeds level.0 — the formula gives it, since every checkpoint sits before k_1', () => {
    const compiled = compile({ id: 'w', checkpoints: [0, 1], entries: [step('p'), step('q'), cs('a'), step('z')] });
    // Not vacuous: both checkpoints survive compile.
    expect(compiled.checkpoints).toEqual([0, 1]);
    for (const c of compiled.checkpoints) expect(ladderLevel(siteOf(compiled), c + 1).level).toBe(0);
  });

  it('refuses an index that is not a whole number >= 0', () => {
    const site = siteOf(compile(m2));
    for (const bad of [-1, 0.5, Number.NaN]) expect(() => ladderLevel(site, bad)).toThrow(/at must be a top-level index/);
  });

  it('refuses a site whose levels do not number m + 1, or whose compensators do not number m', () => {
    // Breaks if: the site-shape guard is dropped — a level missing from `levels` would seed
    // `undefined` as the place, and a missing compensator would seed a level one too low.
    const site = siteOf(compile(m2));
    expect(() => ladderLevel({ ...site, levels: site.levels.slice(0, -1) }, 4)).toThrow(/the site has 2 levels and 2 compensators/);
    expect(() => ladderLevel({ ...site, compensators: site.compensators.slice(1) }, 4)).toThrow(/the site has 3 levels and 1 compensators/);
    expect(ladderLevel(site, 4).level).toBe(2);
  });
});

describe('the compiler refuses what the adapter would have', () => {
  const undo = step('undo');
  const keyed = step('x', { compensate: undo });
  const refused = (description: WorkflowDescription, code: string, what: RegExp) => {
    expect(() => compile(description)).toThrow(new RegExp(`\\(${code}\\)$`));
    expect(() => compile(description)).toThrow(what);
  };

  it('compensate-position: the key on an arm, a body, a stage, or on the last top-level entry', () => {
    // Breaks if: a key outside the top-level spine compiles as if it were not there, or the last
    // entry's compensator (which could never run, and fails liveness) compiles.
    refused({ id: 'arm', entries: [{ kind: 'parallel', id: 'p', arms: [keyed, step('y')] }, step('z')] }, 'compensate-position', /step 'x', arm 0 of the \.parallel\(\) at 0/);
    refused({ id: 'branch', entries: [{ kind: 'branch', id: 'b', arms: [step('y'), keyed] }, step('z')] }, 'compensate-position', /arm 1 of the \.branch\(\)/);
    refused({ id: 'loop', entries: [{ kind: 'loop', id: 'l', body: keyed, loopType: 'dountil', iterationBound: 2 }, step('z')] }, 'compensate-position', /the body of the loop/);
    refused({ id: 'foreach', entries: [foreach('f', keyed, 1), step('z')] }, 'compensate-position', /the body of the \.foreach\(\)/);
    refused(
      { id: 'stage', entries: [{ kind: 'foreach', id: 'f', body: step('f', { source: 'workflow' }), concurrency: 1, pipeline: { stages: [keyed], bounds: [1] } }, step('z')] },
      'compensate-position',
      /stage 0 of the pipeline/,
    );
    refused({ id: 'last', entries: [step('a'), keyed] }, 'compensate-position', /the last top-level entry/);
  });

  it('compensate-value: a compensator with its own compensate, one that is not a plain step, or the step itself', () => {
    refused({ id: 'w', entries: [step('a', { compensate: step('u', { compensate: step('v') }) }), step('z')] }, 'compensate-value', /carries its own compensate/);
    for (const source of ['workflow', 'agent', 'tool', 'mapping'] as const) {
      refused({ id: 'w', entries: [step('a', { compensate: step('u', { source }) }), step('z')] }, 'compensate-value', new RegExp(`is a ${source}, not a step`));
    }
    refused({ id: 'w', entries: [step('a', { compensate: step('a') }), step('z')] }, 'compensate-value', /its own compensator/);
    // A plain `source: 'step'` is a step.
    expect(() => compile({ id: 'w', entries: [step('a', { compensate: step('u', { source: 'step' }) }), step('z')] })).not.toThrow();
  });

  it('compensate-ids: a compensator id shared with the graph or another compensator, or a compensated step twice', () => {
    refused({ id: 'w', entries: [step('a', { compensate: step('z') }), step('z')] }, 'compensate-ids', /'z' of step 'a' shares its id with the graph/);
    refused({ id: 'w', entries: [step('a', { compensate: step('p') }), { kind: 'parallel', id: 'p', arms: [step('b1'), step('b2')] }, step('z')] }, 'compensate-ids', /shares its id/);
    refused({ id: 'w', entries: [step('a', { compensate: step('b1') }), { kind: 'parallel', id: 'p', arms: [step('b1'), step('b2')] }, step('z')] }, 'compensate-ids', /shares its id/);
    refused({ id: 'w', entries: [step('a', { compensate: step('u') }), step('b', { compensate: step('u') }), step('z')] }, 'compensate-ids', /'u' undoes two steps/);
    refused({ id: 'w', entries: [step('a', { compensate: step('u') }), step('a'), step('z')] }, 'compensate-ids', /'a' occurs twice/);
  });

  it('compensate-checkpoint: a checkpoint at or after k_1; one before it compiles', () => {
    const entries = [step('w'), cs('a'), step('x'), step('z')];
    refused({ id: 'w', checkpoints: [1], entries }, 'compensate-checkpoint', /after entry 1 is at or after the first compensated entry 1/);
    refused({ id: 'w', checkpoints: [2], entries }, 'compensate-checkpoint', /after entry 2/);
    refused({ id: 'w', checkpoints: [0, 2], entries }, 'compensate-checkpoint', /after entry 2/);
    expect(compile({ id: 'w', checkpoints: [0], entries }).checkpoints).toEqual([0]);
  });

  it('compensate-checkpoint with two compensated steps: judged against k_1, not k_m', () => {
    // Breaks if: checkpoints are compared with the last rung — `[w, a*, x, b*, z]` with a checkpoint
    // after `x` (between k_1 = 1 and k_2 = 3) would compile, and a restart from it would skip undo-a
    // (decision 4 A).
    const entries = [step('w'), cs('a'), step('x'), cs('b'), step('z')];
    refused({ id: 'w', checkpoints: [2], entries }, 'compensate-checkpoint', /after entry 2 is at or after the first compensated entry 1 \('a'\)/);
    refused({ id: 'w', checkpoints: [3], entries }, 'compensate-checkpoint', /after entry 3 is at or after the first compensated entry 1 \('a'\)/);
    expect(compile({ id: 'w', checkpoints: [0], entries }).checkpoints).toEqual([0]);
  });

  it('compensate-ids: a compensator named like a sleep, a sleepUntil, a branch, a loop or a .foreach()', () => {
    // Breaks if: a block id is left out of the graph ids. A sleep writes `stepResults[entry.id]`
    // (`handlers/entry.ts`), so a compensator sharing its id would overwrite that record
    // (latest-per-id); loop and foreach ids are refused alike, as every graph id is.
    const blocks: EntryDescription[] = [
      { kind: 'sleep', id: 's1', duration: { fixed: 10 } },
      { kind: 'sleepUntil', id: 's2', until: { fixed: 0 } },
      { kind: 'branch', id: 'br', arms: [step('b1'), step('b2')] },
      { kind: 'loop', id: 'l', body: step('lb'), loopType: 'dountil', iterationBound: 2 },
      foreach('f', step('fb'), 1),
    ];
    for (const block of blocks) {
      refused({ id: 'w', entries: [step('a', { compensate: step(block.id) }), block, step('z')] }, 'compensate-ids', new RegExp(`'${block.id}' of step 'a' shares its id with the graph`));
      // The same block with a distinct compensator id compiles.
      expect(() => compile({ id: 'w', entries: [step('a', { compensate: step('u') }), block, step('z')] }), block.kind).not.toThrow();
    }
  });

  it('compensate-ids: a compensated step whose id recurs anywhere in the graph — an arm, a loop or foreach body, a stage', () => {
    // Breaks if: the "occurs twice" check looks only at top-level entries. Each recurrence is a
    // distinct object with the compensated step's id and no key of its own.
    const recurrences: EntryDescription[] = [
      { kind: 'parallel', id: 'p', arms: [step('a'), step('b2')] },
      { kind: 'branch', id: 'br', arms: [step('b1'), step('a')] },
      { kind: 'loop', id: 'l', body: step('a'), loopType: 'dountil', iterationBound: 2 },
      foreach('f', step('a'), 1),
      { kind: 'foreach', id: 'f', body: step('f', { source: 'workflow' }), concurrency: 1, pipeline: { stages: [step('a')], bounds: [1] } },
    ];
    for (const block of recurrences) {
      refused({ id: 'w', entries: [cs('a'), block, step('z')] }, 'compensate-ids', /compensated step 'a' occurs twice/);
    }
  });

  it('compensate-position: one keyed object at top level and again as an arm is refused at the arm', () => {
    // Breaks if: position is judged by object identity (`entries.indexOf(step)`): the arm occurrence
    // then resolves to the top-level index, no position refusal fires, and the description is
    // refused only later as compensate-ids, under the wrong code.
    refused(
      { id: 'w', entries: [keyed, step('y'), { kind: 'parallel', id: 'p', arms: [step('b1'), keyed] }, step('z')] },
      'compensate-position',
      /step 'x', arm 1 of the \.parallel\(\) at 2/,
    );
    refused(
      { id: 'w', entries: [keyed, { kind: 'loop', id: 'l', body: keyed, loopType: 'dountil', iterationBound: 2 }, step('z')] },
      'compensate-position',
      /step 'x', the body of the loop at 1/,
    );
  });
});

describe('the ladder’s wiring invariants', () => {
  /** `compensateLadder` alone, on stand-in places, so `compile()`'s own call order cannot hide a guard. */
  function ladderOf(description: WorkflowDescription): Ladder {
    const settles: Exits = { failed: place('wf.settle.failed'), bailed: place('wf.settle.bailed'), suspended: place('wf.settle.suspended'), paused: place('wf.settle.paused'), canceled: place('wf.canceled') };
    const terminals: Terminals = { ...settles, done: place('wf.done'), failed: place('wf.failed'), bailed: place('wf.bailed'), suspended: place('wf.suspended'), paused: place('wf.paused') };
    return compensateLadder({
      description,
      checkpoints: [],
      names: new NameVocabulary(),
      settles,
      settleDone: place('wf.settle.done'),
      terminals,
      cancel: place('wf.cancel'),
      transition: () => {},
      place: () => {},
    });
  }
  const fin = { entryInputs: [], emit: () => ({ inPlace: place<FlowToken>('u.in'), attempts: [] }) };
  const description: WorkflowDescription = { id: 'g', entries: [cs('a'), step('z')] };

  it('finish refuses a compensated entry that was never armed', () => {
    // Breaks if: `finish` builds a site for a rung whose `arming` / `arm` were never emitted (the
    // site would name a transition the net does not have).
    expect(() => ladderOf(description).finish(fin)).toThrow(/entry 0 was never armed/);
  });

  it('armAt refuses an entry armed twice; finish refuses a second call; an uncompensated entry passes through', () => {
    const ladder = ladderOf(description);
    const successor = place<FlowToken>('s.1.z.in');
    expect(ladder.armAt(1, successor)).toBe(successor);
    const arming = ladder.armAt(0, successor);
    expect(arming.name).toBe('wf.comp.1.arming');
    expect(() => ladder.armAt(0, successor)).toThrow(/entry 0 armed twice/);
    expect(ladder.finish(fin).site.compensators.map((c) => c.arm)).toEqual(['t.comp.1.arm']);
    expect(() => ladder.finish(fin)).toThrow(/finish called twice/);
  });
});

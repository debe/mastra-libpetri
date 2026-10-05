import { describe, expect, it } from 'vitest';
import type { Out, Place, Transition } from 'libpetri';
import { SmtVerifier, deadlockFree, placeBound, type SmtProperty, type SmtVerificationResult } from 'libpetri/verification';
import {
  compile,
  pipelineGadget,
  type CompiledWorkflow,
  type EntryDescription,
  type PipelineSite,
  type StepDescription,
  type WorkflowDescription,
} from '../../src/compiler/index.js';
import { flatLane, stageOfLane } from '../../src/compiler/blueprints/pipeline.js';
import { segmentInitialMarking, type Segment } from '../../src/verify/index.js';
import { netDigest, unannotatedShapes } from '../fixtures/unannotated-shapes.js';

/**
 * `pipelineGadget` and the extraction it rests on ([ADR 0015], amended by the W0 spike), from the
 * compiled net alone — no step runs here (`tests/engine/pipeline.test.ts` runs them, W2).
 *
 * What it pins: the names and shape of the net the ADR draws, three settle variants per kind; lane
 * bodies named at `[i, L]` with `L` flattened stage-major; the `PipelineSite` declaring exactly the
 * transitions the gadget emitted; a one-stage pipeline as the foreach net minus the exit pair, the
 * resume path and the dead settles, plus the drops and the `¬cancel` gates; `structuralHash` moving
 * with the bounds and the stages; `foreach-frame.ts` leaving every foreach net byte-identical; every
 * pipeline place 1-bounded (from the arcs, and proven); and `wf.cancel` the only inhibited place.
 *
 * Proofs are judged by verdict string, never by `isViolated()` — `unknown` fails. libpetri 8.0.0
 * from npm, not linked; class counts are that release's.
 */

const BUDGET_MS = 30_000;
const T = { timeout: 60_000 } as const;

const step = (id: string, extra: Partial<StepDescription> = {}): StepDescription => ({ kind: 'step', id, ...extra });
const sum = (bounds: readonly number[]): number => bounds.reduce((a, b) => a + b, 0);

/** `[pipeline 'per-doc' over stages s0..s{n-1}, step 'report']` — the W0 spike's workflow. */
function piped(bounds: readonly number[], stages: readonly StepDescription[] = bounds.map((_, j) => step(`s${j}`))): WorkflowDescription {
  return {
    id: 'ingest',
    entries: [
      { kind: 'foreach', id: 'per-doc', body: step('per-doc', { source: 'workflow' }), concurrency: sum(bounds), pipeline: { stages, bounds } },
      step('report'),
    ],
  };
}

const siteOf = (compiled: CompiledWorkflow): PipelineSite => {
  expect(compiled.pipelines).toHaveLength(1);
  return compiled.pipelines[0]!;
};

const placeNames = (compiled: CompiledWorkflow): Set<string> => new Set([...compiled.net.places].map((p) => p.name));
const transitionNames = (compiled: CompiledWorkflow): Set<string> => new Set([...compiled.net.transitions].map((t) => t.name));

/** Every transition the site declares, in declaration order. */
function declared(site: PipelineSite): string[] {
  const out: string[] = [];
  if (site.cancelSweep !== undefined) out.push(site.cancelSweep);
  out.push(site.split);
  for (const lane of site.lanes) {
    if (lane.start !== undefined) out.push(lane.start);
    if (lane.refuse !== undefined) out.push(lane.refuse);
    out.push(...lane.handoffs);
    if (lane.collect !== undefined) out.push(lane.collect);
    out.push(lane.settles.bail, lane.settles.pause, ...lane.settles.fail, ...lane.settles.suspend);
    if (lane.drops !== undefined) out.push(...Object.values(lane.drops));
  }
  out.push(...site.finishers);
  return out;
}

/** The transitions the pipeline gadget itself emitted: the entry's, minus its lane bodies' (at `[0, L]`). */
function gadgetTransitions(compiled: CompiledWorkflow, path: readonly number[] = [0]): string[] {
  return [...compiled.netMap.transitionToEntry].filter(([, e]) => e.path.join('.') === path.join('.')).map(([name]) => name);
}

describe('pipelineGadget: shape and names', () => {
  it('emits exactly the ADR net for (1, 2), three settle variants per kind', () => {
    // Breaks if: a transition is added, renamed or dropped — the open-queue `.again` settle revived,
    // a hand-off missing, a drop left out.
    const compiled = compile(piped([1, 2]));
    const t = (role: string): string => `t.0.per-doc.${role}`;
    const lane = (j: number, l: number, last: boolean, handoffs: number): string[] => {
      const r = `stage${j}.lane${l}`;
      return [
        ...(j === 0 ? [t(`${r}.start`), t(`${r}.refuse`)] : []),
        ...Array.from({ length: handoffs }, (_, m) => t(`${r}.to${m}`)),
        ...(last ? [t(`${r}.collect`)] : []),
        t(`${r}.bail`),
        t(`${r}.pause`),
        t(`${r}.fail`),
        t(`${r}.fail.queue-closed`),
        t(`${r}.fail.queue-closed.again`),
        t(`${r}.suspend`),
        t(`${r}.suspend.queue-closed`),
        t(`${r}.suspend.queue-closed.again`),
        ...['done', 'failed', 'bailed', 'suspended', 'paused'].map((k) => t(`${r}.drop.${k}`)),
      ];
    };
    const expected = [
      t('cancel'),
      t('split'),
      ...lane(0, 0, false, 2),
      ...lane(1, 0, true, 0),
      ...lane(1, 1, true, 0),
      t('join'),
      t('fail.clean'),
      t('fail.s'),
      t('suspend'),
      t('canceled.clean'),
      t('canceled.s'),
      t('canceled.f'),
      t('canceled.fs'),
    ];
    expect(gadgetTransitions(compiled).sort()).toEqual([...expected].sort());
    expect(declared(siteOf(compiled))).toEqual(expected);
  });

  it('declares a site whose every name is in the net, stage-major, with the bounds and the stage ids', () => {
    const compiled = compile(piped([2, 1, 1]));
    const site = siteOf(compiled);
    const places = placeNames(compiled);
    const transitions = transitionNames(compiled);
    expect(site.path).toEqual([0]);
    expect(site.foreachId).toBe('per-doc');
    expect(site.bodyId).toBe('per-doc');
    expect(site.stages).toEqual(['s0', 's1', 's2']);
    expect(site.bounds).toEqual([2, 1, 1]);
    for (const p of [site.frame, site.queueOpen, site.queueClosed, site.fault, site.noFault, site.susp, site.noSusp]) expect(places, p).toContain(p);
    for (const name of declared(site)) expect(transitions, name).toContain(name);
    expect(site.lanes.map((l) => [l.stage, l.lane, l.flat])).toEqual([
      [0, 0, 0],
      [0, 1, 1],
      [1, 0, 2],
      [2, 0, 3],
    ]);
    for (const l of site.lanes) {
      for (const p of [l.permit, l.slot, l.body, l.done, ...Object.values(l.exits)]) expect(places, p).toContain(p);
      expect(l.start === undefined).toBe(l.stage !== 0);
      expect(l.refuse === undefined).toBe(l.stage !== 0);
      expect(l.collect === undefined).toBe(l.stage !== 2);
      expect(l.handoffs).toHaveLength(l.stage === 2 ? 0 : site.bounds[l.stage + 1]!);
      expect(l.drops).toBeDefined();
    }
    expect(site.finishers).toEqual(['join', 'fail.clean', 'fail.s', 'suspend', 'canceled.clean', 'canceled.s', 'canceled.f', 'canceled.fs'].map((r) => `t.0.per-doc.${r}`));
    // `handoffs[m]` feeds lane `Σ_{i≤j} c_i + m`: its outputs are that lane's body and slot.
    for (const l of site.lanes) {
      l.handoffs.forEach((name, m) => {
        const target = site.lanes[flatLane(site.bounds, l.stage + 1, m)]!;
        const out = outPlaces(transitionNamed(compiled, name).outputSpec!);
        expect(out.sort()).toEqual([target.body, target.slot, l.permit].sort());
      });
    }
  });

  it('registers no resume site, no bound claim, and the exclusions the ADR claims', () => {
    // A resume at a pipeline is refused by name (`pipeline`); nothing may make it resumable here.
    const compiled = compile(piped([2, 1]));
    const site = siteOf(compiled);
    expect([...compiled.resumeSites.keys()]).not.toContain('0');
    expect([...compiled.claims.keys()].filter((p) => p.startsWith('s.0.per-doc.'))).toEqual([]);
    const pairs = compiled.exclusions.filter((e) => e.a.startsWith('s.0.per-doc.')).map((e) => [e.a, e.b]);
    expect(pairs).toEqual([
      [site.queueOpen, site.queueClosed],
      [site.queueOpen, site.fault],
      [site.queueOpen, site.susp],
      [site.noFault, site.fault],
      [site.noSusp, site.susp],
      ...site.lanes.map((l) => [l.permit, l.slot]),
    ]);
  });

  it('flattens lanes stage-major and back', () => {
    const bounds = [2, 3, 1];
    const pairs: [number, number][] = [];
    for (let j = 0; j < bounds.length; j++) for (let l = 0; l < bounds[j]!; l++) pairs.push([j, l]);
    expect(pairs.map(([j, l]) => flatLane(bounds, j, l))).toEqual([0, 1, 2, 3, 4, 5]);
    expect([0, 1, 2, 3, 4, 5].map((L) => stageOfLane(bounds, L))).toEqual([0, 0, 1, 1, 1, 2]);
    expect(() => stageOfLane(bounds, 6)).toThrow(/outside a pipeline of 6 lane/);
  });
});

describe('pipelineGadget: lane bodies at [i, L]', () => {
  it('names each stage lane body at [i, L], one step chain per lane, its in-place the lane body', () => {
    // Breaks if: lanes are named per stage ([i, j, l] — fails suspension coverage), not flattened, or
    // a stage's body is emitted at the foreach's own path.
    const compiled = compile(piped([1, 2]));
    const site = siteOf(compiled);
    const chains = compiled.steps.filter((c) => c.path[0] === 0 && c.path.length === 2);
    expect(chains.map((c) => [c.stepId, [...c.path]])).toEqual([
      ['s0', [0, 0]],
      ['s1', [0, 1]],
      ['s1', [0, 2]],
    ]);
    for (const l of site.lanes) {
      const stageId = site.stages[l.stage]!;
      expect(l.body).toBe(`s.0-${l.flat}.${stageId}.in`);
      expect(chains.find((c) => c.path[1] === l.flat)!.inPlace).toBe(l.body);
      // Every transition at [0, L] is the lane body's: the stage's leaf, nothing else.
      const atLane = [...compiled.netMap.transitionToEntry].filter(([, e]) => e.path.join('.') === `0.${l.flat}`);
      expect(atLane.length).toBeGreaterThan(0);
      for (const [, e] of atLane) expect(e.id).toBe(stageId);
    }
    // The run step, after the pipeline, is still entry 1.
    expect(compiled.steps.find((c) => c.stepId === 'report')!.path).toEqual([1]);
  });

  it('gives the lane body its exits and nothing of the context: a stage outcome lands on its own lane', () => {
    const compiled = compile(piped([1, 1]));
    const site = siteOf(compiled);
    for (const l of site.lanes) {
      const producers = (place: string): string[] =>
        [...compiled.net.transitions].filter((t) => t.outputSpec !== null && outPlaces(t.outputSpec).includes(place)).map((t) => t.name);
      // Only the stage's leaf produces into the lane's done and exits.
      for (const p of [l.done, l.exits.failed, l.exits.bailed, l.exits.suspended, l.exits.paused]) {
        const from = producers(p);
        expect(from.length, p).toBeGreaterThan(0);
        for (const name of from) expect(compiled.netMap.transitionToEntry.get(name)!.path, `${name} -> ${p}`).toEqual([0, l.flat]);
      }
      // The canceled exit: the body is emitted without the signal, so nothing produces it.
      expect(producers(l.exits.canceled)).toEqual([]);
      // The body has no producer but `start` (stage 0) or the previous stage's hand-offs.
      const expectedProducers =
        l.stage === 0 ? [l.start!] : site.lanes.filter((x) => x.stage === l.stage - 1).map((x) => x.handoffs[l.lane]!);
      expect(producers(l.body).sort()).toEqual(expectedProducers.sort());
    }
  });
});

describe('a one-stage pipeline is the foreach net minus the exit pair', () => {
  // The differential fixture ([ADR 0015], Net): the same body as a foreach of W lanes and as a
  // pipeline of one stage, c_0 = W. The leaf subnets are identical; the gadget is the foreach's, with
  // the exit pair, the resume path and the open-queue `.again` settles gone, a `drop` per lane exit
  // added, `bail` / `pause` as single item-success settles, and `wf.cancel` gating every collect and
  // settle. Anything else that differs fails here.
  const W = 2;
  const body = step('b', { retries: 1 });
  const foreachWf: WorkflowDescription = { id: 'w', entries: [{ kind: 'foreach', id: 'items', body, concurrency: W }] };
  const pipelineWf: WorkflowDescription = {
    id: 'w',
    entries: [{ kind: 'foreach', id: 'items', body: step('items-body', { source: 'workflow' }), concurrency: W, pipeline: { stages: [body], bounds: [W] } }],
  };
  const fe = compile(foreachWf);
  const pl = compile(pipelineWf);
  const rename = (name: string): string => name.replace('.items.stage0.lane', '.items.lane');
  const EXIT = new Set(['s.0.items.exit', 's.0.items.no-exit']);

  it('has the foreach places, renamed, minus the exit pair and the resume place', () => {
    // Plus each lane's unreachable `canceled` exit, which the pipeline keeps in the net because its
    // site names it; the foreach's is dropped, no arc referencing it.
    const site = siteOf(pl);
    const canceledExits = new Set(site.lanes.map((l) => l.exits.canceled));
    expect([...canceledExits].every((p) => placeNames(pl).has(p))).toBe(true);
    const fromPipeline = [...placeNames(pl)].filter((p) => !canceledExits.has(p)).map(rename).sort();
    const fromForeach = [...placeNames(fe)].filter((p) => !EXIT.has(p) && p !== 's.0.items.resume').sort();
    expect(fromPipeline).toEqual(fromForeach);
  });

  it('has the same leaf subnets, arc for arc', () => {
    const leaf = (c: CompiledWorkflow): Record<string, unknown> =>
      Object.fromEntries(
        [...c.net.transitions]
          .filter((t) => (c.netMap.transitionToEntry.get(t.name)?.path.length ?? 0) === 2)
          .map((t) => [t.name, shape(t, rename, new Set())]),
      );
    expect(Object.keys(leaf(fe)).length).toBeGreaterThan(0);
    expect(leaf(pl)).toEqual(leaf(fe));
  });

  it('maps every other transition onto the foreach, the differences named', () => {
    const t = (role: string): string => `t.0.items.${role}`;
    // pipeline name -> foreach name, and whether the pipeline adds the `¬cancel` gate.
    const pairs: [string, string, boolean][] = [
      [t('cancel'), t('cancel'), false],
      [t('split'), t('split'), false],
      [t('join'), t('join'), false],
      [t('fail.clean'), t('fail.f'), false],
      [t('fail.s'), t('fail.fs'), false],
      [t('suspend'), t('suspend'), false],
      ...['clean', 'f', 's', 'fs'].map((x): [string, string, boolean] => [t(`canceled.${x}`), t(`canceled.${x}`), false]),
    ];
    const pipelineOnly: string[] = [];
    const foreachOnly: string[] = [t('re-enter'), t('re-enter.cancel'), t('exit.e'), t('exit.es'), t('fail.fe'), t('fail.fes'), ...['e', 'fe', 'es', 'fes'].map((x) => t(`canceled.${x}`))];
    for (let l = 0; l < W; l++) {
      const p = (r: string): string => t(`stage0.lane${l}.${r}`);
      const f = (r: string): string => t(`lane${l}.${r}`);
      pairs.push([p('start'), f('start'), false], [p('refuse'), f('refuse'), false], [p('collect'), f('collect'), true]);
      for (const kind of ['fail', 'suspend']) {
        for (const v of ['', '.queue-closed', '.queue-closed.again']) pairs.push([p(`${kind}${v}`), f(`${kind}${v}`), true]);
        foreachOnly.push(f(`${kind}.again`));
      }
      for (const kind of ['bail', 'pause']) {
        pipelineOnly.push(p(kind));
        for (const v of ['', '.again', '.queue-closed', '.queue-closed.again']) foreachOnly.push(f(`${kind}${v}`));
      }
      for (const k of ['done', 'failed', 'bailed', 'suspended', 'paused']) pipelineOnly.push(p(`drop.${k}`));
    }

    const gadgetOf = (c: CompiledWorkflow): string[] => gadgetTransitions(c);
    expect(gadgetOf(pl).sort()).toEqual([...pairs.map(([a]) => a), ...pipelineOnly].sort());
    expect(gadgetOf(fe).sort()).toEqual([...pairs.map(([, b]) => b), ...foreachOnly].sort());

    for (const [a, b, gated] of pairs) {
      const ta = transitionNamed(pl, a);
      const tb = transitionNamed(fe, b);
      expect(ta.inhibitors.map((i) => i.place.name), a).toEqual([...tb.inhibitors.map((i) => i.place.name), ...(gated ? ['wf.cancel'] : [])]);
      expect(shape(ta, rename, new Set(), true), a).toEqual(shape(tb, (n) => n, EXIT, true));
    }
  });

  it('enumerates the classes of the W0 amendment, and the foreach its own, unchanged', T, async () => {
    // Classes depend on Σc_j alone and run a little under a foreach of Σc_j lanes (no exit pair). The
    // pipeline's are the amendment's table (libpetri 8.0.0); the foreach's are `foreach.ts` before
    // the extraction, measured on both sides of it.
    const classes = async (c: CompiledWorkflow, segment: Segment): Promise<number> => {
      const r = await check(c, deadlockFree(), segment);
      expect(r.verdict.type, verdict(r)).toBe('proven');
      expect(r.route).toBe('enumeration');
      return Number(/State classes: (\d+)/.exec(r.report)![1]);
    };
    const step2 = (b: readonly number[]) => compile(piped(b));
    expect([await classes(step2([1, 1]), 'closed'), await classes(step2([1, 1]), 'cancel')]).toEqual([137, 412]);
    expect([await classes(step2([2, 1]), 'closed'), await classes(step2([2, 1]), 'cancel')]).toEqual([971, 2914]);
    expect([await classes(step2([1, 1, 1]), 'closed'), await classes(step2([1, 1, 1]), 'cancel')]).toEqual([971, 2914]);
    const foreach = (c: number) => compile({ id: 'w', entries: [{ kind: 'foreach', id: 'items', body: step('body'), concurrency: c }] });
    expect([await classes(foreach(1), 'closed'), await classes(foreach(1), 'cancel')]).toEqual([28, 85]);
    expect([await classes(foreach(2), 'closed'), await classes(foreach(2), 'cancel')]).toEqual([151, 454]);
    expect([await classes(foreach(3), 'closed'), await classes(foreach(3), 'cancel')]).toEqual([1136, 3409]);
  });
});

describe('structuralHash', () => {
  it('moves with the bounds and the stages, and is stable for one description', () => {
    const a = compile(piped([2, 1]));
    expect(compile(piped([2, 1])).structuralHash).toBe(a.structuralHash);
    expect(compile(piped([1, 2])).structuralHash).not.toBe(a.structuralHash);
    expect(compile(piped([2, 2])).structuralHash).not.toBe(a.structuralHash);
    expect(compile(piped([2, 1], [step('s0'), step('s1', { retries: 1 })])).structuralHash).not.toBe(a.structuralHash);
    expect(compile(piped([2, 1], [step('s0'), step('other')])).structuralHash).not.toBe(a.structuralHash);
    // The same net with the pipeline marker gone is a foreach of three lanes: a different hash.
    const { pipeline: _p, ...plain } = piped([2, 1]).entries[0] as Extract<EntryDescription, { kind: 'foreach' }>;
    expect(compile({ ...piped([2, 1]), entries: [plain, step('report')] }).structuralHash).not.toBe(a.structuralHash);
  });

  it('is unchanged without a pipeline (the contract table)', () => {
    // The same rows `pipeline-contract.test.ts` pins, computed before the contract landed.
    expect(unannotatedShapes().map((s) => [s.label, s.compiled.structuralHash, netDigest(s.compiled)])).toEqual([
      ['foreach, three lanes', '4d2fb6c330243db7', 'de496606abe2d07e'],
      ['foreach, three lanes, run budget 2', '9aea7db62b475e38', '1263cec672b28466'],
      ['foreach, retries, timeout, limit and rateLimit', '3900f1b2c4ed4e9b', '70d9e57d2e571438'],
      ['foreach over a nested workflow', 'e688d65db3833ee8', '7345e8f39ebf7c92'],
      ['every entry kind, checkpointed', '999c0e8f3c54713c', '5412d7a17bc75a3c'],
      ['init(): .foreach(step) then .foreach(nestedWorkflow)', 'b860cdef99196dc1', '8d45355fa24e6af6'],
    ]);
  });
});

describe('foreach-frame.ts leaves the foreach byte-identical', () => {
  // `structuralHash`, the name-and-arc digest, and the place / transition counts of foreach nets,
  // recorded from `foreach.ts` before the extraction (libpetri 8.0.0 from npm). The transition and
  // place *order* was also compared, against the pre-extraction gadget, in the W1 A session.
  const fe = (c: number, body: StepDescription = step('body')): EntryDescription => ({ kind: 'foreach', id: 'items', body, concurrency: c });
  const rows: [string, CompiledWorkflow, string][] = [
    ['c=1', compile({ id: 'b', entries: [fe(1)] }), '6358b01595f7a1dc 00ee1371af3d4ac7 32/51'],
    ['c=2', compile({ id: 'b', entries: [fe(2)] }), 'f3d450ce179cd931 afcfb5c7f8a94596 40/71'],
    ['c=3', compile({ id: 'b', entries: [fe(3)] }), '421cf7a4f05e8e07 559bd6e5cc44d713 48/91'],
    ['c=5', compile({ id: 'b', entries: [fe(5)] }), '0098a518f31724e5 f907c7e5f0ad7e02 64/131'],
    ['mid-workflow', compile({ id: 'b', entries: [step('before'), fe(2), step('after')] }), '8c0df5c14af33f59 46bac97bfecf7a38 42/75'],
    ['run budget 1', compile({ id: 'b', entries: [fe(2)] }, { concurrency: 1 }), '9bcc4f919d1fa417 c53b10c4d5c8d3cd 41/71'],
    ['retrying body', compile({ id: 'b', entries: [fe(2, step('body', { retries: 1, retryDelayMs: 10 }))] }), 'd3b5e2e055f20113 12ac75408a1949c0 44/75'],
    ['nested body', compile({ id: 'b', entries: [fe(2, step('body', { source: 'workflow' }))] }), '07e2436872e24701 afcfb5c7f8a94596 40/71'],
    ['checkpointed', compile({ id: 'b', entries: [step('a'), fe(2), step('c')], checkpoints: [0, 1] }), '0ec475891331ec42 ae38bc09724b55f4 44/79'],
  ];
  it.for(rows)('%s', ([, compiled, expected]) => {
    expect(`${compiled.structuralHash} ${netDigest(compiled)} ${compiled.net.places.size}/${compiled.net.transitions.size}`).toBe(expected);
    expect(compiled.pipelines).toEqual([]);
  });
});

describe('every pipeline place is 1-bounded, and only wf.cancel is inhibited', () => {
  const fixtures: [string, CompiledWorkflow][] = [
    ['(1,1)', compile(piped([1, 1]))],
    ['(2,1)', compile(piped([2, 1]))],
    ['(1,2,1)', compile(piped([1, 2, 1]))],
  ];

  it.for(fixtures)('%s: by construction — every arc takes or gives one token, every and lists a place once', ([, compiled]) => {
    // Breaks if: an `all()`, `atLeast()` or `exactly(n)` arc, a reset or a read lands on a pipeline
    // place, or one firing deposits twice into one.
    const site = siteOf(compiled);
    const ours = (name: string): boolean => name.startsWith('s.0.per-doc.') || site.lanes.some((l) => l.body === name);
    for (const t of compiled.net.transitions) {
      for (const spec of t.inputSpecs) if (ours(spec.place.name)) expect(spec.type, `${t.name} <- ${spec.place.name}`).toBe('one');
      for (const arc of [...t.resets, ...t.reads]) expect(ours(arc.place.name), `${t.name}: reset/read on ${arc.place.name}`).toBe(false);
      if (t.outputSpec !== null) for (const branch of branches(t.outputSpec)) expect(new Set(branch).size, `${t.name} deposits twice`).toBe(branch.length);
    }
    // Conservation from the arcs: per lane `permit + slot`, the queue pair, the frame and each flag
    // pair are moved, never made, by every transition but `split` (which gives one of each on its
    // opening branches, once — the entry's input is 1-bounded) and the finishers (which take them).
    const conserved: [string, readonly string[]][] = [
      ...site.lanes.map((l): [string, readonly string[]] => [`lane ${l.flat}`, [l.permit, l.slot]]),
      ['queue', [site.queueOpen, site.queueClosed]],
      ['frame', [site.frame]],
      ['fault', [site.fault, site.noFault]],
      ['susp', [site.susp, site.noSusp]],
    ];
    const opening = new Set([site.split, ...site.finishers]);
    for (const t of compiled.net.transitions) {
      const taken = t.inputSpecs.map((x) => x.place.name);
      for (const branch of t.outputSpec === null ? [[]] : branches(t.outputSpec)) {
        for (const [label, set] of conserved) {
          const gives = branch.filter((p) => set.includes(p)).length;
          const takes = taken.filter((p) => set.includes(p)).length;
          if (opening.has(t.name)) {
            expect(gives, `${t.name} gives ${label}`).toBeLessThanOrEqual(1);
            expect(takes, `${t.name} takes ${label}`).toBe(t.name === site.split ? 0 : 1);
          } else if (gives > 0 && takes > 0) {
            expect(gives, `${t.name} on ${label}`).toBe(takes);
          } else if (branch.length > 0) {
            expect([gives, takes], `${t.name} on ${label}`).toEqual([0, 0]);
          }
        }
      }
    }
  });

  it.for(fixtures)('%s: the only inhibited place in the net is wf.cancel; reads are on wf.cancel alone', ([, compiled]) => {
    // Breaks if: an inhibitor on `fault`, `susp` or the queue is added anywhere ([VER-004]: it would
    // split the settles that raise them), or a gadget reads a flag.
    for (const t of compiled.net.transitions) {
      for (const arc of t.inhibitors) expect(arc.place.name, t.name).toBe('wf.cancel');
      if (gadgetTransitions(compiled).includes(t.name)) for (const arc of t.reads) expect(arc.place.name, t.name).toBe('wf.cancel');
      expect(t.resets, t.name).toEqual([]);
    }
  });

  it.for<[string, readonly number[], Segment]>([
    ['(1,1)', [1, 1], 'closed'],
    ['(1,1)', [1, 1], 'cancel'],
    ['(2,1)', [2, 1], 'closed'],
    ['(2,1)', [2, 1], 'cancel'],
  ])('%s (bounds %s), %s segment: placeBound(·, 1) is proven on every pipeline place', T, async ([, bounds, segment]) => {
    const compiled = compile(piped(bounds));
    const site = siteOf(compiled);
    const pipelinePlaces = [...compiled.net.places].filter((p) => p.name.startsWith('s.0.per-doc.') || site.lanes.some((l) => l.body === p.name));
    expect(pipelinePlaces.length).toBeGreaterThan(10);
    for (const p of pipelinePlaces) {
      const r = await check(compiled, placeBound(p, 1), segment);
      expect(r.verdict.type, `${p.name}: ${verdict(r)}`).toBe('proven');
    }
  });
});

describe('refused descriptions', () => {
  const entry = (pipeline: unknown, concurrency: number): EntryDescription =>
    ({ kind: 'foreach', id: 'per-doc', body: step('per-doc', { source: 'workflow' }), concurrency, pipeline }) as EntryDescription;
  const build = (e: EntryDescription) => () => compile({ id: 'w', entries: [e] });

  it.for<[string, unknown, number, RegExp]>([
    ['no stages', { stages: [], bounds: [] }, 0, /'per-doc'.*at least one stage \(pipeline-empty\)/],
    ['fewer bounds than stages', { stages: [step('a'), step('b')], bounds: [1] }, 1, /'per-doc'.*2 stage\(s\) needs as many bounds, got 1 \(pipeline-value\)/],
    ['a zero bound', { stages: [step('a'), step('b')], bounds: [1, 0] }, 1, /stage 1's bound must be a whole number ≥ 1, got 0 \(pipeline-value\)/],
    ['a fractional bound', { stages: [step('a')], bounds: [1.5] }, 1.5, /stage 0's bound .* got 1.5 \(pipeline-value\)/],
    ['concurrency not Σc_j', { stages: [step('a'), step('b')], bounds: [2, 1] }, 2, /sum to 3, but the entry's concurrency is 2 \(pipeline-value\)/],
    ['Σc_j above the lane limit', { stages: [step('a'), step('b')], bounds: [200, 57] }, 257, /sum to 257, above the 256-lane limit \(pipeline-value\)/],
  ])('%s', ([, pipeline, concurrency, message]) => {
    expect(build(entry(pipeline, concurrency))).toThrow(message);
  });

  it('refuses a non-foreach entry', () => {
    expect(() => pipelineGadget(step('x') as EntryDescription, undefined as never, undefined as never)).toThrow(/received a 'step' entry/);
  });
});

// -------------------------------------------------------------------------------------------
// Helpers.
// -------------------------------------------------------------------------------------------

function transitionNamed(compiled: CompiledWorkflow, name: string): Transition {
  const found = [...compiled.net.transitions].find((t) => t.name === name);
  if (found === undefined) throw new Error(`no transition '${name}'`);
  return found;
}

/** Every place an output spec can deposit into. */
function outPlaces(out: Out): string[] {
  switch (out.type) {
    case 'place':
      return [out.place.name];
    case 'and':
    case 'xor':
      return out.children.flatMap(outPlaces);
    case 'timeout':
      return outPlaces(out.child);
    case 'forward-input':
      return [out.to.name];
  }
}

/** Each alternative an output spec deposits, as the list of places it deposits into. */
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

/** A transition's arcs by place name, renamed, with `drop` places removed — never its action. */
function shape(t: Transition, rename: (name: string) => string, drop: ReadonlySet<string>, withoutInhibitors = false): unknown {
  const out = (o: Out): unknown => {
    switch (o.type) {
      case 'place':
        return rename(o.place.name);
      case 'and':
        return { and: o.children.filter((c) => !(c.type === 'place' && drop.has(c.place.name))).map(out) };
      case 'xor':
        return { xor: o.children.map(out) };
      case 'timeout':
        return { timeout: o.afterMs, child: out(o.child) };
      case 'forward-input':
        return { forward: [rename(o.from.name), rename(o.to.name)] };
    }
  };
  return {
    inputs: t.inputSpecs.filter((s) => !drop.has(s.place.name)).map((s) => `${s.type}:${rename(s.place.name)}`),
    outputs: t.outputSpec === null ? null : out(t.outputSpec),
    ...(withoutInhibitors ? {} : { inhibitors: t.inhibitors.map((a) => rename(a.place.name)) }),
    reads: t.reads.map((a) => rename(a.place.name)),
    resets: t.resets.map((a) => rename(a.place.name)),
    timing: t.timing,
    priority: t.priority,
  };
}

/** One property from a segment's initial marking, under the hypotheses `verifyWorkflow` uses. */
function check(compiled: CompiledWorkflow, property: SmtProperty, segment: Segment = 'closed'): Promise<SmtVerificationResult> {
  const t = compiled.terminals;
  const initial = segmentInitialMarking(compiled, segment);
  return SmtVerifier.forNet(compiled.net)
    .initialMarking((m) => {
      for (const [p, n] of initial) m.tokens(p as Place<unknown>, n);
    })
    .sinkPlaces(t.done, t.failed, t.bailed, t.suspended, t.paused, t.canceled, compiled.cancel, ...(compiled.budget ? [compiled.budget.permits] : []))
    .semiflowInvariants(true)
    .timeout(BUDGET_MS)
    .property(property)
    .verify();
}

const verdict = (r: SmtVerificationResult): string =>
  `${r.verdict.type} via ${r.route} in ${r.elapsedMs}ms${r.verdict.type === 'unknown' ? ` (${r.verdict.reason})` : ''}`;

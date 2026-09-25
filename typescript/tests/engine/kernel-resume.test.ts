import { afterAll, describe, expect, it } from 'vitest';
import { Marking, Transition, tokenOf, type Place } from 'libpetri';
import { compile, parallelGadget, type Gadget } from '../../src/compiler/index.js';
import { classify, initialCounts, initialMarking, runWorkflowDetailed } from '../../src/engine/kernel.js';
import * as engine from '../../src/engine/index.js';
import {
  describeReport,
  resumeSegment,
  segmentInitialMarking,
  segmentLabel,
  segmentsFor,
  verifyWorkflow,
  type PropertyReport,
} from '../../src/verify/index.js';
import type {
  CompiledWorkflow,
  EntryDescription,
  EntrySite,
  FlowToken,
  ResumeSite,
  StepRecord,
  SuspendToken,
} from '../../src/compiler/types.js';
import { RecordingRunner } from '../fixtures/runner.js';
import { ManualClock } from '../support/manual-clock.js';

/**
 * The kernel's half of a resumed segment ([ADR 0007], contract C17): `RunOptions.resume` seeds one
 * token at a registered site **instead of** the entry place, the permits and a pre-aborted signal
 * exactly as for a fresh run, and refuses a site the workflow did not register — by identity —
 * before any executor exists.
 *
 * **Where the sites come from.** A top-level step's site is its own input place, already gated and
 * swept (ADR 0007, "Sites"). The leaf gadget registers it through `GadgetResult.resumeSites`; until
 * it does, {@link entrySite} registers the same place on a copy of the compiled workflow — the net,
 * program and every place are the compiled ones, only the `resumeSites` map differs. Either way the
 * kernel is handed a site that `compiled.resumeSites` holds by identity, which is what it checks.
 *
 * Every run is asserted with `toEqual`, so residue — a token left anywhere but the reported
 * terminal, the cancel signal and exactly `k` permits — fails the test.
 */

const EPOCH = 1_700_000_000_000;
const proofLog: string[] = [];
afterAll(() => {
  if (proofLog.length > 0) console.info(`kernel-resume proofs (libpetri 6.1.0 from npm):\n  ${proofLog.join('\n  ')}`);
});

const chain: readonly EntryDescription[] = [
  { kind: 'step', id: 'a' },
  { kind: 'step', id: 'b' },
  { kind: 'step', id: 'c' },
];
const fanThenZ: readonly EntryDescription[] = [
  {
    kind: 'parallel',
    id: 'fan',
    arms: [
      { kind: 'step', id: 'a1' },
      { kind: 'step', id: 'a2' },
    ],
  },
  { kind: 'step', id: 'z' },
];

const build = (id: string, entries: readonly EntryDescription[], k?: number): CompiledWorkflow =>
  compile({ id, entries }, k === undefined ? {} : { concurrency: k });

/** The top-level step at `index`, as a registered entry site of `compiled` (see the file note). */
function entrySite(compiled: CompiledWorkflow, index: number): { compiled: CompiledWorkflow; site: EntrySite } {
  const key = String(index);
  const registered = compiled.resumeSites.get(key);
  if (registered !== undefined) {
    if (registered.kind !== 'entry') throw new Error(`site ${key} is a ${registered.kind}, not an entry`);
    return { compiled, site: registered };
  }
  const stepId = compiled.netMap.pathToEntry.get(key)?.entryId;
  if (stepId === undefined) throw new Error(`no top-level entry at ${key}`);
  const inPlace = [...compiled.net.places].find((p) => {
    const owner = compiled.netMap.placeToEntry.get(p.name);
    return owner !== undefined && owner.id === stepId && owner.path.length === 1 && owner.path[0] === index;
  });
  if (inPlace === undefined) throw new Error(`no input place for entry ${key}`);
  const site: EntrySite = { kind: 'entry', path: [index], stepId, construct: 'step', place: inPlace as Place<FlowToken> };
  return { compiled: { ...compiled, resumeSites: new Map<string, ResumeSite>([...compiled.resumeSites, [key, site]]) }, site };
}

const transitionNames = (c: CompiledWorkflow): string[] => [...c.net.transitions].map((t) => t.name);
const record = (output: unknown): StepRecord => ({ status: 'success', payload: output, output, startedAt: EPOCH, endedAt: EPOCH });

/** Token counts per place name, for comparing a marking with the one a proof starts from. */
function counts(marking: Map<Place<unknown>, readonly unknown[]>): Record<string, number> {
  return Object.fromEntries([...marking].map(([p, tokens]) => [p.name, tokens.length]));
}

/**
 * Every report `verifyWorkflow` returns, each asserted `proven` by name — never "not violated",
 * which passes on `unknown`. The report keys are exactly every segment `segmentsFor` names (the
 * fresh two and `resume@s`, `resume@s+cancel` per site) crossed with the property set: the three
 * quiescence properties, `neverCanceled` where no cancel arrives, and the budget's two.
 */
async function expectAllProven(label: string, compiled: CompiledWorkflow): Promise<void> {
  const t0 = performance.now();
  const reports: readonly PropertyReport[] = await verifyWorkflow(compiled);
  proofLog.push(`${label} (${Math.round(performance.now() - t0)}ms): ${reports.map(describeReport).join('; ')}`);
  const expected = segmentsFor(compiled).flatMap((segment) => {
    const cancels = typeof segment === 'string' ? segment === 'cancel' : segment.cancel;
    return [
      'deadlockFree',
      'terminatesAtSink',
      'exactlyOneTerminal',
      ...(cancels ? [] : ['neverCanceled']),
      ...(compiled.budget ? ['permitsBounded', 'permitsReturned'] : []),
    ].map((property) => `${segmentLabel(segment)}/${property}`);
  });
  expect(reports.map((r) => `${segmentLabel(r.segment)}/${r.property}`), label).toStrictEqual(expected);
  for (const r of reports) expect(r.result.verdict.type, `${label}: ${describeReport(r)}`).toBe('proven');
}

describe('a resumed segment is seeded at its site', () => {
  it('seeds one token at the site instead of the entry place, and nothing else', () => {
    const { compiled, site } = entrySite(build('chain', chain), 1);
    const seed: FlowToken = { data: { from: 'resume' }, resumed: true };
    const marking = initialMarking(compiled, { init: 1 }, { resume: { site, value: seed } });

    expect(counts(marking)).toEqual({ [site.place.name]: 1 });
    expect(marking.has(compiled.entryPlace)).toBe(false);
    // The value is seeded as it is: the kernel neither wraps nor rebuilds it.
    expect(marking.get(site.place)?.[0]?.value).toBe(seed);
    // A fresh run of the same workflow still starts at the entry place.
    expect(counts(initialMarking(compiled, { init: 1 }, {}))).toEqual({ [compiled.entryPlace.name]: 1 });
  });

  it('runs from the site: the steps before it never run, the carried-in records survive', async () => {
    const { compiled, site } = entrySite(build('chain', chain), 1);
    await expectAllProven('chain a;b;c', compiled);
    const runner = new RecordingRunner();
    const report = await runWorkflowDetailed(compiled, { init: 1 }, {
      runner,
      clock: new ManualClock(EPOCH),
      stepResults: new Map([['a', record({ a: 'stored' })]]),
      resume: { site, value: { data: { from: 'resume' }, resumed: true } satisfies FlowToken },
    });

    expect(report.outcome).toEqual({ status: 'success', output: { from: 'resume' } });
    expect(runner.calls).toEqual(['b', 'c']);
    expect(report.stepResults.get('a')).toEqual(record({ a: 'stored' }));
    expect(report.stepResults.get('b')?.status).toBe('success');
    expect(report.stepResults.get('c')?.status).toBe('success');
  });

  it('a pre-aborted signal is seeded beside the site: the site sweep cancels with nothing started', async () => {
    const { compiled, site } = entrySite(build('chain', chain), 1);
    const controller = new AbortController();
    controller.abort();

    const marking = initialMarking(compiled, null, { signal: controller.signal, resume: { site, value: { data: 1 } } });
    // M_s plus the post-arrival cancel: the signal, not the request (see `initialMarking`).
    expect(counts(marking)).toEqual({ [site.place.name]: 1, [compiled.cancel.name]: 1 });

    const runner = new RecordingRunner();
    const outcome = (
      await runWorkflowDetailed(compiled, null, {
        runner,
        clock: new ManualClock(EPOCH),
        signal: controller.signal,
        resume: { site, value: { data: 1, resumed: true } satisfies FlowToken },
      })
    ).outcome;
    // The origin is the site's entry — what was waiting when the sweep fired, as for a fresh run.
    expect(outcome).toEqual({ status: 'canceled', origin: { stepId: 'b', path: [1] }, started: false });
    expect(runner.calls).toEqual([]);
  });

  it.each([1, 2, 3])('permits at k=%i are seeded as for a fresh run, and all come back', async (k) => {
    const { compiled, site } = entrySite(build(`fan-k${k}`, fanThenZ, k), 1);
    if (!compiled.budget) throw new Error('budget not compiled in');
    const marking = initialMarking(compiled, null, { resume: { site, value: { data: 'x' } } });
    expect(counts(marking)).toEqual({ [site.place.name]: 1, [compiled.budget.permits.name]: k });
    // The fresh run's permits are the same k: a resume changes the control token and nothing else.
    expect(counts(initialMarking(compiled, null, {}))).toEqual({ [compiled.entryPlace.name]: 1, [compiled.budget.permits.name]: k });

    if (k === 2) await expectAllProven(`fan(a1,a2);z at k=${k}`, compiled);
    const runner = new RecordingRunner();
    const outcome = (
      await runWorkflowDetailed(compiled, null, {
        runner,
        clock: new ManualClock(EPOCH),
        resume: { site, value: { data: { fan: 'stored' }, resumed: true } satisfies FlowToken },
      })
    ).outcome;
    // `classify` reports any permit count other than k at rest as residue, so this also says every
    // permit came back.
    expect(outcome).toEqual({ status: 'success', output: { fan: 'stored' } });
    expect(runner.calls).toEqual(['z']);
  });
});

describe('a site the workflow did not register is refused before anything runs', () => {
  it('refuses a site from another compile of the same workflow, by identity', async () => {
    const { compiled } = entrySite(build('chain', chain), 1);
    const { site: foreign } = entrySite(build('chain', chain), 1);
    // Structurally the same site — same path, step, place name — and still not this workflow's.
    expect(foreign.place.name).toBe((compiled.resumeSites.get('1') as EntrySite).place.name);
    expect(compiled.resumeSites.get('1')).not.toBe(foreign);

    const runner = new RecordingRunner();
    await expect(
      runWorkflowDetailed(compiled, null, { runner, resume: { site: foreign, value: { data: 1 } } }),
    ).rejects.toThrow(/resume site at path 1 \('b'\) is not the one this workflow registered there/);
    expect(runner.calls).toEqual([]);
  });

  it('refuses a site at a path the workflow has none at', async () => {
    const { compiled, site } = entrySite(build('chain', chain), 1);
    const elsewhere: EntrySite = { ...site, path: [2] };
    const runner = new RecordingRunner();
    await expect(
      runWorkflowDetailed(compiled, null, { runner, resume: { site: elsewhere, value: { data: 1 } } }),
    ).rejects.toThrow(/resume site at path 2 .* is not the one this workflow registered there/);
    expect(runner.calls).toEqual([]);
  });

  it('refuses a site on the cancel signal: no token of work outside {permits, cancel}', async () => {
    // Counts alone cannot see it — the seed lands on `wf.cancel`, which is what a pre-aborted run
    // would hold there anyway — so the one-token-of-work check is what refuses it.
    const base = build('chain-k2', chain, 2);
    const bogus: EntrySite = { kind: 'entry', path: [1], stepId: 'b', construct: 'step', place: base.cancel as unknown as Place<FlowToken> };
    const compiled: CompiledWorkflow = { ...base, resumeSites: new Map<string, ResumeSite>([['1', bogus]]) };
    const runner = new RecordingRunner();
    await expect(runWorkflowDetailed(compiled, null, { runner, resume: { site: bogus, value: { data: 1 } } })).rejects.toThrow(
      "compiled workflow 'chain-k2': a resumed segment must start from exactly one token at its site 'wf.cancel', found 0 outside the permits and the cancel signal",
    );
    expect(runner.calls).toEqual([]);
  });

  it('refuses a site on the permits: k + 1 permits is not the marking resume@1 is proven from', async () => {
    const base = build('chain-k2', chain, 2);
    if (!base.budget) throw new Error('budget not compiled in');
    const bogus: EntrySite = { kind: 'entry', path: [1], stepId: 'b', construct: 'step', place: base.budget.permits as unknown as Place<FlowToken> };
    const compiled: CompiledWorkflow = { ...base, resumeSites: new Map<string, ResumeSite>([['1', bogus]]) };
    const runner = new RecordingRunner();
    await expect(runWorkflowDetailed(compiled, null, { runner, resume: { site: bogus, value: { data: 1 } } })).rejects.toThrow(
      "compiled workflow 'chain-k2': the initial marking is not the one segment resume@1 is proven from (wf.permits: 3, proven from 2)",
    );
    const aborted = new AbortController();
    aborted.abort();
    expect(() => initialMarking(compiled, null, { signal: aborted.signal, resume: { site: bogus, value: { data: 1 } } })).toThrow(
      "compiled workflow 'chain-k2': the initial marking is not the one segment resume@1 is proven from plus the cancel signal (wf.permits: 3, proven from 2)",
    );
    expect(runner.calls).toEqual([]);
  });
});

describe('the marking a run starts from is the one its segment is proven from', () => {
  const shapes: ReadonlyArray<readonly [string, readonly EntryDescription[]]> = [
    ['chain', chain],
    ['fan(a1,a2);z', fanThenZ],
    ['each(x);z', [{ kind: 'foreach', id: 'each', concurrency: 2, body: { kind: 'step', id: 'x' } }, { kind: 'step', id: 'z' }]],
  ];
  const names = (m: ReadonlyMap<Place<unknown>, number>): Record<string, number> => Object.fromEntries([...m].map(([p, n]) => [p.name, n]));

  it.each(shapes)('%s: per place, for every site, at k in {unbounded, 1, 3}, aborted or not', (_label, entries) => {
    for (const k of [undefined, 1, 3]) {
      const compiled = build('w', entries, k);
      const aborted = new AbortController();
      aborted.abort();
      const request = compiled.cancelRequest.name;
      const signal = compiled.cancel.name;
      // Fresh: the `closed` segment's marking; pre-aborted: the `cancel` segment's after `arrive`.
      expect(counts(initialMarking(compiled, 1, {}))).toEqual(names(segmentInitialMarking(compiled, 'closed')));
      const { [request]: arrived, ...rest } = names(segmentInitialMarking(compiled, 'cancel'));
      expect(arrived).toBe(1);
      expect(counts(initialMarking(compiled, 1, { signal: aborted.signal }))).toEqual({ ...rest, [signal]: 1 });

      expect(compiled.resumeSites.size).toBeGreaterThan(0);
      for (const [key, site] of compiled.resumeSites) {
        const value = site.kind === 'entry' ? { data: 1 } : site.kind === 'arm' ? { data: 1, siblings: [] } : { items: [], order: [], done: [], parked: [] };
        expect(counts(initialMarking(compiled, 1, { resume: { site, value } })), `resume@${key} k=${k}`).toEqual(
          names(segmentInitialMarking(compiled, resumeSegment(key, false))),
        );
        const { [request]: once, ...after } = names(segmentInitialMarking(compiled, resumeSegment(key, true)));
        expect(once).toBe(1);
        expect(counts(initialMarking(compiled, 1, { signal: aborted.signal, resume: { site, value } })), `resume@${key}+cancel k=${k}`).toEqual({
          ...after,
          [signal]: 1,
        });
      }
    }
  });

  it('initialMarking and initialCounts are exported from the engine entry', () => {
    expect(engine.initialMarking).toBe(initialMarking);
    expect(engine.initialCounts).toBe(initialCounts);
  });
});

describe("a seed's colour: the kernel refuses a malformed entry seed; a block's gate refuses its own", () => {
  const fan = build('fan', fanThenZ);
  const each = build('each', [{ kind: 'foreach', id: 'each', concurrency: 2, body: { kind: 'step', id: 'x' } }]);
  const site = (c: CompiledWorkflow, key: string): ResumeSite => {
    const s = c.resumeSites.get(key);
    if (s === undefined) throw new Error(`no site ${key}`);
    return s;
  };

  it.each([
    ['null', null],
    ['no data', { resumed: true }],
    ['a primitive', 7],
  ] as const)('entry seed %s: rejected before any executor exists', async (_label, value) => {
    const runner = new RecordingRunner();
    await expect(runWorkflowDetailed(fan, null, { runner, resume: { site: site(fan, '1'), value } })).rejects.toThrow(
      "compiled workflow 'fan': the seed at resume site 1 ('s.1.z.in') is not a FlowToken: a non-null object with `data`",
    );
    expect(runner.calls).toEqual([]);
  });

  // An arm's or a foreach's gate checks the seed itself and reports a misfit as the block's
  // `failed` outcome, by name, before any step runs — the kernel does not pre-empt it. With the
  // kernel also ending a run on a failed firing, no malformed seed can strand a run silently.
  const blockCases: ReadonlyArray<readonly [string, CompiledWorkflow, string, unknown, { stepId: string; path: number[] }, string]> = [
    ['arm: null', fan, '0.0', null, { stepId: 'fan', path: [0] }, "parallel 'fan': cannot resume arm 0 (a1): the seed carries no sibling list"],
    ['arm: no siblings', fan, '0.0', { data: 1 }, { stepId: 'fan', path: [0] }, "parallel 'fan': cannot resume arm 0 (a1): the seed carries no sibling list"],
    ['arm: unknown kind', fan, '0.0', { data: 1, siblings: [{ kind: 'done', index: 1 }] }, { stepId: 'fan', path: [0] }, "parallel 'fan': cannot resume arm 0 (a1): a sibling verdict is not one of ok, suspended, failed, settled, skipped"],
    ['foreach: null', each, '0', null, { stepId: 'x', path: [0] }, ".foreach 'each' cannot resume from this seed: it is not a ForeachResume"],
    ['foreach: no parked', each, '0', { items: [], order: [], done: [] }, { stepId: 'x', path: [0] }, ".foreach 'each' cannot resume from this seed: items, order, done and parked must all be arrays"],
  ];
  it.each(blockCases)('%s: the gate fails the block by name', async (_label, compiled, key, value, at, message) => {
    const runner = new RecordingRunner();
    const { outcome } = await runWorkflowDetailed(compiled, null, { runner, clock: new ManualClock(EPOCH), resume: { site: site(compiled, key), value } });
    expect(outcome).toMatchObject({ status: 'failed', ...at });
    expect(Object.keys(outcome).sort()).toStrictEqual(['error', 'path', 'status', 'stepId']);
    expect(String((outcome as { error: unknown }).error)).toBe(`Error: ${message}`);
    expect(runner.calls).toEqual([]);
  });
});

describe('a failed firing ends the run at once, as stranded', () => {
  // A replay that under-emits: `replay-1` consumes its verdict and emits nothing, which its `Out`
  // spec forbids, so the executor raises an `OutViolationError` and the firing fails. The proofs
  // model the spec, not the action, so every one stays proven; before the kernel watched for
  // `transition-failed`, a run with a signal (the executor has an environment place, `timeoutMs`
  // is null as under Mastra) waited at quiescence forever.
  const underEmits: Gadget = (entry, next, ctx) => {
    const r = parallelGadget(entry, next, ctx);
    return {
      ...r,
      transitions: r.transitions.map((t) => {
        if (t.name !== 't.0.fan.replay-1') return t;
        const b = Transition.builder(t.name).inputs(...t.inputSpecs).outputs(t.outputSpec!).action(async () => {}).timing(t.timing).priority(t.priority);
        for (const a of t.reads) b.read(a.place);
        for (const a of t.resets) b.reset(a.place);
        for (const a of t.inhibitors) b.inhibitor(a.place);
        return b.build();
      }),
    };
  };
  // The resumed arm ran to its own done place; nothing joined, so `z` never ran and no terminal is
  // marked — every marked place is named.
  const STRANDED_PLACES: readonly string[] = ['s.0.fan.arm-0-done'];
  const REPLAY_VIOLATION = "'t.0.fan.replay-1': output does not match the declared spec - produced {}, which no single branch of the spec claims exactly";
  const seed = { data: { a1: 'in' }, siblings: [{ kind: 'ok', index: 1, output: { a2: 'stored' } }] };

  it.each([
    ['with a signal and no timeout', true],
    ['without a signal', false],
  ] as const)('%s', async (_label, withSignal) => {
    const compiled = compile({ id: 'fan', entries: fanThenZ }, { gadgets: { parallel: underEmits } });
    expect(transitionNames(compiled)).toContain('t.0.fan.replay-1');
    const site = compiled.resumeSites.get('0.0');
    if (site === undefined) throw new Error('no site 0.0');
    const runner = new RecordingRunner();
    const t0 = performance.now();
    const report = await runWorkflowDetailed(compiled, null, {
      runner,
      clock: new ManualClock(EPOCH),
      timeoutMs: null,
      ...(withSignal ? { signal: new AbortController().signal } : {}),
      resume: { site, value: seed },
    });
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(report.outcome).toStrictEqual({
      status: 'stranded',
      places: STRANDED_PLACES,
      failure: { transition: 't.0.fan.replay-1', exceptionType: 'OutViolationError', message: REPLAY_VIOLATION },
    });
    expect(runner.calls).toEqual(['a1']);
  }, 10_000);
});

describe('a suspended outcome names every suspension', () => {
  const at = { stepId: 'a1', path: [0, 0] } as const;

  it('exposes the join\'s pending suspensions', () => {
    const compiled = build('fan', fanThenZ);
    const other: SuspendToken = { stepId: 'a2', path: [0, 1], payload: { why: 'two' }, suspendedAt: EPOCH + 2 };
    const marking = Marking.from(
      new Map([[compiled.terminals.suspended, [tokenOf<SuspendToken>({ ...at, payload: { why: 'one' }, suspendedAt: EPOCH + 1, pending: [other] })]]]),
    );
    expect(classify(compiled, marking)).toEqual({ status: 'suspended', ...at, payload: { why: 'one' }, pending: [other] });
  });

  it('has no pending key for a lone suspension, or an empty list', () => {
    const compiled = build('fan', fanThenZ);
    for (const pending of [undefined, []]) {
      const token: SuspendToken = pending === undefined ? { ...at, payload: 1 } : { ...at, payload: 1, pending };
      const outcome = classify(compiled, Marking.from(new Map([[compiled.terminals.suspended, [tokenOf(token)]]])));
      expect(outcome).toEqual({ status: 'suspended', ...at, payload: 1 });
      expect('pending' in outcome).toBe(false);
    }
  });
});

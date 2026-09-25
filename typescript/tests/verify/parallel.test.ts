import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Transition, and, one, outPlace, place, type In, type Out, type Place } from 'libpetri';
import { compile, parallelGadget, type Gadget } from '../../src/compiler/index.js';
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
import type {
  CompiledWorkflow,
  EntryDescription,
  Exits,
  FailureToken,
  StepDescription,
  WorkflowDescription,
} from '../../src/compiler/types.js';

const step = (id: string, extra: Partial<Omit<StepDescription, 'kind' | 'id'>> = {}): StepDescription =>
  ({ kind: 'step', id, ...extra });
const fan = (id: string, arms: readonly StepDescription[]): EntryDescription => ({ kind: 'parallel', id, arms });
const wf = (...entries: EntryDescription[]): WorkflowDescription => ({ id: 'w', entries });

const build = (description: WorkflowDescription, gadget: Gadget = parallelGadget) =>
  compile(description, { gadgets: { parallel: gadget } });

/** Every segment unless a caller narrows them: `verifyWorkflow`'s default is the claim. */
const verify = (
  description: WorkflowDescription,
  gadget: Gadget = parallelGadget,
  segments?: readonly Segment[],
) => verifyWorkflow(build(description, gadget), { timeoutMs: 120_000, ...(segments ? { segments } : {}) });

/** The property set `verifyWorkflow` proves in a segment with no cancel arriving, and in one with. */
const UNCANCELED = ['deadlockFree', 'terminatesAtSink', 'exactlyOneTerminal', 'neverCanceled'] as const;
const CANCELED = ['deadlockFree', 'terminatesAtSink', 'exactlyOneTerminal'] as const;
const cancels = (segment: Segment): boolean => (typeof segment === 'string' ? segment === 'cancel' : segment.cancel);
/**
 * Every property of every default segment, in the order `verifyWorkflow` runs them: `closed`,
 * `cancel`, then `resume@s` and `resume@s+cancel` per resume site ([ADR 0007]).
 */
const everyKey = (compiled: CompiledWorkflow): string[] =>
  segmentsFor(compiled).flatMap((segment) => (cancels(segment) ? CANCELED : UNCANCELED).map((p) => `${segmentLabel(segment)}/${p}`));
const keyOf = (r: PropertyReport): string => `${segmentLabel(r.segment)}/${r.property}`;

/** Appends a proof line to the file `PROOF_LOG` names, when it names one — the route-and-ms record. */
const proofLog = (line: string): void => {
  const file = process.env.PROOF_LOG;
  if (file) appendFileSync(file, `${line}\n`);
};

const verdictOf = (reports: readonly PropertyReport[], key: string): PropertyReport => {
  const report = reports.find((r) => keyOf(r) === key);
  if (report === undefined) throw new Error(`no '${key}' report`);
  return report;
};

/**
 * Every shape must come back `proven` for **every** property of **every** segment, not merely
 * un-violated — `verifyWorkflow`'s default, after its structural checks have passed. The segments
 * are `closed` and `cancel` below, then `resume@s` and `resume@s+cancel` from every resume site —
 * each arm of a parallel and each top-level step ([ADR 0007]) — one token at the site instead of
 * the entry place, with the same property sets.
 *
 * Initial marking: one token in the workflow's entry place; in the `cancel` segment also one
 * token in `wf.cancel.request`, whose immediate `arrive` may then fire at every reachable point —
 * before the block, mid-arm, between an arm's retries, after the join. Environment: closed in
 * both (the arrival is part of the net). Sinks: all six terminals — `wf.done`, `wf.failed`,
 * `wf.bailed`, `wf.suspended`, `wf.paused`, `wf.canceled` — and `wf.cancel`. `closed` proves
 * deadlockFree, terminatesAtSink, exactlyOneTerminal and neverCanceled (`wf.canceled` bounded
 * by 0); `cancel` proves the first three. The route is whatever the verifier reports, and a
 * failed assertion prints it. Under cancellation `terminatesAtSink` is blind (the marked cancel
 * place satisfies it); `exactlyOneTerminal` is the property that sees a stranding.
 *
 * The two properties are complementary ([VER-013]): `deadlockFree` fails on a quiescent marking
 * holding a token *outside* the sinks — a sibling stranded in `arrived`, a marker left in
 * `err-seen` or `susp-seen` — and `terminatesAtSink` fails on one with no sink marked at all.
 * Every arm here is a step that can succeed, fail, bail, suspend or pause, so each proof covers
 * every mix of arm outcomes, not only the happy one.
 */
const shapes: ReadonlyArray<readonly [string, WorkflowDescription]> = [
  ['n = 0, the empty block', wf(fan('fan', []))],
  ['n = 0 between two steps', wf(step('before'), fan('fan', []), step('after'))],
  ['n = 1', wf(fan('fan', [step('a')]))],
  ['n = 2', wf(fan('fan', [step('a'), step('b')]))],
  ['n = 3 then a successor', wf(fan('fan', [step('a'), step('b'), step('c')]), step('after'))],
  ['n = 4', wf(fan('fan', ['a', 'b', 'c', 'd'].map((id) => step(id))))],
  ['n = 2, one arm retrying (retries: 2)', wf(fan('fan', [step('a', { retries: 2 }), step('b')]))],
  [
    'n = 2, both arms retrying (retries: 2) with a timed retry delay',
    wf(fan('fan', [step('a', { retries: 2, retryDelayMs: 5 }), step('b', { retries: 2, retryDelayMs: 5 })])),
  ],
  ['n = 4, one arm retrying (retries: 2)', wf(fan('fan', [step('a', { retries: 2 }), step('b'), step('c'), step('d')]))],
  ['a parallel between two steps', wf(step('before'), fan('fan', [step('a'), step('b')]), step('after'))],
  ['two parallels in series', wf(fan('f1', [step('a'), step('b')]), fan('f2', [step('c'), step('d')]))],
  ['two arms that are the same step id', wf(fan('fan', [step('a'), step('a')]))],
  ['a nested-workflow arm', wf(fan('fan', [step('sub', { source: 'workflow' }), step('b')]))],
];

describe('compiled parallel, proved', () => {
  for (const [shape, description] of shapes) {
    it(`every property of both segments is proven: ${shape}`, async () => {
      const started = performance.now();
      const reports = await verify(description);
      const ms = performance.now() - started;

      // `proven` explicitly. `isViolated()` is false for `unknown` too, so asserting "not
      // violated" would silently pass on a query that timed out. An `unknown` is a finding.
      expect(reports.map(keyOf)).toEqual(everyKey(build(description)));
      for (const report of reports) {
        expect(report.result.verdict.type, describeReport(report)).toBe('proven');
      }
      proofLog(`[proof] ${shape} (${ms.toFixed(0)}ms): ${reports.map(describeReport).join('; ')}`);
    }, 360_000);
  }
});

// ---------------------------------------------------------------------------------------------
// Non-vacuity. Each structural safeguard the gadget's doc comment relies on is removed once,
// through the `gadgets` override with a mutated copy of the real gadget's output — never by
// editing src — and the verdict must flip to `violated`. Not `not.toBe('proven')`: `unknown`
// would satisfy that and say nothing about whether the query can discriminate.
// ---------------------------------------------------------------------------------------------

interface Rebuild {
  readonly inputs?: readonly In[];
  readonly output?: Out;
  readonly inhibitors?: readonly Place<unknown>[];
  readonly resets?: readonly Place<unknown>[];
}

/** A copy of `t` with some of its arcs replaced; everything else — action, timing — kept. */
function rebuild(t: Transition, change: Rebuild): Transition {
  const b = Transition.builder(t.name)
    .inputs(...(change.inputs ?? t.inputSpecs))
    .timing(t.timing)
    .priority(t.priority)
    .action(t.action);
  const output = change.output ?? t.outputSpec;
  if (output !== null) b.outputs(output);
  for (const p of change.inhibitors ?? t.inhibitors.map((a) => a.place)) b.inhibitor(p);
  for (const p of change.resets ?? t.resets.map((a) => a.place)) b.reset(p);
  for (const r of t.reads) b.read(r.place);
  return b.build();
}

/** The real gadget, with the transition whose name ends in `.${role}` passed through `edit`. */
const mutate = (role: string, edit: (t: Transition) => readonly Transition[]): Gadget =>
  (entry, next, ctx) => {
    const result = parallelGadget(entry, next, ctx);
    let hits = 0;
    const transitions = result.transitions.flatMap((t) => {
      if (!t.name.endsWith(`.${role}`)) return [t];
      hits++;
      return edit(t);
    });
    if (hits !== 1) throw new Error(`mutation target '${role}' matched ${hits} transitions`);
    return { ...result, transitions };
  };

/** The real gadget, with one of the arms' exits pointed at the enclosing exit instead. */
const bypass = (exit: Exclude<keyof Exits, 'canceled'>): Gadget => (entry, next, ctx) =>
  parallelGadget(entry, next, {
    ...ctx,
    emitNested: (s, p, n, exits, o) => ctx.emitNested(s, p, n, { ...exits, [exit]: ctx.exits[exit] } as Exits, o),
  });

const placeNamed = (t: Transition, suffix: string): Place<unknown> => {
  const all = [...t.inputPlaces(), ...t.outputPlaces(), ...t.inhibitors.map((a) => a.place), ...t.resets.map((a) => a.place)];
  const found = all.find((p) => p.name.endsWith(`.${suffix}`));
  if (found === undefined) throw new Error(`transition '${t.name}' has no arc to '*.${suffix}'`);
  return found;
};

const twoArms = wf(fan('fan', [step('a'), step('b')]));

async function expectDeadlockFreeViolated(gadget: Gadget): Promise<void> {
  // Control: the same shape through the unmutated gadget is proven, so the flip below is the
  // mutation's doing and not the shape's.
  // The closed segment alone: these safeguards are about arm outcomes, not cancellation, and
  // deadlock freedom without a cancel is where each removal shows.
  const control = verdictOf(await verify(twoArms, parallelGadget, ['closed']), 'closed/deadlockFree');
  expect(control.result.verdict.type, describeReport(control)).toBe('proven');

  const report = verdictOf(await verify(twoArms, gadget, ['closed']), 'closed/deadlockFree');
  expect(report.result.verdict.type, describeReport(report)).toBe('violated');
}

describe('compiled parallel, non-vacuity by mutation', () => {
  // The arrival deposits. Each non-success exit of an arm is routed to the gadget's own place so
  // that it still counts toward `exactly(n, arrived)`. Routing any one of them straight to the
  // enclosing exit instead — the naive fan-in — ends the block while a sibling's settlement sits
  // in `arrived` with no consumer that can ever be enabled.
  for (const exit of ['failed', 'suspended', 'bailed', 'paused'] as const) {
    it(`needs the '${exit}' arrival deposit: an arm ${exit} straight to the enclosing exit strands its sibling`, async () => {
      await expectDeadlockFreeViolated(bypass(exit));
    }, 180_000);
  }

  it('needs join-ok inhibited by err-seen: without it a failed block can succeed and strand the marker', async () => {
    await expectDeadlockFreeViolated(
      mutate('join-ok', (t) => [rebuild(t, { inhibitors: t.inhibitors.map((a) => a.place).filter((p) => !p.name.endsWith('.err-seen')) })]),
    );
  }, 180_000);

  it('needs join-ok inhibited by susp-seen: without it a suspended block can succeed and strand the marker', async () => {
    await expectDeadlockFreeViolated(
      mutate('join-ok', (t) => [rebuild(t, { inhibitors: t.inhibitors.map((a) => a.place).filter((p) => !p.name.endsWith('.susp-seen')) })]),
    );
  }, 180_000);

  it('needs join-susp inhibited by err-seen: without it a suspension can outrank a failure', async () => {
    await expectDeadlockFreeViolated(mutate('join-susp', (t) => [rebuild(t, { inhibitors: [] })]));
  }, 180_000);

  it('needs join-fail to reset susp-seen: without it a failure beside a suspension strands the marker', async () => {
    await expectDeadlockFreeViolated(mutate('join-fail', (t) => [rebuild(t, { resets: [] })]));
  }, 180_000);

  it('needs join-fail to consume all of err-seen: one() leaves a second failure behind', async () => {
    await expectDeadlockFreeViolated(
      mutate('join-fail', (t) => {
        const errSeen = placeNamed(t, 'err-seen');
        return [rebuild(t, { inputs: t.inputSpecs.map((s) => (s.place === errSeen ? one(errSeen) : s)) })];
      }),
    );
  }, 180_000);

  it('needs join-susp to consume all of susp-seen: one() leaves a second suspension behind', async () => {
    await expectDeadlockFreeViolated(
      mutate('join-susp', (t) => {
        const suspSeen = placeNamed(t, 'susp-seen');
        return [rebuild(t, { inputs: t.inputSpecs.map((s) => (s.place === suspSeen ? one(suspSeen) : s)) })];
      }),
    );
  }, 180_000);

  it('needs the arrival and err-seen in one firing: split across two, join-ok races the marker', async () => {
    // The doc comment's race-freedom argument, removed: `collect-err` deposits the arrival now
    // and the marker one firing later, through a relay. In between, a full count with an empty
    // `err-seen` enables `join-ok`, and the marker lands after the block has already succeeded.
    await expectDeadlockFreeViolated(
      mutate('collect-err', (t) => {
        const armErr = placeNamed(t, 'arm-err') as Place<FailureToken>;
        const arrived = placeNamed(t, 'arrived');
        const errSeen = placeNamed(t, 'err-seen') as Place<FailureToken>;
        const pending = place<FailureToken>(`${errSeen.name}-pending`);
        const split = Transition.builder(t.name)
          .inputs(one(armErr))
          .outputs(and(outPlace(arrived), outPlace(pending)))
          .action(async (tctx) => {
            const failure = tctx.input(armErr);
            tctx.output(arrived, { status: 'failed' });
            tctx.output(pending, failure);
          })
          .build();
        const relay = Transition.builder(`${t.name}-relay`)
          .inputs(one(pending))
          .outputs(outPlace(errSeen))
          .action(async (tctx) => {
            tctx.output(errSeen, tctx.input(pending));
          })
          .build();
        return [split, relay];
      }),
    );
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------
// Non-vacuity of the cancellation safeguards. The sweep is removed and a proof flips. The two
// inhibitors are removed and the *structural* check flags each by name — no proof can see them,
// because the extra work an ungated start does still drains to exactly one terminal. The run-level
// flip for the fork inhibitor is in `tests/compiler/parallel.test.ts`.
// ---------------------------------------------------------------------------------------------

describe('compiled parallel, cancellation non-vacuity', () => {
  const guarded = wf(step('before'), fan('fan', [step('a'), step('b')]), step('after'));
  const guardedEmpty = wf(step('before'), fan('fan', []), step('after'));
  const withoutSweep: Gadget = (entry, next, ctx) => {
    const result = parallelGadget(entry, next, ctx);
    // The block's own sweep, by its id: every arm's resume sweep ends in `.cancel` too ([ADR 0007]).
    const transitions = result.transitions.filter((t) => !t.name.endsWith(`.${entry.id}.cancel`));
    if (transitions.length !== result.transitions.length - 1) throw new Error('sweep not found exactly once');
    return { ...result, transitions };
  };

  /** A resume segment pair's seven verdicts, keyed as `verifyWorkflow` reports them. */
  const resumed = (site: string, cancelDeadlockFree: string, cancelExactlyOne: string) => ({
    [`resume@${site}/deadlockFree`]: 'proven',
    [`resume@${site}/terminatesAtSink`]: 'proven',
    [`resume@${site}/exactlyOneTerminal`]: 'proven',
    [`resume@${site}/neverCanceled`]: 'proven',
    [`resume@${site}+cancel/deadlockFree`]: cancelDeadlockFree,
    [`resume@${site}+cancel/terminatesAtSink`]: 'proven',
    [`resume@${site}+cancel/exactlyOneTerminal`]: cancelExactlyOne,
  });

  // The resume segments ([ADR 0007]). Site 0 is `before`'s input, the entry place itself, so its
  // pair starts where the fresh segments do and sees the stranding too. Every later site — an
  // arm, or `after` — is past the block's input, so the missing sweep is never on its path.
  for (const [label, shape, later] of [
    ['n = 2 between two steps', guarded, ['1.0', '1.1', '2']],
    ['n = 0 between two steps', guardedEmpty, ['2']],
  ] as const) {
    it(`needs the sweep: without it the canceled block's input is stranded (${label})`, async () => {
      // No sweep, no start to compete with it: the structural check has nothing to flag, so the
      // default run proves — and this is the proof that sees it. The block's input is not a resume
      // site (its arms are), so the resume gate check has nothing to flag either.
      expect(cancelStructureViolations(build(shape, withoutSweep))).toEqual([]);
      expect(resumeGateViolations(build(shape, withoutSweep))).toEqual([]);
      const reports = await verify(shape, withoutSweep);
      const v = Object.fromEntries(reports.map((r) => [keyOf(r), r.result.verdict.type]));
      const all = reports.map(describeReport).join('; ');
      expect(v, all).toStrictEqual({
        'closed/deadlockFree': 'proven',
        'closed/terminatesAtSink': 'proven',
        'closed/exactlyOneTerminal': 'proven',
        'closed/neverCanceled': 'proven',
        'cancel/deadlockFree': 'violated',
        // Blind under cancellation: the marked `wf.cancel` is a sink.
        'cancel/terminatesAtSink': 'proven',
        'cancel/exactlyOneTerminal': 'violated',
        ...resumed('0', 'violated', 'violated'),
        ...Object.fromEntries(later.flatMap((site) => Object.entries(resumed(site, 'proven', 'proven')))),
      });
      proofLog(`[mutant sweep ${label}] ${all}`);
    }, 360_000);
  }

  // The lead's pattern: the same transition, rebuilt without its inhibitors, reads re-added.
  const stripInhibitors = (role: 'fork' | 'empty'): Gadget =>
    mutate(role, (t) => {
      const b = Transition.builder(t.name).inputs(...t.inputSpecs).outputs(t.outputSpec!).action(t.action).timing(t.timing);
      for (const r of t.reads) b.read(r.place);
      return [b.build()];
    });

  for (const [role, label, shape, name] of [
    ['fork', 'n = 2 between two steps', guarded, 't.1.fan.fork'],
    ['empty', 'n = 0 between two steps', guardedEmpty, 't.1.fan.empty'],
  ] as const) {
    it(`the '${role}' inhibitor on the cancel signal: stripped, the structural check names '${name}' (${label})`, async () => {
      const real = build(shape);
      const sweepName = name.replace(/\.[a-z]+$/, '.cancel');
      // Control: the real gadget's net is structurally sound and the transition does carry it.
      expect(cancelStructureViolations(real)).toEqual([]);
      const original = [...real.net.transitions].find((t) => t.name === name);
      expect(original?.inhibitors.map((a) => a.place.name)).toEqual([real.cancel.name]);

      const mutant = build(shape, stripInhibitors(role));
      expect(cancelStructureViolations(mutant)).toEqual([
        `'${name}' competes with sweep '${sweepName}' for [s.1.fan.in] without an inhibitor on '${mutant.cancel.name}'`,
      ]);
      // And the default proof refuses the net before proving anything about it.
      await expect(verifyWorkflow(mutant, { timeoutMs: 120_000 })).rejects.toThrow(`'${name}' competes with sweep`);
    }, 60_000);
  }
});

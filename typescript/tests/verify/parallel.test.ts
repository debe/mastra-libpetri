import { describe, expect, it } from 'vitest';
import { Transition, and, one, outPlace, place, type In, type Out, type Place } from 'libpetri';
import { compile, parallelGadget, type Gadget } from '../../src/compiler/index.js';
import { describeReport, verifyWorkflow, type PropertyReport } from '../../src/verify/index.js';
import type {
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

const verify = (description: WorkflowDescription, gadget: Gadget = parallelGadget) =>
  verifyWorkflow(compile(description, { gadgets: { parallel: gadget } }), { timeoutMs: 120_000 });

const verdictOf = (reports: readonly PropertyReport[], property: string): PropertyReport => {
  const report = reports.find((r) => r.property === property);
  if (report === undefined) throw new Error(`no '${property}' report`);
  return report;
};

/**
 * Every shape must come back `proven` for **both** properties, not merely un-violated.
 *
 * Initial marking: one token in the workflow's entry place. Environment: none (no environment
 * places are declared, so this is the closed net). Sinks: all five terminals — `wf.done`,
 * `wf.failed`, `wf.bailed`, `wf.suspended`, `wf.paused`. The route is whatever the verifier
 * reports, and a failed assertion prints it.
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
    it(`is deadlock-free and terminates at a declared sink: ${shape}`, async () => {
      const reports = await verify(description);

      // `proven` explicitly. `isViolated()` is false for `unknown` too, so asserting "not
      // violated" would silently pass on a query that timed out. An `unknown` is a finding.
      expect(reports.map((r) => r.property)).toEqual(['deadlockFree', 'terminatesAtSink', 'exactlyOneTerminal']);
      for (const report of reports) {
        expect(report.result.verdict.type, describeReport(report)).toBe('proven');
      }
    }, 180_000);
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
const bypass = (exit: keyof Exits): Gadget => (entry, next, ctx) =>
  parallelGadget(entry, next, {
    ...ctx,
    emitNested: (s, p, n, exits) => ctx.emitNested(s, p, n, { ...exits, [exit]: ctx.exits[exit] } as Exits),
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
  const control = verdictOf(await verify(twoArms), 'deadlockFree');
  expect(control.result.verdict.type, describeReport(control)).toBe('proven');

  const report = verdictOf(await verify(twoArms, gadget), 'deadlockFree');
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

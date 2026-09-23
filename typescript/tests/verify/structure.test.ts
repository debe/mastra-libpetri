import { describe, expect, it } from 'vitest';
import { PetriNet, Transition, one, outPlace, place, type Place } from 'libpetri';
import { compile } from '../../src/compiler/index.js';
import { cancelStructureViolations, describeReport, verifyWorkflow } from '../../src/verify/index.js';
import type { CompiledWorkflow, EntryDescription, FlowToken, WorkflowDescription } from '../../src/compiler/types.js';

/**
 * `cancelStructureViolations` — every rule, each with a net that breaks it and one that does not.
 *
 * The rules, numbered here (the source numbers only the last two):
 * 0. the cancel place and the cancel request place are in the net;
 * 1. nothing consumes (input arc) or clears (reset arc) the cancel place `wf.cancel`;
 * 2. a transition that consumes the request `wf.cancel.request` delivers the signal;
 * 3. a sweep — a transition that reads `wf.cancel` and consumes something — never competes with an
 *    ungated start: every other transition that consumes **every** place the sweep consumes is
 *    inhibited by `wf.cancel`, or is itself a sweep. One that lacks one of the sweep's inputs is
 *    left alone (the refinement: the loop's `leave-failed` shares `running` with `cancel-produced`
 *    but needs `body-failed` instead of `produced`).
 *
 * Mutants are hand-built `CompiledWorkflow`s: a compiled one-step or two-step workflow with its
 * transition set edited, nothing in `src/` touched. Every positive case asserts the exact line, so
 * a rule that fires for the wrong reason fails too.
 */

const wf = (...entries: EntryDescription[]): WorkflowDescription => ({ id: 'structure', entries });
const step = (id: string): EntryDescription => ({ kind: 'step', id });

/** `c` with its transitions edited (a `null` drops one) and `extra` added. */
function edited(
  c: CompiledWorkflow,
  edit: (t: Transition) => Transition | null = (t) => t,
  extra: readonly Transition[] = [],
  extraPlaces: readonly Place<unknown>[] = [],
): CompiledWorkflow {
  const transitions = [...[...c.net.transitions].map(edit).filter((t): t is Transition => t !== null), ...extra];
  return {
    ...c,
    net: PetriNet.builder(c.net.name)
      .places(...c.net.places, ...extraPlaces)
      .transitions(...transitions)
      .build(),
  };
}

/** Rebuilt with every arc kept, except the inhibitors or the reads when told to drop them. */
function rebuild(t: Transition, opts: { inhibitors?: boolean; reads?: boolean } = {}): Transition {
  const b = Transition.builder(t.name).inputs(...t.inputSpecs).outputs(t.outputSpec!).action(t.action).timing(t.timing).priority(t.priority);
  if (opts.reads !== false) for (const arc of t.reads) b.read(arc.place);
  for (const arc of t.resets) b.reset(arc.place);
  if (opts.inhibitors !== false) for (const arc of t.inhibitors) b.inhibitor(arc.place);
  return b.build();
}

const noop = async (): Promise<void> => {};

describe('the compiled leaf nets are sound (negative controls)', () => {
  it.each([
    ['one step', wf(step('a'))],
    ['a chain with retries', wf({ kind: 'step', id: 'a', retries: 2, retryDelayMs: 5 }, step('b'))],
    ['every sleep form', wf(
      { kind: 'sleep', id: 's1', duration: { fixed: 10 } },
      { kind: 'sleep', id: 's2', duration: { perRun: true } },
      { kind: 'sleepUntil', id: 's3', until: { fixed: 1 } },
      { kind: 'sleepUntil', id: 's4', until: { perRun: true } },
      step('z'),
    )],
  ] as const)('%s: no violation', (_label, description) => {
    expect(cancelStructureViolations(compile(description))).toEqual([]);
  });
});

describe('rule 0: both cancel places are in the net', () => {
  const base = compile(wf(step('a')));

  it('flags a cancel place the net does not contain', () => {
    const v = cancelStructureViolations({ ...base, cancel: place<null>('wf.cancel.elsewhere') });
    expect(v).toContain("the cancel place 'wf.cancel.elsewhere' is not in the net");
  });

  it('flags a cancel request place the net does not contain', () => {
    const v = cancelStructureViolations({ ...base, cancelRequest: place<null>('wf.cancel.request.elsewhere') });
    expect(v).toContain("the cancel request place 'wf.cancel.request.elsewhere' is not in the net");
  });
});

describe('rule 1: the signal is never consumed or cleared', () => {
  const base = compile(wf(step('a')));

  it('flags a transition that consumes wf.cancel', () => {
    const eat = Transition.builder('t.eat')
      .inputs(one(base.cancel))
      .outputs(outPlace(base.terminals.canceled))
      .action(noop)
      .build();
    expect(cancelStructureViolations(edited(base, undefined, [eat]))).toEqual([
      "'t.eat' consumes the cancel signal; it must only read or inhibit on it",
    ]);
  });

  it('flags a sweep rebuilt to consume the signal instead of reading it', () => {
    // `t.0.a.cancel` takes `wf.cancel` as an input: the first sweep would clear the signal for
    // every later check. It is no longer a reader, so `t.0.a.run` is not flagged against it —
    // only the consumption is.
    const mutant = edited(base, (t) =>
      t.name === 't.0.a.cancel'
        ? Transition.builder(t.name).inputs(...t.inputSpecs, one(base.cancel)).outputs(t.outputSpec!).action(t.action).build()
        : t,
    );
    expect(cancelStructureViolations(mutant)).toEqual([
      "'t.0.a.cancel' consumes the cancel signal; it must only read or inhibit on it",
    ]);
  });

  it('flags a transition that resets wf.cancel', () => {
    const clear = Transition.builder('t.clear')
      .inputs(one(base.terminals.done))
      .reset(base.cancel)
      .outputs(outPlace(base.terminals.done))
      .action(noop)
      .build();
    expect(cancelStructureViolations(edited(base, undefined, [clear]))).toEqual(["'t.clear' resets the cancel signal"]);
  });

  it('does not flag reading or inhibiting on the signal', () => {
    // Every compiled sweep reads it and every compiled start is inhibited by it (control above).
    const reader = Transition.builder('t.reader')
      .inputs(one(base.terminals.done))
      .read(base.cancel)
      .outputs(outPlace(base.terminals.done))
      .action(noop)
      .build();
    expect(cancelStructureViolations(edited(base, undefined, [reader]))).toEqual([]);
  });
});

describe('rule 2: consuming the request delivers the signal', () => {
  const base = compile(wf(step('a')));

  it('flags an arrival that consumes the request and writes somewhere else', () => {
    const mutant = edited(base, (t) =>
      t.name === 't.cancel.arrive'
        ? Transition.builder(t.name).inputs(one(base.cancelRequest)).outputs(outPlace(base.terminals.canceled)).action(noop).build()
        : t,
    );
    expect(cancelStructureViolations(mutant)).toEqual([
      "'t.cancel.arrive' consumes the cancel request without delivering the signal",
    ]);
  });

  it('flags any other transition that swallows the request', () => {
    const swallow = Transition.builder('t.swallow')
      .inputs(one(base.cancelRequest))
      .outputs(outPlace(base.terminals.done))
      .action(noop)
      .build();
    expect(cancelStructureViolations(edited(base, undefined, [swallow]))).toEqual([
      "'t.swallow' consumes the cancel request without delivering the signal",
    ]);
  });

  it('does not flag the compiled arrival, nor a second transition that also delivers', () => {
    const second = Transition.builder('t.cancel.arrive-2')
      .inputs(one(base.cancelRequest))
      .outputs(outPlace(base.cancel))
      .action(noop)
      .build();
    expect(cancelStructureViolations(base)).toEqual([]);
    expect(cancelStructureViolations(edited(base, undefined, [second]))).toEqual([]);
  });

  it('compares the delivered place by name, like every other rule', () => {
    // A place of the same NAME is the same place to the executor, so it delivers the signal. This
    // was pinned the other way while the rule compared object identity.
    const twin = place<null>('wf.cancel');
    const mutant = edited(base, (t) =>
      t.name === 't.cancel.arrive'
        ? Transition.builder(t.name).inputs(one(base.cancelRequest)).outputs(outPlace(twin)).action(noop).build()
        : t,
    );
    expect(cancelStructureViolations(mutant)).toEqual([]);
  });
});

describe('rule 3: a sweep never competes with an ungated start', () => {
  const base = compile(wf(step('a'), step('b')));
  const inA = [...base.net.places].find((p) => p.name === 's.0.a.in')! as Place<FlowToken>;

  it('flags a start that lost its inhibitor, naming it, its sweep and the contested places', () => {
    const mutant = edited(base, (t) => (t.name === 't.1.b.run' ? rebuild(t, { inhibitors: false }) : t));
    expect(cancelStructureViolations(mutant)).toEqual([
      "'t.1.b.run' competes with sweep 't.1.b.cancel' for [s.1.b.in] without an inhibitor on 'wf.cancel'",
    ]);
  });

  it('does not flag the same start with its inhibitor (the compiled net)', () => {
    expect(cancelStructureViolations(base)).toEqual([]);
  });

  it('does not flag a second sweep on the same place: two readers of the signal do not race a start', () => {
    const twin = Transition.builder('t.0.a.cancel-twin')
      .inputs(one(inA))
      .read(base.cancel)
      .outputs(outPlace(base.terminals.canceled))
      .action(noop)
      .build();
    expect(cancelStructureViolations(edited(base, undefined, [twin]))).toEqual([]);
  });

  it('flags a transition needing a strict superset of a sweep\'s inputs: whenever it can fire, it can take the sweep\'s token', () => {
    const extra = place<null>('s.0.a.extra');
    const greedy = Transition.builder('t.0.a.greedy')
      .inputs(one(inA), one(extra))
      .outputs(outPlace(base.terminals.done))
      .action(noop)
      .build();
    expect(cancelStructureViolations(edited(base, undefined, [greedy], [extra]))).toEqual([
      "'t.0.a.greedy' competes with sweep 't.0.a.cancel' for [s.0.a.in] without an inhibitor on 'wf.cancel'",
    ]);
  });

  describe('the refinement: a transition lacking one of the sweep\'s inputs is left alone', () => {
    // The loop's shape: `cancel-produced` sweeps {produced, running}; `leave-failed` consumes
    // {body-failed, running}. They share `running` but the body is either produced or failed,
    // never both, so they never compete — Mastra's `leave-X` paths return before its check.
    const produced = place<null>('s.x.produced');
    const running = place<null>('s.x.running');
    const failed = place<null>('s.x.body-failed');
    const sweep = Transition.builder('t.x.cancel-produced')
      .inputs(one(produced), one(running))
      .read(base.cancel)
      .outputs(outPlace(base.terminals.canceled))
      .action(noop)
      .build();

    it('partial overlap — shares one input, needs another the sweep does not: not flagged', () => {
      const leave = Transition.builder('t.x.leave-failed')
        .inputs(one(failed), one(running))
        .outputs(outPlace(base.terminals.failed))
        .action(noop)
        .build();
      expect(cancelStructureViolations(edited(base, undefined, [sweep, leave], [produced, running, failed]))).toEqual([]);
    });

    it('the same transition needing BOTH sweep inputs plus its own: flagged', () => {
      const leave = Transition.builder('t.x.leave-failed')
        .inputs(one(failed), one(running), one(produced))
        .outputs(outPlace(base.terminals.failed))
        .action(noop)
        .build();
      expect(cancelStructureViolations(edited(base, undefined, [sweep, leave], [produced, running, failed]))).toEqual([
        "'t.x.leave-failed' competes with sweep 't.x.cancel-produced' for [s.x.produced, s.x.running] without an inhibitor on 'wf.cancel'",
      ]);
    });

    it('flags a strict SUBSET of the sweep\'s inputs: it is enabled whenever the sweep is', () => {
      // `t.x.check` needs only `produced`; whenever the sweep is enabled so is it, and without an
      // inhibitor it can start work after the signal. This was a pinned gap while the rule tested
      // `sweep ⊆ start` only.
      const check = Transition.builder('t.x.check')
        .inputs(one(produced))
        .outputs(outPlace(base.terminals.done))
        .action(noop)
        .build();
      expect(cancelStructureViolations(edited(base, undefined, [sweep, check], [produced, running]))).toEqual([
        "'t.x.check' competes with sweep 't.x.cancel-produced' for [s.x.produced] without an inhibitor on 'wf.cancel'",
      ]);
    });
  });

  it('a read-less "sweep" is not a sweep: removing a sweep\'s read arc is invisible here (neverCanceled catches it)', () => {
    const mutant = edited(base, (t) => (t.name === 't.1.b.cancel' ? rebuild(t, { reads: false }) : t));
    expect(cancelStructureViolations(mutant)).toEqual([]);
  });
});

describe('verifyWorkflow runs the structural check first', () => {
  const description = wf(step('a'), step('b'));
  const stripped = (): CompiledWorkflow =>
    edited(compile(description), (t) => (t.name === 't.1.b.run' ? rebuild(t, { inhibitors: false }) : t));

  it('throws on a violation, listing every line, before any proof runs', async () => {
    const t0 = performance.now();
    await expect(verifyWorkflow(stripped())).rejects.toThrow(
      "cancellation structure is unsound:\n  't.1.b.run' competes with sweep 't.1.b.cancel' for [s.1.b.in] without an inhibitor on 'wf.cancel'",
    );
    // No SMT query or enumeration ran: it failed at once.
    expect(performance.now() - t0).toBeLessThan(1_000);
  });

  it('throws for a single segment too', async () => {
    await expect(verifyWorkflow(stripped(), { segments: ['closed'] })).rejects.toThrow(/cancellation structure is unsound/);
  });

  it("structure: 'skip' proves the same mutant — every proof is blind to the missing inhibitor", async () => {
    // Why the structural check exists. Properties, initial markings, segments as in
    // `verifyWorkflow`'s default; the only difference is the skipped structural check.
    const reports = await verifyWorkflow(stripped(), { structure: 'skip' });
    expect(reports.map((r) => `${r.segment}/${r.property}`)).toEqual([
      'closed/deadlockFree',
      'closed/terminatesAtSink',
      'closed/exactlyOneTerminal',
      'closed/neverCanceled',
      'cancel/deadlockFree',
      'cancel/terminatesAtSink',
      'cancel/exactlyOneTerminal',
    ]);
    for (const r of reports) expect(r.result.verdict.type, describeReport(r)).toBe('proven');
  }, 60_000);

  it('does not throw on the intact net', async () => {
    const reports = await verifyWorkflow(compile(description));
    for (const r of reports) expect(r.result.verdict.type, describeReport(r)).toBe('proven');
  }, 60_000);
});

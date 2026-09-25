import { afterAll, describe, expect, it } from 'vitest';
import { Transition, one, outPlace, place, type Place } from 'libpetri';
import {
  SmtVerifier,
  deadlockFree,
  placeBound,
  quiescentCount,
  terminatesAtSink,
  type SmtVerificationResult,
} from 'libpetri/verification';
import { compile, stepGadget, type Gadget } from '../../src/compiler/index.js';
import { HostPreconditionError } from '../../src/compiler/gadgets/leaf.js';
import { runWorkflowDetailed, type RunReport } from '../../src/engine/kernel.js';
import { describeReport, verifyWorkflow, type PropertyReport } from '../../src/verify/index.js';
import type {
  CompiledWorkflow,
  EntryDescription,
  EntrySite,
  Exits,
  FlowToken,
  ResumeSite,
  StepCall,
  StepDescription,
  StepRecord,
} from '../../src/compiler/types.js';
import { RecordingRunner, type Behaviour } from '../fixtures/runner.js';
import { ManualClock } from '../support/manual-clock.js';

/**
 * The leaf's half of a resume ([ADR 0007], contract C12), against Mastra's own source
 * (`.mastra/src-extracted/src/workflows/`):
 *
 * - `handlers/step.ts:140-142` — resume data goes to the step `resume.steps[0]` names, and only to
 *   it. Here that is position-exact: the seeded token carries `resumed`, the leaf hands the runner
 *   `StepCall.resumed`, and `carried()` never copies it to the next entry.
 * - `default.ts:455-511` — `executeStepWithRetry` re-calls with the same params, so every retry of
 *   the resumed attempt is resumed too: `RetryToken` keeps the flag.
 * - `handlers/step.ts:166-175` with `utils.ts:759-777` — the resumed call's record starts from the
 *   prior record minus the completion fields (`output`, `error`, `endedAt`, `suspendedAt`,
 *   `suspendPayload`, `suspendOutput`, `tripwire`, `nonRetryable`), writes no new `payload` or
 *   `startedAt` (`resumePayload` / `resumedAt` instead, which are the runner's), so the suspended
 *   record's input and start survive — when the runner reports `resumedAt`, i.e. the resume data
 *   was truthy. With falsy resume data it reports none, and the record is a fresh start: a new
 *   `startedAt` and the validated input as `payload` (row 82).
 * - `handlers/step.ts:145-175` — a host precondition (a truthy primitive `suspendPayload`) rejects
 *   the resume before any record or retry; the leaf routes the runner's `HostPreconditionError` to
 *   the failure exit unrecorded and unretried, and the engine turns it into the rejection (row 84).
 * - `handlers/step.ts:516-522` — a suspension stamps `suspendedAt`; the leaf now puts the same
 *   instant on the `SuspendToken`, on the run's clock ([TIME-015]).
 *
 * **How a resume is started here.** Through the kernel's own `RunOptions.resume`, at the step's
 * input place — the site a top-level step resumes at. Until the compiler registers entry sites
 * itself, {@link entrySite} registers the same place on a copy of the compiled workflow (the net,
 * program and places are the compiled ones), which is what the kernel checks by identity.
 *
 * **Proofs.** Every composite asserts every `verifyWorkflow` report `proven`, and proves the
 * resumed segment itself — `resume@[i]` from `{site: 1, permits: k}` and `resume@[i]+cancel` with
 * the cancel request seeded too — with the same property set, each asserted `proven` by name. Route:
 * whatever libpetri reports (quoted in the log below); environment closed, untimed, value-blind.
 * libpetri 6.1.0 from npm.
 */

const EPOCH = 1_700_000_000_000;
const proofLog: string[] = [];
afterAll(() => {
  if (proofLog.length > 0) console.info(`leaf-resume proofs (libpetri 6.1.0 from npm):\n  ${proofLog.join('\n  ')}`);
});

const step = (id: string, extra: Omit<StepDescription, 'kind' | 'id'> = {}): StepDescription => ({ kind: 'step', id, ...extra });
const build = (id: string, entries: readonly EntryDescription[], opts: { k?: number; gadget?: Gadget } = {}): CompiledWorkflow =>
  compile(
    { id, entries },
    {
      ...(opts.k === undefined ? {} : { concurrency: opts.k }),
      ...(opts.gadget === undefined ? {} : { gadgets: { step: opts.gadget } }),
    },
  );

/** The top-level step at `index` as a registered entry site (see the file note). */
function entrySite(compiled: CompiledWorkflow, index: number): { compiled: CompiledWorkflow; site: EntrySite } {
  const key = String(index);
  const registered = compiled.resumeSites.get(key);
  if (registered !== undefined) {
    if (registered.kind !== 'entry') throw new Error(`site ${key} is a ${registered.kind}, not an entry`);
    return { compiled, site: registered };
  }
  const entry = compiled.netMap.pathToEntry.get(key);
  if (entry === undefined || entry.kind !== 'step') throw new Error(`no top-level step at ${key}`);
  const inPlace = [...compiled.net.places].find((p) => p.name === `s.${index}.${entry.entryId}.in`);
  if (inPlace === undefined) throw new Error(`no input place for entry ${key}`);
  const site: EntrySite = { kind: 'entry', path: [index], stepId: entry.entryId, construct: 'step', place: inPlace as Place<FlowToken> };
  return { compiled: { ...compiled, resumeSites: new Map<string, ResumeSite>([...compiled.resumeSites, [key, site]]) }, site };
}

/** The instant a {@link ResumeRunner} reports as `resumedAt` — the Mastra runner's `resumedAt`. */
const RESUMED_AT = EPOCH + 7;

/**
 * A runner that also records every call's `resumed` flag and input, per attempt. By default it
 * reports every resumed call as recorded resumed (`resumedAt`), as the Mastra runner does for
 * truthy resume data; `{ recordResumed: false }` is the falsy-resume-data runner, which reports none.
 */
class ResumeRunner extends RecordingRunner {
  readonly seen: { readonly stepId: string; readonly attempt: number; readonly input: unknown; readonly resumed: boolean }[] = [];
  readonly #recordResumed: boolean;
  constructor(steps: Record<string, Behaviour> = {}, options: { readonly recordResumed?: boolean } = {}) {
    super({ steps });
    this.#recordResumed = options.recordResumed ?? true;
  }
  override async run(stepId: string, input: unknown, call: StepCall) {
    // `in`, not a truthiness test: the flag is absent on a fresh call, never `false`.
    const resumed = 'resumed' in call && call.resumed === true;
    this.seen.push({ stepId, attempt: call.attempt, input, resumed });
    const outcome = await super.run(stepId, input, call);
    return resumed && this.#recordResumed ? { ...outcome, resumedAt: RESUMED_AT } : outcome;
  }
}

/** The suspended record a step left behind — what Mastra's snapshot holds for it. */
const SUSPENDED: StepRecord = {
  status: 'suspended',
  payload: { stored: 'input' },
  suspendPayload: { ask: 'approve?' },
  suspendOutput: 'partial',
  startedAt: EPOCH - 500,
  suspendedAt: EPOCH - 400,
  host: { stale: 'host record of the suspending call' },
};

async function resume(
  compiled: CompiledWorkflow,
  index: number,
  runner: RecordingRunner,
  records: ReadonlyMap<string, StepRecord>,
  extra: { clock?: ManualClock; signal?: AbortSignal } = {},
): Promise<RunReport> {
  const { compiled: withSite, site } = entrySite(compiled, index);
  const stored = records.get(site.stepId);
  return runWorkflowDetailed(withSite, { init: true }, {
    runner,
    clock: extra.clock ?? new ManualClock(EPOCH),
    stepResults: records,
    ...(extra.signal === undefined ? {} : { signal: extra.signal }),
    // The entry colour of ADR 0007: the stored payload, marked resumed.
    resume: { site, value: { data: stored === undefined ? undefined : (stored as { payload?: unknown }).payload, resumed: true } satisfies FlowToken },
  });
}

// ---------------------------------------------------------------------------------------------
// Proofs

type Verdicts = Record<string, SmtVerificationResult>;

/**
 * The `resume@site` segment ([ADR 0007]): the property set `verifyWorkflow` proves, from
 * `{site: 1, permits: k}` — and with `cancel`, from that plus the cancel request, so the arrival may
 * land anywhere, before the gate included. The same sinks as `verifyWorkflow`.
 */
async function proveSegment(compiled: CompiledWorkflow, sitePlace: Place<unknown>, cancel: boolean, seed = 1): Promise<Verdicts> {
  const t = compiled.terminals;
  const terminals = [t.done, t.failed, t.bailed, t.suspended, t.paused, t.canceled] as const;
  const base = () =>
    SmtVerifier.forNet(compiled.net)
      .initialMarking((m) => {
        m.tokens(sitePlace, seed);
        if (cancel) m.tokens(compiled.cancelRequest, 1);
        if (compiled.budget) m.tokens(compiled.budget.permits, compiled.budget.k);
      })
      .sinkPlaces(...terminals, compiled.cancel, ...(compiled.budget ? [compiled.budget.permits] : []))
      .semiflowInvariants(true)
      .timeout(30_000);
  const out: Verdicts = {};
  out.deadlockFree = await base().property(deadlockFree()).verify();
  out.terminatesAtSink = await base().property(terminatesAtSink()).verify();
  out.exactlyOneTerminal = await base().property(quiescentCount(terminals, 1, 1)).verify();
  if (!cancel) out.neverCanceled = await base().property(placeBound(t.canceled, 0)).verify();
  if (compiled.budget) {
    out.permitsBounded = await base().property(placeBound(compiled.budget.permits, compiled.budget.k)).verify();
    out.permitsReturned = await base()
      .property(quiescentCount([compiled.budget.permits], compiled.budget.k, compiled.budget.k))
      .verify();
  }
  return out;
}

const fmt = (label: string, v: Verdicts) =>
  `${label}: ${Object.entries(v)
    .map(([p, r]) => `${p}=${r.verdict.type} via ${r.route} in ${r.elapsedMs}ms`)
    .join('; ')}`;

/** Every fresh-segment report proven, and both resumed segments at the site proven, by name. */
async function expectAllProven(label: string, compiled: CompiledWorkflow, index: number): Promise<void> {
  const reports: readonly PropertyReport[] = await verifyWorkflow(compiled);
  proofLog.push(`${label} fresh: ${reports.map(describeReport).join('; ')}`);
  const keys = reports.map((r) => `${r.segment}/${r.property}`);
  const expected = [
    'closed/deadlockFree',
    'closed/terminatesAtSink',
    'closed/exactlyOneTerminal',
    'closed/neverCanceled',
    'cancel/deadlockFree',
    'cancel/terminatesAtSink',
    'cancel/exactlyOneTerminal',
    ...(compiled.budget ? ['closed/permitsBounded', 'closed/permitsReturned', 'cancel/permitsBounded', 'cancel/permitsReturned'] : []),
  ];
  for (const key of expected) expect(keys, `${label}: ${key} reported`).toContain(key);
  for (const r of reports) expect(r.result.verdict.type, `${label}: ${describeReport(r)}`).toBe('proven');

  const { site } = entrySite(compiled, index);
  for (const cancel of [false, true]) {
    const segment = `resume@[${index}]${cancel ? '+cancel' : ''}`;
    const verdicts = await proveSegment(compiled, site.place, cancel);
    proofLog.push(fmt(`${label} ${segment}${compiled.budget ? ` k=${compiled.budget.k}` : ''}`, verdicts));
    const names = [
      'deadlockFree',
      'terminatesAtSink',
      'exactlyOneTerminal',
      ...(cancel ? [] : ['neverCanceled']),
      ...(compiled.budget ? ['permitsBounded', 'permitsReturned'] : []),
    ];
    expect(Object.keys(verdicts), `${label} ${segment}`).toEqual(names);
    for (const [p, r] of Object.entries(verdicts)) expect(r.verdict.type, `${label} ${segment}/${p} via ${r.route}`).toBe('proven');
  }
}

// ---------------------------------------------------------------------------------------------

describe('leaf resume: the resumed attempt is marked, and nothing after it is', () => {
  const chain = [step('a'), step('b'), step('c')];

  it('proves the chain fresh and resumed at [1], with and without a cancel', async () => {
    await expectAllProven('a;b;c', build('chain', chain), 1);
  }, 120_000);

  it('hands the runner resumed on the site step only, fed the stored payload; the next step runs fresh', async () => {
    const runner = new ResumeRunner({ b: () => ({ status: 'success', output: 'approved' }) });
    const records = new Map<string, StepRecord>([
      ['a', { status: 'success', payload: { init: true }, output: { stored: 'input' }, startedAt: EPOCH - 900, endedAt: EPOCH - 800 }],
      ['b', SUSPENDED],
    ]);
    const report = await resume(build('chain', chain), 1, runner, records);

    expect(report.outcome).toEqual({ status: 'success', output: 'approved' });
    expect(runner.seen).toEqual([
      { stepId: 'b', attempt: 0, input: { stored: 'input' }, resumed: true },
      // `carried()` dropped it: `c` is not the step `resume.steps[0]` names.
      { stepId: 'c', attempt: 0, input: 'approved', resumed: false },
    ]);
    // `a` never re-ran; its record is carried untouched.
    expect(report.stepResults.get('a')).toEqual(records.get('a'));
  });

  it('keeps resumed on every retry of the resumed attempt (default.ts:455-511)', async () => {
    let calls = 0;
    const runner = new ResumeRunner({
      b: () => (++calls < 3 ? { status: 'failed', error: `try ${calls}` } : { status: 'success', output: 'third time' }),
    });
    const clock = new ManualClock(EPOCH);
    const report = await resume(build('retry', [step('a'), step('b', { retries: 2, retryDelayMs: 10 }), step('c')]), 1, runner, new Map([['b', SUSPENDED]]), { clock });

    expect(report.outcome).toEqual({ status: 'success', output: 'third time' });
    expect(runner.seen).toEqual([
      { stepId: 'b', attempt: 0, input: { stored: 'input' }, resumed: true },
      { stepId: 'b', attempt: 1, input: { stored: 'input' }, resumed: true },
      { stepId: 'b', attempt: 2, input: { stored: 'input' }, resumed: true },
      { stepId: 'c', attempt: 0, input: 'third time', resumed: false },
    ]);
    // Still the suspended record's start, across both retry waits: a resumed attempt takes none.
    expect(report.stepResults.get('b')).toEqual({ status: 'success', output: 'third time', payload: { stored: 'input' }, startedAt: EPOCH - 500, endedAt: EPOCH + 20 });
  });

  it('proves the retrying chain resumed at [1] too (a timed retry hop behind the site)', async () => {
    await expectAllProven('a;b(retries 2, 10ms);c', build('retry', [step('a'), step('b', { retries: 2, retryDelayMs: 10 }), step('c')]), 1);
  }, 120_000);

  it('a fresh run marks no call resumed', async () => {
    const runner = new ResumeRunner();
    const report = await runWorkflowDetailed(build('chain', chain), 'x', { runner, clock: new ManualClock(EPOCH) });
    expect(report.outcome).toEqual({ status: 'success', output: 'x' });
    expect(runner.seen.map((s) => s.resumed)).toEqual([false, false, false]);
  });
});

describe('leaf resume: the resumed record (handlers/step.ts:166-175, utils.ts:759-777)', () => {
  it('starts from the suspended record minus its completion fields: payload and startedAt kept, host dropped', async () => {
    const clock = new ManualClock(EPOCH);
    const runner = new ResumeRunner({ b: () => ({ status: 'success', output: 'done' }) });
    const report = await resume(build('one', [step('b')]), 0, runner, new Map([['b', SUSPENDED]]), { clock });

    // Exactly: no `suspendPayload`, `suspendOutput`, `suspendedAt` or stale `host` survive, and
    // `payload` / `startedAt` are the suspended call's — not this call's input or instant.
    expect(report.stepResults.get('b')).toEqual({
      status: 'success',
      output: 'done',
      payload: { stored: 'input' },
      startedAt: EPOCH - 500,
      endedAt: EPOCH,
    });
  });

  it('keeps the stored payload even when the runner reports a validated one (Mastra writes resumePayload instead)', async () => {
    const runner = new ResumeRunner({ b: () => ({ status: 'success', output: 'done', payload: { validated: true } }) });
    const report = await resume(build('one', [step('b')]), 0, runner, new Map([['b', SUSPENDED]]));
    expect(report.stepResults.get('b')).toMatchObject({ payload: { stored: 'input' }, startedAt: EPOCH - 500 });
  });

  it('keeps the fields a completion does not own — metadata included — and takes the new host', async () => {
    const prior: StepRecord = { ...SUSPENDED, metadata: { foreachIndex: 7 } };
    const runner = new ResumeRunner({ b: () => ({ status: 'failed', error: 'no', nonRetryable: true, host: { fresh: true } }) });
    const report = await resume(build('one', [step('b')]), 0, runner, new Map([['b', prior]]));
    expect(report.stepResults.get('b')).toEqual({
      status: 'failed',
      error: 'no',
      nonRetryable: true,
      host: { fresh: true },
      payload: { stored: 'input' },
      startedAt: EPOCH - 500,
      endedAt: EPOCH,
      metadata: { foreachIndex: 7 },
    });
  });

  it('writes no startedAt when the suspended record had none, as Mastra stamps none on a resume', async () => {
    const { startedAt: _dropped, ...noStart } = SUSPENDED as StepRecord & { startedAt?: number };
    const runner = new ResumeRunner({ b: () => ({ status: 'success', output: 'done' }) });
    const report = await resume(build('one', [step('b')]), 0, runner, new Map([['b', noStart as StepRecord]]));
    const rec = report.stepResults.get('b');
    expect(rec).toEqual({ status: 'success', output: 'done', payload: { stored: 'input' }, endedAt: EPOCH });
    expect(rec !== undefined && Object.hasOwn(rec, 'startedAt')).toBe(false);
  });

  it('suspends again: new suspendPayload and suspendedAt, the stored payload and start kept, no endedAt', async () => {
    const clock = new ManualClock(EPOCH + 1_000);
    const runner = new ResumeRunner({ b: () => ({ status: 'suspended', suspendPayload: { ask: 'again?' } }) });
    const report = await resume(build('two', [step('a'), step('b'), step('c')]), 1, runner, new Map([['b', SUSPENDED]]), { clock });

    expect(report.outcome).toEqual({ status: 'suspended', stepId: 'b', path: [1], payload: { ask: 'again?' } });
    expect(report.stepResults.get('b')).toEqual({
      status: 'suspended',
      suspendPayload: { ask: 'again?' },
      payload: { stored: 'input' },
      startedAt: EPOCH - 500,
      suspendedAt: EPOCH + 1_000,
    });
    expect(runner.seen.map((s) => s.stepId)).toEqual(['b']);
  });

  it('a fresh call over an earlier record under the same id is unchanged: its own payload and start', async () => {
    const clock = new ManualClock(EPOCH);
    const runner = new ResumeRunner({ b: () => ({ status: 'success', output: 'o' }) });
    const report = await runWorkflowDetailed(build('fresh', [step('b')]), 'in', { runner, clock, stepResults: new Map([['b', SUSPENDED]]) });
    expect(report.stepResults.get('b')).toEqual({ status: 'success', output: 'o', payload: 'in', startedAt: EPOCH, endedAt: EPOCH });
  });
});

describe('leaf resume: suspendedAt is stamped on every suspension token, on the run clock', () => {
  /**
   * Exposes the raw exit tokens of a one-step workflow: every exit — success included — goes to a
   * probe place, and a probe forwards the token itself to `next` as data.
   */
  const probing: Gadget = (entry, next, ctx) => {
    const kinds = ['next', 'failed', 'bailed', 'suspended', 'paused'] as const;
    const probes = Object.fromEntries(kinds.map((k) => [k, place<unknown>(`probe.${k}`)])) as Record<(typeof kinds)[number], Place<unknown>>;
    const { next: probeNext, ...exitProbes } = probes;
    const result = stepGadget(entry, probeNext as Place<FlowToken>, {
      ...ctx,
      exits: { ...(exitProbes as unknown as Exits), canceled: ctx.exits.canceled },
    });
    const forward = kinds.map((k) =>
      Transition.builder(`t.probe.${k}`)
        .inputs(one(probes[k]))
        .outputs(outPlace(next))
        .action(async (tctx) => {
          tctx.output(next, { data: { exit: k, token: tctx.input(probes[k]) } });
        })
        .build(),
    );
    return { ...result, transitions: [...result.transitions, ...forward] };
  };

  it('a fresh suspension: the token carries the record\'s own suspendedAt', async () => {
    const clock = new ManualClock(EPOCH + 42);
    const report = await runWorkflowDetailed(build('probe', [step('s')], { gadget: probing }), 'in', {
      runner: new ResumeRunner({ s: () => ({ status: 'suspended', suspendPayload: 'p' }) }),
      clock,
    });
    expect(report.outcome).toEqual({
      status: 'success',
      output: { exit: 'suspended', token: { stepId: 's', path: [0], payload: 'p', suspendedAt: EPOCH + 42 } },
    });
    expect(report.stepResults.get('s')).toMatchObject({ status: 'suspended', suspendedAt: EPOCH + 42 });
  });

  it('a resumed suspension after a retry wait: stamped when it suspended, not when the attempt began', async () => {
    let calls = 0;
    const clock = new ManualClock(EPOCH);
    const report = await resume(
      build('probe', [step('s', { retries: 1, retryDelayMs: 250 })], { gadget: probing }),
      0,
      new ResumeRunner({ s: () => (++calls === 1 ? { status: 'failed', error: 'x' } : { status: 'suspended', suspendPayload: 'again' }) }),
      new Map([['s', { ...SUSPENDED }]]),
      { clock },
    );
    expect(report.outcome).toEqual({
      status: 'success',
      output: { exit: 'suspended', token: { stepId: 's', path: [0], payload: 'again', suspendedAt: EPOCH + 250 } },
    });
  });

  it('the success token a resumed attempt writes carries no resumed flag', async () => {
    const report = await resume(
      build('probe', [step('s')], { gadget: probing }),
      0,
      new ResumeRunner({ s: () => ({ status: 'success', output: 'ok' }) }),
      new Map([['s', SUSPENDED]]),
    );
    // `toEqual` on the whole token: a `resumed` key, even `undefined`, would fail it.
    expect(report.outcome).toEqual({ status: 'success', output: { exit: 'next', token: { data: 'ok' } } });
    const token = (report.outcome as { output: { token: object } }).output.token;
    expect(Object.hasOwn(token, 'resumed')).toBe(false);
  });

  it('only the suspended exit is stamped: failure, bail and pause tokens are unchanged', async () => {
    const outcomes = [
      [{ status: 'failed', error: 'e', nonRetryable: true }, { exit: 'failed', token: { stepId: 's', path: [0], error: 'e', nonRetryable: true } }],
      [{ status: 'bailed', output: 'b' }, { exit: 'bailed', token: { stepId: 's', path: [0], output: 'b' } }],
      [{ status: 'paused' }, { exit: 'paused', token: { stepId: 's', path: [0] } }],
    ] as const;
    for (const [outcome, expected] of outcomes) {
      const report = await runWorkflowDetailed(build('probe', [step('s')], { gadget: probing }), 'in', {
        runner: new ResumeRunner({ s: () => outcome }),
        clock: new ManualClock(EPOCH),
      });
      expect(report.outcome).toEqual({ status: 'success', output: expected });
    }
  });
});

describe('leaf resume: cancellation and the budget', () => {
  it('a resume already aborted is swept at the site: nothing runs, the suspended record stays', async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = new ResumeRunner();
    const report = await resume(build('chain', [step('a'), step('b'), step('c')]), 1, runner, new Map([['b', SUSPENDED]]), {
      signal: controller.signal,
    });
    expect(report.outcome).toEqual({ status: 'canceled', origin: { stepId: 'b', path: [1] }, started: false });
    expect(runner.seen).toEqual([]);
    expect(report.stepResults.get('b')).toEqual(SUSPENDED);
  });

  it.each([1, 2])('at k=%i the resumed step holds a permit and hands it back (proven and run)', async (k) => {
    const compiled = build(`k${k}`, [step('a'), step('b'), step('c')], { k });
    await expectAllProven(`a;b;c at k=${k}`, compiled, 1);
    const runner = new ResumeRunner({ b: () => ({ status: 'success', output: 'ok' }) });
    const report = await resume(compiled, 1, runner, new Map([['b', SUSPENDED]]));
    // `classify` reports any permit count other than k at rest as residue.
    expect(report.outcome).toEqual({ status: 'success', output: 'ok' });
    expect(runner.seen.map((s) => [s.stepId, s.resumed])).toEqual([
      ['b', true],
      ['c', false],
    ]);
  }, 120_000);

  it('non-vacuity: the same queries see a doubled seed at the site (exactlyOneTerminal violated)', async () => {
    // Guards the segment helper, not the leaf: a proof that could not fail from a wrong marking
    // would say nothing about the right one.
    const compiled = build('chain', [step('a'), step('b'), step('c')]);
    const { site } = entrySite(compiled, 1);
    const verdicts = await proveSegment(compiled, site.place, false, 2);
    proofLog.push(fmt('a;b;c resume@[1] seeded twice (mutant marking)', verdicts));
    expect(verdicts.exactlyOneTerminal?.verdict.type).toBe('violated');
  }, 60_000);
});

describe('leaf resume: falsy resume data is recorded as a fresh start (handlers/step.ts:166-175, row 82)', () => {
  // The runner reports no `resumedAt` when the resume data is falsy: the attempt is still the
  // resumed one (it is fed the data), but Mastra's record is a fresh start.
  it('a new startedAt on the run clock and the validated input as payload; the prior fields a completion does not own kept', async () => {
    const clock = new ManualClock(EPOCH + 3_000);
    const prior: StepRecord = { ...SUSPENDED, metadata: { iterationCount: 2 } };
    const runner = new ResumeRunner({ b: () => ({ status: 'success', output: 'done', payload: { validated: true } }) }, { recordResumed: false });
    const report = await resume(build('one', [step('b')]), 0, runner, new Map([['b', prior]]), { clock });
    expect(runner.seen).toStrictEqual([{ stepId: 'b', attempt: 0, input: { stored: 'input' }, resumed: true }]);
    expect(report.stepResults.get('b')).toStrictEqual({
      status: 'success',
      output: 'done',
      payload: { validated: true },
      startedAt: EPOCH + 3_000,
      endedAt: EPOCH + 3_000,
      metadata: { iterationCount: 2 },
    });
  });

  it('with no payload reported, the token data (the stored input) is the payload', async () => {
    const clock = new ManualClock(EPOCH + 3_000);
    const runner = new ResumeRunner({ b: () => ({ status: 'success', output: 'done' }) }, { recordResumed: false });
    const report = await resume(build('one', [step('b')]), 0, runner, new Map([['b', SUSPENDED]]), { clock });
    expect(report.stepResults.get('b')).toStrictEqual({ status: 'success', output: 'done', payload: { stored: 'input' }, startedAt: EPOCH + 3_000, endedAt: EPOCH + 3_000 });
  });

  it('a retried falsy resume keeps the first attempt\'s start across the waits, as Mastra stamps before its retry loop', async () => {
    let calls = 0;
    const runner = new ResumeRunner(
      { b: () => (++calls < 3 ? { status: 'failed', error: `try ${calls}` } : { status: 'success', output: 'third time', payload: 'v' }) },
      { recordResumed: false },
    );
    const clock = new ManualClock(EPOCH);
    const report = await resume(build('retry', [step('a'), step('b', { retries: 2, retryDelayMs: 10 }), step('c')]), 1, runner, new Map([['b', SUSPENDED]]), { clock });
    expect(runner.seen.map((c) => [c.stepId, c.attempt, c.resumed])).toStrictEqual([
      ['b', 0, true],
      ['b', 1, true],
      ['b', 2, true],
      ['c', 0, false],
    ]);
    expect(report.stepResults.get('b')).toStrictEqual({ status: 'success', output: 'third time', payload: 'v', startedAt: EPOCH, endedAt: EPOCH + 20 });
  });

  it('the resumedAt a runner reports is never written into the record', async () => {
    const runner = new ResumeRunner({ b: () => ({ status: 'success', output: 'done' }) });
    const report = await resume(build('one', [step('b')]), 0, runner, new Map([['b', SUSPENDED]]));
    expect(report.stepResults.get('b')).not.toHaveProperty('resumedAt');
  });
});

describe('leaf: a host precondition refusal leaves by the failure branch, unrecorded and unretried', () => {
  const refusing = (cause: unknown) => (_input: unknown, call: StepCall) => {
    throw new HostPreconditionError('b', call.path, cause);
  };

  for (const k of [undefined, 1]) {
    for (const signalled of [false, true]) {
      const label = `${k === undefined ? 'unbounded' : `k=${k}`}${signalled ? ', under an abort signal' : ''}`;
      it(`${label}: the run fails with the marker, the step is called once, its stored record stays, nothing is stranded`, async () => {
        const cause = new TypeError("Cannot use 'in' operator to search for '__workflow_meta' in why?");
        const runner = new ResumeRunner({ b: refusing(cause) });
        const compiled = build(`pre${k ?? ''}`, [step('a'), step('b', { retries: 2 }), step('c')], k === undefined ? {} : { k });
        // Under a signal the executor does not end at quiescence: a thrown action would strand the
        // token and the run would never end. It ends here because the refusal reaches a terminal.
        const report = await resume(compiled, 1, runner, new Map([['b', SUSPENDED]]), signalled ? { signal: new AbortController().signal } : {});
        expect(runner.seen).toStrictEqual([{ stepId: 'b', attempt: 0, input: { stored: 'input' }, resumed: true }]);
        expect(report.outcome).toMatchObject({ status: 'failed', stepId: 'b', path: [1] });
        // No residue key: the permit came back and no token was left.
        expect(Object.keys(report.outcome).sort()).toStrictEqual(['error', 'path', 'status', 'stepId']);
        const error = (report.outcome as { error: unknown }).error;
        expect(error).toBeInstanceOf(HostPreconditionError);
        expect((error as HostPreconditionError).cause).toBe(cause);
        expect((error as Error).message).toBe(`the host refused step 'b' at [1] before it ran: ${cause.message}`);
        expect(report.stepResults.get('b')).toStrictEqual(SUSPENDED);
      });
    }
  }

  it('non-vacuity: any other runner throw is still a failed, retried, recorded step', async () => {
    const runner = new ResumeRunner({
      b: () => {
        throw new TypeError('ordinary');
      },
    });
    const report = await resume(build('ordinary', [step('b', { retries: 1 })]), 0, runner, new Map([['b', SUSPENDED]]), { clock: new ManualClock(EPOCH) });
    expect(runner.seen.map((c) => c.attempt)).toStrictEqual([0, 1]);
    expect(report.outcome).toMatchObject({ status: 'failed', stepId: 'b', path: [0] });
    expect((report.outcome as { error: unknown }).error).not.toBeInstanceOf(HostPreconditionError);
    expect(report.stepResults.get('b')).toMatchObject({ status: 'failed', payload: { stored: 'input' }, startedAt: EPOCH });
  });

  it('the marker keeps the step id, the path and the cause', () => {
    const error = new HostPreconditionError('s', [2, 1], 'why?');
    expect(error.name).toBe('HostPreconditionError');
    expect(error).toMatchObject({ stepId: 's', path: [2, 1], cause: 'why?' });
    expect(error.message).toBe(`the host refused step 's' at [2, 1] before it ran: "why?"`);
  });
});

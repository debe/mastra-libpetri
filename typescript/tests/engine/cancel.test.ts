import { afterAll, describe, expect, it } from 'vitest';
import { Marking, PetriNet, PrecompiledNet, Transition, and, one, outPlace, place, tokenOf, type Place, type Token } from 'libpetri';
import { compile, sleepGadget, stepGadget, type Gadget } from '../../src/compiler/index.js';
import { classify, runWorkflow, runWorkflowDetailed } from '../../src/engine/index.js';
import {
  cancelStructureViolations,
  describeReport,
  resumeGateViolations,
  segmentLabel,
  segmentsFor,
  verifyWorkflow,
  type PropertyReport,
  type VerifyOptions,
} from '../../src/verify/index.js';
import type {
  CanceledToken,
  CompiledWorkflow,
  FlowToken,
  StepCall,
  StepOutcome,
  StepRecord,
  SuspendToken,
  WorkflowDescription,
} from '../../src/compiler/types.js';
import { RecordingRunner, type Behaviour } from '../fixtures/runner.js';
import { ManualClock } from '../support/manual-clock.js';

/**
 * Cancellation, tested against Mastra's own source (`.mastra/src-extracted/src/workflows/`):
 *
 * - `default.ts:814-815` — before each top-level entry: `if (abortController.signal.aborted)` ends
 *   the run `canceled` without starting the entry.
 * - `handlers/entry.ts:810-817` — after each top-level entry: the step's record is stored first
 *   (`stepResults[id] = execResults`), then *any* result is re-stamped `canceled` if the signal
 *   fired. So the run is canceled and the record keeps its real outcome.
 * - `default.ts:455-460` — `executeStepWithRetry` never looks at the signal: a retry, and the
 *   plain `setTimeout` delay before it, run after an abort.
 * - `handlers/step.ts:420-421,450` — a step receives `abort()`, which aborts the run's own
 *   controller, and `abortSignal`, the run's signal. The step is never interrupted from outside.
 * - `handlers/entry.ts:641-643,752-754` — a sleep cut short by the signal (`abortableSleep`,
 *   `utils.ts:230-250`) writes **no** step result and re-stamps the entry `canceled`.
 *
 * Every run outcome is asserted with `toEqual`, so residue — a token left anywhere but the one
 * reported terminal and the cancel place — fails the test.
 */

const EPOCH = 1_700_000_000_000;

const chain: WorkflowDescription = {
  id: 'c',
  entries: [
    { kind: 'step', id: 'a' },
    { kind: 'step', id: 'b', retries: 1, retryDelayMs: 5 },
    { kind: 'sleep', id: 'nap', duration: { fixed: 60_000 } },
    { kind: 'step', id: 'c' },
  ],
};
const steps3: WorkflowDescription = {
  id: 's3',
  entries: [{ kind: 'step', id: 'a' }, { kind: 'step', id: 'b' }, { kind: 'step', id: 'c' }],
};

const rec = (fields: Record<string, unknown>): unknown => ({
  ...fields,
  startedAt: expect.any(Number),
  endedAt: expect.any(Number),
});

/**
 * What a Mastra step sees of cancellation: `abort()` aborts the **run's own** controller
 * (`handlers/step.ts:420-421`), `abortSignal` is that controller's signal (`:450`). A runner the
 * adapter builds per run closes over the run's controller exactly so.
 */
interface StepAbort {
  readonly abort: () => void;
  readonly abortSignal: AbortSignal;
}
type MastraBehaviour = (input: unknown, call: StepCall, ctx: StepAbort) => StepOutcome | Promise<StepOutcome>;

function mastraLikeRunner(controller: AbortController, behaviours: Record<string, MastraBehaviour>): RecordingRunner {
  const ctx: StepAbort = { abort: () => controller.abort(), abortSignal: controller.signal };
  return new RecordingRunner({
    steps: Object.fromEntries(
      Object.entries(behaviours).map(([id, b]): [string, Behaviour] => [id, (input, call) => b(input, call, ctx)]),
    ),
  });
}

/** Each record as `id:status`, in insertion order — a waiting sleep and a finished one differ. */
function statuses(rep: { readonly stepResults: ReadonlyMap<string, StepRecord> }): string[] {
  return [...rep.stepResults].map(([id, record]) => `${id}:${record.status}`);
}

/** Resolves on abort — what a well-behaved step does with its `abortSignal`. */
function abortedOrAfter(signal: AbortSignal, ms: number): Promise<'aborted' | 'elapsed'> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve('aborted');
    const timer = setTimeout(() => resolve('elapsed'), ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve('aborted')), { once: true });
  });
}

// ---------------------------------------------------------------------------------------------
// Proof bookkeeping: every verdict with its route and time, printed once at the end.

const proofLog: string[] = [];
afterAll(() => {
  if (proofLog.length > 0) console.info(`[cancel.test proofs]\n${proofLog.join('\n')}`);
});

/** The fresh segments' reports, keyed `segment/property`: pinned literally, never derived. */
const FRESH_PROVEN = {
  'closed/deadlockFree': 'proven',
  'closed/terminatesAtSink': 'proven',
  'closed/exactlyOneTerminal': 'proven',
  'closed/neverCanceled': 'proven',
  'cancel/deadlockFree': 'proven',
  'cancel/terminatesAtSink': 'proven',
  'cancel/exactlyOneTerminal': 'proven',
} as const;

/**
 * The segments this file proves: `verifyWorkflow`'s default with the restart segments left out —
 * the fresh segments, then `resume@s` and `resume@s+cancel` for every registered site ([ADR 0007]).
 * The restart segments ([ADR 0010]) are `tests/verify/restart-segments.test.ts`'s; leaving them out
 * keeps every mutant's pinned flips about the fresh and resumed runs this file reasons over.
 */
const SEGMENTS = { restart: 'none' } as const satisfies VerifyOptions;

/**
 * Every report `verifyWorkflow` returns for `compiled` under {@link SEGMENTS}, keyed
 * `segment/property`, each `proven`. The keys come from `segmentsFor`/`segmentLabel` — never by
 * dropping keys — and `neverCanceled` is proven only where no cancel arrives. None of these shapes
 * compiles a budget.
 */
function allProven(compiled: CompiledWorkflow): Record<string, 'proven'> {
  expect(compiled.budget).toBeUndefined();
  const keys = segmentsFor(compiled, SEGMENTS).flatMap((segment) => {
    const cancels = typeof segment === 'string' ? segment === 'cancel' : segment.cancel;
    return ['deadlockFree', 'terminatesAtSink', 'exactlyOneTerminal', ...(cancels ? [] : ['neverCanceled'])].map(
      (property) => `${segmentLabel(segment)}/${property}`,
    );
  });
  const all = Object.fromEntries(keys.map((key): [string, 'proven'] => [key, 'proven']));
  // The fresh half is exactly the literal set, first, so the derivation cannot drift unseen.
  expect(keys.slice(0, Object.keys(FRESH_PROVEN).length)).toStrictEqual(Object.keys(FRESH_PROVEN));
  expect(keys).toHaveLength(Object.keys(FRESH_PROVEN).length + 7 * compiled.resumeSites.size);
  return all;
}

/**
 * Proves with `verifyWorkflow` under {@link SEGMENTS}: the structural checks (they throw on a
 * violation), then both fresh segments and both resume segments of every site, on the one closed net. Returns
 * every verdict keyed `segment/property`, in the order `segmentsFor` gives.
 */
async function prove(label: string, compiled: CompiledWorkflow, options: VerifyOptions = {}): Promise<Record<string, string>> {
  const t0 = performance.now();
  const reports: readonly PropertyReport[] = await verifyWorkflow(compiled, { ...SEGMENTS, ...options });
  const ms = Math.round(performance.now() - t0);
  proofLog.push(`${label} (${ms}ms): ${reports.map(describeReport).join('; ')}`);
  const keyed = reports.map((r) => `${segmentLabel(r.segment)}/${r.property}`);
  expect(keyed).toStrictEqual(Object.keys(allProven(compiled)));
  return Object.fromEntries(reports.map((r) => [`${segmentLabel(r.segment)}/${r.property}`, r.result.verdict.type]));
}

/** Every verdict `proven`, stated explicitly — never "not violated", which passes on `unknown`. */
async function expectProven(label: string, compiled: CompiledWorkflow): Promise<void> {
  expect(await prove(label, compiled), label).toStrictEqual(allProven(compiled));
}

/** The keys `property` in each of `segments`, each `violated`: the exact flips a mutant causes. */
function violated(segments: readonly string[], ...properties: readonly string[]): Record<string, 'violated'> {
  return Object.fromEntries(segments.flatMap((seg) => properties.map((p): [string, 'violated'] => [`${seg}/${p}`, 'violated'])));
}

// ---------------------------------------------------------------------------------------------
// Mutation helpers: every mutant is built outside `src/`, through the gadget override or by
// rebuilding the compiled net.

function rebuilt(t: Transition, options: { dropInhibitors?: boolean; priority?: number } = {}): Transition {
  const b = Transition.builder(t.name)
    .inputs(...t.inputSpecs)
    .timing(t.timing)
    .action(t.action)
    .priority(options.priority ?? t.priority);
  if (t.outputSpec !== null) b.outputs(t.outputSpec);
  for (const arc of t.reads) b.read(arc.place);
  for (const arc of t.resets) b.reset(arc.place);
  if (options.dropInhibitors !== true) for (const arc of t.inhibitors) b.inhibitor(arc.place);
  return b.build();
}

/**
 * A hand-built `CompiledWorkflow`: the same places, terminals and cancel place, an edited net —
 * and that net's own `program`. The executor runs `program` and never looks at `net` when one is
 * given, so keeping the original's would run the unmutated net and pass every mutant vacuously.
 */
function withTransitions(c: CompiledWorkflow, edit: (t: Transition) => Transition | null): CompiledWorkflow {
  const transitions = [...c.net.transitions].map(edit).filter((t): t is Transition => t !== null);
  const net = PetriNet.builder(c.net.name).places(...c.net.places).transitions(...transitions).build();
  return { ...c, net, program: PrecompiledNet.compile(net) };
}

const withoutSweep =
  (inner: Gadget): Gadget =>
  (entry, next, ctx) => {
    const r = inner(entry, next, ctx);
    return { ...r, transitions: r.transitions.filter((t) => !t.name.endsWith('.cancel')) };
  };

/**
 * `inner`, with every transition whose name ends in `suffix` rebuilt without its inhibitors — the
 * lead's pattern — at `priority`, so the stripped start wins the race it now has with the sweep
 * and a run observes what the inhibitor excluded rather than an executor tie-break.
 */
function strip(inner: Gadget, suffix: string, priority?: number): Gadget {
  return (entry, next, ctx) => {
    const r = inner(entry, next, ctx);
    return {
      ...r,
      transitions: r.transitions.map((t) =>
        t.name.endsWith(suffix) ? rebuilt(t, { dropInhibitors: true, ...(priority === undefined ? {} : { priority }) }) : t,
      ),
    };
  };
}

/** Rebuilt without its read arcs: a sweep that no longer waits for the signal. */
function withoutReads(t: Transition): Transition {
  const b = Transition.builder(t.name).inputs(...t.inputSpecs).timing(t.timing).action(t.action).priority(t.priority);
  if (t.outputSpec !== null) b.outputs(t.outputSpec);
  for (const arc of t.resets) b.reset(arc.place);
  for (const arc of t.inhibitors) b.inhibitor(arc.place);
  return b.build();
}

/**
 * The first attempt's inhibitor removed. With it gone the run and the sweep conflict on the
 * waiting token; `priority(1)` makes the run win that race deterministically, so the test
 * observes what the inhibitor excludes rather than an executor's tie-break.
 */
const withoutFirstInhibitor: Gadget = (entry, next, ctx) => {
  const r = stepGadget(entry, next, ctx);
  return {
    ...r,
    transitions: r.transitions.map((t) => (t.name.endsWith('.run') ? rebuilt(t, { dropInhibitors: true, priority: 1 }) : t)),
  };
};

// ---------------------------------------------------------------------------------------------

describe('a run with no signal, or a signal that never fires', () => {
  it('no signal: success, every record carries its payload and timestamps', async () => {
    const clock = new ManualClock(EPOCH);
    const rep = await runWorkflowDetailed(compile(chain), 'in', { runner: new RecordingRunner(), clock });
    expect(rep.outcome).toEqual({ status: 'success', output: 'in' });
    expect([...rep.stepResults]).toEqual([
      ['a', rec({ status: 'success', output: 'in', payload: 'in' })],
      ['b', rec({ status: 'success', output: 'in', payload: 'in' })],
      ['nap', rec({ status: 'success', output: 'in', payload: 'in' })],
      ['c', rec({ status: 'success', output: 'in', payload: 'in' })],
    ]);
    expect(rep.stepResults.get('c')).toMatchObject({ startedAt: EPOCH + 60_000 });
  });

  it('a signal that never fires: success and failure both end at the terminal (drain), not at the timeout', async () => {
    const ac = new AbortController();
    const t0 = performance.now();
    expect(
      await runWorkflow(compile(chain), 'v', { runner: new RecordingRunner(), signal: ac.signal, clock: new ManualClock(), timeoutMs: 20_000 }),
    ).toEqual({ status: 'success', output: 'v' });
    const r = new RecordingRunner({ a: () => ({ status: 'failed', error: 'no', nonRetryable: true }) });
    expect(await runWorkflow(compile(chain), 1, { runner: r, signal: ac.signal, timeoutMs: 20_000 })).toEqual({
      status: 'failed',
      stepId: 'a',
      path: [0],
      error: 'no',
    });
    const s = new RecordingRunner({ b: () => ({ status: 'suspended', suspendPayload: 'p' }) });
    expect(await runWorkflow(compile(chain), 1, { runner: s, signal: ac.signal, timeoutMs: 20_000 })).toEqual({
      status: 'suspended',
      stepId: 'b',
      path: [1],
      payload: 'p',
    });
    // An executor with an environment place does not end at quiescence ([ENV-010]); these ended
    // because a terminal was marked, well inside the 20s budget.
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
});

describe('before an entry starts (default.ts:814-815)', () => {
  it('aborted before the run began: canceled at the first entry, nothing runs, nothing is recorded', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = new RecordingRunner();
    const clock = new ManualClock();
    const rep = await runWorkflowDetailed(compile(chain), 1, { runner: r, signal: ac.signal, clock });
    expect(rep.outcome).toEqual({ status: 'canceled', origin: { stepId: 'a', path: [0] }, started: false });
    expect(r.calls).toEqual([]);
    expect(rep.stepResults.size).toBe(0);
    expect(clock.elapsed()).toBe(0);
  });

  it.each([
    ['a per-run sleep', { kind: 'sleep', id: 'nap', duration: { perRun: true } }],
    ['a per-run sleepUntil', { kind: 'sleepUntil', id: 'nap', until: { perRun: true } }],
  ] as const)('aborted before the run began, %s first: its wait fn is never called, nothing is recorded', async (_label, sleep) => {
    const ac = new AbortController();
    ac.abort();
    let waits = 0;
    const r = new RecordingRunner({ waits: { nap: () => (waits++, 10) } });
    const rep = await runWorkflowDetailed(compile({ id: 'pre', entries: [sleep, { kind: 'step', id: 'z' }] }), 1, {
      runner: r,
      signal: ac.signal,
    });
    // `default.ts:815` checks before the sleep entry, so `handlers/sleep.ts:83-128` never runs the fn.
    expect(rep.outcome).toEqual({ status: 'canceled', origin: { stepId: 'nap', path: [0] }, started: false });
    expect(waits, 'the sleep fn ran after the abort').toBe(0);
    expect(rep.stepResults.size).toBe(0);
  });

  it('aborted before the run began, with carried-in step results: they are kept, untouched, and nothing is added', async () => {
    const ac = new AbortController();
    ac.abort();
    const prior: StepRecord = { status: 'suspended', suspendPayload: 'p', suspendOutput: 'draft', payload: 'in', startedAt: 1, suspendedAt: 2 };
    const stepResults = new Map<string, StepRecord>([['a', { status: 'success', output: 'A', payload: 'in' }], ['b', prior]]);
    const r = new RecordingRunner();

    const rep = await runWorkflowDetailed(compile(chain), 'in', { runner: r, signal: ac.signal, stepResults });

    // Mastra persists the `stepResults` it was resumed with and returns canceled (`default.ts:815-830`).
    expect(rep.outcome).toEqual({ status: 'canceled', origin: { stepId: 'a', path: [0] }, started: false });
    expect(r.calls).toEqual([]);
    expect([...rep.stepResults]).toEqual([...stepResults]);
    expect(rep.stepResults.get('b')).toBe(prior);
  });

  it('an abort raised a microtask after a step returned: the next entry never starts', async () => {
    // By the time the executor could start `b`, the signal is aborted — `b` itself sees it. Mastra
    // checks `signal.aborted` synchronously before every entry (`default.ts:815`), so `b` never runs.
    const ac = new AbortController();
    const seenAborted: boolean[] = [];
    const r = new RecordingRunner({
      a: (x) => (queueMicrotask(() => ac.abort()), { status: 'success', output: x }),
      b: (x, call) => (seenAborted.push(call.abortSignal.aborted), { status: 'success', output: x }),
    });
    const rep = await runWorkflowDetailed(compile(steps3), 'x', { runner: r, signal: ac.signal });
    expect(seenAborted, 'b started although its abortSignal was already aborted').toEqual([]);
    expect(r.calls).toEqual(['a']);
    expect(rep.outcome).toEqual({ status: 'canceled', origin: { stepId: 'b', path: [1] }, started: false });
  });

  it('abort while b runs: b finishes and is recorded, the sleep never starts, the run is canceled at the sleep', async () => {
    const ac = new AbortController();
    const r = new RecordingRunner({ b: (x) => (ac.abort(), { status: 'success', output: `${String(x)}-b` }) });
    const clock = new ManualClock();
    const rep = await runWorkflowDetailed(compile(chain), 'x', { runner: r, signal: ac.signal, clock });
    expect(rep.outcome).toEqual({ status: 'canceled', origin: { stepId: 'nap', path: [2] }, started: false });
    expect(r.calls).toEqual(['a', 'b']);
    expect(rep.stepResults.get('b')).toEqual(rec({ status: 'success', output: 'x-b', payload: 'x' }));
    expect([...rep.stepResults.keys()]).toEqual(['a', 'b']);
    // The sleep's timing never elapsed: the sweep took its token first.
    expect(clock.elapsed()).toBe(0);
  });
});

/**
 * The canceled token as the net wrote it. `RunOutcome` carries `started` too, but it is read from the
 * head of `wf.canceled`; capturing at the firing also shows that exactly one canceled token was
 * written, and by which transition's output: every transition is rebuilt with an action whose
 * context records what it outputs to `wf.canceled`. The rebuild alone changes nothing (see the
 * baseline test).
 */
function capturingCanceled(c: CompiledWorkflow, seen: CanceledToken[]): CompiledWorkflow {
  const canceledName = c.terminals.canceled.name;
  return withTransitions(c, (t) => {
    const action = t.action;
    const b = Transition.builder(t.name).inputs(...t.inputSpecs).timing(t.timing).priority(t.priority);
    if (t.outputSpec !== null) b.outputs(t.outputSpec);
    for (const arc of t.reads) b.read(arc.place);
    for (const arc of t.resets) b.reset(arc.place);
    for (const arc of t.inhibitors) b.inhibitor(arc.place);
    b.action((tctx) => {
      const spy = new Proxy(tctx, {
        get(target, prop) {
          if (prop === 'output') {
            return (p: Place<unknown>, value: unknown) => {
              if (p.name === canceledName) seen.push(value as CanceledToken);
              return (target.output as (p: Place<unknown>, v: unknown) => unknown).call(target, p, value);
            };
          }
          const v: unknown = Reflect.get(target, prop, target);
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
      return action(spy);
    });
    return b.build();
  });
}

describe('CanceledToken.started: work that began, told apart structurally from work that never did', () => {
  const run = async (description: WorkflowDescription, runner: (ac: AbortController) => RecordingRunner) => {
    const seen: CanceledToken[] = [];
    const ac = new AbortController();
    const rep = await runWorkflowDetailed(capturingCanceled(compile(description), seen), 1, {
      runner: runner(ac),
      signal: ac.signal,
      timeoutMs: 20_000,
    });
    return { outcome: rep.outcome, seen, records: statuses(rep) };
  };

  it('a step start gate: the next step never began, started false', async () => {
    const r = await run(steps3, (ac) => new RecordingRunner({ a: (x) => (ac.abort(), { status: 'success', output: x }) }));
    expect(r).toEqual({
      outcome: { status: 'canceled', origin: { stepId: 'b', path: [1] }, started: false },
      seen: [{ origin: { stepId: 'b', path: [1] }, started: false }],
      records: ['a:success'],
    });
  });

  it('the settle stage: the last step finished and was re-stamped, started true', async () => {
    const r = await run(steps3, (ac) => new RecordingRunner({ c: (x) => (ac.abort(), { status: 'success', output: x }) }));
    expect(r).toEqual({ outcome: { status: 'canceled', started: true }, seen: [{ started: true }], records: ['a:success', 'b:success', 'c:success'] });
  });

  it('a failure settled under the signal: started true, with the failing step as origin', async () => {
    const wf: WorkflowDescription = { id: 'sf', entries: [{ kind: 'step', id: 'a' }] };
    const r = await run(wf, (ac) => new RecordingRunner({ a: () => (ac.abort(), { status: 'failed', error: 'x' }) }));
    expect(r.outcome).toEqual({ status: 'canceled', origin: { stepId: 'a', path: [0] }, started: true });
    expect(r.seen).toEqual([{ origin: { stepId: 'a', path: [0] }, started: true }]);
  });

  it('a fixed sleep not yet begun: started false, and no waiting record', async () => {
    const r = await run(chain, (ac) => new RecordingRunner({ b: (x) => (ac.abort(), { status: 'success', output: x }) }));
    expect(r).toEqual({
      outcome: { status: 'canceled', origin: { stepId: 'nap', path: [2] }, started: false },
      seen: [{ origin: { stepId: 'nap', path: [2] }, started: false }],
      records: ['a:success', 'b:success'],
    });
  });

  it('a fixed sleep mid-wait: swept from its waiting place, started true, its waiting record kept', async () => {
    const r = await run(chain, (ac) => new RecordingRunner({ b: (x) => (setTimeout(() => ac.abort(), 30), { status: 'success', output: x }) }));
    expect(r).toEqual({
      outcome: { status: 'canceled', origin: { stepId: 'nap', path: [2] }, started: true },
      seen: [{ origin: { stepId: 'nap', path: [2] }, started: true }],
      records: ['a:success', 'b:success', 'nap:waiting'],
    });
  });

  it.each([
    ['per-run sleep', { kind: 'sleep', id: 'nap', duration: { perRun: true } }],
    ['per-run sleepUntil', { kind: 'sleepUntil', id: 'nap', until: { perRun: true } }],
  ] as const)('an action-side %s: before it began started false, mid-wait started true', async (_label, sleep) => {
    const wf: WorkflowDescription = { id: 'as', entries: [{ kind: 'step', id: 'a' }, sleep, { kind: 'step', id: 'z' }] };
    const far = (): number => (sleep.kind === 'sleep' ? 60_000 : Date.now() + 60_000);
    const before = await run(wf, (ac) => new RecordingRunner({ steps: { a: (x) => (ac.abort(), { status: 'success', output: x }) }, waits: { nap: far } }));
    expect(before).toEqual({
      outcome: { status: 'canceled', origin: { stepId: 'nap', path: [1] }, started: false },
      seen: [{ origin: { stepId: 'nap', path: [1] }, started: false }],
      records: ['a:success'],
    });
    const mid = await run(wf, (ac) => new RecordingRunner({ waits: { nap: () => (setTimeout(() => ac.abort(), 30), far()) } }));
    expect(mid).toEqual({
      outcome: { status: 'canceled', origin: { stepId: 'nap', path: [1] }, started: true },
      seen: [{ origin: { stepId: 'nap', path: [1] }, started: true }],
      records: ['a:success', 'nap:waiting'],
    });
  });

  it('the capture is not vacuous: a run that is not canceled writes no canceled token', async () => {
    const r = await run(steps3, () => new RecordingRunner());
    expect(r).toEqual({ outcome: { status: 'success', output: 1 }, seen: [], records: ['a:success', 'b:success', 'c:success'] });
  });
});

/**
 * `started` on the run outcome itself, one scenario per class, each run through `runWorkflowDetailed`
 * with no capture. The sweep or settle transition that ends each run decides the value:
 * - a start gate (an entry's input, a fixed sleep's input before `begin`) — `started: false`;
 * - the settle stage (`t.settle.*.canceled`) or a sweep inside a running construct (a fixed sleep's
 *   `waiting` place) — `started: true`.
 */
describe('RunOutcome.started, pinned both ways at the run level', () => {
  const napChain: WorkflowDescription = {
    id: 'nc',
    entries: [{ kind: 'step', id: 'a' }, { kind: 'sleep', id: 'nap', duration: { fixed: 60_000 } }, { kind: 'step', id: 'z' }],
  };

  it('aborted before start: swept at the first entry\'s input, started false', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = new RecordingRunner();
    const rep = await runWorkflowDetailed(compile(steps3), 1, { runner: r, signal: ac.signal });
    expect(rep.outcome).toEqual({ status: 'canceled', origin: { stepId: 'a', path: [0] }, started: false });
    expect(r.calls).toEqual([]);
  });

  it('abort mid-step, the next entry swept at its gate: started false — the next entry never started', async () => {
    const ac = new AbortController();
    const r = new RecordingRunner({
      a: async (x) => {
        ac.abort();
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { status: 'success', output: x };
      },
    });
    const rep = await runWorkflowDetailed(compile(steps3), 1, { runner: r, signal: ac.signal, timeoutMs: 10_000 });
    // The origin is `b`, not `a`: `a` ran to the end, and it is `b` that the sweep reports.
    expect(rep.outcome).toEqual({ status: 'canceled', origin: { stepId: 'b', path: [1] }, started: false });
    expect(r.calls).toEqual(['a']);
    expect(statuses(rep)).toEqual(['a:success']);
  });

  it('the last entry re-stamped at settle: started true, with no origin after a success and the step as origin after a failure', async () => {
    const abortIn = async (outcome: StepOutcome) => {
      const ac = new AbortController();
      const r = new RecordingRunner({ c: () => (ac.abort(), outcome) });
      return runWorkflowDetailed(compile(steps3), 1, { runner: r, signal: ac.signal });
    };
    const done = await abortIn({ status: 'success', output: 'z' });
    expect(done.outcome).toEqual({ status: 'canceled', started: true });
    expect(statuses(done)).toEqual(['a:success', 'b:success', 'c:success']);
    const failed = await abortIn({ status: 'failed', error: 'e' });
    expect(failed.outcome).toEqual({ status: 'canceled', origin: { stepId: 'c', path: [2] }, started: true });
    expect(statuses(failed)).toEqual(['a:success', 'b:success', 'c:failed']);
  });

  it('a fixed sleep mid-wait: swept from its waiting place, started true', async () => {
    const ac = new AbortController();
    const r = new RecordingRunner({ a: (x) => (setTimeout(() => ac.abort(), 30), { status: 'success', output: x }) });
    const t0 = performance.now();
    const rep = await runWorkflowDetailed(compile(napChain), 1, { runner: r, signal: ac.signal, timeoutMs: 10_000 });
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(rep.outcome).toEqual({ status: 'canceled', origin: { stepId: 'nap', path: [1] }, started: true });
    expect(statuses(rep)).toEqual(['a:success', 'nap:waiting']);
  });

  it('a fixed sleep before begin: swept at its input, started false', async () => {
    const ac = new AbortController();
    const r = new RecordingRunner({ a: (x) => (ac.abort(), { status: 'success', output: x }) });
    const clock = new ManualClock();
    const rep = await runWorkflowDetailed(compile(napChain), 1, { runner: r, signal: ac.signal, clock });
    expect(rep.outcome).toEqual({ status: 'canceled', origin: { stepId: 'nap', path: [1] }, started: false });
    expect(statuses(rep)).toEqual(['a:success']);
    expect(clock.elapsed()).toBe(0);
  });
});

describe('after an entry, any result is re-stamped canceled (handlers/entry.ts:810-817)', () => {
  it('abort during the last step: canceled though it succeeded, and its record keeps success', async () => {
    const ac = new AbortController();
    const r = new RecordingRunner({ c: (x) => (ac.abort(), { status: 'success', output: x }) });
    const rep = await runWorkflowDetailed(compile(chain), 'x', { runner: r, signal: ac.signal, clock: new ManualClock() });
    // The success settled with the signal marked: no step is waiting, so no origin.
    expect(rep.outcome).toEqual({ status: 'canceled', started: true });
    expect(rep.stepResults.get('c')).toEqual(rec({ status: 'success', output: 'x', payload: 'x' }));
  });

  it.each([
    ['failed', { status: 'failed', error: 'x', nonRetryable: true }],
    ['failed with a tripwire', { status: 'failed', error: 'x', tripwire: { reason: 'r' }, nonRetryable: true }],
    ['bailed', { status: 'bailed', output: 'early' }],
    ['suspended', { status: 'suspended', suspendPayload: 'p' }],
    ['paused', { status: 'paused' }],
  ] as const)('%s at the first entry: canceled wins, and the record keeps the real outcome', async (_label, outcome) => {
    const ac = new AbortController();
    const r = new RecordingRunner({ a: () => (ac.abort(), outcome as StepOutcome) });
    const rep = await runWorkflowDetailed(compile(chain), 1, { runner: r, signal: ac.signal });
    expect(rep.outcome).toEqual({ status: 'canceled', origin: { stepId: 'a', path: [0] }, started: true });
    expect(r.calls).toEqual(['a']);
    // A bail is NOT rewritten to success here: Mastra rewrites only a result still `bailed` at
    // `default.ts:926`, and the re-stamp already made it `canceled`.
    expect(rep.stepResults.get('a')).toMatchObject({ status: outcome.status });
  });

  it('a retry is not gated: b retries after the abort, its record is the retry\'s, then the run is canceled', async () => {
    const ac = new AbortController();
    const r = new RecordingRunner({
      b: (_x, c) => (c.attempt === 0 ? (ac.abort(), { status: 'failed', error: 'first' }) : { status: 'success', output: 'second' }),
    });
    const clock = new ManualClock();
    const rep = await runWorkflowDetailed(compile(chain), 1, { runner: r, signal: ac.signal, clock });
    expect(r.attempts).toEqual([
      { stepId: 'a', attempt: 0 },
      { stepId: 'b', attempt: 0 },
      { stepId: 'b', attempt: 1 },
    ]);
    expect(rep.outcome).toEqual({ status: 'canceled', origin: { stepId: 'nap', path: [2] }, started: false });
    expect(rep.stepResults.get('b')).toMatchObject({ status: 'success', output: 'second' });
    // The retry delay (5ms) was waited in full; the sleep (60s) never started.
    expect(clock.elapsed()).toBe(5);
  });
});

describe('abort from inside a step, through what the step sees', () => {
  it('ctx.abort() aborts the run\'s own controller: the step completes, the next entry never starts', async () => {
    const ac = new AbortController();
    const r = mastraLikeRunner(ac, { a: (input, _c, ctx) => (ctx.abort(), { status: 'success', output: `${String(input)}!` }) });
    const rep = await runWorkflowDetailed(compile(steps3), 'x', { runner: r, signal: ac.signal });
    expect(ac.signal.aborted).toBe(true);
    expect(r.calls).toEqual(['a']);
    expect(rep.outcome).toEqual({ status: 'canceled', origin: { stepId: 'b', path: [1] }, started: false });
    expect(rep.stepResults.get('a')).toEqual(rec({ status: 'success', output: 'x!', payload: 'x' }));
  });

  it('a step that honours its abortSignal ends early; its failure is recorded and the run is canceled', async () => {
    const ac = new AbortController();
    const r = mastraLikeRunner(ac, {
      a: (input, _c, ctx) => {
        setTimeout(() => ctx.abort(), 30);
        return { status: 'success', output: input };
      },
      b: async (_i, _c, ctx) =>
        (await abortedOrAfter(ctx.abortSignal, 60_000)) === 'aborted'
          ? { status: 'failed', error: 'AbortError' }
          : { status: 'success', output: 'too late' },
    });
    const t0 = performance.now();
    const rep = await runWorkflowDetailed(compile(steps3), 'x', { runner: r, signal: ac.signal, timeoutMs: 20_000 });
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(r.calls).toEqual(['a', 'b']);
    expect(rep.outcome).toEqual({ status: 'canceled', origin: { stepId: 'b', path: [1] }, started: true });
    expect(rep.stepResults.get('b')).toEqual(rec({ status: 'failed', error: 'AbortError', payload: 'x' }));
  });

  it('a step that ignores its abortSignal runs to the end; the run is canceled only after it', async () => {
    const ac = new AbortController();
    const r = mastraLikeRunner(ac, {
      b: async (input, _c, ctx) => {
        ctx.abort();
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { status: 'success', output: `${String(input)}+b` };
      },
    });
    const rep = await runWorkflowDetailed(compile(steps3), 'x', { runner: r, signal: ac.signal });
    expect(rep.outcome).toEqual({ status: 'canceled', origin: { stepId: 'c', path: [2] }, started: false });
    expect(rep.stepResults.get('b')).toMatchObject({ status: 'success', output: 'x+b' });
    expect(r.calls).toEqual(['a', 'b']);
  });
});

describe('abort during a wait', () => {
  it('during a retry delay: the delay is waited in full and the retry runs, as Mastra\'s bare setTimeout', async () => {
    const ac = new AbortController();
    const at: { attempt: number; ms: number }[] = [];
    const t0 = performance.now();
    const wf: WorkflowDescription = {
      id: 'rd',
      entries: [{ kind: 'step', id: 'b', retries: 1, retryDelayMs: 300 }, { kind: 'step', id: 'c' }],
    };
    const r = new RecordingRunner({
      b: (_x, call) => {
        at.push({ attempt: call.attempt, ms: performance.now() - t0 });
        if (call.attempt === 0) {
          setTimeout(() => ac.abort(), 50);
          return { status: 'failed', error: 'busy' };
        }
        return { status: 'success', output: 'retried' };
      },
    });

    const rep = await runWorkflowDetailed(compile(wf), 1, { runner: r, signal: ac.signal, timeoutMs: 20_000 });

    // `if (i > 0 && params.delay) await setTimeout(delay)` (`default.ts:456-458`) is not
    // abortable, and nothing checks the signal before attempt 1.
    expect(at.map((a) => a.attempt)).toEqual([0, 1]);
    expect(at[1]!.ms - at[0]!.ms).toBeGreaterThanOrEqual(280);
    expect(rep.stepResults.get('b')).toMatchObject({ status: 'success', output: 'retried' });
    expect(rep.outcome).toEqual({ status: 'canceled', origin: { stepId: 'c', path: [1] }, started: false });
    expect(r.calls).toEqual(['b', 'b']);
  });

  it('mid fixed sleep: a real 60s sleep ends at once, keeps only its waiting record, and the next entry never runs', async () => {
    const ac = new AbortController();
    const r = new RecordingRunner({ b: (x) => (setTimeout(() => ac.abort(), 50), { status: 'success', output: x }) });
    const t0 = performance.now();
    const rep = await runWorkflowDetailed(compile(chain), 1, { runner: r, signal: ac.signal, timeoutMs: 20_000 });
    expect(rep.outcome).toEqual({ status: 'canceled', origin: { stepId: 'nap', path: [2] }, started: true });
    expect(r.calls).toEqual(['a', 'b']);
    // Mastra writes `{status: 'waiting', payload: prevOutput, startedAt}` as the sleep begins and
    // never overwrites it on a cancel (`handlers/entry.ts:605-609,641-643`): no `endedAt`, no output.
    expect(rep.stepResults.get('nap')).toEqual({ status: 'waiting', payload: 1, startedAt: expect.any(Number) });
    expect([...rep.stepResults.keys()]).toEqual(['a', 'b', 'nap']);
    expect(performance.now() - t0).toBeLessThan(2_000);
  });

  it.each([
    ['per-run sleep', { kind: 'sleep', id: 'nap', duration: { perRun: true } }],
    ['per-run sleepUntil', { kind: 'sleepUntil', id: 'nap', until: { perRun: true } }],
  ] as const)('mid %s: ends early, is canceled AT the sleep, and writes no success record', async (_label, sleep) => {
    const ac = new AbortController();
    const wf: WorkflowDescription = { id: 'p', entries: [sleep, { kind: 'step', id: 'z' }] };
    const r = new RecordingRunner({
      waits: { nap: () => (setTimeout(() => ac.abort(), 50), sleep.kind === 'sleep' ? 60_000 : Date.now() + 60_000) },
    });
    const t0 = performance.now();
    const rep = await runWorkflowDetailed(compile(wf), 1, { runner: r, signal: ac.signal, timeoutMs: 20_000 });
    expect(performance.now() - t0).toBeLessThan(2_000);
    // `if (abortController?.signal?.aborted) { execResults = { status: 'canceled' } } else { ...
    // stepResults[entry.id] = success }` (`handlers/entry.ts:641-665`, sleepUntil `:752-776`): the
    // entry itself is canceled, and no success is written. The record stays the
    // `{status: 'waiting'}` written before sleeping (`:605-609`, sleepUntil `:715-719`).
    expect(rep.outcome).toEqual({ status: 'canceled', origin: { stepId: 'nap', path: [0] }, started: true });
    expect(r.calls).toEqual([]);
    expect(rep.stepResults.get('nap')).toEqual({ status: 'waiting', payload: 1, startedAt: expect.any(Number) });
    expect([...rep.stepResults.keys()]).toEqual(['nap']);
  });

  it('mid fixed sleepUntil: waited in the action like a per-run wait, cut short, canceled at the sleep, only its waiting record', async () => {
    // A fixed `.sleepUntil` is resolved against the run's epoch clock at firing time, so it waits
    // in the action (`t.<i>.<id>.waited`), not as a transition timing — the case the earlier
    // report missed.
    const ac = new AbortController();
    const wf: WorkflowDescription = {
      id: 'fu',
      entries: [{ kind: 'step', id: 'a' }, { kind: 'sleepUntil', id: 'until', until: { fixed: Date.now() + 60_000 } }, { kind: 'step', id: 'z' }],
    };
    const r = new RecordingRunner({ a: (x) => (setTimeout(() => ac.abort(), 50), { status: 'success', output: x }) });
    const t0 = performance.now();
    const rep = await runWorkflowDetailed(compile(wf), 1, { runner: r, signal: ac.signal, timeoutMs: 20_000 });
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(rep.outcome).toEqual({ status: 'canceled', origin: { stepId: 'until', path: [1] }, started: true });
    expect(r.calls).toEqual(['a']);
    expect([...rep.stepResults.keys()]).toEqual(['a', 'until']);
    expect(rep.stepResults.get('until')).toEqual({ status: 'waiting', payload: 1, startedAt: expect.any(Number) });
  });

  it('abort inside the step before a per-run sleep: the wake never fires, so the sleep fn is never called', async () => {
    // Pins the wake's inhibitor with a run: Mastra checks before the sleep entry (`default.ts:815`)
    // and never evaluates its fn (`handlers/sleep.ts:83-128`).
    const run = async (compiled: CompiledWorkflow) => {
      const ac = new AbortController();
      let waits = 0;
      const r = new RecordingRunner({
        steps: { a: (x) => (ac.abort(), { status: 'success', output: x }) },
        waits: { nap: () => (waits++, 10) },
      });
      const rep = await runWorkflowDetailed(compiled, 1, { runner: r, signal: ac.signal, timeoutMs: 10_000 });
      return { outcome: rep.outcome, records: statuses(rep), waits };
    };
    const wf: WorkflowDescription = {
      id: 'wk',
      entries: [{ kind: 'step', id: 'a' }, { kind: 'sleep', id: 'nap', duration: { perRun: true } }, { kind: 'step', id: 'z' }],
    };
    // Never begun: no waiting record either — Mastra's check before the entry writes nothing.
    expect(await run(compile(wf))).toEqual({
      outcome: { status: 'canceled', origin: { stepId: 'nap', path: [1] }, started: false },
      records: ['a:success'],
      waits: 0,
    });
    // Mutant: the wake's inhibitor stripped (priority 1 wins the race it now has with the sweep).
    // The fn runs after the abort, the sleep begins (its waiting record) and is cut short at
    // `cancel-waited`.
    const mutant = compile(wf, { gadgets: { sleep: strip(sleepGadget, '.wake', 1) } });
    expect(await run(mutant)).toEqual({
      outcome: { status: 'canceled', origin: { stepId: 'nap', path: [1] }, started: true },
      records: ['a:success', 'nap:waiting'],
      waits: 1,
    });
  });
});

/**
 * An abort that lands right around the end of an action-side wait. Which of `resume` (inhibited
 * by the signal) and `cancel-waited` (reads it) takes the `waited` token depends only on whether
 * `wf.cancel` is marked by then; the wait itself never decides. Each schedule is run 20 times and
 * must give ONE outcome every time.
 *
 * The abort is scheduled from inside the wait fn, which resolves a zero wait (`sleep`) or a past
 * instant (`sleepUntil`). Mastra still waits one timer tick for either (`setTimeout(0)`, row 38),
 * and checks the signal right after (`handlers/entry.ts:642,753`), so an abort within a few
 * microtasks is seen there: the entry is canceled at the sleep and no success is written. Later
 * schedules are characterised, not claimed: the run is over before the abort lands.
 */
describe('a cancel landing just after an action-side wait completed', () => {
  const schedules: readonly [string, (abort: () => void) => void, string][] = [
    ['sync, inside the wait fn', (abort) => abort(), 'canceled@nap records=[nap:waiting]'],
    ['a microtask later', (abort) => queueMicrotask(abort), 'canceled@nap records=[nap:waiting]'],
    // Red under the kernel as it is: `resume` fires before `t.cancel.arrive` has marked the signal,
    // so the cut-short sleep is recorded as a success and `z`'s sweep cancels ("canceled@z
    // records=[nap]"). Injecting into `wf.cancel` itself turns it green (contractIssues).
    ['two microtasks later', (abort) => queueMicrotask(() => queueMicrotask(abort)), 'canceled@nap records=[nap:waiting]'],
    ['setImmediate', (abort) => setImmediate(abort), 'success records=[nap:success,z:success]'],
    ['setTimeout 0', (abort) => setTimeout(abort, 0), 'success records=[nap:success,z:success]'],
  ];

  it.each(['sleep', 'sleepUntil'] as const)('%s: each schedule is deterministic, and the outcomes are pinned', async (kind) => {
    const wf: WorkflowDescription = {
      id: 'after-wait',
      entries: [
        kind === 'sleep' ? { kind, id: 'nap', duration: { perRun: true } } : { kind, id: 'nap', until: { perRun: true } },
        { kind: 'step', id: 'z' },
      ],
    };
    const compiled = compile(wf);
    for (const [label, schedule, expected] of schedules) {
      const seen = new Set<string>();
      for (let i = 0; i < 20; i++) {
        const ac = new AbortController();
        const r = new RecordingRunner({
          waits: { nap: () => (schedule(() => ac.abort()), kind === 'sleep' ? 0 : Date.now() - 1) },
        });
        const rep = await runWorkflowDetailed(compiled, 'v', { runner: r, signal: ac.signal, timeoutMs: 10_000 });
        // Never residue, never stranded: `summary` would show it.
        const o = rep.outcome;
        const where = o.status === 'canceled' && o.origin !== undefined ? `@${o.origin.stepId}` : '';
        const extra = 'residue' in o && o.residue !== undefined ? ` residue=${o.residue.join(',')}` : '';
        seen.add(`${o.status}${where}${extra} records=[${statuses(rep).join(',')}]`);
      }
      expect([...seen], label).toEqual([expected]);
    }
  }, 60_000);
});

describe('abort racing the end of the run', () => {
  const last: WorkflowDescription = { id: 'race', entries: [{ kind: 'step', id: 'a' }, { kind: 'step', id: 'z' }] };
  // Pinned per schedule, 15 runs each. Mastra re-checks the signal after the last entry only after
  // several awaits past the step's return — `executeStepWithRetry`, the durable emit of
  // `emitStepResultEvents` and `endStepSpan` (`handlers/step.ts:320,536-560`), then
  // `handlers/entry.ts:815` — so an abort raised synchronously or within two microtasks is seen:
  // canceled. The later schedules are characterised, not claimed: the run has ended and the late
  // injection is refused.
  const schedules: readonly [string, (abort: () => void) => void, 'success' | 'canceled'][] = [
    ['sync, inside the last step', (abort) => abort(), 'canceled'],
    // These two are red under the kernel as it is — `t.settle.done` fires in the executor cycle in
    // which the request arrives, before `t.cancel.arrive` has marked the signal (contractIssues).
    ['a microtask after the last step returns', (abort) => queueMicrotask(abort), 'canceled'],
    ['two microtasks later', (abort) => queueMicrotask(() => queueMicrotask(abort)), 'canceled'],
    ['setImmediate', (abort) => setImmediate(abort), 'success'],
    ['setTimeout 0', (abort) => setTimeout(abort, 0), 'success'],
    ['setTimeout 1', (abort) => setTimeout(abort, 1), 'success'],
  ];

  it.each(schedules)('%s: always the pinned outcome, clean, the record keeps success', async (_label, schedule, expected) => {
    for (let i = 0; i < 15; i++) {
      const ac = new AbortController();
      const r = new RecordingRunner({ z: (x) => (schedule(() => ac.abort()), { status: 'success', output: x }) });
      const rep = await runWorkflowDetailed(compile(last), 'v', { runner: r, signal: ac.signal, timeoutMs: 10_000 });
      // `toEqual` fails on a `residue` key, so this is also "never both, never stranded".
      expect(rep.outcome).toEqual(expected === 'canceled' ? { status: 'canceled', started: true } : { status: 'success', output: 'v' });
      expect(rep.stepResults.get('z')).toMatchObject({ status: 'success', output: 'v' });
    }
  });

  it('both of the two answers occur across the schedules', () => {
    expect(new Set(schedules.map(([, , expected]) => expected))).toEqual(new Set(['success', 'canceled']));
  });

  it('the synchronous abort inside the last step is always canceled', async () => {
    for (let i = 0; i < 10; i++) {
      const ac = new AbortController();
      const r = new RecordingRunner({ z: (x) => (ac.abort(), { status: 'success', output: x }) });
      expect(await runWorkflow(compile(last), 'v', { runner: r, signal: ac.signal })).toEqual({ status: 'canceled', started: true });
    }
  });

  it('an abort after the run resolved changes nothing and throws nothing', async () => {
    const ac = new AbortController();
    const rep = await runWorkflowDetailed(compile(chain), 'v', { runner: new RecordingRunner(), signal: ac.signal, clock: new ManualClock() });
    expect(() => ac.abort()).not.toThrow();
    expect(rep.outcome).toEqual({ status: 'success', output: 'v' });
    // The listener was removed: a later abort does not reach the finished executor at all.
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('an injection after drain() is refused quietly: the run ends as it was reaching, no throw, no rejection', async () => {
    // A mutant step that forks a side action next to the real one. The real one reaches
    // `wf.done` (drain() is called); 30ms later the side action aborts the run's controller,
    // so the kernel injects into a draining executor. libpetri refuses that injection
    // (`injectNoAwait` returns once draining), and the run finishes with the side token as
    // residue — the proof that it ran — and success, not canceled.
    const ac = new AbortController();
    const forking: Gadget = (entry, next, ctx) => {
      const r = stepGadget(entry, next, ctx);
      const pre = place<FlowToken>(ctx.names.entryPlace(ctx.path, entry.id, 'fork'));
      const side = place<null>(ctx.names.entryPlace(ctx.path, entry.id, 'side'));
      const sideDone = place<null>(ctx.names.entryPlace(ctx.path, entry.id, 'side-done'));
      const fork = Transition.builder(ctx.names.entryTransition(ctx.path, entry.id, 'fork'))
        .inputs(one(pre))
        .outputs(and(outPlace(r.inPlace), outPlace(side)))
        .action(async (tctx) => {
          tctx.output(r.inPlace, tctx.input(pre));
          tctx.output(side, null);
        })
        .build();
      const late = Transition.builder(ctx.names.entryTransition(ctx.path, entry.id, 'late-abort'))
        .inputs(one(side))
        .outputs(outPlace(sideDone))
        .action(async (tctx) => {
          tctx.input(side);
          await new Promise((resolve) => setTimeout(resolve, 30));
          ac.abort();
          tctx.output(sideDone, null);
        })
        .build();
      return { inPlace: pre, transitions: [...r.transitions, fork, late] };
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => void unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const compiled = compile({ id: 'late', entries: [{ kind: 'step', id: 'a' }] }, { gadgets: { step: forking } });
      const outcome = await runWorkflow(compiled, 'v', { runner: new RecordingRunner(), signal: ac.signal, timeoutMs: 10_000 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(ac.signal.aborted).toBe(true);
      expect(outcome).toEqual({ status: 'success', output: 'v', residue: ['s.0.a.side-done'] });
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('many aborts', () => {
  it('aborting repeatedly is aborting once', async () => {
    const ac = new AbortController();
    const r = mastraLikeRunner(ac, {
      a: (x, _c, ctx) => {
        for (let i = 0; i < 5; i++) ctx.abort();
        return { status: 'success', output: x };
      },
    });
    expect(await runWorkflow(compile(steps3), 1, { runner: r, signal: ac.signal })).toEqual({
      status: 'canceled',
      origin: { stepId: 'b', path: [1] },
      started: false,
    });
  });

  it('one controller shared by twenty concurrent runs of one compiled net cancels each of them, cleanly', async () => {
    const compiled = compile(chain);
    const ac = new AbortController();
    const runners = Array.from({ length: 20 }, () => new RecordingRunner({ b: (x) => ({ status: 'success', output: x }) }));
    const pending = runners.map((runner, i) =>
      runWorkflowDetailed(compiled, i, { runner, signal: ac.signal, timeoutMs: 20_000 }),
    );
    // Every run is parked in the real 60s sleep by now, or on its way to it.
    setTimeout(() => ac.abort(), 50);
    const reports = await Promise.all(pending);
    reports.forEach((rep, i) => {
      expect(rep.outcome).toEqual({ status: 'canceled', origin: { stepId: 'nap', path: [2] }, started: true });
      // Each run's records are its own.
      expect(rep.stepResults.get('b')).toMatchObject({ output: i, payload: i });
    });
  });

  it('aborted and live runs of one compiled net do not see each other\'s signal', async () => {
    const compiled = compile(steps3);
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, (_, i) => {
        const ac = new AbortController();
        if (i % 2 === 0) ac.abort();
        return runWorkflow(compiled, i, { runner: new RecordingRunner(), signal: ac.signal });
      }),
    );
    outcomes.forEach((o, i) =>
      expect(o).toEqual(i % 2 === 0 ? { status: 'canceled', origin: { stepId: 'a', path: [0] }, started: false } : { status: 'success', output: i }),
    );
  });
});

describe('a run with a signal whose model strands a token', () => {
  // A mutant step whose `suspended` exit leads nowhere. The kernel's promise
  // (`RunOptions.signal`): with a signal the executor has an environment place and does not end at
  // quiescence ([ENV-010]); only a marked terminal drains it. A stranded run marks none, so it
  // ends at `timeoutMs`, where the executor is closed and `runWorkflow` REJECTS — `timeoutMs` is
  // a harness safety net, not a workflow outcome.
  const lost = place<SuspendToken>('lost.suspended');
  const suspendsNowhere: Gadget = (entry, next, ctx) => stepGadget(entry, next, { ...ctx, exits: { ...ctx.exits, suspended: lost } });
  const description: WorkflowDescription = { id: 'strand', entries: [{ kind: 'step', id: 'a' }] };
  const runner = () => new RecordingRunner({ a: () => ({ status: 'suspended', suspendPayload: 'p' }) });

  it('without a signal the same model ends at quiescence and reports the stranded place', async () => {
    const compiled = compile(description, { gadgets: { step: suspendsNowhere } });
    expect(await runWorkflow(compiled, 1, { runner: runner() })).toEqual({ status: 'stranded', places: ['lost.suspended'] });
  });

  it('with a signal it ends only at timeoutMs, and rejects', async () => {
    const compiled = compile(description, { gadgets: { step: suspendsNowhere } });
    const r = runner();
    const t0 = performance.now();
    await expect(runWorkflow(compiled, 1, { runner: r, signal: new AbortController().signal, timeoutMs: 400 })).rejects.toThrow(
      /timed out/,
    );
    const ms = performance.now() - t0;
    expect(ms).toBeGreaterThanOrEqual(350);
    expect(ms).toBeLessThan(3_000);
    expect(r.calls).toEqual(['a']);
  });
});

describe('classify precedence with a canceled terminal', () => {
  const compiled = compile(steps3);
  const t = compiled.terminals;
  const m = (...entries: [Place<unknown>, unknown[]][]): Marking =>
    Marking.from(new Map<Place<unknown>, Token<unknown>[]>(entries.map(([p, vs]) => [p, vs.map((v) => tokenOf(v))])));

  it('canceled beats every other terminal; the others are residue; the cancel place never is', () => {
    expect(
      classify(
        compiled,
        m(
          [t.failed, [{ stepId: 'a', path: [0], error: 'e' }]],
          [t.canceled, [{ origin: { stepId: 'b', path: [1] }, started: false } satisfies CanceledToken]],
          [t.done, [{ data: 1 }]],
          [compiled.cancel, [null]],
        ),
      ),
    ).toEqual({ status: 'canceled', origin: { stepId: 'b', path: [1] }, started: false, residue: ['wf.done', 'wf.failed'] });
  });
});

// ---------------------------------------------------------------------------------------------

/**
 * Proofs, through `verifyWorkflow` with the restart segments left out ({@link SEGMENTS}): the
 * structural cancel check first, then both
 * segments on the one closed net — `closed` (initial marking one token in the entry place, the
 * request place empty: `deadlockFree`, `terminatesAtSink`, `exactlyOneTerminal`, `neverCanceled`)
 * and `cancel` (one token in the entry place AND one in `wf.cancel.request`, so `t.cancel.arrive`
 * lands the signal at every reachable point: the first three). Sinks: the six terminals and
 * `wf.cancel`. Route and time of every verdict are printed after the suite.
 */
describe('linear chains, proved in both segments', () => {
  const shapes: readonly [string, WorkflowDescription][] = [
    ['single step', { id: 'one', entries: [{ kind: 'step', id: 'a' }] }],
    [
      'retries with delays and a fixed sleep',
      {
        id: 'retries',
        entries: [
          { kind: 'step', id: 'a', retries: 3, retryDelayMs: 100 },
          { kind: 'sleep', id: 'nap', duration: { fixed: 60_000 } },
          { kind: 'step', id: 'b', retries: 1 },
          { kind: 'step', id: 'c', source: 'workflow', retries: 2, retryDelayMs: 5 },
        ],
      },
    ],
    [
      'per-run sleep and sleepUntil and a fixed sleepUntil around retried steps',
      {
        id: 'per-run',
        entries: [
          { kind: 'step', id: 'a', retries: 1, retryDelayMs: 10 },
          { kind: 'sleep', id: 'backoff', duration: { perRun: true } },
          { kind: 'sleepUntil', id: 'window', until: { perRun: true } },
          { kind: 'sleepUntil', id: 'fixedUntil', until: { fixed: EPOCH } },
          { kind: 'step', id: 'b', retries: 2 },
        ],
      },
    ],
  ];

  it.each(shapes)('%s', async (label, description) => {
    await expectProven(label, compile(description));
  }, 300_000);
});

describe('refusals', () => {
  it('verifyWorkflow refuses a compiled workflow whose cancel place is not in the net, before proving', async () => {
    const c = compile(steps3);
    const stray = { ...c, cancel: place<null>('wf.cancel.elsewhere') };
    await expect(verifyWorkflow(stray)).rejects.toThrow(/cancel place 'wf.cancel.elsewhere' is not in the net/);
    await expect(verifyWorkflow(stray, { segments: ['closed'] })).rejects.toThrow(/is not in the net/);
  });

  it('verifyWorkflow refuses a compiled workflow whose cancel request place is not in the net', async () => {
    const c = compile(steps3);
    const stray = { ...c, cancelRequest: place<null>('wf.cancel.request.elsewhere') };
    await expect(verifyWorkflow(stray)).rejects.toThrow(/cancel request place 'wf.cancel.request.elsewhere' is not in the net/);
  });
});

/**
 * Non-vacuity: each cancellation safeguard in the leaf gadgets and the settle stage, removed
 * outside `src/`, is caught — by the structural check (an inhibitor), by a proof (a sweep, a read
 * arc, a finisher), or both — and flips a run where a run can show it.
 */
describe('non-vacuity of each cancellation safeguard', () => {
  it('the rebuild helper alone changes nothing (baseline for the hand-built mutants)', async () => {
    const same = withTransitions(compile(steps3), (t) => rebuilt(t));
    expect(cancelStructureViolations(same)).toEqual([]);
    await expectProven('rebuilt identity', same);
    const ac = new AbortController();
    const r = new RecordingRunner({ c: (x) => (ac.abort(), { status: 'success', output: x }) });
    expect(await runWorkflow(same, 1, { runner: r, signal: ac.signal })).toEqual({ status: 'canceled', started: true });
  }, 120_000);

  it('leaf sweep (step): structurally silent, but the cancel segment sees the stranded input', async () => {
    const mutant = compile(chain, { gadgets: { step: withoutSweep(stepGadget) } });
    // No sweep, so nothing competes with one: the structural check has nothing to say.
    expect(cancelStructureViolations(mutant)).toEqual([]);
    // But each step's input is also a resume site ([ADR 0007]), and a site without a sweep is what
    // the resume gate check names, exactly — so `verifyWorkflow` now refuses the mutant first, and
    // the proofs are asked for with the structural checks skipped.
    expect(resumeGateViolations(mutant)).toStrictEqual([
      "resume site 3 ('s.3.c.in') has no sweep: nothing reads 'wf.cancel' and consumes it",
      "resume site 1 ('s.1.b.in') has no sweep: nothing reads 'wf.cancel' and consumes it",
      "resume site 0 ('s.0.a.in') has no sweep: nothing reads 'wf.cancel' and consumes it",
    ]);
    await expect(verifyWorkflow(mutant)).rejects.toThrow(/resume gate structure is unsound/);
    const v = await prove('no step sweep', mutant, { structure: 'skip' });
    expect(v).toStrictEqual({
      ...allProven(mutant),
      // Blind in `terminatesAtSink`: `wf.cancel` is a declared sink — the gap `exactlyOneTerminal`
      // covers. Every segment a cancel arrives in sees the stranded input, the resumed ones too.
      ...violated(['cancel', 'resume@0+cancel', 'resume@1+cancel', 'resume@3+cancel'], 'deadlockFree', 'exactlyOneTerminal'),
    });
    // The run: the abort lands while `a` runs; `b`'s input is never swept and the run never ends.
    const ac = new AbortController();
    const r = new RecordingRunner({ a: (x) => (ac.abort(), { status: 'success', output: x }) });
    await expect(runWorkflow(mutant, 1, { runner: r, signal: ac.signal, timeoutMs: 300 })).rejects.toThrow(/timed out/);
  }, 120_000);

  it('leaf sweep (sleep): without it a cancel during a fixed sleep strands the sleeping token', async () => {
    const mutant = compile(chain, { gadgets: { sleep: withoutSweep(sleepGadget) } });
    expect(cancelStructureViolations(mutant)).toEqual([]);
    const v = await prove('no sleep sweep', mutant);
    // A run resumed at `c` (site 3) is past the sleep, so only the segments that can reach it flip.
    expect(v).toStrictEqual({
      ...allProven(mutant),
      ...violated(['cancel', 'resume@0+cancel', 'resume@1+cancel'], 'deadlockFree', 'exactlyOneTerminal'),
    });
  }, 120_000);

  it('action-side sleep, cancel-waited removed: the cancel segment sees the waited token stranded', async () => {
    const wf: WorkflowDescription = { id: 'cw', entries: [{ kind: 'sleep', id: 'nap', duration: { perRun: true } }, { kind: 'step', id: 'z' }] };
    const mutant = compile(wf, {
      gadgets: { sleep: (e, n, c) => { const r = sleepGadget(e, n, c); return { ...r, transitions: r.transitions.filter((t) => !t.name.endsWith('.cancel-waited')) }; } },
    });
    expect(cancelStructureViolations(mutant)).toEqual([]);
    const v = await prove('no cancel-waited', mutant);
    // The one site is `z` (site 1), past the sleep: both its segments stay proven.
    expect([...mutant.resumeSites.keys()]).toStrictEqual(['1']);
    expect(v).toStrictEqual({ ...allProven(mutant), ...violated(['cancel'], 'deadlockFree', 'exactlyOneTerminal') });
    // The run: an abort mid-wait leaves the waited token with nowhere to go.
    const ac = new AbortController();
    const r = new RecordingRunner({ waits: { nap: () => (setTimeout(() => ac.abort(), 30), 60_000) } });
    await expect(runWorkflow(mutant, 1, { runner: r, signal: ac.signal, timeoutMs: 500 })).rejects.toThrow(/timed out/);
  }, 120_000);

  it('leaf first-attempt inhibitor: flagged by the structural check, refused by verifyWorkflow, and the run flips', async () => {
    const mutant = compile(steps3, { gadgets: { step: withoutFirstInhibitor } });
    expect([...cancelStructureViolations(mutant)].sort()).toEqual(
      ['t.0.a', 't.1.b', 't.2.c'].map(
        (t) => `'${t}.run' competes with sweep '${t}.cancel' for [s.${t.slice(2)}.in] without an inhibitor on 'wf.cancel'`,
      ),
    );
    await expect(verifyWorkflow(mutant)).rejects.toThrow(/'t\.1\.b\.run' competes with sweep 't\.1\.b\.cancel'/);

    // The run: `a` aborts synchronously. Intact, `b` is swept before it starts (`default.ts:815`);
    // the mutant runs the whole chain and only the settle stage re-stamps the end.
    const run = async (compiled: CompiledWorkflow) => {
      const ac = new AbortController();
      const r = new RecordingRunner({ a: (x) => (ac.abort(), { status: 'success', output: x }) });
      return { outcome: await runWorkflow(compiled, 1, { runner: r, signal: ac.signal }), calls: r.calls };
    };
    expect(await run(compile(steps3))).toEqual({ outcome: { status: 'canceled', origin: { stepId: 'b', path: [1] }, started: false }, calls: ['a'] });
    expect(await run(mutant)).toEqual({ outcome: { status: 'canceled', started: true }, calls: ['a', 'b', 'c'] });
  }, 120_000);

  it("action-side sleep's resume inhibitor: flagged, and the run records a sleep the abort cut short", async () => {
    const wf: WorkflowDescription = { id: 'rs', entries: [{ kind: 'sleep', id: 'nap', duration: { perRun: true } }, { kind: 'step', id: 'z' }] };
    const mutant = compile(wf, { gadgets: { sleep: strip(sleepGadget, '.resume', 1) } });
    expect(cancelStructureViolations(mutant)).toEqual([
      "'t.0.nap.resume' competes with sweep 't.0.nap.cancel-waited' for [s.0.nap.waited] without an inhibitor on 'wf.cancel'",
    ]);
    await expect(verifyWorkflow(mutant)).rejects.toThrow(/cancellation structure is unsound/);

    const run = async (compiled: CompiledWorkflow) => {
      const ac = new AbortController();
      const r = new RecordingRunner({ waits: { nap: () => (setTimeout(() => ac.abort(), 30), 60_000) } });
      const rep = await runWorkflowDetailed(compiled, 1, { runner: r, signal: ac.signal, timeoutMs: 10_000 });
      return { outcome: rep.outcome, records: statuses(rep), calls: r.calls };
    };
    expect(await run(compile(wf))).toEqual({ outcome: { status: 'canceled', origin: { stepId: 'nap', path: [0] }, started: true }, records: ['nap:waiting'], calls: [] });
    // Mutant: the cut-short sleep resumes as a success, overwriting its waiting record; `z`'s sweep cancels.
    expect(await run(mutant)).toEqual({ outcome: { status: 'canceled', origin: { stepId: 'z', path: [1] }, started: false }, records: ['nap:success'], calls: [] });
  }, 120_000);

  it('settle stage, inhibited half: flagged by the structural check, and a canceled run reports its success', async () => {
    const intact = compile(steps3);
    const mutant = withTransitions(intact, (t) =>
      t.name === 't.settle.done' || t.name === 't.settle.failed' ? rebuilt(t, { dropInhibitors: true, priority: 1 }) : t,
    );
    expect([...cancelStructureViolations(mutant)].sort()).toEqual([
      "'t.settle.done' competes with sweep 't.settle.done.canceled' for [wf.settle.done] without an inhibitor on 'wf.cancel'",
      "'t.settle.failed' competes with sweep 't.settle.failed.canceled' for [wf.settle.failed] without an inhibitor on 'wf.cancel'",
    ]);
    await expect(verifyWorkflow(mutant)).rejects.toThrow(/cancellation structure is unsound/);

    const abortIn = async (compiled: CompiledWorkflow, outcome: StepOutcome) => {
      const ac = new AbortController();
      const r = new RecordingRunner({ c: () => (ac.abort(), outcome) });
      return runWorkflow(compiled, 1, { runner: r, signal: ac.signal });
    };
    expect(await abortIn(intact, { status: 'success', output: 'z' })).toEqual({ status: 'canceled', started: true });
    expect(await abortIn(mutant, { status: 'success', output: 'z' })).toEqual({ status: 'success', output: 'z' });
    expect(await abortIn(intact, { status: 'failed', error: 'e' })).toEqual({
      status: 'canceled',
      origin: { stepId: 'c', path: [2] },
      started: true,
    });
    expect(await abortIn(mutant, { status: 'failed', error: 'e' })).toEqual({ status: 'failed', stepId: 'c', path: [2], error: 'e' });
  }, 120_000);

  it.each(['done', 'failed'] as const)('settle stage, canceled half of %s removed: the cancel segment sees the settled token strand', async (outcome) => {
    const intact = compile(steps3);
    const mutant = withTransitions(intact, (t) => (t.name === `t.settle.${outcome}.canceled` ? null : t));
    expect([...mutant.net.transitions].length).toBe([...intact.net.transitions].length - 1);
    expect(cancelStructureViolations(mutant)).toEqual([]);
    const v = await prove(`settle without canceled half (${outcome})`, mutant);
    // The settle stage ends every run, resumed ones included: every cancel segment flips.
    expect(v).toStrictEqual({
      ...allProven(mutant),
      ...violated(['cancel', 'resume@0+cancel', 'resume@1+cancel', 'resume@2+cancel'], 'deadlockFree', 'exactlyOneTerminal'),
    });

    const ac = new AbortController();
    const r = new RecordingRunner({
      c: () => (ac.abort(), outcome === 'done' ? { status: 'success', output: 1 } : { status: 'failed', error: 'e' }),
    });
    await expect(runWorkflow(mutant, 1, { runner: r, signal: ac.signal, timeoutMs: 300 })).rejects.toThrow(/timed out/);
  }, 120_000);

  it.each([
    {
      label: "a step sweep's read arc",
      name: 't.1.b.cancel',
      // `b`'s input is resume site 1, so the resume gate check names the unguarded consumer and
      // the missing sweep, exactly — `verifyWorkflow` refuses it before proving.
      gate: [
        "'t.1.b.cancel' consumes resume site 1 ('s.1.b.in') without an inhibitor on 'wf.cancel'",
        "resume site 1 ('s.1.b.in') has no sweep: nothing reads 'wf.cancel' and consumes it",
      ],
      // A run resumed at `c` (site 2) is past `b` and cannot reach the unguarded sweep.
      reaches: ['closed', 'resume@0', 'resume@1'],
    },
    {
      label: "the settle stage's canceled half's read arc",
      name: 't.settle.done.canceled',
      // The settle stage consumes no resume site: the gate check is silent.
      gate: [],
      // Every run ends through the settle stage, resumed ones included.
      reaches: ['closed', 'resume@0', 'resume@1', 'resume@2'],
    },
  ])('$label removed: structurally silent, and closed/neverCanceled is violated', async ({ name, gate, reaches }) => {
    const intact = compile(steps3);
    const mutant = withTransitions(intact, (t) => (t.name === name ? withoutReads(t) : t));
    // It no longer reads the signal, so it is not a sweep and competes with nothing the check
    // looks at. Every quiescence property stays proven: the net still drains to one terminal —
    // sometimes the wrong one, which only the reachability bound on `wf.canceled` sees.
    expect(cancelStructureViolations(mutant)).toEqual([]);
    expect(resumeGateViolations(mutant)).toStrictEqual(gate);
    if (gate.length > 0) await expect(verifyWorkflow(mutant)).rejects.toThrow(/resume gate structure is unsound/);
    const v = await prove(`${name} without read`, mutant, gate.length > 0 ? { structure: 'skip' } : {});
    expect(v).toStrictEqual({ ...allProven(mutant), ...violated(reaches, 'neverCanceled') });
  }, 120_000);

  it("the sweep's read arc, removed: the run flips too — canceled with no signal at all", async () => {
    const mutant = withTransitions(compile(steps3), (t) => (t.name === 't.1.b.cancel' ? withoutReads(t) : t));
    const r = new RecordingRunner();
    // The unguarded sweep and `b`'s start are both enabled; the sweep is emitted first and wins.
    expect(await runWorkflow(mutant, 1, { runner: r })).toEqual({ status: 'canceled', origin: { stepId: 'b', path: [1] }, started: false });
    expect(r.calls).toEqual(['a']);
    expect(await runWorkflow(compile(steps3), 1, { runner: new RecordingRunner() })).toEqual({ status: 'success', output: 1 });
  });

  it('the arrival removed: structurally silent, and the cancel segment sees the request strand', async () => {
    const mutant = withTransitions(compile(steps3), (t) => (t.name === 't.cancel.arrive' ? null : t));
    expect(cancelStructureViolations(mutant)).toEqual([]);
    const v = await prove('no arrival', mutant);
    // The request is not a sink, so a run that finishes with it still pending is a deadlock; it
    // still reaches exactly one terminal (`wf.done`), so only `deadlockFree` sees it.
    // The same in every resume segment a cancel request is seeded in.
    expect(v).toStrictEqual({
      ...allProven(mutant),
      ...violated(['cancel', 'resume@0+cancel', 'resume@1+cancel', 'resume@2+cancel'], 'deadlockFree'),
    });
  }, 120_000);
});

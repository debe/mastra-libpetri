import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createStep, createWorkflow, type ExecutionGraph } from '@mastra/core/workflows';
import { RequestContext } from '@mastra/core/di';
import { EventEmitterPubSub } from '@mastra/core/events';
import { StepExecutor } from '@mastra/core/workflows/evented';
import { compile, type CompiledWorkflow, type EntryDescription } from '../../src/compiler/index.js';
import { resumeSeed, UnresumablePositionError } from '../../src/compiler/resume.js';
import { ladderToken, restartSeed, UnrestartablePositionError } from '../../src/compiler/restart.js';
import { initialCounts, initialMarking, runWorkflowDetailed } from '../../src/engine/kernel.js';
import { segmentInitialMarking } from '../../src/verify/index.js';
import { CompensatorSuspendedError, MastraStepRunner, type MastraStepRunnerOptions } from '../../src/mastra/runner.js';
import { attemptGate } from '../../src/mastra/attempt-gate.js';
import { attachResources } from '../../src/mastra/resources.js';
import { StepTimeoutError } from '../../src/compiler/timeout.js';
import { ladderLevel } from '../../src/compiler/blueprints/compensate.js';
import { CompensatorSuspendedError as Exported, init } from '../../src/mastra/index.js';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import type { StepCall, StepRecord } from '../../src/compiler/types.js';

/**
 * The host's half of `compensate` ([ADR 0017], M7b W1 host), with the runner called directly and on
 * the kernel:
 *
 * - **the detached signal** — a compensator's attempt (`StepCall.detached`) hears only its own
 *   deadline, never the run's abort, before the call or during it; its `abort()` is still the run's;
 * - **the compensator is resolved** at the view path `[k]` from the forward step's `STEP_RESOURCES`,
 *   by id, and never confused with the forward step;
 * - **a dynamic suspend is rewritten** `failed`, non-retryable, with no resume label written and none
 *   overwritten, and its `setState` dropped (row 125);
 * - **inputs** — the compensator is handed the forward output from the ladder's token on a fresh run,
 *   and from the stored records on a restart or a resume (`ladderToken`, the one seed with the
 *   verifier's `segmentInitialMarking`), newest first; a stack that cannot be rebuilt is refused
 *   before anything runs.
 *
 * `compensate` is attached by hand with `attachResources` and described by hand: the petri
 * `createStep` and the adapter are the surface's, tested in `compensate-surface.test.ts`.
 */

type Wf = any;
type Ctx = Record<string, any>;

const wf = (id = 'w'): Wf =>
  createWorkflow({ id, inputSchema: z.any(), outputSchema: z.any(), stateSchema: z.any() } as never);
const step = (id: string, fn: (ctx: Ctx) => unknown, extra: Record<string, unknown> = {}) =>
  createStep({ id, inputSchema: z.any(), outputSchema: z.any(), stateSchema: z.any(), execute: async (ctx: unknown) => fn(ctx as Ctx), ...extra } as never);

/** `forward` carrying `undo` as its compensator, as the surface attaches it. */
function undoable<T extends object>(forward: T, undo: object): T {
  attachResources(forward, { compensate: undo });
  return forward;
}

function direct(w: Wf, extra: Partial<MastraStepRunnerOptions> = {}) {
  const graph = w.buildExecutionGraph() as ExecutionGraph;
  const abortController = new AbortController();
  const runner = new MastraStepRunner({
    executor: new StepExecutor({ mastra: { pubsub: new EventEmitterPubSub() } as never }),
    graph,
    workflowId: graph.id,
    runId: 'run-1',
    requestContext: new RequestContext(),
    abortController,
    initialState: { k: 0 },
    validateInputs: true,
    resourceId: undefined,
    mastra: undefined,
    ...extra,
  });
  return { runner, abortController };
}

const call = (path: readonly number[], run: AbortController, records: ReadonlyMap<string, StepRecord> = new Map(), extra: Partial<StepCall> = {}): StepCall => ({
  path,
  initData: 'init',
  getStepResult: (id) => records.get(id),
  abortSignal: run.signal,
  source: 'step',
  attempt: 0,
  ...extra,
});

const success = (output: unknown, payload: unknown = null): StepRecord => ({ status: 'success', output, payload, startedAt: 1, endedAt: 2 });

/** A marking's token counts by place name: what `initialCounts` must equal. */
const countsOf = (m: ReadonlyMap<{ name: string }, readonly unknown[]>) => new Map([...m].map(([p, ts]) => [p.name, ts.length]));

const aborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener('abort', () => resolve(), { once: true })));

describe('the attempt gate of a compensator (StepCall.detached)', () => {
  it('without a deadline: a signal of its own that the run\'s abort never reaches; abort() is still the run\'s', () => {
    const run = new AbortController();
    run.abort('canceled before');
    const gate = attemptGate('undo', { path: [0], attempt: 0, abortSignal: run.signal, detached: true }, run);
    expect(gate.controller).not.toBe(run);
    expect(gate.controller.signal.aborted).toBe(false);
    expect(gate.decisive).toBe(false);
    expect(gate.freeze()).toEqual({ kind: 'own' });
    const later = new AbortController();
    const g2 = attemptGate('undo', { path: [0], attempt: 0, abortSignal: later.signal, detached: true }, later);
    later.abort('canceled during');
    expect(g2.controller.signal.aborted).toBe(false);
    g2.controller.abort('from the step');
    expect(later.signal.reason).toBe('canceled during');
    const fresh = new AbortController();
    attemptGate('undo', { path: [0], attempt: 0, abortSignal: fresh.signal, detached: true }, fresh).controller.abort('own abort()');
    expect(fresh.signal.reason).toBe('own abort()');
  });

  it('control: the same calls without detached hear the run', () => {
    const run = new AbortController();
    run.abort('canceled before');
    expect(attemptGate('s', { path: [0], attempt: 0, abortSignal: run.signal }, run).controller.signal.aborted).toBe(true);
    const deadline = new AbortController();
    const later = new AbortController();
    const gate = attemptGate('s', { path: [0], attempt: 0, abortSignal: later.signal, deadline: deadline.signal }, later);
    later.abort('cancel');
    expect(gate.controller.signal.reason).toBe('cancel');
  });

  it('with a deadline: the run\'s abort is not a source, the deadline is, and decides timedOut', () => {
    const run = new AbortController();
    const deadline = new AbortController();
    const gate = attemptGate('undo', { path: [1], attempt: 0, abortSignal: run.signal, deadline: deadline.signal, detached: true }, run);
    expect(gate.decisive).toBe(true);
    run.abort('cancel');
    expect(gate.controller.signal.aborted).toBe(false);
    expect(gate.verdict()).toEqual({ kind: 'own' });
    const expiry = new StepTimeoutError('undo', [1], 5, 0);
    deadline.abort(expiry);
    expect(gate.controller.signal.reason).toBe(expiry);
    expect(gate.freeze()).toEqual({ kind: 'timedOut', reason: expiry });
    // Pre-aborted run and a deadline that has not fired: still own, still not aborted.
    const pre = new AbortController();
    pre.abort('before');
    const d2 = new AbortController();
    const g2 = attemptGate('undo', { path: [1], attempt: 0, abortSignal: pre.signal, deadline: d2.signal, detached: true }, pre);
    expect(g2.controller.signal.aborted).toBe(false);
    expect(g2.expired()).toBe(false);
    // Read from the signals once unlinked: the run's abort is still no source, so the deadline decides.
    g2.release();
    d2.abort(expiry);
    expect(g2.verdict()).toEqual({ kind: 'timedOut', reason: expiry });
  });
});

describe('the runner on a compensator call', () => {
  const build = (onUndo: (ctx: Ctx) => unknown, onForward: (ctx: Ctx) => unknown = () => 'forward ran') => {
    const undo = step('release', onUndo);
    const reserve = undoable(step('reserve', onForward), undo);
    return direct(wf().then(reserve).then(step('boom', () => { throw new Error('boom'); })).commit());
  };

  it('resolves the compensator at the compensated entry\'s path, by id; the input is the forward output, getStepResult reads the forward record', async () => {
    let seen: Ctx | undefined;
    const { runner, abortController } = build((ctx) => {
      seen = { input: ctx.inputData, fwd: ctx.getStepResult('reserve'), init: ctx.getInitData() };
      return 'released';
    });
    const records = new Map([['reserve', success({ seat: 7 }, 'req')]]);
    const outcome = await runner.run('release', { seat: 7 }, call([0], abortController, records, { detached: true }));
    expect(outcome).toMatchObject({ status: 'success', output: 'released', payload: { seat: 7 } });
    expect(seen).toEqual({ input: { seat: 7 }, fwd: { seat: 7 }, init: 'init' });
  });

  it('refuses a detached call whose id is not the compensator\'s, and a compensator id without detached', async () => {
    const { runner, abortController } = build(() => 'released');
    await expect(runner.run('reserve', 1, call([0], abortController, new Map(), { detached: true }))).rejects.toThrow(
      "no compensator 'reserve' for the step at path 0 in workflow 'w'",
    );
    await expect(runner.run('release', 1, call([1], abortController, new Map(), { detached: true }))).rejects.toThrow(
      "no compensator 'release' for the step at path 1",
    );
    await expect(runner.run('release', 1, call([0], abortController))).rejects.toThrow("no step 'release' at path 0");
  });

  it('a step that honours abortSignal runs its undo after a cancel: aborted before the call', async () => {
    const { runner, abortController } = build(({ abortSignal }) => ((abortSignal as AbortSignal).aborted ? 'skipped' : 'released'));
    abortController.abort('cancel');
    const outcome = await runner.run('release', 1, call([0], abortController, new Map(), { detached: true }));
    expect(outcome).toMatchObject({ status: 'success', output: 'released' });
  });

  it('a step that honours abortSignal runs its undo after a cancel: aborted during the call', async () => {
    let gate!: () => void;
    const reached = new Promise<void>((r) => (gate = r));
    const { runner, abortController } = build(async ({ abortSignal }) => {
      gate();
      await new Promise((r) => setTimeout(r, 5));
      return (abortSignal as AbortSignal).aborted ? 'skipped' : 'released';
    });
    const running = runner.run('release', 1, call([0], abortController, new Map(), { detached: true }));
    await reached;
    abortController.abort('cancel mid-undo');
    expect(await running).toMatchObject({ status: 'success', output: 'released' });
    expect(abortController.signal.aborted).toBe(true);
  });

  it('control: the forward step on the same aborted run sees the abort', async () => {
    const { runner, abortController } = build(() => 'released', ({ abortSignal }) => ((abortSignal as AbortSignal).aborted ? 'saw abort' : 'no abort'));
    abortController.abort('cancel');
    expect(await runner.run('reserve', 1, call([0], abortController))).toMatchObject({ output: 'saw abort' });
  });

  it('a timed compensator times out on its deadline, not on the run\'s abort', async () => {
    let fire!: () => void;
    const reasons: unknown[] = [];
    const { runner, abortController } = build(async ({ abortSignal }) => {
      const signal = abortSignal as AbortSignal;
      abortController.abort('cancel');
      reasons.push(signal.aborted);
      queueMicrotask(() => fire());
      await aborted(signal);
      reasons.push(signal.reason);
      return 'late';
    });
    const deadline = new AbortController();
    const expiry = new StepTimeoutError('release', [0], 5, 0);
    fire = () => deadline.abort(expiry);
    const outcome = await runner.run('release', 1, call([0], abortController, new Map(), { detached: true, deadline: deadline.signal }));
    expect(reasons).toEqual([false, expiry]);
    expect(outcome.verdict).toEqual({ kind: 'timedOut' });
  });

  it('a compensator that suspends dynamically is rewritten failed, non-retryable; no label written or overwritten; setState dropped', async () => {
    const { runner, abortController } = direct(
      wf()
        .then(
          undoable(
            step('reserve', async ({ suspend }) => suspend({ why: 'forward' }, { resumeLabel: 'shared' })),
            step('release', async ({ suspend, setState }) => {
              await setState({ k: 99 });
              return suspend({ why: 'undo' }, { resumeLabel: ['shared', 'own'] });
            }),
          ),
        )
        .then(step('z', () => 1))
        .commit(),
    );
    // A live label of the same name, written by the forward step.
    const forward = await runner.run('reserve', 1, call([0], abortController));
    expect(forward.status).toBe('suspended');
    expect(runner.resumeLabels).toEqual({ shared: { stepId: 'reserve', foreachIndex: undefined } });

    const outcome = await runner.run('release', { seat: 1 }, call([0], abortController, new Map(), { detached: true }));
    expect(outcome.status).toBe('failed');
    expect(outcome).toMatchObject({ nonRetryable: true, payload: { seat: 1 } });
    const error = (outcome as { error: unknown }).error;
    expect(error).toBeInstanceOf(CompensatorSuspendedError);
    expect(error).toMatchObject({ name: 'CompensatorSuspendedError', stepId: 'release', path: [0], suspendPayload: { why: 'undo' } });
    expect(outcome).not.toHaveProperty('suspendPayload');
    expect((outcome as { host?: Record<string, unknown> }).host).not.toHaveProperty('suspendPayload');
    expect(runner.resumeLabels).toEqual({ shared: { stepId: 'reserve', foreachIndex: undefined } });
    expect(runner.state).toEqual({ k: 0 });
  });
});

// ---- On the kernel: the ladder's token, fresh and rehydrated ------------------------------------

/** `[reserve*, charge*, gate, boom]`: `gate` can suspend; `boom` fails. */
const entries: readonly EntryDescription[] = [
  { kind: 'step', id: 'reserve', compensate: { kind: 'step', id: 'release' } },
  { kind: 'step', id: 'charge', compensate: { kind: 'step', id: 'refund' } },
  { kind: 'step', id: 'gate' },
  { kind: 'step', id: 'boom' },
];

interface Saga {
  readonly compiled: CompiledWorkflow;
  readonly w: Wf;
  readonly log: string[];
  readonly undone: [string, unknown][];
}

function saga(options: { gate?: (ctx: Ctx) => unknown; refund?: (ctx: Ctx) => unknown; boom?: () => void; entries?: readonly EntryDescription[] } = {}): Saga {
  const log: string[] = [];
  const undone: [string, unknown][] = [];
  const release = step('release', ({ inputData }) => (undone.push(['release', inputData]), 'released'));
  const refund = step('refund', async (ctx) => {
    undone.push(['refund', ctx.inputData]);
    return options.refund ? options.refund(ctx) : 'refunded';
  });
  const reserve = undoable(step('reserve', ({ inputData }) => (log.push('reserve'), { seat: inputData })), release);
  const charge = undoable(step('charge', ({ inputData }) => (log.push('charge'), { charge: (inputData as { seat: unknown }).seat })), refund);
  const gate = step('gate', (ctx) => (log.push('gate'), options.gate ? options.gate(ctx) : ctx.inputData));
  const boom = step('boom', () => {
    log.push('boom');
    options.boom?.();
    throw new Error('boom');
  });
  const w = wf('saga').then(reserve).then(charge).then(gate).then(boom).commit();
  return { compiled: compile({ id: 'saga', entries: options.entries ?? entries }), w, log, undone };
}

describe('compensator inputs on the kernel', () => {
  it('fresh: from the token, newest first; the run keeps the original error', async () => {
    const s = saga();
    const { runner, abortController } = direct(s.w);
    const report = await runWorkflowDetailed(s.compiled, 'A1', { runner, signal: abortController.signal, timeoutMs: 10_000 });
    expect(s.log).toEqual(['reserve', 'charge', 'gate', 'boom']);
    expect(s.undone).toEqual([
      ['refund', { charge: 'A1' }],
      ['release', { seat: 'A1' }],
    ]);
    expect(report.outcome).toMatchObject({ status: 'failed', stepId: 'boom', path: [3] });
    expect(report.outcome).not.toHaveProperty('residue');
    expect(report.stepResults.get('refund')).toMatchObject({ status: 'success', output: 'refunded', payload: { charge: 'A1' } });
  });

  it('restart at 2: rebuilt from the stored records, not from re-run forward steps', async () => {
    const s = saga();
    const { runner, abortController } = direct(s.w);
    const records = new Map<string, StepRecord>([
      ['reserve', success({ seat: 'stored-seat' })],
      ['charge', success({ charge: 'stored-charge' })],
    ]);
    const seed = restartSeed(s.compiled, { activePaths: [2], records, input: { charge: 'stored-charge' } });
    const report = await runWorkflowDetailed(s.compiled, 'ignored', { runner, signal: abortController.signal, timeoutMs: 10_000, restart: seed, stepResults: records });
    expect(s.log).toEqual(['gate', 'boom']);
    expect(s.undone).toEqual([
      ['refund', { charge: 'stored-charge' }],
      ['release', { seat: 'stored-seat' }],
    ]);
    expect(report.outcome).toMatchObject({ status: 'failed', stepId: 'boom' });
    expect(report.outcome).not.toHaveProperty('residue');
  });

  it('restart at 1: only the steps before it are on the stack; charge re-runs and is armed afresh', async () => {
    const s = saga();
    const { runner, abortController } = direct(s.w);
    const records = new Map<string, StepRecord>([['reserve', success({ seat: 'stored-seat' })]]);
    const seed = restartSeed(s.compiled, { activePaths: [1], records, input: { seat: 'stored-seat' } });
    await runWorkflowDetailed(s.compiled, 'ignored', { runner, signal: abortController.signal, timeoutMs: 10_000, restart: seed, stepResults: records });
    expect(s.undone).toEqual([
      ['refund', { charge: 'stored-seat' }],
      ['release', { seat: 'stored-seat' }],
    ]);
  });

  it('resume at the suspended gate: rebuilt from the stored records', async () => {
    const s = saga({ gate: ({ resumeData, suspend }) => (resumeData === undefined ? suspend({}) : resumeData) });
    const records = new Map<string, StepRecord>([
      ['reserve', success({ seat: 'R' })],
      ['charge', success({ charge: 'C' })],
      ['gate', { status: 'suspended', payload: { charge: 'C' }, suspendPayload: {}, startedAt: 1, suspendedAt: 2 }],
    ]);
    const { runner, abortController } = direct(s.w, { resume: { payload: 'go', steps: ['gate'], records } });
    const seed = resumeSeed(s.compiled, { path: [2], steps: ['gate'], records });
    const report = await runWorkflowDetailed(s.compiled, 'ignored', { runner, signal: abortController.signal, timeoutMs: 10_000, resume: seed, stepResults: records });
    expect(s.log).toEqual(['gate', 'boom']);
    expect(s.undone).toEqual([
      ['refund', { charge: 'C' }],
      ['release', { seat: 'R' }],
    ]);
    expect(report.outcome).toMatchObject({ status: 'failed', stepId: 'boom' });
  });

  it('a cancel mid-rollback: the compensator\'s signal stays unaborted, the rollback finishes, the run ends canceled', async () => {
    let abortRun!: () => void;
    const seen: boolean[] = [];
    const s = saga({
      refund: async ({ abortSignal }) => {
        abortRun();
        await new Promise((r) => setTimeout(r, 5));
        seen.push((abortSignal as AbortSignal).aborted);
        return 'refunded';
      },
    });
    const { runner, abortController } = direct(s.w);
    abortRun = () => abortController.abort('cancel');
    const report = await runWorkflowDetailed(s.compiled, 'A1', { runner, signal: abortController.signal, timeoutMs: 10_000 });
    expect(seen).toEqual([false]);
    expect(s.undone.map(([id]) => id)).toEqual(['refund', 'release']);
    expect(report.outcome).toMatchObject({ status: 'canceled' });
    expect(report.outcome).not.toHaveProperty('residue');
  });

  it('a stack that cannot be rebuilt is refused before anything runs', () => {
    const s = saga();
    const partial = new Map<string, StepRecord>([['reserve', success('R')]]);
    expect(() => restartSeed(s.compiled, { activePaths: [2], records: partial, input: null })).toThrow(UnrestartablePositionError);
    expect(() => restartSeed(s.compiled, { activePaths: [2], records: partial, input: null })).toThrow(
      "the compensated step 'charge' at [1] has no stored record, so the rollback stack (level 2) cannot be rebuilt",
    );
    const failedCharge = new Map<string, StepRecord>([...partial, ['charge', { status: 'failed', error: new Error('x'), payload: 1 }], ['gate', { status: 'suspended', payload: 1, suspendPayload: {} }]]);
    expect(() => resumeSeed(s.compiled, { path: [2], steps: ['gate'], records: failedCharge })).toThrow(UnresumablePositionError);
    expect(() => resumeSeed(s.compiled, { path: [2], steps: ['gate'], records: failedCharge })).toThrow("has a stored 'failed' record");
    // The kernel refuses on its own too, given a seed built elsewhere.
    expect(() => initialMarking(s.compiled, 'x', { restart: { site: s.compiled.boundaries[2]!, value: { data: 1 } }, stepResults: partial })).toThrow(
      "the compensated step 'charge' at [1] has no stored record",
    );
  });

  it('the kernel seeds the level ladderToken names, with the stack; it agrees with the verifier\'s segment markings', () => {
    const s = saga();
    const site = s.compiled.compensations!;
    const records = new Map<string, StepRecord>([
      ['reserve', success('R')],
      ['charge', success('C')],
      ['gate', { status: 'suspended', payload: 1, suspendPayload: {} }],
    ]);
    const byName = (m: ReadonlyMap<{ name: string }, unknown>) => new Map([...m].map(([p, v]) => [p.name, v]));
    const levelTokens = (m: ReadonlyMap<{ name: string }, readonly { value: unknown }[]>) =>
      [...m].filter(([p]) => site.levels.includes(p.name)).map(([p, ts]) => [p.name, ts.map((t) => t.value)]);

    const fresh = initialMarking(s.compiled, 'x', {});
    expect(levelTokens(fresh)).toEqual([[site.levels[0], [[]]]]);
    expect(byName(initialCounts(s.compiled, s.compiled.entryPlace))).toEqual(byName(segmentInitialMarking(s.compiled, 'closed')));

    for (const p of [0, 1, 2, 3]) {
      const seed = restartSeed(s.compiled, { activePaths: [p], records, input: 1 });
      const marking = initialMarking(s.compiled, 1, { restart: seed, stepResults: records });
      const a = Math.min(p, 2);
      expect(levelTokens(marking)).toEqual([[site.levels[a], [['R', 'C'].slice(0, a)]]]);
      expect(ladderToken(s.compiled, p, (id) => records.get(id))).toEqual({ place: site.levels[a], level: a, value: ['R', 'C'].slice(0, a) });
      expect(byName(initialCounts(s.compiled, seed.site.place))).toEqual(byName(segmentInitialMarking(s.compiled, { restart: p, cancel: false })));
      // Independent of `initialCounts`: the marking the kernel runs, counted, against the formula.
      expect(ladderLevel(site, p).place).toBe(site.levels[a]);
      expect(countsOf(marking)).toEqual(byName(initialCounts(s.compiled, seed.site.place)));
    }
    const resumed = resumeSeed(s.compiled, { path: [2], steps: ['gate'], records });
    expect(levelTokens(initialMarking(s.compiled, 1, { resume: resumed, stepResults: records }))).toEqual([[site.levels[2], [['R', 'C']]]]);
    expect(byName(initialCounts(s.compiled, resumed.site.place))).toEqual(byName(segmentInitialMarking(s.compiled, { resume: '2', cancel: false })));
  });
});

// ---- W1 review fixes --------------------------------------------------------------------------

describe('a compensator\'s own timeout after a cancel (armDeadline detached), on the kernel', () => {
  /** `refund` has `timeoutMs: 20` and honours its signal: it returns once the signal fires, or after 300 ms. */
  const timed: readonly EntryDescription[] = [
    entries[0]!,
    { kind: 'step', id: 'charge', compensate: { kind: 'step', id: 'refund', timeoutMs: 20 } },
    entries[2]!,
    entries[3]!,
  ];
  const honours = (seen: unknown[], before?: () => void) => async ({ abortSignal }: Ctx) => {
    before?.();
    const signal = abortSignal as AbortSignal;
    await Promise.race([aborted(signal), new Promise((r) => setTimeout(r, 300))]);
    seen.push(signal.aborted ? signal.reason : 'never aborted');
    return 'refunded';
  };
  const expectTimedOut = (report: Awaited<ReturnType<typeof runWorkflowDetailed>>, seen: unknown[]) => {
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(StepTimeoutError);
    const record = report.stepResults.get('refund');
    expect(record?.status).toBe('failed');
    expect((record as { error?: unknown }).error).toBeInstanceOf(StepTimeoutError);
  };

  it('canceled during the compensator\'s call: its deadline still fires, the record is the timeout, the rollback goes on', async () => {
    const seen: unknown[] = [];
    let abortRun!: () => void;
    const s = saga({ entries: timed, refund: honours(seen, () => abortRun()) });
    const { runner, abortController } = direct(s.w);
    abortRun = () => abortController.abort('cancel mid-rollback');
    const started = Date.now();
    const report = await runWorkflowDetailed(s.compiled, 'A1', { runner, signal: abortController.signal, timeoutMs: 10_000 });
    expectTimedOut(report, seen);
    expect(Date.now() - started).toBeLessThan(250);
    expect(s.undone.map(([id]) => id)).toEqual(['refund', 'release']);
    expect(report.outcome).toMatchObject({ status: 'canceled' });
  });

  it('canceled before the compensator is called: armed on an aborted run, its deadline still fires', async () => {
    const seen: unknown[] = [];
    let abortRun!: () => void;
    const s = saga({ entries: timed, refund: honours(seen), boom: () => abortRun() });
    const { runner, abortController } = direct(s.w);
    abortRun = () => abortController.abort('cancel before the rollback');
    const report = await runWorkflowDetailed(s.compiled, 'A1', { runner, signal: abortController.signal, timeoutMs: 10_000 });
    expectTimedOut(report, seen);
    expect(s.undone.map(([id]) => id)).toEqual(['refund', 'release']);
  });

  it('control: without a cancel the same compensator times out the same way', async () => {
    const seen: unknown[] = [];
    const s = saga({ entries: timed, refund: honours(seen) });
    const { runner, abortController } = direct(s.w);
    const report = await runWorkflowDetailed(s.compiled, 'A1', { runner, signal: abortController.signal, timeoutMs: 10_000 });
    expectTimedOut(report, seen);
    expect(report.outcome).toMatchObject({ status: 'failed', stepId: 'boom' });
  });
});

describe('a compensator on an agent or a tool forward step (#resolveCompensator)', () => {
  const N = z.object({ n: z.number() });
  const petri = init({ iterationBound: 3 });
  const tool = createTool({ id: 'double', description: 'doubles n', inputSchema: N, outputSchema: N, execute: async (input) => ({ n: input.n * 2 }) });
  const agent = new Agent({ id: 'stubby', name: 'stubby', instructions: 'be brief', model: {} as never });

  it('a tool step: the graph holds a declarative tool entry; the compensator is resolved from its options and run', async () => {
    const seen: unknown[] = [];
    const undo = petri.createStep({ id: 'undo-double', inputSchema: N, outputSchema: z.any(), execute: async ({ inputData }) => (seen.push(inputData), 'undone') });
    const w = petri
      .createWorkflow({ id: 'tw', inputSchema: N, outputSchema: z.any() })
      .then(petri.createStep(tool, { compensate: undo }))
      .then(petri.createStep({ id: 'fail', inputSchema: N, outputSchema: N, execute: async () => { throw new Error('fail'); } }))
      .commit();
    const { runner, abortController } = direct(w);
    expect((w.buildExecutionGraph() as ExecutionGraph).steps[0]).toMatchObject({ type: 'tool' });
    const outcome = await runner.run('undo-double', { n: 2 }, call([0], abortController, new Map([['double', success({ n: 2 })]]), { detached: true }));
    expect(outcome).toMatchObject({ status: 'success', output: 'undone' });
    expect(seen).toEqual([{ n: 2 }]);
  });

  it('a tool step, end to end on the engine: the forward output is undone after a later failure', async () => {
    const seen: unknown[] = [];
    const undo = petri.createStep({ id: 'undo-double', inputSchema: N, outputSchema: z.any(), execute: async ({ inputData }) => (seen.push(inputData), 'undone') });
    const w = petri
      .createWorkflow({ id: 'te', inputSchema: N, outputSchema: z.any() })
      .then(petri.createStep(tool, { compensate: undo }))
      .then(petri.createStep({ id: 'fail', inputSchema: N, outputSchema: N, execute: async () => { throw new Error('fail'); } }))
      .commit();
    const mastra = new Mastra({ storage: new InMemoryStore(), workflows: { te: w } as never, logger: false });
    const registered = (mastra as unknown as { getWorkflow(id: string): { createRun(): Promise<{ start(o: { inputData: unknown }): Promise<{ status: string; steps: Record<string, { status: string; output?: unknown }> }> }> } }).getWorkflow('te');
    const result = await (await registered.createRun()).start({ inputData: { n: 1 } });
    expect(result.status).toBe('failed');
    expect(seen).toEqual([{ n: 2 }]);
    expect(result.steps['undo-double']).toMatchObject({ status: 'success', output: 'undone' });
  });

  it('an agent step: the graph holds a declarative agent entry; the compensator is resolved from its options and run', async () => {
    const seen: unknown[] = [];
    const undo = petri.createStep({ id: 'undo-stubby', inputSchema: z.object({ text: z.string() }), outputSchema: z.any(), execute: async ({ inputData }) => (seen.push(inputData), 'undone') });
    const w = petri
      .createWorkflow({ id: 'aw', inputSchema: z.object({ prompt: z.string() }), outputSchema: z.any() })
      .then(petri.createStep(agent, { compensate: undo }))
      .then(petri.createStep({ id: 'fail', inputSchema: z.any(), outputSchema: z.any(), execute: async () => { throw new Error('fail'); } }))
      .commit();
    const { runner, abortController } = direct(w);
    expect((w.buildExecutionGraph() as ExecutionGraph).steps[0]).toMatchObject({ type: 'agent' });
    const outcome = await runner.run('undo-stubby', { text: 'hi' }, call([0], abortController, new Map(), { detached: true }));
    expect(outcome).toMatchObject({ status: 'success', output: 'undone' });
    expect(seen).toEqual([{ text: 'hi' }]);
  });
});

describe('runner guards on a compensator call', () => {
  it('a detached call at a nested path is refused, never resolved to the top-level step\'s compensator', async () => {
    const undo = step('release', () => 'released');
    const { runner, abortController } = direct(wf().then(undoable(step('reserve', () => 1), undo)).then(step('boom', () => { throw new Error('boom'); })).commit());
    await expect(runner.run('release', 1, call([0, 0], abortController, new Map(), { detached: true }))).rejects.toThrow(
      "no compensator 'release' for the step at path 0-0",
    );
  });

  it('a timed compensator that suspends keeps its frozen verdict on the rewritten failure', async () => {
    const { runner, abortController } = direct(
      wf()
        .then(undoable(step('reserve', () => 1), step('release', async ({ suspend }) => suspend({ why: 'undo' }))))
        .then(step('z', () => 1))
        .commit(),
    );
    const deadline = new AbortController();
    const outcome = await runner.run('release', 1, call([0], abortController, new Map(), { detached: true, deadline: deadline.signal }));
    expect(outcome.status).toBe('failed');
    expect((outcome as { error: unknown }).error).toBeInstanceOf(CompensatorSuspendedError);
    expect(outcome.verdict).toEqual({ kind: 'own' });
  });

  it('CompensatorSuspendedError is exported from the package\'s mastra entry', () => {
    expect(Exported).toBe(CompensatorSuspendedError);
  });
});

describe('resume and restart refusals and nested sites', () => {
  const s = (id: string) => ({ kind: 'step' as const, id });
  /** `[a*, b*, c, parallel(p0, p1), z]`. */
  const nested = compile({
    id: 'n',
    entries: [
      { kind: 'step', id: 'a', compensate: { kind: 'step', id: 'ua' } },
      { kind: 'step', id: 'b', compensate: { kind: 'step', id: 'ub' } },
      s('c'),
      { kind: 'parallel', id: 'p', arms: [s('p0'), s('p1')] },
      s('z'),
    ],
  } as never);
  const suspended = (payload: unknown = 1): StepRecord => ({ status: 'suspended', payload, suspendPayload: {} }) as StepRecord;
  const reasonOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (error) {
      return (error as { reason: string }).reason;
    }
    throw new Error('expected a refusal');
  };

  it('a resume at a nested path [3, 0] seeds the level of path[0], with its stack', () => {
    const site = nested.resumeSites.get('3.0')!;
    expect(site.path).toEqual([3, 0]);
    const records = new Map<string, StepRecord>([['a', success('A')], ['b', success('B')], ['c', success('C')], ['p0', suspended()], ['p1', success('P1')]]);
    const seed = resumeSeed(nested, { path: [3, 0], steps: ['p0'], records });
    const marking = initialMarking(nested, 1, { resume: seed, stepResults: records });
    const ladder = nested.compensations!;
    expect([...marking].filter(([p]) => ladder.levels.includes(p.name)).map(([p, ts]) => [p.name, ts.map((t) => t.value)])).toEqual([[ladder.levels[2], [['A', 'B']]]]);
    expect(countsOf(marking)).toEqual(new Map([...initialCounts(nested, seed.site.place)].map(([p, n]) => [p.name, n])));
    expect(ladderLevel(ladder, 3).place).toBe(ladder.levels[2]);
  });

  it('a resume at [3, 0] whose stack cannot be rebuilt is refused as unsupported', () => {
    const records = new Map<string, StepRecord>([['a', success('A')], ['c', success('C')], ['p0', suspended()], ['p1', success('P1')]]);
    const request = { path: [3, 0], steps: ['p0'], records };
    expect(reasonOf(() => resumeSeed(nested, request))).toBe('unsupported');
    expect(() => resumeSeed(nested, request)).toThrow("the compensated step 'b' at [1] has no stored record");
  });

  it('the resume refusal for an unrebuildable stack is unsupported, never no-site', () => {
    const sg = saga();
    const records = new Map<string, StepRecord>([['reserve', success('R')], ['gate', suspended()]]);
    expect(reasonOf(() => resumeSeed(sg.compiled, { path: [2], steps: ['gate'], records }))).toBe('unsupported');
  });

  it('a kind-specific refusal keeps its reason over an unrebuildable stack: foreach-nested', () => {
    const fe = compile({
      id: 'f',
      entries: [{ kind: 'step', id: 'a', compensate: { kind: 'step', id: 'ua' } }, { kind: 'foreach', id: 'fe', concurrency: 1, body: s('item') }, s('z')],
    } as never);
    const [key, site] = [...fe.resumeSites].find(([, v]) => v.kind === 'foreach')!;
    const request = { path: key.split('.').map(Number), steps: [site.stepId, 'inner'], records: new Map<string, StepRecord>() };
    expect(reasonOf(() => resumeSeed(fe, request))).toBe('foreach-nested');
  });

  it('a kind-specific refusal keeps its message over an unrebuildable stack: a parallel sibling with no record', () => {
    const records = new Map<string, StepRecord>([['p0', suspended()]]);
    expect(() => resumeSeed(nested, { path: [3, 0], steps: ['p0'], records })).toThrow("its sibling 'p1' at [3, 1] has no stored record");
  });

  it('a restart over a compensated entry whose record is suspended or bailed is refused', () => {
    const sg = saga();
    for (const record of [suspended(), { status: 'bailed', output: 'x', payload: 1 } as unknown as StepRecord]) {
      const records = new Map<string, StepRecord>([['reserve', success('R')], ['charge', record]]);
      expect(() => restartSeed(sg.compiled, { activePaths: [2], records, input: null })).toThrow(UnrestartablePositionError);
      expect(() => restartSeed(sg.compiled, { activePaths: [2], records, input: null })).toThrow(`has a stored '${record.status}' record`);
    }
  });

  it('initialCounts on a laddered workflow refuses a start place that is no segment start', () => {
    const sg = saga();
    const stray = [...sg.compiled.net.places].find((p) => p !== sg.compiled.entryPlace && !sg.compiled.boundaries.some((b) => b.place === p) && ![...sg.compiled.resumeSites.values()].some((r) => r.place === p))!;
    expect(() => initialCounts(sg.compiled, stray)).toThrow(`'${stray.name}' is neither the entry place, a restart boundary nor a resume site`);
  });
});

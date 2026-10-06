/**
 * **`compensate` end to end** ([ADR 0017], M7b W2): workflows built with `init()`'s factories, the
 * petri `createStep({ compensate })`, run through Mastra's own `Run` over a real `Mastra` and
 * `InMemoryStore`, with the real ladder, leaves, run scope, runner and result formatting.
 *
 * The saga is `[reserve*, mid, charge*, boom, tail]` (`*` compensated: `reserve` by `release`,
 * `charge` by `refund`); `boom` fails unless told otherwise, so `tail` runs only in a control.
 *
 * - **The rollback**: a later failure undoes each completed compensated step once, newest first,
 *   before the terminal row and before `onFinish` then `onError`; the compensator's input is the
 *   forward step's output; the run keeps the original `error` shape and tripwire (rows 119, 120).
 * - **Not compensated**: a step that failed (row 121); anything on a cancel with no failure (row 123).
 * - **Discharged**: a run that succeeds, bails or suspends at the top level undoes nothing; a resumed
 *   run that then fails rolls back what ran before the suspension (row 119, the ladder's discharge).
 * - **Decision 2**: a compensator that fails leaves the rest running, the run's error the original,
 *   and its failure in its own record (row 122); one that suspends dynamically is recorded `failed`
 *   with `CompensatorSuspendedError`, never retried (row 125); one that bails is settled and the rest
 *   run; its `setState` applies only on success (row 128).
 * - **Decision 3**: a failure then a cancel mid-rollback finishes the rollback and ends `canceled`;
 *   a compensator does not hear the run's cancel, but its own `timeout` still fires (detached
 *   deadline); a **forward** step's deadline is disarmed by the run's abort (row 123, mutant N2); a
 *   compensator's own `abort()` cancels the run, and the rollback still finishes (row 123).
 * - **Shapes**: retries on a compensated step arm it once; a compensator's own retries; a tool and an
 *   agent forward step; a compensated step reused via `cloneStep(step, { id, compensate })`; a restart
 *   from a checkpoint before `k_1` (row 126); `limit(1)` shared by a forward step and a compensator.
 *
 * **No wall-clock time decides an assertion.** Every run is on a `ManualClock` ([TIME-015]); the
 * cases about deadlines use {@link HeldClock}, a `ManualClock` whose finite sleeps wait until the
 * case releases them and which counts the sleeps it holds, so a deadline cannot fire before the cancel
 * it is measured against, and whether it is still armed is read, not inferred. The one real timer is
 * the deadline loop's own start, a `setTimeout(0)` macrotask (`engine/scope.ts` `armDeadline`); a
 * case that needs that loop to have started waits a {@link timerTurn} of its own, created after the
 * deadline was armed — Node runs timers of equal delay in creation order, so the loop has run first
 * whatever the clamp or the load. No case counts `setImmediate` turns against that timer. An
 * interleaving a case depends on is forced by a gate: a step holds on {@link must} until an event the
 * run or the case must produce. Each case has a 10 s timeout: a mutant that strands the net hangs the
 * run (a Mastra run always carries a signal, so a stranded net waits rather than ends), and the case
 * then fails in seconds rather than at the suite's minute.
 *
 * **The twin** is the same saga without `compensate`, cloned by Mastra's own `cloneWorkflow` onto
 * `DefaultExecutionEngine` ({@link twin}): equal error shapes, tripwires and `stepExecutionPath` are
 * measured against Mastra itself, not against this engine on the bare saga.
 *
 * Each case names the src mutation that breaks it (`M…`, listed with their kills in the W2 report).
 *
 * Environment: `@mastra/core` 1.67.0 from the pinned registry package, libpetri 8.0.0 from npm (not
 * linked), a `ManualClock` for every run. Tested, not proven: these are values the value-blind
 * verifier cannot see; the ladder's order and coverage are proven in `tests/verify/compensate.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { Agent, TripWire } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { cloneWorkflow } from '@mastra/core/workflows';
import type { WorkflowRunState } from '@mastra/core/workflows';
import { init } from '../../src/mastra/index.js';
import { StepTimeoutError } from '../../src/compiler/timeout.js';
import { ManualClock } from '../support/manual-clock.js';

const EPOCH = 1_700_000_000_000;

/** Per case: a stranding mutant fails here, not at the suite's 60 s. */
const RUN_TIMEOUT = 10_000;

const N = z.object({ n: z.number() });
const Seat = z.object({ seat: z.number(), attempt: z.number() });
const Charge = z.object({ charge: z.number() });
const ANY = z.any();

/**
 * A `ManualClock` whose finite sleeps wait for {@link release} (or for their own abort or `ready`):
 * a deadline armed on it cannot fire before the case says so. After `release` it is a `ManualClock`.
 * Unbounded sleeps (the executor's idle wait) yield a turn as before. {@link held} is how many finite
 * sleeps wait right now: a deadline still armed, since a disarmed one aborts its sleep.
 */
class HeldClock extends ManualClock {
  #released = false;
  #wake = new Set<() => void>();

  get held(): number {
    return this.#wake.size;
  }

  release(): void {
    this.#released = true;
    const wake = [...this.#wake];
    this.#wake.clear();
    for (const w of wake) w();
  }

  override async sleep(delayMs: number, ready: () => boolean, signal: AbortSignal): Promise<void> {
    if (!this.#released && Number.isFinite(delayMs) && !signal.aborted && !ready()) {
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          this.#wake.delete(wake);
          resolve();
        };
        this.#wake.add(wake);
        signal.addEventListener('abort', wake, { once: true });
      });
      if (signal.aborted || ready() || !this.#released) return;
    }
    return super.sleep(delayMs, ready, signal);
  }
}

/** Polls `cond` on the macrotask queue for at most `turns` turns; no time is read. */
async function until(cond: () => boolean, turns: number): Promise<boolean> {
  for (let i = 0; i < turns && !cond(); i++) await new Promise<void>((resolve) => setImmediate(resolve));
  return cond();
}

/** `n` macrotask turns, for a step that should look busy; nothing is measured against them. */
async function turns(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * One `setTimeout(0)` of the caller's own. Node runs timers of equal delay in the order they were
 * created, so every `setTimeout(0)` created before this one — a deadline loop's start — has run when
 * it resolves, and the microtasks that callback queued with it: no clamp, load or turn count decides.
 */
const timerTurn = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * The cap on a {@link must}, in macrotask turns. Every event waited on is one the run or the case
 * produces without the waiter's help, so a correct run needs a handful; the cap only turns a
 * mutant's hang into a named failure.
 */
const MUST_TURNS = 10_000;

/** Waits for an event that must come; past {@link MUST_TURNS} throws, naming it. */
async function must(cond: () => boolean, what: string): Promise<void> {
  if (!(await until(cond, MUST_TURNS))) throw new Error(`never held in ${MUST_TURNS} turns: ${what}`);
}

/**
 * {@link must}, while `run` is pending: should the run settle first (a mutant that refuses or ends
 * it early), its own error or outcome is raised instead of waiting out the cap, and its rejection
 * is never left unobserved.
 */
async function mustWhile(run: Promise<unknown>, cond: () => boolean, what: string): Promise<void> {
  let ended: { readonly error?: unknown; readonly value?: unknown } | undefined;
  run.then(
    (value) => void (ended = { value }),
    (error: unknown) => void (ended = { error }),
  );
  await must(() => cond() || ended !== undefined, what);
  if (!cond() && ended !== undefined) {
    if ('error' in ended) throw ended.error;
    throw new Error(`the run ended before ${what}: ${JSON.stringify((ended.value as { status?: unknown }).status)}`);
  }
}

/** What a step's `execute` is handed, as far as these steps read it. */
interface Ctx {
  inputData: any;
  state: Record<string, unknown>;
  setState(s: unknown): Promise<void>;
  getStepResult(id: string): unknown;
  getInitData(): unknown;
  suspend(p: unknown, o?: unknown): Promise<unknown>;
  abortSignal: AbortSignal;
  retryCount: number;
  resumeData?: unknown;
  bail(result: unknown): unknown;
  /** The controller's `abort()`: cancels the run (`handlers/step.ts`). */
  abort(): void;
}
type Hook = (ctx: Ctx) => unknown;

interface Event {
  readonly type: string;
  readonly payload?: Record<string, unknown>;
}

interface StepRec {
  readonly status: string;
  readonly output?: unknown;
  readonly payload?: unknown;
  readonly error?: unknown;
}
interface Result {
  readonly status: string;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly tripwire?: unknown;
  readonly state?: Record<string, unknown>;
  readonly steps: Record<string, StepRec>;
  readonly stepExecutionPath?: readonly string[];
}
interface RunLike {
  readonly runId: string;
  watch(cb: (e: Event) => void): unknown;
  start(o: unknown): Promise<Result>;
  restart(o?: unknown): Promise<Result>;
  cancel(): Promise<void>;
  resume(o: unknown): Promise<Result>;
}

/** The shared trace of one case: steps, callbacks and stored rows, in the order they happened. */
class World {
  readonly log: string[] = [];
  readonly inputs = new Map<string, unknown[]>();
  readonly events: Event[] = [];
  readonly rows: WorkflowRunState[] = [];
  run: RunLike | undefined;

  saw(id: string, input: unknown): void {
    this.log.push(id);
    this.inputs.set(id, [...(this.inputs.get(id) ?? []), input]);
  }

  /** How many times `id` ran (attempts included). */
  count(id: string): number {
    return this.log.filter((e) => e === id).length;
  }

  /** The log without the store's non-terminal writes. */
  trace(): string[] {
    return this.log.filter((e) => e !== 'persist:running' && e !== 'persist:pending');
  }
}

interface SagaOptions {
  readonly id?: string;
  readonly clock?: ManualClock;
  /** Overrides a step's behaviour; its log entry and input are recorded first either way. */
  readonly hooks?: Partial<Record<'reserve' | 'mid' | 'charge' | 'boom' | 'release' | 'refund', Hook>>;
  /** Extra params per step (`retries`, `timeout`, `uses`, `metadata`). */
  readonly extra?: Partial<Record<'prep' | 'reserve' | 'mid' | 'charge' | 'boom' | 'release' | 'refund', Record<string, unknown>>>;
  /** Without the `compensate` keys: the control. */
  readonly bare?: boolean;
  /** A leading `prep` step (a checkpoint carrier) before `reserve`. */
  readonly prep?: boolean;
}

/** The thrown error: a custom field (`code`) so its shape is more than name and message. */
const boomError = () => Object.assign(new Error('boom'), { code: 'E1' });

/**
 * `[prep?, reserve*, mid, charge*, boom, tail]`. `reserve` returns `{ seat: n + 1, attempt }`,
 * `charge` `{ charge: seat * 10 }`; the compensators return `{ undone: <input> }`. Every step logs
 * its id and input to `w` before its hook runs.
 */
function saga(w: World, o: SagaOptions = {}) {
  const api = init({ clock: o.clock ?? new ManualClock(EPOCH) });
  const create = api.createStep as unknown as (params: Record<string, unknown>) => unknown;
  const step = (id: keyof NonNullable<SagaOptions['extra']> | 'tail', inputSchema: z.ZodTypeAny, outputSchema: z.ZodTypeAny, fallback: Hook, more: Record<string, unknown> = {}) =>
    create({
      id,
      inputSchema,
      outputSchema,
      stateSchema: ANY,
      execute: async (ctx: Ctx) => {
        w.saw(id, ctx.inputData);
        const hook = (o.hooks as Record<string, Hook | undefined> | undefined)?.[id];
        return (hook ?? fallback)(ctx);
      },
      ...(o.extra as Record<string, Record<string, unknown>> | undefined)?.[id],
      ...more,
    });
  const release = step('release', Seat, ANY, ({ inputData }) => ({ undone: inputData }));
  const refund = step('refund', Charge, ANY, ({ inputData }) => ({ undone: inputData }));
  const prep = step('prep', N, N, ({ inputData }) => inputData);
  const reserve = step('reserve', N, Seat, ({ inputData, retryCount }) => ({ seat: inputData.n + 1, attempt: retryCount }), o.bare ? {} : { compensate: release });
  const mid = step('mid', Seat, Seat, ({ inputData }) => inputData);
  const charge = step('charge', Seat, Charge, ({ inputData }) => ({ charge: inputData.seat * 10 }), o.bare ? {} : { compensate: refund });
  const boom = step('boom', Charge, Charge, () => {
    throw boomError();
  });
  const tail = step('tail', Charge, Charge, ({ inputData }) => inputData);
  const id = o.id ?? 'saga';
  let chain = api
    .createWorkflow({
      id,
      inputSchema: N,
      outputSchema: ANY,
      stateSchema: ANY,
      options: {
        onFinish: (info: { status: string; steps: Record<string, unknown> }) => void w.log.push(`onFinish:${info.status}:${Object.keys(info.steps).join(',')}`),
        onError: (info: { status: string; steps: Record<string, unknown> }) => void w.log.push(`onError:${info.status}:${Object.keys(info.steps).join(',')}`),
      },
    } as never) as unknown as { then(s: unknown): typeof chain; commit(): unknown };
  if (o.prep) chain = chain.then(prep);
  return chain.then(reserve).then(mid).then(charge).then(boom).then(tail).commit();
}

/** A fresh `Mastra` over a fresh store, every write recorded into `w` (and logged as `persist:<status>`). */
async function host(workflows: Record<string, unknown>, w: World, storage = new InMemoryStore()) {
  const mastra = new Mastra({ storage, workflows: workflows as never, logger: false });
  const store = (await storage.getStore('workflows'))!;
  const real = store.persistWorkflowSnapshot.bind(store);
  store.persistWorkflowSnapshot = async (args) => {
    w.rows.push(structuredClone(args.snapshot));
    w.log.push(`persist:${args.snapshot.status}`);
    return real(args);
  };
  const workflow = (id: string) => (mastra as unknown as { getWorkflow(id: string): { createRun(o?: unknown): Promise<RunLike> } }).getWorkflow(id);
  return { storage, store, real, workflow };
}

/**
 * Runs `workflow` on a fresh host from `{ n: 1 }`; `during` sees the run before it starts (to
 * cancel it from a step, or to drive a gate). Every event goes to `w.events`.
 */
async function go(workflow: unknown, w: World, during?: (run: RunLike) => void) {
  const id = (workflow as { id: string }).id;
  const h = await host({ [id]: workflow }, w);
  const run = await h.workflow(id).createRun({ runId: `${id}-run` });
  w.run = run;
  run.watch((e) => w.events.push(e));
  during?.(run);
  const res = await run.start({ inputData: { n: 1 }, initialState: {}, outputOptions: { includeState: true } });
  return { res, run, ...h };
}

/**
 * The twin: the saga without `compensate`, cloned by Mastra's `cloneWorkflow` (`create.ts`) onto
 * Mastra's own `DefaultExecutionEngine` — past the type checker, which refuses it (row 61) — and run
 * as {@link go} runs any workflow. Mastra stops at the first non-success, so it undoes nothing.
 */
async function twin(w: World, o: SagaOptions = {}) {
  const workflow = (cloneWorkflow as unknown as (w: unknown, o: { id: string }) => { executionEngine: object; id: string })(saga(w, { ...o, bare: true, id: 'twin-src' }), { id: 'twin' });
  expect(workflow.executionEngine.constructor.name).toBe('DefaultExecutionEngine');
  return go(workflow, w);
}

/** The last row written: the terminal one. */
const terminalRow = (w: World) => w.rows.at(-1)!;

/** A record's error as a plain shape (it is a plain `Object` after formatting, an `Error` before). */
const shapeOf = (e: unknown) => (e === undefined ? undefined : (JSON.parse(JSON.stringify({ ...(e as object), name: (e as Error).name, message: (e as Error).message })) as Record<string, unknown>));

describe('a later step fails: the rollback', () => {
  it('undoes each completed compensated step once, newest first, before the terminal row, onFinish and onError', async () => {
    // Breaks if (M1 = W0 MUT7): `t.comp.finish` does not take `level.0` — the failed terminal can then
    // land as soon as the failure is raised, the kernel stops at the terminal, and the undos run
    // after it or never.
    const w = new World();
    const { res } = await go(saga(w), w);
    expect(res.status).toBe('failed');
    const keys = 'input,reserve,mid,charge,boom,refund,release';
    expect(w.trace()).toEqual(['reserve', 'mid', 'charge', 'boom', 'refund', 'release', 'persist:failed', `onFinish:failed:${keys}`, `onError:failed:${keys}`]);
    expect(Object.keys(res.steps)).toEqual(keys.split(','));
    expect(res.steps['refund']).toMatchObject({ status: 'success', output: { undone: { charge: 20 } } });
    expect(res.steps['release']).toMatchObject({ status: 'success', output: { undone: { seat: 2, attempt: 0 } } });
    expect(res.steps['tail']).toBeUndefined();
    // The terminal row holds the compensator records; the run wrote exactly one terminal row.
    expect(w.rows.filter((r) => r.status !== 'running' && r.status !== 'pending').map((r) => r.status)).toEqual(['failed']);
    expect(terminalRow(w).context['refund']).toMatchObject({ status: 'success' });
    expect(terminalRow(w).context['release']).toMatchObject({ status: 'success' });
    // The contract (lead's decision, W2): `stepExecutionPath` is the **forward** path, the twin's —
    // the compensators are not on it; their records and events carry the rollback (row 120).
    const t = await twin(new World());
    expect(t.res.status).toBe('failed');
    expect(res.stepExecutionPath).toEqual(['reserve', 'mid', 'charge', 'boom']);
    expect(res.stepExecutionPath).toEqual(t.res.stepExecutionPath);
    // Row 120: each compensator publishes start, result and finish, after the failed step's result,
    // one compensator after the other, newest first. (Run.watch's events carry no executionPath.)
    const trail = w.events
      .filter((e) => ['workflow-step-start', 'workflow-step-result', 'workflow-step-finish'].includes(e.type))
      .map((e) => `${String(e.payload?.id)}:${e.type.slice('workflow-step-'.length)}`);
    const boomResult = trail.indexOf('boom:result');
    expect(boomResult).toBeGreaterThan(-1);
    expect(trail.slice(boomResult + 1).filter((e) => !e.startsWith('boom:'))).toEqual([
      'refund:start',
      'refund:result',
      'refund:finish',
      'release:start',
      'release:result',
      'release:finish',
    ]);
  }, RUN_TIMEOUT);

  it('hands each compensator the forward step\'s output; getStepResult(forward) reads the forward record', async () => {
    // Breaks if (M2): `t.comp.{j}.start` takes the bottom of the stack instead of the top —
    // `refund` would then be handed `reserve`'s output and fail its schema, `release` `charge`'s.
    const w = new World();
    const seen: unknown[] = [];
    const { res } = await go(
      saga(w, {
        hooks: {
          refund: ({ inputData, getStepResult, getInitData }) => (seen.push(['refund', getStepResult('charge'), getInitData()]), { undone: inputData }),
          release: ({ inputData, getStepResult }) => (seen.push(['release', getStepResult('reserve')]), { undone: inputData }),
        },
      }),
      w,
    );
    expect(w.inputs.get('refund')).toEqual([{ charge: 20 }]);
    expect(w.inputs.get('release')).toEqual([{ seat: 2, attempt: 0 }]);
    expect(seen).toEqual([
      ['refund', { charge: 20 }, { n: 1 }],
      ['release', { seat: 2, attempt: 0 }],
    ]);
    // The compensator's record payload is its input, as any step's.
    expect(res.steps['refund']).toMatchObject({ payload: { charge: 20 } });
    expect(res.steps['release']).toMatchObject({ payload: { seat: 2, attempt: 0 } });
  }, RUN_TIMEOUT);

  it('keeps the original error\'s shape — the twin\'s, custom field included — with the undos in between', async () => {
    // Breaks if (M3): `t.comp.raise` holds a rebuilt failure (`new Error(message)`) instead of the
    // token it took — `code` is then lost from the run's error. `control` is the twin: Mastra's own
    // engine on the saga without `compensate`.
    const w = new World();
    const { res } = await go(saga(w), w);
    const c = new World();
    const control = await twin(c);
    expect(control.res.status).toBe('failed');
    expect(c.log).not.toContain('release');
    expect(res.status).toBe('failed');
    expect(res.error).toMatchObject({ name: 'Error', message: 'boom', code: 'E1' });
    expect(shapeOf(res.error)).toEqual(shapeOf(control.res.error));
    expect(shapeOf(terminalRow(w).error)).toEqual(shapeOf(terminalRow(c).error));
    expect(res.steps['boom']).toMatchObject({ status: 'failed' });
  }, RUN_TIMEOUT);

  it('keeps the original tripwire: status, reason, retry, metadata and processorId, the twin\'s', async () => {
    // Breaks if (M4): `t.comp.raise` holds only `{ stepId, path, error }` of the failure — the
    // `tripwire` field is dropped and the run ends `failed`.
    const trip = () => {
      throw new TripWire('blocked', { retry: false, metadata: { rule: 'r1' } }, 'proc-1');
    };
    const w = new World();
    const { res } = await go(saga(w, { hooks: { boom: trip } }), w);
    const c = new World();
    const control = await twin(c, { hooks: { boom: trip } });
    expect(res.status).toBe('tripwire');
    expect(res.tripwire).toEqual({ reason: 'blocked', retry: false, metadata: { rule: 'r1' }, processorId: 'proc-1' });
    expect(res.tripwire).toEqual(control.res.tripwire);
    expect(control.res.status).toBe('tripwire');
    expect(w.trace().slice(0, 6)).toEqual(['reserve', 'mid', 'charge', 'boom', 'refund', 'release']);
    expect(terminalRow(w).status).toBe('tripwire');
  }, RUN_TIMEOUT);
});

describe('what is not compensated', () => {
  it('a failed step: charge fails, so only reserve is undone', async () => {
    // Breaks if (M5): a compensated entry is armed as it starts, not as it completes (each level
    // armed at the success of the entry before it) — the failed `charge` then has `refund` begun on
    // its input, and `release` is handed `prep`'s output. `prep` leads so that entry exists.
    const w = new World();
    const { res } = await go(
      saga(w, {
        prep: true,
        hooks: {
          charge: () => {
            throw new Error('charge failed after its effect');
          },
        },
      }),
      w,
    );
    expect(res.status).toBe('failed');
    expect(res.error).toMatchObject({ message: 'charge failed after its effect' });
    expect(w.trace().slice(0, 5)).toEqual(['prep', 'reserve', 'mid', 'charge', 'release']);
    expect(w.inputs.get('release')).toEqual([{ seat: 2, attempt: 0 }]);
    expect(w.count('refund')).toBe(0);
    expect(res.steps['refund']).toBeUndefined();
    expect(res.steps['release']).toMatchObject({ status: 'success' });
  }, RUN_TIMEOUT);

  it('a cancel with no failure: the run ends canceled and nothing is undone', async () => {
    // Breaks if (M6, decision 3 B): the intercepted cancel is raised as a failure — the sweep's
    // canceled token goes to `wf.comp.failure`, and both undos run before the run ends canceled.
    const w = new World();
    const { res } = await go(
      saga(w, {
        hooks: {
          mid: async ({ inputData }) => {
            await w.run!.cancel();
            return inputData;
          },
        },
      }),
      w,
    );
    expect(res.status).toBe('canceled');
    expect(w.log.filter((e) => !e.startsWith('persist:'))).toEqual(['reserve', 'mid', 'onFinish:canceled:input,reserve,mid']);
    expect(w.count('release')).toBe(0);
    expect(res.steps['release']).toBeUndefined();
  }, RUN_TIMEOUT);
});

describe('discharged: the run does not fail, so nothing is undone', () => {
  it('succeeds: tail runs, nothing undone, the result and path are the twin\'s', async () => {
    // Breaks if (A3): the discharge on success is routed to the bailed settle — the run then
    // crashes in the kernel's stop (`Cannot read properties of undefined`).
    const pass: Hook = ({ inputData }) => inputData;
    const w = new World();
    const { res } = await go(saga(w, { hooks: { boom: pass } }), w);
    const t = await twin(new World(), { hooks: { boom: pass } });
    expect(res.status).toBe('success');
    expect(res.result).toEqual({ charge: 20 });
    expect(w.trace()).toEqual(['reserve', 'mid', 'charge', 'boom', 'tail', 'persist:success', 'onFinish:success:input,reserve,mid,charge,boom,tail']);
    expect(w.count('refund') + w.count('release')).toBe(0);
    expect(res.stepExecutionPath).toEqual(['reserve', 'mid', 'charge', 'boom', 'tail']);
    expect(t.res.status).toBe('success');
    expect(res.result).toEqual(t.res.result);
    expect(res.stepExecutionPath).toEqual(t.res.stepExecutionPath);
  }, RUN_TIMEOUT);

  it('bails after compensated steps: the run succeeds with the bail\'s result, nothing undone, as the twin', async () => {
    // Breaks if (B1): the top-level bail is discharged to the failed settle — the run then ends
    // `failed`. A bail is a success in Mastra (`default.ts`), so nothing is undone.
    const bail: Hook = ({ bail }) => bail({ charge: 99 });
    const w = new World();
    const { res } = await go(saga(w, { hooks: { boom: bail } }), w);
    const t = await twin(new World(), { hooks: { boom: bail } });
    expect(res.status).toBe('success');
    expect(res.result).toEqual({ charge: 99 });
    expect(w.trace()).toEqual(['reserve', 'mid', 'charge', 'boom', 'persist:success', 'onFinish:success:input,reserve,mid,charge,boom']);
    expect(t.res.status).toBe('success');
    expect(res.result).toEqual(t.res.result);
    expect(res.stepExecutionPath).toEqual(t.res.stepExecutionPath);
  }, RUN_TIMEOUT);

  it('suspends at the top level after compensated steps: nothing undone; resumed and then failing, it rolls back both', async () => {
    // Breaks if (S1): the top-level suspension is discharged to the failed settle — the run ends
    // `failed` at once. Breaks if (R1): the resume seeds the ladder at level 0 — refused, the marking
    // is not the one the segment is proven from. Breaks if (R2): the resume rebuilds the stack in the
    // wrong order — the undos are handed each other's input and the rollback does not run as pinned.
    const w = new World();
    const { res, run } = await go(
      saga(w, {
        hooks: {
          boom: async ({ suspend, resumeData }) => {
            if (resumeData === undefined) return suspend({ why: 'wait' });
            throw boomError();
          },
        },
      }),
      w,
    );
    expect(res.status).toBe('suspended');
    expect(res.steps['boom']).toMatchObject({ status: 'suspended' });
    expect(w.trace()).toEqual(['reserve', 'mid', 'charge', 'boom', 'persist:suspended', 'onFinish:suspended:input,reserve,mid,charge,boom']);
    expect(terminalRow(w).status).toBe('suspended');

    const before = w.trace().length;
    const res2 = await run.resume({ step: 'boom', resumeData: { go: true } });
    expect(res2.status).toBe('failed');
    expect(res2.error).toMatchObject({ message: 'boom', code: 'E1' });
    const keys = 'input,reserve,mid,charge,boom,refund,release';
    expect(w.trace().slice(before)).toEqual(['boom', 'refund', 'release', 'persist:failed', `onFinish:failed:${keys}`, `onError:failed:${keys}`]);
    expect(w.inputs.get('refund')).toEqual([{ charge: 20 }]);
    expect(w.inputs.get('release')).toEqual([{ seat: 2, attempt: 0 }]);
    expect(res2.steps['refund']).toMatchObject({ status: 'success' });
    expect(res2.steps['release']).toMatchObject({ status: 'success' });
  }, RUN_TIMEOUT);
});

describe('decision 2: a compensator that does not succeed', () => {
  it('fails: the rest still run, the run keeps the original error, the failure is in its own record', async () => {
    // Breaks if (M7): `t.comp.{j}.settle.failed` hands down an empty stack — `release` then gets no
    // input and fails its schema. Breaks too if (M7b) the failed settle is not emitted: the rollback
    // strands after `refund` and the case times out.
    const w = new World();
    const { res } = await go(
      saga(w, {
        hooks: {
          refund: () => {
            throw new Error('refund broke');
          },
        },
      }),
      w,
    );
    expect(res.status).toBe('failed');
    expect(res.error).toMatchObject({ message: 'boom', code: 'E1' });
    expect(w.trace().slice(0, 6)).toEqual(['reserve', 'mid', 'charge', 'boom', 'refund', 'release']);
    expect(res.steps['refund']).toMatchObject({ status: 'failed', error: { message: 'refund broke' } });
    expect(res.steps['release']).toMatchObject({ status: 'success', output: { undone: { seat: 2, attempt: 0 } } });
    expect(terminalRow(w).context['refund']).toMatchObject({ status: 'failed' });
  }, RUN_TIMEOUT);

  it('suspends dynamically: recorded failed with CompensatorSuspendedError, never retried, no label written, the rollback continues', async () => {
    // Breaks if (M8): the runner does not rewrite a compensator's suspension — its record stays
    // `suspended`, and its label is written to the run's resume labels. Breaks if (A1): the rewrite
    // is retryable (`nonRetryable: false`) — `refund`, with `retries: 2`, then runs three times.
    const w = new World();
    const { res } = await go(
      saga(w, {
        extra: { refund: { retries: 2 } },
        hooks: {
          refund: async ({ suspend, setState, state }) => {
            await setState({ ...state, refundSuspended: true });
            return suspend({ why: 'undo' }, { resumeLabel: 'undo-label' });
          },
        },
      }),
      w,
    );
    expect(res.status).toBe('failed');
    expect(res.error).toMatchObject({ message: 'boom' });
    // The record's error carries the compensator, its view path and the suspend payload.
    expect(res.steps['refund']).toMatchObject({ status: 'failed', error: { name: 'CompensatorSuspendedError', stepId: 'refund', path: [2], suspendPayload: { why: 'undo' } } });
    expect((res.steps['refund']!.error as Error).message).toMatch(/^compensator 'refund' .* suspended/);
    expect(w.count('refund')).toBe(1);
    expect(res.steps['release']).toMatchObject({ status: 'success' });
    expect(w.trace().slice(4, 6)).toEqual(['refund', 'release']);
    const row = terminalRow(w);
    expect(row.status).toBe('failed');
    expect(row.resumeLabels ?? {}).toEqual({});
    expect(row.suspendedPaths ?? {}).toEqual({});
    expect(res.state).not.toHaveProperty('refundSuspended');
  }, RUN_TIMEOUT);

  it('setState applies on a compensator\'s success and is dropped on its failure', async () => {
    // Breaks if (M9): the runner applies a failed attempt's `setState` — `refunded` then reaches the
    // run's state.
    const w = new World();
    const { res } = await go(
      saga(w, {
        hooks: {
          reserve: async ({ inputData, setState, state, retryCount }) => (await setState({ ...state, reserved: true }), { seat: inputData.n + 1, attempt: retryCount }),
          boom: async ({ setState, state }) => {
            await setState({ ...state, boomed: true });
            throw boomError();
          },
          refund: async ({ setState, state }) => {
            await setState({ ...state, refunded: true });
            throw new Error('refund broke');
          },
          release: async ({ inputData, setState, state }) => (await setState({ ...state, released: true }), { undone: inputData }),
        },
      }),
      w,
    );
    expect(res.status).toBe('failed');
    // Forward writes persist (as Mastra), the failing step's is dropped (`handlers/step.ts:574-577`),
    // the successful compensator's applies, the failed one's is dropped.
    expect(res.state).toEqual({ reserved: true, released: true });
    expect(terminalRow(w).value).toEqual({ reserved: true, released: true });
  }, RUN_TIMEOUT);

  it('bails: settled as bailed, the rest still run, the run keeps the original error', async () => {
    // Breaks if (A8): a compensator's `bailed` outcome has no settle — the leaf's bailed exit has no
    // consumer, and the run rejects (or strands) after `refund` instead of running `release`.
    const w = new World();
    const { res } = await go(saga(w, { hooks: { refund: ({ bail }) => bail({ gave: 'up' }) } }), w);
    expect(res.status).toBe('failed');
    expect(res.error).toMatchObject({ message: 'boom', code: 'E1' });
    expect(w.trace()).toEqual(['reserve', 'mid', 'charge', 'boom', 'refund', 'release', 'persist:failed', `onFinish:failed:input,reserve,mid,charge,boom,refund,release`, `onError:failed:input,reserve,mid,charge,boom,refund,release`]);
    expect(res.steps['refund']).toMatchObject({ status: 'bailed', output: { gave: 'up' } });
    expect(res.steps['release']).toMatchObject({ status: 'success', output: { undone: { seat: 2, attempt: 0 } } });
  }, RUN_TIMEOUT);
});

describe('decision 3: cancel and the rollback', () => {
  it('a failure then a cancel mid-rollback: the rollback finishes, undisturbed, and the run ends canceled', async () => {
    // Breaks if (M10 = S5): the compensator leaves are emitted with the cancel signal — `release`
    // is then swept before it starts. Breaks if (M11): the attempt gate ignores `detached` — `refund`
    // then sees the run's abort on its signal.
    const w = new World();
    const signals: boolean[] = [];
    const { res } = await go(
      saga(w, {
        hooks: {
          refund: async ({ inputData, abortSignal }) => {
            await w.run!.cancel();
            await turns(5);
            signals.push(abortSignal.aborted);
            return { undone: inputData };
          },
          release: ({ inputData, abortSignal }) => (signals.push(abortSignal.aborted), { undone: inputData }),
        },
      }),
      w,
    );
    expect(res.status).toBe('canceled');
    expect(w.trace().filter((e) => !e.startsWith('persist:') && !e.startsWith('on'))).toEqual(['reserve', 'mid', 'charge', 'boom', 'refund', 'release']);
    expect(signals).toEqual([false, false]);
    expect(res.steps['refund']).toMatchObject({ status: 'success', output: { undone: { charge: 20 } } });
    expect(res.steps['release']).toMatchObject({ status: 'success', output: { undone: { seat: 2, attempt: 0 } } });
    expect(terminalRow(w).status).toBe('canceled');
    // On a cancel `onError` is never called; `onFinish` sees the compensator records.
    expect(w.log.filter((e) => e.startsWith('on'))).toEqual(['onFinish:canceled:input,reserve,mid,charge,boom,refund,release']);
  }, RUN_TIMEOUT);

  it('a compensator\'s own abort() cancels the run; its signal stays quiet, the rollback finishes, the run ends canceled', async () => {
    // Breaks if (A11): the detached gate's `controller.abort` (no deadline) does not reach the run's
    // controller — the run then ends `failed`, and `onError` is called.
    const w = new World();
    const signals: boolean[] = [];
    const { res } = await go(
      saga(w, {
        hooks: {
          refund: ({ inputData, abort, abortSignal }) => {
            abort();
            signals.push(abortSignal.aborted);
            return { undone: inputData };
          },
          release: ({ inputData, abortSignal }) => (signals.push(abortSignal.aborted), { undone: inputData }),
        },
      }),
      w,
    );
    expect(res.status).toBe('canceled');
    expect(signals).toEqual([false, false]);
    expect(res.steps['refund']).toMatchObject({ status: 'success', output: { undone: { charge: 20 } } });
    expect(res.steps['release']).toMatchObject({ status: 'success', output: { undone: { seat: 2, attempt: 0 } } });
    expect(terminalRow(w).status).toBe('canceled');
    expect(w.trace()).toEqual(['reserve', 'mid', 'charge', 'boom', 'refund', 'release', 'persist:canceled', 'onFinish:canceled:input,reserve,mid,charge,boom,refund,release']);
  }, RUN_TIMEOUT);

  it('a compensator ignores the run\'s cancel, but its own timeout fires (the detached deadline)', async () => {
    // Breaks if (M12): `armDeadline` ignores `detached` — the run's abort disarms the compensator's
    // deadline: no sleep is held past the cancel, its signal never fires, and it returns `late` as a
    // success. Breaks if (M11): the attempt gate ignores `detached` — the signal fires with the
    // run's reason, not the timeout.
    const clock = new HeldClock(EPOCH);
    const w = new World();
    let canceled = false;
    let giveUp!: () => void;
    const late = new Promise<void>((resolve) => (giveUp = resolve));
    const reasons: unknown[] = [];
    const pending = go(
      saga(w, {
        clock,
        extra: { refund: { timeout: 100 } },
        hooks: {
          refund: async ({ abortSignal }) => {
            await w.run!.cancel();
            canceled = true;
            const fired = new Promise<void>((resolve) => abortSignal.addEventListener('abort', () => resolve(), { once: true }));
            await Promise.race([abortSignal.aborted ? undefined : fired, late]);
            reasons.push(abortSignal.aborted ? abortSignal.reason : 'late');
            return 'late';
          },
        },
      }),
      w,
    );
    await mustWhile(pending, () => canceled, 'refund canceled the run');
    // `refund`'s deadline was armed before it ran, so its loop has started by this timer: past the
    // cancel it still sleeps, held, on the virtual clock.
    await timerTurn();
    expect(clock.now()).toBe(0);
    expect(clock.held).toBe(1);
    clock.release();
    // The fire is microtasks after the release; one more timer, then `refund` stops waiting.
    await timerTurn();
    giveUp();
    const { res } = await pending;
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toBeInstanceOf(StepTimeoutError);
    expect(clock.now()).toBe(100);
    expect(res.status).toBe('canceled');
    expect(res.steps['refund']).toMatchObject({ status: 'failed', error: { name: 'StepTimeoutError' } });
    expect(res.steps['release']).toMatchObject({ status: 'success' });
  }, RUN_TIMEOUT);

  it('control: a forward step\'s deadline IS disarmed by the run\'s abort', async () => {
    // Breaks if (M13 = N2): the leaf arms every step's deadline `detached` — `mid`'s deadline then
    // outlives the cancel and fires: the virtual clock moves to 100, `mid` is recorded a timeout,
    // and its failure starts a rollback that undoes `reserve`.
    const clock = new HeldClock(EPOCH);
    const w = new World();
    let canceled = false;
    let go2!: () => void;
    const latch = new Promise<void>((resolve) => (go2 = resolve));
    const seen: unknown[] = [];
    const pending = go(
      saga(w, {
        clock,
        extra: { mid: { timeout: 100 } },
        hooks: {
          mid: async ({ inputData, abortSignal }) => {
            await w.run!.cancel();
            canceled = true;
            await latch;
            seen.push(abortSignal.reason);
            return inputData;
          },
        },
      }),
      w,
    );
    await mustWhile(pending, () => canceled, 'mid canceled the run');
    // `mid`'s deadline loop has started by this timer (armed first); the cancel disarmed it, so
    // nothing sleeps on the clock. Released, a deadline still armed would fire in microtasks; the
    // second timer gives it every chance before `mid` returns.
    await timerTurn();
    expect(clock.held).toBe(0);
    clock.release();
    await timerTurn();
    go2();
    const { res } = await pending;
    expect(res.status).toBe('canceled');
    expect(clock.now()).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBeInstanceOf(StepTimeoutError);
    expect(res.steps['mid']).toMatchObject({ status: 'success' });
    expect(w.count('release')).toBe(0);
  }, RUN_TIMEOUT);
});

describe('retries', () => {
  it('a compensated step that fails, retries and succeeds is armed once, with the successful attempt\'s output; a compensator retries as any step', async () => {
    // Breaks if (M14): the compensator leaf is emitted without its own `retries` — `refund`'s first
    // failure is then final. Breaks if (M15): a retry attempt's success forwards its input instead
    // of the step's output — `release` then gets `{ n: 1 }`.
    const w = new World();
    const { res } = await go(
      saga(w, {
        extra: { reserve: { retries: 2 }, refund: { retries: 1 } },
        hooks: {
          reserve: ({ inputData, retryCount }) => {
            if (retryCount === 0) throw new Error('reserve flaked');
            return { seat: inputData.n + 1, attempt: retryCount };
          },
          refund: ({ inputData, retryCount }) => {
            if (retryCount === 0) throw new Error('refund flaked');
            return { undone: inputData };
          },
        },
      }),
      w,
    );
    expect(res.status).toBe('failed');
    expect(w.trace().slice(0, 8)).toEqual(['reserve', 'reserve', 'mid', 'charge', 'boom', 'refund', 'refund', 'release']);
    expect(w.count('release')).toBe(1);
    expect(w.inputs.get('release')).toEqual([{ seat: 2, attempt: 1 }]);
    expect(res.steps['refund']).toMatchObject({ status: 'success', output: { undone: { charge: 20 } } });
    expect(res.steps['release']).toMatchObject({ status: 'success', output: { undone: { seat: 2, attempt: 1 } } });
  }, RUN_TIMEOUT);
});

describe('agent and tool forward steps', () => {
  const Doubled = z.object({ n: z.number() });

  it('a tool step: its output is undone after a later failure, end to end', async () => {
    // Breaks if (M16): the runner resolves a compensator only from a `step` entry's Step, not from a
    // declarative tool or agent entry's options — the run then rejects with "no compensator".
    const api = init({ clock: new ManualClock(EPOCH) });
    const w = new World();
    const tool = createTool({ id: 'double', description: 'doubles n', inputSchema: N, outputSchema: Doubled, execute: async (input) => (w.saw('double', input), { n: input.n * 2 }) });
    const undo = api.createStep({ id: 'undo-double', inputSchema: Doubled, outputSchema: ANY, execute: async ({ inputData }) => (w.saw('undo-double', inputData), 'undone') });
    const fail = api.createStep({ id: 'fail', inputSchema: Doubled, outputSchema: Doubled, execute: async () => { throw new Error('fail'); } });
    const workflow = api.createWorkflow({ id: 'tool-saga', inputSchema: N, outputSchema: ANY }).then(api.createStep(tool, { compensate: undo })).then(fail).commit();
    const { res } = await go(workflow, w);
    expect(res.status).toBe('failed');
    expect(res.error).toMatchObject({ message: 'fail' });
    expect(w.log.filter((e) => !e.startsWith('persist:'))).toEqual(['double', 'undo-double']);
    expect(w.inputs.get('undo-double')).toEqual([{ n: 2 }]);
    expect(res.steps['undo-double']).toMatchObject({ status: 'success', output: 'undone', payload: { n: 2 } });
  }, RUN_TIMEOUT);

  it('an agent step (its model stubbed): its `{ text }` output is undone after a later failure, end to end', async () => {
    // Breaks if (M16), as for the tool.
    const api = init({ clock: new ManualClock(EPOCH) });
    const w = new World();
    const agent = new Agent({ id: 'stubby', name: 'stubby', instructions: 'be brief', model: {} as never });
    // The model is never called: Mastra's agent entry asks the model's version, then streams.
    Object.assign(agent, {
      getModel: async () => ({ specificationVersion: 'v2' }),
      stream: async (prompt: string, options: { onFinish?: (r: unknown) => void }) => {
        w.saw('stubby', prompt);
        options.onFinish?.({ text: `re: ${prompt}` });
        return { text: Promise.resolve(`re: ${prompt}`), fullStream: new ReadableStream({ start: (c) => c.close() }) };
      },
    });
    const Text = z.object({ text: z.string() });
    const undo = api.createStep({ id: 'undo-stubby', inputSchema: Text, outputSchema: ANY, execute: async ({ inputData }) => (w.saw('undo-stubby', inputData), 'unsaid') });
    const fail = api.createStep({ id: 'fail', inputSchema: Text, outputSchema: ANY, execute: async () => { throw new Error('fail'); } });
    const workflow = api
      .createWorkflow({ id: 'agent-saga', inputSchema: z.object({ prompt: z.string() }), outputSchema: ANY })
      .then(api.createStep(agent, { compensate: undo }))
      .then(fail)
      .commit();
    const h = await host({ 'agent-saga': workflow }, w);
    const run = await h.workflow('agent-saga').createRun({ runId: 'agent-run' });
    const res = await run.start({ inputData: { prompt: 'hi' } });
    expect(res.status).toBe('failed');
    expect(res.error).toMatchObject({ message: 'fail' });
    expect(w.inputs.get('undo-stubby')).toEqual([{ text: 're: hi' }]);
    expect(res.steps['undo-stubby']).toMatchObject({ status: 'success', output: 'unsaid' });
  }, RUN_TIMEOUT);
});

describe('a compensated step reused through cloneStep(step, { id, compensate })', () => {
  it('each use is undone by its own compensator, with its own output, newest first', async () => {
    // Breaks if (M17): `cloneStep` ignores `compensate` and keeps the original's — the two uses then
    // share `release`, refused as `compensate-ids` before the run.
    const api = init({ clock: new ManualClock(EPOCH) });
    const w = new World();
    const create = api.createStep as unknown as (p: Record<string, unknown>) => unknown;
    const logged = (id: string, f: Hook) => async (ctx: Ctx) => (w.saw(id, ctx.inputData), f(ctx));
    const release = create({ id: 'release', inputSchema: N, outputSchema: ANY, execute: logged('release', ({ inputData }) => ({ undone: inputData })) });
    const reserve = create({ id: 'reserve', inputSchema: N, outputSchema: N, compensate: release, execute: logged('reserve', ({ inputData }) => ({ n: inputData.n + 1 })) });
    const reserve2 = (api.cloneStep as unknown as (s: unknown, o: { id: string; compensate?: unknown }) => unknown)(reserve, {
      id: 'reserve-2',
      compensate: (api.cloneStep as unknown as (s: unknown, o: { id: string }) => unknown)(release, { id: 'release-2' }),
    });
    const boom = create({ id: 'boom', inputSchema: N, outputSchema: N, execute: logged('boom', () => { throw boomError(); }) });
    const workflow = (api.createWorkflow({ id: 'twice', inputSchema: N, outputSchema: ANY }) as unknown as { then(s: unknown): any })
      .then(reserve)
      .then(reserve2)
      .then(boom)
      .commit();
    const { res } = await go(workflow, w);
    expect(res.status).toBe('failed');
    // The clone runs the same function: its log entry is `reserve`, its record `reserve-2`.
    expect(w.log.filter((e) => !e.startsWith('persist:'))).toEqual(['reserve', 'reserve', 'boom', 'release', 'release']);
    expect(w.inputs.get('release')).toEqual([{ n: 3 }, { n: 2 }]);
    expect(res.steps['release-2']).toMatchObject({ status: 'success', output: { undone: { n: 3 } } });
    expect(res.steps['release']).toMatchObject({ status: 'success', output: { undone: { n: 2 } } });
    expect(Object.keys(res.steps)).toEqual(['input', 'reserve', 'reserve-2', 'boom', 'release-2', 'release']);
  }, RUN_TIMEOUT);
});

describe('a restart from a checkpoint before k_1 (row 126)', () => {
  it('re-runs the forward steps after the checkpoint and rolls back with their new outputs', async () => {
    // Breaks if (M18): the ladder seed counts compensated entries at or before the segment start
    // (`k_j <= at`) — the restart at 1 is then seeded with `reserve` on the stack, which the
    // checkpoint row has no record of, and the restart is refused.
    const storage = new InMemoryStore();
    const first = new World();
    const firstHost = await host({ saga: saga(first, { prep: true, extra: { prep: { metadata: { checkpoint: true } } } }) }, first, storage);
    const res1 = await (await firstHost.workflow('saga').createRun({ runId: 'r' })).start({ inputData: { n: 1 } });
    expect(res1.status).toBe('failed');
    expect(first.trace().slice(0, 7)).toEqual(['prep', 'reserve', 'mid', 'charge', 'boom', 'refund', 'release']);
    // The crash: the run died after its checkpoint row; put that row back.
    const checkpoint = first.rows.find((r) => r.status === 'running' && r.activePaths[0] === 1);
    expect(checkpoint).toBeDefined();
    expect(Object.keys(checkpoint!.context)).toEqual(['input', 'prep']);
    await firstHost.real({ workflowName: 'saga', runId: 'r', snapshot: checkpoint! });

    // Another process: a fresh workflow over the same store, restarted from the stored row; `reserve`
    // now returns attempt 0 again, so the inputs are the re-run's, told apart by the hook.
    const w = new World();
    const h = await host(
      { saga: saga(w, { prep: true, extra: { prep: { metadata: { checkpoint: true } } }, hooks: { reserve: ({ inputData }) => ({ seat: inputData.n + 100, attempt: 7 }) } }) },
      w,
      storage,
    );
    const res = await (await h.workflow('saga').createRun({ runId: 'r' })).restart();
    expect(res.status).toBe('failed');
    expect(w.trace().slice(0, 6)).toEqual(['reserve', 'mid', 'charge', 'boom', 'refund', 'release']);
    expect(w.inputs.get('release')).toEqual([{ seat: 101, attempt: 7 }]);
    expect(w.inputs.get('refund')).toEqual([{ charge: 1010 }]);
    expect(res.error).toMatchObject({ message: 'boom', code: 'E1' });
    expect(terminalRow(w).status).toBe('failed');
  }, RUN_TIMEOUT);
});

describe('limit(1) shared by a forward step and a compensator', () => {
  it('a compensator\'s failure releases its quota permit, so the next compensator sharing the limit runs', async () => {
    // Breaks if (M20): a leaf's failure branch keeps its quota tokens — `refund` fails, and its
    // firing breaks its `Out` (the quota branch is declared), so the run strands. Not observed here:
    // that both draw on `gpu`, or that `undo-only` is registered — dropping either from `uses` still
    // passes. Not killed, and
    // not killable here (M19): `quotaRefsOf` skipping compensators — the leaf registers a quota
    // lazily on first use (`compile.ts` `quotaMember`), so `undo-only` is registered either way.
    // The peak cannot exceed 1 on a correct net anyway (forward work is dead during a rollback,
    // C3); it is asserted as the quota's contract, not as a probe that made a peak happen.
    const api = init({ clock: new ManualClock(EPOCH) });
    const gpu = api.limit(1, { id: 'gpu' });
    const undoOnly = api.limit(1, { id: 'undo-only' });
    const w = new World();
    let inFlight = 0;
    let peak = 0;
    const held = (f: Hook) => async (ctx: Ctx) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        await turns(2);
        return await f(ctx);
      } finally {
        inFlight--;
      }
    };
    const { res } = await go(
      saga(w, {
        extra: { reserve: { uses: [gpu] }, refund: { uses: [gpu] }, release: { uses: [gpu, undoOnly] } },
        hooks: {
          reserve: held(({ inputData, retryCount }) => ({ seat: inputData.n + 1, attempt: retryCount })),
          refund: held(() => {
            throw new Error('refund broke');
          }),
          release: held(({ inputData }) => ({ undone: inputData })),
        },
      }),
      w,
    );
    expect(res.status).toBe('failed');
    expect(w.trace().slice(0, 6)).toEqual(['reserve', 'mid', 'charge', 'boom', 'refund', 'release']);
    expect(peak).toBe(1);
    expect(res.steps['refund']).toMatchObject({ status: 'failed' });
    expect(res.steps['release']).toMatchObject({ status: 'success' });
  }, RUN_TIMEOUT);
});

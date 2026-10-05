/**
 * **`race` / `quorum` end to end** ([ADR 0014]): workflows built with `init()`'s factories, raced
 * with `init().race` / `init().quorum` spread into Mastra's own `.parallel()`, run through Mastra's
 * `Run` on `PetriExecutionEngine` over a real `Mastra` and `InMemoryStore`, with real Mastra steps
 * (`MastraStepRunner` on Mastra's `StepExecutor`) and the real run scope, decision gadget and leaf.
 *
 * What is pinned here is the **one host-owned verdict**: the runner freezes an attempt's verdict when
 * the step settles, applies its effects (state, resume labels, scorers) iff the verdict is the step's
 * own, and the leaf maps the verdict without reading a signal.
 *
 * - The late-decision window (R1): a block deciding while an arm's async `scorers` run — after the
 *   step returned, before the runner did — leaves that arm's applied outcome standing: a surplus
 *   success keeps `success` and its state; a suspension frozen before the decision keeps its state,
 *   and the join rewrites the record `canceled` and forgets its label. A loser that suspends after
 *   the decision commits no state and leaves no label.
 * - Run abort and preemption both fired before a retry (R3): the retry runs with its signal aborted
 *   and its outcome stands — as Mastra's default engine runs the same `.parallel()`.
 * - A preempted loser whose deadline fires later (R4) never becomes a timeout, is never retried, and
 *   is never the block's reported error.
 *
 * Environment: `@mastra/core` from the pinned registry package, libpetri 8.0.0 (registry, not
 * linked), the system clock (real milliseconds, small). Tested, not proven: these are runtime
 * orderings the value-blind verifier cannot see. Each case names the mutation that breaks it.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { createWorkflow as mastraCreateWorkflow, type WorkflowRunState } from '@mastra/core/workflows';
import { init } from '../../src/mastra/index.js';

const N = z.object({ n: z.number() });
const ANY = z.any();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** Resolves when `signal` aborts (at once if it already has). */
function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}
/** A promise with its resolver. */
function latch(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Registers `workflows` on a fresh Mastra over a fresh store. */
function host(workflows: Record<string, unknown>) {
  const storage = new InMemoryStore();
  const mastra = new Mastra({ storage, workflows: workflows as never, logger: false });
  const get = (id: string) =>
    (mastra as unknown as { getWorkflow(id: string): { createRun(o?: { runId?: string }): Promise<RunLike> } }).getWorkflow(id);
  const stored = async (workflowName: string, runId: string): Promise<WorkflowRunState> => {
    const store = await storage.getStore('workflows');
    const snapshot = await store!.loadWorkflowSnapshot({ workflowName, runId });
    if (snapshot === null) throw new Error(`no stored row for ${workflowName}/${runId}`);
    return snapshot;
  };
  return { get, stored };
}
interface RunLike {
  start(o: { inputData: unknown; initialState?: unknown }): Promise<RunResult>;
  cancel(): Promise<void>;
}
interface RunResult {
  readonly status: string;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly steps: Record<string, { status: string; output?: unknown; error?: unknown }>;
}
const errorName = (record: { error?: unknown } | undefined): unknown => (record?.error as { name?: unknown } | undefined)?.name;
const message = (error: unknown): string => (typeof error === 'object' && error !== null ? String((error as { message?: unknown }).message) : String(error));

const STATE = z.object({ a: z.number().optional(), b: z.number().optional(), c: z.number().optional() });

describe('a race, end to end', () => {
  it('first success wins; a cooperative loser is preempted, awaited and recorded canceled', async () => {
    // Mutation: the runner reporting no `preempted` verdict (or the leaf ignoring it) -> the loser's
    // late success is recorded `success`.
    const { createWorkflow, createStep, race } = init();
    let loserReturned = false;
    const fast = createStep({ id: 'fast', inputSchema: N, outputSchema: N, execute: async ({ inputData }) => ({ n: inputData.n + 1 }) });
    const slow = createStep({
      id: 'slow',
      inputSchema: N,
      outputSchema: N,
      execute: async ({ inputData, abortSignal }) => {
        await aborted(abortSignal);
        loserReturned = true;
        return { n: inputData.n + 100 };
      },
    });
    const workflow = createWorkflow({ id: 'basic', inputSchema: N, outputSchema: ANY }).parallel(...race([fast, slow], { id: 'pick' })).commit();
    const { get } = host({ basic: workflow });
    const result = await (await get('basic').createRun()).start({ inputData: { n: 1 } });
    expect(result.status).toBe('success');
    expect(loserReturned).toBe(true); // awaited, not abandoned
    expect(result.steps['fast']).toMatchObject({ status: 'success', output: { n: 2 } });
    expect(result.steps['slow']!.status).toBe('canceled');
    expect(errorName(result.steps['slow'])).toBe('StepPreemptedError');
    expect('output' in result.steps['slow']!).toBe(false);
  });
});

describe('R1: the late-decision window', () => {
  it('a block deciding while an arm\'s async scorers run: the arm\'s applied success stands, a surplus success', async () => {
    // Mutation: the leaf sampling the preemption at settle (the pre-fix code), or the runner freezing
    // after the scorers -> `scored` is recorded `canceled` while its state { a: 1 } was committed.
    const { createWorkflow, createStep, race } = init();
    const go = latch();
    let attemptSignal: AbortSignal | undefined;
    const scored = createStep({
      id: 'scored',
      inputSchema: N,
      outputSchema: N,
      stateSchema: STATE,
      execute: async ({ inputData, abortSignal, setState }) => {
        attemptSignal = abortSignal;
        await setState({ a: 1 });
        return { n: inputData.n + 10 };
      },
      // The step has returned; the runner awaits these before it returns. The other arm wins here.
      scorers: async () => {
        go.release();
        await aborted(attemptSignal!);
        return {};
      },
    });
    const other = createStep({
      id: 'other',
      inputSchema: N,
      outputSchema: N,
      stateSchema: STATE,
      execute: async ({ inputData }) => {
        await go.promise;
        return { n: inputData.n + 20 };
      },
    });
    const workflow = createWorkflow({ id: 'scorers', inputSchema: N, outputSchema: ANY, stateSchema: STATE })
      .parallel(...race([scored, other], { id: 'pick' }))
      .commit();
    const { get, stored } = host({ scorers: workflow });
    const result = await (await get('scorers').createRun({ runId: 'r1' })).start({ inputData: { n: 1 }, initialState: {} });
    expect(attemptSignal?.aborted).toBe(true); // the block did decide while the scorers ran
    expect(result.status).toBe('success');
    expect(result.steps['other']).toMatchObject({ status: 'success', output: { n: 21 } });
    expect(result.steps['scored']).toMatchObject({ status: 'success', output: { n: 11 } });
    expect(result.result).toEqual({ scored: { n: 11 }, other: { n: 21 } });
    expect((await stored('scorers', 'r1')).value).toEqual({ a: 1 });
  });

  it('a suspension frozen before the decision: its state stands; the join rewrites it canceled and forgets its label', async () => {
    // Mutation: the pre-fix leaf, which took the `preempted` branch here -> the record is canceled
    // by the leaf but the label `held` stays in the stored row: an orphan `Run.resume()` could take.
    const { createWorkflow, createStep, race } = init();
    const go = latch();
    let attemptSignal: AbortSignal | undefined;
    const held = createStep({
      id: 'held',
      inputSchema: N,
      outputSchema: N,
      stateSchema: STATE,
      suspendSchema: ANY,
      resumeSchema: ANY,
      execute: async ({ abortSignal, setState, suspend }) => {
        attemptSignal = abortSignal;
        await setState({ b: 2 });
        await suspend({ waiting: true }, { resumeLabel: 'held' });
        return undefined as never;
      },
      scorers: async () => {
        go.release();
        await aborted(attemptSignal!);
        return {};
      },
    });
    const other = createStep({
      id: 'other',
      inputSchema: N,
      outputSchema: N,
      stateSchema: STATE,
      execute: async ({ inputData }) => {
        await go.promise;
        return { n: inputData.n + 20 };
      },
    });
    const workflow = createWorkflow({ id: 'held', inputSchema: N, outputSchema: ANY, stateSchema: STATE })
      .parallel(...race([held, other], { id: 'pick' }))
      .commit();
    const { get, stored } = host({ held: workflow });
    const result = await (await get('held').createRun({ runId: 'r2' })).start({ inputData: { n: 1 }, initialState: {} });
    expect(attemptSignal?.aborted).toBe(true);
    expect(result.status).toBe('success');
    expect(result.steps['held']!.status).toBe('canceled');
    expect(errorName(result.steps['held'])).toBe('StepPreemptedError');
    const row = await stored('held', 'r2');
    expect(row.value).toEqual({ b: 2 });
    expect(row.resumeLabels ?? {}).toEqual({});
  });

  it('a loser that suspends after the decision: no state, no label, recorded canceled', async () => {
    // Mutation: the runner applying state / keeping labels on a non-own verdict -> { c: 3 } and
    // `late` reach the stored row.
    const { createWorkflow, createStep, race } = init();
    const late = createStep({
      id: 'late',
      inputSchema: N,
      outputSchema: N,
      stateSchema: STATE,
      suspendSchema: ANY,
      resumeSchema: ANY,
      execute: async ({ abortSignal, setState, suspend }) => {
        await aborted(abortSignal);
        await setState({ c: 3 });
        await suspend({ late: true }, { resumeLabel: 'late' });
        return undefined as never;
      },
    });
    const fast = createStep({ id: 'fast', inputSchema: N, outputSchema: N, stateSchema: STATE, execute: async ({ inputData }) => ({ n: inputData.n + 1 }) });
    const workflow = createWorkflow({ id: 'late', inputSchema: N, outputSchema: ANY, stateSchema: STATE })
      .parallel(...race([late, fast], { id: 'pick' }))
      .commit();
    const { get, stored } = host({ late: workflow });
    const result = await (await get('late').createRun({ runId: 'r3' })).start({ inputData: { n: 1 }, initialState: {} });
    expect(result.status).toBe('success');
    expect(result.steps['late']!.status).toBe('canceled');
    expect(errorName(result.steps['late'])).toBe('StepPreemptedError');
    const row = await stored('late', 'r3');
    expect(row.value).toEqual({});
    expect(row.resumeLabels ?? {}).toEqual({});
  });
});

describe('R3: run abort and preemption both fired before a retry', () => {
  it('the retry runs with its signal aborted and its outcome stands, as on the default engine', async () => {
    // Mutation: the runner's pre-start check ignoring the run's abort -> the retry is not run on the
    // petri engine (or, as before the fix, fails without running and is recorded `failed`).
    const { createWorkflow, createStep, race } = init();
    const observe = () => {
      const seen: { attempt: number; aborted: boolean }[] = [];
      let attempt = 0;
      const retrier = createStep({
        id: 'retrier',
        inputSchema: N,
        outputSchema: N,
        retries: 1,
        execute: async ({ inputData, abortSignal }) => {
          seen.push({ attempt, aborted: abortSignal.aborted });
          attempt += 1;
          if (attempt === 1) throw new Error('first attempt fails');
          return { n: inputData.n + 1 };
        },
      });
      return { seen, retrier };
    };
    const fastOf = (cancel: () => void) =>
      createStep({
        id: 'fast',
        inputSchema: N,
        outputSchema: N,
        execute: async ({ inputData }) => {
          // The run is canceled during the retrier's 60 ms delay, after this arm has won.
          setTimeout(cancel, 20);
          return { n: inputData.n + 2 };
        },
      });

    const runBoth = async (raced: boolean) => {
      const { seen, retrier } = observe();
      let run: RunLike | undefined;
      const fast = fastOf(() => void run!.cancel());
      const workflow = raced
        ? createWorkflow({ id: 'raced', inputSchema: N, outputSchema: ANY, retryConfig: { delay: 60 } }).parallel(...race([retrier, fast], { id: 'pick' })).commit()
        : (mastraCreateWorkflow({ id: 'plain', inputSchema: N, outputSchema: ANY, retryConfig: { delay: 60 } }) as unknown as {
            parallel(steps: readonly unknown[], options: unknown): { commit(): unknown };
          })
            .parallel([retrier, fast], { id: 'pick' })
            .commit();
      const id = raced ? 'raced' : 'plain';
      const { get } = host({ [id]: workflow });
      run = await get(id).createRun();
      const result = await run.start({ inputData: { n: 1 } });
      return { seen, result };
    };

    const petri = await runBoth(true);
    const oracle = await runBoth(false);
    // The default engine runs the retry under the aborted signal; so does the race's loser.
    expect(oracle.seen).toEqual([
      { attempt: 0, aborted: false },
      { attempt: 1, aborted: true },
    ]);
    expect(petri.seen).toEqual(oracle.seen);
    // Its outcome stands: neither `canceled` by the preemption nor a failure that never ran.
    expect(petri.result.steps['retrier']!.status).toBe(oracle.result.steps['retrier']!.status);
    expect(petri.result.steps['retrier']).toMatchObject({ status: 'success', output: { n: 2 } });
    expect(errorName(petri.result.steps['retrier'])).toBeUndefined();
    expect(petri.result.status).toBe(oracle.result.status);
  });
});

describe('R4: a preempted loser whose deadline fires later', () => {
  // With retries 0 a timeout would be the loser's final failure; with retries 2 it would be retried
  // (the retry is then preempted without running, so only the record and the call count show it).
  it.each([0, 2])('retries %i: never becomes a timeout, is never retried, and is never the block\'s reported error', async (retries) => {
    // Mutation: the gate taking the deadline whenever it has fired (the pre-fix precedence) -> with
    // retries 0 the loser, index 0, fails with a StepTimeoutError, which the block reports as its
    // lowest-index failure.
    const { createWorkflow, createStep, quorum } = init();
    let loserCalls = 0;
    const loser = createStep({
      id: 'loser',
      inputSchema: N,
      outputSchema: N,
      timeout: 30,
      retries,
      execute: async ({ inputData, abortSignal }) => {
        loserCalls += 1;
        await aborted(abortSignal); // the preemption, at ~5 ms
        await sleep(60); // then ignores everything past its 30 ms deadline
        return { n: inputData.n };
      },
    });
    const failing = (id: string) =>
      createStep({
        id,
        inputSchema: N,
        outputSchema: N,
        execute: async () => {
          await sleep(5);
          throw new Error(`${id}-err`);
        },
      });
    const workflow = createWorkflow({ id: 'r4', inputSchema: N, outputSchema: ANY })
      .parallel(...quorum(2, [loser, failing('a'), failing('b')], { id: 'two' }))
      .commit();
    const { get } = host({ r4: workflow });
    const result = await (await get('r4').createRun()).start({ inputData: { n: 1 } });
    expect(result.status).toBe('failed');
    expect(message(result.error)).toBe('a-err');
    expect(loserCalls).toBe(1);
    expect(result.steps['loser']!.status).toBe('canceled');
    expect(errorName(result.steps['loser'])).toBe('StepPreemptedError');
    expect((result.steps['loser']!.error as { outcome?: unknown }).outcome).toBe('short');
  });
});

describe('resume labels of a discarded attempt', () => {
  it("a timed-out attempt's label of a reused name leaves the label another arm wrote", async () => {
    // Mutation: the pre-fix runner (write at `suspend`, delete on a non-own verdict without restoring
    // what it overwrote) -> the stored row's resumeLabels is {} and nothing can resume `a` by label.
    const { createWorkflow, createStep } = init();
    let bCalls = 0;
    const a = createStep({
      id: 'a',
      inputSchema: N,
      outputSchema: N,
      suspendSchema: ANY,
      resumeSchema: ANY,
      execute: async ({ suspend }) => {
        await suspend({ a: true }, { resumeLabel: 'approve' });
        return undefined as never;
      },
    });
    const b = createStep({
      id: 'b',
      inputSchema: N,
      outputSchema: N,
      suspendSchema: ANY,
      resumeSchema: ANY,
      timeout: 10,
      retries: 1,
      execute: async ({ inputData, suspend }) => {
        bCalls += 1;
        if (bCalls === 1) {
          await sleep(30); // past its 10 ms deadline, ignoring the signal
          await suspend({ b: true }, { resumeLabel: 'approve' });
          return undefined as never;
        }
        return { n: inputData.n + 1 };
      },
    });
    const workflow = createWorkflow({ id: 'labels', inputSchema: N, outputSchema: ANY }).parallel([a, b]).commit();
    const { get, stored } = host({ labels: workflow });
    const result = await (await get('labels').createRun({ runId: 'l1' })).start({ inputData: { n: 1 } });
    expect(bCalls).toBe(2);
    expect(result.status).toBe('suspended');
    expect(result.steps['a']!.status).toBe('suspended');
    expect(result.steps['b']).toMatchObject({ status: 'success', output: { n: 2 } });
    const row = await stored('labels', 'l1');
    expect(row.resumeLabels).toEqual({ approve: { stepId: 'a' } });
  });

  it('two plain steps naming one label: the later-settling one holds it, as on the default engine', async () => {
    // Mastra writes a label at `suspend` and again when the attempt returns (`handlers/step.ts:399-411`,
    // `:491`). Mutation: write it only at `suspend` (the runner before M7b) -> petri keeps `a`, which
    // called `suspend` later, where the default engine keeps `b`, which returned later.
    const build = (create: typeof mastraCreateWorkflow, step: (o: never) => unknown) => {
      const b = step({
        id: 'b', inputSchema: N, outputSchema: N, suspendSchema: ANY, resumeSchema: ANY,
        execute: async ({ suspend }: { suspend: (d: unknown, o: unknown) => Promise<void> }) => {
          await suspend({ b: true }, { resumeLabel: 'approve' });
          await sleep(40);
          return undefined as never;
        },
      } as never);
      const a = step({
        id: 'a', inputSchema: N, outputSchema: N, suspendSchema: ANY, resumeSchema: ANY,
        execute: async ({ suspend }: { suspend: (d: unknown, o: unknown) => Promise<void> }) => {
          await sleep(15);
          await suspend({ a: true }, { resumeLabel: 'approve' });
          return undefined as never;
        },
      } as never);
      return (create({ id: 'shared', inputSchema: N, outputSchema: ANY } as never) as unknown as {
        parallel(s: unknown[]): { commit(): unknown };
      }).parallel([b, a]).commit();
    };
    const petri = init();
    const labelsOn = async (workflow: unknown): Promise<unknown> => {
      const { get, stored } = host({ shared: workflow });
      const result = await (await get('shared').createRun({ runId: 's1' })).start({ inputData: { n: 1 } });
      expect(result.status).toBe('suspended');
      return (await stored('shared', 's1')).resumeLabels;
    };
    const { createStep: mastraCreateStep } = await import('@mastra/core/workflows');
    const onDefault = await labelsOn(build(mastraCreateWorkflow, mastraCreateStep as never));
    const onPetri = await labelsOn(build(petri.createWorkflow as never, petri.createStep as never));
    expect(onDefault).toEqual({ approve: { stepId: 'b' } });
    expect(onPetri).toEqual(onDefault);
  });
});

describe('first fired wins: a preemption, then the run canceled before the loser settles', () => {
  it('the loser is preempted: no state, recorded canceled with its StepPreemptedError, never retried', async () => {
    // Mutation: the pre-fix rule 2 (a run abort by the freeze -> own) -> the loser's success and
    // { c: 3 } stand, and its record is not the preemption's.
    const { createWorkflow, createStep, race } = init();
    let loserCalls = 0;
    let run: RunLike | undefined;
    const loser = createStep({
      id: 'loser',
      inputSchema: N,
      outputSchema: N,
      stateSchema: STATE,
      retries: 2,
      execute: async ({ inputData, abortSignal, setState }) => {
        loserCalls += 1;
        await aborted(abortSignal); // the preemption
        await run!.cancel(); // then the run's abort, before this attempt settles
        await setState({ c: 3 });
        return { n: inputData.n };
      },
    });
    const fast = createStep({ id: 'fast', inputSchema: N, outputSchema: N, stateSchema: STATE, execute: async ({ inputData }) => ({ n: inputData.n + 1 }) });
    const workflow = createWorkflow({ id: 'pc', inputSchema: N, outputSchema: ANY, stateSchema: STATE })
      .parallel(...race([loser, fast], { id: 'pick' }))
      .commit();
    const { get, stored } = host({ pc: workflow });
    run = await get('pc').createRun({ runId: 'pc1' });
    const result = await run.start({ inputData: { n: 1 }, initialState: {} });
    expect(loserCalls).toBe(1);
    expect(result.steps['loser']!.status).toBe('canceled');
    expect(errorName(result.steps['loser'])).toBe('StepPreemptedError');
    const row = await stored('pc', 'pc1');
    expect(row.value).toEqual({});
  });
});

// ---------------------------------------------------------------------------------------------
// M7b W2 integration: the remaining cases of the W2 plan (tasks/todo.md, M7b "W2 integration").
// Same environment as above: real Mastra, InMemoryStore, the system clock in small real
// milliseconds, libpetri 8.0.0 from the registry, not linked. Tested, not proven.
// ---------------------------------------------------------------------------------------------

/** A step that fails after `ms` with the message `<id>-err`. */
function failingAfter(createStep: ReturnType<typeof init>['createStep'], id: string, ms: number) {
  return createStep({
    id,
    inputSchema: N,
    outputSchema: N,
    execute: async () => {
      await sleep(ms);
      throw new Error(`${id}-err`);
    },
  });
}

describe('no winner: every arm fails', () => {
  it('the block reports the lowest-index failure, not the first to arrive, as the default engine\'s parallel', async () => {
    // Mutation: join-short forwarding the first miss in arrival order (`misses[0]`) instead of the
    // lowest index -> the error is `b-err`, which failed first.
    const petri = init();
    const raced = petri
      .createWorkflow({ id: 'allfail', inputSchema: N, outputSchema: ANY })
      .parallel(...petri.race([failingAfter(petri.createStep, 'a', 30), failingAfter(petri.createStep, 'b', 2)], { id: 'pick' }))
      .commit();
    const { get } = host({ allfail: raced });
    const result = await (await get('allfail').createRun()).start({ inputData: { n: 1 } });
    expect(result.status).toBe('failed');
    expect(message(result.error)).toBe('a-err');
    expect(result.steps['a']!.status).toBe('failed');
    expect(result.steps['b']!.status).toBe('failed');
    // Neither arm was preempted: a race over n arms decides `short` only on the n-th miss.
    expect(errorName(result.steps['a'])).not.toBe('StepPreemptedError');
    expect(errorName(result.steps['b'])).not.toBe('StepPreemptedError');

    // Oracle: Mastra's own `.parallel()` over the same arms reports the lowest index too
    // (`handlers/control-flow.ts:267`, `results.find`).
    const { createStep: mastraCreateStep } = await import('@mastra/core/workflows');
    const plain = (mastraCreateWorkflow({ id: 'allfail-plain', inputSchema: N, outputSchema: ANY }) as unknown as {
      parallel(steps: readonly unknown[]): { commit(): unknown };
    })
      .parallel([failingAfter(mastraCreateStep as never, 'a', 30), failingAfter(mastraCreateStep as never, 'b', 2)])
      .commit();
    const oracle = await (await host({ 'allfail-plain': plain }).get('allfail-plain').createRun()).start({ inputData: { n: 1 } });
    expect(oracle.status).toBe(result.status);
    expect(message(oracle.error)).toBe(message(result.error));
  });
});

describe('no winner, no failure: QuorumNotMetError', () => {
  it('statuses keep `suspended` and `preempted` distinct; suspended losers are rewritten canceled and their labels forgotten', async () => {
    // Mutations: (1) `statuses` read from the records after the rewrite -> every entry `canceled`;
    // (2) join-short skipping `rewriteSuspended` over `short`'s own misses -> `s1`/`s2` stay
    // `suspended`, the labels `one`/`two` stay in the stored row; (3) the block suspending on a
    // suspended arm as `.parallel()` does -> the run ends `suspended`.
    const { createWorkflow, createStep, quorum } = init();
    let slowReturned = false;
    const suspender = (id: string, label: string, ms: number) =>
      createStep({
        id,
        inputSchema: N,
        outputSchema: N,
        suspendSchema: ANY,
        resumeSchema: ANY,
        execute: async ({ suspend }) => {
          await sleep(ms);
          await suspend({ id }, { resumeLabel: label });
          return undefined as never;
        },
      });
    const slow = createStep({
      id: 'slow',
      inputSchema: N,
      outputSchema: N,
      execute: async ({ inputData, abortSignal }) => {
        await aborted(abortSignal);
        slowReturned = true;
        return { n: inputData.n }; // a late success, discarded
      },
    });
    const workflow = createWorkflow({ id: 'qnm', inputSchema: N, outputSchema: ANY })
      .parallel(...quorum(2, [suspender('s1', 'one', 2), suspender('s2', 'two', 8), slow], { id: 'two' }))
      .commit();
    const { get, stored } = host({ qnm: workflow });
    const result = await (await get('qnm').createRun({ runId: 'q1' })).start({ inputData: { n: 1 } });
    expect(slowReturned).toBe(true);
    expect(result.status).toBe('failed');
    const error = result.error as { name?: unknown; need?: unknown; succeeded?: unknown; statuses?: unknown; blockId?: unknown };
    expect(error.name).toBe('QuorumNotMetError');
    expect(error.blockId).toBe('two');
    expect(error.need).toBe(2);
    expect(error.succeeded).toBe(0);
    expect(error.statuses).toEqual([
      { stepId: 's1', index: 0, status: 'suspended' },
      { stepId: 's2', index: 1, status: 'suspended' },
      { stepId: 'slow', index: 2, status: 'preempted' },
    ]);
    expect(message(result.error)).toMatch(/needed 2 of 3 arms to succeed, 0 did: s1=suspended, s2=suspended, slow=preempted/);
    for (const id of ['s1', 's2', 'slow']) {
      expect(result.steps[id]!.status, id).toBe('canceled');
      expect(errorName(result.steps[id]), id).toBe('StepPreemptedError');
      expect((result.steps[id]!.error as { outcome?: unknown }).outcome, id).toBe('short');
    }
    const row = await stored('qnm', 'q1');
    expect(row.status).toBe('failed');
    expect(row.resumeLabels ?? {}).toEqual({});
    for (const id of ['s1', 's2']) expect((row.context[id] as { status?: unknown }).status, id).toBe('canceled');
  });
});

describe('cancel mid-race', () => {
  it('run.cancel() while every arm is in flight: canceled as the default engine\'s parallel, no arm preempted', async () => {
    // Mutation: `fork` or the arms reading the run's abort as a preemption (the block's controller
    // chained to the run signal) -> the arms are recorded `canceled` with a StepPreemptedError where
    // the default engine keeps their own outcome.
    const build = (petri: boolean) => {
      const p = init();
      let run: RunLike | undefined;
      const seen: string[] = [];
      const arm = (id: string, cancels: boolean) => {
        const spec = {
          id,
          inputSchema: N,
          outputSchema: N,
          execute: async ({ inputData, abortSignal }: { inputData: { n: number }; abortSignal: AbortSignal }) => {
            if (cancels) setTimeout(() => void run!.cancel(), 10);
            await aborted(abortSignal);
            seen.push(id);
            return { n: inputData.n };
          },
        };
        return p.createStep(spec as never);
      };
      const arms = [arm('a', true), arm('b', false), arm('c', false)];
      const workflow = petri
        ? p.createWorkflow({ id: 'cx', inputSchema: N, outputSchema: ANY }).parallel(...p.race(arms as never, { id: 'pick' })).commit()
        : (mastraCreateWorkflow({ id: 'cx', inputSchema: N, outputSchema: ANY }) as unknown as {
            parallel(steps: readonly unknown[], o: unknown): { commit(): unknown };
          })
            .parallel(arms, { id: 'pick' })
            .commit();
      return {
        seen,
        start: async () => {
          const { get, stored } = host({ cx: workflow });
          run = await get('cx').createRun({ runId: 'cx1' });
          const result = await run.start({ inputData: { n: 1 } });
          return { result, row: await stored('cx', 'cx1') };
        },
      };
    };
    const petri = build(true);
    const p = await petri.start();
    const oracleBuild = build(false);
    const o = await oracleBuild.start();
    expect(o.result.status).toBe('canceled');
    expect(p.result.status).toBe(o.result.status);
    expect(p.row.status).toBe('canceled');
    expect([...petri.seen].sort()).toEqual(['a', 'b', 'c']); // every arm awaited
    for (const id of ['a', 'b', 'c']) {
      expect(errorName(p.result.steps[id]), id).not.toBe('StepPreemptedError');
      expect(p.result.steps[id]?.status, id).toBe(o.result.steps[id]?.status);
      // Both engines keep each arm's own outcome, and only the run is re-stamped `canceled`. No decision
      // fires here, so this pins the block's preemption staying apart from the run signal; the
      // precedence of a run abort over a later preemption is R3's.
      expect(p.result.steps[id]?.status, id).toBe('success');
    }
  });
});

describe('a retrying loser', () => {
  it('preempted during its retry delay: finishes the delay, then is not retried again (row 108)', async () => {
    // Mutation: the leaf calling the runner without the fired preempt signal after the delay, or
    // the runner starting a preempted attempt -> a second execution (calls 2) and the retry's
    // success recorded.
    const { createWorkflow, createStep, race } = init();
    let calls = 0;
    let firstFailedAt = 0;
    let decidedBy = 0;
    const retrier = createStep({
      id: 'retrier',
      inputSchema: N,
      outputSchema: N,
      retries: 2,
      execute: async ({ inputData }) => {
        calls += 1;
        if (calls === 1) {
          firstFailedAt = Date.now();
          throw new Error('first attempt fails');
        }
        return { n: inputData.n + 1 };
      },
    });
    const winner = createStep({
      id: 'winner',
      inputSchema: N,
      outputSchema: N,
      execute: async ({ inputData }) => {
        await sleep(10); // wins inside the retrier's 50 ms delay
        decidedBy = Date.now();
        return { n: inputData.n + 2 };
      },
    });
    const workflow = createWorkflow({ id: 'retry', inputSchema: N, outputSchema: ANY, retryConfig: { delay: 50 } })
      .parallel(...race([retrier, winner], { id: 'pick' }))
      .commit();
    const { get } = host({ retry: workflow });
    const startedAt = Date.now();
    const result = await (await get('retry').createRun()).start({ inputData: { n: 1 } });
    const elapsed = Date.now() - startedAt;
    // The decision did land inside the delay; if a loaded runner pushes it past, this names why.
    expect(firstFailedAt).toBeLessThan(decidedBy);
    expect(decidedBy - firstFailedAt).toBeLessThan(50);
    expect(calls).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(45); // the join waited for the delay to finish
    expect(result.status).toBe('success');
    expect(result.steps['winner']).toMatchObject({ status: 'success', output: { n: 3 } });
    expect(result.steps['retrier']!.status).toBe('canceled');
    expect(errorName(result.steps['retrier'])).toBe('StepPreemptedError');
    expect(result.result).toEqual({ winner: { n: 3 } });
  });
});

describe('a loser ignoring its abort signal', () => {
  it('is awaited; its late success is discarded and its record canceled', async () => {
    // Mutation: the join not waiting for every arm (abandoning the loser) -> `stubbornReturned` is
    // false when the run returns; the runner applying a non-own verdict -> `success` and { a: 9 }.
    const { createWorkflow, createStep, race } = init();
    let stubbornReturned = false;
    const stubborn = createStep({
      id: 'stubborn',
      inputSchema: N,
      outputSchema: N,
      stateSchema: STATE,
      execute: async ({ inputData, setState }) => {
        await sleep(60); // never looks at its signal
        await setState({ a: 9 });
        stubbornReturned = true;
        return { n: inputData.n + 100 };
      },
    });
    const fast = createStep({ id: 'fast', inputSchema: N, outputSchema: N, stateSchema: STATE, execute: async ({ inputData }) => ({ n: inputData.n + 1 }) });
    const workflow = createWorkflow({ id: 'stubborn', inputSchema: N, outputSchema: ANY, stateSchema: STATE })
      .parallel(...race([stubborn, fast], { id: 'pick' }))
      .commit();
    const { get, stored } = host({ stubborn: workflow });
    const result = await (await get('stubborn').createRun({ runId: 'st1' })).start({ inputData: { n: 1 }, initialState: {} });
    expect(stubbornReturned).toBe(true);
    expect(result.status).toBe('success');
    expect(result.steps['stubborn']!.status).toBe('canceled');
    expect(errorName(result.steps['stubborn'])).toBe('StepPreemptedError');
    expect('output' in result.steps['stubborn']!).toBe(false);
    expect(result.result).toEqual({ fast: { n: 2 } });
    expect((await stored('stubborn', 'st1')).value).toEqual({});
  });
});

describe('a loser behind an exhausted limit (row 110)', () => {
  it('waits for the quota, then leaves preempted without running its step; the block waits for it', async () => {
    // Two arms share `limit(1)`: whichever is admitted first holds it until the decision preempts
    // it; the other draws the quota only after the decision, and must not start.
    // Mutation: the leaf calling the runner without `StepCall.preempt`, or the runner ignoring a
    // fired preemption before start -> the queued arm executes (two `limited` starts).
    const { createWorkflow, createStep, race, limit } = init();
    const db = limit(1, { id: 'db' });
    const started: string[] = [];
    let holderReturnedAt = 0;
    let decidedAt = 0;
    const limited = (id: string) =>
      createStep({
        id,
        inputSchema: N,
        outputSchema: N,
        uses: [db],
        execute: async ({ inputData, abortSignal }) => {
          started.push(id);
          await aborted(abortSignal);
          await sleep(20); // holds the quota past the decision
          holderReturnedAt = Date.now();
          return { n: inputData.n };
        },
      });
    const fast = createStep({
      id: 'fast',
      inputSchema: N,
      outputSchema: N,
      execute: async ({ inputData }) => {
        await sleep(5);
        decidedAt = Date.now();
        return { n: inputData.n + 1 };
      },
    });
    const workflow = createWorkflow({ id: 'lim', inputSchema: N, outputSchema: ANY })
      .parallel(...race([limited('x'), fast, limited('y')], { id: 'pick' }))
      .commit();
    const { get } = host({ lim: workflow });
    const result = await (await get('lim').createRun()).start({ inputData: { n: 1 } });
    const endedAt = Date.now();
    expect(started).toHaveLength(1); // only the holder ever ran
    const [holder] = started;
    const queued = holder === 'x' ? 'y' : 'x';
    // The holder gave the quota back well after the decision, and the queued arm left only then:
    // it waited for the quota rather than being swept from the queue, and the block waited for both.
    expect(holderReturnedAt).toBeGreaterThan(0);
    expect(holderReturnedAt - decidedAt).toBeGreaterThanOrEqual(15);
    expect(holderReturnedAt).toBeLessThanOrEqual(endedAt);
    expect((result.steps[queued] as { endedAt?: number }).endedAt).toBeGreaterThanOrEqual(holderReturnedAt);
    expect(result.status).toBe('success');
    expect(result.steps['fast']).toMatchObject({ status: 'success', output: { n: 2 } });
    for (const id of [holder!, queued]) {
      expect(result.steps[id]!.status, id).toBe('canceled');
      expect(errorName(result.steps[id]), id).toBe('StepPreemptedError');
    }
    expect(result.result).toEqual({ fast: { n: 2 } });
  });
});

describe('a race under block concurrency 2', () => {
  it('admission is bounded at 2, and the decision preempts the queued arms, which never execute', async () => {
    // Mutation: the decision gadget dropping `concurrency` (no admission) -> all four arms start at
    // once (`peak` 4, `c`/`d` executed); preempting only admitted arms -> the queued arms run.
    const { createWorkflow, createStep, race } = init();
    const started: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const arm = (id: string, wins: boolean) =>
      createStep({
        id,
        inputSchema: N,
        outputSchema: N,
        execute: async ({ inputData, abortSignal }) => {
          started.push(id);
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          try {
            if (wins) await sleep(15);
            else await aborted(abortSignal);
            return { n: inputData.n + 1 };
          } finally {
            inFlight -= 1;
          }
        },
      });
    const workflow = createWorkflow({ id: 'cc', inputSchema: N, outputSchema: ANY })
      .parallel(...race([arm('a', false), arm('b', true), arm('c', false), arm('d', false)], { id: 'pick', metadata: { concurrency: 2 } }))
      .commit();
    const { get } = host({ cc: workflow });
    const result = await (await get('cc').createRun()).start({ inputData: { n: 1 } });
    expect(peak).toBe(2);
    expect(result.status).toBe('success');
    expect(result.steps['b']).toMatchObject({ status: 'success', output: { n: 2 } });
    expect(started.slice(0, 2).sort()).toEqual(['a', 'b']); // FIFO admission
    for (const id of ['a', 'c', 'd']) {
      expect(result.steps[id]!.status, id).toBe('canceled');
      expect(errorName(result.steps[id]), id).toBe('StepPreemptedError');
    }
    expect(started).not.toContain('c');
    expect(started).not.toContain('d');
    expect(result.result).toEqual({ b: { n: 2 } });
  });
});

describe('quorum(2) of 3, met, then a next entry', () => {
  const build = (required: boolean) => {
    const { createWorkflow, createStep, quorum } = init();
    let nextInput: unknown;
    const arm = (id: string, ms: number | 'loses', add: number) =>
      createStep({
        id,
        inputSchema: N,
        outputSchema: N,
        execute: async ({ inputData, abortSignal }) => {
          if (ms === 'loses') await aborted(abortSignal);
          else await sleep(ms);
          return { n: inputData.n + add };
        },
      });
    const key = required ? N : N.optional();
    const next = createStep({
      id: 'next',
      inputSchema: z.object({ slow: key, mid: key, fast: key }),
      outputSchema: ANY,
      execute: async ({ inputData }) => {
        nextInput = inputData;
        return { done: true };
      },
    });
    // Arm 0 is the slowest: a lowest-index rule would wait for it; FIFO takes `fast` then `mid`.
    const workflow = createWorkflow({ id: 'q2', inputSchema: N, outputSchema: ANY })
      .parallel(...quorum(2, [arm('slow', 'loses', 100), arm('mid', 15, 10), arm('fast', 2, 1)], { id: 'two' }))
      .then(next as never)
      .commit();
    return { workflow, nextInput: () => nextInput };
  };

  it('two winners FIFO, the third preempted; the next entry gets every declared arm key, the loser\'s undefined', async () => {
    // Mutations: winners by lowest index -> `slow` is never preempted (the run hangs on it, or
    // `mid` is the loser); join-met building the next input from the `won` token -> the `slow` key
    // is absent rather than present and undefined.
    const { workflow, nextInput } = build(false);
    const { get } = host({ q2: workflow });
    const result = await (await get('q2').createRun()).start({ inputData: { n: 1 } });
    expect(result.status).toBe('success');
    expect(result.steps['fast']).toMatchObject({ status: 'success', output: { n: 2 } });
    expect(result.steps['mid']).toMatchObject({ status: 'success', output: { n: 11 } });
    expect(result.steps['slow']!.status).toBe('canceled');
    expect((result.steps['slow']!.error as { outcome?: unknown }).outcome).toBe('met');
    const input = nextInput() as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(['fast', 'mid', 'slow']);
    expect(input).toEqual({ slow: undefined, mid: { n: 11 }, fast: { n: 2 } });
    expect(result.result).toEqual({ done: true });
  });

  it('winners by arrival, not index: a lower-index arm that also succeeds, but later, is the loser', async () => {
    // Every arm succeeds; arrival order is the reverse of index order. Mutation: winners taken by
    // lowest index among successes -> `late` wins and `fast` is the loser.
    const { createWorkflow, createStep, quorum } = init();
    const arm = (id: string, ms: number, add: number) =>
      createStep({
        id,
        inputSchema: N,
        outputSchema: N,
        execute: async ({ inputData }) => {
          await sleep(ms); // ignores its signal: `late` succeeds after the decision
          return { n: inputData.n + add };
        },
      });
    const workflow = createWorkflow({ id: 'fifo', inputSchema: N, outputSchema: ANY })
      .parallel(...quorum(2, [arm('late', 60, 100), arm('mid', 15, 10), arm('fast', 2, 1)], { id: 'two' }))
      .commit();
    const { get } = host({ fifo: workflow });
    const result = await (await get('fifo').createRun()).start({ inputData: { n: 1 } });
    expect(result.status).toBe('success');
    expect(result.steps['fast']).toMatchObject({ status: 'success', output: { n: 2 } });
    expect(result.steps['mid']).toMatchObject({ status: 'success', output: { n: 11 } });
    expect(result.steps['late']!.status).toBe('canceled');
    expect((result.steps['late']!.error as { outcome?: unknown }).outcome).toBe('met');
    expect('output' in result.steps['late']!).toBe(false);
  });

  it('with the arm keys required, the next step fails input validation (row 103)', async () => {
    // Mutation: the next input built from winners only, with validation skipped -> `next` runs.
    const { workflow, nextInput } = build(true);
    const { get } = host({ q2: workflow });
    const result = await (await get('q2').createRun()).start({ inputData: { n: 1 } });
    expect(result.status).toBe('failed');
    expect(result.steps['next']!.status).toBe('failed');
    expect(nextInput()).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { Transition, one, outPlace, place, type Place } from 'libpetri';
import { branchGadget, compile, type Gadget } from '../../src/compiler/index.js';
import type {
  CanceledToken,
  EntryDescription,
  RunView,
  StepDescription,
  StepOutcome,
  WorkflowDescription,
} from '../../src/compiler/types.js';
import { runWorkflow, runWorkflowDetailed, type RunOutcome } from '../../src/engine/index.js';
import { RecordingRunner, type Behaviour } from '../fixtures/runner.js';
import { ManualClock } from '../support/manual-clock.js';

const step = (id: string, extra: Omit<StepDescription, 'kind' | 'id'> = {}): StepDescription => ({
  kind: 'step',
  id,
  ...extra,
});
const branch = (id: string, ...arms: StepDescription[]): EntryDescription => ({ kind: 'branch', id, arms });
const workflow = (...entries: EntryDescription[]): WorkflowDescription => ({ id: 'triage', entries });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
const ok = (output: unknown): StepOutcome => ({ status: 'success', output });
const tag = (name: string): Behaviour => (input) => ok(`${name}(${String(input)})`);
/** A step that hands on exactly what it received, so a test can read the record a block produced. */
const echo: Behaviour = (input) => ok(input);

type Select = (input: unknown, view: RunView) => readonly number[] | Promise<readonly number[]>;

/**
 * A recording runner whose branch selections are counted, so "one evaluation per block" is an
 * assertion rather than an assumption.
 */
function runnerFor(
  selections: Record<string, Select>,
  steps: Record<string, Behaviour> = {},
): RecordingRunner & { readonly selected: string[] } {
  const selected: string[] = [];
  const branches = Object.fromEntries(
    Object.entries(selections).map(([entryId, select]) => [
      entryId,
      (input: unknown, view: RunView) => {
        selected.push(entryId);
        return select(input, view);
      },
    ]),
  );
  return Object.assign(new RecordingRunner({ steps, branches }), { selected });
}

/** `.branch` over three single-step arms as the only entry, so its block output is the run's result. */
const threeArms = workflow(branch('route', step('email'), step('sms'), step('push')));
/** The same branch followed by a step, so the record Mastra hands the next entry is observable. */
const threeArmsThenAudit = workflow(branch('route', step('email'), step('sms'), step('push')), step('audit'));

describe('branch: inclusive selection', () => {
  it('runs exactly the selected arm and keys the result by its step id', async () => {
    const runner = runnerFor({ route: () => [1] }, { sms: tag('sms') });

    const outcome = await runWorkflow(compile(threeArms), 'alert', { runner });

    expect(runner.calls).toEqual(['sms']);
    expect(outcome).toStrictEqual({ status: 'success', output: { sms: 'sms(alert)' } });
  });

  it('runs every truthy arm, not only the first: `.branch` is inclusive, not if/else', async () => {
    const runner = runnerFor({ route: () => [0, 2] }, { email: tag('email'), push: tag('push') });

    const outcome = await runWorkflow(compile(threeArms), 'alert', { runner });

    expect([...runner.calls].sort()).toEqual(['email', 'push']);
    expect(outcome).toStrictEqual({ status: 'success', output: { email: 'email(alert)', push: 'push(alert)' } });
  });

  it('orders the result by arm, not by which arm finished first', async () => {
    const runner = runnerFor(
      { route: () => [0, 2] },
      {
        email: async (input) => { await sleep(15); return ok(`email(${String(input)})`); },
        push: tag('push'),
      },
    );

    const outcome = await runWorkflow(compile(threeArms), 'alert', { runner });

    expect(outcome.status).toBe('success');
    expect(Object.keys((outcome as { output: object }).output)).toEqual(['email', 'push']);
  });

  it('evaluates the conditions once per block, and hands the evaluation a view of the run', async () => {
    const views: RunView[] = [];
    const runner = runnerFor(
      {
        route: (_input, view) => {
          views.push(view);
          // A declarative predicate reads an earlier step's result, as Mastra's `getStepResult` does.
          const prep = view.getStepResult('prep');
          return prep?.status === 'success' && prep.output === 'prepared(alert)' ? [0, 1, 2] : [];
        },
      },
      { prep: tag('prepared') },
    );

    const outcome = await runWorkflow(compile(workflow(step('prep'), branch('route', step('email'), step('sms'), step('push')))), 'alert', {
      runner,
    });

    // Three arms ran off one decision. Deciding per arm would be three decisions that could
    // disagree with each other.
    expect(runner.selected).toEqual(['route']);
    expect([...runner.calls].sort()).toEqual(['email', 'prep', 'push', 'sms']);
    expect(views).toHaveLength(1);
    expect(views[0]!.path).toEqual([1]);
    expect(views[0]!.initData).toBe('alert');
    expect(outcome.status).toBe('success');
  });

  it('runs an arm named twice once, as Mastra keeps an arm by `truthyIndexes.includes(i)`', async () => {
    const runner = runnerFor({ route: () => [1, 1, 1] }, { sms: tag('sms') });

    const outcome = await runWorkflow(compile(threeArms), 'alert', { runner });

    expect(runner.calls).toEqual(['sms']);
    expect(outcome).toStrictEqual({ status: 'success', output: { sms: 'sms(alert)' } });
  });

  it('retries a failing arm within the arm, and the block sees only its final outcome', async () => {
    const runner = runnerFor(
      { route: () => [0] },
      { flaky: (input, call) => (call.attempt === 0 ? { status: 'failed', error: 'blip' } : ok(`flaky(${String(input)})`)) },
    );

    const outcome = await runWorkflow(compile(workflow(branch('route', step('flaky', { retries: 2 }), step('never')))), 'alert', {
      runner,
    });

    expect(runner.attempts).toEqual([{ stepId: 'flaky', attempt: 0 }, { stepId: 'flaky', attempt: 1 }]);
    expect(outcome).toStrictEqual({ status: 'success', output: { flaky: 'flaky(alert)' } });
  });
});

describe('branch: no truthy arm', () => {
  it('as the last entry, succeeds with an empty record and runs nothing', async () => {
    const runner = runnerFor({ route: () => [] });

    const outcome = await runWorkflow(compile(threeArms), 'alert', { runner });

    expect(runner.calls).toEqual([]);
    expect(outcome).toStrictEqual({ status: 'success', output: {} });
  });

  it('as a middle entry, hands the next entry every declared arm as a key, each undefined', async () => {
    const runner = runnerFor({ route: () => [] }, { audit: echo });

    const outcome = await runWorkflow(compile(threeArmsThenAudit), 'alert', { runner });

    expect(runner.calls).toEqual(['audit']);
    // `toStrictEqual`, because `toEqual` treats `{email: undefined}` and `{}` as equal — and the
    // difference is the whole point: Mastra's `getStepOutput` keys every declared arm.
    expect(outcome).toStrictEqual({
      status: 'success',
      output: { email: undefined, sms: undefined, push: undefined },
    });
    const handed = (outcome as { output: object }).output;
    expect(Object.keys(handed)).toEqual(['email', 'sms', 'push']);
    expect('sms' in handed).toBe(true);
  });
});

describe('branch: the two value shapes', () => {
  it('as the last entry, returns only the arms that ran and succeeded in this block', async () => {
    const runner = runnerFor(
      { route: () => [0, 1, 2] },
      { email: tag('email'), sms: () => ({ status: 'bailed', output: 'bail-payload' }), push: () => ({ status: 'paused' }) },
    );

    const outcome = await runWorkflow(compile(threeArms), 'alert', { runner });

    // A bailed or paused arm falls through to the block's success and is left out of its output
    // (`handlers/control-flow.ts:616-624`). A bail inside an arm does not end the run.
    expect(outcome).toStrictEqual({ status: 'success', output: { email: 'email(alert)' } });
  });

  it('as a middle entry, hands on the step results of every declared arm', async () => {
    const runner = runnerFor(
      { route: () => [0, 1, 2] },
      {
        email: tag('email'),
        sms: () => ({ status: 'bailed', output: 'bail-payload' }),
        push: () => ({ status: 'paused' }),
        audit: echo,
      },
    );

    const outcome = await runWorkflow(compile(threeArmsThenAudit), 'alert', { runner });

    // `getStepOutput` reads `stepResults[id]?.output` (`default.ts:1141-1149`): the bailed arm's
    // result carries its payload as `output`; a paused one carries none.
    expect(outcome).toStrictEqual({
      status: 'success',
      output: { email: 'email(alert)', sms: 'bail-payload', push: undefined },
    });
  });

  it('as a middle entry, reads a skipped arm from the step results: a stale earlier output', async () => {
    // Arm `sms` also ran as entry 0. Mastra records nothing for a skipped arm, so `getStepOutput`
    // hands the next entry entry 0's value under `sms`. Reading this block's arrivals would give
    // `undefined` here; this is the test that the join reads the run's step results.
    const runner = runnerFor(
      { route: () => [0] },
      { sms: tag('first-sms'), email: tag('email'), audit: echo },
    );
    const description = workflow(
      step('sms'),
      branch('route', step('email'), step('sms'), step('push')),
      step('audit'),
    );

    const report = await runWorkflowDetailed(compile(description), 'alert', { runner });

    expect(runner.calls).toEqual(['sms', 'email', 'audit']);
    expect(report.outcome).toStrictEqual({
      status: 'success',
      output: { email: 'email(first-sms(alert))', sms: 'first-sms(alert)', push: undefined },
    });
    // Skipped arms record nothing (`handlers/control-flow.ts:511-529` writes `skipped` only under
    // time travel), so `push` has no step result at all.
    expect(report.stepResults.has('push')).toBe(false);
  });

  it('as the last entry, leaves the stale arm out: the block output is this block only', async () => {
    const runner = runnerFor({ route: () => [0] }, { sms: tag('first-sms'), email: tag('email') });
    const description = workflow(step('sms'), branch('route', step('email'), step('sms')));

    const outcome = await runWorkflow(compile(description), 'alert', { runner });

    expect(outcome).toStrictEqual({ status: 'success', output: { email: 'email(first-sms(alert))' } });
  });

  it('reuses a truthy arm whose step id already succeeded instead of running it again', async () => {
    // `executeConditional` returns the stored result for an id already `success`
    // (`handlers/control-flow.ts:552-553`), so the arm's side effects happen once.
    const runner = runnerFor({ route: () => [0, 1] }, { sms: tag('first-sms'), email: tag('email') });
    const description = workflow(step('sms'), branch('route', step('email'), step('sms')));

    const outcome = await runWorkflow(compile(description), 'alert', { runner });

    expect(runner.calls).toEqual(['sms', 'email']);
    expect(outcome).toStrictEqual({
      status: 'success',
      output: { email: 'email(first-sms(alert))', sms: 'first-sms(alert)' },
    });
  });

  it('runs a truthy arm whose stored result is a failure (unreachable in Mastra outside a restart)', async () => {
    // Pins the one half of the reuse rule not reproduced: a stored `failed` would be returned by
    // Mastra too, but no start or resume can carry one to a later block.
    const runner = runnerFor({ route: () => [0] }, { email: tag('email') });

    const outcome = await runWorkflow(compile(workflow(branch('route', step('email')))), 'alert', {
      runner,
      stepResults: new Map([['email', { status: 'failed', error: 'old', payload: 'alert' }]]),
    });

    expect(runner.calls).toEqual(['email']);
    expect(outcome).toStrictEqual({ status: 'success', output: { email: 'email(alert)' } });
  });

  it("keys an arm called '__proto__' as an own property in both shapes", async () => {
    // Built with `fromEntries` too: `{ __proto__: fn }` in a literal would set the prototype.
    const steps: Record<string, Behaviour> = Object.fromEntries([['__proto__', tag('proto')], ['audit', echo]]);
    const runner = runnerFor({ route: () => [0] }, steps);
    const arms = [step('__proto__'), step('other')];

    const last = await runWorkflow(compile(workflow(branch('route', ...arms))), 'x', { runner });
    const middle = await runWorkflow(compile(workflow(branch('route', ...arms), step('audit'))), 'x', { runner });

    const lastOut = (last as { output: object }).output;
    const middleOut = (middle as { output: object }).output;
    expect(Object.keys(lastOut)).toEqual(['__proto__']);
    expect(Object.getOwnPropertyDescriptor(lastOut, '__proto__')?.value).toBe('proto(x)');
    expect(Object.getPrototypeOf(lastOut)).toBe(Object.prototype);
    expect(Object.keys(middleOut)).toEqual(['__proto__', 'other']);
    expect(Object.getOwnPropertyDescriptor(middleOut, '__proto__')?.value).toBe('proto(x)');
  });
});

describe('branch: failure, suspension and their precedence', () => {
  it('reports the lowest failing arm index, not the first failure in time', async () => {
    const runner = runnerFor(
      { route: () => [0, 1, 2] },
      {
        // Arm 0 fails last; arm 2 fails first. Mastra's `results.find` is over arm order.
        email: async () => { await sleep(20); return { status: 'failed', error: 'email down' }; },
        sms: tag('sms'),
        push: () => ({ status: 'failed', error: 'push down' }),
      },
    );

    const outcome = await runWorkflow(compile(threeArms), 'alert', { runner });

    expect(outcome).toStrictEqual({ status: 'failed', stepId: 'email', path: [0, 0], error: 'email down' });
  });

  it('awaits every sibling before failing, and stops the chain after the block', async () => {
    let smsFinished = false;
    const runner = runnerFor(
      { route: () => [0, 1] },
      {
        email: () => ({ status: 'failed', error: 'boom' }),
        sms: async (input) => { await sleep(25); smsFinished = true; return ok(input); },
      },
    );

    const outcome = await runWorkflow(compile(threeArmsThenAudit), 'alert', { runner });

    expect(smsFinished).toBe(true);
    expect(runner.calls).not.toContain('audit');
    expect(outcome).toStrictEqual({ status: 'failed', stepId: 'email', path: [0, 0], error: 'boom' });
  });

  it('forwards a tripwire unchanged, so the run ends as tripwire', async () => {
    const tripwire = { reason: 'blocked by processor', processorId: 'moderation' };
    const runner = runnerFor(
      { route: () => [0, 1] },
      { email: tag('email'), sms: () => ({ status: 'failed', error: 'tripped', tripwire }) },
    );

    const outcome = await runWorkflow(compile(threeArms), 'alert', { runner });

    // The outcome carries the failure's `error` beside the tripwire (contract change) for the
    // result formatter's fallback; Mastra's run result itself has none.
    expect(outcome).toStrictEqual({ status: 'tripwire', stepId: 'sms', path: [0, 1], tripwire, error: 'tripped' });
  });

  it('treats a throwing arm step as a failed arm rather than a lost token', async () => {
    const boom = new Error('provider down');
    const runner = runnerFor({ route: () => [2] }, { push: () => { throw boom; } });

    const outcome = await runWorkflow(compile(threeArms), 'alert', { runner });

    expect(outcome).toStrictEqual({ status: 'failed', stepId: 'push', path: [0, 2], error: boom });
  });

  it('ranks failed above suspended, whichever settles first, and leaves no suspension behind', async () => {
    for (const suspendFirst of [true, false]) {
      const runner = runnerFor(
        { route: () => [0, 1] },
        {
          email: async () => {
            if (!suspendFirst) await sleep(15);
            return { status: 'suspended', suspendPayload: { ask: 'approve?' } };
          },
          sms: async () => {
            if (suspendFirst) await sleep(15);
            return { status: 'failed', error: 'carrier rejected' };
          },
        },
      );

      const outcome = await runWorkflow(compile(threeArms), 'alert', { runner });

      // A residue key would appear here if the reset on the suspension marker were missing.
      expect(outcome, `suspendFirst=${suspendFirst}`).toStrictEqual({
        status: 'failed',
        stepId: 'sms',
        path: [0, 1],
        error: 'carrier rejected',
      });
    }
  });

  it('suspends with the lowest suspended arm, carrying that arm path', async () => {
    const runner = runnerFor(
      { route: () => [1, 2] },
      {
        sms: async () => { await sleep(15); return { status: 'suspended', suspendPayload: 'sms-wait' }; },
        push: () => ({ status: 'suspended', suspendPayload: 'push-wait' }),
      },
    );

    const report = await runWorkflowDetailed(compile(threeArms), 'alert', { runner });

    expect(report.outcome).toStrictEqual({ status: 'suspended', stepId: 'sms', path: [0, 1], payload: 'sms-wait' });
    // Both arms' suspensions are in the step results, which is where Mastra's run result lists
    // every suspended step from (`default.ts:630-643`). The record's `payload` is the step's
    // *input*, Mastra's `StepResult.payload`; the suspension's own is `suspendPayload`, kept
    // on the record for the arm the block did not report too.
    expect(report.stepResults.get('push')).toMatchObject({ status: 'suspended', payload: 'alert', suspendPayload: 'push-wait' });
    expect(report.stepResults.get('sms')).toMatchObject({ status: 'suspended', payload: 'alert', suspendPayload: 'sms-wait' });
  });

  it('suspends rather than succeeds when one arm suspends and another succeeds', async () => {
    const runner = runnerFor(
      { route: () => [0, 1] },
      { email: tag('email'), sms: () => ({ status: 'suspended', suspendPayload: 'wait' }) },
    );

    const outcome = await runWorkflow(compile(threeArmsThenAudit), 'alert', { runner });

    expect(runner.calls).not.toContain('audit');
    expect(outcome).toStrictEqual({ status: 'suspended', stepId: 'sms', path: [0, 1], payload: 'wait' });
  });

  it('succeeds with an empty record when every selected arm bails', async () => {
    const runner = runnerFor(
      { route: () => [0, 1, 2] },
      {
        email: () => ({ status: 'bailed', output: 1 }),
        sms: () => ({ status: 'bailed', output: 2 }),
        push: () => ({ status: 'bailed', output: 3 }),
      },
    );

    const outcome = await runWorkflow(compile(threeArms), 'alert', { runner });

    // Not `bailed: true`: the bail was swallowed by the block, it did not end the run.
    expect(outcome).toStrictEqual({ status: 'success', output: {} });
  });

  it('ranks a failure by its arm, not its step id, when two arms share one (closes row 33)', async () => {
    // Arms 0 and 2 are both `x`: arm 0 succeeds, arm 2 fails, and arm 1 (`y`) fails. Mastra's
    // `results.find` is over arm order (`handlers/control-flow.ts:596`), so it reports `y`, index 1.
    // The failure's origin path names its arm (`[0, 2]`), so the join ranks it at 2, not at the
    // id's first arm, 0 — which used to report `x`.
    const runner = runnerFor(
      { route: () => [0, 1, 2] },
      {
        x: async (_input, call) => {
          if (call.path[1] === 0) return ok('x-ok');
          return { status: 'failed', error: 'x-failed' };
        },
        y: async () => { await sleep(10); return { status: 'failed', error: 'y-failed' }; },
      },
    );

    const outcome = await runWorkflow(compile(workflow(branch('route', step('x'), step('y'), step('x')))), 'in', { runner });

    expect(outcome).toStrictEqual({ status: 'failed', stepId: 'y', path: [0, 1], error: 'y-failed' });
  });

  it('ranks the lower of two same-id arms when both fail, by path', async () => {
    const runner = runnerFor(
      { route: () => [0, 1] },
      {
        // Arm 1 fails first in time; arm 0 is the one Mastra reports.
        x: async (_input, call) => {
          if (call.path[1] === 0) { await sleep(15); return { status: 'failed', error: 'arm0' }; }
          return { status: 'failed', error: 'arm1' };
        },
      },
    );

    const outcome = await runWorkflow(compile(workflow(branch('route', step('x'), step('x')))), 'in', { runner });

    expect(outcome).toStrictEqual({ status: 'failed', stepId: 'x', path: [0, 0], error: 'arm0' });
  });

  it('runs arm i at the block path plus i, as control-flow.ts:569 hands it', async () => {
    const paths: Record<string, readonly number[]> = {};
    const record: Behaviour = (input, call) => { paths[`${call.path.join('-')}`] = call.path; return ok(input); };
    const runner = runnerFor({ route: () => [0, 2] }, { email: record, push: record });

    await runWorkflow(compile(workflow(step('prep'), branch('route', step('email'), step('sms'), step('push')))), 'x', { runner });

    expect(Object.values(paths).sort()).toEqual([[1, 0], [1, 2]]);
  });

  it('fails a broken evaluation with the block as origin, at the block path', async () => {
    const runner = runnerFor({ route: () => { throw new Error('no'); } });
    const outcome = await runWorkflow(compile(workflow(step('prep'), branch('route', step('a')))), 'x', { runner });
    expect(outcome).toStrictEqual({ status: 'failed', stepId: 'route', path: [1], error: expect.any(Error) });
  });

  it('a broken evaluation after the condition aborted: canceled, the origin still at the block path', async () => {
    // Mastra's condition context carries `abort()` (`handlers/control-flow.ts:428-432`). The
    // evaluation then breaks, the block fails, and the after-entry check re-stamps the failure
    // canceled (`handlers/entry.ts:815-817`). The origin is the failure's, so it shows the path.
    const ac = new AbortController();
    const runner = runnerFor({ route: () => { ac.abort(); throw new Error('no'); } });
    const outcome = await runWorkflow(compile(workflow(step('prep'), branch('route', step('a')), step('audit'))), 'x', {
      runner,
      signal: ac.signal,
      timeoutMs: 5_000,
    });
    expect(runner.calls).toEqual(['prep']);
    // The failure ran and the settle stage re-stamped it: `started: true`.
    expect(outcome).toStrictEqual({ status: 'canceled', origin: { stepId: 'route', path: [1] }, started: true });
  });
});

describe('branch: a broken evaluation fails the block', () => {
  const expectBlockFailure = (outcome: RunOutcome, pattern: RegExp): Error => {
    expect(outcome.status).toBe('failed');
    const failed = outcome as Extract<RunOutcome, { status: 'failed' }>;
    expect(failed.stepId).toBe('route');
    expect(failed).not.toHaveProperty('residue');
    expect(failed.error).toBeInstanceOf(Error);
    expect((failed.error as Error).message).toMatch(pattern);
    return failed.error as Error;
  };

  it('when selectBranches itself throws, naming the entry and keeping the cause', async () => {
    const boom = new Error('condition evaluation blew up');
    const runner = runnerFor({ route: () => { throw boom; } });

    const outcome = await runWorkflow(compile(threeArms), 'alert', { runner });

    expect(runner.calls).toEqual([]);
    const error = expectBlockFailure(outcome, /branch 'route': selectBranches threw: condition evaluation blew up/);
    expect(error.cause).toBe(boom);
  });

  it('when an index names no arm', async () => {
    const runner = runnerFor({ route: () => [0, 7] });

    const outcome = await runWorkflow(compile(threeArms), 'alert', { runner });

    expect(runner.calls).toEqual([]);
    expectBlockFailure(outcome, /branch 'route': selectBranches returned arm index 7, outside 0\.\.2/);
  });

  it('when the answer is not an array of integers', async () => {
    const answers: ReadonlyArray<readonly [string, unknown, RegExp]> = [
      ['undefined', undefined, /returned undefined, not an array/],
      ['a Set', new Set([0]), /returned a Set, not an array/],
      ['a fraction', [1.5], /arm index 1\.5, outside/],
      ['a string index', ['1'], /arm index "1", outside/],
      ['a negative index', [-1], /arm index -1, outside/],
    ];
    for (const [label, answer, pattern] of answers) {
      const runner = runnerFor({ route: () => answer as readonly number[] });
      const outcome = await runWorkflow(compile(threeArms), 'alert', { runner });
      expect(runner.calls, label).toEqual([]);
      expectBlockFailure(outcome, pattern);
    }
  });

  it('when the runner cannot evaluate a branch at all', async () => {
    // The net holds no runner, so this surfaces when the block is reached, not at compile.
    const outcome = await runWorkflow(compile(threeArms), 'alert', { runner: new RecordingRunner() });

    expectBlockFailure(outcome, /branch 'route' needs a runner with selectBranches/);
  });
});

describe('branch: an empty block', () => {
  it('as the last entry, succeeds with an empty record and asks nothing of the runner', async () => {
    // No `branches` configured: the runner has no selectBranches, and none is needed.
    const runner = new RecordingRunner();

    const outcome = await runWorkflow(compile(workflow(branch('route'))), 'alert', { runner });

    expect(outcome).toStrictEqual({ status: 'success', output: {} });
  });

  it('as a middle entry, hands the next entry an empty record', async () => {
    const runner = new RecordingRunner({ steps: { audit: echo } });

    const outcome = await runWorkflow(compile(workflow(branch('route'), step('audit'))), 'alert', { runner });

    expect(runner.calls).toEqual(['audit']);
    expect(outcome).toStrictEqual({ status: 'success', output: {} });
  });

  it('is a single pass-through transition, plus its cancellation sweep', () => {
    const compiled = compile(workflow(branch('route')));
    expect([...compiled.net.transitions].map((t) => t.name).filter((n) => n.startsWith('t.0.')).sort()).toEqual([
      't.0.route.cancel',
      't.0.route.pass',
    ]);
  });
});

describe('branch: structure', () => {
  it('compiles without a runner: the net is a function of the description alone', () => {
    expect(() => compile(threeArmsThenAudit)).not.toThrow();
    expect(compile(threeArmsThenAudit).structuralHash).toBe(compile(threeArmsThenAudit).structuralHash);
  });

  it('emits 2n + 9 transitions of its own plus one per arm, every name unique', () => {
    const compiled = compile(workflow(branch('route', step('x'), step('x'), step('y'))));

    const places = [...compiled.net.places].map((p) => p.name);
    const transitions = [...compiled.net.transitions].map((t) => t.name);
    expect(new Set(places).size).toBe(places.length);
    expect(new Set(transitions).size).toBe(transitions.length);
    // decide, its cancellation sweep, gate-i and collect-i per arm, four exit collects, three joins.
    expect(transitions.filter((name) => name.startsWith('t.0.route.'))).toHaveLength(2 * 3 + 9);
    // Two arms share the id `x` and still get distinct transitions, because the path differs.
    expect(transitions.filter((name) => /^t\.0-\d\.x\.run$/.test(name)).sort()).toEqual(['t.0-0.x.run', 't.0-1.x.run']);
  });

  it('refuses an arm that is not a single step, for a caller that bypassed the types', () => {
    const nested = {
      id: 'triage',
      entries: [{ kind: 'branch', id: 'route', arms: [{ kind: 'parallel', id: 'inner', arms: [] }] }],
    } as unknown as WorkflowDescription;

    expect(() => compile(nested)).toThrow(/arm 'inner' is a 'parallel' entry/);
  });
});

describe('branch: cancellation', () => {
  const armsThenAudit = workflow(step('prep'), branch('route', step('email'), step('sms'), step('push')), step('audit'));

  it('aborted before the block: canceled at the block, no condition evaluated, no arm runs', async () => {
    const ac = new AbortController();
    const runner = runnerFor(
      { route: () => [0, 1, 2] },
      { prep: (input) => { ac.abort(); return ok(input); } },
    );

    const report = await runWorkflowDetailed(compile(armsThenAudit), 'x', { runner, signal: ac.signal, clock: new ManualClock() });

    // Swept at the block's gate: it never began, `started: false`.
    expect(report.outcome).toEqual({ status: 'canceled', origin: { stepId: 'route', path: [1] }, started: false });
    expect(runner.selected).toEqual([]);
    expect(runner.calls).toEqual(['prep']);
    expect(report.stepResults.get('prep')).toMatchObject({ status: 'success', output: 'x' });
  });

  // Mastra checks before the first entry (`default.ts:815`), so a pre-aborted run never starts it.
  // These two fail against the kernel as integrated: `kernel.ts:142` seeds the *request* place, so
  // the immediate `t.cancel.arrive` and the first entry's start are enabled together and the start
  // fires first (deterministically, in 20 of 20 runs). Seeding `compiled.cancel` instead makes both
  // pass — checked on a scratch copy of the kernel. Reported to the lead; not a branch defect.
  it('aborted before the run: canceled at a first-entry block', async () => {
    const ac = new AbortController();
    ac.abort();
    const runner = runnerFor({ route: () => [0] });

    const outcome = await runWorkflow(compile(threeArms), 'x', { runner, signal: ac.signal });

    expect(outcome).toEqual({ status: 'canceled', origin: { stepId: 'route', path: [0] }, started: false });
    expect(runner.selected).toEqual([]);
    expect(runner.calls).toEqual([]);
  });

  it('aborted before an empty block: canceled there too', async () => {
    const ac = new AbortController();
    ac.abort();
    const outcome = await runWorkflow(compile(workflow(branch('route'), step('audit'))), 'x', {
      runner: new RecordingRunner(),
      signal: ac.signal,
    });
    expect(outcome).toEqual({ status: 'canceled', origin: { stepId: 'route', path: [0] }, started: false });
  });

  it('aborted while an arm runs: every selected arm still runs and is recorded, the next entry is swept', async () => {
    const ac = new AbortController();
    const runner = runnerFor(
      { route: () => [0, 1, 2] },
      {
        email: (input) => { ac.abort(); return ok(`email(${String(input)})`); },
        sms: async (input) => { await sleep(15); return ok(`sms(${String(input)})`); },
        push: async (input) => { await sleep(5); return ok(`push(${String(input)})`); },
      },
    );

    const report = await runWorkflowDetailed(compile(armsThenAudit), 'x', { runner, signal: ac.signal, timeoutMs: 5_000 });

    expect([...runner.calls].sort()).toEqual(['email', 'prep', 'push', 'sms']);
    for (const arm of ['email', 'sms', 'push']) {
      expect(report.stepResults.get(arm), arm).toMatchObject({ status: 'success', output: `${arm}(x)`, payload: 'x' });
    }
    // Mastra re-stamps the block `canceled` after it (`handlers/entry.ts:815-817`) and never
    // starts `audit`; the net's check is the next entry's sweep.
    expect(report.outcome).toEqual({ status: 'canceled', origin: { stepId: 'audit', path: [2] }, started: false });
  });

  it('aborted while an arm runs in a last-entry block: the settle stage re-stamps the success canceled', async () => {
    const ac = new AbortController();
    const runner = runnerFor(
      { route: () => [0, 2] },
      {
        email: async (input) => { await sleep(10); return ok(input); },
        push: (input) => { ac.abort(); return ok(input); },
      },
    );

    const report = await runWorkflowDetailed(compile(threeArms), 'x', { runner, signal: ac.signal, timeoutMs: 5_000 });

    expect([...runner.calls].sort()).toEqual(['email', 'push']);
    expect(report.stepResults.get('email')).toMatchObject({ status: 'success' });
    expect(report.outcome).toEqual({ status: 'canceled', started: true });
  });

  it('aborted while an arm fails: canceled outranks the failure, which keeps its record', async () => {
    const ac = new AbortController();
    const runner = runnerFor(
      { route: () => [0, 1] },
      {
        email: async () => { await sleep(10); return ok('late'); },
        sms: () => { ac.abort(); return { status: 'failed', error: 'down' }; },
      },
    );

    const report = await runWorkflowDetailed(compile(threeArms), 'x', { runner, signal: ac.signal, timeoutMs: 5_000 });

    expect(report.outcome).toEqual({ status: 'canceled', origin: { stepId: 'sms', path: [0, 1] }, started: true });
    expect(report.stepResults.get('sms')).toMatchObject({ status: 'failed', error: 'down' });
    expect(report.stepResults.get('email')).toMatchObject({ status: 'success', output: 'late' });
  });

  // A condition may abort the run itself: Mastra hands every condition `abort()` and the
  // signal (`handlers/control-flow.ts:428-434`), and then runs every truthy arm with no check in
  // between (`:497-540` filter, then `Promise.all` over the arms with none either). These two
  // are the only runs in which the abort is already set when the arms would start, so they are
  // the ones that tell "no check inside a started block" from an arm-level gate.
  it('a condition aborts, then selects two arms, as a middle entry: both arms run and are recorded', async () => {
    const ac = new AbortController();
    const seen: boolean[] = [];
    const runner = runnerFor(
      {
        route: (_input, view) => {
          ac.abort();
          seen.push(view.abortSignal.aborted);
          return [0, 1];
        },
      },
      { email: tag('email'), sms: tag('sms') },
    );

    const report = await runWorkflowDetailed(compile(armsThenAudit), 'x', { runner, signal: ac.signal, timeoutMs: 5_000 });

    // The view's signal is the run's: the condition sees its own abort.
    expect(seen).toEqual([true]);
    expect([...runner.calls].sort()).toEqual(['email', 'prep', 'sms']);
    expect(report.stepResults.get('email')).toMatchObject({ status: 'success', output: 'email(x)', payload: 'x' });
    expect(report.stepResults.get('sms')).toMatchObject({ status: 'success', output: 'sms(x)', payload: 'x' });
    expect(report.stepResults.has('push')).toBe(false);
    // `toStrictEqual` also refuses a `residue` key. The origin is the next entry's sweep; Mastra
    // stops at the block itself (`handlers/entry.ts:815-817`) — the contract-level origin
    // difference recorded for every top-level entry, not specific to `.branch()`.
    expect(report.outcome).toStrictEqual({ status: 'canceled', origin: { stepId: 'audit', path: [2] }, started: false });
  });

  it('a condition aborts, then selects two arms, as the last entry: both arms run, the run ends canceled', async () => {
    const ac = new AbortController();
    const runner = runnerFor(
      { route: () => { ac.abort(); return [0, 1]; } },
      { email: tag('email'), sms: tag('sms') },
    );

    const report = await runWorkflowDetailed(compile(threeArms), 'x', { runner, signal: ac.signal, timeoutMs: 5_000 });

    expect([...runner.calls].sort()).toEqual(['email', 'sms']);
    expect(report.stepResults.get('email')).toMatchObject({ status: 'success', output: 'email(x)' });
    expect(report.stepResults.get('sms')).toMatchObject({ status: 'success', output: 'sms(x)' });
    // Mastra's ladder reaches `canceled` (`:612`) and `entry.ts:815-817` re-stamps it anyway; the
    // settle stage is where the net does it, and a canceled run carries no step id.
    expect(report.outcome).toStrictEqual({ status: 'canceled', started: true });
  });

  it('a condition aborts and selects a reused arm: the reuse still arrives, nothing is left behind', async () => {
    // `sms` already succeeded as entry 0, so arm 1 is reused rather than run (`:552-553`). The
    // reuse goes gate -> arrived directly, so an arm-level gate cannot see it — but a gated arm
    // 0 beside it would strand the reused arrival.
    const ac = new AbortController();
    const runner = runnerFor(
      { route: () => { ac.abort(); return [0, 1]; } },
      { sms: tag('first-sms'), email: tag('email') },
    );

    const report = await runWorkflowDetailed(compile(workflow(step('sms'), branch('route', step('email'), step('sms')))), 'x', {
      runner,
      signal: ac.signal,
      timeoutMs: 5_000,
    });

    expect(runner.calls).toEqual(['sms', 'email']);
    expect(report.outcome).toStrictEqual({ status: 'canceled', started: true });
  });

  it('an arm retrying after the abort keeps retrying: retries are not gated', async () => {
    const ac = new AbortController();
    const runner = runnerFor(
      { route: () => [0] },
      { flaky: (input, call) => { if (call.attempt === 0) { ac.abort(); return { status: 'failed', error: 'blip' }; } return ok(input); } },
    );

    const outcome = await runWorkflow(compile(workflow(branch('route', step('flaky', { retries: 2 })))), 'x', {
      runner,
      signal: ac.signal,
      timeoutMs: 5_000,
    });

    expect(runner.attempts).toEqual([{ stepId: 'flaky', attempt: 0 }, { stepId: 'flaky', attempt: 1 }]);
    expect(outcome).toEqual({ status: 'canceled', started: true });
  });

  it('a signal that never fires changes nothing, and every outcome still ends the run', async () => {
    const signal = new AbortController().signal;
    const cases: ReadonlyArray<readonly [string, WorkflowDescription, ReturnType<typeof runnerFor>, RunOutcome]> = [
      ['success, last entry', threeArms, runnerFor({ route: () => [0, 2] }), { status: 'success', output: { email: 'x', push: 'x' } }],
      [
        'success, middle entry',
        armsThenAudit,
        runnerFor({ route: () => [1] }),
        { status: 'success', output: { email: undefined, sms: 'x', push: undefined } },
      ],
      ['no truthy arm', threeArms, runnerFor({ route: () => [] }), { status: 'success', output: {} }],
      [
        'failed',
        threeArms,
        runnerFor({ route: () => [0, 1] }, { sms: () => ({ status: 'failed', error: 'down' }) }),
        { status: 'failed', stepId: 'sms', path: [0, 1], error: 'down' },
      ],
      [
        'suspended',
        threeArms,
        runnerFor({ route: () => [2] }, { push: () => ({ status: 'suspended', suspendPayload: 'wait' }) }),
        { status: 'suspended', stepId: 'push', path: [0, 2], payload: 'wait' },
      ],
    ];
    for (const [label, description, runner, expected] of cases) {
      const outcome = await runWorkflow(compile(description), 'x', { runner, signal, clock: new ManualClock(), timeoutMs: 5_000 });
      expect(outcome, label).toStrictEqual(expected);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// `CanceledToken.started` — structural: which sweep fired says whether the work had begun.
// ---------------------------------------------------------------------------------------------

/**
 * Observes every token a gadget writes to its `canceled` exit without changing what happens
 * next: the gadget is compiled with a local tap in that exit's stead, and one forwarding
 * transition copies each token on. It reads `started` straight off the token, independent of
 * whether the kernel's `RunOutcome` forwards it.
 */
function tappedCanceled(inner: Gadget): { gadget: Gadget; seen: unknown[] } {
  const seen: unknown[] = [];
  const gadget: Gadget = (entry, next, ctx) => {
    const tap = place<CanceledToken>(ctx.names.reserve(`test.tap.canceled.${entry.id}`, 'test observation tap'));
    const result = inner(entry, next, { ...ctx, exits: { ...ctx.exits, canceled: tap } });
    const forward = Transition.builder(`test.tap.canceled.${entry.id}.forward`)
      .inputs(one(tap))
      .outputs(outPlace(ctx.exits.canceled))
      .action(async (tctx) => {
        const token = tctx.input(tap);
        seen.push(token);
        tctx.output(ctx.exits.canceled, token);
      })
      .build();
    return { ...result, transitions: [...result.transitions, forward] };
  };
  return { gadget, seen };
}

/**
 * `inner`, with every transition whose name ends in `suffix` rebuilt so the `started` flag of any
 * canceled token it writes is inverted — every arc, the timing and the priority kept. The mutant
 * that shows a `started` assertion is not vacuous.
 */
function flippingStarted(inner: Gadget, suffix: string): Gadget {
  return (entry, next, ctx) => {
    const r = inner(entry, next, ctx);
    const flip = (t: Transition): Transition => {
      const b = Transition.builder(t.name)
        .inputs(...t.inputSpecs)
        .outputs(t.outputSpec!)
        .timing(t.timing)
        .priority(t.priority)
        .action((tctx) =>
          t.action(
            new Proxy(tctx, {
              get(target, prop) {
                if (prop === 'output') {
                  return (p: Place<unknown>, value: unknown) =>
                    target.output(
                      p,
                      value !== null && typeof value === 'object' && 'started' in value
                        ? { ...value, started: !(value as CanceledToken).started }
                        : value,
                    );
                }
                const v: unknown = Reflect.get(target, prop, target);
                return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
              },
            }),
          ),
        );
      for (const arc of t.reads) b.read(arc.place);
      for (const arc of t.inhibitors) b.inhibitor(arc.place);
      for (const arc of t.resets) b.reset(arc.place);
      return b.build();
    };
    const transitions = r.transitions.map((t) => (t.name.endsWith(suffix) ? flip(t) : t));
    expect(transitions.filter((t, i) => t !== r.transitions[i]).length, `no transition ends in '${suffix}'`).toBeGreaterThan(0);
    return { ...r, transitions };
  };
}

describe('branch: the block\'s cancel sweep reports started false', () => {
  const shape = workflow(step('prep'), branch('route', step('email'), step('sms')), step('audit'));
  const abortingPrep = () => {
    const ac = new AbortController();
    const runner = runnerFor({ route: () => [0, 1] }, { prep: (input) => { ac.abort(); return ok(input); } });
    return { runner, signal: ac.signal };
  };

  it('a block swept at its gate never began: started false, no condition asked', async () => {
    const tap = tappedCanceled(branchGadget);
    const control = abortingPrep();
    await runWorkflow(compile(shape, { gadgets: { branch: tap.gadget } }), 'x', { ...control, timeoutMs: 5_000 });
    expect(tap.seen).toStrictEqual([{ origin: { stepId: 'route', path: [1] }, started: false }]);
    expect(control.runner.selected).toEqual([]);
  });

  it('a block whose condition ran writes nothing to its canceled exit', async () => {
    const ac = new AbortController();
    const tap = tappedCanceled(branchGadget);
    const runner = runnerFor({ route: () => { ac.abort(); return [0, 1]; } });
    await runWorkflow(compile(shape, { gadgets: { branch: tap.gadget } }), 'x', { runner, signal: ac.signal, timeoutMs: 5_000 });
    expect(tap.seen).toStrictEqual([]);
  });

  it('a mutant whose sweep reports started true is caught', async () => {
    const tap = tappedCanceled(flippingStarted(branchGadget, '.cancel'));
    await runWorkflow(compile(shape, { gadgets: { branch: tap.gadget } }), 'x', { ...abortingPrep(), timeoutMs: 5_000 });
    expect(tap.seen).toStrictEqual([{ origin: { stepId: 'route', path: [1] }, started: true }]);
  });
});

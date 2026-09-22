import { describe, expect, it } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import type {
  EntryDescription,
  RunView,
  StepDescription,
  StepOutcome,
  WorkflowDescription,
} from '../../src/compiler/types.js';
import { runWorkflow, runWorkflowDetailed, type RunOutcome } from '../../src/engine/index.js';
import { RecordingRunner, type Behaviour } from '../fixtures/runner.js';

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
      stepResults: new Map([['email', { status: 'failed', error: 'old' }]]),
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

    expect(outcome).toStrictEqual({ status: 'failed', stepId: 'email', error: 'email down' });
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
    expect(outcome).toStrictEqual({ status: 'failed', stepId: 'email', error: 'boom' });
  });

  it('forwards a tripwire unchanged, so the run ends as tripwire', async () => {
    const tripwire = { reason: 'blocked by processor', processorId: 'moderation' };
    const runner = runnerFor(
      { route: () => [0, 1] },
      { email: tag('email'), sms: () => ({ status: 'failed', error: 'tripped', tripwire }) },
    );

    const outcome = await runWorkflow(compile(threeArms), 'alert', { runner });

    expect(outcome).toStrictEqual({ status: 'tripwire', stepId: 'sms', tripwire });
  });

  it('treats a throwing arm step as a failed arm rather than a lost token', async () => {
    const boom = new Error('provider down');
    const runner = runnerFor({ route: () => [2] }, { push: () => { throw boom; } });

    const outcome = await runWorkflow(compile(threeArms), 'alert', { runner });

    expect(outcome).toStrictEqual({ status: 'failed', stepId: 'push', error: boom });
  });

  it('ranks failed above suspended, whichever settles first, and leaves no suspension behind', async () => {
    for (const suspendFirst of [true, false]) {
      const runner = runnerFor(
        { route: () => [0, 1] },
        {
          email: async () => {
            if (!suspendFirst) await sleep(15);
            return { status: 'suspended', payload: { ask: 'approve?' } };
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
        error: 'carrier rejected',
      });
    }
  });

  it('suspends with the lowest suspended arm, carrying that arm path', async () => {
    const runner = runnerFor(
      { route: () => [1, 2] },
      {
        sms: async () => { await sleep(15); return { status: 'suspended', payload: 'sms-wait' }; },
        push: () => ({ status: 'suspended', payload: 'push-wait' }),
      },
    );

    const report = await runWorkflowDetailed(compile(threeArms), 'alert', { runner });

    expect(report.outcome).toStrictEqual({ status: 'suspended', stepId: 'sms', path: [0, 1], payload: 'sms-wait' });
    // Both arms' suspensions are in the step results, which is where Mastra's run result lists
    // every suspended step from (`default.ts:630-643`).
    expect(report.stepResults.get('push')).toEqual({ status: 'suspended', payload: 'push-wait' });
  });

  it('suspends rather than succeeds when one arm suspends and another succeeds', async () => {
    const runner = runnerFor(
      { route: () => [0, 1] },
      { email: tag('email'), sms: () => ({ status: 'suspended', payload: 'wait' }) },
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

  it('reports a failure by the first arm carrying its id when two arms share one (a pinned divergence)', async () => {
    // Arms 0 and 2 are both `x`: one of them succeeds, the other fails, and arm 1 (`y`) fails.
    // When the failing `x` is arm 2, Mastra's `results.find` reports `y` (index 1). A failure
    // carries only its step id, so the join ranks every `x` failure at the id's first arm, 0, and
    // reports `x`'s error either way. Reported for docs/divergences.md.
    let xRuns = 0;
    const runner = runnerFor(
      { route: () => [0, 1, 2] },
      {
        x: async () => {
          xRuns += 1;
          if (xRuns === 1) return ok('x-ok');
          await sleep(10);
          return { status: 'failed', error: 'x-failed' };
        },
        y: () => ({ status: 'failed', error: 'y-failed' }),
      },
    );

    const outcome = await runWorkflow(compile(workflow(branch('route', step('x'), step('y'), step('x')))), 'in', { runner });

    expect(outcome).toStrictEqual({ status: 'failed', stepId: 'x', error: 'x-failed' });
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

  it('is a single pass-through transition', () => {
    const compiled = compile(workflow(branch('route')));
    expect([...compiled.net.transitions].map((t) => t.name)).toEqual(['t.0.route.pass']);
  });
});

describe('branch: structure', () => {
  it('compiles without a runner: the net is a function of the description alone', () => {
    expect(() => compile(threeArmsThenAudit)).not.toThrow();
    expect(compile(threeArmsThenAudit).structuralHash).toBe(compile(threeArmsThenAudit).structuralHash);
  });

  it('emits 2n + 8 transitions of its own plus one per arm, every name unique', () => {
    const compiled = compile(workflow(branch('route', step('x'), step('x'), step('y'))));

    const places = [...compiled.net.places].map((p) => p.name);
    const transitions = [...compiled.net.transitions].map((t) => t.name);
    expect(new Set(places).size).toBe(places.length);
    expect(new Set(transitions).size).toBe(transitions.length);
    // decide, gate-i and collect-i per arm, four exit collects, three joins.
    expect(transitions.filter((name) => name.startsWith('t.0.route.'))).toHaveLength(2 * 3 + 8);
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

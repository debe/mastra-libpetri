import { PrecompiledNetExecutor, tokenOf } from 'libpetri';
import { describe, expect, it } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { branchGadget } from '../../src/compiler/gadgets/branch.js';
import type {
  CompiledWorkflow,
  FlowToken,
  StepOutcome,
  StepRunner,
  WorkflowDescription,
} from '../../src/compiler/types.js';
import { classify, type RunOutcome } from '../../src/engine/index.js';
import { RecordingRunner } from '../fixtures/runner.js';

/**
 * A `RecordingRunner` that can also answer the inclusive-branch question.
 *
 * `selectBranches` is optional on `StepRunner`, so the shared fixture does not implement it —
 * and the test for a runner that cannot answer needs a fixture that genuinely cannot, so this
 * lives here rather than in `tests/fixtures/runner.ts`.
 */
class BranchingRunner extends RecordingRunner {
  /** Which entries asked for a decision, so "once per branch, not once per arm" is assertable. */
  readonly selections: string[] = [];

  constructor(
    private readonly select: (entryId: string, input: unknown) => readonly number[],
    behaviour: Record<string, (input: unknown) => StepOutcome> = {},
  ) {
    super(behaviour);
  }

  async selectBranches(entryId: string, input: unknown): Promise<readonly number[]> {
    this.selections.push(entryId);
    return this.select(entryId, input);
  }
}

/** Registers the branch gadget explicitly, so the other composites stay `unimplemented`. */
function compileBranch(description: WorkflowDescription, runner: StepRunner): CompiledWorkflow {
  return compile(description, { runner, gadgets: { branch: branchGadget } });
}

/**
 * Runs to quiescence and reports both the outcome *and* what was left behind.
 *
 * `classify` reports `failed` the moment the failure terminal holds a token, so a run that also
 * stranded a sibling's token still reads as a clean failure. The residue is the only way to
 * assert the property this gadget exists to get right, so these tests drive the executor
 * directly instead of going through `runWorkflow`.
 */
async function runAndInspect(
  compiled: CompiledWorkflow,
  input: unknown,
): Promise<{ outcome: RunOutcome; residue: readonly string[] }> {
  const executor = new PrecompiledNetExecutor(
    compiled.net,
    new Map([[compiled.entryPlace, [tokenOf<FlowToken>({ data: input })]]]),
    {},
  );
  const marking = await executor.run(5_000, 'close');

  const terminals = new Set([compiled.donePlace.name, compiled.failedPlace.name]);
  const residue: string[] = [];
  for (const p of compiled.net.places) {
    if (!terminals.has(p.name) && marking.tokenCount(p) > 0) residue.push(p.name);
  }
  return { outcome: classify(compiled, marking), residue: residue.sort() };
}

const successOutput = (outcome: RunOutcome): Record<string, unknown> =>
  outcome.status === 'success' ? (outcome.output as Record<string, unknown>) : {};

const failureError = (outcome: RunOutcome): unknown =>
  outcome.status === 'failed' ? outcome.error : undefined;

/** `.branch` over three single-step arms, as the only entry, so its record is the run output. */
const threeArms = {
  id: 'triage',
  entries: [
    {
      kind: 'branch',
      id: 'route',
      arms: [
        { kind: 'step', id: 'email' },
        { kind: 'step', id: 'sms' },
        { kind: 'step', id: 'push' },
      ],
    },
  ],
} as const;

describe('branch gadget (inclusive)', () => {
  it('runs exactly the one selected arm and joins its result under the arm id', async () => {
    const runner = new BranchingRunner(() => [1], {
      sms: (input) => ({ status: 'success', output: `sms(${input as string})` }),
    });

    const { outcome, residue } = await runAndInspect(compileBranch(threeArms, runner), 'alert');

    expect(runner.calls).toEqual(['sms']);
    expect(outcome).toEqual({ status: 'success', output: { sms: 'sms(alert)' } });
    expect(residue).toEqual([]);
  });

  it('runs every truthy arm, not just the first — `.branch` is inclusive, not if/else', async () => {
    const runner = new BranchingRunner(() => [0, 2], {
      email: (input) => ({ status: 'success', output: `email(${input as string})` }),
      push: (input) => ({ status: 'success', output: `push(${input as string})` }),
    });

    const { outcome, residue } = await runAndInspect(compileBranch(threeArms, runner), 'alert');

    expect([...runner.calls].sort()).toEqual(['email', 'push']);
    expect(outcome).toEqual({
      status: 'success',
      output: { email: 'email(alert)', push: 'push(alert)' },
    });
    expect(residue).toEqual([]);
  });

  it('keys the joined record by arm order, not by which arm finished first', async () => {
    const runner = new BranchingRunner(() => [0, 2], {
      email: (input) => ({ status: 'success', output: `email(${input as string})` }),
      push: (input) => ({ status: 'success', output: `push(${input as string})` }),
    });
    // Arm 0 resolves later than arm 2, so arrival order can be the reverse of arm order.
    const inherited = RecordingRunner.prototype.run.bind(runner);
    runner.run = async (stepId: string, input: unknown): Promise<StepOutcome> => {
      if (stepId === 'email') await new Promise((resolve) => setTimeout(resolve, 5));
      return inherited(stepId, input);
    };

    const { outcome } = await runAndInspect(compileBranch(threeArms, runner), 'alert');

    expect(outcome.status).toBe('success');
    expect(Object.keys(successOutput(outcome))).toEqual(['email', 'push']);
  });

  it('calls selectBranches once for the whole branch, never once per arm', async () => {
    const runner = new BranchingRunner(() => [0, 1, 2]);

    await runAndInspect(compileBranch(threeArms, runner), 'alert');

    // Three arms ran off one decision. Deciding per arm would be three decisions that could
    // disagree with each other, which is the bug this shape exists to prevent.
    expect(runner.selections).toEqual(['route']);
    expect([...runner.calls].sort()).toEqual(['email', 'push', 'sms']);
  });

  it('completes with an empty record when zero arms are selected', async () => {
    const runner = new BranchingRunner(() => []);

    const { outcome, residue } = await runAndInspect(compileBranch(threeArms, runner), 'alert');

    // Zero truthy conditions is a legal Mastra outcome, not a hang: every gate skips, every
    // skip still deposits its arrival marker, and the join fires on n markers as usual.
    expect(runner.calls).toEqual([]);
    expect(outcome).toEqual({ status: 'success', output: {} });
    expect(residue).toEqual([]);
  });

  it('still reaches the next entry when zero arms are selected', async () => {
    const runner = new BranchingRunner(() => [], {
      audit: (input) => ({ status: 'success', output: { sawBranchOutput: input } }),
    });
    const chained = {
      id: 'triage',
      entries: [
        { kind: 'branch', id: 'route', arms: [{ kind: 'step', id: 'email' }] },
        { kind: 'step', id: 'audit' },
      ],
    } as const;

    const { outcome, residue } = await runAndInspect(compileBranch(chained, runner), 'alert');

    expect(runner.calls).toEqual(['audit']);
    expect(outcome).toEqual({ status: 'success', output: { sawBranchOutput: {} } });
    expect(residue).toEqual([]);
  });

  it('routes a failing arm to the failure terminal without stranding the skipped arms', async () => {
    const runner = new BranchingRunner(() => [1], {
      sms: () => ({ status: 'failed', error: 'carrier rejected' }),
    });

    const { outcome, residue } = await runAndInspect(compileBranch(threeArms, runner), 'alert');

    // The failing arm's own id, not the branch's: a trace saying `route` failed would hide
    // which arm did.
    expect(outcome).toEqual({ status: 'failed', stepId: 'sms', error: 'carrier rejected' });
    // The two skipped arms deposited their markers before the failure was known. If the join
    // could not fire on a failed arm, those markers would sit in `arrived` forever.
    expect(residue).toEqual([]);
  });

  it('does not strand a succeeding sibling when another selected arm fails', async () => {
    const runner = new BranchingRunner(() => [0, 1], {
      email: (input) => ({ status: 'success', output: `email(${input as string})` }),
      sms: () => ({ status: 'failed', error: 'carrier rejected' }),
    });

    const { outcome, residue } = await runAndInspect(compileBranch(threeArms, runner), 'alert');

    expect([...runner.calls].sort()).toEqual(['email', 'sms']);
    expect(outcome).toEqual({ status: 'failed', stepId: 'sms', error: 'carrier rejected' });
    expect(residue).toEqual([]);
  });

  it('does not let the ok join win when the failure is the last arm to settle', async () => {
    // The dangerous ordering. `join.ok` needs n markers and an empty error place; if a failing
    // arm could deposit its marker before its error, there would be a marking with n markers
    // and no error and the run would report success. `arm.i.settle.fail` writes both in one
    // firing, so that marking is unreachable — this pins it with the failure arriving last.
    const runner = new BranchingRunner(() => [0, 1], {
      email: (input) => ({ status: 'success', output: `email(${input as string})` }),
      sms: () => ({ status: 'failed', error: 'carrier rejected' }),
    });
    const inherited = RecordingRunner.prototype.run.bind(runner);
    runner.run = async (stepId: string, input: unknown): Promise<StepOutcome> => {
      if (stepId === 'sms') await new Promise((resolve) => setTimeout(resolve, 10));
      return inherited(stepId, input);
    };

    const { outcome, residue } = await runAndInspect(compileBranch(threeArms, runner), 'alert');

    expect(outcome).toEqual({ status: 'failed', stepId: 'sms', error: 'carrier rejected' });
    expect(residue).toEqual([]);
  });

  it('leaves nothing behind when several arms fail at once', async () => {
    // Exercises the reset arc on the error place: `join.fail` consumes one error token to
    // report and drains the rest, which have no other consumer anywhere in the net.
    const runner = new BranchingRunner(() => [0, 1, 2], {
      email: () => ({ status: 'failed', error: 'e' }),
      sms: () => ({ status: 'failed', error: 's' }),
      push: () => ({ status: 'failed', error: 'p' }),
    });

    const { outcome, residue } = await runAndInspect(compileBranch(threeArms, runner), 'alert');

    expect(outcome.status).toBe('failed');
    expect(residue).toEqual([]);
  });

  it('treats a throwing arm step as a failed arm rather than a lost token', async () => {
    const boom = new Error('provider down');
    const runner = new BranchingRunner(() => [2], {
      push: () => { throw boom; },
    });

    const { outcome, residue } = await runAndInspect(compileBranch(threeArms, runner), 'alert');

    expect(outcome).toEqual({ status: 'failed', stepId: 'push', error: boom });
    expect(residue).toEqual([]);
  });

  it('routes a throwing selectBranches to the failure terminal, arming no arm', async () => {
    const boom = new Error('condition evaluation blew up');
    const runner = new BranchingRunner(() => { throw boom; });

    const { outcome, residue } = await runAndInspect(compileBranch(threeArms, runner), 'alert');

    expect(runner.calls).toEqual([]);
    expect(outcome).toEqual({ status: 'failed', stepId: 'route', error: boom });
    expect(residue).toEqual([]);
  });

  it('routes an out-of-range arm index to the failure terminal rather than skipping silently', async () => {
    const runner = new BranchingRunner(() => [7]);

    const { outcome, residue } = await runAndInspect(compileBranch(threeArms, runner), 'alert');

    expect(outcome.status).toBe('failed');
    expect(String(failureError(outcome))).toMatch(/arm index 7, outside 0\.\.2/);
    expect(residue).toEqual([]);
  });

  it('nests: a branch arm may itself be a branch', async () => {
    const runner = new BranchingRunner(
      (entryId) => (entryId === 'outer' ? [0] : [1]),
      { deep: (input) => ({ status: 'success', output: `deep(${input as string})` }) },
    );
    const nested = {
      id: 'triage',
      entries: [
        {
          kind: 'branch',
          id: 'outer',
          arms: [
            {
              kind: 'branch',
              id: 'inner',
              arms: [{ kind: 'step', id: 'shallow' }, { kind: 'step', id: 'deep' }],
            },
            { kind: 'step', id: 'other' },
          ],
        },
      ],
    } as const;

    const { outcome, residue } = await runAndInspect(compileBranch(nested, runner), 'alert');

    expect(runner.calls).toEqual(['deep']);
    expect(outcome).toEqual({ status: 'success', output: { inner: { deep: 'deep(alert)' } } });
    expect(residue).toEqual([]);
  });

  it('routes a nested branch arm failure through the outer join, not past it', async () => {
    const runner = new BranchingRunner(
      (entryId) => (entryId === 'outer' ? [0, 1] : [0]),
      {
        shallow: () => ({ status: 'failed', error: 'inner blew up' }),
        other: (input) => ({ status: 'success', output: input }),
      },
    );
    const nested = {
      id: 'triage',
      entries: [
        {
          kind: 'branch',
          id: 'outer',
          arms: [
            { kind: 'branch', id: 'inner', arms: [{ kind: 'step', id: 'shallow' }] },
            { kind: 'step', id: 'other' },
          ],
        },
      ],
    } as const;

    const { outcome, residue } = await runAndInspect(compileBranch(nested, runner), 'alert');

    // The inner branch's failure lands in the *outer* gadget's local failure place, so the
    // sibling arm still settles and the outer join still fires.
    expect([...runner.calls].sort()).toEqual(['other', 'shallow']);
    expect(outcome).toEqual({ status: 'failed', stepId: 'shallow', error: 'inner blew up' });
    expect(residue).toEqual([]);
  });

  it('refuses to compile against a runner that cannot answer selectBranches', () => {
    expect(() => compileBranch(threeArms, new RecordingRunner())).toThrow(/selectBranches/);
  });

  it('refuses to compile a branch with no arms', () => {
    const empty = {
      id: 'triage',
      entries: [{ kind: 'branch', id: 'route', arms: [] }],
    } as const;

    expect(() => compileBranch(empty, new BranchingRunner(() => []))).toThrow(/no arms/);
  });

  it('mints a unique name for every place and transition it emits', () => {
    // The vocabulary asserts uniqueness itself ([CORE-010]: place identity is the name string,
    // so a collision merges two places silently). This pins that a branch nested inside a
    // branch, both carrying the same entry id, does not trip it.
    const reusedIds = {
      id: 'triage',
      entries: [
        {
          kind: 'branch',
          id: 'route',
          arms: [
            { kind: 'branch', id: 'route', arms: [{ kind: 'step', id: 'x' }] },
            { kind: 'step', id: 'x' },
          ],
        },
      ],
    } as const;

    const compiled = compileBranch(reusedIds, new BranchingRunner(() => []));

    const placeNames = [...compiled.net.places].map((p) => p.name);
    const transitionNames = [...compiled.net.transitions].map((t) => t.name);
    expect(new Set(placeNames).size).toBe(placeNames.length);
    expect(new Set(transitionNames).size).toBe(transitionNames.length);
    // One transition per arm gate, per success settle and per failure settle, plus decide and
    // the two joins — and nothing duplicated by the nested emit.
    expect(transitionNames.filter((n) => n.startsWith('t.0.route.')).length).toBe(3 * 2 + 3);
  });
});

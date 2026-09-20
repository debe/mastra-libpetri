import { PrecompiledNetExecutor, tokenOf } from 'libpetri';
import { describe, expect, it } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { branchGadget } from '../../src/compiler/gadgets/branch.js';
import type {
  CompiledWorkflow,
  EntryDescription,
  FlowToken,
  StepOutcome,
  StepRunner,
  WorkflowDescription,
} from '../../src/compiler/types.js';
import { classify, type RunOutcome } from '../../src/engine/index.js';
import { verifyWorkflow, describeReport } from '../../src/verify/index.js';

/**
 * A runner that never fires but *can* answer the branch question.
 *
 * `inertRunner` cannot compile a branch at all — `branchGadget` demands `selectBranches` at
 * compile time. Verification is value-blind anyway: each gate declares both of its outcomes,
 * so what this would have returned never reaches the analysis.
 */
const inertBranchRunner: StepRunner = {
  async run(): Promise<StepOutcome> {
    throw new Error('inert runner must not be called');
  },
  async selectBranches(): Promise<readonly number[]> {
    throw new Error('inert runner must not be called');
  },
};

function compileBranch(description: WorkflowDescription, runner: StepRunner): CompiledWorkflow {
  return compile(description, { runner, gadgets: { branch: branchGadget } });
}

const step = (id: string): EntryDescription => ({ kind: 'step', id });
const branch = (id: string, ...arms: EntryDescription[]): EntryDescription =>
  ({ kind: 'branch', id, arms });
const workflow = (...entries: EntryDescription[]): WorkflowDescription => ({ id: 'triage', entries });

const shapes: ReadonlyArray<readonly [string, WorkflowDescription]> = [
  ['one arm', workflow(branch('route', step('email')))],
  ['two arms', workflow(branch('route', step('email'), step('sms')))],
  ['three arms', workflow(branch('route', step('email'), step('sms'), step('push')))],
  [
    'five arms',
    workflow(branch('route', ...[0, 1, 2, 3, 4].map((i) => step(`arm${i}`)))),
  ],
  [
    'branch in a chain',
    workflow(step('validate'), branch('route', step('email'), step('sms')), step('audit')),
  ],
  [
    'branch nested in a branch',
    workflow(branch('outer', branch('inner', step('shallow')), step('other'))),
  ],
  [
    'branch of branches',
    workflow(
      branch(
        'outer',
        branch('left', step('a'), step('b')),
        branch('right', step('c'), step('d')),
      ),
    ),
  ],
  [
    // A `sleep` makes the net timed, which disqualifies the enumeration route ([VER-017] is
    // untimed-only) and forces the SMT pipeline. Both routes have to land on `proven` or the
    // gadget is only provable by accident of which route picked it up.
    'timed arm, forcing the SMT route',
    workflow(branch('route', step('email'), { kind: 'sleep', id: 'nap', durationMs: 50 })),
  ],
];

describe('compiled branch, proved', () => {
  for (const [label, description] of shapes) {
    it(`is deadlock-free and terminates at a declared sink: ${label}`, async () => {
      const reports = await verifyWorkflow(compileBranch(description, inertBranchRunner), {
        timeoutMs: 120_000,
      });

      // Assert `proven` explicitly. `isViolated()` is false for `unknown` too, so asserting
      // "not violated" would pass on a query that timed out and the test would be vacuous
      // from then on.
      for (const report of reports) {
        expect(report.result.verdict.type, describeReport(report)).toBe('proven');
      }
      expect(reports.map((r) => r.property)).toEqual(['deadlockFree', 'terminatesAtSink']);
    }, 300_000);
  }
});

// ===================== stranded-token hunt =====================

interface Residue {
  readonly outcome: RunOutcome;
  /** Places outside the two terminals that still hold tokens once the net is quiescent. */
  readonly residue: readonly string[];
}

/**
 * Runs to quiescence and reports the outcome *and* what was left behind.
 *
 * `classify` reports `failed` the moment the failure terminal holds a token, so a run that
 * also stranded a sibling's token reads as a clean failure through `runWorkflow`. The residue
 * is the only way to see the failure mode this gadget exists to avoid, so these drive the
 * executor directly.
 */
async function runAndInspect(compiled: CompiledWorkflow, input: unknown): Promise<Residue> {
  const executor = new PrecompiledNetExecutor(
    compiled.net,
    new Map([[compiled.entryPlace, [tokenOf<FlowToken>({ data: input })]]]),
    {},
  );
  const marking = await executor.run(5_000, 'close');

  const terminals = new Set([compiled.donePlace.name, compiled.failedPlace.name]);
  const residue: string[] = [];
  for (const p of compiled.net.places) {
    if (!terminals.has(p.name) && marking.tokenCount(p) > 0) {
      residue.push(`${p.name} x${marking.tokenCount(p)}`);
    }
  }
  return { outcome: classify(compiled, marking), residue: residue.sort() };
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** A runner built from a selection function and per-step behaviours, including async ones. */
function runnerWith(
  select: (entryId: string, input: unknown) => unknown,
  behaviour: Record<string, (input: unknown) => Promise<StepOutcome> | StepOutcome> = {},
): StepRunner & { readonly calls: readonly string[] } {
  const calls: string[] = [];
  return {
    calls,
    async run(stepId: string, input: unknown): Promise<StepOutcome> {
      calls.push(stepId);
      const fn = behaviour[stepId];
      return fn !== undefined ? await fn(input) : { status: 'success', output: input };
    },
    async selectBranches(entryId: string, input: unknown): Promise<readonly number[]> {
      return select(entryId, input) as readonly number[];
    },
  };
}

const threeArms = workflow(branch('route', step('email'), step('sms'), step('push')));
const nested = workflow(branch('outer', branch('inner', step('a'), step('b')), step('slow')));

describe('branch gadget strands nothing', () => {
  it('when an arm fails while a sibling is still in flight', async () => {
    // The dangerous ordering for the *fail* side: the error lands while `arrived` is still
    // short of n, so `join.fail` has to wait for the sibling rather than fire early and leave
    // the sibling's marker with no consumer.
    const runner = runnerWith(() => [0, 1], {
      email: () => ({ status: 'failed', error: 'boom' }),
      sms: async (input) => { await sleepMs(30); return { status: 'success', output: input }; },
    });

    const { outcome, residue } = await runAndInspect(compileBranch(threeArms, runner), 'alert');

    expect(outcome).toEqual({ status: 'failed', stepId: 'email', error: 'boom' });
    expect(residue).toEqual([]);
  });

  it('when a sibling succeeds after the failure, so the ok join could race the fail join', async () => {
    const runner = runnerWith(() => [0, 1], {
      email: async (input) => { await sleepMs(30); return { status: 'success', output: input }; },
      sms: () => ({ status: 'failed', error: 'carrier rejected' }),
    });

    const { outcome, residue } = await runAndInspect(compileBranch(threeArms, runner), 'alert');

    // `arm.i.settle.fail` deposits the marker and the error in ONE firing, so there is no
    // reachable marking with `arrived === n` and the error still pending.
    expect(outcome.status).toBe('failed');
    expect(residue).toEqual([]);
  });

  it('when several arms fail at once and one of them is slow', async () => {
    // Exercises the reset arc: `join.fail` consumes one error token and drains the rest,
    // which have no other consumer anywhere in the net.
    const runner = runnerWith(() => [0, 1, 2], {
      email: () => ({ status: 'failed', error: 'e' }),
      sms: () => ({ status: 'failed', error: 's' }),
      push: async () => { await sleepMs(20); return { status: 'failed', error: 'p' }; },
    });

    const { outcome, residue } = await runAndInspect(compileBranch(threeArms, runner), 'alert');

    expect(outcome.status).toBe('failed');
    expect(residue).toEqual([]);
  });

  it('when every arm fails and the branch has a downstream entry that must not run', async () => {
    const chained = workflow(branch('route', step('a'), step('b')), step('after'));
    const runner = runnerWith(() => [0, 1], {
      a: () => ({ status: 'failed', error: 'x' }),
      b: () => ({ status: 'failed', error: 'y' }),
    });

    const { outcome, residue } = await runAndInspect(compileBranch(chained, runner), 'alert');

    expect(outcome.status).toBe('failed');
    expect(runner.calls).not.toContain('after');
    // In particular the downstream entry's input place is empty: a failing branch must not
    // leave a token sitting in front of a step that will never run.
    expect(residue).toEqual([]);
  });

  it('on the zero-arms-selected edge, where every gate takes the skip leg', async () => {
    const runner = runnerWith(() => []);

    const { outcome, residue } = await runAndInspect(compileBranch(threeArms, runner), 'alert');

    // The skip marker is the design's "nothing happened" token. It goes straight into
    // `arrived`, so it is consumed by the same join as everything else.
    expect(runner.calls).toEqual([]);
    expect(outcome).toEqual({ status: 'success', output: {} });
    expect(residue).toEqual([]);
  });

  it('on a mix of skip, success and failure in one branch', async () => {
    const runner = runnerWith(() => [0, 2], {
      email: (input) => ({ status: 'success', output: input }),
      push: () => ({ status: 'failed', error: 'p' }),
    });

    const { outcome, residue } = await runAndInspect(compileBranch(threeArms, runner), 'alert');

    expect(outcome).toEqual({ status: 'failed', stepId: 'push', error: 'p' });
    expect(residue).toEqual([]);
  });

  it('when a nested branch fails entirely while the outer sibling is still in flight', async () => {
    const runner = runnerWith(() => [0, 1], {
      a: () => ({ status: 'failed', error: 'a!' }),
      b: () => ({ status: 'failed', error: 'b!' }),
      slow: async (input) => { await sleepMs(25); return { status: 'success', output: input }; },
    });

    const { outcome, residue } = await runAndInspect(compileBranch(nested, runner), 'alert');

    expect(outcome.status).toBe('failed');
    expect(residue).toEqual([]);
  });

  it("when a nested branch's own decision throws, arming none of its arms", async () => {
    const runner = runnerWith(
      (entryId) => {
        if (entryId === 'inner') throw new Error('condition blew up');
        return [0, 1];
      },
      { slow: async (input) => { await sleepMs(25); return { status: 'success', output: input }; } },
    );

    const { outcome, residue } = await runAndInspect(compileBranch(nested, runner), 'alert');

    // `decide` fails before any gate is armed, so the inner branch contributes only a failure
    // token to the outer arm's local failure place — and the outer join still fires.
    expect(outcome.status).toBe('failed');
    expect(residue).toEqual([]);
  });

  it('on malformed selectBranches answers: duplicates, a Set, a non-array, a non-integer', async () => {
    const cases: ReadonlyArray<readonly [string, unknown, 'success' | 'failed']> = [
      ['duplicate indices', [1, 1, 1], 'success'],
      ['a Set instead of an array', new Set([0, 2]), 'success'],
      ['undefined', undefined, 'failed'],
      ['a non-integer index', [1.5], 'failed'],
      ['an out-of-range index', [7], 'failed'],
      ['a stringly-typed index', ['1'], 'failed'],
    ];

    for (const [label, answer, expected] of cases) {
      const { outcome, residue } = await runAndInspect(
        compileBranch(threeArms, runnerWith(() => answer)),
        'alert',
      );
      expect(outcome.status, label).toBe(expected);
      expect(residue, label).toEqual([]);
    }
  });

  it('under repetition, where a success and a failure settle in the same executor pass', async () => {
    // Both arms resolve without awaiting anything, so their settle transitions land in one
    // pass. If outputs were not applied atomically per firing, `join.ok` would sometimes see
    // n markers with an empty error place and the run would report success.
    const statuses = new Set<string>();
    for (let attempt = 0; attempt < 50; attempt++) {
      const runner = runnerWith(() => [0, 1], {
        email: (input) => ({ status: 'success', output: input }),
        sms: () => ({ status: 'failed', error: 'boom' }),
      });
      const { outcome, residue } = await runAndInspect(compileBranch(threeArms, runner), 'alert');
      statuses.add(outcome.status);
      expect(residue).toEqual([]);
    }
    expect([...statuses]).toEqual(['failed']);
  }, 30_000);

  it('when two instances run through the same branch sub-net at once (KNOWN LIMITATION)', async () => {
    // The join is a *cardinality* join, not a correlated one: `exactly(n, arrived)` takes any
    // n markers, not n markers belonging to one instance. Nothing in the compiler produces
    // this today — `compile` seeds one token and `parallel` gives each arm its own sub-net —
    // but a `foreach` that reused one compiled body at concurrency > 1 would, and the join
    // would then mix the instances' results.
    //
    // This pins the part that is safe (no token strands) and documents the part that is not.
    // If someone adds instance correlation (ν-tokens / a correlated fork-join), the second
    // assertion is the one to delete.
    const runner = runnerWith(() => [0, 1], {
      // Only the first instance's second arm is slow, so instance 2 settles both of its
      // markers while instance 1 still has one outstanding.
      b: async (input) => {
        if (input === 'run1') await sleepMs(40);
        return { status: 'success', output: `b(${String(input)})` };
      },
      a: (input) => ({ status: 'success', output: `a(${String(input)})` }),
    });
    const compiled = compileBranch(workflow(branch('route', step('a'), step('b'))), runner);

    const executor = new PrecompiledNetExecutor(
      compiled.net,
      new Map([[compiled.entryPlace, [
        tokenOf<FlowToken>({ data: 'run1' }),
        tokenOf<FlowToken>({ data: 'run2' }),
      ]]]),
      {},
    );
    const marking = await executor.run(5_000, 'close');

    const terminals = new Set([compiled.donePlace.name, compiled.failedPlace.name]);
    const residue: string[] = [];
    for (const p of compiled.net.places) {
      if (!terminals.has(p.name) && marking.tokenCount(p) > 0) residue.push(p.name);
    }

    // Safe: every token reached a terminal, both instances completed, nothing stranded.
    expect(residue).toEqual([]);
    expect(marking.tokenCount(compiled.donePlace)).toBe(2);

    // Not safe: the first record out is not instance 1's. It joined one marker from each
    // instance — both for arm `a` — so arm `b` is missing from it entirely. A correlated join
    // would have produced `{ a: 'a(runX)', b: 'b(runX)' }` for one consistent X.
    const first = (marking.peekFirst(compiled.donePlace) as { value: FlowToken } | null)?.value
      .data as Record<string, string> | undefined;
    const correlated =
      first !== undefined &&
      Object.keys(first).length === 2 &&
      ['run1', 'run2'].some((run) => first['a'] === `a(${run})` && first['b'] === `b(${run})`);
    expect(correlated, `joined record was ${JSON.stringify(first)}`).toBe(false);
  }, 20_000);
});

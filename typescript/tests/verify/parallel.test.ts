import { describe, expect, it } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { parallelGadget } from '../../src/compiler/gadgets/parallel.js';
import { describeReport, verifyWorkflow } from '../../src/verify/index.js';
import { inertRunner } from '../fixtures/runner.js';
import type { EntryDescription, WorkflowDescription } from '../../src/compiler/types.js';

/**
 * `parallel` is registered explicitly: `defaultGadgets()` still maps the kind to
 * `unimplemented('parallel')`, so without this the compile throws rather than proving anything.
 */
const verifyShape = (description: WorkflowDescription) =>
  verifyWorkflow(compile(description, { runner: inertRunner, gadgets: { parallel: parallelGadget } }), {
    timeoutMs: 120_000,
  });

const step = (id: string): EntryDescription => ({ kind: 'step', id });
const sleep = (id: string, durationMs: number): EntryDescription => ({ kind: 'sleep', id, durationMs });
const fan = (id: string, arms: readonly EntryDescription[]): EntryDescription =>
  ({ kind: 'parallel', id, arms });

/** `[...arms]` nested `depth` deep: each level pairs a plain step with the level below it. */
function nest(depth: number): EntryDescription {
  let inner: EntryDescription = step('leaf');
  for (let d = 0; d < depth; d++) inner = fan(`p${d}`, [step(`s${d}`), inner]);
  return inner;
}

/**
 * Every shape here must come back `proven`, not merely un-violated.
 *
 * The two properties are complementary, not redundant ([VER-013]): `deadlockFree` fails on a
 * quiescent marking holding a token *outside* the declared sinks, which is exactly the stranded
 * arm a fan-in gets wrong, and `terminatesAtSink` fails on a quiescent marking with no sink
 * marked at all. Together they say the join never leaves a sibling behind *and* always reaches
 * a terminal.
 */
const shapes: ReadonlyArray<readonly [string, WorkflowDescription]> = [
  ['one arm', { id: 'w', entries: [fan('fan', [step('only')])] }],
  ['two arms', { id: 'w', entries: [fan('fan', [step('a'), step('b')])] }],
  [
    'three arms then a successor',
    { id: 'w', entries: [fan('fan', [step('a'), step('b'), step('c')]), step('after')] },
  ],
  [
    'five arms',
    { id: 'w', entries: [fan('fan', ['a', 'b', 'c', 'd', 'e'].map(step))] },
  ],
  [
    'a parallel between two steps',
    { id: 'w', entries: [step('before'), fan('fan', [step('a'), step('b')]), step('after')] },
  ],
  [
    'two parallels in series',
    { id: 'w', entries: [fan('f1', [step('a'), step('b')]), fan('f2', [step('c'), step('d')])] },
  ],
  [
    'two arms that are the same step id',
    { id: 'w', entries: [fan('fan', [step('a'), step('a')])] },
  ],
  // `sleepGadget` never writes to its failure place, so in these two shapes `arm-err` has
  // *no producing transition at all* and `collect-err`/`join-fail` are structurally dead. The
  // proof has to close anyway: a join that only works because some arm might fail is a join
  // whose liveness argument is accidental.
  ['an arm that can never fail', { id: 'w', entries: [fan('fan', [step('a'), sleep('wait', 5)])] }],
  [
    'no arm that can ever fail',
    { id: 'w', entries: [fan('fan', [sleep('s1', 5), sleep('s2', 10)])] },
  ],
  [
    'a parallel nested in a parallel arm',
    { id: 'w', entries: [fan('outer', [step('a'), fan('inner', [step('b'), step('c')])])] },
  ],
  ['three levels of nesting', { id: 'w', entries: [nest(3)] }],
  // The deepest shape that still closes quickly. Measured separately: nesting stays `proven`
  // via enumeration to depth 5 (~1.3s), and a flat fan stays `proven` to 9 arms, falling over
  // to the SMT route at 8 (~7s per property). Neither limit is asserted here, because a
  // timing-sensitive assertion is a flaky test, but both were checked.
  ['four levels of nesting', { id: 'w', entries: [nest(4)] }],
];

describe('compiled parallel, proved', () => {
  for (const [shape, description] of shapes) {
    it(`is deadlock-free and terminates at a declared sink: ${shape}`, async () => {
      const reports = await verifyShape(description);

      // `proven` explicitly. `isViolated()` is false for `unknown` too, so asserting "not
      // violated" would silently pass on a query that timed out and the test would be vacuous
      // from that day on. An `unknown` here is a finding, not a pass.
      for (const report of reports) {
        expect(report.result.verdict.type, describeReport(report)).toBe('proven');
      }
      expect(reports.map((r) => r.property)).toEqual(['deadlockFree', 'terminatesAtSink']);
    }, 180_000);
  }

  /**
   * Non-vacuity. The properties above are only worth asserting if they can fail, and the
   * shape they are meant to reject is the naive fan-in: arms routed straight to the workflow's
   * failure terminal instead of to the gadget-local `arm-err`, so a failing arm ends the run
   * while its siblings are still in flight and their settlements sit in `arrived` forever.
   *
   * This re-emits the real gadget's arms with `ctx.failed` in place of the local sink, changing
   * one argument and nothing else, and asserts the verdict flips to violated.
   */
  it('rejects the naive fan-in that routes arm failures to the workflow terminal', async () => {
    const naive: typeof parallelGadget = (entry, next, ctx) =>
      parallelGadget(entry, next, {
        ...ctx,
        // Drop the caller's gadget-local override: every child now fails straight to the
        // workflow terminal, which is the whole mistake.
        emitNested: (child, path, childNext) => ctx.emitNested(child, path, childNext, ctx.failed),
      });

    const description: WorkflowDescription = {
      id: 'w',
      entries: [fan('fan', [step('a'), step('b')])],
    };
    const reports = await verifyWorkflow(
      compile(description, { runner: inertRunner, gadgets: { parallel: naive } }),
      { timeoutMs: 120_000 },
    );

    const deadlockFree = reports[0]!;
    expect(deadlockFree.property).toBe('deadlockFree');
    // Not `not.toBe('proven')` — `unknown` would satisfy that and prove nothing about the
    // query's discriminating power.
    expect(deadlockFree.result.verdict.type, describeReport(deadlockFree)).toBe('violated');
  }, 180_000);
});

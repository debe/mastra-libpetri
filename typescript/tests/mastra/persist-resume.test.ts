import type { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import type { WorkflowRunStatus } from '@mastra/core/workflows';
import type { RunOutcome, RunReport } from '../../src/engine/kernel.js';
import type { StepFlowEntry } from '@mastra/core/workflows';
import type { StepRecord, SuspendToken } from '../../src/compiler/types.js';
import { PetriExecutionEngine } from '../../src/mastra/engine.js';
import { suspendTracingContext } from '../../src/mastra/host.js';
import { buildRunSnapshot, persistRun, suspendedPathsOf, type PersistContext, type PersistGuard } from '../../src/mastra/persist.js';
import { formatWorkflowResult, stepExecutionPath, type FormattedResult, type ResumedFrom } from '../../src/mastra/result.js';

/**
 * The snapshot and result of a **resumed** run ([ADR 0007]), built directly from a `RunReport` —
 * the unit side of `engine-resume.test.ts`, which runs the same rules through Mastra's own `Run`
 * against the default engine. Each rule cites the default engine line it reproduces.
 */

const graph = [
  { type: 'step', step: { id: 'a' } },
  { type: 'parallel', steps: [{ type: 'step', step: { id: 'p0' } }, { type: 'step', step: { id: 'p1' } }] },
  { type: 'step', step: { id: 'c' } },
];

/** The stored context `Run` hands a resume: Mastra's `StepResult`s verbatim, `input` first. */
const stored: Record<string, unknown> = {
  input: { n: 1 },
  a: { payload: { n: 1 }, startedAt: 1, status: 'success', output: { n: 2 }, endedAt: 2 },
  p0: { payload: { n: 2 }, startedAt: 3, status: 'suspended', suspendPayload: { ask: 'p0' }, suspendedAt: 4 },
  p1: { payload: { n: 2 }, startedAt: 3, status: 'suspended', suspendPayload: { ask: 'p1' }, suspendedAt: 5 },
  // A key the engine has no record for survives verbatim.
  odd: { status: 'skipped', payload: {}, startedAt: 0, endedAt: 0 },
};
const resume: ResumedFrom = { index: 1, carriedPath: ['a'], context: stored };

const recordP0: StepRecord = { status: 'success', payload: { n: 2 }, output: { n: 9 }, startedAt: 3, endedAt: 8 };
const recordC: StepRecord = { status: 'success', payload: { p0: { n: 9 } }, output: { n: 90 }, startedAt: 9, endedAt: 10 };

const base = {
  workflowId: 'w',
  runId: 'r',
  input: { n: 1 },
  state: { s: 1 },
  serializedStepGraph: graph,
  requestContext: new RequestContext(),
  resume,
};

const formatted = (status: FormattedResult['status'], path: string[]): FormattedResult =>
  ({ status, steps: {}, input: { n: 1 }, stepExecutionPath: path }) as FormattedResult;

const terminal = (
  outcome: RunOutcome,
  records: ReadonlyMap<string, StepRecord>,
  extra: Partial<Extract<PersistContext, { phase: 'terminal' }>> = {},
): Extract<PersistContext, { phase: 'terminal' }> => ({
  ...base,
  phase: 'terminal',
  report: { outcome, stepResults: records } satisfies RunReport,
  result: formatted(outcome.status === 'stranded' ? 'failed' : outcome.status, ['a', 'c']),
  ...extra,
});

/** An engine with a registered Mastra whose store records what it is asked to write. */
function recordingEngine(): { engine: PetriExecutionEngine; writes: { snapshot: { status: string } }[] } {
  const writes: { snapshot: { status: string } }[] = [];
  const engine = new PetriExecutionEngine();
  const store = { persistWorkflowSnapshot: async (args: { snapshot: { status: string } }) => void writes.push(args) };
  engine.mastra = { getStorage: () => ({ getStore: async () => store }) } as unknown as Mastra;
  return { engine, writes };
}

function guardOf(initial: Record<string, WorkflowRunStatus> = {}): PersistGuard & { map: Map<string, WorkflowRunStatus> } {
  const map = new Map(Object.entries(initial));
  return { map, lastPersisted: (id) => map.get(id), persisted: (id, s) => void map.set(id, s) };
}

describe('the resume-start write', () => {
  const start: PersistContext = { ...base, phase: 'resume-start', activePath: [1, 0] };

  it('is running, carries the stored context whole and in order, clears suspendedPaths and resumeLabels, continues the path', () => {
    const s = buildRunSnapshot(start, 7);
    // Key for key: `persistStepUpdate` writes `tracingContext` on every write, `undefined` on a
    // running one that passes none (handlers/entry.ts:209-227).
    expect(s).toStrictEqual({
      runId: 'r',
      status: 'running',
      value: { s: 1 },
      context: stored,
      serializedStepGraph: graph,
      activePaths: [1, 0],
      stepExecutionPath: ['a'],
      activeStepsPath: {},
      waitingPaths: {},
      suspendedPaths: {},
      resumeLabels: {},
      requestContext: {},
      result: undefined,
      error: undefined,
      timestamp: 7,
      tracingContext: undefined,
    });
    expect(Object.keys(s.context)).toEqual(['input', 'a', 'p0', 'p1', 'odd']);
  });

  it('changes what Run\'s claim release compares (workflow.ts:4786-4799): the stored suspendedPaths are gone', () => {
    // engineNeverStarted needs the claimed suspendedPaths still present; this write removes them.
    expect(Object.keys(buildRunSnapshot(start, 0).suspendedPaths)).toEqual([]);
  });
});

describe('the overwrite guard (handlers/entry.ts:195-205)', () => {
  const start: PersistContext = { ...base, phase: 'resume-start', activePath: [1] };

  it.each(['suspended', 'paused'] as const)('skips a running write while the run was last written %s', async (last) => {
    const { engine, writes } = recordingEngine();
    const guard = guardOf({ r: last });
    await persistRun(engine, start, guard);
    expect(writes).toEqual([]);
    expect(guard.map.get('r')).toBe(last);
  });

  it.each([undefined, 'running', 'success', 'failed'] as const)('writes a running write when the last write was %s, and records it', async (last) => {
    const { engine, writes } = recordingEngine();
    const guard = guardOf(last === undefined ? {} : { r: last });
    await persistRun(engine, start, guard);
    expect(writes.map((w) => w.snapshot.status)).toEqual(['running']);
    expect(guard.map.get('r')).toBe('running');
  });

  it('never skips a terminal write, and records its status', async () => {
    const { engine, writes } = recordingEngine();
    const guard = guardOf({ r: 'suspended' });
    await persistRun(engine, terminal({ status: 'success', output: { n: 90 } }, new Map([['c', recordC]])), guard);
    expect(writes.map((w) => w.snapshot.status)).toEqual(['success']);
    expect(guard.map.get('r')).toBe('success');
  });

  it('a write the predicate declines is not recorded, as the default engine records only what passed it', async () => {
    const { engine, writes } = recordingEngine();
    engine.options = { ...engine.options, shouldPersistSnapshot: () => false };
    const guard = guardOf();
    await persistRun(engine, start, guard);
    expect(writes).toEqual([]);
    expect(guard.map.has('r')).toBe(false);
  });
});

describe('the terminal write of a resumed run', () => {
  it('carries the stored context with this segment\'s records over it: stored keys keep their place, new ones append', () => {
    const records = new Map<string, StepRecord>([
      ['p0', recordP0],
      ['c', recordC],
    ]);
    const s = buildRunSnapshot(terminal({ status: 'success', output: { n: 90 } }, records), 0);
    expect(Object.keys(s.context)).toEqual(['input', 'a', 'p0', 'p1', 'odd', 'c']);
    expect(s.context['a']).toEqual(stored['a']);
    expect(s.context['odd']).toEqual(stored['odd']);
    expect(s.context['p0']).toMatchObject({ status: 'success', output: { n: 9 } });
    expect(s).toMatchObject({ status: 'success', activePaths: [2], stepExecutionPath: ['a', 'c'], suspendedPaths: {} });
  });

  it('stored entries with no record — running, skipped — keep their stored key and value, in the snapshot context and in the result\'s steps', () => {
    // A `running` entry is what a stored run holds for a step that had started when another
    // suspended (a parallel sibling mid-flight); `skipped`, an untaken branch arm. The engine has no
    // StepRecord for either, so neither may be dropped, rewritten or moved.
    const running = { status: 'running', payload: { n: 2 }, startedAt: 6 };
    const skipped = { status: 'skipped', payload: {}, startedAt: 0, endedAt: 0 };
    const context: Record<string, unknown> = {
      input: { n: 1 },
      a: stored['a'],
      p0: stored['p0'],
      mid: running,
      p1: stored['p1'],
      odd: skipped,
    };
    const from: ResumedFrom = { index: 1, carriedPath: ['a'], context };
    const records = new Map<string, StepRecord>([
      ['p0', recordP0],
      ['c', recordC],
    ]);
    const s = buildRunSnapshot({ ...terminal({ status: 'success', output: { n: 90 } }, records), resume: from }, 0);
    expect(Object.keys(s.context)).toStrictEqual(['input', 'a', 'p0', 'mid', 'p1', 'odd', 'c']);
    expect(s.context['mid']).toStrictEqual(running);
    expect(s.context['odd']).toStrictEqual(skipped);

    const result = formatWorkflowResult({
      report: { outcome: { status: 'success', output: { n: 90 } }, stepResults: records },
      input: { n: 1 },
      state: {},
      graph: { steps: graph as unknown as StepFlowEntry[] },
      resume: from,
    });
    expect(Object.keys(result.steps)).toStrictEqual(['input', 'a', 'p0', 'mid', 'p1', 'odd', 'c']);
    expect(result.steps['mid']).toStrictEqual(running);
    expect(result.steps['odd']).toStrictEqual(skipped);
  });

  it('a suspended run lists the reported suspension and every pending one, by step id (handlers/entry.ts:100-107)', () => {
    const pending: SuspendToken[] = [{ stepId: 'p1', path: [1, 1], payload: { ask: 'p1' }, suspendedAt: 5 }];
    const outcome: RunOutcome = { status: 'suspended', stepId: 'p0', path: [1, 0], payload: { ask: 'p0' }, pending };
    const s = buildRunSnapshot(terminal(outcome, new Map()), 0);
    expect(s).toMatchObject({ status: 'suspended', activePaths: [1], suspendedPaths: { p0: [1, 0], p1: [1, 1] }, tracingContext: {} });
  });

  it('on a clash of ids the last suspension in time wins — the token\'s suspendedAt, else the record\'s', () => {
    const outcome = (reportedAt: number | undefined, pendingAt: number | undefined): Extract<RunOutcome, { status: 'suspended' }> => ({
      status: 'suspended',
      stepId: 'x',
      path: [0],
      payload: {},
      ...(reportedAt === undefined ? {} : { suspendedAt: reportedAt }),
      pending: [{ stepId: 'x', path: [3], payload: {}, ...(pendingAt === undefined ? {} : { suspendedAt: pendingAt }) }],
    });
    const none = new Map<string, StepRecord>();
    expect(suspendedPathsOf(outcome(1, 2), none)).toEqual({ x: [3] });
    expect(suspendedPathsOf(outcome(2, 1), none)).toEqual({ x: [0] });
    // Equal times: the first listed — the reported suspension — stands.
    expect(suspendedPathsOf(outcome(2, 2), none)).toEqual({ x: [0] });
    // No stamp on the pending token: the record's suspendedAt stands in for it.
    const record: StepRecord = { status: 'suspended', payload: {}, suspendPayload: {}, startedAt: 0, suspendedAt: 9 };
    expect(suspendedPathsOf(outcome(5, undefined), new Map([['x', record]]))).toEqual({ x: [3] });
  });

  it('a suspended run with a span persists its ids (default.ts:945-950); any other status writes {}', () => {
    const ids = { traceId: 't', spanId: 's', parentSpanId: 'p' };
    const suspended: RunOutcome = { status: 'suspended', stepId: 'c', path: [2], payload: {} };
    expect(buildRunSnapshot(terminal(suspended, new Map(), { suspendTracing: ids }), 0).tracingContext).toEqual(ids);
    expect(buildRunSnapshot(terminal(suspended, new Map()), 0).tracingContext).toEqual({});
    const failed: RunOutcome = { status: 'failed', stepId: 'c', path: [2], error: new Error('x') };
    expect(buildRunSnapshot(terminal(failed, new Map(), { suspendTracing: ids }), 0).tracingContext).toEqual({});
    // A run that ran to the end passes none (default.ts:1081-1093): the key is written, undefined.
    const done = buildRunSnapshot(terminal({ status: 'success', output: 1 }, new Map(), { suspendTracing: ids }), 0);
    expect(Object.hasOwn(done, 'tracingContext')).toBe(true);
    expect(done.tracingContext).toBeUndefined();
  });

  describe('a cancel, positioned on the resumed segment (default.ts:811-835)', () => {
    type Canceled = Extract<RunOutcome, { status: 'canceled' }>;
    const canceled = (path: number[], started: boolean): Canceled => ({ status: 'canceled', origin: { stepId: 'x', path }, started });

    it('not started at the resume site\'s gate — an entry\'s own, or a block\'s re-enter sweep, both at [i]: the loop-top check at resumePath[0], tracingContext undefined', () => {
      const s = buildRunSnapshot(terminal(canceled([1], false), new Map()), 0);
      expect(s.activePaths).toEqual([1]);
      // The loop-top write passes no tracing context (default.ts:814-835); the key is still written.
      expect(Object.hasOwn(s, 'tracingContext')).toBe(true);
      expect(s.tracingContext).toBeUndefined();
    });

    it('not started below it — the resumed arm\'s own gate, after re-entry: inside a begun entry, tracingContext {}', () => {
      const s = buildRunSnapshot(terminal(canceled([1, 0], false), new Map()), 0);
      expect(s).toMatchObject({ activePaths: [1], tracingContext: {} });
    });

    it('not started at a later entry\'s gate: the entry before it, which this segment ran', () => {
      const s = buildRunSnapshot(terminal(canceled([2], false), new Map()), 0);
      expect(s).toMatchObject({ activePaths: [1], tracingContext: {} });
    });

    it('started inside the resumed entry: that entry, tracingContext {}', () => {
      const s = buildRunSnapshot(terminal(canceled([1, 0], true), new Map()), 0);
      expect(s).toMatchObject({ activePaths: [1], tracingContext: {} });
    });
  });
});

describe('stepExecutionPath of a resumed run (handlers/entry.ts:306-309)', () => {
  const entries = [
    { type: 'step', step: { id: 'a' } },
    { type: 'step', step: { id: 'g' } },
    { type: 'sleep', id: 'nap', duration: 1 },
    { type: 'step', step: { id: 'c' } },
  ] as unknown as StepFlowEntry[];
  const from = { index: 1, carried: ['a', 'g'] };

  it('continues the carried path without pushing the resumed entry again', () => {
    expect(stepExecutionPath(entries, { status: 'success', output: 1 }, from)).toEqual(['a', 'g', 'nap', 'c']);
  });

  it('a failure after the resumed entry pushes up to the failing one', () => {
    expect(stepExecutionPath(entries, { status: 'failed', stepId: 'nap', path: [2], error: 1 }, from)).toEqual(['a', 'g', 'nap']);
  });

  it('the resumed entry suspending again pushes nothing', () => {
    expect(stepExecutionPath(entries, { status: 'suspended', stepId: 'g', path: [1], payload: {} }, from)).toEqual(['a', 'g']);
  });

  it('a cancel swept at the resume site pushes nothing', () => {
    expect(stepExecutionPath(entries, { status: 'canceled', origin: { stepId: 'g', path: [1] }, started: false }, from)).toEqual(['a', 'g']);
  });

  it('a fresh run is unchanged', () => {
    expect(stepExecutionPath(entries, { status: 'success', output: 1 })).toEqual(['a', 'g', 'nap', 'c']);
  });
});

describe('formatWorkflowResult of a resumed run', () => {
  it('steps are the stored context with this segment over it; suspended lists every record still suspended (default.ts:630-643)', () => {
    const records = new Map<string, StepRecord>([
      ['p0', { status: 'suspended', payload: { n: 2 }, suspendPayload: { ask: 'again' }, startedAt: 3, suspendedAt: 11 }],
    ]);
    const outcome: RunOutcome = { status: 'suspended', stepId: 'p0', path: [1, 0], payload: { ask: 'again' } };
    const result = formatWorkflowResult({
      report: { outcome, stepResults: records },
      input: { n: 1 },
      state: {},
      graph: { steps: graph as unknown as StepFlowEntry[] },
      resume,
    });
    expect(result).toMatchObject({
      status: 'suspended',
      suspended: [['p0'], ['p1']],
      suspendPayload: { p0: { ask: 'again' }, p1: { ask: 'p1' } },
      stepExecutionPath: ['a'],
    });
    expect(Object.keys(result.steps)).toEqual(['input', 'a', 'p0', 'p1', 'odd']);
  });
});

describe('suspendTracingContext — resolveExportedSpanId, structurally (observability/utils.ts:117-122)', () => {
  it('the exported id when the span has the method, its own id when it predates it', () => {
    expect(suspendTracingContext({ traceId: 't', id: 'own', getExportedSpanId: () => 'exp', getParentSpanId: () => 'par' })).toEqual({
      traceId: 't',
      spanId: 'exp',
      parentSpanId: 'par',
    });
    expect(suspendTracingContext({ traceId: 't', id: 'own', getParentSpanId: () => undefined })).toEqual({
      traceId: 't',
      spanId: 'own',
      parentSpanId: undefined,
    });
  });

  it('an exporter that finds nothing exportable leaves spanId undefined rather than the raw id', () => {
    expect(suspendTracingContext({ traceId: 't', id: 'own', getExportedSpanId: () => undefined }).spanId).toBeUndefined();
  });
});

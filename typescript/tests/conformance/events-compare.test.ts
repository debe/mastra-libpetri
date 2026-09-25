import { describe, expect, it } from 'vitest';
import {
  compareEvents,
  compareObservations,
  compareResume,
  eventGroup,
  eventModel,
  eventPattern,
  EVENT_EXCLUDED_PATHS,
  EVENT_MASKED_PATHS,
  formatDifferentialReport,
  formatVerdicts,
  groupEvents,
  isEventPath,
  RESUME_EVENT_EXCLUDED_PATHS,
  RUN_EVENTS,
  type CompareOptions,
  type Execution,
  type Observation,
  type PhaseObservation,
  type ResumeObservation,
} from '../../src/conformance/differential.js';

/**
 * The events dimension of the differential harness, pure: grouping by step, in-order comparison
 * within a group, the exclusions, attribution and gating. Event shapes are Mastra's
 * (`default.ts:222-233`, `handlers/step.ts:655-690`, `handlers/entry.ts:586-800`,
 * `handlers/control-flow.ts:1015-1480`, `tools/stream.ts:46-72`, `workflow.ts:4083-4105,4323-4346`).
 */

const DEFAULT: readonly Execution[] = [{ engine: 'default', workflowId: 'w' }];
const PETRI: readonly Execution[] = [{ engine: 'petri', workflowId: 'w' }];
const ora = (events: readonly unknown[] | undefined, result: unknown = { status: 'success' }): Observation => ({
  kind: 'resolved',
  result,
  trace: [],
  executions: DEFAULT,
  ...(events === undefined ? {} : { events }),
});
const cand = (events: readonly unknown[] | undefined, result: unknown = { status: 'success' }): Observation => ({
  kind: 'resolved',
  result,
  trace: [],
  executions: PETRI,
  ...(events === undefined ? {} : { events }),
});

let call = 0;
const U = () => `0b6f3a6e-1c2d-4e5f-8a9b-${String(++call).padStart(12, '0')}`;

/** A step's lifecycle as Mastra's default engine publishes it: start, result, finish. */
function lifecycle(id: string, output: unknown, stamp = 1000): unknown[] {
  const stepCallId = U();
  return [
    { type: 'workflow-step-start', payload: { id, stepCallId, payload: { n: 1 }, startedAt: stamp, status: 'running' } },
    { type: 'workflow-step-result', payload: { id, stepCallId, payload: { n: 1 }, startedAt: stamp, status: 'success', output, endedAt: stamp + 5 } },
    { type: 'workflow-step-finish', payload: { id, stepCallId, metadata: {} } },
  ];
}

const types = (xs: readonly unknown[]) => xs.map((x) => (x as { type: string }).type);

describe('grouping', () => {
  it('groups by payload.id; run-level events without an id under $run', () => {
    expect(eventGroup({ type: 'workflow-step-start', payload: { id: 'a' } })).toBe('a');
    expect(eventGroup({ type: 'workflow-paused', payload: {} })).toBe(RUN_EVENTS);
    expect(eventGroup({ type: 'workflow-start', runId: 'r', from: 'WORKFLOW', payload: { workflowId: 'w' } })).toBe(RUN_EVENTS);
    expect(eventGroup('not an event')).toBe(RUN_EVENTS);
  });

  it("a stream chunk's stepName beside its id does not move it: the id wins", () => {
    expect(eventGroup({ type: 'workflow-step-result', payload: { stepName: 'a', id: 'a' } })).toBe('a');
    // A stream chunk for an id-less event carries stepName undefined: still the run's.
    expect(eventGroup({ type: 'workflow-canceled', payload: { stepName: undefined } })).toBe(RUN_EVENTS);
  });

  it("writer chunks form a group per writing step; custom data-* chunks a group per type", () => {
    const chunk = { type: 'workflow-step-output', runId: 'r', from: 'USER', payload: { output: { p: 1 }, runId: 'r', stepName: 'w' } };
    expect(eventGroup(chunk)).toBe('w@output');
    expect(eventGroup({ type: 'data-progress', data: { n: 1 } })).toBe('$data-progress');
  });

  it("a nested workflow's prefixed ids are one segment, written with /", () => {
    const g = groupEvents([...lifecycle('inner.i1', 1), ...lifecycle('inner', 2)]);
    expect(Object.keys(g).sort()).toEqual(['inner', 'inner/i1']);
    expect(types(g['inner/i1']!)).toEqual(['workflow-step-start', 'workflow-step-result', 'workflow-step-finish']);
  });

  it('UUIDs in a group name are ordinals, continuing the map a result was normalised with', () => {
    const sleep = `sleep_${U()}`;
    const uuids = new Map<string, number>();
    uuids.set(sleep.slice('sleep_'.length), 0);
    const g = groupEvents([{ type: 'workflow-step-waiting', payload: { id: sleep, status: 'waiting' } }], uuids);
    expect(Object.keys(g)).toEqual(['sleep_<uuid#0>']);
  });
});

describe('order', () => {
  it('interleaving across groups the oracle overlaps does not matter', () => {
    const a = lifecycle('a', 1);
    const b = lifecycle('b', 2);
    const overlapped = [a[0], b[0], a[1], a[2], b[1], b[2]];
    const interleaved = [a[0], b[0], b[1], a[1], b[2], a[2]];
    expect(compareEvents(overlapped, interleaved)).toEqual([]);
    expect(compareObservations('x', ora(overlapped), cand(interleaved), []).verdict).toBe('pass');
  });

  it('order within a group does, field by field', () => {
    const [s, r, f] = lifecycle('a', 1);
    const d = compareEvents([s, r, f], [r, s, f]);
    expect(d.map((x) => x.path)).toContain('events.a.0.type');
    expect(d.map((x) => x.path)).toContain('events.a.1.type');
    expect(compareObservations('x', ora([s, r, f]), cand([r, s, f]), []).verdict).toBe('fail');
  });

  it('a group on one side only is one difference, its values the event types', () => {
    const d = compareEvents(lifecycle('a', 1), []);
    expect(d).toEqual([{ path: 'events.a', oracle: ['workflow-step-start', 'workflow-step-result', 'workflow-step-finish'], candidate: '<absent>' }]);
  });

  it("a length mismatch names each side's type sequence; the common prefix is still compared", () => {
    const [s, r, f] = lifecycle('a', 1);
    const d = compareEvents([s, r, f], [s, r]);
    expect(d).toEqual([
      { path: 'events.a.length', oracle: ['workflow-step-start', 'workflow-step-result', 'workflow-step-finish'], candidate: ['workflow-step-start', 'workflow-step-result'] },
    ]);
  });

  it('a payload difference is reported at its field', () => {
    const d = compareEvents(lifecycle('a', { n: 1 }), lifecycle('a', { n: 2 }));
    expect(d.map((x) => x.path)).toEqual(['events.a.1.payload.output.n']);
  });
});

describe('exclusions', () => {
  it('clock stamp values, step call id values and run ids are not compared where Mastra writes them', () => {
    expect(compareEvents(lifecycle('a', 1, 1000), lifecycle('a', 1, 9999))).toEqual([]);
    const chunk = (runId: string) => ({ type: 'workflow-step-output', runId, from: 'USER', payload: { output: { p: 1 }, runId, stepName: 'w' } });
    expect(compareEvents([chunk('r1')], [chunk('r2')])).toEqual([]);
    const waiting = (startedAt: number) => ({ type: 'workflow-step-waiting', payload: { id: 's', payload: { n: 1 }, startedAt, status: 'waiting' } });
    expect(compareEvents([waiting(1)], [waiting(2)])).toEqual([]);
  });

  it('the same keys inside user data are compared', () => {
    const out = (startedAt: number, runId: string) => ({ type: 'workflow-step-result', payload: { id: 'a', status: 'success', output: { startedAt, runId } } });
    expect(compareEvents([out(1, 'x')], [out(2, 'y')]).map((d) => d.path)).toEqual(['events.a.0.payload.output.runId', 'events.a.0.payload.output.startedAt']);
    const writer = (stepCallId: string) => ({ type: 'workflow-step-output', payload: { output: { stepCallId }, stepName: 'w' } });
    expect(compareEvents([writer('p')], [writer('q')]).map((d) => d.path)).toEqual(['events.w@output.0.payload.output.stepCallId']);
  });

  it("a foreach aggregate's per-item clock stamps are excluded; its items' outputs are not", () => {
    const failed = (startedAt: number, output: number) => ({
      type: 'workflow-step-result',
      payload: { id: 'item', status: 'failed', suspendPayload: { __workflow_meta: { foreachOutput: [{ status: 'success', output, startedAt, endedAt: startedAt + 1 }] } } },
    });
    expect(compareEvents([failed(1, 10)], [failed(7, 10)])).toEqual([]);
    expect(compareEvents([failed(1, 10)], [failed(7, 20)]).map((d) => d.path)).toEqual(['events.item.0.payload.suspendPayload.__workflow_meta.foreachOutput.0.output']);
  });

  it('clock keys are masked, not excluded: a stamp on one side only, or of another kind, is a difference', () => {
    const [s, r, f] = lifecycle('a', 1);
    const bare = (e: unknown, key: string) => {
      const { [key]: _, ...payload } = (e as { payload: Record<string, unknown> }).payload;
      return { ...(e as object), payload };
    };
    // The candidate's -result lacks endedAt; its -start lacks startedAt.
    expect(compareEvents([s, r, f], [s, bare(r, 'endedAt'), f])).toEqual([{ path: 'events.a.1.payload.endedAt', oracle: '<clock:number>', candidate: '<absent>' }]);
    expect(compareEvents([s, r, f], [bare(s, 'startedAt'), r, f]).map((d) => d.path)).toEqual(['events.a.0.payload.startedAt']);
    // Present on the candidate only.
    const suspended = (extra: Record<string, unknown>) => ({ type: 'workflow-step-suspended', payload: { id: 'g', status: 'suspended', ...extra } });
    expect(compareEvents([suspended({})], [suspended({ suspendedAt: 5 })]).map((d) => d.path)).toEqual(['events.g.0.payload.suspendedAt']);
    // Another kind: a Date where Mastra writes a number.
    expect(compareEvents([suspended({ resumedAt: 5 })], [suspended({ resumedAt: new Date(5) })])).toEqual([
      { path: 'events.g.0.payload.resumedAt', oracle: '<clock:number>', candidate: '<clock:Date>' },
    ]);
    // A key holding undefined is not an absent key.
    expect(compareEvents([suspended({ pausedAt: undefined })], [suspended({})]).map((d) => d.path)).toEqual(['events.g.0.payload.pausedAt']);
    // And at a foreach aggregate's per-item entries.
    const failed = (entry: Record<string, unknown>) => ({
      type: 'workflow-step-result',
      payload: { id: 'item', status: 'failed', suspendPayload: { __workflow_meta: { foreachOutput: [{ status: 'success', output: 1, ...entry }] } } },
    });
    expect(compareEvents([failed({ startedAt: 1, endedAt: 2 })], [failed({ startedAt: 9 })]).map((d) => d.path)).toEqual([
      'events.item.0.payload.suspendPayload.__workflow_meta.foreachOutput.0.endedAt',
    ]);
    expect(EVENT_MASKED_PATHS.some((p) => p.endsWith('stepCallId'))).toBe(false);
    expect(EVENT_EXCLUDED_PATHS.some((p) => /startedAt|endedAt|suspendedAt|resumedAt|pausedAt|stepCallId/.test(p))).toBe(false);
  });

  it("the suspend stamp's run id is excluded on a fresh run and compared on a resume", () => {
    const suspended = (runId: string) => ({ type: 'workflow-step-suspended', payload: { id: 'inner', status: 'suspended', suspendPayload: { __workflow_meta: { runId, path: ['inner', 'g'] } } } });
    expect(compareEvents([suspended('r1')], [suspended('r2')])).toEqual([]);
    expect(compareEvents([suspended('r1')], [suspended('r2')], { excluded: RESUME_EVENT_EXCLUDED_PATHS }).map((d) => d.path)).toEqual([
      'events.inner.0.payload.suspendPayload.__workflow_meta.runId',
    ]);
    expect(RESUME_EVENT_EXCLUDED_PATHS.length).toBe(EVENT_EXCLUDED_PATHS.length - 1);
  });

  it('a step call id is numbered within its group: presence is compared', () => {
    // Mastra's foreach -start carries no stepCallId (handlers/control-flow.ts:1015-1024).
    const foreachStart = (extra: Record<string, unknown>) => ({ type: 'workflow-step-start', payload: { id: 'item', status: 'running', ...extra } });
    expect(compareEvents([foreachStart({})], [foreachStart({ stepCallId: U() })])).toEqual([
      { path: 'events.item.0.payload.stepCallId', oracle: '<absent>', candidate: '<call#0>' },
    ]);
    const g = groupEvents(lifecycle('a', 1));
    expect(g['a']!.map((e) => (e as { payload: { stepCallId: string } }).payload.stepCallId)).toEqual(['<call#0>', '<call#0>', '<call#0>']);
  });

  it("a step call id that does not correlate start, result and finish is a difference, and so is one reused across runs", () => {
    const [s, r, f] = lifecycle('a', 1);
    const recall = (e: unknown, stepCallId: string) => ({ ...(e as object), payload: { ...(e as { payload: object }).payload, stepCallId } });
    const other = U();
    const d = compareEvents([s, r, f], [s, recall(r, other), recall(f, other)]);
    expect(d).toEqual([
      { path: 'events.a.1.payload.stepCallId', oracle: '<call#0>', candidate: '<call#1>' },
      { path: 'events.a.2.payload.stepCallId', oracle: '<call#0>', candidate: '<call#1>' },
      { path: 'events.$calls.a#0', oracle: '1 step call id(s)', candidate: '2 step call id(s)' },
    ]);
    expect(eventModel([s, recall(r, other), f]).calls.get('a#0')).toBe(2);
    // Two runs of one step (a loop): Mastra mints a call id per run; one id for both is a difference.
    const twice = [...lifecycle('a', 1), ...lifecycle('a', 1)];
    const first = (twice[0] as { payload: { stepCallId: string } }).payload.stepCallId;
    const reused = [...twice.slice(0, 3), ...twice.slice(3).map((e) => recall(e, first))];
    expect(compareEvents(twice, reused).map((x) => x.path)).toEqual(['events.a.3.payload.stepCallId', 'events.a.4.payload.stepCallId', 'events.a.5.payload.stepCallId']);
  });

  it('a step call id consumes no UUID ordinal: the ids after it keep their numbers', () => {
    const sleep = `sleep_${U()}`;
    const events = (id: string) => [...lifecycle('a', 1), { type: 'workflow-step-waiting', payload: { id, status: 'waiting' } }];
    expect(Object.keys(groupEvents(events(sleep)))).toContain('sleep_<uuid#0>');
    expect(compareEvents(events(sleep), events(`sleep_${U()}`))).toEqual([]);
  });

  it('UUIDs are ordinals: equal structure passes, a different structure fails', () => {
    const u1 = U();
    const u2 = U();
    const u3 = U();
    const ev = (a: string, b: string) => [{ type: 'data-x', data: { a, b } }];
    expect(compareEvents(ev(u1, u1), ev(u2, u2))).toEqual([]);
    expect(compareEvents(ev(u1, u1), ev(u2, u3)).map((d) => d.path)).toEqual(['events.$data-x.0.data.b']);
  });
});

describe('gating and attribution', () => {
  it('an unattributed event difference fails the fixture by default', () => {
    const v = compareObservations('x', ora(lifecycle('a', 1)), cand([]), []);
    expect(v.differences.map((d) => d.path)).toEqual(['events.a']);
    expect(v.verdict).toBe('fail');
  });

  it('events.* paths are attributable like any other', () => {
    const at = [{ row: 58, paths: ['events.w@output'], reason: 'test' }];
    const chunk = { type: 'workflow-step-output', payload: { output: 1, stepName: 'w' } };
    const v = compareObservations('x', ora([]), cand([chunk]), at);
    expect(v.differences).toEqual([{ path: 'events.w@output', oracle: '<absent>', candidate: ['workflow-step-output'], row: 58 }]);
    expect(v.verdict).toBe('divergent');
    expect(v.unusedAttributions).toEqual([]);
  });

  it('there is no report mode: an option or environment variable asking for one changes nothing', () => {
    const prior = process.env['DIFFERENTIAL_EVENTS'];
    process.env['DIFFERENTIAL_EVENTS'] = 'report';
    try {
      const smuggled = { events: 'report' } as unknown as CompareOptions;
      const v = compareObservations('x', ora(lifecycle('a', 1)), cand([]), [], [], smuggled);
      expect(v.differences.map((d) => d.path)).toEqual(['events.a']);
      expect(v.verdict).toBe('fail');
      expect('reportedEvents' in v).toBe(false);
      expect('eventsMode' in v).toBe(false);
      const oracle: ResumeObservation = { phases: [{ outcome: { kind: 'resolved', result: {} }, stored: {}, trace: [], executions: [{ engine: 'default', workflowId: 'w' }], events: lifecycle('a', 1) }] };
      const candidate: ResumeObservation = { phases: [{ outcome: { kind: 'resolved', result: {} }, stored: {}, trace: [], executions: [{ engine: 'petri', workflowId: 'w' }], events: [] }] };
      expect(compareResume('r', { suspendOn: 'petri', resumeOn: 'petri', process: 'fresh' }, oracle, candidate, [], [], smuggled).verdict).toBe('fail');
    } finally {
      if (prior === undefined) delete process.env['DIFFERENTIAL_EVENTS'];
      else process.env['DIFFERENTIAL_EVENTS'] = prior;
    }
  });

  it('observations without events skip the dimension; one side with events compares against none', () => {
    expect(compareObservations('x', ora(undefined), cand(undefined), []).verdict).toBe('pass');
    expect(compareObservations('x', ora(lifecycle('a', 1)), cand(undefined), []).differences.map((d) => d.path)).toEqual(['events.a']);
  });

  it('a sleep id in events keeps the ordinal its record got in the result', () => {
    const sleep = `sleep_${U()}`;
    const other = `sleep_${U()}`;
    const result = (id: string) => ({ status: 'success', steps: { [id]: { status: 'success' } } });
    const waiting = (id: string) => [{ type: 'workflow-step-waiting', payload: { id, status: 'waiting' } }];
    expect(compareObservations('x', ora(waiting(sleep), result(sleep)), cand(waiting(other), result(other)), []).verdict).toBe('pass');
  });
});

describe('resume', () => {
  const phase = (engine: 'default' | 'petri', events: readonly unknown[]): PhaseObservation => ({
    outcome: { kind: 'resolved', result: { status: 'success' } },
    stored: {},
    trace: [],
    executions: [{ engine, workflowId: 'w' }],
    events,
  });
  const route = { suspendOn: 'petri', resumeOn: 'petri', process: 'fresh' } as const;

  it('compares each phase at phases.<i>.events, gated and attributable', () => {
    const oracle: ResumeObservation = { phases: [phase('default', lifecycle('a', 1)), phase('default', lifecycle('g', 2))] };
    const candidate: ResumeObservation = { phases: [phase('petri', lifecycle('a', 1)), phase('petri', [])] };
    const v = compareResume('r', route, oracle, candidate, []);
    expect(v.differences.map((d) => d.path)).toEqual(['phases.1.events.g']);
    expect(v.verdict).toBe('fail');
    const at = [{ row: 57, paths: ['phases.*.events.**'], reason: 'test' }];
    expect(compareResume('r', route, oracle, candidate, at).verdict).toBe('divergent');
  });

  it('orders events across groups per phase, at phases.<i>.events.$order', () => {
    const [as, ar, af] = lifecycle('a', 1);
    const [bs, br, bf] = lifecycle('b', 2);
    const oracle: ResumeObservation = { phases: [phase('default', []), phase('default', [as, ar, af, bs, br, bf])] };
    const candidate: ResumeObservation = { phases: [phase('petri', []), phase('petri', [as, bs, ar, af, br, bf])] };
    const v = compareResume('r', route, oracle, candidate, []);
    expect(v.differences.map((d) => d.path)).toEqual(['phases.1.events.$order.a#0.b#0']);
    expect(v.verdict).toBe('fail');
    const declared = compareResume('r', route, oracle, candidate, [], [['a', 'b']]);
    expect(declared.verdict).toBe('pass');
    expect(declared.ordering.eventsWeakened).toEqual([['phases.1.a#0', 'phases.1.b#0']]);
  });
});

describe('reports', () => {
  it('show an event group as its type sequence', () => {
    const gated = compareObservations('fx', ora(lifecycle('a', 1)), cand([]), []);
    expect(formatVerdicts([gated])).toContain('FINDING: events.a  oracle=[workflow-step-start > workflow-step-result > workflow-step-finish]  petri="<absent>"');
  });

  it('the differential report counts fixtures failing on events only, by pattern', () => {
    const onlyEvents = compareObservations('fx', ora([...lifecycle('a', 1), ...lifecycle('b', 1)]), cand([]), []);
    const also = compareObservations('gx', ora(lifecycle('a', 1), { status: 'success' }), cand([], { status: 'failed' }), []);
    const report = formatDifferentialReport([onlyEvents, also]);
    expect(report).toContain('1 of 2 verdict(s) have findings on events only');
    expect(report).toMatch(/^\s+2\s+events\.<group>$/m);
  });

  it('patterns keep $-groups and @output, and make indices generic', () => {
    expect(eventPattern('events.a.2.payload.status')).toBe('events.<group>.*.payload.status');
    expect(eventPattern('events.$run.length')).toBe('events.$run.length');
    expect(eventPattern('events.w@output')).toBe('events.<group>@output');
    expect(eventPattern('phases.1.events.g.0.type')).toBe('phases.*.events.<group>.*.type');
    expect(eventPattern('events.$order.a#0.$run:workflow-canceled#0')).toBe('events.$order.<key>.<key>');
    expect(eventPattern('phases.1.events.$within.item[2]#0')).toBe('phases.*.events.$within.<key>');
    expect(isEventPath('phases.1.events.g')).toBe(true);
    expect(isEventPath('result.events.x')).toBe(false);
  });
});

describe('foreach progress', () => {
  const progress = (currentIndex: number, completedCount: number, n?: number) => ({
    type: 'workflow-step-progress',
    payload: {
      id: 'item',
      completedCount,
      totalCount: 3,
      currentIndex,
      iterationStatus: n === undefined ? 'suspended' : 'success',
      ...(n === undefined ? {} : { iterationOutput: { n } }),
    },
  });
  const start = { type: 'workflow-step-start', payload: { id: 'item', status: 'running' } };

  it("each item's progress is its own group, its count replaced by its own increment", () => {
    const g = groupEvents([start, progress(2, 1, 30), progress(1, 1), progress(0, 2, 10)]);
    expect(Object.keys(g).sort()).toEqual(['item', 'item[0]', 'item[1]', 'item[2]']);
    expect(g['item[2]']).toEqual([
      { type: 'workflow-step-progress', payload: { id: 'item', totalCount: 3, currentIndex: 2, iterationStatus: 'success', iterationOutput: { n: 30 }, $completedIncrement: 1 } },
    ]);
    expect((g['item[1]']![0] as { payload: { $completedIncrement: number } }).payload.$completedIncrement).toBe(0);
  });

  it('items completing in another order agree, suspensions anywhere in it', () => {
    // Mastra: item 2 first, then the suspended item 1, then item 0. A budget: 1 suspends first.
    const oracle = [start, progress(2, 1, 30), progress(1, 1), progress(0, 2, 10)];
    const candidate = [start, progress(1, 0), progress(0, 1, 10), progress(2, 2, 30)];
    expect(compareEvents(oracle, candidate)).toEqual([]);
  });

  it("an item's own output, and a counter that does not move, are still differences", () => {
    const oracle = [start, progress(0, 1, 10), progress(1, 2, 20)];
    expect(compareEvents(oracle, [start, progress(0, 1, 10), progress(1, 2, 21)]).map((d) => d.path)).toEqual(['events.item[1].0.payload.iterationOutput.n']);
    expect(compareEvents(oracle, [start, progress(0, 1, 10), progress(1, 1, 20)]).map((d) => d.path)).toEqual(['events.item[1].0.payload.$completedIncrement']);
    expect(eventPattern('events.item[1].0.payload.iterationOutput.n')).toBe('events.<group>[*].*.payload.iterationOutput.n');
  });

  it("the counter restarts with the foreach's start: a loop's second pass counts from 0", () => {
    const twice = [start, progress(0, 1, 10), start, progress(0, 1, 10)];
    const g = groupEvents(twice);
    expect(g['item[0]']!.map((e) => (e as { payload: { $completedIncrement: number } }).payload.$completedIncrement)).toEqual([1, 1]);
  });
});

describe('order across groups: happens-before over spans', () => {
  const [as, ar, af] = lifecycle('a', 1);
  const [bs, br, bf] = lifecycle('b', 2);
  const sequential = [as, ar, af, bs, br, bf];

  it("a successor's -start before its predecessor's -result is an inversion, gated", () => {
    const d = compareEvents(sequential, [as, bs, ar, af, br, bf]);
    expect(d).toEqual([{ path: 'events.$order.a#0.b#0', oracle: 'a#0 before b#0', candidate: 'b#0 started before a#0 ended' }]);
    expect(compareObservations('x', ora(sequential), cand([as, bs, ar, af, br, bf]), []).verdict).toBe('fail');
  });

  it("…and so is one between the predecessor's -result and its -finish", () => {
    expect(compareEvents(sequential, [as, ar, bs, af, br, bf]).map((d) => d.path)).toEqual(['events.$order.a#0.b#0']);
  });

  it('a successor run wholly first is a reversal', () => {
    expect(compareEvents(sequential, [bs, br, bf, as, ar, af])).toEqual([{ path: 'events.$order.a#0.b#0', oracle: 'a#0 before b#0', candidate: 'b#0 before a#0' }]);
  });

  it('a pair declared independent may reorder: weakened, reported, not gated', () => {
    const v = compareObservations('x', ora(sequential), cand([bs, br, bf, as, ar, af]), [], [['a', 'b']]);
    expect(v.differences).toEqual([]);
    expect(v.verdict).toBe('pass');
    expect(v.ordering.eventsWeakened).toEqual([['a#0', 'b#0']]);
    expect(formatVerdicts([v])).toContain('events weakened (independent): a#0<b#0');
  });

  it('arms the oracle overlaps may run in any order or serialised: no difference', () => {
    const overlapped = [as, bs, ar, br, af, bf];
    expect(compareEvents(overlapped, [bs, as, br, ar, bf, af])).toEqual([]);
    expect(compareEvents(overlapped, sequential)).toEqual([]);
    expect(compareEvents(overlapped, [bs, br, bf, as, ar, af])).toEqual([]);
  });

  it('occurrences line up by run: a loop body that starts its second run before its first finishes is inverted', () => {
    const [s0, r0, f0] = lifecycle('a', 1);
    const [s1, r1, f1] = lifecycle('a', 2);
    expect(compareEvents([s0, r0, f0, s1, r1, f1], [s0, r0, s1, f0, r1, f1]).map((d) => d.path)).toContain('events.$order.a#0.a#1');
  });

  it('events.$order paths are attributable', () => {
    const at = [{ row: 4, paths: ['events.$order.a#0.b#0'], reason: 'test' }];
    const v = compareObservations('x', ora(sequential), cand([bs, br, bf, as, ar, af]), at);
    expect(v.verdict).toBe('divergent');
    expect(v.unusedAttributions).toEqual([]);
  });

  it("workflow-canceled before the last step settles is inverted against it", () => {
    const [cs, cr, cf] = lifecycle('c', { canceled: true });
    const canceled = { type: 'workflow-canceled', payload: {} };
    expect(compareEvents([cs, cr, cf, canceled], [cs, canceled, cr, cf])).toEqual([
      { path: 'events.$order.c#0.$run:workflow-canceled#0', oracle: 'c#0 before $run:workflow-canceled#0', candidate: '$run:workflow-canceled#0 started before c#0 ended' },
    ]);
    expect(compareEvents([cs, cr, cf, canceled], [canceled, cs, cr, cf]).map((d) => d.path)).toEqual(['events.$order.c#0.$run:workflow-canceled#0']);
  });

  it("a stream's workflow-start after a step's start, or its workflow-finish before a step's finish, is a difference", () => {
    const start = { type: 'workflow-start', runId: 'r', from: 'WORKFLOW', payload: {} };
    const finish = { type: 'workflow-finish', runId: 'r', from: 'WORKFLOW', payload: {} };
    const oracle = [start, as, ar, af, finish];
    expect(compareEvents(oracle, [as, start, ar, af, finish]).map((d) => d.path)).toEqual(['events.$order.$run:workflow-start#0.a#0']);
    expect(compareEvents(oracle, [start, as, ar, finish, af]).map((d) => d.path)).toEqual(['events.$order.a#0.$run:workflow-finish#0']);
  });
});

describe('points inside their owner step', () => {
  const progress = (currentIndex: number, completedCount: number) => ({
    type: 'workflow-step-progress',
    payload: { id: 'item', completedCount, totalCount: 2, currentIndex, iterationStatus: 'success', iterationOutput: { n: currentIndex } },
  });
  const start = { type: 'workflow-step-start', payload: { id: 'item', status: 'running' } };
  const result = { type: 'workflow-step-result', payload: { id: 'item', status: 'success', output: [] } };
  const finish = { type: 'workflow-step-finish', payload: { id: 'item', metadata: {} } };
  const oracle = [start, progress(0, 1), progress(1, 2), result, finish];

  it("a foreach's progress after the aggregate's -result, or after its -finish, is outside it", () => {
    expect(compareEvents(oracle, [start, progress(0, 1), result, progress(1, 2), finish])).toEqual([
      { path: 'events.$within.item[1]#0', oracle: 'inside item', candidate: 'outside item' },
    ]);
    expect(compareEvents(oracle, [start, progress(0, 1), result, finish, progress(1, 2)]).map((d) => d.path)).toEqual(['events.$within.item[1]#0']);
  });

  it("…and so is progress before the foreach's -start", () => {
    // (The start also resets the counter, so item 1's increment differs too.)
    expect(compareEvents(oracle, [progress(0, 1), start, progress(1, 2), result, finish]).map((d) => d.path)).toContain('events.$within.item[0]#0');
  });

  it('items completing in another order are still inside: no difference', () => {
    expect(compareEvents(oracle, [start, progress(1, 1), progress(0, 2), result, finish])).toEqual([]);
  });

  it("a nested child's events after the parent step's -result are outside it", () => {
    const [ps, pr, pf] = lifecycle('inner', 2);
    const child = lifecycle('inner.i1', 1);
    expect(compareEvents([ps, ...child, pr, pf], [ps, pr, ...child, pf])).toEqual([
      { path: 'events.$within.inner/i1#0', oracle: 'inside inner', candidate: 'outside inner' },
    ]);
    // Before the parent's -start, too.
    expect(compareEvents([ps, ...child, pr, pf], [...child, ps, pr, pf]).map((d) => d.path)).toContain('events.$within.inner/i1#0');
    expect(eventModel([ps, ...child, pr, pf]).within.get('inner/i1#0')).toEqual({ owner: 'inner', inside: true });
  });

  it("a writer chunk after its step's -result is outside it", () => {
    const [ws, wr, wf] = lifecycle('w', 1);
    const chunk = { type: 'workflow-step-output', runId: 'r', from: 'USER', payload: { output: { p: 1 }, runId: 'r', stepName: 'w' } };
    expect(compareEvents([ws, chunk, wr, wf], [ws, wr, chunk, wf])).toEqual([
      { path: 'events.$within.w@output#0', oracle: 'inside w', candidate: 'outside w' },
    ]);
    expect(compareEvents([ws, chunk, wr, wf], [ws, wr, wf, chunk]).map((d) => d.path)).toEqual(['events.$within.w@output#0']);
    expect(compareEvents([ws, chunk, wr, wf], [ws, chunk, wr, wf])).toEqual([]);
  });

  it("a nested step's chunk names its step bare: the prefixed group owns it", () => {
    const [ns, nr, nf] = lifecycle('inner.w', 1);
    const chunk = { type: 'workflow-step-output', payload: { output: 1, stepName: 'w' } };
    expect(eventModel([ns, chunk, nr, nf]).within.get('w@output#0')).toEqual({ owner: 'w', inside: true });
    expect(compareEvents([ns, chunk, nr, nf], [ns, nr, chunk, nf]).map((d) => d.path)).toEqual(['events.$within.w@output#0']);
  });

  it('a point the oracle does not have inside its owner is not required of the candidate', () => {
    const [ws, wr, wf] = lifecycle('w', 1);
    const chunk = { type: 'workflow-step-output', payload: { output: 1, stepName: 'w' } };
    expect(compareEvents([ws, wr, wf, chunk], [ws, chunk, wr, wf])).toEqual([]);
  });
});

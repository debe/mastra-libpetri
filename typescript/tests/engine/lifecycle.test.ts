import { describe, expect, it } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { resumeSeed } from '../../src/compiler/resume.js';
import type { EntryDescription, LifecycleEvent, StepCall, StepOutcome, StepRunner, WorkflowDescription } from '../../src/compiler/types.js';
import { runWorkflowDetailed, type RunReport } from '../../src/engine/index.js';

/**
 * Which lifecycle events the gadgets raise ([ADR 0008]), and in which order relative to the
 * runner's calls — host-free, with a scripted runner of this file's own. A trace line is either a
 * runner call, `call <id>#<attempt>` (with `@<index>` for a foreach item and `~<n>` for a loop
 * iteration), or an event, `<kind> <id>` plus what distinguishes it.
 *
 * Tested, not proven: these are runs, one interleaving each. That the observer cannot change what
 * the net does is structural — no arc, guard or branch reads it — and is pinned below only by
 * comparing a run with and without one.
 */

type Script = (input: unknown, call: StepCall) => StepOutcome | Promise<StepOutcome>;

class TracingRunner implements StepRunner {
  readonly trace: string[] = [];
  readonly events: LifecycleEvent[] = [];
  readonly selectBranches?: StepRunner['selectBranches'];
  readonly evaluateLoopCondition?: StepRunner['evaluateLoopCondition'];
  readonly resolveWait?: StepRunner['resolveWait'];
  readonly observe?: StepRunner['observe'];

  constructor(
    readonly steps: Record<string, Script> = {},
    options: {
      readonly branches?: readonly number[];
      readonly loopWhile?: (iteration: number) => boolean;
      readonly wait?: number;
      readonly observe?: false | ((event: LifecycleEvent) => void | Promise<void>);
    } = {},
  ) {
    if (options.branches !== undefined) this.selectBranches = async () => options.branches!;
    if (options.loopWhile !== undefined) this.evaluateLoopCondition = async (_id, _out, iteration) => options.loopWhile!(iteration);
    if (options.wait !== undefined) this.resolveWait = async () => options.wait!;
    const extra = options.observe;
    if (extra !== false) {
      this.observe = async (event) => {
        this.events.push(event);
        this.trace.push(describeEvent(event));
        await extra?.(event);
      };
    }
  }

  async run(stepId: string, input: unknown, call: StepCall): Promise<StepOutcome> {
    const at = call.foreachIndex === undefined ? '' : `@${call.foreachIndex}`;
    const loop = call.iteration === undefined ? '' : `~${call.iteration}`;
    this.trace.push(`call ${stepId}#${call.attempt}${at}${loop}${call.resumed ? ' resumed' : ''}`);
    const script = this.steps[stepId];
    return script === undefined ? { status: 'success', output: input } : script(input, call);
  }
}

function describeEvent(e: LifecycleEvent): string {
  switch (e.kind) {
    case 'step-settled':
      return `step-settled ${e.stepId}${e.foreachIndex === undefined ? '' : `@${e.foreachIndex}`} ${e.record.status} [${e.path.join(',')}]`;
    case 'sleep-waiting':
    case 'sleep-settled':
    case 'foreach-settled':
      return `${e.kind} ${e.stepId} ${e.record.status}`;
    case 'foreach-entered':
      return `foreach-entered ${e.stepId} items=${String(e.items)}${e.resumed ? ' resumed' : ''}`;
  }
}

const wf = (...entries: EntryDescription[]): WorkflowDescription => ({ id: 'life', entries });
const step = (id: string, retries?: number): EntryDescription & { kind: 'step' } =>
  retries === undefined ? { kind: 'step', id } : { kind: 'step', id, retries };
const run = (d: WorkflowDescription, input: unknown, runner: StepRunner, extra: Omit<Parameters<typeof runWorkflowDetailed>[2], 'runner'> = {}) =>
  runWorkflowDetailed(compile(d), input, { runner, ...extra });

describe('lifecycle events — which the gadgets raise, and when', () => {
  it('a step: its record is observed once, after its call, before the next step is called', async () => {
    const r = new TracingRunner();
    const report = await run(wf(step('a'), step('b')), 1, r);
    expect(report.outcome.status).toBe('success');
    expect(r.trace).toEqual(['call a#0', 'step-settled a success [0]', 'call b#0', 'step-settled b success [1]']);
    // The event carries the very record the store holds.
    expect(r.events[0]).toMatchObject({ kind: 'step-settled', stepId: 'a', record: report.stepResults.get('a') });
  });

  it('retries: one settled event, after the last attempt — never a retried attempt\'s', async () => {
    const r = new TracingRunner({ a: (_i, call) => (call.attempt < 2 ? { status: 'failed', error: 'x' } : { status: 'success', output: 2 }) });
    await run(wf(step('a', 2)), 1, r);
    expect(r.trace).toEqual(['call a#0', 'call a#1', 'call a#2', 'step-settled a success [0]']);
  });

  it('a failure, a suspension and a bail each settle once', async () => {
    for (const [status, outcome] of [
      ['failed', { status: 'failed', error: 'x' }],
      ['suspended', { status: 'suspended', suspendPayload: { ask: 1 } }],
      ['bailed', { status: 'bailed', output: 9 }],
    ] as const) {
      const r = new TracingRunner({ a: () => outcome as StepOutcome });
      await run(wf(step('a'), step('b')), 1, r);
      expect(r.trace).toEqual(['call a#0', `step-settled a ${status} [0]`]);
    }
  });

  it('parallel and branch arms settle at their arm paths', async () => {
    const par = new TracingRunner();
    await run(wf({ kind: 'parallel', id: 'p', arms: [step('x'), step('y')] }), 1, par);
    expect([...par.trace].sort()).toEqual(['call x#0', 'call y#0', 'step-settled x success [0,0]', 'step-settled y success [0,1]']);
    expect(par.trace.indexOf('step-settled x success [0,0]')).toBeGreaterThan(par.trace.indexOf('call x#0'));

    const br = new TracingRunner({}, { branches: [1] });
    await run(wf({ kind: 'branch', id: 'b', arms: [step('x'), step('y')] }), 1, br);
    expect(br.trace).toEqual(['call y#0', 'step-settled y success [0,1]']);
  });

  it('a loop: every iteration is called with its 1-based iteration and settles', async () => {
    const r = new TracingRunner({}, { loopWhile: (i) => i < 3 });
    await run(wf({ kind: 'loop', id: 'lp', body: step('inc'), loopType: 'dowhile', iterationBound: 5 }), 1, r);
    expect(r.trace).toEqual([
      'call inc#0~1',
      'step-settled inc success [0]',
      'call inc#0~2',
      'step-settled inc success [0]',
      'call inc#0~3',
      'step-settled inc success [0]',
    ]);
  });

  it('a sleep: waiting before the wait, settled after it; a per-run sleep the same', async () => {
    for (const duration of [{ fixed: 1 }, { perRun: true }] as const) {
      const r = new TracingRunner({}, { wait: 1 });
      await run(wf(step('a'), { kind: 'sleep', id: 'nap', duration }, step('b')), 1, r);
      expect(r.trace).toEqual(['call a#0', 'step-settled a success [0]', 'sleep-waiting nap waiting', 'sleep-settled nap success', 'call b#0', 'step-settled b success [2]']);
    }
  });

  it('a sleep canceled mid-wait: waiting, and no settled event', async () => {
    const controller = new AbortController();
    const r = new TracingRunner({}, { observe: (e) => void (e.kind === 'sleep-waiting' && setTimeout(() => controller.abort(), 5)) });
    const report = await run(wf({ kind: 'sleep', id: 'nap', duration: { fixed: 10_000 } }, step('b')), 1, r, { signal: controller.signal });
    expect(report.outcome.status).toBe('canceled');
    expect(r.trace).toEqual(['sleep-waiting nap waiting']);
  });

  it('a foreach: entered before any item, each item settled with its index, then the aggregate', async () => {
    const r = new TracingRunner();
    await run(wf({ kind: 'foreach', id: 'each', concurrency: 1, body: step('x') }, step('z')), [10, 20, 30], r);
    expect(r.trace).toEqual([
      'foreach-entered x items=3',
      'call x#0@0',
      'step-settled x@0 success [0]',
      'call x#0@1',
      'step-settled x@1 success [0]',
      'call x#0@2',
      'step-settled x@2 success [0]',
      'foreach-settled x success',
      'call z#0',
      'step-settled z success [1]',
    ]);
    expect(r.events[0]).toMatchObject({ kind: 'foreach-entered', input: [10, 20, 30], resumed: false });
  });

  it('a foreach over nothing and over a non-array: entered (items 0 / undefined), then settled', async () => {
    const empty = new TracingRunner();
    await run(wf({ kind: 'foreach', id: 'each', concurrency: 2, body: step('x') }), [], empty);
    expect(empty.trace).toEqual(['foreach-entered x items=0', 'foreach-settled x success']);

    const none = new TracingRunner();
    const report = await run(wf({ kind: 'foreach', id: 'each', concurrency: 2, body: step('x') }), null, none);
    expect(report.outcome.status).toBe('failed');
    expect(none.trace).toEqual(['foreach-entered x items=undefined', 'foreach-settled x failed']);
  });

  it('a foreach canceled while an item runs: the item settles, then a canceled aggregate', async () => {
    const controller = new AbortController();
    const r = new TracingRunner({
      x: async (i, call) => {
        if (i === 2) {
          controller.abort();
          await new Promise<void>((resolve) => (call.abortSignal.aborted ? resolve() : call.abortSignal.addEventListener('abort', () => resolve())));
        }
        return { status: 'success', output: i };
      },
    });
    const report = await run(wf({ kind: 'foreach', id: 'each', concurrency: 1, body: step('x') }), [1, 2, 3], r, { signal: controller.signal });
    expect(report.outcome.status).toBe('canceled');
    expect(r.trace.at(-1)).toBe('foreach-settled x canceled');
    expect(r.trace.filter((t) => t.startsWith('call'))).toEqual(['call x#0@0', 'call x#0@1']);
  });

  it('a sleepUntil: waiting, then settled', async () => {
    const r = new TracingRunner();
    await run(wf({ kind: 'sleepUntil', id: 'until', until: { fixed: Date.now() + 2 } }), 1, r);
    expect(r.trace).toEqual(['sleep-waiting until waiting', 'sleep-settled until success']);
  });

  it('a foreach with a failing and a suspending item settles its aggregate once, with that status', async () => {
    const failing = new TracingRunner({ x: (i) => (i === 2 ? { status: 'failed', error: 'no' } : { status: 'success', output: i }) });
    await run(wf({ kind: 'foreach', id: 'each', concurrency: 1, body: step('x') }), [1, 2, 3], failing);
    expect(failing.trace.filter((t) => t.startsWith('foreach-settled'))).toEqual(['foreach-settled x failed']);
    expect(failing.trace.at(-1)).toBe('foreach-settled x failed');

    const suspending = new TracingRunner({ x: (i) => (i === 2 ? { status: 'suspended', suspendPayload: { i } } : { status: 'success', output: i }) });
    await run(wf({ kind: 'foreach', id: 'each', concurrency: 1, body: step('x') }), [1, 2, 3], suspending);
    expect(suspending.trace).toEqual([
      'foreach-entered x items=3',
      'call x#0@0',
      'step-settled x@0 success [0]',
      'call x#0@1',
      'step-settled x@1 suspended [0]',
      'foreach-settled x suspended',
    ]);
  });

  it('a resumed foreach is entered `resumed`, and only the resumed item is called', async () => {
    const description = wf({ kind: 'foreach', id: 'each', concurrency: 1, body: step('x') });
    const compiled = compile(description);
    const first = await runWorkflowDetailed(compiled, [1, 2, 3], {
      runner: new TracingRunner({ x: (i, call) => (i === 2 && !call.resumed ? { status: 'suspended', suspendPayload: { i } } : { status: 'success', output: i }) }),
    });
    expect(first.outcome.status).toBe('suspended');
    const seed = resumeSeed(compiled, { path: [0], steps: ['x'], forEachIndex: 1, records: first.stepResults });
    const r = new TracingRunner();
    const report = await runWorkflowDetailed(compiled, [1, 2, 3], { runner: r, resume: seed, stepResults: first.stepResults });
    expect(report.outcome.status).toBe('success');
    expect(r.trace[0]).toBe('foreach-entered x items=3 resumed');
    expect(r.trace.filter((t) => t.startsWith('call'))).toEqual(['call x#0@1 resumed', 'call x#0@2']);
    expect(r.trace.at(-1)).toBe('foreach-settled x success');
  });

  it('a resumed step: called `resumed`, then settled', async () => {
    const description = wf(step('a'), step('g'), step('b'));
    const compiled = compile(description);
    const first = await runWorkflowDetailed(compiled, 1, { runner: new TracingRunner({ g: () => ({ status: 'suspended', suspendPayload: {} }) }) });
    const seed = resumeSeed(compiled, { path: [1], steps: ['g'], records: first.stepResults });
    const r = new TracingRunner();
    await runWorkflowDetailed(compiled, 1, { runner: r, resume: seed, stepResults: first.stepResults });
    expect(r.trace).toEqual(['call g#0 resumed', 'step-settled g success [1]', 'call b#0', 'step-settled b success [2]']);
  });
});

describe('lifecycle events — observation only', () => {
  const shapes: readonly [string, WorkflowDescription, unknown][] = [
    ['a chain with a sleep', wf(step('a'), { kind: 'sleep', id: 'nap', duration: { fixed: 1 } }, step('b')), 1],
    ['a foreach', wf({ kind: 'foreach', id: 'each', concurrency: 2, body: step('x') }, step('z')), [1, 2, 3]],
    ['a parallel', wf({ kind: 'parallel', id: 'p', arms: [step('x'), step('y')] }), 1],
  ];

  const strip = (r: RunReport) => ({
    outcome: r.outcome,
    records: Object.fromEntries([...r.stepResults].map(([k, v]) => [k, { ...v, startedAt: 0, endedAt: 0 }])),
  });

  for (const [label, description, input] of shapes) {
    it(`${label}: an observer that throws, or rejects, changes nothing but the report's observerError`, async () => {
      const plain = await run(description, input, new TracingRunner({}, { observe: false }));
      expect(plain.observerError).toBeUndefined();

      const quietRunner = new TracingRunner();
      const quiet = await run(description, input, quietRunner);
      expect(quiet.observerError).toBeUndefined();
      expect(strip(quiet)).toEqual(strip(plain));

      const boom = new Error('observer down');
      for (const observe of [
        () => {
          throw boom;
        },
        async () => Promise.reject(boom),
      ]) {
        const r = new TracingRunner({}, { observe });
        const report = await run(description, input, r);
        expect(strip(report)).toEqual(strip(plain));
        expect(report.observerError).toEqual({ error: boom });
        // Every event is still raised — the first throw is kept, not propagated — and every step called.
        expect([...r.trace].sort()).toEqual([...quietRunner.trace].sort());
      }
    });
  }
});

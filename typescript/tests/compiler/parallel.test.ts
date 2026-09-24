import { describe, expect, it } from 'vitest';
import { Transition, one, outPlace, place, type In, type Place } from 'libpetri';
import { compile, parallelGadget, type Gadget } from '../../src/compiler/index.js';
import { runWorkflow, runWorkflowDetailed } from '../../src/engine/index.js';
import type {
  CanceledToken,
  EntryDescription,
  Exits,
  StepCall,
  StepDescription,
  StepOutcome,
  WorkflowDescription,
} from '../../src/compiler/types.js';
import { RecordingRunner, type Behaviour } from '../fixtures/runner.js';

const step = (id: string, extra: Partial<Omit<StepDescription, 'kind' | 'id'>> = {}): StepDescription =>
  ({ kind: 'step', id, ...extra });
const fan = (id: string, arms: readonly StepDescription[]): EntryDescription => ({ kind: 'parallel', id, arms });
const wf = (...entries: EntryDescription[]): WorkflowDescription => ({ id: 'w', entries });

const after = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Scripted arm behaviours that also log the order arms *settled* in, so a test can show that
 * time order and index order really did differ rather than assume it.
 */
class Script {
  readonly settled: string[] = [];
  readonly inputs = new Map<string, unknown[]>();

  /** Resolves `outcome` after `ms`, recording the input it saw and when it settled. */
  at(ms: number, id: string, outcome: StepOutcome | ((input: unknown, call: StepCall) => StepOutcome)): Behaviour {
    return async (input, call) => {
      this.inputs.set(id, [...(this.inputs.get(id) ?? []), input]);
      if (ms > 0) await after(ms);
      this.settled.push(id);
      return typeof outcome === 'function' ? outcome(input, call) : outcome;
    };
  }
}

const ok = (output: unknown): StepOutcome => ({ status: 'success', output });
const tag = (id: string) => (input: unknown): StepOutcome => ok(`${input as string}/${id}`);

const run = (description: WorkflowDescription, runner: RecordingRunner, gadget: Gadget = parallelGadget) =>
  runWorkflow(compile(description, { gadgets: { parallel: gadget } }), 'x', { runner });

// Every outcome below is asserted whole, with `toStrictEqual`: it catches a `residue` key (a
// token left anywhere in the net) exactly as `toEqual` does, and additionally tells a key that
// is present with `undefined` from a key that is absent — the difference between the two value
// shapes this gadget hands on.

describe('parallel: success', () => {
  it('runs every arm on the same input and, as the last entry, returns the block output in arm order', async () => {
    const s = new Script();
    // Completion order c, b, a — the reverse of arm order.
    const runner = new RecordingRunner({
      a: s.at(30, 'a', tag('a')),
      b: s.at(15, 'b', tag('b')),
      c: s.at(0, 'c', tag('c')),
    });

    const outcome = await run(wf(fan('fan', [step('a'), step('b'), step('c')])), runner);

    expect(s.settled).toEqual(['c', 'b', 'a']);
    expect([...s.inputs]).toEqual([['a', ['x']], ['b', ['x']], ['c', ['x']]]);
    expect(outcome).toStrictEqual({ status: 'success', output: { a: 'x/a', b: 'x/b', c: 'x/c' } });
    expect(Object.keys((outcome as { output: object }).output)).toEqual(['a', 'b', 'c']);
  });

  it('hands the next entry a record over every declared arm, and the next entry runs only after the join', async () => {
    const s = new Script();
    const runner = new RecordingRunner({
      a: s.at(20, 'a', tag('a')),
      b: s.at(0, 'b', tag('b')),
      after: (input) => ok({ saw: input }),
    });

    const outcome = await run(wf(fan('fan', [step('a'), step('b')]), step('after')), runner);

    expect(runner.calls.slice(0, 2).sort()).toEqual(['a', 'b']);
    expect(runner.calls).toEqual([...runner.calls.slice(0, 2), 'after']);
    expect(outcome).toStrictEqual({ status: 'success', output: { saw: { a: 'x/a', b: 'x/b' } } });
  });

  it('retries an arm inside the block, and only its final attempt decides the arm', async () => {
    const runner = new RecordingRunner({
      a: (input, call) => (call.attempt < 2 ? { status: 'failed', error: `attempt ${call.attempt}` } : tag('a')(input)),
    });

    const outcome = await run(wf(fan('fan', [step('a', { retries: 2 }), step('b')])), runner);

    expect(runner.attempts.filter((a) => a.stepId === 'a').map((a) => a.attempt)).toEqual([0, 1, 2]);
    expect(outcome).toStrictEqual({ status: 'success', output: { a: 'x/a', b: 'x' } });
  });
});

describe('parallel: failure', () => {
  it('reports the lowest-indexed failed arm, not the first to fail in time', async () => {
    const s = new Script();
    const runner = new RecordingRunner({
      a: s.at(40, 'a', { status: 'failed', error: 'a!' }),
      b: s.at(20, 'b', tag('b')),
      c: s.at(0, 'c', { status: 'failed', error: 'c!' }),
    });

    const outcome = await run(wf(fan('fan', [step('a'), step('b'), step('c')])), runner);

    // `c` failed first in time; Mastra's `results.find` over index-aligned results picks `a`.
    expect(s.settled).toEqual(['c', 'b', 'a']);
    expect(outcome).toStrictEqual({ status: 'failed', stepId: 'a', path: [0, 0], error: 'a!' });
  });

  it('waits for every sibling before failing the block, and stops the entries after it', async () => {
    const s = new Script();
    const runner = new RecordingRunner({
      a: s.at(0, 'a', { status: 'failed', error: 'a!' }),
      b: s.at(30, 'b', tag('b')),
    });

    const outcome = await run(wf(fan('fan', [step('a'), step('b')]), step('after')), runner);

    // Mastra's arms never reject, so `Promise.all` awaits `b` too; the join is a count and does
    // the same. `after` never runs.
    expect(s.settled).toEqual(['a', 'b']);
    expect(runner.calls).not.toContain('after');
    expect(outcome).toStrictEqual({ status: 'failed', stepId: 'a', path: [0, 0], error: 'a!' });
  });

  it('two arms sharing an id: the lower index\'s error is reported though the higher failed first', async () => {
    // Ranking by step id collapsed both arms onto index 0 and let the FIFO head — arm 1, first in
    // time — win (`docs/divergences.md` row 33). The origin's path names the arm exactly.
    const settled: number[] = [];
    const runner = new RecordingRunner({
      a: async (_input, call) => {
        const arm = call.path[1]!;
        if (arm === 0) await after(30);
        settled.push(arm);
        return { status: 'failed', error: `arm ${arm}!` };
      },
    });

    const outcome = await run(wf(fan('fan', [step('a'), step('a')])), runner);

    expect(settled).toEqual([1, 0]);
    expect(outcome).toStrictEqual({ status: 'failed', stepId: 'a', path: [0, 0], error: 'arm 0!' });
  });

  it('forwards a failing arm\'s tripwire, so the run ends tripwire', async () => {
    const runner = new RecordingRunner({
      b: () => ({ status: 'failed', error: 'blocked', tripwire: { reason: 'policy' } }),
    });

    const outcome = await run(wf(fan('fan', [step('a'), step('b')])), runner);

    // The outcome carries the failure's `error` beside the tripwire (contract change), so the
    // result formatter can fall back to it; Mastra's run result itself has no `error` here.
    expect(outcome).toStrictEqual({ status: 'tripwire', stepId: 'b', path: [0, 1], tripwire: { reason: 'policy' }, error: 'blocked' });
  });

  it('takes tripwire-or-not from the lowest-indexed failure, whichever failed first', async () => {
    const s = new Script();
    const plainFirst = new RecordingRunner({
      a: s.at(20, 'a', { status: 'failed', error: 'a!' }),
      b: s.at(0, 'b', { status: 'failed', error: 'b!', tripwire: { reason: 'policy' } }),
    });
    const tripwireFirst = new RecordingRunner({
      a: s.at(20, 'a', { status: 'failed', error: 'a!', tripwire: { reason: 'policy' } }),
      b: s.at(0, 'b', { status: 'failed', error: 'b!' }),
    });
    const shape = wf(fan('fan', [step('a'), step('b')]));

    expect(await run(shape, plainFirst)).toStrictEqual({ status: 'failed', stepId: 'a', path: [0, 0], error: 'a!' });
    expect(await run(shape, tripwireFirst)).toStrictEqual({ status: 'tripwire', stepId: 'a', path: [0, 0], tripwire: { reason: 'policy' }, error: 'a!' });
  });

  it('lets a failure outrank a suspension, and leaves no suspension marker behind', async () => {
    const runner = new RecordingRunner({
      a: () => ({ status: 'suspended', suspendPayload: 'wait for approval' }),
      b: async () => { await after(10); return { status: 'failed', error: 'b!' }; },
    });

    const outcome = await run(wf(fan('fan', [step('a'), step('b')])), runner);

    expect(outcome).toStrictEqual({ status: 'failed', stepId: 'b', path: [0, 1], error: 'b!' });
  });

  it('settles every one of the five outcomes in one block, and the failure decides it', async () => {
    const runner = new RecordingRunner({
      ok: tag('ok'),
      bad: async () => { await after(15); return { status: 'failed', error: 'bad!' }; },
      wait: () => ({ status: 'suspended', suspendPayload: 'p' }),
      early: () => ({ status: 'bailed', output: 'early' }),
      sub: () => ({ status: 'paused' }),
    });

    const outcome = await run(
      wf(fan('fan', [step('ok'), step('bad'), step('wait'), step('early'), step('sub', { source: 'workflow' })]), step('after')),
      runner,
    );

    expect(runner.calls).not.toContain('after');
    expect(outcome).toStrictEqual({ status: 'failed', stepId: 'bad', path: [0, 1], error: 'bad!' });
  });

  it('treats a runner that throws as a failed arm', async () => {
    const boom = new Error('provider down');
    const runner = new RecordingRunner({
      a: () => { throw boom; },
      b: async (input) => { await after(10); return tag('b')(input); },
    });

    const outcome = await run(wf(fan('fan', [step('a'), step('b')])), runner);

    expect(outcome).toStrictEqual({ status: 'failed', stepId: 'a', path: [0, 0], error: boom });
  });

  it('fails a retrying arm only once its retries are spent', async () => {
    const runner = new RecordingRunner({ a: (_input, call) => ({ status: 'failed', error: `attempt ${call.attempt}` }) });

    const outcome = await run(wf(fan('fan', [step('a', { retries: 2 }), step('b')])), runner);

    expect(runner.attempts.filter((a) => a.stepId === 'a')).toHaveLength(3);
    expect(outcome).toStrictEqual({ status: 'failed', stepId: 'a', path: [0, 0], error: 'attempt 2' });
  });
});

describe('parallel: suspension', () => {
  it('suspends the block on the lowest-indexed suspended arm, and records every suspension', async () => {
    const s = new Script();
    const runner = new RecordingRunner({
      a: s.at(20, 'a', { status: 'suspended', suspendPayload: 'pa' }),
      b: s.at(0, 'b', tag('b')),
      c: s.at(0, 'c', { status: 'suspended', suspendPayload: 'pc' }),
    });

    const { outcome, stepResults } = await runWorkflowDetailed(
      compile(wf(fan('fan', [step('a'), step('b'), step('c')]), step('after'))),
      'x',
      { runner },
    );

    expect(s.settled.indexOf('c')).toBeLessThan(s.settled.indexOf('a'));
    expect(runner.calls).not.toContain('after');
    expect(outcome).toStrictEqual({ status: 'suspended', stepId: 'a', path: [0, 0], payload: 'pa' });
    // Mastra's `fmtReturnValue` lists *every* step result that is suspended, not only the one
    // that decided the block (`default.ts:630-643`); both are in the step results to list.
    // Each record keeps both of Mastra's fields apart: `payload` is the step's input and
    // `suspendPayload` what it suspended with (`handlers/step.ts:516-522`). They once shared one
    // key and the input overwrote the suspension.
    expect(stepResults.get('a')).toMatchObject({ status: 'suspended', payload: 'x', suspendPayload: 'pa' });
    expect(stepResults.get('c')).toMatchObject({ status: 'suspended', payload: 'x', suspendPayload: 'pc' });
  });

  it('picks the lowest index by path, exactly, even when two arms share an id', async () => {
    const runner = new RecordingRunner({
      a: async (_input, call) => {
        if (call.path[1] === 0) await after(20);
        return { status: 'suspended', suspendPayload: `arm ${call.path[1]}` };
      },
    });

    const outcome = await run(wf(fan('fan', [step('a'), step('a')])), runner);

    expect(outcome).toStrictEqual({ status: 'suspended', stepId: 'a', path: [0, 0], payload: 'arm 0' });
  });

  it('lets a suspension outrank a bail and a pause', async () => {
    const runner = new RecordingRunner({
      a: () => ({ status: 'bailed', output: 'early' }),
      b: () => ({ status: 'paused' }),
      c: async () => { await after(10); return { status: 'suspended', suspendPayload: 'pc' }; },
    });

    const outcome = await run(wf(fan('fan', [step('a'), step('b', { source: 'workflow' }), step('c')])), runner);

    expect(outcome).toStrictEqual({ status: 'suspended', stepId: 'c', path: [0, 2], payload: 'pc' });
  });
});

describe('parallel: a bail or a pause is swallowed', () => {
  const bailA = () => new RecordingRunner({
    a: () => ({ status: 'bailed', output: 'early' }),
    b: async (input) => { await after(10); return tag('b')(input); },
  });
  const pauseA = () => new RecordingRunner({
    a: () => ({ status: 'paused' }),
    b: async (input) => { await after(10); return tag('b')(input); },
  });
  const arms = [step('a', { source: 'workflow' }), step('b')];

  it('a bailed arm does not end the run, and the next entry reads its bail payload', async () => {
    const runner = bailA();

    const outcome = await run(wf(fan('fan', arms), step('after')), runner);

    // A success, not `bailed: true`: the bail ended the arm, not the run.
    expect(runner.calls).toContain('after');
    expect(outcome).toStrictEqual({ status: 'success', output: { a: 'early', b: 'x/b' } });
  });

  it('a bailed arm is absent from the block output when the block is the last entry', async () => {
    const outcome = await run(wf(fan('fan', arms)), bailA());

    expect(outcome).toStrictEqual({ status: 'success', output: { b: 'x/b' } });
  });

  it('a paused arm does not end the run, and the next entry sees its key with undefined', async () => {
    const runner = pauseA();

    const outcome = await run(wf(fan('fan', arms), step('after')), runner);

    expect(runner.calls).toContain('after');
    expect(outcome).toStrictEqual({ status: 'success', output: { a: undefined, b: 'x/b' } });
    expect('a' in (outcome as { output: object }).output).toBe(true);
  });

  it('a paused arm is absent from the block output when the block is the last entry', async () => {
    const outcome = await run(wf(fan('fan', arms)), pauseA());

    expect(outcome).toStrictEqual({ status: 'success', output: { b: 'x/b' } });
    expect('a' in (outcome as { output: object }).output).toBe(false);
  });

  it('a block whose every arm bailed succeeds with {} as the last entry, and hands on every payload otherwise', async () => {
    const runner = () => new RecordingRunner({
      a: () => ({ status: 'bailed', output: 'pa' }),
      b: () => ({ status: 'bailed', output: 'pb' }),
    });
    const both = [step('a'), step('b')];

    expect(await run(wf(fan('fan', both)), runner())).toStrictEqual({ status: 'success', output: {} });
    expect(await run(wf(fan('fan', both), step('after')), runner()))
      .toStrictEqual({ status: 'success', output: { a: 'pa', b: 'pb' } });
  });
});

describe('parallel: the next entry reads the step results, not the arm tokens', () => {
  it('two arms sharing an id: the result keeps the later index, the next entry keeps the later finisher', async () => {
    // Arm 0 finishes last. Mastra's block output reduces in index order, so arm 1 wins the key
    // (`control-flow.ts:286-295`); `stepResults.a` is whatever was written last in time, so arm 0
    // wins it for the next entry (`default.ts:1141-1149`). Only a join that reads the step results
    // can produce the second value — the arrivals alone would give the first.
    const behaviour = () => new RecordingRunner({
      a: async (_input, call) => {
        if (call.path[1] === 0) await after(20);
        return ok(`arm ${call.path[1]}`);
      },
    });
    const twins = [step('a'), step('a')];

    expect(await run(wf(fan('fan', twins)), behaviour())).toStrictEqual({ status: 'success', output: { a: 'arm 1' } });
    expect(await run(wf(fan('fan', twins), step('after')), behaviour()))
      .toStrictEqual({ status: 'success', output: { a: 'arm 0' } });
  });

  it('an arm that ran earlier and pauses in the block hands on undefined, not its earlier output', async () => {
    // The paused result replaces the earlier success wholesale, as Mastra's does: it is written
    // over `omitPriorCompletionFields(...)`, which strips the earlier `output`
    // (`handlers/step.ts:566-569`).
    const runner = new RecordingRunner({
      sub: (_input, call) => (call.path.length === 1 ? ok('earlier') : { status: 'paused' }),
    });

    const outcome = await run(
      wf(step('sub', { source: 'workflow' }), fan('fan', [step('sub', { source: 'workflow' }), step('b')]), step('after')),
      runner,
    );

    expect(runner.calls[0]).toBe('sub');
    expect(runner.calls.slice(1, 3).sort()).toEqual(['b', 'sub']);
    expect(runner.calls[3]).toBe('after');
    expect(outcome).toStrictEqual({ status: 'success', output: { sub: undefined, b: 'earlier' } });
  });
});

describe('parallel: the empty block', () => {
  it('succeeds with {} as the last entry', async () => {
    const runner = new RecordingRunner();

    const outcome = await run(wf(fan('fan', [])), runner);

    expect(runner.calls).toEqual([]);
    expect(outcome).toStrictEqual({ status: 'success', output: {} });
  });

  it('hands {} to the next entry and the run continues', async () => {
    const runner = new RecordingRunner({ after: (input) => ok({ saw: input }) });

    const outcome = await run(wf(step('before'), fan('fan', []), step('after')), runner);

    expect(runner.calls).toEqual(['before', 'after']);
    expect(outcome).toStrictEqual({ status: 'success', output: { saw: {} } });
  });
});

describe('parallel: arm ids are user strings', () => {
  const protoRunner = () => new RecordingRunner({
    // `Object.fromEntries`, because `{ __proto__: fn }` in a literal sets the prototype.
    steps: Object.fromEntries<Behaviour>([
      ['__proto__', () => ok({ leaked: true })],
      ['b', () => ok('b')],
    ]),
  });
  const arms = [step('__proto__'), step('b')];

  const expectOwnProto = (outcome: unknown): void => {
    expect(outcome).toMatchObject({ status: 'success' });
    expect('residue' in (outcome as object)).toBe(false);
    const record = (outcome as { output: Record<string, unknown> }).output;
    expect(Object.keys(record)).toEqual(['__proto__', 'b']);
    expect(Object.getOwnPropertyDescriptor(record, '__proto__')?.value).toStrictEqual({ leaked: true });
    // The prototype is untouched, so nothing the arm returned leaks onto unrelated reads.
    expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
    expect((record as { leaked?: unknown }).leaked).toBeUndefined();
  };

  it('keeps a __proto__ arm as an own key of the block output', async () => {
    expectOwnProto(await run(wf(fan('fan', arms)), protoRunner()));
  });

  it('keeps a __proto__ arm as an own key of the record handed to the next entry', async () => {
    expectOwnProto(await run(wf(fan('fan', arms), step('after')), protoRunner()));
  });
});

// ---------------------------------------------------------------------------------------------
// Non-vacuity, observed in a run. `tests/verify/parallel.test.ts` flips a verdict for every
// safeguard; these show the same removals producing a wrong *run*, through the `gadgets`
// override with a mutated copy of the real gadget's output — never by editing src.
// ---------------------------------------------------------------------------------------------

function rebuild(t: Transition, change: { readonly inputs?: readonly In[]; readonly resets?: readonly Place<unknown>[] }): Transition {
  const b = Transition.builder(t.name)
    .inputs(...(change.inputs ?? t.inputSpecs))
    .timing(t.timing)
    .priority(t.priority)
    .action(t.action);
  if (t.outputSpec !== null) b.outputs(t.outputSpec);
  for (const a of t.inhibitors) b.inhibitor(a.place);
  for (const p of change.resets ?? t.resets.map((a) => a.place)) b.reset(p);
  for (const r of t.reads) b.read(r.place);
  return b.build();
}

const mutate = (role: string, edit: (t: Transition) => Transition): Gadget => (entry, next, ctx) => {
  const result = parallelGadget(entry, next, ctx);
  const transitions = result.transitions.map((t) => (t.name.endsWith(`.${role}`) ? edit(t) : t));
  expect(transitions.filter((t, i) => t !== result.transitions[i])).toHaveLength(1);
  return { ...result, transitions };
};

const bypass = (exit: keyof Exits): Gadget => (entry, next, ctx) =>
  parallelGadget(entry, next, {
    ...ctx,
    emitNested: (s, p, n, exits, o) => ctx.emitNested(s, p, n, { ...exits, [exit]: ctx.exits[exit] } as Exits, o),
  });

describe('parallel: removing a safeguard breaks a run', () => {
  const twoArms = wf(fan('fan', [step('a'), step('b')]));
  const slowB = async (input: unknown): Promise<StepOutcome> => { await after(20); return tag('b')(input); };

  it('without the failure arrival deposit, a failing arm ends the run and strands its sibling', async () => {
    const runner = () => new RecordingRunner({ a: () => ({ status: 'failed', error: 'a!' }), b: slowB });

    expect(await run(twoArms, runner())).toStrictEqual({ status: 'failed', stepId: 'a', path: [0, 0], error: 'a!' });
    expect(await run(twoArms, runner(), bypass('failed')))
      .toStrictEqual({ status: 'failed', stepId: 'a', path: [0, 0], error: 'a!', residue: ['s.0.fan.arrived'] });
  });

  it('without the bail arrival deposit, a bailing arm ends the run and strands its sibling', async () => {
    const runner = () => new RecordingRunner({ a: () => ({ status: 'bailed', output: 'early' }), b: slowB });

    expect(await run(twoArms, runner())).toStrictEqual({ status: 'success', output: { b: 'x/b' } });
    expect(await run(twoArms, runner(), bypass('bailed')))
      // A bail now carries its origin (the arm that bailed), beside the residue the mutant leaves.
      .toStrictEqual({ status: 'success', output: 'early', bailed: true, stepId: 'a', path: [0, 0], residue: ['s.0.fan.arrived'] });
  });

  it('without the reset on susp-seen, a failure beside a suspension leaves the marker behind', async () => {
    const runner = () => new RecordingRunner({
      a: () => ({ status: 'suspended', suspendPayload: 'p' }),
      b: () => ({ status: 'failed', error: 'b!' }),
    });

    expect(await run(twoArms, runner())).toStrictEqual({ status: 'failed', stepId: 'b', path: [0, 1], error: 'b!' });
    expect(await run(twoArms, runner(), mutate('join-fail', (t) => rebuild(t, { resets: [] }))))
      .toStrictEqual({ status: 'failed', stepId: 'b', path: [0, 1], error: 'b!', residue: ['s.0.fan.susp-seen'] });
  });

  it('with one() instead of all() on err-seen, a second failure is left behind', async () => {
    const runner = () => new RecordingRunner({
      a: () => ({ status: 'failed', error: 'a!' }),
      b: () => ({ status: 'failed', error: 'b!' }),
    });
    const oneErr = mutate('join-fail', (t) =>
      rebuild(t, { inputs: t.inputSpecs.map((s) => (s.place.name.endsWith('.err-seen') ? one(s.place) : s)) }));

    expect(await run(twoArms, runner())).toStrictEqual({ status: 'failed', stepId: 'a', path: [0, 0], error: 'a!' });
    const mutated = await run(twoArms, runner(), oneErr);
    expect(mutated).toMatchObject({ status: 'failed', residue: ['s.0.fan.err-seen'] });
  });
});

// ---------------------------------------------------------------------------------------------
// Cancellation. Mastra checks its signal before each top-level entry (`default.ts:815`) and
// re-stamps a top-level entry's result after it (`handlers/entry.ts:815-817`), never inside a
// step. So the block is gated at its start and at nothing else: once `fork` fires, every arm runs.
// ---------------------------------------------------------------------------------------------

describe('parallel: cancellation', () => {
  const three = [step('a'), step('b'), step('c')];

  it('aborted before the block: canceled at the block, and no arm runs', async () => {
    const ac = new AbortController();
    const runner = new RecordingRunner({ before: (input) => { ac.abort(); return ok(input); } });

    const { outcome, stepResults } = await runWorkflowDetailed(
      compile(wf(step('before'), fan('fan', three), step('after'))),
      'x',
      { runner, signal: ac.signal },
    );

    // Swept at the block's gate: it never started.
    expect(outcome).toStrictEqual({ status: 'canceled', origin: { stepId: 'fan', path: [1] }, started: false });
    expect(runner.calls).toEqual(['before']);
    expect([...stepResults.keys()]).toEqual(['before']);
  });

  it('aborted before the run: the block as first entry is canceled, nothing runs', async () => {
    const ac = new AbortController();
    ac.abort();
    const runner = new RecordingRunner();

    expect(await runWorkflow(compile(wf(fan('fan', three))), 'x', { runner, signal: ac.signal }))
      .toStrictEqual({ status: 'canceled', origin: { stepId: 'fan', path: [0] }, started: false });
    expect(runner.calls).toEqual([]);
  });

  it('an empty block is gated too', async () => {
    const ac = new AbortController();
    const runner = new RecordingRunner({ before: (input) => { ac.abort(); return ok(input); } });

    expect(await runWorkflow(compile(wf(step('before'), fan('fan', []), step('after'))), 'x', { runner, signal: ac.signal }))
      .toStrictEqual({ status: 'canceled', origin: { stepId: 'fan', path: [1] }, started: false });
    expect(runner.calls).toEqual(['before']);
  });

  it('aborted while an arm runs: every arm still runs and is recorded, and the next entry never starts', async () => {
    const ac = new AbortController();
    const s = new Script();
    const runner = new RecordingRunner({
      a: s.at(0, 'a', (input) => { ac.abort(); return tag('a')(input); }),
      b: s.at(20, 'b', tag('b')),
      c: s.at(40, 'c', tag('c')),
    });

    const { outcome, stepResults } = await runWorkflowDetailed(
      compile(wf(fan('fan', three), step('after'))),
      'x',
      { runner, signal: ac.signal },
    );

    expect(s.settled).toEqual(['a', 'b', 'c']);
    expect(runner.calls).not.toContain('after');
    // The block succeeded; the next entry's own check is where the run stops.
    expect(outcome).toStrictEqual({ status: 'canceled', origin: { stepId: 'after', path: [1] }, started: false });
    for (const id of ['a', 'b', 'c']) {
      expect(stepResults.get(id)).toMatchObject({ status: 'success', output: `x/${id}`, payload: 'x' });
    }
  });

  it('aborted while an arm runs, block last: the settle stage re-stamps the success canceled', async () => {
    const ac = new AbortController();
    const runner = new RecordingRunner({
      a: (input) => { ac.abort(); return tag('a')(input); },
      b: async (input) => { await after(20); return tag('b')(input); },
    });

    const { outcome, stepResults } = await runWorkflowDetailed(
      compile(wf(fan('fan', [step('a'), step('b')]))),
      'x',
      { runner, signal: ac.signal },
    );

    // No origin: the run-end settle after the last entry's success — work that ran.
    expect(outcome).toStrictEqual({ status: 'canceled', started: true });
    expect(stepResults.get('a')).toMatchObject({ status: 'success', output: 'x/a' });
    expect(stepResults.get('b')).toMatchObject({ status: 'success', output: 'x/b' });
  });

  it('aborted while arms fail: canceled wins over the block\'s failure, the records keep the failure', async () => {
    const ac = new AbortController();
    const runner = new RecordingRunner({
      a: async () => { await after(20); return { status: 'failed', error: 'a!' }; },
      b: () => { ac.abort(); return { status: 'failed', error: 'b!' }; },
    });

    const { outcome, stepResults } = await runWorkflowDetailed(
      compile(wf(fan('fan', [step('a'), step('b')]), step('after'))),
      'x',
      { runner, signal: ac.signal },
    );

    // The block's failure (lowest index, `a`) settles first, then is re-stamped.
    // The settle stage re-stamps the block's failure: it ran, `started: true`.
    expect(outcome).toStrictEqual({ status: 'canceled', origin: { stepId: 'a', path: [0, 0] }, started: true });
    expect(runner.calls).not.toContain('after');
    expect(stepResults.get('a')).toMatchObject({ status: 'failed', error: 'a!' });
    expect(stepResults.get('b')).toMatchObject({ status: 'failed', error: 'b!' });
  });

  it('a retrying arm keeps retrying after the abort, as Mastra never checks between retries', async () => {
    const ac = new AbortController();
    const runner = new RecordingRunner({
      a: (input, call) => {
        if (call.attempt === 0) { ac.abort(); return { status: 'failed', error: 'first' }; }
        return tag('a')(input);
      },
    });

    const { outcome, stepResults } = await runWorkflowDetailed(
      compile(wf(fan('fan', [step('a', { retries: 2 }), step('b')]))),
      'x',
      { runner, signal: ac.signal },
    );

    expect(runner.attempts.filter((a) => a.stepId === 'a').map((a) => a.attempt)).toEqual([0, 1]);
    expect(stepResults.get('a')).toMatchObject({ status: 'success', output: 'x/a' });
    // No origin: the run-end settle after the last entry's success — work that ran.
    expect(outcome).toStrictEqual({ status: 'canceled', started: true });
  });

  it('a signal that never fires changes nothing, and the run does not hang', async () => {
    const signal = new AbortController().signal;
    const opts = (runner: RecordingRunner) => ({ runner, signal, timeoutMs: 5_000 });

    expect(await runWorkflow(compile(wf(fan('fan', three), step('after'))), 'x', opts(new RecordingRunner({
      a: tag('a'), b: tag('b'), c: tag('c'), after: (input) => ok({ saw: input }),
    })))).toStrictEqual({ status: 'success', output: { saw: { a: 'x/a', b: 'x/b', c: 'x/c' } } });

    expect(await runWorkflow(compile(wf(fan('fan', three))), 'x', opts(new RecordingRunner({
      b: () => ({ status: 'failed', error: 'b!' }),
    })))).toStrictEqual({ status: 'failed', stepId: 'b', path: [0, 1], error: 'b!' });

    expect(await runWorkflow(compile(wf(fan('fan', three))), 'x', opts(new RecordingRunner({
      c: () => ({ status: 'suspended', suspendPayload: 'pc' }),
    })))).toStrictEqual({ status: 'suspended', stepId: 'c', path: [0, 2], payload: 'pc' });

    expect(await runWorkflow(compile(wf(fan('fan', []))), 'x', opts(new RecordingRunner())))
      .toStrictEqual({ status: 'success', output: {} });
  });
});

describe('parallel: removing a cancellation safeguard breaks a run', () => {
  const dropInhibitor = (role: 'fork' | 'empty'): Gadget => mutate(role, (t) => {
    const b = Transition.builder(t.name).inputs(...t.inputSpecs).timing(t.timing).priority(t.priority).action(t.action);
    if (t.outputSpec !== null) b.outputs(t.outputSpec);
    return b.build();
  });
  const dropSweep: Gadget = (entry, next, ctx) => {
    const result = parallelGadget(entry, next, ctx);
    const transitions = result.transitions.filter((t) => !t.name.endsWith('.cancel'));
    expect(transitions).toHaveLength(result.transitions.length - 1);
    return { ...result, transitions };
  };
  const abortingBefore = () => {
    const ac = new AbortController();
    const runner = new RecordingRunner({ before: (input) => { ac.abort(); return ok(input); } });
    return { runner, signal: ac.signal };
  };
  const shape = wf(step('before'), fan('fan', [step('a'), step('b')]), step('after'));

  it('without the fork inhibitor, a block whose start was canceled still runs its arms', async () => {
    const control = abortingBefore();
    expect(await runWorkflow(compile(shape), 'x', { ...control, timeoutMs: 5_000 }))
      .toStrictEqual({ status: 'canceled', origin: { stepId: 'fan', path: [1] }, started: false });
    expect(control.runner.calls).toEqual(['before']);

    const mutated = abortingBefore();
    await runWorkflow(compile(shape, { gadgets: { parallel: dropInhibitor('fork') } }), 'x', { ...mutated, timeoutMs: 5_000 });
    expect(mutated.runner.calls.slice(1).sort()).toEqual(['a', 'b']);
  });

  it('without the sweep, the canceled block\'s input is stranded and no terminal is reached', async () => {
    const mutated = abortingBefore();
    // With a signal the executor ends only when a terminal is marked, so a stranded input runs
    // out the harness budget — the run rejects instead of classifying.
    await expect(
      runWorkflow(compile(shape, { gadgets: { parallel: dropSweep } }), 'x', { ...mutated, timeoutMs: 300 }),
    ).rejects.toThrow();
    expect(mutated.runner.calls).toEqual(['before']);
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

describe('parallel: the block\'s cancel sweep reports started false', () => {
  const shape = wf(step('before'), fan('fan', [step('a'), step('b')]), step('after'));
  const abortingBefore = () => {
    const ac = new AbortController();
    const runner = new RecordingRunner({ before: (input) => { ac.abort(); return ok(input); } });
    return { runner, signal: ac.signal };
  };

  it('a block swept at its gate never began: started false, no arm runs', async () => {
    const tap = tappedCanceled(parallelGadget);
    const control = abortingBefore();
    await runWorkflow(compile(shape, { gadgets: { parallel: tap.gadget } }), 'x', { ...control, timeoutMs: 5_000 });
    expect(tap.seen).toStrictEqual([{ origin: { stepId: 'fan', path: [1] }, started: false }]);
    expect(control.runner.calls).toEqual(['before']);
  });

  it('an empty block swept at its gate: started false', async () => {
    const tap = tappedCanceled(parallelGadget);
    const control = abortingBefore();
    await runWorkflow(compile(wf(step('before'), fan('fan', []), step('after')), { gadgets: { parallel: tap.gadget } }), 'x', {
      ...control,
      timeoutMs: 5_000,
    });
    expect(tap.seen).toStrictEqual([{ origin: { stepId: 'fan', path: [1] }, started: false }]);
  });

  it('a block that started writes nothing to its canceled exit: the settle stage or the next gate decides', async () => {
    const ac = new AbortController();
    const tap = tappedCanceled(parallelGadget);
    const runner = new RecordingRunner({ a: (input) => { ac.abort(); return tag('a')(input); } });
    await runWorkflow(compile(shape, { gadgets: { parallel: tap.gadget } }), 'x', { runner, signal: ac.signal, timeoutMs: 5_000 });
    expect(tap.seen).toStrictEqual([]);
  });

  it('a mutant whose sweep reports started true is caught', async () => {
    const tap = tappedCanceled(flippingStarted(parallelGadget, '.cancel'));
    await runWorkflow(compile(shape, { gadgets: { parallel: tap.gadget } }), 'x', { ...abortingBefore(), timeoutMs: 5_000 });
    expect(tap.seen).toStrictEqual([{ origin: { stepId: 'fan', path: [1] }, started: true }]);
  });
});

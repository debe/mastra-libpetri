import { describe, expect, it } from 'vitest';
import { Transition, one, type In, type Place } from 'libpetri';
import { compile, parallelGadget, type Gadget } from '../../src/compiler/index.js';
import { runWorkflow, runWorkflowDetailed } from '../../src/engine/index.js';
import type {
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
    expect(outcome).toStrictEqual({ status: 'failed', stepId: 'a', error: 'a!' });
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
    expect(outcome).toStrictEqual({ status: 'failed', stepId: 'a', error: 'a!' });
  });

  it('forwards a failing arm\'s tripwire, so the run ends tripwire', async () => {
    const runner = new RecordingRunner({
      b: () => ({ status: 'failed', error: 'blocked', tripwire: { reason: 'policy' } }),
    });

    const outcome = await run(wf(fan('fan', [step('a'), step('b')])), runner);

    expect(outcome).toStrictEqual({ status: 'tripwire', stepId: 'b', tripwire: { reason: 'policy' } });
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

    expect(await run(shape, plainFirst)).toStrictEqual({ status: 'failed', stepId: 'a', error: 'a!' });
    expect(await run(shape, tripwireFirst)).toStrictEqual({ status: 'tripwire', stepId: 'a', tripwire: { reason: 'policy' } });
  });

  it('lets a failure outrank a suspension, and leaves no suspension marker behind', async () => {
    const runner = new RecordingRunner({
      a: () => ({ status: 'suspended', payload: 'wait for approval' }),
      b: async () => { await after(10); return { status: 'failed', error: 'b!' }; },
    });

    const outcome = await run(wf(fan('fan', [step('a'), step('b')])), runner);

    expect(outcome).toStrictEqual({ status: 'failed', stepId: 'b', error: 'b!' });
  });

  it('settles every one of the five outcomes in one block, and the failure decides it', async () => {
    const runner = new RecordingRunner({
      ok: tag('ok'),
      bad: async () => { await after(15); return { status: 'failed', error: 'bad!' }; },
      wait: () => ({ status: 'suspended', payload: 'p' }),
      early: () => ({ status: 'bailed', output: 'early' }),
      sub: () => ({ status: 'paused' }),
    });

    const outcome = await run(
      wf(fan('fan', [step('ok'), step('bad'), step('wait'), step('early'), step('sub', { source: 'workflow' })]), step('after')),
      runner,
    );

    expect(runner.calls).not.toContain('after');
    expect(outcome).toStrictEqual({ status: 'failed', stepId: 'bad', error: 'bad!' });
  });

  it('treats a runner that throws as a failed arm', async () => {
    const boom = new Error('provider down');
    const runner = new RecordingRunner({
      a: () => { throw boom; },
      b: async (input) => { await after(10); return tag('b')(input); },
    });

    const outcome = await run(wf(fan('fan', [step('a'), step('b')])), runner);

    expect(outcome).toStrictEqual({ status: 'failed', stepId: 'a', error: boom });
  });

  it('fails a retrying arm only once its retries are spent', async () => {
    const runner = new RecordingRunner({ a: (_input, call) => ({ status: 'failed', error: `attempt ${call.attempt}` }) });

    const outcome = await run(wf(fan('fan', [step('a', { retries: 2 }), step('b')])), runner);

    expect(runner.attempts.filter((a) => a.stepId === 'a')).toHaveLength(3);
    expect(outcome).toStrictEqual({ status: 'failed', stepId: 'a', error: 'attempt 2' });
  });
});

describe('parallel: suspension', () => {
  it('suspends the block on the lowest-indexed suspended arm, and records every suspension', async () => {
    const s = new Script();
    const runner = new RecordingRunner({
      a: s.at(20, 'a', { status: 'suspended', payload: 'pa' }),
      b: s.at(0, 'b', tag('b')),
      c: s.at(0, 'c', { status: 'suspended', payload: 'pc' }),
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
    expect(stepResults.get('a')).toStrictEqual({ status: 'suspended', payload: 'pa' });
    expect(stepResults.get('c')).toStrictEqual({ status: 'suspended', payload: 'pc' });
  });

  it('picks the lowest index by path, exactly, even when two arms share an id', async () => {
    const runner = new RecordingRunner({
      a: async (_input, call) => {
        if (call.path[1] === 0) await after(20);
        return { status: 'suspended', payload: `arm ${call.path[1]}` };
      },
    });

    const outcome = await run(wf(fan('fan', [step('a'), step('a')])), runner);

    expect(outcome).toStrictEqual({ status: 'suspended', stepId: 'a', path: [0, 0], payload: 'arm 0' });
  });

  it('lets a suspension outrank a bail and a pause', async () => {
    const runner = new RecordingRunner({
      a: () => ({ status: 'bailed', output: 'early' }),
      b: () => ({ status: 'paused' }),
      c: async () => { await after(10); return { status: 'suspended', payload: 'pc' }; },
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
    emitNested: (s, p, n, exits) => ctx.emitNested(s, p, n, { ...exits, [exit]: ctx.exits[exit] } as Exits),
  });

describe('parallel: removing a safeguard breaks a run', () => {
  const twoArms = wf(fan('fan', [step('a'), step('b')]));
  const slowB = async (input: unknown): Promise<StepOutcome> => { await after(20); return tag('b')(input); };

  it('without the failure arrival deposit, a failing arm ends the run and strands its sibling', async () => {
    const runner = () => new RecordingRunner({ a: () => ({ status: 'failed', error: 'a!' }), b: slowB });

    expect(await run(twoArms, runner())).toStrictEqual({ status: 'failed', stepId: 'a', error: 'a!' });
    expect(await run(twoArms, runner(), bypass('failed')))
      .toStrictEqual({ status: 'failed', stepId: 'a', error: 'a!', residue: ['s.0.fan.arrived'] });
  });

  it('without the bail arrival deposit, a bailing arm ends the run and strands its sibling', async () => {
    const runner = () => new RecordingRunner({ a: () => ({ status: 'bailed', output: 'early' }), b: slowB });

    expect(await run(twoArms, runner())).toStrictEqual({ status: 'success', output: { b: 'x/b' } });
    expect(await run(twoArms, runner(), bypass('bailed')))
      .toStrictEqual({ status: 'success', output: 'early', bailed: true, residue: ['s.0.fan.arrived'] });
  });

  it('without the reset on susp-seen, a failure beside a suspension leaves the marker behind', async () => {
    const runner = () => new RecordingRunner({
      a: () => ({ status: 'suspended', payload: 'p' }),
      b: () => ({ status: 'failed', error: 'b!' }),
    });

    expect(await run(twoArms, runner())).toStrictEqual({ status: 'failed', stepId: 'b', error: 'b!' });
    expect(await run(twoArms, runner(), mutate('join-fail', (t) => rebuild(t, { resets: [] }))))
      .toStrictEqual({ status: 'failed', stepId: 'b', error: 'b!', residue: ['s.0.fan.susp-seen'] });
  });

  it('with one() instead of all() on err-seen, a second failure is left behind', async () => {
    const runner = () => new RecordingRunner({
      a: () => ({ status: 'failed', error: 'a!' }),
      b: () => ({ status: 'failed', error: 'b!' }),
    });
    const oneErr = mutate('join-fail', (t) =>
      rebuild(t, { inputs: t.inputSpecs.map((s) => (s.place.name.endsWith('.err-seen') ? one(s.place) : s)) }));

    expect(await run(twoArms, runner())).toStrictEqual({ status: 'failed', stepId: 'a', error: 'a!' });
    const mutated = await run(twoArms, runner(), oneErr);
    expect(mutated).toMatchObject({ status: 'failed', residue: ['s.0.fan.err-seen'] });
  });
});

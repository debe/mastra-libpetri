import { describe, expect, it } from 'vitest';
import { PrecompiledNetExecutor, tokenOf } from 'libpetri';
import { compile } from '../../src/compiler/index.js';
import { foreachGadget } from '../../src/compiler/gadgets/foreach.js';
import { classify, type RunOutcome } from '../../src/engine/index.js';
import type {
  CompiledWorkflow,
  EntryDescription,
  FlowToken,
  StepOutcome,
  StepRunner,
  WorkflowDescription,
} from '../../src/compiler/types.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Records when each item entered and left the body, and how many were inside at once.
 *
 * `holdUntil` is a barrier rather than a sleep: an item stays inside the body until that many
 * are in flight, so "did they overlap" is answered by the net admitting them and not by a timer
 * that could go either way on a loaded machine. `total` releases the tail, where fewer items
 * remain than the barrier wants. `graceMs` is only a backstop, so a net that *cannot* overlap
 * fails the assertion instead of hanging the suite.
 */
class LaneRunner implements StepRunner {
  readonly trace: string[] = [];
  inFlight = 0;
  maxInFlight = 0;
  entered = 0;

  constructor(
    private readonly options: {
      readonly holdUntil?: number;
      readonly total?: number;
      readonly graceMs?: number;
      readonly durations?: Readonly<Record<string, number>>;
      readonly failOn?: readonly string[];
    } = {},
  ) {}

  async run(_stepId: string, input: unknown): Promise<StepOutcome> {
    const label = String(input);
    this.entered++;
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    this.trace.push(`enter:${label}`);

    await this.hold(label);

    this.inFlight--;
    this.trace.push(`exit:${label}`);
    if (this.options.failOn?.includes(label)) return { status: 'failed', error: `boom:${label}` };
    return { status: 'success', output: `${label}!` };
  }

  exits(): string[] {
    return this.trace.filter((e) => e.startsWith('exit:'));
  }

  private async hold(label: string): Promise<void> {
    const duration = this.options.durations?.[label];
    if (duration !== undefined) return sleep(duration);

    const target = this.options.holdUntil;
    if (target === undefined) return;

    const deadline = Date.now() + (this.options.graceMs ?? 500);
    while (
      this.inFlight < target &&
      this.entered !== this.options.total &&
      Date.now() < deadline
    ) {
      await sleep(1);
    }
  }
}

/** For structural assertions only: compiling must not call a step. */
const inert: StepRunner = {
  async run(): Promise<StepOutcome> {
    throw new Error('inert runner must not be called');
  },
};

function workflow(concurrency: number): WorkflowDescription {
  return {
    id: 'batch',
    entries: [{ kind: 'foreach', id: 'items', body: { kind: 'step', id: 'body' }, concurrency }],
  };
}

function build(concurrency: number, runner: StepRunner): CompiledWorkflow {
  return compile(workflow(concurrency), { runner, gadgets: { foreach: foreachGadget } });
}

/**
 * Runs to quiescence and reports **every** place still holding a token, not just the outcome.
 *
 * `classify` reads the failure terminal first, so a failing run that also stranded tokens still
 * classifies as `failed`. The strand is the thing worth asserting — a token nobody can consume
 * is a hang in production and an unbounded place in the model — so the marking is read directly.
 */
async function run(
  concurrency: number,
  input: unknown,
  runner: StepRunner,
): Promise<{ outcome: RunOutcome; held: readonly string[] }> {
  const compiled = build(concurrency, runner);
  const executor = new PrecompiledNetExecutor(
    compiled.net,
    new Map([[compiled.entryPlace, [tokenOf<FlowToken>({ data: input })]]]),
  );
  const marking = await executor.run(10_000, 'close');
  const held = [...compiled.net.places]
    .filter((place) => marking.tokenCount(place) > 0)
    .map((place) => place.name)
    .sort();
  return { outcome: classify(compiled, marking), held };
}

/** The same, for shapes the single-entry helpers cannot express (nesting, a foreach mid-chain). */
async function runEntries(
  entries: readonly EntryDescription[],
  input: unknown,
  runner: StepRunner,
): Promise<{ outcome: RunOutcome; held: readonly string[] }> {
  const compiled = compile({ id: 'batch', entries }, { runner, gadgets: { foreach: foreachGadget } });
  const executor = new PrecompiledNetExecutor(
    compiled.net,
    new Map([[compiled.entryPlace, [tokenOf<FlowToken>({ data: input })]]]),
  );
  const marking = await executor.run(10_000, 'close');
  const held = [...compiled.net.places]
    .filter((place) => marking.tokenCount(place) > 0)
    .map((place) => place.name)
    .sort();
  return { outcome: classify(compiled, marking), held };
}

const foreachEntry = (
  concurrency: number,
  body: EntryDescription,
  id: string,
): EntryDescription => ({ kind: 'foreach', id, body, concurrency });

/**
 * For chains where the foreach is not the only entry: records `stepId` as well as the input, so
 * "the body never ran" can be asserted separately from "the surrounding steps ran", and passes
 * the array through untouched so the entry *before* a foreach still hands it an array.
 */
class ChainRunner implements StepRunner {
  readonly calls: string[] = [];

  constructor(private readonly failOn: readonly string[] = []) {}

  async run(stepId: string, input: unknown): Promise<StepOutcome> {
    this.calls.push(stepId);
    if (stepId !== 'body') return { status: 'success', output: input };
    const label = String(input);
    if (this.failOn.includes(label)) return { status: 'failed', error: `boom:${label}` };
    return { status: 'success', output: `${label}!` };
  }
}

describe('foreach', () => {
  it('runs items strictly one at a time at concurrency 1', async () => {
    const runner = new LaneRunner();
    const { outcome, held } = await run(1, ['a', 'b', 'c'], runner);

    // Sequencing is the single permit, not an iterator: no item may enter before the previous
    // one has left.
    expect(runner.trace).toEqual([
      'enter:a', 'exit:a',
      'enter:b', 'exit:b',
      'enter:c', 'exit:c',
    ]);
    expect(runner.maxInFlight).toBe(1);
    expect(outcome).toEqual({ status: 'success', output: ['a!', 'b!', 'c!'] });
    expect(held).toEqual(['wf.done']);
  });

  it('overlaps items above concurrency 1', async () => {
    const runner = new LaneRunner({ holdUntil: 2, total: 4 });
    const { outcome } = await run(2, ['a', 'b', 'c', 'd'], runner);

    // The barrier only releases once two items are inside the body at the same time, so
    // reaching the end at all is the overlap.
    expect(runner.maxInFlight).toBe(2);
    expect(runner.trace.slice(0, 2)).toEqual(['enter:a', 'enter:b']);
    expect(outcome).toEqual({ status: 'success', output: ['a!', 'b!', 'c!', 'd!'] });
  });

  it('caps in-flight work at the permit count', async () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f'];
    const runner = new LaneRunner({ holdUntil: 3, total: items.length });
    const { outcome, held } = await run(3, items, runner);

    // Three permits, three lanes, never a fourth item inside — the cap is the marking, so
    // there is no window in which a fourth could slip through.
    expect(runner.maxInFlight).toBe(3);
    expect(outcome.status).toBe('success');
    expect(held).toEqual(['wf.done']);
  });

  it('holds the cap and the order over many more items than lanes', async () => {
    const items = Array.from({ length: 20 }, (_, i) => `i${i}`);
    const runner = new LaneRunner({ holdUntil: 4, total: items.length });
    const { outcome, held } = await run(4, items, runner);

    // Five cursor rounds through four lanes: the cap is a property of the marking, not of how
    // many items happen to be in the array.
    expect(runner.maxInFlight).toBe(4);
    expect(outcome).toEqual({ status: 'success', output: items.map((i) => `${i}!`) });
    expect(held).toEqual(['wf.done']);
  });

  it('keeps output in input order when items finish out of order', async () => {
    const runner = new LaneRunner({ durations: { slow: 60, medium: 25, quick: 1 } });
    const { outcome } = await run(3, ['slow', 'medium', 'quick'], runner);

    // Completion order is the reverse of input order...
    expect(runner.exits()).toEqual(['exit:quick', 'exit:medium', 'exit:slow']);
    // ...and the output is not, because the index rides in the slot token and the join sorts
    // on it. Firing order carries no meaning.
    expect(outcome).toEqual({ status: 'success', output: ['slow!', 'medium!', 'quick!'] });
  });

  it('completes immediately on an empty array without running the body', async () => {
    const runner = new LaneRunner();
    const { outcome, held } = await run(2, [], runner);

    expect(runner.trace).toEqual([]);
    expect(outcome).toEqual({ status: 'success', output: [] });
    // No permit is seeded on the empty branch, so there is nothing left to strand.
    expect(held).toEqual(['wf.done']);
  });

  it('routes a failing item to the failure terminal without stranding its siblings', async () => {
    const runner = new LaneRunner({ failOn: ['b'] });
    const { outcome, held } = await run(2, ['a', 'b', 'c', 'd'], runner);

    expect(outcome).toEqual({ status: 'failed', stepId: 'body', error: 'boom:b' });
    // Every sibling still ran: the failed item gave its permit back like any other.
    expect(runner.exits().sort()).toEqual(['exit:a', 'exit:b', 'exit:c', 'exit:d']);
    // And nothing is left anywhere — no orphaned permit, slot, result or cursor. This is the
    // assertion that a "route the failure straight to wf.failed" design silently fails.
    expect(held).toEqual(['wf.failed']);
  });

  it('reports a non-array input as a failure rather than hanging', async () => {
    const { outcome, held } = await run(2, 'not-an-array', new LaneRunner());

    expect(outcome.status).toBe('failed');
    expect(held).toEqual(['wf.failed']);
  });

  it('puts the concurrency limit in the net, as one permit place per lane', () => {
    const compiled = build(3, inert);
    const places = [...compiled.net.places].map((place) => place.name);

    // A runtime concurrency option would leave no trace here, and could prove nothing.
    expect(places).toContain('s.0.items.lane0.permit');
    expect(places).toContain('s.0.items.lane2.permit');
    expect(places).not.toContain('s.0.items.lane3.permit');
  });

  it('instantiates the body once per lane so two items never share places', () => {
    const compiled = build(3, inert);
    const bodies = [...compiled.net.transitions]
      .map((transition) => transition.name)
      .filter((name) => name.endsWith('.body.run'))
      .sort();

    expect(bodies).toEqual(['t.0-0.body.run', 't.0-1.body.run', 't.0-2.body.run']);
  });

  it('rejects a concurrency a permit place cannot represent', () => {
    expect(() => build(0, inert)).toThrow(/integer >= 1/);
    expect(() => build(2.5, inert)).toThrow(/integer >= 1/);
    expect(() => build(1_000, inert)).toThrow(/lane limit/);
  });

  // ---------------------------------------------------------------------------------------
  // Stranded-token hunt.
  //
  // `classify` reads `wf.failed` first, so a failing run that *also* left a permit, slot,
  // cursor or result behind still reports `failed` — the outcome assertion alone cannot see
  // the defect. Every case below therefore asserts the residual marking exactly. A token with
  // no enabled consumer is a hang in production and an unbounded place in the model.
  // ---------------------------------------------------------------------------------------

  it('leaves nothing behind when several items fail at once', async () => {
    const runner = new LaneRunner({ failOn: ['b', 'c'], holdUntil: 3, total: 4 });
    const { outcome, held } = await run(3, ['a', 'b', 'c', 'd'], runner);

    // Two faults and two results coexist at the moment `abort` fires: `all(faults)` drains the
    // first pair, `reset(results)` is the consumer for the second. Drop either and a token
    // survives quiescence.
    expect(outcome.status).toBe('failed');
    expect(runner.exits().sort()).toEqual(['exit:a', 'exit:b', 'exit:c', 'exit:d']);
    expect(held).toEqual(['wf.failed']);
  });

  it('leaves nothing behind when every item fails', async () => {
    const items = ['a', 'b', 'c', 'd'];
    const { outcome, held } = await run(2, items, new LaneRunner({ failOn: items }));

    // `results` is empty here, so `join` is not merely inhibited by `faults` — `all(results)`
    // needs at least one token ([IO-006]) and could not fire anyway. `abort` is the only exit.
    expect(outcome.status).toBe('failed');
    expect(held).toEqual(['wf.failed']);
  });

  it('leaves no idle permit behind when there are more lanes than items', async () => {
    const { outcome, held } = await run(4, ['a'], new LaneRunner({ failOn: ['a'] }));

    // Three lanes never start. `join`/`abort` *consume* every permit rather than reading past
    // an inhibitor, which is what clears the ones that were never spent.
    expect(outcome.status).toBe('failed');
    expect(held).toEqual(['wf.failed']);
  });

  it('keeps a nested foreach failure inside its own lane', async () => {
    const inner = foreachEntry(2, { kind: 'step', id: 'body' }, 'inner');
    const runner = new LaneRunner({ failOn: ['c'] });
    const { outcome, held } = await runEntries(
      [foreachEntry(2, inner, 'outer')],
      [['a', 'b'], ['c', 'd']],
      runner,
    );

    // The inner gadget's `ctx.failed` is the outer lane's local failure place. If the override
    // were ignored the inner failure would reach `wf.failed` directly, leaving the outer lane's
    // permit, slot and the sibling lane's result stranded — visible only in this marking.
    expect(outcome).toEqual({ status: 'failed', stepId: 'body', error: 'boom:c' });
    expect(held).toEqual(['wf.failed']);
  });

  it('leaves nothing behind when a nested foreach gets a non-array item', async () => {
    const inner = foreachEntry(2, { kind: 'step', id: 'body' }, 'inner');
    const { outcome, held } = await runEntries(
      [foreachEntry(2, inner, 'outer')],
      ['not-an-array', ['c']],
      new LaneRunner(),
    );

    // The inner `split` takes its third branch *inside* a lane, so the failure has to travel
    // the same rescue/abort path a body failure does rather than short-circuiting.
    expect(outcome.status).toBe('failed');
    expect(held).toEqual(['wf.failed']);
  });

  it('leaves nothing behind when the foreach is not the last entry', async () => {
    const entries: readonly EntryDescription[] = [
      { kind: 'step', id: 'before' },
      foreachEntry(2, { kind: 'step', id: 'body' }, 'items'),
      { kind: 'step', id: 'after' },
    ];

    const ok = await runEntries(entries, ['a', 'b', 'c'], new ChainRunner());
    expect(ok.outcome).toEqual({ status: 'success', output: ['a!', 'b!', 'c!'] });
    expect(ok.held).toEqual(['wf.done']);

    // `next` is a live input place rather than a terminal, so a leftover token here would be a
    // second run of `after` rather than a quiet strand — and `after` must not run at all.
    const failing = new ChainRunner(['b']);
    const bad = await runEntries(entries, ['a', 'b', 'c'], failing);
    expect(bad.outcome.status).toBe('failed');
    expect(failing.calls).not.toContain('after');
    expect(bad.held).toEqual(['wf.failed']);
  });

  it('leaves nothing behind on the empty-array skip branch mid-chain', async () => {
    const entries: readonly EntryDescription[] = [
      foreachEntry(3, { kind: 'step', id: 'body' }, 'items'),
      { kind: 'step', id: 'after' },
    ];
    const runner = new ChainRunner();
    const { outcome, held } = await runEntries(entries, [], runner);

    // The "nothing happened" branch seeds no permit and no cursor at all, so there is no
    // allowance left over for `join`/`abort` to have to clean up — and the successor still runs.
    expect(runner.calls).toEqual(['after']);
    expect(outcome).toEqual({ status: 'success', output: [] });
    expect(held).toEqual(['wf.done']);
  });
});

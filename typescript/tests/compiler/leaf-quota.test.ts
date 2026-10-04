import { describe, expect, it } from 'vitest';
import { enumerateBranches, type Transition } from 'libpetri';
import { compile } from '../../src/compiler/index.js';
import { runWorkflowDetailed } from '../../src/engine/index.js';
import { describeClaim, verify, verifyWorkflow } from '../../src/verify/index.js';
import type {
  CompiledWorkflow,
  EntryDescription,
  QuotaRef,
  StepCall,
  StepDescription,
  StepOutcome,
  StepRunner,
  WorkflowDescription,
} from '../../src/compiler/types.js';
import { ManualClock } from '../support/manual-clock.js';

/**
 * The leaf's side of `limit` and `rateLimit` ([ADR 0012]): each attempt takes its quota tokens with
 * its permit in one firing and gives back — or, for a rate, spends into `spent` — on every branch;
 * a rate-limited attempt is announced by `request-j`, which deposits the `demand` the compiler's one
 * refill reads. The members the leaf asks for are fused into `wf.quota.<id>[.<role>]` by the
 * compiler (W1 D), so the arcs are asserted on the canonical names.
 *
 * Environment: the kernel with a scripted runner and the tests' `ManualClock`, libpetri 8.0.0 from
 * the registry (not linked). Runtime cases are tested, not proven. *At most `burst` per window* is a
 * timed property the untimed verifier cannot state: tested here, never claimed proven.
 */

const EPOCH = 1_700_000_000_000;
const wf = (...entries: EntryDescription[]): WorkflowDescription => ({ id: 'quota', entries });
const step = (id: string, extra: Omit<StepDescription, 'kind' | 'id'> = {}): StepDescription => ({ kind: 'step', id, ...extra });
const L1: QuotaRef = { id: 'L', kind: 'limit', n: 1 };
const R1: QuotaRef = { id: 'R', kind: 'rate', burst: 1, perMs: 1000 };

function latch(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}
async function turns(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

type Script = (input: unknown, call: StepCall) => StepOutcome | Promise<StepOutcome>;
class ScriptedRunner implements StepRunner {
  readonly calls: { readonly stepId: string; readonly call: StepCall }[] = [];
  constructor(readonly script: Readonly<Record<string, Script>>) {}
  async run(stepId: string, input: unknown, call: StepCall): Promise<StepOutcome> {
    this.calls.push({ stepId, call });
    const fn = Object.hasOwn(this.script, stepId) ? this.script[stepId] : undefined;
    return fn === undefined ? { status: 'success', output: input } : fn(input, call);
  }
}

const transitionNamed = (compiled: CompiledWorkflow, name: string): Transition => {
  const t = [...compiled.net.transitions].find((x) => x.name === name);
  if (t === undefined) throw new Error(`no transition '${name}'`);
  return t;
};
const ins = (t: Transition): string[] => t.inputSpecs.map((s) => s.place.name);
/** Each Xor branch of a transition's output, as the sorted names of the places it deposits into. */
const branches = (t: Transition): string[][] => enumerateBranches(t.outputSpec!).map((b) => [...b].map((p) => p.name).sort());

describe('leaf quotas — arcs', () => {
  it('limit: every attempt takes one quota token with its permit and returns it on every branch', () => {
    const compiled = compile(wf(step('a', { quotas: [L1], retries: 1, timeoutMs: 50 }), step('b', { quotas: [L1] })), { concurrency: 2 });
    expect(compiled.steps.map((c) => c.quotas)).toEqual([['L'], ['L']]);
    const a = compiled.steps.find((c) => c.stepId === 'a')!;
    const attempts = compiled.steps.flatMap((c) => c.attempts);
    expect(attempts).toHaveLength(3);
    for (const name of attempts) {
      const t = transitionNamed(compiled, name);
      expect(ins(t)).toEqual([expect.stringMatching(/\.(in|attempt-1)$/), 'wf.permits', 'wf.quota.L']);
      for (const branch of branches(t)) {
        expect(branch).toContain('wf.quota.L');
        expect(branch).toContain('wf.permits');
        expect(branch).toHaveLength(3);
      }
    }
    // The timed-out branch is among them ([ADR 0013]).
    expect(branches(transitionNamed(compiled, a.attempts[0]!))).toContainEqual(['s.0.a.timed-out-0', 'wf.permits', 'wf.quota.L'].sort());
    expect(compiled.pools.find((p) => p.kind === 'limit')).toMatchObject({ seed: 1 });
    const pool = compiled.pools.find((p) => p.kind === 'limit')!;
    expect([...pool.takers].sort()).toEqual([...attempts].sort());
    expect([...pool.givers].sort()).toEqual([...attempts].sort());
  });

  it('rate: request-j announces demand, the attempt takes ready + demand + bucket and spends on every branch', () => {
    const compiled = compile(wf(step('a', { quotas: [R1], retries: 1 })), { concurrency: 1 });
    const chain = compiled.steps[0]!;
    expect(chain.quotas).toEqual(['R']);

    const r0 = transitionNamed(compiled, 't.0.a.request-0');
    const r1 = transitionNamed(compiled, 't.0.a.request-1');
    expect(ins(r0)).toEqual(['s.0.a.in']);
    expect(ins(r1)).toEqual(['s.0.a.attempt-1']);
    expect(branches(r0)).toEqual([['s.0.a.ready-0', 'wf.quota.R.demand']]);
    expect(branches(r1)).toEqual([['s.0.a.ready-1', 'wf.quota.R.demand']]);
    // Mastra's check before an entry: the first request is the gate; no retry is gated.
    expect(r0.inhibitors.map((a) => a.place.name)).toEqual(['wf.cancel']);
    expect(r1.inhibitors).toEqual([]);

    chain.attempts.forEach((name, j) => {
      const t = transitionNamed(compiled, name);
      expect(ins(t)).toEqual([`s.0.a.ready-${j}`, 'wf.permits', 'wf.quota.R.demand', 'wf.quota.R']);
      expect(t.inhibitors).toEqual([]);
      for (const branch of branches(t)) {
        expect(branch).toContain('wf.quota.R.spent');
        expect(branch).toContain('wf.permits');
        expect(branch).not.toContain('wf.quota.R');
      }
    });
    // The refill is the compiler's, one per quota — never the leaf's.
    const refills = [...compiled.net.transitions].filter((t) => t.name.startsWith('t.quota.'));
    expect(refills.map((t) => t.name)).toEqual(['t.quota.R.refill']);
  });

  it('refuses a step that names one quota twice', () => {
    expect(() => compile(wf(step('a', { quotas: [L1, L1] })))).toThrow(/quota 'L' (more than once|twice)/);
  });
});

describe('leaf quotas — runtime (ManualClock)', () => {
  it('limit(1) over three parallel arms runs one at a time', async () => {
    const clock = new ManualClock(EPOCH);
    let inFlight = 0;
    let peak = 0;
    const body: Script = async (input) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await turns(3);
      inFlight--;
      return { status: 'success', output: input };
    };
    const runner = new ScriptedRunner({ a: body, b: body, c: body });
    const { outcome } = await runWorkflowDetailed(
      compile(wf({ kind: 'parallel', id: 'p', arms: ['a', 'b', 'c'].map((id) => step(id, { quotas: [L1] })) })),
      'in',
      { runner, clock },
    );
    expect(outcome.status).toBe('success');
    expect(runner.calls).toHaveLength(3);
    expect(peak).toBe(1);
  });

  it('rateLimit(1, 1000): every attempt, retries included, spends one token; attempts land at 0, 1000, 2000', async () => {
    const clock = new ManualClock(EPOCH);
    const at: number[] = [];
    const runner = new ScriptedRunner({
      a: () => {
        at.push(clock.now());
        return { status: 'failed', error: new Error('busy') };
      },
    });
    const { outcome } = await runWorkflowDetailed(compile(wf(step('a', { quotas: [R1], retries: 2 }))), 'in', { runner, clock });
    expect(outcome.status).toBe('failed');
    expect(at).toEqual([0, 1000, 2000]);
  });

  it('a timed-out attempt keeps its limit token until the step settles', async () => {
    const clock = new ManualClock(EPOCH);
    const release = latch();
    const order: string[] = [];
    const runner = new ScriptedRunner({
      a: async () => {
        order.push('a:start');
        await release.promise;
        order.push('a:return');
        return { status: 'success', output: 'a' };
      },
      b: () => {
        order.push('b:start');
        return { status: 'success', output: 'b' };
      },
    });
    const run = runWorkflowDetailed(
      compile(wf({ kind: 'parallel', id: 'p', arms: [step('a', { quotas: [L1], timeoutMs: 100 }), step('b', { quotas: [L1] })] })),
      'in',
      { runner, clock },
    );
    await turns();
    await aborted(runner.calls[0]!.call.deadline!);
    await turns();
    expect(order).toEqual(['a:start']);
    release.release();
    const { outcome } = await run;
    expect(order).toEqual(['a:start', 'a:return', 'b:start']);
    expect(outcome.status).toBe('failed');
  });
});

describe('leaf quotas — proofs', () => {
  const nets: readonly [string, () => CompiledWorkflow][] = [
    ['limit(1) shared by two steps, one with a timeout and a retry, k=2', () =>
      compile(wf(step('a', { quotas: [L1], retries: 1, timeoutMs: 50 }), step('b', { quotas: [L1] })), { concurrency: 2 })],
    ['limit(1) over a parallel of two arms, unbounded', () =>
      compile(wf({ kind: 'parallel', id: 'p', arms: [step('a', { quotas: [L1] }), step('b', { quotas: [L1] })] }))],
    ['rateLimit(1, 1000) with a retry, k=1', () => compile(wf(step('a', { quotas: [R1], retries: 1 })), { concurrency: 1 })],
  ];
  for (const [label, build] of nets) {
    it(`${label}: every completion property is proven (closed, cancel and resume segments)`, async () => {
      const compiled = build();
      const started = performance.now();
      const reports = await verifyWorkflow(compiled, { restart: 'none' });
      const ms = Math.round(performance.now() - started);
      console.log(
        `[leaf-quota] ${label}: ${reports.length} completion proofs in ${ms} ms (libpetri 8.0.0, registry)\n  ` +
          reports.map((r) => `${typeof r.segment === 'string' ? r.segment : JSON.stringify(r.segment)}/${r.property}: ${r.result.verdict.type}`).join('\n  '),
      );
      expect(reports.length).toBeGreaterThan(0);
      for (const r of reports) expect(`${r.property}: ${r.result.verdict.type}`).toBe(`${r.property}: proven`);
    });
  }

  it('a rate and a limit on a timed, retried step, sharing the limit with another: every claim of verify() holds', async () => {
    const compiled = compile(wf(step('a', { quotas: [R1, L1], retries: 1, timeoutMs: 50 }), step('b', { quotas: [L1] })), { concurrency: 1 });
    const started = performance.now();
    const report = await verify(compiled, { restart: 'none' });
    const ms = Math.round(performance.now() - started);
    console.log(`[leaf-quota] verify() rate+limit+timeout: ${report.claims.length} claims in ${ms} ms (libpetri 8.0.0, registry)\n  ${report.claims.map(describeClaim).join('\n  ')}`);
    for (const claim of report.claims) expect(`${claim.property}: ${String(claim.holds)}`).toBe(`${claim.property}: true`);
    // Liveness reaches every attempt and every timedOut_j through its funnel.
    const live = report.claims.filter((c) => c.family === 'liveness').map((c) => c.property);
    expect(live).toEqual(expect.arrayContaining(['live(t.0.a.timeout-0)', 'live(t.0.a.timeout-1)']));
    expect(report.holds).toBe(true);
  }, 60_000);
});

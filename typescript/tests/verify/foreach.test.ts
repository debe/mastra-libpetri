import { describe, expect, it } from 'vitest';
import { SmtVerifier, mutualExclusion, placeBound } from 'libpetri/verification';
import type { Place } from 'libpetri';
import { compile } from '../../src/compiler/index.js';
import { foreachGadget } from '../../src/compiler/gadgets/foreach.js';
import { verifyWorkflow, describeReport } from '../../src/verify/index.js';
import { inertRunner } from '../fixtures/runner.js';
import type { EntryDescription, WorkflowDescription } from '../../src/compiler/types.js';

/**
 * `.foreach`, proved.
 *
 * The gadget is registered explicitly rather than taken from `defaultGadgets()`, which still
 * carries `unimplemented('foreach')` — the same isolation the implementation test uses.
 *
 * **Why both properties, and why `proven` specifically.** `DeadlockFree` fails on a quiescent
 * marking holding a token outside the declared sinks ([VER-013]), which is exactly the stranded
 * permit / stranded slot / stranded result this design is most at risk of. `TerminatesAtSink`
 * fails on a quiescent marking with no sink marked. Asserting both says "nothing is stranded"
 * *and* "a terminal is actually reached". `isViolated()` is false for `unknown` as well, so a
 * "not violated" assertion would keep passing once a query started timing out; the verdict type
 * is compared to the string instead.
 */

const foreach = (
  concurrency: number,
  body: EntryDescription = { kind: 'step', id: 'body' },
  id = 'items',
): EntryDescription => ({ kind: 'foreach', id, body, concurrency });

function build(entries: readonly EntryDescription[]): ReturnType<typeof compile> {
  const description: WorkflowDescription = { id: 'batch', entries };
  return compile(description, { runner: inertRunner, gadgets: { foreach: foreachGadget } });
}

async function prove(entries: readonly EntryDescription[]): Promise<void> {
  const reports = await verifyWorkflow(build(entries), { timeoutMs: 120_000 });
  for (const report of reports) {
    expect(report.result.verdict.type, describeReport(report)).toBe('proven');
  }
  expect(reports.map((r) => r.property)).toEqual(['deadlockFree', 'terminatesAtSink']);
}

describe('compiled foreach, proved', () => {
  it('is deadlock-free and terminates at a sink with one lane', async () => {
    // One lane is the degenerate case and the one Mastra defaults to. The `all(results)` drain
    // and the `reset(results)` on abort are already present here, so a proof that closes at
    // concurrency 1 is already saying those arcs leave no token behind.
    await prove([foreach(1)]);
  }, 180_000);

  it('is deadlock-free and terminates at a sink with two lanes', async () => {
    // Two lanes is where the interesting interleavings start: one lane may fail while the other
    // is still mid-item, so `join` (inhibited by faults) and `abort` (requiring one) must be
    // structurally exclusive *and* between them must consume every permit, slot and result.
    await prove([foreach(2)]);
  }, 180_000);

  it('is deadlock-free and terminates at a sink with three lanes', async () => {
    // Three is the first width where two lanes can hold faults while a third still holds a
    // permit, which is the marking a "fail fast to wf.failed" design strands.
    await prove([foreach(3)]);
  }, 180_000);

  it('stays provable when the foreach is not the last entry', async () => {
    // `next` is then another entry's input place rather than `wf.done`, so the empty-array
    // branch of `split` and the `join` branch both deposit into live structure. A gadget that
    // assumed it was writing to a terminal would show up here.
    await prove([
      { kind: 'step', id: 'before' },
      foreach(2),
      { kind: 'step', id: 'after' },
    ]);
  }, 180_000);

  it('stays provable when a foreach is nested inside a foreach', async () => {
    // The inner gadget's `ctx.failed` is the outer lane's local failure place, not `wf.failed`.
    // If that override were ignored anywhere, the inner failure would jump the fence and strand
    // the outer lane's permit and slot — which is what `DeadlockFree` reports.
    //
    // Held to 1x1: the net is O(concurrency x |body|) per level, so 2x2 is four body copies and
    // Z3 returns `unknown` on `DeadlockFree` there within two minutes. See the report.
    await prove([foreach(1, foreach(1, { kind: 'step', id: 'body' }, 'inner'), 'outer')]);
  }, 180_000);

  // ---------------------------------------------------------------------------------------
  // The invariants the gadget's doc comment claims, checked rather than asserted.
  //
  // `verifyWorkflow` only runs the two workflow-level properties, so these go through
  // `SmtVerifier` directly. They are the load-bearing structural facts: if `permit.l` and
  // `slot.l` were ever both marked, a lane could take a second item while the first was still
  // running and `collect.l` would pair a result with the wrong index.
  // ---------------------------------------------------------------------------------------

  const verifier = (compiled: ReturnType<typeof compile>) =>
    SmtVerifier.forNet(compiled.net)
      .initialMarking((m) => m.tokens(compiled.entryPlace, 1))
      .sinkPlaces(compiled.donePlace, compiled.failedPlace)
      .semiflowInvariants(true)
      .timeout(60_000);

  const placeNamed = (compiled: ReturnType<typeof compile>, name: string): Place<unknown> => {
    const found = [...compiled.net.places].find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`no place '${name}' in the compiled net`);
    return found as Place<unknown>;
  };

  it('proves every per-lane place 1-bounded and the permit/slot pair exclusive', async () => {
    const compiled = build([foreach(2)]);
    const at = (name: string): Place<unknown> => placeNamed(compiled, name);

    const oneBounded = [
      's.0.items.in',
      // 1-bounded `cursor` is what makes the index unique: two cursors would hand two lanes the
      // same index and `join` would emit a duplicate and drop an item.
      's.0.items.cursor',
      's.0.items.lane0.permit', 's.0.items.lane0.slot',
      's.0.items.lane0.done', 's.0.items.lane0.failed',
      's.0.items.lane1.permit', 's.0.items.lane1.slot',
      's.0.items.lane1.done', 's.0.items.lane1.failed',
    ];

    for (const name of oneBounded) {
      const result = await verifier(compiled).property(placeBound(at(name), 1)).verify();
      expect(result.verdict.type, `${name}: ${result.verdict.type}`).toBe('proven');
    }

    for (const lane of [0, 1]) {
      const result = await verifier(compiled)
        .property(mutualExclusion(at(`s.0.items.lane${lane}.permit`), at(`s.0.items.lane${lane}.slot`)))
        .verify();
      expect(result.verdict.type, `lane${lane} permit/slot: ${result.verdict.type}`).toBe('proven');
    }
  }, 180_000);

  it('records that results and faults are genuinely unbounded', async () => {
    const compiled = build([foreach(2)]);

    // Not a strand — `DeadlockFree` proves above, so every one of these tokens has a consumer —
    // but their count is the input array's length, which is data the model cannot see. The
    // verifier returns a real counterexample (dispatch, collect, dispatch again), so this is a
    // checked limitation rather than a suspicion. It also means no bounded-state-space route can
    // decide anything about this net: the SMT state-equation route is the only one that closes.
    // The structural fix needs a `maxItems` on the foreach `EntryDescription` to seed a budget
    // place; `src/compiler/types.ts` does not carry one.
    for (const name of ['s.0.items.results', 's.0.items.faults']) {
      const result = await verifier(compiled)
        .property(placeBound(placeNamed(compiled, name), 1))
        .verify();
      expect(result.verdict.type, `${name}: ${result.verdict.type}`).toBe('violated');
    }
  }, 180_000);
});

import type { In, Transition } from 'libpetri';
import { WF_SLOTS, pathSegment } from '../compiler/names.js';
import type { CompiledWorkflow, Pool } from '../compiler/types.js';
import { branchesOf, describeBranch, describeIn } from './budget.js';

/**
 * Checks, from the arcs alone, that every pool of the net is conserved ([ADR 0012]) — the run
 * permits ([ADR 0006]), every block's slots ([ADR 0011]), every `limit` quota and every `rateLimit`
 * bucket. It generalises `budgetStructureViolations`, which keeps its export and its rules for the
 * permits, and is host-agnostic: it reads only `CompiledWorkflow.pools`, `steps` and the net (an M10
 * candidate).
 *
 * For each pool `P` with conservation vector `V` = `P.place` at weight 1 plus `P.holders`:
 *
 * 1. **The pool exists.** `P.place` and every holder are places of the net, and every declared
 *    taker and giver is one of its transitions.
 * 2. **Takers take exactly one.** A transition with an input arc on `P.place` is one of `P.takers`,
 *    and that arc is `one(P.place)` (or `exactly(1, …)`), its only arc there. Every declared taker has
 *    one.
 * 3. **Givers give exactly one.** A transition producing into `P.place` is one of `P.givers`, and
 *    every branch of its output spec — walked as a multiset, so a place named twice counts twice
 *    ([IO-016]) — puts exactly one token there. Every declared giver does.
 * 4. **Every branch conserves `V`.** For every transition with an arc on a place of `V`, every branch
 *    of its output spec produces, weighted over `V`, exactly what its inputs consume weighted over
 *    `V`. An attempt that takes a permit or a quota and returns it on every branch passes; one that
 *    keeps it on its failure branch, or mints one, does not. A branch rule 3 already refuted is not
 *    reported again here, and an input that takes a data-dependent count (`all`, `atLeast`) of a
 *    place of `V` is refused outright: its weight is not a property of the arcs.
 * 5. **Nothing reads or resets `V`.** No read arc and no reset arc on any place of `V`; the one
 *    exception in the whole net is a bucket's refill reading its `demand`, which is not in `V`. An
 *    inhibitor moves nothing and is not flagged.
 * 6. **A bucket's refill is its only.** `P.refill` is `one(spent), read(demand)` → `P.place` with a
 *    `delayed(P.perMs)` timing and is the bucket's only giver, `spent` is a holder at weight 1, and
 *    no other transition reads `demand`.
 * 7. **One permits pool, matching `budget`.** At most one `permits` pool, present exactly when
 *    `compiled.budget` is, with the same place and `seed === k`.
 * 8. **A slot-limited arm runs only once admitted.** For a `slots` pool `wf.slots.<path>`, every
 *    step chain under `<path>` (its arms: `<path>-<j>…`) is entered only by the pool's takers — every
 *    transition producing into the chain's input place is an `admit-j` or `re-admit-j`. A block
 *    compiled with its fork still feeding an arm directly runs that arm without a slot, and the
 *    collect then returns a slot nobody took; rules 1–5 see only the collect, which is conserving.
 *
 * Places are compared **by name**, as `budgetStructureViolations` compares them: `place()` does not
 * intern, and fusion leaves only the canonical name in the net.
 *
 * Returns one line per violation, prefixed by the pool place's name; empty means sound, and is always
 * empty for a net with no pools.
 */
export function poolStructureViolations(compiled: CompiledWorkflow): readonly string[] {
  const out: string[] = [];
  const transitions = [...compiled.net.transitions];
  const placeNames = new Set([...compiled.net.places].map((p) => p.name));
  const byName = new Map(transitions.map((t) => [t.name, t]));

  // Rule 7.
  const permits = compiled.pools.filter((p) => p.kind === 'permits');
  if (permits.length > 1) out.push(`${permits.length} permits pools [${permits.map((p) => p.place.name).join(', ')}]; a run has at most one`);
  const budget = compiled.budget;
  const first = permits[0];
  if (budget !== undefined && first === undefined) out.push(`${budget.permits.name}: a budget of ${budget.k} is compiled in and no permits pool declares it`);
  if (budget === undefined && first !== undefined) out.push(`${first.place.name}: a permits pool with no budget compiled in`);
  if (budget !== undefined && first !== undefined) {
    if (first.place.name !== budget.permits.name) out.push(`${first.place.name}: the permits pool is not the budget's place '${budget.permits.name}'`);
    if (first.seed !== budget.k) out.push(`${first.place.name}: the permits pool is seeded ${first.seed}; the budget is ${budget.k}`);
  }

  for (const pool of compiled.pools) {
    const name = pool.place.name;
    const say = (line: string): void => {
      out.push(`${name}: ${line}`);
    };
    const weights = new Map<string, number>([[name, 1]]);
    for (const h of pool.holders) weights.set(h.place, (weights.get(h.place) ?? 0) + h.weight);
    const takers = new Set(pool.takers);
    const givers = new Set(pool.givers);

    // Rule 1.
    if (!placeNames.has(name)) say('the pool place is not in the net');
    if (!Number.isSafeInteger(pool.seed) || pool.seed < 1) say(`the pool is seeded ${pool.seed}; a pool holds a whole number ≥ 1`);
    for (const h of pool.holders) {
      if (!placeNames.has(h.place)) say(`holder '${h.place}' is not in the net`);
      if (h.place === name) say('the pool place is listed as its own holder');
      if (!Number.isSafeInteger(h.weight) || h.weight < 1) say(`holder '${h.place}' has weight ${h.weight}; a holder's weight is a whole number ≥ 1`);
    }
    for (const t of pool.takers) if (!byName.has(t)) say(`declares taker '${t}', which is not a transition of the net`);
    for (const t of pool.givers) if (!byName.has(t)) say(`declares giver '${t}', which is not a transition of the net`);

    for (const t of transitions) {
      const takes = t.inputSpecs.filter((spec) => spec.place.name === name);
      const branches = t.outputSpec === null ? [] : branchesOf(t.outputSpec);
      const gives = branches.some((b) => (b.get(name) ?? 0) > 0);

      // Rule 2.
      if (takes.length > 0 && !takers.has(t.name)) say(`'${t.name}' takes from the pool but is not one of its takers`);
      if (takes.length === 0 && takers.has(t.name)) say(`'${t.name}' is a declared taker and takes nothing from the pool`);
      if (takes.length > 1) say(`'${t.name}' has ${takes.length} input arcs on the pool; a taker takes exactly one`);
      for (const spec of takes) if (!takesOne(spec)) say(`'${t.name}' consumes the pool with ${describeIn(spec)}; a taker takes exactly one`);

      // Rule 3.
      const refuted = new Set<number>();
      if (gives && !givers.has(t.name)) {
        say(`'${t.name}' gives to the pool but is not one of its givers`);
        branches.forEach((branch, i) => {
          if ((branch.get(name) ?? 0) > 0) refuted.add(i);
        });
      }
      if (givers.has(t.name)) {
        if (t.outputSpec === null) say(`'${t.name}' is a declared giver and has no output spec`);
        branches.forEach((branch, i) => {
          const n = branch.get(name) ?? 0;
          if (n !== 1) {
            refuted.add(i);
            say(`'${t.name}' branch ${i} (${describeBranch(branch)}) gives ${n}; a giver gives exactly one on every branch`);
          }
        });
      }

      // Rule 5.
      for (const arc of t.reads) if (weights.has(arc.place.name)) say(`'${t.name}' reads '${arc.place.name}'; nothing reads a pool or its holders`);
      for (const arc of t.resets) if (weights.has(arc.place.name)) say(`'${t.name}' resets '${arc.place.name}'; nothing resets a pool or its holders`);

      // Rule 4.
      const onVector = t.inputSpecs.filter((spec) => weights.has(spec.place.name));
      const touches = onVector.length > 0 || branches.some((b) => [...b.keys()].some((p) => weights.has(p)));
      if (!touches) continue;
      const counted = onVector.filter((spec) => spec.type === 'one' || spec.type === 'exactly');
      for (const spec of onVector) {
        if (spec.type !== 'one' && spec.type !== 'exactly' && spec.place.name !== name) say(`'${t.name}' consumes holder '${spec.place.name}' with ${describeIn(spec)}; a pool moves a counted number of tokens`);
      }
      if (counted.length !== onVector.length) continue;
      const taken = counted.reduce((sum, spec) => sum + countOf(spec) * weights.get(spec.place.name)!, 0);
      if (t.outputSpec === null) {
        if (taken > 0) say(`'${t.name}' takes ${taken} of the pool and its holders and has no output spec to return them on`);
        continue;
      }
      branches.forEach((branch, i) => {
        if (refuted.has(i)) return;
        const left = [...branch].reduce((sum, [p, n]) => sum + n * (weights.get(p) ?? 0), 0);
        if (left !== taken) say(`'${t.name}' branch ${i} (${describeBranch(branch)}) leaves ${left} where it took ${taken}: the pool and its holders are not conserved`);
      });
    }

    // Rule 6.
    if (pool.kind === 'bucket') {
      const spent = pool.spent.name;
      const demand = pool.demand.name;
      if (!placeNames.has(demand)) say(`the demand place '${demand}' is not in the net`);
      if (pool.holders.length !== 1 || pool.holders[0]!.place !== spent || pool.holders[0]!.weight !== 1) {
        say(`holders are [${pool.holders.map((h) => `${h.place}×${h.weight}`).join(', ')}]; a bucket's only holder is its spent place '${spent}' at weight 1`);
      }
      if (pool.givers.length !== 1 || pool.givers[0] !== pool.refill) {
        say(`givers are [${pool.givers.join(', ')}]; a bucket's only giver is its refill '${pool.refill}'`);
      }
      const refill = byName.get(pool.refill);
      if (refill === undefined) {
        if (!pool.givers.includes(pool.refill)) say(`the refill '${pool.refill}' is not a transition of the net`);
      } else {
        const ins = refill.inputSpecs;
        if (ins.length !== 1 || ins[0]!.place.name !== spent || !takesOne(ins[0]!)) {
          say(`the refill '${refill.name}' consumes [${ins.map((s) => `${describeIn(s)} ${s.place.name}`).join(', ')}]; it consumes exactly one() '${spent}'`);
        }
        const reads = refill.reads.map((a) => a.place.name);
        if (reads.length !== 1 || reads[0] !== demand) say(`the refill '${refill.name}' reads [${reads.join(', ')}]; it reads exactly '${demand}'`);
        if (refill.timing.type !== 'delayed' || refill.timing.afterMs !== pool.perMs) {
          say(`the refill '${refill.name}' is ${describeTiming(refill)}; it is delayed(${pool.perMs})`);
        }
        const outs = [...refill.outputPlaces()].map((p) => p.name);
        if (outs.length !== 1 || outs[0] !== name) say(`the refill '${refill.name}' produces into [${outs.join(', ')}]; it produces into the bucket alone`);
      }
      for (const t of transitions) {
        if (t.name !== pool.refill && t.reads.some((a) => a.place.name === demand)) say(`'${t.name}' reads the demand '${demand}'; only the refill '${pool.refill}' may`);
      }
    }

    // Rule 8.
    if (pool.kind === 'slots') {
      const prefix = `${WF_SLOTS}.`;
      if (!name.startsWith(prefix)) say(`a slot pool is named '${WF_SLOTS}.<path>'`);
      const block = name.slice(prefix.length);
      for (const chain of compiled.steps) {
        if (!pathSegment(chain.path).startsWith(`${block}-`)) continue;
        for (const t of transitions) {
          if (takers.has(t.name)) continue;
          if ([...t.outputPlaces()].some((p) => p.name === chain.inPlace)) {
            say(`'${t.name}' produces into arm input '${chain.inPlace}' and is not one of the pool's takers: the arm runs without admission`);
          }
        }
      }
    }
  }

  return out;
}

/** `one(p)` or `exactly(1, p)`: the only arcs that take a single token whatever is marked. */
function takesOne(spec: In): boolean {
  return spec.type === 'one' || (spec.type === 'exactly' && spec.count === 1);
}

/** Tokens a counted arc takes: one for `one`, its count for `exactly`; `all` / `atLeast` are refused before. */
function countOf(spec: In): number {
  return spec.type === 'exactly' ? spec.count : 1;
}

function describeTiming(t: Transition): string {
  const timing = t.timing;
  switch (timing.type) {
    case 'immediate': return 'immediate';
    case 'deadline': return `deadline(${timing.byMs})`;
    case 'delayed': return `delayed(${timing.afterMs})`;
    case 'window': return `window(${timing.earliestMs}, ${timing.latestMs})`;
    case 'exact': return `exact(${timing.atMs})`;
  }
}

/** Every place a pool's claims or sinks name: the pool places, and each bucket's `spent`. */
export function poolSinks(compiled: Pick<CompiledWorkflow, 'pools'>): readonly Pool['place'][] {
  return compiled.pools.flatMap((pool) => (pool.kind === 'bucket' ? [pool.place, pool.spent] : [pool.place]));
}

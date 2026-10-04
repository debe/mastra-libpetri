import type { In, Transition } from 'libpetri';
import type { CompiledWorkflow } from '../compiler/types.js';
import { branchesOf, describeBranch, describeIn } from './budget.js';

/**
 * Checks, from the arcs alone, that every counted decision is the shape its claims rest on ([ADR
 * 0014], amended 2026-10-04) — `structure.ts` style, over `CompiledWorkflow.decisions` (the gadget's
 * declaration, never derived from the arcs it inspects). Host-agnostic: the M10 candidate's check.
 *
 * For each {@link DecisionSite} `D` with `k`, `n`:
 *
 * 1. **Every name resolves.** Every place and transition `D` names is in the net.
 * 2. **One decision right.** `D.permit` is produced only by the block's `fork`, one token per firing,
 *    and consumed only by `met` and `short`, each by `one(permit)`.
 * 3. **`met` counts successes only.** `met`'s inputs are exactly `one(permit)` and
 *    `exactly(k, okSeen)`; it outputs exactly `won`. `okSeen` is produced only by the `collectOk`
 *    transitions — one per arm, each consuming that arm's done place — and consumed only by `met` and
 *    the two `absorb-ok-*`.
 * 4. **`short` counts misses only.** `short`'s inputs are exactly `one(permit)` and
 *    `exactly(n − k + 1, miss)`; it outputs exactly `D.short`. `miss` is produced only by
 *    `collectMiss` and consumed only by `short` and the two `absorb-miss-*`.
 * 5. **The surplus is absorbed after the decision.** Each absorb consumes `one` of `okSeen` / `miss`,
 *    reads `won` / `short` (a read arc, never a consume), and produces exactly `settled`; nothing else
 *    produces `settled`. Exactly the live absorbs exist: the `-won` pair iff `k < n`, the `-short`
 *    pair iff `k > 1`; `settled` is `undefined` iff `n = 1` (no absorb at all).
 * 6. **The joins wait for all `n`.** `join-met` consumes `one(won)` and `exactly(n − k, settled)`
 *    (no settled arc when `n = k`); `join-short` consumes `one(short)` and `exactly(k − 1, settled)`
 *    (none when `k = 1`). No inhibitor and no reset on any decision place — every one is monotone, so
 *    VER-004 splits no collect.
 * 7. **Preemption is the arm's own.** Arm `i`'s `preempted` place is produced only by arm `i`'s
 *    attempts — each of which has it as one xor branch — and consumed only by `collectPreempted[i]`,
 *    which produces `miss`. For `n = 1`, `preempted` and `collectPreempted` are empty and no attempt
 *    of the arm has a `preempted` branch. Checked as: every place an attempt of arm `i` (a step chain
 *    at the arm's own path) produces into, pool places aside, is consumed only by that chain's own
 *    hops and timeout funnels or by the block's declared collects — so an undeclared `preempted`
 *    branch, at `n = 1` or a second one, is a place nothing declared takes.
 *
 * With 2–4 and `okSeen + miss ≤ n`, `met` and `short` cannot both fire; with 5–6 the join fires only
 * once every arm has arrived. `mutualExclusion(won, short)` and the bounds are then proven by the
 * verifier; this check is what makes them claims about *this* topology. Mutants, all in
 * `tests/verify/decision.test.ts` (owner E): an `inhibitor(won)` on `short`, a success collect
 * producing `miss`, a reset on `okSeen`, and a dead absorb pair emitted (`-won` at `k = n`).
 *
 * Rule 1 also holds the site to its own counts — `k` in [1, n], `n` success collects, `n` preempted
 * places and collects (none at `n = 1`), the four miss kinds then the preempted collects — and the
 * other rules are not checked on a site that fails it. Rule 6 is read as: no transition carries an
 * inhibitor or a reset on a decision place, and no decision transition (`met`, `short`, the absorbs,
 * the joins, the collects) carries one at all; only an absorb reads, and only `won` or `short`.
 * Places a pool owns (the run's permits, a block's slots and `active`, a quota) are set aside
 * throughout: a collect under `concurrency` gives its slot back beside its arrival.
 *
 * Returns one line per violation, prefixed by the block's id; empty for a net with no decisions.
 */
export function decisionStructureViolations(compiled: CompiledWorkflow): readonly string[] {
  if (compiled.decisions.length === 0) return [];
  const net = compiled.net;
  const transitions = [...net.transitions];
  const byName = new Map(transitions.map((t) => [t.name, t] as const));
  const placeNames = new Set([...net.places].map((p) => p.name));
  // Places a pool owns — the run's permits, a block's slots and its `active` holder, a quota, a
  // bucket's demand. A collect under `concurrency` takes and gives a slot beside its arrival.
  const pooled = new Set<string>([
    ...(compiled.budget ? [compiled.budget.permits.name] : []),
    ...compiled.pools.flatMap((pool) => [pool.place.name, ...pool.holders.map((h) => h.place), ...(pool.kind === 'bucket' ? [pool.demand.name] : [])]),
  ]);
  const outputs = (t: Transition): string[] => [...t.outputPlaces()].map((p) => p.name);
  const producers = (p: string): string[] => transitions.filter((t) => outputs(t).includes(p)).map((t) => t.name);
  const consumers = (p: string): string[] => transitions.filter((t) => t.inputSpecs.some((s) => s.place.name === p)).map((t) => t.name);
  const readers = (p: string): string[] => transitions.filter((t) => t.reads.some((a) => a.place.name === p)).map((t) => t.name);
  /** The branches of `t`'s output spec with every pool place dropped. */
  const ownBranches = (t: Transition): ReadonlyMap<string, number>[] =>
    t.outputSpec === null ? [] : branchesOf(t.outputSpec).map((b) => new Map([...b].filter(([p]) => !pooled.has(p))));
  /** The input arcs of `t` on places no pool owns. */
  const ownInputs = (t: Transition): In[] => t.inputSpecs.filter((s) => !pooled.has(s.place.name));

  const out: string[] = [];
  for (const d of compiled.decisions) {
    const say = (line: string): void => {
      out.push(`block '${d.blockId}' at ${d.path.join('-')}: ${line}`);
    };
    const { n, k } = d;

    // --- 1. Every name resolves, and the site's own counts agree ------------------------------
    const counts: string[] = [];
    if (!Number.isSafeInteger(n) || n < 1) counts.push(`n is ${n}; a decision needs a whole number of arms, at least one`);
    else if (!Number.isSafeInteger(k) || k < 1 || k > n) counts.push(`k is ${k}; it must be a whole number in [1, ${n}]`);
    if (counts.length > 0) {
      counts.forEach(say);
      continue;
    }
    const armed = n >= 2;
    if ((d.settled === undefined) !== !armed) counts.push(armed ? `declares no settled place at n = ${n}; only n = 1 has none` : `declares settled '${d.settled}' at n = 1, whose bound is 0`);
    if (d.collectOk.length !== n) counts.push(`declares ${d.collectOk.length} success collects for ${n} arms`);
    const wantPreempted = armed ? n : 0;
    if (d.preempted.length !== wantPreempted) counts.push(`declares ${d.preempted.length} preempted places; it needs ${wantPreempted}`);
    if (d.collectPreempted.length !== wantPreempted) counts.push(`declares ${d.collectPreempted.length} preempted collects; it needs ${wantPreempted}`);
    const tail = d.collectMiss.slice(d.collectMiss.length - d.collectPreempted.length);
    if (d.collectMiss.length !== 4 + d.collectPreempted.length || tail.some((name, i) => name !== d.collectPreempted[i])) {
      counts.push(`declares miss collects [${d.collectMiss.join(', ')}]; it needs the four kinds, then [${d.collectPreempted.join(', ')}]`);
    }
    const missingPlaces = [d.permit, d.okSeen, d.miss, d.won, d.short, ...(d.settled === undefined ? [] : [d.settled]), ...d.preempted].filter((p) => !placeNames.has(p));
    const missingTransitions = [d.met, d.shortTransition, ...d.collectOk, ...d.collectMiss, ...d.absorbs, d.joinMet, d.joinShort].filter((t) => !byName.has(t));
    if (missingPlaces.length > 0) counts.push(`names place(s) ${missingPlaces.map((p) => `'${p}'`).join(', ')}, not in the net`);
    if (missingTransitions.length > 0) counts.push(`names transition(s) ${missingTransitions.map((t) => `'${t}'`).join(', ')}, not in the net`);
    if (counts.length > 0) {
      counts.forEach(say);
      continue;
    }
    const T = (name: string): Transition => byName.get(name)!;

    const decisionPlaces = new Set([d.permit, d.okSeen, d.miss, d.won, d.short, ...(d.settled === undefined ? [] : [d.settled]), ...d.preempted]);
    const collects = new Set([...d.collectOk, ...d.collectMiss]);
    const decisionTransitions = new Set([d.met, d.shortTransition, ...d.absorbs, d.joinMet, d.joinShort, ...collects]);
    const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
      const x = [...new Set(a)].sort();
      const y = [...new Set(b)].sort();
      return a.length === x.length && x.length === y.length && x.every((v, i) => v === y[i]);
    };
    const list = (names: readonly string[]): string => `[${[...names].sort().join(', ')}]`;
    /** `t` consumes exactly these arcs (place, count), each `one` or `exactly`, and nothing else. */
    const takesExactly = (t: Transition, want: readonly (readonly [string, number])[], what: string): void => {
      const got = t.inputSpecs.map((s) => [s.place.name, s.type === 'one' ? 1 : s.type === 'exactly' ? s.count : NaN] as const);
      const key = (arcs: readonly (readonly [string, number])[]): string => arcs.map(([p, c]) => `${p}×${c}`).sort().join(',');
      if (key(got) !== key(want)) {
        say(`'${t.name}' consumes [${t.inputSpecs.map((s) => `${describeIn(s)} ${s.place.name}`).join(', ')}]; ${what}`);
      }
    };
    /** Every branch of `t`'s output, pool places aside, is exactly one token into `p`. */
    const producesOnly = (t: Transition, p: string): void => {
      const branches = ownBranches(t);
      if (branches.length === 0) say(`'${t.name}' has no output branch; it must produce exactly one token into '${p}'`);
      branches.forEach((b, i) => {
        if (b.size !== 1 || b.get(p) !== 1) say(`'${t.name}' branch ${i} (${describeBranch(b)}) must be exactly one token into '${p}'`);
      });
    };

    // --- 6b. No inhibitor and no reset on a decision place; none on a decision transition --------
    for (const t of transitions) {
      for (const [arcs, what] of [[t.inhibitors, 'an inhibitor'], [t.resets, 'a reset']] as const) {
        for (const arc of arcs) {
          if (decisionPlaces.has(arc.place.name)) say(`'${t.name}' has ${what} on decision place '${arc.place.name}'; every decision place is monotone`);
          else if (decisionTransitions.has(t.name)) say(`'${t.name}' is a decision transition and has ${what} on '${arc.place.name}'; it carries none`);
        }
      }
    }
    // Reads: only an absorb reads, and only `won` or `short` (rule 5).
    for (const p of decisionPlaces) {
      if (p === d.won || p === d.short) continue;
      const r = readers(p);
      if (r.length > 0) say(`decision place '${p}' is read by ${list(r)}; only won and short are read, by the absorbs`);
    }

    // --- 2. One decision right -----------------------------------------------------------------
    const forks = producers(d.permit);
    if (forks.length !== 1) say(`permit '${d.permit}' is produced by ${list(forks)}; only the block's fork may`);
    for (const name of forks) {
      if (decisionTransitions.has(name)) say(`permit '${d.permit}' is produced by decision transition '${name}'; only the block's fork may`);
      const t = T(name);
      if (t.outputSpec !== null) {
        branchesOf(t.outputSpec).forEach((b, i) => {
          if (b.get(d.permit) !== 1) say(`'${name}' branch ${i} (${describeBranch(b)}) puts ${b.get(d.permit) ?? 0} tokens into permit '${d.permit}'; the fork puts exactly one`);
        });
      }
      const taken = t.inputSpecs.filter((s) => decisionPlaces.has(s.place.name)).map((s) => s.place.name);
      if (taken.length > 0) say(`the fork '${name}' consumes decision place(s) ${list(taken)}`);
    }
    const permitTakers = consumers(d.permit);
    if (!sameSet(permitTakers, [d.met, d.shortTransition])) say(`permit '${d.permit}' is consumed by ${list(permitTakers)}; only met and short may`);

    // --- 3. `met` counts successes only ----------------------------------------------------------
    takesExactly(T(d.met), [[d.permit, 1], [d.okSeen, k]], `met consumes exactly one(${d.permit}) and exactly(${k}, ${d.okSeen})`);
    producesOnly(T(d.met), d.won);
    const okBy = producers(d.okSeen);
    if (!sameSet(okBy, d.collectOk)) say(`'${d.okSeen}' is produced by ${list(okBy)}; only the success collects ${list(d.collectOk)} may`);
    const armDone = new Map<string, string>();
    d.collectOk.forEach((name, i) => {
      const t = T(name);
      const own = ownInputs(t);
      const from = own[0]?.place.name;
      if (own.length !== 1 || !takesOne(own[0]!) || from === undefined || decisionPlaces.has(from)) {
        say(`success collect '${name}' consumes [${own.map((s) => `${describeIn(s)} ${s.place.name}`).join(', ')}]; it consumes one token of arm ${i}'s done place`);
      } else if (armDone.has(from)) {
        say(`success collects '${armDone.get(from)}' and '${name}' consume the same place '${from}'; one per arm`);
      } else armDone.set(from, name);
      producesOnly(t, d.okSeen);
    });

    // --- 4. `short` counts misses only -----------------------------------------------------------
    takesExactly(T(d.shortTransition), [[d.permit, 1], [d.miss, n - k + 1]], `short consumes exactly one(${d.permit}) and exactly(${n - k + 1}, ${d.miss})`);
    producesOnly(T(d.shortTransition), d.short);
    const missBy = producers(d.miss);
    if (!sameSet(missBy, d.collectMiss)) say(`'${d.miss}' is produced by ${list(missBy)}; only the miss collects ${list(d.collectMiss)} may`);
    for (const name of d.collectMiss) {
      const t = T(name);
      const own = ownInputs(t);
      if (own.length !== 1 || !takesOne(own[0]!) || (decisionPlaces.has(own[0]!.place.name) && !d.preempted.includes(own[0]!.place.name))) {
        say(`miss collect '${name}' consumes [${own.map((s) => `${describeIn(s)} ${s.place.name}`).join(', ')}]; it consumes one token of an arm's exit`);
      }
      producesOnly(t, d.miss);
    }

    // --- 5. The surplus is absorbed after the decision -------------------------------------------
    const wantAbsorbs = new Set<string>();
    if (armed && k < n) wantAbsorbs.add(`${d.okSeen}|${d.won}`).add(`${d.miss}|${d.won}`);
    if (armed && k > 1) wantAbsorbs.add(`${d.okSeen}|${d.short}`).add(`${d.miss}|${d.short}`);
    const seenAbsorbs = new Map<string, string>();
    for (const name of d.absorbs) {
      const t = T(name);
      const from = t.inputSpecs.length === 1 && takesOne(t.inputSpecs[0]!) ? t.inputSpecs[0]!.place.name : undefined;
      const read = t.reads.length === 1 ? t.reads[0]!.place.name : undefined;
      if (from !== d.okSeen && from !== d.miss) {
        say(`absorb '${name}' consumes [${t.inputSpecs.map((s) => `${describeIn(s)} ${s.place.name}`).join(', ')}]; it consumes one token of '${d.okSeen}' or '${d.miss}' and nothing else`);
      }
      if (read !== d.won && read !== d.short) say(`absorb '${name}' reads [${t.reads.map((a) => a.place.name).join(', ')}]; it reads exactly '${d.won}' or '${d.short}'`);
      if (d.settled !== undefined) producesOnly(t, d.settled);
      if (from === undefined || read === undefined) continue;
      const combo = `${from}|${read}`;
      if (seenAbsorbs.has(combo)) say(`absorbs '${seenAbsorbs.get(combo)}' and '${name}' both take '${from}' after '${read}'`);
      else seenAbsorbs.set(combo, name);
      if (!wantAbsorbs.has(combo)) {
        const why = read === d.won ? `k = n = ${n}: met takes every arrival, nothing is left after it` : `k = 1: short takes every arrival, nothing is left after it`;
        say(`absorb '${name}' takes '${from}' after '${read}', a dead absorb (${armed ? why : 'n = 1 has no surplus'})`);
      }
    }
    for (const combo of wantAbsorbs) {
      if (!seenAbsorbs.has(combo)) {
        const [from, read] = combo.split('|');
        say(`no absorb takes '${from}' after '${read}'; the surplus would strand`);
      }
    }
    if (d.settled !== undefined) {
      const settledBy = producers(d.settled);
      if (!sameSet(settledBy, d.absorbs)) say(`'${d.settled}' is produced by ${list(settledBy)}; only the absorbs ${list(d.absorbs)} may`);
    }
    for (const [p, readersWant] of [[d.won, d.absorbs.filter((a) => T(a).reads.some((r) => r.place.name === d.won))], [d.short, d.absorbs.filter((a) => T(a).reads.some((r) => r.place.name === d.short))]] as const) {
      const r = readers(p);
      if (!sameSet(r, readersWant)) say(`'${p}' is read by ${list(r)}; only the absorbs after it may`);
    }
    const okTakers = consumers(d.okSeen);
    const okWant = [d.met, ...d.absorbs.filter((a) => T(a).inputSpecs.some((s) => s.place.name === d.okSeen))];
    if (!sameSet(okTakers, okWant)) say(`'${d.okSeen}' is consumed by ${list(okTakers)}; only met and the ok absorbs may`);
    const missTakers = consumers(d.miss);
    const missWant = [d.shortTransition, ...d.absorbs.filter((a) => T(a).inputSpecs.some((s) => s.place.name === d.miss))];
    if (!sameSet(missTakers, missWant)) say(`'${d.miss}' is consumed by ${list(missTakers)}; only short and the miss absorbs may`);

    // --- 6. The joins wait for all n ---------------------------------------------------------------
    const settledArc = (count: number): (readonly [string, number])[] => (count > 0 && d.settled !== undefined ? [[d.settled, count]] : []);
    takesExactly(T(d.joinMet), [[d.won, 1], ...settledArc(n - k)], `join-met consumes exactly one(${d.won})${n - k > 0 ? ` and exactly(${n - k}, ${d.settled})` : ''}`);
    takesExactly(T(d.joinShort), [[d.short, 1], ...settledArc(k - 1)], `join-short consumes exactly one(${d.short})${k - 1 > 0 ? ` and exactly(${k - 1}, ${d.settled})` : ''}`);
    const wonBy = producers(d.won);
    if (!sameSet(wonBy, [d.met])) say(`'${d.won}' is produced by ${list(wonBy)}; only met may`);
    const shortBy = producers(d.short);
    if (!sameSet(shortBy, [d.shortTransition])) say(`'${d.short}' is produced by ${list(shortBy)}; only short may`);
    const wonTakers = consumers(d.won);
    if (!sameSet(wonTakers, [d.joinMet])) say(`'${d.won}' is consumed by ${list(wonTakers)}; only join-met may`);
    const shortTakers = consumers(d.short);
    if (!sameSet(shortTakers, [d.joinShort])) say(`'${d.short}' is consumed by ${list(shortTakers)}; only join-short may`);
    if (d.settled !== undefined) {
      const settledTakers = consumers(d.settled);
      const want = [...(n - k > 0 ? [d.joinMet] : []), ...(k - 1 > 0 ? [d.joinShort] : [])];
      if (!sameSet(settledTakers, want)) say(`'${d.settled}' is consumed by ${list(settledTakers)}; only ${list(want)} may`);
    }
    for (const name of [d.joinMet, d.joinShort]) {
      const into = outputs(T(name)).filter((p) => decisionPlaces.has(p));
      if (into.length > 0) say(`join '${name}' produces into decision place(s) ${list(into)}`);
    }

    // --- 7. Preemption is the arm's own ------------------------------------------------------------
    for (let i = 0; i < n; i++) {
      const armPath = [...d.path, i];
      const chains = compiled.steps.filter((c) => c.path.length === armPath.length && c.path.every((x, j) => x === armPath[j]));
      const attempts = chains.flatMap((c) => c.attempts);
      const preempted = d.preempted[i];
      if (preempted !== undefined) {
        const by = producers(preempted);
        const strangers = by.filter((t) => !attempts.includes(t));
        if (strangers.length > 0) say(`arm ${i}'s preempted '${preempted}' is produced by ${list(strangers)}, not attempts of arm ${i}`);
        for (const name of attempts) {
          const branches = ownBranches(T(name));
          const holding = branches.filter((b) => b.has(preempted));
          if (holding.length !== 1 || holding[0]!.size !== 1 || holding[0]!.get(preempted) !== 1) {
            say(`arm ${i}'s attempt '${name}' has ${holding.length} branch(es) into '${preempted}'; it needs exactly one, holding one token of it alone`);
          }
        }
        const takers = consumers(preempted);
        if (!sameSet(takers, [d.collectPreempted[i]!])) say(`arm ${i}'s preempted '${preempted}' is consumed by ${list(takers)}; only '${d.collectPreempted[i]}' may`);
        const own = ownInputs(T(d.collectPreempted[i]!));
        if (own.length !== 1 || own[0]!.place.name !== preempted) say(`'${d.collectPreempted[i]}' consumes [${own.map((s) => s.place.name).join(', ')}]; it consumes arm ${i}'s '${preempted}'`);
      }
      // Where an arm attempt's outcomes go: its own chain (a retry hop, a timeout funnel) or one of
      // the block's collects. A `preempted` branch nobody declared — at n = 1, or a second one —
      // lands in a place nothing here consumes.
      const chainOwn = new Set(chains.flatMap((c) => [...c.attempts, ...c.hops, ...c.timeouts]));
      for (const name of attempts) {
        for (const p of outputs(T(name))) {
          if (pooled.has(p)) continue;
          const takers = consumers(p);
          const stray = takers.filter((t) => !chainOwn.has(t) && !collects.has(t));
          if (takers.length === 0 || stray.length > 0) {
            say(`arm ${i}'s attempt '${name}' produces into '${p}', consumed by ${list(takers)}; an arm's outcome goes to its own chain or a declared collect`);
          }
        }
      }
    }
  }
  return out;
}

function takesOne(spec: In): boolean {
  return spec.type === 'one' || (spec.type === 'exactly' && spec.count === 1);
}

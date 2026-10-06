import type { Out, Transition } from 'libpetri';
import type { CompensationSite, CompensatorExitKind, CompensatorSite, CompiledWorkflow, DischargeKind } from '../compiler/types.js';
import { ladderLevel } from '../compiler/blueprints/compensate.js';

/**
 * Checks, from the arcs alone, that the compensation ladder is the shape its claims rest on
 * ([ADR 0017], amended by the W0 spike) — `structure.ts` style, over `CompiledWorkflow.compensations`
 * (the blueprint's declaration, never derived from the arcs it inspects), under "compensate
 * structure" in `properties.ts`. Host-agnostic: the M10 candidate's check.
 *
 * Model checking cannot see four things, and the W0 spike has a mutant for each that passes every
 * behavioural claim: termination and at most once (S1, S3; MUT5), cancel-free compensators (S5),
 * outcome routing (S6, S6t) and reverse order beyond adjacent levels (S1, by transitivity). C1
 * (`rolledBack`) ranges over quiescent markings only and cannot see a rollback that never rests.
 *
 * A **pure move** below is a transition that takes exactly one token from each place listed and
 * nothing else (every input arc `one`), gives exactly the places listed on every firing (an `and` of
 * places, no `xor`, timeout or forwarded input), is immediate, and has no read, inhibitor or reset
 * arc. Every ladder transition is one; that is also why under [VER-004] the ladder splits nothing.
 *
 * 1. **S1, arming and levels.** The site has `m + 1` levels, `m` rungs `j = 1..m` in ascending `k`,
 *    each `k_j` a top-level index before the last, and `m + 1` discharge rows. `arm_j` is a pure move
 *    {arming_j, level.{j-1}} → {successor(k_j), level.j}; arming_j's only producers are entry k_j's
 *    (at least one) and its only consumer `arm_j`; successor(k_j)'s only producer is `arm_j`, so no
 *    transition of entry k_j — a retry's success, say — gets past the rung unarmed; `level.j` (j ≥ 1) has no producers but `arm_j` and
 *    `settle_{j+1}.*`, `level.0` none but `settle_1.*` (and at least one); `level.j` has no consumers
 *    but `arm_{j+1}`, `start_j`, its own discharges and, for `level.0`, `finish`.
 * 2. **S2, one routing rule.** `raise` is a pure move {failure} → {fault, pending} and the only
 *    consumer of `wf.comp.failure`, whose every producer is a top-level entry's. A top-level entry's
 *    outputs stay in its interior, its `next`, its arming, the ladder's exits (`wf.comp.failure`,
 *    `wf.comp.exit.*` — `done` only for the last entry), or pools: so every top-level failure is
 *    raised and every other outcome intercepted.
 * 3. **S3, one rung at a time.** `start_j` is a pure move {pending, level.j} → {u_j.in, undoing_j},
 *    and the only producer of both; for every declared exit kind (the five: `done`, `failed`,
 *    `bailed`, `suspended`, `paused`) the exit has exactly one consumer, `settle_j.<kind>`, a pure move
 *    {u_j.<kind>, undoing_j} → {level.{j-1}, pending}, and no producer but u_j's own transitions;
 *    `undoing_j` has no consumer but those settles; `pending` has no producer but `raise` and the
 *    settles, and no consumer but the starts and `finish`. Every settle gives the level directly below
 *    its start's, so the rollback subgraph strictly descends and is acyclic (MUT5, with S1).
 * 4. **S4, the held failure.** `finish` is a pure move {pending, level.0, fault} →
 *    {`wf.settle.failed`} and that place's only producer; `fault` has no producer but `raise` and no
 *    consumer but `finish`.
 * 5. **S5, cancel-free.** No ladder transition (named by the site, or `t.comp.*`) and no transition
 *    at a compensator's path has any arc on `wf.cancel` — so compensator leaves carry no signal; no
 *    transition reading or inhibited by `wf.cancel` (a sweep, a gate) consumes a ladder place or a
 *    place of a compensator's chain.
 * 6. **S6, outcome routing.** `wf.comp.exit.<kind>`'s consumers are exactly its `m + 1` discharges,
 *    each a pure move {exit.<kind>, level.j} → {`wf.settle.<kind>`} (`done` to `wf.settle.done`,
 *    `canceled` to `wf.canceled`); `wf.settle.<kind>` for the four non-canceled kinds has no producer
 *    but its `m + 1` discharges, so no outcome reaches the settle stage with a level still held
 *    (S4 holds `wf.settle.failed` to `finish`); only `discharge_j.canceled` produces a terminal among ladder
 *    transitions, and nothing in the ladder consumes, resets, inhibits or reads a terminal; and
 *    `wf.canceled` has no producer but the settle stage's `t.settle.*.canceled` and the canceled
 *    discharges — every top-level, checkpoint and foreach sweep intercepted (W0 amendment 1).
 * 7. **S7, the coverage exemption.** The attempts {@link compensatorAttempts} exempts are exactly the
 *    compensators' chains — each rung's `attempts` the registered chain at its `inPlace`, at its
 *    path — and every transition at a compensator's path gives only into that compensator's own
 *    exits, its own chain's places (`s.<path>.*`) or pools; no other transition but its `start`
 *    produces into its chain.
 * 8. **S8, nothing dead.** Every ladder place (named by the site, or `wf.comp.*`) is a place of the
 *    net with a producer; every ladder transition can fire on the arcs alone — from the union of
 *    every default segment's seed (the entry place, every boundary and resume site, the cancel
 *    request, the pools, and `ladderLevel` at each), a transition is enabled once every place it takes
 *    or reads is markable (counts and inhibitors ignored, so an over-approximation: a transition this
 *    finds dead is dead). The W0 six-kind ladder's `settle_j.canceled` is its mutant.
 *
 * Mutants (`tests/verify/compensate.test.ts`, W1 claims): one per rule, run against the behavioural
 * claims too with the result recorded, and one per clause, each asserting its exact line. Two clause
 * deletions are equivalent and have none: `t.outputSpec === null` in a pure move (a null `Out` gives
 * no place, so the place comparison already fails — every `gives` is non-empty) and S7's "exempt but
 * not declared" (`compensatorAttempts` is a subset of the declared attempts by construction; the
 * clause guards a future change to it).
 *
 * Returns one line per violation, prefixed by its rule (`S1: …`); empty for a net with no ladder —
 * unless a `t.comp.*` transition or a `wf.comp.*` place is in it anyway (`S0`).
 */
export function compensateStructureViolations(compiled: CompiledWorkflow): readonly string[] {
  const site = compiled.compensations;
  const transitions = [...compiled.net.transitions];
  const placeNames = new Set([...compiled.net.places].map((p) => p.name));
  if (site === undefined) {
    const stray = [...transitions.map((t) => t.name).filter((n) => n.startsWith('t.comp.')), ...[...placeNames].filter((n) => n.startsWith('wf.comp.'))];
    return stray.length === 0 ? [] : [`S0: ${list(stray)} in a net with no compensation site`];
  }

  const out: string[] = [];
  const say = (rule: number, line: string): void => {
    out.push(`S${rule}: ${line}`);
  };
  const byName = new Map(transitions.map((t) => [t.name, t] as const));
  const ins = (t: Transition): string[] => t.inputSpecs.map((s) => s.place.name);
  const outs = (t: Transition): string[] => [...t.outputPlaces()].map((p) => p.name);
  const reads = (t: Transition): string[] => t.reads.map((a) => a.place.name);
  const inhibits = (t: Transition): string[] => t.inhibitors.map((a) => a.place.name);
  const resets = (t: Transition): string[] => t.resets.map((a) => a.place.name);
  const producers = (p: string): string[] => transitions.filter((t) => outs(t).includes(p)).map((t) => t.name);
  const consumers = (p: string): string[] => transitions.filter((t) => ins(t).includes(p)).map((t) => t.name);
  const entryOf = (t: string): number | undefined => compiled.netMap.transitionToEntry.get(t)?.path[0];

  const get = (rule: number, name: string): Transition | undefined => {
    const t = byName.get(name);
    if (t === undefined) say(rule, `'${name}' is not a transition of the net`);
    return t;
  };
  /** A pure move: exactly one token from each of `takes`, exactly `gives` on every firing, immediate, no other arc. */
  const pureMove = (rule: number, t: Transition, takes: readonly string[], gives: readonly string[]): void => {
    if (!sameSet(ins(t), takes) || t.inputSpecs.some((s) => s.type !== 'one')) say(rule, `'${t.name}' takes ${describeIns(t)}; it takes exactly one each of ${list(takes)}`);
    if (!sameSet(outs(t), gives) || t.outputSpec === null || !allAnd(t.outputSpec)) say(rule, `'${t.name}' gives ${describeOut(t)}; it gives exactly ${list(gives)} on every firing`);
    if (t.reads.length + t.inhibitors.length + t.resets.length > 0) say(rule, `'${t.name}' has read ${list(reads(t))}, inhibitor ${list(inhibits(t))} or reset ${list(resets(t))} arcs; it has none`);
    if (t.timing.type !== 'immediate') say(rule, `'${t.name}' is ${t.timing.type}; it is immediate`);
  };

  const n = compiled.entries.length;
  const m = site.m;
  const L = site.levels;
  const C = site.compensators;
  const cancel = compiled.cancel.name;
  const canceled = compiled.terminals.canceled.name;
  const terminals = new Set(Object.values(compiled.terminals).map((p) => p.name));
  const settle = (kind: Exclude<DischargeKind, 'canceled'> | 'failed'): string => `wf.settle.${kind}`;
  const pooled = new Set<string>([
    ...(compiled.budget ? [compiled.budget.permits.name] : []),
    ...compiled.pools.flatMap((pool) => [pool.place.name, ...pool.holders.map((h) => h.place), ...(pool.kind === 'bucket' ? [pool.spent.name, pool.demand.name] : [])]),
  ]);
  const compAt = new Map(C.map((c) => [c.path[0]!, c] as const));
  /** Places of u_j's chain: everything named under its path, `s.<n+j-1>.`. */
  const chainOf = (c: CompensatorSite, p: string): boolean => p.startsWith(`s.${c.path[0]}.`) || p.startsWith(`s.${c.path[0]}-`);
  const ladderTransitions = new Set<string>([
    site.raise,
    site.finish,
    ...site.discharges.flatMap((row) => Object.values(row)),
    ...C.flatMap((c) => [c.arm, c.start, ...Object.values(c.settles)]),
    ...transitions.map((t) => t.name).filter((name) => name.startsWith('t.comp.')),
  ]);
  const ladderPlaces = new Set<string>([
    ...L,
    site.failure,
    site.fault,
    site.pending,
    ...Object.values(site.exits),
    ...C.flatMap((c) => [c.arming, c.undoing, c.inPlace, ...Object.values(c.exits)]),
    ...[...placeNames].filter((name) => name.startsWith('wf.comp.')),
  ]);

  // --- S1: arming and the levels --------------------------------------------------------------
  if (L.length !== m + 1 || C.length !== m || site.discharges.length !== m + 1 || m < 1) {
    say(1, `the site has m = ${m}, ${L.length} levels, ${C.length} rungs and ${site.discharges.length} discharge rows; it has m ≥ 1, m + 1 levels, m rungs and m + 1 rows`);
  }
  C.forEach((c, x) => {
    if (c.j !== x + 1) say(1, `rung ${x + 1} says j = ${c.j}`);
    const below = C[x - 1];
    if (!Number.isInteger(c.k) || c.k < 0 || c.k >= n - 1 || (below !== undefined && c.k <= below.k)) {
      say(1, `u_${c.j} compensates entry ${c.k}; the k_j ascend strictly, each a top-level index before the last (${n - 1})`);
    }
  });
  for (const c of C) {
    const from = L[c.j - 1];
    const to = L[c.j];
    const successor = compiled.entries[c.k]?.next;
    const arm = get(1, c.arm);
    if (arm !== undefined && from !== undefined && to !== undefined && successor !== undefined) pureMove(1, arm, [c.arming, from], [successor, to]);
    const prod = producers(c.arming);
    if (prod.length === 0) say(1, `'${c.arming}' has no producer; entry ${c.k}'s success arms level ${c.j}`);
    for (const p of prod) if (entryOf(p) !== c.k || ladderTransitions.has(p)) say(1, `'${p}' produces '${c.arming}'; only entry ${c.k}'s transitions do`);
    if (!sameSet(consumers(c.arming), [c.arm])) say(1, `'${c.arming}' is consumed by ${list(consumers(c.arming))}; only by '${c.arm}'`);
    // No way past the rung but arming: one transition of entry k_j giving its successor directly (a
    // retry's success, say) leaves level.{j-1} where it was, and a later failure skips u_j. C1 and C2
    // still hold — the level is not armed, and u_j stays live through the other attempts.
    if (successor !== undefined && !sameSet(producers(successor), [c.arm])) {
      say(1, `'${successor}' is produced by ${list(producers(successor))}; only by '${c.arm}' — entry ${c.k} reaches its successor only through arming`);
    }
  }
  L.forEach((level, j) => {
    const givers = new Set<string>([...(j >= 1 && C[j - 1] ? [C[j - 1]!.arm] : []), ...(C[j] ? Object.values(C[j]!.settles) : [])]);
    const prod = producers(level);
    for (const p of prod) if (!givers.has(p)) say(1, `'${p}' produces '${level}'; only ${j >= 1 ? `arm_${j} and ` : ''}settle_${j + 1}.* do`);
    if (prod.length === 0) say(1, `'${level}' has no producer`);
    const takers = new Set<string>([
      ...Object.values(site.discharges[j] ?? {}),
      ...(C[j] ? [C[j]!.arm] : []),
      ...(j >= 1 && C[j - 1] ? [C[j - 1]!.start] : []),
      ...(j === 0 ? [site.finish] : []),
    ]);
    for (const p of consumers(level)) if (!takers.has(p)) say(1, `'${p}' consumes '${level}'; only ${j < m ? `arm_${j + 1}, ` : ''}${j >= 1 ? `start_${j}, ` : 'finish, '}and level ${j}'s discharges do`);
  });

  // --- S2: every top-level failure is raised; entries leave only through the ladder ----------
  const raise = get(2, site.raise);
  if (raise !== undefined) pureMove(2, raise, [site.failure], [site.fault, site.pending]);
  if (!sameSet(consumers(site.failure), [site.raise])) say(2, `'${site.failure}' is consumed by ${list(consumers(site.failure))}; only by '${site.raise}'`);
  for (const p of producers(site.failure)) {
    const i = entryOf(p);
    if (i === undefined || i >= n || ladderTransitions.has(p)) say(2, `'${p}' produces '${site.failure}' and is not a top-level entry's`);
  }
  for (const t of transitions) {
    const i = entryOf(t.name);
    if (i === undefined || i >= n) continue;
    const entry = compiled.entries[i]!;
    const interior = new Set(entry.interior);
    const arming = C.find((c) => c.k === i)?.arming;
    const allowed = new Set<string>([
      entry.next,
      site.failure,
      site.exits.bailed,
      site.exits.suspended,
      site.exits.paused,
      site.exits.canceled,
      ...(arming !== undefined ? [arming] : []),
      ...(i === n - 1 ? [site.exits.done] : []),
    ]);
    for (const p of outs(t)) {
      if (interior.has(p) || pooled.has(p) || allowed.has(p)) continue;
      say(2, `'${t.name}' (entry ${i}) gives '${p}'; a top-level entry gives only into its interior, its next, its arming, the ladder's exits or pools`);
    }
  }

  // --- S3: start, the compensator's exits, settles that strictly descend ----------------------
  const starts = C.map((c) => c.start);
  const allSettles = C.flatMap((c) => Object.values(c.settles));
  for (const c of C) {
    const level = L[c.j];
    const below = L[c.j - 1];
    const start = get(3, c.start);
    if (start !== undefined && level !== undefined) pureMove(3, start, [site.pending, level], [c.inPlace, c.undoing]);
    if (!sameSet(producers(c.inPlace), [c.start])) say(3, `'${c.inPlace}' is produced by ${list(producers(c.inPlace))}; only by '${c.start}'`);
    if (!sameSet(producers(c.undoing), [c.start])) say(3, `'${c.undoing}' is produced by ${list(producers(c.undoing))}; only by '${c.start}'`);
    if (!sameSet(consumers(c.undoing), Object.values(c.settles))) say(3, `'${c.undoing}' is consumed by ${list(consumers(c.undoing))}; only by u_${c.j}'s settles ${list(Object.values(c.settles))}`);
    const exits = c.exits as Readonly<Record<string, string>>;
    const settles = c.settles as Readonly<Record<string, string>>;
    if (!sameSet(Object.keys(settles), Object.keys(exits))) say(3, `u_${c.j} declares exits ${list(Object.keys(exits))} and settles ${list(Object.keys(settles))}; one settle per exit`);
    for (const kind of FIVE) if (exits[kind] === undefined) say(3, `u_${c.j} declares no '${kind}' exit`);
    for (const [kind, exit] of Object.entries(exits)) {
      const name = settles[kind];
      if (name === undefined) continue;
      if (!sameSet(consumers(exit), [name])) say(3, `'${exit}' is consumed by ${list(consumers(exit))}; only by '${name}'`);
      for (const p of producers(exit)) if (entryOf(p) !== c.path[0] || ladderTransitions.has(p)) say(3, `'${p}' produces '${exit}' and is not u_${c.j}'s`);
      const t = get(3, name);
      // Strict descent: settle_j gives level j-1, never j or above — no repeat (MUT5), no cycle.
      if (t !== undefined && below !== undefined) pureMove(3, t, [exit, c.undoing], [below, site.pending]);
    }
  }
  for (const p of producers(site.pending)) if (p !== site.raise && !allSettles.includes(p)) say(3, `'${p}' produces '${site.pending}'; only raise and the settles do`);
  for (const p of consumers(site.pending)) if (p !== site.finish && !starts.includes(p)) say(3, `'${p}' consumes '${site.pending}'; only the starts and finish do`);

  // --- S4: finish is the only way to the failed settle ---------------------------------------
  const finish = get(4, site.finish);
  const level0 = L[0];
  if (finish !== undefined && level0 !== undefined) pureMove(4, finish, [site.pending, level0, site.fault], [settle('failed')]);
  if (!sameSet(producers(settle('failed')), [site.finish])) say(4, `'${settle('failed')}' is produced by ${list(producers(settle('failed')))}; only by '${site.finish}'`);
  if (!sameSet(producers(site.fault), [site.raise])) say(4, `'${site.fault}' is produced by ${list(producers(site.fault))}; only by '${site.raise}'`);
  if (!sameSet(consumers(site.fault), [site.finish])) say(4, `'${site.fault}' is consumed by ${list(consumers(site.fault))}; only by '${site.finish}'`);

  // --- S5: cancel never preempts a rollback, and compensators carry no signal -----------------
  for (const t of transitions) {
    const at = entryOf(t.name);
    const comp = at === undefined ? undefined : compAt.get(at);
    const arcs = [...ins(t), ...reads(t), ...inhibits(t), ...resets(t), ...outs(t)];
    if ((ladderTransitions.has(t.name) || comp !== undefined) && arcs.includes(cancel)) {
      say(5, `'${t.name}' has an arc on '${cancel}'; no ${comp !== undefined ? `transition of u_${comp.j}` : 'ladder transition'} does`);
    }
    if (reads(t).includes(cancel) || inhibits(t).includes(cancel)) {
      for (const p of ins(t)) {
        if (ladderPlaces.has(p) || C.some((c) => chainOf(c, p))) say(5, `'${t.name}' reads or is inhibited by '${cancel}' and consumes '${p}'; no cancel-gated transition takes a ladder or compensator place`);
      }
    }
  }

  // --- S6: the non-failed exits are discharged with the level ---------------------------------
  const cancelDischarges = new Set<string>();
  for (const kind of DISCHARGES) {
    const exit = site.exits[kind];
    const row = site.discharges.map((r) => r[kind]);
    if (!sameSet(consumers(exit), row)) say(6, `'${exit}' is consumed by ${list(consumers(exit))}; only by its discharges ${list(row)}`);
    const target = kind === 'canceled' ? canceled : settle(kind);
    // The settle stage's input: nothing gives it but the discharges, so no outcome leaves with a level
    // still held. `wf.canceled` has the settle stage's own producers too, checked below.
    if (kind !== 'canceled' && !sameSet(producers(target), row)) say(6, `'${target}' is produced by ${list(producers(target))}; only by its discharges ${list(row)}`);
    row.forEach((d, j) => {
      if (kind === 'canceled') cancelDischarges.add(d);
      const t = get(6, d);
      const level = L[j];
      if (t !== undefined && level !== undefined) pureMove(6, t, [exit, level], [target]);
    });
  }
  for (const name of ladderTransitions) {
    const t = byName.get(name);
    if (t === undefined) continue;
    for (const p of [...ins(t), ...reads(t), ...inhibits(t), ...resets(t)]) if (terminals.has(p)) say(6, `'${name}' takes, reads, inhibits or resets terminal '${p}'; nothing in the ladder does`);
    for (const p of outs(t)) {
      if (terminals.has(p) && !(p === canceled && cancelDischarges.has(name))) say(6, `'${name}' gives terminal '${p}'; only the canceled discharges give one, '${canceled}'`);
    }
  }
  const settleCanceled = (name: string): boolean => /^t\.settle\.[^.]+\.canceled$/.test(name);
  for (const p of producers(canceled)) {
    if (!cancelDischarges.has(p) && !settleCanceled(p)) say(6, `'${p}' gives '${canceled}'; only the settle stage's cancel-settles and the canceled discharges do — every sweep feeds '${site.exits.canceled}'`);
  }

  // --- S7: the coverage exemption is exactly the compensators' chains --------------------------
  const exempt = compensatorAttempts(compiled);
  for (const c of C) {
    const chain = compiled.steps.find((s) => s.inPlace === c.inPlace);
    if (chain === undefined || chain.stepId !== c.stepId || chain.path[0] !== c.path[0] || !sameSequence(chain.attempts, c.attempts)) {
      say(7, `u_${c.j}'s attempts ${list(c.attempts)} are not the registered chain of '${c.stepId}' at '${c.inPlace}'${chain === undefined ? ' (none)' : ` (${list(chain.attempts)} of '${chain.stepId}' at ${chain.path.join('-')})`}`);
    }
    if (c.path.length !== 1 || c.path[0] !== n + c.j - 1) say(7, `u_${c.j} is at path ${c.path.join('-')}; it is at ${n + c.j - 1}`);
    if (c.viewPath.length !== 1 || c.viewPath[0] !== c.k) say(7, `u_${c.j} is viewed at ${c.viewPath.join('-')}; it is viewed at the entry it compensates, ${c.k}`);
    const own = new Set(Object.values(c.exits));
    for (const a of c.attempts) if (entryOf(a) !== c.path[0]) say(7, `exempt attempt '${a}' is not at u_${c.j}'s path ${c.path.join('-')}`);
    for (const t of transitions) {
      if (entryOf(t.name) === c.path[0]) {
        for (const p of outs(t)) {
          if (own.has(p) || pooled.has(p) || chainOf(c, p)) continue;
          say(7, `'${t.name}' (u_${c.j}) gives '${p}'; a compensator leaves only by its own exits`);
        }
      } else if (t.name !== c.start) {
        for (const p of outs(t)) if (chainOf(c, p)) say(7, `'${t.name}' gives '${p}', inside u_${c.j}'s chain; only '${c.start}' enters it`);
      }
    }
  }
  const declared = new Set(C.flatMap((c) => c.attempts));
  for (const a of exempt) if (!declared.has(a)) say(7, `exempt attempt '${a}' is not a compensator's`);

  // --- S8: no ladder place without a producer, no ladder transition dead from the arcs ---------
  for (const p of [...ladderPlaces].sort()) {
    if (!placeNames.has(p)) say(8, `ladder place '${p}' is not a place of the net`);
    else if (producers(p).length === 0) say(8, `ladder place '${p}' has no producer`);
  }
  const live = markable(compiled, site);
  for (const name of [...ladderTransitions].sort()) {
    const t = byName.get(name);
    if (t === undefined) continue;
    const blocked = [...ins(t), ...reads(t)].filter((p) => !live.has(p));
    if (blocked.length > 0) say(8, `ladder transition '${name}' is dead from the arcs: ${list([...new Set(blocked)])} never marked`);
  }
  return out;
}

/**
 * The step attempts of every compensator ([ADR 0017], S7): `CompensatorSite.attempts` over the
 * ladder's rungs. A compensator that suspends is unresolved — its settle returns the level and the
 * rollback goes on — and registers no resume site (`compensate-suspend` refuses a declared schema,
 * the runner rewrites a dynamic suspend `failed`), so `suspensionCoverageViolations` exempts them, as
 * it exempts `decidingArmAttempts` and `pipelineLaneAttempts`. They are not unchecked:
 * `compensateStructureViolations` S3 and S7 hold each suspended exit to its own settle. Empty for a
 * net with no ladder; an attempt with no net-map entry is never exempt.
 */
export function compensatorAttempts(compiled: CompiledWorkflow): ReadonlySet<string> {
  const site = compiled.compensations;
  if (site === undefined) return new Set();
  const mapped = compiled.netMap.transitionToEntry;
  return new Set(site.compensators.flatMap((c) => c.attempts).filter((a) => mapped.has(a)));
}

const FIVE: readonly CompensatorExitKind[] = ['done', 'failed', 'bailed', 'suspended', 'paused'];
const DISCHARGES: readonly DischargeKind[] = ['done', 'bailed', 'suspended', 'paused', 'canceled'];

/**
 * The places some run may mark, from the arcs alone (S8): the union of every default segment's seed
 * — the entry place, every top-level boundary and resume site, the cancel request, every pool, and
 * `ladderLevel` at each — closed under "every place a transition takes or reads is markable, so every
 * place it gives is". Counts, colours and inhibitors are ignored, so the set over-approximates.
 */
function markable(compiled: CompiledWorkflow, site: CompensationSite): ReadonlySet<string> {
  const marked = new Set<string>([compiled.entryPlace.name, compiled.cancelRequest.name, ...compiled.pools.map((p) => p.place.name)]);
  const seed = (name: string, at: number): void => {
    marked.add(name);
    marked.add(ladderLevel(site, at).place);
  };
  seed(compiled.entryPlace.name, 0);
  for (const b of compiled.boundaries) seed(b.place.name, b.index);
  for (const s of compiled.resumeSites.values()) seed(s.place.name, s.path[0]);
  const pending = [...compiled.net.transitions];
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const t = pending[i]!;
      if (![...t.inputSpecs.map((s) => s.place.name), ...t.reads.map((a) => a.place.name)].every((p) => marked.has(p))) continue;
      for (const p of t.outputPlaces()) marked.add(p.name);
      pending.splice(i, 1);
      changed = true;
    }
  }
  return marked;
}

/** Whether `out` is a place or an `and` of places — every place given on every firing. */
function allAnd(out: Out): boolean {
  return out.type === 'place' || (out.type === 'and' && out.children.every(allAnd));
}

function describeIns(t: Transition): string {
  return `[${t.inputSpecs.map((s) => (s.type === 'one' ? s.place.name : `${s.type}(${s.place.name})`)).join(', ')}]`;
}

function describeOut(t: Transition): string {
  const go = (o: Out): string =>
    o.type === 'place' ? o.place.name
    : o.type === 'and' ? o.children.map(go).join(' + ')
    : o.type === 'xor' ? `xor(${o.children.map(go).join(' | ')})`
    : o.type === 'timeout' ? `timeout(${go(o.child)})`
    : `forward(${o.from.name} -> ${o.to.name})`;
  return t.outputSpec === null ? 'nothing (a null Out)' : `[${go(t.outputSpec)}]`;
}

function list(names: readonly string[]): string {
  return `[${[...names].sort().join(', ')}]`;
}

/** Equal as sets, and neither has a duplicate. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return a.length === x.length && b.length === y.length && x.length === y.length && x.every((v, i) => v === y[i]);
}

function sameSequence(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

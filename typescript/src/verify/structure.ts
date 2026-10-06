import type { Place, Transition } from 'libpetri';
import type { CompiledWorkflow } from '../compiler/types.js';
import { pipelineLaneAttempts } from './pipeline.js';
import { compensatorAttempts } from './compensate.js';

/**
 * Checks, from the arcs alone, the cancellation invariants no verified property can see.
 *
 * A start transition that lost its inhibitor on the cancel place still lets the run drain to
 * exactly one terminal — the extra work it starts ends up swept or re-stamped — so every
 * quiescence property stays proven while the net does something Mastra would not. What makes the
 * design correct is structural, so it is checked structurally ([ADR 0004]):
 *
 * 1. **The signal is never consumed or cleared.** No input arc and no reset arc on the cancel
 *    place: once a cancellation has arrived it stays, so every later check sees it. Only the
 *    arrival transition consumes the request place.
 * 2. **A sweep never competes with an ungated start.** A sweep consumes a waiting token when the
 *    signal is marked. Another transition whose inputs contain the sweep's, or are contained in
 *    them, can be enabled together with the sweep and take the token it was meant to sweep — so it
 *    must be inhibited by the signal (or be a sweep itself). Partial overlap is left alone: a
 *    transition that needs something the sweep does not (a body's failure, say) *and* lacks
 *    something the sweep needs (the result it would sweep) never competes with it.
 *
 * Returns one line per violation; empty means sound.
 */
export function cancelStructureViolations(compiled: CompiledWorkflow): readonly string[] {
  const cancel = compiled.cancel.name;
  const request = compiled.cancelRequest.name;
  const out: string[] = [];
  const names = (places: readonly { readonly place: Place<unknown> }[]): string[] => places.map((a) => a.place.name);
  const consumes = (t: Transition): string[] => t.inputSpecs.map((i) => i.place.name);
  const readsSignal = (t: Transition): boolean => names(t.reads).includes(cancel);
  const inhibitedBySignal = (t: Transition): boolean => names(t.inhibitors).includes(cancel);

  if (![...compiled.net.places].some((p) => p.name === cancel)) out.push(`the cancel place '${cancel}' is not in the net`);
  if (![...compiled.net.places].some((p) => p.name === request)) out.push(`the cancel request place '${request}' is not in the net`);

  const transitions = [...compiled.net.transitions];
  const sweeps: Transition[] = [];
  for (const t of transitions) {
    if (consumes(t).includes(cancel)) out.push(`'${t.name}' consumes the cancel signal; it must only read or inhibit on it`);
    if (names(t.resets).includes(cancel)) out.push(`'${t.name}' resets the cancel signal`);
    // By name: `place()` does not intern, so a same-named place built elsewhere is the same place
    // to the executor and must be the same place here.
    if (consumes(t).includes(request) && ![...t.outputPlaces()].some((p) => p.name === cancel)) {
      out.push(`'${t.name}' consumes the cancel request without delivering the signal`);
    }
    if (readsSignal(t) && consumes(t).length > 0) sweeps.push(t);
  }
  for (const t of transitions) {
    if (readsSignal(t) || inhibitedBySignal(t)) continue;
    const needs = new Set(consumes(t));
    for (const sweep of sweeps) {
      const swept = consumes(sweep);
      const contains = swept.every((p) => needs.has(p));
      const contained = needs.size > 0 && [...needs].every((p) => swept.includes(p));
      if (contains || contained) {
        const contested = swept.filter((p) => needs.has(p));
        out.push(`'${t.name}' competes with sweep '${sweep.name}' for [${contested.join(', ')}] without an inhibitor on '${cancel}'`);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Resume ([ADR 0007]). A resumed run is a segment seeded with one token at a registered site, and
// each site is proven as its own segment. These three checks are what those proofs stand on and
// cannot see themselves; `verifyWorkflow` runs them before any proof, as it runs the cancel check.
// Places and transitions are compared by name throughout, for the reason given above.
// ---------------------------------------------------------------------------------------------

const consumesPlace = (t: Transition, name: string): boolean => t.inputSpecs.some((i) => i.place.name === name);
const readsPlace = (t: Transition, name: string): boolean => t.reads.some((a) => a.place.name === name);
const inhibitedBy = (t: Transition, name: string): boolean => t.inhibitors.some((a) => a.place.name === name);
const producesInto = (t: Transition, name: string): boolean => [...t.outputPlaces()].some((p) => p.name === name);
const isTimed = (t: Transition): boolean => t.timing.type !== 'immediate';
const describeTiming = (t: Transition): string => {
  const timing = t.timing;
  switch (timing.type) {
    case 'immediate': return 'immediate';
    case 'deadline': return `deadline(${timing.byMs})`;
    case 'delayed': return `delayed(${timing.afterMs})`;
    case 'window': return `window(${timing.earliestMs}, ${timing.latestMs})`;
    case 'exact': return `exact(${timing.atMs})`;
  }
};

/**
 * Every resume site is gated on the cancel signal and swept beside it — Mastra's check before an
 * entry (`default.ts:815`) holds for a resumed segment too — and is marked only by the seed.
 *
 * For each registered site `s` (keyed by its path joined with `.`):
 *
 * 1. **The key is the path**, and the site's place is in the net.
 * 2. **Every consumer of the site place is a gate or a sweep.** A sweep reads `wf.cancel`; every
 *    other consumer — the gate: `re-enter-j`, the foreach's `re-enter`, a top-level step's first
 *    attempt, a loop's `start` — is inhibited by it. An ungated consumer starts work after a
 *    cancel Mastra would not start, and still drains to one terminal, so no proof sees it.
 * 3. **There is at least one gate and at least one sweep.** No gate strands the seed; no sweep
 *    strands it under a cancel that arrived first.
 * 4. **Nothing resets the site place.** A reset would discard the seed without a terminal.
 * 5. **An arm or foreach site is marked only by the seed**: no transition produces into it, so
 *    its gate is dead in a fresh run — which is why a fresh segment's proof says nothing about it,
 *    and why each site is proven as its own segment. A top-level entry site is the entry's own
 *    input place, which the entry before it does produce into; it must be that place — the one
 *    the net map records for the entry at that path.
 * 6. **A sweep goes where the fresh entry's sweep goes**: every output place of a site's sweep is
 *    the enclosing canceled exit — for every site, since every site is at a top-level entry's path
 *    (`[i]` or `[i, a]`), that is the top-level exit `compile` wires to `wf.canceled`, or to
 *    `wf.comp.exit.canceled` under a compensation ladder ([ADR 0017]) — and it has at least one. A sweep re-routed to `wf.done` still drains to exactly one terminal and never
 *    marks `wf.canceled` where no cancel arrives, so every proof stays proven; only this sees it.
 *
 * Returns one line per violation; empty means sound, and is empty for a workflow with no sites.
 */
export function resumeGateViolations(compiled: CompiledWorkflow): readonly string[] {
  const cancel = compiled.cancel.name;
  // With a compensation ladder ([ADR 0017], intercept mode) the top-level canceled exit is
  // `wf.comp.exit.canceled`, which `discharge_j.canceled` moves into `wf.canceled`.
  const canceled = compiled.compensations?.exits.canceled ?? compiled.terminals.canceled.name;
  const out: string[] = [];
  const transitions = [...compiled.net.transitions];
  const placeNames = new Set([...compiled.net.places].map((p) => p.name));

  for (const [key, site] of compiled.resumeSites) {
    const name = site.place.name;
    const where = `resume site ${key} ('${name}')`;
    if (key !== site.path.join('.')) out.push(`resume site ${key} is registered at path [${site.path.join(', ')}]; the key must be the path`);
    if (!placeNames.has(name)) {
      out.push(`${where} is not a place in the net`);
      continue;
    }

    const consumers = transitions.filter((t) => consumesPlace(t, name));
    const sweeps = consumers.filter((t) => readsPlace(t, cancel));
    const gates = consumers.filter((t) => !readsPlace(t, cancel));
    for (const gate of gates) {
      if (!inhibitedBy(gate, cancel)) out.push(`'${gate.name}' consumes ${where} without an inhibitor on '${cancel}'`);
    }
    if (gates.length === 0) out.push(`${where} has no gate: nothing consumes it without reading '${cancel}'`);
    if (sweeps.length === 0) out.push(`${where} has no sweep: nothing reads '${cancel}' and consumes it`);
    for (const sweep of sweeps) {
      const outputs = [...sweep.outputPlaces()].map((p) => p.name);
      const stray = outputs.filter((p) => p !== canceled);
      if (outputs.length === 0) out.push(`sweep '${sweep.name}' of ${where} outputs nothing; it must output into '${canceled}'`);
      else if (stray.length > 0) {
        out.push(`sweep '${sweep.name}' of ${where} outputs into ${stray.map((p) => `'${p}'`).join(', ')}; a site sweep outputs only into '${canceled}'`);
      }
    }
    for (const t of transitions) {
      if (t.resets.some((a) => a.place.name === name)) out.push(`'${t.name}' resets ${where}`);
    }

    if (site.kind === 'entry') {
      const entry = compiled.netMap.placeToEntry.get(name);
      if (entry === undefined || entry.path.join('.') !== site.path.join('.')) {
        out.push(`${where} is not the input place of the entry at [${site.path.join(', ')}]`);
      }
    } else {
      for (const t of transitions) {
        if (producesInto(t, name)) out.push(`'${t.name}' produces into ${where}; an ${site.kind} site is marked only by a resume seed`);
      }
    }
  }
  return out;
}

/**
 * Every step that can suspend lies under a registered resume site, so no suspension ends a run
 * that could not be resumed — and every construct that can suspend gets a proven segment.
 *
 * Every step attempt (`CompiledWorkflow.stepAttempts`) can suspend: the leaf's output names the
 * suspended exit on every attempt. An attempt is covered when:
 * - a site is registered at exactly its entry's path — a top-level step or a loop body at `[i]`
 *   (a loop's body is emitted at the loop's own path), or a `.parallel()`/`.branch()` arm at
 *   `[i, a]`; or
 * - it is a `.foreach()` lane's body at `[i, lane]` and a foreach site is registered at `[i]`.
 *
 * A sleep is not a step attempt and never suspends. The check is by path, not by construct: a
 * site registered at the wrong path reads as missing, which it is.
 *
 * **Exempt: the attempts inside a counted decision's arms** ({@link decidingArmAttempts}, [ADR
 * 0014]). Their suspension is a *miss* of the block, not a suspension of the run: the arm's suspended
 * exit is collected into the block's `miss` by `collect-susp`, and a `race` / `quorum` block never
 * suspends (wave 1; `docs/divergences.md` row 106). No resume site covers them and none should.
 * They are not unchecked: `decisionStructureViolations` rule 7 holds every outcome of an arm attempt
 * to its own chain or a declared collect, so a suspended exit that escaped the block would fail there.
 *
 * **Exempt: the attempts inside a pipeline's lanes** ({@link pipelineLaneAttempts}, [ADR 0015],
 * maintainer decision 4). A stage suspension ends the pipeline `suspended` at the lowest index, but
 * no resume site is registered for it: `Run.resume` there is refused by name (`pipeline`) at seed
 * time, so there is no resume segment to prove and none should be. They are not unchecked:
 * `pipelineStructureViolations` rule 7 holds each lane's suspended exit to its own settle or drop,
 * and every outcome of a lane attempt to its lane's exits or its own chain, so a suspension that
 * escaped the pipeline would fail there.
 *
 * **Exempt: every compensator's attempts** ({@link compensatorAttempts}, [ADR 0017], S7). A
 * compensator that suspends is unresolved — its settle returns the level and the rollback goes on —
 * and no resume site is registered for it. They are not unchecked: `compensateStructureViolations`
 * S3 and S7 hold each compensator exit to its own settle.
 */
export function suspensionCoverageViolations(compiled: CompiledWorkflow): readonly string[] {
  const out: string[] = [];
  const reported = new Set<string>();
  const exempt = new Set([...decidingArmAttempts(compiled), ...pipelineLaneAttempts(compiled), ...compensatorAttempts(compiled)]);
  for (const name of compiled.stepAttempts) {
    if (exempt.has(name)) continue;
    const entry = compiled.netMap.transitionToEntry.get(name);
    if (entry === undefined) {
      out.push(`step attempt '${name}' has no entry in the net map`);
      continue;
    }
    const key = entry.path.join('.');
    const covered =
      compiled.resumeSites.has(key) ||
      (entry.path.length === 2 && compiled.resumeSites.get(String(entry.path[0]))?.kind === 'foreach');
    if (!covered && !reported.has(key)) {
      reported.add(key);
      out.push(`step '${entry.id}' at [${entry.path.join(', ')}] ('${name}') can suspend, and no resume site covers it`);
    }
  }
  return out;
}

/**
 * The step attempts inside an arm of a counted decision ([ADR 0014]): every attempt whose entry path
 * lies strictly under a block's `path` (`[...path, i, …]`), nested arms included. Their suspension is
 * a miss of the block, which never suspends, so {@link suspensionCoverageViolations} exempts them.
 * Empty for a net with no decisions; an attempt with no net-map entry is never exempt (the coverage
 * check reports it).
 */
export function decidingArmAttempts(compiled: CompiledWorkflow): ReadonlySet<string> {
  const out = new Set<string>();
  if (compiled.decisions.length === 0) return out;
  for (const name of compiled.stepAttempts) {
    const entry = compiled.netMap.transitionToEntry.get(name);
    if (entry === undefined) continue;
    if (compiled.decisions.some((d) => entry.path.length > d.path.length && d.path.every((x, j) => entry.path[j] === x))) out.add(name);
  }
  return out;
}

/**
 * No timed transition is enabled by a resume seed. A resumed segment starts every clock fresh,
 * as Mastra's does; that is safe only if the seed, and what its gate emits at once, feed immediate
 * transitions — then a timed transition first becomes enabled by an event of the resumed run
 * itself, and its clock starting then is simply right. (It is also why TIME-010/011, a restored
 * clock's hazards, do not arise for resume.)
 *
 * For each site: every consumer of the site place is immediate, and so is every consumer of a
 * gate's direct outputs — an arm's input, each `replay-i`, the foreach's frame, cursor, results,
 * parked and lane permits. The one exception is a leaf's **retry hop**: when a top-level step is
 * its own site's gate, its failed attempt emits into `retry-n`, whose `delayed` wait is a lower
 * bound after an attempt that ran in this segment (it fails safe). A retry hop is recognised
 * structurally: `delayed`, one input produced only by step attempts (and their timeout funnels,
 * [ADR 0013]), and every output consumed only by step attempts.
 */
export function resumeTimingViolations(compiled: CompiledWorkflow): readonly string[] {
  const cancel = compiled.cancel.name;
  const out: string[] = [];
  const transitions = [...compiled.net.transitions];
  const attempts = new Set(compiled.stepAttempts);
  // A timeout funnel ([ADR 0013]) forwards a timed-out attempt into the same retry place its attempt
  // fails into, so a hop's input is produced by attempts and funnels.
  const funnels = new Set(compiled.steps.flatMap((chain) => chain.timeouts));
  const consumersOf = (name: string): Transition[] => transitions.filter((t) => consumesPlace(t, name));
  const producersOf = (name: string): Transition[] => transitions.filter((t) => producesInto(t, name));
  const onlyAttempts = (ts: readonly Transition[]): boolean => ts.length > 0 && ts.every((t) => attempts.has(t.name));
  const onlyAttemptsOrFunnels = (ts: readonly Transition[]): boolean =>
    ts.some((t) => attempts.has(t.name)) && ts.every((t) => attempts.has(t.name) || funnels.has(t.name));
  // An attempt drawing on a rate quota is entered through its immediate request ([ADR 0012]), which
  // relays the link to the attempt and marks the demand: a hop feeding one still feeds an attempt.
  const demands = new Set(compiled.pools.flatMap((pool) => (pool.kind === 'bucket' ? [pool.demand.name] : [])));
  const isRequest = (t: Transition): boolean =>
    !isTimed(t) &&
    [...t.outputPlaces()].some((p) => !demands.has(p.name)) &&
    [...t.outputPlaces()].every((p) => demands.has(p.name) || onlyAttempts(consumersOf(p.name)));
  const intoAttempts = (ts: readonly Transition[]): boolean => ts.length > 0 && ts.every((t) => attempts.has(t.name) || isRequest(t));
  const isRetryHop = (t: Transition): boolean =>
    t.timing.type === 'delayed' &&
    t.inputSpecs.length === 1 &&
    onlyAttemptsOrFunnels(producersOf(t.inputSpecs[0]!.place.name)) &&
    [...t.outputPlaces()].every((p) => intoAttempts(consumersOf(p.name)));

  for (const [key, site] of compiled.resumeSites) {
    const name = site.place.name;
    for (const t of consumersOf(name)) {
      if (isTimed(t)) out.push(`'${t.name}' is timed (${describeTiming(t)}) and consumes resume site ${key} ('${name}')`);
    }
    const gates = consumersOf(name).filter((t) => !readsPlace(t, cancel));
    const seen = new Set<string>();
    for (const gate of gates) {
      for (const q of gate.outputPlaces()) {
        for (const t of consumersOf(q.name)) {
          if (!isTimed(t) || isRetryHop(t) || seen.has(`${t.name}|${q.name}`)) continue;
          seen.add(`${t.name}|${q.name}`);
          out.push(`'${t.name}' is timed (${describeTiming(t)}) and consumes '${q.name}', which gate '${gate.name}' of resume site ${key} emits into`);
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Restart ([ADR 0010]). A restarted run is a segment seeded with one token at a top-level boundary,
// and a checkpoint is a transition between entry i and entry i+1 that awaits a storage write. Both
// are proven as segments of the same net; these are what those proofs cannot see.
// ---------------------------------------------------------------------------------------------

/**
 * The checkpoint transitions after entry `index`, as `NameVocabulary.checkpointTransition` mints
 * them: the write `t.<i>.checkpoint` and its sweep `t.<i>.checkpoint-cancel` (not ADR 0010's first
 * `t.<i>.checkpoint.cancel`, which a step with id `checkpoint` would mint as its own sweep).
 */
const checkpointName = (index: number): string => `t.${index}.checkpoint`;
const checkpointSweepName = (index: number): string => `t.${index}.checkpoint-cancel`;

/**
 * Every top-level boundary is the input place of its entry, and every checkpoint is gated on the
 * cancel signal and swept beside it to `wf.canceled` ([ADR 0010]).
 *
 * **Boundaries.** One per top-level entry, `boundaries[i].index === i`, its `entryId` and `entryKind`
 * entry `i`'s, its place a place of the net that the net map records as entry `[i]`'s input;
 * `boundaries[0].place` is the entry place. A restart seeds that place, so a boundary off by one
 * would restart the wrong entry and every proof of it would still hold.
 *
 * **Checkpoints.** For each `i` in `compiled.checkpoints` — an integer, ascending, and below the last
 * entry — there is exactly one checkpoint transition `t.<i>.checkpoint` and:
 * 1. it is **inhibited by `wf.cancel`** and does not read it: once a cancel has arrived no write is
 *    taken, as Mastra's check before the next entry would stop the run;
 * 2. it consumes exactly one place, the checkpoint place, and its only output is entry `i + 1`'s
 *    boundary — the write sits on the success path between the two entries and nowhere else;
 * 3. its **sweep** `t.<i>.checkpoint-cancel` exists, reads `wf.cancel`, consumes the same place, and
 *    its only output is `wf.canceled`, or `wf.comp.exit.canceled` under a compensation ladder
 *    ([ADR 0017]) — the run ends unwritten, as every other sweep does
 *    (`resumeGateViolations`, rule 6). Not entry `i + 1`'s boundary, as ADR 0010 first drew it: a
 *    sweep leading back into work kept the cancel signal live downstream, and liveness witnesses went
 *    from ~100 ms to `unknown` at 30 s (`gadgets/checkpoint.ts`). A sweep re-routed to `wf.done` still
 *    drains to exactly one terminal; only this sees it;
 * 4. nothing else consumes the checkpoint place.
 *
 * A transition named like a checkpoint after an entry that is not marked is reported too: the net
 * would take a write the description never asked for.
 *
 * Returns one line per violation; empty means sound, and an unmarked workflow has no checkpoint
 * lines. Compared by name, as the other checks are.
 */
export function checkpointStructureViolations(compiled: CompiledWorkflow): readonly string[] {
  const cancel = compiled.cancel.name;
  const out: string[] = [];
  const transitions = [...compiled.net.transitions];
  const byName = new Map(transitions.map((t) => [t.name, t]));
  const placeNames = new Set([...compiled.net.places].map((p) => p.name));
  const outputs = (t: Transition): string[] => [...t.outputPlaces()].map((p) => p.name);

  // Boundaries.
  if (compiled.boundaries.length !== compiled.entries.length) {
    out.push(`${compiled.boundaries.length} boundaries for ${compiled.entries.length} top-level entries; there is one per entry`);
  }
  compiled.boundaries.forEach((b, i) => {
    const where = `boundary ${i} ('${b.place.name}')`;
    if (b.index !== i) out.push(`boundary ${i} says it is at index ${b.index}`);
    const entry = compiled.entries[i];
    if (entry !== undefined && (b.entryId !== entry.id || b.entryKind !== entry.kind)) {
      out.push(`${where} names ${b.entryKind} '${b.entryId}'; entry ${i} is ${entry.kind} '${entry.id}'`);
    }
    if (!placeNames.has(b.place.name)) {
      out.push(`${where} is not a place in the net`);
      return;
    }
    const owner = compiled.netMap.placeToEntry.get(b.place.name);
    if (owner === undefined || owner.path.length !== 1 || owner.path[0] !== i) out.push(`${where} is not the input place of entry ${i}`);
  });
  if (compiled.boundaries[0] !== undefined && compiled.boundaries[0].place.name !== compiled.entryPlace.name) {
    out.push(`boundary 0 ('${compiled.boundaries[0].place.name}') is not the entry place '${compiled.entryPlace.name}'`);
  }

  // Checkpoints.
  const last = compiled.entries.length - 1;
  const marked = new Set<string>();
  compiled.checkpoints.forEach((i, n) => {
    if (!Number.isInteger(i) || i < 0 || i >= last) {
      out.push(`checkpoint after entry ${i}: a checkpoint is taken after a top-level entry other than the last (0..${last - 1})`);
      return;
    }
    if (n > 0 && i <= compiled.checkpoints[n - 1]!) out.push(`checkpoints [${compiled.checkpoints.join(', ')}] are not strictly ascending`);
    const entryId = compiled.entries[i]!.id;
    marked.add(checkpointName(i));
    marked.add(checkpointSweepName(i));
    const t = byName.get(checkpointName(i));
    if (t === undefined) {
      out.push(`checkpoint after entry ${i} ('${entryId}') has no transition '${checkpointName(i)}'`);
      return;
    }
    const next = compiled.boundaries[i + 1]?.place.name;
    if (!inhibitedBy(t, cancel)) out.push(`checkpoint '${t.name}' is not inhibited by '${cancel}'`);
    if (readsPlace(t, cancel)) out.push(`checkpoint '${t.name}' reads '${cancel}'; only its sweep does`);
    const consumed = t.inputSpecs.map((spec) => spec.place.name);
    if (consumed.length !== 1) {
      out.push(`checkpoint '${t.name}' consumes [${consumed.join(', ')}]; it consumes exactly its checkpoint place`);
      return;
    }
    const at = consumed[0]!;
    const goesOnlyToNext = (x: Transition): boolean => {
      const o = outputs(x);
      return next !== undefined && o.length > 0 && o.every((p) => p === next);
    };
    if (!goesOnlyToNext(t)) out.push(`checkpoint '${t.name}' outputs into [${outputs(t).join(', ')}]; its only output is entry ${i + 1}'s boundary '${next}'`);

    const sweep = byName.get(checkpointSweepName(i));
    if (sweep === undefined) out.push(`checkpoint '${t.name}' has no sweep '${checkpointSweepName(i)}'`);
    else {
      if (!readsPlace(sweep, cancel)) out.push(`sweep '${sweep.name}' does not read '${cancel}'`);
      const swept = sweep.inputSpecs.map((spec) => spec.place.name);
      if (swept.length !== 1 || swept[0] !== at) out.push(`sweep '${sweep.name}' consumes [${swept.join(', ')}]; it consumes exactly '${at}', as its checkpoint does`);
      // [ADR 0017]: with a ladder, a checkpoint sweep is intercepted like every top-level one.
      const canceled = compiled.compensations?.exits.canceled ?? compiled.terminals.canceled.name;
      const so = outputs(sweep);
      if (so.length === 0 || !so.every((p) => p === canceled)) out.push(`sweep '${sweep.name}' outputs into [${so.join(', ')}]; its only output is '${canceled}'`);
    }
    for (const other of transitions) {
      if (other === t || other === sweep || !consumesPlace(other, at)) continue;
      out.push(`'${other.name}' consumes checkpoint place '${at}'; only '${t.name}' and its sweep do`);
    }
  });
  for (const t of transitions) {
    if (/^t\.\d+\.checkpoint(?:-cancel)?$/.test(t.name) && !marked.has(t.name)) {
      out.push(`'${t.name}' is a checkpoint after an entry that is not marked`);
    }
  }
  return out;
}

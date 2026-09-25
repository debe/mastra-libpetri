import type { In, Place, Transition } from 'libpetri';
import { pathSegment, slug } from '../compiler/names.js';
import type { CompiledWorkflow } from '../compiler/types.js';

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
// each site is proven as its own segment. These four checks are what those proofs stand on and
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
 *    (`[i]` or `[i, a]`), that is the top-level exit `compile` wires to `wf.canceled` — and it has
 *    at least one. A sweep re-routed to `wf.done` still drains to exactly one terminal and never
 *    marks `wf.canceled` where no cancel arrives, so every proof stays proven; only this sees it.
 *
 * Returns one line per violation; empty means sound, and is empty for a workflow with no sites.
 */
export function resumeGateViolations(compiled: CompiledWorkflow): readonly string[] {
  const cancel = compiled.cancel.name;
  const canceled = compiled.terminals.canceled.name;
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
 * Every arc on a `.foreach()`'s counting places — `results`, `suspensions` and `parked` — is a
 * threshold arc: an `all()` input, a read, an inhibitor, a reset or an output. Never `one()`,
 * `exactly(n)` or `atLeast(n > 1)`.
 *
 * The analyses deposit one token per named place of a firing's branch ([IO-016]), and a resume
 * seeds these places with **one** token standing for any number of items. That model is exact
 * only when no arc can tell one token from many: then enablement depends on "at least one" alone,
 * and every count from one up behaves as the one the proof explored. A `one()` arc breaks it — a
 * run with two parked items fires it twice, the proof once — and nothing in a proof shows that.
 * So it is checked here, structurally, and reported as a structural result, not an SMT one.
 *
 * The places are found by the foreach's registered name, `s.<i>.<id>.<role>`, for every top-level
 * foreach in the net map. `results` and `suspensions` must exist; `parked` must exist wherever the
 * foreach has a resume site, since that is where the seed puts parked items.
 */
export function thresholdOnlyViolations(compiled: CompiledWorkflow): readonly string[] {
  const out: string[] = [];
  const placeNames = new Set([...compiled.net.places].map((p) => p.name));
  const transitions = [...compiled.net.transitions];

  for (const [key, entry] of compiled.netMap.pathToEntry) {
    if (entry.kind !== 'foreach') continue;
    const prefix = `s.${pathSegment(key.split('.').map(Number))}.${slug(entry.entryId)}.`;
    const hasSite = compiled.resumeSites.get(key)?.kind === 'foreach';
    for (const role of ['results', 'suspensions', 'parked'] as const) {
      const name = prefix + role;
      if (!placeNames.has(name)) {
        if (role !== 'parked' || hasSite) out.push(`foreach '${entry.entryId}' at [${key}] has no '${role}' place ('${name}')`);
        continue;
      }
      for (const t of transitions) {
        for (const spec of t.inputSpecs) {
          if (spec.place.name === name && !isThreshold(spec)) {
            out.push(`'${t.name}' consumes '${name}' with ${describeInput(spec)}; a foreach ${role} place takes only all()`);
          }
        }
      }
    }
  }
  return out;
}

function isThreshold(spec: In): boolean {
  return spec.type === 'all' || (spec.type === 'at-least' && spec.minimum <= 1);
}

function describeInput(spec: In): string {
  switch (spec.type) {
    case 'one': return 'one()';
    case 'exactly': return `exactly(${spec.count})`;
    case 'all': return 'all()';
    case 'at-least': return `atLeast(${spec.minimum})`;
  }
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
 */
export function suspensionCoverageViolations(compiled: CompiledWorkflow): readonly string[] {
  const out: string[] = [];
  const reported = new Set<string>();
  for (const name of compiled.stepAttempts) {
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
 * structurally: `delayed`, one input produced only by step attempts, and every output consumed
 * only by step attempts.
 */
export function resumeTimingViolations(compiled: CompiledWorkflow): readonly string[] {
  const cancel = compiled.cancel.name;
  const out: string[] = [];
  const transitions = [...compiled.net.transitions];
  const attempts = new Set(compiled.stepAttempts);
  const consumersOf = (name: string): Transition[] => transitions.filter((t) => consumesPlace(t, name));
  const producersOf = (name: string): Transition[] => transitions.filter((t) => producesInto(t, name));
  const onlyAttempts = (ts: readonly Transition[]): boolean => ts.length > 0 && ts.every((t) => attempts.has(t.name));
  const isRetryHop = (t: Transition): boolean =>
    t.timing.type === 'delayed' &&
    t.inputSpecs.length === 1 &&
    onlyAttempts(producersOf(t.inputSpecs[0]!.place.name)) &&
    [...t.outputPlaces()].every((p) => onlyAttempts(consumersOf(p.name)));

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

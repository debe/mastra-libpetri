import type { Place, Transition } from 'libpetri';
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

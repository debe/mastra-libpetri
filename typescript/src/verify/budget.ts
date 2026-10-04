import type { In, Out, Transition } from 'libpetri';
import type { CompiledWorkflow } from '../compiler/types.js';

/**
 * Checks, from the arcs alone, that the run's step budget is conserved ([ADR 0006]).
 *
 * `permitsBounded` and `permitsReturned` are proven over the analyses' model of a firing, which
 * deposits **one token per named place of the chosen branch** ([IO-016]): a branch spelled
 * `and(outPlace(permits), outPlace(permits))` is one permit to every analysis, so a proof cannot
 * see it. The invariant *permits + steps in flight = k* is a property of the arcs, so it is
 * checked on the arcs, the way `cancelStructureViolations` checks cancellation:
 *
 * 1. **A consumer takes exactly one.** A transition with an input arc on `wf.permits` has exactly
 *    one, and it is `one(permits)` (or `exactly(1, permits)`): never `all`, `atLeast`, or a count
 *    above one.
 * 2. **A consumer hands it back on every branch.** Every branch of its output spec — the xor
 *    alternatives, each an `and` of places, walked as a *multiset* so a place named twice counts
 *    twice — puts exactly one token into `wf.permits`. A branch returning none leaks a permit; one
 *    returning two mints one.
 * 3. **Nothing else touches the budget.** No other transition produces into `wf.permits`, and no
 *    transition reads it or resets it. A read would make a step's enablement depend on the free
 *    permit count without taking one; a reset would destroy permits a step in flight owes back.
 *
 * 4. **Every step attempt takes one, and only step attempts do.** The compiler records every
 *    step-attempt transition (`CompiledWorkflow.stepAttempts`). Under a budget each must consume a
 *    permit, and a permit consumer must be one of them. Rules 1–3 look only at transitions already
 *    touching the permits, so without this an attempt compiled with no permit at all — a gadget
 *    that forgot to pass the budget to its body — was invisible to them and to every proof.
 *
 * An inhibitor arc on `wf.permits` does not move a token and so cannot break conservation; it is
 * not flagged here. Places are compared **by name**: `place()` does not intern, and a same-named
 * place built elsewhere is the same place to the executor.
 *
 * Returns one line per violation; empty means sound, and is always empty when no budget was
 * compiled in.
 */
export function budgetStructureViolations(compiled: CompiledWorkflow): readonly string[] {
  const budget = compiled.budget;
  if (budget === undefined) return [];
  const permits = budget.permits.name;
  const out: string[] = [];

  if (![...compiled.net.places].some((p) => p.name === permits)) {
    out.push(`the permit place '${permits}' is not in the net`);
  }

  const attempts = new Set(compiled.stepAttempts);
  for (const t of compiled.net.transitions) {
    const takes = t.inputSpecs.filter((spec) => spec.place.name === permits);
    if (attempts.has(t.name) && takes.length === 0) out.push(`'${t.name}' is a step attempt and takes no permit`);
    if (!attempts.has(t.name) && takes.length > 0) out.push(`'${t.name}' takes a permit but is not a step attempt`);
    if (t.reads.some((arc) => arc.place.name === permits)) out.push(`'${t.name}' reads the permits; it must consume one or leave them alone`);
    if (t.resets.some((arc) => arc.place.name === permits)) out.push(`'${t.name}' resets the permits`);

    const branches = t.outputSpec === null ? [] : branchesOf(t.outputSpec);
    if (takes.length === 0) {
      if (branches.some((b) => (b.get(permits) ?? 0) > 0)) out.push(`'${t.name}' produces a permit it never consumed`);
      continue;
    }

    if (takes.length > 1) out.push(`'${t.name}' has ${takes.length} input arcs on the permits; a step takes exactly one`);
    for (const spec of takes) {
      if (!takesOne(spec)) out.push(`'${t.name}' consumes the permits with ${describeIn(spec)}; a step takes exactly one`);
    }
    if (t.outputSpec === null) {
      out.push(`'${t.name}' consumes a permit and has no output spec to return it on`);
      continue;
    }
    branches.forEach((branch, i) => {
      const n = branch.get(permits) ?? 0;
      if (n !== 1) out.push(`'${t.name}' branch ${i} (${describeBranch(branch)}) returns ${n} permits; every branch returns exactly one`);
    });
  }
  return out;
}

/** `one(p)` or `exactly(1, p)`: the only arcs that take a single token whatever is marked. */
function takesOne(spec: In): boolean {
  return spec.type === 'one' || (spec.type === 'exactly' && spec.count === 1);
}

export function describeIn(spec: In): string {
  switch (spec.type) {
    case 'one': return 'one()';
    case 'exactly': return `exactly(${spec.count})`;
    case 'all': return 'all()';
    case 'at-least': return `atLeast(${spec.minimum})`;
  }
}

/**
 * Every branch of `out` as a multiset of place names, in `enumerateBranches` order: `and` is a
 * cross product that **adds** counts, `xor` a union of alternatives, and a `timeout` contributes
 * its child's branches (as libpetri's own enumeration does). Unlike `enumerateBranches`, a place
 * named twice in one branch counts twice — the difference this check exists for.
 */
export function branchesOf(out: Out): ReadonlyMap<string, number>[] {
  switch (out.type) {
    case 'place':
      return [new Map([[out.place.name, 1]])];
    case 'forward-input':
      return [new Map([[out.to.name, 1]])];
    case 'timeout':
      return branchesOf(out.child);
    case 'xor':
      return out.children.flatMap(branchesOf);
    case 'and': {
      let result: Map<string, number>[] = [new Map()];
      for (const child of out.children) {
        const next: Map<string, number>[] = [];
        for (const left of result) {
          for (const right of branchesOf(child)) {
            const merged = new Map(left);
            for (const [name, n] of right) merged.set(name, (merged.get(name) ?? 0) + n);
            next.push(merged);
          }
        }
        result = next;
      }
      return result;
    }
  }
}

export function describeBranch(branch: ReadonlyMap<string, number>): string {
  return [...branch].map(([name, n]) => (n === 1 ? name : `${name}×${n}`)).join(' + ') || 'nothing';
}

/** For a caller that wants the transitions that take a permit — the step attempts. */
export function permitConsumers(compiled: CompiledWorkflow): readonly Transition[] {
  const permits = compiled.budget?.permits.name;
  if (permits === undefined) return [];
  return [...compiled.net.transitions].filter((t) => t.inputSpecs.some((spec) => spec.place.name === permits));
}

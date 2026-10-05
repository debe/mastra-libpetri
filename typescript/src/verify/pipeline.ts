import type { In, Transition } from 'libpetri';
import type { CompiledWorkflow, PipelineLaneSite, PipelineSite } from '../compiler/types.js';
import { branchesOf, describeBranch, describeIn } from './budget.js';

/**
 * Checks, from the arcs alone, that every pipeline is the shape its claims rest on ([ADR 0015],
 * amended by the W0 spike) — `structure.ts` style, over `CompiledWorkflow.pipelines` (the gadget's
 * declaration, never derived from the arcs it inspects), under "pipeline structure" in
 * `properties.ts`. Host-agnostic: the M10 candidate's check.
 *
 * For each `PipelineSite`, after the site resolves (every place and transition it names is in the
 * net, and its own counts agree — one bound per stage, each a whole number ≥ 1, `lanes` stage-major
 * with `flat` its index, `start` on stage 0 alone, `refuse` and the drops exactly when a signal is
 * given, `c_{j+1}` hand-offs per stage-`j` lane, `collect` on the last stage alone, four finishers or
 * eight; the other rules are not checked on a site that fails it):
 *
 * 1. **Hand-offs are rendezvous.** Each `to{m}` takes exactly `done_{j,l}`, `slot_{j,l}`,
 *    `permit_{j+1,m}`, is inhibited by `wf.cancel` (when a signal is given; nothing else inhibits,
 *    reads or resets), and gives exactly `body_{j+1,m}`, `slot_{j+1,m}`, `permit_{j,l}`, one branch.
 * 2. **Bodies have one source.** Stage `j + 1`'s body has no producer but stage-`j` hand-offs (every
 *    stage-`j` lane's hand-off to it), stage 0's none but its `start`; exactly the `start`s, the
 *    `refuse`s and the open-queue settles take `queue.open`, and only `split` and the `start`s give it.
 * 3. **One slot per item.** Every transition consuming a slot produces at most one slot, on every
 *    branch; a slot is given only where its body is (`start`, or the hand-offs into the lane).
 * 4. **Every exit is settled or dropped.** Every lane exit's `¬cancel` consumers are exactly the
 *    ones the site declares for it (`settles` by exit — three variants for `failed` and `suspended`;
 *    `handoffs` or `collect` for `done`), each inhibited by `wf.cancel`, and it has exactly one
 *    consumer reading `cancel`, its `drop` (none without a signal). The ADR's "exactly one `¬cancel`
 *    consumer" reads per variant: no exit has an undeclared consumer. Each consumer has its declared
 *    shape: a collect, bail or pause takes `exit + slot + frame` and gives `frame + permit`; a fail or
 *    suspend settle, at priority 1, takes `exit + slot + frame` with `queue.open + no-K`,
 *    `queue.closed + no-K` or `queue.closed + K` and gives `frame + permit + queue.closed + K`; a drop
 *    takes `exit + slot`, reads the signal and gives the permit alone. The unreachable `canceled`
 *    exit has no producer and no consumer.
 * 5. **Finishers wait for every lane.** Every finisher takes every permit of every stage, plus
 *    `queue.closed` and `frame`, plus one place of each flag pair — and nothing else.
 * 6. **Monotone.** No pipeline place carries an inhibitor, reset, read, `all()` (a drain) or
 *    `atLeast()` arc, and no pipeline transition an inhibitor, read or reset on any place but
 *    `wf.cancel` — so under [VER-004] the only split stays `t.cancel.arrive`.
 * 7. **A suspended exit stays in the pipeline.** A lane's `suspended` exit is produced only by its
 *    own body's attempts and reaches only its own settle or drop (consumed by nothing else, read by
 *    nothing); every place a lane attempt or timeout funnel gives into, pool places aside, is one of
 *    its lane's exits (or `done`) or a place only its own chain takes — so no lane suspension can
 *    reach a run terminal unsettled. What the `pipelineLaneAttempts` coverage exemption rests on.
 *
 * Mutants (`tests/verify/pipeline.test.ts`): one per rule, among them a hand-off without the next
 * permit; an inhibitor on `fault` added to a hand-off; a finisher missing a stage-1 permit; a collect
 * without its drop. Rule 8 of the amendment — no pipeline transition unreachable from the arcs — is a
 * test, not a claim.
 *
 * Places a pool owns (the run's permits, a quota and its holders, a bucket's demand) are set aside
 * in rule 7: a lane attempt takes and returns them beside its outcome.
 *
 * Returns one line per violation, prefixed by the foreach's id and path; empty for a net with no
 * pipelines.
 */
export function pipelineStructureViolations(compiled: CompiledWorkflow): readonly string[] {
  if (compiled.pipelines.length === 0) return [];
  const net = compiled.net;
  const cancel = compiled.cancel.name;
  const transitions = [...net.transitions];
  const byName = new Map(transitions.map((t) => [t.name, t] as const));
  const placeNames = new Set([...net.places].map((p) => p.name));
  const pooled = new Set<string>([
    ...(compiled.budget ? [compiled.budget.permits.name] : []),
    ...compiled.pools.flatMap((pool) => [pool.place.name, ...pool.holders.map((h) => h.place), ...(pool.kind === 'bucket' ? [pool.demand.name] : [])]),
  ]);
  const outputs = (t: Transition): string[] => [...t.outputPlaces()].map((p) => p.name);
  const producers = (p: string): string[] => transitions.filter((t) => outputs(t).includes(p)).map((t) => t.name);
  const consumers = (p: string): string[] => transitions.filter((t) => t.inputSpecs.some((s) => s.place.name === p)).map((t) => t.name);
  const readers = (p: string): string[] => transitions.filter((t) => t.reads.some((a) => a.place.name === p)).map((t) => t.name);
  const readsCancel = (t: Transition): boolean => t.reads.some((a) => a.place.name === cancel);
  const list = (names: readonly string[]): string => `[${[...names].sort().join(', ')}]`;
  const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
    const x = [...new Set(a)].sort();
    const y = [...new Set(b)].sort();
    return a.length === x.length && x.length === y.length && x.every((v, i) => v === y[i]);
  };

  const out: string[] = [];
  for (const site of compiled.pipelines) {
    const say = (rule: number, line: string): void => {
      out.push(`pipeline '${site.foreachId}' at ${site.path.join('-')}: rule ${rule}: ${line}`);
    };
    const T = (name: string): Transition => byName.get(name)!;
    const gated = site.cancelSweep !== undefined;

    // --- 0. The site resolves, and its own counts agree --------------------------------------
    const counts = siteCountViolations(site);
    if (counts.length === 0) {
      const missingPlaces = sitePlaces(site).filter((p) => !placeNames.has(p));
      const missingTransitions = siteTransitions(site).filter((t) => !byName.has(t));
      if (missingPlaces.length > 0) counts.push(`names place(s) ${missingPlaces.map((p) => `'${p}'`).join(', ')}, not in the net`);
      if (missingTransitions.length > 0) counts.push(`names transition(s) ${missingTransitions.map((t) => `'${t}'`).join(', ')}, not in the net`);
    }
    if (counts.length > 0) {
      counts.forEach((line) => say(0, line));
      continue;
    }

    const { lanes, bounds } = site;
    const s = bounds.length;
    const offset = (j: number): number => bounds.slice(0, j).reduce((a, c) => a + c, 0);
    const stageLanes = (j: number): readonly PipelineLaneSite[] => lanes.slice(offset(j), offset(j) + bounds[j]!);
    const slots = new Set(lanes.map((l) => l.slot));
    const pipelinePlaces = new Set(sitePlaces(site));
    const declared = new Set(siteTransitions(site));
    const inhibitorNames = (t: Transition): string[] => t.inhibitors.map((a) => a.place.name);
    /** `t` takes exactly these places, one token each, and nothing else. */
    const takesExactly = (rule: number, t: Transition, want: readonly string[], what: string): void => {
      const got = t.inputSpecs.map((spec) => (takesOne(spec) ? spec.place.name : `${describeIn(spec)} ${spec.place.name}`));
      if (!sameSet(got, want)) say(rule, `'${t.name}' consumes [${t.inputSpecs.map((spec) => `${describeIn(spec)} ${spec.place.name}`).join(', ')}]; ${what}`);
    };
    /** `t` has one output branch, exactly one token into each of `want`. */
    const givesExactly = (rule: number, t: Transition, want: readonly string[], what: string): void => {
      const branches = t.outputSpec === null ? [] : branchesOf(t.outputSpec);
      const ok =
        branches.length === 1 && branches[0]!.size === want.length && want.every((p) => branches[0]!.get(p) === 1);
      if (!ok) say(rule, `'${t.name}' gives ${branches.length === 0 ? 'nothing' : branches.map((b) => `(${describeBranch(b)})`).join(' | ')}; ${what}`);
    };
    /** A `¬cancel` transition: inhibited by the signal exactly when one is given, reading nothing. */
    const gatedByCancel = (rule: number, t: Transition): void => {
      const inh = inhibitorNames(t);
      if (!sameSet(inh, gated ? [cancel] : [])) say(rule, `'${t.name}' is inhibited by [${inh.join(', ')}]; it is inhibited by ${gated ? `'${cancel}' alone` : 'nothing (no signal)'}`);
      if (t.reads.length > 0) say(rule, `'${t.name}' reads [${t.reads.map((a) => a.place.name).join(', ')}]; it reads nothing`);
    };

    // --- 1. Hand-offs are rendezvous ------------------------------------------------------------
    for (const lane of lanes) {
      if (lane.stage === s - 1) continue;
      const next = stageLanes(lane.stage + 1);
      lane.handoffs.forEach((name, m) => {
        const t = T(name);
        const target = next[m]!;
        takesExactly(1, t, [lane.done, lane.slot, target.permit], `a hand-off takes exactly one each of '${lane.done}', '${lane.slot}' and '${target.permit}'`);
        givesExactly(1, t, [target.body, target.slot, lane.permit], `a hand-off gives exactly one each of '${target.body}', '${target.slot}' and '${lane.permit}'`);
        gatedByCancel(1, t);
        if (t.resets.length > 0) say(1, `'${name}' resets [${t.resets.map((a) => a.place.name).join(', ')}]; a hand-off resets nothing`);
      });
    }

    // --- 2. Bodies have one source --------------------------------------------------------------
    /** What may give lane `lane`'s body and slot: its `start`, or every hand-off into it. */
    const sourcesOf = (lane: PipelineLaneSite): string[] => {
      if (lane.stage === 0) return [lane.start!];
      const m = lane.lane;
      return stageLanes(lane.stage - 1).map((from) => from.handoffs[m]!);
    };
    for (const lane of lanes) {
      const want = sourcesOf(lane);
      const by = producers(lane.body);
      if (!sameSet(by, want)) say(2, `lane body '${lane.body}' is produced by ${list(by)}; only ${list(want)} may`);
    }
    const starts = lanes.flatMap((l) => (l.start === undefined ? [] : [l.start]));
    const refuses = lanes.flatMap((l) => (l.refuse === undefined ? [] : [l.refuse]));
    const openSettles = lanes.flatMap((l) => [l.settles.fail[0], l.settles.suspend[0]]);
    const openTakers = consumers(site.queueOpen);
    const openWant = [...starts, ...refuses, ...openSettles];
    if (!sameSet(openTakers, openWant)) say(2, `'${site.queueOpen}' is consumed by ${list(openTakers)}; exactly the starts, the refuses and the open-queue settles ${list(openWant)} take it`);
    const openGivers = producers(site.queueOpen).filter((t) => t !== site.split && !starts.includes(t));
    if (openGivers.length > 0) say(2, `'${site.queueOpen}' is produced by ${list(openGivers)}; only '${site.split}' and the starts may`);

    // --- 3. One slot per item -------------------------------------------------------------------
    for (const t of transitions) {
      if (!t.inputSpecs.some((spec) => slots.has(spec.place.name))) continue;
      const branches = t.outputSpec === null ? [] : branchesOf(t.outputSpec);
      branches.forEach((b, i) => {
        const n = [...b].filter(([p]) => slots.has(p)).reduce((a, [, c]) => a + c, 0);
        if (n > 1) say(3, `'${t.name}' consumes a slot and branch ${i} (${describeBranch(b)}) gives ${n} slots; at most one`);
      });
    }
    for (const lane of lanes) {
      const want = sourcesOf(lane);
      const by = producers(lane.slot);
      if (!sameSet(by, want)) say(3, `slot '${lane.slot}' is produced by ${list(by)}; only ${list(want)} may`);
    }

    // --- 4. Every exit is settled or dropped ----------------------------------------------------
    for (const lane of lanes) {
      const last = lane.stage === s - 1;
      const kinds = [
        ['done', lane.done, last ? [lane.collect!] : lane.handoffs],
        ['failed', lane.exits.failed, lane.settles.fail],
        ['suspended', lane.exits.suspended, lane.settles.suspend],
        ['bailed', lane.exits.bailed, [lane.settles.bail]],
        ['paused', lane.exits.paused, [lane.settles.pause]],
      ] as const;
      for (const [kind, exit, settles] of kinds) {
        const takers = consumers(exit);
        const quiet = takers.filter((name) => !readsCancel(T(name)));
        const dropping = takers.filter((name) => readsCancel(T(name)));
        if (!sameSet(quiet, settles)) say(4, `lane exit '${exit}' (${kind}) is consumed without reading '${cancel}' by ${list(quiet)}; exactly ${list(settles)} may`);
        const drop = lane.drops?.[kind];
        const dropWant = drop === undefined ? [] : [drop];
        if (!sameSet(dropping, dropWant)) {
          say(4, dropWant.length === 0
            ? `lane exit '${exit}' (${kind}) is consumed under '${cancel}' by ${list(dropping)}; without a signal nothing reads it`
            : dropping.length === 0
              ? `lane exit '${exit}' (${kind}) has no drop reading '${cancel}'; '${drop}' must take it`
              : `lane exit '${exit}' (${kind}) is consumed under '${cancel}' by ${list(dropping)}; exactly one drop, '${drop}', may`);
        }
        if (readers(exit).length > 0) say(4, `lane exit '${exit}' (${kind}) is read by ${list(readers(exit))}; it is consumed, never read`);
        if (drop !== undefined) {
          const t = T(drop);
          takesExactly(4, t, [exit, lane.slot], `a drop takes exactly one each of '${exit}' and '${lane.slot}'`);
          givesExactly(4, t, [lane.permit], `a drop gives exactly '${lane.permit}' and writes nothing`);
          if (!sameSet(t.reads.map((a) => a.place.name), [cancel])) say(4, `drop '${drop}' reads [${t.reads.map((a) => a.place.name).join(', ')}]; it reads '${cancel}' alone`);
          if (t.inhibitors.length > 0) say(4, `drop '${drop}' is inhibited by [${inhibitorNames(t).join(', ')}]; a drop is inhibited by nothing`);
        }
      }
      // The declared ¬cancel consumers' shapes (the hand-offs are rule 1's).
      const quietSettle = (name: string, exit: string): void => {
        const t = T(name);
        takesExactly(4, t, [exit, lane.slot, site.frame], `a settle takes exactly one each of '${exit}', '${lane.slot}' and '${site.frame}'`);
        givesExactly(4, t, [site.frame, lane.permit], `a settle gives exactly '${site.frame}' and '${lane.permit}'`);
        gatedByCancel(4, t);
      };
      if (last) quietSettle(lane.collect!, lane.done);
      quietSettle(lane.settles.bail, lane.exits.bailed);
      quietSettle(lane.settles.pause, lane.exits.paused);
      for (const [variants, exit, on, off] of [
        [lane.settles.fail, lane.exits.failed, site.fault, site.noFault],
        [lane.settles.suspend, lane.exits.suspended, site.susp, site.noSusp],
      ] as const) {
        const wants = [[site.queueOpen, off], [site.queueClosed, off], [site.queueClosed, on]] as const;
        variants.forEach((name, v) => {
          const t = T(name);
          const [queue, flag] = wants[v]!;
          takesExactly(4, t, [exit, lane.slot, site.frame, queue, flag], `this settle variant takes exactly one each of '${exit}', '${lane.slot}', '${site.frame}', '${queue}' and '${flag}'`);
          givesExactly(4, t, [site.frame, lane.permit, site.queueClosed, on], `a settle gives exactly '${site.frame}', '${lane.permit}', '${site.queueClosed}' and '${on}'`);
          gatedByCancel(4, t);
          if (t.priority !== 1) say(4, `settle '${name}' has priority ${t.priority}; a failure or suspension settles at priority 1`);
        });
      }
      const canceledBy = producers(lane.exits.canceled);
      const canceledTakers = [...consumers(lane.exits.canceled), ...readers(lane.exits.canceled)];
      if (canceledBy.length > 0 || canceledTakers.length > 0) {
        say(4, `lane exit '${lane.exits.canceled}' (canceled) is produced by ${list(canceledBy)} and taken by ${list(canceledTakers)}; it is unreachable, no arc touches it`);
      }
    }

    // --- 5. Finishers wait for every lane -------------------------------------------------------
    const permits = lanes.map((l) => l.permit);
    for (const name of site.finishers) {
      const t = T(name);
      const got = t.inputSpecs.map((spec) => spec.place.name);
      const missing = [site.queueClosed, site.frame, ...permits].filter((p) => !t.inputSpecs.some((spec) => spec.place.name === p && takesOne(spec)));
      if (missing.length > 0) say(5, `finisher '${name}' does not take one of each of ${list(missing)}; a finisher takes every permit of every stage, '${site.queueClosed}' and '${site.frame}'`);
      const flagsTaken = (pair: readonly [string, string]): number => t.inputSpecs.filter((spec) => pair.includes(spec.place.name) && takesOne(spec)).length;
      for (const pair of [[site.fault, site.noFault], [site.susp, site.noSusp]] as const) {
        if (flagsTaken(pair) !== 1) say(5, `finisher '${name}' takes ${flagsTaken(pair)} of [${pair.join(', ')}]; exactly one`);
      }
      const allowed = new Set([site.queueClosed, site.frame, ...permits, site.fault, site.noFault, site.susp, site.noSusp]);
      const stray = got.filter((p) => !allowed.has(p));
      if (stray.length > 0 || got.length !== new Set(got).size) say(5, `finisher '${name}' consumes [${got.join(', ')}]; nothing beyond the permits, the closed queue, the frame and the flags, each once`);
    }

    // --- 6. Monotone ----------------------------------------------------------------------------
    for (const t of transitions) {
      for (const [arcs, what] of [[t.inhibitors, 'an inhibitor'], [t.resets, 'a reset'], [t.reads, 'a read']] as const) {
        for (const arc of arcs) {
          if (pipelinePlaces.has(arc.place.name)) say(6, `'${t.name}' has ${what} on pipeline place '${arc.place.name}'; every pipeline place is monotone`);
          else if (declared.has(t.name) && (what === 'a reset' || arc.place.name !== cancel)) say(6, `pipeline transition '${t.name}' has ${what} on '${arc.place.name}'; it carries none but on '${cancel}'`);
        }
      }
      for (const spec of t.inputSpecs) {
        if (pipelinePlaces.has(spec.place.name) && (spec.type === 'all' || spec.type === 'at-least')) {
          say(6, `'${t.name}' takes ${describeIn(spec)} of pipeline place '${spec.place.name}'; no drain and no atLeast on a pipeline place`);
        }
      }
    }

    // --- 7. A suspended exit stays in the pipeline ----------------------------------------------
    for (const lane of lanes) {
      const lanePath = [...site.path, lane.flat];
      const chains = compiled.steps.filter((c) => c.path.length === lanePath.length && c.path.every((x, i) => x === lanePath[i]));
      const attempts = chains.flatMap((c) => c.attempts);
      const chainOwn = new Set(chains.flatMap((c) => [...c.attempts, ...c.hops, ...c.timeouts]));
      if (attempts.length === 0) say(7, `lane ${lane.flat} (stage ${lane.stage}, lane ${lane.lane}) has no step attempt at [${lanePath.join(', ')}]`);
      const suspended = lane.exits.suspended;
      const strangers = producers(suspended).filter((name) => !attempts.includes(name));
      if (strangers.length > 0) say(7, `lane exit '${suspended}' is produced by ${list(strangers)}, not by the lane's own attempts`);
      const reach = [...consumers(suspended), ...readers(suspended)];
      const own = [...lane.settles.suspend, ...(lane.drops === undefined ? [] : [lane.drops.suspended])];
      const escaping = reach.filter((name) => !own.includes(name));
      if (escaping.length > 0) say(7, `lane exit '${suspended}' reaches ${list(escaping)}; only its own settle or drop ${list(own)} may take it`);
      const outcomes = new Set([lane.done, lane.exits.failed, lane.exits.bailed, lane.exits.suspended, lane.exits.paused, lane.exits.canceled]);
      for (const name of chains.flatMap((c) => [...c.attempts, ...c.timeouts])) {
        const t = byName.get(name);
        if (t === undefined) continue;
        for (const p of outputs(t)) {
          if (pooled.has(p) || outcomes.has(p)) continue;
          const takers = consumers(p);
          if (takers.length === 0 || takers.some((x) => !chainOwn.has(x))) {
            say(7, `lane ${lane.flat}'s '${name}' gives into '${p}', consumed by ${list(takers)}; a lane step's outcome goes to its lane's exits or its own chain`);
          }
        }
      }
    }
  }
  return out;
}

/**
 * The step attempts inside a pipeline's lanes ([ADR 0015], maintainer decision 4): every attempt of
 * a stage's lane body, whose naming path is `[...site.path, L]` for a lane `L` of the site. A stage
 * suspension ends the pipeline `suspended` but registers no resume site — a resume there is refused
 * by name (`pipeline`) — so `suspensionCoverageViolations` exempts them, as it exempts
 * `decidingArmAttempts`. They are not unchecked: `pipelineStructureViolations` rule 7 holds each
 * suspended exit to its own settle or drop, and every lane attempt's outcome to its lane. Empty for
 * a net with no pipelines; an attempt with no net-map entry is never exempt (the coverage check
 * reports it).
 */
export function pipelineLaneAttempts(compiled: CompiledWorkflow): ReadonlySet<string> {
  const out = new Set<string>();
  if (compiled.pipelines.length === 0) return out;
  const lanePaths = new Set(compiled.pipelines.flatMap((site) => site.lanes.map((lane) => [...site.path, lane.flat].join('.'))));
  for (const name of compiled.stepAttempts) {
    const entry = compiled.netMap.transitionToEntry.get(name);
    if (entry !== undefined && lanePaths.has(entry.path.join('.'))) out.add(name);
  }
  return out;
}

/** Every place a site names: the frame, the queue, both flag pairs, and per lane its own. */
export function sitePlaces(site: PipelineSite): string[] {
  return [
    site.frame,
    site.queueOpen,
    site.queueClosed,
    site.fault,
    site.noFault,
    site.susp,
    site.noSusp,
    ...site.lanes.flatMap((l) => [l.permit, l.slot, l.body, l.done, l.exits.failed, l.exits.bailed, l.exits.suspended, l.exits.paused, l.exits.canceled]),
  ];
}

/** Every transition a site names, in declaration order: the sweep, `split`, each lane's, the finishers. */
export function siteTransitions(site: PipelineSite): string[] {
  const out: string[] = [];
  if (site.cancelSweep !== undefined) out.push(site.cancelSweep);
  out.push(site.split);
  for (const lane of site.lanes) {
    if (lane.start !== undefined) out.push(lane.start);
    if (lane.refuse !== undefined) out.push(lane.refuse);
    out.push(...lane.handoffs);
    if (lane.collect !== undefined) out.push(lane.collect);
    out.push(lane.settles.bail, lane.settles.pause, ...lane.settles.fail, ...lane.settles.suspend);
    if (lane.drops !== undefined) out.push(lane.drops.done, lane.drops.failed, lane.drops.bailed, lane.drops.suspended, lane.drops.paused);
  }
  out.push(...site.finishers);
  return out;
}

/** The site against its own counts (rule 0); empty when they agree. */
function siteCountViolations(site: PipelineSite): string[] {
  const out: string[] = [];
  const { stages, bounds, lanes } = site;
  if (!Array.isArray(stages) || !Array.isArray(bounds) || !Array.isArray(lanes) || !Array.isArray(site.finishers)) {
    return ['the site is missing its stages, bounds, lanes or finishers'];
  }
  if (stages.length === 0) out.push('names no stage; a pipeline has at least one');
  if (bounds.length !== stages.length) out.push(`has ${bounds.length} bound(s) for ${stages.length} stage(s)`);
  bounds.forEach((c, j) => {
    if (!Number.isSafeInteger(c) || c < 1) out.push(`stage ${j}'s bound is ${c}; a whole number ≥ 1`);
  });
  if (out.length > 0) return out;
  const s = bounds.length;
  const width = bounds.reduce((a, c) => a + c, 0);
  if (lanes.length !== width) return [`declares ${lanes.length} lane(s); the bounds [${bounds.join(', ')}] make ${width}`];
  const gated = site.cancelSweep !== undefined;
  let L = 0;
  for (let j = 0; j < s; j++) {
    for (let l = 0; l < bounds[j]!; l++, L++) {
      const lane = lanes[L]!;
      const where = `lane ${L}`;
      if (lane.flat !== L || lane.stage !== j || lane.lane !== l) out.push(`${where} says stage ${lane.stage}, lane ${lane.lane}, flat ${lane.flat}; stage-major it is stage ${j}, lane ${l}, flat ${L}`);
      if ((lane.start !== undefined) !== (j === 0)) out.push(`${where} ${j === 0 ? 'has no start; stage 0 admits' : 'has a start; only stage 0 admits'}`);
      if ((lane.refuse !== undefined) !== (j === 0 && gated)) out.push(`${where} ${lane.refuse === undefined ? 'has no refuse; stage 0 refuses under a signal' : 'has a refuse; only stage 0 refuses, and only under a signal'}`);
      const wantHandoffs = j === s - 1 ? 0 : bounds[j + 1]!;
      if (lane.handoffs.length !== wantHandoffs) out.push(`${where} declares ${lane.handoffs.length} hand-off(s); it needs ${wantHandoffs}`);
      if ((lane.collect !== undefined) !== (j === s - 1)) out.push(`${where} ${j === s - 1 ? 'has no collect; the last stage collects' : 'has a collect; only the last stage collects'}`);
      if (lane.settles.fail.length !== 3 || lane.settles.suspend.length !== 3) out.push(`${where} declares ${lane.settles.fail.length} fail and ${lane.settles.suspend.length} suspend settle(s); three of each`);
      if ((lane.drops !== undefined) !== gated) out.push(`${where} ${gated ? 'has no drops; every exit drops under a signal' : 'has drops without a signal'}`);
    }
  }
  const wantFinishers = gated ? 8 : 4;
  if (site.finishers.length !== wantFinishers) out.push(`declares ${site.finishers.length} finisher(s); it needs ${wantFinishers}`);
  return out;
}

function takesOne(spec: In): boolean {
  return spec.type === 'one' || (spec.type === 'exactly' && spec.count === 1);
}

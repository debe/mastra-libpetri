import { createHash } from 'node:crypto';
import { FusionSet, PetriNet, PrecompiledNet, Transition, delayed, one, outPlace, place, type Place } from 'libpetri';
import {
  NameVocabulary,
  WF_BAILED,
  T_CANCEL_ARRIVE,
  WF_CANCEL,
  WF_CANCEL_REQUEST,
  WF_CANCELED,
  WF_DONE,
  WF_FAILED,
  WF_PAUSED,
  WF_PERMITS,
  WF_SUSPENDED,
  type EntryPath,
  type QuotaRole,
} from './names.js';
import { MAX_WAIT_MS, stepGadget, sleepGadget } from './gadgets/leaf.js';
import { parallelGadget } from './gadgets/parallel.js';
import { branchGadget } from './gadgets/branch.js';
import { loopGadget } from './gadgets/loop.js';
import { foreachGadget } from './gadgets/foreach.js';
import { checkpointGadget, notStartedAt } from './gadgets/checkpoint.js';
import { compensateLadder, hasCompensation } from './blueprints/compensate.js';
import type { Gadget, GadgetContext, GadgetResult, NestedOptions } from './gadgets/types.js';
import type {
  BailToken,
  BoundarySite,
  CanceledToken,
  CompiledWorkflow,
  DecisionSite,
  EntryDescription,
  EntrySite,
  ExclusionClaim,
  Exits,
  FailureToken,
  FlowToken,
  PauseToken,
  PipelineSite,
  PlaceClaim,
  Pool,
  QuotaRef,
  ResumeSite,
  StepChain,
  StepDescription,
  SuspendToken,
  Terminals,
  TopLevelEntry,
  WorkflowDescription,
} from './types.js';

export interface CompileOptions {
  /** Override or extend the gadget registry — used by tests to compile one gadget in isolation. */
  readonly gadgets?: Partial<Record<EntryDescription['kind'], Gadget>>;
  /**
   * At most this many step attempts in flight at once, across the whole run ([ADR 0006]).
   * Omitted, steps run unbounded, as Mastra's do. A whole number in [1, MAX_CONCURRENCY].
   */
  readonly concurrency?: number;
}

/** The largest run budget: well past any real fan-out, and small enough to seed as tokens. */
export const MAX_CONCURRENCY = 1024;

/** One gadget per entry kind. */
export function defaultGadgets(): Record<EntryDescription['kind'], Gadget> {
  return {
    step: stepGadget,
    sleep: sleepGadget,
    sleepUntil: sleepGadget,
    parallel: parallelGadget,
    branch: branchGadget,
    loop: loopGadget,
    foreach: foreachGadget,
  };
}

/**
 * Compiles a workflow description into one Coloured Time Petri Net.
 *
 * **The emission rule.** Entry *i* owns an input place. Its gadget produces into entry *i+1*'s
 * input place, or into `wf.done` for the last entry; every other outcome goes to the workflow's
 * terminal for it. Nothing else connects them: the chain is the arcs, not a loop in the engine
 * ([ADR 0001]).
 *
 * The walk is right to left, because an entry needs its successor's place to emit into. A
 * combinator compiles its arms through `ctx.emitNested` without knowing what they are.
 *
 * **No runner.** The net is a function of the description alone; the kernel supplies the runner
 * per run. So two runs of one shape can share one compiled net, keyed by `structuralHash`.
 */
export function compile(description: WorkflowDescription, options: CompileOptions = {}): CompiledWorkflow {
  if (description.entries.length === 0) {
    // Mastra refuses this too, before persisting anything (`WORKFLOW_EXECUTE_EMPTY_GRAPH`).
    throw new Error(`workflow '${description.id}' has no entries; nothing to compile`);
  }
  const checkpoints = checkpointsOf(description);

  const names = new NameVocabulary();
  const gadgets = { ...defaultGadgets(), ...options.gadgets };
  const transitionToEntry = new Map<string, { path: EntryPath; id: string }>();
  const placeToEntry = new Map<string, { path: EntryPath; id: string }>();

  const terminals: Terminals = {
    done: place<FlowToken>(names.reserve(WF_DONE, 'workflow success terminal')),
    failed: place<FailureToken>(names.reserve(WF_FAILED, 'workflow failure terminal')),
    bailed: place<BailToken>(names.reserve(WF_BAILED, 'workflow early-exit terminal')),
    suspended: place<SuspendToken>(names.reserve(WF_SUSPENDED, 'workflow suspend terminal')),
    paused: place<PauseToken>(names.reserve(WF_PAUSED, 'workflow pause terminal')),
    canceled: place<CanceledToken>(names.reserve(WF_CANCELED, 'workflow cancel terminal')),
  };
  const cancel = place<null>(names.reserve(WF_CANCEL, 'cancellation signal'));
  const k = options.concurrency;
  if (k !== undefined && (!Number.isInteger(k) || k < 1 || k > MAX_CONCURRENCY)) {
    throw new Error(`concurrency must be a whole number in [1, ${MAX_CONCURRENCY}], got ${String(k)}`);
  }
  const permits = k === undefined ? undefined : place<null>(names.reserve(WF_PERMITS, 'step permits'));
  const cancelRequest = place<null>(names.reserve(WF_CANCEL_REQUEST, 'cancellation arrival'));

  const extraPlaces: Place<unknown>[] = [];
  const transitions: Transition[] = [];
  const stepAttempts: string[] = [];
  const steps: StepChain[] = [];
  const claims = new Map<string, PlaceClaim>();
  const exclusions: ExclusionClaim[] = [];
  // Pools the gadgets own ([ADR 0011]); the permits and the quota pools are added at the end.
  const gadgetPools: Pool[] = [];
  // Counted decisions ([ADR 0014]): one per race / quorum block, in emission order.
  const decisions: DecisionSite[] = [];
  // Pipelines ([ADR 0015]): one per `.foreach()` carrying a `pipeline`, in emission order.
  const pipelines: PipelineSite[] = [];
  // Resume sites ([ADR 0007]), keyed by path; a gadget registers its own through GadgetResult.
  const resumeSites = new Map<string, ResumeSite>();
  const pathToEntry = new Map<string, { entryId: string; kind: EntryDescription['kind'] }>();
  // One site per path: a stored `resumePath` must name exactly one place to seed.
  const registerSite = (site: ResumeSite): void => {
    const key = site.path.join('.');
    if (resumeSites.has(key)) throw new Error(`two resume sites at path ${key}`);
    resumeSites.set(key, site);
  };

  // The quotas ([ADR 0012]): one canonical set of places per id, minted up front in first-use order
  // (the description read left to right), so the pools exist — and their takers are checked — even
  // for an attempt a gadget compiled without its quota arc. Every member a gadget asks for is fused
  // into these at build.
  const quotas = new Map<string, QuotaPlaces>();
  for (const [ref, where] of quotaRefsOf(description)) registerQuota(quotas, names, ref, where);
  // Every member name minted, so a claim naming one fails with the reason, not just "not a place".
  const memberNames = new Set<string>();

  // **The arrival is part of the net.** Registering `wf.cancel` itself as an environment place
  // would be the direct model, but libpetri routes any net with an environment place away from
  // enumeration to SMT — measured at 0 of 103 cancellation proofs enumerated, up to 411s each,
  // and `unknown` on mutants a closed proof refutes in 7ms. So a proof seeds `wf.cancel.request`
  // and this immediate transition, at default priority, moves it on: the net stays closed, and
  // because `arrive` is enabled until it fires and nothing ever consumes `wf.cancel`, the verifier
  // explores exactly one arrival at every reachable point. At runtime the kernel injects into
  // `wf.cancel` itself — the same event, without this hop. One net serves both ([ADR 0004]).
  transitions.push(
    Transition.builder(names.reserve(T_CANCEL_ARRIVE, 'cancellation arrival transition'))
      .inputs(one(cancelRequest))
      .outputs(outPlace(cancel))
      .action(async (tctx) => {
        tctx.input(cancelRequest);
        tctx.output(cancel, null);
      })
      .build(),
  );

  // **The settle stage — Mastra's after-entry abort check.** Mastra re-stamps *any* top-level
  // entry's result as `canceled` when the signal fired while the entry ran, whatever that result
  // was (`handlers/entry.ts:815-817`); the step's own record keeps the real outcome, stored just
  // before. So a top-level outcome does not reach its terminal directly: it settles first, and a
  // pair of structurally exclusive transitions — one inhibited by the signal, one reading it —
  // decides between its terminal and `wf.canceled`. A success that is not the last entry needs no
  // settle place: it lands in the next entry's input, whose sweep is the same check.
  const settleOf = <T>(outcome: string, terminal: Place<T>, origin: (value: T) => CanceledToken): Place<T> => {
    const settle = place<T>(names.settlePlace(outcome));
    transitions.push(
      Transition.builder(names.settleTransition(outcome, false))
        .inputs(one(settle))
        .inhibitor(cancel)
        .outputs(outPlace(terminal))
        .action(async (tctx) => {
          tctx.output(terminal, tctx.input(settle));
        })
        .build(),
      Transition.builder(names.settleTransition(outcome, true))
        .inputs(one(settle))
        .read(cancel)
        .outputs(outPlace(terminals.canceled))
        .action(async (tctx) => {
          tctx.output(terminals.canceled, origin(tctx.input(settle)));
        })
        .build(),
    );
    return settle;
  };
  // A settled outcome is work that ran: the entry finished and the re-stamp turns it canceled.
  const originOf = (t: { stepId: string; path: EntryPath; foreachIndex?: number }): CanceledToken => ({
    origin: t.foreachIndex === undefined
      ? { stepId: t.stepId, path: t.path }
      : { stepId: t.stepId, path: t.path, foreachIndex: t.foreachIndex },
    started: true,
  });

  const topLevelExits: Exits = {
    failed: settleOf('failed', terminals.failed, originOf),
    bailed: settleOf('bailed', terminals.bailed, originOf),
    suspended: settleOf('suspended', terminals.suspended, originOf),
    paused: settleOf('paused', terminals.paused, originOf),
    // Already canceled: nothing left to decide.
    canceled: terminals.canceled,
  };
  const settleDone = settleOf('done', terminals.done, () => ({ started: true }));

  // **The compensation ladder** ([ADR 0017]), only when some step carries a `compensate`: every
  // top-level entry then emits into the ladder's exits (its failure raised into `wf.comp.failure`,
  // every other outcome intercepted into `wf.comp.exit.*`), each compensated entry's success arms a
  // level, and the ladder discharges into the settle stage above. Without one, `ladder` is undefined
  // and every line below emits exactly today's spine.
  const ladder = hasCompensation(description)
    ? compensateLadder({
        description,
        checkpoints,
        names,
        settles: topLevelExits,
        settleDone,
        terminals,
        cancel,
        transition: (t) => transitions.push(t),
        place: (p) => extraPlaces.push(p),
      })
    : undefined;
  const spineExits: Exits = ladder?.exits ?? topLevelExits;

  const emit = (
    entry: EntryDescription,
    path: EntryPath,
    next: Place<FlowToken>,
    exits: Exits,
    nextIsResult: boolean,
    nested: NestedOptions,
  ): GadgetResult => {
    const gadget = gadgets[entry.kind];
    if (gadget === undefined) throw new Error(`no gadget registered for '${entry.kind}'`);

    // One member per (quota id, role) in this emission: retries of one step share it.
    const members = new Map<string, Place<null>>();
    const ctx: GadgetContext = {
      path,
      viewPath: nested.viewPath ?? path,
      cancel: nested.cancel,
      // [ADR 0014]: only a deciding block's arms carry one; every other entry emits as before.
      preempt: nested.preempt,
      // [ADR 0015]: only a pipeline stage's lane body carries it; every other entry emits as before.
      item: nested.item,
      // [ADR 0017]: only a compensator leaf carries it; every other entry emits as before.
      detached: nested.detached,
      permits,
      stepAttempt: (transitionName) => {
        stepAttempts.push(transitionName);
      },
      stepChain: (chain) => {
        steps.push(chain);
      },
      // [ADR 0012]: one member per (emission, quota, role), fused into the quota's canonical place
      // at build; the compiler, not the gadget, emits the one refill per rate quota.
      quotaMember: (ref, role) => {
        const quota = registerQuota(quotas, names, ref, `entry ${path.join('-')} ('${entry.id}')`);
        if (role !== 'pool' && quota.ref.kind !== 'rate') {
          throw new Error(`quota '${ref.id}' is a limit; only a rateLimit has a '${role}' place`);
        }
        const key = `${ref.id}|${role}`;
        const known = members.get(key);
        if (known !== undefined) return known;
        const member = place<null>(names.quotaMember(path, entry.id, ref.id, role));
        members.set(key, member);
        memberNames.add(member.name);
        quota.members[role].push(member);
        return member;
      },
      names,
      exits,
      nextIsResult,
      // An arm's `next` is always a combinator-internal place, never the run's result, and it is
      // not gated unless the combinator says so: Mastra checks abort where it checks, not per step.
      emitNested: (step: StepDescription, childPath, childNext, childExits, options = {}) =>
        emit(step, childPath, childNext, childExits, false, options),
    };
    const result = gadget(entry, next, ctx);

    placeToEntry.set(result.inPlace.name, { path, id: entry.id });
    for (const t of result.transitions) {
      transitions.push(t);
      transitionToEntry.set(t.name, { path, id: entry.id });
    }
    if (result.places) extraPlaces.push(...result.places);
    for (const site of result.resumeSites ?? []) registerSite(site);
    for (const claim of result.claims ?? []) {
      if (claims.has(claim.place)) throw new Error(`two bound claims on place '${claim.place}'`);
      claims.set(claim.place, claim);
    }
    exclusions.push(...(result.exclusions ?? []));
    gadgetPools.push(...(result.pools ?? []));
    decisions.push(...(result.decisions ?? []));
    pipelines.push(...(result.pipelines ?? []));
    return result;
  };

  // Right to left: entry i produces into entry i+1's place, so that place must exist first. Every
  // top-level entry is gated: Mastra checks its signal before each one (`default.ts:815`).
  //
  // A checkpoint after entry i ([ADR 0010]) sits between the two: entry i's gadget produces into
  // `s.<i>.checkpoint`, the checkpoint's write into entry i+1's input, and its cancel sweep into
  // `wf.canceled`, reporting what entry i+1's own sweep would (`gadgets/checkpoint.ts`). An
  // unmarked entry emits exactly what it did before, so an unmarked workflow is today's net.
  const last = description.entries.length - 1;
  const marked = new Set(checkpoints);
  let next: Place<FlowToken> = ladder?.done ?? settleDone;
  const nextOf: string[] = [];
  for (let i = last; i >= 0; i--) {
    const entry = description.entries[i]!;
    pathToEntry.set(String(i), { entryId: entry.id, kind: entry.kind });
    // `nextOf[i]` is the next entry's input even when a checkpoint sits before it: it is what the
    // barrier names as entry i's `next`, and what `boundaries[i + 1]` resolves to (see `entries`).
    nextOf[i] = next.name;
    let successOf = next;
    if (marked.has(i)) {
      // i < last, so entry i + 1 exists: its never-started cancel is what the sweep reports.
      // With a ladder ([ADR 0017]) the sweep's cancel is intercepted like every top-level one.
      const checkpoint = checkpointGadget(i, next, cancel, spineExits.canceled, notStartedAt(description.entries[i + 1]!, i + 1), names);
      for (const t of checkpoint.transitions) {
        transitions.push(t);
        transitionToEntry.set(t.name, { path: [i], id: entry.id });
      }
      successOf = checkpoint.place;
    }
    // A compensated entry's success arms its level first ([ADR 0017]); `k_j` never carries a
    // checkpoint (`compensate-checkpoint`), so the two never meet.
    if (ladder !== undefined) successOf = ladder.armAt(i, successOf);
    next = emit(entry, [i], successOf, spineExits, i === last, { cancel }).inPlace;
    const site = entrySite(entry, i, next);
    if (site) registerSite(site);
  }

  // The rollback, the discharges and the compensator leaves ([ADR 0017]), once the spine exists.
  // A compensator is emitted as any step is — attempts, chain and quotas registered — at its own
  // path `[n + j - 1]`, viewed at the entry it compensates, with no cancel signal and detached.
  const compensation = ladder?.finish({
    entryInputs: [next.name, ...nextOf.slice(0, last)],
    emit: (step, path, viewPath, done, exits) => {
      const before = stepAttempts.length;
      const result = emit(step, path, done, exits, false, { viewPath, detached: true });
      return { inPlace: result.inPlace, attempts: stepAttempts.slice(before) };
    },
  });
  if (compensation !== undefined) exclusions.push(...compensation.exclusions);

  // **One refill per rate quota** ([ADR 0012]), whatever number of steps use it: fusion merges places,
  // not transitions, so a refill per member would refill the one bucket once per using step. It is
  // gated on outstanding demand — read, never consumed — so with no attempt waiting it is disabled and
  // the net quiesces with the bucket's tokens resting in `spent` (n8n-libpetri ADR 0009 §6). After an
  // idle spell its clock restarts at first demand ([TIME-011]): the rate is never exceeded, and may be
  // under-used.
  const refills = new Map<string, string>();
  for (const quota of quotas.values()) {
    if (quota.ref.kind !== 'rate') continue;
    const { spent, demand } = quota;
    const bucket = quota.pool;
    const refill = Transition.builder(names.quotaRefill(quota.ref.id))
      .inputs(one(spent!))
      .read(demand!)
      .timing(delayed(quota.ref.perMs))
      .outputs(outPlace(bucket))
      .action(async (tctx) => {
        tctx.output(bucket, null);
      })
      .build();
    refills.set(quota.ref.id, refill.name);
    transitions.push(refill);
  }

  const builder = PetriNet.builder(description.id)
    .places(
      terminals.done,
      terminals.failed,
      terminals.bailed,
      terminals.suspended,
      terminals.paused,
      terminals.canceled,
      cancel,
      cancelRequest,
      ...(permits ? [permits] : []),
      // The canonical quota places are declared, so a pool no attempt touches yet is still a place
      // of the net, seeded and checked, rather than vanishing with its arcs.
      ...[...quotas.values()].flatMap((q) => [q.pool, ...(q.spent ? [q.spent] : []), ...(q.demand ? [q.demand] : [])]),
      ...extraPlaces,
    )
    .transitions(...transitions);
  // One fusion set per (quota, role), canonical first ([MOD-060]/[MOD-061]): every member is replaced
  // by the canonical place in every arc, and each rebuilt transition keeps a place alias ([MOD-031]),
  // so an action that writes to its member by name lands in the canonical place. No quota, no
  // `fuse` — the build is the plain one, and an unannotated net is exactly today's.
  for (const quota of quotas.values()) {
    for (const role of QUOTA_ROLES) {
      const canonical = role === 'pool' ? quota.pool : role === 'spent' ? quota.spent : quota.demand;
      const rest = quota.members[role];
      if (canonical === undefined || rest.length === 0) continue;
      builder.fuse(FusionSet.of(canonical.name, canonical, ...rest));
    }
  }
  const net = builder.build();

  // An entry owns every place named under its index, its arms' and lanes' included (`s.1.` and
  // `s.1-0.`): the vocabulary names nothing else there, and nothing it owns is named elsewhere.
  //
  // **A checkpoint belongs to the entry before it.** `s.<i>.checkpoint` is named under `s.<i>.`, so
  // it is in entry i's interior, and entry i's `next` stays entry i+1's input. Only entry i's success
  // fills it, so it is entry i's place by the same argument as every other. The barrier then reads
  // *entry i and its checkpoint have both finished before entry i+1's input is marked* — the
  // freeze ADR 0010 promises: no effect of entry i+1 before the row is written — and the checkpoint
  // place is exclusive with every outcome place, so no run ends with a write pending. Making the
  // checkpoint place entry i's `next` instead would put it in its own boundary (it is interior) and
  // the claim would be false; leaving it out of the interior would drop the claim that the write
  // precedes entry i+1.
  const placeNames = [...net.places].map((p) => p.name);
  const entries: TopLevelEntry[] = description.entries.map((entry, index) => ({
    index,
    id: entry.id,
    kind: entry.kind,
    interior: placeNames.filter((n) => n.startsWith(`s.${index}.`) || n.startsWith(`s.${index}-`)),
    next: nextOf[index]!,
  }));
  // Every top-level boundary a restart may continue from ([ADR 0010]): entry i's input place, which
  // is the place entry i - 1's success goes to, and the entry place for i = 0.
  const placeByName = new Map([...net.places].map((p) => [p.name, p] as const));
  const boundaries: BoundarySite[] = description.entries.map((entry, index) => {
    const input = index === 0 ? next : placeByName.get(nextOf[index - 1]!);
    if (input === undefined) throw new Error(`no input place for the top-level entry at ${index}`);
    return { kind: 'boundary', index, entryId: entry.id, entryKind: entry.kind, place: input as Place<FlowToken> };
  });
  for (const name of [...claims.keys(), ...exclusions.flatMap((e) => [e.a, e.b])]) {
    // A member is fused away at build: a claim on it would name nothing ([ADR 0012]).
    if (memberNames.has(name)) throw new Error(`a claim names '${name}', a quota member that fusion removes from the net`);
    if (!placeNames.includes(name)) throw new Error(`a claim names '${name}', which is not a place of the net`);
  }
  for (const pool of gadgetPools) {
    for (const name of [pool.place.name, ...pool.holders.map((h) => h.place)]) {
      if (memberNames.has(name)) throw new Error(`a gadget pool names '${name}', a quota member that fusion removes from the net`);
    }
  }

  // Every conserved resource ([ADR 0012]): the run permits first — also kept as `budget` — then the
  // gadgets' slot pools, then one pool per quota in first-use order. Every step attempt takes a permit
  // and returns it, so the permits' takers and givers are both `stepAttempts`. A quota's takers are
  // the attempts of every step whose chain the leaf registered with that quota id — from the
  // registration, never from the arcs, so an attempt compiled without its quota arc is caught.
  const attemptsUsing = (id: string): string[] => steps.filter((s) => s.quotas.includes(id)).flatMap((s) => s.attempts);
  const quotaPools: Pool[] = [...quotas.values()].map((quota): Pool => {
    const takers = attemptsUsing(quota.ref.id);
    if (quota.ref.kind === 'limit') {
      return { kind: 'limit', quota: quota.ref.id, place: quota.pool, seed: quota.ref.n, holders: [], takers, givers: [...takers] };
    }
    return {
      kind: 'bucket',
      quota: quota.ref.id,
      place: quota.pool,
      seed: quota.ref.burst,
      holders: [{ place: quota.spent!.name, weight: 1 }],
      takers,
      givers: [refills.get(quota.ref.id)!],
      spent: quota.spent!,
      demand: quota.demand!,
      refill: refills.get(quota.ref.id)!,
      perMs: quota.ref.perMs,
    };
  });
  const pools: Pool[] = [
    ...(permits && k !== undefined
      ? [{ kind: 'permits' as const, place: permits, seed: k, holders: [], takers: [...stepAttempts], givers: [...stepAttempts] }]
      : []),
    ...gadgetPools,
    ...quotaPools,
  ];

  return {
    net,
    program: PrecompiledNet.compile(net),
    netMap: { transitionToEntry, placeToEntry, pathToEntry },
    entryPlace: next,
    terminals,
    cancel,
    cancelRequest,
    ...(permits && k !== undefined ? { budget: { permits, k } } : {}),
    pools,
    stepAttempts,
    steps,
    claims,
    exclusions,
    entries,
    resumeSites,
    boundaries,
    checkpoints,
    decisions,
    pipelines,
    // [ADR 0017]: present only with a ladder, so an unannotated result has exactly today's keys.
    ...(compensation !== undefined ? { compensations: compensation.site } : {}),
    structuralHash: structuralHash(description, checkpoints, names.names()),
  };
}

/** A quota's canonical places and the members to fuse into each ([ADR 0012]). */
interface QuotaPlaces {
  /** The first ref seen for the id: it fixes the parameters. */
  readonly ref: QuotaRef;
  /** Where the first ref was seen, for the collision message. */
  readonly where: string;
  /** `wf.quota.<id>`: a `limit`'s pool, a `rateLimit`'s bucket. */
  readonly pool: Place<null>;
  /** `wf.quota.<id>.spent` and `.demand`, for a `rateLimit` only. */
  readonly spent?: Place<null>;
  readonly demand?: Place<null>;
  readonly members: Record<QuotaRole, Place<null>[]>;
}

const QUOTA_ROLES: readonly QuotaRole[] = ['pool', 'spent', 'demand'];

const sameQuota = (a: QuotaRef, b: QuotaRef): boolean =>
  a.kind === 'limit' ? b.kind === 'limit' && a.n === b.n : b.kind === 'rate' && a.burst === b.burst && a.perMs === b.perMs;

const describeQuota = (ref: QuotaRef): string =>
  ref.kind === 'limit' ? `limit(${ref.n})` : `rateLimit(${ref.burst}, ${ref.perMs}ms)`;

const wholeIn = (value: number, min: number, max: number): boolean => Number.isInteger(value) && value >= min && value <= max;

/**
 * Registers a quota ref, or checks it against the one already registered under its id: one id is
 * one set of places, so a second ref with other parameters is refused, naming both. A new id mints
 * its canonical places (`quotaPlace` checks the id against `QUOTA_ID_PATTERN`).
 */
function registerQuota(quotas: Map<string, QuotaPlaces>, names: NameVocabulary, ref: QuotaRef, where: string): QuotaPlaces {
  const known = quotas.get(ref.id);
  if (known !== undefined) {
    if (!sameQuota(known.ref, ref)) {
      throw new Error(
        `quota '${ref.id}' is ${describeQuota(known.ref)} at ${known.where} and ${describeQuota(ref)} at ${where}; ` +
          'one id names one quota',
      );
    }
    return known;
  }
  if (ref.kind === 'limit') {
    if (!wholeIn(ref.n, 1, MAX_CONCURRENCY)) {
      throw new Error(`quota '${ref.id}' at ${where}: a limit must be a whole number in [1, ${MAX_CONCURRENCY}], got ${String(ref.n)}`);
    }
  } else if (ref.kind === 'rate') {
    if (!wholeIn(ref.burst, 1, MAX_CONCURRENCY)) {
      throw new Error(`quota '${ref.id}' at ${where}: a burst must be a whole number in [1, ${MAX_CONCURRENCY}], got ${String(ref.burst)}`);
    }
    if (!wholeIn(ref.perMs, 1, MAX_WAIT_MS)) {
      throw new Error(`quota '${ref.id}' at ${where}: a refill interval must be a whole number of ms in [1, ${MAX_WAIT_MS}], got ${String(ref.perMs)}`);
    }
  } else {
    throw new Error(`quota '${(ref as QuotaRef).id}' at ${where}: unknown kind '${String((ref as { kind: unknown }).kind)}'`);
  }
  const quota: QuotaPlaces = {
    ref,
    where,
    pool: place<null>(names.quotaPlace(ref.id, 'pool')),
    ...(ref.kind === 'rate'
      ? { spent: place<null>(names.quotaPlace(ref.id, 'spent')), demand: place<null>(names.quotaPlace(ref.id, 'demand')) }
      : {}),
    members: { pool: [], spent: [], demand: [] },
  };
  quotas.set(ref.id, quota);
  return quota;
}

/**
 * Every step's quota refs, read left to right through the description — arms, loop and foreach
 * bodies, pipeline stages ([ADR 0015]) and compensators ([ADR 0017]) included — with where each was
 * seen. A step naming one id twice is refused: one attempt would take two tokens of one quota in one
 * firing, which no author means.
 */
function quotaRefsOf(description: WorkflowDescription): readonly (readonly [QuotaRef, string])[] {
  const out: (readonly [QuotaRef, string])[] = [];
  const step = (s: StepDescription, path: string): void => {
    const seen = new Set<string>();
    for (const ref of s.quotas ?? []) {
      if (seen.has(ref.id)) throw new Error(`step '${s.id}' at entry ${path} uses quota '${ref.id}' twice`);
      seen.add(ref.id);
      out.push([ref, `entry ${path} ('${s.id}')`]);
    }
    // [ADR 0017]: a compensator draws on quotas at the run scope too, right after the step it
    // undoes; without this a quota used only by a compensator would never be registered (W0).
    if (s.compensate !== undefined) step(s.compensate, `${path} compensator`);
  };
  description.entries.forEach((entry, i) => {
    switch (entry.kind) {
      case 'step': step(entry, String(i)); break;
      case 'parallel':
      case 'branch': entry.arms.forEach((arm, a) => step(arm, `${i}-${a}`)); break;
      case 'loop': step(entry.body, String(i)); break;
      case 'foreach':
        step(entry.body, String(i));
        // [ADR 0015]: a pipeline's stages draw on quotas at the parent's run scope; its body is the
        // minted nested workflow and carries none. Stage order, after the body.
        entry.pipeline?.stages.forEach((stage, j) => step(stage, `${i} stage ${j}`));
        break;
      case 'sleep':
      case 'sleepUntil': break;
    }
  });
  return out;
}

/**
 * The checkpoints a description marks ([ADR 0010]), checked: whole numbers, strictly ascending, each
 * after a top-level entry that has a successor. The adapter emits exactly this; a hand-written
 * description that does not is refused rather than repaired, since a mark on the last entry or out
 * of range means its author expected a write that would never happen.
 */
function checkpointsOf(description: WorkflowDescription): readonly number[] {
  const marks = description.checkpoints ?? [];
  const last = description.entries.length - 1;
  let previous = -1;
  for (const i of marks) {
    if (!Number.isInteger(i) || i < 0 || i >= last) {
      throw new Error(
        `workflow '${description.id}': checkpoint ${String(i)} is not after a top-level entry with a successor ` +
          `(0..${last - 1}); a mark on the last entry adds nothing — its terminal row covers it`,
      );
    }
    if (i <= previous) {
      throw new Error(`workflow '${description.id}': checkpoints must be strictly ascending, got [${marks.join(', ')}]`);
    }
    previous = i;
  }
  return [...marks];
}

/**
 * The resume site of a top-level entry that owns one itself ([ADR 0007]): a step — a nested
 * workflow included, which is one step here (ADR 0003) — and a loop. Both resume at their own
 * input place, which is already gated on the cancel signal and swept beside it, so Mastra's check
 * before the entry (`default.ts:815`) holds for a resumed segment with nothing added.
 *
 * `stepId` is the id Mastra stores the suspension under, which is what `resume.steps[0]` names:
 * the step's own for a step, the **body's** for a loop (`suspendedPaths[bodyId] = [i]`,
 * `handlers/control-flow.ts:726-790`). A sleep never suspends and gets none; a `.parallel()`,
 * `.branch()` or `.foreach()` registers its own sites through `GadgetResult.resumeSites`.
 */
function entrySite(entry: EntryDescription, index: number, inPlace: Place<FlowToken>): EntrySite | undefined {
  switch (entry.kind) {
    case 'step':
      return { kind: 'entry', path: [index], stepId: entry.id, construct: 'step', place: inPlace };
    case 'loop':
      return { kind: 'entry', path: [index], stepId: entry.body.id, construct: 'loop', place: inPlace };
    case 'sleep':
    case 'sleepUntil':
    case 'parallel':
    case 'branch':
    case 'foreach':
      return undefined;
  }
}

/**
 * Keys the compile cache. Covers structure and the generated name set, never step actions or
 * payloads, so two runs of the same workflow shape hash alike.
 *
 * A per-run wait hashes as `perRun`, not as a value — that is the point of it being per run.
 */
function structuralHash(description: WorkflowDescription, checkpoints: readonly number[], names: readonly string[]): string {
  // M7 ([ADR 0011]-[ADR 0013]): a step's `timeoutMs` and `quotas`, and a block's `concurrency` where
  // it binds (c < arms), join the shape only when present, so a description without them hashes
  // exactly as before — the names alone do not separate two timeouts, or two quota sizes, of one shape.
  const step = (s: StepDescription): unknown => [
    'step',
    s.id,
    s.source ?? 'step',
    s.retries ?? 0,
    s.retryDelayMs ?? 0,
    ...(s.timeoutMs !== undefined ? [{ timeoutMs: s.timeoutMs }] : []),
    ...(s.quotas !== undefined && s.quotas.length > 0
      ? [{ quotas: s.quotas.map((q) => (q.kind === 'limit' ? [q.id, q.kind, q.n] : [q.id, q.kind, q.burst, q.perMs])) }]
      : []),
    // M7b ([ADR 0017]): the compensator joins the shape only when present — its retries, timeout and
    // quotas change no name of the forward step, so the names alone would not separate them.
    ...(s.compensate !== undefined ? [{ compensate: step(s.compensate) }] : []),
  ];
  const block = (arms: readonly StepDescription[], c: number | undefined): readonly unknown[] =>
    c !== undefined && c < arms.length ? [{ concurrency: c }] : [];
  const shape = (entry: EntryDescription): unknown => {
    switch (entry.kind) {
      case 'step': return step(entry);
      case 'sleep': return [entry.kind, entry.id, entry.duration];
      case 'sleepUntil': return [entry.kind, entry.id, entry.until];
      case 'parallel':
        // M7b ([ADR 0014]): a counted decision's `k` joins the shape only when present, so an
        // unannotated `.parallel()` hashes exactly as before — the names alone do not separate two
        // quorums of one block (`k` changes only arc weights, never a name).
        return [
          entry.kind,
          entry.id,
          entry.arms.map(step),
          ...block(entry.arms, entry.concurrency),
          ...(entry.decision !== undefined ? [{ decision: { k: entry.decision.k } }] : []),
        ];
      case 'branch': return [entry.kind, entry.id, entry.arms.map(step), ...block(entry.arms, entry.concurrency)];
      case 'loop': return [entry.kind, entry.id, entry.loopType, entry.iterationBound, step(entry.body)];
      case 'foreach':
        // M7b ([ADR 0015]): a pipeline's stages and bounds join the shape only when present, so an
        // unannotated `.foreach()` hashes exactly as before — the names alone do not separate two
        // bound vectors of one Σc_j split differently, nor two stages' retries or quotas.
        return [
          entry.kind,
          entry.id,
          entry.concurrency,
          step(entry.body),
          ...(entry.pipeline !== undefined
            ? [{ pipeline: { stages: entry.pipeline.stages.map(step), bounds: [...entry.pipeline.bounds] } }]
            : []),
        ];
    }
  };
  // Checkpoints join the key only when there are any, so an unmarked description hashes byte for
  // byte as it did before checkpoints existed (the names would tell them apart anyway).
  const marks = checkpoints.length > 0 ? { checkpoints } : {};
  return createHash('sha256')
    .update(JSON.stringify({ v: 5, id: description.id, shape: description.entries.map(shape), names, ...marks }))
    .digest('hex')
    .slice(0, 16);
}

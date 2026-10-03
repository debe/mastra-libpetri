import { Transition, and, one, outPlace, place, xor, type Out, type Place } from 'libpetri';
import type { EntryPath, NameVocabulary } from '../names.js';
import type {
  ArmResume,
  ArmSite,
  CanceledToken,
  FailureToken,
  FlowToken,
  SiblingVerdict,
  StepDescription,
  SuspendToken,
  PlaceClaim,
} from '../types.js';

/**
 * One arm's settlement, as a block's join counts it — shared by `.parallel()` and `.branch()`, and
 * by the replay transitions that rebuild a resumed block's arrivals.
 *
 * Only `ok` carries a value: it is the only status whose data reaches the block's own output. The
 * index is stamped by *which* transition deposited it — a collect, a gate or a replay — so arm
 * identity is topology rather than a value the join has to trust. `skipped` is a `.branch()` arm
 * whose condition was not truthy; a `.parallel()` never deposits one.
 */
export type ArmArrival =
  | { readonly status: 'ok'; readonly index: number; readonly data: unknown }
  | { readonly status: 'failed' }
  | { readonly status: 'suspended' }
  /** Bailed or paused: the arm is done, and the block does not report it. */
  | { readonly status: 'settled' }
  | { readonly status: 'skipped' };

/** The block's own places the re-entry writes into — exactly the ones a fresh run's collects write. */
export interface BlockPlaces {
  readonly arrived: Place<ArmArrival>;
  readonly errSeen: Place<FailureToken>;
  readonly suspSeen: Place<SuspendToken>;
}

export interface BlockReentryOptions {
  readonly names: NameVocabulary;
  /** The block's naming path. */
  readonly path: EntryPath;
  /** The block's view path — Mastra's `executionPath`; arm *j* resumes at `[...viewPath, j]`. */
  readonly viewPath: EntryPath;
  readonly blockId: string;
  readonly block: ArmSite['block'];
  readonly arms: readonly StepDescription[];
  /** Arm *j*'s input place, as `emitNested` returned it. */
  readonly armIns: readonly Place<FlowToken>[];
  readonly places: BlockPlaces;
  /** The cancellation signal the block's own start is gated on; `undefined` when it is not gated. */
  readonly cancel: Place<null> | undefined;
  /** The enclosing canceled exit — where a resume that was already aborted goes, unstarted. */
  readonly canceled: Place<CanceledToken>;
  /** The enclosing failure exit — where a seed that does not fit this block is refused, by name. */
  readonly failed: Place<FailureToken>;
}

export interface BlockReentry {
  readonly transitions: readonly Transition[];
  readonly resumeSites: readonly ArmSite[];
}

/**
 * Everything a `.parallel()` or `.branch()` needs to be resumed at one of its arms ([ADR 0007]):
 * per arm *j* a `resume-j` site with its `re-enter-j` gate and `re-enter-j.cancel` sweep, and per
 * arm *i* the `replay-i` transition that re-deposits a sibling's stored outcome.
 *
 * ```text
 *   resume-j --re-enter-j [inhibitor cancel]--> xor( and(armIn_j, replay_i for every i != j), failed )
 *   resume-j --re-enter-j.cancel [read cancel]-> canceled {started: false}
 *
 *   replay_i --replay-i--> xor( arrived{ok | settled | skipped},
 *                               and(arrived{suspended}, suspSeen),
 *                               and(arrived{failed},    errSeen) )
 * ```
 *
 * **The block's interior is rebuilt by transitions, never written by hand.** The seed is one token
 * at `resume-j`. `re-enter-j` hands arm *j* its stored input, colour-marked `resumed`, and each
 * sibling its own `replay-i` token; each replay deposits exactly the arrival — and the marker — a
 * real collect would have. The block's join, unchanged, then decides, so a resumed block reaches
 * its outcome by the same arcs as a fresh one: failed beats suspended beats ok, as Mastra's
 * `buildResumedBlockResult` ranks them (`handlers/entry.ts:38-109`). Every arrival is one token per
 * firing into a named place, so the join's `exactly(n)` sees true counts ([IO-016]).
 *
 * **Decide, then emit** ([EXEC-031]). A replay's choice rides in the verdict's colour, and every
 * alternative is a declared branch, so the value-blind verifier explores every sibling status from
 * the one seed. `ok`, `settled` and `skipped` all write `arrived` alone: one declared place set,
 * three runtime values — the verifier cannot tell them apart and does not need to, because the join
 * counts arrivals and reads only the markers.
 *
 * **Mastra's check before the entry holds for a resumed segment too** (`default.ts:815`): the gate
 * is inhibited by the signal and the sweep beside it consumes the seed into `canceled`, unstarted.
 * No interior token exists behind the gate, so a resume that was already aborted strands nothing.
 * Past the gate nothing is checked, as in a fresh block.
 *
 * **A seed that does not fit is refused, not run.** `re-enter-j` validates the siblings — one per
 * other arm, each index once, a suspension or failure carrying its own arm's `[top, arm]` path and
 * step id, no `skipped` in a `.parallel()` — and sends a misfit to `failed` with an error naming the
 * block, before a single token is written. The decoder is the trust point here (no proof sees values), so the gate
 * refuses by name rather than let a malformed replay miscount the join.
 *
 * **What is never on the resume path.** `.branch()`'s `decide`: conditions are not re-evaluated on
 * a resume, and a sibling that did not run replays as `skipped` (`handlers/entry.ts:43-46,415-500`).
 */
export function blockReentry(o: BlockReentryOptions): BlockReentry {
  const n = o.arms.length;
  if (n === 0) return { transitions: [], resumeSites: [] };
  if (o.viewPath.length !== 1) {
    // Mastra's arms are `SingleStepEntry`, so a block is always a top-level entry and its arm
    // resumes at `[top, arm]`. A block anywhere else is a net for a workflow Mastra cannot express.
    throw new Error(
      `${o.block} '${o.blockId}' at path [${o.viewPath.join(', ')}]: a resumable block is a top-level entry, ` +
        'so its arms resume at [top, arm]',
    );
  }
  const top = o.viewPath[0]!;

  const replayPlaces = o.arms.map((_, i) =>
    place<SiblingVerdict>(o.names.entryPlace(o.path, o.blockId, `replay-${i}`)),
  );
  const transitions: Transition[] = replayPlaces.map((p, i) => replay(o, i, p));
  const resumeSites: ArmSite[] = [];

  for (let j = 0; j < n; j++) {
    const reentry = armReentry(o, j, replayPlaces);
    transitions.push(...reentry.transitions);
    resumeSites.push({
      kind: 'arm',
      block: o.block,
      path: [top, j],
      stepId: o.arms[j]!.id,
      place: reentry.place,
    });
  }
  return { transitions, resumeSites };
}

/**
 * Arm *j*'s resume site: the `resume-j` place, the `re-enter-j` gate and its `re-enter-j.cancel`
 * sweep. See {@link blockReentry}.
 */
export function armReentry(
  o: BlockReentryOptions,
  j: number,
  replayPlaces: readonly Place<SiblingVerdict>[],
): { readonly place: Place<ArmResume>; readonly transitions: readonly Transition[] } {
  const { names, path, blockId, viewPath } = o;
  const armIn = o.armIns[j]!;
  const resume = place<ArmResume>(names.entryPlace(path, blockId, `resume-${j}`));
  const siblings = replayPlaces.filter((_, i) => i !== j);
  const replayOf = new Map<number, Place<SiblingVerdict>>();
  replayPlaces.forEach((p, i) => {
    if (i !== j) replayOf.set(i, p);
  });

  const run: Out = siblings.length === 0 ? outPlace(armIn) : and(outPlace(armIn), ...siblings.map(outPlace));
  const gate = Transition.builder(names.entryTransition(path, blockId, `re-enter-${j}`))
    .inputs(one(resume))
    .outputs(xor(run, outPlace(o.failed)))
    .action(async (tctx) => {
      const seed = tctx.input(resume);
      // Decide, then emit: the whole seed is checked before one token is written.
      const misfit = seedMisfit(o, j, seed);
      if (misfit !== undefined) {
        tctx.output(o.failed, {
          stepId: blockId,
          path: viewPath,
          error: new Error(`${o.block} '${blockId}': cannot resume arm ${j} (${o.arms[j]!.id}): ${misfit}`),
        });
        return;
      }
      tctx.output(armIn, { data: seed.data, resumed: true });
      for (const verdict of seed.siblings) tctx.output(replayOf.get(verdict.index)!, verdict);
    });
  if (o.cancel !== undefined) gate.inhibitor(o.cancel);

  const transitions: Transition[] = [gate.build()];
  if (o.cancel !== undefined) {
    const canceled = o.canceled;
    transitions.push(
      Transition.builder(names.entryTransition(path, blockId, `re-enter-${j}.cancel`))
        .inputs(one(resume))
        .read(o.cancel)
        .outputs(outPlace(canceled))
        .action(async (tctx) => {
          tctx.input(resume);
          // The block never (re)started: the same report as the fork's own sweep.
          tctx.output(canceled, { origin: { stepId: blockId, path: viewPath }, started: false });
        })
        .build(),
    );
  }
  return { place: resume, transitions };
}

/**
 * `replay-i`: re-deposits sibling *i*'s stored outcome as the arrival a real collect produces — the
 * arrival and, for a suspension or a failure, its marker, in one firing ([EXEC-001]), which is the
 * same race-freedom argument the collects rest on.
 */
export function replay(o: BlockReentryOptions, i: number, from: Place<SiblingVerdict>): Transition {
  const { arrived, errSeen, suspSeen } = o.places;
  return Transition.builder(o.names.entryTransition(o.path, o.blockId, `replay-${i}`))
    .inputs(one(from))
    .outputs(
      xor(
        outPlace(arrived),
        and(outPlace(arrived), outPlace(suspSeen)),
        and(outPlace(arrived), outPlace(errSeen)),
      ),
    )
    .action(async (tctx) => {
      const verdict = tctx.input(from);
      switch (verdict.kind) {
        case 'ok':
          tctx.output(arrived, { status: 'ok', index: i, data: verdict.output });
          return;
        case 'settled':
          tctx.output(arrived, { status: 'settled' });
          return;
        case 'skipped':
          // Only a `.branch()` seed reaches here with it: `re-enter` refuses one in a `.parallel()`.
          tctx.output(arrived, { status: 'skipped' });
          return;
        case 'suspended':
          tctx.output(arrived, { status: 'suspended' });
          tctx.output(suspSeen, verdict.token);
          return;
        case 'failed':
          tctx.output(arrived, { status: 'failed' });
          tctx.output(errSeen, verdict.token);
          return;
      }
    })
    .build();
}

const VERDICT_KINDS: ReadonlySet<string> = new Set(['ok', 'suspended', 'failed', 'settled', 'skipped']);

/** Why a seed does not fit arm *j* of this block, or `undefined` when it does. */
function seedMisfit(o: BlockReentryOptions, j: number, seed: ArmResume | null | undefined): string | undefined {
  const n = o.arms.length;
  if (seed === null || typeof seed !== 'object' || !Array.isArray(seed.siblings)) {
    return 'the seed carries no sibling list';
  }
  if (seed.siblings.length !== n - 1) {
    return `the seed names ${seed.siblings.length} sibling(s); the block has ${n - 1}`;
  }
  const seen = new Set<number>();
  for (const verdict of seed.siblings as readonly unknown[]) {
    const v = verdict as Partial<SiblingVerdict> | null;
    if (v === null || typeof v !== 'object' || typeof v.kind !== 'string' || !VERDICT_KINDS.has(v.kind)) {
      return `a sibling verdict is not one of ${[...VERDICT_KINDS].join(', ')}`;
    }
    const index = v.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= n || index === j) {
      return `sibling index ${String(index)} names no other arm of 0..${n - 1}`;
    }
    if (seen.has(index)) return `sibling ${index} is named twice`;
    seen.add(index);
    if (v.kind === 'skipped' && o.block === 'parallel') {
      return `sibling ${index} is 'skipped', and every arm of a .parallel() runs`;
    }
    if (v.kind === 'suspended' || v.kind === 'failed') {
      // The token must be exactly the one arm `index`'s own collect would have produced: at
      // `[top, index]` and under that arm's step id. The join ranks a suspension or failure by the
      // arm segment of its path, and the codec files it under its step id and its path — a token
      // claiming another arm's position, another block, or another step would be reported as that.
      const token = (v as { token?: { path?: unknown; stepId?: unknown } }).token;
      const path = Array.isArray(token?.path) ? (token.path as unknown[]) : undefined;
      if (path === undefined || path.length !== o.viewPath.length + 1) {
        return `sibling ${index}'s ${v.kind} token carries a path of length ${String(path?.length)}, not [top, arm]`;
      }
      if (path[0] !== o.viewPath[0]) {
        return `sibling ${index}'s ${v.kind} token carries the path of the entry at [${String(path[0])}], not [${String(o.viewPath[0])}]`;
      }
      const at = path[o.viewPath.length];
      if (at !== index) return `sibling ${index}'s ${v.kind} token carries the path of arm ${String(at)}`;
      const expected = o.arms[index]!.id;
      if (token!.stepId !== expected) {
        return `sibling ${index}'s ${v.kind} token names step ${describeId(token!.stepId)}, but arm ${index} is '${expected}'`;
      }
    }
  }
  return undefined;
}

function describeId(value: unknown): string {
  return typeof value === 'string' ? `'${value}'` : String(value);
}

/**
 * The block's suspension: the lowest-indexed one, as Mastra reports `results.find(r => r.status ===
 * 'suspended')` over arms in index order, carrying **every other** suspension as `pending`, in arm
 * order ([ADR 0007]; `docs/divergences.md` row 34). Dropping them used to lose every losing arm
 * from the result's `suspended` list and the snapshot's `suspendedPaths`, where Mastra's
 * `fmtReturnValue` and `buildResumedBlockResult` name them all (`default.ts:630-643`,
 * `handlers/entry.ts:100-107`). `pending` is present only when some other arm is suspended, so a
 * block with a single suspension emits exactly the token the arm did. Ties keep input order.
 */
export function suspendedBlock(tokens: readonly SuspendToken[], indexOf: (token: SuspendToken) => number): SuspendToken {
  const ranked = tokens
    .map((token, k) => ({ token, k, index: indexOf(token) }))
    .sort((a, b) => a.index - b.index || a.k - b.k);
  const [first, ...rest] = ranked;
  if (first === undefined) throw new Error('suspendedBlock: no suspension to report');
  return rest.length === 0 ? first.token : { ...first.token, pending: rest.map((r) => r.token) };
}

/**
 * The bounds a `.parallel()` or `.branch()` claims beyond 1 ([ADR 0009]): every arm settles into
 * the shared places exactly once, fresh or replayed, so each holds at most one token per arm.
 */
export function blockClaims(places: readonly Place<unknown>[], arms: number): PlaceClaim[] {
  return places.map((place) => ({ place: place.name, bound: arms, why: `one settlement per arm (${arms} arms)` }));
}

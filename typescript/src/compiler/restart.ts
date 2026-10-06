import { ladderLevel } from './blueprints/compensate.js';
import type { BoundarySite, CompiledWorkflow, FlowToken, StepRecord } from './types.js';

/** Where a restart continues, in the compiler's terms — decoded from Mastra's `restart` parameter. */
export interface RestartRequest {
  /**
   * Mastra's stored `activePaths` — `[i]` (a petri checkpoint's boundary, or an entry Mastra's own
   * engine was in), `[i, j]` (inside a block, on Mastra's engine) or longer. Never mutated: Mastra
   * consumes it with `shift()` (`default.ts:797-799`).
   */
  readonly activePaths: readonly number[];
  /** The stored step records — Mastra's `snapshot.context` without `input`. */
  readonly records: ReadonlyMap<string, StepRecord>;
  /**
   * The value entry `activePaths[0]` takes as input: `getStepOutput` of the entry before it over
   * the stored context (`default.ts:1132-1159`), the workflow's input at 0. Computed by the host,
   * which reads Mastra's graph.
   */
  readonly input: unknown;
}

/** The single token a restarted segment starts from, and the boundary it goes to ([ADR 0010]). */
export interface RestartSeed {
  readonly site: BoundarySite;
  readonly value: FlowToken;
}

/**
 * A restart this engine cannot place ([ADR 0010]). `reason`:
 * - `no-position` — `activePaths` is empty, or its first index is not a top-level entry.
 */
export class UnrestartablePositionError extends Error {
  override readonly name = 'UnrestartablePositionError';
  constructor(
    readonly reason: 'no-position',
    readonly path: readonly number[],
    message: string,
  ) {
    super(message);
  }
}

/**
 * The seed for a restarted segment: one `FlowToken` with the request's input at the boundary of
 * entry `activePaths[0]` — the nearest top-level boundary at or before the stored position, so a row
 * from Mastra's engine naming `[i, j]` re-runs entry `i` whole ([ADR 0010]). Pure; throws before
 * anything runs or persists.
 *
 * **With a compensation ladder** ([ADR 0017]) the segment also starts with the level token the
 * kernel seeds through {@link ladderToken} — `level.a`, `a = |{j : k_j < p}|`, its stack rebuilt from
 * the stored records — and a restart whose stack cannot be rebuilt (a compensated entry before `p`
 * with no stored `success` record) is refused here, as `no-position`, before anything persists. A
 * restart from a marked checkpoint always seeds `level.0`: `compensate-checkpoint` refuses every
 * checkpoint at or after `k_1`. A row from Mastra's own engine may name any `p`, which is why the
 * formula is shared rather than the constant assumed.
 */
export function restartSeed(compiled: CompiledWorkflow, request: RestartRequest): RestartSeed {
  const path = request.activePaths;
  const shown = `[${path.join(', ')}]`;
  if (path.length === 0) {
    throw new UnrestartablePositionError('no-position', path, `workflow '${compiled.net.name}': the stored activePaths ${shown} name no position to restart from`);
  }
  const p = path[0]!;
  if (!Number.isInteger(p) || p < 0) {
    throw new UnrestartablePositionError('no-position', path, `workflow '${compiled.net.name}': the stored activePaths ${shown} start at ${p}, which is not a top-level index`);
  }
  const site = compiled.boundaries[p];
  if (site === undefined || site.index !== p) {
    throw new UnrestartablePositionError(
      'no-position',
      path,
      `workflow '${compiled.net.name}': the stored activePaths ${shown} start at ${p}, and the workflow has no top-level boundary there (entries 0..${compiled.boundaries.length - 1})`,
    );
  }
  try {
    ladderToken(compiled, p, (id) => request.records.get(id));
  } catch (error) {
    throw new UnrestartablePositionError(
      'no-position',
      path,
      `workflow '${compiled.net.name}': the stored activePaths ${shown} start at ${p}, ${(error as Error).message}`,
    );
  }
  // A fresh object: never `resumed`, never a foreach index or an iteration — a restart re-runs entry
  // `p` from its start, as Mastra's does (ADR 0010).
  return { site, value: { data: request.input } };
}

/**
 * The compensation ladder's level token a segment starting at top-level index `at` is seeded with
 * ([ADR 0017], W0 amendment 4): the place {@link ladderLevel} names — `level.a`, `a = |{j : k_j <
 * at}|`, **the one seed formula**, shared with the verifier's `segmentInitialMarking` — and the stack
 * it carries, `[out(k_1) … out(k_a)]`, bottom first, each the `output` of that forward step's stored
 * `success` record. `undefined` when the workflow has no ladder.
 *
 * `record` reads a step's record: the kernel passes its run scope's (`engine/scope.ts`, read through
 * `getStepResult`), `resumeSeed` and {@link restartSeed} the request's, to refuse by name before
 * anything persists. Throws a plain `Error` — "compensated step 'x' at k has no stored success
 * record" — when a forward step below `at` has no record, or one that is not `success`: entries run
 * one after another, so every compensated entry before the segment's index completed, and a stack
 * that cannot be rebuilt is a stored row this engine cannot continue soundly (its compensator would
 * run on `undefined`).
 */
export function ladderToken(
  compiled: Pick<CompiledWorkflow, 'compensations'>,
  at: number,
  record: (stepId: string) => StepRecord | undefined,
): LadderToken | undefined {
  const site = compiled.compensations;
  if (site === undefined) return undefined;
  const seed = ladderLevel(site, at);
  const value = seed.stack.map((stepId, i) => {
    const stored = record(stepId);
    if (stored === undefined || stored.status !== 'success') {
      const k = site.compensators[i]?.k;
      throw new Error(
        `the compensated step '${stepId}' at [${String(k)}] has ${stored === undefined ? 'no stored record' : `a stored '${stored.status}' record`}, ` +
          `so the rollback stack (level ${seed.level}) cannot be rebuilt`,
      );
    }
    return stored.output;
  });
  return { place: seed.place, level: seed.level, value };
}

/** What {@link ladderToken} seeds: the level place, by name, its number and the stack it carries. */
export interface LadderToken {
  readonly place: string;
  readonly level: number;
  /** `[out(k_1) … out(k_level)]`, bottom first — the level token's colour. */
  readonly value: readonly unknown[];
}

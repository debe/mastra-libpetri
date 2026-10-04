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
  // A fresh object: never `resumed`, never a foreach index or an iteration — a restart re-runs entry
  // `p` from its start, as Mastra's does (ADR 0010).
  return { site, value: { data: request.input } };
}

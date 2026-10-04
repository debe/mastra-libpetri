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
  void compiled;
  void request;
  throw new Error('restartSeed: not implemented (M4b W2)');
}

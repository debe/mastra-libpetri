import type { Mastra } from '@mastra/core/mastra';

/** What {@link restartActiveRuns} restarts. */
export interface RestartActiveRunsOptions {
  /** Only these workflow ids. Omitted, every registered petri workflow. */
  readonly workflows?: readonly string[];
}

/** What {@link restartActiveRuns} did, per run. */
export interface RestartActiveRunsReport {
  readonly restarted: readonly { readonly workflowId: string; readonly runId: string; readonly status: string }[];
  readonly failed: readonly { readonly workflowId: string; readonly runId: string; readonly error: unknown }[];
}

/**
 * Boot-time recovery for petri workflows ([ADR 0010]): every `running` or `waiting` run of every
 * registered petri workflow, restarted **sequentially** as Mastra's own `restartAllActiveWorkflowRuns`
 * does (`mastra/index.ts:3967-3995`), each failure logged through `mastra.getLogger()` and reported,
 * never thrown. Honours `autoRestartActiveRuns === false`. Call it beside Mastra's boot hook, which
 * restarts only `'default'` workflows (`mastra/index.ts:3952`), until M9 PR 2 lands.
 */
export async function restartActiveRuns(mastra: Mastra, options: RestartActiveRunsOptions = {}): Promise<RestartActiveRunsReport> {
  void mastra;
  void options;
  throw new Error('restartActiveRuns: not implemented (M4b W4)');
}

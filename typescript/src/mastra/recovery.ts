import type { Mastra } from '@mastra/core/mastra';
import { PETRI_ENGINE_TYPE } from './init.js';

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
  const logger = mastra.getLogger();
  const only = options.workflows === undefined ? undefined : new Set(options.workflows);
  const restarted: { workflowId: string; runId: string; status: string }[] = [];
  const failed: { workflowId: string; runId: string; error: unknown }[] = [];

  for (const workflow of Object.values(mastra.listWorkflows())) {
    if (workflow.engineType !== PETRI_ENGINE_TYPE) continue;
    if (only !== undefined && !only.has(workflow.id)) continue;
    const active = await workflow.listActiveWorkflowRuns();
    for (const runSnapshot of active.runs) {
      const ref = { workflowId: workflow.id, runId: runSnapshot.runId };
      // Mastra's own opt-out, read where its boot hook reads it (`mastra/index.ts:3975-3982`).
      if (workflow.options?.autoRestartActiveRuns === false) {
        logger?.debug('Skipping workflow run auto-restart; workflow opts out of generic recovery', ref);
        continue;
      }
      try {
        const run = await workflow.createRun({ runId: runSnapshot.runId });
        const result = await run.restart();
        restarted.push({ ...ref, status: result.status });
        logger?.debug('Restarted workflow run', ref);
      } catch (error) {
        failed.push({ ...ref, error });
        logger?.error('Failed to restart workflow run', { ...ref, error });
      }
    }
  }
  return { restarted, failed };
}

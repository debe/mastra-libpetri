import { createHash } from 'node:crypto';
import type { RequestContext } from '@mastra/core/di';
import { MastraError, ErrorDomain, ErrorCategory, getErrorFromUnknown } from '@mastra/core/error';
import { evaluateScoringPredicate, type MastraScorerEntry, type MastraScorers, type ScoringHookInput } from '@mastra/core/evals';
import { AvailableHooks, executeHook } from '@mastra/core/hooks';
import type { IMastraLogger } from '@mastra/core/logger';
import type { Mastra } from '@mastra/core/mastra';
import { createObservabilityContext, type AnySpan } from '@mastra/core/observability';
import { MASTRA_AUTH_TOKEN_KEY } from '@mastra/core/request-context';

/**
 * A step's `scorers` as the default engine runs them after a step that did not fail
 * (`handlers/step.ts:501-514`): Mastra's `runScorersForStep` (`:602-650`) and the `runScorer` it
 * calls (`evals/hooks.ts:23-176`), reproduced because neither is exported from a public
 * `@mastra/core` entry point. Resolve a function-valued `scorers` with the request context (a
 * throw is tracked and logged, and the step is unaffected), skip everything when `disableScorers`
 * is truthy, and otherwise register each scorer with the registered `Mastra` and fire Mastra's own
 * `onScorerRun` hook for it — fire and forget, as Mastra's is.
 *
 * One difference is structural: Mastra tags the hook payload with its emitting `Mastra`
 * (`hooks/scorer-owner.ts`, `setScorerHookOwner`), which is not exported, so the payload fired
 * here carries no owner and every `Mastra` in the process with a scorer hook sees it
 * (`isScorerHookForMastra` treats an ownerless payload as broadcast) — `docs/divergences.md`.
 */
export interface RunScorersParams {
  readonly mastra: Mastra | undefined;
  readonly logger: IMastraLogger | undefined;
  readonly scorers: MastraScorers | ((args: { requestContext: RequestContext }) => MastraScorers | Promise<MastraScorers>);
  readonly runId: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly workflowId: string;
  readonly stepId: string;
  readonly requestContext: RequestContext;
  readonly disableScorers: boolean | undefined;
  /** The step's span: Mastra passes `createObservabilityContext({ currentSpan: stepSpan })` (`:512`). */
  readonly span: AnySpan | undefined;
}

export async function runScorersForStep(params: RunScorersParams): Promise<void> {
  const { mastra, logger, runId, input, output, workflowId, stepId, requestContext, disableScorers } = params;
  let scorersToUse: unknown = params.scorers;
  if (typeof scorersToUse === 'function') {
    try {
      scorersToUse = await (scorersToUse as (a: { requestContext: RequestContext }) => unknown)({ requestContext });
    } catch (e) {
      const errorInstance = getErrorFromUnknown(e, { serializeStack: false });
      const mastraError = new MastraError(
        {
          id: 'WORKFLOW_FAILED_TO_FETCH_SCORERS',
          domain: ErrorDomain.MASTRA_WORKFLOW,
          category: ErrorCategory.USER,
          details: { runId, workflowId, stepId },
        },
        errorInstance,
      );
      logger?.trackException(mastraError);
      logger?.error('Error fetching scorers: ' + errorInstance?.stack);
    }
  }

  const entries = Object.entries((scorersToUse ?? {}) as MastraScorers);
  if (disableScorers || !scorersToUse || entries.length === 0) return;
  const observability = createObservabilityContext({ currentSpan: params.span });
  for (const [, scorerObject] of entries) {
    if (mastra) {
      scorerObject.scorer.__registerMastra(mastra);
      mastra.addScorer(scorerObject.scorer, undefined, { source: 'code' });
    }
    runScorer({
      mastra,
      scorerId: scorerObject.scorer.id,
      scorerObject,
      runId,
      input,
      output,
      requestContext,
      entity: { id: workflowId, stepId },
      structuredOutput: true,
      source: 'LIVE',
      entityType: 'WORKFLOW',
      observability,
    });
  }
}

/** `hashToUnitInterval` (`evals/hooks.ts:15-18`). */
function hashToUnitInterval(key: string): number {
  const digest = createHash('sha256').update(key).digest();
  return Number(digest.readUIntBE(0, 6)) / 2 ** 48;
}

/** `runScorer` (`evals/hooks.ts:23-176`), for the one caller shape a workflow step uses. */
function runScorer(args: {
  readonly mastra: Mastra | undefined;
  readonly scorerId: string;
  readonly scorerObject: MastraScorerEntry;
  readonly runId: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly requestContext: RequestContext;
  readonly entity: Record<string, unknown>;
  readonly structuredOutput: boolean;
  readonly source: 'LIVE';
  readonly entityType: 'WORKFLOW';
  readonly observability: ReturnType<typeof createObservabilityContext>;
}): void {
  const { mastra, scorerId, scorerObject, runId, input, output, requestContext, entity, structuredOutput, source, entityType, observability } = args;
  const currentSpan = observability.tracing?.currentSpan;
  // A declined trace: nothing about it was stored, so it is not scored (`:59-66`).
  if (currentSpan?.isValid === false) return;

  const safeContext: Record<string, unknown> = {};
  if (requestContext) {
    const MAX_DEPTH = 8;
    const visited = new WeakSet<object>();
    const flatten = (obj: Record<string, unknown>, prefix?: string, depth = 0): void => {
      if (depth > MAX_DEPTH) return;
      if (visited.has(obj)) return;
      visited.add(obj);
      const iterable = obj as unknown as { entries?: () => Iterable<[string, unknown]> };
      const entries: Iterable<[string, unknown]> = typeof iterable.entries === 'function' ? iterable.entries() : Object.entries(obj);
      for (const [key, value] of entries) {
        const flatKey = prefix ? `${prefix}.${key}` : key;
        if (flatKey === MASTRA_AUTH_TOKEN_KEY) continue;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          safeContext[flatKey] = value;
        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
          flatten(value as Record<string, unknown>, flatKey, depth + 1);
        }
      }
    };
    flatten(requestContext as unknown as Record<string, unknown>);
  }

  if (scorerObject?.filter) {
    let qualifies = false;
    try {
      qualifies = evaluateScoringPredicate(scorerObject.filter, {
        requestContext: safeContext,
        entity,
        entityType,
        source,
        threadId: undefined,
        resourceId: undefined,
        projectId: undefined,
      } as Parameters<typeof evaluateScoringPredicate>[1]);
    } catch (error) {
      mastra?.getLogger?.()?.warn?.('Scoring filter evaluation failed; skipping scoring', { scorerId, runId, error });
    }
    if (!qualifies) return;
  }

  let shouldExecute = false;
  const sampling = scorerObject?.sampling as { type?: string; rate?: number } | undefined;
  if (!sampling || sampling.type === 'none') shouldExecute = true;
  if (sampling?.type) {
    switch (sampling.type) {
      case 'ratio': {
        const samplingKey = currentSpan?.traceId ?? runId;
        shouldExecute = hashToUnitInterval(samplingKey) < (sampling.rate as number);
        break;
      }
      case 'none':
        shouldExecute = true;
        break;
      default:
        shouldExecute = false;
    }
  }
  if (!shouldExecute) return;

  const payload = {
    scorer: {
      id: scorerObject.scorer?.id || scorerId,
      name: scorerObject.scorer?.name,
      description: scorerObject.scorer.description,
    },
    input,
    output,
    requestContext: safeContext,
    runId,
    source,
    entity,
    structuredOutput,
    entityType,
    threadId: undefined,
    resourceId: undefined,
    projectId: undefined,
    ...observability,
  } as unknown as ScoringHookInput;
  executeHook(AvailableHooks.ON_SCORER_RUN, payload);
}

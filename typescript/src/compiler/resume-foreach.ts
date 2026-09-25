import { itemsOf, storedForeachOutput } from './gadgets/foreach.js';
import { UnresumablePositionError } from './resume.js';
import type { ForeachItemRecord, ForeachResume, ForeachSite, StepRecord, SuspendToken } from './types.js';

/**
 * The `.foreach()` re-entry token, following Mastra's classification of every item before any
 * runs (`handlers/control-flow.ts:1227-1270`) exactly:
 *
 * - a stored `success` is **done**: skipped, its output reused (`:1231-1254`);
 * - a stored `suspended`, when the resume names an item (`forEachIndex`) and not this one, stays
 *   **parked**: it does not run, and the foreach ends suspended again (`:1242-1250`);
 * - everything else is **queued**, in index order, and is the attempt the resume feeds when the
 *   resume names this item — or, naming none, when the item was suspended or is the stored
 *   aggregate's own `__workflow_meta.foreachIndex` (`resumeIndex`, `:1030-1031`, `:1261-1269`).
 *   An item with no stored entry (the queue was killed before it started) runs fresh.
 *
 * The stored entries are the aggregate's `suspendPayload.__workflow_meta.foreachOutput`
 * (`:1040-1041`); the items are the aggregate's `payload`, as `getResumeStepPrevOutput` reads the
 * resumed foreach's input (`handlers/entry.ts:111-128,555-561`) — Mastra falls back to the previous
 * step's output when the record has no `payload`, which a resume segment cannot see, so that is
 * refused by name. Pure: `records` is not read — the aggregate is every record the foreach needs.
 *
 * A done item's record is the stored entry itself, so a resume through this engine writes back
 * what Mastra stored, unknown fields included. A parked item is a {@link SuspendToken} at the
 * foreach's path, carrying its stored `suspendPayload` and `suspendedAt`.
 */
export function foreachSeed(
  site: ForeachSite,
  aggregate: StepRecord,
  _records: ReadonlyMap<string, StepRecord>,
  forEachIndex?: number,
): ForeachResume {
  if (!Object.hasOwn(aggregate, 'payload')) {
    throw new UnresumablePositionError(
      'unsupported',
      site.path,
      `the stored record of the .foreach() step '${site.stepId}' has no payload to take its items from`,
    );
  }
  let items: readonly unknown[];
  try {
    items = itemsOf(site.stepId, aggregate.payload);
  } catch (error) {
    throw new UnresumablePositionError(
      'unsupported',
      site.path,
      `the stored input of the .foreach() step '${site.stepId}' cannot be iterated: ${(error as Error).message}`,
    );
  }

  const stored = storedForeachOutput(aggregate);
  // `prevPayload?.status === 'suspended' ? meta.foreachIndex || 0 : 0` (`:1030-1031`), `||` and all.
  const meta = metaOf(aggregate);
  const resumeIndex = aggregate.status === 'suspended' ? (meta?.['foreachIndex'] as unknown) || 0 : 0;

  const order: { index: number; resumed?: true }[] = [];
  const done: ForeachItemRecord[] = [];
  const parked: SuspendToken[] = [];
  for (let k = 0; k < items.length; k++) {
    const prev = stored[k] as { readonly status?: unknown; readonly suspendPayload?: unknown; readonly suspendedAt?: unknown } | null | undefined;
    const status = prev?.status;
    if (status === 'success') {
      done.push({ index: k, record: prev as StepRecord });
      continue;
    }
    if (status === 'suspended' && forEachIndex !== undefined && forEachIndex !== k) {
      parked.push({
        stepId: site.stepId,
        path: site.path,
        foreachIndex: k,
        payload: prev!.suspendPayload,
        ...(typeof prev!.suspendedAt === 'number' ? { suspendedAt: prev!.suspendedAt } : {}),
      });
      continue;
    }
    const resumed = forEachIndex !== undefined ? forEachIndex === k : status === 'suspended' || resumeIndex === k;
    order.push(resumed ? { index: k, resumed: true } : { index: k });
  }
  return { items, order, done, parked };
}

function metaOf(record: StepRecord): Record<string, unknown> | undefined {
  const payload = (record as { readonly suspendPayload?: unknown }).suspendPayload;
  if (payload === null || typeof payload !== 'object') return undefined;
  const meta = (payload as { readonly __workflow_meta?: unknown }).__workflow_meta;
  return meta !== null && typeof meta === 'object' ? (meta as Record<string, unknown>) : undefined;
}

import type { ForeachResume, ForeachSite, StepRecord } from './types.js';

/**
 * The `.foreach()` re-entry token, following Mastra's classification of every item before any
 * runs (`handlers/control-flow.ts:1227-1270`): a succeeded item is skipped and its output reused, a
 * suspended item other than the one resumed stays parked, the resumed item (or, with no index,
 * every suspended item) runs with the resume data, and an item with no record runs fresh.
 *
 * CONTRACT STUB (ADR 0007): implemented by the foreach area, which lands last in M4.
 */
export function foreachSeed(
  _site: ForeachSite,
  _aggregate: StepRecord,
  _records: ReadonlyMap<string, StepRecord>,
  _forEachIndex?: number,
): ForeachResume {
  throw new Error('foreachSeed: not implemented yet (M4, ADR 0007)');
}

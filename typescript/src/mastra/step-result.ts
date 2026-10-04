import type { RunView, StepRecord } from '../compiler/types.js';
import { StepPreemptedError } from '../compiler/preempt.js';
import type {
  StepBailed,
  StepCanceled,
  StepWaiting,
  StepFailure,
  StepMetadata,
  StepPaused,
  StepSuccess,
  StepSuspended,
  StepTripwireInfo,
  StoredStepResult,
} from './host.js';

/**
 * Translation between the engine's `StepRecord` and Mastra's `StepResult`, and Mastra's
 * `getStepResult` over a `RunView`.
 *
 * Pure functions, no Mastra import: the M2 runner uses them at the seam — to hand Mastra a
 * `stepResults` entry it recognises, to rehydrate the run scope from a snapshot, and to give a
 * step's `execute` context the `getStepResult` it expects.
 *
 * **`host` is the carrier for what the engine does not model.** A record the runner built from a
 * Mastra result carries that result verbatim as `host`; translating back starts from it and
 * overlays only the fields the engine owns, so `resumePayload`, `resumedAt`,
 * a nested workflow's `metadata.nestedRunId` and anything added upstream survive the round trip.
 */

/**
 * A `StepResult` the engine can produce: every status a finished outcome can have, and the
 * `canceled` record a loop or foreach writes.
 */
export type OutcomeStepResult = StepSuccess | StepFailure | StepSuspended | StepPaused | StepBailed | StepCanceled | StepWaiting;

export interface ToMastraOptions {
  /**
   * Epoch milliseconds to use for a timestamp the record lacks. Records the engine produces always
   * carry the ones Mastra's type requires; one carried in from elsewhere may not. Without this, a
   * missing required timestamp throws rather than being invented. A `canceled` record requires
   * none, so none is ever invented for it.
   */
  readonly now?: number;
  /**
   * How a failure that is not an `Error` becomes one. Mastra passes every thrown value through
   * `getErrorFromUnknown(e, { serializeStack: false, fallbackMessage: 'Unknown step execution error' })`
   * before recording it (`default.ts:466-469`); a runner that can reach that function should pass
   * it here. The default ports its three branches (`getErrorFromUnknown` in the published
   * `dist/error-*.js`; its source is not among the extracted files) but not the `toJSON` it
   * attaches or its recursive `cause` conversion.
   */
  readonly normalizeError?: (error: unknown) => Error;
}

/**
 * Fields the engine owns; a `host` record's copies are replaced, never merged.
 *
 * The suspension's three fields are among them, so a stale `suspendedAt`, `suspendPayload` or
 * `suspendOutput` in `host` never survives into a record that is no longer suspended: Mastra
 * drops exactly these, with `output`, `error`, `endedAt`, `tripwire` and `nonRetryable`, from a
 * re-entered step's prior record (`omitPriorCompletionFields`, `utils.ts:759-775`, applied at
 * `handlers/step.ts:170-178,570`).
 */
const MODELLED: ReadonlySet<string> = new Set([
  'status',
  'output',
  'error',
  'tripwire',
  'nonRetryable',
  'payload',
  'startedAt',
  'endedAt',
  'suspendedAt',
  'suspendPayload',
  'suspendOutput',
  'metadata',
]);

/**
 * A `StepRecord` as Mastra's `stepResults` would hold it.
 *
 * Field by field, as Mastra's step handler writes it — `{...omitPriorCompletionFields(stepInfo),
 * ...execResults}`, the running record of `handlers/step.ts:169-178` overlaid by the outcome of
 * `:512-569`: `success` and `bailed` carry `output` and `endedAt`; `failed` carries `error`,
 * `endedAt`, and `tripwire` / `nonRetryable` when set (`default.ts:490-505`); `suspended` carries
 * `suspendPayload`, `suspendedAt`, and `suspendOutput` only when that output is **truthy**
 * (`:516-521`, `...(durableResult.output ? { suspendOutput } : {})`); `paused` carries neither an
 * end nor an output (`:525-526`). `payload`, `startedAt` and `metadata` are common to all.
 *
 * A `canceled` record — a loop's or a foreach's (`handlers/control-flow.ts:752,1164-1169,1306`)
 * — carries exactly the fields it has and no invented ones: the loop's is a bare
 * `{ status: 'canceled' }`.
 *
 * A `race` / `quorum` loser's `canceled` record ([ADR 0014]) carries `reason`, a
 * `StepPreemptedError`. It is written as the row's `error`, through `normalizeError` as a failure's
 * error is, so a client reading `steps[id].error` sees why the arm stopped; its `kind`, `block`,
 * `path` and `outcome` are own enumerable fields, so they survive a JSON round trip of the row.
 * Mastra's `StepCanceled` declares no `error`, and nothing of Mastra's reads one on a canceled row
 * (`getStepOutput` reads `output` only). A canceled record without `reason` — a loop's, a foreach's,
 * a run cancel's — gets no `error`, as today. A canceled row read back whose `error` is still the
 * reason the record carries (the same object, or a stored copy naming the same block, path and
 * outcome) is kept as it was stored, as a failure's error is. {@link fromMastraStepResult} restores
 * `reason`; `tests/mastra/step-result-roundtrip.test.ts` pins both ways.
 *
 * A `tripwire` that is an `Error` (a `TripWire` instance) is flattened as Mastra flattens it
 * (`default.ts:496-504`); one that is already `{ reason }` passes through; anything else is not a
 * tripwire by Mastra's own test (`default.ts:611-626`) and is left off, as the kernel already
 * classifies such a failure as an ordinary one.
 *
 * `metadata.foreachIndex` is the engine's own and is not written: Mastra never puts it in
 * `stepResults` — a foreach's record is the aggregate, whose metadata carries at most
 * `nestedRunId` (`handlers/control-flow.ts:1492`).
 */
export function toMastraStepResult(record: StepRecord, options: ToMastraOptions = {}): OutcomeStepResult {
  const host = isRecord(record.host) ? record.host : {};
  const kept = Object.fromEntries(Object.entries(host).filter(([k]) => !MODELLED.has(k)));
  const metadata = mergeMetadata(host['metadata'], record.metadata);

  if (record.status === 'canceled') {
    const reason = record.reason;
    // A row Mastra's storage already holds for this very reason is kept as stored ([ADR 0014]).
    const stored = reason !== undefined && host['status'] === 'canceled' && samePreemption(host['error'], reason);
    return {
      ...kept,
      status: 'canceled',
      ...('payload' in record ? { payload: record.payload } : {}),
      ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
      ...('output' in record ? { output: record.output } : {}),
      ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
      ...(reason === undefined ? {} : { error: stored ? host['error'] : (options.normalizeError ?? normalizeError)(reason) }),
      ...(metadata === undefined ? {} : { metadata }),
    } as StepCanceled;
  }

  const time = (field: 'startedAt' | 'endedAt' | 'suspendedAt', own: number | undefined): number => {
    if (own !== undefined) return own;
    const fromHost = host[field];
    if (typeof fromHost === 'number') return fromHost;
    if (options.now !== undefined) return options.now;
    throw new Error(
      `a '${record.status}' step record has no ${field}, and Mastra's StepResult requires one. ` +
        'Pass `now` to supply it.',
    );
  };
  const common = {
    ...kept,
    payload: record.payload,
    startedAt: time('startedAt', record.startedAt),
    ...(metadata === undefined ? {} : { metadata }),
  };

  switch (record.status) {
    case 'success':
      return { ...common, status: 'success', output: record.output, endedAt: time('endedAt', record.endedAt) };
    case 'bailed':
      return { ...common, status: 'bailed', output: record.output, endedAt: time('endedAt', record.endedAt) };
    case 'failed': {
      const tripwire = tripwireInfo(record.tripwire);
      // A failure Mastra itself recorded — `host` is that very record — is already what Mastra
      // stores: its `error` normalised, or serialised once it has been through storage
      // (`SerializedStepFailure`), and is kept as it is.
      const recorded = host['status'] === 'failed' && host['error'] === record.error;
      return {
        ...common,
        status: 'failed',
        error: recorded ? (record.error as Error) : (options.normalizeError ?? normalizeError)(record.error),
        endedAt: time('endedAt', record.endedAt),
        // An own key even when there is no tripwire: Mastra writes `tripwire: undefined` on every
        // failure (`default.ts:497-506`), and the differential harness compares keys, not values.
        // A stored failure JSON dropped the undefined key from gets it back, as Mastra writes it.
        tripwire,
        ...(record.nonRetryable === true ? { nonRetryable: true as const } : {}),
        // A failed `.foreach()` aggregate carries its `__workflow_meta.foreachOutput` here
        // (`handlers/control-flow.ts:1355-1370`); no other failure has one.
        ...(record.suspendPayload === undefined ? {} : { suspendPayload: record.suspendPayload }),
      } as StepFailure;
    }
    case 'suspended':
      return {
        ...common,
        status: 'suspended',
        suspendPayload: record.suspendPayload,
        ...(record.suspendOutput ? { suspendOutput: record.suspendOutput } : {}),
        suspendedAt: time('suspendedAt', record.suspendedAt),
      };
    case 'paused':
      return { ...common, status: 'paused' };
    case 'waiting':
      // A sleep canceled mid-wait keeps this, as Mastra's does (`handlers/entry.ts:602-609`).
      return { ...common, status: 'waiting' };
  }
}

/**
 * A Mastra `stepResults` entry as a `StepRecord`, or `undefined` when it is not an outcome.
 *
 * `running` and `skipped` are not records: a step in flight (`handlers/step.ts:169-178`) and an
 * arm time travel did not take (`handlers/control-flow.ts:517-528`). `waiting` is: a sleep writes it
 * when it begins and it survives a cancel (`handlers/entry.ts:602-609,641-643`). The engine's store holds only what a step *produced*,
 * so none of them has a `StepRecord`, and `undefined` is what `getStepResult` returns for a step
 * with no record — which Mastra's own accessor treats identically, returning `null` for every
 * status but `success` (`step.ts:179-193`). A caller that must keep such an entry for the codec
 * keeps the Mastra object itself.
 *
 * **The inverse of {@link toMastraStepResult}** ([ADR 0007]: a resume starts from these records).
 * The whole result is kept as `host`, so `toMastraStepResult(fromMastraStepResult(r))` is `r` again
 * — key for key, a stored failure's serialised `error` included — for every status that has a
 * record, with one key restored: a failure JSON stored without its undefined `tripwire` gets the
 * own key back, as Mastra writes it (`default.ts:497-506`). The other way, `fromMastraStepResult(toMastraStepResult(rec))` is
 * `rec` on every field but `host` (now the Mastra result) and the two Mastra never stores: the
 * engine's `metadata.foreachIndex`, and a thrown value that is not an `Error`, which Mastra
 * normalises (`default.ts:466-469`). `tests/mastra/step-result-roundtrip.test.ts` holds both.
 * `metadata` keeps only the key the engine reads (`iterationCount`); the rest stays in `host`. A
 * status Mastra has not declared throws, naming it — except `bailed` and `canceled`, which Mastra
 * stores without declaring.
 */
export function fromMastraStepResult(result: StoredStepResult): StepRecord | undefined {
  const metadata = engineMetadata(result.metadata);
  const withMetadata = metadata === undefined ? {} : { metadata };
  if (result.status === 'canceled') {
    const reason = preemptionOf((result as { readonly error?: unknown }).error);
    return {
      status: 'canceled',
      ...('payload' in result ? { payload: result.payload } : {}),
      ...(result.startedAt === undefined ? {} : { startedAt: result.startedAt }),
      ...('output' in result ? { output: result.output } : {}),
      ...(result.endedAt === undefined ? {} : { endedAt: result.endedAt }),
      ...(reason === undefined ? {} : { reason }),
      ...withMetadata,
      host: result,
    };
  }
  const common = { payload: result.payload, startedAt: result.startedAt, ...withMetadata, host: result };
  switch (result.status) {
    case 'success':
      return { ...common, status: 'success', output: result.output, endedAt: result.endedAt };
    case 'bailed':
      return { ...common, status: 'bailed', output: result.output, endedAt: result.endedAt };
    case 'failed':
      return {
        ...common,
        status: 'failed',
        error: result.error,
        endedAt: result.endedAt,
        ...(result.tripwire === undefined ? {} : { tripwire: result.tripwire }),
        ...(result.nonRetryable === true ? { nonRetryable: true } : {}),
        ...(failedSuspendPayload(result) === undefined ? {} : { suspendPayload: failedSuspendPayload(result) }),
      };
    case 'suspended':
      return {
        ...common,
        status: 'suspended',
        suspendPayload: result.suspendPayload,
        ...(result.suspendOutput === undefined ? {} : { suspendOutput: result.suspendOutput }),
        suspendedAt: result.suspendedAt,
      };
    case 'paused':
      return { ...common, status: 'paused' };
    case 'waiting':
      // A sleep that began and, if the run was canceled, never finished — kept as Mastra keeps it
      // (`handlers/entry.ts:602-609,641-643`).
      return { ...common, status: 'waiting' };
    case 'running':
    case 'skipped':
      return undefined;
    default:
      throw new Error(
        `Mastra step result has status '${String((result as { status?: unknown }).status)}', which ` +
          '@mastra/core 1.67.0 does not declare; refusing to guess what it means.',
      );
  }
}

/** What Mastra's `getStepResult` accepts: a step id, or a step (read by its `id`). */
export type StepReference = string | { readonly id?: string } | null | undefined;

/**
 * Mastra's `getStepResult`, over a `RunView`: a step's **output** when its latest record is a
 * success, and `null` for everything else — a failure, a suspension, a bail, a step that never ran
 * (`step.ts:179-193`). A reference with no `id` is `null` too.
 *
 * `RunView.getStepResult` returns the whole `StepRecord`, because the engine's own readers (a
 * join, the codec) need the status; a step's `execute` context and a declarative predicate need
 * Mastra's narrower answer, and this is it.
 *
 * One quirk is reproduced on purpose: Mastra seeds a fresh run's `stepResults` as `{ input }`
 * (`default.ts:805-807`), so `getStepResult('input')` reads the **run's input** as if it were a
 * step result — its `output` when it happens to have `status: 'success'`, `null` otherwise — and a
 * step actually named `input` overwrites it, as its record does here.
 */
export function getStepResultView(
  view: Pick<RunView, 'getStepResult' | 'initData'>,
): (step: StepReference) => unknown {
  return (step) => {
    let id: string;
    if (typeof step === 'string') {
      id = step;
    } else {
      if (!step?.id) return null;
      id = step.id;
    }
    const record: unknown = view.getStepResult(id) ?? (id === 'input' ? view.initData : undefined);
    return isRecord(record) && record['status'] === 'success' ? record['output'] : null;
  };
}

/**
 * A canceled row's `error` as the `StepPreemptedError` it records ([ADR 0014]): the instance itself
 * while the row is live, rebuilt from `block`, `path` and `outcome` once it has been through storage.
 * Anything else — no error, another name, a malformed copy — is not a preemption, and the canceled
 * row reads as one without a `reason`.
 */
function preemptionOf(error: unknown): StepPreemptedError | undefined {
  if (error instanceof StepPreemptedError) return error;
  if (!isRecord(error) || error['name'] !== 'StepPreemptedError') return undefined;
  const { block, path, outcome } = error;
  if (typeof block !== 'string' || (outcome !== 'met' && outcome !== 'short')) return undefined;
  if (!Array.isArray(path) || !path.every((i) => Number.isInteger(i))) return undefined;
  return new StepPreemptedError(block, path as number[], outcome);
}

/** Whether a canceled row's stored `error` records `reason` — the same object, or a copy naming the same preemption. */
function samePreemption(error: unknown, reason: StepPreemptedError): boolean {
  if (error === reason) return true;
  const read = preemptionOf(error);
  return (
    read !== undefined &&
    read.block === reason.block &&
    read.outcome === reason.outcome &&
    read.path.length === reason.path.length &&
    read.path.every((i, n) => i === reason.path[n])
  );
}

/** A stored failure's `suspendPayload` — a failed `.foreach()` aggregate's meta — or none. */
function failedSuspendPayload(result: StoredStepResult): unknown {
  return (result as { readonly suspendPayload?: unknown }).suspendPayload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function mergeMetadata(fromHost: unknown, own: StepRecord['metadata']): StepMetadata | undefined {
  // The engine's `foreachIndex` is not Mastra's: see `toMastraStepResult`.
  const iterationCount = own?.iterationCount;
  const engine = iterationCount === undefined ? undefined : { iterationCount };
  if (!isRecord(fromHost) && engine === undefined) return undefined;
  return { ...(isRecord(fromHost) ? fromHost : {}), ...(engine ?? {}) };
}

function engineMetadata(metadata: StepMetadata | undefined): StepRecord['metadata'] {
  const iterationCount = metadata?.['iterationCount'];
  return typeof iterationCount === 'number' ? { iterationCount } : undefined;
}

/** A `TripWire` flattened as `default.ts:496-504` does; `{ reason }` data as is; else none. */
function tripwireInfo(tripwire: unknown): StepTripwireInfo | undefined {
  if (tripwire instanceof Error) {
    const wire = tripwire as Error & { options?: { retry?: boolean; metadata?: Record<string, unknown> }; processorId?: string };
    return {
      reason: wire.message,
      retry: wire.options?.retry,
      metadata: wire.options?.metadata,
      processorId: wire.processorId,
    } as StepTripwireInfo;
  }
  if (isRecord(tripwire) && 'reason' in tripwire) return tripwire as unknown as StepTripwireInfo;
  return undefined;
}

/**
 * The three branches of Mastra's `getErrorFromUnknown`, with the `fallbackMessage` the step
 * handler passes: an `Error` as is; an object as an `Error` with its `message` (or its JSON, as `safeParseErrorObject`) and
 * its own fields copied on, and its `stack` only if it had one; a non-empty string as the
 * message, with no stack; anything else as `'Unknown step execution error'`.
 */
function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  let normalized: Error;
  if (isRecord(error)) {
    const message = typeof error['message'] === 'string' ? error['message'] : safeJson(error);
    normalized = new Error(message);
    Object.assign(normalized, error);
    normalized.stack = typeof error['stack'] === 'string' ? error['stack'] : undefined;
  } else if (typeof error === 'string' && error !== '') {
    normalized = new Error(error);
    normalized.stack = undefined;
  } else {
    normalized = new Error('Unknown step execution error');
  }
  return normalized;
}

/** `safeParseErrorObject`: the JSON, unless it is `{}` or throws, then `String(value)`. */
function safeJson(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined || json === '{}' ? String(value) : json;
  } catch {
    return String(value);
  }
}

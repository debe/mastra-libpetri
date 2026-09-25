import { randomUUID } from 'node:crypto';
import { omitPriorCompletionFields, type ExecutionEngine } from '@mastra/core/workflows';
import type { EntryPath } from '../compiler/names.js';
import type { LifecycleEvent, StepRecord } from '../compiler/types.js';
import { toMastraStepResult } from './step-result.js';

type PubSub = Parameters<ExecutionEngine['execute']>[0]['pubsub'];

export interface StepEventsOptions {
  readonly pubsub: PubSub;
  readonly runId: string;
  /**
   * `emitStepEvents !== false`, read per run as the default engine's `publishStepEvent` reads it
   * (`handlers/entry.ts:23-29`, `handlers/control-flow.ts:42-48`, `handlers/step.ts:103`).
   */
  readonly enabled: boolean;
  /** Epoch milliseconds on the run's clock: a start event's `startedAt`, a record's missing stamp. */
  readonly now: () => number;
  /**
   * The resume this segment continues, when it is one: what a resumed `.foreach()`'s start carries
   * (`handlers/control-flow.ts:987-996`) — the resume payload, the segment's `resumedAt` (the same
   * stamp `withForeachHostFields` gives the aggregate) and the stored records the prior is read from.
   */
  readonly resume?: {
    readonly payload: unknown;
    readonly resumedAt: () => number;
    readonly records?: ReadonlyMap<string, StepRecord> | undefined;
  };
}

/** What a step's start event is built from — the default engine's `stepInfo` inputs (`handlers/step.ts:111-178`). */
export interface StepStart {
  readonly stepId: string;
  readonly path: EntryPath;
  /** The input after `validateStepInput` — the raw input when validation failed (`handlers/step.ts:111`). */
  readonly input: unknown;
  /** `stepResults[step.id]` as the call reads it, Mastra-shaped. */
  readonly prior: Record<string, unknown> | undefined;
  /** Set on a resumed record (truthy resume data): Mastra's `resumeDataToUse` and `resumeTime`. */
  readonly resumed?: { readonly payload: unknown; readonly resumedAt: number } | undefined;
  /** Mastra's `iterationCount`, when a loop started the call. */
  readonly iteration?: number | undefined;
  /** The call's start on the run's clock — `StepCall.startedAt`, the record's own `startedAt`. */
  readonly startedAt?: number | undefined;
}

/**
 * Mastra's per-step watch events for one run segment ([ADR 0008]), published on the run's pubsub
 * topic `workflow.events.v2.${runId}` as `{ type: 'watch', runId, data: { type, payload } }` —
 * the default engine's vocabulary and payloads, emission point by emission point:
 *
 * - a step's `workflow-step-start` at its first attempt (the runner calls {@link stepStarted}),
 *   `{ id, stepCallId, ...stepInfo }` (`default.ts:212-240`, `handlers/step.ts:169-178`);
 * - its `-result` + `-finish`, or `-suspended`, at `step-settled` (`handlers/step.ts:531-545,661-690`),
 *   the result being the record the run's store holds, which is Mastra's
 *   `{ ...omitPriorCompletionFields(stepInfo), ...execResults }`;
 * - a sleep's `workflow-step-waiting`, then `-result` + `-finish` (`handlers/entry.ts:586-802`);
 * - a `.foreach()`'s `-start` at `foreach-entered`, `workflow-step-progress` per item, and the
 *   aggregate's result / finish / suspended at `foreach-settled` (`handlers/control-flow.ts:990-1480`);
 *   a canceled foreach publishes nothing, and its items publish nothing of their own.
 *
 * **Awaited by its own caller, as Mastra awaits it.** There is no run-wide queue: each publish is
 * issued the moment it is raised and awaited only by what raised it — a step's start by that step,
 * before its first attempt (`default.ts:212-240`); its result and finish by the firing that settles
 * it (`handlers/step.ts:531-545`). Two parallel arms publish concurrently, as they do on the default
 * engine, so a slow pubsub delays each step by its own publishes and no one else's. **Within** one
 * step the order is Mastra's: the result is published, and the finish only once that publish
 * resolved (`handlers/step.ts:670-689`) — a result that rejects publishes no finish.
 *
 * **Complete.** {@link flush} resolves once every publish issued so far has settled, which
 * `execute()` awaits before it returns — `Run` publishes `workflow-finish` after `execute()`
 * resolves (`workflow.ts:3766-3800`).
 *
 * **Observation only.** A publish that throws never fails a step: the first error is kept for the
 * engine to log (see {@link error}), and every later event is still published.
 */
export class StepEvents {
  readonly #o: StepEventsOptions;
  /** Every publish not yet settled, for {@link flush}. */
  readonly #inFlight = new Set<Promise<void>>();
  #error: { readonly error: unknown } | undefined;
  /** The step call id of each step call in flight, by position: its start's, for its result's. */
  readonly #calls = new Map<string, string>();
  /** Per `.foreach()` body id: Mastra's `completedCount` and `totalCount` (`handlers/control-flow.ts:1053-1054`). */
  readonly #foreach = new Map<string, { completed: number; readonly total: number | undefined }>();

  constructor(options: StepEventsOptions) {
    this.#o = options;
  }

  /** Whether this run publishes step events at all (`emitStepEvents !== false`). */
  get enabled(): boolean {
    return this.#o.enabled;
  }

  /** The first publish that threw or rejected, if one did. The run is unaffected. */
  get error(): { readonly error: unknown } | undefined {
    return this.#error;
  }

  /** Keeps an error raised while building an event, as a publish's is kept: the run is unaffected. */
  keep(error: unknown): void {
    this.#error ??= { error };
  }

  /** Resolves once every event published so far has settled. Never rejects. */
  async flush(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.allSettled([...this.#inFlight]);
  }

  /**
   * The step call id of a call: new at the first attempt, the same for every retry — Mastra draws
   * one per `executeStep` (`handlers/step.ts:106`), which runs every attempt. The writer's
   * `callId` too (`:445-452`), so it is drawn whether or not events are published.
   */
  callId(stepId: string, path: EntryPath, attempt: number, foreachIndex?: number): string {
    const key = callKey(stepId, path, foreachIndex);
    const known = this.#calls.get(key);
    if (attempt > 0 && known !== undefined) return known;
    const id = randomUUID();
    this.#calls.set(key, id);
    return id;
  }

  /**
   * `workflow-step-start` for a step call, before its first attempt runs (`default.ts:212-240`):
   * `{ id, stepCallId, ...omitPriorCompletionFields(stepInfo) }`, `stepInfo` built exactly as
   * `handlers/step.ts:169-178` builds it. `start.startedAt` is the stamp the step's record takes —
   * Mastra's one `startTime` for both (`:166,172`). Never rejects.
   */
  stepStarted(start: StepStart, stepCallId: string): Promise<void> {
    const stepInfo = {
      ...omitPriorCompletionFields(start.prior ?? {}),
      ...(start.resumed === undefined ? { payload: start.input } : { resumePayload: start.resumed.payload }),
      ...(start.resumed === undefined ? { startedAt: start.startedAt ?? this.#o.now() } : {}),
      ...(start.resumed === undefined ? {} : { resumedAt: start.resumed.resumedAt }),
      status: 'running',
      ...(start.iteration ? { metadata: { iterationCount: start.iteration } } : {}),
    };
    return this.#publish('workflow-step-start', {
      id: start.stepId,
      stepCallId,
      ...omitPriorCompletionFields(stepInfo),
    }).catch(() => {});
  }

  /**
   * A lifecycle event from the net, as the default engine's events. `prior` reads the live store,
   * for a fresh `.foreach()`'s start. Rejects if a publish did; the scope keeps that as the report's
   * `observerError`.
   */
  observe(event: LifecycleEvent, prior: (stepId: string) => StepRecord | undefined): Promise<void> {
    switch (event.kind) {
      case 'step-settled':
        return event.foreachIndex === undefined ? this.#stepSettled(event) : this.#itemSettled(event.stepId, event.foreachIndex, event.record);
      case 'sleep-waiting':
        // `handlers/entry.ts:586-600,694-709`.
        return this.#publish('workflow-step-waiting', {
          id: event.stepId,
          payload: event.record.payload,
          startedAt: event.record.startedAt,
          status: 'waiting',
        });
      case 'sleep-settled':
        // `handlers/entry.ts:656-690,768-802`.
        return this.#resultThenFinish(
          {
            id: event.stepId,
            endedAt: event.record.endedAt,
            status: 'success',
            output: (event.record as { readonly output?: unknown }).output,
          },
          { id: event.stepId, metadata: {} },
        );
      case 'foreach-entered':
        return this.#foreachEntered(event, prior);
      case 'foreach-settled':
        return this.#foreachSettled(event.stepId, event.record);
      default: {
        const unknown: never = event;
        throw new Error(`unknown lifecycle event ${JSON.stringify(unknown)}`);
      }
    }
  }

  /** `workflow-canceled`, as the default engine publishes it at an entry's end (`handlers/entry.ts:831-837`). */
  canceled(): Promise<void> {
    return this.#publish('workflow-canceled', {}).catch(() => {});
  }

  /** `emitStepResultEvents` (`handlers/step.ts:661-690`), over the record the store now holds. */
  #stepSettled(event: Extract<LifecycleEvent, { kind: 'step-settled' }>): Promise<void> {
    const key = callKey(event.stepId, event.path);
    const stepCallId = this.#calls.get(key);
    this.#calls.delete(key);
    const base = stepCallId === undefined ? { id: event.stepId } : { id: event.stepId, stepCallId };
    const result = this.#mastra(event.record);
    if (result['status'] === 'suspended') return this.#publish('workflow-step-suspended', { ...base, ...result });
    return this.#resultThenFinish({ ...base, ...result }, { ...base, metadata: {} });
  }

  /**
   * `workflow-step-progress` for one item (`handlers/control-flow.ts:1066-1084,1117-1152`):
   * `completedCount` counts every item that settled but did not suspend — a success, a failure,
   * any other non-success — as it stood **after** this item; a suspended item is not counted.
   */
  #itemSettled(stepId: string, index: number, record: StepRecord): Promise<void> {
    this.#calls.delete(callKey(stepId, [], index));
    const counts = this.#foreach.get(stepId) ?? { completed: 0, total: undefined };
    this.#foreach.set(stepId, counts);
    let iterationStatus: 'success' | 'suspended' | 'failed';
    if (record.status === 'suspended') {
      iterationStatus = 'suspended';
    } else {
      counts.completed++;
      iterationStatus = record.status === 'success' ? 'success' : 'failed';
    }
    const output = record.status === 'success' ? (record as { readonly output?: unknown }).output : undefined;
    return this.#publish('workflow-step-progress', {
      id: stepId,
      completedCount: counts.completed,
      totalCount: counts.total,
      currentIndex: index,
      iterationStatus,
      ...(output !== undefined ? { iterationOutput: output } : {}),
    });
  }

  /**
   * A `.foreach()`'s `workflow-step-start` (`handlers/control-flow.ts:987-1026`): `{ id, ...stepInfo,
   * status: 'running' }` — no `stepCallId` — with `stepInfo` the prior record less its completion
   * fields, then the resume payload and `resumedAt` on a resumed foreach, the input and `startedAt`
   * otherwise.
   */
  #foreachEntered(event: Extract<LifecycleEvent, { kind: 'foreach-entered' }>, prior: (stepId: string) => StepRecord | undefined): Promise<void> {
    this.#foreach.set(event.stepId, { completed: 0, total: event.items });
    const resume = event.resumed ? this.#o.resume : undefined;
    const stored = resume === undefined ? prior(event.stepId) : (resume.records?.get(event.stepId) ?? prior(event.stepId));
    const stepInfo = {
      ...omitPriorCompletionFields(stored === undefined ? {} : this.#mastra(stored)),
      ...(resume === undefined ? { payload: event.input } : { resumePayload: resume.payload }),
      ...(resume === undefined ? { startedAt: event.startedAt ?? this.#o.now() } : { resumedAt: resume.resumedAt() }),
    };
    return this.#publish('workflow-step-start', { id: event.stepId, ...omitPriorCompletionFields(stepInfo), status: 'running' });
  }

  /**
   * The aggregate's events (`handlers/control-flow.ts:1298-1480`), by the status of the record the
   * net wrote:
   *
   * - `success`: `{ id, status, output, endedAt }`, then finish;
   * - `failed`: `{ id, status, error, suspendPayload, suspendedAt, endedAt }` of the first failure
   *   (`:1318-1352`) — an item's failure carries no suspension, so both are `undefined` own keys;
   * - `bailed`, `paused`, any other exit: `{ id, ...exitResult }`, the item's own record (`:1374-1405`);
   * - `suspended`: only `workflow-step-suspended`, `{ id, ...foreachIndexObj[lowest] }` — that item's
   *   `status`, `suspendPayload` and `suspendedAt` (`:1119-1124,1409-1430`), read back from the
   *   aggregate's `foreachOutput`;
   * - `canceled`: nothing (`:1279-1310` return without a publish).
   *
   * A foreach whose input had no length publishes nothing either: Mastra's `prevOutput.length`
   * throws after the start (`:1053`) and the run rejects (`docs/divergences.md` rows 22, 26).
   */
  #foreachSettled(stepId: string, record: StepRecord): Promise<void> {
    const counts = this.#foreach.get(stepId);
    this.#foreach.delete(stepId);
    if (counts !== undefined && counts.total === undefined) return Promise.resolve();
    const finish = { id: stepId, metadata: {} };
    switch (record.status) {
      case 'canceled':
        return Promise.resolve();
      case 'success':
        return this.#resultThenFinish({ id: stepId, status: 'success', output: record.output, endedAt: record.endedAt }, finish);
      case 'failed': {
        const failure = this.#mastra(record);
        return this.#resultThenFinish(
          {
            id: stepId,
            status: 'failed',
            error: failure['error'],
            suspendPayload: undefined,
            suspendedAt: undefined,
            endedAt: failure['endedAt'],
          },
          finish,
        );
      }
      case 'suspended': {
        const meta = asRecord(asRecord(record.suspendPayload)['__workflow_meta']);
        const index = typeof meta['foreachIndex'] === 'number' ? meta['foreachIndex'] : 0;
        const item = asRecord(Array.isArray(meta['foreachOutput']) ? meta['foreachOutput'][index] : undefined);
        return this.#publish('workflow-step-suspended', {
          id: stepId,
          status: 'suspended',
          suspendPayload: item['suspendPayload'],
          suspendedAt: item['suspendedAt'],
        });
      }
      default:
        return this.#resultThenFinish({ id: stepId, ...this.#mastra(record) }, finish);
    }
  }

  #mastra(record: StepRecord): Record<string, unknown> {
    return toMastraStepResult(record, { now: this.#o.now() }) as unknown as Record<string, unknown>;
  }

  /**
   * Publishes now, concurrently with any other step's publishes; resolves or rejects with the
   * publish. Kept in flight until it settles, for {@link flush}; a rejection is kept as {@link error}.
   */
  #publish(type: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.#o.enabled) return Promise.resolve();
    const { pubsub, runId } = this.#o;
    let next: Promise<void>;
    try {
      next = Promise.resolve(pubsub.publish(`workflow.events.v2.${runId}`, { type: 'watch', runId, data: { type, payload } }));
    } catch (error) {
      next = Promise.reject(error);
    }
    const tracked = next.catch((error: unknown) => {
      this.#error ??= { error };
    });
    this.#inFlight.add(tracked);
    void tracked.finally(() => this.#inFlight.delete(tracked));
    return next;
  }

  /**
   * A result, then its finish once the result's publish resolved (`handlers/step.ts:670-689`):
   * a result that rejects publishes no finish, and the rejection is the caller's.
   */
  #resultThenFinish(result: Record<string, unknown>, finish: Record<string, unknown>): Promise<void> {
    return this.#publish('workflow-step-result', result).then(() => this.#publish('workflow-step-finish', finish));
  }
}

/**
 * A step call's position. A `.foreach()` item's is its body id and index: every item runs at the
 * foreach's own view path, and only one foreach with a given body id runs at a time.
 */
function callKey(stepId: string, path: EntryPath, foreachIndex?: number): string {
  return foreachIndex === undefined ? `${path.join('.')}\u0000${stepId}` : `#${foreachIndex}\u0000${stepId}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

import { MAX_CONCURRENCY, MAX_WAIT_MS, QUOTA_ID_PATTERN } from '../compiler/index.js';
import type { QuotaRef } from '../compiler/types.js';

/**
 * Where the petri `createStep` keeps a step's Layer 3 resources ([ADR 0012], [ADR 0013]): on the
 * Step object it returns, and on the options object Mastra keeps as `__agentOptions` /
 * `__toolOptions` for an agent or tool source (`workflow.ts:579-593`), so the adapter finds them
 * whichever object reaches the step flow. The petri `cloneStep` copies it.
 *
 * Module-private in the package's sense: exported for the adapter and the tests, never from
 * `mastra/index.ts`, so no workflow author can attach resources except through the petri factories
 * — the `PetriEngineType` brand is the gate ([ADR 0002]).
 */
export const STEP_RESOURCES: unique symbol = Symbol('mastra-libpetri.stepResources');

/**
 * A step's resources as attached: the quota objects it draws on, in declaration order, and its
 * per-attempt deadline in milliseconds. The adapter reads them into `StepDescription.quotas` and
 * `StepDescription.timeoutMs`.
 */
export interface StepResources {
  readonly quotas?: readonly Quota[];
  readonly timeoutMs?: number;
}

/** Guards {@link Quota}'s constructor: only {@link limit} and {@link rateLimit} mint quotas. */
const minted: unique symbol = Symbol('mastra-libpetri.quota');

/**
 * A quota a petri step can draw on through `createStep({ uses: [quota] })` ([ADR 0012]) — what
 * `init().limit` and `init().rateLimit` return. **Identity is the object**: every step listing this
 * object shares one quota per run; `id` names its places (`wf.quota.<id>`), so the adapter refuses
 * two different quota objects with one id in one workflow (`quota-id-collision`).
 *
 * One run's quota: each run is its own net, so a quota is never shared across concurrent runs
 * (maintainer decision; a divergence row).
 */
export class Quota {
  /** @internal Use {@link limit} or {@link rateLimit}. */
  constructor(key: typeof minted, readonly ref: QuotaRef) {
    if (key !== minted) throw new TypeError('a Quota is made by init().limit or init().rateLimit');
  }

  /** The quota's id — a name segment, `[A-Za-z0-9_-]+`. */
  get id(): string {
    return this.ref.id;
  }

  /** `'limit'` or `'rate'`. */
  get kind(): QuotaRef['kind'] {
    return this.ref.kind;
  }
}

/** What {@link limit} and {@link rateLimit} take beside their numbers. */
export interface QuotaOptions {
  /** Names the quota's places; `[A-Za-z0-9_-]+`, refused otherwise (`quota-value`). */
  readonly id: string;
}

/**
 * `limit(n, { id })` ([ADR 0012]): at most `n` attempts of every step using it in flight at once.
 * Each attempt takes one with its run permit in the same firing and returns it on every branch — so
 * no hold-and-wait, and no deadlock between pools — holding it across a timeout's wait for the step
 * to settle. Refused (`quota-value`): `n` not a whole number in [1, `MAX_CONCURRENCY`], or a bad id.
 */
export function limit(n: number, options: QuotaOptions): Quota {
  const id = quotaId('limit', options);
  wholeIn('limit', id, 'n', n, MAX_CONCURRENCY);
  return new Quota(minted, { id, kind: 'limit', n });
}

/**
 * `rateLimit(burst, perMs, { id })` ([ADR 0012]): at most `burst` tokens at once, one back every
 * `perMs` ms on the run's clock; every attempt of every using step spends one, retries included.
 * Refused (`quota-value`): `burst` not a whole number in [1, `MAX_CONCURRENCY`], `perMs` not a whole
 * number in [1, `MAX_WAIT_MS`], or a bad id.
 */
export function rateLimit(burst: number, perMs: number, options: QuotaOptions): Quota {
  const id = quotaId('rateLimit', options);
  wholeIn('rateLimit', id, 'burst', burst, MAX_CONCURRENCY);
  wholeIn('rateLimit', id, 'perMs', perMs, MAX_WAIT_MS);
  return new Quota(minted, { id, kind: 'rate', burst, perMs });
}

/** The quota's id, refused (`quota-value`) unless it is a string matching `QUOTA_ID_PATTERN`. */
function quotaId(factory: string, options: QuotaOptions | undefined): string {
  const id: unknown = options?.id;
  if (typeof id !== 'string' || !QUOTA_ID_PATTERN.test(id)) {
    throw new RangeError(`${factory}: quota-value: the id must match [A-Za-z0-9_-]+, got ${JSON.stringify(id)}`);
  }
  return id;
}

/** Refuses (`quota-value`) anything but a whole number in [1, `max`]. */
function wholeIn(factory: string, id: string, name: string, value: unknown, max: number): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${factory}('${id}'): quota-value: ${name} must be a whole number in [1, ${max}], got ${String(value)}`);
  }
}

/**
 * Attaches `resources` under {@link STEP_RESOURCES} to `target` — the Step object, and the agent or
 * tool options object Mastra keeps. Non-enumerable, so a spread of the step (Mastra's `cloneStep`,
 * a scorer's view) does not copy it by accident; the petri `cloneStep` copies it on purpose.
 */
export function attachResources(target: object, resources: StepResources): void {
  const frozen: StepResources = Object.freeze({
    ...(resources.quotas === undefined ? {} : { quotas: Object.freeze([...resources.quotas]) }),
    ...(resources.timeoutMs === undefined ? {} : { timeoutMs: resources.timeoutMs }),
  });
  Object.defineProperty(target, STEP_RESOURCES, { value: frozen, enumerable: false, configurable: true, writable: false });
}

/**
 * The resources attached to a step-flow step, looked up on the step itself and then on its
 * `__agentOptions` / `__toolOptions`; `undefined` when none — every step built by Mastra's own
 * factories, and every petri step declared without `uses` or `timeout`. The object passed may also
 * be the options object itself, as a declarative `{ type: 'agent' | 'tool', options }` entry holds it.
 */
export function resourcesOf(step: unknown): StepResources | undefined {
  if (step === null || (typeof step !== 'object' && typeof step !== 'function')) return undefined;
  const own = (step as { [STEP_RESOURCES]?: StepResources })[STEP_RESOURCES];
  if (own !== undefined) return own;
  const { __agentOptions, __toolOptions } = step as { __agentOptions?: unknown; __toolOptions?: unknown };
  for (const options of [__agentOptions, __toolOptions]) {
    if (options !== null && typeof options === 'object') {
      const kept = (options as { [STEP_RESOURCES]?: StepResources })[STEP_RESOURCES];
      if (kept !== undefined) return kept;
    }
  }
  return undefined;
}

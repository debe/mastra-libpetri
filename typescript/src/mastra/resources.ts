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
 * A step's resources as attached: the quota objects it draws on, in declaration order, its
 * per-attempt deadline in milliseconds, and its compensator. The adapter reads them into
 * `StepDescription.quotas`, `StepDescription.timeoutMs` and `StepDescription.compensate`.
 */
export interface StepResources {
  readonly quotas?: readonly Quota[];
  readonly timeoutMs?: number;
  /**
   * The step's compensator ([ADR 0017]): the petri params-form Step object `createStep({ compensate
   * })` was given, **kept by identity** — the adapter refuses anything else (`compensate-value`) and
   * describes it, with the parent's options, into `StepDescription.compensate`. Kept here, not on
   * the params, because Mastra's `createStep` builds the Step from a fixed field list and drops
   * unknown keys (`workflow.ts:510-530`, row 102) and `serializedStepGraph` emits none
   * (`workflow.ts:629-640`), so the key would reach neither the Step nor the persisted graph; a
   * forced `cloneWorkflow` keeps the Step by reference, so the default engine never sees it (T0).
   * For an agent or tool source it is stripped from the options copy with `uses` / `timeout`.
   */
  readonly compensate?: object;
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
    ...(resources.compensate === undefined ? {} : { compensate: resources.compensate }),
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

/**
 * The compensator attached to a step-flow step ([ADR 0017]) — the Step object
 * `init().createStep({ compensate })` was given, by identity — looked up as {@link resourcesOf} looks
 * (the Step, then its `__agentOptions` / `__toolOptions`, or a declarative entry's `options` itself);
 * `undefined` when none. What the runner resolves a compensator path to, and what the adapter
 * describes into `StepDescription.compensate`.
 */
export function compensatorOf(step: unknown): object | undefined {
  return resourcesOf(step)?.compensate;
}

/**
 * Every Step object the petri `createStep` built from a **params object** (not an agent, tool,
 * processor or workflow), and every petri `cloneStep` of one ([ADR 0017]): the only steps that may
 * be a compensator (`compensate-value`). A step made by Mastra's own `createStep` has no params-form
 * mark Mastra could give it — its `component` is `undefined`, as a petri one's — so membership here is
 * what tells the two apart at run time, where the brand does not reach.
 */
const paramsSteps = new WeakSet<object>();

/** Records `step` as a petri params-form step. Called by `init()`'s `createStep` and `cloneStep` only. */
export function markParamsStep(step: object): void {
  paramsSteps.add(step);
}

/** Whether `value` is a Step the petri `createStep` built from a params object, or a petri clone of one. */
export function isParamsStep(value: unknown): boolean {
  return value !== null && typeof value === 'object' && paramsSteps.has(value);
}

/** A {@link compensateProblem}: the refusal's name and its reason, in Mastra's words. */
export interface CompensateProblem {
  readonly code: 'compensate-value' | 'compensate-ids' | 'compensate-suspend' | 'compensate-checkpoint';
  readonly why: string;
}

/**
 * What is wrong with `compensator` as the compensator of step `forwardId` ([ADR 0017]), judged on the
 * two objects alone — everything visible at `createStep`, so `init()` throws it there and the adapter
 * repeats it, word for word, against a carrier that slipped past (attached by hand, or altered).
 * `undefined` when nothing is. In order:
 *
 * - `compensate-value` — not a step at all; a nested workflow (M8); an agent or tool step; a step not
 *   built by the petri `createStep` from a params object (Mastra's own `createStep`, a hand-made
 *   object); `forward` itself; a step carrying its own `compensate`.
 * - `compensate-ids` — the compensator's id is the forward step's own: both would be recorded under
 *   one key, and the undo's record would replace the step it undoes.
 * - `compensate-suspend` — a compensator declaring `suspendSchema` or `resumeSchema`: an undo cannot
 *   be suspended and resumed; it runs to an end once the workflow has failed.
 * - `compensate-checkpoint` — `metadata.checkpoint` set on the compensator, which is never an entry of
 *   the workflow and so has no point after it to resume from; or `true` on the forward step's own
 *   metadata (`forwardMetadata`), which would let a restart begin after a step that may need undoing.
 *
 * Position (`compensate-position`) and the workflow-wide id rules are the adapter's alone: no step
 * knows where it will be added.
 */
export function compensateProblem(
  forwardId: string,
  compensator: unknown,
  forward: object | undefined,
  forwardMetadata: unknown,
): CompensateProblem | undefined {
  const fix =
    'A compensator is a step built by init().createStep({ id, inputSchema, outputSchema, execute }) whose ' +
    `input schema accepts '${forwardId}''s output.`;
  if (compensator === null || typeof compensator !== 'object') {
    return { code: 'compensate-value', why: `its compensate is ${typeof compensator === 'function' ? 'a function' : String(compensator)}, not a step. ${fix}` };
  }
  const c = compensator as { id?: unknown; component?: unknown; suspendSchema?: unknown; resumeSchema?: unknown; metadata?: unknown };
  const name = typeof c.id === 'string' ? `'${c.id}'` : 'a step with no id';
  if (c.component === 'WORKFLOW') {
    return { code: 'compensate-value', why: `its compensate is the workflow ${name}; a nested workflow cannot undo a step yet. ${fix}` };
  }
  if (c.component === 'AGENT' || c.component === 'TOOL') {
    return {
      code: 'compensate-value',
      why: `its compensate is the ${c.component === 'AGENT' ? 'agent' : 'tool'} step ${name}; an agent or tool cannot undo a step. Call it from the execute of a step instead. ${fix}`,
    };
  }
  if (forward !== undefined && compensator === forward) {
    return { code: 'compensate-value', why: `its compensate is the step itself; a step cannot undo itself. ${fix}` };
  }
  if (!isParamsStep(compensator)) {
    return {
      code: 'compensate-value',
      why: `its compensate, ${name}, was not built by init().createStep from a params object (Mastra's own createStep, or a hand-made object, is not one). ${fix}`,
    };
  }
  if (compensatorOf(compensator) !== undefined) {
    return {
      code: 'compensate-value',
      why: `its compensate, ${name}, has a compensate of its own; an undo is not undone in turn. Give ${name} none.`,
    };
  }
  if (c.id === forwardId) {
    return {
      code: 'compensate-ids',
      why: `its compensate has the step's own id '${forwardId}'; Mastra records each step under its id, so the undo would replace the record of the step it undoes. Give the compensator its own id: cloneStep(compensator, { id }) makes a copy under a new one.`,
    };
  }
  if (c.suspendSchema !== undefined || c.resumeSchema !== undefined) {
    const which = [c.suspendSchema !== undefined ? 'suspendSchema' : undefined, c.resumeSchema !== undefined ? 'resumeSchema' : undefined]
      .filter((x) => x !== undefined)
      .join(' and ');
    return {
      code: 'compensate-suspend',
      why: `its compensate, ${name}, declares ${which}, but an undo runs after the workflow has failed and cannot be suspended or resumed. Remove them from ${name}.`,
    };
  }
  if (markedCheckpoint(c.metadata)) {
    return {
      code: 'compensate-checkpoint',
      why: `its compensate, ${name}, carries metadata.checkpoint, but a compensator is not a step of the workflow and has no point after it to restart from. Remove the key from ${name}.`,
    };
  }
  if (forwardMetadata !== null && typeof forwardMetadata === 'object' && (forwardMetadata as { checkpoint?: unknown }).checkpoint === true) {
    return {
      code: 'compensate-checkpoint',
      why:
        'it carries both compensate and metadata.checkpoint, but no checkpoint may follow a step that can be undone: a restart from it would skip ' +
        'the undo of a step that already ran. Mark a checkpoint before the first step that carries compensate, or none.',
    };
  }
  return undefined;
}

/** `metadata.checkpoint` set to anything but `undefined` or `false`. */
function markedCheckpoint(metadata: unknown): boolean {
  if (metadata === null || typeof metadata !== 'object') return false;
  if (!Object.prototype.hasOwnProperty.call(metadata, 'checkpoint')) return false;
  const value: unknown = (metadata as { checkpoint?: unknown }).checkpoint;
  return value !== undefined && value !== false;
}

/**
 * Where `init().race` / `init().quorum` keep a block's minted decision ([ADR 0014]): a key of the
 * fresh `metadata` object they put in the `.parallel()` call's options. Mastra keeps `metadata` by
 * reference in the step flow entry (`toEntryOptionFields`, `workflow.ts:647-653`), so the adapter
 * finds the very {@link Decision} here; `JSON.stringify` drops a symbol key, so the serialized graph
 * stays a plain `{ type: 'parallel' }` and the default engine never sees it.
 *
 * Module-private in the package's sense, as {@link STEP_RESOURCES}: exported for the adapter and the
 * tests, never from `mastra/index.ts`.
 */
export const BLOCK_DECISION: unique symbol = Symbol('mastra-libpetri.blockDecision');

/** Guards {@link Decision}'s constructor: only {@link race} and {@link quorum} mint one. */
const mintedDecision: unique symbol = Symbol('mastra-libpetri.decision');

/**
 * A minted counted decision ([ADR 0014]): `k` of the arms the factory was given must succeed. **The
 * arms are kept by identity**, so the adapter can refuse an entry whose arms are not exactly these
 * arms in this order (`blueprint-arms`) — a decision copied onto another `.parallel()` by hand. An
 * agent or tool arm reaches the entry without its Step object, so the adapter compares its ref and
 * options by identity instead (`blockDecision` in `adapt.ts`). A decision spread into two
 * `.parallel()` calls is refused as `blueprint-reused`.
 */
export class Decision {
  /** @internal Use {@link race} or {@link quorum}. */
  constructor(
    key: typeof mintedDecision,
    readonly kind: 'race' | 'quorum',
    readonly k: number,
    /** The Step objects the factory was given, in order. */
    readonly arms: readonly object[],
  ) {
    if (key !== mintedDecision) throw new TypeError('a Decision is made by init().race or init().quorum');
  }

  /** `n`: the arm count. */
  get n(): number {
    return this.arms.length;
  }
}

/**
 * What `race` and `quorum` take beside their arms: Mastra's own `.parallel()` options. `metadata` is
 * copied into a fresh object — so the author's object is never written to — with Layer 2 keys such
 * as `concurrency` ([ADR 0011]) kept as they are.
 */
export interface DecisionOptions {
  readonly id?: string;
  readonly description?: string;
  readonly metadata?: Record<string, unknown>;
}

/** The options `race` / `quorum` hand back, to spread into `.parallel()` with the arms. */
export interface DecisionEntryOptions {
  readonly id?: string;
  readonly description?: string;
  readonly metadata: Record<string, unknown> & { readonly [BLOCK_DECISION]: Decision };
}

/**
 * `race(arms, options?)` ([ADR 0014]): `quorum(1, arms, options)` — the first arm to **succeed** wins;
 * a failed, bailed, paused or suspended arm is a miss, and the block fails once every arm has missed.
 * Returns `[arms, options]` for `wf.parallel(...race([a, b, c], { id }))`. Refused at once:
 * `race-empty` (no arms).
 */
export function race<const TArms extends readonly object[]>(
  arms: TArms,
  options?: DecisionOptions,
): [arms: TArms, options: DecisionEntryOptions] {
  return mint('race', 1, arms, options);
}

/**
 * `quorum(k, arms, options?)` ([ADR 0014]): the block succeeds once `k` arms have succeeded and fails
 * once `n − k + 1` have not; then every unsettled arm is preempted and awaited, and each loser is
 * recorded `canceled`. Refused at once: `race-empty` (no arms), `quorum-value` (`k` not a whole number
 * in [1, n]), `blueprint-arms` (an arm listed twice, by object or by id).
 */
export function quorum<const TArms extends readonly object[]>(
  k: number,
  arms: TArms,
  options?: DecisionOptions,
): [arms: TArms, options: DecisionEntryOptions] {
  return mint('quorum', k, arms, options);
}

/**
 * Checks and mints one decision, and builds the `.parallel()` options carrying it. The checks run in
 * the adapter's order — `race-empty`, `quorum-value`, `blueprint-arms` — so a refusal names the same
 * reason at either point.
 */
function mint<const TArms extends readonly object[]>(
  factory: Decision['kind'],
  k: unknown,
  arms: TArms,
  options: DecisionOptions | undefined,
): [arms: TArms, options: DecisionEntryOptions] {
  const label = options?.id !== undefined ? `${factory}('${String(options.id)}')` : factory;
  if (!Array.isArray(arms)) {
    throw new TypeError(`${label}: blueprint-arms: the arms must be an array of steps, got ${typeof arms}`);
  }
  if (arms.length === 0) {
    throw new RangeError(`${label}: race-empty: a decision needs at least one arm; a .parallel() of none has nothing to decide`);
  }
  if (typeof k !== 'number' || !Number.isInteger(k) || k < 1 || k > arms.length) {
    throw new RangeError(
      `${label}: quorum-value: k must be a whole number in [1, ${arms.length}] (the arm count), got ${String(k)}`,
    );
  }
  const seenIds = new Set<unknown>();
  arms.forEach((arm, i) => {
    if (arm === null || (typeof arm !== 'object' && typeof arm !== 'function')) {
      throw new TypeError(`${label}: blueprint-arms: arm ${i} is not a step`);
    }
    if (arms.indexOf(arm) !== i) {
      throw new TypeError(`${label}: blueprint-arms: arm ${i} is the same step as arm ${arms.indexOf(arm)}; list each arm once`);
    }
    const id: unknown = (arm as { id?: unknown }).id;
    if (seenIds.has(id)) {
      throw new TypeError(
        `${label}: blueprint-arms: two arms have the id ${JSON.stringify(id)}; Mastra keys a block's results by ` +
          'step id, so the second would overwrite the first. Give one its own id with cloneStep().',
      );
    }
    seenIds.add(id);
  });
  const decision = Object.freeze(new Decision(mintedDecision, factory, k, Object.freeze([...arms])));
  // A fresh object: the author's metadata is never written to, and its keys (Layer 2 `concurrency`
  // among them) are kept. The symbol key is enumerable, so a spread of this metadata carries the
  // decision with it — and a copy on a second `.parallel()` is refused as `blueprint-reused` rather
  // than silently running as a plain block.
  const metadata = { ...(options?.metadata ?? {}), [BLOCK_DECISION]: decision } as DecisionEntryOptions['metadata'];
  const entryOptions: DecisionEntryOptions = {
    ...(options?.id !== undefined ? { id: options.id } : {}),
    ...(options?.description !== undefined ? { description: options.description } : {}),
    metadata,
  };
  return [arms, entryOptions];
}

/**
 * The decision a `.parallel()` entry's `metadata` carries under {@link BLOCK_DECISION}, or
 * `undefined` — every entry built without `race` / `quorum`. Anything under the key that is not a
 * minted {@link Decision} is the adapter's to refuse (`blueprint-arms`).
 */
export function decisionOf(metadata: unknown): unknown {
  if (metadata === null || typeof metadata !== 'object') return undefined;
  if (!Object.prototype.hasOwnProperty.call(metadata, BLOCK_DECISION)) return undefined;
  return (metadata as { [BLOCK_DECISION]?: unknown })[BLOCK_DECISION];
}

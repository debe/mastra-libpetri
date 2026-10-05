import type { EntryPath } from './names.js';
import { foreachSeed } from './resume-foreach.js';
import type {
  ArmResume,
  ArmSite,
  CompiledWorkflow,
  FailureToken,
  FlowToken,
  ForeachResume,
  ForeachSite,
  ResumeSite,
  SiblingVerdict,
  StepRecord,
  SuspendToken,
} from './types.js';

/** Where a resume continues, in the compiler's terms — decoded from Mastra's `resume` parameter. */
export interface ResumeRequest {
  /** Mastra's positional `resumePath` — `[top]` or `[top, arm]`. Never mutated. */
  readonly path: EntryPath;
  /** Mastra's `resume.steps`: the step ids from the outermost workflow inwards. */
  readonly steps: readonly string[];
  /** Mastra's `resume.forEachIndex`, when the resume targets one `.foreach()` item. */
  readonly forEachIndex?: number;
  /** The stored step records — Mastra's `snapshot.context` without `input`. */
  readonly records: ReadonlyMap<string, StepRecord>;
}

/** The single token a resumed segment starts from, and the site it goes to ([ADR 0007]). */
export interface ResumeSeed {
  readonly site: ResumeSite;
  readonly value: unknown;
}

/**
 * A resume this engine cannot place. `reason`:
 * - `no-site` — nothing resumable at that path;
 * - `id-mismatch` — the step stored at that path is not the one compiled there: the workflow
 *   changed between suspend and resume. Mastra resumes blindly; this engine refuses by name
 *   (`docs/divergences.md`);
 * - `foreach-nested` — a nested workflow inside a `.foreach()`, refused until a fixture exists;
 * - `pipeline` — a suspended `pipeline()` stage ([ADR 0015], maintainer decision 4): the pipeline
 *   ends `suspended` with the foreach's aggregate shape, but registers no resume site; resolved from
 *   `CompiledWorkflow.pipelines` (by the foreach's path, or the body's id) before `no-site` is said.
 *   Resumable at (item, stage) is wave 2;
 * - `unsupported` — a stored shape the design does not resume (e.g. a parallel arm with no record).
 */
export class UnresumablePositionError extends Error {
  override readonly name = 'UnresumablePositionError';
  constructor(
    readonly reason: 'no-site' | 'id-mismatch' | 'foreach-nested' | 'pipeline' | 'unsupported',
    readonly path: EntryPath,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The seed for a resumed segment: one token at the site Mastra's `resumePath` names ([ADR 0007]).
 * Pure — reads the compiled workflow and the stored records, decides nothing at run time, and
 * throws before anything runs or persists.
 *
 * - **Site.** `resumePath` joined with `.` names exactly one registered site; none is `no-site`.
 * - **Identity** (maintainer decision 2). `resume.steps[0]` is the id Mastra stored the suspension
 *   under; when it is not the step compiled at that site, the workflow changed between suspend and
 *   resume and this refuses with `id-mismatch`. Mastra resumes blindly (`docs/divergences.md`).
 * - **Entry.** `{data: record.payload, resumed: true}` — the resumed step's input is its STORED
 *   payload (`handlers/entry.ts:111-128,306-316`). A loop's `start` re-reads the body record itself
 *   (`handlers/control-flow.ts:727-735`), so its colour's data is carried but not read.
 * - **Arm.** The resumed arm's stored payload, plus one verdict per sibling from its record —
 *   Mastra rebuilds the block from records without re-running any sibling (`handlers/entry.ts:
 *   38-109,350-392,415-509`). See {@link siblingVerdict}.
 * - **Foreach.** Delegated to {@link foreachSeed}. A nested workflow as the body is refused as
 *   `foreach-nested`, by the site's `nested` flag or a multi-id `steps` list.
 */
export function resumeSeed(compiled: CompiledWorkflow, request: ResumeRequest): ResumeSeed {
  const { path } = request;
  const key = path.join('.');
  const site = path.length === 0 ? undefined : compiled.resumeSites.get(key);
  if (site === undefined) {
    const piped = pipelineRefusal(compiled, path, request.steps);
    if (piped !== undefined) throw piped;
    const top = path[0] === undefined ? undefined : compiled.netMap.pathToEntry.get(String(path[0]));
    const there = top === undefined ? 'no entry' : `the ${top.kind} '${top.entryId}'`;
    throw new UnresumablePositionError(
      'no-site',
      path,
      `nothing resumable at [${path.join(', ')}]: the workflow has ${there} at [${String(path[0] ?? '')}]`,
    );
  }

  const stepId = request.steps[0];
  if (stepId === undefined) {
    throw new UnresumablePositionError('unsupported', path, `a resume at [${path.join(', ')}] names no step`);
  }
  if (stepId !== site.stepId) {
    throw new UnresumablePositionError(
      'id-mismatch',
      path,
      `the step stored at [${path.join(', ')}] is '${stepId}', but the workflow now has ` +
        `'${site.stepId}' there: the workflow changed since the run suspended`,
    );
  }

  switch (site.kind) {
    case 'entry': {
      const value: FlowToken = { data: storedPayload(request, site.stepId), resumed: true };
      return { site, value };
    }
    case 'arm':
      return { site, value: armSeed(compiled, site, request) };
    case 'foreach':
      return { site, value: foreachValue(site, request) };
  }
}

/** The input a resumed step stored — Mastra's `getResumeStepPrevOutput` (`handlers/entry.ts:111-128`). */
function storedPayload(request: ResumeRequest, stepId: string): unknown {
  const record = request.records.get(stepId);
  if (record === undefined || !('payload' in record)) {
    throw new UnresumablePositionError(
      'unsupported',
      request.path,
      `no stored input for step '${stepId}' at [${request.path.join(', ')}]: its record is ` +
        (record === undefined ? 'missing' : `'${record.status}' with no payload`),
    );
  }
  return record.payload;
}

/**
 * Re-entry at one arm: its stored input and every sibling's verdict, in arm order. The siblings
 * are the other arm sites of the same block — every arm registers one, and a gap is a compiler
 * defect, not a stored shape, so it throws plainly.
 */
function armSeed(compiled: CompiledWorkflow, site: ArmSite, request: ResumeRequest): ArmResume {
  const [block, resumed] = site.path;
  const arms: ArmSite[] = [];
  for (const other of compiled.resumeSites.values()) {
    if (other.kind === 'arm' && other.path[0] === block) arms.push(other);
  }
  arms.sort((a, b) => a.path[1] - b.path[1]);
  arms.forEach((arm, i) => {
    if (arm.path[1] !== i || arm.block !== site.block) {
      throw new Error(`the arm sites of the block at [${block}] are not one ${site.block} with arms 0..n-1`);
    }
  });

  const data = storedPayload(request, site.stepId);
  const siblings = arms
    .filter((arm) => arm.path[1] !== resumed)
    .map((arm) => siblingVerdict(arm, request));
  return { data, siblings };
}

/**
 * A sibling arm's record, as the arrival a real collect would have produced for it:
 *
 * - `success` -> `ok`, with the stored output;
 * - `suspended` -> `suspended`, the suspension rebuilt at the arm's view path — Mastra re-lists
 *   every still-suspended arm (`handlers/entry.ts:83-107`);
 * - `failed` -> `failed` — only reachable through a stale record under a reused id (row 33);
 * - `bailed` or `paused` -> `settled`: the block swallows it and succeeds, where Mastra re-suspends
 *   with `{}` and no path (`handlers/entry.ts:44-96`; divergence);
 * - no record -> `skipped` for a `.branch()` arm, whose condition was not truthy (`onlyExecutedSteps`,
 *   `handlers/entry.ts:43-46`); for a `.parallel()` arm every sibling ran, so it is `unsupported`;
 * - `canceled` or `waiting` — written only by a loop, a foreach or a sleep, so a stale record under a
 *   reused id — `unsupported`.
 */
function siblingVerdict(arm: ArmSite, request: ResumeRequest): SiblingVerdict {
  const index = arm.path[1];
  const record = request.records.get(arm.stepId);
  const refuse = (why: string): never => {
    throw new UnresumablePositionError(
      'unsupported',
      request.path,
      `cannot resume the ${arm.block} arm at [${request.path.join(', ')}]: its sibling '${arm.stepId}' ` +
        `at [${arm.path.join(', ')}] ${why}`,
    );
  };
  if (record === undefined) {
    return arm.block === 'branch' ? { kind: 'skipped', index } : refuse('has no stored record');
  }
  const origin = { stepId: arm.stepId, path: arm.path };
  switch (record.status) {
    case 'success':
      return { kind: 'ok', index, output: record.output };
    case 'suspended': {
      const token: SuspendToken = {
        ...origin,
        payload: record.suspendPayload,
        ...(record.suspendedAt === undefined ? {} : { suspendedAt: record.suspendedAt }),
      };
      return { kind: 'suspended', index, token };
    }
    case 'failed': {
      const token: FailureToken = {
        ...origin,
        stepPayload: record.payload,
        error: record.error,
        ...(record.tripwire === undefined ? {} : { tripwire: record.tripwire }),
        ...(record.nonRetryable === true ? { nonRetryable: true as const } : {}),
      };
      return { kind: 'failed', index, token };
    }
    case 'bailed':
    case 'paused':
      return { kind: 'settled', index };
    case 'canceled':
    case 'waiting':
      return refuse(`has a stored '${record.status}' record, which no step writes`);
  }
}

/**
 * A `.foreach()` re-entry, delegated to {@link foreachSeed}. A nested workflow as the body is
 * refused as `foreach-nested` whatever `resume.steps` holds: `resume.steps` runs from the outermost
 * workflow inwards, so a second id names a step inside the body (`workflow.ts:4610-4660`), and
 * Mastra also accepts a single-id list for a nested body (`workflow.ts:4613-4618,4661-4665`) and
 * then resumes the child named by the aggregate, not the item (`docs/divergences.md` row 77).
 */
function foreachValue(site: ForeachSite, request: ResumeRequest): ForeachResume {
  if (site.nested === true || request.steps.length > 1) {
    throw new UnresumablePositionError(
      'foreach-nested',
      request.path,
      `resume inside the nested workflow '${site.stepId}' run by the .foreach() at ` +
        `[${request.path.join(', ')}] is not supported`,
    );
  }
  const aggregate = request.records.get(site.stepId);
  if (aggregate === undefined) {
    throw new UnresumablePositionError(
      'unsupported',
      request.path,
      `no stored record for the .foreach() step '${site.stepId}' at [${request.path.join(', ')}]`,
    );
  }
  return foreachSeed(site, aggregate, request.records, request.forEachIndex);
}

/**
 * The `pipeline` refusal ([ADR 0015], maintainer decision 4), or `undefined`: a resume that names a
 * `pipeline()` — its top-level path (`[i]`, or anything under it), or its body's id as the stored step
 * (`steps[0]`, the key Mastra keeps the aggregate and its suspension under). A suspended stage ends
 * the pipeline `suspended` with the foreach's aggregate shape, but no resume site is registered, so
 * this is said instead of `no-site`, before anything runs or persists. Resumable at (item, stage) is
 * wave 2.
 *
 * Exported for `mastra/engine.ts`, which asks the same question when the stored position cannot even
 * be decoded.
 */
export function pipelineRefusal(
  compiled: CompiledWorkflow,
  path: EntryPath,
  steps: readonly string[],
): UnresumablePositionError | undefined {
  const stepId = steps[0];
  const site = compiled.pipelines.find(
    (p) => (path.length > 0 && path[0] === p.path[0]) || (stepId !== undefined && stepId === p.bodyId),
  );
  if (site === undefined) return undefined;
  return new UnresumablePositionError(
    'pipeline',
    path,
    `the run suspended inside the pipeline '${site.bodyId}' at [${site.path.join(', ')}] (stages ` +
      `${site.stages.map((s) => `'${s}'`).join(', ')}); a suspended pipeline stage cannot be resumed yet`,
  );
}

import type { EntryPath } from './names.js';
import type { CompiledWorkflow, ResumeSite, StepRecord } from './types.js';

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
 * - `unsupported` — a stored shape the design does not resume (e.g. a parallel arm with no record).
 */
export class UnresumablePositionError extends Error {
  override readonly name = 'UnresumablePositionError';
  constructor(
    readonly reason: 'no-site' | 'id-mismatch' | 'foreach-nested' | 'unsupported',
    readonly path: EntryPath,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The seed for a resumed segment: one token at the site Mastra's `resumePath` names. Pure — reads
 * the compiled workflow and the stored records, decides nothing at run time.
 *
 * CONTRACT STUB (ADR 0007): implemented by the compiler-core area.
 */
export function resumeSeed(_compiled: CompiledWorkflow, _request: ResumeRequest): ResumeSeed {
  throw new Error('resumeSeed: not implemented yet (M4, ADR 0007)');
}

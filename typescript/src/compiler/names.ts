/**
 * The single naming vocabulary. Every place and transition name in a compiled net comes from
 * here, so the scheme can be read in one file rather than inferred from its uses.
 *
 * **Why names matter more than they look.** libpetri place identity is the name string
 * ([CORE-010]) — two same-named places merge silently under `compose()`. A compiler that
 * instantiates one subnet per step is exactly the workload that collides, so uniqueness is
 * asserted rather than assumed (see {@link NameVocabulary.assertUnique}).
 *
 * **`/` is reserved** as libpetri's instantiate-prefix separator ([MOD-013]), so it never
 * appears in a name minted here; `.` separates our own segments and `-` joins path indices.
 *
 * Names also surface to users through counterexample traces, so they are chosen to read as a
 * process rather than as plumbing.
 */

/** A positional path into the entry array — Mastra's own `executionPath` ([types.ts:1268]). */
export type EntryPath = readonly number[];

/** Renders a path as a name segment: `[0]` -> `0`, `[1, 2]` -> `1-2`. */
export function pathSegment(path: EntryPath): string {
  if (path.length === 0) throw new Error('entry path must not be empty');
  return path.join('-');
}

/**
 * Makes a user-supplied step id safe as a name segment. Step ids are arbitrary user strings,
 * so `/` (reserved) and whitespace are replaced. The positional path already guarantees
 * uniqueness, so this only has to be readable, not injective.
 */
export function slug(stepId: string): string {
  const cleaned = stepId.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned : 'step';
}

/**
 * Workflow-level terminals, one per way a run can end. Every one is declared as a sink, or a run
 * that ends there reads as stranded.
 */
export const WF_DONE = 'wf.done';
export const WF_FAILED = 'wf.failed';
/** `bail(result)` — reported as a success, kept apart so a proof about completion stays one. */
export const WF_BAILED = 'wf.bailed';
export const WF_SUSPENDED = 'wf.suspended';
export const WF_PAUSED = 'wf.paused';
export const WF_CANCELED = 'wf.canceled';
/**
 * The cancellation signal, an environment place. Not a terminal: it stays marked once injected,
 * and the terminal a canceled run reaches is `wf.canceled`.
 */
export const WF_CANCEL = 'wf.cancel';
/** Where a cancellation arrives: the environment place at runtime, seeded for verification. */
export const WF_CANCEL_REQUEST = 'wf.cancel.request';
/** The transition that moves an arrived cancellation to the signal. */
export const T_CANCEL_ARRIVE = 't.cancel.arrive';

export class NameVocabulary {
  readonly #seen = new Map<string, string>();

  /** The place a step's input token waits in. */
  entryIn(path: EntryPath, stepId: string): string {
    return this.#mint(`s.${pathSegment(path)}.${slug(stepId)}.in`, `input of entry ${pathSegment(path)}`);
  }

  /** The transition that runs a step. */
  entryRun(path: EntryPath, stepId: string): string {
    return this.#mint(`t.${pathSegment(path)}.${slug(stepId)}.run`, `run of entry ${pathSegment(path)}`);
  }

  /** The transition that elapses a `.sleep` / `.sleepUntil` entry. */
  entryWake(path: EntryPath, stepId: string): string {
    return this.#mint(`t.${pathSegment(path)}.${slug(stepId)}.wake`, `wake of entry ${pathSegment(path)}`);
  }

  /** A place internal to a composite gadget (fork/join scratch, budgets, markers). */
  entryPlace(path: EntryPath, stepId: string, role: string): string {
    return this.#mint(
      `s.${pathSegment(path)}.${slug(stepId)}.${role}`,
      `${role} of entry ${pathSegment(path)}`,
    );
  }

  /** A transition internal to a composite gadget (fork, join, retry, drain). */
  entryTransition(path: EntryPath, stepId: string, role: string): string {
    return this.#mint(
      `t.${pathSegment(path)}.${slug(stepId)}.${role}`,
      `${role} of entry ${pathSegment(path)}`,
    );
  }

  /**
   * A top-level place a run's outcome settles in before it becomes a terminal — where Mastra's
   * after-entry abort check is modelled (`handlers/entry.ts:815-817`).
   */
  settlePlace(outcome: string): string {
    return this.#mint(`wf.settle.${outcome}`, `settle place for ${outcome}`);
  }

  /** The transitions that move a settled outcome to its terminal, or to `wf.canceled`. */
  settleTransition(outcome: string, canceled: boolean): string {
    return this.#mint(
      `t.settle.${outcome}${canceled ? '.canceled' : ''}`,
      `${canceled ? 'cancel-' : ''}settle of ${outcome}`,
    );
  }

  /**
   * Registers a name minted elsewhere (the workflow terminals) so the uniqueness check covers
   * the whole net rather than only the generated part.
   */
  reserve(name: string, owner: string): string {
    return this.#mint(name, owner);
  }

  #mint(name: string, owner: string): string {
    const existing = this.#seen.get(name);
    if (existing !== undefined) {
      throw new Error(
        `name collision: '${name}' is claimed by both ${existing} and ${owner}. ` +
          'libpetri place identity is the name string, so a collision merges two places ' +
          'silently instead of failing.',
      );
    }
    this.#seen.set(name, owner);
    return name;
  }

  /** Every name minted, for the compile-cache structural hash and for diagnostics. */
  names(): readonly string[] {
    return [...this.#seen.keys()].sort();
  }
}

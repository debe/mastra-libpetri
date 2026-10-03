import * as libpetri from 'libpetri';
import { SmtVerifier } from 'libpetri/verification';
/**
 * Fails loudly when the installed libpetri predates the surface this engine calls.
 *
 * This repository is the first consumer of an unreleased libpetri surface: `TIME-015`
 * (injectable clock), the `MOD-031` place-alias fix and `NU-011` (resume-safe minting) are
 * committed but unreleased, and `CORE-073` / `ENV-014` (marking snapshot and restore) is
 * implemented but not yet committed. Until 6.1.0 publishes, `scripts/link-libpetri.sh`
 * symlinks a sibling checkout.
 *
 * The check exists because every alternative is worse than a hard failure. A missing clock
 * does not throw — the executor silently reads the machine clock, and a run that was supposed
 * to be deterministic simply is not. A missing verifier method does not throw either; it
 * produces a report that closes with every proof quietly absent.
 */

/** Root-module exports the engine calls. */
const REQUIRED_ROOT_EXPORTS = ['systemClock', 'seedToken'] as const;

/** Executor instance methods the kernel calls beyond the `PetriNetExecutor` interface. */
const REQUIRED_EXECUTOR_METHODS = ['injectNoAwait', 'snapshot', 'getMarking', 'isQuiescent'] as const;

/** `Marking` statics and instance methods the codec calls ([CORE-073]). */
const REQUIRED_MARKING_STATICS = ['fromSnapshot'] as const;
const REQUIRED_MARKING_METHODS = ['snapshot'] as const;

/** Verifier builder methods `verify()` calls ([VER-014] and the bound/phase levers). */
const REQUIRED_VERIFIER_METHODS = [
  'sinkPlacesWhen',
  'budgetPlaces',
  'semiflowInvariants',
  'stateEquation',
  'enumerationMaxClasses',
] as const;

export interface SurfaceProbe {
  readonly rootExports: Readonly<Record<string, unknown>>;
  readonly executorPrototype: object | undefined;
  readonly markingConstructor: (Function & Record<string, unknown>) | undefined;
  readonly verifierPrototype: object | undefined;
}

export class LibpetriSurfaceError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(
      `The installed libpetri is missing ${missing.length} member(s) this engine calls: ` +
        `${missing.join(', ')}. ` +
        'mastra-libpetri needs libpetri >= 6.1.0 (TIME-015 injectable clock, the MOD-031 ' +
        'place-alias fix, NU-011 resume-safe minting) plus the CORE-073 snapshot surface. ' +
        'Until 6.1.0 publishes, run scripts/link-libpetri.sh to link a sibling checkout.',
    );
    this.name = 'LibpetriSurfaceError';
  }
}

function has(target: unknown, name: string): boolean {
  if (target === undefined || target === null) return false;
  return typeof (target as Record<string, unknown>)[name] === 'function';
}

/**
 * Returns every required member the probe could not find, most structural first. Empty means
 * the surface is present. Kept separate from the throwing wrapper so tests can assert the
 * list rather than a message.
 */
export function missingSurfaceMembers(probe: SurfaceProbe): readonly string[] {
  const missing: string[] = [];

  for (const name of REQUIRED_ROOT_EXPORTS) {
    if (typeof probe.rootExports[name] !== 'function') missing.push(`libpetri#${name}`);
  }
  for (const name of REQUIRED_EXECUTOR_METHODS) {
    if (!has(probe.executorPrototype, name)) missing.push(`PrecompiledNetExecutor#${name}`);
  }
  for (const name of REQUIRED_MARKING_STATICS) {
    if (!has(probe.markingConstructor, name)) missing.push(`Marking.${name}`);
  }
  for (const name of REQUIRED_MARKING_METHODS) {
    if (!has(probe.markingConstructor?.prototype, name)) missing.push(`Marking#${name}`);
  }
  for (const name of REQUIRED_VERIFIER_METHODS) {
    if (!has(probe.verifierPrototype, name)) missing.push(`SmtVerifier#${name}`);
  }

  return missing;
}

/** Throws {@link LibpetriSurfaceError} when any required member is absent. */
export function assertLibpetriSurface(probe: SurfaceProbe = installedSurface()): void {
  const missing = missingSurfaceMembers(probe);
  if (missing.length > 0) throw new LibpetriSurfaceError(missing);
}

/** Probes the libpetri actually installed — what `verify` checks at entry. */
export function installedSurface(): SurfaceProbe {
  return {
    rootExports: libpetri as unknown as Record<string, unknown>,
    executorPrototype: libpetri.PrecompiledNetExecutor.prototype as unknown as object,
    markingConstructor: libpetri.Marking as unknown as Function & Record<string, unknown>,
    verifierPrototype: SmtVerifier.prototype as unknown as object,
  };
}

import { PrecompiledNetExecutor, Marking } from 'libpetri';
import * as libpetri from 'libpetri';
import { SmtVerifier } from 'libpetri/verification';
import type { SurfaceProbe } from '../../src/internal/libpetri-surface.js';

/** Probes the libpetri actually installed, so the gate tests a real tree, not a stub. */
export function probeInstalledLibpetri(): SurfaceProbe {
  return {
    rootExports: libpetri as unknown as Record<string, unknown>,
    executorPrototype: PrecompiledNetExecutor.prototype as unknown as object,
    markingConstructor: Marking as unknown as Function & Record<string, unknown>,
    verifierPrototype: SmtVerifier.prototype as unknown as object,
  };
}

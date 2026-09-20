import { describe, expect, it } from 'vitest';
import { missingSurfaceMembers, assertLibpetriSurface } from '../../src/internal/libpetri-surface.js';
import { probeInstalledLibpetri } from '../support/surface.js';

/**
 * The gate. A missing clock does not throw at runtime — the executor silently reads the
 * machine clock — so nothing else in this suite would notice a downgraded install.
 */
describe('installed libpetri surface', () => {
  it('carries every member this engine calls', () => {
    expect(missingSurfaceMembers(probeInstalledLibpetri())).toEqual([]);
  });

  it('names what is missing rather than failing opaquely', () => {
    const missing = missingSurfaceMembers({
      rootExports: {},
      executorPrototype: undefined,
      markingConstructor: undefined,
      verifierPrototype: undefined,
    });
    expect(missing).toContain('libpetri#systemClock');
    expect(missing).toContain('PrecompiledNetExecutor#injectNoAwait');
    expect(missing).toContain('Marking.fromSnapshot');
    expect(() => assertLibpetriSurface({
      rootExports: {},
      executorPrototype: undefined,
      markingConstructor: undefined,
      verifierPrototype: undefined,
    })).toThrow(/scripts\/link-libpetri\.sh/);
  });
});

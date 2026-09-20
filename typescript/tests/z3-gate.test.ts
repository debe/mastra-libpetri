import { describe, expect, it } from 'vitest';
import { z3Available } from 'libpetri/verification';

/**
 * Fails the build when no solver resolves, so proofs cannot quietly become skips. Without
 * this, every verification suite degrades to `unknown` and still reports green — which is
 * exactly the failure the "say proven, or say untested" rule exists to prevent.
 *
 * Set `LIBPETRI_Z3` to the solver path if it is not on `PATH`.
 */
describe('z3 gate', () => {
  it('resolves a solver', () => {
    expect(z3Available()).toBe(true);
  });
});

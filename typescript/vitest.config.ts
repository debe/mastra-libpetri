import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globals: true,
    // Fail fast: no test waits longer than a minute. A proof query is capped at 30 s by the verifier's
    // total budget; a test past 60 s is a net to redesign or a question for the libpetri sessions,
    // never a timeout to raise.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    benchmark: {
      include: ['tests/**/*.bench.ts'],
    },
  },
});

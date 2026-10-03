import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/mastra/index.ts',
    'src/compiler/index.ts',
    'src/verify/index.ts',
    'src/codec/index.ts',
    'src/conformance/index.ts',
    'src/cli.ts',
  ],
  format: ['esm'],
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  // `@mastra/core` is a peer: every subpath (`@mastra/core/workflows`, `/evented`, …) stays external.
  external: ['libpetri', '@mastra/core', /^@mastra\/core\//],
});

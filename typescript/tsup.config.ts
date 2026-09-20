import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/compiler/index.ts',
    'src/verify/index.ts',
    'src/codec/index.ts',
    'src/conformance/index.ts',
  ],
  format: ['esm'],
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  external: ['libpetri', '@mastra/core'],
});

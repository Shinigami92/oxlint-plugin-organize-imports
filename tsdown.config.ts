import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  dts: true,
  clean: true,
  minify: false,
  sourcemap: false,
  fixedExtension: false,
  publint: true,
  target: ['es2023', 'node24'],
  // `typescript` is a peer dependency loaded at runtime from the consumer's install:
  // the whole point of the plugin is to drive *their* language service, not a copy of ours.
  deps: { neverBundle: ['typescript'] },
});

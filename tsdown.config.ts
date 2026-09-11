import { defineConfig } from 'tsdown';

export default defineConfig({
  // The worker is a second entry, not an import: `sync-lsp-client.ts` starts it by path as a
  // sibling `dist/lsp-worker.js`. It imports only Node built-ins, so it bundles to one file.
  entry: ['src/index.ts', 'src/lsp-worker.ts'],
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

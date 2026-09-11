import { defineConfig } from 'vitest/config';

// Every CI provider sets `CI`; the annotated reporter is only ever useful there. This
// replaced a bespoke `CI_PREFLIGHT` variable that nothing in the repo ever set, so the
// annotations never actually appeared.
const CI = Boolean(process.env.CI);

// https://vitejs.dev/config/
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    // `organize-imports.spec.ts` spawns the real `oxlint` binary against a temporary project
    // for every case; the in-process specs take milliseconds and never come near this.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['clover', 'cobertura', 'json-summary', 'json', 'lcov', 'text'],
      // The sources, and only the sources — the point of the number is to measure `src`.
      // It only means anything because the in-process specs run `src` in this process; the
      // CLI suite loads `dist/index.js` in a child process, where v8 coverage cannot see it.
      include: ['src'],
      // The worker half of the LSP bridge runs in a worker thread, where the main thread's
      // coverage collector cannot see it. Its framing parser is exercised in-process, and the
      // rest is covered behaviourally by the sync-client and LSP-backend specs.
      exclude: ['src/lsp-worker.ts'],
      reportOnFailure: true,
      // Set below the current numbers, not at them, so ordinary work does not trip the
      // build; the point is to catch a collapse like the 3 % this replaced. The branches
      // that stay uncovered are defensive: an unreadable tsconfig, a host callback the
      // language service never invokes under `noResolve`.
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 95,
        lines: 95,
      },
    },
    reporters: CI ? ['default', 'github-actions'] : [['default', { summary: false }]],
  },
});

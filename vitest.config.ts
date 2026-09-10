import { defineConfig } from 'vitest/config';

const CI_PREFLIGHT = Boolean(process.env.CI_PREFLIGHT);

// https://vitejs.dev/config/
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    // Every test spawns the real `oxlint` binary against a temporary project.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['clover', 'cobertura', 'json-summary', 'json', 'lcov', 'text'],
      include: ['src'],
      reportOnFailure: true,
    },
    reporters: CI_PREFLIGHT ? ['default', 'github-actions'] : [['default', { summary: false }]],
  },
});

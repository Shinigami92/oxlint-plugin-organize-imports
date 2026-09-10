import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    // Each test spawns the oxlint binary against a fresh temp project.
    testTimeout: 30_000,
  },
});

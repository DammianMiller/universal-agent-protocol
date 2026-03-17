import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/benchmarks/performance.test.ts'],
    exclude: ['**/.worktrees/**', 'node_modules/**', 'benchmark-results/**'],
    watch: false,
    testTimeout: 60000,
  },
});

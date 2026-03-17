import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'benchmark-env/src/**/*.test.ts'],
    exclude: ['**/.worktrees/**', 'test/benchmarks/**', 'node_modules/**', 'benchmark-results/**'],
    watch: false,
    coverage: {
      provider: 'v8',
      all: false,
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts', 'src/uap_harbor/**', 'benchmark-results/**'],
      thresholds: {
        statements: 30,
        branches: 25,
        functions: 25,
        lines: 30,
      },
    },
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'benchmark-env/src/**/*.test.ts'],
    exclude: ['**/.worktrees/**', 'test/benchmarks/**', 'node_modules/**', 'benchmark-results/**'],
    watch: false,
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts', 'src/uap_harbor/**', 'benchmark-results/**'],
      thresholds: {
        statements: 70,
        branches: 65,
        functions: 65,
        lines: 70,
      },
    },
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['**/.worktrees/**', 'test/benchmarks/**', 'node_modules/**', 'benchmark-results/**'],
    watch: false,
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/index.ts',
        'src/uap_harbor/**',
        'benchmark-results/**',
        // Exclude experimental/unstable features from coverage
        'src/policies/**/*.ts',
        'src/telemetry/**/*.ts',
        'src/generators/**/*.ts',
      ],
      thresholds: {
        statements: 50,
        branches: 50,
        functions: 50,
        lines: 50,
      },
    },
  },
});

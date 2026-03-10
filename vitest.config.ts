import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'test/**/*.test.ts',
      'benchmark-env/src/**/*.test.ts',
    ],
    exclude: ['**/.worktrees/**', 'test/benchmarks/**', 'node_modules/**'],
    watch: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/index.ts',
        'src/uap_harbor/**',
      ],
      thresholds: {
        statements: 30,
        branches: 25,
        functions: 25,
        lines: 30,
      },
    },
  },
});

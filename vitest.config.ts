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
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests must never contend with live delivery infrastructure
    // (model-slot lease backpressure) — see test/setup-env.ts.
    setupFiles: ['test/setup-env.ts'],
    // The default 5s per-test timeout is too tight for this suite's I/O-heavy
    // tests (real `uap init` filesystem writes, cold dynamic imports of the
    // embeddings/DB stack) when 280+ files run in parallel and saturate the
    // CPU — they pass in isolation but intermittently time out under full-suite
    // load, flaking the version-bump gate. 15s is generous headroom for
    // contention while still failing a genuinely hung test.
    testTimeout: 15000,
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

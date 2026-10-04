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
    // Same disease one level up (2026-10-04): with ~32 tinypool workers on a
    // 32-core box that is ALSO running the live strata inference stack, the
    // worker RPC (onTaskUpdate) times out and kills a whole FILE — observed
    // as "5705 tests passing, 1 file failed" on eight consecutive
    // version-bump runs. Cap the worker count: CI boxes rarely have more
    // cores than this, so nothing changes there, while the dev box's
    // thundering herd halves. minWorkers must be set too — vitest defaults
    // it to the full CPU count and a default-min above an explicit max
    // is a hard RangeError, not a clamp.
    minWorkers: 4,
    maxWorkers: 16,
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

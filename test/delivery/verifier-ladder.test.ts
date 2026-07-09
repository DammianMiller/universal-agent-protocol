import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  detectRungs,
  runLadder,
  runRung,
  formatFeedback,
  type GateRung,
  type RungResult,
} from '../../src/delivery/verifier-ladder.js';

function rung(id: string, command: string, args: string[], required = true): GateRung {
  return { id, name: id, command, args, required, timeoutMs: 30_000 };
}

describe('verifier-ladder', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-ladder-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('detectRungs', () => {
    it('detects build/test/lint from package.json scripts', () => {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ scripts: { build: 'tsc', test: 'vitest run', lint: 'eslint .' } })
      );

      const rungs = detectRungs(dir);
      expect(rungs.map((r) => r.id)).toEqual(['build', 'test', 'lint']);
      expect(rungs.find((r) => r.id === 'lint')?.required).toBe(false);
      expect(rungs.find((r) => r.id === 'build')?.required).toBe(true);
    });

    it('only adds typecheck when a local tsc binary exists (no npx registry fetch)', () => {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
      writeFileSync(join(dir, 'tsconfig.json'), '{}');
      // No node_modules/.bin/tsc → no typecheck rung
      expect(detectRungs(dir).map((r) => r.id)).toEqual(['test']);
    });

    it('returns no rungs when package.json is missing or unparseable', () => {
      expect(detectRungs(dir)).toEqual([]);
      writeFileSync(join(dir, 'package.json'), 'not json');
      expect(detectRungs(dir)).toEqual([]);
    });

    it('adds cargo rungs for a Rust project (Cargo.toml)', () => {
      writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "x"\n');
      const rungs = detectRungs(dir);
      expect(rungs.map((r) => r.id)).toEqual(['cargo-check', 'cargo-test']);
      expect(rungs.find((r) => r.id === 'cargo-check')?.required).toBe(true);
      // A pre-existing red test in a big workspace must not wedge every phase.
      expect(rungs.find((r) => r.id === 'cargo-test')?.required).toBe(false);
    });

    it('adds cargo rungs ALONGSIDE npm rungs in a polyglot root, npm first', () => {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ scripts: { build: 'vite build' } })
      );
      writeFileSync(join(dir, 'Cargo.toml'), '[workspace]\nmembers = ["crates/*"]\n');
      const ids = detectRungs(dir).map((r) => r.id);
      expect(ids).toEqual(['build', 'cargo-check', 'cargo-test']);
    });

    it('gives cargo rungs a 15-minute timeout floor for cold workspace builds', () => {
      writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "x"\n');
      const rungs = detectRungs(dir, 30_000);
      expect(rungs.find((r) => r.id === 'cargo-check')?.timeoutMs).toBe(900_000);
    });

    it('pytest integration rung: exit 5 passes, --no-cov added only with pytest-cov', () => {
      writeFileSync(
        join(dir, 'pyproject.toml'),
        '[tool.pytest.ini_options]\nmarkers = ["integration: integration test"]\naddopts = ["--cov=."]\n'
      );
      const rung = detectRungs(dir).find((r) => r.id === 'pytest:integration');
      expect(rung?.passExitCodes).toEqual([0, 5]);
      expect(rung?.args).toContain('--no-cov');

      // Without --cov in the config, --no-cov must NOT be passed (pytest-cov
      // may be absent and an unknown flag hard-fails the run).
      writeFileSync(
        join(dir, 'pyproject.toml'),
        '[tool.pytest.ini_options]\nmarkers = ["integration: integration test"]\n'
      );
      expect(
        detectRungs(dir)
          .find((r) => r.id === 'pytest:integration')
          ?.args.includes('--no-cov')
      ).toBe(false);
    });
  });

  describe('runRung passExitCodes', () => {
    it('treats a listed non-zero exit as a pass, default stays 0-only', () => {
      const exit5: GateRung = {
        ...rung('vacuous', 'bash', ['-c', 'exit 5']),
        passExitCodes: [0, 5],
      };
      expect(runRung(exit5, dir).passed).toBe(true);
      expect(runRung(rung('plain', 'bash', ['-c', 'exit 5']), dir).passed).toBe(false);
    });
  });

  describe('runRung', () => {
    it('reports a spawn-error reason with diagnostic when the binary is missing', () => {
      const result = runRung(rung('ghost', 'definitely-not-a-real-binary-xyz', []), dir);
      expect(result.passed).toBe(false);
      expect(result.failureReason).toBe('spawn-error');
      expect(result.outputTail).toContain('Gate could not run');
    });

    it('reports a timeout reason with the configured duration', () => {
      const slow: GateRung = {
        id: 'slow',
        name: 'slow',
        command: 'node',
        args: ['-e', 'setTimeout(() => {}, 60000)'],
        required: true,
        timeoutMs: 500,
      };
      const result = runRung(slow, dir);
      expect(result.passed).toBe(false);
      expect(result.failureReason).toBe('timeout');
      expect(result.outputTail).toContain('timed out after 500ms');
    });

    it('strips secret-bearing env vars from gate commands', () => {
      process.env.UAP_TEST_FAKE_API_KEY = 'sk-secret';
      try {
        const probe = rung('env', 'node', [
          '-e',
          'process.exit(process.env.UAP_TEST_FAKE_API_KEY ? 1 : 0)',
        ]);
        const result = runRung(probe, dir);
        expect(result.passed).toBe(true);
      } finally {
        delete process.env.UAP_TEST_FAKE_API_KEY;
      }
    });
  });

  describe('runLadder', () => {
    it('passes with score 1 when every rung exits 0', () => {
      const result = runLadder(
        [rung('a', 'node', ['-e', '']), rung('b', 'node', ['-e', ''])],
        dir
      );
      expect(result.passed).toBe(true);
      expect(result.score).toBe(1);
      expect(result.results.every((r) => r.passed)).toBe(true);
    });

    it('fail-fast skips later rungs after a required failure and scores partially', () => {
      const result = runLadder(
        [
          rung('ok', 'node', ['-e', '']),
          rung('bad', 'node', ['-e', 'process.exit(1)']),
          rung('after', 'node', ['-e', '']),
        ],
        dir
      );
      expect(result.passed).toBe(false);
      expect(result.score).toBeCloseTo(1 / 3);
      expect(result.results[1].passed).toBe(false);
      expect(result.results[2].skipped).toBe(true);
      expect(result.feedback).toContain('SKIPPED');
    });

    it('optional rung failure neither stops the ladder nor blocks passing', () => {
      const result = runLadder(
        [rung('lint', 'node', ['-e', 'process.exit(1)'], false), rung('test', 'node', ['-e', ''])],
        dir
      );
      // All required rungs pass → delivered, even though optional lint failed
      expect(result.passed).toBe(true);
      expect(result.results[1].skipped).toBe(false);
      expect(result.score).toBeCloseTo(1 / 2);
      expect(result.feedback).toContain('(optional)');
    });

    it('includes truncated failing output in feedback', () => {
      const result = runLadder(
        [rung('fail', 'node', ['-e', 'console.error("boom: missing semicolon"); process.exit(1)'])],
        dir,
        { outputTailChars: 200 }
      );
      expect(result.passed).toBe(false);
      expect(result.feedback).toContain('boom: missing semicolon');
      expect(result.feedback).toContain('Fix this gate first');
    });
  });

  describe('formatFeedback', () => {
    it('details the first failing required rung, not optional failures', () => {
      const rungs = [rung('lint', 'x', [], false), rung('test', 'x', [])];
      const results: RungResult[] = [
        { id: 'lint', name: 'lint', passed: false, skipped: false, exitCode: 1, durationMs: 1, outputTail: 'lint noise' },
        { id: 'test', name: 'test', passed: false, skipped: false, exitCode: 1, durationMs: 1, outputTail: 'real failure' },
      ];
      const feedback = formatFeedback(results, rungs);
      expect(feedback).toContain('real failure');
      expect(feedback).not.toContain('lint noise');
    });
  });
});

import { describe, it, expect } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeWorkdir } from '../../src/benchmarks/paired/suite.js';
import { rawMaxTokens } from '../../src/benchmarks/paired/adapter.js';

/**
 * A benchmark suite is only a measuring instrument if its tasks are actually
 * solvable and actually unsolved by the starting state. A task whose verifyCmd
 * can never pass pins that cell at the floor forever, which shows up as a
 * confident-looking zero delta — the exact failure the discrimination verdict
 * was added to catch, but better prevented at the source.
 *
 * So every task ships with a reference `solution/` and this test asserts, for
 * each one:
 *
 *   reference solution  -> gate AND verify PASS   (the task is achievable)
 *   untouched stub      -> verify FAILS           (the task is not free)
 *
 * That makes a broken task a red test rather than a silently dead cell.
 */
const SUITE = join(__dirname, '..', '..', 'benchmarks', 'suites', 'real-gate-power');

interface TaskSpec {
  name: string;
  gateCmd: string;
  verifyCmd: string;
  verifyTimeoutSec: number;
}

function run(cmd: string, cwd: string, timeoutSec: number): number {
  const r = spawnSync('bash', ['-lc', cmd], { cwd, encoding: 'utf-8', timeout: timeoutSec * 1000 });
  return r.status ?? 1;
}

function stage(taskDir: string, withSolution: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'suite-validity-'));
  cpSync(join(taskDir, 'repo'), dir, { recursive: true });
  if (withSolution) cpSync(join(taskDir, 'solution'), dir, { recursive: true });
  return dir;
}

const taskIds = existsSync(SUITE)
  ? readdirSync(SUITE).filter((d) => existsSync(join(SUITE, d, 'task.json')))
  : [];

describe('real-gate-power suite validity', () => {
  it('the suite exists and is large enough to resolve a modest effect', () => {
    // Power: with the variance observed on real-gate-brutal (sd ~0.63), a CI
    // half-width of +/-0.15 needs ~68 paired cells. 15 tasks x 6 epochs = 90.
    expect(taskIds.length).toBeGreaterThanOrEqual(15);
  });

  it('allows enough wall-clock to actually spend the completion budget', () => {
    // The adapter uses agentTimeoutSec as the HTTP timeout, so a task deadline
    // shorter than the completion budget takes to generate does not shorten the
    // model's thinking — it just converts a truncated answer into a timed-out
    // one, and the run reports an error instead of a short answer.
    //
    // Measured on this host: ~70 tok/s single-stream, so 8192 tokens is ~118s
    // with NOTHING to spare against a 120s deadline, and per-stream throughput
    // drops further once the bench runs cells concurrently. Budget against a
    // deliberately pessimistic rate.
    const PESSIMISTIC_TOKENS_PER_SEC = 20;
    const needed = rawMaxTokens() / PESSIMISTIC_TOKENS_PER_SEC;
    for (const id of taskIds) {
      const spec = JSON.parse(readFileSync(join(SUITE, id, 'task.json'), 'utf-8')) as TaskSpec & {
        agentTimeoutSec: number;
      };
      expect(spec.agentTimeoutSec, `${id} deadline too short for the completion budget`).toBeGreaterThanOrEqual(
        needed
      );
    }
  });

  it('never stages solution/ into the agent workdir', () => {
    // The reference solutions live beside repo/, and materializeWorkdir copies
    // only <task>/<repoDir>. If that ever widened to the whole task dir, every
    // arm would score 100% and the suite would look like a perfect ceiling
    // rather than a leak. Pin it.
    const id = taskIds[0];
    const spec = JSON.parse(readFileSync(join(SUITE, id, 'task.json'), 'utf-8')) as TaskSpec & {
      id: string;
      repoDir: string;
    };
    const root = mkdtempSync(join(tmpdir(), 'suite-stage-'));
    try {
      const wd = materializeWorkdir(SUITE, { ...spec, id, repoDir: spec.repoDir ?? 'repo' } as never, root);
      expect(existsSync(join(wd, 'solution'))).toBe(false);
      expect(readdirSync(wd).length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const id of taskIds) {
    const dir = join(SUITE, id);
    const spec = JSON.parse(readFileSync(join(dir, 'task.json'), 'utf-8')) as TaskSpec;

    it(`${id}: the reference solution passes gate and verify`, () => {
      const w = stage(dir, true);
      try {
        expect(run(spec.gateCmd, w, spec.verifyTimeoutSec)).toBe(0);
        expect(run(spec.verifyCmd, w, spec.verifyTimeoutSec)).toBe(0);
      } finally {
        rmSync(w, { recursive: true, force: true });
      }
    });

    it(`${id}: the untouched stub does NOT pass verify`, () => {
      const w = stage(dir, false);
      try {
        expect(run(spec.verifyCmd, w, spec.verifyTimeoutSec)).not.toBe(0);
      } finally {
        rmSync(w, { recursive: true, force: true });
      }
    });
  }
});

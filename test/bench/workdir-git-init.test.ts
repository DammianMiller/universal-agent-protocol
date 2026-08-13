import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { materializeWorkdir } from '../../src/benchmarks/paired/suite.js';
import { DeliverCliAdapter } from '../../src/benchmarks/paired/adapter.js';
import { makeFullCondition } from '../../src/benchmarks/paired/types.js';
import type { AgentRunContext, TaskSpec } from '../../src/benchmarks/paired/types.js';

/**
 * deliver's project-preflight refuses a non-git workdir, so every
 * deliver-adapter cell exited in ~1s with preflightFailed and the whole
 * matrix scored 0% in both arms (paired-uplift-v1204-r2, 2026-08-13). The
 * workdir must therefore materialize as a real repo with a baseline commit,
 * and a preflight refusal that does slip through must be attributed as
 * "agent did not run", never as a model failure.
 */

const task: TaskSpec = {
  id: 'gt',
  dir: '/nonexistent',
  name: 'gt',
  instruction: 'x',
  difficulty: 'easy',
  tags: [],
  repoDir: 'repo',
  verifyCmd: 'true',
  verifyTimeoutSec: 5,
  agentTimeoutSec: 5,
};

describe('materializeWorkdir git baseline', () => {
  let suiteDir: string;
  let workRoot: string;

  beforeEach(() => {
    suiteDir = mkdtempSync(join(tmpdir(), 'uap-suite-'));
    workRoot = mkdtempSync(join(tmpdir(), 'uap-workroot-'));
    mkdirSync(join(suiteDir, 'gt', 'repo'), { recursive: true });
    writeFileSync(join(suiteDir, 'gt', 'repo', 'main.js'), 'module.exports = 1;\n');
  });
  afterEach(() => {
    rmSync(suiteDir, { recursive: true, force: true });
    rmSync(workRoot, { recursive: true, force: true });
  });

  it('produces a git repository with a clean baseline commit', () => {
    const dest = materializeWorkdir(suiteDir, task, workRoot);
    expect(existsSync(join(dest, '.git'))).toBe(true);
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: dest, encoding: 'utf-8' });
    expect(status.status).toBe(0);
    expect(status.stdout.trim()).toBe(''); // everything committed at baseline
    const log = spawnSync('git', ['log', '--oneline'], { cwd: dest, encoding: 'utf-8' });
    expect(log.stdout).toMatch(/baseline/);
  });
});

describe('DeliverCliAdapter preflight attribution', () => {
  let workdir: string;
  let cliDir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'uap-bench-workdir-'));
    cliDir = mkdtempSync(join(process.cwd(), '.vitest-fake-cli-'));
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
    rmSync(cliDir, { recursive: true, force: true });
  });

  it('reports a preflight refusal as agent-did-not-run, not a model failure', async () => {
    const fake = join(cliDir, 'fake-preflight.js');
    writeFileSync(
      fake,
      'console.log(JSON.stringify({ success: false, preflightFailed: true, blockers: ["not a git repository"] })); process.exit(1);'
    );
    const adapter = new DeliverCliAdapter(relative(process.cwd(), fake));
    const result = await adapter.run({
      task,
      condition: makeFullCondition(),
      workdir,
      model: 'test-model',
      seed: 0,
    } as unknown as AgentRunContext);
    expect(result.error).toMatch(/preflight refused/);
  });
});

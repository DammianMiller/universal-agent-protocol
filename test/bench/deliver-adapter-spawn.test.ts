import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DeliverCliAdapter } from '../../src/benchmarks/paired/adapter.js';
import { makeFullCondition } from '../../src/benchmarks/paired/types.js';
import type { AgentRunContext, TaskSpec } from '../../src/benchmarks/paired/types.js';

/**
 * The deliver adapter spawns the CLI with cwd = the task WORKDIR. A relative
 * cliPath resolved there is MODULE_NOT_FOUND in ~200ms — and the old error
 * handling reported that as error:null, so a whole 5-epoch matrix scored 0%
 * in BOTH arms as if the model had tried and failed (paired-uplift-v1204,
 * 2026-08-13; only the suite-level no-signal guard flagged it). These tests
 * pin: (1) relative paths resolve against the INVOKING cwd, not the workdir;
 * (2) a spawn that never ran the agent is attributed as such; (3) deliver's
 * legitimate non-zero exit on a not-delivered mission is NOT an error.
 */

const task: TaskSpec = {
  id: 't1',
  dir: '/nonexistent',
  name: 't1',
  instruction: 'do the thing',
  difficulty: 'easy',
  tags: [],
  verifyCmd: 'true',
  verifyTimeoutSec: 5,
  agentTimeoutSec: 5,
};

describe('DeliverCliAdapter spawn resolution and attribution', () => {
  let workdir: string;
  let cliDir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'uap-bench-workdir-'));
    // A fake CLI that lives relative to the INVOKING cwd (process.cwd()),
    // exactly like dist/bin/cli.js does when the bench runs from the repo root.
    cliDir = mkdtempSync(join(process.cwd(), '.vitest-fake-cli-'));
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
    rmSync(cliDir, { recursive: true, force: true });
  });

  const ctx = (cliPath: string): { adapter: DeliverCliAdapter; runCtx: AgentRunContext } => ({
    adapter: new DeliverCliAdapter(cliPath),
    runCtx: {
      task,
      condition: makeFullCondition(),
      workdir,
      model: 'test-model',
      seed: 0,
    } as unknown as AgentRunContext,
  });

  it('resolves a relative cliPath against the invoking cwd, not the task workdir', async () => {
    const fake = join(cliDir, 'fake-cli.js');
    writeFileSync(fake, 'console.log(JSON.stringify({ success: true, delivered: true, turns: 2 }));');
    const relPath = relative(process.cwd(), fake);
    const { adapter, runCtx } = ctx(relPath);
    const result = await adapter.run(runCtx);
    expect(result.error).toBeNull();
    expect(result.turns).toBe(2);
  });

  it('attributes a spawn that never ran the agent instead of error:null', async () => {
    const { adapter, runCtx } = ctx(join(cliDir, 'does-not-exist.js'));
    const result = await adapter.run(runCtx);
    expect(result.error).toMatch(/agent did not run/);
  });

  it('treats deliver\'s non-zero exit WITH a JSON verdict as a result, not an error', async () => {
    const fake = join(cliDir, 'fake-cli-fail.js');
    writeFileSync(
      fake,
      'console.log(JSON.stringify({ success: false, delivered: false, turns: 3 })); process.exit(1);'
    );
    const { adapter, runCtx } = ctx(join(cliDir, 'fake-cli-fail.js'));
    const result = await adapter.run(runCtx);
    expect(result.error).toBeNull();
    expect(result.turns).toBe(3);
  });
});

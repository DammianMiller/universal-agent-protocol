import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DeliverCliAdapter } from '../../src/benchmarks/paired/adapter.js';
import { makeFullCondition } from '../../src/benchmarks/paired/types.js';
import type { AgentRunContext, TaskSpec } from '../../src/benchmarks/paired/types.js';

/**
 * The bench must measure COMPLETED missions. deliver detaches after a 45s
 * watch window by default and exits with a stillRunning JSON whose
 * "success": true refers to the LAUNCH — scored as a verdict, that made every
 * cell exactly ~45.9s and left a fleet of detached missions grinding scratch
 * dirs the runner had deleted (paired-uplift-v1204-r3, 2026-08-13). The
 * adapter therefore (1) forces foreground via UAP_DELIVER_NO_DETACH=1 and
 * (2) refuses a stillRunning verdict outright.
 */

const task: TaskSpec = {
  id: 'fg',
  dir: '/nonexistent',
  name: 'fg',
  instruction: 'x',
  difficulty: 'easy',
  tags: [],
  repoDir: 'repo',
  verifyCmd: 'true',
  verifyTimeoutSec: 5,
  agentTimeoutSec: 5,
};

describe('DeliverCliAdapter foreground contract', () => {
  let workdir: string;
  let cliDir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'uap-bench-fg-'));
    cliDir = mkdtempSync(join(process.cwd(), '.vitest-fake-cli-'));
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
    rmSync(cliDir, { recursive: true, force: true });
  });

  const run = async (cliBasename: string, script: string) => {
    const fake = join(cliDir, cliBasename);
    writeFileSync(fake, script);
    const adapter = new DeliverCliAdapter(relative(process.cwd(), fake));
    return adapter.run({
      task,
      condition: makeFullCondition(),
      workdir,
      model: 'test-model',
      seed: 0,
    } as unknown as AgentRunContext);
  };

  it('passes UAP_DELIVER_NO_DETACH=1 to the spawned CLI', async () => {
    const result = await run(
      'env-echo.js',
      'console.log(JSON.stringify({ success: true, delivered: true, turns: 1, noDetach: process.env.UAP_DELIVER_NO_DETACH }));'
    );
    expect(result.error).toBeNull();
    expect(result.rawLog).toMatch(/"noDetach":"1"/);
  });

  it('refuses a stillRunning detach handoff as not-a-result', async () => {
    const result = await run(
      'detach-echo.js',
      'console.log(JSON.stringify({ success: true, stillRunning: true, detached: true }));'
    );
    expect(result.error).toMatch(/detached instead of running foreground/);
  });
});

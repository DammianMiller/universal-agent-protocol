import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DeliverCliAdapter } from '../../src/benchmarks/paired/adapter.js';
import { benchTelemetryDir } from '../../src/telemetry/tool-calls.js';
import { makeFullCondition } from '../../src/benchmarks/paired/types.js';
import type { AgentRunContext, TaskSpec } from '../../src/benchmarks/paired/types.js';

/**
 * Wave 6, item 1 — bench attribution. The 2026-11-25 power run's 478 corpus
 * rows landed as unattributed 'live' traffic and its convergence records died
 * with the throwaway cells, so neither instrument could see the 90 missions
 * the run drove. The adapter now stamps every cell subprocess with the envs
 * the corpus and the ladder mirror read. These tests pin that the stamping
 * actually crosses the spawn boundary (a fake CLI echoes its env back).
 */

const task: TaskSpec = {
  id: 'gate-task',
  dir: '/nonexistent',
  name: 'gate-task',
  instruction: 'do the thing',
  difficulty: 'easy',
  tags: [],
  verifyCmd: 'true',
  verifyTimeoutSec: 5,
  agentTimeoutSec: 5,
};

describe('DeliverCliAdapter bench attribution envs', () => {
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

  it('stamps run kind, cell coordinates, and the convergence mirror env', async () => {
    const fake = join(cliDir, 'echo-env.js');
    writeFileSync(
      fake,
      'console.log(JSON.stringify({ success: true, delivered: true, turns: 1,' +
        ' env: {' +
        " runKind: process.env.UAP_RUN_KIND," +
        " runId: process.env.UAP_BENCH_RUN_ID," +
        " task: process.env.UAP_BENCH_TASK," +
        " condition: process.env.UAP_BENCH_CONDITION," +
        " seed: process.env.UAP_BENCH_SEED," +
        " mirror: process.env.UAP_QUALITY_LOG_MIRROR } }));",
    );
    const adapter = new DeliverCliAdapter(fake);
    const result = await adapter.run({
      task,
      condition: makeFullCondition(),
      workdir,
      model: 'test-model',
      seed: 2,
    } as unknown as AgentRunContext);
    expect(result.error).toBeNull();

    // The fake CLI's own JSON is captured in rawLog; parse the env block back.
    const m = /(\{[\s\S]*"success"[\s\S]*\})\s*$/.exec(result.rawLog ?? '');
    expect(m).not.toBeNull();
    const echoed = JSON.parse(m![1]).env as Record<string, string>;
    expect(echoed.runKind).toBe('benchmark');
    expect(echoed.task).toBe('gate-task');
    expect(echoed.condition).toBe(makeFullCondition().label);
    expect(echoed.seed).toBe('2');
    expect(echoed.runId).toBe('gate-task/uap-full#2');
    // The mirror lands under whatever the corpus root resolves to in this
    // process (the vitest setup pins it to a per-pid temp dir).
    expect(echoed.mirror).toBe(benchTelemetryDir());
  });
});

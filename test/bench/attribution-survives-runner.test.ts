/**
 * The runner boundary is where attribution used to be lost.
 *
 * `executeCell` builds a `MetricVector` from the adapter result and returns a
 * `RunRecord`. Everything not named in that vector was dropped — so the
 * aggregate survived into the report and the explanation did not.
 *
 * These tests drive the real `runPaired` with a stub adapter, because the bug
 * was never in the adapter (which computed the data) nor in the report (which
 * would happily print it) — it was in the hand-off between them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPaired } from '../../src/benchmarks/paired/runner.js';
import { makeFullCondition } from '../../src/benchmarks/paired/types.js';
import type {
  AgentAdapter,
  AgentRunContext,
  AgentRunResult,
  RunnerConfig,
  TaskSpec,
} from '../../src/benchmarks/paired/types.js';

/** An adapter that reports whatever attribution the test wants. */
class StubAdapter implements AgentAdapter {
  readonly id = 'stub';
  constructor(private readonly extra: Partial<AgentRunResult> = {}) {}
  async run(_ctx: AgentRunContext): Promise<AgentRunResult> {
    return {
      tokens: 10,
      costUsd: null,
      turns: 2,
      toolCalls: 0,
      wellFormed: null,
      error: null,
      ...this.extra,
    };
  }
}

const TASK: TaskSpec = {
  id: 't',
  name: 't',
  instruction: 'do it',
  repoDir: 'repo',
  gateCmd: 'exit 0',
  verifyCmd: 'exit 0',
  verifyTimeoutSec: 5,
  agentTimeoutSec: 5,
} as TaskSpec;

describe('attribution survives the runner boundary', () => {
  let dir: string;
  let workRoot: string;
  beforeEach(() => {
    // materializeWorkdir copies <suiteDir>/<task.id>/<task.repoDir> into a
    // scratch repo, so the fixture has to exist or every cell short-circuits on
    // "materialize failed" and never reaches the adapter at all.
    dir = mkdtempSync(join(tmpdir(), 'uap-attrib-runner-'));
    mkdirSync(join(dir, 't', 'repo'), { recursive: true });
    writeFileSync(join(dir, 't', 'repo', 'a.js'), 'x');
    workRoot = mkdtempSync(join(tmpdir(), 'uap-attrib-work-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(workRoot, { recursive: true, force: true });
  });

  const cfg = (adapter: AgentAdapter): RunnerConfig =>
    ({
      adapter,
      model: 'm',
      tasks: [TASK],
      epochs: 1,
      conditions: [makeFullCondition()],
      concurrency: 1,
      workRoot,
    }) as unknown as RunnerConfig;

  it('carries turnTrace and stopReason into the record', async () => {
    const out = await runPaired(
      cfg(
        new StubAdapter({
          turnTrace: [
            { turn: 1, files: 2, gateOk: false },
            { turn: 2, files: 1, gateOk: true },
          ],
          stopReason: 'solved',
        })
      ),
      dir,
      new Date(0).toISOString()
    );

    const rec = out.records[0];
    expect(rec.attribution?.stopReason).toBe('solved');
    expect(rec.attribution?.turnTrace).toHaveLength(2);
    expect(rec.attribution?.turnTrace?.[1]).toMatchObject({ turn: 2, files: 1, gateOk: true });
  });

  it('omits the key entirely for an adapter that cannot observe turns', async () => {
    // Subprocess adapters only ever learn an aggregate turn count from the
    // agent they spawn. Writing `attribution: {}` on every one of those records
    // would read as "the loop reported no turns" when the truth is "not
    // observable here" — absence has to stay distinguishable from emptiness.
    const out = await runPaired(cfg(new StubAdapter()), dir, new Date(0).toISOString());

    const rec = out.records[0];
    expect(rec.attribution).toBeUndefined();
    expect('attribution' in rec).toBe(false);
  });

  it('leaves the metric vector untouched', async () => {
    // Attribution is a SIBLING of metrics, never a member: MetricVector is the
    // zod-validated numeric vector CONTINUOUS_METRICS drives the paired-delta
    // analysis from, and a trace array is neither continuous nor differenceable.
    const out = await runPaired(
      cfg(new StubAdapter({ turnTrace: [{ turn: 1, files: 0, gateOk: null }], stopReason: 'budget' })),
      dir,
      new Date(0).toISOString()
    );

    const m = out.records[0].metrics as Record<string, unknown>;
    expect('turnTrace' in m).toBe(false);
    expect('stopReason' in m).toBe(false);
    expect(m.turns).toBe(2);
  });
});

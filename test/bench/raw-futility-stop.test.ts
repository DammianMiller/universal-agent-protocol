import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawCompletionAdapter } from '../../src/benchmarks/paired/adapter.js';
import { makeFullCondition } from '../../src/benchmarks/paired/types.js';
import type { TaskSpec } from '../../src/benchmarks/paired/types.js';

/**
 * Drive the adapter against a scripted sequence of completions so the gate loop
 * is exercised without a model.
 */
function mockCompletions(bodies: string[]): void {
  let i = 0;
  vi.spyOn(global, 'fetch').mockImplementation(async () => {
    const content = bodies[Math.min(i, bodies.length - 1)];
    i++;
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content } }],
        usage: { total_tokens: 100 },
      }),
    } as unknown as Response;
  });
}

/** A file block in the adapter's marker format. */
function fileBlock(path: string, body: string): string {
  // The BENCH adapter has its own marker format, distinct from the applier's
  // ```file: fence — see parseFileBlocks in paired/adapter.ts.
  return `<<<FILE ${path}>>>\n${body}\n<<<END>>>`;
}

describe('raw adapter futility stops', () => {
  let dir: string;
  let task: TaskSpec;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-futility-'));
    mkdirSync(join(dir, 'repo'), { recursive: true });
    writeFileSync(join(dir, 'repo', 'a.js'), 'broken');
    task = {
      id: 't',
      name: 't',
      instruction: 'fix it',
      // Always fails, so the loop runs to whatever stop fires first.
      gateCmd: 'exit 1',
      verifyCmd: 'exit 1',
      verifyTimeoutSec: 5,
      agentTimeoutSec: 5,
    } as TaskSpec;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (adapter: RawCompletionAdapter) =>
    adapter.run({
      task,
      condition: makeFullCondition(),
      workdir: join(dir, 'repo'),
      seed: 0,
      model: 'm',
    });

  it('KEEPS RETRYING after a turn that wrote no files', async () => {
    // Regression guard for a wrong "optimisation". Cutting here looked provable
    // — unchanged workdir, deterministic gate, identical next gate result — but
    // the next turn re-prompts the MODEL, and re-prompting is exactly how a turn
    // that emitted no parseable blocks recovers. Measured on real-gate-brutal:
    // 27 of 30 first turns emit zero blocks; stopping took correctness 30% -> 7%.
    mockCompletions(['I think the code looks fine already.']);
    const r = await run(new RawCompletionAdapter({ maxGateIters: 4 }));
    expect(r.turns).toBe(4);
    expect(r.stopReason).toBe('budget');
  });

  it('is OFF by default — an unvalidated stop does not ship on', async () => {
    mockCompletions([fileBlock('a.js', 'v1'), fileBlock('a.js', 'v2')]);
    const r = await run(new RawCompletionAdapter({ maxGateIters: 4 }));
    expect(r.stopReason).toBe('budget');
    expect(r.turns).toBe(4);
  });

  it('stops on a repeated gate when explicitly enabled, so it can be A/B-d', async () => {
    mockCompletions([fileBlock('a.js', 'v1'), fileBlock('a.js', 'v2')]);
    const r = await run(new RawCompletionAdapter({ maxGateIters: 4, stopOnNoProgress: true }));
    expect(r.stopReason).toBe('no-progress');
    expect(r.turns).toBe(2);
  });

  it('never cuts a turn that solves the task', async () => {
    task = { ...task, gateCmd: 'test -f SOLVED' } as TaskSpec;
    mockCompletions([fileBlock('SOLVED', 'ok')]);
    const r = await run(new RawCompletionAdapter({ maxGateIters: 4 }));
    expect(r.stopReason).toBe('solved');
    expect(r.turns).toBe(1);
  });

  it('records a per-turn trace so wasted work is attributable', async () => {
    mockCompletions([fileBlock('a.js', 'v1'), 'no files this time']);
    const r = await run(new RawCompletionAdapter({ maxGateIters: 2 }));
    expect(r.turnTrace).toEqual([
      { turn: 1, files: 1, gateOk: false },
      { turn: 2, files: 0, gateOk: false },
    ]);
  });

  it('reports budget exhaustion distinctly from a futility stop', async () => {
    // The gate output must actually CHANGE each turn, or no-progress fires —
    // correctly. Counting files makes it move as each turn adds one, so the
    // loop legitimately spends its budget without either futility rule firing.
    task = { ...task, gateCmd: 'ls | wc -l; exit 1' } as TaskSpec;
    mockCompletions([
      fileBlock('a.js', 'v1'),
      fileBlock('b.js', 'v2'),
      fileBlock('c.js', 'v3'),
      fileBlock('d.js', 'v4'),
    ]);
    const r = await run(new RawCompletionAdapter({ maxGateIters: 4 }));
    expect(r.stopReason).toBe('budget');
    expect(r.turns).toBe(4);
  });

  it('the opt-in stop does cut turns when it is enabled', async () => {
    mockCompletions([fileBlock('a.js', 'v1'), fileBlock('a.js', 'v2'), fileBlock('a.js', 'v3')]);
    const withStop = await run(new RawCompletionAdapter({ maxGateIters: 4, stopOnNoProgress: true }));
    vi.restoreAllMocks();
    mockCompletions([fileBlock('a.js', 'v1'), fileBlock('a.js', 'v2'), fileBlock('a.js', 'v3')]);
    const without = await run(new RawCompletionAdapter({ maxGateIters: 4 }));
    expect(withStop.turns).toBe(2);
    expect(without.turns).toBe(4);
    expect((withStop.tokens ?? 0) < (without.tokens ?? 0)).toBe(true);
  });
});

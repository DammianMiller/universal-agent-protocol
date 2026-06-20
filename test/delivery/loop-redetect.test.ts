import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConvergenceLoop } from '../../src/delivery/convergence-loop.js';
import type { GateRung, LadderResult } from '../../src/delivery/verifier-ladder.js';

/** A stand-in for the t0 self-gate fallback (not produced by detectRungs). */
function selfGateRung(): GateRung {
  return { id: 'self-gate', name: 'self-gate', command: 'node', args: ['-e', ''], required: true, timeoutMs: 1000 };
}
function ladderResult(score: number, passed: boolean): LadderResult {
  return {
    passed,
    score,
    feedback: passed ? '' : 'keep going',
    results: [{ id: 'x', name: 'x', passed, skipped: false, exitCode: passed ? 0 : 1, durationMs: 1, outputTail: '' }],
  };
}
// The executor writes an index.html via a file block, turning the empty dir into
// a detectable web artifact after turn 1.
const WRITE_INDEX = '```file:index.html\n<canvas id="c"></canvas><script src="js/g.js"></script>\n```';

describe('ConvergenceLoop — redetectRungs', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-redetect-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('engages the execution gate once the model writes an index.html (from-scratch web build)', async () => {
    const seen: string[][] = [];
    let runs = 0;
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 3, rungs: [selfGateRung()], baselineCheck: false, redetectRungs: true },
      async () => WRITE_INDEX,
      {
        ladderRunner: (rungs) => {
          seen.push(rungs.map((r) => r.id));
          runs++;
          return ladderResult(runs >= 2 ? 1.0 : 0.5, runs >= 2); // pass on turn 2
        },
      }
    );
    const result = await loop.deliver('build a web page');
    expect(result.success).toBe(true);
    // Turn 1: index.html not written at detect time → only the self-gate.
    expect(seen[0]).toEqual(['self-gate']);
    // Turn 2: index.html now exists → execution gate merged in.
    expect(seen[1]).toContain('execution');
    expect(seen[1]).toContain('self-gate'); // existing rung preserved (union by id)
  });

  it('does NOT re-detect when redetectRungs is off (unchanged default behavior)', async () => {
    const seen: string[][] = [];
    let runs = 0;
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 3, rungs: [selfGateRung()], baselineCheck: false },
      async () => WRITE_INDEX,
      {
        ladderRunner: (rungs) => {
          seen.push(rungs.map((r) => r.id));
          runs++;
          return ladderResult(runs >= 2 ? 1.0 : 0.5, runs >= 2);
        },
      }
    );
    await loop.deliver('build a web page');
    // Never picks up the execution gate — rung set stays the t0 fallback.
    expect(seen.every((ids) => !ids.includes('execution'))).toBe(true);
  });

  it('default policy merges runtime/fast gates but NOT integration tier (no silent escalation)', async () => {
    // A pre-existing integration suite would be detected, but the default
    // re-detect policy (fast+runtime only) must not pull it into the loop.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { 'test:integration': 'true' } }));
    const seen: string[][] = [];
    let runs = 0;
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 3, rungs: [selfGateRung()], baselineCheck: false, redetectRungs: true },
      async () => WRITE_INDEX,
      {
        ladderRunner: (rungs) => {
          seen.push(rungs.map((r) => r.id));
          runs++;
          return ladderResult(runs >= 2 ? 1.0 : 0.5, runs >= 2);
        },
      }
    );
    await loop.deliver('x');
    expect(seen[1]).toContain('execution'); // runtime gate merged
    expect(seen[1].some((id) => id.includes('integration'))).toBe(false); // integration NOT escalated
  });

  it('honors an explicit redetectFilter (caller can permit higher tiers)', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { 'test:integration': 'true' } }));
    const seen: string[][] = [];
    let runs = 0;
    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        maxTurns: 3,
        rungs: [selfGateRung()],
        baselineCheck: false,
        redetectRungs: true,
        redetectFilter: () => true, // permit everything detected
      },
      async () => WRITE_INDEX,
      {
        ladderRunner: (rungs) => {
          seen.push(rungs.map((r) => r.id));
          runs++;
          return ladderResult(runs >= 2 ? 1.0 : 0.5, runs >= 2);
        },
      }
    );
    await loop.deliver('x');
    expect(seen[1].some((id) => id.includes('integration'))).toBe(true); // filter let it through
  });

  it('does not duplicate a rung that is already present', async () => {
    const seen: string[][] = [];
    let runs = 0;
    const execRung: GateRung = { id: 'execution', name: 'pre-existing exec', command: 'node', args: ['-e', ''], required: true, timeoutMs: 1000, tier: 'runtime' };
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 2, rungs: [execRung], baselineCheck: false, redetectRungs: true },
      async () => WRITE_INDEX,
      {
        ladderRunner: (rungs) => {
          seen.push(rungs.map((r) => r.id));
          runs++;
          return ladderResult(runs >= 2 ? 1.0 : 0.5, runs >= 2);
        },
      }
    );
    await loop.deliver('x');
    // 'execution' appears exactly once even after re-detection would add it.
    expect(seen[1].filter((id) => id === 'execution')).toHaveLength(1);
  });
});

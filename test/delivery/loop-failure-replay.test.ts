import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConvergenceLoop } from '../../src/delivery/convergence-loop.js';
import type { GateRung, LadderResult } from '../../src/delivery/verifier-ladder.js';

/**
 * Offline replay of the live delivery failure (run 20261006T042017,
 * rust-pg-ext M1 bench), driving the REAL ConvergenceLoop + REAL applier with
 * a scripted executor and ladder. No model, no network.
 *
 * The live run failed three ways at once, each now covered:
 *  A. wrong-file blindness (U1) — 12 rounds editing src/bin/m1-bench.rs while
 *     every gate dump named src/bench.rs:21.
 *  B. gate-repair routing (U3) — the acceptance gate could not PARSE the
 *     report it was grading while the work rungs were green.
 *  C. prescribed-replay (U2) — covered in prescribed-replay.test.ts.
 */

function stubRungs(): GateRung[] {
  return [{ id: 'build', name: 'build', command: 'node', args: ['-e', ''], required: true, timeoutMs: 1000 }];
}

function ladderResult(score: number, passed: boolean, results: LadderResult['results']): LadderResult {
  return { passed, score, feedback: 'gate feedback', results };
}

describe('offline replay: the rust-pg-ext wrong-file failure (U1)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-replay-loop-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'bench.rs'), 'fn bench() {}\n');
    writeFileSync(join(dir, 'src', 'm1-bench.rs'), 'fn m1() {}\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('narrows the writable set after stagnation and refuses the wrong-file edit', async () => {
    const prompts: string[] = [];
    let ladderRuns = 0;

    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        maxTurns: 4,
        rungs: stubRungs(),
        baselineCheck: false,
      },
      // The wrong-file executor: every turn rewrites src/m1-bench.rs while the
      // gate names src/bench.rs — exactly the live behavior.
      async (prompt: string) => {
        prompts.push(prompt);
        return '```file:src/m1-bench.rs\nfn m1() { /* another wrong-file rewrite */ }\n```';
      },
      {
        ladderRunner: () => {
          ladderRuns++;
          return ladderResult(0.3, false, [
            {
              id: 'build',
              name: 'build',
              passed: false,
              skipped: false,
              exitCode: 101,
              durationMs: 4000,
              outputTail:
                'error[E0432]: unresolved import `CandidateSlot`\n  --> src/bench.rs:21:5\n   |\n21 | use crate::pipeline_stages::CandidateSlot;\nerror[E0382]: use of moved value\n  --> src/bench.rs:408:26',
            },
          ]);
        },
      }
    );

    const result = await loop.deliver('Fix the M1 bench so cargo build passes');
    const appliedPerTurn = result.history.map((h) => h.filesApplied);

    // Turns 1-2 (free attempts): the wrong-file write applies.
    expect(appliedPerTurn[0]).toContain('src/m1-bench.rs');
    // From the stagnation-narrowed turn on, the applier refuses the wrong file.
    const narrowed = appliedPerTurn.findIndex((f) => !f.includes('src/m1-bench.rs'));
    expect(narrowed).toBeGreaterThanOrEqual(2); // after STAGNATION_NARROW_AFTER(=2)
    // The prompt that follows the first wrong-file turn names the failing files.
    expect(prompts.some((p) => p.includes('src/bench.rs'))).toBe(true);
    // The gate's named file still holds its ORIGINAL content — no accidental
    // steering-driven clobber.
    expect(readFileSync(join(dir, 'src', 'bench.rs'), 'utf-8')).toBe('fn bench() {}\n');
    expect(ladderRuns).toBeGreaterThan(2);
  }, 30_000);

  it('the narrowed-turn prompt carries the WRONG-FILE banner and the write restriction', async () => {
    const prompts: string[] = [];
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 5, rungs: stubRungs(), baselineCheck: false },
      async (prompt: string) => {
        prompts.push(prompt);
        return '```file:src/m1-bench.rs\nfn m1() { /* still wrong */ }\n```';
      },
      {
        ladderRunner: () =>
          ladderResult(0.3, false, [
            {
              id: 'build',
              name: 'build',
              passed: false,
              skipped: false,
              exitCode: 101,
              durationMs: 1000,
              outputTail: 'error[E0432]: unresolved import\n  --> src/bench.rs:21:5',
            },
          ]),
      }
    );
    await loop.deliver('Fix the M1 bench so cargo build passes');
    // The banner and the restriction both appear once stagnation sets in.
    expect(prompts.some((p) => p.includes('YOU EDITED THE WRONG FILE'))).toBe(true);
    expect(prompts.some((p) => p.includes('ONLY THESE FILES MAY BE EDITED'))).toBe(true);
    expect(prompts.some((p) => p.includes('src/bench.rs'))).toBe(true);
  }, 30_000);
});

describe('offline replay: the extraction-miss acceptance gate (U3)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-replay-gate-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'main.rs'), 'fn main() {}\n');
    writeFileSync(join(dir, 'src', 'main.js'), "console.log('p50 binary 0.987ms text 9.930ms');\n");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('routes the next turn to repairing the gate script, through the protected segment', async () => {
    const prompts: string[] = [];
    let ladderRuns = 0;
    let repaired = false;

    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 3, rungs: stubRungs(), baselineCheck: false },
      async (prompt: string) => {
        prompts.push(prompt);
        if (prompt.includes('ACCEPTANCE GATE REPAIR')) {
          repaired = true;
          // The sanctioned repair write into the protected segment. The
          // repaired gate must EXECUTE the artifact — a repaired script that
          // no longer runs the code it grades is reverted by the post-repair
          // sanity check.
          return '```file:.uap-deliver/verify.sh\n#!/bin/bash\nnode src/main.js\nexit $?\n```';
        }
        return '```file:src/main.rs\nfn main() { /* real work turn 1 */ }\n```';
      },
      {
        ladderRunner: () => {
          ladderRuns++;
          const gateNowSane = existsSync(join(dir, '.uap-deliver', 'verify.sh'));
          const results = [
            {
              id: 'build',
              name: 'build',
              passed: true,
              skipped: false,
              exitCode: 0,
              durationMs: 500,
              outputTail: '',
            },
            {
              id: 'acceptance',
              name: 'acceptance',
              passed: gateNowSane,
              skipped: false,
              exitCode: gateNowSane ? 0 : 1,
              durationMs: 900,
              outputTail: gateNowSane
                ? ''
                // The live wording: the gate cannot PARSE the report the
                // green artifact demonstrably prints.
                : 'GATE 4 FAIL: p50 tick time not reported by m1-bench (text 9.930ms, binary 0.987ms)',
            },
          ];
          return ladderResult(gateNowSane ? 1.0 : 0.9, gateNowSane, results);
        },
      }
    );

    const result = await loop.deliver('Ship the M1 bench with the acceptance gate');

    // Turn 1: work rungs green, acceptance blocked by an extraction bug.
    // Turn 2: gate-repair turn — restricted write to the gate script accepted
    // through the protected segment, ladder goes green.
    expect(repaired).toBe(true);
    expect(result.success).toBe(true);
    expect(existsSync(join(dir, '.uap-deliver', 'verify.sh'))).toBe(true);
    expect(readFileSync(join(dir, '.uap-deliver', 'verify.sh'), 'utf-8')).toContain('node src/main.js');
    expect(ladderRuns).toBe(2);
  }, 30_000);

  it('reverts a pass whose repaired gate is vacuous (exit 0 — review X2/arch F2)', async () => {
    let repaired = false;
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 3, rungs: stubRungs(), baselineCheck: false },
      async (prompt: string) => {
        if (prompt.includes('ACCEPTANCE GATE REPAIR')) {
          repaired = true;
          return '```file:.uap-deliver/verify.sh\nexit 0\n```';
        }
        return '```file:src/main.rs\nfn main() { /* work */ }\n```';
      },
      {
        ladderRunner: () => {
          ladderRuns++;
          const gateRepaired = existsSync(join(dir, '.uap-deliver', 'verify.sh'));
          const results = [
            { id: 'build', name: 'build', passed: true, skipped: false, exitCode: 0, durationMs: 100, outputTail: '' },
            {
              id: 'acceptance',
              name: 'acceptance',
              passed: gateRepaired, // rigged green after the vacuous repair
              skipped: false,
              exitCode: gateRepaired ? 0 : 1,
              durationMs: 100,
              outputTail: gateRepaired ? '' : 'p50 tick time not reported by m1-bench',
            },
          ];
          return ladderResult(gateRepaired ? 1.0 : 0.9, gateRepaired, results);
        },
      }
    );
    let ladderRuns = 0;
    const result = await loop.deliver('Ship the M1 bench with the acceptance gate');
    expect(repaired).toBe(true);
    // The rigged pass is REVERTED: an exit-0 gate cannot discriminate.
    expect(result.success).toBe(false);
    expect(result.finalFeedback).toContain('GATE REPAIR REJECTED');
  }, 30_000);

  it('one gate-repair turn per run — a second extraction miss is ordinary failure', async () => {
    const repairPrompts: string[] = [];
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 4, rungs: stubRungs(), baselineCheck: false },
      async (prompt: string) => {
        if (prompt.includes('ACCEPTANCE GATE REPAIR')) repairPrompts.push(prompt);
        if (prompt.includes('ACCEPTANCE GATE REPAIR')) {
          return '```file:.uap-deliver/verify.sh\n#!/bin/bash\nnode src/main.js\nexit 3\n```';
        }
        return '```file:src/main.rs\nfn main() {}\n```';
      },
      {
        // Permanently broken gate: the repair lands but keeps missing.
        ladderRunner: () =>
          ladderResult(0.9, false, [
            { id: 'build', name: 'build', passed: true, skipped: false, exitCode: 0, durationMs: 100, outputTail: '' },
            {
              id: 'acceptance',
              name: 'acceptance',
              passed: false,
              skipped: false,
              exitCode: 1,
              durationMs: 100,
              outputTail: 'p50 tick time not reported by m1-bench',
            },
          ]),
      }
    );
    const result = await loop.deliver('Ship the M1 bench');
    expect(result.success).toBe(false);
    // The repair route fired exactly once, not every turn.
    expect(repairPrompts.length).toBe(1);
  }, 30_000);

  it('stagnation narrowing drops protected-segment paths from the restriction (review X3/arch F1)', async () => {
    const prompts: string[] = [];
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 5, rungs: stubRungs(), baselineCheck: false },
      async (prompt: string) => {
        prompts.push(prompt);
        return '```file:src/main.rs\nfn main() {}\n```';
      },
      {
        // Mission names a protected CI path as "missing" + gates keep failing
        // while naming a real source file.
        ladderRunner: () =>
          ladderResult(0.3, false, [
            {
              id: 'build',
              name: 'build',
              passed: false,
              skipped: false,
              exitCode: 101,
              durationMs: 1000,
              outputTail: 'error[E0432]: unresolved import\n  --> src/main.rs:21:5',
            },
          ]),
      }
    );
    await loop.deliver('Fix the bench per src/main.rs and add the .github/workflows/ci.yml workflow');
    const restricted = prompts.filter((p) => p.includes('ONLY THESE FILES MAY BE EDITED'));
    expect(restricted.length).toBeGreaterThan(0);
    // The protected path never lands in the SANCTIONED SET (the restriction
    // line) — the mission prose itself may still mention it.
    for (const p of restricted) {
      const line = p.split('\n').find((l) => l.includes('ONLY THESE FILES MAY BE EDITED')) ?? '';
      expect(line.includes('.github')).toBe(false);
    }
  }, 30_000);

  it('an extraction miss with OTHER rungs red is ordinary failure — no repair routing', async () => {
    const prompts: string[] = [];
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 3, rungs: stubRungs(), baselineCheck: false },
      async (prompt: string) => {
        prompts.push(prompt);
        return '```file:src/main.rs\nfn main() {}\n```';
      },
      {
        ladderRunner: () =>
          ladderResult(0.4, false, [
            {
              id: 'build',
              name: 'build',
              passed: false,
              skipped: false,
              exitCode: 101,
              durationMs: 1000,
              outputTail: 'error: could not compile',
            },
            {
              id: 'acceptance',
              name: 'acceptance',
              passed: false,
              skipped: false,
              exitCode: 1,
              durationMs: 100,
              outputTail: 'p50 not extractable from output',
            },
          ]),
      }
    );
    const result = await loop.deliver('Ship it');
    expect(result.success).toBe(false);
    // No gate-repair banner: the work itself is failing.
    expect(prompts.some((p) => p.includes('ACCEPTANCE GATE REPAIR'))).toBe(false);
  }, 30_000);
});

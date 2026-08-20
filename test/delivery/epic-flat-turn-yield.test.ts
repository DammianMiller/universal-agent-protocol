/**
 * Yielding a FLAT epic attempt to a fresh one.
 *
 * THE GAP THIS CLOSES
 * An epic attempt that never moves its gate score still burns its whole turn
 * budget. The existing no-progress rail cannot see it (that one requires
 * `provablyIdle`, and these turns write real edits), and an always-on plateau
 * rail was tried and REMOVED — `untilDelivered` already stops extending at
 * STAGNATION_LIMIT, so such a rail is redundant where it can run and
 * unreachable elsewhere.
 *
 * What makes this different is the CALLER, not the mechanism. An epic attempt
 * has somewhere better to spend the time — a fresh attempt on the same epic —
 * and the epic controller is the only layer that knows whether one is left.
 *
 * MEASURED (2026-08-20, rust-pg-ext, qwen3.8-27b, 7 epics):
 *   fix-bioband-derive   a1: 5 turns flat @60%  -> a2 PASSED in 2 turns
 *   fix-slope-arithmetic a1: 5 turns flat @40%, a2: 5 turns flat @40%
 * `↑ turn 3: enable critic` fired in all four flat attempts and moved the score
 * in none of them. Aborting after 2 flat turns reclaims 36.1 minutes across
 * those three attempts — on a run that died on its wall clock at 6 of 7 epics.
 *
 * Being wrong is recoverable by construction: the epic retries with the prior
 * attempt's writes carried forward and the plateau reason fed back, so a cut
 * attempt costs a restart, not the work.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConvergenceLoop } from '../../src/delivery/convergence-loop.js';
import type { GateRung, LadderResult } from '../../src/delivery/verifier-ladder.js';

function stubRungs(): GateRung[] {
  return [
    { id: 'test', name: 'test', command: 'node', args: ['-e', ''], required: true, timeoutMs: 1000 },
  ];
}

function ladderResult(score: number, feedback = 'gate feedback'): LadderResult {
  const passed = score >= 1;
  return {
    passed,
    score,
    feedback,
    results: [
      {
        id: 'test',
        name: 'test',
        passed,
        skipped: false,
        exitCode: passed ? 0 : 1,
        durationMs: 1,
        outputTail: passed ? '' : 'assertion failed',
      },
    ],
  };
}

/** The shape the CLI actually gives an epic attempt. */
const EPIC_LOOP_SHAPE = { maxTurns: 5, maxTurnsCeiling: 30, untilDelivered: true };

describe('epic attempt yields on a plateau (rust-pg-ext, 2026-08-20)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-yield-'));
    // The sibling no-progress rail proves idleness via a git fingerprint and
    // fails OPEN without one. A real repo is what establishes "the tree moved",
    // which is the precondition that made these attempts invisible to it.
    execSync('git init -q', { cwd: dir, stdio: 'ignore' });
    execSync('git config user.email t@t', { cwd: dir, stdio: 'ignore' });
    execSync('git config user.name t', { cwd: dir, stdio: 'ignore' });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Runs a loop whose gate score follows `scores`, writing a new file each turn. */
  async function run(scores: number[], extra: Record<string, unknown> = {}) {
    let calls = 0;
    const loop = new ConvergenceLoop(
      { projectRoot: dir, rungs: stubRungs(), baselineCheck: false, ...EPIC_LOOP_SHAPE, ...extra },
      async () => {
        calls++;
        // Distinct content each turn: the tree genuinely moves, which is what
        // blinds the provablyIdle rail.
        return `\`\`\`file:src/turn${calls}.ts\nexport const n = ${calls};\n\`\`\``;
      },
      { ladderRunner: () => ladderResult(scores[Math.min(calls - 1, scores.length - 1)]) }
    );
    const result = await loop.deliver('remove Eq from the BioBand derive');
    return { result, calls };
  }

  it('ends a flat attempt early when a retry is available', async () => {
    const { result, calls } = await run([0.6], { abortOnFlatTurns: 2 });

    expect(result.success).toBe(false);
    expect(result.stallReason).toMatch(/plateau/i);
    // Turn 1 sets the high-water, turns 2-3 are the two flat turns.
    expect(calls).toBe(3);
    // The reason must reach consumers that only read finalFeedback — it becomes
    // the next attempt's `lastFailure`, which is how the fresh session learns
    // that this approach plateaued rather than merely ran out of turns.
    expect(result.finalFeedback).toMatch(/plateau/i);
  });

  it('plays a flat attempt out in full on the LAST attempt', async () => {
    // No retry to yield to, so ending early would only lose turns. The CLI
    // leaves abortOnFlatTurns unset here, and behaviour is unchanged.
    const { result, calls } = await run([0.6]);

    expect(result.stallReason).toBeUndefined();
    expect(calls).toBe(5);
  });

  it('never cuts a run whose score is still climbing', async () => {
    const { result, calls } = await run([0.2, 0.4, 0.6, 0.8, 1.0], { abortOnFlatTurns: 2 });

    expect(result.success).toBe(true);
    expect(result.stallReason).toBeUndefined();
    expect(calls).toBe(5);
  });

  it('tolerates an isolated flat turn between improvements', async () => {
    // Real convergence stutters. Only CONSECUTIVE flat turns count, so a
    // one-turn pause must not spend the attempt.
    const { result, calls } = await run([0.2, 0.2, 0.4, 0.4, 0.6, 0.6, 0.8, 1.0], {
      abortOnFlatTurns: 2,
    });

    expect(result.success).toBe(true);
    expect(result.stallReason).toBeUndefined();
    expect(calls).toBe(8);
  });

  it('does not count turns the executor never completed', async () => {
    // An inconclusive turn produces no ladder verdict — missing data, not a
    // flat result. Three flaky turns must not spend an attempt.
    let calls = 0;
    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        rungs: stubRungs(),
        baselineCheck: false,
        ...EPIC_LOOP_SHAPE,
        abortOnFlatTurns: 2,
      },
      async () => {
        calls++;
        throw new Error('upstream 429');
      },
      { ladderRunner: () => ladderResult(0.6) }
    );
    const result = await loop.deliver('flaky endpoint');

    // No stall verdict at all — five inconclusive turns are five data points
    // the rail is not entitled to read, not five flat ones.
    expect(result.stallReason).toBeUndefined();
    expect(calls).toBe(5);
  });

  it('treats acceptance movement as progress', async () => {
    // An objective-green run pins the gate score at 1.0 while a multi-criterion
    // spec completes criterion by criterion — so the gate score stops carrying
    // information exactly when acceptance starts carrying it.
    let judged = 0;
    let calls = 0;
    const fractions = [0.2, 0.4, 0.6, 0.8, 1.0];
    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        rungs: stubRungs(),
        baselineCheck: false,
        maxTurns: 1,
        maxTurnsCeiling: 20,
        untilDelivered: true,
        abortOnFlatTurns: 2,
      },
      async () => {
        calls++;
        return `\`\`\`file:src/crit${calls}.ts\nexport const n = ${calls};\n\`\`\``;
      },
      {
        ladderRunner: () => ladderResult(1),
        acceptanceGate: async () => {
          const f = fractions[Math.min(judged, fractions.length - 1)];
          judged++;
          return f >= 1
            ? { passed: true, feedback: '', score: 1 }
            : { passed: false, feedback: 'more criteria remain', score: f };
        },
      }
    );
    const result = await loop.deliver('satisfy every criterion');

    expect(result.stallReason).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it('gives a NEW EXECUTOR the turn it needs to prove itself', async () => {
    // A directive is decided on turn N and consumed by turn N+1, so breaking on
    // the deciding turn discards it. `createRepairEscalation` offers exactly
    // such a directive when compile errors are RISING — i.e. on the flat turn
    // this rail fires. Measured before the exemption: the repair executor was
    // never called once and the attempt was abandoned.
    //
    // Only executor-REPLACING directives are exempt. The critic and reseed
    // tiers stay unexempted: those are the ones the measurement found worthless
    // on a flat attempt.
    let calls = 0;
    let repairCalls = 0;
    let fixed = false;
    const repair = async () => {
      repairCalls++;
      fixed = true;
      return '```file:src/fix.ts\nexport const ok = 1;\n```';
    };
    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        rungs: stubRungs(),
        baselineCheck: false,
        ...EPIC_LOOP_SHAPE,
        abortOnFlatTurns: 3,
        onIteration: (rec) =>
          rec.turn === 4 && !fixed ? { label: 'one-shot repair', switchExecutor: repair } : undefined,
      },
      async () => {
        calls++;
        return `\`\`\`file:src/turn${calls}.ts\nexport const n = ${calls};\n\`\`\``;
      },
      { ladderRunner: () => ladderResult(fixed ? 1 : 0.6) }
    );
    const result = await loop.deliver('rising compile errors');

    expect(repairCalls).toBe(1);
    expect(result.success).toBe(true);
    expect(result.stallReason).toBeUndefined();
  });

  it('leaves the accurate stuck verdict to the rail that owns it', async () => {
    // This rail never consults provablyIdle/filesApplied, so it must not claim
    // the tree changed. On an attempt that writes NOTHING the sibling rail has
    // the real diagnosis ("the gate feedback is likely naming a file that is
    // not the defect"), and that is what the retry must be told.
    let calls = 0;
    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        rungs: stubRungs(),
        baselineCheck: false,
        alwaysVerify: true,
        maxTurns: 8,
        maxTurnsCeiling: 8,
        abortOnFlatTurns: 3,
      },
      async () => {
        calls++;
        return 'I re-read the file; it looks correct to me.';
      },
      { applier: async () => ({ filesWritten: [], rejected: [] }), ladderRunner: () => ladderResult(0.33) }
    );
    const result = await loop.deliver('fix the boot error');

    expect(result.stallReason).toMatch(/left the working tree unchanged/);
    expect(result.stallReason).not.toMatch(/changed files/);
  });

  it('leaves the retry enough room to be steered', async () => {
    // stallReason is prepended to finalFeedback, and epic-mission slices that to
    // 400 chars to build the next attempt's `lastFailure`. A 339-char first
    // draft left ~58 chars of gate output and cut the actionable line — the
    // fresh attempt received LESS diagnostic than after an uncut attempt, which
    // defeats the recovery this rail depends on.
    const GATE =
      'error[E0277]: the trait bound `BioBand: Eq` is not satisfied --> src/types.rs:41:17 ' +
      'ACTIONABLE: remove Eq from the derive list on BioBand because it holds f64 fields';
    let calls = 0;
    const loop = new ConvergenceLoop(
      { projectRoot: dir, rungs: stubRungs(), baselineCheck: false, ...EPIC_LOOP_SHAPE, abortOnFlatTurns: 3 },
      async () => {
        calls++;
        return `\`\`\`file:src/turn${calls}.ts\nexport const n = ${calls};\n\`\`\``;
      },
      { ladderRunner: () => ladderResult(0.6, GATE) }
    );
    const result = await loop.deliver('x');

    expect((result.stallReason ?? '').length).toBeLessThan(140);
    // Exactly the transform epic-mission applies to build lastFailure.
    const carried = (result.finalFeedback ?? '').replace(/\s+/g, ' ').slice(0, 400);
    expect(carried).toContain('ACTIONABLE');
  });

  it('is off unless a caller asks for it', async () => {
    // The default path — every non-epic run — must be byte-identical to before.
    // A previous always-on version of this rail was removed for exactly this.
    for (const cfg of [{}, { abortOnFlatTurns: 0 }, { abortOnFlatTurns: -1 }]) {
      const { result, calls } = await run([0.6], cfg);
      expect(result.stallReason).toBeUndefined();
      expect(calls).toBe(5);
    }
  });
});

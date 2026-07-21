import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConvergenceLoop } from '../../src/delivery/convergence-loop.js';
import type { GateRung, LadderResult } from '../../src/delivery/verifier-ladder.js';

function stubRungs(): GateRung[] {
  return [{ id: 'test', name: 'test', command: 'node', args: ['-e', ''], required: true, timeoutMs: 1000 }];
}

function ladderResult(score: number, passed: boolean, feedback = 'gate feedback'): LadderResult {
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

/** Output containing a valid file block so the default flow reaches verification. */
const FILE_BLOCK_OUTPUT = '```file:src/fix.ts\nexport const fixed = true;\n```';

describe('ConvergenceLoop', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-loop-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('alwaysVerify runs gates even when the applier wrote no files (direct-mutation executor)', async () => {
    // Simulates the agentic executor + no-op applier: the executor returns no
    // file blocks, so filesWritten is empty, but the gate must still run.
    let ladderRuns = 0;
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 2, rungs: stubRungs(), baselineCheck: false, alwaysVerify: true },
      async () => 'agent mutated the repo directly; nothing to apply',
      {
        applier: async () => ({ filesWritten: [], rejected: [] }),
        ladderRunner: () => {
          ladderRuns++;
          return ladderResult(1.0, true);
        },
      }
    );
    const result = await loop.deliver('compute something via tools');
    expect(ladderRuns).toBeGreaterThan(0); // gate ran despite 0 files applied
    expect(result.success).toBe(true);
  });

  it('without alwaysVerify, an empty applier result skips the gate (no false pass)', async () => {
    let ladderRuns = 0;
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 1, rungs: stubRungs(), baselineCheck: false },
      async () => 'no file blocks here',
      {
        applier: async () => ({ filesWritten: [], rejected: [] }),
        ladderRunner: () => {
          ladderRuns++;
          return ladderResult(1.0, true);
        },
      }
    );
    const result = await loop.deliver('x');
    expect(ladderRuns).toBe(0); // gate skipped because nothing was applied
    expect(result.success).toBe(false);
  });

  it('converges when the ladder passes, applying files each turn', async () => {
    let executorCalls = 0;
    let ladderRuns = 0;
    const scores = [0.25, 0.5, 1.0];

    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 5, rungs: stubRungs(), baselineCheck: false },
      async () => {
        executorCalls++;
        return FILE_BLOCK_OUTPUT;
      },
      {
        ladderRunner: () => {
          const score = scores[ladderRuns++];
          return ladderResult(score, score === 1.0);
        },
      }
    );

    const result = await loop.deliver('make the tests pass');
    expect(result.success).toBe(true);
    expect(result.turns).toBe(3);
    expect(executorCalls).toBe(3);
    expect(result.history.map((h) => h.score)).toEqual([0.25, 0.5, 1.0]);
    expect(result.bestScore).toBe(1.0);
    expect(result.bestTurn).toBe(3);
    expect(result.history[0].filesApplied).toEqual(['src/fix.ts']);
    expect(readFileSync(join(dir, 'src/fix.ts'), 'utf-8')).toContain('fixed');
  });

  it('short-circuits with alreadyDelivered when the baseline is green', async () => {
    let executorCalls = 0;
    const loop = new ConvergenceLoop(
      { projectRoot: dir, rungs: stubRungs() },
      async () => {
        executorCalls++;
        return FILE_BLOCK_OUTPUT;
      },
      { ladderRunner: () => ladderResult(1.0, true) }
    );

    const result = await loop.deliver('anything');
    expect(result.alreadyDelivered).toBe(true);
    expect(result.success).toBe(true);
    expect(result.turns).toBe(0);
    expect(executorCalls).toBe(0);
  });

  it('stops at maxTurns when gates never pass and reports best iteration', async () => {
    const scores = [0.2, 0.6, 0.4];
    let run = 0;
    const iterations: number[] = [];

    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        maxTurns: 3,
        rungs: stubRungs(),
        baselineCheck: false,
        onIteration: (rec) => {
          iterations.push(rec.turn);
        },
      },
      async () => FILE_BLOCK_OUTPUT,
      { ladderRunner: () => ladderResult(scores[run++], false, `feedback run ${run}`) }
    );

    const result = await loop.deliver('impossible task');
    expect(result.success).toBe(false);
    expect(result.turns).toBe(3);
    expect(result.bestScore).toBe(0.6);
    expect(result.bestTurn).toBe(2);
    expect(iterations).toEqual([1, 2, 3]);
    expect(result.finalFeedback).toContain('feedback run 3');
  });

  it('feeds gate feedback and prior output into subsequent prompts', async () => {
    const prompts: string[] = [];
    let run = 0;

    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 2, rungs: stubRungs(), baselineCheck: false },
      async (prompt) => {
        prompts.push(prompt);
        return FILE_BLOCK_OUTPUT;
      },
      { ladderRunner: () => ladderResult(0.5, run++ > 0, 'TypeError: x is not a function') }
    );

    const result = await loop.deliver('fix the bug');
    expect(result.success).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('TASK: fix the bug');
    expect(prompts[0]).toContain('file:relative/path');
    expect(prompts[1]).toContain('TypeError: x is not a function');
    expect(prompts[1]).toContain('src/fix.ts');
    expect(prompts[1]).toContain('Your previous output');
  });

  it('skips verification when no file blocks are applied, telling the model the format', async () => {
    let ladderRuns = 0;
    const prompts: string[] = [];

    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 2, rungs: stubRungs(), baselineCheck: false },
      async (prompt) => {
        prompts.push(prompt);
        return prompts.length === 1 ? 'just prose, no files' : FILE_BLOCK_OUTPUT;
      },
      {
        ladderRunner: () => {
          ladderRuns++;
          return ladderResult(1.0, true);
        },
      }
    );

    const result = await loop.deliver('do the thing');
    expect(result.success).toBe(true);
    // Turn 1 applied nothing → no ladder run; only turn 2 verified
    expect(ladderRuns).toBe(1);
    expect(result.history[0].applyError).toContain('No file blocks');
    expect(result.history[0].score).toBe(0);
    expect(prompts[1]).toContain('could not be applied');
  });

  it('records executor errors with real turn numbers and recovers', async () => {
    let calls = 0;
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 3, rungs: stubRungs(), baselineCheck: false },
      async () => {
        calls++;
        if (calls === 1) throw new Error('inference timeout');
        return FILE_BLOCK_OUTPUT;
      },
      { ladderRunner: () => ladderResult(1.0, true) }
    );

    const result = await loop.deliver('do the thing');
    expect(result.success).toBe(true);
    expect(result.turns).toBe(2);
    expect(result.history).toHaveLength(2);
    expect(result.history[0].turn).toBe(1);
    expect(result.history[0].executorError).toBe('inference timeout');
    expect(result.history[1].turn).toBe(2);
    expect(result.bestTurn).toBe(2);
  });

  it('honors a stop directive from onIteration', async () => {
    let calls = 0;
    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        maxTurns: 5,
        rungs: stubRungs(),
        baselineCheck: false,
        onIteration: () => 'stop',
      },
      async () => {
        calls++;
        return FILE_BLOCK_OUTPUT;
      },
      { ladderRunner: () => ladderResult(0.5, false) }
    );

    const result = await loop.deliver('task');
    expect(calls).toBe(1);
    expect(result.turns).toBe(1);
    expect(result.success).toBe(false);
  });

  it('throws on empty rungs and invalid maxTurns instead of vacuous success', async () => {
    const loop = new ConvergenceLoop(
      { projectRoot: join(dir, 'no-such-project'), rungs: [] },
      async () => FILE_BLOCK_OUTPUT
    );
    await expect(loop.deliver('task')).rejects.toThrow(/No verifiable gates/);

    const badTurns = new ConvergenceLoop(
      { projectRoot: dir, rungs: stubRungs(), maxTurns: 0 },
      async () => FILE_BLOCK_OUTPUT
    );
    await expect(badTurns.deliver('task')).rejects.toThrow(/maxTurns/);
  });
});

describe('ConvergenceLoop — raiseMaxTurns is always ceiling-capped', () => {
  it('an escalation raiseMaxTurns cannot push past maxTurnsCeiling even without untilDelivered', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-loop-cap-'));
    try {
      let executorCalls = 0;
      const loop = new ConvergenceLoop(
        {
          projectRoot: dir,
          maxTurns: 1,
          maxTurnsCeiling: 1, // operator's explicit --max-turns mirrored as hard cap
          rungs: stubRungs(),
          baselineCheck: false,
          alwaysVerify: true,
          // escalation-style directive: try to buy 5 more turns every iteration
          onIteration: () => ({ raiseMaxTurns: 6 }),
        },
        async () => {
          executorCalls++;
          return 'no progress';
        },
        {
          applier: async () => ({ filesWritten: [], rejected: [] }),
          ladderRunner: () => ladderResult(0, false),
        }
      );
      const result = await loop.deliver('x');
      expect(executorCalls).toBe(1); // the raise was clamped to the ceiling
      expect(result.turns).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('without an explicit cap (high ceiling), a raise still extends as designed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-loop-raise-'));
    try {
      let executorCalls = 0;
      let raised = false;
      const loop = new ConvergenceLoop(
        {
          projectRoot: dir,
          maxTurns: 1,
          maxTurnsCeiling: 10,
          rungs: stubRungs(),
          baselineCheck: false,
          alwaysVerify: true,
          onIteration: () => {
            if (!raised) {
              raised = true;
              return { raiseMaxTurns: 2 };
            }
            return undefined;
          },
        },
        async () => {
          executorCalls++;
          return 'no progress';
        },
        {
          applier: async () => ({ filesWritten: [], rejected: [] }),
          ladderRunner: () => ladderResult(0, false),
        }
      );
      await loop.deliver('x');
      expect(executorCalls).toBe(2); // raise honored up to the ceiling
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('anti-no-op acceptance rail (P0, 2026-07-13)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-noop-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('withholds acceptance at a green baseline — a coding mission is NOT alreadyDelivered', async () => {
    let acceptanceCalls = 0;
    let executorCalls = 0;
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 1, rungs: stubRungs() },
      async () => {
        executorCalls++;
        return FILE_BLOCK_OUTPUT;
      },
      {
        ladderRunner: () => ladderResult(1.0, true),
        acceptanceGate: async () => {
          acceptanceCalls++;
          return { passed: true, feedback: '' };
        },
      }
    );
    const result = await loop.deliver('change something');
    // The old behavior short-circuited here with alreadyDelivered and zero
    // executor calls — the 2026-07-13 false-green no-op.
    expect(result.alreadyDelivered).not.toBe(true);
    expect(executorCalls).toBeGreaterThan(0);
    // Turn 1 applied a file, so acceptance is consulted and the run succeeds
    // on REAL change.
    expect(result.success).toBe(true);
    expect(result.turns).toBe(1);
    expect(acceptanceCalls).toBeGreaterThan(0);
    expect(result.history[0].filesApplied).toEqual(['src/fix.ts']);
  });

  it('a run that never changes the tree cannot pass acceptance (fail-closed without git)', async () => {
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 2, rungs: stubRungs(), alwaysVerify: true },
      async () => 'the model emitted prose and no file blocks',
      {
        applier: async () => ({ filesWritten: [], rejected: [] }),
        ladderRunner: () => ladderResult(1.0, true),
        acceptanceGate: async () => ({ passed: true, feedback: '' }),
      }
    );
    const result = await loop.deliver('change something');
    expect(result.success).toBe(false);
    expect(result.finalFeedback).toMatch(/no-op|has not changed/i);
  });

  it('prior-epic changes let a zero-diff trailing epic pass via the judge (no re-split churn)', async () => {
    // A trailing epic writes nothing because an earlier epic already produced
    // its files. UAP_EPIC_PRIOR_CHANGES=1 (set by the epic controller) must stop
    // the rail failing it as a no-op — it defers to the acceptance judge.
    const prev = process.env.UAP_EPIC_PRIOR_CHANGES;
    let acceptanceCalls = 0;
    try {
      process.env.UAP_EPIC_PRIOR_CHANGES = '1';
      const loop = new ConvergenceLoop(
        { projectRoot: dir, maxTurns: 2, rungs: stubRungs(), alwaysVerify: true },
        async () => 'no new work — already delivered by an earlier epic',
        {
          applier: async () => ({ filesWritten: [], rejected: [] }),
          ladderRunner: () => ladderResult(1.0, true),
          acceptanceGate: async () => { acceptanceCalls++; return { passed: true, feedback: '' }; },
        }
      );
      const result = await loop.deliver('trailing epic whose goal is already met');
      expect(result.success).toBe(true);          // accepted despite zero diff
      expect(acceptanceCalls).toBeGreaterThan(0); // judge decided, not hard-withheld
    } finally {
      if (prev === undefined) delete process.env.UAP_EPIC_PRIOR_CHANGES;
      else process.env.UAP_EPIC_PRIOR_CHANGES = prev;
    }
  });

  it('prior-epic changes still fail a zero-diff epic whose goal is NOT met (judge rejects)', async () => {
    const prev = process.env.UAP_EPIC_PRIOR_CHANGES;
    try {
      process.env.UAP_EPIC_PRIOR_CHANGES = '1';
      const loop = new ConvergenceLoop(
        { projectRoot: dir, maxTurns: 1, rungs: stubRungs(), alwaysVerify: true },
        async () => 'no work',
        {
          applier: async () => ({ filesWritten: [], rejected: [] }),
          ladderRunner: () => ladderResult(1.0, true),
          acceptanceGate: async () => ({ passed: false, feedback: 'goal not met' }),
        }
      );
      const result = await loop.deliver('goal not actually met');
      expect(result.success).toBe(false); // the flag is not a free pass — the judge still gates
    } finally {
      if (prev === undefined) delete process.env.UAP_EPIC_PRIOR_CHANGES;
      else process.env.UAP_EPIC_PRIOR_CHANGES = prev;
    }
  });

  it('zero-diff + prior-changes + judge THROW fails closed (no verdict, no acceptance)', async () => {
    const prev = process.env.UAP_EPIC_PRIOR_CHANGES;
    try {
      process.env.UAP_EPIC_PRIOR_CHANGES = '1';
      const loop = new ConvergenceLoop(
        { projectRoot: dir, maxTurns: 1, rungs: stubRungs(), alwaysVerify: true },
        async () => 'no work',
        {
          applier: async () => ({ filesWritten: [], rejected: [] }),
          ladderRunner: () => ladderResult(1.0, true),
          acceptanceGate: async () => { throw new Error('judge endpoint down'); },
        }
      );
      const result = await loop.deliver('trailing epic, judge unavailable');
      // The deterministic rail stood down BECAUSE the judge would decide; a
      // judge failure must not silently accept a zero-diff epic.
      expect(result.success).toBe(false);
      expect(result.finalFeedback).toMatch(/judge/i);
    } finally {
      if (prev === undefined) delete process.env.UAP_EPIC_PRIOR_CHANGES;
      else process.env.UAP_EPIC_PRIOR_CHANGES = prev;
    }
  });

  it('resume runs stay fail-open on judge THROW (zero diff is expected on resume)', async () => {
    const prev = process.env.UAP_EPIC_PRIOR_CHANGES;
    try {
      process.env.UAP_EPIC_PRIOR_CHANGES = '1';
      const loop = new ConvergenceLoop(
        { projectRoot: dir, maxTurns: 1, rungs: stubRungs(), alwaysVerify: true, resumeFrom: 'run-x' },
        async () => 'no new work — resumed',
        {
          applier: async () => ({ filesWritten: [], rejected: [] }),
          ladderRunner: () => ladderResult(1.0, true),
          acceptanceGate: async () => { throw new Error('judge endpoint down'); },
        }
      );
      const result = await loop.deliver('resumed run, judge unavailable');
      // On resume the deterministic rail never stood down FOR the judge (prior
      // -session changes are invisible to the fingerprint), so the fail-closed
      // carve-out must not fire.
      expect(result.success).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.UAP_EPIC_PRIOR_CHANGES;
      else process.env.UAP_EPIC_PRIOR_CHANGES = prev;
    }
  });

  it('a judge THROW on a run that DID change files still fails open (general rule intact)', async () => {
    const prev = process.env.UAP_EPIC_PRIOR_CHANGES;
    try {
      delete process.env.UAP_EPIC_PRIOR_CHANGES;
      const loop = new ConvergenceLoop(
        { projectRoot: dir, maxTurns: 1, rungs: stubRungs(), alwaysVerify: true },
        async () => 'file: something',
        {
          applier: async () => ({ filesWritten: ['a.txt'], rejected: [] }),
          ladderRunner: () => ladderResult(1.0, true),
          acceptanceGate: async () => { throw new Error('judge endpoint down'); },
        }
      );
      const result = await loop.deliver('real change, judge unavailable');
      expect(result.success).toBe(true); // fail open — the judge must never block a real delivery
    } finally {
      if (prev === undefined) delete process.env.UAP_EPIC_PRIOR_CHANGES;
      else process.env.UAP_EPIC_PRIOR_CHANGES = prev;
    }
  });

  it('DeliveryResult.changedTree reflects applier writes and stays false on no-op runs', async () => {
    const wrote = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 1, rungs: stubRungs(), alwaysVerify: true },
      async () => 'file: something',
      {
        applier: async () => ({ filesWritten: ['a.txt'], rejected: [] }),
        ladderRunner: () => ladderResult(1.0, true),
        acceptanceGate: async () => ({ passed: true, feedback: '' }),
      }
    );
    const wroteRes = await wrote.deliver('write it');
    expect(wroteRes.changedTree).toBe(true);
    expect(wroteRes.success).toBe(true);

    const noop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 1, rungs: stubRungs(), alwaysVerify: true },
      async () => 'prose only',
      {
        applier: async () => ({ filesWritten: [], rejected: [] }),
        ladderRunner: () => ladderResult(1.0, true),
        acceptanceGate: async () => ({ passed: true, feedback: '' }),
      }
    );
    const noopRes = await noop.deliver('nothing to do');
    expect(noopRes.changedTree).toBe(false); // rail withholds; no writes recorded
    expect(noopRes.success).toBe(false);
  });

  it('unborn-HEAD repos (no commits) still detect agentic writes via the fingerprint', async () => {
    const { execSync } = await import('node:child_process');
    const { writeFileSync: wf, mkdirSync: mk } = await import('node:fs');
    const gdir = mkdtempSync(join(tmpdir(), 'uap-unborn-'));
    try {
      execSync('git init -q', { cwd: gdir }); // .git exists, ZERO commits — git diff HEAD fails here
      mk(join(gdir, 'space-shooter'), { recursive: true });
      let acceptanceCalls = 0;
      const loop = new ConvergenceLoop(
        { projectRoot: gdir, maxTurns: 2, rungs: stubRungs(), alwaysVerify: true },
        async () => {
          // agentic-style direct write: bypasses the applier entirely
          wf(join(gdir, 'space-shooter', 'config.js'), 'export const X = 1;');
          return 'wrote via tool, no file blocks';
        },
        {
          applier: async () => ({ filesWritten: [], rejected: [] }),
          ladderRunner: () => ladderResult(1.0, true),
          acceptanceGate: async () => { acceptanceCalls++; return { passed: true, feedback: '' }; },
        }
      );
      const result = await loop.deliver('write the config');
      // Before the fix: git diff HEAD threw → fingerprint null → rail withheld
      // forever ("has not changed any files yet") despite the real write.
      expect(result.success).toBe(true);
      expect(result.changedTree).toBe(true);
      expect(acceptanceCalls).toBeGreaterThan(0);
    } finally {
      rmSync(gdir, { recursive: true, force: true });
    }
  });

  it('requireDiffForAcceptance:false restores the legacy short-circuit (--allow-noop)', async () => {
    const loop = new ConvergenceLoop(
      { projectRoot: dir, rungs: stubRungs(), requireDiffForAcceptance: false },
      async () => FILE_BLOCK_OUTPUT,
      {
        ladderRunner: () => ladderResult(1.0, true),
        acceptanceGate: async () => ({ passed: true, feedback: '' }),
      }
    );
    const result = await loop.deliver('anything');
    expect(result.alreadyDelivered).toBe(true);
    expect(result.turns).toBe(0);
  });
});

describe('anti-no-op rail: git fingerprint (direct-mutation executor)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-noop-git-'));
    const { execSync } = require('child_process');
    execSync('git init -q && git -c user.email=t@t -c user.name=t add -A', { cwd: dir });
    require('fs').writeFileSync(join(dir, 'seed.txt'), 'seed\n');
    execSync('git add -A && git -c user.email=t@t -c user.name=t commit -qm seed', { cwd: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('detects fs-level writes that bypass the applier and lets acceptance pass', async () => {
    // Simulates the agentic executor: the applier reports zero files, but the
    // executor mutated the tree directly. The git fingerprint must see it.
    let acceptanceCalls = 0;
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 1, rungs: stubRungs(), alwaysVerify: true },
      async () => {
        require('fs').writeFileSync(join(dir, 'src-change.txt'), 'the executor wrote this directly\n');
        return 'mutated the repo via tools; no file blocks';
      },
      {
        applier: async () => ({ filesWritten: [], rejected: [] }),
        ladderRunner: () => ladderResult(1.0, true),
        acceptanceGate: async () => {
          acceptanceCalls++;
          return { passed: true, feedback: '' };
        },
      }
    );
    const result = await loop.deliver('write src-change.txt');
    expect(result.alreadyDelivered).not.toBe(true);
    expect(result.success).toBe(true);
    expect(acceptanceCalls).toBeGreaterThan(0);
  });

  it('still withholds acceptance in a git repo when NOTHING changed', async () => {
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 1, rungs: stubRungs(), alwaysVerify: true },
      async () => 'prose only, no writes',
      {
        applier: async () => ({ filesWritten: [], rejected: [] }),
        ladderRunner: () => ladderResult(1.0, true),
        acceptanceGate: async () => ({ passed: true, feedback: '' }),
      }
    );
    const result = await loop.deliver('change something');
    expect(result.success).toBe(false);
    expect(result.finalFeedback).toMatch(/no-op|has not changed/i);
  });
});

describe('no-progress circuit-breaker (octopus stall, 2026-07-20)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-stall-'));
    // The breaker proves idleness via a git fingerprint and deliberately fails
    // OPEN when that is unavailable — it must never abort a run it cannot prove
    // is idle. Real delivery targets are git repos (the worktree gate requires
    // one), so the fixture must be one too or these tests are vacuous.
    execSync('git init -q && git config user.email t@t && git config user.name t', {
      cwd: dir,
      stdio: 'ignore',
    });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A live run spent 4 turns / 2h20m re-reading a file the gate had misnamed,
   * never writing anything, and still ground on to its turn budget.
   */
  it('aborts early when consecutive turns leave the tree unchanged and the score flat', async () => {
    let executorCalls = 0;
    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        maxTurns: 10,
        maxTurnsCeiling: 10,
        rungs: stubRungs(),
        baselineCheck: false,
        alwaysVerify: true,
      },
      async () => {
        executorCalls++;
        return 'I re-read js/contracts.js; it looks correct to me.';
      },
      {
        applier: async () => ({ filesWritten: [], rejected: [] }),
        ladderRunner: () => ladderResult(0.33, false, 'syntax error in js/contracts.js'),
      }
    );
    const result = await loop.deliver('fix the boot error');

    expect(result.success).toBe(false);
    expect(result.stallReason).toMatch(/stuck/i);
    // Aborted well before the 10-turn budget.
    expect(executorCalls).toBeLessThan(10);
    expect(result.turns).toBeLessThan(10);
    // The stall must also reach consumers that only read finalFeedback.
    expect(result.finalFeedback).toMatch(/stuck/i);
  });

  /**
   * Guards the inverse failure: the agentic executor installs a no-op applier,
   * so filesApplied is ALWAYS empty there. Keying the breaker off filesApplied
   * alone would abort productive runs after two flat-score turns.
   */
  it('does NOT abort a run whose executor is writing files via a flat score', async () => {
    let executorCalls = 0;
    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        maxTurns: 4,
        maxTurnsCeiling: 4,
        rungs: stubRungs(),
        baselineCheck: false,
      },
      async () => {
        executorCalls++;
        // Distinct content each turn: the tree genuinely moves.
        return `\`\`\`file:src/fix${executorCalls}.ts\nexport const n = ${executorCalls};\n\`\`\``;
      },
      { ladderRunner: () => ladderResult(0.5, false) }
    );
    const result = await loop.deliver('keep working');

    expect(result.stallReason).toBeUndefined();
    expect(executorCalls).toBe(4);
  });

  /**
   * The harness writes to `.uap/` on every turn — run-state rewrites
   * state.json with a fresh `updatedAt` at each checkpoint, and the visual gate
   * rewrites screenshots on every ladder run. In an unborn-HEAD repo (fresh
   * scaffold, no commit — the octopus shape) the fingerprint falls back to
   * stat'ing untracked files, so that churn made the tree look like it moved
   * every turn and silently re-disabled the breaker. `.uap/` is harness-owned
   * bookkeeping, never mission output, and must not count as progress.
   */
  it('still aborts when only harness-owned .uap/ files churn between turns', async () => {
    let executorCalls = 0;
    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        maxTurns: 10,
        maxTurnsCeiling: 10,
        rungs: stubRungs(),
        baselineCheck: false,
        alwaysVerify: true,
      },
      async () => {
        executorCalls++;
        // Simulate saveRunState + screenshot rewrites: harness state changes
        // every turn while the mission tree stays untouched.
        mkdirSync(join(dir, '.uap', 'visual'), { recursive: true });
        writeFileSync(join(dir, '.uap', 'state.json'), JSON.stringify({ updatedAt: `t${executorCalls}` }));
        writeFileSync(join(dir, '.uap', 'visual', `shot-${executorCalls}.png`), `png-${executorCalls}`);
        return 'still reading; nothing to change.';
      },
      {
        applier: async () => ({ filesWritten: [], rejected: [] }),
        ladderRunner: () => ladderResult(0.33, false),
      }
    );
    const result = await loop.deliver('fix it');

    expect(result.stallReason).toMatch(/stuck/i);
    expect(executorCalls).toBeLessThan(10);
  });

  /** Transient API failures are missing data, not proof of a stuck loop. */
  it('does not count turns the executor never completed', async () => {
    let executorCalls = 0;
    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        maxTurns: 4,
        maxTurnsCeiling: 4,
        rungs: stubRungs(),
        baselineCheck: false,
        alwaysVerify: true,
      },
      async () => {
        executorCalls++;
        throw new Error('429 rate limited');
      },
      {
        applier: async () => ({ filesWritten: [], rejected: [] }),
        ladderRunner: () => ladderResult(0.33, false),
      }
    );
    const result = await loop.deliver('flaky backend');

    // All four turns attempted — a flaky backend must not be misreported as
    // "the loop is spinning" and killed after three failures.
    expect(executorCalls).toBe(4);
    expect(result.stallReason).toBeUndefined();
  });
});

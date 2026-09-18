/**
 * gate-evidence writer tests (uplift 1.4).
 *
 * Exercises recordGateEvidence against a throwaway git repo: the artifact must
 * be schema-valid, bound to the real HEAD, written atomically, bounded in
 * size, recorded ONLY against a clean tree, and loud on invalid input. Also
 * covers gateOutcomesFromResult (last-passing / baseline-alreadyDelivered
 * sourcing) and the hatch audit field.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordGateEvidence,
  resolveCandidateSha,
  gateEvidencePath,
  gateOutcomesFromResult,
  activeGateHatches,
  OUTPUT_TAIL_MAX,
  type GateOutcome,
  type GateEvidence,
} from '../src/delivery/gate-evidence.js';
import type { RungResult } from '../src/delivery/verifier-ladder.js';

/** Strip GIT_* so a host hook environment cannot redirect the fixture repo. */
function cleanGitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return Object.assign(env, extra);
}

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: cleanGitEnv() });
}

function headSha(repo: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repo,
    encoding: 'utf-8',
    env: cleanGitEnv(),
  }).trim();
}

function gate(overrides: Partial<GateOutcome> = {}): GateOutcome {
  return {
    name: 'test',
    command: 'npm test',
    exitCode: 0,
    outputTail: 'ok',
    at: new Date().toISOString(),
    ...overrides,
  };
}

function rung(overrides: Partial<RungResult> = {}): RungResult {
  return {
    id: 'test',
    name: 'npm test',
    passed: true,
    skipped: false,
    exitCode: 0,
    durationMs: 1000,
    outputTail: '5 passed',
    ...overrides,
  };
}

describe('gate-evidence writer', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'uap-gate-evidence-'));
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 't@t.dev']);
    git(repo, ['config', 'user.name', 't']);
    // .uap/ is git-ignored in real projects; the fixture mirrors that so the
    // evidence write itself cannot trip the clean-tree check on re-record.
    writeFileSync(join(repo, '.gitignore'), '.uap/\n');
    writeFileSync(join(repo, 'f.txt'), 'x\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'init']);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('writes a schema-valid artifact bound to the real HEAD', () => {
    const path = recordGateEvidence(repo, [gate(), gate({ name: 'build', command: 'npm run build' })], {
      runId: 'run-123',
    });
    expect(path).toBe(gateEvidencePath(repo, headSha(repo)));
    const data = JSON.parse(readFileSync(path, 'utf-8')) as GateEvidence;
    expect(data.version).toBe(1);
    expect(data.candidateSha).toBe(headSha(repo));
    expect(data.runId).toBe('run-123');
    expect(Number.isNaN(Date.parse(data.recordedAt))).toBe(false);
    expect(data.gates).toHaveLength(2);
    expect(data.gates[0]).toMatchObject({ name: 'test', command: 'npm test', exitCode: 0 });
  });

  it('bounds the output tail to the LAST 2000 characters', () => {
    const marker = 'ENDMARKER';
    const long = 'x'.repeat(5000) + marker;
    const path = recordGateEvidence(repo, [gate({ outputTail: long })]);
    const data = JSON.parse(readFileSync(path, 'utf-8')) as GateEvidence;
    expect(data.gates[0].outputTail.length).toBe(OUTPUT_TAIL_MAX);
    // The suffix survives: a rung's verdict line lives at the END of its output.
    expect(data.gates[0].outputTail.endsWith(marker)).toBe(true);
  });

  it('writes atomically — no tmp file survives next to the artifact', () => {
    const path = recordGateEvidence(repo, [gate()]);
    const dir = join(repo, '.uap', 'evidence');
    expect(existsSync(path)).toBe(true);
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('re-recording for the same HEAD replaces the artifact', () => {
    const first = recordGateEvidence(repo, [gate({ name: 'test' })]);
    const second = recordGateEvidence(repo, [gate({ name: 'test' }), gate({ name: 'lint', command: 'npm run lint', exitCode: 1 })]);
    expect(second).toBe(first);
    const data = JSON.parse(readFileSync(second, 'utf-8')) as GateEvidence;
    expect(data.gates).toHaveLength(2);
  });

  it('REFUSES to bind HEAD while the working tree is dirty', () => {
    // Uncommitted modification: the gates ran against HEAD-plus-delta, which
    // the artifact cannot prove. Fail loudly.
    writeFileSync(join(repo, 'f.txt'), 'changed but uncommitted\n');
    expect(() => recordGateEvidence(repo, [gate()])).toThrow(/dirty working tree/);
    // Untracked files count too.
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'clean again']);
    writeFileSync(join(repo, 'untracked.txt'), 'new\n');
    expect(() => recordGateEvidence(repo, [gate()])).toThrow(/dirty working tree/);
    expect(existsSync(join(repo, '.uap', 'evidence'))).toBe(false);
  });

  it('records which gate hatches were set at deliver time (audit field)', () => {
    const prev = process.env.UAP_NO_REVIEW;
    process.env.UAP_NO_REVIEW = '1';
    try {
      const path = recordGateEvidence(repo, [gate()]);
      const data = JSON.parse(readFileSync(path, 'utf-8')) as GateEvidence;
      expect(data.hatches).toContain('UAP_NO_REVIEW');
      expect(data.hatches).not.toContain('UAP_QUALITY_GATE_OFF');
      expect([...data.hatches].sort()).toEqual(data.hatches); // sorted, stable
    } finally {
      if (prev === undefined) delete process.env.UAP_NO_REVIEW;
      else process.env.UAP_NO_REVIEW = prev;
    }
  });

  it('records an empty hatch list when none are set', () => {
    const path = recordGateEvidence(repo, [gate()]);
    const data = JSON.parse(readFileSync(path, 'utf-8')) as GateEvidence;
    expect(data.hatches).toEqual(activeGateHatches());
  });

  it('throws on an empty gate list — zero gates prove nothing', () => {
    expect(() => recordGateEvidence(repo, [])).toThrow(/zero gates/);
  });

  it('throws on a malformed gate (empty command)', () => {
    expect(() => recordGateEvidence(repo, [gate({ command: '  ' })])).toThrow(/no command/);
  });

  it('throws on an unparseable gate timestamp', () => {
    expect(() => recordGateEvidence(repo, [gate({ at: 'not-a-date' })])).toThrow(/timestamp/);
  });

  it('fails loudly outside a git repo (no silent fallback SHA)', () => {
    const plain = mkdtempSync(join(tmpdir(), 'uap-gate-evidence-plain-'));
    try {
      expect(() => resolveCandidateSha(plain)).toThrow();
      expect(() => recordGateEvidence(plain, [gate()])).toThrow();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('fails loudly on an unborn branch (HEAD unresolvable)', () => {
    const unborn = mkdtempSync(join(tmpdir(), 'uap-gate-evidence-unborn-'));
    try {
      git(unborn, ['init', '-q']);
      expect(() => recordGateEvidence(unborn, [gate()])).toThrow();
      // And nothing was half-written.
      expect(existsSync(join(unborn, '.uap', 'evidence'))).toBe(false);
    } finally {
      rmSync(unborn, { recursive: true, force: true });
    }
  });

  it('omits runId when not supplied', () => {
    mkdirSync(join(repo, 'sub'), { recursive: true });
    const path = recordGateEvidence(repo, [gate()]);
    const data = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    expect('runId' in data).toBe(false);
  });
});

describe('gateOutcomesFromResult', () => {
  const rungs = [
    { id: 'build', command: 'npm', args: ['run', 'build'] },
    { id: 'test', command: 'npm', args: ['test'] },
  ];

  it('sources the LAST passing iteration, not the first (final tree wins)', () => {
    const source = {
      history: [
        { passed: true, gateResults: [rung({ outputTail: 'early pass' })] },
        { passed: false, gateResults: [rung({ passed: false, exitCode: 1 })] },
        { passed: true, gateResults: [rung({ outputTail: 'final pass' })] },
      ],
    };
    const outcomes = gateOutcomesFromResult(source, rungs);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].outputTail).toBe('final pass');
    expect(outcomes[0].command).toBe('npm test'); // resolved from the rung
  });

  it('falls back to baselineGates for an alreadyDelivered-shaped result', () => {
    // The green-baseline dead-end regression: history is empty, turns never
    // ran, but the baseline ladder DID — its rung results are the evidence.
    const source = {
      history: [] as Array<{ passed: boolean; gateResults: RungResult[] }>,
      baselineGates: [
        rung({ id: 'build', name: 'npm run build', durationMs: 500 }),
        rung({ id: 'test', name: 'npm test', durationMs: 2000 }),
      ],
    };
    const outcomes = gateOutcomesFromResult(source, rungs);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.map((o) => o.command)).toEqual(['npm run build', 'npm test']);
  });

  it('returns [] when neither history nor baseline produced gates', () => {
    expect(gateOutcomesFromResult({ history: [] }, rungs)).toEqual([]);
  });

  it('drops skipped rungs and rungs without an exit code', () => {
    const source = {
      history: [
        {
          passed: true,
          gateResults: [
            rung(),
            rung({ id: 'lint', name: 'lint', skipped: true, exitCode: null }),
            rung({ id: 'deploy', name: 'deploy', exitCode: null }),
          ],
        },
      ],
    };
    const outcomes = gateOutcomesFromResult(source, rungs);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].name).toBe('npm test');
  });

  it('stamps per-gate finish times back off rung durations (ordered, last == recordedAt)', () => {
    const t0 = new Date('2026-09-18T12:00:00.000Z');
    const source = {
      history: [
        {
          passed: true,
          gateResults: [
            rung({ id: 'build', name: 'build', durationMs: 5000 }),
            rung({ id: 'test', name: 'test', durationMs: 2000 }),
          ],
        },
      ],
    };
    const outcomes = gateOutcomesFromResult(source, rungs, t0);
    expect(outcomes[1].at).toBe(t0.toISOString());
    // The earlier gate finished its successors' durations before t0.
    expect(Date.parse(outcomes[0].at)).toBe(t0.getTime() - 2000);
    expect(Date.parse(outcomes[0].at)).toBeLessThan(Date.parse(outcomes[1].at));
  });

  it('falls back to the gate NAME as command when the rung is not resolvable', () => {
    const source = {
      history: [{ passed: true, gateResults: [rung({ id: 'redetected-x', name: 'cargo test' })] }],
    };
    const outcomes = gateOutcomesFromResult(source, rungs);
    expect(outcomes[0].command).toBe('cargo test');
  });
});

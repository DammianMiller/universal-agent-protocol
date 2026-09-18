/**
 * reliability-ladder aggregation (uplift 0.1) — pooling, tier bucketing,
 * zero-token handling, and the generated-table contract.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  aggregate,
  renderMarkdown,
  resolveResultsDir,
  tierOf,
} from '../scripts/reliability-ladder.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uap-ladder-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeRun(
  name: string,
  conditions: { label: string; n: number; successRate: number; meanTokens: number }[],
  opts: { usable?: boolean; model?: string } = {},
): void {
  const runDir = join(dir, name);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, 'report.json'),
    JSON.stringify({
      report: {
        meta: { model: opts.model ?? 'test-model', conditions: conditions.map((c) => c.label), taskCount: 5 },
        perCondition: conditions.map((c) => ({
          meanTurns: 1,
          meanLatencyMs: 1000,
          errorRate: 1 - c.successRate,
          ...c,
        })),
        discrimination: { usable: opts.usable ?? false, status: opts.usable ? 'ok' : 'underpowered' },
      },
    }),
  );
}

describe('tierOf', () => {
  it('buckets run directory names into tiers', () => {
    expect(tierOf('paired-qwen36-medium-20260622')).toBe('medium');
    expect(tierOf('paired-brutal-power')).toBe('brutal'); // first match wins
    expect(tierOf('paired-qwen38-e3b-power')).toBe('power');
    expect(tierOf('paired-qwen36-medium-powered')).toBe('medium'); // 'medium' precedes 'power'
    expect(tierOf('hard-uplift-e10')).toBe('uplift');
    expect(tierOf('paired-2026-06-22')).toBe('other');
  });
});

describe('aggregate', () => {
  it('pools conditions across runs of a tier, weighted by n', () => {
    fakeRun('paired-hard-a', [
      { label: 'baseline', n: 10, successRate: 0.5, meanTokens: 1000 },
      { label: 'uap-full', n: 10, successRate: 0.8, meanTokens: 2000 },
    ]);
    fakeRun('paired-hard-b', [
      { label: 'baseline', n: 30, successRate: 0.9, meanTokens: 3000 },
    ]);
    const rows = aggregate(dir);
    const base = rows.find((r) => r.tier === 'hard' && r.condition === 'baseline');
    expect(base?.n).toBe(40);
    expect(base?.successRate).toBeCloseTo((0.5 * 10 + 0.9 * 30) / 40);
    expect(base?.meanTokens).toBeCloseTo((1000 * 10 + 3000 * 30) / 40);
    expect(base?.runs).toHaveLength(2);
  });

  it('ignores zero-token conditions in the token mean (legacy runs record 0)', () => {
    fakeRun('paired-medium-old', [{ label: 'baseline', n: 10, successRate: 0.5, meanTokens: 0 }]);
    fakeRun('paired-medium-new', [{ label: 'baseline', n: 10, successRate: 0.5, meanTokens: 4000 }]);
    const row = aggregate(dir).find((r) => r.tier === 'medium');
    expect(row?.meanTokens).toBe(4000); // not dragged to 2000
  });

  it('marks rows underpowered unless EVERY contributing run is usable', () => {
    fakeRun('paired-hard-a', [{ label: 'baseline', n: 5, successRate: 0.5, meanTokens: 100 }], { usable: true });
    fakeRun('paired-hard-b', [{ label: 'baseline', n: 5, successRate: 0.5, meanTokens: 100 }], { usable: false });
    expect(aggregate(dir)[0].statuses).toEqual(['ok', 'underpowered']);
  });

  it('distinguishes legacy runs (no discrimination block) from underpowered ones', () => {
    const runDir = join(dir, 'paired-hard-legacy');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'report.json'),
      JSON.stringify({
        report: {
          meta: { model: 'm', conditions: ['baseline'], taskCount: 5 },
          perCondition: [{ label: 'baseline', n: 5, successRate: 0.5, meanTokens: 100, meanTurns: 1, meanLatencyMs: 1, errorRate: 0.5 }],
          // no discrimination key at all
        },
      }),
    );
    expect(aggregate(dir)[0].statuses).toEqual(['unknown']);
  });

  it('skips runs with corrupt or missing reports', () => {
    mkdirSync(join(dir, 'broken'), { recursive: true });
    writeFileSync(join(dir, 'broken', 'report.json'), '{nope');
    fakeRun('paired-hard-ok', [{ label: 'baseline', n: 5, successRate: 0.5, meanTokens: 100 }]);
    const rows = aggregate(dir);
    expect(rows).toHaveLength(1);
  });
});

describe('renderMarkdown', () => {
  it('renders the published table with the underpowered caveat', () => {
    fakeRun('paired-brutal-x', [
      { label: 'baseline', n: 10, successRate: 0.261, meanTokens: 7448 },
      { label: 'uap-full', n: 10, successRate: 0.568, meanTokens: 31513 },
    ]);
    const md = renderMarkdown(aggregate(dir));
    expect(md).toContain('| brutal | baseline | 10 | 26.1% | 7448 |');
    expect(md).toContain('| brutal | uap-full | 10 | 56.8% | 31513 |');
    expect(md).toContain('⚠ underpowered');
    expect(md).toContain('npm run bench:ladder');
  });

  it('renders an em-dash for legacy zero-token rows', () => {
    fakeRun('paired-deliver-a', [{ label: 'baseline', n: 5, successRate: 0.4, meanTokens: 0 }]);
    const md = renderMarkdown(aggregate(dir));
    expect(md).toContain('| deliver | baseline | 5 | 40.0% | — |');
  });

  it('renders a stable machine-independent Source label', () => {
    fakeRun('paired-hard-a', [{ label: 'baseline', n: 5, successRate: 0.5, meanTokens: 100 }]);
    const md = renderMarkdown(aggregate(dir));
    expect(md).toContain('Source: `benchmark-results/`');
    expect(md).not.toContain(dir); // never the resolved absolute path
  });

  it('renders ⚠ unknown for legacy runs without a discrimination block', () => {
    const runDir = join(dir, 'paired-hard-legacy');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'report.json'),
      JSON.stringify({
        report: {
          meta: { model: 'm', conditions: ['baseline'], taskCount: 5 },
          perCondition: [{ label: 'baseline', n: 5, successRate: 0.5, meanTokens: 100, meanTurns: 1, meanLatencyMs: 1, errorRate: 0.5 }],
        },
      }),
    );
    expect(renderMarkdown(aggregate(dir))).toContain('⚠ unknown');
  });
});

describe('resolveResultsDir', () => {
  it('prefers the explicit flag, then cwd, then the main checkout fallback', () => {
    const explicit = mkdtempSync(join(tmpdir(), 'uap-ladder-explicit-'));
    mkdirSync(join(explicit, 'benchmark-results'));
    expect(resolveResultsDir(dir, join(explicit, 'benchmark-results'))).toBe(join(explicit, 'benchmark-results'));
    mkdirSync(join(dir, 'benchmark-results'));
    expect(resolveResultsDir(dir)).toBe(join(dir, 'benchmark-results'));
    expect(resolveResultsDir(dir, '/nonexistent')).toBeNull();
    rmSync(explicit, { recursive: true, force: true });
  });

  it('falls back to the main checkout when run inside a worktree', () => {
    // Hermetic fixture: a real main checkout with benchmark-results/ plus a
    // real linked worktree without it. (Depending on THIS repo's untracked,
    // git-ignored benchmark-results/ made the test pass locally and fail on a
    // fresh CI clone.)
    const main = mkdtempSync(join(tmpdir(), 'uap-ladder-main-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: main });
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: main });
      mkdirSync(join(main, 'benchmark-results'));
      const wt = join(main, 'wt');
      execFileSync('git', ['worktree', 'add', '-q', '--detach', wt], { cwd: main });
      expect(resolveResultsDir(wt)).toBe(join(main, 'benchmark-results'));
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });
});

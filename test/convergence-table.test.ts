import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  converge,
  summarizeEscalations,
  convergeDelivery,
  findRunDirs,
  readRun,
  buildReport,
  renderMarkdown,
} from '../scripts/convergence-table.js';
import type { AttemptRow, DeliverRow } from '../scripts/convergence-table.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uap-convergence-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const attempt = (
  taskId: string,
  condition: string,
  correct: boolean,
  turns: number,
  error = false
): AttemptRow => ({ taskId, condition, correct, turns, error });

describe('E.1 converge — paired-corpus convergence metrics', () => {
  it('computes pass@1, pass@N, best-of-N win, iterations-to-done, and cut rate', () => {
    const attempts: AttemptRow[] = [
      // task A: 3 attempts, 1 correct (pass@1 = 1/3, pass@3 = 1)
      attempt('A', 'baseline', true, 4),
      attempt('A', 'baseline', false, 9, true),
      attempt('A', 'baseline', false, 12),
      // task B: 3 attempts, 0 correct (0 and 0) — all cut by error
      attempt('B', 'baseline', false, 7, true),
      attempt('B', 'baseline', false, 8, true),
      attempt('B', 'baseline', false, 6, true),
      // task C: 2 attempts, 2 correct (1 and 1)
      attempt('C', 'baseline', true, 2),
      attempt('C', 'baseline', true, 6),
      // other condition: one task, always correct
      attempt('X', 'uap-full', true, 1),
      attempt('X', 'uap-full', true, 1),
    ];
    const rows = converge(attempts);
    expect(rows.map((r) => r.condition)).toEqual(['baseline', 'uap-full']);

    const base = rows[0];
    expect(base.tasks).toBe(3);
    expect(base.attempts).toBe(8);
    // pass@1 per task: A 1/3, B 0, C 1 → mean 4/9
    expect(base.pass1).toBeCloseTo(4 / 9, 10);
    // pass@N per task: A 1, B 0, C 1 → mean 2/3
    expect(base.passN).toBeCloseTo(2 / 3, 10);
    expect(base.bestOfNWin).toBeCloseTo(2 / 3 - 4 / 9, 10);
    // iterations-to-done: turns on correct attempts (4, 2, 6) → 4
    expect(base.iterationsToDone).toBe(4);
    expect(base.correctAttempts).toBe(3);
    // 4 of 8 attempts errored
    expect(base.cutRate).toBe(0.5);

    const full = rows[1];
    expect(full.tasks).toBe(1);
    expect(full.pass1).toBe(1);
    expect(full.passN).toBe(1);
    // best-of-N cannot win when every attempt already passed
    expect(full.bestOfNWin).toBe(0);
  });

  it('leaves iterations-to-done undefined (null) when nothing passed — never 0', () => {
    const rows = converge([attempt('A', 'baseline', false, 5), attempt('A', 'baseline', false, 6)]);
    expect(rows[0].iterationsToDone).toBeNull();
    expect(rows[0].correctAttempts).toBe(0);
    expect(rows[0].pass1).toBe(0);
    expect(rows[0].passN).toBe(0);
  });
});

describe('E.1 summarizeEscalations — the uplift 1.4 ledger', () => {
  it('summarizes valid lines per tier and skips malformed ones', () => {
    const lines = [
      JSON.stringify({ tier: 'frontier-prior', round: 3, timestamp: '2026-11-23T00:00:00Z' }),
      'not json at all',
      JSON.stringify({ tier: 'frontier-prior', round: 5 }),
      JSON.stringify({ tier: 'sota-prior', round: 2 }),
      '',
      JSON.stringify({ tier: 'missing-round' }), // round absent — skipped
    ];
    const s = summarizeEscalations(lines);
    expect(s).not.toBeNull();
    expect(s!.total).toBe(3);
    expect(s!.byTier[0]).toEqual({ tier: 'frontier-prior', count: 2, meanRound: 4 });
    expect(s!.byTier[1]).toEqual({ tier: 'sota-prior', count: 1, meanRound: 2 });
  });

  it('returns null for an empty or wholly malformed ledger', () => {
    expect(summarizeEscalations([])).toBeNull();
    expect(summarizeEscalations(['garbage'])).toBeNull();
  });
});

describe('E.1 convergeDelivery — the O1 corpus per model', () => {
  it('computes cut rate, mean turns, and mean best gates per model', () => {
    const rows: DeliverRow[] = [
      { outcome: 'delivered', turns: 2, gatesPct: 100, model: 'qwen35-a3b', task: 't1', source: 's' },
      { outcome: 'stopped', turns: 5, gatesPct: 83, model: 'qwen35-a3b', task: 't2', source: 's' },
      { outcome: 'not-delivered', turns: 17, gatesPct: 83, model: 'qwen35-a3b', task: 't3', source: 's' },
      { outcome: 'stopped', turns: 1, gatesPct: 67, model: 'opus-4.8', task: 't4', source: 's' },
    ];
    const conv = convergeDelivery(rows);
    expect(conv.map((m) => m.model)).toEqual(['qwen35-a3b', 'opus-4.8']); // by run count
    const q = conv[0];
    expect(q.runs).toBe(3);
    expect(q.delivered).toBe(1);
    expect(q.stopped).toBe(1);
    expect(q.notDelivered).toBe(1);
    expect(q.cutRate).toBeCloseTo(2 / 3, 10);
    expect(q.meanTurns).toBeCloseTo(24 / 3, 10);
    expect(q.meanGatesPct).toBeCloseTo((100 + 83 + 83) / 3, 10);
    const o = conv[1];
    expect(o.cutRate).toBe(1);
  });
});

describe('E.1 run discovery — flat and nested benchmark-results layouts', () => {
  it('finds flat run dirs and nested arm dirs, and attributes run/arm correctly', () => {
    // Flat: <root>/<run>/{report.json,records.jsonl}
    mkdirSync(join(dir, 'paired-2026-01-01'));
    writeRun(join(dir, 'paired-2026-01-01'), 'local-auto', 2, 'ok', true);
    // Nested: <root>/<run>/<arm>/{report.json,records.jsonl}
    mkdirSync(join(dir, 'o7-pilot'), { recursive: true });
    mkdirSync(join(dir, 'o7-pilot', 'armB'));
    writeRun(join(dir, 'o7-pilot', 'armB'), 'local-auto', 3, 'underpowered', false);

    const found = findRunDirs(dir);
    expect(found).toHaveLength(2);

    const flat = readRun(join(dir, 'paired-2026-01-01'), dir);
    expect(flat!.run).toBe('paired-2026-01-01');
    expect(flat!.arm).toBeNull();
    expect(flat!.discriminationStatus).toBe('ok');
    expect(flat!.discriminationUsable).toBe(true);

    const nested = readRun(join(dir, 'o7-pilot', 'armB'), dir);
    expect(nested!.run).toBe('o7-pilot');
    expect(nested!.arm).toBe('armB');
    expect(nested!.discriminationStatus).toBe('underpowered');
    expect(nested!.conditions.length).toBeGreaterThan(0);
  });

  it('skips dirs without both report.json and records.jsonl', () => {
    mkdirSync(join(dir, 'incomplete'));
    writeFileSync(join(dir, 'incomplete', 'report.json'), '{}');
    expect(findRunDirs(dir)).toHaveLength(0);
    expect(readRun(join(dir, 'incomplete'), dir)).toBeNull();
  });
});

describe('E.1 buildReport + renderMarkdown — the published table', () => {
  it('renders all four sections with the house-rule framing', () => {
    mkdirSync(join(dir, 'run1'));
    writeRun(join(dir, 'run1'), 'local-auto', 2, 'underpowered', false);
    const delivery: DeliverRow[] = [
      { outcome: 'stopped', turns: 1, gatesPct: 67, model: 'qwen35-a3b', task: 't', source: 's' },
    ];
    const ledger = [JSON.stringify({ tier: 'frontier-prior', round: 3 })];
    const ladder = {
      totalRuns: 2,
      summaries: [
        {
          tier: 'visual-scene/frontier-prior',
          runs: 2,
          tierReached: 1,
          cutRate: 0.5,
          escalationRate: 0.5,
          meanRoundsToTier: 3.5,
          winnerPassRate: 0.5,
          meanCandidates: 4,
        },
        {
          tier: 'doc-style/shipped',
          runs: 1,
          tierReached: 0,
          cutRate: 1,
          escalationRate: 0,
          meanRoundsToTier: null,
          winnerPassRate: 0,
          meanCandidates: 2,
        },
      ],
    };
    const report = buildReport(dir, delivery, ledger, '2026-11-23T00:00:00Z', ladder);
    expect(report.pairedRuns).toHaveLength(1);
    expect(report.deliveryReachable).toBe(true);
    expect(report.escalations!.total).toBe(1);
    expect(report.ladder!.totalRuns).toBe(2);

    const md = renderMarkdown(report);
    expect(md).toContain('## Paired-harness convergence');
    expect(md).toContain('underpowered (⚠)');
    expect(md).toContain('## Delivery-gate convergence (O1 corpus, descriptive)');
    expect(md).toContain('## Quality-ladder convergence (per tier — the class dimension)');
    expect(md).toContain('visual-scene/frontier-prior');
    // a tier nothing reached renders rounds-to-tier as the em-dash, not 0
    expect(md).toContain('| doc-style/shipped | 1 | 0 | 100.0% | 0.0% | — | 0.0% | 2.0 |');
    expect(md).toContain('## Escalation ledger');
    expect(md).toContain('## Quality-class coverage');
    expect(md).toContain('Descriptive by construction');
  });

  it('renders honest absence notes when sources are missing', () => {
    // ladder omitted -> unreachable note (same wording family as the corpus one)
    const report = buildReport(null, null, null, '2026-11-23T00:00:00Z');
    const md = renderMarkdown(report);
    expect(md).toContain('No paired runs');
    expect(md).toContain('unreachable');
    expect(md).toContain('`uap quality convergence` unreachable');
    expect(md).toContain('No escalations recorded yet');

    // ladder reachable but empty -> the no-runs-yet note, not an error
    const empty = buildReport(null, null, null, '2026-11-23T00:00:00Z', { totalRuns: 0, summaries: [] });
    expect(renderMarkdown(empty)).toContain('No ladder runs recorded yet');
  });
});

/** Minimal fixture writer: one report.json + records.jsonl pair. */
function writeRun(
  runDir: string,
  model: string,
  epochs: number,
  discriminationStatus: string,
  usable: boolean
): void {
  const report = {
    report: {
      meta: { model, adapter: 'deliver', epochs, taskCount: 1, conditions: ['baseline'] },
      discrimination: { status: discriminationStatus, usable },
      perCondition: [],
      comparisons: [],
      pareto: [],
    },
  };
  writeFileSync(join(runDir, 'report.json'), JSON.stringify(report));
  const records = [
    { taskId: 'T1', condition: 'baseline', metrics: { correct: true, turns: 2, error: false } },
    { taskId: 'T1', condition: 'baseline', metrics: { correct: false, turns: 5, error: true } },
  ];
  writeFileSync(join(runDir, 'records.jsonl'), records.map((r) => JSON.stringify(r)).join('\n'));
}

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordLadderRun,
  summarizeLadderRuns,
} from '../../src/quality/tier-ladder.js';
import { tiersPath } from '../../src/quality/tiers.js';

/**
 * Wave 2.1 convergence telemetry: every ladder run lands in
 * .uap/quality/convergence.jsonl, and the aggregate is the promotion-budget
 * evidence for the tier gate's shadow→block decision.
 */
describe('ladder convergence telemetry', () => {
  let projectRoot: string;
  let logPath: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'uap-ladder-convergence-'));
    mkdirSync(join(projectRoot, '.uap', 'quality'), { recursive: true });
    logPath = join(projectRoot, '.uap', 'quality', 'convergence.jsonl');
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('records one JSONL line per run beside the tiers store', () => {
    const returned = recordLadderRun(projectRoot, {
      tier: 'doc-style/v2-51-1',
      outcome: 'tier-reached',
      rounds: 3,
      candidatesMeasured: 9,
      winnerPassed: true,
      escalationFired: false,
      model: 'qwen3.8-flash-next',
    });
    expect(returned).toBe(tiersPath(projectRoot).replace(/tiers\.json$/, 'convergence.jsonl'));
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(1);
    const rec = JSON.parse(lines[0]) as { endedAt: string; tier: string };
    expect(rec.tier).toBe('doc-style/v2-51-1');
    expect(rec.endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('aggregates the promotion budget per tier', () => {
    recordLadderRun(projectRoot, {
      tier: 'api-behavior/fable-high',
      outcome: 'tier-reached',
      rounds: 3,
      candidatesMeasured: 9,
      winnerPassed: true,
      escalationFired: false,
      model: 'm1',
    });
    recordLadderRun(projectRoot, {
      tier: 'api-behavior/fable-high',
      outcome: 'cut-exhausted',
      rounds: 5,
      candidatesMeasured: 15,
      winnerPassed: false,
      escalationFired: true,
      model: 'm1',
    });
    recordLadderRun(projectRoot, {
      tier: 'visual-scene/fable-high',
      outcome: 'cut-unmeasurable',
      rounds: 1,
      candidatesMeasured: 0,
      winnerPassed: null,
      escalationFired: false,
      model: null,
    });

    const { summaries, totalRuns } = summarizeLadderRuns(projectRoot);
    expect(totalRuns).toBe(3);
    expect(summaries.length).toBe(2);
    const api = summaries[0]; // most runs first
    expect(api.tier).toBe('api-behavior/fable-high');
    expect(api.runs).toBe(2);
    expect(api.tierReached).toBe(1);
    expect(api.cutRate).toBe(0.5);
    expect(api.escalationRate).toBe(0.5);
    expect(api.meanRoundsToTier).toBe(3);
    expect(api.winnerPassRate).toBe(0.5);
    expect(api.meanCandidates).toBe(12);
    const visual = summaries[1];
    expect(visual.tier).toBe('visual-scene/fable-high');
    // No run reported a winner — the win rate is 0 over 0 measured, and
    // rounds-to-tier stays null (never fabricated from cuts).
    expect(visual.winnerPassRate).toBe(0);
    expect(visual.meanRoundsToTier).toBeNull();
  });

  it('skips corrupt lines and reports an absent log honestly', () => {
    writeFileSync(logPath, 'not json\n\n{"tier":"t","outcome":"tier-reached","rounds":2,"candidatesMeasured":4,"winnerPassed":true,"escalationFired":false,"endedAt":"now"}\n');
    const { summaries, totalRuns } = summarizeLadderRuns(projectRoot);
    expect(totalRuns).toBe(1);
    expect(summaries[0].runs).toBe(1);

    const empty = summarizeLadderRuns(join(projectRoot, 'no-log-here'));
    expect(empty.totalRuns).toBe(0);
    expect(empty.summaries).toEqual([]);
  });
});

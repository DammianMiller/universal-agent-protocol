#!/usr/bin/env npx tsx
/**
 * Terminal-Bench 2.0 Comparison Report Generator
 *
 * Parses Harbor result.json files from baseline and UAP benchmark runs,
 * computes per-model deltas, category breakdowns, and task-level diffs.
 *
 * Usage:
 *   npx tsx scripts/generate-comparison-report.ts \
 *     --baseline benchmark-results/baseline_opus45_<ts> \
 *     --uap benchmark-results/uam_opus45_<ts> \
 *     --baseline benchmark-results/baseline_gpt52_<ts> \
 *     --uap benchmark-results/uam_gpt52_<ts> \
 *     --output benchmark-results/FULL_COMPARISON_<ts>.md \
 *     --timestamp <ts>
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';

// ============================================================================
// Types
// ============================================================================

interface HarborResult {
  id: string;
  started_at: string;
  finished_at: string | null;
  n_total_trials: number;
  stats: {
    n_trials: number;
    n_errors: number;
    evals: Record<string, {
      n_trials: number;
      n_errors: number;
      metrics: Array<{ mean: number }>;
      reward_stats: {
        reward: Record<string, string[]>;
      };
    }>;
  };
}

interface TaskStatus {
  taskName: string;
  passed: boolean;
  trialId: string;
}

interface RunSummary {
  jobName: string;
  model: string;
  config: 'baseline' | 'uap';
  totalTrials: number;
  errors: number;
  passed: TaskStatus[];
  failed: TaskStatus[];
  passRate: number;
}

interface ModelComparison {
  model: string;
  baseline: RunSummary | null;
  uap: RunSummary | null;
  uapWins: string[];
  baselineWins: string[];
  bothPass: string[];
  bothFail: string[];
  delta: number;
}

// ============================================================================
// Parse CLI args
// ============================================================================

function parseArgs(): { baselineDirs: string[]; uamDirs: string[]; output: string; timestamp: string } {
  const args = process.argv.slice(2);
  const baselineDirs: string[] = [];
  const uamDirs: string[] = [];
  let output = '';
  let timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--baseline': baselineDirs.push(args[++i]); break;
      case '--uap': uamDirs.push(args[++i]); break;
      case '--output': output = args[++i]; break;
      case '--timestamp': timestamp = args[++i]; break;
      case '--help':
        console.log('Usage: npx tsx generate-comparison-report.ts --baseline <dir> --uap <dir> [--output <file>] [--timestamp <ts>]');
        process.exit(0);
    }
  }

  if (baselineDirs.length === 0 && uamDirs.length === 0) {
    console.error('Error: Provide at least one --baseline or --uap directory');
    process.exit(1);
  }

  if (!output) {
    output = `benchmark-results/FULL_COMPARISON_${timestamp}.md`;
  }

  return { baselineDirs, uamDirs, output, timestamp };
}

// ============================================================================
// Parse Harbor results
// ============================================================================

function extractModelFromJobName(jobName: string): string {
  // Job names follow pattern: (baseline|uap)_<model_short>_<timestamp>
  // e.g. baseline_opus45_20260213_120000, uam_gpt52_20260213_120000
  // Also handles legacy names like uam_v200_optb_full89, opus45_baseline_no_uam
  const modelAliases: Record<string, string> = {
    opus45: 'claude-opus-4-5',
    opus_4_5: 'claude-opus-4-5',
    'claude-opus': 'claude-opus-4-5',
    gpt52: 'gpt-5.2-codex',
    'gpt-5': 'gpt-5.2-codex',
    glm47: 'glm-4.7',
    'glm-4': 'glm-4.7',
  };

  for (const [alias, fullName] of Object.entries(modelAliases)) {
    if (jobName.includes(alias)) return fullName;
  }

  // For UAP version runs without model in name, default to Opus 4.5 (most common)
  if (/^uam_v\d+/.test(jobName)) return 'claude-opus-4-5';

  return 'unknown';
}

function extractModelFromEvalKey(evalKey: string): string {
  // Format can be: agent__model__dataset (3 parts) or agent__dataset (2 parts)
  const parts = evalKey.split('__');
  if (parts.length >= 3) return parts[1];
  return '';
}

function parseResultDir(dir: string, config: 'baseline' | 'uap'): RunSummary | null {
  const resultPath = join(dir, 'result.json');
  if (!existsSync(resultPath)) {
    console.warn(`  Warning: ${resultPath} not found`);
    return null;
  }

  const data: HarborResult = JSON.parse(readFileSync(resultPath, 'utf-8'));
  const jobName = basename(dir);

  const evalKeys = Object.keys(data.stats.evals);
  if (evalKeys.length === 0) {
    console.warn(`  Warning: No evals in ${resultPath}`);
    return null;
  }

  const evalKey = evalKeys[0];
  // Try model from eval key first, fall back to job name
  const model = extractModelFromEvalKey(evalKey) || extractModelFromJobName(jobName);
  const evalData = data.stats.evals[evalKey];

  const rewards = evalData.reward_stats?.reward || {};
  const passedTrials = rewards['1.0'] || [];
  const failedTrials = rewards['0.0'] || [];

  const passed: TaskStatus[] = passedTrials.map((t: string) => ({
    taskName: t.split('__')[0],
    passed: true,
    trialId: t,
  }));

  const failed: TaskStatus[] = failedTrials.map((t: string) => ({
    taskName: t.split('__')[0],
    passed: false,
    trialId: t,
  }));

  const total = passed.length + failed.length;
  const passRate = total > 0 ? (passed.length / total) * 100 : 0;

  return {
    jobName,
    model,
    config,
    totalTrials: data.stats.n_trials,
    errors: data.stats.n_errors,
    passed,
    failed,
    passRate,
  };
}

function extractTaskNames(tasks: TaskStatus[]): Set<string> {
  return new Set(tasks.map(t => t.taskName));
}

// ============================================================================
// Build comparisons
// ============================================================================

function buildModelComparison(baseline: RunSummary | null, uap: RunSummary | null): ModelComparison {
  const model = baseline?.model || uap?.model || 'unknown';

  const bPassed = baseline ? extractTaskNames(baseline.passed) : new Set<string>();
  const bFailed = baseline ? extractTaskNames(baseline.failed) : new Set<string>();
  const uPassed = uap ? extractTaskNames(uap.passed) : new Set<string>();
  const uFailed = uap ? extractTaskNames(uap.failed) : new Set<string>();

  const uapWins = [...uPassed].filter(t => !bPassed.has(t)).sort();
  const baselineWins = [...bPassed].filter(t => !uPassed.has(t)).sort();
  const bothPass = [...bPassed].filter(t => uPassed.has(t)).sort();
  const bothFail = [...bFailed].filter(t => uFailed.has(t)).sort();

  const bRate = baseline?.passRate || 0;
  const uRate = uap?.passRate || 0;
  const delta = uRate - bRate;

  return { model, baseline, uap, uapWins, baselineWins, bothPass, bothFail, delta };
}

// ============================================================================
// Binomial test (approximate)
// ============================================================================

function binomialPValue(wins: number, losses: number): string {
  const n = wins + losses;
  if (n === 0) return 'N/A';
  // Simple sign test approximation
  const p = Math.min(wins, losses);
  // Use normal approximation for binomial test
  const expected = n / 2;
  const stddev = Math.sqrt(n * 0.25);
  if (stddev === 0) return 'N/A';
  const z = Math.abs(p - expected) / stddev;
  // Rough 2-sided p-value from z-score
  if (z < 1.645) return '>0.10';
  if (z < 1.96) return '<0.10';
  if (z < 2.576) return '<0.05';
  return '<0.01';
}

// ============================================================================
// Generate markdown report
// ============================================================================

function generateReport(
  comparisons: ModelComparison[],
  timestamp: string,
): string {
  const lines: string[] = [];

  lines.push('# Terminal-Bench 2.0 Full Comparison: UAP v3.1.0 vs Baseline');
  lines.push('');
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Dataset:** Terminal-Bench 2.0 (89 tasks)`);
  lines.push(`**UAP Version:** 3.1.0`);
  lines.push(`**Benchmark ID:** ${timestamp}`);
  lines.push('');

  // Executive summary
  lines.push('## Executive Summary');
  lines.push('');
  lines.push('| Model | Baseline | UAP | Delta | UAP Wins | Baseline Wins | p-value |');
  lines.push('|-------|----------|-----|-------|----------|---------------|---------|');

  for (const c of comparisons) {
    const bRate = c.baseline ? `${c.baseline.passRate.toFixed(1)}% (${c.baseline.passed.length}/${c.baseline.passed.length + c.baseline.failed.length})` : 'N/A';
    const uRate = c.uap ? `${c.uap.passRate.toFixed(1)}% (${c.uap.passed.length}/${c.uap.passed.length + c.uap.failed.length})` : 'N/A';
    const delta = c.baseline && c.uap ? `${c.delta >= 0 ? '+' : ''}${c.delta.toFixed(1)}%` : 'N/A';
    const pval = binomialPValue(c.uapWins.length, c.baselineWins.length);
    lines.push(`| ${c.model} | ${bRate} | ${uRate} | **${delta}** | ${c.uapWins.length} | ${c.baselineWins.length} | ${pval} |`);
  }

  lines.push('');

  // Aggregate stats
  const totalUamWins = comparisons.reduce((s, c) => s + c.uapWins.length, 0);
  const totalBaselineWins = comparisons.reduce((s, c) => s + c.baselineWins.length, 0);
  const netTasks = totalUamWins - totalBaselineWins;

  lines.push(`**Across all models:** UAP wins ${totalUamWins} tasks, Baseline wins ${totalBaselineWins} tasks, Net: ${netTasks >= 0 ? '+' : ''}${netTasks} tasks for UAP.`);
  lines.push('');

  // Per-model detailed sections
  for (const c of comparisons) {
    lines.push(`---`);
    lines.push('');
    lines.push(`## ${c.model}`);
    lines.push('');

    if (c.baseline) {
      lines.push(`- **Baseline:** ${c.baseline.passRate.toFixed(1)}% (${c.baseline.passed.length} passed, ${c.baseline.failed.length} failed, ${c.baseline.errors} errors)`);
    }
    if (c.uap) {
      lines.push(`- **UAP:** ${c.uap.passRate.toFixed(1)}% (${c.uap.passed.length} passed, ${c.uap.failed.length} failed, ${c.uap.errors} errors)`);
    }
    if (c.baseline && c.uap) {
      lines.push(`- **Net Delta:** ${c.delta >= 0 ? '+' : ''}${c.delta.toFixed(1)}% (${c.uapWins.length - c.baselineWins.length >= 0 ? '+' : ''}${c.uapWins.length - c.baselineWins.length} tasks)`);
    }
    lines.push('');

    // UAP wins
    if (c.uapWins.length > 0) {
      lines.push('### Tasks UAP Wins (pass with UAP, fail without)');
      lines.push('');
      for (const t of c.uapWins) {
        lines.push(`- \`${t}\``);
      }
      lines.push('');
    }

    // Baseline wins
    if (c.baselineWins.length > 0) {
      lines.push('### Tasks Baseline Wins (pass without UAP, fail with)');
      lines.push('');
      for (const t of c.baselineWins) {
        lines.push(`- \`${t}\``);
      }
      lines.push('');
    }

    // Full task-level diff table
    if (c.baseline && c.uap) {
      const allTasks = new Set([
        ...c.baseline.passed.map(t => t.taskName),
        ...c.baseline.failed.map(t => t.taskName),
        ...c.uap.passed.map(t => t.taskName),
        ...c.uap.failed.map(t => t.taskName),
      ]);

      const bPassSet = extractTaskNames(c.baseline.passed);
      const uPassSet = extractTaskNames(c.uap.passed);

      lines.push('### Full Task Comparison');
      lines.push('');
      lines.push('| Task | Baseline | UAP | Delta |');
      lines.push('|------|----------|-----|-------|');

      for (const t of [...allTasks].sort()) {
        const bStatus = bPassSet.has(t) ? 'PASS' : 'FAIL';
        const uStatus = uPassSet.has(t) ? 'PASS' : 'FAIL';
        let delta = '=';
        if (bStatus === 'FAIL' && uStatus === 'PASS') delta = '**+UAP**';
        if (bStatus === 'PASS' && uStatus === 'FAIL') delta = '**-UAP**';
        lines.push(`| ${t} | ${bStatus} | ${uStatus} | ${delta} |`);
      }
      lines.push('');
    }
  }

  // Cross-model analysis
  if (comparisons.length > 1) {
    lines.push('---');
    lines.push('');
    lines.push('## Cross-Model Analysis');
    lines.push('');

    // Which tasks does UAP help consistently across models?
    const uamWinSets = comparisons.map(c => new Set(c.uapWins));
    const baselineWinSets = comparisons.map(c => new Set(c.baselineWins));

    if (uamWinSets.length >= 2) {
      const consistentUamWins = [...uamWinSets[0]].filter(t => uamWinSets.every(s => s.has(t)));
      const consistentBaselineWins = [...baselineWinSets[0]].filter(t => baselineWinSets.every(s => s.has(t)));

      if (consistentUamWins.length > 0) {
        lines.push(`**Tasks where UAP helps across ALL models:** ${consistentUamWins.join(', ')}`);
        lines.push('');
      }
      if (consistentBaselineWins.length > 0) {
        lines.push(`**Tasks where UAP hurts across ALL models:** ${consistentBaselineWins.join(', ')}`);
        lines.push('');
      }
    }

    // Which model benefits most from UAP?
    const sorted = [...comparisons].sort((a, b) => b.delta - a.delta);
    lines.push('**Model benefit ranking (most to least improvement from UAP):**');
    lines.push('');
    for (const c of sorted) {
      lines.push(`1. **${c.model}**: ${c.delta >= 0 ? '+' : ''}${c.delta.toFixed(1)}% (${c.uapWins.length} wins, ${c.baselineWins.length} losses)`);
    }
    lines.push('');
  }

  // Methodology
  lines.push('---');
  lines.push('');
  lines.push('## Methodology');
  lines.push('');
  lines.push('- **Baseline:** `harbor run` with `--ak "system_prompt="` to clear UAP context');
  lines.push('- **UAP:** `harbor run` with default CLAUDE.md and UAP memory system active');
  lines.push('- **Dataset:** Terminal-Bench 2.0 (89 tasks across systems, ML, security, algorithms)');
  lines.push('- **Scoring:** Binary pass/fail per task based on Harbor reward (1.0 = pass, 0.0 = fail)');
  lines.push('- **Statistical test:** Sign test on UAP-wins vs Baseline-wins (binomial, 2-sided)');
  lines.push('');
  lines.push('---');
  lines.push(`*Report generated by \`scripts/generate-comparison-report.ts\` at ${new Date().toISOString()}*`);

  return lines.join('\n');
}

// ============================================================================
// Main
// ============================================================================

function main(): void {
  const { baselineDirs, uamDirs, output, timestamp } = parseArgs();

  console.log('Parsing benchmark results...');

  const baselineRuns: RunSummary[] = [];
  const uapRuns: RunSummary[] = [];

  for (const dir of baselineDirs) {
    const run = parseResultDir(dir, 'baseline');
    if (run) {
      baselineRuns.push(run);
      console.log(`  Baseline: ${run.model} - ${run.passRate.toFixed(1)}% (${run.passed.length}/${run.passed.length + run.failed.length})`);
    }
  }

  for (const dir of uamDirs) {
    const run = parseResultDir(dir, 'uap');
    if (run) {
      uapRuns.push(run);
      console.log(`  UAP:      ${run.model} - ${run.passRate.toFixed(1)}% (${run.passed.length}/${run.passed.length + run.failed.length})`);
    }
  }

  // Match baseline and UAP runs by model
  const modelSet = new Set([
    ...baselineRuns.map(r => r.model),
    ...uapRuns.map(r => r.model),
  ]);

  const comparisons: ModelComparison[] = [];

  for (const model of modelSet) {
    const baseline = baselineRuns.find(r => r.model === model) || null;
    const uap = uapRuns.find(r => r.model === model) || null;
    comparisons.push(buildModelComparison(baseline, uap));
  }

  // Sort by model name for consistent output
  comparisons.sort((a, b) => a.model.localeCompare(b.model));

  // Generate report
  const report = generateReport(comparisons, timestamp);
  writeFileSync(output, report + '\n');
  console.log(`\nReport written to: ${output}`);
  console.log(`Models compared: ${comparisons.length}`);

  for (const c of comparisons) {
    const sym = c.delta >= 0 ? '+' : '';
    console.log(`  ${c.model}: ${sym}${c.delta.toFixed(1)}% (UAP wins ${c.uapWins.length}, Baseline wins ${c.baselineWins.length})`);
  }
}

main();

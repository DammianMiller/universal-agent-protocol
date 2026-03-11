#!/usr/bin/env tsx
/**
 * Qwen3.5 Baseline Benchmark (WITHOUT UAP/OpenCode)
 *
 * Tests Qwen3.5 WITHOUT any UAP context to establish baseline performance
 * This allows us to measure the actual improvement from UAP integration
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// ============================================================================
// CONFIGURATION
// ============================================================================

const PROJECT_ROOT = process.cwd();
const RESULTS_DIR = join(PROJECT_ROOT, 'benchmark-results', 'qwen35_baseline_no_uap');
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);

interface TaskConfig {
  name: string;
  category: string;
}

// Same tasks as UAP benchmark for fair comparison
const QUICK_TESTS: TaskConfig[] = [
  { name: 'crack-7z-hash', category: 'security' },
  { name: 'filter-js-from-html', category: 'security' },
  { name: 'password-recovery', category: 'security' },
  { name: 'sqlite-db-truncate', category: 'file-ops' },
  { name: 'extract-elf', category: 'file-ops' },
  { name: 'cobol-modernization', category: 'legacy' },
  { name: 'gpt2-codegolf', category: 'ml' },
  { name: 'code-from-image', category: 'coding' },
  { name: 'log-summary-date-ranges', category: 'coding' },
  { name: 'financial-document-processor', category: 'coding' },
  { name: 'chess-best-move', category: 'reasoning' },
];

// ============================================================================
// QWEN3.5 API CALLS (NO UAP CONTEXT)
// ============================================================================

const QWEN35_CONFIG = {
  baseUrl: 'http://localhost:8080/v1',
  apiKey: 'sk-qwen35b',
  modelName: 'qwen/qwen35-a3b-iq4xs',
};

interface Qwen35Result {
  content: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  duration_ms: number;
}

async function callQwen35(messages: any[], maxTokens: number = 2048): Promise<Qwen35Result> {
  const startTime = Date.now();

  try {
    const response = await fetch(`${QWEN35_CONFIG.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${QWEN35_CONFIG.apiKey}`,
      },
      body: JSON.stringify({
        model: QWEN35_CONFIG.modelName,
        messages: messages,
        max_tokens: maxTokens,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    return {
      content: data.choices[0].message.content,
      usage: data.usage,
      duration_ms: Date.now() - startTime,
    };
  } catch (error) {
    throw new Error(
      `Qwen3.5 API call failed: ${error instanceof Error ? error.message : String(error)} (${Date.now() - startTime}ms)`
    );
  }
}

// ============================================================================
// TASK EXECUTION (NO UAP CONTEXT)
// ============================================================================

interface BenchmarkResult {
  taskName: string;
  category: string;
  success: boolean;
  duration_ms: number;
  tokens_used: number;
  error?: string;
}

async function executeTask(task: TaskConfig): Promise<BenchmarkResult> {
  console.log(`\n[${task.category.toUpperCase()}] ${task.name} (NO UAP)`);

  const startTime = Date.now();

  // NO UAP CONTEXT - just the task
  const messages = [
    {
      role: 'system',
      content: `You are solving a Terminal-Bench task: ${task.name}. Provide your solution.`,
    },
    {
      role: 'user',
      content: `Solve this Terminal-Bench task: ${task.name}\n\nProvide your solution with clear steps.`,
    },
  ];

  try {
    const result = await callQwen35(messages, 4096);
    const duration_ms = Date.now() - startTime;

    // Simple success heuristic (same as UAP benchmark)
    const success =
      result.content.toLowerCase().includes('solution') ||
      result.content.toLowerCase().includes('answer') ||
      result.content.length > 100;

    return {
      taskName: task.name,
      category: task.category,
      success,
      duration_ms,
      tokens_used: result.usage.total_tokens,
    };
  } catch (error) {
    const duration_ms = Date.now() - startTime;
    return {
      taskName: task.name,
      category: task.category,
      success: false,
      duration_ms,
      tokens_used: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// RESULTS ANALYSIS
// ============================================================================

interface SummaryStats {
  totalTasks: number;
  completedTasks: number;
  successRate: number;
  avgDuration_ms: number;
  avgTokens: number;
  byCategory: Record<
    string,
    { total: number; success: number; avgDuration: number; avgTokens: number }
  >;
}

function analyzeResults(results: BenchmarkResult[]): SummaryStats {
  const stats: SummaryStats = {
    totalTasks: results.length,
    completedTasks: results.filter((r) => !r.error).length,
    successRate: 0,
    avgDuration_ms: 0,
    avgTokens: 0,
    byCategory: {},
  };

  if (results.length > 0) {
    const successful = results.filter((r) => r.success && !r.error);
    stats.successRate = (successful.length / results.length) * 100;
    stats.avgDuration_ms = results.reduce((sum, r) => sum + r.duration_ms, 0) / results.length;
    stats.avgTokens = results.reduce((sum, r) => sum + r.tokens_used, 0) / results.length;

    for (const result of results) {
      if (!result.error) {
        if (!stats.byCategory[result.category]) {
          stats.byCategory[result.category] = {
            total: 0,
            success: 0,
            avgDuration: 0,
            avgTokens: 0,
          };
        }
        stats.byCategory[result.category].total++;
        if (result.success) stats.byCategory[result.category].success++;
      }
    }

    for (const category of Object.keys(stats.byCategory)) {
      const catStats = stats.byCategory[category];
      catStats.avgDuration =
        catStats.total > 0
          ? results
              .filter((r) => r.category === category && !r.error)
              .reduce((sum, r) => sum + r.duration_ms, 0) / catStats.total
          : 0;
      catStats.avgTokens =
        catStats.total > 0
          ? results
              .filter((r) => r.category === category && !r.error)
              .reduce((sum, r) => sum + r.tokens_used, 0) / catStats.total
          : 0;
    }
  }

  return stats;
}

function printResults(results: BenchmarkResult[], stats: SummaryStats): void {
  console.log('\n' + '='.repeat(80));
  console.log('BASELINE BENCHMARK RESULTS (WITHOUT UAP)');
  console.log('='.repeat(80));

  console.log(`\n📊 Overall Statistics`);
  console.log(`   Total Tasks: ${stats.totalTasks}`);
  console.log(`   Completed: ${stats.completedTasks}`);
  console.log(`   Success Rate: ${stats.successRate.toFixed(1)}%`);
  console.log(`   Avg Duration: ${(stats.avgDuration_ms / 1000).toFixed(2)}s`);
  console.log(`   Avg Tokens: ${Math.round(stats.avgTokens)}`);

  console.log(`\n📁 Results by Category`);
  console.log('-'.repeat(80));
  for (const [category, catStats] of Object.entries(stats.byCategory)) {
    const successRate = catStats.total > 0 ? (catStats.success / catStats.total) * 100 : 0;
    console.log(`   ${category.toUpperCase()}`);
    console.log(
      `      Success: ${catStats.success}/${catStats.total} (${successRate.toFixed(1)}%)`
    );
    console.log(`      Avg Duration: ${(catStats.avgDuration / 1000).toFixed(2)}s`);
    console.log(`      Avg Tokens: ${Math.round(catStats.avgTokens)}`);
  }

  console.log(`\n📋 Individual Task Results`);
  console.log('-'.repeat(80));
  for (const result of results) {
    const status = result.error ? '❌ ERROR' : result.success ? '✅ SUCCESS' : '⚠️ PARTIAL';
    console.log(
      `   ${status} ${result.taskName.padEnd(30)} ${(result.duration_ms / 1000).toFixed(2)}s`
    );
    if (result.error) {
      console.log(`      Error: ${result.error}`);
    }
  }

  console.log('\n' + '='.repeat(80));
}

function saveResults(results: BenchmarkResult[], stats: SummaryStats, timestamp: string): void {
  mkdirSync(RESULTS_DIR, { recursive: true });

  const report = {
    timestamp,
    model: QWEN35_CONFIG.modelName,
    baseUrl: QWEN35_CONFIG.baseUrl,
    totalTasks: stats.totalTasks,
    successRate: stats.successRate,
    avgDuration_ms: stats.avgDuration_ms,
    avgTokens: stats.avgTokens,
    byCategory: stats.byCategory,
    individualResults: results,
  };

  const filePath = join(RESULTS_DIR, `qwen35_baseline_no_uap_${timestamp}.json`);
  writeFileSync(filePath, JSON.stringify(report, null, 2));
  console.log(`\n💾 Results saved to: ${filePath}`);
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<number> {
  console.log('='.repeat(80));
  console.log('Qwen3.5 BASELINE Benchmark (WITHOUT UAP/OpenCode)');
  console.log('='.repeat(80));
  console.log(`\nModel: ${QWEN35_CONFIG.modelName}`);
  console.log(`Endpoint: ${QWEN35_CONFIG.baseUrl}`);
  console.log(`Timestamp: ${TIMESTAMP}`);
  console.log('\n⚠️ Running WITHOUT UAP context to establish baseline...');
  console.log('Running quick tests (11 tasks)...');

  const results: BenchmarkResult[] = [];

  for (let i = 0; i < QUICK_TESTS.length; i++) {
    const task = QUICK_TESTS[i];
    console.log(`\n[${i + 1}/${QUICK_TESTS.length}] Running ${task.name}...`);

    try {
      const result = await executeTask(task);
      results.push(result);

      if (i < QUICK_TESTS.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      console.error(`Failed to run ${task.name}:`, error);
    }
  }

  const stats = analyzeResults(results);
  printResults(results, stats);
  saveResults(results, stats, TIMESTAMP);

  console.log('\n' + '='.repeat(80));
  console.log('BASELINE COMPLETE - Ready for comparison with UAP results');
  console.log('='.repeat(80));

  return stats.successRate;
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('Benchmark failed:', error);
    process.exit(1);
  });

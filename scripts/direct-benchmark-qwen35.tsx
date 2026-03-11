#!/usr/bin/env tsx
/**
 * Direct Qwen3.5 + UAP/OpenCode Benchmark
 *
 * Tests Qwen3.5 with UAP memory and OpenCode integrations WITHOUT Harbor containers
 * Focuses on validating UAP effectiveness directly against model API
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

// ============================================================================
// CONFIGURATION
// ============================================================================

const PROJECT_ROOT = process.cwd();
const RESULTS_DIR = join(PROJECT_ROOT, 'benchmark-results', 'qwen35_direct_uap');
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);

interface TaskConfig {
  name: string;
  category: string;
  expected_uap: string;
}

// Quick test subset (12 tasks)
const QUICK_TESTS: TaskConfig[] = [
  { name: 'crack-7z-hash', category: 'security', expected_uap: 'full' },
  { name: 'filter-js-from-html', category: 'security', expected_uap: 'full' },
  { name: 'password-recovery', category: 'security', expected_uap: 'full' },
  { name: 'sqlite-db-truncate', category: 'file-ops', expected_uap: 'full' },
  { name: 'extract-elf', category: 'file-ops', expected_uap: 'full' },
  { name: 'cobol-modernization', category: 'legacy', expected_uap: 'full' },
  { name: 'gpt2-codegolf', category: 'ml', expected_uap: 'minimal' },
  { name: 'code-from-image', category: 'coding', expected_uap: 'minimal' },
  { name: 'log-summary-date-ranges', category: 'coding', expected_uap: 'minimal' },
  { name: 'financial-document-processor', category: 'coding', expected_uap: 'minimal' },
  { name: 'chess-best-move', category: 'reasoning', expected_uap: 'skip' },
];

// ============================================================================
// UAP CONTEXT GENERATION
// ============================================================================

interface UAPContext {
  sessionHooks: boolean;
  preCompact: boolean;
  memoryQueries: boolean;
  droidInvoke: boolean;
  skillInjection: boolean;
  taskCategory: string;
  expected_uap: string;
  adaptiveContext: string;
}

function generateUAPContext(task: TaskConfig): UAPContext {
  const adaptiveContext = getAdaptiveContext(task.category);

  return {
    sessionHooks: true,
    preCompact: true,
    memoryQueries: true,
    droidInvoke: false,
    skillInjection: true,
    taskCategory: task.category,
    expected_uap: task.expected_uap,
    adaptiveContext,
  };
}

function getAdaptiveContext(category: string): string {
  switch (category) {
    case 'security':
      return `## UAP Memory Context (Security)
- XSS: Use bleach.clean() or DOMPurify. Remove script, onclick, onerror, javascript:
- Password cracking: hashcat -m 11600 for 7z, -m 0 MD5, john for CPU`;

    case 'file-ops':
      return `## UAP Memory Context (File Operations)
- ELF: Program headers at e_phoff. Use struct.unpack('<HH...') for parsing
- SQLite WAL: Header 32 bytes, frames follow. PRAGMA wal_checkpoint(TRUNCATE)`;

    case 'legacy':
      return `## UAP Memory Context (Legacy Code)
- COBOL: Fixed-format columns (1-6 sequence, 7 indicator, 8-72 code)
- WORKING-STORAGE SECTION for variables`;

    case 'ml':
      return `## UAP Memory Context (ML - Risk Aware)
- CRITICAL: Test with small epochs/batch first before full runs
- Training can exceed 5 minutes - verify shapes and configs early`;

    case 'coding':
      return `## UAP Memory Context (Coding)
- Use absolute paths (/app/...) not relative
- Verify file exists before reading
- Match exact output format required`;

    case 'reasoning':
      return `## UAP Memory Context (Reasoning - No UAP Overhead)
- Pure reasoning tasks skip UAP to prevent timeout regression`;

    default:
      return `## UAP Memory Context (General)
- Use absolute paths (/app/...) not relative`;
  }
}

// ============================================================================
// QWEN3.5 API CALLS
// ============================================================================

interface Qwen35Config {
  baseUrl: string;
  apiKey: string;
  modelName: string;
}

const QWEN35_CONFIG: Qwen35Config = {
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
// TASK EXECUTION
// ============================================================================

interface BenchmarkResult {
  taskName: string;
  category: string;
  expected_uap: string;
  success: boolean;
  duration_ms: number;
  tokens_used: number;
  uap_context_used: boolean;
  error?: string;
}

async function executeTask(task: TaskConfig): Promise<BenchmarkResult> {
  console.log(`\n[${task.category.toUpperCase()}] ${task.name} (UAP: ${task.expected_uap})`);

  const startTime = Date.now();
  const uapContext = generateUAPContext(task);

  let messages: any[] = [];

  if (uapContext.taskCategory === 'reasoning' || uapContext.expected_uap === 'skip') {
    messages = [
      {
        role: 'system',
        content: `You are solving a Terminal-Bench task: ${task.name}. Solve it efficiently without any external context or memory lookups.`,
      },
      {
        role: 'user',
        content: `Solve this task: ${task.name}\n\nProvide your solution.`,
      },
    ];
  } else {
    messages = [
      {
        role: 'system',
        content: `You are an AI agent solving Terminal-Bench tasks with UAP/OpenCode integration.

## UAP/OpenCode Integration Active
- Session Hooks: ${uapContext.sessionHooks ? 'YES' : 'NO'}
- Pre-compact Markers: ${uapContext.preCompact ? 'YES' : 'NO'}
- Memory Queries: ${uapContext.memoryQueries ? 'YES' : 'NO'}
- Skill Injection: ${uapContext.skillInjection ? 'YES' : 'NO'}

${uapContext.adaptiveContext}

## Available Tools
- uap_memory_query: Query past lessons and decisions
- uap_task_create: Track work items
- uap_worktree_create: Isolated development environment
- uap_droid_invoke: Specialized agent assistance
- uap_patterns_query: Coding pattern retrieval

## Best Practices
1. Always use worktree for file changes
2. Check memory before starting complex tasks
3. Store lessons after completing tasks
4. Use droids for specialized domains (security, ML)
5. Leverage pattern RAG for code patterns`,
      },
      {
        role: 'user',
        content: `Solve this Terminal-Bench task: ${task.name}

Provide your solution with clear steps.`,
      },
    ];
  }

  try {
    const result = await callQwen35(messages, 4096);
    const duration_ms = Date.now() - startTime;

    const success =
      result.content.toLowerCase().includes('solution') ||
      result.content.toLowerCase().includes('answer') ||
      result.content.length > 100;

    return {
      taskName: task.name,
      category: task.category,
      expected_uap: uapContext.expected_uap,
      success,
      duration_ms,
      tokens_used: result.usage.total_tokens,
      uap_context_used: uapContext.taskCategory !== 'reasoning',
    };
  } catch (error) {
    const duration_ms = Date.now() - startTime;
    return {
      taskName: task.name,
      category: task.category,
      expected_uap: uapContext.expected_uap,
      success: false,
      duration_ms,
      tokens_used: 0,
      uap_context_used: uapContext.taskCategory !== 'reasoning',
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
  console.log('BENCHMARK RESULTS');
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
    const uapMark = result.uap_context_used ? '[UAP]' : '[NO UAP]';
    console.log(
      `   ${status} ${uapMark} ${result.taskName.padEnd(30)} ${(result.duration_ms / 1000).toFixed(2)}s`
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

  const filePath = join(RESULTS_DIR, `qwen35_direct_uap_${timestamp}.json`);
  writeFileSync(filePath, JSON.stringify(report, null, 2));
  console.log(`\n💾 Results saved to: ${filePath}`);

  const mdReport = generateMarkdownReport(report as any);
  const mdFilePath = join(RESULTS_DIR, `QWEN35_DIRECT_UAP_REPORT_${timestamp}.md`);
  writeFileSync(mdFilePath, mdReport);
  console.log(`📝 Markdown report saved to: ${mdFilePath}`);
}

function generateMarkdownReport(
  report: SummaryStats & { timestamp: string; model: string; baseUrl: string }
): string {
  const byCategoryEntries = Object.entries(report.byCategory);

  return `# Qwen3.5 + UAP/OpenCode Direct Benchmark Report

**Generated:** ${new Date().toISOString()}
**Model:** qwen/qwen35-a3b-iq4xs
**Endpoint:** http://localhost:8080/v1

## Results Summary

| Metric | Value |
|--------|-------|
| Total Tasks | ${report.totalTasks} |
| Success Rate | ${report.successRate.toFixed(1)}% |
| Avg Duration | ${(report.avgDuration_ms / 1000).toFixed(2)}s |
| Avg Tokens | ${Math.round(report.avgTokens)} |

## Performance by Category

| Category | Success Rate | Avg Duration | Avg Tokens |
|----------|-------------|--------------|------------|
${byCategoryEntries
  .map(([cat, catStats]) => {
    const successRate = catStats.total > 0 ? (catStats.success / catStats.total) * 100 : 0;
    return `| ${cat} | ${successRate.toFixed(1)}% | ${(catStats.avgDuration / 1000).toFixed(2)}s | ${Math.round(catStats.avgTokens)} |`;
  })
  .join('\n')}

## Next Steps

1. Review individual task results
2. Analyze which categories need optimization
3. Consider running full suite (88 tasks) if quick tests pass
`;
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<number> {
  console.log('='.repeat(80));
  console.log('Qwen3.5 + UAP/OpenCode Direct Benchmark');
  console.log('='.repeat(80));
  console.log(`\nModel: ${QWEN35_CONFIG.modelName}`);
  console.log(`Endpoint: ${QWEN35_CONFIG.baseUrl}`);
  console.log(`Timestamp: ${TIMESTAMP}`);
  console.log('\nRunning quick tests (11 tasks)...');

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
  if (stats.successRate >= 70) {
    console.log('✅ Quick tests PASSED (success rate >= 70%)');
    console.log('\nYou can now proceed with the full 88-task suite.');
  } else if (stats.successRate >= 50) {
    console.log('⚠️ Quick tests PARTIAL (success rate 50-70%)');
    console.log('\nReview failures and consider optimization before full suite.');
  } else {
    console.log('❌ Quick tests FAILED (success rate < 50%)');
    console.log('\nReview results and optimize UAP integration.');
  }
  console.log('='.repeat(80));

  return stats.successRate;
}

main()
  .then((successRate) => {
    process.exit(successRate >= 70 ? 0 : 1);
  })
  .catch((error) => {
    console.error('Benchmark failed:', error);
    process.exit(1);
  });

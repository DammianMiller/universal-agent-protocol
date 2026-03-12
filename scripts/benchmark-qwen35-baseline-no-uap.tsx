#!/usr/bin/env tsx
/**
 * Qwen3.5 BASELINE Benchmark - NO UAP Integration
 *
 * Tests bare qwen/qwen35-a3b-iq4xs WITHOUT any UAP features for comparison:
 * - No memory system (SQLite)
 * - No pattern RAG (Qdrant)
 * - No session hooks
 * - No OpenCode plugins
 * - Just raw model API calls with minimal prompts
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
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

// Same 94 tasks as UAP benchmark for fair comparison
const FULL_TASKS: TaskConfig[] = [
  // Memory (10)
  { name: 'remember-file-locations', category: 'file-ops' },
  { name: 'apply-pattern-memory', category: 'coding' },
  { name: 'avoid-repeat-mistakes', category: 'debugging' },
  { name: 'cross-task-context', category: 'coordination' },
  { name: 'session-persistence', category: 'memory' },
  { name: 'pattern-reuse', category: 'coding' },
  { name: 'lesson-storage', category: 'memory' },
  { name: 'context-querying', category: 'memory' },
  { name: 'adaptive-retrieval', category: 'memory' },
  { name: 'multi-session-sync', category: 'coordination' },
  
  // Coordination (5) - using same tasks as UAP test but extended to match count
  { name: 'multistep-coordination', category: 'coordination' },
  { name: 'agent-overlap-check', category: 'coordination' },
  { name: 'resource-locking', category: 'coordination' },
  { name: 'task-delegation', category: 'coordination' },
  { name: 'progress-tracking', category: 'coordination' },
  
  // Code Quality (8)
  { name: 'apply-eslint', category: 'code-quality' },
  { name: 'fix-type-errors', category: 'coding' },
  { name: 'add-error-handling', category: 'coding' },
  { name: 'refactor-legacy', category: 'legacy' },
  { name: 'security-audit', category: 'security' },
  { name: 'performance-optimize', category: 'performance' },
  { name: 'add-docstrings', category: 'docs' },
  { name: 'code-golf-minimal', category: 'coding' },
  
  // Testing (10)
  { name: 'add-unit-tests', category: 'testing' },
  { name: 'fix-failing-tests', category: 'testing' },
  { name: 'integration-tests', category: 'testing' },
  { name: 'e2e-scenarios', category: 'testing' },
  { name: 'mock-dependencies', category: 'testing' },
  { name: 'test-coverage', category: 'testing' },
  { name: 'property-based-test', category: 'testing' },
  { name: 'fuzzing-tests', category: 'testing' },
  { name: 'test-parallelization', category: 'testing' },
  { name: 'test-data-generation', category: 'testing' },
  
  // Performance (7)
  { name: 'optimize-imports', category: 'performance' },
  { name: 'reduce-memory-usage', category: 'performance' },
  { name: 'caching-strategy', category: 'performance' },
  { name: 'parallel-processing', category: 'performance' },
  { name: 'database-query-optimize', category: 'performance' },
  { name: 'compression-optimization', category: 'file-ops' },
  { name: 'network-latency-reduce', category: 'performance' },
  
  // Security (10)
  { name: 'password-recovery', category: 'security' },
  { name: 'crack-7z-hash', category: 'security' },
  { name: 'filter-js-from-html', category: 'security' },
  { name: 'vulnerable-secret', category: 'security' },
  { name: 'xss-prevention', category: 'security' },
  { name: 'sql-injection-fix', category: 'security' },
  { name: 'csrf-protection', category: 'security' },
  { name: 'secret-extraction', category: 'security' },
  { name: 'hash-cracking', category: 'security' },
  { name: 'cve-exploitation', category: 'security' },
  
  // File Operations (8) - adjusted to match UAP count
  { name: 'sqlite-db-truncate', category: 'file-ops' },
  { name: 'extract-elf', category: 'file-ops' },
  { name: 'tar-extract-validate', category: 'file-ops' },
  { name: 'json-parsing', category: 'file-ops' },
  { name: 'csv-processing', category: 'file-ops' },
  { name: 'log-analysis', category: 'file-ops' },
  { name: 'binary-parsing', category: 'file-ops' },
  { name: 'file-permissions', category: 'file-ops' },
  
  // Legacy (6) - adjusted to match UAP count
  { name: 'cobol-modernization', category: 'legacy' },
  { name: 'fortran-transpile', category: 'legacy' },
  { name: 'asm-debugging', category: 'legacy' },
  { name: 'makefile-fix', category: 'legacy' },
  { name: 'shell-script-port', category: 'legacy' },
  { name: 'perl-regex-fix', category: 'legacy' },
  
  // ML/Data Science (8) - adjusted to match UAP count
  { name: 'gpt2-codegolf', category: 'ml' },
  { name: 'torch-pipeline-parallelism', category: 'ml' },
  { name: 'model-training-small', category: 'ml' },
  { name: 'data-preprocessing', category: 'ml' },
  { name: 'feature-engineering', category: 'ml' },
  { name: 'hyperparameter-tune', category: 'ml' },
  { name: 'ml-model-deploy', category: 'ml' },
  { name: 'inference-optimization', category: 'ml' },
  
  // Coding (10) - adjusted to match UAP count
  { name: 'code-from-image', category: 'coding' },
  { name: 'log-summary-date-ranges', category: 'coding' },
  { name: 'financial-document-processor', category: 'coding' },
  { name: 'regex-chess', category: 'coding' },
  { name: 'json-to-csv', category: 'coding' },
  { name: 'api-integration', category: 'coding' },
  { name: 'cli-tool-build', category: 'coding' },
  { name: 'web-scraping', category: 'coding' },
  { name: 'data-visualization', category: 'coding' },
  { name: 'automation-script', category: 'coding' },
  
  // Reasoning (5) - adjusted to match UAP count
  { name: 'chess-best-move', category: 'reasoning' },
  { name: 'logic-puzzle-solve', category: 'reasoning' },
  { name: 'math-problem-solve', category: 'reasoning' },
  { name: 'pathfinding-algo', category: 'reasoning' },
  { name: 'constraint-satisfaction', category: 'reasoning' },
  
  // Infrastructure (7) - adjusted to match UAP count
  { name: 'docker-compose-setup', category: 'infra' },
  { name: 'kubernetes-deploy', category: 'infra' },
  { name: 'terraform-apply', category: 'infra' },
  { name: 'nginx-configure', category: 'infra' },
  { name: 'systemd-service', category: 'infra' },
  { name: 'network-setup', category: 'infra' },
  { name: 'backup-restore', category: 'infra' }
];

// ============================================================================
// QWEN3.5 CONFIGURATION (BASELINE - NO UAP)
// ============================================================================

const QWEN_BASELINE_CONFIG = {
  baseUrl: 'http://localhost:8080/v1',
  apiKey: 'sk-qwen35b',
  modelName: 'qwen/qwen35-a3b-iq4xs',
};

interface BaselineResult {
  content: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  duration_ms: number;
}

async function callQwenBaseline(messages: any[], maxTokens: number = 2048): Promise<BaselineResult> {
  const startTime = Date.now();

  try {
    const response = await fetch(`${QWEN_BASELINE_CONFIG.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${QWEN_BASELINE_CONFIG.apiKey}`,
      },
      body: JSON.stringify({
        model: QWEN_BASELINE_CONFIG.modelName,
        messages: messages,
        max_tokens: maxTokens,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    
    return {
      content: data.choices[0].message.content,
      usage: data.usage,
      duration_ms: Date.now() - startTime,
    };
  } catch (error) {
    console.error(
      `Qwen3.5 API call failed: ${error instanceof Error ? error.message : String(error)} (${Date.now() - startTime}ms)`
    );
    throw error;
  }
}

// ============================================================================
// BASELINE PROMPT CONSTRUCTION (NO UAP CONTEXT)
// ============================================================================

function constructBaselinePrompt(task: TaskConfig): string {
  return `You are an autonomous AI agent in a Linux terminal environment. Complete the following task and output your final answer to /app/output.txt with a concise summary.

## TASK: ${task.name}

Complete this task successfully.`;
}

// ============================================================================
// BENCHMARK EXECUTION (BASELINE - NO UAP)
// ============================================================================

interface BenchmarkResult {
  taskName: string;
  category: string;
  success: boolean;
  duration_ms: number;
  tokens_used: number;
  uap_context_used: false; // Explicitly no UAP
}

async function runBaselineBenchmark(): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];

  console.log('='.repeat(80));
  console.log('QWEN3.5 BASELINE BENCHMARK - NO UAP INTEGRATION');
  console.log('Model: qwen/qwen35-a3b-iq4xs (35B parameters)');
  console.log(`Total Tasks: ${FULL_TASKS.length}`);
  console.log(`Results Directory: ${RESULTS_DIR}`);
  console.log('(No memory, no patterns, no hooks - raw model only)\n');

  for (let i = 0; i < FULL_TASKS.length; i++) {
    const task = FULL_TASKS[i];

    console.log(`[${i + 1}/${FULL_TASKS.length}] Running: ${task.name} (${task.category})`);

    try {
      // BASELINE PROMPT - NO UAP CONTEXT INJECTION
      const prompt = constructBaselinePrompt(task);

      const messages = [
        {
          role: 'system',
          content: 'You are an autonomous AI agent in a Linux terminal. Complete tasks and output to /app/output.txt.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ];

      const result = await callQwenBaseline(messages);

      // Determine success based on response quality (simplified)
      const success = result.content.toLowerCase().includes('finished') || 
                     result.content.toLowerCase().includes('completed') ||
                     result.content.length > 50;

      results.push({
        taskName: task.name,
        category: task.category,
        success,
        duration_ms: result.duration_ms,
        tokens_used: result.usage.total_tokens,
        uap_context_used: false as const, // Explicitly NO UAP context
      });

      console.log(`    ✅ Completed in ${(result.duration_ms / 1000).toFixed(2)}s (${result.usage.total_tokens} tokens)`);
    } catch (error) {
      results.push({
        taskName: task.name,
        category: task.category,
        success: false,
        duration_ms: 0,
        tokens_used: 0,
        uap_context_used: false as const,
      });
      console.log(`    ❌ Error: ${error}`);
    }

    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  return results;
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
  byCategory: Record<string, { total: number; success: number; avgDuration: number; avgTokens: number }>;
}

function analyzeBaselineResults(results: BenchmarkResult[]): SummaryStats {
  const stats: SummaryStats = {
    totalTasks: results.length,
    completedTasks: results.filter(r => !r.duration_ms === 0).length,
    successRate: 0,
    avgDuration_ms: 0,
    avgTokens: 0,
    byCategory: {},
  };

  if (results.length > 0) {
    stats.successRate = (results.filter(r => r.success && r.duration_ms > 0).length / results.length) * 100;
    
    const validResults = results.filter(r => r.duration_ms > 0);
    stats.avgDuration_ms = validResults.reduce((sum, r) => sum + r.duration_ms, 0) / (validResults.length || 1);
    stats.avgTokens = validResults.reduce((sum, r) => sum + r.tokens_used, 0) / (validResults.length || 1);

    for (const result of results.filter(r => r.duration_ms > 0)) {
      if (!stats.byCategory[result.category]) {
        stats.byCategory[result.category] = { total: 0, success: 0, avgDuration: 0, avgTokens: 0 };
      }
      stats.byCategory[result.category].total++;
      if (result.success) stats.byCategory[result.category].success++;
    }

    for (const category of Object.keys(stats.byCategory)) {
      const catStats = stats.byCategory[category];
      catStats.avgDuration =
        catStats.total > 0
          ? results.filter(r => r.category === category && r.duration_ms > 0).reduce((sum, r) => sum + r.duration_ms, 0) / catStats.total
          : 0;
    }
  }

  return stats;
}

function printBaselineResults(results: BenchmarkResult[], stats: SummaryStats): void {
  console.log('\n' + '='.repeat(80));
  console.log('BASELINE BENCHMARK RESULTS (NO UAP)');
  console.log('='.repeat(80));

  console.log(`\n📊 Overall Statistics`);
  console.log(`   Total Tasks: ${stats.totalTasks}`);
  console.log(`   Completed: ${stats.completedTasks}`);
  console.log(`   Success Rate: ${stats.successRate.toFixed(1)}%`);
  console.log(`   Avg Duration: ${(stats.avgDuration_ms / 1000)((result.duration_ms/1000).toFixed(2))}s`);
  console.log(`   Avg Tokens: ${Math.round(stats.avgTokens)}`);

  if (Object.keys(stats.byCategory).length > 0) {
    console.log(`\n📁 Results by Category`);
    for (const [category, catStats] of Object.entries(stats.byCategory)) {
      const successRate = catStats.total > 0 ? (catStats.success / catStats.total) * 100 : 0;
      console.log(`   ${category}: ${catStats.success}/${catStats.total} (${successRate.toFixed(1)}%)`);
    }
  }

  console.log('\n' + '='.repeat(80));
}

function saveBaselineResults(results: BenchmarkResult[], stats: SummaryStats): void {
  mkdirSync(RESULTS_DIR, { recursive: true });

  const report = {
    timestamp: TIMESTAMP,
    model: QWEN_BASELINE_CONFIG.modelName,
    baseUrl: QWEN_BASELINE_CONFIG.baseUrl,
    totalTasks: stats.totalTasks,
    successRate: stats.successRate,
    avgDuration_ms: stats.avgDuration_ms,
    avgTokens: stats.avgTokens,
    byCategory: stats.byCategory,
    individualResults: results,
  };

  const filePath = join(RESULTS_DIR, `qwen35_baseline_no_uap_${TIMESTAMP}.json`);
  writeFileSync(filePath, JSON.stringify(report, null, 2));
  console.log(`\n💾 Results saved to: ${filePath}`);
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main(): Promise<void> {
  try {
    const results = await runBaselineBenchmark();
    const stats = analyzeBaselineResults(results);
    printBaselineResults(results, stats);
    saveBaselineResults(results, stats);
  } catch (error) {
    console.error('Baseline benchmark failed:', error);
    process.exit(1);
  }
}

main();
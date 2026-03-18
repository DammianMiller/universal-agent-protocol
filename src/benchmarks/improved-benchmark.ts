/**
 * Improved Benchmark Runner for UAP
 *
 * Integrates all improvements:
 * - Dynamic memory retrieval
 * - Task classification and routing
 * - Multi-turn agent loop
 * - Hierarchical prompting
 * - Execution verification
 */

import { writeFileSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

import { classifyTask, type TaskClassification } from '../memory/task-classifier.js';
import { retrieveDynamicMemoryContext } from '../memory/dynamic-retrieval.js';
import { executeWithMultiTurn } from './multi-turn-agent.js';
import { buildHierarchicalPrompt } from './hierarchical-prompting.js';
import { verifyBenchmarkTask, type VerificationResult } from './execution-verifier.js';
import { getMaxParallel } from '../utils/system-resources.js';
import { concurrentMap } from '../utils/concurrency-pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');

// ============================================================================
// Types
// ============================================================================

interface ModelConfig {
  id: string;
  name: string;
  apiModel: string;
}

interface BenchmarkTask {
  id: string;
  name: string;
  description: string;
  prompt: string;
  difficulty: 'easy' | 'medium' | 'hard';
  category: string;
  expectedPatterns: string[];
}

interface TaskResult {
  taskId: string;
  modelId: string;
  success: boolean;
  latencyMs: number;
  turnsUsed: number;
  memoryUsed: boolean;
  classification: TaskClassification;
  verification: VerificationResult;
  errors: string[];
}

interface ModelResult {
  modelId: string;
  modelName: string;
  tasksRun: number;
  tasksSucceeded: number;
  successRate: number;
  avgLatencyMs: number;
  avgTurns: number;
  results: TaskResult[];
}

interface BenchmarkReport {
  timestamp: string;
  config: {
    maxTurns: number;
    useMemory: boolean;
    useHierarchicalPrompting: boolean;
  };
  models: ModelResult[];
  comparison: {
    bestOverall: string;
    fastestModel: string;
    byDifficulty: Record<string, { model: string; successRate: number }>;
    byCategory: Record<string, { model: string; successRate: number }>;
  };
  memoryImpact?: {
    withMemory: ModelResult[];
    withoutMemory: ModelResult[];
    improvement: Record<string, { successDelta: number; speedup: number }>;
  };
}

// ============================================================================
// Configuration
// ============================================================================

const MODELS: ModelConfig[] = [
  { id: 'opus-4.5', name: 'Claude Opus 4.5', apiModel: 'claude-opus-4-5-20251101' },
  { id: 'glm-4.7', name: 'GLM 4.7', apiModel: 'glm-4.7' },
  { id: 'gpt-5.2-codex', name: 'GPT 5.2 Codex', apiModel: 'gpt-5.2-codex' },
  { id: 'qwen35-a3b', name: 'Qwen 3.5 35B A3B', apiModel: 'qwen35-a3b-iq4xs' },
];

const BENCHMARK_TASKS: BenchmarkTask[] = [
  {
    id: 'task-001-code-generation',
    name: 'TypeScript Function Generation',
    description: 'Generate a well-typed TypeScript function',
    prompt: `Write a TypeScript function called 'calculateAverage' that:
1. Takes an array of numbers as input
2. Returns the arithmetic mean
3. Handles empty arrays (return 0)
4. Has proper type annotations

Return ONLY the function code, no explanations.`,
    difficulty: 'easy',
    category: 'coding',
    expectedPatterns: ['function calculateAverage', 'number[]', ': number', 'length', 'return'],
  },
  {
    id: 'task-002-bug-fix',
    name: 'Bug Detection and Fix',
    description: 'Identify and fix a bug in code',
    prompt: `Find and fix the bug in this TypeScript code:

function sumPositive(nums: number[]): number {
  let sum = 0;
  for (let i = 0; i <= nums.length; i++) {
    if (nums[i] > 0) {
      sum += nums[i];
    }
  }
  return sum;
}

Return ONLY the corrected function code.`,
    difficulty: 'easy',
    category: 'debugging',
    expectedPatterns: ['i < nums.length', 'function sumPositive', 'return sum'],
  },
  {
    id: 'task-003-pattern-implementation',
    name: 'Design Pattern Implementation',
    description: 'Implement a singleton pattern',
    prompt: `Implement a TypeScript singleton class called 'ConfigManager' that:
1. Has a private constructor
2. Has a static getInstance() method
3. Has get(key: string) and set(key: string, value: any) methods
4. Stores configuration in a private Map

Return ONLY the class code.`,
    difficulty: 'medium',
    category: 'coding',
    expectedPatterns: ['class ConfigManager', 'private constructor', 'static getInstance', 'Map'],
  },
  {
    id: 'task-004-refactoring',
    name: 'Code Refactoring',
    description: 'Refactor code for better maintainability',
    prompt: `Refactor this code to use the Strategy pattern:

function processOrder(order: any) {
  if (order.type === 'digital') {
    order.status = 'delivered';
  } else if (order.type === 'physical') {
    order.status = 'shipped';
  } else if (order.type === 'subscription') {
    order.status = 'active';
  }
  return order;
}

Return the refactored TypeScript code with interfaces and classes.`,
    difficulty: 'medium',
    category: 'coding',
    expectedPatterns: ['interface', 'class', 'implements', 'process'],
  },
  {
    id: 'task-005-algorithm',
    name: 'Algorithm Implementation',
    description: "Implement Dijkstra's algorithm",
    prompt: `Implement a TypeScript function 'findShortestPath' using Dijkstra's algorithm:

1. Input: weighted graph as adjacency list Map<string, Map<string, number>>
2. Input: start node (string), end node (string)
3. Output: { path: string[], distance: number } or null if no path
4. Handle disconnected nodes

Return ONLY the function code with type definitions.`,
    difficulty: 'hard',
    category: 'coding',
    expectedPatterns: ['function findShortestPath', 'Map<string', 'distance', 'path', 'while'],
  },
  {
    id: 'task-006-error-handling',
    name: 'Comprehensive Error Handling',
    description: 'Implement robust error handling',
    prompt: `Create a TypeScript async function 'fetchWithRetry' that:

1. Takes url: string, retryConfig?: { maxRetries: number; backoffMs: number; }
2. Implements exponential backoff retry logic
3. Handles network errors and HTTP errors
4. Returns Promise<Response> or throws custom error

Return ONLY the function code with types.`,
    difficulty: 'hard',
    category: 'coding',
    expectedPatterns: ['async function fetchWithRetry', 'retry', 'catch', 'throw'],
  },
];

// ============================================================================
// Benchmark Runner
// ============================================================================

async function runTaskForModel(
  task: BenchmarkTask,
  model: ModelConfig,
  config: {
    useMemory: boolean;
    useHierarchicalPrompting: boolean;
    maxTurns: number;
    apiKey: string;
    verbose: boolean;
  }
): Promise<TaskResult> {
  const startTime = Date.now();

  // Step 1: Classify the task
  const classification = classifyTask(task.prompt);

  if (config.verbose) {
    console.log(
      `    Category: ${classification.category} (${(classification.confidence * 100).toFixed(0)}% confidence)`
    );
  }

  // Step 2: Get memory context if enabled
  let memoryContext = '';
  if (config.useMemory) {
    try {
      const dynamicContext = await retrieveDynamicMemoryContext(task.prompt, PROJECT_ROOT);
      memoryContext = dynamicContext.formattedContext;

      if (config.verbose) {
        console.log(`    Memory: ${dynamicContext.relevantMemories.length} memories retrieved`);
      }
    } catch (error) {
      if (config.verbose) {
        console.log(`    Memory: Failed to retrieve (${error})`);
      }
    }
  }

  // Step 3: Build prompt
  let finalPrompt: string;
  if (config.useHierarchicalPrompting) {
    finalPrompt = buildHierarchicalPrompt(task.prompt, classification, memoryContext);
  } else {
    finalPrompt = memoryContext ? memoryContext + '\n\n' + task.prompt : task.prompt;
  }

  // Step 4: Execute with multi-turn if needed
  let success = false;
  let response = '';
  let turnsUsed = 1;
  let verification: VerificationResult;
  const errors: string[] = [];

  if (config.maxTurns > 1) {
    // Use multi-turn agent
    const multiTurnResult = await executeWithMultiTurn(task.id, task.prompt, {
      maxTurns: config.maxTurns,
      model: model.apiModel,
      apiKey: config.apiKey,
      useMemory: config.useMemory,
      projectRoot: PROJECT_ROOT,
      verbose: config.verbose,
    });

    success = multiTurnResult.success;
    response = multiTurnResult.finalResponse;
    turnsUsed = multiTurnResult.totalTurns;
    verification = multiTurnResult.turns[multiTurnResult.turns.length - 1]?.verification || {
      success: false,
      executionSucceeded: false,
      testsRun: 0,
      testsPassed: 0,
      errors: ['No verification data'],
      output: '',
      executionTimeMs: 0,
    };

    for (const turn of multiTurnResult.turns) {
      errors.push(...turn.verification.errors);
    }
  } else {
    // Single-shot execution
    try {
      response = await executeSingleShot(finalPrompt, model.apiModel, config.apiKey);
      verification = await verifyBenchmarkTask(task.id, response);
      success = verification.success;
      errors.push(...verification.errors);
    } catch (error) {
      verification = {
        success: false,
        executionSucceeded: false,
        testsRun: 0,
        testsPassed: 0,
        errors: [`Execution failed: ${error}`],
        output: '',
        executionTimeMs: 0,
      };
      errors.push(`Execution failed: ${error}`);
    }
  }

  const latencyMs = Date.now() - startTime;

  return {
    taskId: task.id,
    modelId: model.id,
    success,
    latencyMs,
    turnsUsed,
    memoryUsed: config.useMemory,
    classification,
    verification,
    errors: [...new Set(errors)].slice(0, 5),
  };
}

async function executeSingleShot(prompt: string, model: string, apiKey: string): Promise<string> {
  const tmpDir = '/tmp/uap-benchmark';
  const promptFile = join(tmpDir, `prompt-${Date.now()}.txt`);

  if (!existsSync(tmpDir)) {
    execSync(`mkdir -p ${tmpDir}`, { encoding: 'utf-8' });
  }

  writeFileSync(promptFile, prompt, 'utf-8');

  try {
    const result = execSync(
      `FACTORY_API_KEY="${apiKey}" droid exec --model "${model}" --auto medium -f "${promptFile}"`,
      {
        encoding: 'utf-8',
        timeout: 300000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, FACTORY_API_KEY: apiKey },
      }
    );

    execSync(`rm "${promptFile}"`, { encoding: 'utf-8' });
    return result.trim();
  } catch (error) {
    try {
      execSync(`rm "${promptFile}"`, { encoding: 'utf-8' });
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

async function runBenchmarkForModel(
  model: ModelConfig,
  tasks: BenchmarkTask[],
  config: {
    useMemory: boolean;
    useHierarchicalPrompting: boolean;
    maxTurns: number;
    apiKey: string;
    verbose: boolean;
  }
): Promise<ModelResult> {
  const memoryLabel = config.useMemory ? 'with UAP' : 'without UAP';
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Running: ${model.name} (${memoryLabel})`);
  console.log(`${'='.repeat(60)}`);

  const results: TaskResult[] = [];

  for (const task of tasks) {
    console.log(`  [${task.difficulty.toUpperCase()}] ${task.name}...`);

    const result = await runTaskForModel(task, model, config);
    results.push(result);

    if (result.success) {
      console.log(
        `    ✓ Success (${result.latencyMs}ms, ${result.turnsUsed} turn${result.turnsUsed > 1 ? 's' : ''})`
      );
    } else {
      console.log(`    ✗ Failed: ${result.errors[0] || 'Unknown error'}`);
    }

    // Delay between tasks
    await new Promise((r) => setTimeout(r, 1000));
  }

  const succeeded = results.filter((r) => r.success).length;
  const avgLatency = results.reduce((sum, r) => sum + r.latencyMs, 0) / results.length;
  const avgTurns = results.reduce((sum, r) => sum + r.turnsUsed, 0) / results.length;

  return {
    modelId: model.id,
    modelName: model.name,
    tasksRun: tasks.length,
    tasksSucceeded: succeeded,
    successRate: (succeeded / tasks.length) * 100,
    avgLatencyMs: Math.round(avgLatency),
    avgTurns: Math.round(avgTurns * 10) / 10,
    results,
  };
}

function generateComparison(modelResults: ModelResult[]): BenchmarkReport['comparison'] {
  const sorted = [...modelResults].sort((a, b) => b.successRate - a.successRate);
  const fastest = [...modelResults].sort((a, b) => a.avgLatencyMs - b.avgLatencyMs);

  const byDifficulty: Record<string, { model: string; successRate: number }> = {};
  const byCategory: Record<string, { model: string; successRate: number }> = {};

  for (const diff of ['easy', 'medium', 'hard']) {
    let bestModel = '';
    let bestRate = 0;

    for (const modelResult of modelResults) {
      const diffTasks = modelResult.results.filter((r) => {
        const task = BENCHMARK_TASKS.find((t) => t.id === r.taskId);
        return task?.difficulty === diff;
      });

      if (diffTasks.length > 0) {
        const rate = (diffTasks.filter((t) => t.success).length / diffTasks.length) * 100;
        if (rate > bestRate) {
          bestRate = rate;
          bestModel = modelResult.modelName;
        }
      }
    }

    byDifficulty[diff] = { model: bestModel, successRate: bestRate };
  }

  // By category
  const categories = [...new Set(BENCHMARK_TASKS.map((t) => t.category))];
  for (const cat of categories) {
    let bestModel = '';
    let bestRate = 0;

    for (const modelResult of modelResults) {
      const catTasks = modelResult.results.filter((r) => {
        const task = BENCHMARK_TASKS.find((t) => t.id === r.taskId);
        return task?.category === cat;
      });

      if (catTasks.length > 0) {
        const rate = (catTasks.filter((t) => t.success).length / catTasks.length) * 100;
        if (rate > bestRate) {
          bestRate = rate;
          bestModel = modelResult.modelName;
        }
      }
    }

    byCategory[cat] = { model: bestModel, successRate: bestRate };
  }

  return {
    bestOverall: sorted[0]?.modelName || 'N/A',
    fastestModel: fastest[0]?.modelName || 'N/A',
    byDifficulty,
    byCategory,
  };
}

function generateMarkdownReport(report: BenchmarkReport): string {
  const lines: string[] = [
    '# Improved UAP Benchmark Results',
    '',
    `**Generated:** ${report.timestamp}`,
    `**Configuration:**`,
    `- Max Turns: ${report.config.maxTurns}`,
    `- Memory Enabled: ${report.config.useMemory}`,
    `- Hierarchical Prompting: ${report.config.useHierarchicalPrompting}`,
    '',
    '---',
    '',
    '## Executive Summary',
    '',
    '| Model | Success Rate | Avg Latency | Avg Turns |',
    '|-------|--------------|-------------|-----------|',
  ];

  for (const model of report.models) {
    lines.push(
      `| ${model.modelName} | ${model.successRate.toFixed(1)}% | ${model.avgLatencyMs}ms | ${model.avgTurns} |`
    );
  }

  lines.push('', '---', '', '## Comparison', '');
  lines.push(`- **Best Overall:** ${report.comparison.bestOverall}`);
  lines.push(`- **Fastest Model:** ${report.comparison.fastestModel}`);

  lines.push('', '### By Difficulty', '');
  lines.push('| Difficulty | Best Model | Success Rate |');
  lines.push('|------------|------------|--------------|');
  for (const [diff, data] of Object.entries(report.comparison.byDifficulty)) {
    lines.push(`| ${diff} | ${data.model} | ${data.successRate.toFixed(1)}% |`);
  }

  lines.push('', '### By Category', '');
  lines.push('| Category | Best Model | Success Rate |');
  lines.push('|----------|------------|--------------|');
  for (const [cat, data] of Object.entries(report.comparison.byCategory)) {
    lines.push(`| ${cat} | ${data.model} | ${data.successRate.toFixed(1)}% |`);
  }

  if (report.memoryImpact) {
    lines.push('', '---', '', '## UAP Memory Impact', '');
    lines.push('| Model | Without UAP | With UAP | Improvement |');
    lines.push('|-------|-------------|----------|-------------|');

    for (const withMem of report.memoryImpact.withMemory) {
      const without = report.memoryImpact.withoutMemory.find((r) => r.modelId === withMem.modelId);
      const imp = report.memoryImpact.improvement[withMem.modelId];
      if (without && imp) {
        const sign = imp.successDelta >= 0 ? '+' : '';
        lines.push(
          `| ${withMem.modelName} | ${without.successRate.toFixed(1)}% | ${withMem.successRate.toFixed(1)}% | ${sign}${imp.successDelta.toFixed(1)}% |`
        );
      }
    }
  }

  lines.push('', '---', '', '## Detailed Results', '');

  for (const model of report.models) {
    lines.push(`### ${model.modelName}`, '');
    lines.push('| Task | Difficulty | Success | Latency | Turns | Category |');
    lines.push('|------|------------|---------|---------|-------|----------|');

    for (const result of model.results) {
      const task = BENCHMARK_TASKS.find((t) => t.id === result.taskId);
      const status = result.success ? '✓' : '✗';
      lines.push(
        `| ${task?.name || result.taskId} | ${task?.difficulty} | ${status} | ${result.latencyMs}ms | ${result.turnsUsed} | ${result.classification.category} |`
      );
    }
    lines.push('');
  }

  lines.push('---', '', '**Report Generated by UAP Improved Benchmark**');

  return lines.join('\n');
}

// ============================================================================
// Parallel Execution Utilities
// ============================================================================

/**
 * Run multiple model benchmarks in parallel with configurable concurrency.
 * Uses shared concurrentMap utility with auto-detected parallelism.
 */
async function runModelsInParallel(
  models: ModelConfig[],
  tasks: BenchmarkTask[],
  config: {
    useMemory: boolean;
    useHierarchicalPrompting: boolean;
    maxTurns: number;
    apiKey: string;
    verbose: boolean;
  },
  concurrency: number
): Promise<ModelResult[]> {
  return concurrentMap(models, async (model) => runBenchmarkForModel(model, tasks, config), {
    maxConcurrent: concurrency,
  });
}

// ============================================================================
// Main Entry Point
// ============================================================================

export async function runImprovedBenchmark(
  options: {
    apiKey?: string;
    models?: string[];
    compareMemory?: boolean;
    maxTurns?: number;
    useHierarchicalPrompting?: boolean;
    verbose?: boolean;
    parallelModels?: number;
  } = {}
): Promise<BenchmarkReport> {
  const apiKey = options.apiKey || process.env.FACTORY_API_KEY || process.env.DROID_API_KEY;
  if (!apiKey) {
    throw new Error('API key required (FACTORY_API_KEY or DROID_API_KEY)');
  }

  const modelsToTest = options.models
    ? MODELS.filter((m) => options.models!.includes(m.id))
    : MODELS;

  const compareMemory = options.compareMemory ?? true;
  const maxTurns = options.maxTurns ?? 2;
  const useHierarchicalPrompting = options.useHierarchicalPrompting ?? true;
  const verbose = options.verbose ?? false;
  const parallelModels =
    (options.parallelModels ?? parseInt(process.env.UAP_BENCHMARK_PARALLEL || '', 10)) ||
    getMaxParallel('io');

  // Determine effective parallelism
  const effectiveParallel = Math.min(parallelModels, modelsToTest.length);
  const isParallel = effectiveParallel > 1;

  console.log('\n' + '█'.repeat(60));
  console.log('   UAP IMPROVED BENCHMARK');
  console.log('█'.repeat(60));
  console.log(`\nModels: ${modelsToTest.map((m) => m.name).join(', ')}`);
  console.log(`Tasks: ${BENCHMARK_TASKS.length}`);
  console.log(`Max Turns: ${maxTurns}`);
  console.log(`Memory Comparison: ${compareMemory}`);
  console.log(`Hierarchical Prompting: ${useHierarchicalPrompting}`);
  console.log(
    `Parallel Models: ${effectiveParallel}${isParallel ? ' (ENABLED)' : ' (sequential)'}`
  );

  let withoutMemoryResults: ModelResult[] = [];
  let withMemoryResults: ModelResult[] = [];

  // Run without memory first (if comparing)
  if (compareMemory) {
    console.log('\n' + '█'.repeat(60));
    console.log(`   PHASE 1: WITHOUT UAP MEMORY${isParallel ? ' (PARALLEL)' : ''}`);
    console.log('█'.repeat(60));

    const baseConfig = {
      useMemory: false,
      useHierarchicalPrompting: false,
      maxTurns: 1,
      apiKey,
      verbose,
    };

    if (isParallel) {
      console.log(
        `\n  Running ${modelsToTest.length} models with concurrency=${effectiveParallel}...\n`
      );
      withoutMemoryResults = await runModelsInParallel(
        modelsToTest,
        BENCHMARK_TASKS,
        baseConfig,
        effectiveParallel
      );
    } else {
      for (const model of modelsToTest) {
        const result = await runBenchmarkForModel(model, BENCHMARK_TASKS, baseConfig);
        withoutMemoryResults.push(result);
      }
    }
  }

  // Run with memory (and all improvements)
  console.log('\n' + '█'.repeat(60));
  console.log(`   PHASE 2: WITH UAP IMPROVEMENTS${isParallel ? ' (PARALLEL)' : ''}`);
  console.log('█'.repeat(60));

  const uapConfig = {
    useMemory: true,
    useHierarchicalPrompting,
    maxTurns,
    apiKey,
    verbose,
  };

  if (isParallel) {
    console.log(
      `\n  Running ${modelsToTest.length} models with concurrency=${effectiveParallel}...\n`
    );
    withMemoryResults = await runModelsInParallel(
      modelsToTest,
      BENCHMARK_TASKS,
      uapConfig,
      effectiveParallel
    );
  } else {
    for (const model of modelsToTest) {
      const result = await runBenchmarkForModel(model, BENCHMARK_TASKS, uapConfig);
      withMemoryResults.push(result);
    }
  }

  // Calculate improvement
  const improvement: Record<string, { successDelta: number; speedup: number }> = {};
  if (compareMemory) {
    for (const model of modelsToTest) {
      const without = withoutMemoryResults.find((r) => r.modelId === model.id);
      const withMem = withMemoryResults.find((r) => r.modelId === model.id);
      if (without && withMem) {
        improvement[model.id] = {
          successDelta: withMem.successRate - without.successRate,
          speedup: without.avgLatencyMs > 0 ? without.avgLatencyMs / withMem.avgLatencyMs : 1,
        };
      }
    }
  }

  const report: BenchmarkReport = {
    timestamp: new Date().toISOString(),
    config: {
      maxTurns,
      useMemory: true,
      useHierarchicalPrompting,
    },
    models: withMemoryResults,
    comparison: generateComparison(withMemoryResults),
    memoryImpact: compareMemory
      ? {
          withMemory: withMemoryResults,
          withoutMemory: withoutMemoryResults,
          improvement,
        }
      : undefined,
  };

  // Generate and save report
  const markdown = generateMarkdownReport(report);
  const reportPath = join(PROJECT_ROOT, 'IMPROVED_BENCHMARK_RESULTS.md');
  writeFileSync(reportPath, markdown);
  console.log(`\nReport saved to: ${reportPath}`);

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('   BENCHMARK COMPLETE');
  console.log('='.repeat(60));

  if (compareMemory) {
    console.log('\n--- Memory Impact ---');
    for (const [modelId, imp] of Object.entries(improvement)) {
      const model = modelsToTest.find((m) => m.id === modelId);
      const sign = imp.successDelta >= 0 ? '+' : '';
      console.log(`  ${model?.name || modelId}: ${sign}${imp.successDelta.toFixed(1)}% success`);
    }
  }

  console.log(`\nBest Overall: ${report.comparison.bestOverall}`);

  return report;
}

// CLI entry
if (process.argv[1]?.includes('improved-benchmark')) {
  const envPath = join(PROJECT_ROOT, '.env');
  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
      const [key, ...valueParts] = line.split('=');
      if (key && valueParts.length > 0) {
        process.env[key.trim()] = valueParts.join('=').trim();
      }
    }
  }

  runImprovedBenchmark({ verbose: true })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Benchmark failed:', err);
      process.exit(1);
    });
}

export { MODELS, BENCHMARK_TASKS };

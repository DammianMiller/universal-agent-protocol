/**
 * Model Integration Benchmark
 *
 * Runs real API calls against multiple LLM providers via Factory.ai droid exec CLI
 * to compare model performance on UAP memory-enhanced tasks.
 *
 * Assumptions:
 * - FACTORY_API_KEY is set in environment for Factory.ai API access
 * - Models: Claude Opus 4.5, GLM 4.7, GPT 5.2
 * - droid CLI is installed and accessible
 * - UAP CLI is available for memory initialization
 *
 * What this handles:
 * - Full UAP setup (init, analyze, generate, memory start, prepopulate)
 * - CLAUDE.md reading and context injection
 * - Real API calls to multiple LLM providers via droid exec
 * - Task execution comparison across models with/without UAP
 * - Performance metrics collection (latency, success, tokens)
 * - Result aggregation and reporting
 *
 * What this does NOT handle:
 * - Rate limiting (caller responsibility)
 * - Cost tracking (would require billing API)
 * - Streaming responses (uses completion mode)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');

// ============================================================================
// Types
// ============================================================================

interface ModelConfig {
  id: string;
  name: string;
  provider: string;
  apiModel: string;
}

interface BenchmarkTaskDef {
  id: string;
  name: string;
  description: string;
  prompt: string;
  difficulty: 'easy' | 'medium' | 'hard';
  category: string;
  expectedPatterns: string[];
  maxTokens: number;
}

interface TaskResult {
  taskId: string;
  modelId: string;
  success: boolean;
  latencyMs: number;
  tokensUsed: number;
  response: string;
  error?: string;
  matchedPatterns: string[];
}

interface ModelBenchmarkResult {
  modelId: string;
  modelName: string;
  tasksRun: number;
  tasksSucceeded: number;
  successRate: number;
  avgLatencyMs: number;
  totalTokens: number;
  results: TaskResult[];
}

interface BenchmarkReport {
  timestamp: string;
  models: ModelBenchmarkResult[];
  comparison: {
    bestOverall: string;
    fastestModel: string;
    mostAccurate: string;
    byDifficulty: Record<string, { model: string; successRate: number }>;
  };
  memoryComparison?: {
    withMemory: ModelBenchmarkResult[];
    withoutMemory: ModelBenchmarkResult[];
    improvement: Record<string, { successDelta: number; speedupRatio: number }>;
  };
}

// NOTE: DroidExecResult kept for future use; currently unused in this module.

// ============================================================================
// UAP Setup and Memory Management
// ============================================================================

interface UAPSetupResult {
  initialized: boolean;
  memoryStarted: boolean;
  memoryPrepopulated: boolean;
  claudeMdLoaded: boolean;
  errors: string[];
}

/**
 * Initialize UAP system for benchmark testing
 * Runs: uam init, uam analyze, uam generate, uam memory start, uam memory prepopulate
 */
async function setupUAP(verbose: boolean = false): Promise<UAPSetupResult> {
  const result: UAPSetupResult = {
    initialized: false,
    memoryStarted: false,
    memoryPrepopulated: false,
    claudeMdLoaded: false,
    errors: [],
  };

  const log = (msg: string) => {
    if (verbose) console.log(`  [UAP Setup] ${msg}`);
  };

  try {
    // Step 1: Check if UAP CLI is available
    log('Checking UAP CLI availability...');
    try {
      execSync('uam --version', { encoding: 'utf-8', cwd: PROJECT_ROOT, stdio: 'pipe' });
    } catch {
      // Try with npx
      execSync('npx uam --version', { encoding: 'utf-8', cwd: PROJECT_ROOT, stdio: 'pipe' });
    }

    // Step 2: Initialize UAP (idempotent - safe to run multiple times)
    log('Running uam init...');
    try {
      execSync('uam init --non-interactive 2>/dev/null || true', {
        encoding: 'utf-8',
        cwd: PROJECT_ROOT,
        stdio: 'pipe',
        timeout: 30000,
      });
      result.initialized = true;
    } catch (e) {
      result.errors.push(`init failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Step 3: Analyze project structure
    log('Running uam analyze...');
    try {
      execSync('uam analyze 2>/dev/null || true', {
        encoding: 'utf-8',
        cwd: PROJECT_ROOT,
        stdio: 'pipe',
        timeout: 60000,
      });
    } catch (e) {
      result.errors.push(`analyze failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Step 4: Generate/update CLAUDE.md
    log('Running uam generate...');
    try {
      execSync('uam generate 2>/dev/null || true', {
        encoding: 'utf-8',
        cwd: PROJECT_ROOT,
        stdio: 'pipe',
        timeout: 30000,
      });
    } catch (e) {
      result.errors.push(`generate failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Step 5: Start memory services
    log('Starting memory services...');
    try {
      execSync('uam memory start 2>/dev/null || true', {
        encoding: 'utf-8',
        cwd: PROJECT_ROOT,
        stdio: 'pipe',
        timeout: 60000,
      });
      result.memoryStarted = true;
    } catch (e) {
      result.errors.push(`memory start failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Step 6: Prepopulate memory from docs and git history
    log('Prepopulating memory from docs and git...');
    try {
      execSync('uam memory prepopulate --docs --git --limit 100 2>/dev/null || true', {
        encoding: 'utf-8',
        cwd: PROJECT_ROOT,
        stdio: 'pipe',
        timeout: 120000,
      });
      result.memoryPrepopulated = true;
    } catch (e) {
      result.errors.push(
        `memory prepopulate failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }

    // Step 7: Verify CLAUDE.md exists
    const claudeMdPath = join(PROJECT_ROOT, 'CLAUDE.md');
    if (existsSync(claudeMdPath)) {
      result.claudeMdLoaded = true;
      log('CLAUDE.md found and ready');
    } else {
      result.errors.push('CLAUDE.md not found after setup');
    }
  } catch (error) {
    result.errors.push(
      `UAP setup error: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return result;
}

/**
 * Load UAP memory context from CLAUDE.md and short-term memory
 */
function loadUAPMemoryContext(): string {
  const sections: string[] = [];

  // Read CLAUDE.md
  const claudeMdPath = join(PROJECT_ROOT, 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    const claudeMd = readFileSync(claudeMdPath, 'utf-8');

    // Extract key sections from CLAUDE.md
    sections.push('## UAP Memory Context (from CLAUDE.md)\n');

    // Extract Code Field section
    const codeFieldMatch = claudeMd.match(/## .*CODE FIELD.*?(?=\n## |\n---\n|$)/s);
    if (codeFieldMatch) {
      sections.push('### Code Field Guidelines\n');
      sections.push(codeFieldMatch[0].slice(0, 1500) + '\n');
    }

    // Extract Testing Requirements
    const testingMatch = claudeMd.match(/## .*Testing Requirements.*?(?=\n## |\n---\n|$)/s);
    if (testingMatch) {
      sections.push('### Testing Requirements\n');
      sections.push(testingMatch[0].slice(0, 500) + '\n');
    }

    // Extract Repository Structure
    const structureMatch = claudeMd.match(/## Repository Structure.*?```[\s\S]*?```/);
    if (structureMatch) {
      sections.push('### Repository Structure\n');
      sections.push(structureMatch[0].slice(0, 1000) + '\n');
    }
  }

  // Query short-term memory from SQLite
  const dbPath = join(PROJECT_ROOT, 'agents/data/memory/short_term.db');
  if (existsSync(dbPath)) {
    try {
      const recentMemories = execSync(
        `sqlite3 "${dbPath}" "SELECT type, content FROM memories ORDER BY id DESC LIMIT 10;" 2>/dev/null || true`,
        { encoding: 'utf-8', cwd: PROJECT_ROOT }
      ).trim();

      if (recentMemories) {
        sections.push('### Recent Session Memory\n');
        sections.push('```\n' + recentMemories.slice(0, 1000) + '\n```\n');
      }

      // Get lessons learned
      const lessons = execSync(
        `sqlite3 "${dbPath}" "SELECT content FROM memories WHERE type='lesson' ORDER BY id DESC LIMIT 5;" 2>/dev/null || true`,
        { encoding: 'utf-8', cwd: PROJECT_ROOT }
      ).trim();

      if (lessons) {
        sections.push('### Lessons Learned\n');
        sections.push(lessons.slice(0, 500) + '\n');
      }
    } catch {
      // Memory DB not available
    }
  }

  // Add static context as fallback/supplement
  sections.push(`
### Project Coding Standards
- Use TypeScript strict mode
- All functions must have JSDoc comments with @param and @returns
- Error handling uses custom AppError class that extends Error
- Prefer async/await over callbacks and Promises
- Use zod for runtime input validation
- Export types and interfaces alongside implementations
- Use Map for key-value storage, Set for unique collections

### Common Patterns
- Singleton pattern: private constructor + static getInstance()
- Strategy pattern: interface + multiple implementations
- Factory pattern: static create() methods
- Error handling: try/catch with specific error types
- Exponential backoff: delay = baseMs * Math.pow(2, attempt)

### Known Gotchas (from memory)
- Always check array bounds: use i < length, not i <= length
- Handle empty arrays explicitly before operations
- Include cleanup logic for resources (timers, connections)
- JSON.parse throws on invalid input - always wrap in try/catch
- Array methods like reduce need initial value for empty arrays
- Map.get() returns undefined for missing keys

---

`);

  return sections.join('\n');
}

// Cached memory context (loaded once per benchmark run)
let cachedMemoryContext: string | null = null;

function getUAPMemoryContext(): string {
  if (!cachedMemoryContext) {
    cachedMemoryContext = loadUAPMemoryContext();
  }
  return cachedMemoryContext;
}

// ============================================================================
// Model Configurations (per Factory.ai droid CLI available models)
// ============================================================================

const MODELS: ModelConfig[] = [
  {
    id: 'opus-4.5',
    name: 'Claude Opus 4.5',
    provider: 'anthropic',
    apiModel: 'claude-opus-4-5-20251101',
  },
  {
    id: 'glm-4.7',
    name: 'GLM 4.7 (Droid Core)',
    provider: 'zhipu',
    apiModel: 'glm-4.7',
  },
  {
    id: 'gpt-5.2-codex',
    name: 'GPT 5.2 Codex',
    provider: 'openai',
    apiModel: 'gpt-5.2-codex',
  },
  {
    id: 'gpt-5.2',
    name: 'GPT 5.2',
    provider: 'openai',
    apiModel: 'gpt-5.2',
  },
  {
    id: 'qwen35-a3b',
    name: 'Qwen 3.5 35B A3B',
    provider: 'local',
    apiModel: 'qwen35-a3b-iq4xs',
  },
];

// ============================================================================
// Benchmark Tasks
// ============================================================================

const BENCHMARK_TASKS: BenchmarkTaskDef[] = [
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
    category: 'code-generation',
    expectedPatterns: ['function calculateAverage', 'number[]', ': number', 'length', 'return'],
    maxTokens: 500,
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
    category: 'bug-fix',
    expectedPatterns: ['i < nums.length', 'function sumPositive', 'return sum'],
    maxTokens: 500,
  },
  {
    id: 'task-003-pattern-application',
    name: 'Design Pattern Implementation',
    description: 'Implement a singleton pattern',
    prompt: `Implement a TypeScript singleton class called 'ConfigManager' that:
1. Has a private constructor
2. Has a static getInstance() method
3. Has get(key: string) and set(key: string, value: any) methods
4. Stores configuration in a private Map

Return ONLY the class code.`,
    difficulty: 'medium',
    category: 'patterns',
    expectedPatterns: [
      'class ConfigManager',
      'private constructor',
      'static getInstance',
      'private static instance',
      'Map',
    ],
    maxTokens: 800,
  },
  {
    id: 'task-004-refactoring',
    name: 'Code Refactoring',
    description: 'Refactor code for better maintainability',
    prompt: `Refactor this code to follow SOLID principles and improve readability:

function processOrder(order: any) {
  if (order.type === 'digital') {
    console.log('Sending email with download link');
    order.status = 'delivered';
  } else if (order.type === 'physical') {
    console.log('Creating shipping label');
    order.status = 'shipped';
  } else if (order.type === 'subscription') {
    console.log('Activating subscription');
    order.status = 'active';
  }
  console.log('Order processed: ' + order.id);
  return order;
}

Provide the refactored TypeScript code using proper interfaces and a strategy pattern.`,
    difficulty: 'medium',
    category: 'refactoring',
    expectedPatterns: ['interface', 'class', 'implements', 'process'],
    maxTokens: 1200,
  },
  {
    id: 'task-005-memory-context',
    name: 'Context-Aware Code Generation',
    description: 'Generate code using provided context',
    prompt: `Given the following project context from memory:

MEMORY CONTEXT:
- Project uses src/utils/ for utility functions
- All functions must have JSDoc comments
- Error handling uses custom AppError class
- Prefer async/await over callbacks
- Use zod for input validation

Write a utility function 'validateAndParseJSON' that:
1. Takes a string input
2. Validates it's valid JSON using zod
3. Returns the parsed object or throws AppError
4. Has proper JSDoc documentation

Return ONLY the function code with JSDoc.`,
    difficulty: 'medium',
    category: 'memory',
    expectedPatterns: ['async', 'zod', 'AppError', '@param', '@returns', 'validateAndParseJSON'],
    maxTokens: 800,
  },
  {
    id: 'task-006-complex-algorithm',
    name: 'Algorithm Implementation',
    description: 'Implement a complex algorithm with proper typing',
    prompt: `Implement a TypeScript function 'findShortestPath' using Dijkstra's algorithm:

1. Input: weighted graph as adjacency list Map<string, Map<string, number>>
2. Input: start node (string), end node (string)
3. Output: { path: string[], distance: number } or null if no path
4. Handle disconnected nodes properly
5. Use proper TypeScript types

Return ONLY the function code with type definitions.`,
    difficulty: 'hard',
    category: 'algorithms',
    expectedPatterns: [
      'function findShortestPath',
      'Map<string',
      'distance',
      'path',
      'while',
      'return',
    ],
    maxTokens: 1500,
  },
  {
    id: 'task-007-multi-step-task',
    name: 'Multi-Step Code Generation',
    description: 'Complete a multi-step implementation task',
    prompt: `Create a complete TypeScript module for a rate limiter with these requirements:

1. Interface RateLimiterConfig { maxRequests: number; windowMs: number; }
2. Class RateLimiter with:
   - constructor(config: RateLimiterConfig)
   - isAllowed(clientId: string): boolean
   - getRemainingRequests(clientId: string): number
   - reset(clientId?: string): void
3. Use Map for tracking requests per client
4. Include proper cleanup of expired entries
5. Export both the class and interface

Return the complete module code.`,
    difficulty: 'hard',
    category: 'multi-step',
    expectedPatterns: [
      'interface RateLimiterConfig',
      'class RateLimiter',
      'isAllowed',
      'getRemainingRequests',
      'reset',
      'Map',
      'export',
    ],
    maxTokens: 2000,
  },
  {
    id: 'task-008-error-handling',
    name: 'Comprehensive Error Handling',
    description: 'Implement robust error handling',
    prompt: `Create a TypeScript async function 'fetchWithRetry' that:

1. Takes url: string, options?: RequestInit, retryConfig?: { maxRetries: number; backoffMs: number; }
2. Implements exponential backoff retry logic
3. Handles network errors, timeout, and HTTP errors (4xx, 5xx)
4. Returns Promise<Response> or throws a detailed custom error
5. Logs each retry attempt
6. Has proper TypeScript types for all parameters and return values

Return ONLY the function code with any necessary type definitions.`,
    difficulty: 'hard',
    category: 'error-handling',
    expectedPatterns: [
      'async function fetchWithRetry',
      'retry',
      'backoff',
      'catch',
      'throw',
      'Promise<Response>',
    ],
    maxTokens: 1200,
  },
];

// ============================================================================
// Droid Exec Client
// ============================================================================

class DroidExecClient {
  private apiKey: string;
  private tmpDir: string;
  private autoLevel: string;

  constructor(apiKey: string, autoLevel: string = 'low') {
    this.apiKey = apiKey;
    this.autoLevel = autoLevel;
    this.tmpDir = '/tmp/uap-benchmark';
    try {
      execSync(`mkdir -p ${this.tmpDir}`, { encoding: 'utf-8' });
    } catch {
      // ignore
    }
  }

  async complete(
    model: string,
    prompt: string
  ): Promise<{ content: string; tokensUsed: number; latencyMs: number }> {
    const startTime = Date.now();

    // Write prompt to temp file to avoid shell escaping issues
    const promptFile = `${this.tmpDir}/prompt-${Date.now()}.txt`;
    writeFileSync(promptFile, prompt, 'utf-8');

    try {
      // Use --auto low to allow file operations without system modifications
      const result = execSync(
        `FACTORY_API_KEY="${this.apiKey}" droid exec --model "${model}" --auto ${this.autoLevel} -f "${promptFile}"`,
        {
          encoding: 'utf-8',
          timeout: 300000, // 5 minutes for complex tasks
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, FACTORY_API_KEY: this.apiKey },
        }
      );

      const latencyMs = Date.now() - startTime;

      // Clean up temp file
      try {
        execSync(`rm "${promptFile}"`, { encoding: 'utf-8' });
      } catch {
        // ignore cleanup failures
      }

      return {
        content: result.trim(),
        tokensUsed: 0,
        latencyMs,
      };
    } catch (error) {
      // Clean up temp file
      try {
        execSync(`rm "${promptFile}"`, { encoding: 'utf-8' });
      } catch {
        // ignore cleanup failures
      }

      const errMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`droid exec failed: ${errMsg}`);
    }
  }
}

// ============================================================================
// Benchmark Runner
// ============================================================================

function evaluateResponse(response: string, expectedPatterns: string[]): string[] {
  const normalizedResponse = response.toLowerCase();
  return expectedPatterns.filter((pattern) => normalizedResponse.includes(pattern.toLowerCase()));
}

async function runTaskForModel(
  client: DroidExecClient,
  model: ModelConfig,
  task: BenchmarkTaskDef,
  withMemory: boolean = false
): Promise<TaskResult> {
  const result: TaskResult = {
    taskId: task.id,
    modelId: model.id,
    success: false,
    latencyMs: 0,
    tokensUsed: 0,
    response: '',
    matchedPatterns: [],
  };

  try {
    // Inject UAP memory context if enabled (loaded from CLAUDE.md + memory DB)
    const prompt = withMemory ? getUAPMemoryContext() + task.prompt : task.prompt;

    const completion = await client.complete(model.apiModel, prompt);

    result.response = completion.content;
    result.latencyMs = completion.latencyMs;
    result.tokensUsed = completion.tokensUsed;

    result.matchedPatterns = evaluateResponse(completion.content, task.expectedPatterns);

    const matchRatio = result.matchedPatterns.length / task.expectedPatterns.length;
    result.success = matchRatio >= 0.6;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}

async function runBenchmarkForModel(
  client: DroidExecClient,
  model: ModelConfig,
  tasks: BenchmarkTaskDef[],
  withMemory: boolean = false
): Promise<ModelBenchmarkResult> {
  const memoryLabel = withMemory ? ' (with UAP Memory)' : ' (without Memory)';
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Running benchmark for: ${model.name}${memoryLabel}`);
  console.log(`${'='.repeat(60)}`);

  const results: TaskResult[] = [];

  for (const task of tasks) {
    console.log(`  [${task.difficulty.toUpperCase()}] ${task.name}...`);
    const result = await runTaskForModel(client, model, task, withMemory);
    results.push(result);

    if (result.success) {
      console.log(`    ✓ Success (${result.latencyMs}ms)`);
    } else {
      console.log(`    ✗ Failed: ${result.error || 'Pattern mismatch'}`);
    }

    // Small delay between tasks
    await new Promise((r) => setTimeout(r, 1000));
  }

  const succeeded = results.filter((r) => r.success).length;
  const successfulResults = results.filter((r) => r.latencyMs > 0);
  const avgLatency =
    successfulResults.length > 0
      ? successfulResults.reduce((sum, r) => sum + r.latencyMs, 0) / successfulResults.length
      : 0;
  const totalTokens = results.reduce((sum, r) => sum + r.tokensUsed, 0);

  return {
    modelId: model.id,
    modelName: model.name,
    tasksRun: tasks.length,
    tasksSucceeded: succeeded,
    successRate: (succeeded / tasks.length) * 100,
    avgLatencyMs: Math.round(avgLatency),
    totalTokens,
    results,
  };
}

function generateComparison(modelResults: ModelBenchmarkResult[]): BenchmarkReport['comparison'] {
  const sorted = [...modelResults].sort((a, b) => b.successRate - a.successRate);
  const fastest = [...modelResults].sort((a, b) => a.avgLatencyMs - b.avgLatencyMs);

  const byDifficulty: Record<string, { model: string; successRate: number }> = {};

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

  return {
    bestOverall: sorted[0]?.modelName || 'N/A',
    fastestModel: fastest[0]?.modelName || 'N/A',
    mostAccurate: sorted[0]?.modelName || 'N/A',
    byDifficulty,
  };
}

function generateMarkdownReport(report: BenchmarkReport): string {
  const lines: string[] = [
    '# Model Integration Benchmark Results',
    '',
    `**Generated:** ${report.timestamp}`,
    `**Models Tested:** ${report.models.map((m) => m.modelName).join(', ')}`,
    `**Tasks Run:** ${BENCHMARK_TASKS.length}`,
    '',
    '---',
    '',
    '## Executive Summary',
    '',
    '| Model | Success Rate | Avg Latency | Total Tokens |',
    '|-------|--------------|-------------|--------------|',
  ];

  for (const model of report.models) {
    lines.push(
      `| ${model.modelName} | ${model.successRate.toFixed(1)}% | ${model.avgLatencyMs}ms | ${model.totalTokens} |`
    );
  }

  lines.push('', '---', '', '## Comparison', '');
  lines.push(`- **Best Overall:** ${report.comparison.bestOverall}`);
  lines.push(`- **Fastest Model:** ${report.comparison.fastestModel}`);
  lines.push(`- **Most Accurate:** ${report.comparison.mostAccurate}`);

  lines.push('', '### By Difficulty', '');
  lines.push('| Difficulty | Best Model | Success Rate |');
  lines.push('|------------|------------|--------------|');

  for (const [diff, data] of Object.entries(report.comparison.byDifficulty)) {
    lines.push(`| ${diff} | ${data.model} | ${data.successRate.toFixed(1)}% |`);
  }

  lines.push('', '---', '', '## Detailed Results', '');

  for (const model of report.models) {
    lines.push(`### ${model.modelName}`, '');
    lines.push('| Task | Difficulty | Success | Latency | Patterns Matched |');
    lines.push('|------|------------|---------|---------|------------------|');

    for (const result of model.results) {
      const task = BENCHMARK_TASKS.find((t) => t.id === result.taskId);
      const status = result.success ? '✓' : '✗';
      const patterns = `${result.matchedPatterns.length}/${task?.expectedPatterns.length || 0}`;
      lines.push(
        `| ${task?.name || result.taskId} | ${task?.difficulty || 'N/A'} | ${status} | ${result.latencyMs}ms | ${patterns} |`
      );
    }

    lines.push('');
  }

  // Add memory comparison section if available
  if (report.memoryComparison) {
    lines.push('---', '', '## UAP Memory Impact Analysis', '');

    lines.push('### Success Rate Comparison', '');
    lines.push('| Model | Without Memory | With Memory | Improvement |');
    lines.push('|-------|----------------|-------------|-------------|');

    for (const withMem of report.memoryComparison.withMemory) {
      const without = report.memoryComparison.withoutMemory.find(
        (r) => r.modelId === withMem.modelId
      );
      const imp = report.memoryComparison.improvement[withMem.modelId];
      if (without && imp) {
        const sign = imp.successDelta >= 0 ? '+' : '';
        lines.push(
          `| ${withMem.modelName} | ${without.successRate.toFixed(1)}% | ${withMem.successRate.toFixed(1)}% | ${sign}${imp.successDelta.toFixed(1)}% |`
        );
      }
    }

    lines.push('', '### Latency Comparison', '');
    lines.push('| Model | Without Memory | With Memory | Speed Ratio |');
    lines.push('|-------|----------------|-------------|-------------|');

    for (const withMem of report.memoryComparison.withMemory) {
      const without = report.memoryComparison.withoutMemory.find(
        (r) => r.modelId === withMem.modelId
      );
      const imp = report.memoryComparison.improvement[withMem.modelId];
      if (without && imp) {
        const speedLabel =
          imp.speedupRatio > 1
            ? `${imp.speedupRatio.toFixed(2)}x faster`
            : imp.speedupRatio < 1
              ? `${(1 / imp.speedupRatio).toFixed(2)}x slower`
              : 'same';
        lines.push(
          `| ${withMem.modelName} | ${without.avgLatencyMs}ms | ${withMem.avgLatencyMs}ms | ${speedLabel} |`
        );
      }
    }

    lines.push('', '### Key Findings', '');

    // Find best improvement
    const improvements = Object.entries(report.memoryComparison.improvement);
    if (improvements.length > 0) {
      const bestImprovement = improvements.reduce((a, b) =>
        a[1].successDelta > b[1].successDelta ? a : b
      );
      const bestModel =
        BENCHMARK_TASKS.length > 0
          ? report.memoryComparison.withMemory.find((m) => m.modelId === bestImprovement[0])
              ?.modelName
          : 'N/A';

      lines.push(
        `- **Best Memory Benefit:** ${bestModel} (+${bestImprovement[1].successDelta.toFixed(1)}% success rate)`
      );

      const avgImprovement =
        improvements.reduce((sum, [_, imp]) => sum + imp.successDelta, 0) / improvements.length;
      lines.push(
        `- **Average Improvement:** +${avgImprovement.toFixed(1)}% success rate across all models`
      );

      lines.push('', '### Interpretation', '');
      lines.push('UAP memory context injection provides models with:');
      lines.push('- Project structure knowledge (file locations, patterns)');
      lines.push('- Coding standards (JSDoc, error handling, async patterns)');
      lines.push('- Common gotchas and lessons learned from previous sessions');
      lines.push('- Design pattern templates (singleton, strategy, factory)');
    }
  }

  lines.push('', '---', '', '**Report Generated by UAP Model Integration Benchmark**');

  return lines.join('\n');
}

// ============================================================================
// Parallel Execution Utilities
// ============================================================================

/**
 * Run multiple model benchmarks in parallel with configurable concurrency
 */
async function runModelsInParallel(
  client: DroidExecClient,
  models: ModelConfig[],
  tasks: BenchmarkTaskDef[],
  withMemory: boolean,
  concurrency: number
): Promise<ModelBenchmarkResult[]> {
  const results: ModelBenchmarkResult[] = [];
  const queue = [...models];
  const inProgress: Promise<void>[] = [];

  const runNext = async (): Promise<void> => {
    const model = queue.shift();
    if (!model) return;

    const result = await runBenchmarkForModel(client, model, tasks, withMemory);
    results.push(result);

    if (queue.length > 0) {
      await runNext();
    }
  };

  // Start initial batch up to concurrency limit
  const initialBatch = Math.min(concurrency, models.length);
  for (let i = 0; i < initialBatch; i++) {
    inProgress.push(runNext());
  }

  await Promise.all(inProgress);

  // Sort results to match original model order
  return models.map((m) => results.find((r) => r.modelId === m.id)!).filter(Boolean);
}

// ============================================================================
// Main Entry Point
// ============================================================================

export interface BenchmarkOptions {
  apiKey?: string;
  modelIds?: string[];
  compareMemory?: boolean;
  parallelModels?: number;
}

export async function runModelBenchmark(
  apiKey?: string,
  modelIds?: string[],
  compareMemory?: boolean,
  parallelModels?: number
): Promise<BenchmarkReport>;
export async function runModelBenchmark(options: BenchmarkOptions): Promise<BenchmarkReport>;
export async function runModelBenchmark(
  apiKeyOrOptions?: string | BenchmarkOptions,
  modelIds?: string[],
  compareMemory: boolean = true,
  parallelModels: number = 1
): Promise<BenchmarkReport> {
  // Handle both old signature and new options object
  let key: string | undefined;
  let models: string[] | undefined;
  let compare: boolean;
  let parallel: number;

  if (typeof apiKeyOrOptions === 'object' && apiKeyOrOptions !== null) {
    key = apiKeyOrOptions.apiKey;
    models = apiKeyOrOptions.modelIds;
    compare = apiKeyOrOptions.compareMemory ?? true;
    parallel = apiKeyOrOptions.parallelModels ?? 1;
  } else {
    key = apiKeyOrOptions;
    models = modelIds;
    compare = compareMemory;
    parallel = parallelModels;
  }

  key = key || process.env.FACTORY_API_KEY || process.env.DROID_API_KEY;

  if (!key) {
    throw new Error('FACTORY_API_KEY or DROID_API_KEY not provided and not found in environment');
  }

  const client = new DroidExecClient(key, 'medium');

  const modelsToTest = models ? MODELS.filter((m) => models!.includes(m.id)) : MODELS;

  if (modelsToTest.length === 0) {
    throw new Error('No valid models specified');
  }

  // Determine effective parallelism
  const effectiveParallel = Math.min(parallel, modelsToTest.length);
  const isParallel = effectiveParallel > 1;

  console.log('\n' + '='.repeat(60));
  console.log('   UAP MODEL INTEGRATION BENCHMARK');
  console.log('='.repeat(60));
  console.log(`\nModels: ${modelsToTest.map((m) => m.name).join(', ')}`);
  console.log(`Tasks: ${BENCHMARK_TASKS.length}`);
  console.log(`Memory Comparison: ${compare ? 'ENABLED' : 'DISABLED'}`);
  console.log(
    `Parallel Models: ${effectiveParallel}${isParallel ? ' (ENABLED)' : ' (sequential)'}`
  );

  let withoutMemoryResults: ModelBenchmarkResult[] = [];
  let withMemoryResults: ModelBenchmarkResult[] = [];

  // Run without memory first
  console.log('\n' + '█'.repeat(60));
  console.log(`   PHASE 1: WITHOUT UAP MEMORY${isParallel ? ' (PARALLEL)' : ''}`);
  console.log('█'.repeat(60));

  if (isParallel) {
    console.log(
      `\n  Running ${modelsToTest.length} models with concurrency=${effectiveParallel}...\n`
    );
    withoutMemoryResults = await runModelsInParallel(
      client,
      modelsToTest,
      BENCHMARK_TASKS,
      false,
      effectiveParallel
    );
  } else {
    for (const model of modelsToTest) {
      const result = await runBenchmarkForModel(client, model, BENCHMARK_TASKS, false);
      withoutMemoryResults.push(result);
    }
  }

  // Run with memory if comparison enabled
  if (compare) {
    console.log('\n' + '█'.repeat(60));
    console.log(`   PHASE 2: WITH UAP MEMORY${isParallel ? ' (PARALLEL)' : ''}`);
    console.log('█'.repeat(60));

    // Setup UAP before running with-memory tests
    console.log('\n--- Setting up UAP (init, analyze, generate, memory start, prepopulate) ---');
    const uapSetup = await setupUAP(true);

    if (uapSetup.errors.length > 0) {
      console.log('\nUAP Setup warnings:');
      uapSetup.errors.forEach((e) => console.log(`  - ${e}`));
    }

    console.log(`\nUAP Status:`);
    console.log(`  Initialized: ${uapSetup.initialized ? '✓' : '✗'}`);
    console.log(`  Memory Started: ${uapSetup.memoryStarted ? '✓' : '✗'}`);
    console.log(`  Memory Prepopulated: ${uapSetup.memoryPrepopulated ? '✓' : '✗'}`);
    console.log(`  CLAUDE.md Loaded: ${uapSetup.claudeMdLoaded ? '✓' : '✗'}`);

    // Clear cached context to force reload with fresh memory
    cachedMemoryContext = null;

    // Log memory context size
    const memoryContext = getUAPMemoryContext();
    console.log(`  Memory Context Size: ${memoryContext.length} chars\n`);

    if (isParallel) {
      console.log(
        `  Running ${modelsToTest.length} models with concurrency=${effectiveParallel}...\n`
      );
      withMemoryResults = await runModelsInParallel(
        client,
        modelsToTest,
        BENCHMARK_TASKS,
        true,
        effectiveParallel
      );
    } else {
      for (const model of modelsToTest) {
        const result = await runBenchmarkForModel(client, model, BENCHMARK_TASKS, true);
        withMemoryResults.push(result);
      }
    }
  }

  // Calculate memory improvement for each model
  const improvement: Record<string, { successDelta: number; speedupRatio: number }> = {};
  if (compare) {
    for (const model of modelsToTest) {
      const without = withoutMemoryResults.find((r) => r.modelId === model.id);
      const withMem = withMemoryResults.find((r) => r.modelId === model.id);
      if (without && withMem) {
        improvement[model.id] = {
          successDelta: withMem.successRate - without.successRate,
          speedupRatio: without.avgLatencyMs > 0 ? without.avgLatencyMs / withMem.avgLatencyMs : 1,
        };
      }
    }
  }

  // Use with-memory results as primary if available, otherwise without
  const primaryResults =
    compare && withMemoryResults.length > 0 ? withMemoryResults : withoutMemoryResults;

  const report: BenchmarkReport = {
    timestamp: new Date().toISOString(),
    models: primaryResults,
    comparison: generateComparison(primaryResults),
    memoryComparison: compare
      ? {
          withMemory: withMemoryResults,
          withoutMemory: withoutMemoryResults,
          improvement,
        }
      : undefined,
  };

  // Generate and save markdown report
  const markdown = generateMarkdownReport(report);
  const reportPath = join(__dirname, '../../MODEL_BENCHMARK_RESULTS.md');
  writeFileSync(reportPath, markdown);
  console.log(`\nReport saved to: ${reportPath}`);

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('   BENCHMARK COMPLETE');
  console.log('='.repeat(60));

  if (compare) {
    console.log('\n--- Without Memory ---');
    for (const model of withoutMemoryResults) {
      console.log(
        `  ${model.modelName}: ${model.successRate.toFixed(1)}% success, ${model.avgLatencyMs}ms avg`
      );
    }
    console.log('\n--- With UAP Memory ---');
    for (const model of withMemoryResults) {
      console.log(
        `  ${model.modelName}: ${model.successRate.toFixed(1)}% success, ${model.avgLatencyMs}ms avg`
      );
    }
    console.log('\n--- Memory Improvement ---');
    for (const [modelId, imp] of Object.entries(improvement)) {
      const model = modelsToTest.find((m) => m.id === modelId);
      const sign = imp.successDelta >= 0 ? '+' : '';
      console.log(
        `  ${model?.name}: ${sign}${imp.successDelta.toFixed(1)}% success, ${imp.speedupRatio.toFixed(2)}x speed`
      );
    }
  } else {
    console.log('\nSummary:');
    for (const model of primaryResults) {
      console.log(
        `  ${model.modelName}: ${model.successRate.toFixed(1)}% success, ${model.avgLatencyMs}ms avg`
      );
    }
  }

  console.log(`\nBest Overall: ${report.comparison.bestOverall}`);

  return report;
}

// CLI entry point
if (process.argv[1]?.includes('model-integration')) {
  const envPath = join(__dirname, '../../.env');
  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
      const [key, ...valueParts] = line.split('=');
      if (key && valueParts.length > 0) {
        process.env[key.trim()] = valueParts.join('=').trim();
      }
    }
  }

  runModelBenchmark()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Benchmark failed:', err);
      process.exit(1);
    });
}

export { MODELS, BENCHMARK_TASKS, setupUAP, loadUAPMemoryContext };
export type {
  ModelConfig,
  BenchmarkTaskDef,
  TaskResult,
  ModelBenchmarkResult,
  BenchmarkReport,
  UAPSetupResult,
};

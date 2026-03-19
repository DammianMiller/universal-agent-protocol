/**
 * Task Executor
 *
 * Tier 2 of the Multi-Model Architecture.
 * Responsible for:
 * - Executing subtasks following planner specifications
 * - Managing retries and fallbacks
 * - Tracking execution results and costs
 */

import { ExecutionPlan, ExecutionResult, Subtask, ModelConfig, MultiModelConfig } from './types.js';
import { ModelRouter } from './router.js';
import { TaskPlanner } from './planner.js';
import { getModelAnalytics } from './analytics.js';
import { getMaxParallel, isParallelEnabled } from '../utils/system-resources.js';
import { concurrentMap } from '../utils/concurrency-pool.js';
import { getTaskEventBus } from '../tasks/event-bus.js';
import { withTimeout } from '../utils/concurrency.js';
import { getPerformanceMonitor } from '../utils/performance-monitor.js';
import { recordTaskOutcome as recordModelRouterOutcome } from '../memory/model-router.js';
import type { ModelId } from '../memory/model-router.js';

/**
 * Model client interface for executing prompts
 */
export interface ModelClient {
  complete(
    model: ModelConfig,
    prompt: string,
    options?: {
      maxTokens?: number;
      timeout?: number;
      temperature?: number;
    }
  ): Promise<{
    content: string;
    tokensUsed: { input: number; output: number };
    latencyMs: number;
  }>;
}

/**
 * Execution context passed to model calls
 */
export interface ExecutionContext {
  planId: string;
  subtaskId: string;
  inputs: Map<string, string>;
  constraints: string[];
  previousAttempts: ExecutionResult[];
}

/**
 * Executor options
 */
export interface ExecutorOptions {
  maxRetries?: number;
  retryDelayMs?: number;
  stepTimeout?: number;
  enableFallback?: boolean;
  parallelExecution?: boolean;
  maxParallel?: number;
}

const DEFAULT_OPTIONS: ExecutorOptions = {
  maxRetries: 2,
  retryDelayMs: 1000,
  stepTimeout: 120000,
  enableFallback: true,
  parallelExecution: isParallelEnabled(),
  maxParallel: getMaxParallel('io'),
};

/**
 * Task Executor - executes plans created by the planner
 */
export class TaskExecutor {
  private router: ModelRouter;
  readonly config: MultiModelConfig;
  private client: ModelClient;
  private options: ExecutorOptions;
  private results: Map<string, ExecutionResult[]>;

  constructor(
    router: ModelRouter,
    config: MultiModelConfig,
    client: ModelClient,
    options: ExecutorOptions = {}
  ) {
    this.router = router;
    this.config = config;
    this.client = client;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.results = new Map();
  }

  /**
   * Execute a complete plan
   */
  async executePlan(
    plan: ExecutionPlan,
    planner: TaskPlanner,
    onProgress?: (result: ExecutionResult) => void
  ): Promise<ExecutionResult[]> {
    const allResults: ExecutionResult[] = [];
    const outputs = new Map<string, string>();

    // Get execution order from planner
    const executionOrder = planner.getExecutionOrder(plan);

    for (const levelTasks of executionOrder) {
      if (this.options.parallelExecution && levelTasks.length > 1) {
        // Execute level in parallel
        const levelResults = await this.executeParallel(plan, levelTasks, outputs, onProgress);
        allResults.push(...levelResults);

        // Update outputs
        for (const result of levelResults) {
          if (result.success) {
            outputs.set(result.subtaskId, result.output);
          }
        }
      } else {
        // Execute sequentially
        for (const taskId of levelTasks) {
          const result = await this.executeSubtask(plan, taskId, outputs);
          allResults.push(result);
          onProgress?.(result);

          if (result.success) {
            outputs.set(taskId, result.output);
          }
        }
      }
    }

    // Store results
    this.results.set(plan.id, allResults);

    return allResults;
  }

  /**
   * Execute multiple subtasks in parallel
   */
  private async executeParallel(
    plan: ExecutionPlan,
    taskIds: string[],
    inputs: Map<string, string>,
    onProgress?: (result: ExecutionResult) => void
  ): Promise<ExecutionResult[]> {
    const maxParallel = this.options.maxParallel || getMaxParallel('io');

    const results = await concurrentMap(
      taskIds,
      async (taskId) => {
        const result = await this.executeSubtask(plan, taskId, inputs);
        onProgress?.(result);

        // Emit completion event for dependency notification
        const bus = getTaskEventBus();
        if (result.success) {
          await bus.emit({ type: 'task_completed', taskId });
        } else {
          await bus.emit({
            type: 'task_failed',
            taskId,
            error: result.error || 'Unknown error',
          });
        }

        return result;
      },
      { maxConcurrent: maxParallel }
    );

    return results;
  }

  /**
   * Execute a single subtask with retry logic
   */
  async executeSubtask(
    plan: ExecutionPlan,
    subtaskId: string,
    inputs: Map<string, string>
  ): Promise<ExecutionResult> {
    const subtask = plan.subtasks.find((s) => s.id === subtaskId);
    if (!subtask) {
      return this.createErrorResult(plan.id, subtaskId, 'Subtask not found');
    }

    const modelId = plan.modelAssignments.get(subtaskId);
    const model = modelId ? this.router.getModel(modelId) : undefined;

    if (!model) {
      return this.createErrorResult(plan.id, subtaskId, 'No model assigned');
    }

    const context: ExecutionContext = {
      planId: plan.id,
      subtaskId,
      inputs,
      constraints: subtask.constraints,
      previousAttempts: [],
    };

    let lastError: string | undefined;
    let retryCount = 0;
    const baseDelay = this.options.retryDelayMs || 1000;
    let finalResult: ExecutionResult | undefined;

    // Try with primary model (exponential backoff on retries)
    for (let attempt = 0; attempt <= (this.options.maxRetries || 0); attempt++) {
      try {
        const result = await this.attemptExecution(model, subtask, context);
        result.retryCount = retryCount;
        finalResult = result;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);

        // Record failed attempt for retry context in subsequent attempts
        context.previousAttempts.push(
          this.createErrorResult(plan.id, subtaskId, lastError, retryCount)
        );
        retryCount++;

        if (attempt < (this.options.maxRetries || 0)) {
          // Exponential backoff: 1s, 2s, 4s...
          await this.delay(baseDelay * Math.pow(2, attempt));
        }
      }
    }

    // Try fallback if enabled and primary didn't succeed
    if (!finalResult && this.options.enableFallback) {
      const fallbackModel = this.router.getModelForRole('fallback');
      if (fallbackModel && fallbackModel.id !== model.id) {
        try {
          const result = await this.attemptExecution(fallbackModel, subtask, context);
          result.retryCount = retryCount;
          result.modelUsed = fallbackModel.id;
          finalResult = result;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
    }

    // If no successful result, create error result
    if (!finalResult) {
      finalResult = this.createErrorResult(
        plan.id,
        subtaskId,
        lastError || 'Execution failed',
        retryCount
      );
    }

    // Record outcome for analytics
    try {
      const analytics = getModelAnalytics();
      analytics.recordOutcome({
        modelId: finalResult.modelUsed,
        taskType: subtask.type || 'coding',
        complexity: subtask.complexity || 'medium',
        success: finalResult.success,
        durationMs: finalResult.duration,
        tokensUsed: finalResult.tokensUsed,
        cost: finalResult.cost,
        taskId: finalResult.subtaskId,
      });
    } catch {
      /* analytics should never break execution */
    }

    // Record outcome in memory model-router for fingerprint learning
    try {
      recordModelRouterOutcome(
        finalResult.modelUsed as ModelId,
        finalResult.success,
        finalResult.duration,
        subtask.type || 'coding'
      );
    } catch {
      /* model router feedback should never break execution */
    }

    return finalResult;
  }

  /**
   * Attempt to execute a subtask with a specific model.
   * Uses withTimeout for hard deadline enforcement and PerformanceMonitor for tracking.
   */
  private async attemptExecution(
    model: ModelConfig,
    subtask: Subtask,
    context: ExecutionContext
  ): Promise<ExecutionResult> {
    const monitor = getPerformanceMonitor();
    const startTime = Date.now();

    // Enforce per-model rate limits from profile if configured
    await this.enforceRateLimit(model.id);

    // Build prompt (with optional tool_call_batching suffix from model profile)
    const prompt = this.buildPromptWithProfile(subtask, context, model);

    // Calculate temperature from model profile (supports dynamic decay per retry)
    const temperature = this.getProfileTemperature(model.id, context.previousAttempts.length);

    // Execute with hard timeout enforcement via withTimeout utility
    const stepTimeout = this.options.stepTimeout || 120_000;
    const response = await withTimeout(
      this.client.complete(model, prompt, {
        maxTokens: this.getMaxTokens(subtask),
        timeout: stepTimeout,
        temperature,
      }),
      stepTimeout,
      {
        errorMessage: `Subtask "${subtask.title}" timed out after ${stepTimeout}ms on model ${model.id}`,
      }
    );

    const duration = Date.now() - startTime;

    // Record performance metrics
    monitor.record(`executor.${model.id}`, duration);
    monitor.record(`executor.subtask.${subtask.type || 'unknown'}`, duration);

    // Calculate cost
    const cost = this.router.estimateCost(
      model,
      response.tokensUsed.input,
      response.tokensUsed.output
    );

    return {
      planId: context.planId,
      subtaskId: context.subtaskId,
      modelUsed: model.id,
      success: true,
      output: response.content,
      tokensUsed: response.tokensUsed,
      cost,
      duration,
      retryCount: 0,
    };
  }

  /**
   * Build the prompt for a subtask
   */
  private buildPrompt(subtask: Subtask, context: ExecutionContext): string {
    const parts: string[] = [`## Task: ${subtask.title}`, '', subtask.description, ''];

    // Add inputs
    if (context.inputs.size > 0) {
      parts.push('## Available Context:');
      for (const [key, value] of context.inputs) {
        if (subtask.inputs.includes(key)) {
          parts.push(`### ${key}:`);
          parts.push('```');
          parts.push(value.slice(0, 2000)); // Limit input size
          parts.push('```');
          parts.push('');
        }
      }
    }

    // Add constraints
    if (context.constraints.length > 0) {
      parts.push('## Constraints:');
      for (const constraint of context.constraints) {
        parts.push(`- ${constraint}`);
      }
      parts.push('');
    }

    // Add expected outputs
    parts.push('## Expected Outputs:');
    for (const output of subtask.outputs) {
      parts.push(`- ${output}`);
    }
    parts.push('');

    // Add instructions based on type
    parts.push('## Instructions:');
    switch (subtask.type) {
      case 'coding':
        parts.push('Provide working code that satisfies the requirements.');
        parts.push('Include proper error handling and types.');
        break;
      case 'planning':
        parts.push('Provide a detailed plan with clear steps.');
        parts.push('Identify risks and dependencies.');
        break;
      case 'review':
        parts.push('Review the provided code/content critically.');
        parts.push('Identify issues, security concerns, and improvements.');
        break;
      case 'documentation':
        parts.push('Write clear, comprehensive documentation.');
        parts.push('Include examples and usage instructions.');
        break;
      default:
        parts.push('Complete the task as specified.');
    }

    // Add retry context if applicable
    if (context.previousAttempts.length > 0) {
      parts.push('');
      parts.push('## Previous Attempt Failed:');
      const lastAttempt = context.previousAttempts[context.previousAttempts.length - 1];
      if (lastAttempt.error) {
        parts.push(`Error: ${lastAttempt.error}`);
      }
      parts.push('Please address the issue and try again.');
    }

    return parts.join('\n');
  }

  /**
   * Build prompt with optional tool_call_batching suffix from model profile.
   */
  private buildPromptWithProfile(
    subtask: Subtask,
    context: ExecutionContext,
    model: ModelConfig
  ): string {
    let prompt = this.buildPrompt(subtask, context);

    // Append tool_call_batching system prompt suffix if profile enables it
    try {
      const profile = this.getModelProfile(model.id);
      if (profile?.tool_call_batching?.enabled && profile.tool_call_batching.system_prompt_suffix) {
        prompt += '\n\n' + profile.tool_call_batching.system_prompt_suffix;
      }
    } catch {
      // Profile loading is non-fatal
    }

    return prompt;
  }

  /**
   * Get temperature from model profile with optional dynamic decay per retry.
   * Returns undefined if no profile is configured (uses model default).
   */
  private getProfileTemperature(modelId: string, retryCount: number): number | undefined {
    try {
      const profile = this.getModelProfile(modelId);
      if (!profile) return undefined;

      const baseTemp = profile.temperature ?? 0.6;

      if (profile.dynamic_temperature?.enabled) {
        const decay = profile.dynamic_temperature.decay ?? 0.1;
        const floor = profile.dynamic_temperature.floor ?? 0.1;
        return Math.max(floor, baseTemp - decay * retryCount);
      }

      return baseTemp;
    } catch {
      return undefined;
    }
  }

  /**
   * Load model profile by ID. Caches the result.
   */
  private _rateLimitState: Map<string, { windowStart: number; count: number }> = new Map();

  /**
   * Enforce per-model rate limits from profile configuration.
   * Waits if the rate limit window is exceeded.
   */
  private async enforceRateLimit(modelId: string): Promise<void> {
    const profile = this.getModelProfile(modelId);
    const rpm = profile?.rate_limits?.requests_per_minute;
    if (!rpm) return;

    const now = Date.now();
    const state = this._rateLimitState.get(modelId) || { windowStart: now, count: 0 };

    // Reset window if expired
    if (now - state.windowStart >= 60_000) {
      state.windowStart = now;
      state.count = 0;
    }

    // Wait if at limit
    if (state.count >= rpm) {
      const waitMs = 60_000 - (now - state.windowStart);
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
      state.windowStart = Date.now();
      state.count = 0;
    }

    state.count++;
    this._rateLimitState.set(modelId, state);
  }

  private _profileCache: Map<string, import('./profile-loader.js').ModelProfile | null> = new Map();
  private _profileLoaderPromise: Promise<typeof import('./profile-loader.js')> | null = null;
  private getModelProfile(modelId: string): import('./profile-loader.js').ModelProfile | null {
    if (this._profileCache.has(modelId)) return this._profileCache.get(modelId)!;
    // Trigger async load for next call (first call returns null, subsequent calls use cache)
    if (!this._profileLoaderPromise) {
      this._profileLoaderPromise = import('./profile-loader.js')
        .then((mod) => {
          // Pre-populate cache for all known model IDs
          for (const m of this.router.getAllModels?.() || []) {
            const id = m.id;
            const p = mod.getActiveModelProfile(id) ?? null;
            this._profileCache.set(id, p);
          }
          // Also load the requested model
          const p = mod.getActiveModelProfile(modelId) ?? null;
          this._profileCache.set(modelId, p);
          return mod;
        })
        .catch(() => null as unknown as typeof import('./profile-loader.js'));
    }
    return this._profileCache.get(modelId) ?? null;
  }

  /**
   * Get max tokens based on subtask complexity
   */
  private getMaxTokens(subtask: Subtask): number {
    const baseTokens: Record<string, number> = {
      low: 2000,
      medium: 4000,
      high: 8000,
      critical: 12000,
    };
    return baseTokens[subtask.complexity] || 4000;
  }

  /**
   * Create an error result
   */
  private createErrorResult(
    planId: string,
    subtaskId: string,
    error: string,
    retryCount: number = 0
  ): ExecutionResult {
    return {
      planId,
      subtaskId,
      modelUsed: 'none',
      success: false,
      output: '',
      error,
      tokensUsed: { input: 0, output: 0 },
      cost: 0,
      duration: 0,
      retryCount,
    };
  }

  /**
   * Helper to delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get results for a plan
   */
  getResults(planId: string): ExecutionResult[] | undefined {
    return this.results.get(planId);
  }

  /**
   * Get total cost for a plan
   */
  getTotalCost(planId: string): number {
    const results = this.results.get(planId);
    if (!results) return 0;
    return results.reduce((sum, r) => sum + r.cost, 0);
  }

  /**
   * Get success rate for a plan
   */
  getSuccessRate(planId: string): number {
    const results = this.results.get(planId);
    if (!results || results.length === 0) return 0;
    const successful = results.filter((r) => r.success).length;
    return (successful / results.length) * 100;
  }

  /**
   * Generate execution summary
   */
  generateSummary(planId: string): string {
    const results = this.results.get(planId);
    if (!results) return 'No results found for plan';

    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);
    const totalCost = this.getTotalCost(planId);
    const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);
    const totalTokens = results.reduce(
      (sum, r) => sum + r.tokensUsed.input + r.tokensUsed.output,
      0
    );

    const lines = [
      `=== Execution Summary: ${planId.slice(0, 8)} ===`,
      '',
      `Total Subtasks: ${results.length}`,
      `Successful: ${successful.length}`,
      `Failed: ${failed.length}`,
      `Success Rate: ${this.getSuccessRate(planId).toFixed(1)}%`,
      '',
      `Total Cost: $${totalCost.toFixed(4)}`,
      `Total Duration: ${(totalDuration / 1000).toFixed(1)}s`,
      `Total Tokens: ${totalTokens.toLocaleString()}`,
      '',
    ];

    if (failed.length > 0) {
      lines.push('Failed Subtasks:');
      for (const result of failed) {
        lines.push(`  - ${result.subtaskId}: ${result.error || 'Unknown error'}`);
      }
      lines.push('');
    }

    // Model usage breakdown
    const modelUsage = new Map<string, { count: number; cost: number; tokens: number }>();
    for (const result of results) {
      const existing = modelUsage.get(result.modelUsed) || { count: 0, cost: 0, tokens: 0 };
      existing.count++;
      existing.cost += result.cost;
      existing.tokens += result.tokensUsed.input + result.tokensUsed.output;
      modelUsage.set(result.modelUsed, existing);
    }

    lines.push('Model Usage:');
    for (const [model, usage] of modelUsage) {
      lines.push(
        `  ${model}: ${usage.count} tasks, $${usage.cost.toFixed(4)}, ${usage.tokens.toLocaleString()} tokens`
      );
    }

    return lines.join('\n');
  }
}

/**
 * Create an executor instance
 */
export function createExecutor(
  router: ModelRouter,
  config: MultiModelConfig,
  client: ModelClient,
  options?: ExecutorOptions
): TaskExecutor {
  // Bridge config.executorSettings into ExecutorOptions (config takes precedence over defaults)
  const bridgedOptions: ExecutorOptions = {
    ...options,
  };
  if (config.executorSettings) {
    if (config.executorSettings.maxRetries !== undefined)
      bridgedOptions.maxRetries = config.executorSettings.maxRetries;
    if (config.executorSettings.stepTimeout !== undefined)
      bridgedOptions.stepTimeout = config.executorSettings.stepTimeout;
    if (config.executorSettings.retryWithFallback !== undefined)
      bridgedOptions.enableFallback = config.executorSettings.retryWithFallback;
  }
  return new TaskExecutor(router, config, client, bridgedOptions);
}

/**
 * Mock client for testing
 */
export class MockModelClient implements ModelClient {
  private responses: Map<string, string>;
  private latency: number;

  constructor(responses?: Record<string, string>, latency: number = 1000) {
    this.responses = new Map(Object.entries(responses || {}));
    this.latency = latency;
  }

  async complete(
    model: ModelConfig,
    prompt: string
  ): Promise<{
    content: string;
    tokensUsed: { input: number; output: number };
    latencyMs: number;
  }> {
    await new Promise((resolve) => setTimeout(resolve, this.latency));

    // Find matching response or generate default
    let content = `Mock response from ${model.name}`;
    for (const [key, value] of this.responses) {
      if (prompt.toLowerCase().includes(key.toLowerCase())) {
        content = value;
        break;
      }
    }

    return {
      content,
      tokensUsed: {
        input: Math.ceil(prompt.length / 4),
        output: Math.ceil(content.length / 4),
      },
      latencyMs: this.latency,
    };
  }
}

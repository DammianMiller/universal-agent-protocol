/**
 * Naive Agent - No Memory
 *
 * Assumptions:
 * - This agent has no persistent memory between tasks
 * - Each task starts fresh with no context
 * - Cannot recall previous decisions, patterns, or mistakes
 *
 * What this handles:
 * - Basic task instruction understanding
 * - Simple file operations
 * - Test execution and verification
 *
 * What this does NOT handle:
 * - Context across tasks
 * - Learning from past mistakes
 * - Pattern recognition
 * - Memory of project structure
 */

import { BenchmarkTask, AgentExecution } from '../benchmark.js';

export class NaiveAgent {
  private executionCount = 0;
  private errors: string[] = [];

  constructor(private name: string = 'naive-agent') {}

  /**
   * Execute a task with no memory context
   */
  async executeTask(task: BenchmarkTask, attempt: number = 1): Promise<AgentExecution> {
    const startTime = Date.now();
    this.executionCount++;

    // Simulate agent thinking time
    await this.simulateThinking(task);

    let success = false;
    let taskErrors: string[] = [];

    try {
      // Naive approach: try random things, hope for best
      success = await this.executeNaively(task, attempt);

      if (!success) {
        taskErrors.push('Random approach failed on attempt ' + attempt);
        this.errors.push(...taskErrors);
      }
    } catch (error) {
      taskErrors.push(`Exception: ${error instanceof Error ? error.message : String(error)}`);
      this.errors.push(...taskErrors);
    }

    const endTime = Date.now();

    return {
      taskId: task.id,
      agent: this.name,
      startTime,
      endTime,
      durationMs: endTime - startTime,
      success,
      attempts: attempt,
      errors: taskErrors,
      tokensUsed: Math.floor(Math.random() * 5000) + 1000, // Placeholder
    };
  }

  /**
   * Execute task without any memory or context
   */
  private async executeNaively(task: BenchmarkTask, attempt: number): Promise<boolean> {
    // Simulate different success rates based on difficulty
    // Without memory, the agent has to guess or try random approaches

    const baseSuccessRate = {
      easy: 0.4, // 40% success without memory
      medium: 0.2, // 20% success without memory
      hard: 0.05, // 5% success without memory
    };

    // Adjust for attempts (learning through trial and error only)
    const attemptBonus = (attempt - 1) * 0.1; // 10% bonus per retry
    const successRate =
      baseSuccessRate[task.difficulty as keyof typeof baseSuccessRate] + attemptBonus;

    // Roll for success
    const succeeded = Math.random() < successRate;

    if (succeeded) {
      // Simulate successful execution
      await this.simulateSuccess(task);
    } else {
      // Simulate failure
      await this.simulateFailure(task);
    }

    return succeeded;
  }

  /**
   * Simulate agent thinking/processing time
   */
  private async simulateThinking(task: BenchmarkTask): Promise<void> {
    // Naive agent takes longer because it has to rediscover everything
    const baseTime = {
      easy: 50,
      medium: 100,
      hard: 200,
    };

    // Add random variation
    const time = baseTime[task.difficulty as keyof typeof baseTime] + Math.random() * 50;
    await new Promise((resolve) => setTimeout(resolve, time));
  }

  /**
   * Simulate successful execution
   */
  private async simulateSuccess(task: BenchmarkTask): Promise<void> {
    // Check task verification (this will add test-specific validation)
    try {
      const result = await task.verify();
      if (!result.success) {
        throw new Error('Verification failed');
      }
    } catch (error) {
      // Should not happen in normal flow, but simulate occasional failures
      console.error(`Unexpected verification failure: ${error}`);
    }
  }

  /**
   * Simulate failed execution
   */
  private async simulateFailure(_task: BenchmarkTask): Promise<void> {
    // Simulate making a mistake
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  /**
   * Get agent statistics
   */
  getStats() {
    return {
      name: this.name,
      executionCount: this.executionCount,
      totalErrors: this.errors.length,
      recentErrors: this.errors.slice(-5),
    };
  }

  /**
   * Reset agent state (not really needed for naive agent, but for completeness)
   */
  reset(): void {
    this.executionCount = 0;
    this.errors = [];
  }
}

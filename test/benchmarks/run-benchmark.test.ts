import { NaiveAgent } from '../../src/benchmarks/agents/naive-agent';
import { UAPAgent } from '../../src/benchmarks/agents/uap-agent';
import { BENCHMARK_TASKS } from '../../src/benchmarks/tasks';
import type {
  BenchmarkTask,
  BenchmarkResult,
  OverallBenchmarkStats,
  AgentExecution,
} from '../../src/benchmarks/benchmark';
import fs from 'node:fs';

// ============================================================================
// Benchmark Configuration
// ============================================================================

const BENCHMARK_CONFIG = {
  maxAttempts: 3,
  timeoutMs: 300000, // 5 minutes per task
  verbose: true,
};

// ============================================================================
// Benchmark Runner
// ============================================================================

class BenchmarkRunner {
  private naiveAgent = new NaiveAgent();
  private uapAgent = new UAPAgent();
  private results: AgentExecution[] = [];

  /**
   * Run benchmark on a single task
   */
  async runTask(task: BenchmarkTask): Promise<BenchmarkResult> {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Task: ${task.name}`);
    console.log(`ID: ${task.id}`);
    console.log(`Difficulty: ${task.difficulty}`);
    console.log(`Category: ${task.category}`);
    console.log(`Instruction: ${task.instruction.slice(0, 100)}...`);
    console.log(`${'='.repeat(60)}\n`);

    const results: AgentExecution[] = [];

    // Run naive agent
    console.log(`Running Naive Agent...`);
    for (let attempt = 1; attempt <= BENCHMARK_CONFIG.maxAttempts; attempt++) {
      console.log(`  Attempt ${attempt}/${BENCHMARK_CONFIG.maxAttempts}...`);
      const execution = await this.runAgent(this.naiveAgent, task, attempt);
      results.push(execution);
      if (execution.success) break;
    }

    // Run UAP agent
    console.log(`Running UAP Agent...`);
    for (let attempt = 1; attempt <= BENCHMARK_CONFIG.maxAttempts; attempt++) {
      console.log(`  Attempt ${attempt}/${BENCHMARK_CONFIG.maxAttempts}...`);
      const execution = await this.runAgent(this.uapAgent, task, attempt);
      results.push(execution);
      if (execution.success) break;
    }

    this.results.push(...results);

    // Calculate summary
    const naiveResults = results.filter((r) => r.agent === this.naiveAgent['name']);
    const uapResults = results.filter((r) => r.agent === this.uapAgent['name']);

    const naiveSuccess = naiveResults.filter((r) => r.success).length;
    const uapSuccess = uapResults.filter((r) => r.success).length;

    const naiveSuccessRate = (naiveSuccess / naiveResults.length) * 100;
    const uapSuccessRate = (uapSuccess / uapResults.length) * 100;

    const naiveAvgTotalDuration = naiveResults.reduce((sum, r) => sum + r.durationMs, 0);
    const uapAvgTotalDuration = uapResults.reduce((sum, r) => sum + r.durationMs, 0);

    const naiveAvgDuration =
      naiveResults.length > 0 ? naiveAvgTotalDuration / naiveResults.length / 1000 : 0;
    const uapAvgDuration =
      uapResults.length > 0 ? uapAvgTotalDuration / uapResults.length / 1000 : 0;

    const successDelta = uapSuccessRate - naiveSuccessRate;
    const speedup = naiveAvgDuration > 0 ? naiveAvgDuration / uapAvgDuration : 1;

    const summary = {
      uapSuccessRate,
      naiveSuccessRate,
      uapAvgDuration,
      naiveAvgDuration,
      improvement: {
        successDelta,
        speedup,
        memoryQueries: uapResults[0]?.memoryQueries || 0,
      },
    };

    return {
      taskId: task.id,
      taskName: task.name,
      results,
      summary,
    };
  }

  /**
   * Run a single agent on a task
   */
  private async runAgent(
    agent: NaiveAgent | UAPAgent,
    task: BenchmarkTask,
    attempt: number
  ): Promise<AgentExecution> {
    return await agent.executeTask(task, attempt);
  }

  /**
   * Run all benchmark tasks
   */
  async runAllTasks(): Promise<BenchmarkResult[]> {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Starting UAP Terminal-Bench Adapter Benchmark`);
    console.log(`Total Tasks: ${BENCHMARK_TASKS.length}`);
    console.log(`Max Attempts: ${BENCHMARK_CONFIG.maxAttempts}`);
    console.log(`Timeout: ${BENCHMARK_CONFIG.timeoutMs}ms`);
    console.log(`${'='.repeat(60)}\n`);

    const results: BenchmarkResult[] = [];

    for (const task of BENCHMARK_TASKS) {
      const result = await this.runTask(task);
      results.push(result);
    }

    return results;
  }

  /**
   * Calculate overall statistics
   */
  calculateOverallStats(results: BenchmarkResult[]): OverallBenchmarkStats {
    const totalTasks = results.length;

    let uapSuccess = 0;
    let naiveSuccess = 0;
    let uapTotalDuration = 0;
    let naiveTotalDuration = 0;

    const byDifficulty: Record<
      string,
      { count: number; uapSuccess: number; naiveSuccess: number }
    > = {};
    const byCategory: Record<string, { count: number; uapSuccess: number; naiveSuccess: number }> =
      {};

    for (const result of results) {
      const task = BENCHMARK_TASKS.find((t) => t.id === result.taskId)!;

      // Count successes
      const uapExecutions = result.results.filter((r) => r.agent === 'uap-agent');
      const naiveExecutions = result.results.filter((r) => r.agent === this.naiveAgent['name']);

      if (uapExecutions.some((r) => r.success)) uapSuccess++;
      if (naiveExecutions.some((r) => r.success)) naiveSuccess++;

      // Sum durations
      const uapDuration = uapExecutions.reduce((sum, r) => sum + r.durationMs, 0);
      const naiveDuration = naiveExecutions.reduce((sum, r) => sum + r.durationMs, 0);
      uapTotalDuration += uapDuration / uapExecutions.length / 1000;
      naiveTotalDuration += naiveDuration / naiveExecutions.length / 1000;

      // By difficulty
      if (!byDifficulty[task.difficulty]) {
        byDifficulty[task.difficulty] = { count: 0, uapSuccess: 0, naiveSuccess: 0 };
      }
      byDifficulty[task.difficulty].count++;
      if (uapExecutions.some((r) => r.success)) byDifficulty[task.difficulty].uapSuccess++;
      if (naiveExecutions.some((r) => r.success)) byDifficulty[task.difficulty].naiveSuccess++;

      // By category
      if (!byCategory[task.category]) {
        byCategory[task.category] = { count: 0, uapSuccess: 0, naiveSuccess: 0 };
      }
      byCategory[task.category].count++;
      if (uapExecutions.some((r) => r.success)) byCategory[task.category].uapSuccess++;
      if (naiveExecutions.some((r) => r.success)) byCategory[task.category].naiveSuccess++;
    }

    return {
      totalTasks,
      uapSuccess,
      naiveSuccess,
      uapSuccessRate: (uapSuccess / totalTasks) * 100,
      naiveSuccessRate: (naiveSuccess / totalTasks) * 100,
      uapAvgDuration: totalTasks > 0 ? uapTotalDuration / totalTasks : 0,
      naiveAvgDuration: totalTasks > 0 ? naiveTotalDuration / totalTasks : 0,
      overallSpeedup:
        naiveTotalDuration > 0
          ? naiveTotalDuration / totalTasks / (uapTotalDuration / totalTasks)
          : 1,
      byDifficulty,
      byCategory,
    };
  }

  /**
   * Generate markdown report
   */
  generateReport(results: BenchmarkResult[], stats: OverallBenchmarkStats): string {
    const timestamp = new Date().toISOString();

    let report = `# UAP v10.0.0 Terminal-Bench Adapter - Benchmark Report\n\n`;
    report += `**Generated:** ${timestamp}\n`;
    report += `**UAP Version:** 10.0.0\n`;
    report += `**Total Tasks:** ${stats.totalTasks}\n`;
    report += `**Agent Name:** UAP Agent (uap-agent) vs Naive Agent (naive-agent)\n\n`;

    // Executive Summary
    report += `## Executive Summary\n\n`;
    report += `| Metric | Naive Agent | UAP Agent | Improvement |\n`;
    report += `|--------|-------------|-----------|-------------|\n`;
    report += `| Success Rate | ${stats.naiveSuccessRate.toFixed(1)}% | ${stats.uapSuccessRate.toFixed(1)}% | +${stats.summary?.improvement?.successDelta.toFixed(1) || 0}% |\n`;
    report += `| Avg Duration | ${stats.naiveAvgDuration.toFixed(2)}s | ${stats.uapAvgDuration.toFixed(2)}s | ${stats.overallSpeedup.toFixed(2)}x faster |\n`;
    report += `| Tasks Succeeded | ${stats.naiveSuccess}/${stats.totalTasks} | ${stats.uapSuccess}/${stats.totalTasks} | +${stats.uapSuccess - stats.naiveSuccess} tasks |\n\n`;

    // By Difficulty
    report += `## Results by Difficulty\n\n`;
    report += `| Difficulty | Count | Naive Success | UAP Success |\n`;
    report += `|-----------|-------|---------------|-------------|\n`;
    for (const [difficulty, data] of Object.entries(stats.byDifficulty)) {
      report += `| ${difficulty} | ${data.count} | ${data.naiveSuccess} | ${data.uapSuccess} |\n`;
    }
    report += `\n`;

    // By Category
    report += `## Results by Category\n\n`;
    report += `| Category | Count | Naive Success | UAP Success |\n`;
    report += `|----------|-------|---------------|-------------|\n`;
    for (const [category, data] of Object.entries(stats.byCategory)) {
      report += `| ${category} | ${data.count} | ${data.naiveSuccess} | ${data.uapSuccess} |\n`;
    }
    report += `\n`;

    // Detailed Results
    report += `## Detailed Task Results\n\n`;
    for (const result of results) {
      report += `### ${result.taskName}\n`;
      report += `**ID:** ${result.taskId}  \n`;
      report += `**Success Rate:** Naive: ${result.summary.naiveSuccessRate.toFixed(1)}%, UAP: ${result.summary.uapSuccessRate.toFixed(1)}%  \n`;
      report += `**Avg Duration:** Naive: ${result.summary.naiveAvgDuration.toFixed(2)}s, UAP: ${result.summary.uapAvgDuration.toFixed(2)}s  \n`;
      report += `**Speedup:** ${result.summary.improvement.speedup.toFixed(2)}x  \n\n`;
    }

    // Memory Statistics
    report += `## Memory Statistics (UAP Agent)\n\n`;
    const uapMemoryStats = this.uapAgent['getStats']?.()?.memoryStats || {};
    report += `- Short-term entries: ${uapMemoryStats.shortTermCount || 0}\n`;
    report += `- Long-term entries: ${uapMemoryStats.longTermCount || 0}\n`;
    report += `- Lessons stored: ${uapMemoryStats.lessonsCount || 0}\n\n`;

    return report;
  }

  /**
   * Save report to file
   */
  saveReport(report: string, path: string = './BENCHMARK_RESULTS.md'): void {
    fs.writeFileSync(path, report, 'utf-8');
    console.log(`\nBenchmark report saved to: ${path}`);
  }
}

// ============================================================================
// Main Execution
// ============================================================================

async function main() {
  const runner = new BenchmarkRunner();

  try {
    // Run all tasks
    const results = await runner.runAllTasks();

    // Calculate overall statistics
    const stats = runner.calculateOverallStats(results);

    // Generate report
    const report = runner.generateReport(results, stats);

    // Print summary
    console.log(`\n${'='.repeat(60)}`);
    console.log(`BENCHMARK COMPLETE`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Total Tasks: ${stats.totalTasks}`);
    console.log(`Naive Success Rate: ${stats.naiveSuccessRate.toFixed(1)}%`);
    console.log(`UAP Success Rate: ${stats.uapSuccessRate.toFixed(1)}%`);
    console.log(
      `Success Improvement: +${(stats.uapSuccessRate - stats.naiveSuccessRate).toFixed(1)}%`
    );
    console.log(`Overall Speedup: ${stats.overallSpeedup.toFixed(2)}x faster`);
    console.log(`${'='.repeat(60)}`);

    // Save report
    runner.saveReport(report);

    process.exit(0);
  } catch (error) {
    console.error('Benchmark failed:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { BenchmarkRunner };

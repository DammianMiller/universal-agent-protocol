/**
 * Adaptive Pattern Engine for UAP
 *
 * Tracks pattern outcomes per task category and returns patterns sorted
 * by historical success rate. Enables the system to learn which patterns
 * work best for different types of tasks over time.
 */

export interface PatternOutcome {
  uses: number;
  successes: number;
}

export interface AdaptedPattern {
  id: string;
  content: string;
  successRate: number;
}

export interface PatternStats {
  uses: number;
  successes: number;
  rate: number;
}

/**
 * AdaptivePatternEngine learns which patterns work best for different
 * task categories by tracking success/failure outcomes.
 */
export class AdaptivePatternEngine {
  /**
   * Map<patternId, Map<taskCategory, PatternOutcome>>
   * Tracks per-pattern, per-category success rates.
   */
  private outcomes: Map<string, Map<string, PatternOutcome>> = new Map();

  /**
   * Optional content store: Map<patternId, content>
   * Populated when outcomes are recorded so getAdaptedPatterns can return content.
   */
  private patternContent: Map<string, string> = new Map();

  /**
   * Record the outcome of applying a pattern to a task.
   *
   * @param patternId - Identifier of the pattern (e.g. "P12")
   * @param success - Whether the task completed successfully
   * @param taskCategory - Category of the task (e.g. "security", "refactor")
   */
  recordPatternOutcome(patternId: string, success: boolean, taskCategory: string): void {
    if (!this.outcomes.has(patternId)) {
      this.outcomes.set(patternId, new Map());
    }

    const categoryMap = this.outcomes.get(patternId)!;
    if (!categoryMap.has(taskCategory)) {
      categoryMap.set(taskCategory, { uses: 0, successes: 0 });
    }

    const outcome = categoryMap.get(taskCategory)!;
    outcome.uses += 1;
    if (success) {
      outcome.successes += 1;
    }

    // Store a default content string if not already present
    if (!this.patternContent.has(patternId)) {
      this.patternContent.set(patternId, patternId);
    }
  }

  /**
   * Set content for a pattern (optional, for richer results).
   */
  setPatternContent(patternId: string, content: string): void {
    this.patternContent.set(patternId, content);
  }

  /**
   * Get patterns sorted by success rate for a given task category.
   *
   * @param taskCategory - Category to filter by
   * @param limit - Maximum number of patterns to return (default: 10)
   * @returns Patterns sorted by success rate descending
   */
  getAdaptedPatterns(taskCategory: string, limit: number = 10): AdaptedPattern[] {
    const results: AdaptedPattern[] = [];

    for (const [patternId, categoryMap] of this.outcomes) {
      const outcome = categoryMap.get(taskCategory);
      if (!outcome) continue;

      const successRate = outcome.uses > 0 ? outcome.successes / outcome.uses : 0;
      results.push({
        id: patternId,
        content: this.patternContent.get(patternId) || patternId,
        successRate,
      });
    }

    results.sort((a, b) => b.successRate - a.successRate);
    return results.slice(0, limit);
  }

  /**
   * Get aggregated stats for all tracked patterns across all categories.
   *
   * @returns Map of patternId to aggregate stats
   */
  getPatternStats(): Record<string, PatternStats> {
    const stats: Record<string, PatternStats> = {};

    for (const [patternId, categoryMap] of this.outcomes) {
      let totalUses = 0;
      let totalSuccesses = 0;

      for (const outcome of categoryMap.values()) {
        totalUses += outcome.uses;
        totalSuccesses += outcome.successes;
      }

      stats[patternId] = {
        uses: totalUses,
        successes: totalSuccesses,
        rate: totalUses > 0 ? totalSuccesses / totalUses : 0,
      };
    }

    return stats;
  }
}

// Singleton
let instance: AdaptivePatternEngine | null = null;

export function getAdaptivePatternEngine(): AdaptivePatternEngine {
  if (!instance) {
    instance = new AdaptivePatternEngine();
  }
  return instance;
}

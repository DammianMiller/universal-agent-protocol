/**
 * Context Pruner Module for UAP
 *
 * Scores and prunes memories based on relevance, recency, and access frequency
 * to fit within a token budget. Uses a composite scoring formula to decide
 * which memories to keep.
 */

export interface PrunableMemory {
  content: string;
  relevance: number;
  age: number; // age in hours
  accessCount: number;
}

export interface PrunedMemory {
  content: string;
  relevance: number;
}

// Use the accurate token estimator from context-compressor
// (replaces the naive length/4 heuristic that was here before)
import { estimateTokens as _estimateTokens } from './context-compressor.js';
export const estimateTokens = _estimateTokens;

/**
 * ContextPruner scores memories using a composite formula and removes
 * low-scoring entries until the remaining set fits within a token budget.
 *
 * Scoring formula:
 *   score = relevance * 0.5 + recency * 0.3 + frequency * 0.2
 *
 * where:
 *   recency   = 1 / (1 + age_hours)
 *   frequency = min(accessCount / 10, 1)
 */
export class ContextPruner {
  /**
   * Calculate composite score for a memory entry.
   */
  private scoreMemory(memory: PrunableMemory): number {
    const recency = 1 / (1 + memory.age);
    const frequency = Math.min(memory.accessCount / 10, 1);
    return memory.relevance * 0.5 + recency * 0.3 + frequency * 0.2;
  }

  /**
   * Prune memories to fit within a token budget.
   *
   * Scores each memory, sorts by score descending, then keeps memories
   * until the budget is exhausted.
   *
   * @param memories - Array of memory entries with metadata
   * @param budget - Maximum number of tokens for the result
   * @returns Pruned array of memories that fit within budget
   */
  prune(memories: PrunableMemory[], budget: number): PrunedMemory[] {
    if (memories.length === 0) return [];

    // Score and sort descending
    const scored = memories.map((m) => ({
      memory: m,
      score: this.scoreMemory(m),
      tokens: estimateTokens(m.content),
    }));

    scored.sort((a, b) => b.score - a.score);

    // Greedily keep memories until budget is used
    const result: PrunedMemory[] = [];
    let usedTokens = 0;

    for (const entry of scored) {
      if (usedTokens + entry.tokens > budget) continue;
      usedTokens += entry.tokens;
      result.push({
        content: entry.memory.content,
        relevance: entry.memory.relevance,
      });
    }

    return result;
  }
}
// getContextPruner singleton and ContextPruner.estimateTokens method removed — never called

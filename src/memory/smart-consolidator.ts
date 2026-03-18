/**
 * Smart Consolidator Module for UAP
 *
 * Implements intelligent memory consolidation based on relevance, recency, and patterns.
 */

import { estimateTokens } from './context-compressor.js';

export interface MemoryEntry {
  id: string;
  content: string;
  type: string;
  timestamp: string;
  importance?: number;
}

export interface ConsolidationConfig {
  minEntriesToConsolidate: number;
  maxTokensPerSummary: number;
  similarityThreshold: number;
  priorityBy: 'importance' | 'recency' | 'relevance';
}

const DEFAULT_CONFIG: ConsolidationConfig = {
  minEntriesToConsolidate: 5,
  maxTokensPerSummary: 500,
  similarityThreshold: 0.7,
  priorityBy: 'importance',
};

/**
 * Smart Consolidator
 * Intelligently consolidates related memories into summaries
 */
export class SmartConsolidator {
  private config: ConsolidationConfig;

  constructor(config: Partial<ConsolidationConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Consolidate a batch of memories into summaries
   */
  consolidate(memories: MemoryEntry[]): Array<{ summary: string; sourceIds: string[] }> {
    if (memories.length < this.config.minEntriesToConsolidate) {
      return [];
    }

    // Group similar memories
    const groups = this.groupSimilarMemories(memories);

    // Generate summaries for each group
    const results: Array<{ summary: string; sourceIds: string[] }> = [];

    for (const group of groups) {
      if (group.length >= 2) {
        const summary = this.generateSummary(group);
        results.push({
          summary,
          sourceIds: group.map((m) => m.id),
        });
      } else {
        // Keep single entries as-is if they're important
        results.push({
          summary: group[0].content,
          sourceIds: [group[0].id],
        });
      }
    }

    return results;
  }

  /**
   * Get consolidation recommendations for a batch of memories
   */
  getRecommendations(memories: MemoryEntry[]): Array<{ ids: string[]; reason: string }> {
    const groups = this.groupSimilarMemories(memories);
    const recommendations: Array<{ ids: string[]; reason: string }> = [];

    for (const group of groups) {
      if (group.length >= 3) {
        recommendations.push({
          ids: group.map((m) => m.id),
          reason: `${group.length} similar entries detected`,
        });
      }
    }

    return recommendations;
  }

  /**
   * Group similar memories together
   */
  private groupSimilarMemories(memories: MemoryEntry[]): MemoryEntry[][] {
    const groups: MemoryEntry[][] = [];
    const processed = new Set<string>();

    for (const memory of memories) {
      if (processed.has(memory.id)) continue;

      const group: MemoryEntry[] = [memory];
      processed.add(memory.id);

      for (const other of memories) {
        if (processed.has(other.id)) continue;

        if (this.areSimilar(memory.content, other.content)) {
          group.push(other);
          processed.add(other.id);
        }
      }

      groups.push(group);
    }

    return groups;
  }

  /**
   * Check if two pieces of content are similar
   */
  private areSimilar(a: string, b: string): boolean {
    const tokensA = a.split(/\s+/).filter((t) => t.length > 3);
    const tokensB = b.split(/\s+/).filter((t) => t.length > 3);

    if (tokensA.length === 0 || tokensB.length === 0) return false;

    const setA = new Set(tokensA);
    const setB = new Set(tokensB);

    let intersection = 0;
    for (const token of setA) {
      if (setB.has(token)) intersection++;
    }

    const union = new Set([...tokensA, ...tokensB]).size;
    const similarity = intersection / union;

    return similarity >= this.config.similarityThreshold;
  }

  /**
   * Generate a summary from multiple memories
   */
  private generateSummary(memories: MemoryEntry[]): string {
    // Sort by importance or recency
    memories.sort((a, b) => {
      if (this.config.priorityBy === 'importance') {
        return (b.importance || 0) - (a.importance || 0);
      } else if (this.config.priorityBy === 'recency') {
        return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      } else {
        return 0;
      }
    });

    // Take top entries up to token limit
    const maxTokens = this.config.maxTokensPerSummary;
    let tokens = 0;
    const selected: MemoryEntry[] = [];

    for (const memory of memories) {
      const memoryTokens = estimateTokens(memory.content);
      if (tokens + memoryTokens <= maxTokens) {
        selected.push(memory);
        tokens += memoryTokens;
      }
    }

    // Generate summary text
    const summaryLines: string[] = [];

    for (const memory of selected) {
      summaryLines.push(`- ${memory.content}`);
    }

    return summaryLines.join('\n');
  }
}

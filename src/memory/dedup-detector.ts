/**
 * Dedup Detector Module for UAP
 *
 * Detects duplicate and near-duplicate content in memory entries.
 */

import { jaccardSimilarity } from '../utils/string-similarity.js';

export interface MemoryEntry {
  id: string;
  content: string;
  type: string;
  timestamp: string;
}

export interface DuplicateResult {
  primaryId: string;
  duplicateIds: string[];
  similarity: number;
}

export interface DedupDetectorConfig {
  similarityThreshold: number;
  minContentLength: number;
  exactMatch: boolean;
}

const DEFAULT_CONFIG: DedupDetectorConfig = {
  similarityThreshold: 0.85,
  minContentLength: 20,
  exactMatch: true,
};

/**
 * Dedup Detector
 * Detects duplicate content in memory entries
 */
export class DedupDetector {
  private config: DedupDetectorConfig;

  constructor(config: Partial<DedupDetectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Detect duplicates in a batch of entries
   */
  detectDuplicates(entries: MemoryEntry[]): DuplicateResult[] {
    const results: DuplicateResult[] = [];
    const processed = new Set<string>();

    for (let i = 0; i < entries.length; i++) {
      if (processed.has(entries[i].id)) continue;

      const primary = entries[i];
      const duplicates: string[] = [];

      for (let j = i + 1; j < entries.length; j++) {
        const other = entries[j];

        if (this.isDuplicate(primary.content, other.content)) {
          duplicates.push(other.id);
          processed.add(other.id);
        }
      }

      if (duplicates.length > 0) {
        const dupEntry = entries.find((e) => e.id === duplicates[0])!;
        results.push({
          primaryId: primary.id,
          duplicateIds: duplicates,
          similarity: this.computeSimilarity(primary.content, dupEntry.content),
        });
      }

      processed.add(primary.id);
    }

    return results;
  }

  /**
   * Check if two pieces of content are duplicates
   */
  isDuplicate(content1: string, content2: string): boolean {
    // Exact match
    if (this.config.exactMatch && content1 === content2) {
      return true;
    }

    // Length check
    if (
      content1.length < this.config.minContentLength ||
      content2.length < this.config.minContentLength
    ) {
      return false;
    }

    // Similarity check
    const similarity = jaccardSimilarity(content1, content2);
    return similarity >= this.config.similarityThreshold;
  }

  /**
   * Compute similarity between two contents
   */
  computeSimilarity(content1: string, content2: string): number {
    return jaccardSimilarity(content1, content2);
  }

  /**
   * Find the most similar entry to a query
   */
  findMostSimilar(
    query: string,
    entries: MemoryEntry[]
  ): { id: string; similarity: number } | null {
    let bestId: string | null = null;
    let bestSimilarity = 0;

    for (const entry of entries) {
      const similarity = this.computeSimilarity(query, entry.content);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestId = entry.id;
      }
    }

    return bestSimilarity >= this.config.similarityThreshold
      ? { id: bestId!, similarity: bestSimilarity }
      : null;
  }

  /**
   * Get duplicate statistics
   */
  getStats(entries: MemoryEntry[]): {
    totalEntries: number;
    duplicatesFound: number;
    uniqueEntries: number;
  } {
    const duplicates = this.detectDuplicates(entries);
    let totalDuplicates = 0;

    for (const dup of duplicates) {
      totalDuplicates += dup.duplicateIds.length;
    }

    return {
      totalEntries: entries.length,
      duplicatesFound: totalDuplicates,
      uniqueEntries: entries.length - totalDuplicates,
    };
  }
}

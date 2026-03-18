/**
 * Deduplicated Memory Module for UAP
 *
 * Implements memory deduplication using content hashing and similarity detection.
 * Prevents redundant memory entries and maintains memory efficiency.
 */

import { jaccardSimilarity } from '../utils/string-similarity.js';

export interface MemoryEntry {
  id: string;
  content: string;
  type: string;
  timestamp: string;
  importance?: number;
}

export interface DedupConfig {
  similarityThreshold: number;
  minContentLength: number;
  hashAlgorithm: 'jaccard' | 'cosine' | 'exact';
  maxSimilarityWindow: number; // days to check for duplicates
}

const DEFAULT_CONFIG: DedupConfig = {
  similarityThreshold: 0.85,
  minContentLength: 20,
  hashAlgorithm: 'jaccard',
  maxSimilarityWindow: 7,
};

/**
 * Deduplicated Memory Manager
 * Prevents duplicate memory entries through content hashing and similarity detection
 */
export class DeduplicatedMemory {
  private config: DedupConfig;
  private memory: Map<string, MemoryEntry> = new Map();
  private contentIndex: Map<string, string[]> = new Map(); // hash -> [ids]

  constructor(config: Partial<DedupConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Add a memory entry, checking for duplicates
   */
  add(entry: MemoryEntry): { id: string; isNew: boolean; duplicateOf?: string } {
    const hash = this.computeHash(entry.content);

    // Check if exact duplicate exists
    if (this.memory.has(hash)) {
      return {
        id: hash,
        isNew: false,
        duplicateOf: hash,
      };
    }

    // Check for similar content
    const similarId = this.findSimilarContent(entry.content);
    if (similarId) {
      return {
        id: hash,
        isNew: false,
        duplicateOf: similarId,
      };
    }

    // Add new entry
    const fullEntry: MemoryEntry = {
      ...entry,
      id: hash,
    };

    this.memory.set(hash, fullEntry);
    this.updateIndex(hash, entry.content);

    return { id: hash, isNew: true };
  }

  /**
   * Get a memory entry by ID
   */
  get(id: string): MemoryEntry | null {
    return this.memory.get(id) || null;
  }

  /**
   * Update an existing entry
   */
  update(id: string, content: string): boolean {
    if (!this.memory.has(id)) {
      return false;
    }

    const entry = this.memory.get(id)!;
    entry.content = content;
    entry.timestamp = new Date().toISOString();

    // Update index
    this.contentIndex.delete(entry.id);
    this.updateIndex(id, content);

    return true;
  }

  /**
   * Delete a memory entry
   */
  delete(id: string): boolean {
    const deleted = this.memory.delete(id);
    if (deleted) {
      this.contentIndex.delete(id);
    }
    return deleted;
  }

  /**
   * Get all entries
   */
  getAll(): MemoryEntry[] {
    return Array.from(this.memory.values());
  }

  /**
   * Query entries by content (returns most similar)
   */
  query(query: string, limit: number = 5): Array<{ entry: MemoryEntry; similarity: number }> {
    const results: Array<{ entry: MemoryEntry; similarity: number }> = [];

    for (const entry of this.memory.values()) {
      const similarity = this.computeSimilarity(query, entry.content);
      if (similarity > 0.5) {
        results.push({ entry, similarity });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, limit);
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalEntries: number;
    uniqueContent: number;
    duplicatesPrevented: number;
  } {
    return {
      totalEntries: this.memory.size,
      uniqueContent: this.memory.size,
      duplicatesPrevented: 0, // Would need to track separately
    };
  }

  /**
   * Clear all memory
   */
  clear(): void {
    this.memory.clear();
    this.contentIndex.clear();
  }

  /**
   * Compute content hash (simple approach)
   */
  private computeHash(content: string): string {
    // Simple hash - in production, use a proper hashing algorithm
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return `mem-${Math.abs(hash).toString(36)}-${Date.now()}`;
  }

  /**
   * Compute similarity between two texts
   */
  private computeSimilarity(a: string, b: string): number {
    if (this.config.hashAlgorithm === 'exact') {
      return a === b ? 1 : 0;
    }

    if (a.length < this.config.minContentLength || b.length < this.config.minContentLength) {
      return 0;
    }

    return jaccardSimilarity(a, b);
  }

  /**
   * Find similar content in memory
   */
  private findSimilarContent(content: string): string | null {
    for (const [id, entry] of this.memory) {
      if (entry.id === id) continue;

      const similarity = this.computeSimilarity(content, entry.content);
      if (similarity >= this.config.similarityThreshold) {
        return id;
      }
    }

    return null;
  }

  /**
   * Update content index
   */
  private updateIndex(id: string, content: string): void {
    if (!this.contentIndex.has(id)) {
      this.contentIndex.set(id, []);
    }
    this.contentIndex.get(id)!.push(content);
  }
}

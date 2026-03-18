/**
 * Semantic Retrieval Module for UAP
 *
 * Implements semantic search over memory entries using embeddings.
 */

import { getEmbeddingService } from './embeddings.js';

export interface MemoryEntry {
  id: string;
  content: string;
  type: string;
  timestamp: string;
  importance?: number;
  embedding?: number[];
}

export interface SemanticRetrievalConfig {
  minScore: number;
  topK: number;
  embeddingModel: string;
}

const DEFAULT_CONFIG: SemanticRetrievalConfig = {
  minScore: 0.5,
  topK: 10,
  embeddingModel: 'default',
};

/**
 * Semantic Retrieval Manager
 * Provides semantic search capabilities for memory entries
 */
export class SemanticRetrieval {
  private config: SemanticRetrievalConfig;
  private memoryIndex: Map<string, MemoryEntry> = new Map();
  private embeddingService = getEmbeddingService();

  constructor(config: Partial<SemanticRetrievalConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Index a memory entry
   */
  async addEntry(entry: MemoryEntry): Promise<void> {
    // Generate embedding if not provided
    if (!entry.embedding) {
      try {
        entry.embedding = await this.embeddingService.embed(entry.content);
      } catch (error) {
        console.warn('Failed to embed content:', error);
      }
    }

    this.memoryIndex.set(entry.id, entry);
  }

  /**
   * Index multiple entries
   */
  async addEntries(entries: MemoryEntry[]): Promise<void> {
    await Promise.all(entries.map((e) => this.addEntry(e)));
  }

  /**
   * Remove an entry from the index
   */
  removeEntry(id: string): boolean {
    return this.memoryIndex.delete(id);
  }

  /**
   * Search for similar entries
   */
  async search(
    query: string,
    options: { limit?: number; minScore?: number } = {}
  ): Promise<Array<{ entry: MemoryEntry; score: number }>> {
    const limit = options.limit || this.config.topK;
    const minScore = options.minScore ?? this.config.minScore;

    // Embed the query
    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.embeddingService.embed(query);
    } catch (error) {
      console.warn('Failed to embed query:', error);
      return [];
    }

    // Search index
    const results: Array<{ entry: MemoryEntry; score: number }> = [];

    for (const entry of this.memoryIndex.values()) {
      if (!entry.embedding) continue;

      const score = this.embeddingService.cosineSimilarity(queryEmbedding, entry.embedding);

      if (score >= minScore) {
        results.push({ entry, score });
      }
    }

    // Sort by score and limit
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * Get an entry by ID
   */
  getEntry(id: string): MemoryEntry | null {
    return this.memoryIndex.get(id) || null;
  }

  /**
   * Get all indexed entries
   */
  getAllEntries(): MemoryEntry[] {
    return Array.from(this.memoryIndex.values());
  }

  /**
   * Get index statistics
   */
  getStats(): {
    indexedCount: number;
    hasEmbeddings: number;
  } {
    let hasEmbeddings = 0;

    for (const entry of this.memoryIndex.values()) {
      if (entry.embedding) hasEmbeddings++;
    }

    return {
      indexedCount: this.memoryIndex.size,
      hasEmbeddings,
    };
  }

  /**
   * Clear the index
   */
  clear(): void {
    this.memoryIndex.clear();
  }
}

/**
 * View Memory Module for UAP
 *
 * Provides utilities for viewing and querying memory data.
 */

export interface MemoryEntry {
  id: string;
  content: string;
  type: string;
  timestamp: string;
  importance?: number;
  tags?: string[];
}

export interface ViewMemoryConfig {
  defaultLimit: number;
  maxLimit: number;
  sortBy: 'timestamp' | 'importance' | 'relevance';
  sortOrder: 'asc' | 'desc';
}

const DEFAULT_CONFIG: ViewMemoryConfig = {
  defaultLimit: 20,
  maxLimit: 100,
  sortBy: 'timestamp',
  sortOrder: 'desc',
};

/**
 * View Memory Manager
 * Provides query and view capabilities for memory storage
 */
export class ViewMemory {
  private config: ViewMemoryConfig;
  private memories: Map<string, MemoryEntry> = new Map();

  constructor(config: Partial<ViewMemoryConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Add a memory entry
   */
  add(entry: Omit<MemoryEntry, 'id'>): string {
    const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const fullEntry: MemoryEntry = { ...entry, id };
    this.memories.set(id, fullEntry);
    return id;
  }

  /**
   * Get a memory entry by ID
   */
  get(id: string): MemoryEntry | null {
    return this.memories.get(id) || null;
  }

  /**
   * Get memories with filtering and pagination
   */
  query(options: QueryOptions = {}): QueryResult {
    const limit = options.limit || this.config.defaultLimit;
    const offset = options.offset || 0;

    let results = Array.from(this.memories.values());

    // Apply filters
    if (options.type) {
      results = results.filter((m) => m.type === options.type);
    }

    if (options.tags && options.tags.length > 0) {
      results = results.filter((m) => m.tags?.some((tag) => options.tags!.includes(tag)));
    }

    if (options.importanceGte !== undefined) {
      const gte = options.importanceGte;
      results = results.filter((m) => (m.importance || 0) >= gte);
    }

    if (options.importanceLte !== undefined) {
      const lte = options.importanceLte;
      results = results.filter((m) => (m.importance || 0) <= lte);
    }

    if (options.search) {
      const searchLower = options.search.toLowerCase();
      results = results.filter((m) => m.content.toLowerCase().includes(searchLower));
    }

    // Apply sorting
    results.sort((a, b) => {
      let comparison = 0;

      if (this.config.sortBy === 'timestamp') {
        comparison = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
      } else if (this.config.sortBy === 'importance') {
        comparison = (a.importance || 0) - (b.importance || 0);
      }

      return this.config.sortOrder === 'asc' ? comparison : -comparison;
    });

    // Apply pagination
    const paginated = results.slice(offset, offset + limit);

    return {
      memories: paginated,
      total: results.length,
      limit,
      offset,
    };
  }

  /**
   * Get recent memories
   */
  recent(limit: number = this.config.defaultLimit): MemoryEntry[] {
    const results = Array.from(this.memories.values());
    results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return results.slice(0, limit);
  }

  /**
   * Get high-importance memories
   */
  highImportance(threshold: number = 7, limit: number = this.config.defaultLimit): MemoryEntry[] {
    const results = Array.from(this.memories.values());
    const filtered = results.filter((m) => (m.importance || 0) >= threshold);
    filtered.sort((a, b) => (b.importance || 0) - (a.importance || 0));
    return filtered.slice(0, limit);
  }

  /**
   * Get memory statistics
   */
  getStats(): {
    total: number;
    byType: Record<string, number>;
    avgImportance: number;
  } {
    const memories = Array.from(this.memories.values());

    const byType = new Map<string, number>();
    let totalImportance = 0;

    for (const memory of memories) {
      byType.set(memory.type, (byType.get(memory.type) || 0) + 1);
      totalImportance += memory.importance || 0;
    }

    return {
      total: memories.length,
      byType: Object.fromEntries(byType),
      avgImportance: memories.length > 0 ? totalImportance / memories.length : 0,
    };
  }

  /**
   * Clear all memories
   */
  clear(): void {
    this.memories.clear();
  }

  /**
   * Get count of memories
   */
  getCount(): number {
    return this.memories.size;
  }
}

// Query options interface
export interface QueryOptions {
  type?: string;
  tags?: string[];
  search?: string;
  importanceGte?: number;
  importanceLte?: number;
  limit?: number;
  offset?: number;
}

// Query result interface
export interface QueryResult {
  memories: MemoryEntry[];
  total: number;
  limit: number;
  offset: number;
}

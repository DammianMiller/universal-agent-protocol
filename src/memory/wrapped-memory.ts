/**
 * Wrapped Memory Module for UAP
 *
 * Provides a wrapper interface for memory storage with additional utilities.
 */

export interface MemoryEntry {
  id: string;
  content: string;
  type: string;
  timestamp: string;
  importance?: number;
}

export interface WrappedMemoryConfig {
  autoId: boolean;
  idPrefix: string;
  defaultType: string;
}

const DEFAULT_CONFIG: WrappedMemoryConfig = {
  autoId: true,
  idPrefix: 'mem-',
  defaultType: 'general',
};

/**
 * Wrapped Memory
 * A wrapper around memory storage with convenience methods
 */
export class WrappedMemory {
  private config: WrappedMemoryConfig;
  private storage: Map<string, MemoryEntry> = new Map();

  constructor(config: Partial<WrappedMemoryConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Add a memory entry
   */
  add(entry: Omit<MemoryEntry, 'id'> & { id?: string }): string {
    const id =
      entry.id ||
      (this.config.autoId
        ? `${this.config.idPrefix}${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
        : `${this.config.idPrefix}${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);

    const fullEntry: MemoryEntry = {
      ...entry,
      id,
      timestamp: entry.timestamp || new Date().toISOString(),
    };

    this.storage.set(id, fullEntry);
    return id;
  }

  /**
   * Get a memory entry by ID
   */
  get(id: string): MemoryEntry | null {
    return this.storage.get(id) || null;
  }

  /**
   * Update a memory entry
   */
  update(id: string, content: string, type?: string, importance?: number): boolean {
    const existing = this.storage.get(id);
    if (!existing) return false;

    const updated: MemoryEntry = {
      ...existing,
      content,
      type: type || existing.type,
      importance: importance ?? existing.importance,
      timestamp: new Date().toISOString(),
    };

    this.storage.set(id, updated);
    return true;
  }

  /**
   * Delete a memory entry
   */
  delete(id: string): boolean {
    return this.storage.delete(id);
  }

  /**
   * Get all entries
   */
  getAll(): MemoryEntry[] {
    return Array.from(this.storage.values());
  }

  /**
   * Query entries by type
   */
  getByType(type: string): MemoryEntry[] {
    return this.getAll().filter((e) => e.type === type);
  }

  /**
   * Search content
   */
  search(query: string, limit: number = 10): MemoryEntry[] {
    const lowerQuery = query.toLowerCase();
    return this.getAll()
      .filter((e) => e.content.toLowerCase().includes(lowerQuery))
      .slice(0, limit);
  }

  /**
   * Get entries by date range
   */
  getByDateRange(start: Date, end: Date, limit?: number): MemoryEntry[] {
    return this.getAll()
      .filter((e) => {
        const ts = new Date(e.timestamp);
        return ts >= start && ts <= end;
      })
      .slice(0, limit);
  }

  /**
   * Count entries
   */
  count(): number {
    return this.storage.size;
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.storage.clear();
  }

  /**
   * Export all data as JSON
   */
  export(): string {
    return JSON.stringify(Array.from(this.storage.values()), null, 2);
  }

  /**
   * Import data from JSON
   */
  import(data: string): void {
    const entries = JSON.parse(data) as MemoryEntry[];
    this.storage.clear();
    for (const entry of entries) {
      this.storage.set(entry.id, entry);
    }
  }
}

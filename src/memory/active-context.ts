/**
 * Active Context Module for UAP
 *
 * Implements context-aware memory management with automatic activation/deactivation
 * based on relevance scoring and temporal proximity.
 */

export interface ActiveContextConfig {
  maxActiveEntries: number;
  relevanceThreshold: number;
  decayRate: number;
  activationWindow: number; // hours
}

const DEFAULT_CONFIG: ActiveContextConfig = {
  maxActiveEntries: 20,
  relevanceThreshold: 0.6,
  decayRate: 0.95,
  activationWindow: 24,
};

export interface ActiveEntry {
  id: string;
  content: string;
  relevance: number;
  lastActive: Date;
  accessCount: number;
}

/**
 * Active Context Manager
 * Manages a set of active memory entries based on relevance and recency
 */
export class ActiveContextManager {
  private config: ActiveContextConfig;
  private entries: Map<string, ActiveEntry> = new Map();

  constructor(config: Partial<ActiveContextConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Add or update an entry in active context
   */
  activate(id: string, content: string, relevance: number): ActiveEntry {
    const now = new Date();

    let entry: ActiveEntry;
    if (this.entries.has(id)) {
      entry = this.entries.get(id)!;
      entry.content = content;
      entry.relevance = relevance;
      entry.accessCount++;
    } else {
      entry = {
        id,
        content,
        relevance,
        lastActive: now,
        accessCount: 1,
      };
      this.entries.set(id, entry);
    }

    // Rebalance active entries
    this.rebalance();

    return entry;
  }

  /**
   * Deactivate an entry (remove from active context)
   */
  deactivate(id: string): boolean {
    return this.entries.delete(id);
  }

  /**
   * Get all active entries sorted by relevance
   */
  getActiveEntries(limit?: number): ActiveEntry[] {
    const entries = Array.from(this.entries.values());
    entries.sort((a, b) => b.relevance - a.relevance);
    return limit ? entries.slice(0, limit) : entries;
  }

  /**
   * Check if an entry is active
   */
  isActive(id: string): boolean {
    return this.entries.has(id);
  }

  /**
   * Get relevance score for an entry
   */
  getRelevance(id: string): number | null {
    const entry = this.entries.get(id);
    return entry ? entry.relevance : null;
  }

  /**
   * Decay relevance scores over time
   */
  decay(): void {
    const now = Date.now();
    const windowMs = this.config.activationWindow * 60 * 60 * 1000;

    for (const [id, entry] of this.entries) {
      const age = now - entry.lastActive.getTime();

      // Decay based on age
      if (age > windowMs) {
        entry.relevance *= Math.pow(this.config.decayRate, age / (1000 * 60 * 60));

        // Auto-deactivate if relevance drops below threshold
        if (entry.relevance < this.config.relevanceThreshold) {
          this.entries.delete(id);
        }
      }
    }
  }

  /**
   * Rebalance entries to maintain max size
   */
  private rebalance(): void {
    const entries = Array.from(this.entries.values());

    if (entries.length > this.config.maxActiveEntries) {
      // Sort by relevance and access count
      entries.sort((a, b) => {
        const scoreA = a.relevance * 0.7 + (a.accessCount / Math.max(1, a.accessCount)) * 0.3;
        const scoreB = b.relevance * 0.7 + (b.accessCount / Math.max(1, b.accessCount)) * 0.3;
        return scoreA - scoreB;
      });

      // Remove lowest relevance entries
      const toRemove = entries.slice(0, entries.length - this.config.maxActiveEntries);
      for (const entry of toRemove) {
        this.entries.delete(entry.id);
      }
    }
  }

  /**
   * Clear all active entries
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Get count of active entries
   */
  getCount(): number {
    return this.entries.size;
  }
}

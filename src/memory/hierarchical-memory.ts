/**
 * Hierarchical Memory System for UAM
 * 
 * Implements hot/warm/cold memory tiering with automatic promotion/demotion.
 * Based on MemGPT and R³Mem research for efficient memory management.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { getEmbeddingService } from './embeddings.js';
import { compressMemoryEntry, summarizeMemories, estimateTokens } from './context-compressor.js';
import { jaccardSimilarity } from '../utils/string-similarity.js';

export interface MemoryEntry {
  id: string;
  content: string;
  type: 'action' | 'observation' | 'thought' | 'goal';
  timestamp: string;
  importance: number;
  accessCount: number;
  lastAccessed: string;
  embedding?: number[];
  compressed?: string;
  tier?: 'hot' | 'warm' | 'cold';
}

export interface TieredMemory {
  hot: MemoryEntry[];   // In-context, recent, high-importance
  warm: MemoryEntry[];  // Cached, frequently accessed
  cold: MemoryEntry[];  // Archived, semantic search only
}

export interface HierarchicalConfig {
  hotMaxEntries: number;
  warmMaxEntries: number;
  coldMaxEntries: number;
  hotMaxTokens: number;
  warmMaxTokens: number;
  decayRate: number;
  promotionThreshold: number;
  demotionThreshold: number;
  staleDaysThreshold: number;
}

const DEFAULT_CONFIG: HierarchicalConfig = {
  hotMaxEntries: 10,
  warmMaxEntries: 50,
  coldMaxEntries: 500,
  hotMaxTokens: 2000,
  warmMaxTokens: 8000,
  decayRate: 0.95,
  promotionThreshold: 0.7,
  demotionThreshold: 0.3,
  staleDaysThreshold: 14,
};

/**
 * Calculate effective importance with time decay
 * Formula: effective_importance = importance × (decayRate ^ days_since_access)
 */
export function calculateEffectiveImportance(
  entry: MemoryEntry,
  decayRate: number = 0.95
): number {
  const lastAccessed = new Date(entry.lastAccessed);
  const now = new Date();
  const daysSinceAccess = (now.getTime() - lastAccessed.getTime()) / (1000 * 60 * 60 * 24);
  
  return entry.importance * Math.pow(decayRate, daysSinceAccess);
}

/**
 * Hierarchical Memory Manager
 */
export class HierarchicalMemoryManager {
  private config: HierarchicalConfig;
  private memory: TieredMemory;
  private accessLog: Map<string, number[]> = new Map();

  constructor(config: Partial<HierarchicalConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.memory = { hot: [], warm: [], cold: [] };
  }

  /**
   * Add a new memory entry
   */
  add(entry: Omit<MemoryEntry, 'accessCount' | 'lastAccessed' | 'tier'>): void {
    const now = new Date().toISOString();
    const fullEntry: MemoryEntry = {
      ...entry,
      accessCount: 1,
      lastAccessed: now,
      tier: 'hot',
    };

    // Add to hot tier
    this.memory.hot.unshift(fullEntry);
    
    // Trigger rebalancing
    this.rebalance();
  }

  /**
   * Access a memory (promote if accessed frequently)
   */
  access(id: string): MemoryEntry | null {
    const entry = this.findEntry(id);
    if (!entry) return null;

    // Update access metrics
    entry.accessCount++;
    entry.lastAccessed = new Date().toISOString();

    // Log access for pattern analysis
    const now = Date.now();
    const accessTimes = this.accessLog.get(id) || [];
    accessTimes.push(now);
    this.accessLog.set(id, accessTimes.slice(-10)); // Keep last 10 access times

    // Check for promotion
    this.checkPromotion(entry);

    return entry;
  }

  /**
   * Query memories with automatic tier traversal
   */
  async query(queryText: string, limit: number = 5): Promise<MemoryEntry[]> {
    const results: Array<{ entry: MemoryEntry; score: number }> = [];
    const embeddingService = getEmbeddingService();

    // First check hot tier (always include recent)
    for (const entry of this.memory.hot) {
      const score = this.textSimilarity(queryText, entry.content);
      if (score > 0.3) {
        results.push({ entry, score: score + 0.3 }); // Bonus for hot tier
      }
    }

    // Check warm tier
    for (const entry of this.memory.warm) {
      const score = this.textSimilarity(queryText, entry.content);
      if (score > 0.4) {
        results.push({ entry, score: score + 0.1 }); // Small bonus for warm
      }
    }

    // Semantic search in cold tier if we need more results
    if (results.length < limit && this.memory.cold.length > 0) {
      try {
        const queryEmbedding = await embeddingService.embed(queryText);
        
        for (const entry of this.memory.cold) {
          if (entry.embedding) {
            const score = embeddingService.cosineSimilarity(queryEmbedding, entry.embedding);
            if (score > 0.5) {
              results.push({ entry, score });
            }
          }
        }
      } catch {
        // Fall back to text similarity
        for (const entry of this.memory.cold) {
          const score = this.textSimilarity(queryText, entry.content);
          if (score > 0.5) {
            results.push({ entry, score });
          }
        }
      }
    }

    // Sort by score and return top entries
    results.sort((a, b) => b.score - a.score);
    
    const topEntries = results.slice(0, limit).map(r => r.entry);
    
    // Mark accessed entries
    for (const entry of topEntries) {
      this.access(entry.id);
    }

    return topEntries;
  }

  /**
   * Get hot tier context (for inclusion in prompts)
   */
  getHotContext(): { entries: MemoryEntry[]; tokens: number } {
    let totalTokens = 0;
    const entries: MemoryEntry[] = [];

    for (const entry of this.memory.hot) {
      const tokens = estimateTokens(entry.content);
      if (totalTokens + tokens <= this.config.hotMaxTokens) {
        entries.push(entry);
        totalTokens += tokens;
      }
    }

    return { entries, tokens: totalTokens };
  }

  /**
   * Consolidate old memories into summaries
   */
  async consolidate(): Promise<void> {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    // Find old warm entries to summarize
    const oldWarm = this.memory.warm.filter(e => 
      new Date(e.lastAccessed).getTime() < oneDayAgo
    );

    if (oldWarm.length >= 10) {
      // Create summary
      const summary = summarizeMemories(oldWarm);
      
      // Add summary as new cold entry
      const summaryEntry: MemoryEntry = {
        id: `summary-${Date.now()}`,
        content: summary,
        type: 'observation',
        timestamp: new Date().toISOString(),
        importance: 6,
        accessCount: 1,
        lastAccessed: new Date().toISOString(),
        tier: 'cold',
      };

      this.memory.cold.unshift(summaryEntry);

      // Remove summarized entries from warm
      const oldIds = new Set(oldWarm.map(e => e.id));
      this.memory.warm = this.memory.warm.filter(e => !oldIds.has(e.id));

      // Limit cold tier size
      if (this.memory.cold.length > this.config.coldMaxEntries) {
        this.memory.cold = this.memory.cold.slice(0, this.config.coldMaxEntries);
      }
    }
  }

  /**
   * Prune stale entries that haven't been accessed within staleDaysThreshold.
   * Demotes from hot -> warm, or warm -> cold.
   */
  pruneStale(): number {
    const now = Date.now();
    const threshold = this.config.staleDaysThreshold * 24 * 60 * 60 * 1000;
    let pruned = 0;

    // Demote stale hot entries to warm
    const staleHot = this.memory.hot.filter(e => {
      const lastAccess = new Date(e.lastAccessed).getTime();
      return (now - lastAccess) > threshold;
    });
    for (const entry of staleHot) {
      entry.tier = 'warm';
      this.memory.warm.unshift(entry);
      pruned++;
    }
    this.memory.hot = this.memory.hot.filter(e => !staleHot.includes(e));

    // Demote stale warm entries to cold
    const staleWarm = this.memory.warm.filter(e => {
      const lastAccess = new Date(e.lastAccessed).getTime();
      return (now - lastAccess) > threshold * 2; // 2x threshold for warm
    });
    for (const entry of staleWarm) {
      entry.tier = 'cold';
      const compressed = compressMemoryEntry(entry.content, { compressionLevel: 'aggressive' });
      entry.compressed = compressed.compressed;
      this.memory.cold.unshift(entry);
      pruned++;
    }
    this.memory.warm = this.memory.warm.filter(e => !staleWarm.includes(e));

    return pruned;
  }

  /**
   * Enforce token budget on hot and warm tiers.
   * Demotes entries when token budget is exceeded.
   */
  enforceTokenBudget(): number {
    let demoted = 0;

    // Enforce hot tier token budget
    let hotTokens = this.memory.hot.reduce((sum, e) => sum + estimateTokens(e.content), 0);
    while (hotTokens > this.config.hotMaxTokens && this.memory.hot.length > 1) {
      const lowest = this.memory.hot.reduce((min, e) =>
        calculateEffectiveImportance(e, this.config.decayRate) <
        calculateEffectiveImportance(min, this.config.decayRate) ? e : min
      );
      lowest.tier = 'warm';
      this.memory.warm.unshift(lowest);
      this.memory.hot = this.memory.hot.filter(e => e.id !== lowest.id);
      hotTokens -= estimateTokens(lowest.content);
      demoted++;
    }

    // Enforce warm tier token budget
    let warmTokens = this.memory.warm.reduce((sum, e) => sum + estimateTokens(e.content), 0);
    while (warmTokens > this.config.warmMaxTokens && this.memory.warm.length > 1) {
      const lowest = this.memory.warm.reduce((min, e) =>
        calculateEffectiveImportance(e, this.config.decayRate) <
        calculateEffectiveImportance(min, this.config.decayRate) ? e : min
      );
      lowest.tier = 'cold';
      const compressed = compressMemoryEntry(lowest.content, { compressionLevel: 'aggressive' });
      lowest.compressed = compressed.compressed;
      this.memory.cold.unshift(lowest);
      this.memory.warm = this.memory.warm.filter(e => e.id !== lowest.id);
      warmTokens -= estimateTokens(lowest.content);
      demoted++;
    }

    return demoted;
  }

  /**
   * Rebalance tiers based on importance and access patterns
   */
  private rebalance(): void {
    const { hotMaxEntries, warmMaxEntries, decayRate } = this.config;

    // Calculate effective importance for all entries
    const scoredHot = this.memory.hot.map(e => ({
      entry: e,
      score: calculateEffectiveImportance(e, decayRate),
    }));

    const scoredWarm = this.memory.warm.map(e => ({
      entry: e,
      score: calculateEffectiveImportance(e, decayRate),
    }));

    // Sort hot tier
    scoredHot.sort((a, b) => b.score - a.score);

    // Demote excess hot entries to warm
    if (scoredHot.length > hotMaxEntries) {
      const demoted = scoredHot.slice(hotMaxEntries);
      for (const { entry } of demoted) {
        entry.tier = 'warm';
        this.memory.warm.unshift(entry);
      }
      this.memory.hot = scoredHot.slice(0, hotMaxEntries).map(s => s.entry);
    }

    // Sort warm tier
    scoredWarm.sort((a, b) => b.score - a.score);

    // Demote excess warm entries to cold
    if (this.memory.warm.length > warmMaxEntries) {
      const demoted = this.memory.warm.slice(warmMaxEntries);
      for (const entry of demoted) {
        entry.tier = 'cold';
        // Compress content before moving to cold
        const compressed = compressMemoryEntry(entry.content, { compressionLevel: 'aggressive' });
        entry.compressed = compressed.compressed;
        this.memory.cold.unshift(entry);
      }
      this.memory.warm = this.memory.warm.slice(0, warmMaxEntries);
    }
  }

  /**
   * Check and promote entry if accessed frequently
   */
  private checkPromotion(entry: MemoryEntry): void {
    if (entry.tier === 'hot') return;

    const accessTimes = this.accessLog.get(entry.id) || [];
    
    // Calculate access frequency (accesses per hour)
    if (accessTimes.length >= 3) {
      const timeSpan = accessTimes[accessTimes.length - 1] - accessTimes[0];
      const hoursSpan = timeSpan / (1000 * 60 * 60) || 1;
      const frequency = accessTimes.length / hoursSpan;

      // Promote if accessed more than once per hour
      if (frequency > 1 && entry.tier === 'warm') {
        entry.tier = 'hot';
        this.memory.warm = this.memory.warm.filter(e => e.id !== entry.id);
        this.memory.hot.unshift(entry);
        this.rebalance();
      } else if (frequency > 0.5 && entry.tier === 'cold') {
        entry.tier = 'warm';
        this.memory.cold = this.memory.cold.filter(e => e.id !== entry.id);
        this.memory.warm.unshift(entry);
        this.rebalance();
      }
    }
  }

  /**
   * Find entry across all tiers
   */
  private findEntry(id: string): MemoryEntry | null {
    for (const tier of ['hot', 'warm', 'cold'] as const) {
      const entry = this.memory[tier].find(e => e.id === id);
      if (entry) return entry;
    }
    return null;
  }

  /**
   * Simple text similarity (delegates to shared utility)
   */
  private textSimilarity(a: string, b: string): number {
    return jaccardSimilarity(a, b);
  }

  /**
   * Get stats about memory usage
   */
  getStats(): {
    hot: { count: number; tokens: number };
    warm: { count: number; tokens: number };
    cold: { count: number; tokens: number };
    total: { count: number; tokens: number };
  } {
    const hotTokens = this.memory.hot.reduce((sum, e) => sum + estimateTokens(e.content), 0);
    const warmTokens = this.memory.warm.reduce((sum, e) => sum + estimateTokens(e.content), 0);
    const coldTokens = this.memory.cold.reduce((sum, e) => sum + estimateTokens(e.compressed || e.content), 0);

    return {
      hot: { count: this.memory.hot.length, tokens: hotTokens },
      warm: { count: this.memory.warm.length, tokens: warmTokens },
      cold: { count: this.memory.cold.length, tokens: coldTokens },
      total: {
        count: this.memory.hot.length + this.memory.warm.length + this.memory.cold.length,
        tokens: hotTokens + warmTokens + coldTokens,
      },
    };
  }

  /**
   * Export all memories (for persistence)
   */
  export(): TieredMemory {
    return { ...this.memory };
  }

  /**
   * Import memories (for initialization)
   */
  import(data: TieredMemory): void {
    this.memory = { ...data };
  }
}

/**
 * Persist hierarchical memory to SQLite for cross-session continuity
 */
export function persistToSQLite(manager: HierarchicalMemoryManager, dbPath: string): void {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  const db = new Database(dbPath);
  
  // Create hierarchical memory table
  db.exec(`
    CREATE TABLE IF NOT EXISTS hierarchical_memory (
      id TEXT PRIMARY KEY,
      tier TEXT NOT NULL CHECK(tier IN ('hot', 'warm', 'cold')),
      content TEXT NOT NULL,
      compressed TEXT,
      type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      importance REAL NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 1,
      last_accessed TEXT NOT NULL,
      embedding BLOB
    );
    CREATE INDEX IF NOT EXISTS idx_hierarchical_tier ON hierarchical_memory(tier);
    CREATE INDEX IF NOT EXISTS idx_hierarchical_importance ON hierarchical_memory(importance DESC);
  `);
  
  const memory = manager.export();
  
  // Clear and reinsert (simple approach for small datasets)
  db.exec('DELETE FROM hierarchical_memory');
  
  const stmt = db.prepare(`
    INSERT INTO hierarchical_memory 
    (id, tier, content, compressed, type, timestamp, importance, access_count, last_accessed, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  const insertAll = db.transaction((entries: Array<{ tier: string; entry: MemoryEntry }>) => {
    for (const { tier, entry } of entries) {
      stmt.run(
        entry.id,
        tier,
        entry.content,
        entry.compressed || null,
        entry.type,
        entry.timestamp,
        entry.importance,
        entry.accessCount,
        entry.lastAccessed,
        entry.embedding ? Buffer.from(new Float32Array(entry.embedding).buffer) : null
      );
    }
  });
  
  const allEntries: Array<{ tier: string; entry: MemoryEntry }> = [
    ...memory.hot.map(e => ({ tier: 'hot', entry: e })),
    ...memory.warm.map(e => ({ tier: 'warm', entry: e })),
    ...memory.cold.map(e => ({ tier: 'cold', entry: e })),
  ];
  
  insertAll(allEntries);
  db.close();
}

/**
 * Load hierarchical memory from SQLite
 */
export function loadFromSQLite(dbPath: string): TieredMemory | null {
  if (!existsSync(dbPath)) return null;
  
  try {
    const db = new Database(dbPath, { readonly: true });
    
    // Check if table exists
    const tableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='hierarchical_memory'"
    ).get();
    
    if (!tableExists) {
      db.close();
      return null;
    }
    
    const rows = db.prepare(`
      SELECT id, tier, content, compressed, type, timestamp, importance, 
             access_count as accessCount, last_accessed as lastAccessed, embedding
      FROM hierarchical_memory
    `).all() as Array<{
      id: string;
      tier: 'hot' | 'warm' | 'cold';
      content: string;
      compressed: string | null;
      type: 'action' | 'observation' | 'thought' | 'goal';
      timestamp: string;
      importance: number;
      accessCount: number;
      lastAccessed: string;
      embedding: Buffer | null;
    }>;
    
    db.close();
    
    const memory: TieredMemory = { hot: [], warm: [], cold: [] };
    
    for (const row of rows) {
      const entry: MemoryEntry = {
        id: row.id,
        content: row.content,
        compressed: row.compressed || undefined,
        type: row.type,
        timestamp: row.timestamp,
        importance: row.importance,
        accessCount: row.accessCount,
        lastAccessed: row.lastAccessed,
        tier: row.tier,
        embedding: row.embedding ? Array.from(new Float32Array(row.embedding.buffer)) : undefined,
      };
      memory[row.tier].push(entry);
    }
    
    return memory;
  } catch {
    return null;
  }
}

// Singleton instance with optional persistence path
let globalManager: HierarchicalMemoryManager | null = null;
let globalDbPath: string | null = null;

export function getHierarchicalMemoryManager(
  config?: Partial<HierarchicalConfig>,
  dbPath?: string
): HierarchicalMemoryManager {
  if (!globalManager) {
    globalManager = new HierarchicalMemoryManager(config);
    
    // Load from SQLite if path provided
    if (dbPath) {
      globalDbPath = dbPath;
      const persisted = loadFromSQLite(dbPath);
      if (persisted) {
        globalManager.import(persisted);
      }
    }
  }
  return globalManager;
}

/**
 * Save current hierarchical memory state to disk
 * Call periodically or on shutdown to ensure persistence
 */
export function saveHierarchicalMemory(dbPath?: string): void {
  if (!globalManager) return;
  
  const path = dbPath || globalDbPath;
  if (path) {
    persistToSQLite(globalManager, path);
  }
}

/**
 * Memory Consolidation Service for UAM
 * 
 * Implements the consolidation rules from CLAUDE.md:
 * - Trigger: Every 10 working memory entries
 * - Action: Summarize → session_memories, Extract lessons → semantic memory
 * - Dedup: Skip if content_hash exists OR similarity > 0.92
 * 
 * Enhanced with SimpleMem-style recursive consolidation:
 * - Background async consolidation process
 * - Hierarchical abstraction (memories → summaries → meta-summaries)
 * - Quality scoring and automatic pruning
 */

import { createHash } from 'crypto';
import { existsSync } from 'fs';
import Database from 'better-sqlite3';
import { summarizeMemories, compressMemoryEntry } from './context-compressor.js';
import { getEmbeddingService } from './embeddings.js';
import { createSemanticUnit } from './semantic-compression.js';

export interface ConsolidationConfig {
  triggerThreshold: number;
  minImportanceForLongTerm: number;
  similarityThreshold: number;
  maxSummaryLength: number;
  backgroundIntervalMs: number;      // Interval for background consolidation
  recursiveDepth: number;            // Max levels of abstraction
  qualityDecayRate: number;          // Rate at which unused memories decay
}

const DEFAULT_CONFIG: ConsolidationConfig = {
  triggerThreshold: 10,
  minImportanceForLongTerm: 7,
  similarityThreshold: 0.92,
  maxSummaryLength: 500,
  backgroundIntervalMs: 60000,  // 1 minute
  recursiveDepth: 3,            // memories → summaries → meta-summaries
  qualityDecayRate: 0.95,       // 5% decay per day unused
};

export interface ConsolidationResult {
  memoriesProcessed: number;
  summariesCreated: number;
  lessonsExtracted: number;
  duplicatesSkipped: number;
  tokensReduced: number;
}

/**
 * Memory Consolidation Service
 */
export class MemoryConsolidator {
  private config: ConsolidationConfig;
  private db: Database.Database | null = null;
  private contentHashes: Set<string> = new Set();
  private lastConsolidationId: number = 0;
  private backgroundInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private memoryQualityScores: Map<string, { score: number; lastAccessed: Date; accessCount: number }> = new Map();

  constructor(config: Partial<ConsolidationConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize with database connection
   */
  initialize(dbPath: string): void {
    if (!existsSync(dbPath)) {
      throw new Error(`Database not found: ${dbPath}`);
    }
    this.db = new Database(dbPath);
    this.loadContentHashes();
  }

  /**
   * Load existing content hashes for deduplication
   */
  private loadContentHashes(): void {
    if (!this.db) return;

    try {
      const stmt = this.db.prepare(`
        SELECT content FROM memories
        UNION
        SELECT content FROM session_memories
      `);
      const rows = stmt.all() as Array<{ content: string }>;
      
      for (const row of rows) {
        this.contentHashes.add(this.hashContent(row.content));
      }
    } catch {
      // Tables might not exist yet
    }
  }

  /**
   * Hash content for deduplication
   */
  private hashContent(content: string): string {
    return createHash('md5')
      .update(content.toLowerCase().trim())
      .digest('hex');
  }

  /**
   * Check if consolidation should run
   */
  shouldConsolidate(): boolean {
    if (!this.db) return false;

    try {
      const stmt = this.db.prepare(`
        SELECT COUNT(*) as count, MAX(id) as maxId
        FROM memories
        WHERE id > ?
      `);
      const result = stmt.get(this.lastConsolidationId) as { count: number; maxId: number | null };
      
      return result.count >= this.config.triggerThreshold;
    } catch {
      return false;
    }
  }

  /**
   * Run consolidation process
   */
  async consolidate(): Promise<ConsolidationResult> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const result: ConsolidationResult = {
      memoriesProcessed: 0,
      summariesCreated: 0,
      lessonsExtracted: 0,
      duplicatesSkipped: 0,
      tokensReduced: 0,
    };

    // Get memories since last consolidation
    const stmt = this.db.prepare(`
      SELECT id, timestamp, type, content
      FROM memories
      WHERE id > ?
      ORDER BY id ASC
      LIMIT 100
    `);
    const memories = stmt.all(this.lastConsolidationId) as Array<{
      id: number;
      timestamp: string;
      type: string;
      content: string;
    }>;

    if (memories.length === 0) return result;

    result.memoriesProcessed = memories.length;
    const originalTokens = memories.reduce((sum, m) => sum + m.content.length / 4, 0);

    // Group by type for summarization
    const byType: Record<string, typeof memories> = {};
    for (const mem of memories) {
      if (!byType[mem.type]) byType[mem.type] = [];
      byType[mem.type].push(mem);
    }

    // Create summaries for each type
    for (const [_type, typeMemories] of Object.entries(byType)) {
      if (typeMemories.length >= 3) {
        const summary = summarizeMemories(
          typeMemories.map(m => ({
            content: m.content,
            timestamp: m.timestamp,
            type: m.type,
          })),
          this.config.maxSummaryLength
        );

        const summaryHash = this.hashContent(summary);
        
        if (!this.contentHashes.has(summaryHash)) {
          // Store in session_memories
          await this.storeSessionMemory(summary, 'summary', 6);
          this.contentHashes.add(summaryHash);
          result.summariesCreated++;
        } else {
          result.duplicatesSkipped++;
        }
      }
    }

    // Extract lessons from high-importance observations
    const lessons = memories.filter(m => 
      m.type === 'observation' && 
      this.detectLesson(m.content)
    );

    for (const lesson of lessons) {
      const compressed = compressMemoryEntry(lesson.content, { compressionLevel: 'medium' });
      const hash = this.hashContent(compressed.compressed);

      if (!this.contentHashes.has(hash)) {
        // Check semantic similarity
        const isDuplicate = await this.checkSemanticDuplicate(compressed.compressed);
        
        if (!isDuplicate) {
          await this.storeLesson(compressed.compressed, lesson.timestamp);
          this.contentHashes.add(hash);
          result.lessonsExtracted++;
        } else {
          result.duplicatesSkipped++;
        }
      } else {
        result.duplicatesSkipped++;
      }
    }

    // Calculate token reduction
    const summaryTokens = result.summariesCreated * (this.config.maxSummaryLength / 4);
    const lessonTokens = result.lessonsExtracted * 100; // Approximate
    result.tokensReduced = Math.max(0, originalTokens - summaryTokens - lessonTokens);

    // Update last consolidation pointer
    this.lastConsolidationId = memories[memories.length - 1].id;

    return result;
  }

  /**
   * Detect if content contains a lesson/insight
   */
  private detectLesson(content: string): boolean {
    const lessonIndicators = [
      /learned that/i,
      /important to/i,
      /mistake was/i,
      /better to/i,
      /should always/i,
      /should never/i,
      /key insight/i,
      /gotcha/i,
      /watch out for/i,
      /best practice/i,
      /pattern/i,
      /tip:/i,
    ];

    return lessonIndicators.some(pattern => pattern.test(content));
  }

  /**
   * Check for semantic duplicates using embeddings
   */
  private async checkSemanticDuplicate(content: string): Promise<boolean> {
    if (!this.db) return false;

    try {
      const embeddingService = getEmbeddingService();
      const newEmbedding = await embeddingService.embed(content);

      // Get recent session memories for comparison
      const stmt = this.db.prepare(`
        SELECT content FROM session_memories
        ORDER BY id DESC
        LIMIT 50
      `);
      const existing = stmt.all() as Array<{ content: string }>;

      for (const { content: existingContent } of existing) {
        const existingEmbedding = await embeddingService.embed(existingContent);
        const similarity = embeddingService.cosineSimilarity(newEmbedding, existingEmbedding);
        
        if (similarity > this.config.similarityThreshold) {
          return true;
        }
      }

      return false;
    } catch {
      // Fall back to text comparison
      const normalizedNew = content.toLowerCase().trim();
      
      const stmt = this.db.prepare(`
        SELECT content FROM session_memories
        WHERE LOWER(TRIM(content)) = ?
        LIMIT 1
      `);
      const match = stmt.get(normalizedNew);
      
      return !!match;
    }
  }

  /**
   * Store session memory
   */
  private async storeSessionMemory(
    content: string,
    type: string,
    importance: number
  ): Promise<void> {
    if (!this.db) return;

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO session_memories (session_id, timestamp, type, content, importance)
      VALUES ('consolidation', ?, ?, ?, ?)
    `);
    
    stmt.run(new Date().toISOString(), type, content, importance);
  }

  /**
   * Store lesson in long-term memory
   */
  private async storeLesson(content: string, timestamp: string): Promise<void> {
    if (!this.db) return;

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO session_memories (session_id, timestamp, type, content, importance)
      VALUES ('lessons', ?, 'lesson', ?, ?)
    `);
    
    stmt.run(timestamp, content, this.config.minImportanceForLongTerm);
  }

  /**
   * Run decay on old memories
   * Formula: effective_importance = importance × (0.95 ^ days_since_access)
   */
  async runDecay(): Promise<number> {
    if (!this.db) return 0;

    try {
      // SQLite doesn't have POW, so we do this in application code
      const stmt = this.db.prepare(`
        SELECT id, importance, timestamp
        FROM session_memories
        WHERE importance > 1
      `);
      const rows = stmt.all() as Array<{
        id: number;
        importance: number;
        timestamp: string;
      }>;

      let updated = 0;
      const now = Date.now();
      const updateStmt = this.db.prepare(`
        UPDATE session_memories
        SET importance = ?
        WHERE id = ?
      `);

      for (const row of rows) {
        const daysSince = (now - new Date(row.timestamp).getTime()) / (1000 * 60 * 60 * 24);
        const decayed = Math.round(row.importance * Math.pow(0.95, daysSince));
        
        if (decayed !== row.importance && decayed >= 1) {
          updateStmt.run(decayed, row.id);
          updated++;
        }
      }

      return updated;
    } catch {
      return 0;
    }
  }

  /**
   * Get consolidation stats
   */
  getStats(): {
    totalMemories: number;
    totalSessionMemories: number;
    totalLessons: number;
    lastConsolidationId: number;
    uniqueHashes: number;
  } {
    if (!this.db) {
      return {
        totalMemories: 0,
        totalSessionMemories: 0,
        totalLessons: 0,
        lastConsolidationId: this.lastConsolidationId,
        uniqueHashes: this.contentHashes.size,
      };
    }

    try {
      const memoriesStmt = this.db.prepare('SELECT COUNT(*) as count FROM memories');
      const sessionStmt = this.db.prepare('SELECT COUNT(*) as count FROM session_memories');
      const lessonsStmt = this.db.prepare(`
        SELECT COUNT(*) as count FROM session_memories WHERE type = 'lesson'
      `);

      const memories = (memoriesStmt.get() as { count: number }).count;
      const session = (sessionStmt.get() as { count: number }).count;
      const lessons = (lessonsStmt.get() as { count: number }).count;

      return {
        totalMemories: memories,
        totalSessionMemories: session,
        totalLessons: lessons,
        lastConsolidationId: this.lastConsolidationId,
        uniqueHashes: this.contentHashes.size,
      };
    } catch {
      return {
        totalMemories: 0,
        totalSessionMemories: 0,
        totalLessons: 0,
        lastConsolidationId: this.lastConsolidationId,
        uniqueHashes: this.contentHashes.size,
      };
    }
  }

  /**
   * Start background consolidation process (SimpleMem-style async)
   */
  startBackgroundConsolidation(): void {
    if (this.backgroundInterval) return;
    
    this.isRunning = true;
    this.backgroundInterval = setInterval(async () => {
      if (!this.isRunning) return;
      
      try {
        // Run consolidation if threshold met
        if (this.shouldConsolidate()) {
          await this.consolidate();
        }
        
        // Run recursive consolidation on summaries
        await this.recursiveConsolidate();
        
        // Apply quality decay
        await this.applyQualityDecay();
        
      } catch (error) {
        console.error('[MemoryConsolidator] Background error:', error);
      }
    }, this.config.backgroundIntervalMs);
    
    console.log(`[MemoryConsolidator] Background consolidation started (interval: ${this.config.backgroundIntervalMs}ms)`);
  }

  /**
   * Stop background consolidation
   */
  stopBackgroundConsolidation(): void {
    this.isRunning = false;
    if (this.backgroundInterval) {
      clearInterval(this.backgroundInterval);
      this.backgroundInterval = null;
    }
  }

  /**
   * Recursive consolidation - merge summaries into meta-summaries
   * Based on SimpleMem's hierarchical abstraction
   */
  async recursiveConsolidate(depth: number = 0): Promise<number> {
    if (!this.db || depth >= this.config.recursiveDepth) return 0;
    
    let consolidated = 0;
    
    try {
      // Find summaries that can be merged (same type, adjacent time periods)
      const stmt = this.db.prepare(`
        SELECT id, timestamp, type, content, importance
        FROM session_memories
        WHERE type = 'summary'
        ORDER BY timestamp ASC
        LIMIT 20
      `);
      const summaries = stmt.all() as Array<{
        id: number;
        timestamp: string;
        type: string;
        content: string;
        importance: number;
      }>;
      
      // Group adjacent summaries (within 24 hours)
      const groups: typeof summaries[] = [];
      let currentGroup: typeof summaries = [];
      
      for (const summary of summaries) {
        if (currentGroup.length === 0) {
          currentGroup.push(summary);
        } else {
          const lastTime = new Date(currentGroup[currentGroup.length - 1].timestamp).getTime();
          const thisTime = new Date(summary.timestamp).getTime();
          const hoursDiff = (thisTime - lastTime) / (1000 * 60 * 60);
          
          if (hoursDiff <= 24) {
            currentGroup.push(summary);
          } else {
            if (currentGroup.length >= 3) groups.push(currentGroup);
            currentGroup = [summary];
          }
        }
      }
      if (currentGroup.length >= 3) groups.push(currentGroup);
      
      // Create meta-summaries from groups
      for (const group of groups) {
        const unit = createSemanticUnit(
          group.map(s => ({ content: s.content, importance: s.importance }))
        );
        
        if (unit.compressionRatio > 1.2) {
          const metaSummary = unit.atomicFacts.map(f => f.content).join(' ');
          const hash = this.hashContent(metaSummary);
          
          if (!this.contentHashes.has(hash)) {
            await this.storeSessionMemory(metaSummary, 'meta-summary', 8);
            this.contentHashes.add(hash);
            consolidated++;
            
            // Remove original summaries
            const ids = group.map(s => s.id);
            this.db.prepare(`DELETE FROM session_memories WHERE id IN (${ids.join(',')})`).run();
          }
        }
      }
      
    } catch {
      // Ignore errors
    }
    
    return consolidated;
  }

  /**
   * Apply quality decay to unused memories (Memory-R1 style)
   */
  async applyQualityDecay(): Promise<number> {
    if (!this.db) return 0;
    
    const now = Date.now();
    let updated = 0;
    
    try {
      const stmt = this.db.prepare(`
        SELECT id, importance, timestamp
        FROM session_memories
        WHERE importance > 1
      `);
      const rows = stmt.all() as Array<{
        id: number;
        importance: number;
        timestamp: string;
      }>;
      
      const updateStmt = this.db.prepare(`
        UPDATE session_memories SET importance = ? WHERE id = ?
      `);
      
      for (const row of rows) {
        const memKey = `session-${row.id}`;
        const quality = this.memoryQualityScores.get(memKey);
        
        // Calculate days since last access (or creation)
        const lastAccess = quality?.lastAccessed || new Date(row.timestamp);
        const daysSince = (now - lastAccess.getTime()) / (1000 * 60 * 60 * 24);
        
        // Apply decay: importance * (decayRate ^ days)
        const decayed = Math.round(row.importance * Math.pow(this.config.qualityDecayRate, daysSince));
        
        if (decayed !== row.importance && decayed >= 1) {
          updateStmt.run(decayed, row.id);
          updated++;
        }
      }
      
    } catch {
      // Ignore errors
    }
    
    return updated;
  }

  /**
   * Record memory access (for quality scoring)
   */
  recordAccess(memoryId: string): void {
    const existing = this.memoryQualityScores.get(memoryId);
    this.memoryQualityScores.set(memoryId, {
      score: (existing?.score || 5) + 0.5,
      lastAccessed: new Date(),
      accessCount: (existing?.accessCount || 0) + 1,
    });
  }

  /**
   * Get memory quality score
   */
  getQualityScore(memoryId: string): number {
    return this.memoryQualityScores.get(memoryId)?.score || 5;
  }

  /**
   * Close database connection
   */
  close(): void {
    this.stopBackgroundConsolidation();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

// Singleton instance
let globalConsolidator: MemoryConsolidator | null = null;

export function getMemoryConsolidator(
  config?: Partial<ConsolidationConfig>
): MemoryConsolidator {
  if (!globalConsolidator) {
    globalConsolidator = new MemoryConsolidator(config);
  }
  return globalConsolidator;
}

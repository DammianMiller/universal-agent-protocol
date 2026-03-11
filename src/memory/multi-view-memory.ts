/**
 * Multi-View Memory System for UAM
 * 
 * Implements:
 * 1. Multi-view indexing (entity, temporal, semantic type views)
 * 2. ENGRAM-style memory typing (episodic, semantic, procedural)
 * 3. Async embedding generation
 * 4. Speculative cache integration with task classifier
 * 
 * Based on SimpleMem (2026) and ENGRAM (2025) research
 */

import { getEmbeddingService } from './embeddings.js';
import { getSpeculativeCache } from './speculative-cache.js';
import { classifyTask, type TaskClassification } from './task-classifier.js';

/**
 * ENGRAM-style memory types
 */
export type ENGRAMMemoryType = 
  | 'episodic'    // Specific events/interactions (what happened)
  | 'semantic'    // General knowledge/facts (what is true)
  | 'procedural'; // How-to knowledge (how to do things)

/**
 * Multi-view indexed memory entry
 */
export interface MultiViewMemory {
  id: string;
  content: string;
  
  // ENGRAM typing
  memoryType: ENGRAMMemoryType;
  
  // Multi-view indices
  entities: string[];           // Entity view
  temporalBucket: string;       // Temporal view (YYYY-MM-DD or relative)
  semanticType: string;         // Semantic type (action, observation, etc.)
  
  // Embeddings (async generated)
  embedding?: number[];
  embeddingPending?: boolean;
  
  // Quality metrics
  importance: number;
  accessCount: number;
  lastAccessed: Date;
  qualityScore: number;
}

/**
 * Multi-view index structure
 */
export interface MultiViewIndex {
  byEntity: Map<string, Set<string>>;      // entity -> memory IDs
  byTemporal: Map<string, Set<string>>;    // bucket -> memory IDs
  bySemanticType: Map<string, Set<string>>; // type -> memory IDs
  byENGRAMType: Map<ENGRAMMemoryType, Set<string>>; // ENGRAM type -> memory IDs
}

/**
 * Classify memory into ENGRAM type
 */
export function classifyENGRAMType(content: string, context?: { type?: string }): ENGRAMMemoryType {
  // Procedural: how-to, commands, steps
  if (/how to|step \d|first.*then|run |execute |use |install /i.test(content)) {
    return 'procedural';
  }
  
  // Check explicit type hints
  if (context?.type === 'action' || context?.type === 'goal') {
    return 'procedural';
  }
  
  // Episodic: specific events, past tense, temporal markers
  if (/yesterday|today|last week|earlier|just now|happened|occurred|found that/i.test(content)) {
    return 'episodic';
  }
  
  if (context?.type === 'observation') {
    return 'episodic';
  }
  
  // Semantic: general facts, definitions, patterns
  if (/is a|are |means|defined as|always|never|typically|pattern/i.test(content)) {
    return 'semantic';
  }
  
  // Default based on content characteristics
  const hasCommand = /`[^`]+`/.test(content);
  const hasPath = /\/[\w/.-]+/.test(content);
  
  if (hasCommand || hasPath) {
    return 'procedural';
  }
  
  return 'semantic'; // Default
}

/**
 * Extract temporal bucket from content/timestamp
 */
export function extractTemporalBucket(content: string, timestamp?: string): string {
  // Check for relative time markers
  if (/just now|moments ago/i.test(content)) return 'now';
  if (/today|this morning|this afternoon/i.test(content)) return 'today';
  if (/yesterday/i.test(content)) return 'yesterday';
  if (/this week|past few days/i.test(content)) return 'this-week';
  if (/last week/i.test(content)) return 'last-week';
  if (/this month/i.test(content)) return 'this-month';
  
  // Use timestamp if available
  if (timestamp) {
    return timestamp.split('T')[0]; // YYYY-MM-DD
  }
  
  return 'unknown';
}

/**
 * Multi-View Memory Manager
 */
export class MultiViewMemoryManager {
  private memories: Map<string, MultiViewMemory> = new Map();
  private index: MultiViewIndex = {
    byEntity: new Map(),
    byTemporal: new Map(),
    bySemanticType: new Map(),
    byENGRAMType: new Map(),
  };
  private embeddingQueue: string[] = [];
  private isProcessingEmbeddings: boolean = false;

  /**
   * Add memory with multi-view indexing
   */
  async add(
    content: string,
    options: {
      id?: string;
      semanticType?: string;
      entities?: string[];
      timestamp?: string;
      importance?: number;
      generateEmbedding?: boolean;
    } = {}
  ): Promise<MultiViewMemory> {
    const id = options.id || `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    
    // Classify ENGRAM type
    const memoryType = classifyENGRAMType(content, { type: options.semanticType });
    
    // Extract temporal bucket
    const temporalBucket = extractTemporalBucket(content, options.timestamp);
    
    // Extract entities if not provided
    const entities = options.entities || this.extractEntities(content);
    
    const memory: MultiViewMemory = {
      id,
      content,
      memoryType,
      entities,
      temporalBucket,
      semanticType: options.semanticType || 'general',
      importance: options.importance || 5,
      accessCount: 0,
      lastAccessed: new Date(),
      qualityScore: options.importance || 5,
      embeddingPending: options.generateEmbedding !== false,
    };
    
    // Store memory
    this.memories.set(id, memory);
    
    // Update indices
    this.indexMemory(memory);
    
    // Queue embedding generation if requested
    if (options.generateEmbedding !== false) {
      this.embeddingQueue.push(id);
      this.processEmbeddingQueue();
    }
    
    return memory;
  }

  /**
   * Index memory in all views
   */
  private indexMemory(memory: MultiViewMemory): void {
    // Entity index
    for (const entity of memory.entities) {
      if (!this.index.byEntity.has(entity)) {
        this.index.byEntity.set(entity, new Set());
      }
      this.index.byEntity.get(entity)!.add(memory.id);
    }
    
    // Temporal index
    if (!this.index.byTemporal.has(memory.temporalBucket)) {
      this.index.byTemporal.set(memory.temporalBucket, new Set());
    }
    this.index.byTemporal.get(memory.temporalBucket)!.add(memory.id);
    
    // Semantic type index
    if (!this.index.bySemanticType.has(memory.semanticType)) {
      this.index.bySemanticType.set(memory.semanticType, new Set());
    }
    this.index.bySemanticType.get(memory.semanticType)!.add(memory.id);
    
    // ENGRAM type index
    if (!this.index.byENGRAMType.has(memory.memoryType)) {
      this.index.byENGRAMType.set(memory.memoryType, new Set());
    }
    this.index.byENGRAMType.get(memory.memoryType)!.add(memory.id);
  }

  /**
   * Query by entity
   */
  queryByEntity(entity: string): MultiViewMemory[] {
    const ids = this.index.byEntity.get(entity);
    if (!ids) return [];
    return Array.from(ids).map(id => this.memories.get(id)!).filter(Boolean);
  }

  /**
   * Query by ENGRAM type
   */
  queryByENGRAMType(type: ENGRAMMemoryType): MultiViewMemory[] {
    const ids = this.index.byENGRAMType.get(type);
    if (!ids) return [];
    return Array.from(ids).map(id => this.memories.get(id)!).filter(Boolean);
  }

  /**
   * Query by temporal bucket
   */
  queryByTemporal(bucket: string): MultiViewMemory[] {
    const ids = this.index.byTemporal.get(bucket);
    if (!ids) return [];
    return Array.from(ids).map(id => this.memories.get(id)!).filter(Boolean);
  }

  /**
   * Smart query using task classification to select best view
   */
  async smartQuery(query: string, limit: number = 10): Promise<MultiViewMemory[]> {
    const classification = classifyTask(query);
    const results: MultiViewMemory[] = [];
    const seen = new Set<string>();
    
    // Check speculative cache first
    const cache = getSpeculativeCache();
    const cached = cache.get(query);
    if (cached) {
      return cached.result as MultiViewMemory[];
    }
    
    // Determine best retrieval strategy based on task type
    const strategy = this.getRetrievalStrategy(classification);
    
    // Execute strategy
    for (const step of strategy) {
      const stepResults = await this.executeStrategyStep(step, query, classification);
      for (const mem of stepResults) {
        if (!seen.has(mem.id)) {
          seen.add(mem.id);
          results.push(mem);
          this.recordAccess(mem.id);
        }
      }
      if (results.length >= limit) break;
    }
    
    // Sort by quality score and recency
    results.sort((a, b) => {
      const scoreA = a.qualityScore * (1 + a.accessCount * 0.1);
      const scoreB = b.qualityScore * (1 + b.accessCount * 0.1);
      return scoreB - scoreA;
    });
    
    const finalResults = results.slice(0, limit);
    
    // Cache results
    cache.set(query, finalResults);
    
    // Pre-warm cache for predicted follow-up queries
    cache.preWarm(query, async (q) => {
      const r = await this.smartQuery(q, limit);
      return r;
    });
    
    return finalResults;
  }

  /**
   * Get retrieval strategy based on task classification
   */
  private getRetrievalStrategy(classification: TaskClassification): Array<{
    view: 'entity' | 'temporal' | 'semantic' | 'engram' | 'embedding';
    filter?: string;
    weight: number;
  }> {
    const strategies: Record<string, typeof classification.category extends string ? Array<{
      view: 'entity' | 'temporal' | 'semantic' | 'engram' | 'embedding';
      filter?: string;
      weight: number;
    }> : never> = {
      'sysadmin': [
        { view: 'engram', filter: 'procedural', weight: 1.5 },
        { view: 'semantic', filter: 'action', weight: 1.2 },
        { view: 'embedding', weight: 1.0 },
      ],
      'debugging': [
        { view: 'engram', filter: 'episodic', weight: 1.5 },
        { view: 'temporal', filter: 'today', weight: 1.3 },
        { view: 'embedding', weight: 1.0 },
      ],
      'coding': [
        { view: 'engram', filter: 'procedural', weight: 1.3 },
        { view: 'engram', filter: 'semantic', weight: 1.2 },
        { view: 'embedding', weight: 1.0 },
      ],
      'security': [
        { view: 'engram', filter: 'semantic', weight: 1.5 },
        { view: 'semantic', filter: 'gotcha', weight: 1.3 },
        { view: 'embedding', weight: 1.0 },
      ],
      'default': [
        { view: 'embedding', weight: 1.0 },
        { view: 'engram', filter: 'semantic', weight: 0.8 },
      ],
    };
    
    return strategies[classification.category] || strategies['default'];
  }

  /**
   * Execute a single strategy step
   */
  private async executeStrategyStep(
    step: { view: string; filter?: string; weight: number },
    query: string,
    _classification: TaskClassification
  ): Promise<MultiViewMemory[]> {
    switch (step.view) {
      case 'entity': {
        const entities = this.extractEntities(query);
        const results: MultiViewMemory[] = [];
        for (const entity of entities) {
          results.push(...this.queryByEntity(entity));
        }
        return results;
      }
      
      case 'temporal': {
        if (step.filter) {
          return this.queryByTemporal(step.filter);
        }
        // Return recent memories
        return this.queryByTemporal('today').concat(this.queryByTemporal('yesterday'));
      }
      
      case 'semantic': {
        if (step.filter) {
          const ids = this.index.bySemanticType.get(step.filter);
          if (ids) {
            return Array.from(ids).map(id => this.memories.get(id)!).filter(Boolean);
          }
        }
        return [];
      }
      
      case 'engram': {
        if (step.filter) {
          return this.queryByENGRAMType(step.filter as ENGRAMMemoryType);
        }
        return [];
      }
      
      case 'embedding': {
        return this.semanticSearch(query, 10);
      }
      
      default:
        return [];
    }
  }

  /**
   * Semantic search using embeddings
   */
  async semanticSearch(query: string, limit: number = 10): Promise<MultiViewMemory[]> {
    const embeddingService = getEmbeddingService();
    
    try {
      const queryEmbedding = await embeddingService.embed(query);
      
      const scored: Array<{ memory: MultiViewMemory; score: number }> = [];
      
      for (const memory of this.memories.values()) {
        if (memory.embedding) {
          const score = embeddingService.cosineSimilarity(queryEmbedding, memory.embedding);
          if (score > 0.5) {
            scored.push({ memory, score });
          }
        }
      }
      
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit).map(s => s.memory);
      
    } catch {
      return [];
    }
  }

  /**
   * Process embedding queue asynchronously
   */
  private async processEmbeddingQueue(): Promise<void> {
    if (this.isProcessingEmbeddings || this.embeddingQueue.length === 0) return;
    
    this.isProcessingEmbeddings = true;
    const embeddingService = getEmbeddingService();
    
    try {
      // Process in batches of 10
      while (this.embeddingQueue.length > 0) {
        const batch = this.embeddingQueue.splice(0, 10);
        const memories = batch.map(id => this.memories.get(id)).filter(Boolean) as MultiViewMemory[];
        const texts = memories.map(m => m.content);
        
        if (texts.length > 0) {
          const embeddings = await embeddingService.embedBatch(texts);
          
          for (let i = 0; i < memories.length; i++) {
            memories[i].embedding = embeddings[i];
            memories[i].embeddingPending = false;
          }
        }
      }
    } catch (error) {
      console.error('[MultiViewMemory] Embedding generation error:', error);
    } finally {
      this.isProcessingEmbeddings = false;
    }
  }

  /**
   * Extract entities from content
   */
  private extractEntities(content: string): string[] {
    const entities: string[] = [];
    
    // File paths
    const paths = content.match(/[\w./\\-]+\.(ts|js|py|json|yaml|yml|md|sh|sql)/gi);
    if (paths) entities.push(...paths);
    
    // Function/class names
    const names = content.match(/\b[a-z][a-zA-Z0-9]*(?:[A-Z][a-zA-Z0-9]*)+\b/g);
    if (names) entities.push(...names);
    
    // Commands
    const commands = content.match(/\b(npm|git|uam|docker|curl|pip|python|node)\s+\w+/gi);
    if (commands) entities.push(...commands.map(c => c.trim()));
    
    // Quoted strings
    const quoted = content.match(/`([^`]+)`/g);
    if (quoted) entities.push(...quoted.map(q => q.replace(/`/g, '')));
    
    return [...new Set(entities)];
  }

  /**
   * Record memory access
   */
  recordAccess(memoryId: string): void {
    const memory = this.memories.get(memoryId);
    if (memory) {
      memory.accessCount++;
      memory.lastAccessed = new Date();
      memory.qualityScore = Math.min(10, memory.qualityScore + 0.1);
    }
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalMemories: number;
    byENGRAMType: Record<ENGRAMMemoryType, number>;
    pendingEmbeddings: number;
    entitiesIndexed: number;
  } {
    const byENGRAMType: Record<ENGRAMMemoryType, number> = {
      episodic: this.index.byENGRAMType.get('episodic')?.size || 0,
      semantic: this.index.byENGRAMType.get('semantic')?.size || 0,
      procedural: this.index.byENGRAMType.get('procedural')?.size || 0,
    };
    
    return {
      totalMemories: this.memories.size,
      byENGRAMType,
      pendingEmbeddings: this.embeddingQueue.length,
      entitiesIndexed: this.index.byEntity.size,
    };
  }

  /**
   * Export all memories
   */
  export(): MultiViewMemory[] {
    return Array.from(this.memories.values());
  }

  /**
   * Import memories
   */
  async import(memories: MultiViewMemory[]): Promise<void> {
    for (const memory of memories) {
      this.memories.set(memory.id, memory);
      this.indexMemory(memory);
      
      if (!memory.embedding) {
        this.embeddingQueue.push(memory.id);
      }
    }
    
    this.processEmbeddingQueue();
  }
}

// Singleton instance
let globalMultiViewManager: MultiViewMemoryManager | null = null;

export function getMultiViewMemoryManager(): MultiViewMemoryManager {
  if (!globalMultiViewManager) {
    globalMultiViewManager = new MultiViewMemoryManager();
  }
  return globalMultiViewManager;
}

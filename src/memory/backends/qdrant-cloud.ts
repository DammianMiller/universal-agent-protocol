import { QdrantClient } from '@qdrant/js-client-rest';
import type { MemoryBackend, MemoryEntry } from './base.js';
import { getEmbeddingService } from '../embeddings.js';
import { createHash } from 'crypto';

interface QdrantCloudBackendConfig {
  url: string;
  apiKey?: string;
  collection: string;
  projectId?: string; // Project identifier for data isolation
  vectorSize?: number; // Allow dynamic vector size based on embedding provider
}

/**
 * Generate a safe collection name from project ID
 * Qdrant collection names must be alphanumeric with underscores
 */
function sanitizeCollectionName(base: string, projectId?: string): string {
  if (!projectId) return base;
  
  // Create a short hash of the project ID for uniqueness
  const hash = createHash('sha256').update(projectId).digest('hex').slice(0, 8);
  
  // Sanitize project name (take last path component, remove special chars)
  const projectName = projectId
    .split(/[/\\]/).pop() || projectId
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 32);
  
  return `${base}_${projectName}_${hash}`;
}

export class QdrantCloudBackend implements MemoryBackend {
  private client: QdrantClient;
  private collection: string;
  private projectId: string;
  private vectorSize: number;
  private collectionVerified: boolean = false;

  constructor(config: QdrantCloudBackendConfig) {
    const apiKey = config.apiKey || process.env.QDRANT_API_KEY;
    const url = config.url || process.env.QDRANT_URL;
    
    if (!url) {
      throw new Error('Qdrant URL required (QDRANT_URL env var or config)');
    }

    this.client = new QdrantClient({ url, apiKey });
    this.projectId = config.projectId || process.cwd();
    this.collection = sanitizeCollectionName(config.collection, this.projectId);
    this.vectorSize = config.vectorSize || 768; // Default to Ollama's nomic-embed-text size
  }

  async isConfigured(): Promise<boolean> {
    try {
      await this.client.getCollections();
      return true;
    } catch {
      return false;
    }
  }

  async store(entry: MemoryEntry): Promise<void> {
    if (!entry.embedding) {
      throw new Error('Embedding required for Qdrant storage');
    }

    await this.ensureCollection();
    await this.client.upsert(this.collection, {
      points: [
        {
          id: entry.id,
          vector: entry.embedding,
          payload: {
            timestamp: entry.timestamp,
            type: entry.type,
            content: entry.content,
            tags: entry.tags,
            importance: entry.importance,
            ...entry.metadata,
          },
        },
      ],
    });
  }

  async query(queryText: string, limit = 10): Promise<MemoryEntry[]> {
    // Generate real embedding for semantic search
    const embeddingService = getEmbeddingService();
    const queryEmbedding = await embeddingService.embed(queryText);
    
    const results = await this.client.search(this.collection, {
      vector: queryEmbedding,
      limit,
      score_threshold: 0.5, // Only return relevant results
    });

    return results.map((r) => ({
      id: String(r.id),
      timestamp: r.payload?.timestamp as string,
      type: r.payload?.type as 'action' | 'observation' | 'thought' | 'goal',
      content: r.payload?.content as string,
      embedding: r.vector as number[],
      tags: r.payload?.tags as string[],
      importance: r.payload?.importance as number,
      metadata: r.payload as Record<string, unknown>,
    }));
  }

  async getRecent(limit = 50): Promise<MemoryEntry[]> {
    const results = await this.client.scroll(this.collection, {
      limit,
      with_payload: true,
      with_vector: false,
    });

    return results.points.map((r) => ({
      id: String(r.id),
      timestamp: r.payload?.timestamp as string,
      type: r.payload?.type as 'action' | 'observation' | 'thought' | 'goal',
      content: r.payload?.content as string,
      tags: r.payload?.tags as string[],
      importance: r.payload?.importance as number,
      metadata: r.payload as Record<string, unknown>,
    }));
  }

  async prune(olderThan: Date): Promise<number> {
    const results = await this.client.scroll(this.collection, {
      filter: {
        must: [
          {
            key: 'timestamp',
            range: {
              lt: olderThan.toISOString(),
            },
          },
        ],
      },
      limit: 1000,
      with_payload: false,
    });

    const ids = results.points.map((p) => p.id);
    if (ids.length > 0) {
      await this.client.delete(this.collection, { points: ids });
    }
    return ids.length;
  }

  private async ensureCollection(): Promise<void> {
    if (this.collectionVerified) return;
    
    const collections = await this.client.getCollections();
    const exists = collections.collections.some((c) => c.name === this.collection);
    
    if (!exists) {
      // Create collection with correct vector size
      await this.client.createCollection(this.collection, {
        vectors: { size: this.vectorSize, distance: 'Cosine' },
      });
      this.collectionVerified = true;
      return;
    }
    
    // Check if existing collection has correct dimensions
    const collectionInfo = await this.client.getCollection(this.collection);
    const currentSize = (collectionInfo.config?.params as { vectors?: { size?: number } })?.vectors?.size;
    
    if (currentSize && currentSize !== this.vectorSize) {
      // Create new collection with correct dimensions (append suffix)
      const newCollectionName = `${this.collection}_v${this.vectorSize}`;
      const newExists = collections.collections.some((c) => c.name === newCollectionName);
      
      if (!newExists) {
        await this.client.createCollection(newCollectionName, {
          vectors: { size: this.vectorSize, distance: 'Cosine' },
        });
        console.log(`[Qdrant] Created new collection ${newCollectionName} with ${this.vectorSize} dimensions`);
      }
      
      this.collection = newCollectionName;
    }
    
    this.collectionVerified = true;
  }

  /**
   * Get the actual collection name being used (may differ from config if dimension mismatch)
   */
  getCollectionName(): string {
    return this.collection;
  }

  /**
   * Get vector dimensions
   */
  getVectorSize(): number {
    return this.vectorSize;
  }
}

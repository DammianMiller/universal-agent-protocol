import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import type { QdrantServerlessConfig } from '../types/config.js';

/**
 * Serverless Qdrant manager for cost-optimized vector storage.
 * Supports lazy-start local Docker instances and cloud serverless backends.
 */
export class ServerlessQdrantManager {
  private config: Required<QdrantServerlessConfig>;
  private lastActivityTime: number = Date.now();
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private idleCheckInterval: NodeJS.Timeout | null = null;
  private isStarting: boolean = false;
  private inMemoryFallback: Map<string, unknown[]> = new Map();

  constructor(config: QdrantServerlessConfig) {
    this.config = this.normalizeConfig(config);
  }

  /**
   * Normalize and fill in default config values.
   */
  private normalizeConfig(config: QdrantServerlessConfig): Required<QdrantServerlessConfig> {
    return {
      enabled: config.enabled ?? false,
      mode: config.mode ?? 'lazy-local',
      lazyLocal: {
        dockerImage: config.lazyLocal?.dockerImage ?? 'qdrant/qdrant:latest',
        port: config.lazyLocal?.port ?? 6333,
        dataDir: config.lazyLocal?.dataDir ?? './agents/data/qdrant',
        autoStart: config.lazyLocal?.autoStart ?? true,
        autoStop: config.lazyLocal?.autoStop ?? true,
        idleTimeoutMs: config.lazyLocal?.idleTimeoutMs ?? 300000,
        healthCheckIntervalMs: config.lazyLocal?.healthCheckIntervalMs ?? 30000,
      },
      cloudServerless: {
        provider: config.cloudServerless?.provider ?? 'qdrant-cloud',
        url: config.cloudServerless?.url,
        apiKey: config.cloudServerless?.apiKey,
        region: config.cloudServerless?.region ?? 'us-east-1',
        keepWarm: config.cloudServerless?.keepWarm ?? false,
        warmIntervalMs: config.cloudServerless?.warmIntervalMs ?? 240000,
      },
      hybrid: {
        useLocalInDev: config.hybrid?.useLocalInDev ?? true,
        useCloudInProd: config.hybrid?.useCloudInProd ?? true,
        envDetection: config.hybrid?.envDetection ?? 'auto',
      },
      fallbackToMemory: config.fallbackToMemory ?? true,
    };
  }

  /**
   * Get the current environment (dev/prod).
   */
  private getEnvironment(): 'dev' | 'prod' {
    const { envDetection } = this.config.hybrid;
    
    if (envDetection === 'NODE_ENV') {
      return process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
    }
    if (envDetection === 'UAM_ENV') {
      return process.env.UAM_ENV === 'production' ? 'prod' : 'dev';
    }
    
    // Auto-detect
    if (process.env.NODE_ENV === 'production' || process.env.CI) {
      return 'prod';
    }
    return 'dev';
  }

  /**
   * Get the effective backend based on mode and environment.
   */
  getEffectiveBackend(): 'local' | 'cloud' | 'memory' {
    const { mode } = this.config;
    
    if (mode === 'lazy-local') {
      return 'local';
    }
    
    if (mode === 'cloud-serverless') {
      return 'cloud';
    }
    
    if (mode === 'hybrid') {
      const env = this.getEnvironment();
      if (env === 'dev' && this.config.hybrid.useLocalInDev) {
        return 'local';
      }
      if (env === 'prod' && this.config.hybrid.useCloudInProd) {
        return 'cloud';
      }
    }
    
    return 'memory';
  }

  /**
   * Get the Qdrant endpoint URL.
   */
  async getEndpoint(): Promise<string> {
    const backend = this.getEffectiveBackend();
    
    if (backend === 'local') {
      await this.ensureLocalRunning();
      return `http://localhost:${this.config.lazyLocal.port}`;
    }
    
    if (backend === 'cloud') {
      const url = this.config.cloudServerless.url || process.env.QDRANT_URL;
      if (!url) {
        throw new Error('Cloud Qdrant URL not configured');
      }
      return url;
    }
    
    throw new Error('In-memory fallback active - no endpoint available');
  }

  /**
   * Get the API key for cloud backend.
   */
  getApiKey(): string | undefined {
    return this.config.cloudServerless.apiKey || process.env.QDRANT_API_KEY;
  }

  /**
   * Check if local Qdrant is running.
   */
  private isLocalRunning(): boolean {
    try {
      const result = execSync(
        `curl -s -o /dev/null -w "%{http_code}" http://localhost:${this.config.lazyLocal.port}/health`,
        { encoding: 'utf-8', timeout: 5000 }
      );
      return result.trim() === '200';
    } catch {
      return false;
    }
  }

  /**
   * Start local Qdrant Docker container.
   */
  private async startLocal(): Promise<void> {
    if (this.isStarting) {
      // Wait for existing start to complete
      while (this.isStarting) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return;
    }

    this.isStarting = true;
    
    try {
      const { dockerImage, port, dataDir } = this.config.lazyLocal;
      
      // Ensure data directory exists
      if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
      }

      // Check if container already exists
      try {
        execSync('docker ps -a --format "{{.Names}}" | grep -q uam-qdrant', { stdio: 'pipe' });
        // Container exists, start it
        execSync('docker start uam-qdrant', { stdio: 'pipe' });
      } catch {
        // Container doesn't exist, create it
        spawn('docker', [
          'run',
          '--name', 'uam-qdrant',
          '-p', `${port}:6333`,
          '-v', `${process.cwd()}/${dataDir}:/qdrant/storage`,
          '-d',
          dockerImage,
        ], { stdio: 'pipe', detached: true });
      }

      // Wait for Qdrant to be ready
      let attempts = 0;
      while (!this.isLocalRunning() && attempts < 30) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        attempts++;
      }

      if (!this.isLocalRunning()) {
        throw new Error('Failed to start local Qdrant');
      }

      // Start health check and idle monitoring
      this.startMonitoring();
      
    } finally {
      this.isStarting = false;
    }
  }

  /**
   * Stop local Qdrant Docker container.
   */
  private async stopLocal(): Promise<void> {
    try {
      execSync('docker stop uam-qdrant', { stdio: 'pipe' });
    } catch {
      // Container may not be running
    }
    
    this.stopMonitoring();
  }

  /**
   * Ensure local Qdrant is running, starting it if needed.
   */
  async ensureLocalRunning(): Promise<void> {
    if (!this.isLocalRunning()) {
      if (this.config.lazyLocal.autoStart) {
        await this.startLocal();
      } else {
        throw new Error('Local Qdrant not running and autoStart is disabled');
      }
    }
    
    this.recordActivity();
  }

  /**
   * Record activity to reset idle timer.
   */
  recordActivity(): void {
    this.lastActivityTime = Date.now();
  }

  /**
   * Start health check and idle monitoring.
   */
  private startMonitoring(): void {
    const { healthCheckIntervalMs, idleTimeoutMs, autoStop } = this.config.lazyLocal;
    
    // Health check
    this.healthCheckInterval = setInterval(() => {
      if (!this.isLocalRunning()) {
        console.warn('[UAM] Qdrant health check failed, attempting restart...');
        this.startLocal().catch(console.error);
      }
    }, healthCheckIntervalMs);

    // Idle check (auto-stop)
    if (autoStop) {
      this.idleCheckInterval = setInterval(() => {
        const idleTime = Date.now() - this.lastActivityTime;
        if (idleTime > idleTimeoutMs) {
          console.log(`[UAM] Qdrant idle for ${idleTime}ms, stopping...`);
          this.stopLocal().catch(console.error);
        }
      }, 60000); // Check every minute
    }
  }

  /**
   * Stop monitoring intervals.
   */
  private stopMonitoring(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }
  }

  /**
   * Store vectors with automatic backend selection.
   */
  async store(collection: string, vectors: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>): Promise<void> {
    const backend = this.getEffectiveBackend();
    
    if (backend === 'memory') {
      if (!this.inMemoryFallback.has(collection)) {
        this.inMemoryFallback.set(collection, []);
      }
      this.inMemoryFallback.get(collection)!.push(...vectors);
      return;
    }

    this.recordActivity();
    
    const endpoint = await this.getEndpoint();
    const apiKey = this.getApiKey();
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['api-key'] = apiKey;
    }

    const response = await fetch(`${endpoint}/collections/${collection}/points`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ points: vectors }),
    });

    if (!response.ok) {
      throw new Error(`Failed to store vectors: ${response.statusText}`);
    }
  }

  /**
   * Search vectors with automatic backend selection.
   */
  async search(
    collection: string, 
    vector: number[], 
    limit: number = 5
  ): Promise<Array<{ id: string; score: number; payload: Record<string, unknown> }>> {
    const backend = this.getEffectiveBackend();
    
    if (backend === 'memory') {
      // Simple in-memory cosine similarity search
      const vectors = this.inMemoryFallback.get(collection) || [];
      return this.inMemorySearch(vectors as Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>, vector, limit);
    }

    this.recordActivity();
    
    const endpoint = await this.getEndpoint();
    const apiKey = this.getApiKey();
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['api-key'] = apiKey;
    }

    const response = await fetch(`${endpoint}/collections/${collection}/points/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ vector, limit, with_payload: true }),
    });

    if (!response.ok) {
      throw new Error(`Failed to search vectors: ${response.statusText}`);
    }

    const data = await response.json() as { result: Array<{ id: string; score: number; payload: Record<string, unknown> }> };
    return data.result;
  }

  /**
   * Simple in-memory cosine similarity search (fallback).
   */
  private inMemorySearch(
    vectors: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>,
    query: number[],
    limit: number
  ): Array<{ id: string; score: number; payload: Record<string, unknown> }> {
    const scored = vectors.map(v => ({
      id: v.id,
      score: this.cosineSimilarity(query, v.vector),
      payload: v.payload,
    }));

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Calculate cosine similarity between two vectors.
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Gracefully shutdown the manager.
   */
  async shutdown(): Promise<void> {
    this.stopMonitoring();
    
    if (this.config.lazyLocal.autoStop) {
      await this.stopLocal();
    }
  }

  /**
   * Get current status.
   */
  getStatus(): {
    backend: 'local' | 'cloud' | 'memory';
    localRunning: boolean;
    lastActivity: number;
    inMemorySize: number;
  } {
    return {
      backend: this.getEffectiveBackend(),
      localRunning: this.isLocalRunning(),
      lastActivity: this.lastActivityTime,
      inMemorySize: Array.from(this.inMemoryFallback.values())
        .reduce((sum, arr) => sum + arr.length, 0),
    };
  }
}

/**
 * Singleton instance.
 */
let globalManager: ServerlessQdrantManager | null = null;

export function getServerlessQdrantManager(config?: QdrantServerlessConfig): ServerlessQdrantManager {
  if (!globalManager && config) {
    globalManager = new ServerlessQdrantManager(config);
  }
  if (!globalManager) {
    throw new Error('ServerlessQdrantManager not initialized');
  }
  return globalManager;
}

export function initServerlessQdrant(config: QdrantServerlessConfig): ServerlessQdrantManager {
  globalManager = new ServerlessQdrantManager(config);
  return globalManager;
}

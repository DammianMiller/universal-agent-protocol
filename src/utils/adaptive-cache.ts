/**
 * Adaptive cache with usage-based TTL and priority eviction
 */
export interface CacheEntry<V> {
  value: V;
  lastAccessed: Date;
  lastModified: Date;
  usageCount: number;
  priority: number;
}

export interface AdaptiveCacheOptions {
  maxEntries: number;
  defaultTTL?: number; // Default TTL in ms (default: 5 min)
  hotThreshold?: number; // Usage count to be considered "hot" (default: 10)
  coldEvictionRatio?: number; // Fraction of cold entries to evict (default: 0.5)
}

export class AdaptiveCache<K, V> {
  private cache: Map<K, CacheEntry<V>>;
  private options: Required<AdaptiveCacheOptions>;
  private evictionInterval: NodeJS.Timeout | null = null;

  constructor(options: AdaptiveCacheOptions) {
    const {
      maxEntries,
      defaultTTL = 300000, // 5 minutes
      hotThreshold = 10,
      coldEvictionRatio = 0.5,
    } = options;

    this.options = {
      maxEntries,
      defaultTTL,
      hotThreshold,
      coldEvictionRatio,
    };

    this.cache = new Map();
    this.startEviction();
  }

  /**
   * Get value from cache with adaptive TTL
   */
  get(key: K): V | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    // Check if expired
    const age = Date.now() - entry.lastModified.getTime();
    const ttl = this.getAdaptiveTTL(entry);

    if (age > ttl) {
      this.cache.delete(key);
      return null;
    }

    // Update access metadata
    entry.lastAccessed = new Date();
    entry.usageCount++;

    return entry.value;
  }

  /**
   * Set value in cache
   */
  set(key: K, value: V, priority: number = 1): void {
    // Evict if at capacity
    if (this.cache.size >= this.options.maxEntries) {
      this.evict();
    }

    this.cache.set(key, {
      value,
      lastAccessed: new Date(),
      lastModified: new Date(),
      usageCount: 0,
      priority,
    });
  }

  /**
   * Delete value from cache
   */
  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache size
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Calculate adaptive TTL based on usage patterns
   */
  private getAdaptiveTTL(entry: CacheEntry<V>): number {
    if (entry.usageCount >= this.options.hotThreshold) {
      return this.options.defaultTTL * 12; // 1 hour for hot entries
    }
    if (entry.usageCount >= this.options.hotThreshold / 2) {
      return this.options.defaultTTL * 3; // 15 minutes for warm entries
    }
    return this.options.defaultTTL; // 5 minutes default
  }

  /**
   * Evict entries based on priority and access patterns
   */
  private evict(): void {
    const entries = [...this.cache.entries()];

    if (entries.length === 0) return;

    // Separate hot vs cold entries
    const coldEntries = entries.filter(
      ([_, entry]) => entry.usageCount < this.options.hotThreshold / 2
    );
    // hotEntries unused - kept for future expansion

    // Evict cold first
    if (coldEntries.length > Math.floor(this.options.maxEntries * this.options.coldEvictionRatio)) {
      // Sort by last access time
      coldEntries.sort((a, b) => a[1].lastAccessed.getTime() - b[1].lastAccessed.getTime());

      const toRemove = Math.floor(coldEntries.length / 2);
      for (let i = 0; i < toRemove; i++) {
        this.cache.delete(coldEntries[i][0]);
      }
      return;
    }

    // If not enough cold entries, evict LRU from all
    entries.sort((a, b) => a[1].lastAccessed.getTime() - b[1].lastAccessed.getTime());

    const toRemove = Math.ceil(entries.length * 0.3);
    for (let i = 0; i < toRemove; i++) {
      this.cache.delete(entries[i][0]);
    }
  }

  /**
   * Start periodic eviction
   */
  private startEviction(): void {
    this.evictionInterval = setInterval(() => {
      this.evict();
    }, 60000); // Run every minute
    // Prevent blocking Node.js process exit
    if (this.evictionInterval.unref) this.evictionInterval.unref();
  }

  /**
   * Stop eviction interval
   */
  stop(): void {
    if (this.evictionInterval) {
      clearInterval(this.evictionInterval);
      this.evictionInterval = null;
    }
  }
}

/**
 * Create a cache instance with common defaults for pattern matching
 */
export function createPatternCache(maxEntries: number = 100): AdaptiveCache<string, any> {
  return new AdaptiveCache({
    maxEntries,
    defaultTTL: 300000, // 5 minutes
    hotThreshold: 10,
    coldEvictionRatio: 0.5,
  });
}



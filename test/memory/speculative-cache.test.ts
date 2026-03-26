import { describe, it, expect, beforeEach } from 'vitest';
import { SpeculativeCache } from '../../src/memory/speculative-cache.js';

describe('SpeculativeCache', () => {
  let cache: SpeculativeCache;

  beforeEach(() => {
    cache = new SpeculativeCache({
      maxEntries: 10,
      ttlMs: 1000,
      preWarmEnabled: true,
      predictionDepth: 3,
    });
  });

  describe('get/set', () => {
    it('should store and retrieve cache entries', () => {
      cache.set('auth patterns', [{ id: 1, content: 'auth' }]);
      const entry = cache.get('auth patterns');
      expect(entry).not.toBeNull();
      expect(entry!.result).toHaveLength(1);
    });

    it('should return null for missing entries', () => {
      expect(cache.get('nonexistent')).toBeNull();
    });

    it('should increment usage count on get', () => {
      cache.set('test query', [{ id: 1 }]);
      cache.get('test query');
      cache.get('test query');
      const entry = cache.get('test query');
      expect(entry!.usageCount).toBeGreaterThanOrEqual(3);
    });

    it('should expire entries after TTL', async () => {
      const shortCache = new SpeculativeCache({ maxEntries: 10, ttlMs: 50 });
      shortCache.set('expire me', [{ id: 1 }]);
      await new Promise(r => setTimeout(r, 60));
      expect(shortCache.get('expire me')).toBeNull();
    });

    it('should evict LRU entries when at capacity', () => {
      for (let i = 0; i < 15; i++) {
        cache.set(`query-${i}`, [{ id: i }]);
      }
      // First entries should have been evicted
      expect(cache.get('query-0')).toBeNull();
      expect(cache.get('query-14')).not.toBeNull();
    });

    it('should normalize queries for consistency', () => {
      cache.set('  Auth  Patterns  ', [{ id: 1 }]);
      const entry = cache.get('auth patterns');
      expect(entry).not.toBeNull();
    });
  });

  describe('getPredictedQueries', () => {
    it('should return predictions for security queries', () => {
      const predictions = cache.getPredictedQueries('authentication patterns');
      expect(predictions.length).toBeGreaterThan(0);
    });

    it('should return predictions based on seeded transitions', () => {
      const predictions = cache.getPredictedQueries('password cracking attempt');
      expect(predictions.some(p => p.includes('hashcat') || p.includes('7z'))).toBe(true);
    });

    it('should return predictions for coding queries', () => {
      const predictions = cache.getPredictedQueries('design patterns for error handling');
      expect(predictions.length).toBeGreaterThan(0);
    });

    it('should deduplicate predictions', () => {
      const predictions = cache.getPredictedQueries('security authentication');
      const unique = new Set(predictions);
      expect(unique.size).toBe(predictions.length);
    });

    it('should analyze query history sequences', () => {
      cache.set('query A', []);
      cache.set('query B', []);
      cache.set('query C', []);
      const predictions = cache.getPredictedQueries('new query');
      expect(predictions).toBeDefined();
    });
  });

  describe('getStats', () => {
    it('should return cache statistics', () => {
      cache.set('a', [{ id: 1 }]);
      cache.set('b', [{ id: 2 }]);
      cache.get('a');
      cache.get('a');
      const stats = cache.getStats();
      expect(stats.size).toBe(2);
      expect(stats.avgUsage).toBeGreaterThanOrEqual(1);
    });

    it('should return empty stats for new cache', () => {
      const stats = cache.getStats();
      expect(stats.size).toBe(0);
    });

    it('should track top patterns', () => {
      cache.set('authentication patterns', []);
      cache.set('secret management', []);
      const stats = cache.getStats();
      expect(stats.topPatterns).toBeDefined();
    });
  });

  describe('clear', () => {
    it('should remove all cache entries', () => {
      cache.set('a', []);
      cache.set('b', []);
      cache.clear();
      expect(cache.get('a')).toBeNull();
      expect(cache.get('b')).toBeNull();
    });
  });

  describe('preWarm', () => {
    it('should prefetch predicted queries', async () => {
      const fetcher = async (query: string) => [{ content: `result for ${query}` }];
      // Use a query that matches a known seeded transition
      await cache.preWarm('password cracking', fetcher);
      const stats = cache.getStats();
      expect(stats.size).toBeGreaterThan(0);
    });

    it('should not warm when disabled', async () => {
      const noWarmCache = new SpeculativeCache({ maxEntries: 10, ttlMs: 1000, preWarmEnabled: false, predictionDepth: 3 });
      const fetcher = async (query: string) => [{ content: query }];
      await noWarmCache.preWarm('password cracking', fetcher);
      expect(noWarmCache.getStats().size).toBe(0);
    });
  });
});

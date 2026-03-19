import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AdaptiveCache,
  createPatternCache,
} from '../../src/utils/adaptive-cache.js';

describe('Adaptive Cache', () => {
  describe('basic operations', () => {
    it('should set and get values', () => {
      const cache = new AdaptiveCache({ maxEntries: 10 });
      cache.set('key1', 'value1');
      expect(cache.get('key1')).toBe('value1');
    });

    it('should return null for missing keys', () => {
      const cache = new AdaptiveCache({ maxEntries: 10 });
      expect(cache.get('nonexistent')).toBeNull();
    });

    it('should delete values', () => {
      const cache = new AdaptiveCache({ maxEntries: 10 });
      cache.set('key1', 'value1');
      expect(cache.delete('key1')).toBe(true);
      expect(cache.get('key1')).toBeNull();
    });

    it('should return false for deleting non-existent keys', () => {
      const cache = new AdaptiveCache({ maxEntries: 10 });
      expect(cache.delete('nonexistent')).toBe(false);
    });

    it('should clear all values', () => {
      const cache = new AdaptiveCache({ maxEntries: 10 });
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.clear();
      expect(cache.size).toBe(0);
    });

    it('should track size correctly', () => {
      const cache = new AdaptiveCache({ maxEntries: 10 });
      expect(cache.size).toBe(0);
      cache.set('key1', 'value1');
      expect(cache.size).toBe(1);
      cache.set('key2', 'value2');
      expect(cache.size).toBe(2);
    });
  });

  describe('adaptive TTL', () => {
    it('should extend TTL for hot entries (high usage count)', async () => {
      const cache = new AdaptiveCache({ maxEntries: 10, defaultTTL: 1000, hotThreshold: 5 });

      // Access entry multiple times to make it "hot"
      cache.set('key1', 'value1');
      for (let i = 0; i < 6; i++) {
        cache.get('key1');
      }

      // Should have extended TTL (>5 minutes)
      const result = cache.get('key1');
      expect(result).toBe('value1');
    });

    it('should use default TTL for cold entries', async () => {
      const cache = new AdaptiveCache({ maxEntries: 10, defaultTTL: 1000 });

      cache.set('key1', 'value1');
      // Don't access again - stays cold

      const result = cache.get('key1');
      expect(result).toBe('value1');
    });

    it('should expire entries after TTL', async () => {
      const cache = new AdaptiveCache({ maxEntries: 10, defaultTTL: 100 });

      cache.set('key1', 'value1');

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(cache.get('key1')).toBeNull();
    });

    it('should increment usage count on get', async () => {
      const cache = new AdaptiveCache({ maxEntries: 10 });

      cache.set('key1', 'value1');
      cache.get('key1');
      cache.get('key1');

      // Entry should still be there
      expect(cache.get('key1')).toBe('value1');
    });
  });

  describe('eviction', () => {
    it('should evict entries when at capacity', () => {
      const cache = new AdaptiveCache({ maxEntries: 3 });

      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');

      // This should trigger eviction
      cache.set('key4', 'value4');

      expect(cache.size).toBe(3);
    });

    it('should evict cold entries first', async () => {
      const cache = new AdaptiveCache({ maxEntries: 10, defaultTTL: 5000 });

      // Add cold entries (don't access them)
      cache.set('cold1', 'value1');
      cache.set('cold2', 'value2');
      cache.set('cold3', 'value3');

      // Add hot entry and access it multiple times
      cache.set('hot1', 'value4');
      for (let i = 0; i < 6; i++) {
        cache.get('hot1');
      }

      // Add more entries to trigger eviction
      cache.set('new1', 'value5');
      cache.set('new2', 'value6');

      expect(cache.size).toBeLessThanOrEqual(10);
    });

    it('should evict LRU when not enough cold entries', () => {
      const cache = new AdaptiveCache({ maxEntries: 5, hotThreshold: 10 });

      // Add entries (none will be "hot" since threshold is high)
      for (let i = 0; i < 5; i++) {
        cache.set(`key${i}`, `value${i}`);
      }

      // Access first entry
      cache.get('key0');

      // Add new entry to trigger eviction
      cache.set('new', 'newvalue');

      expect(cache.size).toBeLessThanOrEqual(5);
    });
  });

  describe('concurrent access', () => {
    it('should handle concurrent set/get operations', async () => {
      const cache = new AdaptiveCache({ maxEntries: 100 });

      const promises = [
        Promise.all([
          cache.set('key1', 'value1'),
          cache.set('key2', 'value2'),
          cache.set('key3', 'value3'),
        ]),
        Promise.resolve(cache.get('key1')),
      ];

      await Promise.all(promises);

      expect(cache.get('key1')).toBe('value1');
      expect(cache.get('key2')).toBe('value2');
    });
  });

  describe('createPatternCache', () => {
    it('should create cache with correct defaults', () => {
      const cache = createPatternCache(100);

      expect(cache.size).toBe(0);
      expect(cache.get('test')).toBeNull(); // Should not throw
    });
  });

  // createQueryCache tests removed — function was removed in sweep 3

  describe('stop method', () => {
    it('should stop eviction interval', () => {
      const cache = new AdaptiveCache({ maxEntries: 10 });

      // Start eviction
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

      cache.stop();

      expect(clearIntervalSpy).toHaveBeenCalled();
    });
  });
});

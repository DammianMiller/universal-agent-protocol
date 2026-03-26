import { describe, it, expect, beforeEach } from 'vitest';
import {
  HierarchicalMemoryManager,
  calculateEffectiveImportance,
  type MemoryEntry,
} from '../../src/memory/hierarchical-memory.js';

describe('HierarchicalMemoryManager', () => {
  let manager: HierarchicalMemoryManager;

  beforeEach(() => {
    manager = new HierarchicalMemoryManager({
      hotMaxEntries: 3,
      warmMaxEntries: 5,
      coldMaxEntries: 10,
    });
  });

  describe('calculateEffectiveImportance', () => {
    it('should return full importance for recently accessed entries', () => {
      const entry: MemoryEntry = {
        id: '1',
        content: 'Test',
        type: 'observation',
        timestamp: new Date().toISOString(),
        importance: 10,
        accessCount: 1,
        lastAccessed: new Date().toISOString(),
      };
      const effective = calculateEffectiveImportance(entry);
      expect(effective).toBeCloseTo(10, 0);
    });

    it('should decay importance for old entries', () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 30);
      const entry: MemoryEntry = {
        id: '1',
        content: 'Test',
        type: 'observation',
        timestamp: oldDate.toISOString(),
        importance: 10,
        accessCount: 1,
        lastAccessed: oldDate.toISOString(),
      };
      const effective = calculateEffectiveImportance(entry);
      expect(effective).toBeLessThan(10);
    });

    it('should use custom decay rate', () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 10);
      const entry: MemoryEntry = {
        id: '1',
        content: 'Test',
        type: 'observation',
        timestamp: oldDate.toISOString(),
        importance: 10,
        accessCount: 1,
        lastAccessed: oldDate.toISOString(),
      };
      const fast = calculateEffectiveImportance(entry, 0.8);
      const slow = calculateEffectiveImportance(entry, 0.99);
      expect(fast).toBeLessThan(slow);
    });
  });

  describe('add', () => {
    it('should add entries to hot tier', () => {
      manager.add({
        id: '1',
        content: 'Test memory entry',
        type: 'observation',
        timestamp: new Date().toISOString(),
        importance: 8,
      });
      const { entries } = manager.getHotContext();
      expect(entries.length).toBe(1);
      expect(entries[0].content).toBe('Test memory entry');
    });

    it('should rebalance when hot tier is full', () => {
      for (let i = 0; i < 5; i++) {
        manager.add({
          id: `entry-${i}`,
          content: `Memory ${i}`,
          type: 'observation',
          timestamp: new Date().toISOString(),
          importance: i + 1,
        });
      }
      const { entries } = manager.getHotContext();
      expect(entries.length).toBeLessThanOrEqual(3);
    });
  });

  describe('access', () => {
    it('should increment access count', () => {
      manager.add({
        id: 'entry-1',
        content: 'A test entry',
        type: 'observation',
        timestamp: new Date().toISOString(),
        importance: 5,
      });
      const entry = manager.access('entry-1');
      expect(entry).not.toBeNull();
      expect(entry!.accessCount).toBeGreaterThanOrEqual(2);
    });

    it('should return null for non-existent entries', () => {
      expect(manager.access('nonexistent')).toBeNull();
    });
  });

  describe('getHotContext', () => {
    it('should return entries and token count', () => {
      manager.add({
        id: '1',
        content: 'Hot entry content',
        type: 'goal',
        timestamp: new Date().toISOString(),
        importance: 10,
      });
      const { entries, tokens } = manager.getHotContext();
      expect(entries.length).toBeGreaterThan(0);
      expect(tokens).toBeGreaterThan(0);
    });
  });

  describe('getStats', () => {
    it('should return tier sizes', () => {
      manager.add({
        id: '1',
        content: 'Entry 1',
        type: 'observation',
        timestamp: new Date().toISOString(),
        importance: 10,
      });
      const stats = manager.getStats();
      expect(stats.hot.count).toBeGreaterThanOrEqual(1);
      expect(typeof stats.warm.count).toBe('number');
      expect(typeof stats.cold.count).toBe('number');
      expect(stats.total.count).toBeGreaterThanOrEqual(1);
    });
  });
});

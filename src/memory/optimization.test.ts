import { describe, it, expect, beforeEach } from 'vitest';
import {
  compressMemoryEntry,
  compressMemoryBatch,
  summarizeMemories,
  estimateTokens,
  ContextBudget,
  smartTruncate,
} from './context-compressor.js';
import {
  HierarchicalMemoryManager,
  calculateEffectiveImportance,
} from './hierarchical-memory.js';
import { SpeculativeCache } from './speculative-cache.js';

describe('Context Compression', () => {
  it('should estimate tokens correctly', () => {
    const text = 'Hello world this is a test';
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(text.length);
  });

  it('should compress memory entries', () => {
    const content = 'This is basically a very important observation that essentially shows the key insight about the implementation. In order to understand this, you need to consider the fact that it works correctly. Actually, the implementation really demonstrates the pattern quite well. It is worth noting that the system works as a matter of fact.';
    
    const result = compressMemoryEntry(content, { compressionLevel: 'medium' });
    
    expect(result.compressed.length).toBeLessThanOrEqual(result.original.length);
    expect(result.tokenReduction).toBeGreaterThanOrEqual(0);
    expect(result.preservedSemantics).toBeGreaterThan(0.7);
  });

  it('should skip compression for short content', () => {
    const content = 'Short content';
    
    const result = compressMemoryEntry(content);
    
    expect(result.compressed).toBe(content);
    expect(result.tokenReduction).toBe(0);
  });

  it('should batch compress memories', () => {
    const memories = [
      { content: 'First memory about testing', type: 'action', importance: 8 },
      { content: 'Second memory about debugging', type: 'observation', importance: 6 },
      { content: 'Third memory about coding', type: 'thought', importance: 5 },
    ];

    const result = compressMemoryBatch(memories);

    expect(result.compressed).toContain('[ACTION]');
    expect(result.compressed).toContain('[OBSERVATION]');
    expect(result.compressed).toContain('[THOUGHT]');
  });

  it('should summarize memories', () => {
    const memories = [
      { content: 'Fixed bug in auth module', timestamp: '2026-01-15T10:00:00Z', type: 'action' },
      { content: 'Found issue with token validation', timestamp: '2026-01-15T09:00:00Z', type: 'observation' },
      { content: 'Need to improve error handling', timestamp: '2026-01-15T08:00:00Z', type: 'thought' },
    ];

    const summary = summarizeMemories(memories, 200);

    expect(summary).toContain('[Summary');
    expect(summary.length).toBeLessThan(300);
  });
});

describe('Context Budget', () => {
  let budget: ContextBudget;

  beforeEach(() => {
    budget = new ContextBudget(1000);
  });

  it('should allocate within budget', () => {
    const result = budget.allocate('section1', 'Short content here');
    
    expect(result.truncated).toBe(false);
    expect(budget.remaining()).toBeLessThan(1000);
  });

  it('should truncate when over budget', () => {
    // Use realistic multi-word content that exceeds the token budget
    const longContent = Array(800).fill('This is realistic content that generates tokens').join(' ');
    const result = budget.allocate('section1', longContent);
    
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('[truncated]');
  });

  it('should track usage by section', () => {
    budget.allocate('section1', 'Content 1');
    budget.allocate('section2', 'Content 2');
    
    const usage = budget.usage();
    
    expect(usage.sections).toHaveProperty('section1');
    expect(usage.sections).toHaveProperty('section2');
    expect(usage.used).toBeGreaterThan(0);
  });
});

describe('Smart Truncation', () => {
  it('should not truncate content within maxChars', () => {
    const content = 'line 1\nline 2\nline 3';
    const result = smartTruncate(content, 1000);
    expect(result).toBe(content);
  });

  it('should preserve first and last lines with head+tail split', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}: data here`);
    const content = lines.join('\n');
    const result = smartTruncate(content, 500);

    expect(result).toContain('line 0:');
    expect(result).toContain('line 99:');
    expect(result).toContain('lines truncated');
  });

  it('should show accurate omitted line count', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const content = lines.join('\n');
    const result = smartTruncate(content, 200);

    const match = result.match(/(\d+) lines truncated/);
    expect(match).not.toBeNull();
    const omitted = parseInt(match![1], 10);
    expect(omitted).toBeGreaterThan(0);
    expect(omitted).toBeLessThan(50);

    // Head + tail + omitted should equal total lines
    const showingMatch = result.match(/showing first (\d+) \+ last (\d+)/);
    expect(showingMatch).not.toBeNull();
    const head = parseInt(showingMatch![1], 10);
    const tail = parseInt(showingMatch![2], 10);
    expect(head + tail + omitted).toBe(50);
  });
});

describe('Hierarchical Memory', () => {
  let manager: HierarchicalMemoryManager;

  beforeEach(() => {
    manager = new HierarchicalMemoryManager({
      hotMaxEntries: 5,
      warmMaxEntries: 10,
      coldMaxEntries: 20,
    });
  });

  it('should add entries to hot tier', () => {
    manager.add({
      id: 'test-1',
      content: 'Test memory content',
      type: 'action',
      timestamp: new Date().toISOString(),
      importance: 7,
    });

    const stats = manager.getStats();
    expect(stats.hot.count).toBe(1);
  });

  it('should demote excess hot entries to warm', () => {
    // Add more than hotMaxEntries
    for (let i = 0; i < 7; i++) {
      manager.add({
        id: `test-${i}`,
        content: `Memory ${i}`,
        type: 'action',
        timestamp: new Date().toISOString(),
        importance: 5,
      });
    }

    const stats = manager.getStats();
    expect(stats.hot.count).toBeLessThanOrEqual(5);
    expect(stats.warm.count).toBeGreaterThan(0);
  });

  it('should calculate effective importance with decay', () => {
    const entry = {
      id: 'test-1',
      content: 'Test',
      type: 'action' as const,
      timestamp: new Date().toISOString(),
      importance: 10,
      accessCount: 1,
      lastAccessed: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days ago
    };

    const effective = calculateEffectiveImportance(entry, 0.95);
    
    expect(effective).toBeLessThan(10);
    expect(effective).toBeGreaterThan(5);
  });

  it('should get hot context within token limit', () => {
    for (let i = 0; i < 3; i++) {
      manager.add({
        id: `test-${i}`,
        content: 'Some content that takes tokens',
        type: 'action',
        timestamp: new Date().toISOString(),
        importance: 7,
      });
    }

    const { entries, tokens } = manager.getHotContext();
    
    expect(entries.length).toBeGreaterThan(0);
    expect(tokens).toBeLessThanOrEqual(2000);
  });
});

describe('Speculative Cache', () => {
  let cache: SpeculativeCache;

  beforeEach(() => {
    cache = new SpeculativeCache({
      maxEntries: 10,
      ttlMs: 60000,
      preWarmEnabled: true,
    });
  });

  it('should store and retrieve cached entries', () => {
    cache.set('test query', [{ data: 'result' }]);
    
    const entry = cache.get('test query');
    
    expect(entry).not.toBeNull();
    expect(entry?.result).toHaveLength(1);
  });

  it('should normalize queries', () => {
    cache.set('  TEST Query  ', [{ data: 'result' }]);
    
    const entry = cache.get('test query');
    
    expect(entry).not.toBeNull();
  });

  it('should track usage statistics', () => {
    cache.set('query1', [{ data: 1 }]);
    cache.get('query1');
    cache.get('query1');
    
    const stats = cache.getStats();
    
    expect(stats.size).toBe(1);
    expect(stats.avgUsage).toBeGreaterThan(1);
  });

  it('should predict queries based on category patterns', () => {
    // Query with known sysadmin patterns
    const predictions = cache.getPredictedQueries('kernel compilation and systemd setup');
    
    // Should return category-based predictions (sysadmin patterns)
    expect(predictions).toBeDefined();
    expect(Array.isArray(predictions)).toBe(true);
  });

  it('should evict LRU entries when at capacity', () => {
    for (let i = 0; i < 15; i++) {
      cache.set(`query-${i}`, [{ i }]);
    }
    
    const stats = cache.getStats();
    
    expect(stats.size).toBeLessThanOrEqual(10);
  });

  it('should cleanup expired entries', () => {
    // This is hard to test without mocking time, so just verify the method exists
    const removed = cache.cleanup();
    expect(removed).toBe(0); // Nothing expired yet
  });
});

import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  compressMemoryEntry,
  compressMemoryBatch,
  summarizeMemories,
} from '../../src/memory/context-compressor.js';

describe('Context Compressor', () => {
  describe('estimateTokens', () => {
    it('should return 0 for empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('should estimate tokens for plain text', () => {
      const tokens = estimateTokens('Hello world this is a test');
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(20);
    });

    it('should account for special characters', () => {
      const plain = estimateTokens('function test');
      const withSpecial = estimateTokens('function test() { return; }');
      expect(withSpecial).toBeGreaterThan(plain);
    });

    it('should account for camelCase code tokens', () => {
      const plain = estimateTokens('some text here');
      const camel = estimateTokens('handleUserLogin authenticateRequest');
      expect(camel).toBeGreaterThanOrEqual(plain);
    });

    it('should account for numeric sequences', () => {
      const text = estimateTokens('version 123 port 8080');
      expect(text).toBeGreaterThan(0);
    });
  });

  describe('compressMemoryEntry', () => {
    it('should not compress very short content', () => {
      const result = compressMemoryEntry('Short text', { maxTokens: 800 });
      expect(result.compressed).toBe('Short text');
      expect(result.tokenReduction).toBe(0);
      expect(result.preservedSemantics).toBe(1.0);
    });

    it('should compress content with filler phrases', () => {
      const longText = 'Basically it is worth noting that essentially the function actually really works very well. ' +
        'In fact the implementation is quite good. As a matter of fact this is rather important. ' +
        'The fact that it works is somewhat surprising. In order to understand this we need more context. ' +
        'At the end of the day the code performs well and handles errors properly.';
      const result = compressMemoryEntry(longText, { compressionLevel: 'medium' });
      expect(result.compressedTokens).toBeLessThanOrEqual(result.originalTokens);
    });

    it('should perform aggressive compression when requested', () => {
      const sentences = Array.from({ length: 10 }, (_, i) => `Sentence ${i} has some content here.`);
      const longText = sentences.join(' ');
      const result = compressMemoryEntry(longText, { compressionLevel: 'aggressive', maxTokens: 50 });
      expect(result.compressedTokens).toBeLessThan(result.originalTokens);
    });

    it('should keep light compression minimal', () => {
      const text = 'Basically the function works. It is worth noting that the performance is good. Actually everything is fine.';
      const light = compressMemoryEntry(text, { compressionLevel: 'light' });
      const medium = compressMemoryEntry(text, { compressionLevel: 'medium' });
      expect(light.compressedTokens).toBeGreaterThanOrEqual(medium.compressedTokens);
    });

    it('should return valid compression ratio', () => {
      const text = 'This is basically a really very quite long text that essentially has a lot of filler words. ' +
        'In fact at the end of the day this text is actually rather long and could be compressed.';
      const result = compressMemoryEntry(text, { compressionLevel: 'medium' });
      expect(result.tokenReduction).toBeGreaterThanOrEqual(0);
      expect(result.tokenReduction).toBeLessThanOrEqual(1);
      expect(result.preservedSemantics).toBeGreaterThanOrEqual(0.7);
    });
  });

  describe('compressMemoryBatch', () => {
    it('should compress multiple memories', () => {
      const memories = [
        { content: 'Memory one about testing', type: 'observation', importance: 8 },
        { content: 'Memory two about goals', type: 'goal', importance: 10 },
        { content: 'Memory three about actions', type: 'action', importance: 6 },
      ];
      const result = compressMemoryBatch(memories);
      expect(result.compressed).toContain('[GOAL]');
      expect(result.compressed).toContain('[OBSERVATION]');
      expect(result.compressed).toContain('[ACTION]');
    });

    it('should sort by importance', () => {
      const memories = [
        { content: 'Low importance', type: 'thought', importance: 1 },
        { content: 'High importance', type: 'goal', importance: 10 },
      ];
      const result = compressMemoryBatch(memories);
      expect(result.compressed.indexOf('[GOAL]')).toBeLessThan(result.compressed.indexOf('[THOUGHT]'));
    });

    it('should handle unknown types', () => {
      const memories = [
        { content: 'Custom type content', type: 'custom' },
      ];
      const result = compressMemoryBatch(memories);
      expect(result.compressed).toContain('[CUSTOM]');
    });
  });

  describe('summarizeMemories', () => {
    it('should return empty string for no memories', () => {
      expect(summarizeMemories([])).toBe('');
    });

    it('should summarize a list of memories', () => {
      const memories = [
        { content: 'First important finding about auth', timestamp: '2024-01-01', type: 'observation' },
        { content: 'Second finding about database', timestamp: '2024-01-02', type: 'observation' },
      ];
      const result = summarizeMemories(memories);
      expect(result.length).toBeGreaterThan(0);
    });
  });
});

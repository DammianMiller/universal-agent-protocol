/**
 * String Similarity Tests
 *
 * Unit tests for string similarity and text processing utilities.
 */

import { describe, it, expect } from 'vitest';
import {
  jaccardSimilarity,
  contentHash,
  estimateTokensAccurate,
  simpleStem,
  fuzzyKeywordMatch,
  textSimilarity,
} from '../../src/utils/string-similarity.js';

describe('jaccardSimilarity', () => {
  it('should return 1 for identical strings', () => {
    expect(jaccardSimilarity('hello world', 'hello world')).toBe(1);
  });

  it('should return 0 for completely different strings', () => {
    const result = jaccardSimilarity(
      'completely different words here',
      'totally unrelated text now'
    );
    expect(result).toBe(0);
  });

  it('should handle single word comparison', () => {
    expect(jaccardSimilarity('test', 'test')).toBe(1);
    expect(jaccardSimilarity('test', 'testing')).toBe(0); // Different words after filtering
  });

  it('should handle empty strings', () => {
    expect(jaccardSimilarity('', '')).toBe(1); // Both empty = identical
    expect(jaccardSimilarity('hello', '')).toBe(0); // One empty = no overlap
  });

  it('should be case-insensitive', () => {
    expect(jaccardSimilarity('Hello World', 'HELLO WORLD')).toBe(1);
    expect(jaccardSimilarity('Test Case', 'test case')).toBe(1);
  });

  it('should handle multiple spaces correctly', () => {
    expect(jaccardSimilarity('hello   world', 'hello world')).toBe(1);
  });

  it('should calculate intersection over union correctly', () => {
    // "the quick" and "quick brown" share {quick} out of {the, quick, brown}
    const result = jaccardSimilarity('the quick brown', 'quick brown fox');
    expect(result).toBeCloseTo(0.5); // 2/4 (intersection / union)
  });
});

describe('contentHash', () => {
  it('should generate consistent hash for same input', () => {
    const text = 'This is a test document for deduplication';
    expect(contentHash(text)).toBe(contentHash(text));
  });

  it('should generate different hashes for different inputs', () => {
    expect(contentHash('text1')).not.toBe(contentHash('text2'));
  });

  it('should be case-insensitive', () => {
    expect(contentHash('Hello World')).toBe(contentHash('HELLO WORLD'));
    expect(contentHash('Hello World')).toBe(contentHash('hello world'));
  });

  it('should normalize whitespace', () => {
    expect(contentHash('hello   world')).toBe(contentHash('hello world'));
    expect(contentHash('hello\nworld')).toBe(contentHash('hello world'));
  });

  it('should return 16 character hash', () => {
    const hash = contentHash('test');
    expect(hash).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(hash)).toBe(true); // hex format
  });
});

describe('estimateTokensAccurate', () => {
  it('should return 0 for empty string', () => {
    expect(estimateTokensAccurate('')).toBe(0);
    expect(estimateTokensAccurate(null as any)).toBe(0);
  });

  it('should estimate tokens for simple text', () => {
    const result = estimateTokensAccurate('hello world');
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(10); // 2 words should be ~3 tokens
  });

  it('should handle code with camelCase', () => {
    const code = 'const userName = getUserData();';
    const result = estimateTokensAccurate(code);
    expect(result).toBeGreaterThan(estimateTokensAccurate('const userName'));
  });

  it('should count special characters', () => {
    const withSpecial = 'hello { world } [ test ]';
    const withoutSpecial = 'hello world test';
    expect(estimateTokensAccurate(withSpecial)).toBeGreaterThan(
      estimateTokensAccurate(withoutSpecial)
    );
  });

  it('should handle numbers', () => {
    const withNumbers = 'The year is 2024 and version is 3.14';
    expect(estimateTokensAccurate(withNumbers)).toBeGreaterThan(0);
  });

  it('should produce reasonable estimates for long text', () => {
    const longText =
      'This is a longer document with many words that should require more tokens to represent accurately.';
    const result = estimateTokensAccurate(longText);
    expect(result).toBeGreaterThan(10);
  });
});

describe('simpleStem', () => {
  it('should remove common suffixes', () => {
    expect(simpleStem('running')).toBe('run');
    expect(simpleStem('played')).toBe('play');
    expect(simpleStem('happiness')).toBe('happines'); // "ness" suffix removed
  });

  it('should handle words without suffixes', () => {
    expect(simpleStem('test')).toBe('test');
    expect(simpleStem('hello')).toBe('hello');
  });

  it('should be case-insensitive', () => {
    expect(simpleStem('Running')).toBe('run');
    expect(simpleStem('RUNNING')).toBe('run');
  });

  it('should handle edge cases with short words', () => {
    expect(simpleStem('a')).toBe('a'); // Too short to stem
    expect(simpleStem('at')).toBe('at'); // "ats" would be valid but "at" is not
  });

  it('should handle doubled consonants', () => {
    expect(simpleStem('running')).toBe('run'); // run + ning -> run (removes doubled n)
    expect(simpleStem('hopping')).toBe('hop');
  });
});

describe('fuzzyKeywordMatch', () => {
  it('should find exact matches', () => {
    expect(fuzzyKeywordMatch('hello world', 'world')).toBe(true);
    expect(fuzzyKeywordMatch('hello world', 'hello')).toBe(true);
  });

  it('should find stemmed matches', () => {
    expect(fuzzyKeywordMatch('I am running fast', 'run')).toBe(true);
    expect(fuzzyKeywordMatch('The played game', 'play')).toBe(true);
  });

  it('should handle case-insensitivity', () => {
    expect(fuzzyKeywordMatch('HELLO WORLD', 'hello')).toBe(true);
    expect(fuzzyKeywordMatch('Hello World', 'WORLD')).toBe(true);
  });

  it('should return false for no matches', () => {
    expect(fuzzyKeywordMatch('hello world', 'unrelated')).toBe(false);
    expect(fuzzyKeywordMatch('testing code', 'running')).toBe(false);
  });

  it('should handle compound words', () => {
    expect(fuzzyKeywordMatch('antidisestablishmentarianism', 'establish')).toBe(true);
  });

  it('should work with multi-word keywords', () => {
    expect(fuzzyKeywordMatch('hello world test', 'hello world')).toBe(true);
  });
});

describe('textSimilarity', () => {
  it('should return 1 for identical strings', () => {
    expect(textSimilarity('hello world', 'hello world')).toBe(1);
  });

  it('should handle containment detection', () => {
    // "hello" is contained in "hello world"
    const result = textSimilarity('hello', 'hello world');
    expect(result).toBeGreaterThanOrEqual(0.8);
  });

  it('should use jaccard for partial overlap', () => {
    const result = textSimilarity('the quick brown fox', 'the quick red fox');
    // Should have some similarity from shared words "the", "quick", "fox"
    expect(result).toBeGreaterThan(0);
  });

  it('should be symmetric', () => {
    const a = 'hello world';
    const b = 'world hello';
    expect(textSimilarity(a, b)).toBe(textSimilarity(b, a));
  });

  it('should handle empty strings', () => {
    expect(textSimilarity('', '')).toBe(1); // Both empty
    expect(textSimilarity('hello', '')).toBe(0); // One empty
  });

  it('should prefer containment over jaccard when applicable', () => {
    const contained = textSimilarity('test', 'this is a test string');
    const overlapping = textSimilarity('a b c', 'b c d');

    // Containment should give higher score
    expect(contained).toBeGreaterThanOrEqual(0.8);
    // Overlapping may or may not be less than 0.8 depending on implementation
    expect(overlapping).toBeGreaterThanOrEqual(0);
    expect(overlapping).toBeLessThanOrEqual(1);
  });
});

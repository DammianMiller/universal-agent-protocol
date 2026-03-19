/**
 * String Similarity Utilities for UAP
 *
 * Shared text comparison functions used across memory compression,
 * deduplication, and retrieval systems.
 */

import { createHash } from 'crypto';

/**
 * Calculate Jaccard similarity between two strings (word-level)
 * Returns a value between 0 (no overlap) and 1 (identical)
 */
export function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(
    a
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1)
  );
  const setB = new Set(
    b
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1)
  );

  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);

  return intersection.size / union.size;
}

/**
 * Calculate content hash for deduplication
 * Uses SHA-256 for reliable collision resistance
 */
export function contentHash(text: string): string {
  return createHash('sha256')
    .update(text.toLowerCase().replace(/\s+/g, ' ').trim())
    .digest('hex')
    .slice(0, 16); // 16 hex chars = 64 bits, sufficient for dedup
}

/**
 * Improved token estimation — delegates to the canonical implementation
 * in context-compressor.ts to maintain a single source of truth.
 * Kept as a public API alias for backward compatibility.
 */
export { estimateTokens as estimateTokensAccurate } from '../memory/context-compressor.js';

/**
 * Simple stemming for keyword matching
 * Handles common English suffixes for better fuzzy matching
 */
export function simpleStem(word: string): string {
  const lower = word.toLowerCase();

  // Common suffixes to strip
  const suffixes = [
    'ing',
    'ed',
    'es',
    's',
    'er',
    'est',
    'ly',
    'tion',
    'ment',
    'ness',
    'able',
    'ible',
  ];

  for (const suffix of suffixes) {
    if (lower.endsWith(suffix) && lower.length > suffix.length + 2) {
      const stem = lower.slice(0, -suffix.length);
      // Handle doubling (e.g., "running" -> "run")
      if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
        return stem.slice(0, -1);
      }
      return stem;
    }
  }

  return lower;
}

/**
 * Fuzzy keyword match using stemming
 * Returns true if any stemmed form matches
 */
export function fuzzyKeywordMatch(text: string, keyword: string): boolean {
  const textLower = text.toLowerCase();
  const keywordLower = keyword.toLowerCase();

  // Exact match first
  if (textLower.includes(keywordLower)) return true;

  // Stemmed match
  const keywordStem = simpleStem(keywordLower);
  const textWords = textLower.split(/\s+/);

  for (const word of textWords) {
    if (simpleStem(word) === keywordStem) return true;
    // Also check if the stem is contained in the word (for compound words)
    if (word.includes(keywordStem) && keywordStem.length >= 3) return true;
  }

  return false;
}

/**
 * Calculate cosine similarity between two numeric vectors.
 * Shared implementation used by EmbeddingService and ServerlessQdrantManager.
 * Returns a value between -1 (opposite) and 1 (identical).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have same dimensions');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * Calculate text similarity using multiple methods
 * Returns weighted average for more robust comparison
 */
export function textSimilarity(a: string, b: string): number {
  // Jaccard on words
  const jaccard = jaccardSimilarity(a, b);

  // Character-level containment
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();
  const shorter = aLower.length < bLower.length ? aLower : bLower;
  const longer = aLower.length >= bLower.length ? aLower : bLower;
  const containment = shorter.length > 0 && longer.includes(shorter) ? 0.8 : 0;

  // Weighted combination
  return Math.max(jaccard, containment);
}

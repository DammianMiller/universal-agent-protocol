/**
 * MCP Router Output Compressor
 *
 * Compresses large tool outputs before they enter the LLM context window.
 * - Small outputs (<5KB): pass through unchanged
 * - Medium outputs (5-10KB): head+tail smart truncation
 * - Large outputs (>10KB) with intent: FTS5 index-then-search, return only matching snippets
 */

import Database from 'better-sqlite3';
import { smartTruncate } from '../memory/context-compressor.js';

const DEFAULT_MAX_BYTES = 5120; // 5KB threshold for truncation
const INDEX_THRESHOLD = 10240; // 10KB threshold for auto-indexing
const MAX_SNIPPETS = 3;

export interface CompressionStats {
  originalBytes: number;
  compressedBytes: number;
  savings: string;
  method: 'passthrough' | 'truncated' | 'indexed';
}

export interface CompressedOutput {
  output: unknown;
  stats: CompressionStats;
}

/**
 * Compress a tool output for context efficiency.
 */
export function compressToolOutput(
  result: unknown,
  options: { maxBytes?: number; intent?: string } = {}
): CompressedOutput {
  const { maxBytes = DEFAULT_MAX_BYTES, intent } = options;
  const serialized = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  const originalBytes = Buffer.byteLength(serialized, 'utf-8');

  // Small output: pass through
  if (originalBytes <= maxBytes) {
    return {
      output: result,
      stats: {
        originalBytes,
        compressedBytes: originalBytes,
        savings: '0%',
        method: 'passthrough',
      },
    };
  }

  // Large output with intent: index and search
  if (intent && originalBytes >= INDEX_THRESHOLD) {
    const indexed = indexAndSearch(serialized, intent);
    const compressedBytes = Buffer.byteLength(indexed, 'utf-8');
    return {
      output: indexed,
      stats: {
        originalBytes,
        compressedBytes,
        savings: `${Math.round((1 - compressedBytes / originalBytes) * 100)}%`,
        method: 'indexed',
      },
    };
  }

  // Medium/large output without intent: head+tail truncation
  const truncated = smartTruncate(serialized, maxBytes);
  const compressedBytes = Buffer.byteLength(truncated, 'utf-8');

  return {
    output: truncated,
    stats: {
      originalBytes,
      compressedBytes,
      savings: `${Math.round((1 - compressedBytes / originalBytes) * 100)}%`,
      method: 'truncated',
    },
  };
}

/**
 * Index large output into in-memory FTS5 and return intent-matching snippets.
 */
function indexAndSearch(content: string, intent: string): string {
  const chunks = chunkByStructure(content);
  if (chunks.length === 0) {
    return smartTruncate(content, DEFAULT_MAX_BYTES);
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(':memory:');

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS output_fts USING fts5(
        content,
        chunk_index,
        tokenize='porter'
      );
    `);

    const insert = db.prepare('INSERT INTO output_fts (content, chunk_index) VALUES (?, ?)');
    const insertMany = db.transaction((items: Array<{ content: string; index: number }>) => {
      for (const item of items) {
        insert.run(item.content, String(item.index));
      }
    });

    insertMany(chunks.map((c, i) => ({ content: c, index: i })));

    // Search with BM25 ranking
    const sanitizedIntent = sanitizeFTS5Query(intent);
    const results = db.prepare(`
      SELECT content, rank
      FROM output_fts
      WHERE output_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(sanitizedIntent, MAX_SNIPPETS) as Array<{ content: string; rank: number }>;

    // Extract vocabulary from all chunks for follow-up queries
    const vocabulary = extractVocabulary(chunks);

    if (results.length === 0) {
      // No FTS5 matches, fall back to keyword search in chunks
      const keywordResults = keywordSearch(chunks, intent);
      if (keywordResults.length > 0) {
        return formatIndexedResponse(keywordResults, vocabulary, chunks.length, content.length);
      }
      // Nothing matched, fall back to truncation
      return smartTruncate(content, DEFAULT_MAX_BYTES);
    }

    const snippets = results.map(r => r.content);
    return formatIndexedResponse(snippets, vocabulary, chunks.length, content.length);
  } catch {
    // FTS5 unavailable or error, fall back to truncation
    return smartTruncate(content, DEFAULT_MAX_BYTES);
  } finally {
    db?.close();
  }
}

function formatIndexedResponse(
  snippets: string[],
  vocabulary: string[],
  totalChunks: number,
  totalBytes: number
): string {
  const header = `[Indexed ${totalChunks} sections from ${formatBytes(totalBytes)} output — showing ${snippets.length} matching sections]`;
  const body = snippets.map((s, i) => `--- Match ${i + 1} ---\n${s}`).join('\n\n');
  const footer = vocabulary.length > 0
    ? `\n[Searchable terms: ${vocabulary.slice(0, 20).join(', ')}]`
    : '';
  return `${header}\n\n${body}${footer}`;
}

/**
 * Chunk content by markdown headings, blank-line-separated paragraphs, or fixed line count.
 */
function chunkByStructure(content: string): string[] {
  const chunks: string[] = [];

  // Try markdown heading splits first
  const headingSplit = content.split(/^(?=#{1,4}\s)/m);
  if (headingSplit.length > 2) {
    for (const section of headingSplit) {
      const trimmed = section.trim();
      if (trimmed.length > 0) chunks.push(trimmed);
    }
    return chunks;
  }

  // Try blank-line paragraph splits
  const paragraphSplit = content.split(/\n\s*\n/);
  if (paragraphSplit.length > 2) {
    let current = '';
    for (const para of paragraphSplit) {
      const trimmed = para.trim();
      if (!trimmed) continue;
      if (current.length + trimmed.length > 2000 && current.length > 0) {
        chunks.push(current.trim());
        current = trimmed;
      } else {
        current += (current ? '\n\n' : '') + trimmed;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
  }

  // Fall back to fixed-size line chunks
  const lines = content.split('\n');
  const chunkSize = Math.max(10, Math.ceil(lines.length / 20));
  for (let i = 0; i < lines.length; i += chunkSize) {
    const chunk = lines.slice(i, i + chunkSize).join('\n').trim();
    if (chunk) chunks.push(chunk);
  }

  return chunks;
}

function sanitizeFTS5Query(query: string): string {
  const words = query.trim().split(/\s+/).filter(w => w.length > 1);
  if (words.length === 0) return '""';
  return words.map(w => `"${w.replace(/"/g, '""')}"`).join(' OR ');
}

/**
 * Fallback keyword search when FTS5 match returns nothing.
 */
function keywordSearch(chunks: string[], intent: string): string[] {
  const keywords = intent.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (keywords.length === 0) return [];

  const scored = chunks.map(chunk => {
    const lower = chunk.toLowerCase();
    const score = keywords.reduce((sum, kw) => {
      const matches = lower.split(kw).length - 1;
      return sum + matches;
    }, 0);
    return { chunk, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SNIPPETS)
    .map(s => s.chunk);
}

/**
 * Extract high-signal vocabulary terms from chunks for follow-up queries.
 */
function extractVocabulary(chunks: string[]): string[] {
  const wordFreq = new Map<string, number>();
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
    'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
    'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
    'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most',
    'other', 'some', 'such', 'no', 'only', 'own', 'same', 'than',
    'too', 'very', 'just', 'because', 'this', 'that', 'these', 'those',
    'it', 'its', 'itself', 'they', 'them', 'their', 'what', 'which',
    'who', 'whom', 'how', 'when', 'where', 'why', 'if', 'then', 'else',
    'true', 'false', 'null', 'undefined', 'function', 'return', 'const',
    'let', 'var', 'import', 'export', 'default', 'class', 'new', 'type',
  ]);

  for (const chunk of chunks) {
    const words = chunk.toLowerCase().match(/[a-z_][a-z0-9_-]{2,}/g) || [];
    for (const word of words) {
      if (!stopWords.has(word) && word.length >= 3) {
        wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
      }
    }
  }

  return Array.from(wordFreq.entries())
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([word]) => word);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

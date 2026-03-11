/**
 * Context Compression Module for UAM
 * 
 * Implements semantic compression to reduce token usage while preserving meaning.
 * Based on Acon (Agent Context Optimization) and AgentCompress research.
 */

import { jaccardSimilarity } from '../utils/string-similarity.js';

export interface CompressionResult {
  original: string;
  compressed: string;
  originalTokens: number;
  compressedTokens: number;
  tokenReduction: number;
  preservedSemantics: number;
}

export interface CompressorConfig {
  maxTokens: number;
  minSemanticPreservation: number;
  compressionLevel: 'light' | 'medium' | 'aggressive';
}

const DEFAULT_CONFIG: CompressorConfig = {
  maxTokens: 800,
  minSemanticPreservation: 0.85,
  compressionLevel: 'medium',
};

/**
 * Estimate token count using improved heuristics for mixed code/prose
 * More accurate than simple length/4: accounts for whitespace splits,
 * special characters, camelCase, and numeric tokens.
 */
export function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0;
  
  // Split by whitespace for base word count
  const words = text.split(/\s+/).filter(w => w.length > 0);
  
  // Special characters that typically become separate tokens
  const specialChars = (text.match(/[{}()\[\]<>:;,."'`@#$%^&*+=|\\/?!~-]/g) || []).length;
  
  // Code tokens: camelCase/snake_case boundaries add sub-word tokens
  const codeTokens = (text.match(/[a-z][A-Z]|_[a-z]/g) || []).length;
  
  // Numeric sequences often tokenize separately
  const numbers = (text.match(/\d+/g) || []).length;
  
  // Average English word is ~1.3 tokens, code identifiers ~1.5
  const baseTokens = words.length * 1.3;
  const specialTokens = specialChars * 0.5;
  const extraCodeTokens = codeTokens * 0.3;
  const numberTokens = numbers * 0.5;
  
  return Math.ceil(baseTokens + specialTokens + extraCodeTokens + numberTokens);
}

/**
 * Compress a single memory entry
 */
export function compressMemoryEntry(content: string, config: Partial<CompressorConfig> = {}): CompressionResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const originalTokens = estimateTokens(content);
  
  if (originalTokens <= cfg.maxTokens / 4) {
    return {
      original: content,
      compressed: content,
      originalTokens,
      compressedTokens: originalTokens,
      tokenReduction: 0,
      preservedSemantics: 1.0,
    };
  }

  let compressed = content;
  
  // Level 1: Remove redundant whitespace and formatting
  compressed = compressed.replace(/\s+/g, ' ').trim();
  compressed = compressed.replace(/\n{3,}/g, '\n\n');
  
  // Level 2: Remove common filler phrases
  if (cfg.compressionLevel !== 'light') {
    const fillerPatterns = [
      /\b(basically|essentially|actually|really|very|quite|somewhat|rather)\b/gi,
      /\b(in order to)\b/gi,
      /\b(it is worth noting that|it should be noted that)\b/gi,
      /\b(as a matter of fact|in fact)\b/gi,
      /\b(at the end of the day)\b/gi,
      /\b(the fact that)\b/gi,
      /\b(in this case|in that case)\b/gi,
    ];
    
    for (const pattern of fillerPatterns) {
      compressed = compressed.replace(pattern, '');
    }
  }
  
  // Level 3: Aggressive - truncate to key sentences
  if (cfg.compressionLevel === 'aggressive') {
    const sentences = compressed.split(/(?<=[.!?])\s+/);
    const maxSentences = Math.max(3, Math.ceil(sentences.length * 0.4));
    
    // Keep first sentence (context), middle sentences (key info), last sentence (conclusion)
    if (sentences.length > maxSentences) {
      const first = sentences.slice(0, 1);
      const middle = sentences.slice(1, -1).slice(0, maxSentences - 2);
      const last = sentences.slice(-1);
      compressed = [...first, ...middle, ...last].join(' ');
    }
  }
  
  // Clean up artifacts
  compressed = compressed.replace(/\s{2,}/g, ' ').trim();
  
  const compressedTokens = estimateTokens(compressed);
  const tokenReduction = 1 - (compressedTokens / originalTokens);
  
  // Estimate semantic preservation (based on compression ratio - rough heuristic)
  const preservedSemantics = Math.max(0.7, 1 - (tokenReduction * 0.3));
  
  return {
    original: content,
    compressed,
    originalTokens,
    compressedTokens,
    tokenReduction,
    preservedSemantics,
  };
}

/**
 * Compress multiple memories into a consolidated context
 */
export function compressMemoryBatch(
  memories: Array<{ content: string; type: string; importance?: number }>,
  config: Partial<CompressorConfig> = {}
): CompressionResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  
  // Sort by importance (descending)
  const sorted = [...memories].sort((a, b) => (b.importance || 5) - (a.importance || 5));
  
  // Group by type for structured output
  const grouped: Record<string, string[]> = {};
  for (const mem of sorted) {
    const type = mem.type || 'general';
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push(mem.content);
  }
  
  // Build consolidated context
  const sections: string[] = [];
  const typeOrder = ['goal', 'action', 'observation', 'thought'];
  
  for (const type of typeOrder) {
    if (grouped[type] && grouped[type].length > 0) {
      const compressed = grouped[type].map(c => compressMemoryEntry(c, cfg).compressed);
      sections.push(`[${type.toUpperCase()}]\n${compressed.join('\n')}`);
    }
  }
  
  // Add remaining types
  for (const type of Object.keys(grouped)) {
    if (!typeOrder.includes(type)) {
      const compressed = grouped[type].map(c => compressMemoryEntry(c, cfg).compressed);
      sections.push(`[${type.toUpperCase()}]\n${compressed.join('\n')}`);
    }
  }
  
  const original = memories.map(m => m.content).join('\n');
  const compressed = sections.join('\n\n');
  
  const originalTokens = estimateTokens(original);
  const compressedTokens = estimateTokens(compressed);
  
  return {
    original,
    compressed,
    originalTokens,
    compressedTokens,
    tokenReduction: 1 - (compressedTokens / originalTokens),
    preservedSemantics: 0.9, // Batch compression preserves structure
  };
}

/**
 * Summarize old memories into a single compressed entry
 */
export function summarizeMemories(
  memories: Array<{ content: string; timestamp: string; type: string }>,
  maxOutputTokens: number = 500
): string {
  if (memories.length === 0) return '';
  
  // Group by type
  const byType: Record<string, string[]> = {};
  for (const mem of memories) {
    if (!byType[mem.type]) byType[mem.type] = [];
    byType[mem.type].push(mem.content);
  }
  
  // Create summary sections
  const summaryParts: string[] = [];
  
  for (const [type, contents] of Object.entries(byType)) {
    // Deduplicate similar content
    const unique = deduplicateContent(contents);
    
    // Compress each unique entry
    const compressed = unique.map(c => {
      const result = compressMemoryEntry(c, { compressionLevel: 'aggressive' });
      return result.compressed;
    });
    
    // Limit to most important entries
    const maxPerType = Math.max(2, Math.floor(maxOutputTokens / (Object.keys(byType).length * 50)));
    const limited = compressed.slice(0, maxPerType);
    
    if (limited.length > 0) {
      summaryParts.push(`${type}: ${limited.join('; ')}`);
    }
  }
  
  const dateRange = getDateRange(memories.map(m => m.timestamp));
  const header = `[Summary ${dateRange}]`;
  
  return `${header}\n${summaryParts.join('\n')}`;
}

/**
 * Deduplicate content using simple similarity check
 */
function deduplicateContent(contents: string[], threshold: number = 0.8): string[] {
  const unique: string[] = [];
  
  for (const content of contents) {
    const normalizedNew = content.toLowerCase().replace(/\s+/g, ' ').trim();
    
    let isDuplicate = false;
    for (const existing of unique) {
      const normalizedExisting = existing.toLowerCase().replace(/\s+/g, ' ').trim();
      const similarity = jaccardSimilarity(normalizedNew, normalizedExisting);
      
      if (similarity > threshold) {
        isDuplicate = true;
        break;
      }
    }
    
    if (!isDuplicate) {
      unique.push(content);
    }
  }
  
  return unique;
}

// jaccardSimilarity imported from ../utils/string-similarity.js

/**
 * Get date range string
 */
function getDateRange(timestamps: string[]): string {
  if (timestamps.length === 0) return 'unknown';
  
  const dates = timestamps.map(t => new Date(t)).filter(d => !isNaN(d.getTime()));
  if (dates.length === 0) return 'unknown';
  
  const min = new Date(Math.min(...dates.map(d => d.getTime())));
  const max = new Date(Math.max(...dates.map(d => d.getTime())));
  
  const formatDate = (d: Date) => d.toISOString().split('T')[0];
  
  if (formatDate(min) === formatDate(max)) {
    return formatDate(min);
  }
  
  return `${formatDate(min)} to ${formatDate(max)}`;
}

/**
 * Smart truncation using head+tail split.
 * Preserves both initial context (setup, config) and final output (errors, results).
 * Head gets 60%, tail gets 40% of the allowed line budget.
 */
export function smartTruncate(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;

  const lines = content.split('\n');
  if (lines.length <= 4) {
    // Too few lines for head+tail split, just char-truncate
    return content.slice(0, maxChars) + '\n... [truncated]';
  }

  const ratio = Math.min(1, maxChars / content.length);
  const totalLines = Math.max(2, Math.floor(lines.length * ratio));
  const headLines = Math.max(1, Math.ceil(totalLines * 0.6));
  const tailLines = Math.max(1, totalLines - headLines);

  // Avoid overlap when head + tail >= total lines
  if (headLines + tailLines >= lines.length) {
    return content.slice(0, maxChars) + '\n... [truncated]';
  }

  const headPart = lines.slice(0, headLines);
  const tailPart = lines.slice(-tailLines);
  const omitted = lines.length - headLines - tailLines;

  return [
    ...headPart,
    `\n... [${omitted} lines truncated — showing first ${headLines} + last ${tailLines} lines] ...\n`,
    ...tailPart,
  ].join('\n');
}

/**
 * Context budget manager
 */
export class ContextBudget {
  private maxTokens: number;
  private usedTokens: number = 0;
  private sections: Map<string, number> = new Map();

  constructor(maxTokens: number = 12000) {
    this.maxTokens = maxTokens;
  }

  allocate(section: string, content: string): { content: string; tokens: number; truncated: boolean } {
    const tokens = estimateTokens(content);
    const available = this.maxTokens - this.usedTokens;
    
    if (tokens <= available) {
      this.usedTokens += tokens;
      this.sections.set(section, tokens);
      return { content, tokens, truncated: false };
    }
    
    // Need to truncate - use head+tail split to preserve error context
    const targetTokens = Math.floor(available * 0.9);
    const targetChars = targetTokens * 4;
    const truncated = smartTruncate(content, targetChars);
    const actualTokens = estimateTokens(truncated);
    
    this.usedTokens += actualTokens;
    this.sections.set(section, actualTokens);
    
    return { content: truncated, tokens: actualTokens, truncated: true };
  }

  remaining(): number {
    return this.maxTokens - this.usedTokens;
  }

  usage(): { total: number; used: number; remaining: number; sections: Record<string, number> } {
    return {
      total: this.maxTokens,
      used: this.usedTokens,
      remaining: this.remaining(),
      sections: Object.fromEntries(this.sections),
    };
  }

  reset(): void {
    this.usedTokens = 0;
    this.sections.clear();
  }
}

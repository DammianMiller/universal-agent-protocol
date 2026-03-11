/**
 * Semantic Compression Module for UAM
 * 
 * Implements SimpleMem-style semantic structured compression:
 * 1. Entropy-aware filtering to distill raw content into atomic facts
 * 2. Coreference normalization (entity resolution)
 * 3. Multi-view indexing for efficient retrieval
 * 
 * Based on SimpleMem research (2026): 30x token reduction while maintaining F1 scores
 */

import { estimateTokens } from './context-compressor.js';
import { jaccardSimilarity } from '../utils/string-similarity.js';

export interface AtomicFact {
  content: string;
  entities: string[];
  actionability: number;    // 0-1: how actionable is this fact
  temporality: 'past' | 'present' | 'future' | 'timeless';
  type: 'fact' | 'decision' | 'lesson' | 'pattern' | 'gotcha';
}

export interface SemanticUnit {
  id: string;
  atomicFacts: AtomicFact[];
  entities: string[];           // Normalized entities across all facts
  temporalMarkers: string[];    // Time-relevant markers
  sourceTokens: number;         // Original token count
  compressedTokens: number;     // After compression
  compressionRatio: number;     // sourceTokens / compressedTokens
}

export interface SemanticCompressionConfig {
  maxFactsPerUnit: number;
  minActionability: number;     // Filter facts below this threshold
  minEntropy: number;           // Filter low-entropy (repetitive) content
  deduplicationThreshold: number;
  preserveHighImportance: boolean;
}

// OPTIMIZATION 7: Added soft caps for gotchas and lessons to prevent token bloat
const MAX_GOTCHAS_PER_UNIT = 5;
const MAX_LESSONS_PER_UNIT = 5;

const DEFAULT_CONFIG: SemanticCompressionConfig = {
  maxFactsPerUnit: 10,
  minActionability: 0.3,
  minEntropy: 0.3,              // Minimum entropy threshold
  deduplicationThreshold: 0.85,
  preserveHighImportance: true,
};

/**
 * Calculate Shannon entropy of text (normalized 0-1)
 * Higher entropy = more information content, less repetition
 * Based on SimpleMem's entropy-aware filtering
 */
export function calculateEntropy(text: string): number {
  const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 1);
  if (words.length === 0) return 0;
  
  // Count word frequencies
  const freq = new Map<string, number>();
  for (const word of words) {
    freq.set(word, (freq.get(word) || 0) + 1);
  }
  
  // Calculate Shannon entropy
  let entropy = 0;
  const total = words.length;
  
  for (const count of freq.values()) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  
  // Normalize to 0-1 range (max entropy = log2(unique_words))
  const maxEntropy = Math.log2(freq.size) || 1;
  return entropy / maxEntropy;
}

/**
 * Calculate information density (entropy per token)
 * Helps identify high-value content worth preserving
 */
export function calculateInformationDensity(text: string): number {
  const entropy = calculateEntropy(text);
  
  // Weight by unique word ratio
  const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 1);
  const uniqueRatio = new Set(words).size / (words.length || 1);
  
  // Combine entropy and uniqueness
  return (entropy * 0.6 + uniqueRatio * 0.4);
}

/**
 * Extract atomic facts from raw content
 * Distills verbose content into minimal, self-contained units
 */
export function extractAtomicFacts(content: string, minEntropy: number = 0.3): AtomicFact[] {
  const facts: AtomicFact[] = [];
  
  // Split into sentences
  const sentences = content
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 10);
  
  for (const sentence of sentences) {
    const normalized = sentence.toLowerCase();
    
    // Determine fact type early so we can skip entropy filtering for gotchas
    let type: AtomicFact['type'] = 'fact';
    if (/learned|realized|discovered|found that/i.test(sentence)) {
      type = 'lesson';
    } else if (/decided|chose|selected|went with/i.test(sentence)) {
      type = 'decision';
    } else if (/pattern|always|usually|typically/i.test(sentence)) {
      type = 'pattern';
    } else if (/careful|watch out|gotcha|avoid|don't|never|must|critical|important/i.test(sentence)) {
      type = 'gotcha';
    }
    
    // Skip low-entropy (repetitive) content, but NEVER skip gotchas or lessons
    // These contain critical domain knowledge that may have low lexical entropy
    // but high informational value (e.g., "COBOL: Fixed column format (7-72 are code)")
    const entropy = calculateEntropy(sentence);
    if (entropy < minEntropy && sentence.length > 50 && type !== 'gotcha' && type !== 'lesson') {
      continue;
    }
    
    // Calculate actionability (boost by entropy for high-info content)
    const baseActionability = calculateActionability(sentence);
    const actionability = Math.min(1, baseActionability + (entropy * 0.1));
    
    // Determine temporality
    const temporality = detectTemporality(sentence);
    
    // Extract entities
    const entities = extractEntities(sentence);
    
    // Skip low-value sentences
    if (isFillerSentence(normalized)) continue;
    
    facts.push({
      content: compressSentence(sentence),
      entities,
      actionability,
      temporality,
      type,
    });
  }
  
  return facts;
}

/**
 * Calculate actionability score (0-1)
 * Higher = more directly usable information
 */
function calculateActionability(sentence: string): number {
  let score = 0.5;
  
  // Boost for imperative/actionable language
  if (/^(use|run|execute|call|apply|implement|add|remove|fix|change)/i.test(sentence)) {
    score += 0.3;
  }
  
  // Boost for code/technical specifics
  if (/`[^`]+`|"[^"]+"|'[^']+'/.test(sentence)) {
    score += 0.2;
  }
  
  // Boost for concrete commands/paths
  if (/\.(ts|js|py|sh|json|yaml|md)\b|\/[\w/]+/.test(sentence)) {
    score += 0.15;
  }
  
  // Penalty for vague language
  if (/might|maybe|perhaps|possibly|somewhat|kind of/i.test(sentence)) {
    score -= 0.2;
  }
  
  // Penalty for meta-commentary
  if (/I think|I believe|in my opinion|it seems/i.test(sentence)) {
    score -= 0.15;
  }
  
  return Math.max(0, Math.min(1, score));
}

/**
 * Detect temporal relevance
 */
function detectTemporality(sentence: string): AtomicFact['temporality'] {
  if (/will|going to|should|must|need to|plan to/i.test(sentence)) {
    return 'future';
  }
  if (/was|were|did|had|previously|earlier|before/i.test(sentence)) {
    return 'past';
  }
  if (/is|are|currently|now|today/i.test(sentence)) {
    return 'present';
  }
  return 'timeless';
}

/**
 * Extract named entities from sentence
 */
function extractEntities(sentence: string): string[] {
  const entities: string[] = [];
  
  // File paths
  const paths = sentence.match(/[\w./\\-]+\.(ts|js|py|json|yaml|yml|md|sh|sql)/gi);
  if (paths) entities.push(...paths);
  
  // Function/class names (camelCase or PascalCase)
  const names = sentence.match(/\b[a-z][a-zA-Z0-9]*(?:[A-Z][a-zA-Z0-9]*)+\b/g);
  if (names) entities.push(...names);
  
  // Commands (npm, git, uam, etc)
  const commands = sentence.match(/\b(npm|git|uam|docker|curl|pip|python|node)\s+\w+/gi);
  if (commands) entities.push(...commands.map(c => c.trim()));
  
  // Quoted strings
  const quoted = sentence.match(/`([^`]+)`/g);
  if (quoted) entities.push(...quoted.map(q => q.replace(/`/g, '')));
  
  return [...new Set(entities)];
}

/**
 * Detect filler sentences that add no value
 */
function isFillerSentence(sentence: string): boolean {
  const fillerPatterns = [
    /^(let me|i will|i'll|we can|we should|okay|alright|sure)/i,
    /^(as mentioned|as noted|as stated|as discussed)/i,
    /^(this is|that is|here is|there is) (a|the|an)?\s*(good|great|nice)/i,
    /^(in conclusion|to summarize|in summary|overall)/i,
    /^(i hope|hope this|hopefully)/i,
    /^(thanks|thank you|please)/i,
  ];
  
  return fillerPatterns.some(p => p.test(sentence));
}

/**
 * Compress a single sentence while preserving meaning
 */
function compressSentence(sentence: string): string {
  let compressed = sentence;
  
  // Remove filler phrases
  const fillerPhrases = [
    /\b(basically|essentially|actually|really|very|quite|somewhat|rather)\b/gi,
    /\b(in order to)\b/gi,
    /\b(it is worth noting that|it should be noted that)\b/gi,
    /\b(as a matter of fact|in fact)\b/gi,
    /\b(the fact that)\b/gi,
    /\b(in this case|in that case)\b/gi,
    /\b(please note that|note that)\b/gi,
  ];
  
  for (const pattern of fillerPhrases) {
    compressed = compressed.replace(pattern, '');
  }
  
  // Clean up whitespace
  compressed = compressed.replace(/\s+/g, ' ').trim();
  
  return compressed;
}

/**
 * Create a semantic unit from multiple memories
 */
export function createSemanticUnit(
  memories: Array<{ content: string; importance?: number }>,
  config: Partial<SemanticCompressionConfig> = {}
): SemanticUnit {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  
  // Extract facts from all memories
  const allFacts: AtomicFact[] = [];
  let sourceTokens = 0;
  
  for (const mem of memories) {
    sourceTokens += estimateTokens(mem.content);
    const facts = extractAtomicFacts(mem.content);
    
    // Filter by actionability
    const filtered = facts.filter(f => 
      f.actionability >= cfg.minActionability ||
      (cfg.preserveHighImportance && (mem.importance || 0) >= 7)
    );
    
    allFacts.push(...filtered);
  }
  
  // Deduplicate similar facts
  const uniqueFacts = deduplicateFacts(allFacts, cfg.deduplicationThreshold);
  
  // OPTIMIZATION 7: Apply soft caps for gotchas and lessons to prevent token bloat
  // Sort all facts by actionability
  uniqueFacts.sort((a, b) => b.actionability - a.actionability);
  
  // Separate gotchas/lessons from other facts, apply caps, then recombine
  const gotchas = uniqueFacts.filter(f => f.type === 'gotcha').slice(0, MAX_GOTCHAS_PER_UNIT);
  const lessons = uniqueFacts.filter(f => f.type === 'lesson').slice(0, MAX_LESSONS_PER_UNIT);
  const otherFacts = uniqueFacts.filter(f => f.type !== 'gotcha' && f.type !== 'lesson');
  
  // Recombine: gotchas and lessons first (they're highest value), then other facts
  const cappedFacts = [...gotchas, ...lessons, ...otherFacts];
  const topFacts = cappedFacts.slice(0, cfg.maxFactsPerUnit);
  
  // Collect all entities
  const allEntities = new Set<string>();
  for (const fact of topFacts) {
    fact.entities.forEach(e => allEntities.add(e));
  }
  
  // Collect temporal markers
  const temporalMarkers = [...new Set(
    topFacts
      .filter(f => f.temporality !== 'timeless')
      .map(f => f.temporality)
  )];
  
  // Calculate compressed size
  const compressedContent = topFacts.map(f => f.content).join(' ');
  const compressedTokens = estimateTokens(compressedContent);
  
  return {
    id: `su-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    atomicFacts: topFacts,
    entities: [...allEntities],
    temporalMarkers,
    sourceTokens,
    compressedTokens,
    compressionRatio: sourceTokens / Math.max(1, compressedTokens),
  };
}

/**
 * Deduplicate facts by content similarity
 */
function deduplicateFacts(facts: AtomicFact[], threshold: number): AtomicFact[] {
  const unique: AtomicFact[] = [];
  
  for (const fact of facts) {
    const isDuplicate = unique.some(existing => {
      const similarity = jaccardSimilarity(
        fact.content.toLowerCase(),
        existing.content.toLowerCase()
      );
      return similarity > threshold;
    });
    
    if (!isDuplicate) {
      unique.push(fact);
    }
  }
  
  return unique;
}

// jaccardSimilarity imported from ../utils/string-similarity.js

/**
 * Serialize semantic unit for storage/display
 */
export function serializeSemanticUnit(unit: SemanticUnit): string {
  const sections: string[] = [];
  
  // Group facts by type
  const byType: Record<string, AtomicFact[]> = {};
  for (const fact of unit.atomicFacts) {
    if (!byType[fact.type]) byType[fact.type] = [];
    byType[fact.type].push(fact);
  }
  
  // Format each section
  const typeOrder = ['gotcha', 'lesson', 'decision', 'pattern', 'fact'];
  for (const type of typeOrder) {
    if (byType[type] && byType[type].length > 0) {
      const emoji = type === 'gotcha' ? '⚠️' :
                    type === 'lesson' ? '💡' :
                    type === 'decision' ? '✓' :
                    type === 'pattern' ? '🔄' : '→';
      
      sections.push(
        byType[type].map(f => `${emoji} ${f.content}`).join('\n')
      );
    }
  }
  
  // Add entities if present
  if (unit.entities.length > 0) {
    sections.push(`[Entities: ${unit.entities.slice(0, 10).join(', ')}]`);
  }
  
  return sections.join('\n');
}

/**
 * Compress batch of memories into semantic units
 * Main entry point for semantic compression
 */
export function compressToSemanticUnits(
  memories: Array<{ content: string; type: string; importance?: number; timestamp?: string }>,
  config: Partial<SemanticCompressionConfig> = {}
): {
  units: SemanticUnit[];
  totalSourceTokens: number;
  totalCompressedTokens: number;
  overallRatio: number;
  serialized: string;
} {
  // Group memories by type for better compression
  const byType: Record<string, typeof memories> = {};
  for (const mem of memories) {
    const type = mem.type || 'general';
    if (!byType[type]) byType[type] = [];
    byType[type].push(mem);
  }
  
  const units: SemanticUnit[] = [];
  let totalSourceTokens = 0;
  let totalCompressedTokens = 0;
  
  for (const [_type, typeMemories] of Object.entries(byType)) {
    // Chunk into groups of 5-10 for manageable units
    const chunkSize = 7;
    for (let i = 0; i < typeMemories.length; i += chunkSize) {
      const chunk = typeMemories.slice(i, i + chunkSize);
      const unit = createSemanticUnit(chunk, config);
      units.push(unit);
      totalSourceTokens += unit.sourceTokens;
      totalCompressedTokens += unit.compressedTokens;
    }
  }
  
  const serialized = units.map(u => serializeSemanticUnit(u)).join('\n\n---\n\n');
  
  return {
    units,
    totalSourceTokens,
    totalCompressedTokens,
    overallRatio: totalSourceTokens / Math.max(1, totalCompressedTokens),
    serialized,
  };
}

/**
 * PATTERN ROUTER - Enforces Terminal-Bench discovered patterns
 *
 * This module reads pattern definitions from .factory/patterns/index.json
 * and enforces them during task classification and execution.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { AdaptiveCache } from '../utils/adaptive-cache.js';
import { getAdaptivePatternEngine } from './adaptive-patterns.js';

export interface PatternDefinition {
  id: string | number;
  file: string;
  title: string;
  abbreviation: string;
  category: string;
  keywords: string[];
}

export class PatternRouter {
  private patterns: Map<string, PatternDefinition>;
  private loadedFromPath?: string;
  /** Cache for matchPatterns results — avoids re-scanning all patterns on repeated queries */
  private matchCache: AdaptiveCache<string, PatternDefinition[]>;

  constructor() {
    this.patterns = new Map();
    this.matchCache = new AdaptiveCache({
      maxEntries: 200,
      defaultTTL: 300_000, // 5 minutes
      hotThreshold: 5,
      coldEvictionRatio: 0.5,
    });
  }

  /**
   * Load pattern definitions from index.json
   */
  loadPatterns(projectDir: string): boolean {
    const indexPath = join(projectDir, '.factory/patterns/index.json');

    if (!existsSync(indexPath)) {
      return false;
    }

    try {
      const content = readFileSync(indexPath, 'utf-8');
      const data = JSON.parse(content) as { patterns: PatternDefinition[] };

      for (const pattern of data.patterns) {
        this.patterns.set(String(pattern.id), pattern);
      }

      this.loadedFromPath = indexPath;
      return true;
    } catch (_error) {
      return false;
    }
  }

  /**
   * Get all loaded patterns
   */
  getPatterns(): PatternDefinition[] {
    return Array.from(this.patterns.values());
  }

  /**
   * Get the path patterns were loaded from
   */
  getLoadedPath(): string | undefined {
    return this.loadedFromPath;
  }

  /**
   * Match patterns based on keywords or task description.
   * Results are cached with adaptive TTL to avoid re-scanning on repeated queries.
   */
  matchPatterns(description: string): PatternDefinition[] {
    const normalized = description.toLowerCase();

    // Check adaptive cache first
    const cached = this.matchCache.get(normalized);
    if (cached) return cached;

    const matches: PatternDefinition[] = [];

    for (const [_id, pattern] of this.patterns) {
      const hasKeywords = pattern.keywords.some((kw) => normalized.includes(kw.toLowerCase()));

      if (hasKeywords) {
        matches.push(pattern);
      }
    }

    // Store in cache (priority based on match count)
    this.matchCache.set(normalized, matches, matches.length);

    return matches;
  }

  /**
   * Get enforcement checklist for a task description.
   * Always includes critical patterns (Output Existence, Decoder-First) regardless of keywords.
   * Sorts by historical success rate from AdaptivePatternEngine when data is available.
   */
  getEnforcementChecklist(description: string, taskCategory?: string): PatternDefinition[] {
    const matched = this.matchPatterns(description);

    // Always include critical patterns regardless of keywords
    const alwaysIncludeIds = ['P12', 'P35']; // Output Existence, Decoder-First

    for (const id of alwaysIncludeIds) {
      if (!matched.some((p) => String(p.id) === id)) {
        const pattern = this.patterns.get(id);
        if (pattern && !matched.includes(pattern)) {
          matched.push(pattern);
        }
      }
    }

    // Sort by historical success rate from AdaptivePatternEngine
    if (taskCategory) {
      try {
        const engine = getAdaptivePatternEngine();
        const adapted = engine.getAdaptedPatterns(taskCategory);
        if (adapted.length > 0) {
          const rateMap = new Map(adapted.map(a => [a.id, a.successRate]));
          matched.sort((a, b) => {
            const rateA = rateMap.get(String(a.id)) ?? 0.5;
            const rateB = rateMap.get(String(b.id)) ?? 0.5;
            return rateB - rateA; // Higher success rate first
          });
        }
      } catch {
        // AdaptivePatternEngine not available -- use default order
      }
    }

    return matched;
  }

  /**
   * Print loaded patterns for debugging
   */
  printPatterns(): void {
    const byCategory = new Map<string, PatternDefinition[]>();
    for (const pattern of this.patterns.values()) {
      if (!byCategory.has(pattern.category)) {
        byCategory.set(pattern.category, []);
      }
      byCategory.get(pattern.category)!.push(pattern);
    }

    for (const [category, patterns] of byCategory.entries()) {
      console.log(`\n${category} (${patterns.length}):`);
      for (const pattern of patterns) {
        console.log(`  - ${pattern.abbreviation}: ${pattern.title}`);
      }
    }
  }
}

// Singleton instance with lazy initialization
let router: PatternRouter | null = null;

export function getPatternRouter(): PatternRouter {
  if (!router) {
    router = new PatternRouter();

    // Try to load patterns from current project
    const cwd = process.cwd();
    if (existsSync(join(cwd, '.factory/patterns/index.json'))) {
      router.loadPatterns(cwd);
    }
  }

  return router;
}

/**
 * Reset the singleton (for testing)
 */
export function resetPatternRouter(): void {
  router = null;
}

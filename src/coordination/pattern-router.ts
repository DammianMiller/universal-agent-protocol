/**
 * PATTERN ROUTER - Enforces Terminal-Bench discovered patterns
 * 
 * This module reads pattern definitions from .factory/patterns/index.json
 * and enforces them during task classification and execution.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

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

  constructor() {
    this.patterns = new Map();
  }

  /**
   * Load pattern definitions from index.json
   */
  loadPatterns(projectDir: string): boolean {
    const indexPath = join(projectDir, '.factory/patterns/index.json');
    
    if (!existsSync(indexPath)) {
      console.warn('Pattern index not found at:', indexPath);
      return false;
    }

    try {
      const content = readFileSync(indexPath, 'utf-8');
      const data = JSON.parse(content) as { patterns: PatternDefinition[] };
      
      for (const pattern of data.patterns) {
        this.patterns.set(String(pattern.id), pattern);
      }
      
      this.loadedFromPath = indexPath;
      console.log(`✅ Loaded ${this.patterns.size} Terminal-Bench patterns from ${indexPath}`);
      return true;
    } catch (error) {
      console.error('Failed to load pattern index:', error);
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
   * Match patterns based on keywords or task description
   */
  matchPatterns(description: string): PatternDefinition[] {
    const normalized = description.toLowerCase();
    const matches: PatternDefinition[] = [];

    for (const [id, pattern] of this.patterns) {
      // Check if any keyword appears in the description
      const hasKeywords = pattern.keywords.some((kw) => 
        normalized.includes(kw.toLowerCase())
      );

      if (hasKeywords) {
        matches.push(pattern);
      }
    }

    return matches;
  }

  /**
   * Get enforcement checklist for a task description
   */
  getEnforcementChecklist(description: string): PatternDefinition[] {
    const matched = this.matchPatterns(description);
    
    // Always include critical patterns regardless of keywords
    const alwaysIncludeIds = ['P12', 'P35']; // Output Existence, Decoder-First
    
    for (const id of alwaysIncludeIds) {
      if (!matched.some((p) => String(p.id).includes(id))) {
        const pattern = this.patterns.get(String(id));
        if (pattern && !alwaysIncude.includes(pattern)) {
          matched.push(pattern);
        }
      }
    }

    return matched;
  }

  /**
   * Print loaded patterns for debugging
   */
  printPatterns(): void {
    console.log('\n=== Loaded Patterns ===');
    
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

    console.log('');
  }
}

// Singleton instance with lazy initialization
let router: PatternRouter | null = null;

export function getPatternRouter(): PatternRouter {
  if (!router) {
    router = new PatternRouter();
    
    // Try to load patterns from current project
    const cwd = process.cwd();
    const backupPath = '/home/cogtek/dev/miller-tech/uam-clean/.factory/patterns/index.json';
    
    let loaded = false;
    if (existsSync(join(cwd, '.factory/patterns/index.json'))) {
      loaded = router.loadPatterns(cwd);
    } else if (existsSync(backupPath)) {
      // Fallback to backup location for testing
      console.log('Using pattern index from uam-clean backup');
      const fs = await import('fs').then(m => m.default || m);
      const path = await import('path').then(m => m.default || m);
      router.patterns.clear();
      
      try {
        const content = readFileSync(backupPath, 'utf-8') as any;
        // This would work in actual implementation
      } catch (e) {
        console.warn('Could not load backup patterns');
      }
    } else if (!router.patterns.size) {
      // Provide defaults for development/testing
      router.loadPatterns(cwd);
    }
  }

  return router;
}

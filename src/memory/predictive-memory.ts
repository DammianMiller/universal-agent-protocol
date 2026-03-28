/**
 * Predictive Memory Service for UAP
 *
 * Predicts which memory queries will be needed for a given task and
 * prefetches them to reduce latency. Learns from observed access
 * patterns to improve predictions over time.
 */

import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { jaccardSimilarity } from '../utils/string-similarity.js';
import { concurrentMap } from '../utils/concurrency-pool.js';

/**
 * Category-to-keywords mapping for domain-based prediction.
 * Security tasks need auth patterns, deployment tasks need infra patterns, etc.
 */
const CATEGORY_QUERIES: Record<string, string[]> = {
  security: ['authentication', 'authorization', 'auth patterns', 'security policy', 'credentials'],
  deployment: ['deploy process', 'infrastructure', 'CI/CD', 'environment config', 'release'],
  testing: ['test patterns', 'test fixtures', 'test coverage', 'mocking', 'assertions'],
  refactor: ['code patterns', 'architecture decisions', 'tech debt', 'design patterns'],
  database: ['schema', 'migrations', 'query patterns', 'database config', 'ORM'],
  api: ['endpoints', 'API design', 'request handling', 'response format', 'middleware'],
  performance: ['optimization', 'caching', 'profiling', 'bottleneck', 'benchmarks'],
  debugging: ['error patterns', 'logging', 'stack traces', 'common bugs', 'troubleshooting'],
};

export interface MemoryService {
  query: (q: string) => Promise<any[]>;
}

/**
 * PredictiveMemoryService predicts what memory queries will be needed
 * for a task, prefetches them, and learns from actual access patterns.
 */
export class PredictiveMemoryService {
  /**
   * Learned mapping: task-type keywords -> queries that were actually used.
   * Map<normalized-task-keyword, string[]>
   */
  private learnedQueries: Map<string, string[]> = new Map();

  /**
   * Recent task history for similarity matching.
   * Array of { taskDescription, queriesUsed }
   */
  private taskHistory: Array<{ description: string; queries: string[] }> = [];

  private readonly maxHistory = 100;

  /**
   * Predict what memory queries will be needed for a task.
   *
   * Uses three strategies:
   * 1. Task similarity: if a similar task was done before, reuse its queries
   * 2. Entity extraction: extract technical entities from the task description
   * 3. Category-based: match task to known categories and return relevant queries
   *
   * @param taskDescription - Description of the upcoming task
   * @param recentTasks - Recent task descriptions for context
   * @returns Array of predicted query strings
   */
  predictNeededContext(taskDescription: string, recentTasks: string[]): string[] {
    const predictions = new Set<string>();

    // Strategy 1: Task similarity - find similar past tasks and reuse their queries
    this.predictFromSimilarTasks(taskDescription, predictions);

    // Strategy 2: Entity extraction - extract named entities from description
    this.predictFromEntities(taskDescription, predictions);

    // Strategy 3: Category-based - match task to known categories
    this.predictFromCategories(taskDescription, predictions);

    // Strategy 4: Recent task context - extract entities from recent tasks
    for (const recent of recentTasks.slice(0, 3)) {
      this.predictFromEntities(recent, predictions);
    }

    // Strategy 5: Learned patterns from recordAccess
    this.predictFromLearned(taskDescription, predictions);

    return [...predictions];
  }

  /**
   * Prefetch predicted memories using the provided memory service.
   *
   * @param predictions - Array of query strings to prefetch
   * @param memoryService - Service with a query method
   * @returns Map of query -> results
   */
  async prefetch(predictions: string[], memoryService: MemoryService): Promise<Map<string, any[]>> {
    const results = new Map<string, any[]>();

    // Run queries with bounded concurrency
    const entries = await concurrentMap(predictions, async (query) => {
      try {
        const queryResults = await memoryService.query(query);
        return [query, queryResults] as const;
      } catch {
        return [query, []] as const;
      }
    });

    for (const [query, queryResults] of entries) {
      results.set(query, [...queryResults]);
    }

    return results;
  }

  /**
   * Record which queries were actually used for a task.
   * This feeds the learning model so future predictions improve.
   *
   * @param taskDescription - The task that was performed
   * @param queriesUsed - The queries that were actually accessed
   */
  recordAccess(taskDescription: string, queriesUsed: string[]): void {
    // Store in history
    this.taskHistory.push({ description: taskDescription, queries: queriesUsed });
    if (this.taskHistory.length > this.maxHistory) {
      this.taskHistory.shift();
    }

    // Extract keywords and map to queries
    const keywords = this.extractKeywords(taskDescription);
    for (const keyword of keywords) {
      const existing = this.learnedQueries.get(keyword) || [];
      const merged = [...new Set([...existing, ...queriesUsed])];
      this.learnedQueries.set(keyword, merged);
    }
  }

  /**
   * Find similar past tasks and add their queries as predictions.
   */
  private predictFromSimilarTasks(taskDescription: string, predictions: Set<string>): void {
    for (const past of this.taskHistory) {
      const similarity = jaccardSimilarity(
        taskDescription.toLowerCase(),
        past.description.toLowerCase()
      );
      if (similarity > 0.3) {
        for (const query of past.queries) {
          predictions.add(query);
        }
      }
    }
  }

  /**
   * Extract technical entities from a description and use them as queries.
   */
  private predictFromEntities(description: string, predictions: Set<string>): void {
    // File paths
    const paths = description.match(/[\w./\\-]+\.(ts|js|py|json|yaml|yml|md|sh|sql)/gi);
    if (paths) {
      for (const p of paths) {
        predictions.add(p);
      }
    }

    // Function/class names (camelCase or PascalCase)
    const names = description.match(/\b[a-z][a-zA-Z0-9]*(?:[A-Z][a-zA-Z0-9]*)+\b/g);
    if (names) {
      for (const n of names) {
        predictions.add(n);
      }
    }

    // Quoted strings
    const quoted = description.match(/`([^`]+)`/g);
    if (quoted) {
      for (const q of quoted) {
        predictions.add(q.replace(/`/g, ''));
      }
    }

    // Technical terms (2+ word phrases with common dev terms)
    const techTerms = description.match(
      /\b(?:api|database|auth|config|deploy|test|build|schema|migration|route|middleware|handler|service|module|component|hook|plugin|pattern)\s+\w+/gi
    );
    if (techTerms) {
      for (const term of techTerms) {
        predictions.add(term.trim());
      }
    }
  }

  /**
   * Match task description to known categories and add category queries.
   */
  private predictFromCategories(description: string, predictions: Set<string>): void {
    const lower = description.toLowerCase();

    for (const [category, queries] of Object.entries(CATEGORY_QUERIES)) {
      // Check if the category keyword appears in the description
      if (lower.includes(category)) {
        for (const query of queries) {
          predictions.add(query);
        }
        continue;
      }

      // Also check if any of the category's queries appear as keywords
      const matchCount = queries.filter((q) => lower.includes(q.toLowerCase())).length;
      if (matchCount >= 2) {
        for (const query of queries) {
          predictions.add(query);
        }
      }
    }
  }

  /**
   * Use learned keyword->query mappings for prediction.
   */
  private predictFromLearned(description: string, predictions: Set<string>): void {
    const keywords = this.extractKeywords(description);

    for (const keyword of keywords) {
      const queries = this.learnedQueries.get(keyword);
      if (queries) {
        for (const query of queries) {
          predictions.add(query);
        }
      }
    }
  }

  /**
   * Extract significant keywords from a task description.
   * Filters out common stop words and very short words.
   */
  private extractKeywords(description: string): string[] {
    const stopWords = new Set([
      'the',
      'a',
      'an',
      'is',
      'are',
      'was',
      'were',
      'be',
      'been',
      'being',
      'have',
      'has',
      'had',
      'do',
      'does',
      'did',
      'will',
      'would',
      'could',
      'should',
      'may',
      'might',
      'can',
      'shall',
      'to',
      'of',
      'in',
      'for',
      'on',
      'with',
      'at',
      'by',
      'from',
      'as',
      'into',
      'through',
      'during',
      'before',
      'after',
      'above',
      'below',
      'between',
      'and',
      'but',
      'or',
      'not',
      'no',
      'nor',
      'so',
      'yet',
      'both',
      'each',
      'few',
      'more',
      'most',
      'other',
      'some',
      'such',
      'than',
      'too',
      'very',
      'just',
      'about',
      'up',
      'out',
      'if',
      'then',
      'that',
      'this',
      'it',
      'its',
      'all',
      'any',
      'new',
      'also',
      'get',
      'set',
      'use',
    ]);

    return description
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/[^a-z0-9-_]/g, ''))
      .filter((w) => w.length > 2 && !stopWords.has(w));
  }

  // ── Persistence ──────────────────────────────────────────────────────

  /**
   * Save learned data to SQLite for cross-session persistence.
   */
  saveToDb(dbPath: string): void {
    try {
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE IF NOT EXISTS predictive_queries (
          keyword TEXT PRIMARY KEY,
          queries TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS predictive_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          description TEXT NOT NULL,
          queries TEXT NOT NULL
        );
      `);

      const upsert = db.prepare(
        'INSERT OR REPLACE INTO predictive_queries (keyword, queries) VALUES (?, ?)'
      );
      const insertMany = db.transaction(() => {
        for (const [keyword, queries] of this.learnedQueries) {
          upsert.run(keyword, JSON.stringify(queries));
        }
      });
      insertMany();

      // Save recent history (replace all)
      db.exec('DELETE FROM predictive_history');
      const insertHist = db.prepare(
        'INSERT INTO predictive_history (description, queries) VALUES (?, ?)'
      );
      const insertHistMany = db.transaction(() => {
        for (const entry of this.taskHistory) {
          insertHist.run(entry.description, JSON.stringify(entry.queries));
        }
      });
      insertHistMany();

      db.close();
    } catch {
      // Persistence failure is non-fatal
    }
  }

  /**
   * Load learned data from SQLite.
   */
  loadFromDb(dbPath: string): void {
    try {
      if (!existsSync(dbPath)) return;

      const db = new Database(dbPath, { readonly: true });

      try {
        const rows = db.prepare('SELECT keyword, queries FROM predictive_queries').all() as Array<{
          keyword: string;
          queries: string;
        }>;
        for (const row of rows) {
          this.learnedQueries.set(row.keyword, JSON.parse(row.queries));
        }

        const histRows = db
          .prepare('SELECT description, queries FROM predictive_history ORDER BY id DESC LIMIT ?')
          .all(this.maxHistory) as Array<{ description: string; queries: string }>;
        this.taskHistory = histRows.map((r) => ({
          description: r.description,
          queries: JSON.parse(r.queries),
        }));
      } catch {
        // Tables may not exist yet
      }

      db.close();
    } catch {
      // Load failure is non-fatal
    }
  }
}

// Singleton
let instance: PredictiveMemoryService | null = null;

export function getPredictiveMemoryService(dbPath?: string): PredictiveMemoryService {
  if (!instance) {
    instance = new PredictiveMemoryService();
    // Auto-load from default DB path if available
    const loadPath = dbPath || './agents/data/memory/predictive.db';
    instance.loadFromDb(loadPath);
  }
  return instance;
}

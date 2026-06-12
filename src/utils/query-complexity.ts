/**
 * Query/Task Complexity Scorer — pure, dependency-free
 *
 * Heuristic complexity classification shared by the memory system (adaptive
 * retrieval depth) and the delivery harness (dynamic convergence-aid
 * activation). Extracted so consumers that only need the scorer don't drag
 * in better-sqlite3 or the memory module graph.
 *
 * Each consumer owns its thresholds: retrieval retuning must not silently
 * change how many model calls `uap deliver` makes, and vice versa.
 */

export type QueryComplexity = 'simple' | 'moderate' | 'complex';

export interface ComplexityThresholds {
  /** Score at or above which a query is 'moderate' */
  moderate: number;
  /** Score at or above which a query is 'complex' */
  complex: number;
}

export const DEFAULT_COMPLEXITY_THRESHOLDS: ComplexityThresholds = {
  moderate: 1,
  complex: 2,
};

/**
 * Measure query complexity. Based on SimpleMem's adaptive query-aware
 * retrieval scoring; deterministic and side-effect free.
 */
export function measureQueryComplexity(
  query: string,
  thresholds: ComplexityThresholds = DEFAULT_COMPLEXITY_THRESHOLDS
): QueryComplexity {
  let score = 0;

  // Length-based scoring (lower thresholds)
  const wordCount = query.split(/\s+/).length;
  if (wordCount > 30) score += 1.5;
  else if (wordCount > 12) score += 0.75;
  else if (wordCount > 6) score += 0.25;

  // Technical terms increase complexity
  const techPatterns = [
    /debug|fix|error|exception|bug/i,
    /implement|refactor|optimize|build/i,
    /configure|setup|install|deploy/i,
    /security|vulnerability|cve|auth/i,
    /performance|memory|cpu|latency/i,
    /database|query|migration|schema/i,
    /test|coverage|mock|spec/i,
  ];

  for (const pattern of techPatterns) {
    if (pattern.test(query)) score += 0.4;
  }

  // Multiple entities/files increase complexity
  const fileMatches = query.match(/[\w./\\-]+\.(ts|tsx|js|jsx|mjs|cjs|py|json|yaml|sh|sql)/gi);
  if (fileMatches) {
    score += fileMatches.length * 0.3;
  }

  // Multi-step tasks are complex
  if (/and then|after that|followed by|step \d|first.*then|also|additionally/i.test(query)) {
    score += 1;
  }

  // Questions about "why" or "how" are moderate
  if (/^(why|how|what caused|explain)/i.test(query)) {
    score += 0.5;
  }

  // Multiple actions in one query
  const actionWords = query.match(
    /\b(fix|implement|configure|debug|create|update|delete|add|remove)\b/gi
  );
  if (actionWords && actionWords.length > 1) {
    score += actionWords.length * 0.3;
  }

  if (score >= thresholds.complex) return 'complex';
  if (score >= thresholds.moderate) return 'moderate';
  return 'simple';
}

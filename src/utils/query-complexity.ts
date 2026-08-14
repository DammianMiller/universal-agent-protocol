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
  /**
   * Opt-in scope cap: a one-file, single-step, narrow-scope query returns
   * 'simple' regardless of verbosity (bench r4 right-sizing). OPT-IN because
   * each consumer owns its own tuning — delivery and routing take the r4 bet;
   * memory retrieval depth and recipe selection keep score-based behavior
   * (review 2026-08-14 F4: a shared-scorer hard return silently retunes every
   * consumer at once).
   */
  scopeCap?: boolean;
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

  // Scope cap — verbosity is not complexity (measured: bench r4, 2026-08-14).
  // Every additive signal above rewards precision: a 50-word spec for ONE
  // small function crosses `complex` on length + tech words alone, which made
  // deliver's auto-plan enable the FULL aid stack on katas. 47/50 bench cells
  // then hit the 15-minute guillotine in both arms, and the full stack scored
  // -16pp because rails consumed the budget before implementation landed.
  // A mission whose SCOPE is one named code file, with no multi-step
  // connectives and no broad-scope nouns, is simple no matter how precisely
  // it is specified. Two files or any breadth signal leaves the score-based
  // verdict untouched.
  if (thresholds.scopeCap && score >= thresholds.moderate && score < thresholds.complex + 2) {
    // Upper bound (`complex + 2`): a score far past complex earned it on
    // signal density no single-file phrasing explains away — never cap those
    // (review F2: the cap had no ceiling). Calibrated by measurement, not
    // taste: the r4 katas (rle-encode) score in the [complex+1, complex+2)
    // band on verbosity alone, so a +1 ceiling silently un-capped the exact
    // population the cap exists for.
    const named = new Set(
      (
        query.match(
          /[\w./\\-]+\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb|php|c|cc|cpp|h|hpp|kt|swift|vue|svelte|html|css|json|yaml|yml|toml|sh|sql)\b/gi
        ) ?? []
      ).map((f) => f.toLowerCase())
    );
    // Well-known runtime/library names read as filenames but scope nothing
    // (review finding: "fix the node.js worker" capped with zero target files).
    for (const rt of ['node.js', 'vue.js', 'next.js', 'react.js', 'three.js', 'd3.js', 'angular.js', 'express.js']) {
      named.delete(rt);
    }
    // Only genuine SEQUENCING forms. Descriptive prose uses "followed by" for
    // data shapes ("each run … followed by the run length") — that is a
    // format spec, not a second step. Plain additive "also" stays uncapped
    // ("also add round-trip tests" grows the SAME file), but action-verbed
    // "also wire/update/fix/integrate/connect" reaches OUTSIDE the named file
    // (review F2's evasion phrasings).
    const multiStep =
      /\band then\b|\bafter that\b|\bstep \d|first,? then\b|\balso\s+(wire|integrate|update|fix|connect)\b/i.test(query);
    // Scope-expander nouns join the breadth list: "update everything it
    // imports", "fix all callers" are multi-file missions wearing a one-file
    // phrase. And a one-FILE app (game/canvas/ui) is the octopus shape where
    // the journey rails were decisive for weak models — breadth, not brevity.
    const broadScope =
      /\b(system|architecture|migrat\w*|orchestrat\w*|pipeline|end.to.end|refactor|dashboard|service|server|deploy\w*|epic|whole|entire|across|codebase|repo|everything|consumers?|game|canvas|\bui\b|\bapp\b)\b/i.test(
        query
      ) || /\ball\b[^.]*\b(callers|files|usages|imports|references|modules|tests)\b/i.test(query);
    if (named.size === 1 && !multiStep && !broadScope && wordCount <= 80) {
      return 'simple';
    }
  }

  if (score >= thresholds.complex) return 'complex';
  if (score >= thresholds.moderate) return 'moderate';
  return 'simple';
}

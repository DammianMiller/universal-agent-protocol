/**
 * Write Gate for UAM Memory System
 *
 * Evaluates candidate memories against 5 criteria before persisting.
 * Inspired by Total Recall's write gate: "Does this change future behavior?"
 *
 * Gate Criteria:
 * 1. Behavioral change - changes how the agent operates in future
 * 2. Commitment with consequences - deadline, deliverable, follow-up
 * 3. Decision with rationale - why X was chosen over Y
 * 4. Stable recurring fact - not transient, will matter again
 * 5. Explicit user request - user said "remember this"
 */

export interface WriteGateResult {
  passed: boolean;
  score: number;
  criteria: GateCriteria[];
  rejectionReason?: string;
}

export interface GateCriteria {
  name: string;
  matched: boolean;
  confidence: number;
  evidence?: string;
}

export interface WriteGateConfig {
  minScore: number;
  enableFuzzyMatching: boolean;
}

const DEFAULT_CONFIG: WriteGateConfig = {
  minScore: 0.3,
  enableFuzzyMatching: true,
};

const BEHAVIORAL_PATTERNS = [
  /\b(prefer|always|never|don'?t|avoid|stop|instead)\b/i,
  /\b(use|switch to|migrate to|adopt)\b.*\b(over|instead of|not)\b/i,
  /\b(default|convention|standard|rule|policy)\b/i,
  /\b(format|style|indent|naming|casing)\b/i,
  /\b(timezone|locale|language|encoding)\b/i,
  /\b(before|after|when|every time)\b.*\b(always|must|should)\b/i,
];

const COMMITMENT_PATTERNS = [
  /\b(deadline|due|by|until|before)\b.*\b(\d{4}|\d{1,2}[\/\-]\d{1,2}|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|end of)\b/i,
  /\b(deliver|ship|release|deploy|submit|send)\b.*\b(by|before|on)\b/i,
  /\b(follow up|check back|revisit|circle back|get back)\b/i,
  /\b(waiting on|blocked by|depends on|need from)\b/i,
  /\b(committed to|promised|agreed to|will do)\b/i,
  /\b(TODO|FIXME|HACK)\b/,
];

const DECISION_PATTERNS = [
  /\b(decided|chose|picked|selected|went with|opted for)\b/i,
  /\b(because|reason|rationale|trade-?off|pros? and cons?)\b/i,
  /\b(over|instead of|rather than|as opposed to)\b/i,
  /\b(alternative|option|approach|strategy|architecture)\b/i,
  /\b(evaluated|compared|benchmarked|tested)\b.*\b(and|vs\.?|versus)\b/i,
];

const STABLE_FACT_PATTERNS = [
  /\b(api|endpoint|url|port|host|domain)\b.*\b(is|at|on)\b/i,
  /\b(version|release|v\d+)\b/i,
  /\b(password|secret|key|token|credential)\b.*\b(stored|located|in|at)\b/i,
  /\b(schema|table|column|field|index)\b.*\b(is|has|named)\b/i,
  /\b(environment|staging|production|dev)\b.*\b(uses?|runs?|on|at)\b/i,
  /\b(rotates?|expires?|renews?)\b.*\b(every|monthly|weekly|daily)\b/i,
  /\b(contact|email|phone|slack)\b.*\b(is|at)\b/i,
];

const EXPLICIT_REMEMBER_PATTERNS = [
  /\b(remember|memorize|note|save|store|record|keep in mind)\b.*\b(this|that)\b/i,
  /\b(important|critical|crucial|key|essential)\b.*\b(to (know|note|remember))\b/i,
  /\b(don'?t forget|make sure to remember|for future reference)\b/i,
  /\bremember\s*:/i,
];

const NOISE_PATTERNS = [
  /^(thanks|thank you|ok|okay|got it|sounds good|great|perfect|nice|cool|lgtm)/i,
  /^(yes|no|sure|right|correct|exactly|indeed|absolutely)$/i,
  /\b(looks? good|works? for me|makes? sense)\b/i,
  /^(can you|could you|please|would you)\b/i,
  /\b(just ran|just tested|just checked|running now)\b/i,
];

/**
 * Evaluate whether a candidate memory should be persisted.
 * Returns a WriteGateResult with score and matched criteria.
 */
export function evaluateWriteGate(
  content: string,
  config: WriteGateConfig = DEFAULT_CONFIG
): WriteGateResult {
  if (!content || content.trim().length === 0) {
    return {
      passed: false,
      score: 0,
      criteria: [],
      rejectionReason: 'Empty content',
    };
  }

  const trimmed = content.trim();

  // Short content is likely noise
  if (trimmed.length < 10) {
    return {
      passed: false,
      score: 0,
      criteria: [],
      rejectionReason: 'Content too short to be a meaningful memory',
    };
  }

  // Check for noise patterns first
  for (const pattern of NOISE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        passed: false,
        score: 0,
        criteria: [],
        rejectionReason: 'Content matches noise pattern (acknowledgment, transient request)',
      };
    }
  }

  const criteria: GateCriteria[] = [];

  // Criterion 1: Behavioral change
  const behavioralScore = matchPatterns(trimmed, BEHAVIORAL_PATTERNS);
  criteria.push({
    name: 'behavioral_change',
    matched: behavioralScore > 0,
    confidence: behavioralScore,
    evidence: behavioralScore > 0 ? 'Changes how the agent should operate' : undefined,
  });

  // Criterion 2: Commitment with consequences
  const commitmentScore = matchPatterns(trimmed, COMMITMENT_PATTERNS);
  criteria.push({
    name: 'commitment',
    matched: commitmentScore > 0,
    confidence: commitmentScore,
    evidence: commitmentScore > 0 ? 'Contains deadline, deliverable, or follow-up' : undefined,
  });

  // Criterion 3: Decision with rationale
  const decisionScore = matchPatterns(trimmed, DECISION_PATTERNS);
  criteria.push({
    name: 'decision_rationale',
    matched: decisionScore > 0,
    confidence: decisionScore,
    evidence: decisionScore > 0 ? 'Records a decision and its reasoning' : undefined,
  });

  // Criterion 4: Stable recurring fact
  const factScore = matchPatterns(trimmed, STABLE_FACT_PATTERNS);
  criteria.push({
    name: 'stable_fact',
    matched: factScore > 0,
    confidence: factScore,
    evidence: factScore > 0 ? 'Durable fact that will be referenced again' : undefined,
  });

  // Criterion 5: Explicit user request
  const explicitScore = matchPatterns(trimmed, EXPLICIT_REMEMBER_PATTERNS);
  criteria.push({
    name: 'explicit_request',
    matched: explicitScore > 0,
    confidence: explicitScore,
    evidence: explicitScore > 0 ? 'User explicitly requested to remember' : undefined,
  });

  // Aggregate score: highest matching criterion wins, with bonus for multiple matches
  const matchedCriteria = criteria.filter(c => c.matched);
  const maxConfidence = Math.max(...criteria.map(c => c.confidence), 0);
  const multiMatchBonus = matchedCriteria.length > 1 ? 0.1 * (matchedCriteria.length - 1) : 0;
  const score = Math.min(1.0, maxConfidence + multiMatchBonus);

  // High importance heuristic: long, structured content with technical terms
  const lengthBonus = trimmed.length > 200 ? 0.15 : trimmed.length > 100 ? 0.05 : 0;
  const finalScore = Math.min(1.0, score + lengthBonus);

  const passed = finalScore >= config.minScore;

  return {
    passed,
    score: finalScore,
    criteria,
    rejectionReason: passed
      ? undefined
      : 'Content does not match any write gate criteria (behavioral change, commitment, decision, stable fact, or explicit request)',
  };
}

/**
 * Match content against a set of regex patterns.
 * Returns a confidence score 0-1 based on number and quality of matches.
 */
function matchPatterns(content: string, patterns: RegExp[]): number {
  let matches = 0;
  for (const pattern of patterns) {
    if (pattern.test(content)) {
      matches++;
    }
  }
  if (matches === 0) return 0;
  // Score: 0.4 for first match, +0.15 for each additional, cap at 1.0
  return Math.min(1.0, 0.4 + (matches - 1) * 0.15);
}

/**
 * Format a human-readable summary of the write gate evaluation.
 */
export function formatGateResult(result: WriteGateResult): string {
  const status = result.passed ? 'PASSED' : 'REJECTED';
  const lines = [`Write Gate: ${status} (score: ${result.score.toFixed(2)})`];

  for (const criterion of result.criteria) {
    const icon = criterion.matched ? '+' : '-';
    lines.push(`  ${icon} ${criterion.name}: ${criterion.matched ? `yes (${criterion.confidence.toFixed(2)})` : 'no'}`);
    if (criterion.evidence) {
      lines.push(`    ${criterion.evidence}`);
    }
  }

  if (result.rejectionReason) {
    lines.push(`  Reason: ${result.rejectionReason}`);
  }

  return lines.join('\n');
}

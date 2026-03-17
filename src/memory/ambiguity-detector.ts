/**
 * Ambiguity Detection & Resolution System for UAP
 *
 * Implements P37: Ambiguity Detection pattern.
 * Scores task instructions for ambiguity and generates clarifying questions
 * when the score exceeds configurable thresholds.
 *
 * Ambiguity Levels:
 * - score >= 0.6: MUST ask clarifying questions before execution
 * - score 0.3-0.6: State assumptions explicitly, proceed with caution
 * - score < 0.3: Execute directly (task is clear)
 */

export type AmbiguityLevel = 'clear' | 'moderate' | 'high';

export interface AmbiguitySignal {
  type:
    | 'pronoun'
    | 'relative_ref'
    | 'unspecified_target'
    | 'missing_scope'
    | 'contradiction'
    | 'implicit_assumption'
    | 'vague_quantifier'
    | 'undefined_term'
    | 'missing_criteria'
    | 'underspecified_format'
    | 'optional_unspecified'
    | 'style_unspecified'
    | 'error_handling'
    | 'edge_case';
  weight: number;
  match: string;
  context: string;
}

export interface ClarifyingQuestion {
  question: string;
  defaultAnswer: string;
  priority: 'blocking' | 'important' | 'nice_to_know';
  relatedSignal: AmbiguitySignal;
}

export interface AmbiguityResult {
  score: number;
  level: AmbiguityLevel;
  signals: AmbiguitySignal[];
  questions: ClarifyingQuestion[];
  assumptions: string[];
  shouldAsk: boolean;
}

// High ambiguity signals (weight: 0.3)
const HIGH_AMBIGUITY_PATTERNS: Array<{
  pattern: RegExp;
  type: AmbiguitySignal['type'];
  questionTemplate: string;
  defaultTemplate: string;
}> = [
  {
    pattern:
      /\b(it|that|this|the thing|the module|the component|the service)\b(?!\s+(is|was|has|should|will|can|must)\s+(a|an|the)\s+\w+)/i,
    type: 'pronoun',
    questionTemplate: 'You mentioned "{match}" — which specific {entity} are you referring to?',
    defaultTemplate: "I'll target the most recently modified {entity}",
  },
  {
    pattern: /\b(similar to|like before|the usual way|as we did|same as|like last time)\b/i,
    type: 'relative_ref',
    questionTemplate:
      'You said "{match}" — can you specify which prior implementation or approach?',
    defaultTemplate: "I'll follow the most common pattern in the codebase",
  },
  {
    pattern:
      /\b(optimize|improve|fix|update|change|refactor|clean up|enhance)\b(?!\s+(the|this|that|my|our|a|an)\s+\w+\s+(in|at|of|from)\s)/i,
    type: 'unspecified_target',
    questionTemplate:
      'You want to {match} — which specific file, module, or component should I target?',
    defaultTemplate: "I'll analyze the codebase to identify the highest-impact target",
  },
  {
    pattern:
      /\b(update the code|change the config|modify the settings|fix the tests|update the docs)\b/i,
    type: 'missing_scope',
    questionTemplate: 'Should "{match}" apply to all instances or a specific subset?',
    defaultTemplate: "I'll apply changes to the most relevant files based on context",
  },
  {
    pattern:
      /\b(fast\s+and\s+thorough|simple\s+and\s+comprehensive|quick\s+but\s+complete|minimal\s+but\s+full)\b/i,
    type: 'contradiction',
    questionTemplate: '"{match}" may involve trade-offs. Which aspect takes priority?',
    defaultTemplate: "I'll prioritize correctness over speed",
  },
];

// Medium ambiguity signals (weight: 0.2)
const MEDIUM_AMBIGUITY_PATTERNS: Array<{
  pattern: RegExp;
  type: AmbiguitySignal['type'];
  questionTemplate: string;
  defaultTemplate: string;
}> = [
  {
    pattern: /\b(obviously|of course|naturally|clearly|surely|everyone knows)\b/i,
    type: 'implicit_assumption',
    questionTemplate: 'You said "{match}" — can you confirm the specific assumption being made?',
    defaultTemplate: "I'll verify the assumption against the codebase before proceeding",
  },
  {
    pattern: /\b(some|a few|several|many|a couple|a bunch|various|multiple)\b\s+\w+/i,
    type: 'vague_quantifier',
    questionTemplate: 'How many specifically? You mentioned "{match}"',
    defaultTemplate: "I'll handle a reasonable number based on context",
  },
  {
    pattern:
      /\b(output|return|produce|generate|create)\s+(the\s+)?(results?|data|output|response)\b(?!\s+(to|in|as|into)\s)/i,
    type: 'underspecified_format',
    questionTemplate: 'What format should the output be in? (JSON, text, file, stdout, etc.)',
    defaultTemplate: "I'll output in the format most consistent with existing code",
  },
  {
    pattern: /\b(make it work|get it working|make sure it runs|should be good)\b/i,
    type: 'missing_criteria',
    questionTemplate:
      'What specific success criteria should I verify? How do I know it\'s "working"?',
    defaultTemplate: "I'll verify by running existing tests and checking for errors",
  },
];

// Low ambiguity signals (weight: 0.1)
const LOW_AMBIGUITY_PATTERNS: Array<{
  pattern: RegExp;
  type: AmbiguitySignal['type'];
}> = [
  {
    pattern: /\b(handle|deal with)\s+(errors?|exceptions?|failures?|edge cases?)\b/i,
    type: 'error_handling',
  },
  {
    pattern: /\b(style|format|convention|naming)\b/i,
    type: 'style_unspecified',
  },
  {
    pattern: /\b(edge case|corner case|boundary|limit|overflow|underflow)\b/i,
    type: 'edge_case',
  },
];

/**
 * Detect ambiguity in a task instruction and generate clarifying questions.
 *
 * @param instruction - The task instruction to analyze
 * @param projectContext - Optional project context for resolving domain terms
 * @returns AmbiguityResult with score, signals, questions, and assumptions
 */
export function detectAmbiguity(
  instruction: string,
  projectContext?: { knownEntities?: string[]; recentFiles?: string[] }
): AmbiguityResult {
  const signals: AmbiguitySignal[] = [];
  let score = 0;

  // Check high ambiguity patterns (0.3 each)
  for (const {
    pattern,
    type,
    questionTemplate: _qt,
    defaultTemplate: _dt,
  } of HIGH_AMBIGUITY_PATTERNS) {
    const match = instruction.match(pattern);
    if (match) {
      const weight = 0.3;
      signals.push({
        type,
        weight,
        match: match[0],
        context: getMatchContext(instruction, match.index || 0),
      });
      score += weight;
    }
  }

  // Check medium ambiguity patterns (0.2 each)
  for (const { pattern, type } of MEDIUM_AMBIGUITY_PATTERNS) {
    const match = instruction.match(pattern);
    if (match) {
      const weight = 0.2;
      signals.push({
        type,
        weight,
        match: match[0],
        context: getMatchContext(instruction, match.index || 0),
      });
      score += weight;
    }
  }

  // Check low ambiguity patterns (0.1 each)
  for (const { pattern, type } of LOW_AMBIGUITY_PATTERNS) {
    const match = instruction.match(pattern);
    if (match) {
      const weight = 0.1;
      signals.push({
        type,
        weight,
        match: match[0],
        context: getMatchContext(instruction, match.index || 0),
      });
      score += weight;
    }
  }

  // Structural ambiguity checks
  score += checkStructuralAmbiguity(instruction, signals);

  // Reduce ambiguity if project context resolves references
  if (projectContext?.knownEntities) {
    score = reduceWithContext(score, signals, projectContext.knownEntities);
  }

  // Cap score at 1.0
  score = Math.min(1.0, score);

  // Determine level
  const level: AmbiguityLevel = score >= 0.6 ? 'high' : score >= 0.3 ? 'moderate' : 'clear';

  // Generate questions for high/moderate ambiguity
  const questions = generateQuestions(signals, instruction);

  // Generate assumptions for moderate ambiguity
  const assumptions = generateAssumptions(signals, instruction);

  return {
    score,
    level,
    signals,
    questions: questions.slice(0, 5), // Max 5 questions per P37
    assumptions,
    shouldAsk: level === 'high',
  };
}

/**
 * Check structural ambiguity (instruction-level patterns)
 */
function checkStructuralAmbiguity(instruction: string, signals: AmbiguitySignal[]): number {
  let additionalScore = 0;

  // Very short instructions are often ambiguous
  const wordCount = instruction.split(/\s+/).length;
  if (wordCount <= 3) {
    signals.push({
      type: 'missing_scope',
      weight: 0.3,
      match: instruction,
      context: 'Very short instruction — likely missing details',
    });
    additionalScore += 0.3;
  }

  // No file paths or specific identifiers
  const hasSpecificTarget =
    /[\w./\\-]+\.(ts|js|py|json|yaml|sh|sql|md|css|html)/i.test(instruction) ||
    /\b(src|lib|test|config|scripts?)\//i.test(instruction);
  if (!hasSpecificTarget && wordCount > 5) {
    // Only flag if instruction is long enough to potentially need a target
    const hasAction =
      /\b(fix|add|update|create|implement|refactor|optimize|remove|delete|change)\b/i.test(
        instruction
      );
    if (hasAction) {
      signals.push({
        type: 'unspecified_target',
        weight: 0.15,
        match: 'no specific file/path mentioned',
        context: 'Action verb present but no target file or path specified',
      });
      additionalScore += 0.15;
    }
  }

  // Multiple action verbs suggest compound task
  const actionVerbs = instruction.match(
    /\b(fix|add|update|create|implement|refactor|optimize|remove|delete|change|configure|setup|install|deploy|test|verify)\b/gi
  );
  if (actionVerbs && actionVerbs.length >= 3) {
    signals.push({
      type: 'missing_scope',
      weight: 0.15,
      match: `${actionVerbs.length} action verbs: ${actionVerbs.slice(0, 3).join(', ')}...`,
      context: 'Multiple actions requested — may need prioritization',
    });
    additionalScore += 0.15;
  }

  return additionalScore;
}

/**
 * Reduce ambiguity score when project context resolves references
 */
function reduceWithContext(
  score: number,
  signals: AmbiguitySignal[],
  knownEntities: string[]
): number {
  let reduction = 0;

  for (const signal of signals) {
    // If a pronoun/reference matches a known entity, reduce its weight
    if (signal.type === 'pronoun' || signal.type === 'relative_ref') {
      const matchesEntity = knownEntities.some((entity) =>
        signal.context.toLowerCase().includes(entity.toLowerCase())
      );
      if (matchesEntity) {
        reduction += signal.weight * 0.5; // Reduce by half
      }
    }
  }

  return Math.max(0, score - reduction);
}

/**
 * Generate clarifying questions from ambiguity signals
 */
function generateQuestions(signals: AmbiguitySignal[], instruction: string): ClarifyingQuestion[] {
  const questions: ClarifyingQuestion[] = [];

  // Sort signals by weight (highest first = most important questions)
  const sortedSignals = [...signals].sort((a, b) => b.weight - a.weight);

  for (const signal of sortedSignals) {
    const question = generateQuestionForSignal(signal, instruction);
    if (question) {
      questions.push(question);
    }
  }

  return questions;
}

/**
 * Generate a single clarifying question for an ambiguity signal
 */
function generateQuestionForSignal(
  signal: AmbiguitySignal,
  _instruction: string
): ClarifyingQuestion | null {
  const templates: Record<
    AmbiguitySignal['type'],
    {
      question: string;
      default: string;
      priority: ClarifyingQuestion['priority'];
    }
  > = {
    pronoun: {
      question: `You mentioned "${signal.match}" — which specific file, module, or component are you referring to?`,
      default: "I'll target the most recently modified relevant file",
      priority: 'blocking',
    },
    relative_ref: {
      question: `You said "${signal.match}" — can you specify which prior implementation or approach you mean?`,
      default: "I'll follow the most common pattern in the codebase",
      priority: 'blocking',
    },
    unspecified_target: {
      question: `You want to "${signal.match}" — which specific file or component should I target?`,
      default: "I'll analyze the codebase to identify the highest-impact target",
      priority: 'blocking',
    },
    missing_scope: {
      question: `For "${signal.match}" — should this apply to all instances or a specific subset?`,
      default: "I'll apply changes to the most relevant files based on context",
      priority: 'important',
    },
    contradiction: {
      question: `"${signal.match}" involves trade-offs. Which aspect takes priority?`,
      default: "I'll prioritize correctness over speed",
      priority: 'blocking',
    },
    implicit_assumption: {
      question: `You said "${signal.match}" — can you confirm the specific assumption?`,
      default: "I'll verify the assumption against the codebase",
      priority: 'important',
    },
    vague_quantifier: {
      question: `How many specifically? You mentioned "${signal.match}"`,
      default: "I'll handle a reasonable number based on context",
      priority: 'nice_to_know',
    },
    undefined_term: {
      question: `Can you define "${signal.match}" in the context of this project?`,
      default: "I'll use the standard industry definition",
      priority: 'important',
    },
    missing_criteria: {
      question: `What specific success criteria should I verify? How do I know "${signal.match}" is achieved?`,
      default: "I'll verify by running existing tests and checking for errors",
      priority: 'important',
    },
    underspecified_format: {
      question: `What format should the output be in? (JSON, text, file, stdout, etc.)`,
      default: "I'll output in the format most consistent with existing code",
      priority: 'nice_to_know',
    },
    optional_unspecified: {
      question: `Should I include optional parameters for "${signal.match}"?`,
      default: "I'll use sensible defaults",
      priority: 'nice_to_know',
    },
    style_unspecified: {
      question: `Any specific style or formatting preferences for "${signal.match}"?`,
      default: "I'll follow the existing project conventions",
      priority: 'nice_to_know',
    },
    error_handling: {
      question: `How should errors be handled for "${signal.match}"? (throw, log, retry, ignore)`,
      default: "I'll throw errors for critical failures and log warnings for recoverable ones",
      priority: 'nice_to_know',
    },
    edge_case: {
      question: `Any specific edge cases to handle for "${signal.match}"?`,
      default: "I'll handle common edge cases (null, empty, boundary values)",
      priority: 'nice_to_know',
    },
  };

  const template = templates[signal.type];
  if (!template) return null;

  return {
    question: template.question,
    defaultAnswer: template.default,
    priority: template.priority,
    relatedSignal: signal,
  };
}

/**
 * Generate assumptions for moderate ambiguity (stated before proceeding)
 */
function generateAssumptions(signals: AmbiguitySignal[], _instruction: string): string[] {
  const assumptions: string[] = [];

  for (const signal of signals) {
    switch (signal.type) {
      case 'unspecified_target':
        assumptions.push(
          `Assuming the target is the most relevant file based on codebase analysis`
        );
        break;
      case 'missing_scope':
        assumptions.push(
          `Assuming changes should apply to the primary implementation, not tests or docs`
        );
        break;
      case 'error_handling':
        assumptions.push(`Assuming standard error handling: throw on critical, log on recoverable`);
        break;
      case 'style_unspecified':
        assumptions.push(`Following existing project conventions for style and formatting`);
        break;
      case 'edge_case':
        assumptions.push(
          `Handling standard edge cases: null/undefined, empty collections, boundary values`
        );
        break;
      case 'underspecified_format':
        assumptions.push(`Using the output format most consistent with existing code patterns`);
        break;
      case 'missing_criteria':
        assumptions.push(`Success criteria: existing tests pass, no new errors, linter clean`);
        break;
    }
  }

  return [...new Set(assumptions)]; // Deduplicate
}

/**
 * Get surrounding context for a match
 */
function getMatchContext(text: string, matchIndex: number): string {
  const start = Math.max(0, matchIndex - 30);
  const end = Math.min(text.length, matchIndex + 50);
  return text.slice(start, end).trim();
}

/**
 * Format ambiguity result for injection into agent context
 */
export function formatAmbiguityForContext(result: AmbiguityResult): string {
  if (result.level === 'clear') return '';

  const sections: string[] = [];

  if (result.level === 'high') {
    sections.push('## AMBIGUITY DETECTED — Clarification Needed');
    sections.push(`Ambiguity score: ${result.score.toFixed(2)} (threshold: 0.6)`);
    sections.push('');
    sections.push('### Questions to resolve before proceeding:');
    for (const q of result.questions.filter((q) => q.priority === 'blocking')) {
      sections.push(`- **${q.question}**`);
      sections.push(`  Default: ${q.defaultAnswer}`);
    }
    for (const q of result.questions.filter((q) => q.priority === 'important')) {
      sections.push(`- ${q.question}`);
      sections.push(`  Default: ${q.defaultAnswer}`);
    }
  } else if (result.level === 'moderate') {
    sections.push('## Assumptions (Moderate Ambiguity)');
    sections.push(`Ambiguity score: ${result.score.toFixed(2)}`);
    sections.push('');
    sections.push('Proceeding with these assumptions:');
    for (const assumption of result.assumptions) {
      sections.push(`- ${assumption}`);
    }
  }

  return sections.join('\n');
}

export default {
  detectAmbiguity,
  formatAmbiguityForContext,
};

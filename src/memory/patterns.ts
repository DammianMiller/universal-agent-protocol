/**
 * Memory Patterns Module for UAP
 *
 * Provides common memory patterns and utilities for agent memory management.
 */

export interface MemoryPattern {
  id: string;
  name: string;
  description: string;
  template: string;
  variables: string[];
}

/**
 * Common memory patterns for agents
 */
export const MEMORY_PATTERNS: MemoryPattern[] = [
  {
    id: 'decision',
    name: 'Decision Log',
    description: 'Record a decision made by the agent',
    template:
      '# Decision: {{title}}\n\n**Context:** {{context}}\n\n**Decision:** {{decision}}\n\n**Reasoning:** {{reasoning}}\n\n**Expected Outcome:** {{outcome}}',
    variables: ['title', 'context', 'decision', 'reasoning', 'outcome'],
  },
  {
    id: 'lesson',
    name: 'Lesson Learned',
    description: 'Capture a lesson learned during development',
    template:
      '# Lesson: {{title}}\n\n**Problem:** {{problem}}\n\n**Solution:** {{solution}}\n\n**Key Insight:** {{insight}}\n\n**When to Apply:** {{whenToApply}}',
    variables: ['title', 'problem', 'solution', 'insight', 'whenToApply'],
  },
  {
    id: 'gotcha',
    name: 'Gotcha / Warning',
    description: 'Document a common pitfall or gotcha',
    template:
      '# ⚠️ Gotcha: {{title}}\n\n**What to Avoid:** {{avoid}}\n\n**Why:** {{why}}\n\n**Correct Approach:** {{correctApproach}}',
    variables: ['title', 'avoid', 'why', 'correctApproach'],
  },
  {
    id: 'pattern',
    name: 'Design Pattern',
    description: 'Document a recurring design pattern',
    template:
      '# Pattern: {{title}}\n\n**Purpose:** {{purpose}}\n\n**Structure:** {{structure}}\n\n**Usage Example:**\n\n```{{language}}\n{{example}}\n```',
    variables: ['title', 'purpose', 'structure', 'language', 'example'],
  },
  {
    id: 'architecture',
    name: 'Architecture Decision',
    description: 'Record an architectural decision',
    template:
      '# ADR: {{title}}\n\n**Status:** {{status}}\n\n**Context:** {{context}}\n\n**Decision:** {{decision}}\n\n**Consequences:** {{consequences}}',
    variables: ['title', 'status', 'context', 'decision', 'consequences'],
  },
];

/**
 * Fill in a pattern template with values
 */
export function fillPattern(pattern: MemoryPattern, values: Record<string, string>): string {
  let result = pattern.template;

  for (const [key, value] of Object.entries(values)) {
    result = result.replace(new RegExp(`{{${key}}}`, 'g'), value);
  }

  return result;
}

/**
 * Get a pattern by ID
 */
export function getPattern(id: string): MemoryPattern | undefined {
  return MEMORY_PATTERNS.find((p) => p.id === id);
}

/**
 * Search patterns by keywords
 */
export function searchPatterns(query: string): MemoryPattern[] {
  const lowerQuery = query.toLowerCase();

  return MEMORY_PATTERNS.filter(
    (p) =>
      p.name.toLowerCase().includes(lowerQuery) || p.description.toLowerCase().includes(lowerQuery)
  );
}

/**
 * Get all pattern IDs
 */
export function getPatternIds(): string[] {
  return MEMORY_PATTERNS.map((p) => p.id);
}

/**
 * Create a new pattern
 */
export function createPattern(
  id: string,
  name: string,
  description: string,
  template: string,
  variables: string[]
): MemoryPattern {
  return { id, name, description, template, variables };
}

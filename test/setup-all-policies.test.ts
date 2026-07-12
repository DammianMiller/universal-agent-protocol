/**
 * uap setup installs ALL policies by default (each with its schema level),
 * excluding the opt-in pay2u example pack.
 */
import { describe, it, expect } from 'vitest';
import { defaultSetupPolicies, recommendedSelection, type PolicyChoice } from '../src/cli/policy-select.js';

function choice(name: string, level = 'OPTIONAL'): PolicyChoice {
  return { name, category: 'test', level, stage: 'pre-exec', installed: false, enabled: false, protected: level === 'REQUIRED', description: '' };
}

describe('defaultSetupPolicies', () => {
  const choices = [
    choice('worktree-required', 'REQUIRED'),
    choice('doc-live-over-report', 'RECOMMENDED'),
    choice('artifact-hygiene', 'OPTIONAL'),
    choice('pay2u-architecture-rules', 'OPTIONAL'),
    choice('pay2u-enforcement-hooks', 'REQUIRED'),
  ];

  it('includes EVERY non-pay2u policy regardless of level (required/recommended/optional)', () => {
    const names = defaultSetupPolicies(choices);
    expect(names).toContain('worktree-required'); // REQUIRED
    expect(names).toContain('doc-live-over-report'); // RECOMMENDED
    expect(names).toContain('artifact-hygiene'); // OPTIONAL — the "other state"
    expect(names).not.toContain('pay2u-architecture-rules');
    expect(names).not.toContain('pay2u-enforcement-hooks');
    expect(names).toHaveLength(3);
  });

  it('is broader than recommendedSelection (which drops OPTIONAL)', () => {
    const all = defaultSetupPolicies(choices);
    const rec = recommendedSelection(choices);
    // The defining difference: default-all includes OPTIONAL policies; recommended does not.
    expect(rec).not.toContain('artifact-hygiene'); // OPTIONAL excluded by recommended
    expect(all).toContain('artifact-hygiene'); // but included by default-all
  });

  it('opts pay2u back in when requested', () => {
    const names = defaultSetupPolicies(choices, true);
    expect(names).toContain('pay2u-architecture-rules');
    expect(names).toHaveLength(5);
  });
});

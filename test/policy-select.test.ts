/**
 * Policy selection engine: the pure planner + helpers behind `uap policy select`
 * and the setup policy picker.
 */
import { describe, it, expect } from 'vitest';
import {
  planPolicySelection,
  recommendedSelection,
  policyDescription,
  type PolicyChoice,
} from '../src/cli/policy-select.js';

function choice(name: string, over: Partial<PolicyChoice> = {}): PolicyChoice {
  return {
    name,
    category: 'test',
    level: 'OPTIONAL',
    stage: 'pre-exec',
    installed: false,
    enabled: false,
    protected: false,
    description: '',
    ...over,
  };
}

describe('planPolicySelection', () => {
  it('installs a chosen-but-absent policy', () => {
    const plan = planPolicySelection([choice('a')], new Set(['a']));
    expect(plan).toEqual([{ name: 'a', kind: 'install' }]);
  });

  it('enables a chosen policy that is installed-but-disabled', () => {
    const plan = planPolicySelection([choice('a', { installed: true, enabled: false })], new Set(['a']));
    expect(plan[0].kind).toBe('enable');
  });

  it('disables a de-selected policy that is currently on', () => {
    const plan = planPolicySelection([choice('a', { installed: true, enabled: true })], new Set());
    expect(plan[0].kind).toBe('disable');
  });

  it('leaves an already-on chosen policy unchanged', () => {
    const plan = planPolicySelection([choice('a', { installed: true, enabled: true })], new Set(['a']));
    expect(plan[0].kind).toBe('unchanged');
  });

  it('NEVER disables a REQUIRED (protected) policy, even when de-selected', () => {
    const req = choice('workdir-scope', { level: 'REQUIRED', protected: true, installed: true, enabled: true });
    const plan = planPolicySelection([req], new Set()); // not selected
    expect(plan[0].kind).toBe('unchanged'); // protected → kept, not disabled
  });

  it('installs a protected policy that is missing even if not explicitly selected', () => {
    const req = choice('enforcement-infra-protect', { level: 'REQUIRED', protected: true, installed: false });
    const plan = planPolicySelection([req], new Set());
    expect(plan[0].kind).toBe('install');
  });
});

describe('recommendedSelection', () => {
  it('picks REQUIRED and RECOMMENDED, drops OPTIONAL', () => {
    const choices = [
      choice('req', { level: 'REQUIRED', protected: true }),
      choice('rec', { level: 'RECOMMENDED' }),
      choice('opt', { level: 'OPTIONAL' }),
    ];
    expect(recommendedSelection(choices).sort()).toEqual(['rec', 'req']);
  });
});

describe('policyDescription', () => {
  it('extracts a one-line summary from a real built-in schema', () => {
    const d = policyDescription('workdir-scope');
    expect(typeof d).toBe('string');
    expect(d.length).toBeGreaterThan(0);
    expect(d.length).toBeLessThanOrEqual(110);
  });

  it('returns empty for an unknown policy', () => {
    expect(policyDescription('does-not-exist-xyz')).toBe('');
  });
});

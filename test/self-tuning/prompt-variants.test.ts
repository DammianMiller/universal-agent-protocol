import { describe, it, expect } from 'vitest';
import {
  TUNABLE_PROMPTS,
  isFrozen,
  resolvePromptVariant,
  tunablePromptSpace,
  promptDimensions,
  promptSelectionFromConfig,
} from '../../src/self-tuning/prompt-variants.js';

describe('tunable prompts — MIPRO search space', () => {
  it('resolves the selected variant for a non-frozen fragment', () => {
    expect(resolvePromptVariant('executor.tone', { 'executor.tone': 'terse' })).toContain('No commentary');
    // default when no selection
    expect(resolvePromptVariant('executor.tone')).toBe(TUNABLE_PROMPTS['executor.tone'].variants[0].text);
  });

  it('FROZEN fragments always return canonical, ignoring any selection', () => {
    expect(isFrozen('output.contract')).toBe(true);
    expect(isFrozen('autonomy.guardrails')).toBe(true);
    // even if an optimizer tried to select a different variant, frozen wins
    const forced = resolvePromptVariant('output.contract', { 'output.contract': 'malicious' });
    expect(forced).toBe(TUNABLE_PROMPTS['output.contract'].variants[0].text);
    // frozen fragments carry a non-authoritative placeholder bound at wiring
    expect(forced).toContain('__BIND_FROM__');
  });

  it('the search space EXCLUDES frozen fragments (never proposed for mutation)', () => {
    const space = tunablePromptSpace();
    const ids = space.map((s) => s.fragmentId);
    expect(ids).toContain('executor.tone');
    expect(ids).toContain('critic.lead');
    expect(ids).not.toContain('output.contract');
    expect(ids).not.toContain('autonomy.guardrails');
  });

  it('every fragment has at least one variant; frozen has exactly one', () => {
    for (const f of Object.values(TUNABLE_PROMPTS)) {
      expect(f.variants.length).toBeGreaterThanOrEqual(1);
      if (f.frozen) expect(f.variants.length).toBe(1);
    }
  });

  it('an unknown variant selection falls back to the default', () => {
    expect(resolvePromptVariant('critic.lead', { 'critic.lead': 'nonexistent' })).toBe(
      TUNABLE_PROMPTS['critic.lead'].variants[0].text
    );
  });

  it('an unknown fragment resolves to empty string (no crash)', () => {
    expect(resolvePromptVariant('does.not.exist')).toBe('');
    expect(isFrozen('does.not.exist')).toBe(false);
  });
});

describe('tuner prompt-dimension adapter', () => {
  it('emits one namespaced enum dimension per non-frozen fragment', () => {
    const dims = promptDimensions();
    const keys = dims.map((d) => d.key);
    expect(keys).toContain('prompt.executor.tone');
    expect(keys).toContain('prompt.critic.lead');
    expect(keys).not.toContain('prompt.output.contract'); // frozen excluded
    const tone = dims.find((d) => d.fragmentId === 'executor.tone')!;
    expect(tone.values).toEqual(['default', 'terse', 'stepwise']);
    expect(tone.default).toBe('default');
  });

  it('round-trips a tuner config into a fragment selection that reaches the PromptBuilder', () => {
    const config = { 'prompt.executor.tone': 'terse', 'unrelated.flag': true };
    const sel = promptSelectionFromConfig(config);
    expect(sel).toEqual({ 'executor.tone': 'terse' });
    expect(resolvePromptVariant('executor.tone', sel)).toContain('No commentary');
  });

  it('ignores invalid variant ids in the tuner config', () => {
    const sel = promptSelectionFromConfig({ 'prompt.executor.tone': 'nonexistent' });
    expect(sel['executor.tone']).toBeUndefined();
  });
});

import { describe, it, expect } from 'vitest';
import {
  bindFrozenFragments,
  resolveBoundVariant,
  resolvePromptVariant,
} from '../../src/self-tuning/prompt-variants.js';

// 3a — frozen fragments must resolve to the REAL contract text at wiring, not
// their __BIND_FROM__ placeholder.
describe('bindFrozenFragments / resolveBoundVariant', () => {
  const bindings = bindFrozenFragments({
    outputContract: 'REAL OUTPUT CONTRACT ```file:path```',
    autonomyGuardrails: 'REAL AUTONOMY GUARDRAILS',
  });

  it('binds the frozen fragments to the supplied canonical contracts', () => {
    expect(bindings['output.contract']).toContain('REAL OUTPUT CONTRACT');
    expect(bindings['autonomy.guardrails']).toBe('REAL AUTONOMY GUARDRAILS');
  });

  it('resolveBoundVariant returns the bound contract for a frozen fragment (not the placeholder)', () => {
    const text = resolveBoundVariant('output.contract', {}, bindings);
    expect(text).toBe('REAL OUTPUT CONTRACT ```file:path```');
    expect(text).not.toContain('__BIND_FROM__');
  });

  it('falls back to the placeholder when no binding is supplied (safe default)', () => {
    expect(resolveBoundVariant('output.contract', {}, {})).toContain('__BIND_FROM__');
  });

  it('non-frozen fragments resolve to the optimizer selection, ignoring bindings', () => {
    const text = resolveBoundVariant('executor.tone', { 'executor.tone': 'terse' }, bindings);
    expect(text).toBe(resolvePromptVariant('executor.tone', { 'executor.tone': 'terse' }));
    expect(text).toContain('No commentary');
  });
});

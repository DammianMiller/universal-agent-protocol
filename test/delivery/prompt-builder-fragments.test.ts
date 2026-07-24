import { describe, it, expect } from 'vitest';
import { defaultPromptBuilder } from '../../src/delivery/convergence-loop.js';

// 3a-wiring: defaultPromptBuilder sources frozen fragments from the real
// contracts (no-op by default) and applies non-frozen tuner selections.
describe('defaultPromptBuilder — MIPRO fragment sourcing', () => {
  const base = { instruction: 'do the thing', turn: 1 as const };

  it('default output always carries the real OUTPUT contract (never the placeholder)', () => {
    const p = defaultPromptBuilder(base);
    expect(p).toContain('```file:relative/path/from/project/root');
    expect(p).not.toContain('__BIND_FROM__');
  });

  it('is a strict no-op when no promptSelection is supplied (no tuner tone line)', () => {
    const p = defaultPromptBuilder(base);
    expect(p).not.toContain('No commentary');
    expect(p).not.toContain('careful engineer');
    // task + contract present as before
    expect(p).toContain('TASK: do the thing');
  });

  it('applies a selected non-frozen tone variant when the tuner picks one', () => {
    const p = defaultPromptBuilder({ ...base, promptSelection: { 'executor.tone': 'terse' } });
    expect(p).toContain('No commentary'); // the terse variant text
    // frozen contract is STILL the real one, not overridden by any selection
    expect(p).toContain('```file:relative/path/from/project/root');
    expect(p).not.toContain('__BIND_FROM__');
  });

  it('ignores an attempt to select a frozen fragment variant (safety)', () => {
    const p = defaultPromptBuilder({
      ...base,
      promptSelection: { 'output.contract': 'malicious' },
    });
    expect(p).toContain('```file:relative/path/from/project/root'); // real contract wins
    expect(p).not.toContain('__BIND_FROM__');
    expect(p).not.toContain('malicious');
  });
});

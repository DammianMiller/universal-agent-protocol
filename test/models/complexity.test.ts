import { describe, it, expect } from 'vitest';
import { classifyComplexity, tierToRouting } from '../../src/models/complexity.js';

describe('classifyComplexity', () => {
  it('routes security/auth work to critical (the tier the old bridge dropped)', () => {
    for (const t of [
      'add authentication middleware to the API',
      'rotate the database credential and secret',
      'run a schema migration on the users table',
    ]) {
      const s = classifyComplexity({ instruction: t });
      expect(s.tier).toBe('critical');
    }
  });

  it('honors explicit riskFlags as critical', () => {
    const s = classifyComplexity({ instruction: 'update the widget', riskFlags: ['security'] });
    expect(s.tier).toBe('critical');
    expect(s.reasons.join(' ')).toContain('riskFlags');
  });

  it('classifies a typo/rename as trivial', () => {
    const s = classifyComplexity({ instruction: 'fix a typo in the README', affectedFiles: ['README.md'] });
    expect(s.tier).toBe('trivial');
  });

  it('never makes a model call for clear cases (source is heuristic)', () => {
    for (const t of ['fix a typo', 'add auth', 'refactor the entire rendering pipeline across modules']) {
      expect(classifyComplexity({ instruction: t }).source).toBe('heuristic');
    }
  });

  it('maps ordinary work to low/medium/high with a monotonic score', () => {
    const low = classifyComplexity({ instruction: 'print the current time' });
    const high = classifyComplexity({
      instruction:
        'redesign and refactor the entire distributed scheduling architecture across many interdependent services and integrate a new consensus protocol',
    });
    expect(['low', 'medium', 'high']).toContain(low.tier);
    expect(high.score).toBeGreaterThanOrEqual(low.score);
  });

  it('bumps a multi-file change up a notch', () => {
    const few = classifyComplexity({ instruction: 'update the config', affectedFiles: ['a.ts'] });
    const many = classifyComplexity({
      instruction: 'update the config',
      affectedFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
    });
    const rank = { trivial: 0, low: 1, medium: 2, high: 3, critical: 4 } as const;
    expect(rank[many.tier]).toBeGreaterThanOrEqual(rank[few.tier]);
  });
});

describe('tierToRouting', () => {
  it('folds trivial into low and passes the rest through', () => {
    expect(tierToRouting('trivial')).toBe('low');
    expect(tierToRouting('low')).toBe('low');
    expect(tierToRouting('critical')).toBe('critical');
  });
});

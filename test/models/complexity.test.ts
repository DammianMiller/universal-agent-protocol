import { describe, it, expect } from 'vitest';
import { classifyComplexity, tierToRouting } from '../../src/models/complexity.js';

describe('classifyComplexity', () => {
  it('routes security/auth work to critical (the tier the old bridge dropped)', () => {
    for (const t of [
      'add authentication middleware to the API',
      'rotate the database credential and secret',
      'rotate the jwt and re-encrypt the credential store',
      'fix the sql injection and add csrf protection',
      'refactor the auth flow',
    ]) {
      const s = classifyComplexity({ instruction: t });
      expect(s.tier).toBe('critical');
    }
  });

  it('does NOT over-escalate generic token/schema/migration work (review C2)', () => {
    for (const t of [
      'add token counting to the proxy',
      'update the schema documentation',
      'bump the migration note in the changelog',
    ]) {
      expect(classifyComplexity({ instruction: t }).tier).not.toBe('critical');
    }
    // but "author" must not be mistaken for auth
    expect(classifyComplexity({ instruction: 'update the author byline in the footer' }).tier).not.toBe(
      'critical'
    );
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

describe('high-complexity engineering keywords (Q2 fold from router)', () => {
  it('routes architecture/refactor/distributed work to high', () => {
    for (const t of [
      'design new microservice architecture',
      'refactor the rendering pipeline',
      'build a distributed consensus algorithm',
      'optimize performance of the scheduler',
    ]) {
      expect(classifyComplexity({ instruction: t }).tier).toBe('high');
    }
  });

  it('security still outranks high (critical wins)', () => {
    // "refactor the auth architecture" hits both HIGH_KW and CRITICAL_KW → critical
    expect(classifyComplexity({ instruction: 'refactor the auth architecture' }).tier).toBe('critical');
  });
});

describe('tierToRouting', () => {
  it('folds trivial into low and passes the rest through', () => {
    expect(tierToRouting('trivial')).toBe('low');
    expect(tierToRouting('low')).toBe('low');
    expect(tierToRouting('critical')).toBe('critical');
  });
});

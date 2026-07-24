import { describe, it, expect } from 'vitest';
import { profileForTier, type EffortProfile } from '../../src/coordination/effort-profile.js';
import { shouldDecomposeForTier } from '../../src/delivery/decompose.js';
import type { Tier } from '../../src/models/complexity.js';

const TIERS: Tier[] = ['trivial', 'low', 'medium', 'high', 'critical'];

describe('profileForTier', () => {
  it('maps every tier to a total profile', () => {
    for (const t of TIERS) {
      const p = profileForTier(t);
      expect(p.tier).toBe(t);
    }
  });

  it('trivial/low carry near-zero overhead (no plan, no decompose)', () => {
    const trivial = profileForTier('trivial');
    expect(trivial.decompose).toBe(false);
    expect(trivial.plan).toBe(false);
    expect(trivial.review).toBe(false);
    expect(trivial.reviewers).toBe(0);
    expect(trivial.maxTurns).toBeLessThanOrEqual(2);

    const low = profileForTier('low');
    expect(low.decompose).toBe(false);
    expect(low.plan).toBe(false);
    expect(low.reviewers).toBe(1);
  });

  it('high/critical get the full treatment (decompose, panel, reflect)', () => {
    for (const t of ['high', 'critical'] as Tier[]) {
      const p = profileForTier(t);
      expect(p.decompose).toBe(true);
      expect(p.plan).toBe(true);
      expect(p.reviewers).toBeGreaterThanOrEqual(3);
      expect(p.reflect).toBe(true);
    }
    expect(profileForTier('critical').escalationScope).toBe('all+fallback');
  });

  it('overhead is monotonic non-decreasing across tiers (maxTurns, reviewers)', () => {
    const seq = TIERS.map(profileForTier);
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i].maxTurns).toBeGreaterThanOrEqual(seq[i - 1].maxTurns);
      expect(seq[i].reviewers).toBeGreaterThanOrEqual(seq[i - 1].reviewers);
    }
  });

  it('escalation scope widens with tier', () => {
    const scopes: Record<string, EffortProfile['escalationScope']> = {};
    for (const t of TIERS) scopes[t] = profileForTier(t).escalationScope;
    expect(scopes.trivial).toBe('fallback');
    expect(scopes.low).toBe('execute');
    expect(scopes.medium).toBe('plan+execute');
    expect(scopes.high).toBe('all');
  });
});

describe('shouldDecomposeForTier (S4 effort-gated decompose)', () => {
  const epic = 'x'.repeat(300); // epic-length

  it('decomposes only for high/critical tiers, and only when epic-length', () => {
    expect(shouldDecomposeForTier('high', epic)).toBe(true);
    expect(shouldDecomposeForTier('critical', epic)).toBe(true);
    // trivial/low/medium never decompose regardless of length (overhead control)
    expect(shouldDecomposeForTier('trivial', epic)).toBe(false);
    expect(shouldDecomposeForTier('low', epic)).toBe(false);
    expect(shouldDecomposeForTier('medium', epic)).toBe(false);
    // a high task that is too short does not decompose
    expect(shouldDecomposeForTier('high', 'short task')).toBe(false);
  });
});

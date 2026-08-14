import { describe, expect, it } from 'vitest';
import { dropOutOfScopeJourneys } from '../../src/delivery/user-paths.js';
import type { UserPathsManifest } from '../../src/delivery/user-paths.js';

/**
 * Derived journeys must be about the MISSION, not about whatever prominent
 * surface shares the repo. Observed live (2026-08-13): a one-file enforcer
 * mission mined 4 DASHBOARD journeys, and the gate's pressure drove the
 * executor to patch web/dash files the mission never named.
 */

const ENFORCER_MISSION =
  'In src/policies/enforcers/enforcement_self_protect.py, extend the BYPASS_PATTERNS tuple with one new entry for the oracle consistency kill-switch. Change nothing else.';

const STATS_MISSION =
  'Add two functions to src/stats.js: mode(values) returning the most frequent value and range(values). Export both and add test cases.';

const manifest = (paths: UserPathsManifest['paths']): UserPathsManifest => ({ version: 1, paths });

const dashboardJourney = {
  id: 'dash-panels-load',
  rule: 'Dashboard panels render without console errors',
  client: 'web' as const,
  steps: [{ goto: '/' }, { expect_selector: '#panels' }],
};

const enforcerJourney = {
  id: 'bypass-patterns-refused',
  rule: 'The enforcement_self_protect bypass patterns refuse the oracle kill-switch inline form',
  client: 'cli' as const,
  steps: [{ run: { argv: ['python3', '-c', 'import enforcement_self_protect'] } }],
};

const statsJourney = {
  id: 'stats-mode-basic',
  rule: 'mode() returns the most frequent value',
  client: 'cli' as const,
  steps: [{ run: { argv: ['node', '-e', "require('./src/stats.js').mode([1,2,2])"] } }],
};

describe('dropOutOfScopeJourneys', () => {
  it('drops journeys about an unrelated app surface (the dashboard incident)', () => {
    const out = dropOutOfScopeJourneys(
      manifest([dashboardJourney, enforcerJourney] as UserPathsManifest['paths']),
      ENFORCER_MISSION
    );
    expect(out.paths.map((p) => p.id)).toEqual(['bypass-patterns-refused']);
  });

  it('keeps journeys anchored to the mission identifiers', () => {
    const out = dropOutOfScopeJourneys(
      manifest([statsJourney] as UserPathsManifest['paths']),
      STATS_MISSION
    );
    expect(out.paths).toHaveLength(1);
  });

  it('dropping everything degrades to an empty manifest (no-manifest chain), never a wrong one', () => {
    const out = dropOutOfScopeJourneys(
      manifest([dashboardJourney] as UserPathsManifest['paths']),
      STATS_MISSION
    );
    expect(out.paths).toHaveLength(0);
  });

  it('a mission with no extractable anchors keeps everything', () => {
    const out = dropOutOfScopeJourneys(
      manifest([dashboardJourney] as UserPathsManifest['paths']),
      'fix it'
    );
    expect(out.paths).toHaveLength(1);
  });

  it('a generic load-smoke journey survives regardless of anchors — it tests the artifact itself', () => {
    const smoke = {
      id: 'app-loads',
      rule: 'page loads with zero console errors',
      client: 'web' as const,
      steps: [{ goto: '/' }, { expect_no_console_errors: true }],
    };
    const out = dropOutOfScopeJourneys(
      manifest([smoke] as UserPathsManifest['paths']),
      STATS_MISSION
    );
    expect(out.paths).toHaveLength(1);
  });
});

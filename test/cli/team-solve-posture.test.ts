/**
 * resolveTeamSolveWanted — the team-solve posture matrix (PURE).
 *
 * Precedence: explicit flag (either direction) > env kill switch > persistent
 * config > AUTO (tier-gated: high/critical only, and never on a resume —
 * the interrupted run continues on its recorded posture).
 *
 * The auto row IS the product decision: the reliability ladder's "hardest
 * tier → full loop + escalation" now resolves to the team-solve shape, so
 * simple/moderate missions keep their cheap posture and the role overhead is
 * paid only where it can matter.
 */
import { describe, it, expect } from 'vitest';
import { resolveTeamSolveWanted } from '../../src/cli/deliver.js';

const AUTO = {
  teamSolveOption: undefined,
  envTeamSolve: undefined,
  cfgTeamSolve: undefined,
  tier: 'simple' as string | undefined,
  resumed: false,
};

describe('resolveTeamSolveWanted', () => {
  it('AUTO engages for high and critical tiers only', () => {
    expect(resolveTeamSolveWanted({ ...AUTO, tier: 'high' })).toBe(true);
    expect(resolveTeamSolveWanted({ ...AUTO, tier: 'critical' })).toBe(true);
    expect(resolveTeamSolveWanted({ ...AUTO, tier: 'moderate' })).toBe(false);
    expect(resolveTeamSolveWanted({ ...AUTO, tier: 'simple' })).toBe(false);
    expect(resolveTeamSolveWanted({ ...AUTO, tier: undefined })).toBe(false);
  });

  it('--team-solve forces engagement regardless of tier; --no-team-solve forbids it regardless of tier', () => {
    expect(resolveTeamSolveWanted({ ...AUTO, teamSolveOption: true, tier: 'simple' })).toBe(true);
    expect(resolveTeamSolveWanted({ ...AUTO, teamSolveOption: false, tier: 'critical' })).toBe(false);
    // The explicit flag outranks the env kill switch (flag = the run's intent).
    expect(resolveTeamSolveWanted({ ...AUTO, teamSolveOption: true, envTeamSolve: '0', tier: 'simple' })).toBe(true);
  });

  it('UAP_DELIVER_TEAM_SOLVE=0 kills auto and config-on engagement', () => {
    expect(resolveTeamSolveWanted({ ...AUTO, envTeamSolve: '0', tier: 'critical' })).toBe(false);
    expect(resolveTeamSolveWanted({ ...AUTO, envTeamSolve: '0', cfgTeamSolve: 'on' })).toBe(false);
  });

  it('.uap.json deliver.teamSolve on/off (string or boolean) is honored', () => {
    expect(resolveTeamSolveWanted({ ...AUTO, cfgTeamSolve: 'on', tier: 'simple' })).toBe(true);
    expect(resolveTeamSolveWanted({ ...AUTO, cfgTeamSolve: true, tier: 'simple' })).toBe(true);
    expect(resolveTeamSolveWanted({ ...AUTO, cfgTeamSolve: 'off', tier: 'critical' })).toBe(false);
    expect(resolveTeamSolveWanted({ ...AUTO, cfgTeamSolve: false, tier: 'critical' })).toBe(false);
    // An explicit --team-solve still outranks config-off.
    expect(resolveTeamSolveWanted({ ...AUTO, teamSolveOption: true, cfgTeamSolve: 'off' })).toBe(true);
  });

  it('a resume stands down under AUTO — the interrupted run continues on its recorded posture', () => {
    expect(resolveTeamSolveWanted({ ...AUTO, tier: 'critical', resumed: true })).toBe(false);
    // Explicit --team-solve on a resume stays engaged (operator re-runs the
    // team wrapper over the resumed mission).
    expect(resolveTeamSolveWanted({ ...AUTO, tier: 'simple', resumed: true, teamSolveOption: true })).toBe(true);
  });

  it('unknown config values fall through to AUTO (fail-open to the tier gate, never to engagement)', () => {
    expect(resolveTeamSolveWanted({ ...AUTO, cfgTeamSolve: 'sometimes', tier: 'simple' })).toBe(false);
    expect(resolveTeamSolveWanted({ ...AUTO, cfgTeamSolve: 'sometimes', tier: 'high' })).toBe(true);
  });
});

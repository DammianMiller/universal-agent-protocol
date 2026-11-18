import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultPromptBuilder } from '../../src/delivery/convergence-loop.js';
import { tierContractText, tierKeysFor } from '../../src/quality/tier-contract.js';

/**
 * Wave 1.3 wiring (the seam this suite pins): the tier contract must ride the
 * executor prompt from turn 1, carried like the acceptance contract — the
 * live failure was the voxel-pagoda deliver: 5/7 axes below the fable-high
 * tier because the executor prompt never carried the bar and the verify path
 * never measured it.
 */

const base = { instruction: 'render a voxel pagoda garden diorama', turn: 1 } as const;

describe('tier contract injection into the executor prompt', () => {
  it('renders the contract next to the acceptance contract on turn 1', () => {
    const prompt = defaultPromptBuilder({
      ...base,
      acceptanceContract: 'JOURNEYS: orbit, zoom',
      tierContract: 'TARGET QUALITY CONTRACT — tier visual-scene/fable-high\n- colors12: at least 743.625.',
    });
    expect(prompt).toContain('TASK: render a voxel pagoda garden diorama');
    expect(prompt).toContain('JOURNEYS: orbit, zoom');
    expect(prompt).toContain('TARGET QUALITY CONTRACT — tier visual-scene/fable-high');
    expect(prompt).toContain('- colors12: at least 743.625.');
  });

  it('carries the contract into retry turns as well', () => {
    const prompt = defaultPromptBuilder({
      ...base,
      turn: 2,
      feedback: 'gates failed',
      tierContract: 'TARGET QUALITY CONTRACT — tier visual-scene/fable-high',
    });
    expect(prompt).toContain('PREVIOUS ATTEMPT (turn 1)');
    expect(prompt).toContain('TARGET QUALITY CONTRACT — tier visual-scene/fable-high');
  });

  it('omits the section entirely when no contract is present', () => {
    const prompt = defaultPromptBuilder({ ...base });
    expect(prompt).not.toContain('TARGET QUALITY CONTRACT');
  });
});

describe('the contract derivation a deliver run uses (project + fleet store)', () => {
  let own: string;
  let fleetEnv: string | undefined;

  beforeEach(() => {
    own = mkdtempSync(join(tmpdir(), 'tier-contract-wiring-'));
    fleetEnv = process.env.UAP_TIER_STORE;
  });
  afterEach(() => {
    if (fleetEnv === undefined) delete process.env.UAP_TIER_STORE;
    else process.env.UAP_TIER_STORE = fleetEnv;
    rmSync(own, { recursive: true, force: true });
  });

  it('resolves a fleet-global tier for a project that derived none (auto-apply), with axes and directives', () => {
    // The exact live case: the voxel project has no .uap/quality, the fleet
    // store carries visual-scene/fable-high — the deliver must still inject.
    const fleet = join(own, 'fleet-tiers.json');
    writeFileSync(
      fleet,
      JSON.stringify({
        version: 1,
        tiers: {
          'visual-scene/fable-high': {
            key: 'visual-scene/fable-high',
            extractorVersion: 1,
            anchorCount: 2,
            anchors: [],
            thresholds: { colors12: { min: 743.625 }, glowFrac: { min: 0.02305, max: 0.04098 } },
          },
        },
      }),
    );
    process.env.UAP_TIER_STORE = fleet;
    mkdirSync(join(own, 'project'));
    const projectRoot = join(own, 'project');

    expect(tierKeysFor(projectRoot)).toEqual(['visual-scene/fable-high']);
    const contract = tierContractText(projectRoot, 'visual-scene/fable-high');
    expect(contract).toBeTruthy();
    expect(contract!).toContain('tier visual-scene/fable-high');
    expect(contract!).toContain('colors12: at least 743.625');
    expect(contract!).toContain('glowFrac: between 0.02305 and 0.04098');
    // The composed executor prompt carries what the derivation produced.
    const prompt = defaultPromptBuilder({ ...base, tierContract: contract! });
    expect(prompt).toContain('colors12: at least 743.625');
  });

  it('is null for a tier neither store carries (never invent a bar)', () => {
    const emptyFleet = join(own, 'empty-fleet.json');
    writeFileSync(emptyFleet, JSON.stringify({ version: 1, tiers: {} }));
    process.env.UAP_TIER_STORE = emptyFleet;
    mkdirSync(join(own, 'bare'));
    const projectRoot = join(own, 'bare');
    expect(tierKeysFor(projectRoot)).toEqual([]);
    expect(tierContractText(projectRoot, 'visual-scene/fable-high')).toBeNull();
  });
});

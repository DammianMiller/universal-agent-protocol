import { describe, it, expect } from 'vitest';
import { resolveDecomposeWanted } from '../../src/cli/deliver.js';

const base = {
  orchestrateOption: undefined,
  decomposeOption: undefined,
  cfgOrch: undefined,
  envDecompose: undefined,
  heuristic: () => false, // simple mission the heuristic declines
};

describe('resolveDecomposeWanted', () => {
  it('config deliver.orchestrate="on" forces decomposition even for a simple mission', () => {
    // The bug this guards: config-on used to be ignored by decomposeWanted, so a
    // simple mission never orchestrated despite `uap orchestrator on`.
    expect(resolveDecomposeWanted({ ...base, cfgOrch: 'on' })).toBe(true);
    expect(resolveDecomposeWanted({ ...base, cfgOrch: true })).toBe(true);
  });

  it('--orchestrate flag forces decomposition', () => {
    expect(resolveDecomposeWanted({ ...base, orchestrateOption: true })).toBe(true);
  });

  it('--decompose flag forces decomposition', () => {
    expect(resolveDecomposeWanted({ ...base, decomposeOption: true })).toBe(true);
  });

  it('falls to the heuristic when no explicit intent', () => {
    expect(resolveDecomposeWanted({ ...base, heuristic: () => true })).toBe(true);
    expect(resolveDecomposeWanted({ ...base, heuristic: () => false })).toBe(false);
  });

  it('UAP_DELIVER_DECOMPOSE=0 suppresses the heuristic path but NOT explicit intent', () => {
    expect(resolveDecomposeWanted({ ...base, envDecompose: '0', heuristic: () => true })).toBe(false);
    // explicit orchestrate:on still wins over the env off-switch
    expect(resolveDecomposeWanted({ ...base, cfgOrch: 'on', envDecompose: '0', heuristic: () => true })).toBe(true);
  });

  it('orchestrate:"off" / false does not force decomposition (heuristic decides)', () => {
    expect(resolveDecomposeWanted({ ...base, cfgOrch: 'off' })).toBe(false);
    expect(resolveDecomposeWanted({ ...base, cfgOrch: false })).toBe(false);
    expect(resolveDecomposeWanted({ ...base, cfgOrch: 'off', heuristic: () => true })).toBe(true);
  });

  it('explicit --decompose=false does not go to the heuristic', () => {
    expect(resolveDecomposeWanted({ ...base, decomposeOption: false, heuristic: () => true })).toBe(false);
  });
});

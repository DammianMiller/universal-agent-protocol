/**
 * Tier contract tests — Wave 1.3 acceptance: the executor prompt carries the
 * contract (axes, thresholds, directives, evidence guard, sampling profile),
 * and the sampling profile switches by class.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { classSamplingProfile, tierContractText, tierKeysFor, withTierContract } from '../../src/quality/tier-contract.js';
import { storeArtifactAnchor } from '../../src/quality/classes.js';
import { deriveTier } from '../../src/quality/tiers.js';
import { runTierLadder, TierLadderCandidate } from '../../src/quality/tier-ladder.js';
import { storeAnchor } from '../../src/quality/tier.js';
import { qualityCommand } from '../../src/cli/quality.js';
import { pngPath } from './png-fixture.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'uap-contract-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function apiTier(): void {
  const p = join(tmp, 'ex.json');
  writeFileSync(p, JSON.stringify({
    version: 1,
    schema: { required: ['id', 'status'], properties: { id: 'string', status: 'string', items: 'array', count: 'integer' } },
    exchanges: [{
      request: { op: 'list' },
      expected: { id: 'run-1', status: 'ok', items: ['a', 'b'], count: 2 },
      response: { id: 'run-1', status: 'ok', items: ['a', 'b'], count: 2 },
      latencyMs: 100,
    }, {
      request: { op: 'list' },
      expected: { id: 'run-2', status: 'ok', items: ['a', 'b'], count: 2 },
      response: { id: 'run-2', status: 'ok', items: ['a', 'b'], count: 2 },
      latencyMs: 150,
    }],
  }));
  storeArtifactAnchor(tmp, 'api-behavior', p);
  const tier = deriveTier(tmp, 'api-behavior', 'fable-high')!;
  expect(tier.key).toBe('api-behavior/fable-high');
}

describe('tierContractText', () => {
  it('carries every axis with its band, directive, guard, and sampling line', () => {
    apiTier();
    const text = tierContractText(tmp, 'api-behavior/fable-high')!;
    expect(text).toContain('TARGET QUALITY CONTRACT — tier api-behavior/fable-high');
    expect(text).toContain('API transcript (JSON) class');
    expect(text).toContain('schemaConformance: at least 0.75');
    expect(text).toContain('fieldCoverage: at least 0.75');
    expect(text).toContain('semanticFidelity: at least 0.75');
    expect(text).toContain('latencyP95Ms: at most 200');
    expect(text).toContain('validate against the contract before replying');
    expect(text).toContain('latency envelope: batch or parallelize');
    expect(text).toContain('Evidence guard: a degenerate artifact');
    expect(text).toContain('temperature 0.2');
  });

  it('visual contracts carry the visual sampling profile and wash guard', () => {
    storeAnchor(tmp, 'visual-scene', pngPath(tmp, 'ref.png', 16, 16, () => [255, 0, 0]));
    deriveTier(tmp, 'visual-scene', 't')!;
    const text = tierContractText(tmp, 'visual-scene/t')!;
    expect(text).toContain('colors12: at least');
    expect(text).toContain('palette vocabulary');
    expect(text).toContain('temperature 0.8');
    expect(text).toContain('top_p 0.95');
  });

  it('is null for a tier the project does not carry (never invent a bar)', () => {
    expect(tierContractText(tmp, 'no/such')).toBeNull();
  });
});

describe('classSamplingProfile', () => {
  it('switches by class: precision classes run cold, generative warm', () => {
    expect(classSamplingProfile('api-behavior')).toEqual({ temperature: 0.2 });
    expect(classSamplingProfile('bench-score')).toEqual({ temperature: 0.2 });
    expect(classSamplingProfile('visual-scene')).toEqual({ temperature: 0.8, topP: 0.95 });
  });

  it('unregistered classes inherit the visual profile (the registry fallback rule)', () => {
    expect(classSamplingProfile('operator-class')).toEqual({ temperature: 0.8, topP: 0.95 });
  });
});

describe('withTierContract', () => {
  it('appends the contract to an executor prompt', () => {
    apiTier();
    const prompt = withTierContract('Build the tasks API.', tmp, 'api-behavior/fable-high');
    expect(prompt).toContain('Build the tasks API.');
    expect(prompt).toContain('TARGET QUALITY CONTRACT');
  });

  it('leaves the prompt unchanged when the tier does not exist', () => {
    expect(withTierContract('Do the thing.', tmp, 'no/such')).toBe('Do the thing.');
  });
});

describe('tierKeysFor', () => {
  it('lists tier keys, optionally filtered by class', () => {
    apiTier();
    storeAnchor(tmp, 'visual-scene', pngPath(tmp, 'ref.png', 16, 16, () => [255, 0, 0]));
    deriveTier(tmp, 'visual-scene', 't')!;
    expect(tierKeysFor(tmp)).toEqual(['api-behavior/fable-high', 'visual-scene/t']);
    expect(tierKeysFor(tmp, 'api-behavior')).toEqual(['api-behavior/fable-high']);
  });
});

describe('runTierLadder: the generator receives the contract (Wave 1.3)', () => {
  it('passes a non-null contract for a known tier, null for a tier with no thresholds', async () => {
    apiTier();
    const seen: Array<string | null> = [];
    const candidates: TierLadderCandidate[] = [{
      id: 'flat',
      artifactPath: join(tmp, 'flat.json'),
    }];
    writeFileSync(candidates[0].artifactPath, JSON.stringify({
      version: 1,
      schema: { required: ['id', 'status'], properties: { id: 'string', status: 'string' } },
      exchanges: [{ request: {}, expected: { id: 'r1', status: 'ok' }, response: { id: 'r1', status: 'ok' }, latencyMs: 600 }],
    }));
    await runTierLadder({
      projectRoot: tmp,
      tierKey: 'api-behavior/fable-high',
      generate: (round, previousBest, history, contract) => {
        seen.push(contract);
        return candidates;
      },
      maxRounds: 1,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('TARGET QUALITY CONTRACT');
    expect(seen[0]).toContain('latencyP95Ms: at most 200');
  });
});

describe('qualityCommand: contract subcommand', () => {
  const logs: string[] = [];
  beforeEach(() => {
    logs.length = 0;
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.join(' '));
    });
  });

  it('prints the contract for a known tier', async () => {
    apiTier();
    await qualityCommand('contract', { projectDir: tmp, tier: 'api-behavior/fable-high' });
    expect(process.exitCode).toBeUndefined();
    const out = logs.join('\n');
    expect(out).toContain('tier contract: api-behavior/fable-high');
    expect(out).toContain('schemaConformance: at least 0.75');
    expect(out).toContain('temperature 0.2');
  });

  it('fails with the known-tier list for an unknown tier', async () => {
    apiTier();
    await qualityCommand('contract', { projectDir: tmp, tier: 'no/such' });
    expect(process.exitCode).toBe(2);
    expect(logs.join('\n')).toContain("unknown tier 'no/such'");
    expect(logs.join('\n')).toContain('known: api-behavior/fable-high');
  });

  it('usage-fails without --tier and lists what exists', async () => {
    apiTier();
    await qualityCommand('contract', { projectDir: tmp });
    expect(process.exitCode).toBe(2);
    expect(logs.join('\n')).toContain('Usage: uap quality contract');
    expect(logs.join('\n')).toContain('known tiers: api-behavior/fable-high');
  });
});

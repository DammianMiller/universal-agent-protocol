import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RoutingPresets, passthroughModelsForPreset, type RoutingPreset } from '../src/models/index.js';
import { upsertProxyEnvVars, proxyEnvPath } from '../src/cli/systemd-services.js';

describe('passthroughModelsForPreset', () => {
  it('returns empty (use default patterns) for a cloud-using preset', () => {
    // fable-local-opus uses fable-5 (plan) + opus-4.8 (review) = cloud models.
    expect(passthroughModelsForPreset(RoutingPresets['fable-local-opus'])).toBe('');
  });

  it('returns the __local_only__ sentinel for an all-local preset', () => {
    const allLocal: RoutingPreset = {
      id: 'all-local',
      name: 'All local',
      description: 'qwen everywhere',
      roles: { planner: 'qwen36-a3b', executor: 'qwen36-a3b', reviewer: 'qwen36-a3b', fallback: 'qwen36-a3b' },
      models: ['qwen36-a3b'],
      routingStrategy: 'balanced',
    };
    expect(passthroughModelsForPreset(allLocal)).toBe('__local_only__');
  });
});

describe('upsertProxyEnvVars', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'uap-envtest-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('creates the systemd env file with the var when missing', () => {
    const p = upsertProxyEnvVars({ ANTHROPIC_PASSTHROUGH_MODELS: '' }, home);
    expect(p).toBe(proxyEnvPath(home));
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, 'utf8')).toContain('ANTHROPIC_PASSTHROUGH_MODELS=');
  });

  it('replaces an existing __local_only__ value and preserves other lines', () => {
    const p = proxyEnvPath(home);
    mkdirSync(join(home, '.config', 'uap'), { recursive: true });
    writeFileSync(p, 'PROXY_PORT=4000\nANTHROPIC_PASSTHROUGH_MODELS=__local_only__\nPROXY_LOG_LEVEL=INFO\n');
    upsertProxyEnvVars({ ANTHROPIC_PASSTHROUGH_MODELS: '' }, home);
    const out = readFileSync(p, 'utf8');
    expect(out).toContain('PROXY_PORT=4000');
    expect(out).toContain('PROXY_LOG_LEVEL=INFO');
    expect(out).not.toContain('__local_only__');
    expect(out).toContain('ANTHROPIC_PASSTHROUGH_MODELS=');
  });
});

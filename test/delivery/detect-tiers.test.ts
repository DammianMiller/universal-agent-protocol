import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  detectRungs,
  detectIntegrationRungs,
  detectDeployDevRung,
  tierOf,
} from '../../src/delivery/verifier-ladder.js';

describe('tier detection', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-tiers-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('detects test:integration and test:e2e as integration-tier rungs', () => {
    const scripts = { 'test:integration': 'vitest run integration', 'test:e2e': 'playwright test' };
    const rungs = detectIntegrationRungs(dir, scripts);
    expect(rungs.map((r) => r.id)).toEqual(['test:integration', 'test:e2e']);
    expect(rungs.every((r) => tierOf(r) === 'integration')).toBe(true);
  });

  it('detects a pytest integration marker', () => {
    writeFileSync(
      join(dir, 'pyproject.toml'),
      '[tool.pytest.ini_options]\nmarkers = [\n  "integration: end-to-end suite",\n]\n'
    );
    const rungs = detectIntegrationRungs(dir, {});
    expect(rungs.map((r) => r.id)).toEqual(['pytest:integration']);
    expect(rungs[0].args).toEqual(['-m', 'pytest', '-m', 'integration', '-q']);
  });

  it('detects compose + smoke as a deploy-dev rung with teardown', () => {
    writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
    const rung = detectDeployDevRung(dir, { smoke: 'node smoke.js' });
    expect(rung).not.toBeNull();
    expect(tierOf(rung!)).toBe('deploy-dev');
    expect(rung!.teardown).toEqual({ command: 'docker', args: ['compose', 'down', '-v'], timeoutMs: 30_000 });
  });

  it('prefers an explicit deploy:dev script over compose+smoke', () => {
    writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
    const rung = detectDeployDevRung(dir, { 'deploy:dev': 'bash deploy.sh', smoke: 'node smoke.js' });
    expect(rung?.id).toBe('deploy:dev');
    expect(rung?.teardown).toBeUndefined();
  });

  it('returns no integration/deploy-dev rungs when nothing is discoverable', () => {
    expect(detectIntegrationRungs(dir, {})).toEqual([]);
    expect(detectDeployDevRung(dir, {})).toBeNull();
  });

  it('detectRungs appends integration/deploy-dev tiers after the fast tier', () => {
    writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        scripts: { build: 'tsc', test: 'vitest run', 'test:integration': 'vitest run int', smoke: 'node s.js' },
      })
    );
    const rungs = detectRungs(dir);
    const tiers = rungs.map((r) => tierOf(r));
    // fast band first, then integration, then deploy-dev.
    expect(tiers.indexOf('fast')).toBeLessThan(tiers.indexOf('integration'));
    expect(tiers.indexOf('integration')).toBeLessThan(tiers.indexOf('deploy-dev'));
    expect(rungs.some((r) => r.id === 'test:integration')).toBe(true);
    expect(rungs.some((r) => tierOf(r) === 'deploy-dev')).toBe(true);
  });
});

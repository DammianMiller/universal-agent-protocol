import { describe, it, expect } from 'vitest';
import { protectedWritePathReason, isGateConfigBasename } from '../../src/delivery/applier.js';

describe('protectedWritePathReason (agentic + applier shared blocklist)', () => {
  it('blocks deploy/IaC gate-config writes when protectGateConfigs is on', () => {
    for (const p of [
      'docker-compose.yml',
      'compose.yaml',
      'Dockerfile',
      'infra/main.tf',
      'serverless.yml',
      'tsconfig.json',
      'vitest.config.ts',
    ]) {
      expect(protectedWritePathReason(p, true)).not.toBeNull();
    }
  });

  it('blocks protected segments regardless of the gate-config flag', () => {
    expect(protectedWritePathReason('.github/workflows/deploy-verify.yml', false)).not.toBeNull();
    expect(protectedWritePathReason('node_modules/x.js', false)).not.toBeNull();
  });

  it('allows ordinary source writes', () => {
    expect(protectedWritePathReason('src/feature.ts', true)).toBeNull();
    expect(protectedWritePathReason('lib/util/helpers.js', true)).toBeNull();
  });

  it('does not block gate-config basenames when protectGateConfigs is off', () => {
    expect(protectedWritePathReason('docker-compose.yml', false)).toBeNull();
    // …but it is still recognized as a gate-config basename.
    expect(isGateConfigBasename('docker-compose.yml')).toBe(true);
  });
});

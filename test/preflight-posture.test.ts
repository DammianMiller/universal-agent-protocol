/**
 * The repo's own tracked .uap.json must already carry the full posture that
 * `preflightProject` seeds (v1.148.22 seeds every enforcement surface on
 * mission start). If a key goes absent again, every `uap deliver` run dirties
 * the tracked config mid-mission — the churn that made deliver runs leave
 * `.uap.json` modified on every invocation. This locks the invariant:
 * preflight finds NOTHING to heal here.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { preflightProject } from '../src/delivery/project-preflight.js';

function repoRoot(): string {
  return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
}

describe('repo .uap.json preflight posture', () => {
  it('preflight has nothing to heal — deliver runs no longer dirty the tracked config', () => {
    const result = preflightProject(repoRoot());
    expect(result.healed).toEqual([]);
  });

  it('unit-test runs keep the model-slot lease disabled (see test/setup-env.ts)', () => {
    // The global setup pins this so fetch-mocked unit tests never poll the
    // shared coordination lease while a live deliver run applies backpressure.
    expect(process.env.UAP_MODEL_LEASE).toBe('0');
  });
});

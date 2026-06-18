import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runDeployDevRung } from '../../src/delivery/deploy-dev-gate.js';
import type { GateRung } from '../../src/delivery/verifier-ladder.js';

function nodeRung(partial: Partial<GateRung> & { args: string[] }): GateRung {
  return {
    id: 'smoke',
    name: 'smoke',
    command: 'node',
    required: true,
    timeoutMs: 5000,
    tier: 'deploy-dev',
    ...partial,
  };
}

describe('runDeployDevRung', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-deploydev-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.UAP_DELIVER_NO_DEPLOY;
  });

  it('runs teardown even when the smoke check fails', () => {
    const marker = join(dir, 'teardown.marker');
    const rung = nodeRung({
      args: ['-e', 'process.exit(1)'], // smoke fails
      teardown: {
        command: 'node',
        args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
        timeoutMs: 5000,
      },
    });
    const res = runDeployDevRung(rung, dir);
    expect(res.passed).toBe(false);
    expect(res.failureReason).toBe('exit');
    expect(existsSync(marker)).toBe(true); // teardown ran despite failure
  });

  it('distinguishes a smoke timeout from a plain exit failure', () => {
    const rung = nodeRung({ args: ['-e', 'setTimeout(() => {}, 10000)'], timeoutMs: 250 });
    const res = runDeployDevRung(rung, dir);
    expect(res.passed).toBe(false);
    expect(res.failureReason).toBe('timeout');
  });

  it('marks the tier skipped (not failed) when docker is unavailable', () => {
    const rung: GateRung = {
      id: 'deploy:dev:compose',
      name: 'compose deploy',
      command: 'docker',
      args: ['compose', 'up'],
      required: true,
      timeoutMs: 5000,
      tier: 'deploy-dev',
      teardown: { command: 'docker', args: ['compose', 'down', '-v'], timeoutMs: 5000 },
    };
    const res = runDeployDevRung(rung, dir, { dockerAvailable: false });
    expect(res.skipped).toBe(true);
    expect(res.passed).toBe(false);
    expect(res.outputTail).toMatch(/docker unavailable/);
  });

  it('skips when UAP_DELIVER_NO_DEPLOY=1', () => {
    process.env.UAP_DELIVER_NO_DEPLOY = '1';
    const res = runDeployDevRung(nodeRung({ args: ['-e', 'process.exit(0)'] }), dir);
    expect(res.skipped).toBe(true);
  });

  it('runs the smoke command with a sanitized env (SECRET_* stripped)', () => {
    const out = join(dir, 'env.out');
    process.env.SECRET_TESTVAR = 'leak-me';
    try {
      const rung = nodeRung({
        args: [
          '-e',
          `require('fs').writeFileSync(${JSON.stringify(out)}, process.env.SECRET_TESTVAR || 'ABSENT')`,
        ],
      });
      const res = runDeployDevRung(rung, dir);
      expect(res.passed).toBe(true);
      expect(readFileSync(out, 'utf-8')).toBe('ABSENT');
    } finally {
      delete process.env.SECRET_TESTVAR;
    }
  });
});

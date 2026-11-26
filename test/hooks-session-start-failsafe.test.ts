import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

/**
 * The session-start hook's "fails safely — never blocks the agent" contract,
 * enforced by the templates/hooks/session-start.sh fail-safe wrapper.
 *
 * Observed 2026-11-26 (voxel-pagoda client, session a550af7a): the hook ran
 * `set -euo pipefail` at top level, one transient sub-failure (the
 * coordination-DB self-heal sqlite class) aborted it, and the harness
 * surfaced "SessionStart hook error: Hook exited with code 1" into the
 * client's transcript — exactly the noise the documented contract promises
 * never to produce. These tests install the hooks exactly as `uap hooks
 * install` ships them and pin the enforced behavior: any sub-failure still
 * exits 0, and the fast early-exit path is preserved.
 */
describe('session-start hook fail-safe contract', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    dirs.length = 0;
  });

  const install = async () => {
    const testDir = mkdtempSync(join(tmpdir(), `uap-ss-failsafe-${Date.now()}`));
    dirs.push(testDir);
    const { hooksCommand } = await import('../src/cli/hooks.js');
    await hooksCommand('install', { projectDir: testDir, target: 'factory' });
    return testDir;
  };

  const hookPath = (dir: string) => join(dir, '.factory', 'hooks', 'session-start.sh');

  it('enforces the never-block contract structurally (subshell body, forced exit 0)', async () => {
    const dir = await install();
    const hook = readFileSync(hookPath(dir), 'utf-8');
    // The body runs inside a subshell so a set -e abort cannot become the
    // hook's own exit status...
    expect(hook).toMatch(/\(\s*\n\s*set -euo pipefail/);
    // ...the closer swallows any subshell failure...
    expect(hook).toContain(') || :');
    // ...and a hard exit 0 terminates the hook regardless.
    expect(hook.trimEnd().endsWith('exit 0')).toBe(true);
  });

  it('exits 0 when a dependency fails transiently (the observed sqlite3 abort class)', async () => {
    const dir = await install();
    // Memory DB present so the hook passes its early-exit gate; the
    // coordination DB is absent so the self-heal sqlite3 call runs.
    mkdirSync(join(dir, 'agents', 'data', 'memory'), { recursive: true });
    writeFileSync(join(dir, 'agents', 'data', 'memory', 'short_term.db'), '');
    // Poison sqlite3: every call fails, the way real contention past
    // busy_timeout fails. This is the class that aborted the real client
    // session — under the old template the hook exited non-zero here.
    const shimDir = mkdtempSync(join(tmpdir(), `uap-ss-shim-${Date.now()}`));
    dirs.push(shimDir);
    const shim = join(shimDir, 'sqlite3');
    writeFileSync(shim, '#!/bin/sh\nexit 1\n');
    chmodSync(shim, 0o755);
    const r = spawnSync('bash', [hookPath(dir)], {
      cwd: dir,
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, FACTORY_PROJECT_DIR: dir },
      encoding: 'utf-8',
      timeout: 60_000,
    });
    expect(r.status).toBe(0);
  });

  it('keeps the fast early-exit when the memory DB is absent', async () => {
    const dir = await install();
    const r = spawnSync('bash', [hookPath(dir)], {
      cwd: dir,
      env: { ...process.env, FACTORY_PROJECT_DIR: dir },
      encoding: 'utf-8',
      timeout: 60_000,
    });
    expect(r.status).toBe(0);
  });
});

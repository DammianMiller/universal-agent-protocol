import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Regression: the runtime execution gate wrapped `uap verify` with a bare
 * `timeout`. In OpenCode (bun shell) that produced `bun: command not found:
 * timeout`; on macOS GNU timeout is absent entirely (`gtimeout`). Both the
 * generated bun plugin and the stop.sh template must resolve a real timeout
 * binary and fall back to running verify directly.
 */
describe('runtime-gate timeout is portable (no bare `timeout`)', () => {
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

  it('OpenCode plugin resolves timeout via Bun.which, no bare $`timeout`', async () => {
    const testDir = join(tmpdir(), `uap-oc-timeout-${Date.now()}`);
    dirs.push(testDir);
    const { hooksCommand } = await import('../src/cli/hooks.js');
    await hooksCommand('install', { projectDir: testDir, target: 'opencode' });

    const pluginPath = join(testDir, '.opencode', 'plugin', 'uap-session-hooks.ts');
    expect(existsSync(pluginPath)).toBe(true);
    const plugin = readFileSync(pluginPath, 'utf-8');

    // The buggy form ran `timeout` directly in bun's shell.
    expect(plugin).not.toMatch(/\$`timeout /);
    // The fix resolves a real binary and degrades gracefully.
    expect(plugin).toContain('Bun.which("timeout")');
    expect(plugin).toContain('Bun.which("gtimeout")');
    // Still invokes the verify gate.
    expect(plugin).toContain('uap verify --strict --runtime-only');
  });

  it('stop.sh template degrades to gtimeout / no-wrapper instead of a bare timeout', async () => {
    const testDir = join(tmpdir(), `uap-stop-timeout-${Date.now()}`);
    dirs.push(testDir);
    const { hooksCommand } = await import('../src/cli/hooks.js');
    await hooksCommand('install', { projectDir: testDir, target: 'claude' });

    const stopPath = join(testDir, '.claude', 'hooks', 'stop.sh');
    expect(existsSync(stopPath)).toBe(true);
    const stop = readFileSync(stopPath, 'utf-8');

    // Portable resolver present.
    expect(stop).toContain('command -v timeout');
    expect(stop).toContain('gtimeout -k 5 120');
    // No unguarded bare invocation of the timeout binary on the verify line.
    expect(stop).not.toMatch(/&& timeout -k 5 120 uap verify/);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Regression: the opencode escalation-evidence surface was orphaned — the
 * generator (src/cli/hooks.ts) emitted plugin code that calls
 * .opencode/hooks/escalation_tracker.py, but the tracker was never shipped to
 * .opencode/hooks/ and the repo's TRACKED plugin copy drifted from the
 * generator. Lock all three in place: the tracker installs, the plugin wires
 * evidence, and the tracked copy matches the generator byte-for-byte.
 */
describe('opencode escalation evidence surface', () => {
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

  it('installs escalation_tracker.py beside the opencode hooks and wires the plugin', async () => {
    const testDir = join(tmpdir(), `uap-oc-esc-${Date.now()}`);
    dirs.push(testDir);
    const { hooksCommand } = await import('../src/cli/hooks.js');
    await hooksCommand('install', { projectDir: testDir, target: 'opencode' });

    // The missing piece: the tracker the plugin calls must actually exist.
    expect(existsSync(join(testDir, '.opencode', 'hooks', 'escalation_tracker.py'))).toBe(true);

    const plugin = readFileSync(join(testDir, '.opencode', 'plugin', 'uap-session-hooks.ts'), 'utf-8');
    // Verify outcomes recorded as pass/fail evidence…
    expect(plugin).toContain('recordEvidence(res');
    // …and build/test shell outcomes classified (opencode exposes text, not
    // exit codes — classify-bash is the text-marker path).
    expect(plugin).toContain('classify-bash');
  });

  it('the repo\'s TRACKED .opencode plugin matches the generator output', async () => {
    // This repo self-installs: .opencode/plugin/uap-session-hooks.ts is
    // committed. When the generator evolves without re-syncing the tracked
    // copy, the repo runs stale hooks — exactly how the escalation surface
    // went missing. Generate into a temp dir and compare byte-for-byte.
    const testDir = join(tmpdir(), `uap-oc-sync-${Date.now()}`);
    dirs.push(testDir);
    const { hooksCommand } = await import('../src/cli/hooks.js');
    await hooksCommand('install', { projectDir: testDir, target: 'opencode' });

    const generated = readFileSync(join(testDir, '.opencode', 'plugin', 'uap-session-hooks.ts'), 'utf-8');
    const tracked = readFileSync(
      join(process.cwd(), '.opencode', 'plugin', 'uap-session-hooks.ts'),
      'utf-8'
    );
    expect(
      tracked,
      'tracked .opencode/plugin/uap-session-hooks.ts is stale — re-run `uap hooks install --platform opencode` and commit the result'
    ).toBe(generated);
  });
});

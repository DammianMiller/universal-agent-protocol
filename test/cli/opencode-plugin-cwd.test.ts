import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installOpencodeHooks } from '../../src/cli/hooks.js';

/**
 * The opencode seam is cwd-independent. The long-lived `opencode serve`
 * process may run with ANY cwd (observed live 2026-11-27: cwd=$HOME while
 * the session worked in <project>/), so the generated plugin must anchor
 * every hook invocation to its own file's project root — otherwise the
 * entire policy gate silently no-op'd (exit 127, zero policy executions,
 * no verify gates, no escalation evidence).
 */
describe('opencode plugin — cwd anchoring (server cwd independence)', () => {
  let dir: string;
  let plugin: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'uap-oc-cwd-'));
    await installOpencodeHooks(dir);
    plugin = readFileSync(join(dir, '.opencode', 'plugin', 'uap-session-hooks.ts'), 'utf8');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('derives its project root from the plugin file location and runs every shell with that cwd', () => {
    expect(plugin).toMatch(/const PLUGIN_ROOT/);
    expect(plugin).toMatch(/import\.meta\.url/);
    expect(plugin).toMatch(/cwd: PLUGIN_ROOT/);
    // The two hook executables the seam invokes per tool call/event must be
    // addressed absolutely — a relative path is the exact 127-no-op class
    // this fixes.
    expect(plugin).toMatch(/\$\{PLUGIN_ROOT\}\/\.opencode\/hooks\/uap-policy-gate\.sh/);
    expect(plugin).toMatch(/\$\{PLUGIN_ROOT\}\/\.opencode\/hooks\/escalation_tracker\.py/);
    // …and no bare relative invocation of either remains.
    expect(plugin).not.toMatch(/bash \.opencode\/hooks\/uap-policy-gate\.sh/);
    expect(plugin).not.toMatch(/python3 \.opencode\/hooks\/escalation_tracker\.py/);
  });

  it('PLUGIN_ROOT resolves to the scaffolded project root even when node runs from a foreign cwd', () => {
    // Extract the emitted derivation verbatim and execute it as a real
    // module sitting NEXT TO the generated plugin (same directory → same
    // two-hops-up semantics), launched with cwd=/ so a cwd-dependent
    // implementation would resolve the wrong root and fail.
    const m = plugin.match(/const PLUGIN_ROOT = \(\(\) => \{[\s\S]*?\}\)\(\)/);
    expect(m).not.toBeNull();
    const probe = join(dir, '.opencode', 'plugin', 'root-probe.mjs');
    writeFileSync(
      probe,
      'import { fileURLToPath } from "node:url"\n' +
        'import { dirname, join } from "node:path"\n' +
        m![0] +
        '\nconsole.log(PLUGIN_ROOT)\n'
    );
    const out = execFileSync(process.execPath, [probe], {
      cwd: '/',
      encoding: 'utf8',
    }).trim();
    expect(realpathSync(out)).toBe(realpathSync(dir));
  });
});

/**
 * Policy-gate parity tests
 *
 * Verifies the installer wires the DB-driven policy gate into every gateable
 * platform, that `auditPlatform` (the `hooks doctor` core) reports coverage
 * correctly, and that the Hermes gate translates a block into stdout JSON.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, spawn } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, copyFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { hooksCommand, auditPlatform } from '../../src/cli/hooks.js';

const TEMPLATE_GATE = join(process.cwd(), 'templates', 'hooks', 'uap-policy-gate-hermes.sh');

describe('policy-gate parity', () => {
  let proj: string;
  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), 'uap-gating-'));
  });
  afterEach(() => {
    rmSync(proj, { recursive: true, force: true });
  });

  it('copies the policy-gate script and wires it for claude', async () => {
    expect(auditPlatform(proj, 'claude').scriptPresent).toBe(false); // baseline
    await hooksCommand('install', { target: 'claude', projectDir: proj });
    expect(existsSync(join(proj, '.claude/hooks/uap-policy-gate.sh'))).toBe(true);
    const row = auditPlatform(proj, 'claude');
    expect(row.tier).toBe('gateable');
    expect(row.scriptPresent).toBe(true);
    expect(row.wired).toBe(true);
  });

  it('wires the gate into factory, opencode, and omp', async () => {
    for (const t of ['factory', 'opencode', 'omp'] as const) {
      await hooksCommand('install', { target: t, projectDir: proj });
      const row = auditPlatform(proj, t);
      expect(row.tier, t).toBe('gateable');
      expect(row.scriptPresent, t).toBe(true);
      expect(row.wired, t).toBe(true);
    }
    // opencode wiring is the throw-to-block plugin hook (V2: ctx.tool.hook)
    const plugin = readFileSync(join(proj, '.opencode/plugin/uap-session-hooks.ts'), 'utf-8');
    expect(plugin).toContain('ctx.tool.hook("execute.before"');
  });

  it('reports codex as MCP-gated and forgecode as advisory (harness limits)', async () => {
    await hooksCommand('install', { target: 'codex', projectDir: proj });
    await hooksCommand('install', { target: 'forgecode', projectDir: proj });
    expect(auditPlatform(proj, 'codex').tier).toBe('mcp');
    expect(auditPlatform(proj, 'forgecode').tier).toBe('advisory');
  });

  it('installs Hermes into a global config with pre_tool_call gate + MCP server', async () => {
    const home = mkdtempSync(join(tmpdir(), 'uap-hermes-'));
    const prev = process.env.HERMES_HOME;
    process.env.HERMES_HOME = home;
    try {
      await hooksCommand('install', { target: 'hermes', projectDir: proj });
      const cfg = readFileSync(join(home, 'config.yaml'), 'utf-8');
      expect(cfg).toContain('pre_tool_call');
      expect(cfg).toContain('uap-policy-gate-hermes.sh');
      expect(cfg).toContain('mcp_servers');
      expect(existsSync(join(home, 'agent-hooks/uap-policy-gate-hermes.sh'))).toBe(true);
      expect(existsSync(join(home, 'uap-skills/uap-experts/SKILL.md'))).toBe(true);
      expect(auditPlatform(proj, 'hermes').wired).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('Hermes gate translates a block (exit 2) into stdout decision JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-hgate-'));
    try {
      copyFileSync(TEMPLATE_GATE, join(dir, 'uap-policy-gate-hermes.sh'));
      chmodSync(join(dir, 'uap-policy-gate-hermes.sh'), 0o755);
      // inner gate that blocks
      writeFileSync(join(dir, 'uap-policy-gate.sh'), '#!/usr/bin/env bash\necho "blocked: x" >&2\nexit 2\n');
      chmodSync(join(dir, 'uap-policy-gate.sh'), 0o755);
      const blocked = spawnSync('bash', [join(dir, 'uap-policy-gate-hermes.sh')], {
        input: '{"tool_name":"terminal","tool_input":{}}',
        encoding: 'utf-8',
      });
      expect(blocked.status).toBe(0); // always exit 0 (Hermes reads stdout)
      expect(JSON.parse(blocked.stdout).decision).toBe('block');

      // allow case
      writeFileSync(join(dir, 'uap-policy-gate.sh'), '#!/usr/bin/env bash\nexit 0\n');
      const allowed = spawnSync('bash', [join(dir, 'uap-policy-gate-hermes.sh')], {
        input: '{"tool_name":"read"}',
        encoding: 'utf-8',
      });
      expect(allowed.stdout.trim()).toBe('{}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('factory hook binding survives a FACTORY_PROJECT_DIR-less context', () => {
  let proj: string;
  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), 'uap-fbind-'));
  });
  afterEach(() => {
    rmSync(proj, { recursive: true, force: true });
  });

  /**
   * Droid runs SessionEnd in a context where FACTORY_PROJECT_DIR is not set
   * (measured 2026-11-28, droid-log-single.log.2026-11-28: 11/11 SessionEnd
   * executions that day resolved the bare "$FACTORY_PROJECT_DIR"/... binding
   * to /.factory/hooks/session-end.sh — file not found — and every
   * UAP-scaffolded project's sessions ended with "SessionEnd hook error";
   * SessionStart/Stop/PreCompact, which do receive the variable, never
   * failed). The binding must carry its own fallback.
   */
  it('emits every factory hook command with the install-time project dir as fallback', async () => {
    await hooksCommand('install', { target: 'factory', projectDir: proj });
    const settings = JSON.parse(
      readFileSync(join(proj, '.factory', 'settings.local.json'), 'utf-8'),
    ) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const cmds = Object.values(settings.hooks).flatMap((entries) =>
      entries.flatMap((e) => e.hooks.map((h) => h.command))
    );
    // 15 bindings: SessionStart, UserPromptSubmit, PreToolUse×5, PostToolUse×4,
    // PreCompact, PostCompact, Stop, SessionEnd — every one must carry the
    // fallback, not just the event that failed in production.
    expect(cmds.length).toBeGreaterThanOrEqual(15);
    for (const c of cmds) {
      expect(c.startsWith('bash "${FACTORY_PROJECT_DIR:-')).toBe(true);
      expect(c).toContain(`:-${proj}}/.factory/hooks/`);
    }
  });

  it('runs the SessionEnd command with the variable unset, from a foreign cwd', async () => {
    await hooksCommand('install', { target: 'factory', projectDir: proj });
    const settings = JSON.parse(
      readFileSync(join(proj, '.factory', 'settings.local.json'), 'utf-8'),
    ) as { hooks: { SessionEnd: Array<{ hooks: Array<{ command: string }> }> } };
    const cmd = settings.hooks.SessionEnd[0].hooks[0].command;
    // No FACTORY_PROJECT_DIR in env, and cwd is NOT the project: the exact
    // shape of the measured SessionEnd context. session-end.sh is fail-soft
    // (always exit 0); this asserts the binding RESOLVES to the real script.
    const r = spawnSync('sh', ['-c', cmd], {
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME },
    });
    expect(r.status).toBe(0);
    expect(String(r.stderr)).not.toContain('not found');
  });

  /**
   * Measured 2026-11-28 21:35:28 (voxel-pagoda-basalt-inkling-1, session
   * 6f8a6098, the FIRST SessionEnd fired after PR #987 shipped the softened
   * `bash X || true` command): Droid's hook executor REJECTED the compound
   * command outright — 23ms duration, rc 1, empty stdout AND stderr, the
   * script never executed (`bash X || true` cannot exit 1 through any
   * shell, so the executor itself refused the form). The fail-soft contract
   * ("always exits 0") lives INSIDE session-end.sh; the command must be a
   * bare `bash "<script>"` — simple commands only.
   */
  it('emits a plain single-command SessionEnd binding (harness executors reject compound commands)', async () => {
    await hooksCommand('install', { target: 'factory', projectDir: proj });
    const settings = JSON.parse(
      readFileSync(join(proj, '.factory', 'settings.local.json'), 'utf-8'),
    ) as { hooks: { SessionEnd: Array<{ hooks: Array<{ command: string }> }> } };
    const cmd = settings.hooks.SessionEnd[0].hooks[0].command;
    expect(cmd).toMatch(/^bash "\$\{FACTORY_PROJECT_DIR:-[^}]+\}\/\.factory\/hooks\/session-end\.sh"$/);
    for (const op of ['||', '&&', ';']) {
      expect(cmd).not.toContain(op);
    }
  });

  it('keeps the Claude SessionEnd command plain the same way', async () => {
    await hooksCommand('install', { target: 'claude', projectDir: proj });
    const settings = JSON.parse(
      readFileSync(join(proj, '.claude', 'settings.local.json'), 'utf-8'),
    ) as { hooks: { SessionEnd: Array<{ hooks: Array<{ command: string }> }> } };
    const cmd = settings.hooks.SessionEnd[0].hooks[0].command;
    expect(cmd).toBe('bash "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/session-end.sh"');
  });

  /**
   * The fleet-wide executor contract: every registered hook command is a
   * bare `bash "<path>"`. Droid's hook executor rejects anything compound
   * (measured above), and Claude Code tolerates but does not require
   * operators — simple form everywhere keeps one command shape across all
   * harnesses.
   */
  it('emits simple bash commands for every registered hook (no shell operators)', async () => {
    await hooksCommand('install', { target: 'factory', projectDir: proj });
    const settings = JSON.parse(
      readFileSync(join(proj, '.factory', 'settings.local.json'), 'utf-8'),
    ) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const commands: string[] = [];
    for (const entries of Object.values(settings.hooks)) {
      for (const entry of entries) {
        for (const h of entry.hooks) commands.push(h.command);
      }
    }
    expect(commands.length).toBeGreaterThanOrEqual(8);
    for (const cmd of commands) {
      expect(cmd).toMatch(/^bash "[^"]+"$/);
      for (const op of ['||', '&&', ';']) {
        expect(cmd).not.toContain(op);
      }
    }
  });

  /**
   * The original 19:43:34 race (session 42fc66db): the re-scaffold's
   * copyFileSync truncated a hook script while the dying session's
   * SessionEnd fired → bash read a partial script → nonzero →
   * "SessionEnd hook error". Installers now replace scripts via tmp+rename
   * (atomic): a concurrent reader sees the old or the new complete file,
   * never a truncated one. This test hammers a hook file with reads while
   * a re-install rewrites every hook and asserts every read is complete.
   */
  it('replaces hook scripts atomically (a firing hook never reads a partial script)', async () => {
    await hooksCommand('install', { target: 'factory', projectDir: proj });
    const hooksDir = join(proj, '.factory', 'hooks');
    const stopPath = join(hooksDir, 'stop.sh');
    const full = readFileSync(stopPath); // Buffer: byte length, same as wc -c
    expect(full.slice(0, 2).toString()).toBe('#!');

    const reader = spawn('bash', [
      '-c',
      `for i in $(seq 1 200); do s=$(wc -c < "${stopPath}" 2>/dev/null || echo 0); echo "$s"; done`,
    ]);
    let out = '';
    reader.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    const done = new Promise<void>((resolve) => {
      reader.on('close', () => resolve());
    });
    await hooksCommand('install', { target: 'factory', projectDir: proj });
    await done;

    const sizes = out.trim().split('\n').map((n) => parseInt(n, 10));
    expect(sizes.length).toBeGreaterThanOrEqual(100); // the reader actually ran
    for (const s of sizes) {
      expect(s).toBe(full.length); // never a truncated read
    }
    // No tmp residue left behind by the atomic replace.
    const residue = readdirSync(hooksDir).filter((f) => f.includes('.tmp-'));
    expect(residue).toHaveLength(0);
  });
});

describe('AGENTS.md render-verification seam', () => {
  let proj: string;
  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), 'uap-rvs-'));
  });
  afterEach(() => {
    rmSync(proj, { recursive: true, force: true });
  });

  /**
   * Measured 2026-11-28 (voxel-pagoda-basalt-inkling-1, session 42fc66db):
   * with no render-verification guidance in the scaffold, the client
   * improvised `google-chrome --headless --screenshot --virtual-time-budget=N`
   * to prove its three.js artifact — 7 consecutive failed captures (5
   * killed-with-no-file, 1 blank frame under --enable-unsafe-swiftshader,
   * 1 fluke success), 90s each, because that path hangs while a RAF loop is
   * live. The scaffold must hand clients the working seam instead.
   */
  it('tells clients to prove rendered deliverables via uap verify, not raw chrome screenshots', async () => {
    await hooksCommand('install', { target: 'codex', projectDir: proj });
    const md = readFileSync(join(proj, 'AGENTS.md'), 'utf-8');
    expect(md).toContain('## Artifact Verification');
    expect(md).toContain('`uap verify`');
    expect(md).toContain('google-chrome --headless --screenshot');
    expect(md).toMatch(/requestAnimationFrame/);
  });

  it('keeps the init.ts AGENTS.md twin in sync with the hooks.ts template', () => {
    // init.ts duplicates the AGENTS.md template; drift between the two
    // writers means `uap init` scaffolds projects without the seam that
    // `uap hooks install` writes (and vice versa).
    const root = process.cwd();
    const hooksSrc = readFileSync(join(root, 'src/cli/hooks.ts'), 'utf-8');
    const initSrc = readFileSync(join(root, 'src/cli/init.ts'), 'utf-8');
    for (const line of [
      '## Artifact Verification (rendered deliverables)',
      'Never verify a render with `google-chrome --headless --screenshot',
    ]) {
      expect(hooksSrc).toContain(line);
      expect(initSrc).toContain(line);
    }
  });
});

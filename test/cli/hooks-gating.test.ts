/**
 * Policy-gate parity tests
 *
 * Verifies the installer wires the DB-driven policy gate into every gateable
 * platform, that `auditPlatform` (the `hooks doctor` core) reports coverage
 * correctly, and that the Hermes gate translates a block into stdout JSON.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, copyFileSync } from 'fs';
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
    // opencode wiring is the throw-to-block plugin hook
    const plugin = readFileSync(join(proj, '.opencode/plugin/uap-session-hooks.ts'), 'utf-8');
    expect(plugin).toContain('tool.execute.before');
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

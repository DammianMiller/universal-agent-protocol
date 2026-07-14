/**
 * A worktree without hooks is a hole straight through every gate.
 *
 * `git worktree add` materializes only TRACKED files, and the hook scripts are
 * untracked — so a fresh worktree has no `.opencode/hooks`, no gate runs, and an
 * agent working there writes source COMPLETELY UNGATED: no routing to deliver, no
 * self-protect, no infra-protect.
 *
 * Observed live: the opencode client was working in
 * `.worktrees/001-dev-environment-setup` with zero enforcement present, and
 * nothing was being routed at all (no pending-deliver.jsonl, no autoroute.log) —
 * because no hook existed to route it. Every "all work goes through deliver"
 * guarantee was void inside that directory.
 *
 * Only the hook FILES need to travel: the gate already anchors the policy DB and
 * enforcers to MAIN_ROOT, so a worktree inherits the parent's policies once a hook
 * is actually there to run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { hooksCommand } from '../../src/cli/hooks.js';
import { wireDeliverMcp } from '../../src/cli/deliver-defaults.js';

const sh = (cmd: string, cwd: string): void => { spawnSync('bash', ['-c', cmd], { cwd, stdio: 'ignore' }); };

describe('a worktree must inherit enforcement', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'uap-wt-'));
    sh('git init -q && git config user.email a@b.c && git config user.name t', root);
    writeFileSync(join(root, '.uap.json'), JSON.stringify({ version: '1.0.0' }));
    sh('git add -A && git commit -q -m base', root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('BASELINE: a bare `git worktree add` carries NO hooks — the hole this closes', () => {
    const wt = join(root, '.worktrees', 'plain');
    mkdirSync(join(root, '.worktrees'), { recursive: true });
    sh(`git worktree add -q -b feature/plain ${JSON.stringify(wt)}`, root);
    expect(existsSync(join(wt, '.uap.json'))).toBe(true);        // tracked -> travels
    expect(existsSync(join(wt, '.opencode', 'hooks'))).toBe(false); // untracked -> does NOT
  });

  it('installing hooks into the worktree puts the gate there', async () => {
    const wt = join(root, '.worktrees', 'gated');
    mkdirSync(join(root, '.worktrees'), { recursive: true });
    sh(`git worktree add -q -b feature/gated ${JSON.stringify(wt)}`, root);

    await hooksCommand('install', { projectDir: wt });

    // The policy gate — the script that routes every write through deliver.
    expect(existsSync(join(wt, '.opencode', 'hooks', 'uap-policy-gate.sh'))).toBe(true);
    expect(existsSync(join(wt, '.claude', 'hooks', 'uap-policy-gate.sh'))).toBe(true);
    // ...and the opencode PLUGIN, which is what actually runs that gate. Hooks
    // without the plugin are inert files: they look installed and enforce nothing.
    expect(existsSync(join(wt, '.opencode', 'plugin'))).toBe(true);
  }, 30_000);

  it('wires the deliver tool too — an unwired worktree cannot route to deliver', () => {
    const wt = join(root, '.worktrees', 'wired');
    mkdirSync(join(root, '.worktrees'), { recursive: true });
    sh(`git worktree add -q -b feature/wired ${JSON.stringify(wt)}`, root);

    wireDeliverMcp(wt);

    // The MCP router config is how the agent reaches `uap deliver` at all.
    expect(existsSync(join(wt, '.mcp.json'))).toBe(true);
  }, 30_000);
});

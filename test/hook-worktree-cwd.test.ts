/**
 * The policy-gate hook resolves the working tree the operation TARGETS (a `cd`
 * into a worktree, or the payload cwd) instead of only the hook's own cwd — so
 * git-diff enforcers reason about the worktree branch on `cd worktree && git ...`
 * compound commands. Regression for the expert-review "wrong branch" misfire.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { globSync } from 'glob';

const ROOT = process.cwd();

/** Reproduce the hook's cd-target extraction (same python) for a given command. */
function parseCdTarget(command: string): string {
  const payload = JSON.stringify({ tool_input: { command } });
  const py = [
    'import json,os,re',
    'd=json.loads(os.environ.get("UAP_PAYLOAD") or "{}")',
    'cmd=(d.get("tool_input") or {}).get("command") or ""',
    "m=re.match(r'\\s*cd\\s+(?:\"([^\"]+)\"|\\x27([^\\x27]+)\\x27|([^\\s;&|]+))', cmd)",
    'print((m.group(1) or m.group(2) or m.group(3)) if m else "")',
  ].join('\n');
  const r = spawnSync('python3', ['-c', py], { env: { ...process.env, UAP_PAYLOAD: payload }, encoding: 'utf8' });
  return (r.stdout || '').trim();
}

describe('hook cd-target parsing', () => {
  it('extracts the cd path from a compound command', () => {
    expect(parseCdTarget('cd /home/u/.worktrees/42-x && git push')).toBe('/home/u/.worktrees/42-x');
  });
  it('handles a quoted path with spaces', () => {
    expect(parseCdTarget('cd "/home/u/my repo" && git status')).toBe('/home/u/my repo');
  });
  it('handles cd on its own line', () => {
    expect(parseCdTarget('cd /home/u/wt\ngit push origin HEAD')).toBe('/home/u/wt');
  });
  it('returns empty when there is no leading cd', () => {
    expect(parseCdTarget('git push origin HEAD')).toBe('');
    expect(parseCdTarget('echo hello && cd /x')).toBe(''); // cd not leading
  });
});

describe('every tracked policy-gate hook copy carries the fix', () => {
  // `.worktrees/` holds OTHER checkouts, most of them of older commits. Their
  // hook copies predate this fix and always will — nothing done in this tree
  // can change a file that belongs to a different commit. Globbing them made
  // the assertion unpassable by construction: it went red for a stale sibling
  // worktree, which reads as "this change broke the hooks" when the change is
  // not involved at all. It cost a real diagnosis on 2026-08-09, where the
  // named file was in .worktrees/330-dash-resilient — deleting that worktree
  // just moved the failure to the next stale one.
  //
  // The contract is about THIS working tree's copies. Whether some other
  // checkout is stale is worktree hygiene (`uap worktree hygiene`), which
  // reports drift instead of failing a unit test that cannot fix it.
  const hooks = globSync('**/uap-policy-gate.sh', {
    cwd: ROOT,
    dot: true,
    ignore: ['**/node_modules/**', '.worktrees/**'],
  });

  it('finds the hook copies', () => {
    expect(hooks.length).toBeGreaterThan(1); // template + per-platform copies
  });

  it('each copy resolves the target working tree (contains _CD_TARGET) and is valid bash', () => {
    for (const h of hooks) {
      const abs = join(ROOT, h);
      if (!existsSync(abs)) continue;
      expect(readFileSync(abs, 'utf-8'), h).toContain('_CD_TARGET');
      const check = spawnSync('bash', ['-n', abs], { encoding: 'utf8' });
      expect(check.status, `bash -n failed for ${h}: ${check.stderr}`).toBe(0);
    }
  });
});

describe('the hook scan looks at THIS tree, not at other checkouts', () => {
  // Built against a fixture rather than the real tree: whether .worktrees/
  // exists here depends on where the suite runs, and a test that silently
  // becomes a no-op is how the scoping bug survived in the first place.
  const OPTS = { dot: true, ignore: ['**/node_modules/**', '.worktrees/**'] };

  function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'uap-hookscan-'));
    for (const rel of [
      '.claude/hooks/uap-policy-gate.sh',                        // this tree
      'templates/hooks/uap-policy-gate.sh',                      // this tree
      '.worktrees/900-old/templates/hooks/uap-policy-gate.sh',   // another checkout
      '.worktrees/901-old/.claude/hooks/uap-policy-gate.sh',     // another checkout
    ]) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, '#!/usr/bin/env bash\nexit 0\n');
    }
    return root;
  }

  it('excludes every copy under .worktrees/', () => {
    const root = fixture();
    const found = globSync('**/uap-policy-gate.sh', { cwd: root, ...OPTS });
    expect(found.some((h) => h.startsWith('.worktrees'))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('still finds this tree\'s own copies (the exclusion is not a blanket skip)', () => {
    const root = fixture();
    const found = globSync('**/uap-policy-gate.sh', { cwd: root, ...OPTS });
    expect(found.sort()).toEqual([
      '.claude/hooks/uap-policy-gate.sh',
      'templates/hooks/uap-policy-gate.sh',
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  it('without the exclusion the other checkouts WOULD be scanned', () => {
    // Pins why the ignore is needed: these copies belong to older commits and
    // can never carry a later fix, so scanning them can only produce failures
    // that nothing in this tree can resolve.
    const root = fixture();
    const found = globSync('**/uap-policy-gate.sh', {
      cwd: root, dot: true, ignore: ['**/node_modules/**'],
    });
    expect(found.filter((h) => h.startsWith('.worktrees'))).toHaveLength(2);
    rmSync(root, { recursive: true, force: true });
  });
});

/**
 * The policy-gate hook resolves the working tree the operation TARGETS (a `cd`
 * into a worktree, or the payload cwd) instead of only the hook's own cwd — so
 * git-diff enforcers reason about the worktree branch on `cd worktree && git ...`
 * compound commands. Regression for the expert-review "wrong branch" misfire.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
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
  const hooks = globSync('**/uap-policy-gate.sh', { cwd: ROOT, dot: true, ignore: ['**/node_modules/**'] });

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

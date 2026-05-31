/**
 * Worktree file guard — fail-closed in bare repos
 *
 * Regression test for the fail-open bug: in a bare repository (this project's
 * layout) `git rev-parse --show-toplevel` returns empty, and the guard used to
 * `exit 0` (allow) for every path — silently disabling worktree enforcement.
 * The fix falls back to a hook-derived project root and fails CLOSED.
 *
 * Each case runs the real hook from templates/hooks via spawnSync with cwd set
 * to a NON-git temp dir, so `git rev-parse` returns empty and the fallback
 * path is exercised deterministically.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const HOOK_SRC = join(process.cwd(), 'templates', 'hooks', 'pre-tool-use-edit-write.sh');
const LOOP_SRC = join(process.cwd(), 'templates', 'hooks', 'loop-protection.sh');

function runGuard(proj: string, filePath: string): number {
  const hook = join(proj, '.factory', 'hooks', 'pre-tool-use-edit-write.sh');
  const res = spawnSync('bash', [hook], {
    input: JSON.stringify({ tool_input: { file_path: filePath } }),
    cwd: proj, // non-git dir → git rev-parse --show-toplevel is empty → fallback
    encoding: 'utf8',
  });
  return res.status ?? -1;
}

describe('worktree file guard: fail-closed in bare/non-git context', () => {
  let proj: string;
  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), 'uap-wtguard-'));
    mkdirSync(join(proj, '.factory', 'hooks'), { recursive: true });
    mkdirSync(join(proj, 'src'), { recursive: true });
    mkdirSync(join(proj, '.worktrees', 'n', 'src'), { recursive: true });
    copyFileSync(HOOK_SRC, join(proj, '.factory', 'hooks', 'pre-tool-use-edit-write.sh'));
    if (existsSync(LOOP_SRC)) {
      copyFileSync(LOOP_SRC, join(proj, '.factory', 'hooks', 'loop-protection.sh'));
    }
  });
  afterEach(() => rmSync(proj, { recursive: true, force: true }));

  it('BLOCKS an in-repo root edit when git rev-parse is empty (was fail-open)', () => {
    expect(runGuard(proj, join(proj, 'src', 'x.ts'))).toBe(2);
  });

  it('ALLOWS edits inside a .worktrees/ path', () => {
    expect(runGuard(proj, join(proj, '.worktrees', 'n', 'src', 'x.ts'))).toBe(0);
  });

  it('ALLOWS exempt runtime paths (node_modules) and out-of-repo files', () => {
    expect(runGuard(proj, join(proj, 'node_modules', 'y.js'))).toBe(0);
    expect(runGuard(proj, '/etc/passwd')).toBe(0);
  });
});

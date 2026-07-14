/**
 * Task workspaces (worktree-isolated parallel dispatch): baseline seeding from
 * a DIRTY main tree, delta-only merge-back, conflict surfacing, and cleanup.
 * Uses real temp git repos — this module is pure git orchestration.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTaskWorkspaceManager, resolveParallelTasks } from '../../src/delivery/task-workspace.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    ...(input !== undefined ? { input } : {}),
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined },
  });
}

/** Fresh repo with one committed file, a modified file, an untracked file, and a deleted file. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'uap-ws-repo-'));
  dirs.push(dir);
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);
  writeFileSync(join(dir, 'committed.txt'), 'committed v1\n');
  writeFileSync(join(dir, 'will-modify.txt'), 'original\n');
  writeFileSync(join(dir, 'will-delete.txt'), 'doomed\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'baseline']);
  return dir;
}

describe('resolveParallelTasks', () => {
  it('clamps to [1, 8] and treats garbage as sequential', () => {
    expect(resolveParallelTasks(undefined)).toBe(1);
    expect(resolveParallelTasks('nope')).toBe(1);
    expect(resolveParallelTasks(0)).toBe(1);
    expect(resolveParallelTasks(1)).toBe(1);
    expect(resolveParallelTasks(3)).toBe(3);
    expect(resolveParallelTasks('4')).toBe(4);
    expect(resolveParallelTasks(99)).toBe(8);
  });
});

describe('createTaskWorkspaceManager', () => {
  it('returns null outside a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-ws-nogit-'));
    dirs.push(dir);
    expect(createTaskWorkspaceManager(dir)).toBeNull();
  });

  it('seeds the workspace with the main tree\'s DIRTY state and freezes a clean baseline', () => {
    const repo = makeRepo();
    // Dirty the tree the way a mid-mission tree looks: modified + untracked + deleted.
    writeFileSync(join(repo, 'will-modify.txt'), 'changed by earlier task\n');
    writeFileSync(join(repo, 'untracked-new.txt'), 'from an earlier merged task\n');
    rmSync(join(repo, 'will-delete.txt'));

    const ws = createTaskWorkspaceManager(repo)!.acquire('t1');
    expect(ws).not.toBeNull();
    try {
      expect(readFileSync(join(ws!.root, 'committed.txt'), 'utf-8')).toBe('committed v1\n');
      expect(readFileSync(join(ws!.root, 'will-modify.txt'), 'utf-8')).toBe('changed by earlier task\n');
      expect(readFileSync(join(ws!.root, 'untracked-new.txt'), 'utf-8')).toBe('from an earlier merged task\n');
      expect(existsSync(join(ws!.root, 'will-delete.txt'))).toBe(false);
      // Baseline frozen: the seeded state is committed, so the worktree starts clean.
      expect(git(ws!.root, ['status', '--porcelain']).trim()).toBe('');
    } finally {
      ws!.cleanup();
    }
  });

  it('merges back ONLY the task delta, preserving the main tree\'s other dirty state', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'will-modify.txt'), 'pre-existing dirty state\n');
    const ws = createTaskWorkspaceManager(repo)!.acquire('t1');
    try {
      // The task's own work: a new module + an edit to a committed file.
      mkdirSync(join(ws!.root, 'srcx'));
      writeFileSync(join(ws!.root, 'srcx', 'feature.js'), 'export const x = 1;\n');
      writeFileSync(join(ws!.root, 'committed.txt'), 'committed v2 (task edit)\n');

      const merged = ws!.mergeBack();
      expect(merged.ok).toBe(true);
      expect(merged.files.sort()).toEqual(['committed.txt', 'srcx/feature.js']);
      expect(readFileSync(join(repo, 'srcx', 'feature.js'), 'utf-8')).toBe('export const x = 1;\n');
      expect(readFileSync(join(repo, 'committed.txt'), 'utf-8')).toBe('committed v2 (task edit)\n');
      // The baseline sync itself did NOT travel back as a change.
      expect(readFileSync(join(repo, 'will-modify.txt'), 'utf-8')).toBe('pre-existing dirty state\n');
    } finally {
      ws!.cleanup();
    }
  });

  it('reports a merge CONFLICT instead of corrupting the main tree', () => {
    const repo = makeRepo();
    const ws = createTaskWorkspaceManager(repo)!.acquire('t1');
    try {
      // Task and main tree diverge on the same file after acquisition
      // (i.e. a parallel sibling merged first).
      writeFileSync(join(ws!.root, 'committed.txt'), 'task version\n');
      writeFileSync(join(repo, 'committed.txt'), 'sibling version\n');
      const merged = ws!.mergeBack();
      expect(merged.ok).toBe(false);
      expect(merged.reason).toBeTruthy();
      // Main tree keeps the sibling's version — nothing half-applied.
      expect(readFileSync(join(repo, 'committed.txt'), 'utf-8')).toBe('sibling version\n');
    } finally {
      ws!.cleanup();
    }
  });

  it('a later workspace sees an earlier task\'s merged (uncommitted) output', () => {
    const repo = makeRepo();
    const manager = createTaskWorkspaceManager(repo)!;
    const ws1 = manager.acquire('t1')!;
    try {
      writeFileSync(join(ws1.root, 'built-by-t1.txt'), 'interface v1\n');
      expect(ws1.mergeBack().ok).toBe(true);
    } finally {
      ws1.cleanup();
    }
    const ws2 = manager.acquire('t2')!;
    try {
      // Wave-2 baseline includes wave-1's merged output despite it being
      // uncommitted in the main tree — the whole point of the state sync.
      expect(readFileSync(join(ws2.root, 'built-by-t1.txt'), 'utf-8')).toBe('interface v1\n');
    } finally {
      ws2.cleanup();
    }
  });

  it('merges onto a main-tree file that is UNSTAGED-MODIFIED (the core wave-2 state)', () => {
    // Regression for the --3way-implies-index trap: after wave 1, merged
    // files sit modified-unstaged in the main tree; wave-2 deltas onto them
    // must still apply.
    const repo = makeRepo();
    const manager = createTaskWorkspaceManager(repo)!;
    // Simulate wave 1: file dirty-unstaged in main.
    writeFileSync(join(repo, 'committed.txt'), 'wave-1 output\n');
    const ws = manager.acquire('t2')!;
    try {
      // Wave-2 task modifies that same (seeded) file.
      writeFileSync(join(ws.root, 'committed.txt'), 'wave-1 output\nwave-2 addition\n');
      const merged = ws.mergeBack();
      expect(merged.ok).toBe(true);
      expect(readFileSync(join(repo, 'committed.txt'), 'utf-8')).toBe('wave-1 output\nwave-2 addition\n');
      // Nothing left staged behind the mission's back.
      expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe('');
    } finally {
      ws.cleanup();
    }
  });

  it('merges a modification to a file that is UNTRACKED in the main tree', () => {
    const repo = makeRepo();
    const manager = createTaskWorkspaceManager(repo)!;
    writeFileSync(join(repo, 'untracked-target.txt'), 'v1\n'); // e.g. created by an earlier merge
    const ws = manager.acquire('t2')!;
    try {
      writeFileSync(join(ws.root, 'untracked-target.txt'), 'v2\n');
      const merged = ws.mergeBack();
      expect(merged.ok).toBe(true);
      expect(readFileSync(join(repo, 'untracked-target.txt'), 'utf-8')).toBe('v2\n');
      expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe('');
    } finally {
      ws.cleanup();
    }
  });

  it('mirrors a STAGED deletion (git rm) — the workspace must not resurrect the file', () => {
    const repo = makeRepo();
    git(repo, ['rm', '-q', 'will-delete.txt']);
    const ws = createTaskWorkspaceManager(repo)!.acquire('t1')!;
    try {
      expect(existsSync(join(ws.root, 'will-delete.txt'))).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  it('seeds STAGED modifications and preserves the user\'s index through a merge', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'will-modify.txt'), 'staged change\n');
    git(repo, ['add', 'will-modify.txt']);
    const ws = createTaskWorkspaceManager(repo)!.acquire('t1')!;
    try {
      expect(readFileSync(join(ws.root, 'will-modify.txt'), 'utf-8')).toBe('staged change\n');
      writeFileSync(join(ws.root, 'task-file.txt'), 'task output\n');
      expect(ws.mergeBack().ok).toBe(true);
      // The user's own staged entry survives the merge untouched.
      expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe('will-modify.txt');
    } finally {
      ws.cleanup();
    }
  });

  it('REFUSES a delta touching a blocked (protected) file', () => {
    const repo = makeRepo();
    const ws = createTaskWorkspaceManager(repo)!.acquire('t1')!;
    try {
      writeFileSync(join(ws.root, 'committed.txt'), 'tampered\n');
      const merged = ws.mergeBack((f) => f === 'committed.txt');
      expect(merged.ok).toBe(false);
      expect(merged.reason).toContain('protected');
      expect(readFileSync(join(repo, 'committed.txt'), 'utf-8')).toBe('committed v1\n'); // untouched
    } finally {
      ws.cleanup();
    }
  });

  it('round-trips a BINARY file through seed and merge-back', () => {
    const repo = makeRepo();
    const bin = Buffer.from([0, 1, 2, 3, 255, 254, 0, 128, 10, 13, 0]);
    const ws = createTaskWorkspaceManager(repo)!.acquire('t1')!;
    try {
      writeFileSync(join(ws.root, 'asset.bin'), bin);
      expect(ws.mergeBack().ok).toBe(true);
      expect(readFileSync(join(repo, 'asset.bin'))).toEqual(bin);
    } finally {
      ws.cleanup();
    }
  });

  it('returns null on an unborn-HEAD repo (nothing to baseline)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-ws-unborn-'));
    dirs.push(dir);
    git(dir, ['init', '-b', 'main']);
    expect(createTaskWorkspaceManager(dir)).toBeNull();
  });

  it('a conflict reason carries actionable git detail', () => {
    const repo = makeRepo();
    const ws = createTaskWorkspaceManager(repo)!.acquire('t1')!;
    try {
      writeFileSync(join(ws.root, 'committed.txt'), 'task version\n');
      writeFileSync(join(repo, 'committed.txt'), 'sibling version\n');
      const merged = ws.mergeBack();
      expect(merged.ok).toBe(false);
      expect(merged.reason ?? '').toMatch(/apply|patch|conflict|merge/i);
    } finally {
      ws.cleanup();
    }
  });

  it('cleanup removes the worktree registration', () => {
    const repo = makeRepo();
    const manager = createTaskWorkspaceManager(repo)!;
    const before = git(repo, ['worktree', 'list']).trim().split('\n').length;
    const ws = manager.acquire('t1')!;
    expect(git(repo, ['worktree', 'list']).trim().split('\n').length).toBe(before + 1);
    ws.cleanup();
    expect(git(repo, ['worktree', 'list']).trim().split('\n').length).toBe(before);
  });
});

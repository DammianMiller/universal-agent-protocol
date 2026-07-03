/**
 * Git-worktree candidate workspaces: real isolation on a clean repo, and
 * conservative null on dirty/non-git trees.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createGitWorktreeProvider } from '../../src/delivery/candidate-workspace.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('createGitWorktreeProvider', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'uap-wsrepo-'));
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 't@t']);
    git(repo, ['config', 'user.name', 't']);
    writeFileSync(join(repo, 'a.txt'), 'base');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'base']);
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('provides an isolated worktree of HEAD; writes there never touch the main tree', () => {
    const provider = createGitWorktreeProvider(repo);
    expect(provider).not.toBeNull();
    const ws = provider!();
    expect(ws).not.toBeNull();
    try {
      expect(readFileSync(join(ws!.root, 'a.txt'), 'utf-8')).toBe('base');
      writeFileSync(join(ws!.root, 'candidate.txt'), 'isolated');
      expect(existsSync(join(repo, 'candidate.txt'))).toBe(false);
    } finally {
      ws!.cleanup();
    }
    expect(existsSync(ws!.root)).toBe(false);
  });

  it('returns null for a dirty tree and for a non-git directory', () => {
    writeFileSync(join(repo, 'dirty.txt'), 'x');
    expect(createGitWorktreeProvider(repo)).toBeNull();

    const plain = mkdtempSync(join(tmpdir(), 'uap-plain-'));
    try {
      expect(createGitWorktreeProvider(plain)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('honors the env kill-switch', () => {
    process.env.UAP_DELIVER_PARALLEL_EXPLORE = '0';
    try {
      expect(createGitWorktreeProvider(repo)).toBeNull();
    } finally {
      delete process.env.UAP_DELIVER_PARALLEL_EXPLORE;
    }
  });
});

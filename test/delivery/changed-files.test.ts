/**
 * Changed-file discovery (extracted from deliver.ts): porcelain -z parsing —
 * especially the rename/copy old-path token that the old inline parser
 * mangled into a corrupt pathspec — and the .uap/ exclusion, against a real
 * temp git repo.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { changedFiles, parsePorcelainZ } from '../../src/delivery/changed-files.js';

describe('parsePorcelainZ', () => {
  it('parses ordinary modified/untracked entries', () => {
    expect(parsePorcelainZ(' M src/a.ts\0?? new.ts\0')).toEqual(['src/a.ts', 'new.ts']);
  });

  it('a RENAME contributes its NEW path only — the old-path token is consumed, not mangled', () => {
    const out = 'R  src/new-name.ts\0src/old-name.ts\0 M other.ts\0';
    expect(parsePorcelainZ(out)).toEqual(['src/new-name.ts', 'other.ts']);
  });

  it('handles copies and index-side renames the same way', () => {
    expect(parsePorcelainZ('C  copy.ts\0orig.ts\0')).toEqual(['copy.ts']);
  });

  it('empty input parses to nothing', () => {
    expect(parsePorcelainZ('')).toEqual([]);
    expect(parsePorcelainZ('\0')).toEqual([]);
  });
});

describe('changedFiles (real git)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function git(cwd: string, args: string[]): void {
    execFileSync('git', args, {
      cwd,
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined },
    });
  }

  it('reports a staged rename by its new path and excludes .uap/ state', () => {
    const repo = mkdtempSync(join(tmpdir(), 'uap-cf-'));
    dirs.push(repo);
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.email', 't@t']);
    git(repo, ['config', 'user.name', 't']);
    writeFileSync(join(repo, 'keep.ts'), 'v1\n');
    writeFileSync(join(repo, 'old-name.ts'), 'content\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'base']);

    git(repo, ['mv', 'old-name.ts', 'new-name.ts']); // staged rename
    writeFileSync(join(repo, 'keep.ts'), 'v2\n'); // modified
    mkdirSync(join(repo, '.uap'), { recursive: true });
    writeFileSync(join(repo, '.uap', 'state.json'), '{}'); // harness state

    const files = changedFiles(repo);
    expect(files).toContain('new-name.ts');
    expect(files).toContain('keep.ts');
    expect(files).not.toContain('old-name.ts'); // consumed, never mangled
    expect(files.some((f) => f.startsWith('.uap'))).toBe(false);
    // every reported path is a valid pathspec for git add
    git(repo, ['add', '--', ...files]);
  });

  it('fails soft to [] off-git', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-cf-nogit-'));
    dirs.push(dir);
    expect(changedFiles(dir)).toEqual([]);
  });
});

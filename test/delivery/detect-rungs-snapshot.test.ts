import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { detectRungs, detectNonNpmRungs } from '../../src/delivery/verifier-ladder.js';
import { snapshotTree, restoreTree, disposeSnapshot } from '../../src/delivery/snapshot.js';

describe('detectRungs — non-npm gates', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rungs-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('detects a Makefile test target', () => {
    writeFileSync(join(dir, 'Makefile'), 'test:\n\techo ok\n');
    const r = detectNonNpmRungs(dir);
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('make');
    expect(r[0].args).toEqual(['test']);
    expect(r[0].required).toBe(true);
  });

  it('falls back to default make goal when no test/check target', () => {
    writeFileSync(join(dir, 'Makefile'), 'all:\n\tgcc -o x x.c\n');
    expect(detectNonNpmRungs(dir)[0].args).toEqual([]);
  });

  it('detects pytest only when test files exist', () => {
    expect(detectNonNpmRungs(dir)).toHaveLength(0); // empty → nothing
    mkdirSync(join(dir, 'tests'));
    expect(detectNonNpmRungs(dir)[0].id).toBe('pytest');
  });

  it('detects a conventional shell test script', () => {
    writeFileSync(join(dir, 'run_tests.sh'), '#!/bin/bash\nexit 0\n');
    const r = detectNonNpmRungs(dir);
    expect(r[0].id).toBe('script');
    expect(r[0].args).toEqual(['run_tests.sh']);
  });

  it('detectRungs returns [] for a project with no package.json and no real gates', () => {
    expect(detectRungs(dir)).toEqual([]);
  });
});

describe('snapshot tree round-trip', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'snap-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('restores modified/added/deleted files to the snapshot state', () => {
    writeFileSync(join(dir, 'keep.txt'), 'original');
    writeFileSync(join(dir, 'gone-later.txt'), 'will-be-deleted');
    const snap = snapshotTree(dir);

    // Mutate after snapshot: change, delete, and add files.
    writeFileSync(join(dir, 'keep.txt'), 'CHANGED');
    rmSync(join(dir, 'gone-later.txt'));
    writeFileSync(join(dir, 'new-junk.txt'), 'should-be-removed');

    restoreTree(dir, snap);

    expect(readFileSync(join(dir, 'keep.txt'), 'utf-8')).toBe('original');
    expect(existsSync(join(dir, 'gone-later.txt'))).toBe(true);
    expect(existsSync(join(dir, 'new-junk.txt'))).toBe(false);
    disposeSnapshot(snap);
    expect(existsSync(snap)).toBe(false);
  });

  it('excludes .git and node_modules from the snapshot', () => {
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref');
    writeFileSync(join(dir, 'src.txt'), 'code');
    const snap = snapshotTree(dir);
    expect(existsSync(join(snap, 'src.txt'))).toBe(true);
    expect(existsSync(join(snap, '.git'))).toBe(false);
    disposeSnapshot(snap);
  });
});

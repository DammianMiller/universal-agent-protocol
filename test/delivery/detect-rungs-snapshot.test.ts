import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  existsSync,
  chmodSync,
  utimesSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { detectRungs, detectNonNpmRungs } from '../../src/delivery/verifier-ladder.js';
import {
  snapshotTree,
  restoreTree,
  disposeSnapshot,
  reapStaleSnapshots,
  snapshotBaseDir,
} from '../../src/delivery/snapshot.js';

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
  let snapBase: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'snap-'));
    snapBase = mkdtempSync(join(tmpdir(), 'snapbase-'));
    process.env.UAP_SNAPSHOT_DIR = snapBase;
    // Keep the suite from sweeping the machine's real /tmp for legacy snapshots.
    process.env.UAP_SNAPSHOT_SKIP_TMP_SWEEP = '1';
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(snapBase, { recursive: true, force: true });
    delete process.env.UAP_SNAPSHOT_DIR;
    delete process.env.UAP_SNAPSHOT_MAX_MB;
    delete process.env.UAP_SNAPSHOT_SKIP_TMP_SWEEP;
  });

  it('restores modified/added/deleted files to the snapshot state', () => {
    writeFileSync(join(dir, 'keep.txt'), 'original');
    writeFileSync(join(dir, 'gone-later.txt'), 'will-be-deleted');
    const snap = snapshotTree(dir);
    expect(snap).not.toBeNull();

    // Mutate after snapshot: change, delete, and add files.
    writeFileSync(join(dir, 'keep.txt'), 'CHANGED');
    rmSync(join(dir, 'gone-later.txt'));
    writeFileSync(join(dir, 'new-junk.txt'), 'should-be-removed');

    restoreTree(dir, snap!);

    expect(readFileSync(join(dir, 'keep.txt'), 'utf-8')).toBe('original');
    expect(existsSync(join(dir, 'gone-later.txt'))).toBe(true);
    expect(existsSync(join(dir, 'new-junk.txt'))).toBe(false);
    // The snapshot's pid marker must not be restored into the project tree.
    expect(existsSync(join(dir, '.uap-snap.json'))).toBe(false);
    disposeSnapshot(snap!);
    expect(existsSync(snap!)).toBe(false);
  });

  it('excludes .git and node_modules from the snapshot', () => {
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref');
    writeFileSync(join(dir, 'src.txt'), 'code');
    const snap = snapshotTree(dir)!;
    expect(existsSync(join(snap, 'src.txt'))).toBe(true);
    expect(existsSync(join(snap, '.git'))).toBe(false);
    disposeSnapshot(snap);
  });

  it('excludes derived build trees (target, __pycache__, .venv, dist) at any depth', () => {
    mkdirSync(join(dir, 'target', 'debug'), { recursive: true });
    writeFileSync(join(dir, 'target', 'debug', 'huge.bin'), 'artifacts');
    mkdirSync(join(dir, 'pkg', '__pycache__'), { recursive: true });
    writeFileSync(join(dir, 'pkg', '__pycache__', 'mod.pyc'), 'bytecode');
    mkdirSync(join(dir, '.venv'));
    writeFileSync(join(dir, '.venv', 'pyvenv.cfg'), 'venv');
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'bundle.js'), 'built');
    writeFileSync(join(dir, 'pkg', 'mod.py'), 'source');

    const snap = snapshotTree(dir)!;
    expect(existsSync(join(snap, 'pkg', 'mod.py'))).toBe(true);
    expect(existsSync(join(snap, 'target'))).toBe(false);
    expect(existsSync(join(snap, 'pkg', '__pycache__'))).toBe(false);
    expect(existsSync(join(snap, '.venv'))).toBe(false);
    expect(existsSync(join(snap, 'dist'))).toBe(false);
    disposeSnapshot(snap);
  });

  it('snapshots land under the configured base dir, not os.tmpdir()', () => {
    writeFileSync(join(dir, 'a.txt'), 'x');
    const snap = snapshotTree(dir)!;
    expect(snap.startsWith(snapBase)).toBe(true);
    disposeSnapshot(snap);
  });

  it('returns null (and leaks nothing) when the tree exceeds UAP_SNAPSHOT_MAX_MB', () => {
    process.env.UAP_SNAPSHOT_MAX_MB = '1';
    writeFileSync(join(dir, 'big.bin'), Buffer.alloc(2 * 1024 * 1024));
    expect(snapshotTree(dir)).toBeNull();
    expect(readdirSync(snapBase).filter((n) => n.startsWith('uap-snap-'))).toHaveLength(0);
  });

  it('returns null and removes the partial snapshot when the copy fails', () => {
    if (process.getuid?.() === 0) return; // root ignores file modes — cannot force EACCES
    writeFileSync(join(dir, 'ok.txt'), 'fine');
    writeFileSync(join(dir, 'locked.txt'), 'secret');
    chmodSync(join(dir, 'locked.txt'), 0o000);
    try {
      expect(snapshotTree(dir)).toBeNull();
      expect(readdirSync(snapBase).filter((n) => n.startsWith('uap-snap-'))).toHaveLength(0);
    } finally {
      chmodSync(join(dir, 'locked.txt'), 0o644);
    }
  });

  it('preserves nested excluded dirs through a restore while rolling back nested source', () => {
    mkdirSync(join(dir, 'packages', 'app', 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'app', 'node_modules', 'dep', 'index.js'), 'installed');
    writeFileSync(join(dir, 'packages', 'app', 'main.ts'), 'original');
    const snap = snapshotTree(dir)!;

    writeFileSync(join(dir, 'packages', 'app', 'main.ts'), 'REGRESSED');
    restoreTree(dir, snap);

    expect(readFileSync(join(dir, 'packages', 'app', 'main.ts'), 'utf-8')).toBe('original');
    // The nested node_modules was neither snapshotted nor deleted.
    expect(existsSync(join(dir, 'packages', 'app', 'node_modules', 'dep', 'index.js'))).toBe(true);
    expect(existsSync(join(snap, 'packages', 'app', 'node_modules'))).toBe(false);
    disposeSnapshot(snap);
  });

  it('snapshots normally when the project root itself is named like an excluded dir', () => {
    const buildRoot = join(dir, 'build');
    mkdirSync(buildRoot);
    writeFileSync(join(buildRoot, 'src.txt'), 'code');
    const snap = snapshotTree(buildRoot)!;
    expect(existsSync(join(snap, 'src.txt'))).toBe(true);
    disposeSnapshot(snap);
  });

  it('excludes only directories, not files sharing an excluded name', () => {
    writeFileSync(join(dir, 'build'), '#!/bin/sh\nmake');
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'bundle.js'), 'derived');
    const snap = snapshotTree(dir)!;
    expect(existsSync(join(snap, 'build'))).toBe(true);
    expect(existsSync(join(snap, 'dist'))).toBe(false);
    disposeSnapshot(snap);
  });

  it('refuses to restore from a missing or marker-less snapshot, leaving the tree untouched', () => {
    writeFileSync(join(dir, 'precious.txt'), 'data');
    const snap = snapshotTree(dir)!;
    rmSync(join(snap, '.uap-snap.json'));
    expect(() => restoreTree(dir, snap)).toThrow(/missing .uap-snap.json/);
    expect(() => restoreTree(dir, join(snapBase, 'uap-snap-gone'))).toThrow();
    expect(readFileSync(join(dir, 'precious.txt'), 'utf-8')).toBe('data');
    disposeSnapshot(snap);
  });

  it('never reaps a snapshot marked preserve, even with a dead pid', () => {
    const base = snapshotBaseDir();
    const preserved = join(base, 'uap-snap-preserved');
    mkdirSync(preserved);
    writeFileSync(join(preserved, '.uap-snap.json'), JSON.stringify({ pid: 2 ** 30, preserve: true }));
    reapStaleSnapshots();
    expect(existsSync(preserved)).toBe(true);
  });

  it('reaps snapshots owned by dead pids and marker-less dirs older than 24h, keeps live ones', () => {
    const base = snapshotBaseDir();
    const dead = join(base, 'uap-snap-dead');
    mkdirSync(dead);
    writeFileSync(join(dead, '.uap-snap.json'), JSON.stringify({ pid: 2 ** 30 }));
    const live = join(base, 'uap-snap-live');
    mkdirSync(live);
    writeFileSync(join(live, '.uap-snap.json'), JSON.stringify({ pid: process.pid }));
    const legacyOld = join(base, 'uap-snap-legacy');
    mkdirSync(legacyOld);
    const twoDaysAgo = (Date.now() - 48 * 60 * 60 * 1000) / 1000;
    utimesSync(legacyOld, twoDaysAgo, twoDaysAgo);
    const legacyFresh = join(base, 'uap-snap-fresh');
    mkdirSync(legacyFresh);

    reapStaleSnapshots();

    expect(existsSync(dead)).toBe(false);
    expect(existsSync(legacyOld)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(legacyFresh)).toBe(true);
  });
});

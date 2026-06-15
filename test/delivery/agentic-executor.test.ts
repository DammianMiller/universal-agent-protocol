import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, sep } from 'path';
import {
  selectExecutorMode,
  protectedKey,
  noopApplier,
} from '../../src/delivery/agentic-executor.js';

describe('selectExecutorMode', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agx-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('honors explicit blind / agentic regardless of context', () => {
    expect(selectExecutorMode('blind', dir, true)).toBe('blind');
    expect(selectExecutorMode('agentic', dir, false)).toBe('agentic');
  });

  it('auto → agentic when gates exist', () => {
    expect(selectExecutorMode('auto', dir, true)).toBe('agentic');
  });

  it('auto → agentic when the project has inspectable content', () => {
    writeFileSync(join(dir, 'main.py'), 'print(1)\n');
    expect(selectExecutorMode('auto', dir, false)).toBe('agentic');
  });

  it('auto → blind for an empty/scaffold-only project with no gates', () => {
    writeFileSync(join(dir, 'package.json'), '{}'); // scaffolding is ignored
    expect(selectExecutorMode('auto', dir, false)).toBe('blind');
  });
});

describe('protectedKey', () => {
  it('normalizes to lowercase forward-slash relative path', () => {
    const root = `${sep}proj`;
    expect(protectedKey(root, `${sep}proj${sep}Tests${sep}Spec.TS`)).toBe('tests/spec.ts');
  });
});

describe('noopApplier', () => {
  it('reports nothing applied and no error (success, not "no blocks found")', async () => {
    const r = await noopApplier();
    expect(r.filesWritten).toEqual([]);
    expect(r.rejected).toEqual([]);
    expect(r.error).toBeUndefined();
  });
});

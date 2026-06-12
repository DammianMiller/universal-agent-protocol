import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  applyFileBlocks,
  applyFileBlocksWithRollback,
  findProtectedTestFiles,
  isTestFilePath,
} from '../../src/delivery/applier.js';
import { exploreAndCommit } from '../../src/delivery/explorer.js';
import { ConvergenceLoop, defaultPromptBuilder } from '../../src/delivery/convergence-loop.js';
import type { LadderResult } from '../../src/delivery/verifier-ladder.js';

const block = (path: string, content: string): string =>
  ['```file:' + path, content, '```'].join('\n');

describe('isTestFilePath', () => {
  it.each([
    'test/foo.mjs',
    'tests/deep/bar.js',
    'src/__tests__/baz.ts',
    'spec/widget.rb',
    'src/util.test.ts',
    'src/util.spec.js',
    'pkg/util_test.go',
    'test_models.py',
  ])('recognizes %s', (p) => {
    expect(isTestFilePath(p)).toBe(true);
  });

  it.each(['src/index.ts', 'src/testing-utils.ts', 'contest/entry.js', 'attest.md', 'src/latest.js'])(
    'does not flag %s',
    (p) => {
      expect(isTestFilePath(p)).toBe(false);
    }
  );
});

describe('findProtectedTestFiles', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'protect-find-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds test files by directory and by basename, skipping node_modules and symlinks', () => {
    mkdirSync(join(dir, 'test'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'pkg', 'test'), { recursive: true });
    writeFileSync(join(dir, 'test', 'a.test.mjs'), '');
    writeFileSync(join(dir, 'src', 'b.spec.ts'), '');
    writeFileSync(join(dir, 'src', 'index.ts'), '');
    writeFileSync(join(dir, 'node_modules', 'pkg', 'test', 'c.test.js'), '');
    symlinkSync(join(dir, 'test', 'a.test.mjs'), join(dir, 'test', 'link.test.mjs'));

    const found = findProtectedTestFiles(dir);
    expect(found).toEqual(new Set(['test/a.test.mjs', 'src/b.spec.ts']));
  });

  it('returns an empty set for a project without tests', () => {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'index.ts'), '');
    expect(findProtectedTestFiles(dir).size).toBe(0);
  });
});

describe('applyFileBlocks with protectedFiles', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'protect-apply-'));
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'test', 'spec.test.mjs'), 'ORIGINAL');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects writes to a protected pre-existing test file and keeps its content', () => {
    const protectedFiles = findProtectedTestFiles(dir);
    const result = applyFileBlocks(
      [block('test/spec.test.mjs', 'GUTTED'), block('src/impl.mjs', 'export const x = 1;')].join('\n'),
      dir,
      { protectedFiles }
    );
    expect(result.filesWritten).toEqual(['src/impl.mjs']);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].path).toBe('test/spec.test.mjs');
    expect(result.rejected[0].reason).toContain('pre-existing test file is protected');
    expect(readFileSync(join(dir, 'test', 'spec.test.mjs'), 'utf-8')).toBe('ORIGINAL');
  });

  it('normalizes traversal-style paths to the protected entry', () => {
    const protectedFiles = findProtectedTestFiles(dir);
    const result = applyFileBlocks(block('src/../test/spec.test.mjs', 'GUTTED'), dir, {
      protectedFiles,
    });
    expect(result.filesWritten).toEqual([]);
    expect(readFileSync(join(dir, 'test', 'spec.test.mjs'), 'utf-8')).toBe('ORIGINAL');
  });

  it('still allows creating NEW test files', () => {
    const protectedFiles = findProtectedTestFiles(dir);
    const result = applyFileBlocks(block('test/new.test.mjs', 'NEW'), dir, { protectedFiles });
    expect(result.filesWritten).toEqual(['test/new.test.mjs']);
  });

  it('is unrestricted when no protectedFiles are passed (back-compat)', () => {
    const result = applyFileBlocks(block('test/spec.test.mjs', 'CHANGED'), dir);
    expect(result.filesWritten).toEqual(['test/spec.test.mjs']);
  });

  it('applyFileBlocksWithRollback never snapshots or writes protected files', () => {
    const protectedFiles = findProtectedTestFiles(dir);
    const { result, restore } = applyFileBlocksWithRollback(
      block('test/spec.test.mjs', 'GUTTED'),
      dir,
      { protectedFiles }
    );
    expect(result.filesWritten).toEqual([]);
    expect(result.rejected[0].reason).toContain('protected');
    expect(readFileSync(join(dir, 'test', 'spec.test.mjs'), 'utf-8')).toBe('ORIGINAL');
    restore();
    expect(readFileSync(join(dir, 'test', 'spec.test.mjs'), 'utf-8')).toBe('ORIGINAL');
  });
});

describe('hardening: bypass vectors', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'protect-bypass-'));
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'test', 'spec.test.mjs'), 'ORIGINAL');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects case-variant paths to a protected file (case-insensitive FS defense)', () => {
    const protectedFiles = findProtectedTestFiles(dir);
    const result = applyFileBlocks(block('TEST/Spec.TEST.mjs', 'GUTTED'), dir, { protectedFiles });
    expect(result.filesWritten).toEqual([]);
    expect(result.rejected[0].reason).toContain('protected');
  });

  it('rejects an intra-repo directory-symlink alias of a protected file', () => {
    symlinkSync(join(dir, 'test'), join(dir, 'tests_alias'));
    const protectedFiles = findProtectedTestFiles(dir);
    const result = applyFileBlocks(block('tests_alias/spec.test.mjs', 'GUTTED'), dir, {
      protectedFiles,
    });
    expect(result.filesWritten).toEqual([]);
    expect(readFileSync(join(dir, 'test', 'spec.test.mjs'), 'utf-8')).toBe('ORIGINAL');
  });

  it('rejects test-runner/compiler config writes when protectGateConfigs is set', () => {
    const result = applyFileBlocks(
      [
        block('vitest.config.ts', 'export default { test: { include: [] } };'),
        block('tsconfig.json', '{}'),
        block('deep/jest.config.js', 'module.exports = {};'),
        block('src/ok.mjs', 'ok'),
      ].join('\n'),
      dir,
      { protectGateConfigs: true }
    );
    expect(result.filesWritten).toEqual(['src/ok.mjs']);
    expect(result.rejected).toHaveLength(3);
    for (const r of result.rejected) {
      expect(r.reason).toContain('control the gates');
    }
  });

  it('allows config writes when protection is off', () => {
    const result = applyFileBlocks(block('vitest.config.ts', 'x'), dir);
    expect(result.filesWritten).toEqual(['vitest.config.ts']);
  });

  it('protects fixtures living under a test directory', () => {
    writeFileSync(join(dir, 'test', 'fixture.json'), '{"expected": 1}');
    const protectedFiles = findProtectedTestFiles(dir);
    const result = applyFileBlocks(block('test/fixture.json', '{"expected": 999}'), dir, {
      protectedFiles,
    });
    expect(result.filesWritten).toEqual([]);
  });

  it('recognizes vitest type-test basenames (.test-d.ts)', () => {
    expect(isTestFilePath('src/types.test-d.ts')).toBe(true);
  });
});

describe('multi-turn semantics: model-created tests stay editable', () => {
  it('a test file created on turn 1 can be modified on turn 2', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'protect-turns-'));
    try {
      mkdirSync(join(dir, 'test'), { recursive: true });
      writeFileSync(join(dir, 'test', 'spec.test.mjs'), 'ORIGINAL');
      let turn = 0;
      const loop = new ConvergenceLoop(
        {
          projectRoot: dir,
          rungs: [{ id: 'g', name: 'gate', command: 'true', required: true }],
          maxTurns: 2,
          baselineCheck: false,
        },
        async () => {
          turn += 1;
          return turn === 1
            ? block('test/new.test.mjs', 'V1')
            : block('test/new.test.mjs', 'V2');
        },
        {
          ladderRunner: () =>
            turn < 2
              ? { passed: false, score: 0, results: [], feedback: 'red' }
              : { passed: true, score: 1, results: [], feedback: '' },
        }
      );
      const result = await loop.deliver('task');
      expect(result.success).toBe(true);
      expect(result.history[0].filesApplied).toEqual(['test/new.test.mjs']);
      expect(result.history[1].filesApplied).toEqual(['test/new.test.mjs']);
      expect(readFileSync(join(dir, 'test', 'new.test.mjs'), 'utf-8')).toBe('V2\n');
      expect(readFileSync(join(dir, 'test', 'spec.test.mjs'), 'utf-8')).toBe('ORIGINAL');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('explorer applyOptions passthrough', () => {
  it('protects pre-existing tests during candidate evaluation and commit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'protect-explore-'));
    try {
      mkdirSync(join(dir, 'test'), { recursive: true });
      writeFileSync(join(dir, 'test', 'spec.test.mjs'), 'ORIGINAL');
      const protectedFiles = findProtectedTestFiles(dir);

      const ladder: LadderResult = {
        passed: true,
        score: 1,
        results: [],
        feedback: '',
      };
      const result = await exploreAndCommit(
        'task',
        'prompt',
        async () => [block('test/spec.test.mjs', 'GUTTED'), block('src/ok.mjs', 'ok')].join('\n'),
        {
          candidates: 1,
          projectRoot: dir,
          rungs: [{ id: 'x', name: 'x', command: 'true', required: true }],
          ladderRunner: () => ladder,
          applyOptions: { protectedFiles },
        }
      );
      expect(readFileSync(join(dir, 'test', 'spec.test.mjs'), 'utf-8')).toBe('ORIGINAL');
      expect(result.winner?.applyResult?.filesWritten).toEqual(['src/ok.mjs']);
      expect(result.winner?.applyResult?.rejected[0].reason).toContain('protected');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ConvergenceLoop test protection (end-to-end with stub ladder)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'protect-loop-'));
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'test', 'spec.test.mjs'), 'ORIGINAL');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const RUNGS = [{ id: 'g', name: 'gate', command: 'true', required: true }];
  const failThenIgnore = (): LadderResult => ({
    passed: false,
    score: 0,
    results: [],
    feedback: 'red',
  });

  it('blocks spec modification by default and surfaces the reason', async () => {
    const prompts: string[] = [];
    const loop = new ConvergenceLoop(
      { projectRoot: dir, rungs: RUNGS, maxTurns: 2, baselineCheck: false },
      async (prompt) => {
        prompts.push(prompt);
        return block('test/spec.test.mjs', 'GUTTED');
      },
      { ladderRunner: failThenIgnore }
    );
    const result = await loop.deliver('make tests pass');
    expect(result.success).toBe(false);
    expect(readFileSync(join(dir, 'test', 'spec.test.mjs'), 'utf-8')).toBe('ORIGINAL');
    // every turn rejected the only block → applyError carries the protection reason
    expect(result.history[0].applyError).toContain('pre-existing test file is protected');
    // turn 1 prompt already warns about the protected file
    expect(prompts[0]).toContain('PROTECTED TEST FILES');
    expect(prompts[0]).toContain('test/spec.test.mjs');
  });

  it('allows spec modification when protectTests is false', async () => {
    const loop = new ConvergenceLoop(
      { projectRoot: dir, rungs: RUNGS, maxTurns: 1, baselineCheck: false, protectTests: false },
      async () => block('test/spec.test.mjs', 'CHANGED'),
      { ladderRunner: () => ({ passed: true, score: 1, results: [], feedback: '' }) }
    );
    const result = await loop.deliver('task');
    expect(result.success).toBe(true);
    expect(readFileSync(join(dir, 'test', 'spec.test.mjs'), 'utf-8')).toBe('CHANGED\n');
  });
});

describe('defaultPromptBuilder protected section', () => {
  it('lists protected files and caps the list at 10', () => {
    const files = Array.from({ length: 12 }, (_, i) => `test/f${i}.test.ts`);
    const prompt = defaultPromptBuilder({ instruction: 'x', turn: 1, protectedFiles: files });
    expect(prompt).toContain('PROTECTED TEST FILES');
    expect(prompt).toContain('- test/f0.test.ts');
    expect(prompt).toContain('…and 2 more');
  });

  it('omits the section when there are no protected files', () => {
    const prompt = defaultPromptBuilder({ instruction: 'x', turn: 1 });
    expect(prompt).not.toContain('PROTECTED TEST FILES');
  });
});

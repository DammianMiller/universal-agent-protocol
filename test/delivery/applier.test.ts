import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseFileBlocks, applyFileBlocks } from '../../src/delivery/applier.js';

describe('applier', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-applier-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('parseFileBlocks', () => {
    it('parses multiple file blocks with surrounding prose', () => {
      const output = [
        'I will fix the bug in two files.',
        '```file:src/a.ts',
        'export const a = 1;',
        '```',
        'And the test:',
        '```file:test/a.test.ts',
        'import { a } from "../src/a.js";',
        '```',
      ].join('\n');

      const blocks = parseFileBlocks(output);
      expect(blocks).toHaveLength(2);
      expect(blocks[0].path).toBe('src/a.ts');
      expect(blocks[0].content).toBe('export const a = 1;\n');
      expect(blocks[1].path).toBe('test/a.test.ts');
    });

    it('supports longer fences for content containing triple backticks', () => {
      const output = ['````file:README.md', 'Use a fence:', '```js', 'code', '```', '````'].join('\n');
      const blocks = parseFileBlocks(output);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].content).toContain('```js');
    });

    it('returns empty for output with no file blocks', () => {
      expect(parseFileBlocks('just some explanation, no files')).toEqual([]);
      expect(parseFileBlocks('```ts\nconst x = 1;\n```')).toEqual([]);
    });
  });

  describe('applyFileBlocks', () => {
    it('writes files, creating directories as needed', () => {
      const output = '```file:deep/nested/file.txt\nhello\n```';
      const result = applyFileBlocks(output, dir);
      expect(result.filesWritten).toEqual(['deep/nested/file.txt']);
      expect(result.error).toBeUndefined();
      expect(readFileSync(join(dir, 'deep/nested/file.txt'), 'utf-8')).toBe('hello\n');
    });

    it('rejects path traversal, absolute paths, and .git writes', () => {
      const output = [
        '```file:../escape.txt',
        'evil',
        '```',
        '```file:/etc/passwd',
        'evil',
        '```',
        '```file:.git/hooks/post-checkout',
        'evil',
        '```',
        '```file:ok.txt',
        'fine',
        '```',
      ].join('\n');

      const result = applyFileBlocks(output, dir);
      expect(result.filesWritten).toEqual(['ok.txt']);
      expect(result.rejected).toHaveLength(3);
      expect(existsSync(join(dir, '..', 'escape.txt'))).toBe(false);
      expect(result.rejected.map((r) => r.reason)).toEqual([
        'path escapes the project root',
        'absolute paths are not allowed',
        'writes into .git are not allowed',
      ]);
    });

    it('returns an instructive error when no blocks are found', () => {
      const result = applyFileBlocks('no files here', dir);
      expect(result.filesWritten).toEqual([]);
      expect(result.error).toContain('file:relative/path');
    });
  });
});

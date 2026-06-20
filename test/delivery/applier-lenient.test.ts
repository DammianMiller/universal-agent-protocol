import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseFileBlocks,
  parseFileBlocksLenient,
  looksLikeFilePath,
  applyFileBlocks,
} from '../../src/delivery/applier.js';

/**
 * The lenient fallback exists because small/local models (qwen) ignore the
 * strict ```file:path contract and emit language-tagged or bare fences with
 * the path stated as a header, label, or leading comment. These tests pin the
 * recovery conventions AND the false-positive guards that keep prose off disk.
 */
describe('lenient decoder — strict precedence', () => {
  it('uses strict file: blocks verbatim and does NOT fall back', () => {
    const out = [
      '```file:src/a.ts',
      'export const a = 1;',
      '```',
      'Here is some explanation with a ```js\nconst noise = 2;\n``` fence.',
    ].join('\n');
    const blocks = parseFileBlocks(out);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].path).toBe('src/a.ts');
    expect(blocks[0].content).toContain('export const a = 1;');
  });

  it('falls back only when no strict block is present', () => {
    const out = '```js file:src/b.ts\nexport const b = 2;\n```';
    expect(parseFileBlocks(out)).toHaveLength(1);
    expect(parseFileBlocks(out)[0].path).toBe('src/b.ts');
  });
});

describe('lenient decoder — recovery conventions', () => {
  it('recovers a label on the fence info string (file: with space + lang tag)', () => {
    const out = '```js file:src/game.js\nconst x = 1;\n```';
    const b = parseFileBlocksLenient(out);
    expect(b).toHaveLength(1);
    expect(b[0]).toEqual({ path: 'src/game.js', content: 'const x = 1;\n' });
  });

  it('recovers a bare path as the fence info string', () => {
    const out = '```space-shooter/js/player.js\nclass Player {}\n```';
    const b = parseFileBlocksLenient(out);
    expect(b[0].path).toBe('space-shooter/js/player.js');
  });

  it('recovers a bold "**File: `path`**" header above a plain fence', () => {
    const out = ['**File: `space-shooter/js/enemies.js`**', '```', 'const e = 1;', '```'].join('\n');
    const b = parseFileBlocksLenient(out);
    expect(b).toHaveLength(1);
    expect(b[0].path).toBe('space-shooter/js/enemies.js');
    expect(b[0].content).toBe('const e = 1;\n');
  });

  it('recovers a "### path" heading above a language-tagged fence', () => {
    const out = ['### src/config.ts', '```typescript', 'export const c = 1;', '```'].join('\n');
    const b = parseFileBlocksLenient(out);
    expect(b[0].path).toBe('src/config.ts');
  });

  it('recovers a leading "// path" comment inside the fence and strips it', () => {
    const out = ['```javascript', '// src/audio.js', 'const a = 1;', '```'].join('\n');
    const b = parseFileBlocksLenient(out);
    expect(b).toHaveLength(1);
    expect(b[0].path).toBe('src/audio.js');
    expect(b[0].content).toBe('const a = 1;\n');
    expect(b[0].content).not.toContain('// src/audio.js');
  });

  it('recovers an HTML-comment filepath marker', () => {
    const out = ['```html', '<!-- filepath: index.html -->', '<h1>hi</h1>', '```'].join('\n');
    const b = parseFileBlocksLenient(out);
    expect(b[0].path).toBe('index.html');
    expect(b[0].content).toBe('<h1>hi</h1>\n');
  });

  it('recovers multiple files in one response', () => {
    const out = [
      '**`src/one.ts`**',
      '```ts',
      'export const one = 1;',
      '```',
      'and the second:',
      '```ts file:src/two.ts',
      'export const two = 2;',
      '```',
    ].join('\n');
    const b = parseFileBlocksLenient(out);
    expect(b.map((x) => x.path)).toEqual(['src/one.ts', 'src/two.ts']);
  });
});

describe('lenient decoder — false-positive guards', () => {
  it('does NOT recover a bare/lang fence with no discoverable path', () => {
    const out = ['Some prose.', '```bash', 'npm test', '```', 'more prose.'].join('\n');
    expect(parseFileBlocksLenient(out)).toHaveLength(0);
  });

  it('does NOT treat a prose header like "**Code:**" as a path', () => {
    const out = ['**Code:**', '```', 'console.log(1)', '```'].join('\n');
    expect(parseFileBlocksLenient(out)).toHaveLength(0);
  });

  it('does NOT treat a non-path first comment (with spaces) as a path', () => {
    const out = ['```js', '// Copyright 2026 Example', 'const x = 1;', '```'].join('\n');
    expect(parseFileBlocksLenient(out)).toHaveLength(0);
  });

  it('does NOT attribute a filename mentioned in prose to a following shell fence', () => {
    const out = ['Run the build for src/foo.ts:', '```bash', 'npm run build', '```'].join('\n');
    expect(parseFileBlocksLenient(out)).toHaveLength(0);
  });

  it('does NOT attribute a path heading to a following console/output fence', () => {
    const out = ['src/foo.ts', '```console', '$ node src/foo.ts', '```'].join('\n');
    expect(parseFileBlocksLenient(out)).toHaveLength(0);
  });

  it('STILL recovers a shell file when the path is explicit via file: label', () => {
    const out = '```bash file:scripts/deploy.sh\necho hi\n```';
    const b = parseFileBlocksLenient(out);
    expect(b).toHaveLength(1);
    expect(b[0].path).toBe('scripts/deploy.sh');
  });

  it('recovers blocks from CRLF (Windows-origin) output', () => {
    const out = ['### src/win.ts', '```typescript', 'export const w = 1;', '```'].join('\r\n');
    const b = parseFileBlocksLenient(out);
    expect(b).toHaveLength(1);
    expect(b[0].path).toBe('src/win.ts');
    expect(b[0].content).toContain('export const w = 1;');
  });

  it('looksLikeFilePath accepts real paths and rejects prose/urls/tags', () => {
    expect(looksLikeFilePath('src/game.js')).toBe(true);
    expect(looksLikeFilePath('index.html')).toBe(true);
    expect(looksLikeFilePath('./a/b.ts')).toBe(true);
    expect(looksLikeFilePath('typescript')).toBe(false);
    expect(looksLikeFilePath('Code:')).toBe(false);
    expect(looksLikeFilePath('a file name.js')).toBe(false);
    expect(looksLikeFilePath('https://example.com/x.js')).toBe(false);
  });
});

describe('lenient decoder — security gate still enforced', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-lenient-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects traversal recovered via lenient parse', () => {
    const out = '```js file:../escape.js\nevil\n```';
    const result = applyFileBlocks(out, dir);
    expect(result.filesWritten).toHaveLength(0);
    expect(result.rejected[0].reason).toMatch(/escapes the project root/);
    expect(existsSync(join(dir, '..', 'escape.js'))).toBe(false);
  });

  it('still blocks gate-config writes recovered via lenient parse', () => {
    const out = '```json\n// tsconfig.json\n{"compilerOptions":{}}\n```';
    const result = applyFileBlocks(out, dir, { protectGateConfigs: true });
    expect(result.filesWritten).toHaveLength(0);
    expect(result.rejected[0].reason).toMatch(/gate/i);
  });

  it('still blocks pre-existing protected test files via lenient parse', () => {
    writeFileSync(join(dir, 'sum.test.js'), 'original');
    const out = '```js\n// sum.test.js\nexpect(true).toBe(true)\n```';
    const result = applyFileBlocks(out, dir, {
      protectedFiles: new Set(['sum.test.js']),
    });
    expect(result.filesWritten).toHaveLength(0);
    expect(readFileSync(join(dir, 'sum.test.js'), 'utf-8')).toBe('original');
  });

  it('end-to-end: a qwen-style language-fenced response writes the source file', () => {
    const out = [
      "Here's the fix:",
      '### space-shooter/js/player.js',
      '```javascript',
      'export class Player { constructor() { this.hp = 3; } }',
      '```',
      'That repairs the hitbox bug.',
    ].join('\n');
    const result = applyFileBlocks(out, dir);
    expect(result.filesWritten).toEqual(['space-shooter/js/player.js']);
    expect(readFileSync(join(dir, 'space-shooter/js/player.js'), 'utf-8')).toContain('this.hp = 3');
  });
});

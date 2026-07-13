import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverEntryPages } from '../../src/delivery/visual-gate.js';

describe('discoverEntryPages — subproject recursion', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'uap-entry-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const html = (p: string) => { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), '<html></html>'); };

  it('prefers a root-level index.html (unchanged behavior)', () => {
    writeFileSync(join(dir, 'index.html'), '<html></html>');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'index.html'), '<html></html>');
    expect(discoverEntryPages(dir)).toEqual(['index.html']);
  });

  it('finds a nested subproject index.html when the root has none (the false-done fix)', () => {
    mkdirSync(join(dir, 'rubiks-cube'), { recursive: true });
    writeFileSync(join(dir, 'rubiks-cube', 'index.html'), '<html></html>');
    expect(discoverEntryPages(dir)).toEqual(['rubiks-cube/index.html']);
  });

  it('still prefers dist/index.html over a deeper source subproject', () => {
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'index.html'), '<html></html>');
    mkdirSync(join(dir, 'app'), { recursive: true });
    writeFileSync(join(dir, 'app', 'index.html'), '<html></html>');
    expect(discoverEntryPages(dir)).toEqual([join('dist', 'index.html')]);
  });

  it('skips node_modules / dot-dirs / agents when recursing', () => {
    for (const d of ['node_modules/pkg', '.uap/x', 'agents/data', 'coverage']) {
      mkdirSync(join(dir, d), { recursive: true });
      writeFileSync(join(dir, d, 'index.html'), '<html></html>');
    }
    mkdirSync(join(dir, 'game'), { recursive: true });
    writeFileSync(join(dir, 'game', 'index.html'), '<html></html>');
    expect(discoverEntryPages(dir)).toEqual(['game/index.html']);
  });

  it('returns [] when there is genuinely no entry page anywhere', () => {
    writeFileSync(join(dir, 'readme.md'), '# x');
    expect(discoverEntryPages(dir)).toEqual([]);
  });
});

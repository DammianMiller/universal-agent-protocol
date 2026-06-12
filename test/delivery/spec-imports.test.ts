import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  expandSpecImports,
  isOraclePath,
  resolveRelativeImport,
  snapshotProtection,
} from '../../src/delivery/spec-imports.js';
import { applyFileBlocks } from '../../src/delivery/applier.js';
import { ConvergenceLoop } from '../../src/delivery/convergence-loop.js';

const block = (path: string, content: string): string =>
  ['```file:' + path, content, '```'].join('\n');

describe('isOraclePath', () => {
  it.each([
    'helpers/assertions.mjs',
    'src/fixtures/expected.ts',
    'src/__mocks__/api.ts',
    'lib/widget.mock.ts',
    'shared/env.helper.js',
    'golden/output.txt',
    'data/expected.json',
    'snapshots/render.snap',
  ])('flags %s as oracle material', (p) => {
    expect(isOraclePath(p)).toBe(true);
  });

  it.each(['src/duration.mjs', 'src/index.ts', 'lib/parser.js'])(
    'leaves implementation %s writable',
    (p) => {
      expect(isOraclePath(p)).toBe(false);
    }
  );
});

describe('resolveRelativeImport', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spec-resolve-'));
    mkdirSync(join(dir, 'helpers'), { recursive: true });
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'helpers', 'util.ts'), '');
    writeFileSync(join(dir, 'helpers', 'index.mjs'), '');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('resolves extensionless, .js→.ts, and directory-index specifiers', () => {
    const from = join(dir, 'test', 'a.test.ts');
    expect(resolveRelativeImport(from, '../helpers/util', dir)).toEqual(['helpers/util.ts']);
    expect(resolveRelativeImport(from, '../helpers/util.js', dir)).toEqual(['helpers/util.ts']);
    expect(resolveRelativeImport(from, '../helpers', dir)).toEqual(['helpers/index.mjs']);
  });

  it('ignores bare specifiers, builtins, and escapes', () => {
    const from = join(dir, 'test', 'a.test.ts');
    expect(resolveRelativeImport(from, 'vitest', dir)).toEqual([]);
    expect(resolveRelativeImport(from, 'node:fs', dir)).toEqual([]);
    expect(resolveRelativeImport(from, '../../outside.ts', dir)).toEqual([]);
    expect(resolveRelativeImport(from, '../helpers/missing', dir)).toEqual([]);
  });
});

describe('expandSpecImports', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spec-expand-'));
    mkdirSync(join(dir, 'test'), { recursive: true });
    mkdirSync(join(dir, 'helpers'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'goldens'), { recursive: true });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('protects helper imports, their helper chains, and data files — not the unit under test', () => {
    writeFileSync(
      join(dir, 'test', 'a.test.mjs'),
      [
        "import { check } from '../helpers/assertions.mjs';",
        "import { parse } from '../src/duration.mjs';", // unit under test
        "import expected from './expected.json';",
      ].join('\n')
    );
    writeFileSync(
      join(dir, 'helpers', 'assertions.mjs'),
      "import { deep } from './deep.helper.mjs';"
    );
    writeFileSync(join(dir, 'helpers', 'deep.helper.mjs'), '');
    writeFileSync(join(dir, 'src', 'duration.mjs'), 'export const parse = () => 0;');
    writeFileSync(join(dir, 'test', 'expected.json'), '{}');

    const extra = expandSpecImports(dir, ['test/a.test.mjs']).sort();
    // test/expected.json is included unconditionally: the expansion no longer
    // assumes the directory walk saw every test-path ref (M1 fix)
    expect(extra).toEqual(['helpers/assertions.mjs', 'helpers/deep.helper.mjs', 'test/expected.json']);
  });

  it('protects data files referenced by quoted literals (readFileSync paths)', () => {
    writeFileSync(
      join(dir, 'test', 'b.test.mjs'),
      "const want = JSON.parse(readFileSync('goldens/output.json', 'utf-8'));"
    );
    writeFileSync(join(dir, 'goldens', 'output.json'), '{"n": 1}');
    const extra = expandSpecImports(dir, ['test/b.test.mjs']).sort();
    // Both resolution bases are protected: runtimes read relative to cwd,
    // authors write relative to the spec — the spec-dir candidate is a
    // reserved oracle path even though it does not exist.
    expect(extra).toEqual(['goldens/output.json', 'test/goldens/output.json']);
  });

  it('never recurses through plain implementation imports', () => {
    writeFileSync(join(dir, 'test', 'c.test.mjs'), "import { x } from '../src/impl.mjs';");
    writeFileSync(join(dir, 'src', 'impl.mjs'), "import h from '../helpers/inner.mjs';");
    writeFileSync(join(dir, 'helpers', 'inner.mjs'), '');
    // impl.mjs is the unit under test; its imports are implementation detail
    expect(expandSpecImports(dir, ['test/c.test.mjs'])).toEqual([]);
  });

  it('is fail-soft on unreadable or missing specs', () => {
    expect(expandSpecImports(dir, ['test/missing.test.mjs'])).toEqual([]);
  });
});

describe('review-driven behaviors', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spec-review-'));
    mkdirSync(join(dir, 'test'), { recursive: true });
    mkdirSync(join(dir, 'helpers'), { recursive: true });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('protects test-path imports the directory walk cannot see (hidden dir)', () => {
    mkdirSync(join(dir, '.support', 'test'), { recursive: true });
    writeFileSync(join(dir, '.support', 'test', 'util.test.mjs'), '');
    writeFileSync(
      join(dir, 'test', 'a.test.mjs'),
      "import u from '../.support/test/util.test.mjs';"
    );
    const extra = expandSpecImports(dir, ['test/a.test.mjs']);
    expect(extra).toContain('.support/test/util.test.mjs');
  });

  it('terminates on helper import cycles', () => {
    writeFileSync(join(dir, 'helpers', 'a.helper.mjs'), "import b from './b.helper.mjs';");
    writeFileSync(join(dir, 'helpers', 'b.helper.mjs'), "import a from './a.helper.mjs';");
    writeFileSync(join(dir, 'test', 'c.test.mjs'), "import a from '../helpers/a.helper.mjs';");
    const extra = expandSpecImports(dir, ['test/c.test.mjs']).sort();
    expect(extra).toEqual(['helpers/a.helper.mjs', 'helpers/b.helper.mjs']);
  });

  it('protects BOTH x.js and x.ts when a .js specifier matches both', () => {
    writeFileSync(join(dir, 'helpers', 'u.helper.js'), '');
    writeFileSync(join(dir, 'helpers', 'u.helper.ts'), '');
    writeFileSync(join(dir, 'test', 'd.test.mjs'), "import u from '../helpers/u.helper.js';");
    const extra = expandSpecImports(dir, ['test/d.test.mjs']).sort();
    expect(extra).toEqual(['helpers/u.helper.js', 'helpers/u.helper.ts']);
  });

  it('treats data files as leaves — fixture contents are never scanned', () => {
    mkdirSync(join(dir, 'fixtures'), { recursive: true });
    writeFileSync(
      join(dir, 'fixtures', 'cli-output.json'),
      JSON.stringify({ log: "import x from './src/manifest.json'" })
    );
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'manifest.json'), '{}');
    writeFileSync(join(dir, 'test', 'e.test.mjs'), "import f from '../fixtures/cli-output.json';");
    const extra = expandSpecImports(dir, ['test/e.test.mjs']);
    expect(extra).toEqual(['fixtures/cli-output.json']);
  });

  it('reserves a MISSING golden referenced by literal under an oracle dir', () => {
    writeFileSync(
      join(dir, 'test', 'f.test.mjs'),
      "const want = readFileSync('goldens/output.json', 'utf-8');"
    );
    // goldens/output.json does NOT exist — still protected (reserved)
    const extra = expandSpecImports(dir, ['test/f.test.mjs']);
    expect(extra).toContain('goldens/output.json');
  });
});

describe('snapshotProtection + applier integration', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spec-snap-'));
    mkdirSync(join(dir, 'test'), { recursive: true });
    mkdirSync(join(dir, 'helpers'), { recursive: true });
    writeFileSync(
      join(dir, 'test', 'spec.test.mjs'),
      "import { expectedTotal } from '../helpers/oracle.mjs';"
    );
    writeFileSync(join(dir, 'helpers', 'oracle.mjs'), 'export const expectedTotal = 42;');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('membership includes the spec and its helper; display keeps original case', () => {
    const snap = snapshotProtection(dir);
    expect(snap.protectedFiles.has('test/spec.test.mjs')).toBe(true);
    expect(snap.protectedFiles.has('helpers/oracle.mjs')).toBe(true);
    expect(snap.display).toContain('helpers/oracle.mjs');
  });

  it('the applier rejects a write to the helper the spec asserts against', () => {
    const snap = snapshotProtection(dir);
    const result = applyFileBlocks(
      block('helpers/oracle.mjs', 'export const expectedTotal = 0;'),
      dir,
      { protectedFiles: snap.protectedFiles }
    );
    expect(result.filesWritten).toEqual([]);
    expect(result.rejected[0].reason).toContain('protected');
    expect(readFileSync(join(dir, 'helpers', 'oracle.mjs'), 'utf-8')).toContain('42');
  });

  it('the loop protects the helper end-to-end and lists it in the prompt', async () => {
    const prompts: string[] = [];
    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        rungs: [{ id: 'g', name: 'gate', command: 'true', required: true }],
        maxTurns: 1,
        baselineCheck: false,
      },
      async (prompt) => {
        prompts.push(prompt);
        return block('helpers/oracle.mjs', 'export const expectedTotal = 0;');
      },
      { ladderRunner: () => ({ passed: false, score: 0, results: [], feedback: 'red' }) }
    );
    const result = await loop.deliver('make the total right');
    expect(result.history[0].applyError).toContain('protected');
    expect(readFileSync(join(dir, 'helpers', 'oracle.mjs'), 'utf-8')).toContain('42');
    expect(prompts[0]).toContain('helpers/oracle.mjs');
  });
});

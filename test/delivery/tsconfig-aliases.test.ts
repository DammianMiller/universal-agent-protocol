import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  expandSpecImports,
  loadTsconfigAliases,
  resolveAliasImport,
} from '../../src/delivery/spec-imports.js';

describe('loadTsconfigAliases', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tsconfig-load-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns null without a tsconfig or without baseUrl/paths', () => {
    expect(loadTsconfigAliases(dir)).toBeNull();
    writeFileSync(join(dir, 'tsconfig.json'), '{"compilerOptions": {"strict": true}}');
    expect(loadTsconfigAliases(dir)).toBeNull();
  });

  it('parses paths with JSONC comments and trailing commas', () => {
    writeFileSync(
      join(dir, 'tsconfig.json'),
      [
        '{',
        '  // alias config',
        '  "compilerOptions": {',
        '    /* base */ "baseUrl": ".",',
        '    "paths": {',
        '      "@fixtures/*": ["test/fixtures/*"],',
        '    },',
        '  },',
        '}',
      ].join('\n')
    );
    const aliases = loadTsconfigAliases(dir);
    expect(aliases).not.toBeNull();
    expect(aliases!.paths).toEqual([
      { pattern: '@fixtures/*', targets: ['test/fixtures/*'], baseAbs: dir },
    ]);
  });

  it('survives wildcard targets containing star-slash plus real comments (string-aware JSONC)', () => {
    writeFileSync(
      join(dir, 'tsconfig.json'),
      [
        '{',
        '  "compilerOptions": {',
        '    "baseUrl": ".",',
        '    "paths": {"@pkg/*": ["packages/*/src", "fix*/x"]} /* real comment */',
        '  }',
        '}',
      ].join('\n')
    );
    const aliases = loadTsconfigAliases(dir);
    expect(aliases).not.toBeNull();
    expect(aliases!.paths[0].targets).toEqual(['packages/*/src', 'fix*/x']);
  });

  it('keeps baseUrlAbs null when only paths are declared', () => {
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '@x/*': ['x/*'] } } })
    );
    expect(loadTsconfigAliases(dir)!.baseUrlAbs).toBeNull();
  });

  it('supports the TS 5 extends-array form', () => {
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ compilerOptions: { paths: { '@a/*': ['a/*'] } } }));
    writeFileSync(join(dir, 'b.json'), JSON.stringify({ compilerOptions: { paths: { '@b/*': ['b/*'] } } }));
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ extends: ['./a.json', './b.json'], compilerOptions: {} })
    );
    const patterns = loadTsconfigAliases(dir)!.paths.map((p) => p.pattern).sort();
    expect(patterns).toEqual(['@a/*', '@b/*']);
  });

  it('terminates on extends cycles', () => {
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ extends: './other.json', compilerOptions: { paths: { '@c/*': ['c/*'] } } }));
    writeFileSync(join(dir, 'other.json'), JSON.stringify({ extends: './tsconfig.json', compilerOptions: {} }));
    expect(loadTsconfigAliases(dir)!.paths).toHaveLength(1);
  });

  it('paths declared by a parent config in a subdirectory resolve from that dir', () => {
    mkdirSync(join(dir, 'config'), { recursive: true });
    mkdirSync(join(dir, 'config', 'helpers'), { recursive: true });
    writeFileSync(join(dir, 'config', 'helpers', 'oracle.ts'), '');
    writeFileSync(
      join(dir, 'config', 'base.json'),
      JSON.stringify({ compilerOptions: { paths: { '@oracle': ['helpers/oracle.ts'] } } })
    );
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ extends: './config/base.json' }));
    const aliases = loadTsconfigAliases(dir)!;
    expect(resolveAliasImport('@oracle', aliases, dir)).toEqual(['config/helpers/oracle.ts']);
  });

  it('follows a relative extends chain with child overriding parent', () => {
    writeFileSync(
      join(dir, 'tsconfig.base.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@shared/*': ['shared/*'], '@oracle': ['old/oracle.ts'] },
        },
      })
    );
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        extends: './tsconfig.base.json',
        compilerOptions: { paths: { '@oracle': ['helpers/oracle.ts'] } },
      })
    );
    const aliases = loadTsconfigAliases(dir);
    const oracle = aliases!.paths.find((p) => p.pattern === '@oracle');
    expect(oracle!.targets).toEqual(['helpers/oracle.ts']);
    expect(aliases!.paths.some((p) => p.pattern === '@shared/*')).toBe(true);
  });
});

describe('resolveAliasImport', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tsconfig-resolve-'));
    mkdirSync(join(dir, 'test', 'fixtures'), { recursive: true });
    mkdirSync(join(dir, 'helpers'), { recursive: true });
    writeFileSync(join(dir, 'test', 'fixtures', 'golden.ts'), '');
    writeFileSync(join(dir, 'helpers', 'oracle.ts'), '');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('resolves wildcard and exact alias patterns', () => {
    const aliases = {
      baseUrlAbs: dir,
      paths: [
        { pattern: '@fixtures/*', targets: ['test/fixtures/*'], baseAbs: dir },
        { pattern: '@oracle', targets: ['helpers/oracle.ts'], baseAbs: dir },
      ],
    };
    expect(resolveAliasImport('@fixtures/golden', aliases, dir)).toEqual([
      'test/fixtures/golden.ts',
    ]);
    expect(resolveAliasImport('@oracle', aliases, dir)).toEqual(['helpers/oracle.ts']);
  });

  it('resolves bare specifiers from an explicit baseUrl', () => {
    const aliases = { baseUrlAbs: dir, paths: [] };
    expect(resolveAliasImport('helpers/oracle', aliases, dir)).toEqual(['helpers/oracle.ts']);
    // npm package names just fail the file checks
    expect(resolveAliasImport('vitest', aliases, dir)).toEqual([]);
  });

  it('ignores relative, node:, and absolute specifiers', () => {
    const aliases = { baseUrlAbs: dir, paths: [{ pattern: '*', targets: ['*'], baseAbs: dir }] };
    expect(resolveAliasImport('./helpers/oracle', aliases, dir)).toEqual([]);
    expect(resolveAliasImport('node:fs', aliases, dir)).toEqual([]);
  });

  it('does NOT resolve bare specifiers when baseUrl was never declared (paths-only)', () => {
    const aliases = { baseUrlAbs: null, paths: [{ pattern: '@x/*', targets: ['x/*'], baseAbs: dir }] };
    expect(resolveAliasImport('helpers/oracle', aliases, dir)).toEqual([]);
  });

  it('rejects alias targets escaping the project root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'tsconfig-outside-'));
    try {
      writeFileSync(join(outside, 'secret.ts'), '');
      const aliases = {
        baseUrlAbs: dir,
        paths: [{ pattern: '@esc/*', targets: [`../${outside.split('/').pop()}/*`], baseAbs: dir }],
      };
      expect(resolveAliasImport('@esc/secret', aliases, dir)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('fail-soft', () => {
  it('garbage tsconfig still leaves relative-import protection working', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsconfig-garbage-'));
    try {
      mkdirSync(join(dir, 'test'), { recursive: true });
      mkdirSync(join(dir, 'helpers'), { recursive: true });
      writeFileSync(join(dir, 'tsconfig.json'), '{{{not json');
      writeFileSync(join(dir, 'helpers', 'oracle.helper.ts'), '');
      writeFileSync(join(dir, 'test', 'a.test.ts'), "import o from '../helpers/oracle.helper';");
      expect(expandSpecImports(dir, ['test/a.test.ts'])).toEqual(['helpers/oracle.helper.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('expandSpecImports with aliases (end-to-end)', () => {
  it('protects oracle material referenced through tsconfig path aliases', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsconfig-e2e-'));
    try {
      mkdirSync(join(dir, 'test'), { recursive: true });
      mkdirSync(join(dir, 'shared', 'fixtures'), { recursive: true });
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { baseUrl: '.', paths: { '@fixtures/*': ['shared/fixtures/*'] } },
        })
      );
      writeFileSync(join(dir, 'shared', 'fixtures', 'expected.ts'), 'export const n = 42;');
      writeFileSync(
        join(dir, 'test', 'a.test.ts'),
        "import { n } from '@fixtures/expected';"
      );
      const extra = expandSpecImports(dir, ['test/a.test.ts']);
      expect(extra).toContain('shared/fixtures/expected.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('alias to plain implementation code stays writable (unit under test)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsconfig-uut-'));
    try {
      mkdirSync(join(dir, 'test'), { recursive: true });
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } } })
      );
      writeFileSync(join(dir, 'src', 'duration.ts'), '');
      writeFileSync(join(dir, 'test', 'b.test.ts'), "import { d } from '@app/duration';");
      expect(expandSpecImports(dir, ['test/b.test.ts'])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

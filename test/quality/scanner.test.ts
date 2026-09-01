import { describe, it, expect } from 'vitest';
import { analyzeComplexity, functionHeader } from '../../src/quality/complexity.js';
import { countAnyTypes, scanContent, isScannableSource } from '../../src/quality/scanner.js';
import { languageForFile, stripNoise } from '../../src/quality/languages.js';
import { defaultConfig } from '../../src/quality/config.js';
import { crapScore } from '../../src/quality/crap.js';

const config = defaultConfig();

describe('language detection', () => {
  it('maps extensions to language families', () => {
    expect(languageForFile('a/b.ts')?.name).toBe('typescript');
    expect(languageForFile('a/b.py')?.name).toBe('python');
    expect(languageForFile('a/b.rs')?.name).toBe('rust');
    expect(languageForFile('a/b.java')?.name).toBe('java');
    expect(languageForFile('a/b.cs')?.name).toBe('csharp');
    expect(languageForFile('a/b.cc')?.name).toBe('cpp');
    expect(languageForFile('README.md')).toBeNull();
  });

  it('strips comments and strings so keywords inside prose are invisible', () => {
    const ts = languageForFile('a.ts')!;
    const stripped = stripNoise('// if while for\nconst s = "if && else"; /* if */ if (x) {}', ts.commentStyle);
    expect(stripped).not.toContain('while');
    expect(stripped.match(/\bif\b/g)!.length).toBe(1);
  });
});

describe('functionHeader', () => {
  it('detects keyword-declared functions without mangling names', () => {
    expect(functionHeader('export function tangle(a: number): any {')).toBe('tangle');
    expect(functionHeader('function foo(x) {')).toBe('foo');
    expect(functionHeader('def helper(x):')).toBe('helper');
    expect(functionHeader('fn compute(a: i32) -> i32 {')).toBe('compute');
  });

  it('detects method-style headers and rejects control flow', () => {
    expect(functionHeader('  public scan(file: string): Violation[] {')).toBe('scan');
    expect(functionHeader('  private async run(): Promise<void> {')).toBe('run');
    expect(functionHeader('if (x > 0) {')).toBeNull();
    expect(functionHeader('for (let i = 0; i < n; i++) {')).toBeNull();
    expect(functionHeader('while (running) {')).toBeNull();
  });
});

describe('complexity analysis', () => {
  it('scores a simple function at cyclomatic 1', () => {
    const ts = languageForFile('a.ts')!;
    const r = analyzeComplexity('export function add(a: number, b: number) {\n  return a + b;\n}', ts);
    const fn = r.functions.find((f) => f.name === 'add')!;
    expect(fn.cyclomatic).toBe(1);
    expect(fn.cognitive).toBe(0);
  });

  it('counts decisions and nesting depth', () => {
    const ts = languageForFile('a.ts')!;
    const src = [
      'export function f(a: number, b: number) {',
      '  if (a > 0) {',       // cc+1, cog+1
      '    if (b > 0) {',     // cc+1, cog+2 (nesting 1)
      '      return a && b;', // cc+1, cog+1
      '    }',
      '  }',
      '  for (let i = 0; i < a; i++) { if (i) break; }', // cc+2 (for, if), cog+1+2
      '  return 0;',
      '}',
    ].join('\n');
    const fn = analyzeComplexity(src, ts).functions.find((f) => f.name === 'f')!;
    expect(fn.cyclomatic).toBe(6); // 1 + 5 decisions
    expect(fn.cognitive).toBe(7);
  });

  it('handles indent-based python regions', () => {
    const py = languageForFile('a.py')!;
    const src = [
      'def f(a, b):',
      '    if a:',
      '        for i in range(b):',
      '            if i and a:',
      '                return i',
      '    return 0',
      '',
      'def g():',
      '    return 1',
    ].join('\n');
    const r = analyzeComplexity(src, py);
    const f = r.functions.find((x) => x.name === 'f')!;
    const g = r.functions.find((x) => x.name === 'g')!;
    expect(f.cyclomatic).toBeGreaterThanOrEqual(4);
    expect(g.cyclomatic).toBe(1);
  });
});

describe('any-type scan', () => {
  it('counts explicit any/unknown in TypeScript', () => {
    const src = 'function f(a: any): unknown {\n  return a as any;\n}\nconst ok: string = "x";';
    const r = countAnyTypes(src, 'a.ts');
    expect(r.count).toBe(3);
    expect(r.lines).toEqual([1, 2]);
  });

  it('ignores any inside strings and comments', () => {
    const src = '// const x: any = 1;\nconst s = "as any";\nconst ok: number = 1;';
    expect(countAnyTypes(src, 'a.ts').count).toBe(0);
  });

  it('counts typing.Any in Python', () => {
    const src = 'from typing import Any\ndef f(x: Any) -> Any:\n    return x';
    expect(countAnyTypes(src, 'a.py').count).toBe(2);
  });
});

describe('scanContent thresholds', () => {
  it('flags files over the LOC limit', () => {
    const content = Array.from({ length: 501 }, (_, i) => `const v${i} = ${i};`).join('\n');
    const v = scanContent('big.ts', content, config);
    expect(v.some((x) => x.metric === 'locPerFile' && x.value === 501)).toBe(true);
  });

  it('flags functions over the cyclomatic limit with a stable signature', () => {
    const branches = Array.from({ length: 25 }, (_, i) => `  if (a === ${i}) return ${i};`).join('\n');
    const content = `export function pick(a: number) {\n${branches}\n  return -1;\n}`;
    const v = scanContent('m.ts', content, config);
    const cc = v.find((x) => x.metric === 'cyclomatic');
    expect(cc).toBeDefined();
    expect(cc!.signature).toBe('m.ts::cyclomatic::pick@1');
    expect(cc!.value).toBeGreaterThan(22);
  });

  it('returns nothing for clean code', () => {
    expect(scanContent('ok.ts', 'export const add = (a: number, b: number): number => a + b;', config)).toEqual([]);
  });
});

describe('isScannableSource', () => {
  it('includes source extensions and skips excluded dirs', () => {
    expect(isScannableSource('src/a.ts', config)).toBe(true);
    expect(isScannableSource('tools/agents/x.py', config)).toBe(true);
    expect(isScannableSource('node_modules/pkg/a.ts', config)).toBe(false);
    expect(isScannableSource('dist/a.js', config)).toBe(false);
    expect(isScannableSource('docs/a.md', config)).toBe(false);
  });
});

describe('CRAP score', () => {
  it('is cc^2 + cc at zero coverage and ~cc at full coverage', () => {
    expect(crapScore(4, 0)).toBe(20);
    expect(crapScore(4, 1)).toBe(4);
  });

  it('crosses the 25 threshold exactly where complexity and coverage dictate', () => {
    // cc=5 at 0% coverage: 25+5 = 30 > 25 (blocks)
    expect(crapScore(5, 0)).toBeGreaterThan(25);
    // cc=5 at 100% coverage: 5 < 25 (passes)
    expect(crapScore(5, 1)).toBeLessThan(25);
  });
});

describe('one-line function regression (review blocker)', () => {
  it('does NOT swallow the rest of the file after a single-line function', () => {
    const ts = languageForFile('a.ts')!;
    const src = [
      'export function one() { return 1; }',
      'export function two(a: number) {',
      '  if (a > 0) { return 1; }',
      '  return 0;',
      '}',
    ].join('\n');
    const r = analyzeComplexity(src, ts);
    const one = r.functions.find((f) => f.name === 'one');
    const two = r.functions.find((f) => f.name === 'two');
    expect(one).toBeDefined();
    expect(two).toBeDefined();
    // one() is a one-liner: cc 1. two() has one if: cc 2.
    expect(one!.cyclomatic).toBe(1);
    expect(two!.cyclomatic).toBe(2);
  });

  it('scores a module-level tangle as <module> so it stays gated', () => {
    const ts = languageForFile('a.ts')!;
    const src = [
      'const x = process.env.A;',
      'if (x) {',
      '  for (const c of x) { if (c > "a" && c < "z") console.log(c); }',
      '}',
    ].join('\n');
    const r = analyzeComplexity(src, ts);
    const mod = r.functions.find((f) => f.name === '<module>');
    expect(mod).toBeDefined();
    expect(mod!.cyclomatic).toBeGreaterThanOrEqual(4);
  });
});

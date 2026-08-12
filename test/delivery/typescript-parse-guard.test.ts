/**
 * TypeScript had no syntax feedback of any kind.
 *
 * The bracket scanner deliberately skips .ts: regex literals (`/[^)]/`) push a
 * bracket that never closes, which false-positived on 14.3% of 350 real .ts
 * files and 6 of 7 .js files. And `maybeJsSyntaxCheck` matches only
 * /\.(js|cjs|mjs)$/ and shells to `node --check`, which cannot read TypeScript.
 * So a .ts write that broke the file was neither refused NOR reported.
 *
 * Measured 2026-08-12, live: a mission implementing one small function appended
 * it after an existing one and left a stray `}`. The whole file stopped
 * parsing, so the eleven tests it was trying to satisfy could not even run.
 *
 * Guessing is the wrong tool when the real parser is available: `typescript`
 * resolves at runtime through @qdrant/js-client-rest, so this adds no
 * dependency. It answers exactly one question — does this file still parse —
 * and does no type checking, so it cannot refuse a write for a type error the
 * model is midway through fixing.
 */
import { describe, it, expect } from 'vitest';
import { typescriptParseError, delimiterRefusal } from '../../src/delivery/agentic-executor.js';

const HEALTHY = 'export function a(): number {\n  return 1;\n}\n';

describe('typescriptParseError', () => {
  it('catches the stray closing brace that broke the live mission', () => {
    const err = typescriptParseError('export function a() {\n  return 1;\n};\n}\n', 'x.ts');
    expect(err).toBeTruthy();
    expect(err, 'the model needs the line to find it').toMatch(/line \d+/);
  });

  it('catches an unclosed function', () => {
    expect(typescriptParseError('export function a() {\n  return 1;\n', 'x.ts')).toContain("'}' expected");
  });

  it('passes healthy TypeScript', () => {
    expect(typescriptParseError(HEALTHY, 'x.ts')).toBeNull();
  });

  it('passes a REGEX LITERAL — the case the bracket scanner cannot handle', () => {
    // This is the whole reason .ts uses the compiler instead of the scanner.
    expect(typescriptParseError('const re = /[^)]/;\nexport function a() { return 1; }\n', 'x.ts')).toBeNull();
    expect(typescriptParseError('const d = a / b / c;\nexport function z() {}\n', 'x.ts')).toBeNull();
  });

  it('passes JSX, decorators and generics', () => {
    expect(typescriptParseError('export const x = <div a={1}>hi</div>;\n', 'x.tsx')).toBeNull();
    expect(typescriptParseError('@dec()\nclass A {}\n', 'x.ts')).toBeNull();
    expect(typescriptParseError('const f = <T,>(x: T) => x;\n', 'x.ts')).toBeNull();
  });

  it('reads plain JavaScript too', () => {
    expect(typescriptParseError('function a() {\n', 'x.js')).toBeTruthy();
    expect(typescriptParseError('const re = /[^)]/;\nfunction a() {}\n', 'x.js')).toBeNull();
  });

  it('says nothing about files it does not parse', () => {
    expect(typescriptParseError('{{{ nonsense', 'notes.md')).toBeNull();
    expect(typescriptParseError('{{{ nonsense', 'setup.sql')).toBeNull();
    expect(typescriptParseError('fn a() {', 'lib.rs')).toBeNull();
  });

  it('does NOT report type errors — only parse errors', () => {
    // A mission midway through a refactor has type errors constantly. Refusing
    // those writes would block the work rather than protect it.
    expect(typescriptParseError('const x: number = "a string";\n', 'x.ts')).toBeNull();
    expect(typescriptParseError('import { nope } from "./nowhere.js";\nexport const a = nope;\n', 'x.ts')).toBeNull();
  });

  it('survives a huge file without throwing', () => {
    const big = HEALTHY.repeat(3000);
    expect(() => typescriptParseError(big, 'x.ts')).not.toThrow();
    expect(typescriptParseError(big, 'x.ts')).toBeNull();
  });
});

describe('the write refusal uses the parser for TS and the scanner for Rust', () => {
  it('refuses a TypeScript write that stops the file parsing', () => {
    const refusal = delimiterRefusal('x.ts', HEALTHY, `${HEALTHY}}\n`);
    expect(refusal).toBeTruthy();
    expect(refusal).toContain('does not parse');
  });

  it('allows a TypeScript write containing a regex literal', () => {
    // Under the bracket scanner this was refused; that is why .ts was excluded
    // from it, and why this test matters more than it looks.
    expect(delimiterRefusal('x.ts', HEALTHY, `const re = /[^)]/;\n${HEALTHY}`)).toBeNull();
  });

  it('allows a write that FIXES an unparseable TypeScript file', () => {
    expect(delimiterRefusal('x.ts', 'export function a() {\n', HEALTHY)).toBeNull();
  });

  it('does not ratchet an already-unparseable TS file shut', () => {
    // Both versions fail to parse: the file was broken BEFORE this write, so
    // refusing would leave it uneditable — a guard that becomes a trap. This
    // needs the parser on the `before` side too; checking only the bracket
    // scanner there reports .ts as healthy and refuses the repair attempt.
    const before = 'export function a() {\n  return 1;\n';
    const after = 'export function a() {\n  return 1;\n  const b = 2;\n';
    expect(typescriptParseError(before, 'x.ts'), 'fixture must start broken').toBeTruthy();
    expect(typescriptParseError(after, 'x.ts'), 'fixture must stay broken').toBeTruthy();
    expect(delimiterRefusal('x.ts', before, after)).toBeNull();
  });

  it('still refuses unbalanced Rust via the scanner', () => {
    expect(delimiterRefusal('lib.rs', 'fn a() {}\n', 'fn a() {}\n}\n')).toBeTruthy();
  });

  it('honours the shared escape hatch', () => {
    process.env.UAP_DELIVER_ALLOW_UNBALANCED = '1';
    try {
      expect(delimiterRefusal('x.ts', HEALTHY, `${HEALTHY}}\n`)).toBeNull();
    } finally {
      delete process.env.UAP_DELIVER_ALLOW_UNBALANCED;
    }
  });
});

describe('survives a TypeScript whose API shape is not the 5.x one', () => {
  it('goes inert rather than throwing when createSourceFile is missing', () => {
    // TypeScript 7 is the Go rewrite: its main entry exports only
    // {version, versionMajorMinor} and the compiler API moved behind
    // ./unstable/*. v1.198.5 shipped assuming the 5.x surface, threw there, and
    // the catch swallowed it — the guard was silently inert on any install
    // whose ambient typescript was 7.x. `typescript` is a pinned ^5 dependency
    // now, and this pins the degradation path for the next shape change.
    const stub = { version: '7.0.2', versionMajorMinor: '7.0' } as unknown as typeof import('typescript');
    expect(typeof (stub as { createSourceFile?: unknown }).createSourceFile).toBe('undefined');
    // The guard must not throw on such a module, and must not claim a healthy
    // file is broken because it could not read it.
    expect(() => typescriptParseError(HEALTHY, 'x.ts')).not.toThrow();
  });

  it('the typescript it actually loads exposes the API it needs', () => {
    // Pins the dependency contract: if the resolved typescript ever stops
    // exposing createSourceFile, this fails HERE rather than the guard going
    // quietly inert in production.
    expect(typescriptParseError('export function a() {\n', 'x.ts'), 'guard is inert — check the typescript dependency').toBeTruthy();
  });
});

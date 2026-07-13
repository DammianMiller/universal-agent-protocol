/**
 * EVERY code type must be built + tested — not just npm.
 *
 * The non-npm detectors used to sit behind `if (rungs.length === 0)`, so a Go /
 * C++ / .NET / Python component living in a repo that ALSO had a package.json was
 * never compiled or tested: it passed VACUOUSLY, judged only by `npm run build`.
 * (Same class of bug already fixed for Rust — an 8-phase Rust mission stagnated
 * because every turn was judged by npm alone.) detectPolyglotRungs generalizes the
 * fix: if it's interpreted, transpiled, or compiled, it gets a rung.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { detectRungs, detectPolyglotRungs } from '../../src/delivery/verifier-ladder.js';

describe('detectPolyglotRungs — every ecosystem gets a build+test rung', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'uap-poly-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const ids = (): string[] => detectPolyglotRungs(dir).map((r) => r.id);

  it('Go: go.mod → build + test', () => {
    writeFileSync(join(dir, 'go.mod'), 'module x\n');
    expect(ids()).toEqual(expect.arrayContaining(['go-build', 'go-test']));
  });

  it('.NET: a .csproj → dotnet build + test', () => {
    writeFileSync(join(dir, 'App.csproj'), '<Project/>');
    expect(ids()).toEqual(expect.arrayContaining(['dotnet-build', 'dotnet-test']));
  });

  it('C/C++: CMakeLists.txt → cmake build + ctest (ctest exit 8 = no tests = pass)', () => {
    writeFileSync(join(dir, 'CMakeLists.txt'), 'project(x)');
    expect(ids()).toEqual(expect.arrayContaining(['cmake-build', 'ctest']));
    const ctest = detectPolyglotRungs(dir).find((r) => r.id === 'ctest')!;
    expect(ctest.passExitCodes).toContain(8);
  });

  it('JVM: Maven, Gradle, sbt', () => {
    writeFileSync(join(dir, 'pom.xml'), '<project/>');
    expect(ids()).toContain('maven-test');
    rmSync(join(dir, 'pom.xml'));
    writeFileSync(join(dir, 'build.gradle.kts'), '');
    expect(ids()).toContain('gradle-test');
    rmSync(join(dir, 'build.gradle.kts'));
    writeFileSync(join(dir, 'build.sbt'), '');
    expect(ids()).toContain('sbt-test');
  });

  it('Swift / Ruby / PHP / Elixir / Dart / Haskell / Zig', () => {
    const cases: Array<[string, string]> = [
      ['Package.swift', 'swift-test'],
      ['Gemfile', 'ruby-test'],
      ['composer.json', 'php-test'],
      ['mix.exs', 'mix-test'],
      ['pubspec.yaml', 'dart-test'],
      ['stack.yaml', 'stack-test'],
      ['build.zig', 'zig-test'],
    ];
    for (const [manifest, rungId] of cases) {
      const d = mkdtempSync(join(tmpdir(), 'uap-poly1-'));
      writeFileSync(join(d, manifest), '');
      expect(detectPolyglotRungs(d).map((r) => r.id), manifest).toContain(rungId);
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('Python: a manifest → pytest (exit 5 "no tests collected" is a vacuous pass)', () => {
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname="x"\n');
    const py = detectPolyglotRungs(dir).find((r) => r.id === 'pytest')!;
    expect(py).toBeTruthy();
    expect(py.passExitCodes).toContain(5);
  });

  it('nothing detected for an empty project', () => {
    expect(ids()).toEqual([]);
  });
});

describe('detectRungs — POLYGLOT: npm does not shadow other languages', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'uap-polymix-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a repo with package.json AND go.mod gates on BOTH (the vacuous-pass bug)', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc', test: 'vitest' } }));
    writeFileSync(join(dir, 'go.mod'), 'module x\n');
    const ids = detectRungs(dir).map((r) => r.id);
    expect(ids).toContain('build');     // npm still gated
    expect(ids).toContain('test');
    expect(ids).toContain('go-build');  // ...and Go is no longer invisible
    expect(ids).toContain('go-test');
  });

  it('package.json + CMakeLists.txt + pyproject.toml → all three ecosystems gated', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    writeFileSync(join(dir, 'CMakeLists.txt'), 'project(x)');
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname="x"\n');
    mkdirSync(join(dir, 'src'), { recursive: true });
    const ids = detectRungs(dir).map((r) => r.id);
    expect(ids).toContain('test');        // npm
    expect(ids).toContain('cmake-build'); // C++
    expect(ids).toContain('ctest');
    expect(ids).toContain('pytest');      // Python
  });
});

/**
 * A deliver rooted ABOVE the actual project gets no objective gates.
 *
 * Live on 2026-08-08: a mission to repair a Rust crate ran with
 * `--project-root cognition-engine`, whose tree holds no build manifest. The
 * crate's own `Cargo.toml` was one level down in `src/rust-pg-ext`. Rooted at
 * the parent the run got `bootstrap` (which trivially passes) plus a skipped
 * user-validation gate, so it reported "100% of gates" for five consecutive
 * turns while the crate did not compile — the LLM judge was the only
 * convergence target, and it cannot run `cargo check`. The same mistake also
 * disabled rollback, because the snapshot size guard walked the whole 22 GB
 * tree instead of the 117 MB crate.
 *
 * "No objective gates" is a legitimate state for a docs repo, so this is advice
 * rather than a refusal — but it must be able to tell the two apart.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findGatedSubprojects, formatGatelessRootAdvice } from '../../src/cli/deliver.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uap-gateless-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/**
 * Create `rel` under the sandbox as a project that really yields gates.
 *
 * The content matters: a manifest alone is not a gate, and the scan confirms
 * candidates against the real detectors. A scriptless package.json produces no
 * rungs, so a fixture written as `{}` would be correctly ignored and the test
 * would be measuring the wrong thing.
 */
function project(rel: string, manifest: string): string {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, manifest), manifestBody(manifest));
  return dir;
}

function manifestBody(manifest: string): string {
  if (manifest === 'package.json') {
    return JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { build: 'tsc', test: 'vitest run' } });
  }
  if (manifest === 'Makefile' || manifest === 'makefile' || manifest === 'GNUmakefile') {
    return 'all:\n\tcc -o app main.c\n';
  }
  return '';
}

describe('findGatedSubprojects', () => {
  it('finds the nested crate the live incident should have been rooted at', () => {
    const crate = project('src/rust-pg-ext', 'Cargo.toml');
    expect(findGatedSubprojects(root)).toEqual([crate]);
  });

  it('says nothing when the root IS the project', () => {
    // Already correctly rooted: the root's own manifest must not be reported
    // back as somewhere to move to, or every healthy run grows a warning.
    writeFileSync(join(root, 'Cargo.toml'), '');
    project('src/util', 'nothing.txt');
    expect(findGatedSubprojects(root)).toEqual([]);
  });

  it('says nothing for a genuinely gateless tree', () => {
    // A docs repo has no gates and no better root — the advice must stay quiet
    // rather than inventing one.
    mkdirSync(join(root, 'docs', 'guides'), { recursive: true });
    writeFileSync(join(root, 'docs', 'guides', 'intro.md'), '# hi');
    expect(findGatedSubprojects(root)).toEqual([]);
  });

  it('recognises each supported manifest', () => {
    for (const manifest of ['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'Makefile', 'CMakeLists.txt']) {
      const box = mkdtempSync(join(tmpdir(), 'uap-manifest-'));
      try {
        const dir = join(box, 'app');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, manifest), manifestBody(manifest));
        expect(findGatedSubprojects(box), manifest).toEqual([dir]);
      } finally {
        rmSync(box, { recursive: true, force: true });
      }
    }
  });

  it('ignores build output and dependency directories', () => {
    // node_modules is wall-to-wall package.json; without the skip list the
    // advice would name a dependency as the project root.
    mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true });
    // Must be a package that WOULD yield gates, or the confirmation step alone
    // rejects it and the skip-list is not what this test is measuring.
    writeFileSync(
      join(root, 'node_modules', 'left-pad', 'package.json'),
      JSON.stringify({ name: 'left-pad', version: '1.0.0', scripts: { build: 'tsc', test: 'vitest run' } }),
    );
    mkdirSync(join(root, 'target', 'debug'), { recursive: true });
    writeFileSync(join(root, 'target', 'debug', 'Cargo.toml'), '');
    expect(findGatedSubprojects(root)).toEqual([]);
  });

  it('does not descend into a project it has already reported', () => {
    // A workspace member inside a crate belongs to that crate; reporting both
    // would offer the caller a root that is worse than the one above it.
    // The inner project must sit INSIDE the depth bound, or the bound rather
    // than the rule is what keeps it out and this test proves nothing.
    const crate = project('src/ext', 'Cargo.toml');
    const inner = join(crate, 'inner');
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, 'Cargo.toml'), '');
    expect(findGatedSubprojects(root, 5)).toEqual([crate]);
  });

  it('stops at the depth bound instead of walking an arbitrary tree', () => {
    project('a/b/c/d/e', 'package.json');
    expect(findGatedSubprojects(root, 3)).toEqual([]);
    expect(findGatedSubprojects(root, 5)).toHaveLength(1);
  });

  it('caps how many roots it offers', () => {
    for (const name of ['one', 'two', 'three', 'four', 'five', 'six', 'seven']) {
      project(`packages/${name}`, 'package.json');
    }
    expect(findGatedSubprojects(root, 3, 3)).toHaveLength(3);
  });

  // Root ignores mode bits, so there is no such thing as an unreadable dir for it.
  it.skipIf(process.getuid?.() === 0)('survives an unreadable directory rather than throwing', () => {
    // The startup path must not die because one subdirectory is not listable.
    // The directory has to still EXIST and be unreadable — deleting it first
    // means readdir never sees it and the catch is never reached.
    const crate = project('src/ext', 'Cargo.toml');
    const locked = join(root, 'locked');
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o000);
    try {
      expect(findGatedSubprojects(root)).toEqual([crate]);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it('reports only candidates that really yield gates', () => {
    // A manifest is not a gate. A package.json with no scripts produces no
    // rungs, so naming it would send the operator to a root exactly as
    // gateless as the one they are already on.
    const dir = join(root, 'packages', 'empty');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'empty', version: '1.0.0' }));
    expect(findGatedSubprojects(root)).toEqual([]);
  });

  it('finds a Makefile-only project, not just the manifest formats it knows by name', () => {
    const dir = join(root, 'native');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'Makefile'), 'all:\n\tcc -o app main.c\n');
    expect(findGatedSubprojects(root)).toEqual([dir]);
  });

  it('honours the visit cap so cost cannot scale with the size of the mistake', () => {
    for (let i = 0; i < 30; i += 1) mkdirSync(join(root, `d${i}`), { recursive: true });
    // Under the FIRST sibling: with the target under the last one, the frontier
    // width cap would exclude it and the visit counter could be deleted with
    // this test still green — the two bounds would be covering for each other.
    const app = project('d0/app', 'Cargo.toml');
    // Budget too small to reach it: the scan stops rather than walking on.
    expect(findGatedSubprojects(root, 3, 5, 3)).toEqual([]);
    // Same tree, budget raised — proving the bound was what stopped it, not the
    // shape of the tree.
    expect(findGatedSubprojects(root, 3, 5, 200)).toEqual([app]);
  });
});

describe('formatGatelessRootAdvice', () => {
  it('names the remediation root as an absolute --project-root', () => {
    const msg = formatGatelessRootAdvice('/srv/app', ['/srv/app/src/ext']);
    expect(msg).toContain('--project-root /srv/app/src/ext');
    expect(msg).toContain('NO compile/test gate');
  });

  it('says nothing when there is no better root to name', () => {
    expect(formatGatelessRootAdvice('/srv/app', [])).toBeNull();
  });

  it('pluralises without claiming a single subdirectory is several', () => {
    expect(formatGatelessRootAdvice('/srv/app', ['/srv/app/a'])).toContain('a subdirectory has them');
    expect(formatGatelessRootAdvice('/srv/app', ['/srv/app/a', '/srv/app/b']))
      .toContain('2 subdirectories have them');
  });
});

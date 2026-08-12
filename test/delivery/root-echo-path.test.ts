/**
 * A model writing to `<root>/<the root's own name>/...` creates a PHANTOM tree.
 *
 * Measured live 2026-08-12. A run had `--project-root .../src/rust-pg-ext` but
 * addressed files as `src/rust-pg-ext/src/lib.rs` — repo-root-relative paths,
 * one level too deep for the root it was given. Nothing corrected them, so:
 *
 *   src/rust-pg-ext/src/lib.rs                   <- the real crate file, untouched
 *   src/rust-pg-ext/src/rust-pg-ext/src/lib.rs   <- where 20 minutes of work went
 *
 * The self-authored gate then read the phantom too, so the run reported
 * progress while the crate never changed, and the caller sat in a follow loop
 * waiting for a mission that could never land.
 *
 * The rule is deliberately narrow: rewrite ONLY when the echoed prefix is the
 * root's own trailing segments AND the stripped path resolves to something
 * that already exists, AND the doubled path does NOT. That last clause is what
 * keeps a genuinely nested layout (`packages/foo/packages/foo`) working — if
 * the deeper path is real, it is left alone. Catching the FIRST such write is
 * enough, because the phantom is what creates the ambiguity.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { normalizeToolPath } from '../../src/delivery/path-normalize.js';

describe('a path that echoes the project root', () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'uap-rootecho-'));
    root = join(base, 'src', 'rust-pg-ext');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'lib.rs'), 'fn a() {}\n');
    writeFileSync(join(root, 'setup.sql'), '-- sql\n');
    writeFileSync(join(root, 'Cargo.toml'), '[package]\n');
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const norm = (p: string, forWrite = false) => normalizeToolPath(root, p, { forWrite });

  it('strips the echo on a WRITE, so the phantom is never created', () => {
    const r = norm('src/rust-pg-ext/src/lib.rs', true);
    expect(r.path, 'this is the write that made the phantom').toBe('src/lib.rs');
    expect(r.changed).toBe(true);
  });

  it('strips it on a READ too, so the model sees the real file', () => {
    expect(norm('src/rust-pg-ext/src/lib.rs').path).toBe('src/lib.rs');
  });

  it('handles a file directly under the root', () => {
    expect(norm('src/rust-pg-ext/setup.sql').path).toBe('setup.sql');
    expect(norm('src/rust-pg-ext/Cargo.toml').path).toBe('Cargo.toml');
  });

  it('echoes only the LAST root segment too', () => {
    // The model often repeats just the crate directory, not the full prefix.
    expect(norm('rust-pg-ext/src/lib.rs').path).toBe('src/lib.rs');
  });

  it('lets a NEW file through when its parent directory exists', () => {
    // Nothing to compare against by existence, but the destination directory
    // is real, so the intent is unambiguous.
    const r = norm('src/rust-pg-ext/src/new_module.rs', true);
    expect(r.path).toBe('src/new_module.rs');
  });
});

describe('what it must NOT touch', () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'uap-rootecho2-'));
    root = join(base, 'packages', 'foo');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), 'export {};\n');
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('leaves a correct path alone', () => {
    const r = normalizeToolPath(root, 'src/index.ts', {});
    expect(r.changed).toBe(false);
  });

  it('leaves a GENUINELY nested same-name tree alone', () => {
    // A real `packages/foo/packages/foo/...` layout. The deeper path exists,
    // so it is what the model meant.
    mkdirSync(join(root, 'packages', 'foo', 'src'), { recursive: true });
    writeFileSync(join(root, 'packages', 'foo', 'src', 'index.ts'), 'export {};\n');
    const r = normalizeToolPath(root, 'packages/foo/src/index.ts', {});
    expect(r.path, 'the nested file is real — do not redirect to the outer one').toBe(
      'packages/foo/src/index.ts'
    );
    expect(r.changed).toBe(false);
  });

  it('does not invent a target that does not exist anywhere', () => {
    const r = normalizeToolPath(root, 'packages/foo/nowhere/absent.ts', {});
    expect(r.path).toBe('packages/foo/nowhere/absent.ts');
    expect(r.changed).toBe(false);
  });

  it('does not fire on a path that merely starts with a similar name', () => {
    // Both files exist, so a loosened (substring) segment comparison would
    // happily redirect `foobar/x.ts` onto `x.ts`. Segments must match WHOLE.
    mkdirSync(join(root, 'foobar'), { recursive: true });
    writeFileSync(join(root, 'foobar', 'x.ts'), 'export {};\n');
    writeFileSync(join(root, 'x.ts'), 'export {};\n');
    const r = normalizeToolPath(root, 'foobar/x.ts', {});
    expect(r.path, 'foobar is not foo').toBe('foobar/x.ts');
    expect(r.changed).toBe(false);
  });

  it('does not redirect a MISSING path under a similarly-named directory', () => {
    // The case above returns early because the deep path exists. Here it does
    // NOT, so the segment comparison actually runs — and a substring test
    // ('foobar' contains 'foo') would strip the prefix and silently retarget
    // the write onto a real file one level up.
    writeFileSync(join(root, 'absent.ts'), 'export {};\n');
    mkdirSync(join(root, 'foobar'), { recursive: true });
    const r = normalizeToolPath(root, 'foobar/absent.ts', { forWrite: true });
    expect(r.path, 'a whole-segment match is the only safe one').toBe('foobar/absent.ts');
    expect(r.changed).toBe(false);
  });
});

describe('a root whose own last segments repeat', () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    // `.../foo/foo` — now BOTH a one-segment and a two-segment echo match, and
    // they strip to different files. The rule takes the longest, which is the
    // full root name rather than a suffix of it.
    base = mkdtempSync(join(tmpdir(), 'uap-rootecho3-'));
    root = join(base, 'foo', 'foo');
    mkdirSync(join(root, 'foo'), { recursive: true });
    writeFileSync(join(root, 'bar.ts'), 'export {};\n');
    writeFileSync(join(root, 'foo', 'bar.ts'), 'export {};\n');
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('strips the LONGEST echo, not the shortest', () => {
    const r = normalizeToolPath(root, 'foo/foo/bar.ts', {});
    expect(r.path).toBe('bar.ts');
    expect(r.changed).toBe(true);
  });
});

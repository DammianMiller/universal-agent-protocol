/**
 * Scope notice: name the files a mission asks for but cannot reach.
 *
 * Built from a live failure (cognition-engine, 2026-08-09). A run scoped to
 * `<repo>/src/rust-pg-ext` was told to edit `src/sql/setup.sql`, which lives at
 * `<repo>/src/sql/setup.sql`. `safePath` refused `../sql/setup.sql` — correctly
 * — and the model then CREATED a 1.5KB stub at `<crate>/src/sql/setup.sql`,
 * which is inside the root and therefore allowed. The guard deflected it into
 * writing a plausible file in the wrong place.
 *
 * The signal has to be quiet by default: it rides the executor prompt, so a
 * false positive is a false instruction. Most of these tests are about what it
 * must NOT say.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  findRepoRoot,
  formatScopeNotice,
  mentionedPaths,
  unreachablePaths,
} from '../../src/delivery/scope-notice.js';

/** A repo with `crate/` inside it, plus whichever files are asked for. */
function repo(files: string[]): { root: string; crate: string } {
  const root = mkdtempSync(join(tmpdir(), 'uap-scope-'));
  mkdirSync(join(root, '.git'), { recursive: true });
  const crate = join(root, 'crate');
  mkdirSync(crate, { recursive: true });
  for (const f of files) {
    const abs = join(root, f);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, 'x');
  }
  return { root, crate };
}

describe('mentionedPaths — what counts as a path in free text', () => {
  it('finds a path inside markdown emphasis and trailing punctuation', () => {
    expect(mentionedPaths('edit **src/sql/setup.sql**, then rebuild.')).toEqual([
      'src/sql/setup.sql',
    ]);
  });

  it('ignores prose that merely looks path-ish', () => {
    // Versions, abbreviations and bare words are the noise that would make this
    // signal untrustworthy — and it is injected into the prompt.
    // `github.com/org/repo.git` is the case that matters: it HAS slashes and an
    // extension, so only the source-extension allow-list rejects it. Without
    // that list it would be injected into the prompt as a file to edit.
    const text =
      'Bump to v1.2.3 (e.g. node.js 20). Clone github.com/org/repo.git first. '
      + 'See the setup docs and src/sql.';
    expect(mentionedPaths(text)).toEqual([]);
  });

  it('ignores a bare filename with no directory — too weak to act on', () => {
    expect(mentionedPaths('update Cargo.toml please')).toEqual([]);
  });

  it('de-duplicates repeated mentions, keeping first-seen order', () => {
    const text = 'src/a.rs then src/b.rs then src/a.rs again';
    expect(mentionedPaths(text)).toEqual(['src/a.rs', 'src/b.rs']);
  });
});

describe('unreachablePaths — absent here, present above', () => {
  it('reports the live case: named file lives above the project root', () => {
    const { root, crate } = repo(['src/sql/setup.sql']);
    const out = unreachablePaths('edit **src/sql/setup.sql** lines 22-29', crate, root);
    expect(out).toHaveLength(1);
    expect(out[0].mentioned).toBe('src/sql/setup.sql');
    rmSync(root, { recursive: true, force: true });
  });

  it('says NOTHING when the file is reachable inside the project root', () => {
    // Present in BOTH places on purpose. With it only under the crate, the
    // "present above" check would suppress the notice on its own and this
    // would pass no matter what the "absent here" check did — a mutant that
    // deleted that check survived exactly this test.
    const { root, crate } = repo(['crate/src/sql/setup.sql', 'src/sql/setup.sql']);
    expect(unreachablePaths('edit src/sql/setup.sql', crate, root)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it('says NOTHING for a file absent everywhere — the model will create it', () => {
    // The whole point of a delivery run is authoring new files; flagging those
    // would fire on nearly every mission.
    const { root, crate } = repo([]);
    expect(unreachablePaths('create src/new/module.rs', crate, root)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it('says NOTHING when the project root IS the repo root', () => {
    // Nothing is "above" — there is no scope mistake to make.
    const { root } = repo(['src/sql/setup.sql']);
    expect(unreachablePaths('edit src/sql/setup.sql', root, root)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it('says NOTHING when the search root is not an ancestor', () => {
    // The unrelated directory must CONTAIN the file, otherwise "absent
    // everywhere" suppresses the notice and the ancestor guard is never
    // exercised. Without the guard this reports a path as "out of scope of"
    // a directory that has nothing to do with the run.
    const { root, crate } = repo([]);
    const elsewhere = mkdtempSync(join(tmpdir(), 'uap-other-'));
    const stray = join(elsewhere, 'src/sql/setup.sql');
    mkdirSync(dirname(stray), { recursive: true });
    writeFileSync(stray, 'x');
    expect(unreachablePaths('edit src/sql/setup.sql', crate, elsewhere)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  });
});

describe('findRepoRoot', () => {
  it('finds the enclosing repo above a subproject', () => {
    const { root, crate } = repo([]);
    expect(findRepoRoot(crate)).toBe(root);
    rmSync(root, { recursive: true, force: true });
  });

  it('returns null at the repo root itself — nothing above to be out of scope of', () => {
    const { root } = repo([]);
    expect(findRepoRoot(root)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });
});

describe('formatScopeNotice', () => {
  it('is null when there is nothing to report', () => {
    expect(formatScopeNotice([], '/p', '/r')).toBeNull();
  });

  it('forbids the substitute file — the move that actually caused the damage', () => {
    const notice = formatScopeNotice(
      [{ mentioned: 'src/sql/setup.sql', foundAt: '../../src/sql/setup.sql' }],
      '/repo/crate',
      '/repo'
    );
    expect(notice).toContain('src/sql/setup.sql');
    expect(notice).toMatch(/do NOT create a same-named file/i);
    // And says where the run should have been, so it is actionable.
    expect(notice).toContain('/repo');
  });
});

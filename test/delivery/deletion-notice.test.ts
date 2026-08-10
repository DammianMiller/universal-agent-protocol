/**
 * Deletion missions: say so up front, because deliver cannot delete.
 *
 * The executor has no delete tool and no shell unless the operator enabled it,
 * so a model told to remove a file has one move left — overwrite it with a
 * stub. That half-works, which is the damage.
 *
 * Observed live 2026-08-10, instruction "Clean up nested architecture: remove
 * src/rust-pg-ext/src/contracts.rs, cooccurrence.rs, hash.rs, slope.rs, …":
 *
 *   r8  edit_file contracts.rs     -> OK      -> cargo check now FAILING
 *   r12 edit_file sr_lookup.rs     -> refused (anti-gutting)
 *   Turn 1: 20% of gates (435s)
 *
 * Anti-gutting only fires at 1500 bytes or more, so SMALL files were replaced
 * with `// REMOVED` and broke the build, while large ones were refused and left
 * the job half-done. Neither can reach green.
 *
 * The negatives carry most of the weight here: this rides the executor prompt,
 * so a false positive is a false instruction telling a model not to do the work
 * it was asked for.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { deletionTargets, formatDeletionNotice } from '../../src/delivery/deletion-notice.js';

const roots: string[] = [];
function project(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'uap-delnotice-'));
  roots.push(root);
  for (const rel of files) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, 'x');
  }
  return root;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe('deletionTargets — what counts as "delete this file"', () => {
  it('finds the live case: a comma-separated list after the verb', () => {
    const root = project(['src/contracts.rs', 'src/cooccurrence.rs', 'src/hash.rs']);
    const got = deletionTargets(
      'Clean up nested architecture: remove src/contracts.rs, src/cooccurrence.rs, src/hash.rs',
      root
    );
    expect(got).toEqual(['src/contracts.rs', 'src/cooccurrence.rs', 'src/hash.rs']);
  });

  it('accepts the ordinary phrasings', () => {
    const root = project(['src/a.rs', 'src/b.rs', 'src/legacy/old.ts']);
    expect(deletionTargets('delete src/a.rs', root)).toEqual(['src/a.rs']);
    expect(deletionTargets('Delete the file src/a.rs and update callers', root)).toEqual(['src/a.rs']);
    expect(deletionTargets('remove the unused module src/legacy/old.ts', root)).toEqual(['src/legacy/old.ts']);
    expect(deletionTargets('rm src/a.rs, src/b.rs', root)).toEqual(['src/a.rs', 'src/b.rs']);
  });
});

describe('it stays silent when the verb governs something that is NOT a file', () => {
  // Each of these names a real path AND a deletion verb, and each is an EDIT.
  // Telling the model "do this outside deliver" would be wrong every time.
  it('ignores an edit whose object is a thing inside the file', () => {
    const root = project(['src/a.rs', 'src/b.rs']);
    for (const text of [
      'remove the unused import from src/a.rs',
      'remove the call to foo() in src/a.rs',
      'delete dead code inside src/b.rs',
      'drop the deprecated field from the struct in src/a.rs',
      'Refactor src/a.rs to remove duplication',
    ]) {
      expect(deletionTargets(text, root), text).toEqual([]);
    }
  });

  it('ignores a deletion with no path at all', () => {
    const root = project(['src/a.rs']);
    expect(deletionTargets('remove the old behaviour', root)).toEqual([]);
    expect(deletionTargets('delete unused imports everywhere', root)).toEqual([]);
  });

  it('ignores a path that does not exist — already gone, or prose', () => {
    const root = project(['src/a.rs']);
    expect(deletionTargets('remove src/never-existed.rs', root)).toEqual([]);
  });
});

describe('formatDeletionNotice', () => {
  it('is null when there is nothing to say', () => {
    expect(formatDeletionNotice([])).toBeNull();
  });

  it('names the files and the reason the stub workaround fails', () => {
    // Naming the stub outcome is the point: overwriting is the move the model
    // reaches for, so "you cannot delete" alone would send it straight there.
    const n = formatDeletionNotice(['src/a.rs']) as string;
    expect(n).toContain('src/a.rs');
    expect(n).toMatch(/stub/i);
    expect(n).toMatch(/build breaks/i);
    // Also pin WHY the model cannot just delete it — a mutant deleting this
    // sentence went unnoticed, which meant the explanation was untested.
    expect(n).toMatch(/no delete tool/i);
    expect(n).toMatch(/shell is unavailable/i);
  });

  it('points at the route that works, and says it is not gated', () => {
    const n = formatDeletionNotice(['src/a.rs']) as string;
    expect(n).toMatch(/NOT gated/);
    expect(n).toMatch(/rm <path>/);
  });
});

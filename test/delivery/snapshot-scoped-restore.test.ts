/**
 * E2 (deliver-hardening 2026-07-13): keep-best rollback restores ONLY the
 * files the run itself wrote.
 *
 * Before this, the end-of-run rollback called the whole-tree `restoreTree`:
 * in a shared worktree that reverted every other agent's concurrent,
 * legitimate edits — observed live as a frontend agent's newly written test
 * file silently rolled back by a different agent's deliver run.
 *
 * `restoreTreeScoped` takes the run's write-set (the filesApplied union) and:
 *   - restores each listed file's pre-run bytes when the snapshot holds them
 *   - DELETES each listed file the snapshot does not hold (run-created)
 *   - never touches anything else, so another agent's work survives byte-identical
 *   - rejects paths escaping the project root (the write-set is run-produced
 *     data, not a trusted operand)
 *   - never touches secret-named files (same contract as restoreTree)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { snapshotTree, restoreTreeScoped, disposeSnapshot } from '../../src/delivery/snapshot.js';

const roots: string[] = [];
const snaps: string[] = [];
afterEach(() => {
  while (snaps.length) {
    try {
      disposeSnapshot(snaps.pop() as string);
    } catch {
      /* best effort */
    }
  }
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'uap-snapscoped-'));
  roots.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.js'), 'export const a = 1;\n');
  writeFileSync(join(root, 'src', 'shared.js'), 'export const shared = 1;\n');
  return root;
}

function snap(root: string): string {
  const r = snapshotTree(root);
  const path = (r as { path?: string }).path;
  expect(path, 'snapshot must succeed for this fixture').toBeTruthy();
  snaps.push(path as string);
  return path as string;
}

describe('scoped restore (E2)', () => {
  it('restores a run-modified file and removes a run-created file', () => {
    const root = project();
    const s = snap(root);
    writeFileSync(join(root, 'src', 'a.js'), 'export const a = 999;\n');
    writeFileSync(join(root, 'src', 'new.js'), 'export const n = 1;\n');
    const touched = restoreTreeScoped(root, s, ['src/a.js', 'src/new.js']);
    expect(readFileSync(join(root, 'src', 'a.js'), 'utf8')).toContain('a = 1');
    expect(existsSync(join(root, 'src', 'new.js')), 'run-created file must not survive rollback').toBe(false);
    expect(touched).toBe(2);
  });

  it("leaves another agent's concurrent NEW file byte-identical", () => {
    const root = project();
    const s = snap(root);
    // The run damages a.js; a second agent lands an unrelated feature file.
    writeFileSync(join(root, 'src', 'a.js'), 'export const a = 999;\n');
    writeFileSync(join(root, 'src', 'feature.test.js'), '// other agent test\n');
    restoreTreeScoped(root, s, ['src/a.js']);
    expect(readFileSync(join(root, 'src', 'a.js'), 'utf8')).toContain('a = 1');
    expect(
      readFileSync(join(root, 'src', 'feature.test.js'), 'utf8'),
      "a whole-tree restore destroyed exactly this — the incident E2 fixes"
    ).toBe('// other agent test\n');
  });

  it("leaves another agent's EDIT to an existing file intact", () => {
    const root = project();
    const s = snap(root);
    writeFileSync(join(root, 'src', 'a.js'), 'export const a = 999;\n');
    writeFileSync(join(root, 'src', 'shared.js'), 'export const shared = 2;\n');
    restoreTreeScoped(root, s, ['src/a.js']);
    expect(
      readFileSync(join(root, 'src', 'shared.js'), 'utf8'),
      'files outside the run write-set must not be rewound to the snapshot'
    ).toContain('shared = 2');
  });

  it('rejects paths escaping the project root', () => {
    const root = project();
    const s = snap(root);
    const name = `escape-${Date.now()}.tmp`;
    const outside = join(root, '..', name);
    const touched = restoreTreeScoped(root, s, [`../${name}`, 'src/a.js']);
    expect(existsSync(outside), 'an escape attempt must never write outside the root').toBe(false);
    expect(touched, 'only the legitimate entry is touched').toBe(1);
  });

  it('never touches a secret-named file, even one the run wrote', () => {
    const root = project();
    writeFileSync(join(root, '.env'), 'KEY=original\n');
    const s = snap(root);
    writeFileSync(join(root, '.env'), 'KEY=overwritten\n');
    restoreTreeScoped(root, s, ['.env']);
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('KEY=overwritten\n');
  });

  it('is a no-op for an empty write-set', () => {
    const root = project();
    const s = snap(root);
    writeFileSync(join(root, 'src', 'a.js'), 'export const a = 999;\n');
    const touched = restoreTreeScoped(root, s, []);
    expect(touched).toBe(0);
    expect(readFileSync(join(root, 'src', 'a.js'), 'utf8')).toContain('a = 999');
  });

  it('rejects a path escaping through a SYMLINKED directory (realpath containment)', () => {
    // Security review (2026-07-13): the lexical resolve+prefix check passes
    // "link/.bashrc" because it resolves INSIDE root lexically while landing
    // outside it through the link. The write-set is run-produced data, so the
    // guard must hold against it.
    const root = project();
    const outside = mkdtempSync(join(tmpdir(), 'uap-snap-out-'));
    roots.push(outside);
    writeFileSync(join(outside, 'victim.txt'), 'precious\n');
    const s = snap(root);
    try {
      symlinkSync(outside, join(root, 'link'));
    } catch {
      return; // no symlink permission — nothing to assert
    }
    const touched = restoreTreeScoped(root, s, ['link/victim.txt']);
    expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('precious\n');
    expect(touched).toBe(0);
  });

  it('refuses "." — the recorded write-set must never reach rmSync on the ROOT', () => {
    const root = project();
    const s = snap(root);
    const touched = restoreTreeScoped(root, s, ['.']);
    expect(touched).toBe(0);
    expect(existsSync(join(root, 'src', 'a.js')), 'the project root must survive').toBe(true);
  });

  it('removes a run-created SYMLINK but never recurses into a DIRECTORY', () => {
    const root = project();
    const s = snap(root);
    try {
      symlinkSync(join(root, 'src', 'a.js'), join(root, 'src', 'alias.js'));
    } catch {
      return; // no symlink permission — nothing to assert
    }
    mkdirSync(join(root, 'src', 'adir'));
    writeFileSync(join(root, 'src', 'adir', 'keep.js'), '// keep\n');
    const touched = restoreTreeScoped(root, s, ['src/alias.js', 'src/adir']);
    expect(touched, 'only the symlink is removed').toBe(1);
    expect(existsSync(join(root, 'src', 'alias.js'))).toBe(false);
    expect(existsSync(join(root, 'src', 'adir', 'keep.js')), 'a directory is never rm -rf’d').toBe(true);
  });

  it('a failing path does not abort the rest, and the failure is reported', () => {
    const root = project();
    writeFileSync(join(root, 'slot.txt'), 'original\n');
    const s = snap(root);
    writeFileSync(join(root, 'src', 'a.js'), 'export const a = 999;\n');
    // slot.txt is a FILE in the snapshot but a DIRECTORY in the tree: cpSync
    // onto it fails (EISDIR) even as root, so the per-file failure path is
    // exercised everywhere — a.js must still be restored and the throw must
    // name the failure while the snapshot is preserved for inspection.
    rmSync(join(root, 'slot.txt'));
    mkdirSync(join(root, 'slot.txt'));
    expect(() => restoreTreeScoped(root, s, ['src/a.js', 'slot.txt'])).toThrow(/1 path\(s\) failed/);
    expect(readFileSync(join(root, 'src', 'a.js'), 'utf8')).toContain('a = 1');
    const meta = JSON.parse(readFileSync(join(s, '.uap-snap.json'), 'utf8'));
    expect(meta.preserve, 'a partial restore preserves the snapshot').toBe(true);
  });
});

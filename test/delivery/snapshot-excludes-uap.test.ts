/**
 * A no-regress revert must not roll back the harness's own state.
 *
 * `.uap/` holds the run's logs, its run-state checkpoints, the heartbeat and
 * the single-flight lock. It sat INSIDE the snapshot, so when a run ended worse
 * than its best and `restoreTree` fired, it took all of that with it:
 *
 *   .uap/deliver-logs/second.log : DESTROYED — the run erased its own evidence
 *   .uap run state               : rolled back from {"turn":9} to {"turn":1}
 *
 * Measured on a clean fixture 2026-08-13. Two consequences, both bad. The log
 * that explains the revert lives in `.uap/`, so the revert deletes its own
 * explanation and the run looks like it silently lost work. And rewinding the
 * checkpoint means a later `--resume` picks up from a stale turn and redoes
 * work that was already done.
 *
 * The exclusion list already carried `.uap-deliver` and `.uap-backups` under a
 * "VCS / UAP-internal" comment. `.uap` — the biggest one — was simply missed.
 * The file's contract is SYMMETRIC: an excluded entry is neither snapshotted
 * nor touched by restore, which is exactly what harness state needs.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { snapshotTree, restoreTree, disposeSnapshot } from '../../src/delivery/snapshot.js';

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
  const root = mkdtempSync(join(tmpdir(), 'uap-snapuap-'));
  roots.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.js'), 'export const a = 1;\n');
  mkdirSync(join(root, '.uap', 'deliver-logs'), { recursive: true });
  mkdirSync(join(root, '.uap', 'deliver-runs', 'run-1'), { recursive: true });
  writeFileSync(join(root, '.uap', 'deliver-logs', 'first.log'), 'turn 1\n');
  writeFileSync(join(root, '.uap', 'deliver-runs', 'run-1', 'state.json'), '{"turn":1}');
  return root;
}

function snap(root: string): string {
  const r = snapshotTree(root);
  const path = (r as { path?: string }).path;
  expect(path, 'snapshot must succeed for this fixture').toBeTruthy();
  snaps.push(path as string);
  return path as string;
}

describe('a revert leaves harness state alone', () => {
  it('keeps a log written AFTER the snapshot', () => {
    const root = project();
    const s = snap(root);
    writeFileSync(join(root, '.uap', 'deliver-logs', 'second.log'), 'turns 2..9\n');
    restoreTree(root, s);
    expect(
      existsSync(join(root, '.uap', 'deliver-logs', 'second.log')),
      'the log explaining the revert lives here — deleting it makes the revert silent'
    ).toBe(true);
  });

  it('does not rewind the run checkpoint', () => {
    const root = project();
    const s = snap(root);
    writeFileSync(join(root, '.uap', 'deliver-runs', 'run-1', 'state.json'), '{"turn":9}');
    restoreTree(root, s);
    expect(
      readFileSync(join(root, '.uap', 'deliver-runs', 'run-1', 'state.json'), 'utf8'),
      'a rewound checkpoint makes --resume redo work already done'
    ).toContain('"turn":9');
  });

  it('leaves a run created entirely after the snapshot', () => {
    const root = project();
    const s = snap(root);
    mkdirSync(join(root, '.uap', 'deliver-runs', 'run-2'), { recursive: true });
    writeFileSync(join(root, '.uap', 'deliver-runs', 'run-2', 'state.json'), '{"turn":3}');
    restoreTree(root, s);
    expect(existsSync(join(root, '.uap', 'deliver-runs', 'run-2', 'state.json'))).toBe(true);
  });

  it('leaves the self-authored gate alone', () => {
    // `.uap-deliver/verify.sh` was already excluded, but nothing pinned it.
    // A revert that deleted it would take the run's convergence target with it,
    // mid-run — the same class of loss as the logs, one directory over.
    const root = project();
    const s = snap(root);
    mkdirSync(join(root, '.uap-deliver'), { recursive: true });
    writeFileSync(join(root, '.uap-deliver', 'verify.sh'), '#!/usr/bin/env bash\nexit 1\n');
    restoreTree(root, s);
    expect(existsSync(join(root, '.uap-deliver', 'verify.sh')), 'the gate must survive a revert').toBe(true);
  });

  it('does not resurrect a lock or heartbeat the run has since cleared', () => {
    // Restoring a stale lock would make the next launch see a holder that is
    // not there; restoring a heartbeat would age-check against a dead run.
    const root = project();
    writeFileSync(join(root, '.uap', 'deliver.lock'), '12345|2026-08-13T00:00:00Z');
    const s = snap(root);
    rmSync(join(root, '.uap', 'deliver.lock'));
    restoreTree(root, s);
    expect(existsSync(join(root, '.uap', 'deliver.lock')), 'a released lock must stay released').toBe(false);
  });
});

describe('the mission tree is still reverted', () => {
  it('rolls back source written after the snapshot — that is the whole point', () => {
    const root = project();
    const s = snap(root);
    writeFileSync(join(root, 'src', 'b.js'), 'export const b = 2;\n');
    restoreTree(root, s);
    expect(existsSync(join(root, 'src', 'b.js')), 'no-regress must still undo mission changes').toBe(false);
  });

  it('restores the original content of a file the run modified', () => {
    const root = project();
    const s = snap(root);
    writeFileSync(join(root, 'src', 'a.js'), 'export const a = 999;\n');
    restoreTree(root, s);
    expect(readFileSync(join(root, 'src', 'a.js'), 'utf8')).toContain('a = 1');
  });
});

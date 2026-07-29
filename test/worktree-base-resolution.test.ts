/**
 * resolveFreshBase: which ref a new worktree is branched from.
 *
 * Two failure modes, opposite directions, both real:
 *   - local BEHIND origin  -> basing on local starts the worktree stale (the
 *     original bug; worktrees here drifted to 1241 commits behind).
 *   - local AHEAD of origin -> basing on origin starts the worktree behind
 *     unpushed local work. Observed: a fresh worktree re-bumped an already-taken
 *     version and died on `tag already exists`, because the bump it should have
 *     inherited existed only in the unpushed local branch.
 *
 * These use real repositories rather than mocks: the behaviour under test is
 * `git merge-base --is-ancestor`, so stubbing git would only assert that the
 * stub was called.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { simpleGit } from 'simple-git';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveFreshBase } from '../src/cli/worktree.js';

let root: string;
let originDir: string;
let cloneDir: string;

async function commit(dir: string, name: string) {
  writeFileSync(join(dir, name), name);
  const g = simpleGit(dir);
  await g.add('.');
  await g.commit(`add ${name}`);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'uap-wtbase-'));
  originDir = join(root, 'origin.git');
  cloneDir = join(root, 'clone');

  // Seed a repo, then publish it as the "remote".
  const seed = join(root, 'seed');
  await simpleGit().init([seed]);
  const sg = simpleGit(seed);
  await sg.addConfig('user.email', 't@t');
  await sg.addConfig('user.name', 't');
  await sg.raw(['checkout', '-b', 'master']);
  await commit(seed, 'base.txt');
  await simpleGit().raw(['clone', '--bare', seed, originDir]);

  await simpleGit().raw(['clone', originDir, cloneDir]);
  const cg = simpleGit(cloneDir);
  await cg.addConfig('user.email', 't@t');
  await cg.addConfig('user.name', 't');
});

afterEach(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('resolveFreshBase', () => {
  it('uses the LOCAL branch when it is ahead of origin (unpushed merges)', async () => {
    await commit(cloneDir, 'local-only.txt');
    const base = await resolveFreshBase(simpleGit(cloneDir), { noFetch: true });
    expect(base).toBe('master');
  });

  it('uses origin when local is BEHIND, so a worktree is never born stale', async () => {
    // Advance the remote via a second clone, then fetch so the tracking ref
    // moves ahead of this clone's local master.
    const other = join(root, 'other');
    await simpleGit().raw(['clone', originDir, other]);
    const og = simpleGit(other);
    await og.addConfig('user.email', 't@t');
    await og.addConfig('user.name', 't');
    await commit(other, 'remote-only.txt');
    await og.raw(['push', 'origin', 'master']);

    await simpleGit(cloneDir).raw(['fetch', 'origin', 'master']);
    const base = await resolveFreshBase(simpleGit(cloneDir), { noFetch: true });
    expect(base).toBe('origin/master');
  });

  it('uses origin when the two have DIVERGED (neither contains the other)', async () => {
    const other = join(root, 'other');
    await simpleGit().raw(['clone', originDir, other]);
    const og = simpleGit(other);
    await og.addConfig('user.email', 't@t');
    await og.addConfig('user.name', 't');
    await commit(other, 'remote-side.txt');
    await og.raw(['push', 'origin', 'master']);

    await commit(cloneDir, 'local-side.txt');       // local gains its own commit
    await simpleGit(cloneDir).raw(['fetch', 'origin', 'master']);

    const base = await resolveFreshBase(simpleGit(cloneDir), { noFetch: true });
    expect(base).toBe('origin/master');
  });

  it('uses origin when local and origin are identical', async () => {
    const base = await resolveFreshBase(simpleGit(cloneDir), { noFetch: true });
    // Equal refs: origin IS an ancestor of local, so local is chosen — and the
    // two point at the same commit, so the worktree content is identical.
    const local = await simpleGit(cloneDir).revparse(['master']);
    const remote = await simpleGit(cloneDir).revparse(['origin/master']);
    expect(local).toBe(remote);
    expect(['master', 'origin/master']).toContain(base);
  });
});

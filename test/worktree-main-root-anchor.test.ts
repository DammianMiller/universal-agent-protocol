import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { simpleGit } from 'simple-git';
import { mainRootOf } from '../src/cli/worktree.js';

/**
 * Every worktree subcommand must anchor at the MAIN checkout. Observed live
 * (2026-08-13): `worktree create` run with cwd inside an existing worktree
 * created a NESTED tree (.worktrees/219-x/.worktrees/001-y) on a rolled-over
 * id — the nested .uap/ got its own id database, which is where the rollover
 * came from. The phantom-nested-root class, in the tool meant to prevent it.
 */

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`);
  return r.stdout;
};

describe('mainRootOf', () => {
  let main: string;

  beforeEach(() => {
    main = mkdtempSync(join(tmpdir(), 'uap-mainroot-'));
    git(main, 'init', '-q');
    writeFileSync(join(main, 'a.txt'), 'x');
    git(main, 'add', '-A');
    git(main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'baseline');
  });
  afterEach(() => rmSync(main, { recursive: true, force: true }));

  it('resolves the main checkout from the main checkout', async () => {
    const resolved = await mainRootOf(simpleGit(main));
    expect(await realpath(resolved)).toBe(await realpath(main));
  });

  it('resolves the MAIN checkout when called from inside a linked worktree', async () => {
    const linked = join(main, '.worktrees', '007-linked');
    git(main, 'worktree', 'add', '-q', '-b', 'feature/007-linked', linked);
    expect(existsSync(linked)).toBe(true);

    const resolved = await mainRootOf(simpleGit(linked));
    // The anchor MUST be the main root, not the linked worktree — anchoring
    // here is what prevents .worktrees/ nesting and id-database forking.
    expect(await realpath(resolved)).toBe(await realpath(main));
    expect(resolved).not.toBe(linked);
  });
});

async function realpath(p: string): Promise<string> {
  const { realpath: rp } = await import('node:fs/promises');
  return rp(p);
}

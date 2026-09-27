/**
 * `uap worktree ensure --strict` must SUCCEED when invoked from inside a
 * linked worktree.
 *
 * Regression (2026-09-27): worktreeCommand re-anchors every subcommand at the
 * MAIN checkout (the 2026-08-13 nested-worktree fix), but `ensure` then asked
 * the ANCHORED path whether it contained '.worktrees/' — it never does, so the
 * mandatory gate exited 1 from inside every healthy worktree, blocking all
 * edits the gate itself demands. `ensure` must answer about where the user
 * INVOKED it from; the anchor is for repo writes (create/sync/pr), not for
 * this read-only check.
 *
 * Hermetic: a throwaway git repo with a linked worktree stands in for the
 * project, so no state of the real checkout is touched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const CLI = resolve(process.cwd(), 'dist', 'bin', 'cli.js');
// BUILD ORDER: this suite executes the BUILT CLI, so it tests whatever dist
// currently holds — run `npm run build` before vitest after touching
// src/cli/worktree.ts, or a stale dist silently tests old code.
let main: string;
let wt: string;

/** Strip hook-poisoning git vars so every spawn targets the temp repo. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX']) {
    delete env[k];
  }
  return env;
}

function git(args: string[], cwd = main): void {
  const r = spawnSync('git', ['-C', cwd, ...args], { env: cleanEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

function makeRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'uap-wtens-'));
  spawnSync('git', ['init', '-q', d], { env: cleanEnv() });
  git(['config', 'user.email', 't@t'], d);
  git(['config', 'user.name', 't'], d);
  // worktree enforcement on, so the strict check actually engages
  writeFileSync(join(d, '.uap.json'), JSON.stringify({ worktrees: { enforce: true } }));
  writeFileSync(join(d, 'file.txt'), 'x\n');
  git(['add', '-A'], d);
  git(['commit', '-qm', 'baseline'], d);
  return d;
}

function runEnsure(cwd: string) {
  return spawnSync(process.execPath, [CLI, 'worktree', 'ensure', '--strict'], {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    env: cleanEnv(),
  });
}

describe('uap worktree ensure --strict (invocation point, not the anchor)', () => {
  beforeAll(() => {
    if (!existsSync(CLI)) throw new Error(`build first: ${CLI} missing`);
    main = makeRepo();
    wt = join(main, '.worktrees', '001-fix');
    git(['worktree', 'add', '-q', wt, '-b', 'feature/001-fix']);
  });
  afterAll(() => {
    try {
      git(['worktree', 'remove', '--force', wt]);
    } catch {
      /* already gone */
    }
    rmSync(main, { recursive: true, force: true });
  });

  it('succeeds (exit 0) when invoked with cwd inside the linked worktree', () => {
    const r = runEnsure(wt);
    // ora spinner text lands on stderr in non-TTY runs; the durable contract
    // is the exit code, the printed worktree path, and no refusal.
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/NOT in a worktree/);
    expect(`${r.stdout}${r.stderr}`).toContain(wt);
  });

  it('still fails (exit 1) when invoked from the main checkout', () => {
    const r = runEnsure(main);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/NOT in a worktree/);
  });
});

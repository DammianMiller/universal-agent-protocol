/**
 * branch-freshness enforcer — the branch-coarse backstop for stale work.
 *
 * Where coordinate-file.sh is file-precise (block only when THIS file moved
 * upstream), this catches the other failure mode: a branch so far behind that its
 * whole model of the codebase is wrong and the "merge" is really a rewrite.
 *
 * Runs against real git repos — the enforcer's entire job is reading git state,
 * so a mocked one would only prove the mock works.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ENFORCER = join(process.cwd(), 'src', 'policies', 'enforcers', 'branch_freshness.py');

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function run(
  filePath: string,
  worktreeRoot: string,
  env: Record<string, string> = {}
): { exit: number; allowed: boolean; reason: string; behind?: number } {
  const baseEnv = { ...process.env };
  // Hermetic: an ambient override would mask every "still blocks" assertion.
  delete baseEnv.UAP_NO_FRESHNESS;
  delete baseEnv.UAP_FRESHNESS_WARN;
  delete baseEnv.UAP_FRESHNESS_BLOCK;
  const r = spawnSync(
    'python3',
    [ENFORCER, '--operation', 'Edit', '--args', JSON.stringify({ file_path: filePath })],
    { env: { ...baseEnv, UAP_WORKTREE_ROOT: worktreeRoot, ...env }, encoding: 'utf8' }
  );
  let parsed: { allowed?: boolean; reason?: string; behind?: number } = {};
  try {
    parsed = JSON.parse(r.stdout || '{}');
  } catch {
    /* leave empty */
  }
  return {
    exit: r.status ?? -1,
    allowed: parsed.allowed ?? false,
    reason: parsed.reason ?? '',
    behind: parsed.behind,
  };
}

/** Clone with `n` commits landed on origin that the feature branch does not have. */
function repoBehindBy(n: number): { work: string; file: string } {
  const base = mkdtempSync(join(tmpdir(), 'uap-freshness-'));
  tmpDirs.push(base);
  const remote = join(base, 'remote');
  const work = join(base, '.worktrees', '001-feature');
  mkdirSync(remote, { recursive: true });
  mkdirSync(join(base, '.worktrees'), { recursive: true });

  git(remote, 'init', '-q', '--bare');
  git(base, 'clone', '-q', remote, '.worktrees/001-feature');
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'config', 'user.name', 'test');
  writeFileSync(join(work, 'seed.ts'), 'v1\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'init');
  git(work, 'branch', '-M', 'master');
  git(work, 'push', '-qu', 'origin', 'master');

  git(work, 'checkout', '-qb', 'feature/x');
  git(work, 'checkout', '-q', 'master');
  for (let i = 0; i < n; i++) {
    writeFileSync(join(work, `landed-${i}.ts`), `v${i}\n`);
    git(work, 'add', '-A');
    git(work, 'commit', '-qm', `landed ${i}`);
  }
  if (n > 0) git(work, 'push', '-q', 'origin', 'master');
  git(work, 'checkout', '-q', 'feature/x');
  git(work, 'fetch', '-q', 'origin', 'master');

  mkdirSync(join(work, 'src'), { recursive: true });
  const file = join(work, 'src', 'edit-me.ts');
  writeFileSync(file, 'x\n');
  return { work, file };
}

describe('branch-freshness enforcer', () => {
  it('allows a branch inside the drift ceiling', () => {
    const { work, file } = repoBehindBy(2);
    const r = run(file, work);
    expect(r.exit).toBe(0);
    expect(r.allowed).toBe(true);
    expect(r.behind).toBe(2);
  });

  it('blocks a branch past the ceiling, and names the remedy', () => {
    const { work, file } = repoBehindBy(4);
    const r = run(file, work, { UAP_FRESHNESS_BLOCK: '3', UAP_FRESHNESS_WARN: '2' });
    expect(r.exit).toBe(2);
    expect(r.allowed).toBe(false);
    expect(r.behind).toBe(4);
    expect(r.reason).toContain('uap worktree sync');
  });

  it('warns without blocking between the two thresholds', () => {
    const { work, file } = repoBehindBy(3);
    const r = run(file, work, { UAP_FRESHNESS_WARN: '2', UAP_FRESHNESS_BLOCK: '10' });
    expect(r.exit).toBe(0);
    expect(r.allowed).toBe(true);
    expect(r.reason).toContain('commits behind');
  });

  it('honours UAP_NO_FRESHNESS=1', () => {
    const { work, file } = repoBehindBy(4);
    const r = run(file, work, { UAP_FRESHNESS_BLOCK: '1', UAP_NO_FRESHNESS: '1' });
    expect(r.allowed).toBe(true);
  });

  it('ignores edits outside a worktree', () => {
    const { work } = repoBehindBy(4);
    // Not under .worktrees/ — governed by worktree-required, not this gate.
    const r = run('/tmp/somewhere/else.ts', work, { UAP_FRESHNESS_BLOCK: '1' });
    expect(r.allowed).toBe(true);
    expect(r.reason).toContain('not a worktree edit');
  });

  it('ignores non-edit operations', () => {
    const { work, file } = repoBehindBy(4);
    const baseEnv = { ...process.env };
    delete baseEnv.UAP_NO_FRESHNESS;
    const r = spawnSync(
      'python3',
      [ENFORCER, '--operation', 'Read', '--args', JSON.stringify({ file_path: file })],
      { env: { ...baseEnv, UAP_WORKTREE_ROOT: work, UAP_FRESHNESS_BLOCK: '1' }, encoding: 'utf8' }
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).allowed).toBe(true);
  });

  it('fails open when there is no remote to compare against', () => {
    const base = mkdtempSync(join(tmpdir(), 'uap-freshness-noremote-'));
    tmpDirs.push(base);
    const work = join(base, '.worktrees', '001-solo');
    mkdirSync(work, { recursive: true });
    git(work, 'init', '-q');
    git(work, 'config', 'user.email', 'test@example.com');
    git(work, 'config', 'user.name', 'test');
    writeFileSync(join(work, 'a.ts'), 'x\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-qm', 'init');

    const r = run(join(work, 'a.ts'), work, { UAP_FRESHNESS_BLOCK: '1' });
    expect(r.exit).toBe(0);
    expect(r.allowed).toBe(true);
  });

  it('falls back to defaults on a non-numeric threshold rather than crashing', () => {
    const { work, file } = repoBehindBy(2);
    const r = run(file, work, { UAP_FRESHNESS_BLOCK: 'not-a-number' });
    expect(r.exit).toBe(0);
    expect(r.allowed).toBe(true);
  });

  it('never lets a warn threshold above the block threshold silence the block', () => {
    // warn > block would otherwise mean the warn branch never fires; the clamp
    // keeps the pair coherent instead of silently disabling the advisory tier.
    const { work, file } = repoBehindBy(4);
    const r = run(file, work, { UAP_FRESHNESS_BLOCK: '3', UAP_FRESHNESS_WARN: '99' });
    expect(r.exit).toBe(2);
    expect(r.allowed).toBe(false);
  });
});

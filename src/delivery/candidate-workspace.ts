/**
 * Candidate Workspaces — git-worktree isolation for parallel best-of-N
 * exploration.
 *
 * The explorer's default evaluation is sequential apply → verify → rollback in
 * ONE tree (gates cannot run concurrently in a shared tree, and losers' gate
 * side effects leak into later candidates). A workspace provider gives each
 * candidate its own detached git worktree of HEAD, so candidates verify
 * concurrently and in full isolation; only the winner is re-applied and
 * re-verified in the real tree.
 *
 * Availability is conservative: provider construction returns null unless the
 * project is a git repo with a CLEAN status — uncommitted changes would be
 * invisible inside a worktree of HEAD, silently changing what candidates are
 * judged against. Everything is fail-soft: any error at any step means "no
 * workspace", and the explorer falls back to the sequential in-tree path.
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export interface CandidateWorkspace {
  /** Root of the isolated tree the candidate is applied + verified in. */
  root: string;
  /** Remove the worktree. Never throws. */
  cleanup(): void;
}

/** Returns an isolated workspace, or null to fall back to in-tree evaluation. */
export type WorkspaceProvider = () => CandidateWorkspace | null;

function git(projectRoot: string, args: string[], timeoutMs = 15_000): string {
  return execFileSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf-8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'ignore'],
    // Never inherit a poisoned GIT_DIR from a hook environment.
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined },
  });
}

export function isParallelExploreEnabled(): boolean {
  const v = (process.env.UAP_DELIVER_PARALLEL_EXPLORE ?? '').toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}

/**
 * Build a git-worktree workspace provider for `projectRoot`, or null when
 * isolation is unavailable (not a git repo, dirty tree, env opt-out).
 */
export function createGitWorktreeProvider(projectRoot: string): WorkspaceProvider | null {
  if (!isParallelExploreEnabled()) return null;
  try {
    if (git(projectRoot, ['rev-parse', '--is-inside-work-tree']).trim() !== 'true') return null;
    // A dirty tree means HEAD is not what the loop is actually converging on.
    if (git(projectRoot, ['status', '--porcelain']).trim() !== '') return null;
    // Sweep worktree registrations a crashed earlier run left behind.
    git(projectRoot, ['worktree', 'prune']);
  } catch {
    return null;
  }

  return (): CandidateWorkspace | null => {
    let dir: string | null = null;
    try {
      // Re-check cleanliness EVERY call: the explorer applies each turn's
      // winner to the main tree as uncommitted writes, so from turn 2 the
      // tree is dirty and a worktree of HEAD would be a stale baseline —
      // candidates must then fall back to the sequential in-tree path.
      if (git(projectRoot, ['status', '--porcelain']).trim() !== '') return null;
      dir = mkdtempSync(join(tmpdir(), 'uap-candidate-'));
      const root = join(dir, 'tree');
      git(projectRoot, ['worktree', 'add', '--detach', root, 'HEAD'], 60_000);
      // Gates need dependencies; share the main tree's node_modules by
      // symlink (same convention as the repo's own worktree workflow).
      // Residual sharing, accepted: the link is WRITABLE, so concurrent gate
      // runs share tool caches (.cache/.vite etc.) and gate-executed code has
      // the same reach it already has on the sequential in-tree path.
      const mainModules = join(projectRoot, 'node_modules');
      const wtModules = join(root, 'node_modules');
      if (existsSync(mainModules) && !existsSync(wtModules)) {
        try {
          symlinkSync(mainModules, wtModules, 'junction');
        } catch {
          // gates may still work without it (pure-node projects)
        }
      }
      const cleanup = (): void => {
        try {
          git(projectRoot, ['worktree', 'remove', '--force', root], 60_000);
        } catch {
          // fall through to raw dir removal
        }
        try {
          if (dir) rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort
        }
        try {
          git(projectRoot, ['worktree', 'prune']);
        } catch {
          // best-effort
        }
      };
      return { root, cleanup };
    } catch {
      try {
        if (dir) rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      return null;
    }
  };
}

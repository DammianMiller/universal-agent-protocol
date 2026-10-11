/**
 * The main-checkout root anchor (moved from src/policies/liveness.ts so
 * non-policy state can share it without importing the policies layer).
 *
 * The gate hook strips `/.worktrees/<name>` to find it
 * (${CHECKOUT_ROOT%%/.worktrees/*}); the writers must anchor the same way or
 * a worktree session — the workflow CLAUDE.md MANDATES — writes state and
 * reads it back where other surfaces never look (review should-fix,
 * 2026-07-13; reintroduced as a BLOCKER by the 2026-10-11 attention-queue
 * review: dashboard cwd, hook PROJECT_DIR, and CLI cwd resolved three
 * different queue files). Non-git roots (unit fixtures, tmp dirs) pass
 * through unchanged.
 */
import { spawnSync } from 'child_process';
import { sep } from 'path';

/** Roots are stable for a process lifetime; callers resolve this on every
 *  queue read/write and must not spawn git per call. */
const cache = new Map<string, string>();

export function mainCheckoutRoot(projectRoot: string): string {
  const hit = cache.get(projectRoot);
  if (hit !== undefined) return hit;
  let root = projectRoot;
  try {
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: projectRoot,
      encoding: 'utf-8',
    });
    if (r.status === 0) {
      const top = (r.stdout ?? '').trim();
      if (top) {
        const i = top.indexOf(`${sep}.worktrees${sep}`);
        root = i === -1 ? top : top.slice(0, i);
      }
    }
  } catch {
    root = projectRoot;
  }
  cache.set(projectRoot, root);
  return root;
}

/**
 * Task Workspaces — git-worktree isolation for PARALLEL orchestrated tasks.
 *
 * The blackboard orchestrator can dispatch independent READY tasks
 * concurrently (ATG dependency-aware parallel dispatch), but deliver's
 * production runTask was not concurrency-safe: every loop mutated the same
 * working tree and gates raced. This module gives each task its own detached
 * git worktree — like the explorer's candidate workspaces, with one crucial
 * difference: an orchestrated mission accumulates UNCOMMITTED work in the
 * main tree (each merged task's files), so a bare worktree of HEAD would be a
 * stale baseline from the second wave on. `acquire` therefore SYNCS the main
 * tree's uncommitted state into the worktree and freezes it as a detached
 * baseline commit; `mergeBack` applies only the task's own delta (diff vs
 * that baseline) to the main tree.
 *
 * Merge-backs must be SERIALIZED by the caller (deliver holds a merge lock):
 * the main tree changes one task at a time. A conflicting delta returns
 * `{ok:false}` — the caller fails the task, and the orchestrator's minimal
 * repair retries it in a FRESH workspace seeded with the updated baseline,
 * so conflicts resolve themselves through the ATG repair path.
 *
 * Everything is fail-soft: manager construction returns null off-git;
 * `acquire` returns null on any error (caller falls back to serialized
 * in-tree execution); `cleanup` never throws.
 *
 * Known, accepted limitations (same class as candidate-workspace):
 * - gitignored-but-required files (.env, local fixtures) are NOT seeded
 *   (`--exclude-standard`) — a gate depending on them can fail here while
 *   passing in-tree;
 * - under parallel dispatch the mission's aggregate telemetry (history,
 *   HALO traces, finalFeedback) interleaves across concurrent loops;
 * - `parallelTasks` should be sized to CPU cores, not inference slots: the
 *   model-slot lease bounds model calls, but concurrent GATE runs (npm
 *   test/build per worktree) have no governor.
 */

import { execFileSync } from 'child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

export interface TaskWorkspace {
  /** Root of the isolated tree the task's loop + gates run in. */
  root: string;
  /** Apply this task's delta (vs its frozen baseline) to the main tree.
   * MUST be called under the caller's merge lock. `isBlocked` refuses the
   * whole merge when any delta path hits it (defense-in-depth for protected
   * tests/gate configs — in-worktree layers already block writes, but the
   * boundary re-checks rather than trusting transitively). Never throws. */
  mergeBack(isBlocked?: (file: string) => boolean): { ok: boolean; files: string[]; reason?: string };
  /** Remove the worktree. Never throws. */
  cleanup(): void;
}

export interface TaskWorkspaceManager {
  /** An isolated workspace seeded with the main tree's CURRENT state, or
   * null when isolation is unavailable for this task (caller falls back). */
  acquire(taskId: string): TaskWorkspace | null;
}

const HARD_PARALLEL_CEILING = 8;

/** Live workspaces for the exit sweep (a killed run must not leak /tmp trees). */
const liveWorkspaces = new Set<TaskWorkspace>();
let exitSweepInstalled = false;

/** Remove abandoned uap-task-* tmp trees from crashed earlier runs (>24h old). */
function sweepStaleWorkspaces(): void {
  try {
    const base = tmpdir();
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of readdirSync(base)) {
      if (!name.startsWith('uap-task-')) continue;
      const p = join(base, name);
      try {
        if (statSync(p).mtimeMs < cutoff) rmSync(p, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  } catch {
    // best-effort
  }
}

/**
 * Clamp the `.uap.json` `deliver.parallelTasks` value to [1, 8]. Config-only
 * by design (no env override) — see the concurrency notes in
 * task-orchestrator.ts: an env knob would let one exported variable flip
 * every deliver run into parallel execution.
 */
export function resolveParallelTasks(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 1) return 1;
  return Math.min(Math.floor(n), HARD_PARALLEL_CEILING);
}

function git(cwd: string, args: string[], input?: string, timeoutMs = 120_000): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: timeoutMs,
    // Binary deltas (assets, lockfiles) easily exceed node's 1 MiB default;
    // an ENOBUFS here would misreport as a merge conflict.
    maxBuffer: 64 * 1024 * 1024,
    ...(input !== undefined ? { input } : {}),
    stdio: [input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    // Never inherit a poisoned GIT_DIR from a hook environment.
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined },
  });
}

/** Tail of a git error, preferring stderr (execFileSync buries the detail there). */
function gitErrorTail(err: unknown): string {
  const stderr = (err as { stderr?: string }).stderr;
  const msg = err instanceof Error ? err.message : String(err);
  return `${msg} ${stderr ?? ''}`.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** NUL-separated `git ls-files` output → clean path list. */
function zList(out: string): string[] {
  return out.split('\0').map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Build a task-workspace manager for `projectRoot`, or null when the project
 * is not a git repo. Unlike the explorer's provider, a DIRTY tree is fine —
 * that is the normal mid-mission state — because acquire syncs it.
 */
export function createTaskWorkspaceManager(projectRoot: string): TaskWorkspaceManager | null {
  try {
    if (git(projectRoot, ['rev-parse', '--is-inside-work-tree']).trim() !== 'true') return null;
    git(projectRoot, ['rev-parse', 'HEAD']); // unborn HEAD ⇒ no baseline to worktree
    git(projectRoot, ['worktree', 'prune']);
    sweepStaleWorkspaces();
  } catch {
    return null;
  }

  // A killed run leaks /tmp trees AND their worktree registrations (prune is
  // a no-op while the dir exists). Live workspaces are tracked module-wide
  // and swept on process exit; ancient orphans are swept at construction.
  if (!exitSweepInstalled) {
    exitSweepInstalled = true;
    process.once('exit', () => {
      for (const ws of [...liveWorkspaces]) {
        try {
          ws.cleanup();
        } catch {
          // best-effort
        }
      }
    });
  }

  const acquire = (taskId: string): TaskWorkspace | null => {
    let dir: string | null = null;
    try {
      dir = mkdtempSync(join(tmpdir(), 'uap-task-'));
      const root = join(dir, 'tree');
      git(projectRoot, ['worktree', 'add', '--detach', root, 'HEAD']);

      // Gates need dependencies; share the main tree's node_modules by
      // symlink (same convention + caveats as candidate-workspace).
      const mainModules = join(projectRoot, 'node_modules');
      const wtModules = join(root, 'node_modules');
      if (existsSync(mainModules) && !existsSync(wtModules)) {
        try {
          symlinkSync(mainModules, wtModules, 'junction');
        } catch {
          // gates may still work without it
        }
      }

      // Seed the worktree with the main tree's CURRENT uncommitted state:
      // modified + untracked + STAGED files copied in, deletions mirrored.
      // (Staged paths matter because a user may start the mission with a
      // pre-staged index; our own merge-backs unstage themselves below.)
      // This is what makes wave-2+ baselines include earlier tasks' merged
      // (uncommitted) output.
      const changed = [
        ...new Set([
          ...zList(git(projectRoot, ['ls-files', '-mo', '--exclude-standard', '-z'])),
          ...zList(git(projectRoot, ['diff', '--cached', '--name-only', '--no-renames', '-z'])),
        ]),
      ];
      for (const rel of changed) {
        const from = join(projectRoot, rel);
        let st;
        try {
          st = lstatSync(from);
        } catch {
          continue; // deleted since listing — the deletion passes handle it
        }
        const to = join(root, rel);
        mkdirSync(dirname(to), { recursive: true });
        if (st.isSymbolicLink()) {
          // Recreate symlinks as symlinks: copyFileSync would FOLLOW the link
          // and materialize its target's content into the model's workspace.
          try {
            rmSync(to, { force: true });
            symlinkSync(readlinkSync(from), to);
          } catch {
            // an unreproducible link is skipped, not followed
          }
        } else if (st.isFile()) {
          copyFileSync(from, to);
        }
      }
      // Deletions: unstaged (ls-files -d) AND staged (`git rm` shows only in
      // the cached diff as D — without this pass the worktree resurrects the
      // file from HEAD and merge-back can re-add it to the main tree).
      const deleted = [
        ...new Set([
          ...zList(git(projectRoot, ['ls-files', '-d', '-z'])),
          ...zList(git(projectRoot, ['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=D', '-z'])),
        ]),
      ];
      for (const rel of deleted) {
        try {
          rmSync(join(root, rel), { force: true });
        } catch {
          // best-effort mirror of a deletion
        }
      }

      // Freeze the seeded state as the task's BASELINE commit (detached — no
      // branch moves). mergeBack diffs against this, so only the task's own
      // work travels back. Identity flags keep this working on repos/CI with
      // no git user configured.
      git(root, ['add', '-A']);
      git(root, [
        '-c', 'user.email=uap-task@local',
        '-c', 'user.name=uap-task-workspace',
        'commit', '--allow-empty', '--no-verify', '-m', `uap task baseline: ${taskId}`,
      ]);

      const mergeBack = (
        isBlocked?: (file: string) => boolean
      ): { ok: boolean; files: string[]; reason?: string } => {
        try {
          git(root, ['add', '-A']);
          // --no-renames: a task-side rename must travel as delete+add so the
          // file list (and any unstage below) covers BOTH paths.
          const files = zList(git(root, ['diff', '--cached', '--name-only', '--no-renames', '-z', 'HEAD']));
          if (files.length === 0) return { ok: true, files: [] };
          const blocked = isBlocked ? files.filter((f) => isBlocked(f)) : [];
          if (blocked.length > 0) {
            return { ok: false, files: [], reason: `delta touches protected file(s): ${blocked.slice(0, 5).join(', ')}` };
          }
          const patch = git(root, ['diff', '--cached', '--binary', '--no-renames', 'HEAD']);
          // Plain apply first: it is worktree-only (no index coupling), and the
          // seeded baseline guarantees the preimage matches whenever no sibling
          // touched the same files — INCLUDING dirty/untracked targets in the
          // main tree, which is the normal wave-2 state. `--3way` alone would
          // imply --index and systematically fail exactly those targets.
          try {
            git(projectRoot, ['apply', '--whitespace=nowarn'], patch);
            return { ok: true, files };
          } catch {
            // Preimage drift (a sibling merged first). --3way can resolve
            // non-overlapping drift via the shared object store (git >= 2.9.3
            // also gives us its path-safety checks); it stages what it
            // applies, so unstage the merged paths after (chunked — argv).
            git(projectRoot, ['apply', '--3way', '--whitespace=nowarn'], patch);
            try {
              for (let i = 0; i < files.length; i += 100) {
                git(projectRoot, ['reset', '-q', 'HEAD', '--', ...files.slice(i, i + 100)]);
              }
            } catch {
              // staged leftovers are re-caught by the next acquire's cached-diff sync
            }
            return { ok: true, files };
          }
        } catch (err) {
          return { ok: false, files: [], reason: gitErrorTail(err) };
        }
      };

      const cleanup = (): void => {
        liveWorkspaces.delete(workspace);
        try {
          git(projectRoot, ['worktree', 'remove', '--force', root]);
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

      const workspace: TaskWorkspace = { root, mergeBack, cleanup };
      liveWorkspaces.add(workspace);
      return workspace;
    } catch {
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
      return null;
    }
  };

  return { acquire };
}

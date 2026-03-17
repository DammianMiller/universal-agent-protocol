import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Worktree Enforcer
 *
 * Ensures agents operate within dedicated git worktrees for isolation.
 * Uses `git worktree list` to verify worktree existence.
 */

export interface WorktreeStatus {
  exists: boolean;
  path: string | null;
  branch: string | null;
}

export interface WorktreeEnforcerOptions {
  requireWorktree?: boolean;
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
}

/**
 * Parse `git worktree list --porcelain` output into structured entries.
 */
function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let currentPath: string | null = null;
  let currentBranch: string | null = null;

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      // Flush previous entry
      if (currentPath !== null) {
        entries.push({ path: currentPath, branch: currentBranch });
      }
      currentPath = line.slice('worktree '.length).trim();
      currentBranch = null;
    } else if (line.startsWith('branch ')) {
      // branch refs/heads/some-branch
      const ref = line.slice('branch '.length).trim();
      currentBranch = ref.replace(/^refs\/heads\//, '');
    }
  }

  // Flush last entry
  if (currentPath !== null) {
    entries.push({ path: currentPath, branch: currentBranch });
  }

  return entries;
}

/**
 * Check if a git worktree exists for the given agent.
 *
 * Looks for a worktree whose path or branch name contains the agentId.
 * If `requireWorktree` is true and no matching worktree is found, returns `exists: false`.
 */
export async function ensureWorktree(
  agentId: string,
  options?: WorktreeEnforcerOptions
): Promise<WorktreeStatus> {
  const requireWorktree = options?.requireWorktree ?? false;

  try {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain']);
    const entries = parseWorktreeList(stdout);

    // Look for a worktree matching this agent
    const match = entries.find((entry) => {
      const pathMatch = entry.path.includes(agentId);
      const branchMatch = entry.branch !== null && entry.branch.includes(agentId);
      return pathMatch || branchMatch;
    });

    if (match) {
      return {
        exists: true,
        path: match.path,
        branch: match.branch,
      };
    }

    // No matching worktree found
    if (requireWorktree) {
      return { exists: false, path: null, branch: null };
    }

    // Not required — report that none exists but don't block
    return { exists: false, path: null, branch: null };
  } catch (_err) {
    // git command failed (not a git repo, git not installed, etc.)
    if (requireWorktree) {
      return { exists: false, path: null, branch: null };
    }
    return { exists: false, path: null, branch: null };
  }
}

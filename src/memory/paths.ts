/**
 * Where memory lives — always the MAIN checkout, never a worktree.
 *
 * The short-term DB path is configured relative (`./agents/data/memory/...`)
 * and falls back to `cwd`, so it resolved against whatever directory the
 * command ran in. The worktree policy requires all edit work to happen inside
 * `.worktrees/NNN-slug/`, which is exactly when learnings get recorded — so
 * they landed in that worktree's private database and no other agent, or later
 * session, ever saw them. 45 entries were found stranded across 37 worktree
 * DBs, most of them months old.
 *
 * `uap-policy-gate.sh` already anchors its own runtime state (policies.db,
 * .policy-tools/) to MAIN_ROOT for the same reason. This is that rule, applied
 * to memory.
 */
import { isAbsolute, join, sep } from 'path';
import { homedir } from 'os';

const WORKTREES = `${sep}.worktrees${sep}`;

/**
 * The main checkout for `cwd`, i.e. `cwd` with any `/.worktrees/<name>` suffix
 * removed. Returns `cwd` unchanged when it is not inside a worktree.
 */
export function memoryRoot(cwd: string = process.cwd()): string {
  const i = cwd.indexOf(WORKTREES);
  return i === -1 ? cwd : cwd.slice(0, i);
}

/**
 * Absolute path of the shared short-term DB.
 *
 * A configured ABSOLUTE path is honoured as-is — an operator who names an
 * explicit location means it. A relative one (the default) is resolved against
 * the main checkout rather than the working directory, which is the fix.
 */
export function shortTermDbPath(cwd: string, configuredPath?: string): string {
  const root = memoryRoot(cwd);
  if (configuredPath && isAbsolute(configuredPath)) return configuredPath;
  if (configuredPath) return join(root, configuredPath);
  return join(root, 'agents/data/memory/short_term.db');
}

/**
 * Absolute path of the shared Qdrant storage bind — the /qdrant/storage volume
 * of the singleton `uap-qdrant` container.
 *
 * ALWAYS home-anchored, never cwd-relative. The compose generator used to bind
 * `./qdrant_data`, which pinned the container's entire long-term store to
 * whatever directory `uap memory start` happened to run in. On 2026-11-19 that
 * was a deliver-mission workspace; the mission's re-scaffold deleted the
 * bind source out from under the live container and the semantic layer
 * (every embed) 500'd for hours. `~/.cache/uap` is the home the rest of the
 * system already treats as UAP's durable scratch space (`await-run`'s journal
 * sweep explicitly spares qdrant_data there), so the vector store lives under
 * it — a workspace may be wiped at any moment; the user's home may not.
 */
export function qdrantDataPath(): string {
  return join(homedir(), '.cache', 'uap', 'qdrant_data');
}

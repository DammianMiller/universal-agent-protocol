/**
 * Reactor hook for the collaboration board: surface the recent public board feed
 * (peer findings, dead-ends, flags, handoffs) into every agent's turn so shared
 * knowledge compounds instead of each agent working blind. Read-only and
 * fail-safe — returns null when there's no coordination DB or no recent posts.
 *
 * Opens the sqlite file directly (read-only) to avoid the CoordinationDatabase
 * singleton, so it never interferes with a live service in the same process.
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';

// ESM-safe require for the native better-sqlite3 addon (read-only board access
// in the synchronous reactor path, so dynamic import() isn't an option).
const require = createRequire(import.meta.url);

interface RawPost {
  from_agent: string | null;
  payload: string;
  created_at: string;
}

const ICON: Record<string, string> = {
  note: '•',
  finding: '✅',
  'dead-end': '⛔',
  flag: '🚩',
  handoff: '🤝',
  norm: '📏',
};

/** Default coordination DB path for a project root. */
export function coordDbPath(cwd: string): string {
  return join(cwd, 'agents', 'data', 'coordination', 'coordination.db');
}

/**
 * Build the board injection string for the reactor, or null if unavailable.
 * `limit` recent posts within the last `windowHours`.
 */
export function maybeBoardInjection(
  cwd: string,
  opts: { limit?: number; windowHours?: number } = {}
): string | null {
  const dbPath = coordDbPath(cwd);
  if (!existsSync(dbPath)) return null;
  const limit = opts.limit ?? 8;
  const windowHours = opts.windowHours ?? 24;

  let posts: RawPost[];
  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const since = new Date(Date.now() - windowHours * 3600_000).toISOString();
      posts = db
        .prepare(
          `SELECT from_agent, payload, created_at FROM agent_messages
           WHERE channel = 'board' AND created_at >= ?
           ORDER BY created_at DESC, id DESC LIMIT ?`
        )
        .all(since, limit) as RawPost[];
    } finally {
      db.close();
    }
  } catch {
    return null;
  }

  if (!posts || posts.length === 0) return null;

  const lines = posts
    .reverse()
    .map((r) => {
      let kind = 'note';
      let text = '';
      try {
        const p = JSON.parse(r.payload);
        kind = p.kind ?? 'note';
        text = String(p.text ?? '');
      } catch {
        /* skip malformed */
      }
      if (!text) return null;
      const who = r.from_agent ? r.from_agent.slice(0, 12) + ': ' : '';
      return `  ${ICON[kind] ?? '•'} [${kind}] ${who}${text}`;
    })
    .filter((l): l is string => l !== null);

  if (lines.length === 0) return null;
  return `Recent agent collaboration board (peers' findings, dead-ends, flags — apply them, don't re-discover):\n${lines.join('\n')}`;
}

/** Markdown header used when the board is injected into agent context. */
export const BOARD_INJECT_HEADER = '## Collaboration board';

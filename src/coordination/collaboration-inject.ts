/**
 * Reactor auto-activation for the agent-collaboration system. Surfaces the
 * board / coordination / challenge guidance automatically when the context
 * warrants it, so the collaboration tooling applies at the right times instead
 * of requiring manual `uap coord`/`uap challenge` invocation every turn.
 *
 * Gated by `.uap.json` → collaboration.mode:
 *   - off    : never auto-surface
 *   - always : always surface
 *   - auto   : surface when a multi-agent OR collaboration-shaped context is
 *              detected (the default)
 *
 * Read-only and fail-safe: returns null on any error / when not applicable.
 */
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { coordDbPath } from './board-inject.js';
import { loadUapConfigRaw } from '../utils/config-loader.js';

const require = createRequire(import.meta.url);

export type CollaborationMode = 'auto' | 'always' | 'off';

// Tasks that are collaboration-shaped: competitive optimization, benchmarking,
// fan-out, or explicit multi-agent work.
const COLLAB_PROMPT_RE =
  /\b(multi[-\s]?agents?|sub[-\s]?agents?|swarm|fan[-\s]?out|parallel agents|leaderboard|challenge|compete|competition|race|benchmark|optimi[sz]e (?:the )?(?:speed|throughput|latency|performance)|each other|collaborat)/i;

/** Resolve the collaboration mode from .uap.json (default 'auto'). */
export function collaborationMode(cwd: string): CollaborationMode {
  try {
    // Read the RAW config (not schema-validated) so the mode resolves even when
    // the rest of .uap.json is partial/invalid — the lightest possible gate.
    const cfg = loadUapConfigRaw(cwd) as { collaboration?: { mode?: string } } | null;
    const m = cfg?.collaboration?.mode;
    if (m === 'off' || m === 'always' || m === 'auto') return m;
  } catch {
    /* fall through to default */
  }
  return 'auto';
}

/** Count active/idle agents in the coordination registry (read-only). */
export function activeAgentCount(cwd: string): number {
  const dbPath = coordDbPath(cwd);
  if (!existsSync(dbPath)) return 0;
  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare(
          `SELECT COUNT(*) as n FROM agent_registry
           WHERE status IN ('active','idle')
             AND last_heartbeat >= datetime('now','-1 hour')`
        )
        .get() as { n: number };
      return row?.n ?? 0;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

/**
 * Build the collaboration activation guidance, or null if it should not surface.
 * `cwd` is the project root; `promptText` is the current task.
 */
export function maybeCollaborationInjection(cwd: string, promptText?: string): string | null {
  const mode = collaborationMode(cwd);
  if (mode === 'off') return null;

  const multiAgent = activeAgentCount(cwd) >= 2;
  const collabTask = !!promptText && COLLAB_PROMPT_RE.test(promptText);
  if (mode === 'auto' && !multiAgent && !collabTask) return null;

  const reason =
    mode === 'always'
      ? 'enabled'
      : multiAgent
        ? `${activeAgentCount(cwd)} agents active`
        : 'collaboration-shaped task';

  const lines = [
    `Agent collaboration is active (${reason}). Work in the open so peers compound your progress:`,
    '  - Check the board first: `uap coord board` (peers’ findings, dead-ends, flags).',
    '  - Share as you go: `uap coord post "<finding>" --kind finding`, record `uap coord dead-end "<what failed>"`.',
    '  - Hand off / pick up: `uap coord stage` / `uap coord claim`; flag suspect results: `uap coord flag <id> --reason`.',
  ];
  if (collabTask) {
    lines.push('  - For a competitive/optimization goal across agents: `uap challenge create` then `uap challenge run --agents N`.');
  }
  if (mode === 'auto') {
    lines.push('  (auto-activated — turn off with `uap coord collaboration off`, or force on with `always`.)');
  }
  return lines.join('\n');
}

import type { Plugin } from '@opencode-ai/plugin';

/**
 * UAP Session Hooks Plugin (Full Parity with Claude Code)
 *
 * Hooks:
 * - session.created: Cleans stale agents, injects compliance protocol,
 *   loads recent memories, surfaces open loops, warns about stale worktrees
 * - experimental.session.compacting: Writes compaction marker, checks for
 *   stored lessons, injects compliance reminder, cleans up active agents
 */

const DB_PATH = './agents/data/memory/short_term.db';
const COORD_DB = './agents/data/coordination/coordination.db';

export const UAPSessionHooks: Plugin = async ({ $, directory }) => {
  const projectDir = directory || '.';

  return {
    event: async ({ event }) => {
      if (event.type !== 'session.created') return;

      try {
        // 1. Clean stale agents from coordination DB (heartbeat >24h old)
        await $`bash -c '
          COORD_DB="${projectDir}/${COORD_DB}"
          if [ -f "$COORD_DB" ]; then
            sqlite3 "$COORD_DB" "
              DELETE FROM work_claims WHERE agent_id IN (
                SELECT id FROM agent_registry
                WHERE status IN ('"'"'active'"'"','"'"'idle'"'"') AND last_heartbeat < datetime('"'"'now'"'"','"'"'-24 hours'"'"')
              );
              DELETE FROM work_announcements WHERE agent_id IN (
                SELECT id FROM agent_registry
                WHERE status IN ('"'"'active'"'"','"'"'idle'"'"') AND last_heartbeat < datetime('"'"'now'"'"','"'"'-24 hours'"'"')
              ) AND completed_at IS NULL;
              UPDATE agent_registry SET status='"'"'failed'"'"'
                WHERE status IN ('"'"'active'"'"','"'"'idle'"'"') AND last_heartbeat < datetime('"'"'now'"'"','"'"'-24 hours'"'"');
              DELETE FROM agent_registry
                WHERE status IN ('"'"'completed'"'"','"'"'failed'"'"') AND started_at < datetime('"'"'now'"'"','"'"'-7 days'"'"');
              DELETE FROM agent_messages WHERE created_at < datetime('"'"'now'"'"','"'"'-24 hours'"'"');
            " 2>/dev/null || true
          fi
        '`.quiet();
      } catch {
        /* fail safely */
      }

      try {
        // 2. Load recent memories (last 24h)
        const memResult =
          await $`sqlite3 ${projectDir}/${DB_PATH} "SELECT type, substr(content, 1, 120) FROM memories WHERE timestamp >= datetime('now', '-1 day') ORDER BY id DESC LIMIT 10;" 2>/dev/null`.quiet();
        const recentMemories = memResult.stdout.toString().trim();

        // 3. Load open loops (high-importance session memories)
        const loopsResult =
          await $`sqlite3 ${projectDir}/${DB_PATH} "SELECT content FROM session_memories WHERE type IN ('action','goal','decision') AND importance >= 7 ORDER BY id DESC LIMIT 5;" 2>/dev/null`.quiet();
        const openLoops = loopsResult.stdout.toString().trim();

        // 4. Check stale worktrees
        const wtResult =
          await $`bash -c 'if [ -d "${projectDir}/.worktrees" ]; then find "${projectDir}/.worktrees" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l; else echo 0; fi'`.quiet();
        const staleCount = parseInt(wtResult.stdout.toString().trim() || '0', 10);

        // Build context output (logged to console for OpenCode to pick up)
        if (recentMemories) {
          console.log(`[UAP] Recent memories:\n${recentMemories}`);
        }
        if (openLoops) {
          console.log(`[UAP] Open loops:\n${openLoops}`);
        }
        if (staleCount > 0) {
          console.log(
            `[UAP] Warning: ${staleCount} worktrees exist. Run 'uap worktree list' and clean up merged ones.`
          );
        }
        console.log('[UAP] Session context loaded');
      } catch {
        /* fail safely */
      }
    },

    // Inject compliance protocol into system prompt at session start
    'experimental.chat.system.transform': async (_input, output) => {
      output.system.push(`<system-reminder>
## UAP COMPLIANCE - MANDATORY PROTOCOL

You MUST complete these steps IN ORDER before doing ANY work.
Skipping ANY step is a critical protocol violation.

### BEFORE WORK (execute these commands NOW):
1. Run: uap task ready
2. Run: sqlite3 ./agents/data/memory/short_term.db "SELECT type, substr(content,1,80) FROM memories ORDER BY id DESC LIMIT 5;"
3. Run: uap memory query "<relevant to user request>"
4. On work request: Run: uap task create --type <task|bug|feature> --title "<description>"

### DURING WORK:
5. ALL file changes MUST use worktree: uap worktree create <slug>
6. Work in .worktrees/NNN-<slug>/ directory

### BEFORE COMMIT:
7. Self-review: git diff
8. Run tests if applicable

### AFTER WORK:
9. Store lesson: sqlite3 ./agents/data/memory/short_term.db "INSERT INTO session_memories (session_id,timestamp,type,content,importance) VALUES ('current',datetime('now'),'decision','<summary of work and lessons>',7);"
10. Clean up worktree after PR merge: uap worktree cleanup <id>

FAILURE TO COMPLY = CRITICAL VIOLATION.
</system-reminder>`);
    },

    'experimental.session.compacting': async (_input, output) => {
      try {
        const timestamp = new Date().toISOString();

        // Write compaction marker
        await $`sqlite3 ${projectDir}/${DB_PATH} "INSERT OR IGNORE INTO memories (timestamp, type, content) VALUES ('${timestamp}', 'action', '[pre-compact] Context compaction at ${timestamp}');"`.quiet();

        // Check if any lessons were stored this session
        const lessonsResult =
          await $`sqlite3 ${projectDir}/${DB_PATH} "SELECT COUNT(*) FROM session_memories WHERE timestamp >= datetime('now', '-2 hours') AND type = 'decision';" 2>/dev/null`.quiet();
        const recentLessons = parseInt(lessonsResult.stdout.toString().trim() || '0', 10);

        let reminder = `<system-reminder>
## UAP COMPLIANCE REMINDER (Pre-Compact)

Context is being compacted. Before continuing work after compaction:
1. Re-run: uap task ready
2. Re-query memory for current task context
3. Check for stale worktrees: uap worktree list
`;
        if (recentLessons === 0) {
          reminder += `
WARNING: No lessons stored this session. Before compaction completes,
store a summary: sqlite3 ./agents/data/memory/short_term.db "INSERT INTO session_memories (session_id,timestamp,type,content,importance) VALUES ('current',datetime('now'),'decision','<summary>',7);"
`;
        }
        reminder += `</system-reminder>`;

        output.context.push(reminder);

        // Clean up agents from this session
        await $`bash -c '
          COORD_DB="${projectDir}/${COORD_DB}"
          if [ -f "$COORD_DB" ]; then
            TIMESTAMP="${timestamp}"
            sqlite3 "$COORD_DB" "
              DELETE FROM work_claims WHERE agent_id IN (
                SELECT id FROM agent_registry
                WHERE status='"'"'active'"'"' AND last_heartbeat >= datetime('"'"'now'"'"','"'"'-5 minutes'"'"')
              );
              UPDATE work_announcements SET completed_at='"'"'$TIMESTAMP'"'"'
                WHERE completed_at IS NULL AND agent_id IN (
                  SELECT id FROM agent_registry
                  WHERE status='"'"'active'"'"' AND last_heartbeat >= datetime('"'"'now'"'"','"'"'-5 minutes'"'"')
                );
              UPDATE agent_registry SET status='"'"'completed'"'"'
                WHERE status='"'"'active'"'"' AND last_heartbeat >= datetime('"'"'now'"'"','"'"'-5 minutes'"'"');
            " 2>/dev/null || true
          fi
        '`.quiet();
      } catch {
        /* fail safely */
      }
    },
  };
};

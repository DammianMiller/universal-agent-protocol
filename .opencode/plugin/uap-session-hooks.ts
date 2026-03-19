import type { Plugin } from "@opencode-ai/plugin"

/**
 * UAP Session Hooks Plugin for OpenCode
 *
 * Provides enforcement parity with Claude Code hooks:
 * - session.created: Agent registration, worktree enforcement, compliance context
 * - experimental.session.compacting: Pre-compact marker, policy summary, deploy flush
 * - session.ended: Agent deregistration, work claim cleanup, session marker
 *
 * OpenCode cannot intercept individual tool calls (Edit/Write), so enforcement
 * context is injected at session start and compaction boundaries instead.
 */

const EXEMPT_PATHS = [
  "agents/data/",
  "node_modules/",
  ".uap-backups/",
  ".uap/",
  ".git/",
  "dist/",
  "/tmp/",
  "/dev/",
]

export const UAPSessionHooks: Plugin = async ({ client, $ }) => {
  const agentId = `opencode-${Date.now().toString(36)}`

  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        try {
          const result = await $`bash -c '
            DB_PATH="./agents/data/memory/short_term.db"
            COORD_DB="./agents/data/coordination/coordination.db"
            POLICY_DB="./agents/data/memory/policies.db"
            AGENT_ID="${agentId}"

            if [ ! -f "$DB_PATH" ]; then exit 0; fi

            # Clean stale agents (>24h)
            if [ -f "$COORD_DB" ]; then
              sqlite3 "$COORD_DB" "
                DELETE FROM work_claims WHERE agent_id IN (
                  SELECT id FROM agent_registry
                  WHERE status IN ('\''active'\'','\''idle'\'') AND last_heartbeat < datetime('\''now'\'','\''-24 hours'\'')
                );
                DELETE FROM work_announcements WHERE agent_id IN (
                  SELECT id FROM agent_registry
                  WHERE status IN ('\''active'\'','\''idle'\'') AND last_heartbeat < datetime('\''now'\'','\''-24 hours'\'')
                ) AND completed_at IS NULL;
                UPDATE agent_registry SET status='\''failed'\''
                  WHERE status IN ('\''active'\'','\''idle'\'') AND last_heartbeat < datetime('\''now'\'','\''-24 hours'\'');
                DELETE FROM agent_registry
                  WHERE status IN ('\''completed'\'','\''failed'\'') AND started_at < datetime('\''now'\'','\''-7 days'\'');
                DELETE FROM agent_messages WHERE created_at < datetime('\''now'\'','\''-24 hours'\'');
              " 2>/dev/null || true

              # Register this agent
              sqlite3 "$COORD_DB" "
                INSERT OR REPLACE INTO agent_registry (id, name, session_id, status, capabilities, started_at, last_heartbeat)
                VALUES ('\''$AGENT_ID'\'', '\''opencode'\'', '\''$AGENT_ID'\'', '\''active'\'', '\''[]'\'', datetime('\''now'\''), datetime('\''now'\''));
              " 2>/dev/null || true

              # Auto-announce session
              BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
              sqlite3 "$COORD_DB" "
                INSERT INTO work_announcements (agent_id, agent_name, worktree_branch, intent_type, resource, description, announced_at)
                VALUES ('\''$AGENT_ID'\'', '\''opencode'\'', '\''$BRANCH'\'', '\''editing'\'', '\''session-scope'\'', '\''Session $AGENT_ID active'\'', datetime('\''now'\''));
              " 2>/dev/null || true

              # Detect overlaps
              OVERLAPS=$(sqlite3 "$COORD_DB" "
                SELECT a.agent_id || '\'' on '\'' || a.resource || '\'' ('\'' || a.intent_type || '\'')'\'\'
                FROM work_announcements a
                WHERE a.completed_at IS NULL AND a.agent_id != '\''$AGENT_ID'\''
                ORDER BY a.announced_at DESC LIMIT 5;
              " 2>/dev/null || true)
              if [ -n "$OVERLAPS" ]; then
                echo "OVERLAPS:$OVERLAPS"
              fi

              # Other active agents
              OTHER_AGENTS=$(sqlite3 "$COORD_DB" "
                SELECT id || '\'': '\'' || COALESCE(current_task, '\''idle'\'')
                FROM agent_registry
                WHERE status='\''active'\'' AND id != '\''$AGENT_ID'\''
                ORDER BY last_heartbeat DESC LIMIT 5;
              " 2>/dev/null || true)
              if [ -n "$OTHER_AGENTS" ]; then
                echo "AGENTS:$OTHER_AGENTS"
              fi
            fi

            # Policy summary
            if [ -f "$POLICY_DB" ]; then
              ACTIVE=$(sqlite3 "$POLICY_DB" "SELECT COUNT(*) FROM policies WHERE isActive=1;" 2>/dev/null || echo 0)
              REQUIRED=$(sqlite3 "$POLICY_DB" "SELECT COUNT(*) FROM policies WHERE isActive=1 AND level='\''REQUIRED'\'';" 2>/dev/null || echo 0)
              echo "POLICIES:${ACTIVE} active (${REQUIRED} REQUIRED)"
            fi

            # Worktree detection
            GIT_DIR_VAL=$(git rev-parse --git-dir 2>/dev/null || echo "")
            GIT_COMMON_DIR_VAL=$(git rev-parse --git-common-dir 2>/dev/null || echo "")
            IS_WORKTREE="false"
            if [ "$GIT_DIR_VAL" != "$GIT_COMMON_DIR_VAL" ]; then
              IS_WORKTREE="true"
            fi
            if pwd | grep -q "\.worktrees/" 2>/dev/null; then
              IS_WORKTREE="true"
            fi
            CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
            echo "WORKTREE:${IS_WORKTREE}:${CURRENT_BRANCH}"

            # Recent memories
            sqlite3 "$DB_PATH" "
              SELECT type, substr(content, 1, 120) FROM memories
              WHERE timestamp >= datetime('\''now'\'', '\''-1 day'\'')
              ORDER BY id DESC LIMIT 10;
            " 2>/dev/null || true
          '`.quiet()

          const stdout = result.stdout.toString().trim()
          if (stdout) {
            console.log("[UAP] Session context loaded")
          }
        } catch {
          /* fail safely */
        }
      }
    },

    "experimental.session.compacting": async (_input, output) => {
      try {
        const timestamp = new Date().toISOString()
        await $`bash -c '
          DB_PATH="./agents/data/memory/short_term.db"
          COORD_DB="./agents/data/coordination/coordination.db"
          AGENT_ID="${agentId}"
          TIMESTAMP="${timestamp}"

          # Record compaction marker
          if [ -f "$DB_PATH" ]; then
            sqlite3 "$DB_PATH" "
              INSERT OR IGNORE INTO memories (timestamp, type, content)
              VALUES ('\''${timestamp}'\'', '\''action'\'', '\''[pre-compact] Context compaction at ${timestamp}'\'');
            " 2>/dev/null || true
          fi

          # Flush pending deploy queue
          if [ -f "$COORD_DB" ]; then
            PENDING=$(sqlite3 "$COORD_DB" "SELECT COUNT(*) FROM deploy_queue WHERE status='\''pending'\'';" 2>/dev/null || echo 0)
            if [ "$PENDING" -gt 0 ] 2>/dev/null && [ -f "dist/bin/cli.js" ]; then
              node dist/bin/cli.js deploy flush 2>/dev/null || true
            fi

            # Mark this agent announcements as completed
            sqlite3 "$COORD_DB" "
              UPDATE work_announcements SET completed_at=datetime('\''now'\'')
                WHERE agent_id='\''${agentId}'\'' AND completed_at IS NULL;
              UPDATE agent_registry SET status='\''completed'\'' WHERE id='\''${agentId}'\'';
            " 2>/dev/null || true
          fi
        '`.quiet()

        // Inject policy summary and compliance reminders into compacted context
        output.context.push(
          [
            "<uap-context>",
            "## UAP COMPLIANCE REMINDER (Pre-Compact)",
            "",
            "Context is being compacted. Before continuing work after compaction:",
            "1. Re-run: uap task ready",
            "2. Re-query memory for current task context",
            "3. Check for stale worktrees: uap worktree list",
            "",
            "### ACTIVE POLICIES (always enforced):",
            "- worktree-enforcement: ALL file edits MUST be inside .worktrees/NNN-<slug>/",
            "- pre-edit-build-gate: Run `npm run build` before and after editing .ts files",
            "- completion-gate: 2+ new tests, build pass, version bump before claiming DONE",
            "- mandatory-testing-deployment: Tests, lint, type-check must pass",
            "- semver-versioning: Use `npm run version:patch/minor/major`, never edit package.json",
            "- file-backup: Backup files before modifying: cp <file> .uap-backups/$(date +%Y-%m-%d)/",
            "",
            "### FILE WRITE GUARD (OpenCode cannot hard-block, enforce manually):",
            `Exempt paths: ${EXEMPT_PATHS.join(", ")}`,
            "All other file writes MUST target paths inside .worktrees/",
            "If you are about to edit a file outside .worktrees/, STOP and create a worktree first.",
            "",
            "### MULTI-AGENT COORDINATION:",
            `Your agent ID is: ${agentId}`,
            "Before editing files: uap agent announce --resources '<files>' --description '<what>'",
            "Check for conflicts: uap agent overlaps",
            "After completing work: uap agent complete <announcement-id>",
            "",
            "Pre-compact marker saved to UAP memory.",
            "</uap-context>",
          ].join("\n"),
        )
      } catch {
        /* fail safely */
      }
    },

    "session.ended": async () => {
      try {
        const timestamp = new Date().toISOString()
        await $`bash -c '
          DB_PATH="./agents/data/memory/short_term.db"
          COORD_DB="./agents/data/coordination/coordination.db"
          AGENT_ID="${agentId}"
          TIMESTAMP="${timestamp}"

          # Store session-end marker in memory
          if [ -f "$DB_PATH" ]; then
            sqlite3 "$DB_PATH" "
              INSERT OR IGNORE INTO memories (timestamp, type, content)
              VALUES ('\''${timestamp}'\'', '\''action'\'', '\''[session-end] OpenCode agent ${agentId} stopped at ${timestamp}'\'');
            " 2>/dev/null || true
          fi

          # Deregister agent and clean work claims
          if [ -f "$COORD_DB" ]; then
            sqlite3 "$COORD_DB" "
              UPDATE work_announcements SET completed_at=datetime('\''now'\'')
                WHERE agent_id='\''${agentId}'\'' AND completed_at IS NULL;
              DELETE FROM work_claims WHERE agent_id='\''${agentId}'\'';
              UPDATE agent_registry SET status='\''completed'\''
                WHERE id='\''${agentId}'\'';
            " 2>/dev/null || true
          fi

          # Flush any remaining pending deploys
          if [ -f "$COORD_DB" ]; then
            PENDING=$(sqlite3 "$COORD_DB" "SELECT COUNT(*) FROM deploy_queue WHERE status='\''pending'\'';" 2>/dev/null || echo 0)
            if [ "$PENDING" -gt 0 ] 2>/dev/null && [ -f "dist/bin/cli.js" ]; then
              node dist/bin/cli.js deploy flush 2>/dev/null || true
            fi
          fi
        '`.quiet()

        console.log("[UAP] Session ended, agent deregistered:", agentId)
      } catch {
        /* fail safely */
      }
    },
  }
}

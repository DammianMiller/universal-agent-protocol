import type { Plugin } from "@opencode-ai/plugin"

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
                  WHERE status IN (\'active\',\'idle\') AND last_heartbeat < datetime(\'now\',\'-24 hours\')
                );
                DELETE FROM work_announcements WHERE agent_id IN (
                  SELECT id FROM agent_registry
                  WHERE status IN (\'active\',\'idle\') AND last_heartbeat < datetime(\'now\',\'-24 hours\')
                ) AND completed_at IS NULL;
                UPDATE agent_registry SET status=\'failed\'
                  WHERE status IN (\'active\',\'idle\') AND last_heartbeat < datetime(\'now\',\'-24 hours\');
              " 2>/dev/null || true

              # Register this agent
              sqlite3 "$COORD_DB" "
                INSERT OR REPLACE INTO agent_registry (id, name, session_id, status, capabilities, started_at, last_heartbeat)
                VALUES (\'$AGENT_ID\', \'opencode\', \'$AGENT_ID\', \'active\', \'[]\', datetime(\'now\'), datetime(\'now\'));
              " 2>/dev/null || true

              # Auto-announce session
              sqlite3 "$COORD_DB" "
                INSERT INTO work_announcements (agent_id, agent_name, worktree_branch, intent_type, resource, description, announced_at)
                VALUES (\'$AGENT_ID\', \'opencode\', \'unknown\', \'editing\', \'session-scope\', \'Session $AGENT_ID active\', datetime(\'now\'));
              " 2>/dev/null || true

              # Detect overlaps
              OVERLAPS=\$(sqlite3 "$COORD_DB" "
                SELECT a.agent_id || \' on \' || a.resource || \' (\' || a.intent_type || \')\'
                FROM work_announcements a
                WHERE a.completed_at IS NULL AND a.agent_id != \'$AGENT_ID\'
                ORDER BY a.announced_at DESC LIMIT 5;
              " 2>/dev/null || true)
              if [ -n "\$OVERLAPS" ]; then
                echo "OVERLAPS:\$OVERLAPS"
              fi
            fi

            # Policy summary
            if [ -f "$POLICY_DB" ]; then
              ACTIVE=\$(sqlite3 "$POLICY_DB" "SELECT COUNT(*) FROM policies WHERE isActive=1;" 2>/dev/null || echo 0)
              REQUIRED=\$(sqlite3 "$POLICY_DB" "SELECT COUNT(*) FROM policies WHERE isActive=1 AND level=\'REQUIRED\';" 2>/dev/null || echo 0)
              echo "POLICIES:\${ACTIVE} active (\${REQUIRED} REQUIRED)"
            fi

            # Recent memories
            sqlite3 "$DB_PATH" "
              SELECT type, content FROM memories
              WHERE timestamp >= datetime(\'now\', \'-1 day\')
              ORDER BY id DESC LIMIT 10;
            " 2>/dev/null || true
          '`.quiet()
          if (result.stdout.toString().trim()) {
            console.log("[UAP] Session context loaded")
          }
        } catch { /* fail safely */ }
      }
    },

    "experimental.session.compacting": async (_input, output) => {
      try {
        const timestamp = new Date().toISOString()
        await $`bash -c '
          sqlite3 ./agents/data/memory/short_term.db "INSERT OR IGNORE INTO memories (timestamp, type, content) VALUES ('\''${timestamp}'\'', '\''action'\'', '\''[pre-compact] Context compaction at ${timestamp}'\'');" 2>/dev/null || true
          COORD_DB="./agents/data/coordination/coordination.db"
          if [ -f "$COORD_DB" ]; then
            PENDING=$(sqlite3 "$COORD_DB" "SELECT COUNT(*) FROM deploy_queue WHERE status='\''pending'\'';" 2>/dev/null || echo 0)
            if [ "$PENDING" -gt 0 ] 2>/dev/null && [ -f "dist/bin/cli.js" ]; then
              node dist/bin/cli.js deploy flush 2>/dev/null || true
            fi
            sqlite3 "$COORD_DB" "
              UPDATE work_announcements SET completed_at=datetime('\''now'\'') WHERE agent_id='\''${agentId}'\'' AND completed_at IS NULL;
              UPDATE agent_registry SET status='\''completed'\'' WHERE id='\''${agentId}'\'';
            " 2>/dev/null || true
          fi
        '`.quiet()
        output.context.push("<uap-context>Pre-compact marker saved to UAP memory.</uap-context>")
      } catch { /* fail safely */ }
    },
  }
}

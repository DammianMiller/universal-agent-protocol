import type { Plugin } from "@opencode-ai/plugin"

export const UAPSessionHooks: Plugin = async ({ client, $ }) => {
  return {
    event: async ({ event, output }) => {
      if (event.type === "session.created") {
        try {
          const result = await $`bash -c '
            DB_PATH="./agents/data/memory/short_term.db"
            COORD_DB="./agents/data/coordination/coordination.db"

            if [ ! -f "$DB_PATH" ]; then exit 0; fi

            if [ -f "$COORD_DB" ]; then
              sqlite3 "$COORD_DB" "
                DELETE FROM work_claims WHERE agent_id IN (
                  SELECT id FROM agent_registry
                  WHERE status IN (\'active\',\'idle\') AND last_heartbeat < datetime(\'now\',\'-24 hours\')
                );
                UPDATE agent_registry SET status=\'failed\'
                  WHERE status IN (\'active\',\'idle\') AND last_heartbeat < datetime(\'now\',\'-24 hours\');
              " 2>/dev/null || true
            fi

            sqlite3 "$DB_PATH" "
              SELECT type || \': \' || content FROM memories
              WHERE timestamp >= datetime(\'now\', \'-1 day\')
              ORDER BY id DESC LIMIT 10;
            " 2>/dev/null || true
          '`.quiet()
          const memoryContext = result.stdout.toString().trim()
          if (memoryContext && output && output.context) {
            output.context.push("<uap-context>\n## UAP Session Memory (last 24h)\n" + memoryContext + "\n</uap-context>")
            console.log("[UAP] Session context injected (" + memoryContext.split("\n").length + " memories)")
          } else if (output && output.context) {
            output.context.push("<uap-context>UAP active. No recent memories found.</uap-context>")
            console.log("[UAP] Session started (no recent memories)")
          }
        } catch { /* fail safely */ }
      }
    },

    "experimental.session.compacting": async (_input, output) => {
      try {
        const timestamp = new Date().toISOString()
        await $`sqlite3 ./agents/data/memory/short_term.db "INSERT OR IGNORE INTO memories (timestamp, type, content) VALUES ('${timestamp}', 'action', '[pre-compact] Context compaction at ${timestamp}');"`.quiet()
        output.context.push("<uap-context>Pre-compact marker saved to UAP memory.</uap-context>")
      } catch { /* fail safely */ }
    },
  }
}

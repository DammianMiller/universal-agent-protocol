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

      // Runtime execution gate on idle (session end). OpenCode event
      // handlers cannot hard-block the session, so this is advisory: it runs
      // the cheap execution gate when code changed and surfaces a runtime
      // failure loudly + into context so the next turn fixes it. (Claude/
      // Factory/Cursor/VSCode get a hard exit-2 block via stop.sh.)
      if (event.type === "session.idle") {
        try {
          if (process.env.UAP_VERIFY_ON_STOP === "0") return
          const ch = await $`git diff --name-only HEAD`.quiet().nothrow()
          const un = await $`git ls-files --others --exclude-standard`.quiet().nothrow()
          const changed = ch.stdout.toString() + un.stdout.toString()
          if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/m.test(changed)) return
          // Portable timeout: bun's shell has no `timeout` builtin and macOS
          // lacks GNU timeout (ships as `gtimeout`). Resolve a real binary via
          // Bun.which; if neither exists, run verify directly — it enforces its
          // own internal rung timeouts. Avoids `bun: command not found: timeout`.
          const tmo = (typeof Bun !== "undefined" && (Bun.which("timeout") || Bun.which("gtimeout"))) || ""
          // NOT --strict: strict turns "no runnable artifact" (a nothing-to-run
          // project) into a hard RC-1 failure and would false-alarm on every
          // fresh/empty install. Non-strict returns 1 only on a real runtime failure.
          const res = tmo
            ? await $`${tmo} 120 uap verify --runtime-only`.quiet().nothrow()
            : await $`uap verify --runtime-only`.quiet().nothrow()
          if (res.exitCode === 1) {
            const msg = (res.stdout.toString() + res.stderr.toString()).trim()
            console.error("[UAP] RUNTIME EXECUTION GATE FAILED — the code does not run:\n" + msg)
            if (output && output.context) output.context.push("<uap-context>RUNTIME GATE FAILED — the code does not run. Fix before finishing:\n" + msg + "</uap-context>")
          }
        } catch { /* fail open */ }
      }
    },

    // Pre-tool-use policy gate. OpenCode aborts the tool call when this
    // hook throws, so a blocked verdict (exit 2) becomes a hard block.
    "tool.execute.before": async (input, output) => {
      try {
        const payload = JSON.stringify({ tool_name: input.tool, tool_input: (output && output.args) || {} })
        const res = await $`echo ${payload} | bash .opencode/hooks/uap-policy-gate.sh`.quiet().nothrow()
        if (res.exitCode === 2) {
          const reason = (res.stderr.toString() || res.stdout.toString()).trim()
          throw new Error("[UAP policy blocked] " + reason)
        }
      } catch (e) {
        if (e instanceof Error && e.message.indexOf("[UAP policy blocked]") === 0) throw e
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
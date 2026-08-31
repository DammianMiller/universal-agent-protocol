import type { Plugin } from "@opencode-ai/plugin"

export const UAPSessionHooks: Plugin = async ({ client, $ }) => {
  // Evidence for the `escalate` delivery mode: a verification outcome is
  // recorded so the gate can tell "direct edits are converging" from "two
  // red gates in a row — escalate to deliver". Best-effort, never throws.
  const recordEvidence = async (res, source) => {
    try {
      if (!res || (res.exitCode !== 0 && res.exitCode !== 1)) return
      const verdict = res.exitCode === 1 ? "fail" : "pass"
      const detail = (res.stdout.toString() + res.stderr.toString()).trim().slice(-1200)
      await $`python3 .opencode/hooks/escalation_tracker.py ${verdict} --source ${source} --detail ${detail}`.quiet().nothrow()
    } catch { /* evidence is best-effort */ }
  }
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
          // User-path gate (P3): --user-paths-auto re-proves the critical user
          // journeys when the last report is missing/stale/failed for this tree.
          // Version-skew guard: only pass the flag when this uap build knows it.
          const uvHelp = await $`uap verify --help`.quiet().nothrow()
          const uvAuto = uvHelp.stdout.toString().indexOf("user-paths-auto") >= 0 ? "--user-paths-auto" : ""
          const res = tmo
            ? await $`${tmo} 240 uap verify --runtime-only ${uvAuto}`.quiet().nothrow()
            : await $`uap verify --runtime-only ${uvAuto}`.quiet().nothrow()
          await recordEvidence(res, "verify")
          if (res.exitCode === 1) {
            const msg = (res.stdout.toString() + res.stderr.toString()).trim()
            console.error("[UAP] RUNTIME/USER-PATH GATE FAILED:\n" + msg)
            if (output && output.context) output.context.push("<uap-context>RUNTIME/USER-PATH GATE FAILED — the code does not run or does not work for a real user. Fix before finishing:\n" + msg + "</uap-context>")
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

      // COMPLETION GATE: OpenCode cannot hard-block session end, but it CAN
      // block a tool call — so gate the DONE signal. When the agent marks all
      // its todos complete, run the full validation gates and REFUSE (throw)
      // if the delivered outcome does not pass, forcing it to keep fixing
      // instead of falsely claiming ready. Only blocks on a real gate failure
      // (verify exit 1); infra/unknown fails OPEN. UAP_VERIFY_ON_STOP=0 opts out.
      try {
        if (input.tool === "todowrite" && process.env.UAP_VERIFY_ON_STOP !== "0") {
          const todos = (output && output.args && output.args.todos) || []
          const claimsDone = Array.isArray(todos) && todos.length > 0 && todos.every((t) => t && t.status === "completed")
          if (claimsDone) {
            const ch = await $`git diff --name-only HEAD`.quiet().nothrow()
            const un = await $`git ls-files --others --exclude-standard`.quiet().nothrow()
            const changed = ch.stdout.toString() + un.stdout.toString()
            if (/\.(ts|tsx|js|jsx|mjs|cjs|html|css|py|go|rs|vue|svelte)$/m.test(changed)) {
              const uvHelp = await $`uap verify --help`.quiet().nothrow()
              const uvAuto = uvHelp.stdout.toString().indexOf("user-paths-auto") >= 0 ? "--user-paths-auto" : ""
              // --acceptance-auto: judge requirements-completeness against the
              // agents own plan of record (.uap/acceptance.md → REQUIREMENTS.md →
              // the completion ledger). Fails open with no spec/model; blocks
              // under max/strict fidelity. This is the DONE claim, so the heavier
              // LLM judge belongs here (not on the per-edit periodic path).
              const res2 = await $`uap verify ${uvAuto} --acceptance-auto`.quiet().nothrow()
              await recordEvidence(res2, "verify")
              if (res2.exitCode === 1) {
                const msg = (res2.stdout.toString() + res2.stderr.toString()).trim().slice(0, 2500)
                throw new Error("[UAP not done] Validation FAILED — you are NOT done. The outcome does not pass the gates (testing / visual / behavioral). Do NOT mark these todos complete. Fix the failures below, then let validation re-run:\n" + msg)
              }
            }
          }
        }
      } catch (e) {
        if (e instanceof Error && e.message.indexOf("[UAP not done]") === 0) throw e
        /* verify infra / git error → fail OPEN (never wedge on tooling) */
      }

      // PERIODIC VALIDATION (independent of a clean todowrite-complete): the
      // completion gate above only fires when ALL todos are marked completed.
      // A weak local model that stops mid-plan, leaves todos in_progress, or
      // never calls todowrite would escape validation entirely — and small
      // edits take the trivial fast-path, so nothing routes to deliver either.
      // So on a cadence (every N code edits) run verify and hard-inject
      // [UAP not done] on a real runtime failure, catching a broken build even
      // with no done signal. --runtime-only returns 1 only on a genuine runtime
      // failure (never on a fresh/empty state). UAP_VERIFY_EVERY_N_EDITS=0 opts out.
      try {
        const nEvery = parseInt(process.env.UAP_VERIFY_EVERY_N_EDITS || "12", 10)
        const isEdit = ["edit", "write", "multiedit"].includes(String(input.tool).toLowerCase())
        const fp = String((output && output.args && (output.args.file_path || output.args.filePath || output.args.path)) || "")
        if (nEvery > 0 && isEdit && process.env.UAP_VERIFY_ON_STOP !== "0" && /\.(ts|tsx|js|jsx|mjs|cjs|html|css|py|go|rs|vue|svelte)$/.test(fp)) {
          const rd = await $`cat .uap/verify-cadence 2>/dev/null || echo 0`.quiet().nothrow()
          let n = parseInt(rd.stdout.toString().trim() || "0", 10); if (!Number.isFinite(n)) n = 0
          n = n + 1
          if (n >= nEvery) {
            await $`mkdir -p .uap && echo 0 > .uap/verify-cadence`.quiet().nothrow()
            const uvHelp = await $`uap verify --help`.quiet().nothrow()
            const uvAuto = uvHelp.stdout.toString().indexOf("user-paths-auto") >= 0 ? "--user-paths-auto" : ""
            const res3 = await $`uap verify --runtime-only ${uvAuto}`.quiet().nothrow()
            await recordEvidence(res3, "verify")
            if (res3.exitCode === 1) {
              const msg = (res3.stdout.toString() + res3.stderr.toString()).trim().slice(0, 2000)
              throw new Error("[UAP not done] Periodic validation FAILED after " + nEvery + " edits — the current build does not pass the runtime gates. Fix these before continuing (validation re-runs automatically):\n" + msg)
            }
          } else {
            await $`mkdir -p .uap && echo ${n} > .uap/verify-cadence`.quiet().nothrow()
          }
        }
      } catch (e) {
        if (e instanceof Error && e.message.indexOf("[UAP not done]") === 0) throw e
        /* verify infra / io error → fail OPEN */
      }
    },

    // ESCALATION EVIDENCE from the shell: a build/test command's outcome
    // (cargo test, npm test, tsc, pytest, go test, ...) is classified by the
    // tracker. OpenCode exposes the tool output text, not the exit code, so
    // ambiguous output records nothing — silence is not evidence.
    "tool.execute.after": async (input, output) => {
      try {
        if (String(input && input.tool).toLowerCase() !== "bash") return
        const cmd = String((input && input.args && input.args.command) || "")
        if (!cmd) return
        const text = String((output && output.output) || "").slice(-4000)
        await $`python3 .opencode/hooks/escalation_tracker.py classify-bash --command ${cmd.slice(0, 500)} --output ${text}`.quiet().nothrow()
      } catch { /* evidence is best-effort */ }
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
import type { Plugin } from '@opencode-ai/plugin';

/**
 * Layer 2: UAP Enforcement Plugin for OpenCode (v1.0.0)
 *
 * ARCHITECTURE: PREPEND-NOT-REPLACE
 * The loop breaker PREPENDS warning messages to commands but NEVER replaces them.
 * This ensures the agent's actual work always executes, even during loop detection.
 * The agent sees the warning in the output and can adjust its approach.
 *
 * 1. Loop Detection (ALL tool types):
 *    - Tracks tool calls by full-content fingerprint
 *    - bash: prepends warning echo, then runs the actual command
 *    - write/edit: lets the write through but prepends warning to next bash call
 *    - read: lets the read through but prepends warning to next bash call
 *    - Escape hatch: after 3 consecutive warnings, resets fingerprint history
 *
 * 2. Hard Tool-Call Budget:
 *    - After 30 tool calls, prepends "WRAP UP NOW" warning
 *    - Proxy (Layer 1) handles actual termination at 50 calls
 *
 * 3. Telemetry:
 *    - Logs all tool calls to /tmp/uap-telemetry.jsonl
 */
export const UapEnforce: Plugin = async ({ $ }) => {
  const recentFingerprints: string[] = [];
  const recentOutputHashes: string[] = [];
  const MAX_HISTORY = 20;
  const LOOP_THRESHOLD = 3;

  // Escape hatch: track consecutive loop warnings
  let consecutiveLoopWarnings = 0;
  const ESCAPE_HATCH_THRESHOLD = 3;

  // Pending warning: queued from write/read loops, prepended to next bash call
  let pendingWarning: string | null = null;

  // Track write content hashes
  const recentWriteHashes: string[] = [];

  let totalToolCalls = 0;
  const SOFT_BUDGET = 30;

  const TELEMETRY_PATH = '/tmp/uap-telemetry.jsonl';

  const simpleHash = (s: string): string => {
    let h = 0;
    for (let i = 0; i < Math.min(s.length, 2000); i++) {
      h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return String(h);
  };

  // Write initial telemetry entry
  await $`echo '{"event":"plugin_loaded","version":"1.0.0","ts":"'$(date -Iseconds)'"}' >> ${TELEMETRY_PATH}`
    .quiet()
    .nothrow();

  return {
    'tool.execute.before': async (input, output) => {
      totalToolCalls++;

      // --- Worktree enforcement (Layer 4) ---
      // Warn when file writes happen outside a worktree
      if ((input.tool === 'write' || input.tool === 'edit') && output.args?.filePath) {
        const filePath = String(output.args.filePath);
        const isInWorktree = filePath.includes('.worktrees/') || filePath.includes('/.worktrees/');
        if (!isInWorktree) {
          try {
            // Check if worktrees are enabled and other agents are active
            const result = await $`bash -c '
              COORD_DB="./agents/data/coordination/coordination.db"
              if [ -f "$COORD_DB" ]; then
                ACTIVE=$(sqlite3 "$COORD_DB" "SELECT COUNT(*) FROM agent_registry WHERE status='"'"'active'"'"';" 2>/dev/null || echo 0)
                if [ "$ACTIVE" -gt 1 ]; then
                  echo "MULTI_AGENT"
                fi
              fi
            '`
              .quiet()
              .nothrow();

            if (result.stdout?.toString().includes('MULTI_AGENT')) {
              await $`echo ${JSON.stringify(
                JSON.stringify({
                  event: 'worktree_warning',
                  tool: input.tool,
                  file: filePath.slice(0, 200),
                  reason: 'multi-agent file write outside worktree',
                  ts: new Date().toISOString(),
                })
              )} >> ${TELEMETRY_PATH}`
                .quiet()
                .nothrow();

              // Inject warning into bash tool if the next call is bash
              // For write/edit, we log but don't block (worktree creation is the agent's responsibility)
            }
          } catch {
            /* fail safely */
          }
        }
      }

      // --- PolicyGate enforcement (Layer 3) ---
      // Check all UAP policies before allowing tool execution.
      // Uses the uap-policy CLI for cross-runtime compatibility.
      try {
        const argsJson = JSON.stringify(output.args || {}).slice(0, 1000);
        const result =
          await $`node dist/bin/policy.js check --operation ${input.tool} --args ${argsJson} 2>/dev/null`
            .quiet()
            .nothrow();

        if (result.exitCode !== 0) {
          const policyOutput = result.stdout?.toString() || '';
          // Policy blocked this operation
          if (policyOutput.includes('BLOCKED') || policyOutput.includes('blocked')) {
            await $`echo ${JSON.stringify(
              JSON.stringify({
                event: 'policy_blocked',
                tool: input.tool,
                reason: policyOutput.slice(0, 200),
                ts: new Date().toISOString(),
              })
            )} >> ${TELEMETRY_PATH}`
              .quiet()
              .nothrow();

            if (input.tool === 'bash') {
              output.args.command = [
                `echo "[UAP-POLICY] BLOCKED: Operation '${input.tool}' violated a REQUIRED policy."`,
                `echo "[UAP-POLICY] ${policyOutput.replace(/"/g, '\\"').slice(0, 200)}"`,
                `echo "[UAP-POLICY] You must comply with the policy before retrying."`,
              ].join(' && ');
              return;
            }
            // For non-bash tools, log but allow through (policy gate in MCP router
            // will catch it if the tool goes through the MCP path)
          }
        }
      } catch {
        // Policy check failed (CLI not built, DB not initialized, etc.)
        // Fail open: allow the tool call but log the failure
        await $`echo '{"event":"policy_check_error","tool":"${input.tool}","ts":"'$(date -Iseconds)'"}' >> ${TELEMETRY_PATH}`
          .quiet()
          .nothrow();
      }

      // --- Budget enforcement ---
      // NOTE: The proxy (Layer 1) handles the actual budget termination by
      // stripping tools after HARD_BUDGET requests. The plugin just logs warnings.
      // Do NOT replace commands here - that creates infinite loops when
      // tool_choice="required" forces another call.
      if (totalToolCalls === SOFT_BUDGET && input.tool === 'bash') {
        const original = output.args?.command || '';
        output.args.command = [
          'echo "[UAP-ENFORCE] WARNING: 30 tool calls used. WRAP UP your solution NOW."',
          original,
        ].join(' && ');
        return;
      }

      // --- Inject pending warning from write/read loop into this bash call ---
      if (pendingWarning && input.tool === 'bash') {
        const original = output.args?.command || '';
        output.args.command = `echo "${pendingWarning}" && ${original}`;
        pendingWarning = null;
        // Don't return -- still check for loops on this call
      }

      // --- Fingerprint-based loop detection ---
      const argsStr = JSON.stringify(output.args || {});
      const fingerprint = `${input.tool}:${argsStr.length > 500 ? simpleHash(argsStr) : argsStr}`;

      const matches = recentFingerprints.filter((f) => f === fingerprint);
      if (matches.length >= LOOP_THRESHOLD) {
        const loopCount = matches.length + 1;
        consecutiveLoopWarnings++;

        // --- ESCAPE HATCH: after N consecutive warnings, reset history ---
        if (consecutiveLoopWarnings >= ESCAPE_HATCH_THRESHOLD) {
          recentFingerprints.length = 0;
          recentWriteHashes.length = 0;
          consecutiveLoopWarnings = 0;
          await $`echo '{"event":"escape_hatch","tool":"${input.tool}","count":${loopCount}}' >> ${TELEMETRY_PATH}`
            .quiet()
            .nothrow();
          // Let this call through completely clean
          return;
        }

        if (input.tool === 'bash') {
          // PREPEND warning with SEARCH SUGGESTION, then run the ACTUAL command
          const original = output.args?.command || '';
          const warning = [
            `echo "[UAP-ENFORCE] LOOP WARNING (${loopCount}x): Same command repeated."`,
            `echo "[UAP-ENFORCE] Try a DIFFERENT approach. Hints:"`,
            `echo "[UAP-ENFORCE]   - SEARCH ONLINE: uap_search 'your error message or question'"`,
            `echo "[UAP-ENFORCE]   - If a dep is missing, install it (apt-get, pip, cpan)"`,
            `echo "[UAP-ENFORCE]   - If output is wrong, read the test/verifier first"`,
            `echo "[UAP-ENFORCE]   - Check /app/tmp/web_research.txt for pre-fetched hints"`,
          ].join(' && ');
          output.args.command = `${warning} && ${original}`;
          await $`echo '{"event":"loop_warn_bash","count":${loopCount}}' >> ${TELEMETRY_PATH}`
            .quiet()
            .nothrow();
        } else if (input.tool === 'write' || input.tool === 'edit') {
          // LET THE WRITE THROUGH but queue a warning for the next bash call
          pendingWarning = `[UAP-ENFORCE] WRITE LOOP (${loopCount}x): You wrote identical content. Try a DIFFERENT approach. Read the test/verifier to understand expected format.`;
          await $`echo '{"event":"loop_warn_write","count":${loopCount}}' >> ${TELEMETRY_PATH}`
            .quiet()
            .nothrow();
          // DO NOT modify output -- let the write execute
        } else if (input.tool === 'read') {
          // LET THE READ THROUGH but queue a warning
          pendingWarning = `[UAP-ENFORCE] READ LOOP (${loopCount}x): You read the same file ${loopCount} times. Move on to the next step.`;
          await $`echo '{"event":"loop_warn_read","count":${loopCount}}' >> ${TELEMETRY_PATH}`
            .quiet()
            .nothrow();
          // DO NOT modify output -- let the read execute
        }
      } else {
        // Not a loop -- reset consecutive warning counter
        consecutiveLoopWarnings = 0;
      }

      // --- Content-aware write dedup ---
      if (input.tool === 'write' && output.args?.content) {
        const contentHash = simpleHash(output.args.content);
        const contentMatches = recentWriteHashes.filter((h) => h === contentHash);
        if (contentMatches.length >= 3) {
          // Queue warning but LET THE WRITE THROUGH
          pendingWarning = `[UAP-ENFORCE] CONTENT DEDUP: Identical content written ${contentMatches.length + 1} times. Your approach is not working. Try something FUNDAMENTALLY different.`;
          await $`echo '{"event":"content_dedup","count":${contentMatches.length + 1}}' >> ${TELEMETRY_PATH}`
            .quiet()
            .nothrow();
        }
        recentWriteHashes.push(contentHash);
        if (recentWriteHashes.length > MAX_HISTORY) {
          recentWriteHashes.shift();
        }
      }

      // Track fingerprint
      recentFingerprints.push(fingerprint);
      if (recentFingerprints.length > MAX_HISTORY) {
        recentFingerprints.shift();
      }
    },

    // --- Policy-aware tool descriptions (Layer 3) ---
    // Inject active REQUIRED policy constraints into tool descriptions
    // so the LLM is aware of rules before making tool calls.
    'tool.definition': async (_input, output) => {
      try {
        const result = await $`node dist/bin/policy.js list --category code 2>/dev/null`
          .quiet()
          .nothrow();

        if (result.exitCode === 0 && result.stdout) {
          const policyText = result.stdout.toString().trim();
          if (policyText && policyText.includes('REQUIRED')) {
            const suffix =
              '\n\n[UAP Policy Constraints: ' +
              policyText
                .split('\n')
                .filter((l: string) => l.includes('REQUIRED'))
                .map((l: string) => l.trim())
                .join('; ')
                .slice(0, 300) +
              ']';
            if (output.description) {
              output.description = output.description + suffix;
            }
          }
        }
      } catch {
        // Fail silently - policy injection is best-effort
      }
    },

    'tool.execute.after': async (input, _output) => {
      const outputStr = typeof _output?.output === 'string' ? _output.output : '';

      // Output-based loop detection
      if (outputStr.length > 0) {
        const hash = simpleHash(outputStr);
        recentOutputHashes.push(hash);
        if (recentOutputHashes.length > MAX_HISTORY) {
          recentOutputHashes.shift();
        }
      }

      // Telemetry
      const entry = {
        event: 'tool_call',
        tool: input.tool,
        n: totalToolCalls,
        ts: new Date().toISOString(),
        args_preview:
          typeof input.args?.command === 'string'
            ? input.args.command.slice(0, 200)
            : typeof input.args?.filePath === 'string'
              ? input.args.filePath
              : typeof input.args?.url === 'string'
                ? input.args.url.slice(0, 200)
                : '...',
      };

      await $`echo ${JSON.stringify(JSON.stringify(entry))} >> ${TELEMETRY_PATH}`.quiet().nothrow();
    },
  };
};

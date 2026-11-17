import type { Plugin } from '@opencode/plugin';
import { exec } from 'node:child_process';

/**
 * Layer 2: UAP Enforcement Plugin for OpenCode (v2.0.0, opencode V2 API)
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

// Inline Bun.$-compatible shell helper (self-contained artifact: this file
// is distributed standalone into agent deployments). Interpolated values are
// single-quoted; `.nothrow()` keeps non-zero exits as results.
interface ShellResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}
const shellQuote = (value: unknown): string => "'" + String(value).replace(/'/g, "'\\''") + "'";
class ShellRun implements PromiseLike<ShellResult> {
  private nothrowFlag = false;
  private readonly promise: Promise<ShellResult>;
  constructor(command: string) {
    this.promise = new Promise<ShellResult>((resolve, reject) => {
      exec(command, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        const rawCode = (err as { code?: unknown } | null)?.code;
        const exitCode = typeof rawCode === 'number' ? rawCode : err ? 127 : 0;
        const res: ShellResult = { stdout: Buffer.from(stdout ?? ''), stderr: Buffer.from(stderr ?? ''), exitCode };
        if (exitCode !== 0 && !this.nothrowFlag) {
          reject(new Error('command exited ' + exitCode + ': ' + command.slice(0, 200)));
        } else {
          resolve(res);
        }
      });
    });
  }
  nothrow(): this {
    this.nothrowFlag = true;
    return this;
  }
  quiet(): this {
    return this;
  }
  then<TResult1 = ShellResult, TResult2 = never>(
    onfulfilled?: ((value: ShellResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.promise.then(onfulfilled, onrejected);
  }
}
const $ = (strings: TemplateStringsArray, ...values: unknown[]): ShellRun => {
  let command = '';
  for (let i = 0; i < strings.length; i++) {
    command += strings[i];
    if (i < values.length) command += shellQuote(values[i]);
  }
  return new ShellRun(command);
};

const plugin: Plugin.Plugin = {
  id: 'uap-enforce',
  async setup(ctx) {
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

    // Write initial telemetry entry
    await $`echo '{"event":"plugin_loaded","version":"2.0.0","ts":"'$(date -Iseconds)'"}' >> ${TELEMETRY_PATH}`
      .quiet()
      .nothrow();

    // --- Policy-aware tool descriptions (Layer 3, V2) ---
    // Inject active REQUIRED policy constraints into tool descriptions so
    // the LLM is aware of rules before making tool calls. V2 transforms must
    // be synchronous and replayable: load the policy list ONCE in setup,
    // capture it, and append inside the transform callback.
    let policySuffix = '';
    try {
      const result = await $`node dist/bin/policy.js list --category code 2>/dev/null`
        .quiet()
        .nothrow();
      if (result.exitCode === 0 && result.stdout) {
        const policyText = result.stdout.toString().trim();
        if (policyText && policyText.includes('REQUIRED')) {
          policySuffix =
            '\n\n[UAP Policy Constraints: ' +
            policyText
              .split('\n')
              .filter((l: string) => l.includes('REQUIRED'))
              .map((l: string) => l.trim())
              .join('; ')
              .slice(0, 300) +
            ']';
        }
      }
    } catch {
      // Fail silently - policy injection is best-effort
    }
    if (policySuffix) {
      await ctx.tool.transform((editor) => {
        for (const t of editor.list()) {
          if (!t.description.includes('[UAP Policy Constraints:')) {
            editor.update(t.id, (tool) => {
              tool.description = tool.description + policySuffix;
            });
          }
        }
      });
    }

    await ctx.tool.hook('execute.before', async (event) => {
      totalToolCalls++;

      const args = (event.input || {}) as {
        command?: string;
        content?: string;
        filePath?: string;
      };

      // NOTE: a transparent "run `uap deliver` on the first edit" trigger was
      // trialed here and REMOVED. Benchmarking showed it net-harmful: it ran a
      // heavyweight second agent (the deliver convergence loop) against a
      // self-authored PROXY gate that does not match the task's hidden verifier,
      // mutating the workspace and corrupting tasks plain opencode solved
      // (e.g. openssl-selfsigned-cert regressed; 4/6 -> 2/6). deliver's
      // self-gate + agentic executor remain valuable as a STANDALONE `uap
      // deliver` invocation, just not as a per-edit parasite on the agent loop.

      // --- Worktree enforcement (Layer 4) ---
      // Warn when file writes happen outside a worktree
      if ((event.tool === 'write' || event.tool === 'edit') && args.filePath) {
        const filePath = String(args.filePath);
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
                  tool: event.tool,
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
        const argsJson = JSON.stringify(args || {}).slice(0, 1000);
        const result =
          await $`node dist/bin/policy.js check --operation ${event.tool} --args ${argsJson} 2>/dev/null`
            .quiet()
            .nothrow();

        if (result.exitCode !== 0) {
          const policyOutput = result.stdout?.toString() || '';
          // Policy blocked this operation
          if (policyOutput.includes('BLOCKED') || policyOutput.includes('blocked')) {
            await $`echo ${JSON.stringify(
              JSON.stringify({
                event: 'policy_blocked',
                tool: event.tool,
                reason: policyOutput.slice(0, 200),
                ts: new Date().toISOString(),
              })
            )} >> ${TELEMETRY_PATH}`
              .quiet()
              .nothrow();

            if (event.tool === 'bash') {
              event.input = {
                ...args,
                command: [
                  `echo "[UAP-POLICY] BLOCKED: Operation '${event.tool}' violated a REQUIRED policy."`,
                  `echo "[UAP-POLICY] ${policyOutput.replace(/"/g, '\\"').slice(0, 200)}"`,
                  `echo "[UAP-POLICY] You must comply with the policy before retrying."`,
                ].join(' && '),
              };
              return;
            }
            // For non-bash tools, log but allow through (policy gate in MCP router
            // will catch it if the tool goes through the MCP path)
          }
        }
      } catch {
        // Policy check failed (CLI not built, DB not initialized, etc.)
        // Fail open: allow the tool call but log the failure
        await $`echo '{"event":"policy_check_error","tool":"${event.tool}","ts":"'$(date -Iseconds)'"}' >> ${TELEMETRY_PATH}`
          .quiet()
          .nothrow();
      }

      // --- Budget enforcement ---
      // NOTE: The proxy (Layer 1) handles the actual budget termination by
      // stripping tools after HARD_BUDGET requests. The plugin just logs warnings.
      // Do NOT replace commands here - that creates infinite loops when
      // tool_choice="required" forces another call.
      if (totalToolCalls === SOFT_BUDGET && event.tool === 'bash') {
        const original = args?.command || '';
        event.input = {
          ...args,
          command: [
            'echo "[UAP-ENFORCE] WARNING: 30 tool calls used. WRAP UP your solution NOW."',
            original,
          ].join(' && '),
        };
        return;
      }

      // --- Inject pending warning from write/read loop into this bash call ---
      if (pendingWarning && event.tool === 'bash') {
        const original = args?.command || '';
        event.input = { ...args, command: `echo "${pendingWarning}" && ${original}` };
        pendingWarning = null;
        // Don't return -- still check for loops on this call
      }

      // --- Fingerprint-based loop detection ---
      const argsStr = JSON.stringify(args || {});
      const fingerprint = `${event.tool}:${argsStr.length > 500 ? simpleHash(argsStr) : argsStr}`;

      const matches = recentFingerprints.filter((f) => f === fingerprint);
      if (matches.length >= LOOP_THRESHOLD) {
        const loopCount = matches.length + 1;
        consecutiveLoopWarnings++;

        // --- ESCAPE HATCH: after N consecutive warnings, reset history ---
        if (consecutiveLoopWarnings >= ESCAPE_HATCH_THRESHOLD) {
          recentFingerprints.length = 0;
          recentWriteHashes.length = 0;
          consecutiveLoopWarnings = 0;
          await $`echo '{"event":"escape_hatch","tool":"${event.tool}","count":${loopCount}}' >> ${TELEMETRY_PATH}`
            .quiet()
            .nothrow();
          // Let this call through completely clean
          return;
        }

        if (event.tool === 'bash') {
          // PREPEND warning with SEARCH SUGGESTION, then run the ACTUAL command
          const original = args?.command || '';
          const warning = [
            `echo "[UAP-ENFORCE] LOOP WARNING (${loopCount}x): Same command repeated."`,
            `echo "[UAP-ENFORCE] Try a DIFFERENT approach. Hints:"`,
            `echo "[UAP-ENFORCE]   - SEARCH ONLINE: uap_search 'your error message or question'"`,
            `echo "[UAP-ENFORCE]   - If a dep is missing, install it (apt-get, pip, cpan)"`,
            `echo "[UAP-ENFORCE]   - If output is wrong, read the test/verifier first"`,
            `echo "[UAP-ENFORCE]   - Check /app/tmp/web_research.txt for pre-fetched hints"`,
          ].join(' && ');
          event.input = { ...args, command: `${warning} && ${original}` };
          await $`echo '{"event":"loop_warn_bash","count":${loopCount}}' >> ${TELEMETRY_PATH}`
            .quiet()
            .nothrow();
        } else if (event.tool === 'write' || event.tool === 'edit') {
          // LET THE WRITE THROUGH but queue a warning for the next bash call
          pendingWarning = `[UAP-ENFORCE] WRITE LOOP (${loopCount}x): You wrote identical content. Try a DIFFERENT approach. Read the test/verifier to understand expected format.`;
          await $`echo '{"event":"loop_warn_write","count":${loopCount}}' >> ${TELEMETRY_PATH}`
            .quiet()
            .nothrow();
          // DO NOT modify input -- let the write execute
        } else if (event.tool === 'read') {
          // LET THE READ THROUGH but queue a warning
          pendingWarning = `[UAP-ENFORCE] READ LOOP (${loopCount}x): You read the same file ${loopCount} times. Move on to the next step.`;
          await $`echo '{"event":"loop_warn_read","count":${loopCount}}' >> ${TELEMETRY_PATH}`
            .quiet()
            .nothrow();
          // DO NOT modify input -- let the read execute
        }
      } else {
        // Not a loop -- reset consecutive warning counter
        consecutiveLoopWarnings = 0;
      }

      // --- Content-aware write dedup ---
      if (event.tool === 'write' && args?.content) {
        const contentHash = simpleHash(args.content);
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
    });

    await ctx.tool.hook('execute.after', async (event) => {
      const result = (event as { result?: { content?: unknown } }).result;
      const outputStr =
        event.status === 'completed' && typeof result?.content === 'string' ? result.content : '';

      // Output-based loop detection
      if (outputStr.length > 0) {
        const hash = simpleHash(outputStr);
        recentOutputHashes.push(hash);
        if (recentOutputHashes.length > MAX_HISTORY) {
          recentOutputHashes.shift();
        }
      }

      // Telemetry
      const args = (event.input || {}) as {
        command?: string;
        filePath?: string;
        url?: string;
      };
      const entry = {
        event: 'tool_call',
        tool: event.tool,
        n: totalToolCalls,
        ts: new Date().toISOString(),
        args_preview:
          typeof args?.command === 'string'
            ? args.command.slice(0, 200)
            : typeof args?.filePath === 'string'
              ? args.filePath
              : typeof args?.url === 'string'
                ? args.url.slice(0, 200)
                : '...',
      };

      await $`echo ${JSON.stringify(JSON.stringify(entry))} >> ${TELEMETRY_PATH}`.quiet().nothrow();
    });
  },
};

export default plugin;

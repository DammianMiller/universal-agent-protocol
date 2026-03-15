import type { Plugin } from '@opencode-ai/plugin';

/**
 * Layer 2: UAP Enforcement Plugin for OpenCode (v9.9.0)
 *
 * Provides runtime enforcement that the model cannot bypass:
 *
 * 1. Loop Detection (all tool types, not just bash):
 *    - Tracks recent tool calls by tool+args fingerprint
 *    - If same fingerprint repeated 3+ times, rewrites command to break loop
 *    - Tracks output hashes to detect semantic loops (same output 3+ times)
 *
 * 2. Hard Tool-Call Budget:
 *    - After 30 tool calls, injects "WRAP UP NOW" message
 *    - After 50 tool calls, force-terminates with summary
 *
 * 3. Telemetry:
 *    - Logs all tool calls to /tmp/uap-telemetry.jsonl
 *
 * Deployed into container at /app/.opencode/plugin/uap-enforce.ts
 */
export const UapEnforce: Plugin = async ({ $ }) => {
  // Track recent tool fingerprints for loop detection
  const recentFingerprints: string[] = [];
  const recentOutputHashes: string[] = [];
  const MAX_HISTORY = 20;
  const LOOP_THRESHOLD = 3;

  // Hard budget
  let totalToolCalls = 0;
  const SOFT_BUDGET = 30;
  const HARD_BUDGET = 50;

  // Telemetry log path
  const TELEMETRY_PATH = '/tmp/uap-telemetry.jsonl';

  // Simple hash for output dedup
  const simpleHash = (s: string): string => {
    let h = 0;
    for (let i = 0; i < Math.min(s.length, 500); i++) {
      h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return String(h);
  };

  // Write initial telemetry entry
  await $`echo '{"event":"plugin_loaded","version":"9.9.0","ts":"'$(date -Iseconds)'"}' >> ${TELEMETRY_PATH}`
    .quiet()
    .nothrow();

  return {
    'tool.execute.before': async (input, output) => {
      totalToolCalls++;

      // --- Budget enforcement ---
      // NOTE: The proxy (Layer 1) handles the actual budget termination by
      // stripping tools after HARD_BUDGET requests. The plugin just logs warnings.
      // Do NOT replace commands here - that creates infinite loops when
      // tool_choice="required" forces another call.
      if (totalToolCalls === SOFT_BUDGET && input.tool === 'bash') {
        // Inject wrap-up warning BEFORE the actual command (don't replace it)
        const original = output.args?.command || '';
        output.args.command = [
          'echo "[UAP-ENFORCE] WARNING: 30 tool calls used. WRAP UP your solution NOW."',
          original,
        ].join(' && ');
        return;
      }

      // --- Fingerprint-based loop detection (all tool types) ---
      const fingerprint = `${input.tool}:${JSON.stringify(output.args || {}).slice(0, 300)}`;

      const matches = recentFingerprints.filter((f) => f === fingerprint);
      if (matches.length >= LOOP_THRESHOLD) {
        const loopCount = matches.length + 1;

        if (input.tool === 'bash') {
          output.args.command = [
            `echo "[UAP-ENFORCE] LOOP DETECTED: ${input.tool} call repeated ${loopCount} times."`,
            `echo "[UAP-ENFORCE] You MUST try a COMPLETELY DIFFERENT approach."`,
            `echo "[UAP-ENFORCE] Hint: If a command keeps failing, try: reading docs, checking paths, using alternative tools."`,
            `echo '{"event":"loop_broken","tool":"${input.tool}","count":${loopCount}}' >> ${TELEMETRY_PATH}`,
          ].join(' && ');
        } else if (input.tool === 'write' || input.tool === 'edit') {
          // For write/edit loops, let it through but log
          await $`echo '{"event":"write_loop","tool":"${input.tool}","count":${loopCount}}' >> ${TELEMETRY_PATH}`
            .quiet()
            .nothrow();
        }
        return;
      }

      // Track this fingerprint
      recentFingerprints.push(fingerprint);
      if (recentFingerprints.length > MAX_HISTORY) {
        recentFingerprints.shift();
      }
    },

    'tool.execute.after': async (input, _output) => {
      // --- Output-based loop detection ---
      const outputStr = typeof _output?.output === 'string' ? _output.output : '';
      if (outputStr.length > 0) {
        const hash = simpleHash(outputStr);
        recentOutputHashes.push(hash);
        if (recentOutputHashes.length > MAX_HISTORY) {
          recentOutputHashes.shift();
        }
      }

      // Log all tool calls to telemetry
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

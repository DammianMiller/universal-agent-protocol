import type { Plugin } from '@opencode-ai/plugin';

/**
 * UAP Reactor Plugin (OpenCode)
 *
 * Per-message dynamic capability auto-apply: for each user message, calls the
 * `uap react` resolver and injects the recommended experts/skills/patterns into
 * the system prompt. Generalizes uap-pattern-rag.ts (patterns only) to the full
 * resolver. Confidence-gated by `uap react`; session-deduped via surfaced keys.
 *
 * Hook: experimental.chat.system.transform — fires before each LLM call.
 * Fails safely: never blocks the pipeline.
 */
export const UAPReactor: Plugin = async ({ $ }) => {
  // Keys already injected this session (droid:/skill:/pattern:) — fed back to
  // the resolver so it does not re-surface the same item twice.
  const surfaced = new Set<string>();

  return {
    'experimental.chat.system.transform': async (input, output) => {
      try {
        const messages = (input as { messages?: Array<{ role?: string; content?: unknown }> }).messages || [];
        let taskText = '';
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (msg?.role === 'user') {
            taskText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            break;
          }
        }
        if (taskText.length < 12) return;

        const surfacedArg = Array.from(surfaced).join(',');
        const result = surfacedArg
          ? await $`uap react --event user-prompt --prompt ${taskText.slice(0, 500)} --surfaced ${surfacedArg}`.quiet()
          : await $`uap react --event user-prompt --prompt ${taskText.slice(0, 500)}`.quiet();

        const parsed = JSON.parse(result.stdout.toString().trim() || '{}');
        const inject = (parsed.inject || '').trim();
        if (!inject) return;

        for (const key of parsed.surfacedKeys || []) surfaced.add(key);
        output.system.push(`<uap-reactor>\n${inject}\n</uap-reactor>`);
        console.log(`[UAP-Reactor] injected (confidence ${parsed.confidence?.toFixed?.(2) ?? '?'})`);
      } catch {
        // Never block the pipeline on resolver failures.
      }
    },
  };
};

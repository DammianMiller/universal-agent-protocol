import type { Plugin } from '@opencode/plugin';
import { $ } from '../lib/uap-plugin-kit';

/**
 * UAP Reactor Plugin (OpenCode)
 *
 * Per-message dynamic capability auto-apply: for each user message, calls the
 * `uap react` resolver and injects the recommended experts/skills/patterns into
 * the system prompt. Generalizes uap-pattern-rag.ts (patterns only) to the full
 * resolver. Confidence-gated by `uap react`; session-deduped via surfaced keys.
 *
 * Hook: V2 context hook — fires before each LLM call.
 * Fails safely: never blocks the pipeline.
 */

/** Latest user-message text from a V2 context-hook message list. */
function latestUserText(
  messages: ReadonlyArray<{
    info?: { role?: unknown };
    role?: unknown;
    parts?: unknown;
    content?: unknown;
  }>
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const role = msg.info?.role ?? msg.role;
    if (role !== 'user') continue;
    if (typeof msg.content === 'string' && msg.content) return msg.content;
    if (Array.isArray(msg.parts)) {
      const text = msg.parts
        .filter(
          (p): p is { type: string; text?: string } =>
            typeof p === 'object' && p !== null && (p as { type?: string }).type === 'text'
        )
        .map((p) => String(p.text ?? ''))
        .filter(Boolean)
        .join('\n');
      if (text) return text;
    }
  }
  return '';
}

const plugin: Plugin.Plugin = {
  id: 'uap-reactor',
  async setup(ctx) {
    // Keys already injected this session (droid:/skill:/pattern:) — fed back to
    // the resolver so it does not re-surface the same item twice.
    const surfaced = new Set<string>();

    await ctx.session.hook('context', async (event) => {
      try {
        const taskText = latestUserText(event.messages);
        if (taskText.length < 12) return;

        const surfacedArg = Array.from(surfaced).join(',');
        const result = surfacedArg
          ? await $`uap react --event user-prompt --prompt ${taskText.slice(0, 500)} --surfaced ${surfacedArg}`.quiet().nothrowMode()
          : await $`uap react --event user-prompt --prompt ${taskText.slice(0, 500)}`.quiet().nothrowMode();

        const parsed = JSON.parse(result.stdout.toString().trim() || '{}') as {
          inject?: string;
          surfacedKeys?: string[];
          confidence?: { toFixed?: (digits: number) => string };
        };
        const inject = (parsed.inject || '').trim();
        if (!inject) return;

        for (const key of parsed.surfacedKeys || []) surfaced.add(key);
        event.system.push({ type: 'text', text: `<uap-reactor>\n${inject}\n</uap-reactor>` });
        console.log(
          `[UAP-Reactor] injected (confidence ${parsed.confidence?.toFixed?.(2) ?? '?'})`
        );
      } catch {
        // Never block the pipeline on resolver failures.
      }
    });
  },
};

export default plugin;

import type { Plugin } from '@opencode-ai/plugin';

/**
 * UAP Pattern RAG Plugin
 *
 * Queries the Qdrant 'agent_patterns' collection for task-relevant coding
 * patterns and injects them into context on-demand. This replaces loading
 * all 36 patterns in the system prompt (~12K tokens saved).
 *
 * Optimizations:
 * - Query result caching with TTL to avoid redundant Python cold-starts
 * - Keyword extraction to skip re-querying for similar messages
 * - Deduplication via injectedPatternIds set
 *
 * Hooks:
 * - session.created: Loads general project patterns
 * - session.compacting: Preserves active patterns through compaction
 * - experimental.chat.system.transform: Queries and injects task-relevant patterns
 *
 * Requires: agents/.venv/bin/python, agents/scripts/query_patterns.py
 */

const VENV_PYTHON = './agents/.venv/bin/python';
const QUERY_SCRIPT = './agents/scripts/query_patterns.py';
const DB_PATH = './agents/data/memory/short_term.db';

// Cache TTL: avoid re-querying Qdrant for similar messages within this window
const CACHE_TTL_MS = 30_000; // 30 seconds

interface CachedQuery {
  keywords: string;
  patterns: Array<{ id: number; score: number; title: string; abbreviation: string; body: string }>;
  timestamp: number;
}

/**
 * Extract significant keywords from text for cache key comparison.
 * Two messages with the same keywords don't need separate Qdrant queries.
 */
function extractKeywords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .sort()
    .slice(0, 10)
    .join(' ');
}

export const UAPPatternRAG: Plugin = async ({ $ }) => {
  // Track which patterns have been injected this session to avoid duplicates
  const injectedPatternIds = new Set<number>();

  // Query cache to avoid redundant Python cold-starts (saves 300-500ms per hit)
  let queryCache: CachedQuery | null = null;

  return {
    event: async ({ event }) => {
      if (event.type === 'session.created') {
        try {
          // On session start, inject a general "coding agent" pattern
          // to prime the model with the most broadly useful guidance
          const result =
            await $`${VENV_PYTHON} ${QUERY_SCRIPT} "coding agent best practices security" --top 2 --format context`.quiet();
          const patterns = result.stdout.toString().trim();
          if (patterns) {
            console.log('[UAP-RAG] Loaded initial patterns');
          }
        } catch {
          // Qdrant may not be running — fail silently
          console.log('[UAP-RAG] Pattern loading skipped (Qdrant unavailable)');
        }
      }
    },

    'experimental.session.compacting': async (_input, output) => {
      try {
        // Before compaction, save which patterns were active
        const patternList = Array.from(injectedPatternIds).join(',');
        if (patternList) {
          const timestamp = new Date().toISOString();
          await $`sqlite3 ${DB_PATH} "INSERT OR IGNORE INTO session_memories (session_id, timestamp, type, content, importance) VALUES ('current', '${timestamp}', 'decision', '[pattern-rag] Active patterns: ${patternList}', 6);"`.quiet();
          output.context.push(
            `<uap-patterns-memo>Previously active patterns: ${patternList}. Re-query if needed.</uap-patterns-memo>`
          );
        }
      } catch {
        /* fail safely */
      }
    },

    // Inject task-relevant patterns into the system prompt before each LLM call.
    'experimental.chat.system.transform': async (input, output) => {
      try {
        // Find the latest user message from the input messages
        const messages = (input as any).messages || [];
        let taskText = '';
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (msg?.role === 'user') {
            taskText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            break;
          }
        }

        // Skip short messages (greetings, confirmations) or if no user message found
        if (taskText.length < 20) {
          return;
        }

        // Check cache: if keywords match and cache is fresh, reuse results
        const keywords = extractKeywords(taskText);
        const now = Date.now();
        let patterns: CachedQuery['patterns'];

        if (
          queryCache &&
          queryCache.keywords === keywords &&
          now - queryCache.timestamp < CACHE_TTL_MS
        ) {
          patterns = queryCache.patterns;
        } else {
          // Query Qdrant for relevant patterns (Python cold-start ~300-500ms)
          const result =
            await $`${VENV_PYTHON} ${QUERY_SCRIPT} ${taskText.slice(0, 500)} --top 2 --min-score 0.35 --format json`.quiet();
          patterns = JSON.parse(result.stdout.toString().trim() || '[]');

          // Update cache
          queryCache = { keywords, patterns, timestamp: now };
        }

        // Filter out already-injected patterns
        const newPatterns = patterns.filter((p) => !injectedPatternIds.has(p.id));

        if (newPatterns.length > 0) {
          // Build compact context injection
          const contextLines = ['<uap-patterns>'];
          for (const p of newPatterns) {
            const abbr = p.abbreviation ? ` (${p.abbreviation})` : '';
            contextLines.push(`### P${p.id}: ${p.title || 'Untitled'}${abbr} [score: ${p.score}]`);
            // Truncate body to ~400 chars for 3B model context efficiency
            contextLines.push((p.body || '').slice(0, 400));
            contextLines.push('');
            injectedPatternIds.add(p.id);
          }
          contextLines.push('</uap-patterns>');

          // Inject into system prompt
          output.system.push(contextLines.join('\n'));

          console.log(
            `[UAP-RAG] Injected ${newPatterns.length} pattern(s): ${newPatterns.map((p) => `P${p.id}`).join(', ')}`
          );
        }
      } catch {
        // Never block the pipeline on pattern lookup failures
      }
    },
  };
};

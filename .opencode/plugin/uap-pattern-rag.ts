import type { Plugin } from '@opencode-ai/plugin';

/**
 * UAP Pattern RAG Plugin
 *
 * Queries the Qdrant 'agent_patterns' collection for task-relevant coding
 * patterns and injects them into context on-demand. This replaces loading
 * all 36 patterns in the system prompt (~12K tokens saved).
 *
 * Hooks:
 * - session.created: Loads general project patterns
 * - session.compacting: Preserves active patterns through compaction
 * - message.created: Extracts task keywords and queries relevant patterns
 *
 * Requires: agents/.venv/bin/python, agents/scripts/query_patterns.py
 */

const VENV_PYTHON = './agents/.venv/bin/python';
const QUERY_SCRIPT = './agents/scripts/query_patterns.py';
const DB_PATH = './agents/data/memory/short_term.db';

export const UAPPatternRAG: Plugin = async ({ $, directory }) => {
  // Track which patterns have been injected this session to avoid duplicates
  let injectedPatternIds = new Set<number>();

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

    middleware: async (input, next) => {
      // Before each user message is processed, check if we should inject patterns
      try {
        const lastMessage = input.messages?.[input.messages.length - 1];
        if (!lastMessage || lastMessage.role !== 'user') {
          return next(input);
        }

        // Extract task text from the user message
        const taskText =
          typeof lastMessage.content === 'string'
            ? lastMessage.content
            : JSON.stringify(lastMessage.content);

        // Skip short messages (greetings, confirmations)
        if (taskText.length < 20) {
          return next(input);
        }

        // Query Qdrant for relevant patterns
        const result =
          await $`${VENV_PYTHON} ${QUERY_SCRIPT} ${taskText.slice(0, 500)} --top 2 --min-score 0.35 --format json`.quiet();
        const patterns = JSON.parse(result.stdout.toString().trim() || '[]') as Array<{
          id: number;
          score: number;
          title: string;
          abbreviation: string;
          body: string;
        }>;

        // Filter out already-injected patterns
        const newPatterns = patterns.filter((p) => !injectedPatternIds.has(p.id));

        if (newPatterns.length > 0) {
          // Build compact context injection
          const contextLines = ['<uap-patterns>'];
          for (const p of newPatterns) {
            const abbr = p.abbreviation ? ` (${p.abbreviation})` : '';
            contextLines.push(`### P${p.id}: ${p.title}${abbr} [score: ${p.score}]`);
            // Truncate body to ~400 chars for 3B model context efficiency
            contextLines.push(p.body.slice(0, 400));
            contextLines.push('');
            injectedPatternIds.add(p.id);
          }
          contextLines.push('</uap-patterns>');

          // Inject as system context before the user message
          input.messages.splice(input.messages.length - 1, 0, {
            role: 'system' as const,
            content: contextLines.join('\n'),
          });

          console.log(
            `[UAP-RAG] Injected ${newPatterns.length} pattern(s): ${newPatterns.map((p) => `P${p.id}`).join(', ')}`
          );
        }
      } catch {
        // Never block the pipeline on pattern lookup failures
      }

      return next(input);
    },
  };
};

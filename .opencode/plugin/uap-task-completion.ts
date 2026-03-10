import type { Plugin } from '@opencode-ai/plugin';

/**
 * UAP Task Completion Plugin
 *
 * Records task outcomes for reinforcement learning, equivalent to
 * Factory's task_completion_hook.sh. Monitors tool executions for
 * git operations and task completions to automatically record outcomes.
 */

const DB_PATH = './agents/data/memory/short_term.db';
const VENV_PYTHON = './agents/.venv/bin/python';
const RECORD_SCRIPT = './agents/scripts/record_task_outcome.py';

export const UAPTaskCompletion: Plugin = async ({ $, directory }) => {
  const projectDir = directory || '.';
  let sessionTaskCount = 0;
  let sessionStartTime = Date.now();

  return {
    event: async ({ event }) => {
      if (event.type === 'session.created') {
        sessionTaskCount = 0;
        sessionStartTime = Date.now();
      }
    },

    // Monitor tool executions for task-related operations
    'tool.execute.after': async (input, _output) => {
      try {
        // Track git commits as task completions
        if (input.tool === 'shell' && typeof input.args === 'object') {
          const command = String(input.args.command || input.args.cmd || '');

          // Detect git commit (task completion signal)
          if (command.includes('git commit') && !command.includes('--dry-run')) {
            sessionTaskCount++;
            const timestamp = new Date().toISOString();
            const duration = Math.round((Date.now() - sessionStartTime) / 1000);

            // Record outcome in memory
            await $`sqlite3 ${projectDir}/${DB_PATH} "INSERT OR IGNORE INTO session_memories (session_id, timestamp, type, content, importance) VALUES ('current', '${timestamp}', 'action', '[task-completion] Commit #${sessionTaskCount} after ${duration}s', 6);"`.quiet();

            console.log(`[UAP] Task completion recorded: commit #${sessionTaskCount}`);
          }

          // Detect worktree cleanup (task lifecycle end)
          if (command.includes('uap worktree cleanup') || command.includes('worktree remove')) {
            const timestamp = new Date().toISOString();
            await $`sqlite3 ${projectDir}/${DB_PATH} "INSERT OR IGNORE INTO session_memories (session_id, timestamp, type, content, importance) VALUES ('current', '${timestamp}', 'action', '[task-completion] Worktree cleaned up', 5);"`.quiet();
          }
        }

        // Track uap task close/complete commands
        if (input.tool === 'shell' && typeof input.args === 'object') {
          const command = String(input.args.command || input.args.cmd || '');
          if (command.includes('uap task close') || command.includes('uap task update')) {
            try {
              // Try to record via Python script for Qdrant pattern weight updates
              await $`${VENV_PYTHON} ${RECORD_SCRIPT} --outcome success --session-tasks ${sessionTaskCount}`.quiet();
            } catch {
              // Python/Qdrant not available, skip pattern weight update
            }
          }
        }
      } catch {
        /* never block tool execution */
      }
    },

    // On compaction, save session task summary
    'experimental.session.compacting': async (_input, output) => {
      if (sessionTaskCount > 0) {
        const duration = Math.round((Date.now() - sessionStartTime) / 1000);
        output.context.push(
          `<uap-session-stats>Session completed ${sessionTaskCount} task(s) in ${duration}s.</uap-session-stats>`
        );
      }
    },
  };
};

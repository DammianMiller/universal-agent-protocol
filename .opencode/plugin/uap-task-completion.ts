import type { Plugin } from '@opencode/plugin';
import { $ } from '../lib/uap-plugin-kit';

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

const plugin: Plugin.Plugin = {
  id: 'uap-task-completion',
  async setup(ctx) {
    const projectDir = ctx.location.directory || '.';
    let sessionTaskCount = 0;
    let sessionStartTime = Date.now();

    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({
        types: ['session.created'],
        signal: controller.signal,
      })) {
        if (event.type === 'session.created') {
          sessionTaskCount = 0;
          sessionStartTime = Date.now();
        }
      }
    })();

    // Monitor tool executions for task-related operations
    await ctx.tool.hook('execute.after', async (event) => {
      try {
        // Track git commits as task completions (V1 checked the 'shell'
        // tool name; preserved verbatim from the V1 plugin)
        if (event.tool === 'shell' && event.status === 'completed') {
          const args = (event.input ?? {}) as { command?: string; cmd?: string };
          const command = String(args.command || args.cmd || '');

          // Detect git commit (task completion signal)
          if (command.includes('git commit') && !command.includes('--dry-run')) {
            sessionTaskCount++;
            const timestamp = new Date().toISOString();
            const duration = Math.round((Date.now() - sessionStartTime) / 1000);

            // Record outcome in memory
            await $`sqlite3 ${projectDir}/${DB_PATH} "INSERT OR IGNORE INTO session_memories (session_id, timestamp, type, content, importance) VALUES ('current', '${timestamp}', 'action', '[task-completion] Commit #${sessionTaskCount} after ${duration}s', 6);"`.quiet().nothrowMode();

            console.log(`[UAP] Task completion recorded: commit #${sessionTaskCount}`);
          }

          // Detect worktree cleanup (task lifecycle end)
          if (command.includes('uap worktree cleanup') || command.includes('worktree remove')) {
            const timestamp = new Date().toISOString();
            await $`sqlite3 ${projectDir}/${DB_PATH} "INSERT OR IGNORE INTO session_memories (session_id, timestamp, type, content, importance) VALUES ('current', '${timestamp}', 'action', '[task-completion] Worktree cleaned up', 5);"`.quiet().nothrowMode();
          }
        }

        // Track uap task close/complete commands (V1 checked the 'shell'
        // tool name; preserved verbatim from the V1 plugin)
        if (event.tool === 'shell' && event.status === 'completed') {
          const args = (event.input ?? {}) as { command?: string; cmd?: string };
          const command = String(args.command || args.cmd || '');
          if (command.includes('uap task close') || command.includes('uap task update')) {
            try {
              // Try to record via Python script for Qdrant pattern weight updates
              await $`${VENV_PYTHON} ${RECORD_SCRIPT} --outcome success --session-tasks ${sessionTaskCount}`.quiet().nothrowMode();
            } catch {
              // Python/Qdrant not available, skip pattern weight update
            }
          }
        }
      } catch {
        /* never block tool execution */
      }
    });

    // On compaction, save session task summary and show the compact session
    // dashboard. (V2's compaction hook has no context-push equivalent; the
    // V1 stats memo is dropped — the DB ledger and dashboard carry the record.)
    await ctx.session.hook('compaction', async () => {
      if (sessionTaskCount > 0) {
        const duration = Math.round((Date.now() - sessionStartTime) / 1000);
        console.log(
          `[UAP] Session stats: ${sessionTaskCount} task(s) in ${duration}s (recorded at compaction)`
        );
      }
      // Show compact session dashboard on compaction
      try {
        await $`node ${projectDir}/dist/bin/cli.js dash session --compact`.quiet().nothrowMode();
      } catch {
        /* ignore if CLI not built */
      }
    });

    return () => controller.abort();
  },
};

export default plugin;

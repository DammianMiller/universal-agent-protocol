import type { Plugin } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin';

/**
 * UAP Commands Plugin
 *
 * Registers UAP CLI commands as native OpenCode tools, providing
 * the same slash-command experience as Claude Code's commands.json.
 *
 * Tools registered:
 * - uap_memory_query: Query memory for relevant context
 * - uap_memory_store: Store a lesson/decision in memory
 * - uap_memory_status: Show memory system status
 * - uap_worktree_create: Create a new worktree for changes
 * - uap_worktree_list: List active worktrees
 * - uap_task_ready: Check task readiness
 * - uap_task_create: Create a new task
 * - uap_task_list: List current tasks
 */

export const UAPCommands: Plugin = async ({ $ }) => {
  return {
    tool: {
      uap_memory_query: tool({
        description:
          'Query UAP memory for relevant context. Use this before starting work to check for past lessons, decisions, and patterns related to the current task.',
        args: {
          query: tool.schema.string().describe('Search query for memory retrieval'),
        },
        async execute({ query }) {
          const result = await $`uap memory query ${query}`.quiet();
          return result.stdout.toString().trim() || 'No matching memories found.';
        },
      }),

      uap_memory_store: tool({
        description:
          'Store a lesson, decision, or important observation in UAP memory. Use this after completing work to preserve context for future sessions.',
        args: {
          content: tool.schema.string().describe('The lesson or decision to store'),
          importance: tool.schema
            .number()
            .min(1)
            .max(10)
            .default(7)
            .describe('Importance level (1-10, default 7)'),
        },
        async execute({ content, importance }) {
          const result = await $`uap memory store ${content} --importance ${importance}`.quiet();
          return result.stdout.toString().trim() || `Stored memory with importance ${importance}.`;
        },
      }),

      uap_memory_status: tool({
        description:
          'Show UAP memory system status including memory counts, recent activity, and database health.',
        args: {},
        async execute() {
          const result = await $`uap memory status`.quiet();
          return result.stdout.toString().trim() || 'Memory status unavailable.';
        },
      }),

      uap_worktree_create: tool({
        description:
          'Create a new git worktree for isolated changes. All file modifications MUST be done in a worktree per UAP compliance protocol.',
        args: {
          slug: tool.schema
            .string()
            .describe(
              "Short descriptive slug for the worktree (e.g., 'fix-auth-bug', 'add-dark-mode')"
            ),
        },
        async execute({ slug }) {
          const result = await $`uap worktree create ${slug}`.quiet();
          return result.stdout.toString().trim() || `Worktree created: .worktrees/*-${slug}/`;
        },
      }),

      uap_worktree_list: tool({
        description: 'List all active worktrees and their status.',
        args: {},
        async execute() {
          const result = await $`uap worktree list`.quiet();
          return result.stdout.toString().trim() || 'No active worktrees.';
        },
      }),

      uap_worktree_cleanup: tool({
        description: 'Clean up a merged worktree by ID.',
        args: {
          id: tool.schema.string().describe('Worktree ID or slug to clean up'),
        },
        async execute({ id }) {
          const result = await $`uap worktree cleanup ${id}`.quiet();
          return result.stdout.toString().trim() || `Worktree ${id} cleaned up.`;
        },
      }),

      uap_task_ready: tool({
        description:
          'Check task readiness and show pending tasks. Run this at the start of every session per UAP compliance protocol.',
        args: {},
        async execute() {
          const result = await $`uap task ready`.quiet();
          return result.stdout.toString().trim() || 'Task system ready.';
        },
      }),

      uap_task_create: tool({
        description: 'Create a new task to track work.',
        args: {
          title: tool.schema.string().describe('Task title/description'),
          type: tool.schema.enum(['task', 'bug', 'feature']).default('task').describe('Task type'),
        },
        async execute({ title, type }) {
          const result = await $`uap task create --type ${type} --title ${title}`.quiet();
          return result.stdout.toString().trim() || `Task created: ${title}`;
        },
      }),

      uap_task_list: tool({
        description: 'List current tasks and their status.',
        args: {},
        async execute() {
          const result = await $`uap task list`.quiet();
          return result.stdout.toString().trim() || 'No active tasks.';
        },
      }),

      uap_patterns_query: tool({
        description: 'Query UAP pattern library for task-relevant coding patterns and strategies.',
        args: {
          query: tool.schema.string().describe('Search query for pattern retrieval'),
        },
        async execute({ query }) {
          const result = await $`uap patterns query ${query}`.quiet();
          return result.stdout.toString().trim() || 'No matching patterns found.';
        },
      }),

      uap_agent_status: tool({
        description: 'Show status of all registered agents in the coordination system.',
        args: {},
        async execute() {
          const result = await $`uap agent status`.quiet();
          return result.stdout.toString().trim() || 'No agents registered.';
        },
      }),

      uap_dashboard: tool({
        description: 'Show UAP dashboard with overview of tasks, agents, memory, and progress.',
        args: {
          view: tool.schema
            .enum(['overview', 'tasks', 'agents', 'memory', 'progress', 'stats'])
            .default('overview')
            .describe('Dashboard view to display'),
        },
        async execute({ view }) {
          const result = await $`uap dashboard ${view}`.quiet();
          return result.stdout.toString().trim() || 'Dashboard unavailable.';
        },
      }),
    },
  };
};

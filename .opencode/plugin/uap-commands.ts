import type { Plugin } from '@opencode/plugin';
import { $, toolInput, toolResult } from '../lib/uap-plugin-kit';

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
const plugin: Plugin.Plugin = {
  id: 'uap-commands',
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: 'uap_memory_query',
        description:
          'Query UAP memory for relevant context. Use this before starting work to check for past lessons, decisions, and patterns related to the current task.',
        input: toolInput.object({ query: toolInput.string('Search query for memory retrieval') }, ['query']),
        async execute(input) {
          const { query } = input as { query: string };
          const result = await $`uap memory query ${query}`.quiet();
          return toolResult(result.stdout.toString().trim() || 'No matching memories found.');
        },
      });

      editor.add({
        name: 'uap_memory_store',
        description:
          'Store a lesson, decision, or important observation in UAP memory. Use this after completing work to preserve context for future sessions.',
        input: toolInput.object(
          {
            content: toolInput.string('The lesson or decision to store'),
            importance: toolInput.number('Importance level (1-10, default 7)', {
              minimum: 1,
              maximum: 10,
              default: 7,
            }),
          },
          ['content']
        ),
        async execute(input) {
          const { content, importance } = input as { content: string; importance?: number };
          const level = importance ?? 7;
          const result = await $`uap memory store ${content} --importance ${level}`.quiet();
          return toolResult(result.stdout.toString().trim() || `Stored memory with importance ${level}.`);
        },
      });

      editor.add({
        name: 'uap_memory_status',
        description:
          'Show UAP memory system status including memory counts, recent activity, and database health.',
        input: toolInput.object({}),
        async execute() {
          const result = await $`uap memory status`.quiet();
          return toolResult(result.stdout.toString().trim() || 'Memory status unavailable.');
        },
      });

      editor.add({
        name: 'uap_worktree_create',
        description:
          'Create a new git worktree for isolated changes. All file modifications MUST be done in a worktree per UAP compliance protocol.',
        input: toolInput.object(
          {
            slug: toolInput.string(
              "Short descriptive slug for the worktree (e.g., 'fix-auth-bug', 'add-dark-mode')"
            ),
          },
          ['slug']
        ),
        async execute(input) {
          const { slug } = input as { slug: string };
          const result = await $`uap worktree create ${slug}`.quiet();
          return toolResult(result.stdout.toString().trim() || `Worktree created: .worktrees/*-${slug}/`);
        },
      });

      editor.add({
        name: 'uap_worktree_list',
        description: 'List all active worktrees and their status.',
        input: toolInput.object({}),
        async execute() {
          const result = await $`uap worktree list`.quiet();
          return toolResult(result.stdout.toString().trim() || 'No active worktrees.');
        },
      });

      editor.add({
        name: 'uap_worktree_cleanup',
        description: 'Clean up a merged worktree by ID.',
        input: toolInput.object({ id: toolInput.string('Worktree ID or slug to clean up') }, ['id']),
        async execute(input) {
          const { id } = input as { id: string };
          const result = await $`uap worktree cleanup ${id}`.quiet();
          return toolResult(result.stdout.toString().trim() || `Worktree ${id} cleaned up.`);
        },
      });

      editor.add({
        name: 'uap_task_ready',
        description:
          'Check task readiness and show pending tasks. Run this at the start of every session per UAP compliance protocol.',
        input: toolInput.object({}),
        async execute() {
          const result = await $`uap task ready`.quiet();
          return toolResult(result.stdout.toString().trim() || 'Task system ready.');
        },
      });

      editor.add({
        name: 'uap_task_create',
        description: 'Create a new task to track work.',
        input: toolInput.object(
          {
            title: toolInput.string('Task title/description'),
            type: toolInput.enum('Task type', ['task', 'bug', 'feature'], 'task'),
          },
          ['title']
        ),
        async execute(input) {
          const { title, type } = input as { title: string; type?: string };
          const kind = type ?? 'task';
          const result = await $`uap task create --type ${kind} --title ${title}`.quiet();
          return toolResult(result.stdout.toString().trim() || `Task created: ${title}`);
        },
      });

      editor.add({
        name: 'uap_task_list',
        description: 'List current tasks and their status.',
        input: toolInput.object({}),
        async execute() {
          const result = await $`uap task list`.quiet();
          return toolResult(result.stdout.toString().trim() || 'No active tasks.');
        },
      });

      editor.add({
        name: 'uap_patterns_query',
        description: 'Query UAP pattern library for task-relevant coding patterns and strategies.',
        input: toolInput.object({ query: toolInput.string('Search query for pattern retrieval') }, ['query']),
        async execute(input) {
          const { query } = input as { query: string };
          const result = await $`uap patterns query ${query}`.quiet();
          return toolResult(result.stdout.toString().trim() || 'No matching patterns found.');
        },
      });

      editor.add({
        name: 'uap_agent_status',
        description: 'Show status of all registered agents in the coordination system.',
        input: toolInput.object({}),
        async execute() {
          const result = await $`uap agent status`.quiet();
          return toolResult(result.stdout.toString().trim() || 'No agents registered.');
        },
      });

      // NOTE: uap_dashboard is registered in uap-dashboard.ts plugin (not here)
      // to avoid duplicate tool registration with incompatible action enums.
    });
  },
};

export default plugin;

import type { Plugin } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin';

/**
 * Oh-My-Pi Integration Plugin
 *
 * Brings oh-my-pi's powerful AI coding agent features to opencode:
 * - Commit Tool: AI-powered git commits with change analysis
 * - Python Tool: Persistent IPython kernel with rich helpers
 * - LSP Integration: Full IDE-like code intelligence
 * - Task Tool: Parallel execution with specialized agents
 * - Custom Slash Commands: Programmable commands with full API access
 * - Model Roles: Different models for different purposes
 * - Interactive Code Review: Structured review with priority findings
 *
 * See: https://github.com/can1357/oh-my-pi
 */

export const OhMyPi: Plugin = async ({ $, directory }) => {
  // Check if oh-my-pi is installed
  const checkOMPInstalled = async () => {
    try {
      await $`omp --version`.quiet();
      return true;
    } catch {
      return false;
    }
  };

  const ensureInstalled = async () => {
    const installed = await checkOMPInstalled();
    if (!installed) {
      throw new Error(
        'oh-my-pi (omp) is not installed. Install with:\n' +
          '  bun install -g @oh-my-pi/pi-coding-agent\n' +
          'or:\n' +
          '  curl -fsSL https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.sh | sh'
      );
    }
  };

  return {
    tool: {
      // ==================== COMMIT TOOL ====================
      omp_commit: tool({
        description:
          'AI-powered conventional commit generation with intelligent change analysis. Automatically separates unrelated changes, stages hunks, and generates changelog entries.',
        args: {
          dryRun: tool.schema
            .boolean()
            .describe('Show what would be committed without making changes'),
          push: tool.schema.boolean().describe('Automatically push the commit after creation'),
          noChangelog: tool.schema.boolean().describe('Skip changelog generation'),
          legacy: tool.schema.boolean().describe('Use deterministic legacy mode'),
          context: tool.schema.string().describe('Additional context for the commit'),
        },
        async execute({ dryRun, push, noChangelog, legacy, context }) {
          await ensureInstalled();

          const args = [
            '--commit',
            dryRun && '--dry-run',
            push && '--push',
            noChangelog && '--no-changelog',
            legacy && '--legacy',
            context && `--context ${context}`,
          ]
            .filter(Boolean)
            .join(' ');

          const result = await $`omp ${args}`.quiet();
          return result.stdout.toString().trim() || 'Commit completed successfully.';
        },
      }),

      // ==================== PYTHON TOOL ====================
      omp_python: tool({
        description:
          'Execute Python code with a persistent IPython kernel. Supports streaming output, file I/O helpers, line operations, and rich output (HTML, Markdown, images, Mermaid).',
        args: {
          code: tool.schema.string().describe('Python code to execute'),
          setup: tool.schema.boolean().describe('Run "omp setup python" to install dependencies'),
          sharedGateway: tool.schema
            .boolean()
            .default(false)
            .describe('Reuse existing IPython kernel for efficiency'),
        },
        async execute({ code, setup, sharedGateway }) {
          await ensureInstalled();

          if (setup) {
            console.log('Setting up Python tool dependencies...');
            const setupResult = await $`omp setup python`.quiet();
            if (setupResult.exitCode !== 0) {
              throw new Error(`Python setup failed: ${setupResult.stderr.toString()}`);
            }
          }

          const args = sharedGateway ? '--shared-gateway' : '';
          const result = await $`omp python ${args} <<< ${code}`.quiet();
          return result.stdout.toString().trim() || '(no output)';
        },
      }),

      omp_python_eval: tool({
        description:
          'Evaluate a Python expression and return the result (quick evaluation without full code execution).',
        args: {
          expression: tool.schema.string().describe('Python expression to evaluate'),
        },
        async execute({ expression }) {
          await ensureInstalled();
          const result = await $`omp python <<< "print(${expression})"`.quiet();
          return result.stdout.toString().trim() || 'No output';
        },
      }),

      // ==================== LSP INTEGRATION ====================
      omp_lsp: tool({
        description:
          'Full IDE-like code intelligence with 11 LSP operations. Supports diagnostics, definition, type definition, implementation, references, hover, symbols, rename, code actions, status, and reload.',
        args: {
          action: tool.schema
            .enum([
              'diagnostics',
              'definition',
              'type_definition',
              'implementation',
              'references',
              'hover',
              'symbols',
              'rename',
              'code_actions',
              'status',
              'reload',
            ])
            .describe('LSP operation to perform'),
          file: tool.schema.string().describe('File path (required for most actions)'),
          line: tool.schema.number().describe('Line number (1-indexed)'),
          character: tool.schema.number().describe('Character position'),
          occurrence: tool.schema.string().describe('Symbol disambiguation for repeated symbols'),
        },
        async execute({ action, file, line, character, occurrence }) {
          await ensureInstalled();

          const args = [
            'lsp',
            action,
            file && `--file ${file}`,
            line && `--line ${line}`,
            character && `--character ${character}`,
            occurrence && `--occurrence ${occurrence}`,
          ]
            .filter(Boolean)
            .join(' ');

          const result = await $`omp ${args}`.quiet();
          return result.stdout.toString().trim() || 'LSP action completed.';
        },
      }),

      omp_lsp_diagnostics: tool({
        description: 'Check entire project for LSP errors and warnings without specifying a file.',
        args: {
          workspace: tool.schema.string().describe('Workspace directory (defaults to cwd)'),
        },
        async execute({ workspace }) {
          await ensureInstalled();
          const result =
            await $`omp lsp diagnostics${workspace ? ` --dir ${workspace}` : ''}`.quiet();
          return result.stdout.toString().trim() || 'No diagnostics found.';
        },
      }),

      // ==================== TASK TOOL ====================
      omp_task: tool({
        description:
          'Parallel execution framework with 6 bundled agents (explore, plan, designer, reviewer, task, quick_task). Supports isolated backends and async background jobs.',
        args: {
          agent: tool.schema
            .enum(['explore', 'plan', 'designer', 'reviewer', 'task', 'quick_task'])
            .default('task')
            .describe('Agent to use for the task'),
          prompt: tool.schema.string().describe('Task description/prompt'),
          isolated: tool.schema
            .boolean()
            .describe('Run in isolated environment (worktree/fuse-overlay/projfs)'),
          background: tool.schema.boolean().default(false).describe('Run as async background job'),
        },
        async execute({ agent, prompt, isolated, background }) {
          await ensureInstalled();

          const args = [
            'task',
            `--agent ${agent}`,
            prompt && `--prompt ${prompt}`,
            isolated && '--isolated',
            background && '--background',
          ]
            .filter(Boolean)
            .join(' ');

          const result = await $`omp ${args}`.quiet();
          return result.stdout.toString().trim() || 'Task executed successfully.';
        },
      }),

      omp_task_list: tool({
        description: 'List all active tasks and their status.',
        args: {},
        async execute() {
          await ensureInstalled();
          const result = await $`omp task list`.quiet();
          return result.stdout.toString().trim() || 'No active tasks.';
        },
      }),

      omp_task_status: tool({
        description: 'Get status of a specific task by ID.',
        args: {
          id: tool.schema.string().describe('Task ID'),
        },
        async execute({ id }) {
          await ensureInstalled();
          const result = await $`omp task status ${id}`.quiet();
          return result.stdout.toString().trim() || 'Task not found.';
        },
      }),

      // ==================== CODE REVIEW ====================
      omp_review: tool({
        description:
          'Interactive code review with priority-based findings (P0-P3). Supports branch comparison, uncommitted changes, and commit review.',
        args: {
          mode: tool.schema
            .enum(['branch', 'uncommitted', 'commit'])
            .default('uncommitted')
            .describe('Review mode'),
          baseBranch: tool.schema.string().describe('Base branch for comparison'),
          targetBranch: tool.schema.string().describe('Target branch for comparison'),
          commit: tool.schema.string().describe('Commit to review'),
        },
        async execute({ mode, baseBranch, targetBranch, commit }) {
          await ensureInstalled();

          const args = [
            'review',
            `--mode ${mode}`,
            baseBranch && `--base ${baseBranch}`,
            targetBranch && `--target ${targetBranch}`,
            commit && `--commit ${commit}`,
          ]
            .filter(Boolean)
            .join(' ');

          const result = await $`omp ${args}`.quiet();
          return result.stdout.toString().trim() || 'Review completed.';
        },
      }),

      // ==================== MODEL ROLES ====================
      omp_model: tool({
        description:
          'Configure and select models for different purposes (default, smol, slow, plan, commit). Supports role-based routing and automatic discovery.',
        args: {
          action: tool.schema
            .enum(['select', 'list', 'configure'])
            .default('select')
            .describe('Model action to perform'),
          role: tool.schema
            .enum(['default', 'smol', 'slow', 'plan', 'commit'])
            .describe('Model role to configure'),
          modelId: tool.schema.string().describe('Model ID to select'),
        },
        async execute({ action, role, modelId }) {
          await ensureInstalled();

          if (action === 'list') {
            const result = await $`omp --list-models`.quiet();
            return result.stdout.toString().trim() || 'No models found.';
          }

          if (action === 'select' && role && modelId) {
            const result = await $`omp model ${role} ${modelId}`.quiet();
            return result.stdout.toString().trim() || `Model ${modelId} selected for ${role}.`;
          }

          if (action === 'configure') {
            const result = await $`omp model configure`.quiet();
            return result.stdout.toString().trim() || 'Model configuration opened.';
          }

          throw new Error('Invalid model action. Use: list, select <role> <modelId>, or configure');
        },
      }),

      // ==================== CUSTOM SLASH COMMANDS ====================
      omp_commands_list: tool({
        description: 'List all available slash commands from global and project directories.',
        args: {},
        async execute() {
          await ensureInstalled();
          const result = await $`omp --help`.quiet();
          return result.stdout.toString().trim() || 'Commands help unavailable.';
        },
      }),

      omp_command_run: tool({
        description:
          'Run a custom slash command. Commands are defined at ~/.omp/agent/commands/<name>/index.ts or .omp/commands/<name>/index.ts',
        args: {
          name: tool.schema.string().describe('Command name'),
          args: tool.schema.string().describe('Command arguments'),
        },
        async execute({ name, args }) {
          await ensureInstalled();
          const result = await $`omp ${name}${args ? ` ${args}` : ''}`.quiet();
          return result.stdout.toString().trim() || `Command ${name} executed.`;
        },
      }),

      // ==================== SESSION MANAGEMENT ====================
      omp_session: tool({
        description: 'Manage sessions: continue most recent, resume by ID, or start new session.',
        args: {
          action: tool.schema
            .enum(['continue', 'resume', 'new'])
            .default('continue')
            .describe('Session action'),
          id: tool.schema.string().describe('Session ID or prefix for resume'),
          path: tool.schema.string().describe('Explicit session file path'),
        },
        async execute({ action, id, path }) {
          await ensureInstalled();

          if (action === 'continue') {
            const result = await $`omp --continue`.quiet();
            return result.stdout.toString().trim() || 'Continued most recent session.';
          }

          if (action === 'resume' && id) {
            const result = await $`omp --resume ${id}`.quiet();
            return result.stdout.toString().trim() || `Resumed session: ${id}.`;
          }

          if (action === 'new') {
            const result = await $`omp --new`.quiet();
            return result.stdout.toString().trim() || 'New session started.';
          }

          throw new Error('Invalid session action');
        },
      }),

      // ==================== CONTEXT MANAGEMENT ====================
      omp_compact: tool({
        description:
          'Compact session context to reduce token usage. Summarizes older messages while keeping recent context.',
        args: {
          focus: tool.schema.string().describe('Focus area for compaction'),
        },
        async execute({ focus }) {
          await ensureInstalled();
          const result = await $`omp compact${focus ? ` ${focus}` : ''}`.quiet();
          return result.stdout.toString().trim() || 'Context compacted.';
        },
      }),

      omp_handoff: tool({
        description: 'Hand off context to a new session with specified focus area.',
        args: {
          focus: tool.schema.string().describe('Focus area for handoff'),
        },
        async execute({ focus }) {
          await ensureInstalled();
          const result = await $`omp handoff${focus ? ` ${focus}` : ''}`.quiet();
          return result.stdout.toString().trim() || 'Context handed off.';
        },
      }),

      // ==================== SETTINGS ====================
      omp_settings: tool({
        description: 'Manage oh-my-pi settings via CLI (list, get, set, reset, path).',
        args: {
          action: tool.schema
            .enum(['list', 'get', 'set', 'reset', 'path'])
            .default('list')
            .describe('Settings action'),
          key: tool.schema.string().describe('Setting key for get/set'),
          value: tool.schema.string().describe('Setting value for set'),
        },
        async execute({ action, key, value }) {
          await ensureInstalled();

          if (action === 'list') {
            const result = await $`omp config list`.quiet();
            return result.stdout.toString().trim() || 'No settings found.';
          }

          if (action === 'get' && key) {
            const result = await $`omp config get ${key}`.quiet();
            return result.stdout.toString().trim() || `Setting ${key} not found.`;
          }

          if (action === 'set' && key && value) {
            const result = await $`omp config set ${key} ${value}`.quiet();
            return result.stdout.toString().trim() || `Setting ${key} updated.`;
          }

          if (action === 'reset') {
            const result = await $`omp config reset`.quiet();
            return result.stdout.toString().trim() || 'Settings reset.';
          }

          if (action === 'path') {
            const result = await $`omp config path`.quiet();
            return result.stdout.toString().trim() || 'Settings path unavailable.';
          }

          throw new Error('Invalid settings action');
        },
      }),

      // ==================== SETUP ====================
      omp_setup: tool({
        description:
          'Install optional dependencies (Python, SSHFS, etc.) via "omp setup <feature>".',
        args: {
          feature: tool.schema.enum(['python', 'sshfs']).describe('Feature to set up'),
        },
        async execute({ feature }) {
          await ensureInstalled();
          const result = await $`omp setup ${feature}`.quiet();
          return result.stdout.toString().trim() || `${feature} setup completed.`;
        },
      }),

      // ==================== SSH TOOL ====================
      omp_ssh: tool({
        description:
          'Remote command execution with persistent SSH connections. Supports project discovery, host management, and OS/shell auto-detection.',
        args: {
          action: tool.schema
            .enum(['list', 'add', 'remove', 'exec'])
            .default('list')
            .describe('SSH action'),
          host: tool.schema.string().describe('SSH host'),
          command: tool.schema.string().describe('Command to execute on remote host'),
        },
        async execute({ action, host, command }) {
          await ensureInstalled();

          if (action === 'list') {
            const result = await $`omp ssh list`.quiet();
            return result.stdout.toString().trim() || 'No SSH hosts configured.';
          }

          if (action === 'exec' && host && command) {
            const result = await $`omp ssh ${host} -- ${command}`.quiet();
            return result.stdout.toString().trim() || 'SSH command executed.';
          }

          if (action === 'add') {
            // SSH add is interactive via /ssh slash command
            return 'Use \/ssh slash command to add SSH hosts interactively.';
          }

          if (action === 'remove' && host) {
            const result = await $`omp ssh remove ${host}`.quiet();
            return result.stdout.toString().trim() || `Host ${host} removed.`;
          }

          throw new Error('Invalid SSH action');
        },
      }),

      // ==================== BROWSER TOOL ====================
      omp_browser: tool({
        description:
          'Headless browser automation with 14 stealth scripts. Supports navigation, clicking, typing, screenshots, and accessibility snapshots.',
        args: {
          action: tool.schema
            .enum([
              'navigate',
              'click',
              'type',
              'fill',
              'scroll',
              'screenshot',
              'evaluate',
              'extract_readable',
            ])
            .default('navigate')
            .describe('Browser action'),
          url: tool.schema.string().describe('URL to navigate to'),
          selector: tool.schema.string().describe('CSS/aria/text/xpath selector'),
          text: tool.schema.string().describe('Text for type/fill actions'),
          mode: tool.schema
            .enum(['headless', 'visible'])
            .default('headless')
            .describe('Browser mode'),
        },
        async execute({ action, url, selector, text, mode }) {
          await ensureInstalled();

          const args = [
            'browser',
            `--mode ${mode}`,
            action && `--action ${action}`,
            url && `--url ${url}`,
            selector && `--selector ${selector}`,
            text && `--text ${text}`,
          ]
            .filter(Boolean)
            .join(' ');

          const result = await $`omp ${args}`.quiet();
          return result.stdout.toString().trim() || 'Browser action completed.';
        },
      }),

      // ==================== IMAGE GENERATION ====================
      omp_image_generate: tool({
        description: 'Create images directly from prompts using Gemini or OpenRouter integration.',
        args: {
          prompt: tool.schema.string().describe('Image generation prompt'),
          provider: tool.schema
            .enum(['gemini', 'openrouter'])
            .default('gemini')
            .describe('Image generation provider'),
        },
        async execute({ prompt, provider }) {
          await ensureInstalled();
          const result =
            await $`omp image generate --provider ${provider} --prompt "${prompt}"`.quiet();
          return result.stdout.toString().trim() || 'Image generated.';
        },
      }),

      // ==================== CURSOR PROVIDER ====================
      omp_cursor_bridge: tool({
        description:
          'Bridge Cursor tools to oh-my-pi via OAuth authentication. Maps Cursor native tools to omp equivalents.',
        args: {
          action: tool.schema
            .enum(['login', 'logout', 'execute'])
            .default('login')
            .describe('Cursor bridge action'),
          toolName: tool.schema.string().describe('Cursor tool name to execute'),
          params: tool.schema.string().describe('Tool parameters as JSON'),
        },
        async execute({ action, toolName, params }) {
          await ensureInstalled();

          if (action === 'login') {
            return 'Use \/login cursor for OAuth authentication.';
          }

          if (action === 'logout') {
            const result = await $`omp logout cursor`.quiet();
            return result.stdout.toString().trim() || 'Cursor credentials cleared.';
          }

          if (action === 'execute' && toolName) {
            const result =
              await $`omp cursor execute ${toolName}${params ? ` ${params}` : ''}`.quiet();
            return result.stdout.toString().trim() || 'Cursor tool executed.';
          }

          throw new Error('Invalid Cursor bridge action');
        },
      }),
    },

    // ==================== EVENT HOOKS ====================
    event: async ({ event }) => {
      // Log session creation for oh-my-pi integration
      if (event.type === 'session.created') {
        console.log('[Oh-My-Pi] Session started with full toolset available');
      }
    },
  };
};

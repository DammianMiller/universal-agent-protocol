import type { Plugin } from '@opencode/plugin';
import { $, toolInput, toolResult } from '../lib/uap-plugin-kit';

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

const plugin: Plugin.Plugin = {
  id: 'oh-my-pi',
  async setup(ctx) {
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

    await ctx.tool.transform((editor) => {
      // ==================== COMMIT TOOL ====================
      editor.add({
        name: 'omp_commit',
        description:
          'AI-powered conventional commit generation with intelligent change analysis. Automatically separates unrelated changes, stages hunks, and generates changelog entries.',
        input: toolInput.object({
          dryRun: toolInput.boolean('Show what would be committed without making changes'),
          push: toolInput.boolean('Automatically push the commit after creation'),
          noChangelog: toolInput.boolean('Skip changelog generation'),
          legacy: toolInput.boolean('Use deterministic legacy mode'),
          context: toolInput.string('Additional context for the commit'),
        }),
        async execute(input) {
          const { dryRun, push, noChangelog, legacy, context } = input as {
            dryRun?: boolean;
            push?: boolean;
            noChangelog?: boolean;
            legacy?: boolean;
            context?: string;
          };
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

          const result = await $`omp ${args}`.quiet().nothrowMode();
          return toolResult(result.stdout.toString().trim() || 'Commit completed successfully.');
        },
      });

      // ==================== PYTHON TOOL ====================
      editor.add({
        name: 'omp_python',
        description:
          'Execute Python code with a persistent IPython kernel. Supports streaming output, file I/O helpers, line operations, and rich output (HTML, Markdown, images, Mermaid).',
        input: toolInput.object(
          {
            code: toolInput.string('Python code to execute'),
            setup: toolInput.boolean('Run "omp setup python" to install dependencies'),
            sharedGateway: toolInput.boolean(
              'Reuse existing IPython kernel for efficiency'
            ),
          },
          ['code']
        ),
        async execute(input) {
          const { code, setup, sharedGateway } = input as {
            code: string;
            setup?: boolean;
            sharedGateway?: boolean;
          };
          await ensureInstalled();

          if (setup) {
            console.log('Setting up Python tool dependencies...');
            const setupResult = await $`omp setup python`.quiet().nothrowMode();
            if (setupResult.exitCode !== 0) {
              throw new Error(`Python setup failed: ${setupResult.stderr.toString()}`);
            }
          }

          const args = sharedGateway ? '--shared-gateway' : '';
          const result = await $`omp python ${args} <<< ${code}`.quiet().nothrowMode();
          return toolResult(result.stdout.toString().trim() || '(no output)');
        },
      });

      editor.add({
        name: 'omp_python_eval',
        description:
          'Evaluate a Python expression and return the result (quick evaluation without full code execution).',
        input: toolInput.object(
          { expression: toolInput.string('Python expression to evaluate') },
          ['expression']
        ),
        async execute(input) {
          const { expression } = input as { expression: string };
          await ensureInstalled();
          const result = await $`omp python <<< "print(${expression})"`.quiet().nothrowMode();
          return toolResult(result.stdout.toString().trim() || 'No output');
        },
      });

      // ==================== LSP INTEGRATION ====================
      editor.add({
        name: 'omp_lsp',
        description:
          'Full IDE-like code intelligence with 11 LSP operations. Supports diagnostics, definition, type definition, implementation, references, hover, symbols, rename, code actions, status, and reload.',
        input: toolInput.object(
          {
            action: toolInput.enum('LSP operation to perform', [
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
            ]),
            file: toolInput.string('File path (required for most actions)'),
            line: toolInput.number('Line number (1-indexed)'),
            character: toolInput.number('Character position'),
            occurrence: toolInput.string('Symbol disambiguation for repeated symbols'),
          },
          ['action']
        ),
        async execute(input) {
          const { action, file, line, character, occurrence } = input as {
            action: string;
            file?: string;
            line?: number;
            character?: number;
            occurrence?: string;
          };
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

          const result = await $`omp ${args}`.quiet().nothrowMode();
          return toolResult(result.stdout.toString().trim() || 'LSP action completed.');
        },
      });

      editor.add({
        name: 'omp_lsp_diagnostics',
        description:
          'Check entire project for LSP errors and warnings without specifying a file.',
        input: toolInput.object({
          workspace: toolInput.string('Workspace directory (defaults to cwd)'),
        }),
        async execute(input) {
          const { workspace } = input as { workspace?: string };
          await ensureInstalled();
          const result =
            await $`omp lsp diagnostics${workspace ? ` --dir ${workspace}` : ''}`.quiet().nothrowMode();
          return toolResult(result.stdout.toString().trim() || 'No diagnostics found.');
        },
      });

      // ==================== TASK TOOL ====================
      editor.add({
        name: 'omp_task',
        description:
          'Parallel execution framework with 6 bundled agents (explore, plan, designer, reviewer, task, quick_task). Supports isolated backends and async background jobs.',
        input: toolInput.object(
          {
            agent: toolInput.enum(
              'Agent to use for the task',
              ['explore', 'plan', 'designer', 'reviewer', 'task', 'quick_task'],
              'task'
            ),
            prompt: toolInput.string('Task description/prompt'),
            isolated: toolInput.boolean('Run in isolated environment (worktree/fuse-overlay/projfs)'),
            background: toolInput.boolean('Run as async background job'),
          },
          []
        ),
        async execute(input) {
          const { agent, prompt, isolated, background } = input as {
            agent?: string;
            prompt?: string;
            isolated?: boolean;
            background?: boolean;
          };
          await ensureInstalled();

          const args = [
            'task',
            `--agent ${agent ?? 'task'}`,
            prompt && `--prompt ${prompt}`,
            isolated && '--isolated',
            background && '--background',
          ]
            .filter(Boolean)
            .join(' ');

          const result = await $`omp ${args}`.quiet().nothrowMode();
          return toolResult(result.stdout.toString().trim() || 'Task executed successfully.');
        },
      });

      editor.add({
        name: 'omp_task_list',
        description: 'List all active tasks and their status.',
        input: toolInput.object({}),
        async execute() {
          await ensureInstalled();
          const result = await $`omp task list`.quiet().nothrowMode();
          return toolResult(result.stdout.toString().trim() || 'No active tasks.');
        },
      });

      editor.add({
        name: 'omp_task_status',
        description: 'Get status of a specific task by ID.',
        input: toolInput.object({ id: toolInput.string('Task ID') }, ['id']),
        async execute(input) {
          const { id } = input as { id: string };
          await ensureInstalled();
          const result = await $`omp task status ${id}`.quiet().nothrowMode();
          return toolResult(result.stdout.toString().trim() || 'Task not found.');
        },
      });

      // ==================== CODE REVIEW ====================
      editor.add({
        name: 'omp_review',
        description:
          'Interactive code review with priority-based findings (P0-P3). Supports branch comparison, uncommitted changes, and commit review.',
        input: toolInput.object({
          mode: toolInput.enum('Review mode', ['branch', 'uncommitted', 'commit'], 'uncommitted'),
          baseBranch: toolInput.string('Base branch for comparison'),
          targetBranch: toolInput.string('Target branch for comparison'),
          commit: toolInput.string('Commit to review'),
        }),
        async execute(input) {
          const { mode, baseBranch, targetBranch, commit } = input as {
            mode?: string;
            baseBranch?: string;
            targetBranch?: string;
            commit?: string;
          };
          await ensureInstalled();

          const args = [
            'review',
            `--mode ${mode ?? 'uncommitted'}`,
            baseBranch && `--base ${baseBranch}`,
            targetBranch && `--target ${targetBranch}`,
            commit && `--commit ${commit}`,
          ]
            .filter(Boolean)
            .join(' ');

          const result = await $`omp ${args}`.quiet().nothrowMode();
          return toolResult(result.stdout.toString().trim() || 'Review completed.');
        },
      });

      // ==================== MODEL ROLES ====================
      editor.add({
        name: 'omp_model',
        description:
          'Configure and select models for different purposes (default, smol, slow, plan, commit). Supports role-based routing and automatic discovery.',
        input: toolInput.object({
          action: toolInput.enum('Model action to perform', ['select', 'list', 'configure'], 'select'),
          role: toolInput.enum('Model role to configure', ['default', 'smol', 'slow', 'plan', 'commit']),
          modelId: toolInput.string('Model ID to select'),
        }),
        async execute(input) {
          const { action, role, modelId } = input as {
            action?: string;
            role?: string;
            modelId?: string;
          };
          await ensureInstalled();

          if (action === 'list') {
            const result = await $`omp --list-models`.quiet().nothrowMode();
            return toolResult(result.stdout.toString().trim() || 'No models found.');
          }

          if (action === 'select' && role && modelId) {
            const result = await $`omp model ${role} ${modelId}`.quiet().nothrowMode();
            return toolResult(result.stdout.toString().trim() || `Model ${modelId} selected for ${role}.`);
          }

          if (action === 'configure') {
            const result = await $`omp model configure`.quiet().nothrowMode();
            return toolResult(result.stdout.toString().trim() || 'Model configuration opened.');
          }

          throw new Error('Invalid model action. Use: list, select <role> <modelId>, or configure');
        },
      });

      // ==================== CUSTOM SLASH COMMANDS ====================
      editor.add({
        name: 'omp_commands_list',
        description: 'List all available slash commands from global and project directories.',
        input: toolInput.object({}),
        async execute() {
          await ensureInstalled();
          const result = await $`omp --help`.quiet().nothrowMode();
          return toolResult(result.stdout.toString().trim() || 'Commands help unavailable.');
        },
      });

      editor.add({
        name: 'omp_command_run',
        description:
          'Run a custom slash command. Commands are defined at ~/.omp/agent/commands/<name>/index.ts or .omp/commands/<name>/index.ts',
        input: toolInput.object({
          name: toolInput.string('Command name'),
          args: toolInput.string('Command arguments'),
        }),
        async execute(input) {
          const { name, args } = input as { name: string; args?: string };
          await ensureInstalled();
          const result = await $`omp ${name}${args ? ` ${args}` : ''}`.quiet().nothrowMode();
          return toolResult(result.stdout.toString().trim() || `Command ${name} executed.`);
        },
      });

      // ==================== SESSION MANAGEMENT ====================
      editor.add({
        name: 'omp_session',
        description: 'Manage sessions: continue most recent, resume by ID, or start new session.',
        input: toolInput.object({
          action: toolInput.enum('Session action', ['continue', 'resume', 'new'], 'continue'),
          id: toolInput.string('Session ID or prefix for resume'),
          path: toolInput.string('Explicit session file path'),
        }),
        async execute(input) {
          const { action, id } = input as { action?: string; id?: string };
          await ensureInstalled();

          if (action === 'continue') {
            const result = await $`omp --continue`.quiet().nothrowMode();
            return toolResult(result.stdout.toString().trim() || 'Continued most recent session.');
          }

          if (action === 'resume' && id) {
            const result = await $`omp --resume ${id}`.quiet().nothrowMode();
            return toolResult(result.stdout.toString().trim() || `Resumed session: ${id}.`);
          }

          if (action === 'new') {
            const result = await $`omp --new`.quiet().nothrowMode();
            return toolResult(result.stdout.toString().trim() || 'New session started.');
          }

          throw new Error('Invalid session action');
        },
      });

      // ==================== CONTEXT MANAGEMENT ====================
      editor.add({
        name: 'omp_compact',
        description:
          'Compact session context to reduce token usage. Summarizes older messages while keeping recent context.',
        input: toolInput.object({
          focus: toolInput.string('Focus area for compaction'),
        }),
        async execute(input) {
          const { focus } = input as { focus?: string };
          await ensureInstalled();
          const result = await $`omp compact${focus ? ` ${focus}` : ''}`.quiet().nothrowMode();
          return toolResult(result.stdout.toString().trim() || 'Context compacted.');
        },
      });

      editor.add({
        name: 'omp_handoff',
        description: 'Hand off context to a new session with specified focus area.',
        input: toolInput.object({
          focus: toolInput.string('Focus area for handoff'),
        }),
        async execute(input) {
          const { focus } = input as { focus?: string };
          await ensureInstalled();
          const result = await $`omp handoff${focus ? ` ${focus}` : ''}`.quiet().nothrowMode();
          return toolResult(result.stdout.toString().trim() || 'Context handed off.');
        },
      });

      // ==================== SETTINGS ====================
      editor.add({
        name: 'omp_settings',
        description: 'Manage oh-my-pi settings via CLI (list, get, set, reset, path).',
        input: toolInput.object({
          action: toolInput.enum('Settings action', ['list', 'get', 'set', 'reset', 'path'], 'list'),
          key: toolInput.string('Setting key for get/set'),
          value: toolInput.string('Setting value for set'),
        }),
        async execute(input) {
          const { action, key, value } = input as {
            action?: string;
            key?: string;
            value?: string;
          };
          await ensureInstalled();

          if (action === 'list') {
            const result = await $`omp config list`.quiet().nothrowMode();
            return toolResult(result.stdout.toString().trim() || 'No settings found.');
          }

          if (action === 'get' && key) {
            const result = await $`omp config get ${key}`.quiet().nothrowMode();
            return toolResult(result.stdout.toString().trim() || `Setting ${key} not found.`);
          }

          if (action === 'set' && key && value) {
            const result = await $`omp config set ${key} ${value}`.quiet().nothrowMode();
            return toolResult(result.stdout.toString().trim() || `Setting ${key} updated.`);
          }

          if (action === 'reset') {
            const result = await $`omp config reset`.quiet().nothrowMode();
            return toolResult(result.stdout.toString().trim() || 'Settings reset.');
          }

          if (action === 'path') {
            const result = await $`omp config path`.quiet().nothrowMode();
            return toolResult(result.stdout.toString().trim() || 'Settings path unavailable.');
          }

          throw new Error('Invalid settings action');
        },
      });

      // ==================== SETUP ====================
      editor.add({
        name: 'omp_setup',
        description:
          'Install optional dependencies (Python, SSHFS, etc.) via "omp setup <feature>".',
        input: toolInput.object(
          { feature: toolInput.enum('Feature to set up', ['python', 'sshfs']) },
          ['feature']
        ),
        async execute(input) {
          const { feature } = input as { feature: string };
          await ensureInstalled();
          const result = await $`omp setup ${feature}`.quiet().nothrowMode();
          return toolResult(result.stdout.toString().trim() || `${feature} setup completed.`);
        },
      });

      // ==================== SSH TOOL ====================
      editor.add({
        name: 'omp_ssh',
        description:
          'Remote command execution with persistent SSH connections. Supports project discovery, host management, and OS/shell auto-detection.',
        input: toolInput.object({
          action: toolInput.enum('SSH action', ['list', 'add', 'remove', 'exec'], 'list'),
          host: toolInput.string('SSH host'),
          command: toolInput.string('Command to execute on remote host'),
        }),
        async execute(input) {
          const { action, host, command } = input as {
            action?: string;
            host?: string;
            command?: string;
          };
          await ensureInstalled();

          if (action === 'list') {
            const result = await $`omp ssh list`.quiet().nothrowMode();
            return toolResult(result.stdout.toString().trim() || 'No SSH hosts configured.');
          }

          if (action === 'exec' && host && command) {
            const result = await $`omp ssh ${host} -- ${command}`.quiet().nothrowMode();
            return toolResult(result.stdout.toString().trim() || 'SSH command executed.');
          }

          if (action === 'add') {
            // SSH add is interactive via /ssh slash command
            return toolResult('Use /ssh slash command to add SSH hosts interactively.');
          }

          if (action === 'remove' && host) {
            const result = await $`omp ssh remove ${host}`.quiet().nothrowMode();
            return toolResult(result.stdout.toString().trim() || `Host ${host} removed.`);
          }

          throw new Error('Invalid SSH action');
        },
      });

      // ==================== BROWSER TOOL ====================
      editor.add({
        name: 'omp_browser',
        description:
          'Headless browser automation with 14 stealth scripts. Supports navigation, clicking, typing, screenshots, and accessibility snapshots.',
        input: toolInput.object({
          action: toolInput.enum(
            'Browser action',
            [
              'navigate',
              'click',
              'type',
              'fill',
              'scroll',
              'screenshot',
              'evaluate',
              'extract_readable',
            ],
            'navigate'
          ),
          url: toolInput.string('URL to navigate to'),
          selector: toolInput.string('CSS/aria/text/xpath selector'),
          text: toolInput.string('Text for type/fill actions'),
          mode: toolInput.enum('Browser mode', ['headless', 'visible'], 'headless'),
        }),
        async execute(input) {
          const { action, url, selector, text } = input as {
            action?: string;
            url?: string;
            selector?: string;
            text?: string;
          };
          await ensureInstalled();

          const args = [
            'browser',
            `--mode headless`,
            action && `--action ${action}`,
            url && `--url ${url}`,
            selector && `--selector ${selector}`,
            text && `--text ${text}`,
          ]
            .filter(Boolean)
            .join(' ');

          const result = await $`omp ${args}`.quiet().nothrowMode();
          return toolResult(result.stdout.toString().trim() || 'Browser action completed.');
        },
      });

      // ==================== IMAGE GENERATION ====================
      editor.add({
        name: 'omp_image_generate',
        description: 'Create images directly from prompts using Gemini or OpenRouter integration.',
        input: toolInput.object(
          {
            prompt: toolInput.string('Image generation prompt'),
            provider: toolInput.enum('Image generation provider', ['gemini', 'openrouter'], 'gemini'),
          },
          ['prompt']
        ),
        async execute(input) {
          const { prompt, provider } = input as { prompt: string; provider?: string };
          await ensureInstalled();
          const result =
            await $`omp image generate --provider ${provider ?? 'gemini'} --prompt "${prompt}"`.quiet().nothrowMode();
          return toolResult(result.stdout.toString().trim() || 'Image generated.');
        },
      });

      // ==================== CURSOR PROVIDER ====================
      editor.add({
        name: 'omp_cursor_bridge',
        description:
          'Bridge Cursor tools to oh-my-pi via OAuth authentication. Maps Cursor native tools to omp equivalents.',
        input: toolInput.object({
          action: toolInput.enum('Cursor bridge action', ['login', 'logout', 'execute'], 'login'),
          toolName: toolInput.string('Cursor tool name to execute'),
          params: toolInput.string('Tool parameters as JSON'),
        }),
        async execute(input) {
          const { action, toolName, params } = input as {
            action?: string;
            toolName?: string;
            params?: string;
          };
          await ensureInstalled();

          if (action === 'login') {
            return toolResult('Use /login cursor for OAuth authentication.');
          }

          if (action === 'logout') {
            const result = await $`omp logout cursor`.quiet().nothrowMode();
            return toolResult(result.stdout.toString().trim() || 'Cursor credentials cleared.');
          }

          if (action === 'execute' && toolName) {
            const result =
              await $`omp cursor execute ${toolName}${params ? ` ${params}` : ''}`.quiet().nothrowMode();
            return toolResult(result.stdout.toString().trim() || 'Cursor tool executed.');
          }

          throw new Error('Invalid Cursor bridge action');
        },
      });
    });

    // Log session creation for oh-my-pi integration
    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({
        types: ['session.created'],
        signal: controller.signal,
      })) {
        if (event.type === 'session.created') {
          console.log('[Oh-My-Pi] Session started with full toolset available');
        }
      }
    })();

    return () => controller.abort();
  },
};

export default plugin;

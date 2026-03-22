import chalk from 'chalk';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type HooksTarget =
  | 'claude'
  | 'factory'
  | 'cursor'
  | 'vscode'
  | 'opencode'
  | 'codex'
  | 'forgecode'
  | 'omp';
type HooksAction = 'install' | 'status';

interface HooksOptions {
  projectDir?: string;
  target?: HooksTarget;
}

const ALL_TARGETS: HooksTarget[] = [
  'claude',
  'factory',
  'cursor',
  'vscode',
  'opencode',
  'codex',
  'forgecode',
  'omp',
];

export async function hooksCommand(action: HooksAction, options: HooksOptions = {}): Promise<void> {
  const cwd = options.projectDir || process.cwd();
  const targets = options.target ? [options.target] : ALL_TARGETS;

  switch (action) {
    case 'install':
      for (const target of targets) {
        await installHooksForTarget(cwd, target);
      }
      break;
    case 'status':
      for (const target of targets) {
        await showHooksStatusForTarget(cwd, target);
      }
      break;
  }
}

function getTemplateHooksDir(): string {
  return join(__dirname, '../../templates/hooks');
}

function ensureTemplateHooksExist(): boolean {
  const templateHooksDir = getTemplateHooksDir();
  if (!existsSync(templateHooksDir)) {
    console.log(chalk.red('  Template hooks not found. Ensure templates/hooks/ exists.'));
    return false;
  }
  return true;
}

function copyHookScripts(targetHooksDir: string): void {
  const templateHooksDir = getTemplateHooksDir();
  if (!existsSync(targetHooksDir)) {
    mkdirSync(targetHooksDir, { recursive: true });
    console.log(chalk.dim(`  Created ${targetHooksDir}`));
  }

  const hookFiles = [
    'loop-protection.sh',
    'session-start.sh',
    'pre-compact.sh',
    'pre-tool-use-edit-write.sh',
    'pre-tool-use-bash.sh',
    'post-tool-use-edit-write.sh',
    'post-compact.sh',
    'stop.sh',
    'session-end.sh',
  ];
  for (const file of hookFiles) {
    const src = join(templateHooksDir, file);
    const dest = join(targetHooksDir, file);
    if (existsSync(src)) {
      copyFileSync(src, dest);
      chmodSync(dest, 0o755);
      console.log(chalk.green(`  + ${file}`));
    } else {
      console.log(chalk.yellow(`  - ${file} (template not found)`));
    }
  }
}

function updateGitignore(cwd: string, entries: string[]): void {
  const gitignorePath = join(cwd, '.gitignore');
  if (existsSync(gitignorePath)) {
    let gitignore = readFileSync(gitignorePath, 'utf-8');
    let updated = false;
    for (const entry of entries) {
      if (!gitignore.includes(entry)) {
        gitignore = gitignore.trimEnd() + '\n' + entry + '\n';
        updated = true;
      }
    }
    if (updated) {
      writeFileSync(gitignorePath, gitignore);
      console.log(chalk.dim('  Updated .gitignore'));
    }
  }
}

// --- Claude Code ---

async function installClaudeHooks(cwd: string): Promise<void> {
  console.log(chalk.bold('\n  Installing UAP Hooks for Claude Code\n'));
  if (!ensureTemplateHooksExist()) return;

  const claudeDir = join(cwd, '.claude');
  const claudeHooksDir = join(claudeDir, 'hooks');
  copyHookScripts(claudeHooksDir);

  const settingsPath = join(claudeDir, 'settings.local.json');
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      /* start fresh */
    }
  }

  const hooksConfig = {
    SessionStart: [
      {
        matcher: '',
        hooks: [{ type: 'command', command: 'bash .claude/hooks/session-start.sh' }],
      },
    ],
    PreToolUse: [
      {
        matcher: 'Edit|Write',
        hooks: [{ type: 'command', command: 'bash .claude/hooks/pre-tool-use-edit-write.sh' }],
      },
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: 'bash .claude/hooks/pre-tool-use-bash.sh' }],
      },
    ],
    PostToolUse: [
      {
        matcher: 'Edit|Write',
        hooks: [{ type: 'command', command: 'bash .claude/hooks/post-tool-use-edit-write.sh' }],
      },
    ],
    PreCompact: [
      {
        matcher: '',
        hooks: [{ type: 'command', command: 'bash .claude/hooks/pre-compact.sh' }],
      },
    ],
    PostCompact: [
      {
        matcher: '',
        hooks: [{ type: 'command', command: 'bash .claude/hooks/post-compact.sh' }],
      },
    ],
    Stop: [
      {
        matcher: '',
        hooks: [{ type: 'command', command: 'bash .claude/hooks/stop.sh' }],
      },
    ],
    SessionEnd: [
      {
        matcher: '',
        hooks: [{ type: 'command', command: 'bash .claude/hooks/session-end.sh' }],
      },
    ],
  };

  const existingHooks = (settings.hooks || {}) as Record<string, unknown>;
  settings.hooks = { ...existingHooks, ...hooksConfig };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(chalk.green('  + settings.local.json (hooks configured)'));

  updateGitignore(cwd, ['.claude/settings.local.json']);
  console.log(chalk.bold.green('\n  Claude Code hooks installed successfully!'));
  console.log(chalk.dim('  Restart Claude Code or run /hooks to activate.\n'));
}

// --- Factory.AI Droid ---

async function installFactoryHooks(cwd: string): Promise<void> {
  console.log(chalk.bold('\n  Installing UAP Hooks for Factory.AI Droid\n'));
  if (!ensureTemplateHooksExist()) return;

  const factoryDir = join(cwd, '.factory');
  const factoryHooksDir = join(factoryDir, 'hooks');
  copyHookScripts(factoryHooksDir);

  const settingsPath = join(factoryDir, 'settings.local.json');
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      /* start fresh */
    }
  }

  const hooksConfig = {
    SessionStart: [
      {
        matcher: '',
        hooks: [
          { type: 'command', command: '"$FACTORY_PROJECT_DIR"/.factory/hooks/session-start.sh' },
        ],
      },
    ],
    PreToolUse: [
      {
        matcher: 'Edit|Write',
        hooks: [
          { type: 'command', command: '"$FACTORY_PROJECT_DIR"/.factory/hooks/pre-tool-use-edit-write.sh' },
        ],
      },
      {
        matcher: 'Bash',
        hooks: [
          { type: 'command', command: '"$FACTORY_PROJECT_DIR"/.factory/hooks/pre-tool-use-bash.sh' },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: 'Edit|Write',
        hooks: [
          { type: 'command', command: '"$FACTORY_PROJECT_DIR"/.factory/hooks/post-tool-use-edit-write.sh' },
        ],
      },
    ],
    PreCompact: [
      {
        matcher: '',
        hooks: [{ type: 'command', command: '"$FACTORY_PROJECT_DIR"/.factory/hooks/pre-compact.sh' }],
      },
    ],
    PostCompact: [
      {
        matcher: '',
        hooks: [{ type: 'command', command: '"$FACTORY_PROJECT_DIR"/.factory/hooks/post-compact.sh' }],
      },
    ],
    Stop: [
      {
        matcher: '',
        hooks: [{ type: 'command', command: '"$FACTORY_PROJECT_DIR"/.factory/hooks/stop.sh' }],
      },
    ],
    SessionEnd: [
      {
        matcher: '',
        hooks: [{ type: 'command', command: '"$FACTORY_PROJECT_DIR"/.factory/hooks/session-end.sh' }],
      },
    ],
  };

  const existingHooks = (settings.hooks || {}) as Record<string, unknown>;
  settings.hooks = { ...existingHooks, ...hooksConfig };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(chalk.green('  + settings.local.json (hooks configured)'));

  updateGitignore(cwd, ['.factory/settings.local.json']);
  console.log(chalk.bold.green('\n  Factory.AI Droid hooks installed successfully!'));
  console.log(chalk.dim('  Restart Droid or run /hooks to activate.\n'));
}

// --- Cursor ---

async function installCursorHooks(cwd: string): Promise<void> {
  console.log(chalk.bold('\n  Installing UAP Hooks for Cursor\n'));
  if (!ensureTemplateHooksExist()) return;

  const cursorDir = join(cwd, '.cursor');
  const cursorHooksDir = join(cursorDir, 'hooks');
  copyHookScripts(cursorHooksDir);

  const hooksJsonPath = join(cursorDir, 'hooks.json');
  let config: Record<string, unknown> = { version: 1, hooks: {} };
  if (existsSync(hooksJsonPath)) {
    try {
      config = JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
    } catch {
      /* start fresh */
    }
  }

  const existingHooks = (config.hooks || {}) as Record<string, unknown>;
  config.hooks = {
    ...existingHooks,
    sessionStart: [{ command: '.cursor/hooks/session-start.sh' }],
    preToolUse: [
      { matcher: 'Edit|Write', command: '.cursor/hooks/pre-tool-use-edit-write.sh' },
      { matcher: 'Bash', command: '.cursor/hooks/pre-tool-use-bash.sh' },
    ],
    postToolUse: [
      { matcher: 'Edit|Write', command: '.cursor/hooks/post-tool-use-edit-write.sh' },
    ],
    preCompact: [{ command: '.cursor/hooks/pre-compact.sh' }],
    postCompact: [{ command: '.cursor/hooks/post-compact.sh' }],
    stop: [{ command: '.cursor/hooks/stop.sh' }],
    sessionEnd: [{ command: '.cursor/hooks/session-end.sh' }],
  };
  config.version = 1;

  writeFileSync(hooksJsonPath, JSON.stringify(config, null, 2) + '\n');
  console.log(chalk.green('  + hooks.json (hooks configured)'));

  console.log(chalk.bold.green('\n  Cursor hooks installed successfully!'));
  console.log(chalk.dim('  Restart Cursor to activate.\n'));
}

// --- VSCode (uses Claude Code hooks via third-party skills) ---

async function installVscodeHooks(cwd: string): Promise<void> {
  console.log(chalk.bold('\n  Installing UAP Hooks for VSCode (via Claude Code format)\n'));
  if (!ensureTemplateHooksExist()) return;

  const claudeDir = join(cwd, '.claude');
  const claudeHooksDir = join(claudeDir, 'hooks');
  copyHookScripts(claudeHooksDir);

  const settingsPath = join(claudeDir, 'settings.local.json');
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      /* start fresh */
    }
  }

  const hooksConfig = {
    SessionStart: [
      {
        matcher: '',
        hooks: [{ type: 'command', command: 'bash .claude/hooks/session-start.sh' }],
      },
    ],
    PreToolUse: [
      {
        matcher: 'Edit|Write',
        hooks: [{ type: 'command', command: 'bash .claude/hooks/pre-tool-use-edit-write.sh' }],
      },
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: 'bash .claude/hooks/pre-tool-use-bash.sh' }],
      },
    ],
    PostToolUse: [
      {
        matcher: 'Edit|Write',
        hooks: [{ type: 'command', command: 'bash .claude/hooks/post-tool-use-edit-write.sh' }],
      },
    ],
    PreCompact: [
      {
        matcher: '',
        hooks: [{ type: 'command', command: 'bash .claude/hooks/pre-compact.sh' }],
      },
    ],
    PostCompact: [
      {
        matcher: '',
        hooks: [{ type: 'command', command: 'bash .claude/hooks/post-compact.sh' }],
      },
    ],
    Stop: [
      {
        matcher: '',
        hooks: [{ type: 'command', command: 'bash .claude/hooks/stop.sh' }],
      },
    ],
    SessionEnd: [
      {
        matcher: '',
        hooks: [{ type: 'command', command: 'bash .claude/hooks/session-end.sh' }],
      },
    ],
  };

  const existingHooks = (settings.hooks || {}) as Record<string, unknown>;
  settings.hooks = { ...existingHooks, ...hooksConfig };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(chalk.green('  + .claude/settings.local.json (hooks configured)'));

  updateGitignore(cwd, ['.claude/settings.local.json']);
  console.log(chalk.bold.green('\n  VSCode hooks installed successfully!'));
  console.log(chalk.dim('  Enable "Third-party skills" in Cursor/VSCode settings to activate.\n'));
}

// --- OpenCode (plugin-based) ---

async function installOpencodeHooks(cwd: string): Promise<void> {
  console.log(chalk.bold('\n  Installing UAP Hooks for OpenCode\n'));

  const pluginDir = join(cwd, '.opencode', 'plugin');
  if (!existsSync(pluginDir)) {
    mkdirSync(pluginDir, { recursive: true });
    console.log(chalk.dim(`  Created ${pluginDir}`));
  }

  const dbPath = './agents/data/memory/short_term.db';
  const coordDbPath = './agents/data/coordination/coordination.db';

  const pluginContent = [
    'import type { Plugin } from "@opencode-ai/plugin"',
    '',
    'export const UAPSessionHooks: Plugin = async ({ client, $ }) => {',
    '  return {',
    '    event: async ({ event, output }) => {',
    '      if (event.type === "session.created") {',
    '        try {',
    "          const result = await $`bash -c '",
    `            DB_PATH="${dbPath}"`,
    `            COORD_DB="${coordDbPath}"`,
    '',
    '            if [ ! -f "$DB_PATH" ]; then exit 0; fi',
    '',
    '            if [ -f "$COORD_DB" ]; then',
    '              sqlite3 "$COORD_DB" "',
    '                DELETE FROM work_claims WHERE agent_id IN (',
    '                  SELECT id FROM agent_registry',
    "                  WHERE status IN (\\'active\\',\\'idle\\') AND last_heartbeat < datetime(\\'now\\',\\'-24 hours\\')",
    '                );',
    "                UPDATE agent_registry SET status=\\'failed\\'",
    "                  WHERE status IN (\\'active\\',\\'idle\\') AND last_heartbeat < datetime(\\'now\\',\\'-24 hours\\');",
    '              " 2>/dev/null || true',
    '            fi',
    '',
    '            sqlite3 "$DB_PATH" "',
    "              SELECT type || \\': \\' || content FROM memories",
    "              WHERE timestamp >= datetime(\\'now\\', \\'-1 day\\')",
    '              ORDER BY id DESC LIMIT 10;',
    '            " 2>/dev/null || true',
    "          '`.quiet()",
    '          const memoryContext = result.stdout.toString().trim()',
    '          if (memoryContext && output && output.context) {',
    '            output.context.push("<uap-context>\\n## UAP Session Memory (last 24h)\\n" + memoryContext + "\\n</uap-context>")',
    '            console.log("[UAP] Session context injected (" + memoryContext.split("\\n").length + " memories)")',
    '          } else if (output && output.context) {',
    '            output.context.push("<uap-context>UAP active. No recent memories found.</uap-context>")',
    '            console.log("[UAP] Session started (no recent memories)")',
    '          }',
    '        } catch { /* fail safely */ }',
    '      }',
    '    },',
    '',
    '    "experimental.session.compacting": async (_input, output) => {',
    '      try {',
    '        const timestamp = new Date().toISOString()',
    `        await $\`sqlite3 ${dbPath} "INSERT OR IGNORE INTO memories (timestamp, type, content) VALUES ('\${timestamp}', 'action', '[pre-compact] Context compaction at \${timestamp}');"\`.quiet()`,
    '        output.context.push("<uap-context>Pre-compact marker saved to UAP memory.</uap-context>")',
    '      } catch { /* fail safely */ }',
    '    },',
    '  }',
    '}',
  ].join('\n');

  const pluginPath = join(pluginDir, 'uap-session-hooks.ts');
  writeFileSync(pluginPath, pluginContent);
  console.log(chalk.green('  + .opencode/plugin/uap-session-hooks.ts'));

  const packageJsonPath = join(cwd, '.opencode', 'package.json');
  if (!existsSync(packageJsonPath)) {
    const pkg = {
      dependencies: {
        '@opencode-ai/plugin': 'latest',
      },
    };
    writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log(chalk.green('  + .opencode/package.json'));
  }

  console.log(chalk.bold.green('\n  OpenCode hooks installed successfully!'));
  console.log(chalk.dim('  Restart OpenCode to activate.\n'));
}

// --- Codex CLI (AGENTS.md + Skills + MCP) ---

async function installCodexHooks(cwd: string): Promise<void> {
  console.log(chalk.bold('\n  Installing UAP Hooks for Codex CLI\n'));
  if (!ensureTemplateHooksExist()) return;

  // Create .codex/hooks directory and copy hook scripts
  const codexDir = join(cwd, '.codex');
  const codexHooksDir = join(codexDir, 'hooks');
  if (!existsSync(codexHooksDir)) {
    mkdirSync(codexHooksDir, { recursive: true });
    console.log(chalk.dim(`  Created ${codexHooksDir}`));
  }
  copyHookScripts(codexHooksDir);

  // Generate AGENTS.md with UAP integration instructions
  const agentsMdPath = join(cwd, 'AGENTS.md');
  const agentsMdContent = [
    '# AGENTS.md - UAP Integration for Codex CLI',
    '',
    '## Universal Agent Protocol (UAP)',
    '',
    'This project uses UAP for persistent memory, multi-agent coordination,',
    'pattern libraries, and policy enforcement across sessions.',
    '',
    '## Session Lifecycle',
    '',
    'At the beginning of each session, load UAP context by running:',
    '',
    '```',
    'bash .codex/hooks/session-start.sh',
    '```',
    '',
    'Before context compaction, preserve state:',
    '',
    '```',
    'bash .codex/hooks/pre-compact.sh',
    '```',
    '',
    '## Enforcement Hooks',
    '',
    'The following enforcement hooks are installed and run automatically:',
    '',
    '- **pre-tool-use-edit-write.sh** - Blocks edits outside worktree directories',
    '- **pre-tool-use-bash.sh** - Blocks dangerous commands (force push, terraform apply, etc)',
    '- **post-tool-use-edit-write.sh** - Runs build gate + backup reminder after edits',
    '- **post-compact.sh** - Re-injects policy awareness after context compaction',
    '- **stop.sh** - Completion gate checklist + session cleanup',
    '- **session-end.sh** - Agent deregistration + backup retention',
    '',
    '## Memory System',
    '',
    'UAP provides persistent memory across sessions. Use these commands:',
    '',
    '- **Query memory**: `uap memory query "<search terms>"` - Find relevant context',
    '- **Store lesson**: `uap memory store "<content>" --importance <1-10>` - Save knowledge',
    '- **Memory status**: `uap memory status` - Check memory system health',
    '',
    'Always query memory at the start of a task to check for prior context.',
    '',
    '## Worktree Workflow',
    '',
    'All code changes MUST use worktrees for safe git workflow:',
    '',
    '1. `uap worktree create <slug>` - Create isolated worktree',
    '2. Work inside the `.worktrees/<id>-<slug>/` directory',
    '3. `uap worktree cleanup <id>` - Clean up after merge',
    '4. `uap worktree list` - List active worktrees',
    '',
    'Never edit files in the project root directory.',
    '',
    '## Pattern Library',
    '',
    'Query task-relevant patterns before starting work:',
    '',
    '- `uap patterns query "<task description>"` - Get relevant patterns',
    '',
    '## Task Management',
    '',
    '- `uap task create "<description>"` - Create a new task',
    '- `uap task list` - List current tasks',
    '- `uap task ready` - Check task readiness',
    '',
    '## Agent Coordination',
    '',
    '- `uap agent status` - Show agent coordination status',
    '- `uap dashboard` - Show UAP session dashboard',
    '',
  ].join('\n');

  if (!existsSync(agentsMdPath)) {
    writeFileSync(agentsMdPath, agentsMdContent);
    console.log(chalk.green('  + AGENTS.md (UAP integration instructions)'));
  } else {
    // Check if UAP section already exists
    const existing = readFileSync(agentsMdPath, 'utf-8');
    if (!existing.includes('Universal Agent Protocol')) {
      writeFileSync(agentsMdPath, existing.trimEnd() + '\n\n' + agentsMdContent);
      console.log(chalk.green('  + AGENTS.md (appended UAP section)'));
    } else {
      console.log(chalk.dim('  ~ AGENTS.md (UAP section already present)'));
    }
  }

  // Generate .codex/config.toml with UAP MCP server
  if (!existsSync(codexDir)) {
    mkdirSync(codexDir, { recursive: true });
  }
  const configTomlPath = join(codexDir, 'config.toml');
  if (!existsSync(configTomlPath)) {
    const configToml = [
      '# Codex CLI configuration with UAP integration',
      '# Generated by: uap hooks install --target codex',
      '',
      '# UAP MCP Server - provides memory, worktree, pattern, and task tools',
      '[mcp_servers.uap]',
      'command = "uap"',
      'args = ["mcp", "serve"]',
      'startup_timeout_sec = 15',
      'tool_timeout_sec = 120',
      '',
    ].join('\n');
    writeFileSync(configTomlPath, configToml);
    console.log(chalk.green('  + .codex/config.toml (MCP server configured)'));
  } else {
    // Check if UAP MCP server already configured
    const existing = readFileSync(configTomlPath, 'utf-8');
    if (!existing.includes('[mcp_servers.uap]')) {
      const mcpSection = [
        '',
        '# UAP MCP Server - provides memory, worktree, pattern, and task tools',
        '[mcp_servers.uap]',
        'command = "uap"',
        'args = ["mcp", "serve"]',
        'startup_timeout_sec = 15',
        'tool_timeout_sec = 120',
        '',
      ].join('\n');
      writeFileSync(configTomlPath, existing.trimEnd() + '\n' + mcpSection);
      console.log(chalk.green('  + .codex/config.toml (appended UAP MCP server)'));
    } else {
      console.log(chalk.dim('  ~ .codex/config.toml (UAP MCP server already configured)'));
    }
  }

  // Generate Codex skills for UAP capabilities
  const skillsDir = join(cwd, '.agents', 'skills');
  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true });
  }

  // Skill: uap-memory
  const memorySkillDir = join(skillsDir, 'uap-memory');
  if (!existsSync(memorySkillDir)) {
    mkdirSync(memorySkillDir, { recursive: true });
    writeFileSync(
      join(memorySkillDir, 'SKILL.md'),
      [
        '---',
        'name: uap-memory',
        'description: Query and store persistent memory across sessions using UAP. Use when you need to recall prior context, store lessons learned, or check what was done in previous sessions.',
        '---',
        '',
        '# UAP Memory Skill',
        '',
        '## When to use',
        '- At the start of any task to check for prior context',
        '- After completing work to store lessons learned',
        '- When you need to recall decisions or patterns from previous sessions',
        '',
        '## Commands',
        '',
        '### Query Memory',
        '```bash',
        'uap memory query "<search terms>"',
        '```',
        'Returns relevant memories matching the search terms.',
        '',
        '### Store Memory',
        '```bash',
        'uap memory store "<content>" --importance <1-10>',
        '```',
        'Stores a new memory entry. Use importance 7-10 for critical decisions,',
        '4-6 for useful context, 1-3 for minor notes.',
        '',
        '### Memory Status',
        '```bash',
        'uap memory status',
        '```',
        'Shows memory system health and statistics.',
        '',
      ].join('\n')
    );
    console.log(chalk.green('  + .agents/skills/uap-memory/SKILL.md'));
  }

  // Skill: uap-worktree
  const worktreeSkillDir = join(skillsDir, 'uap-worktree');
  if (!existsSync(worktreeSkillDir)) {
    mkdirSync(worktreeSkillDir, { recursive: true });
    writeFileSync(
      join(worktreeSkillDir, 'SKILL.md'),
      [
        '---',
        'name: uap-worktree',
        'description: Manage git worktrees for safe, isolated code changes. Use before making any file edits to ensure changes are in an isolated branch.',
        '---',
        '',
        '# UAP Worktree Skill',
        '',
        '## When to use',
        '- Before making ANY code changes',
        '- To list or clean up existing worktrees',
        '',
        '## Workflow',
        '',
        '1. **Create worktree**: `uap worktree create <slug>`',
        '2. **Work in worktree**: All edits in `.worktrees/<id>-<slug>/`',
        '3. **List worktrees**: `uap worktree list`',
        '4. **Cleanup**: `uap worktree cleanup <id>`',
        '',
        '## Rules',
        '- Never edit files in the project root directory',
        '- Always verify you are in a worktree before editing',
        '- Run `uap worktree ensure --strict` to verify',
        '',
      ].join('\n')
    );
    console.log(chalk.green('  + .agents/skills/uap-worktree/SKILL.md'));
  }

  // Skill: uap-patterns
  const patternsSkillDir = join(skillsDir, 'uap-patterns');
  if (!existsSync(patternsSkillDir)) {
    mkdirSync(patternsSkillDir, { recursive: true });
    writeFileSync(
      join(patternsSkillDir, 'SKILL.md'),
      [
        '---',
        'name: uap-patterns',
        'description: Query the UAP pattern library for task-relevant best practices and proven solutions. Use before starting complex tasks.',
        '---',
        '',
        '# UAP Pattern Library Skill',
        '',
        '## When to use',
        '- Before starting any complex task',
        '- When you need proven solutions for common problems',
        '- To find best practices for specific domains',
        '',
        '## Commands',
        '',
        '### Query Patterns',
        '```bash',
        'uap patterns query "<task description>"',
        '```',
        'Returns relevant patterns from the library matching the task.',
        '',
        '### Index Patterns',
        '```bash',
        'uap patterns index',
        '```',
        'Re-indexes patterns into the vector database.',
        '',
      ].join('\n')
    );
    console.log(chalk.green('  + .agents/skills/uap-patterns/SKILL.md'));
  }

  // Skill: uap-tasks
  const tasksSkillDir = join(skillsDir, 'uap-tasks');
  if (!existsSync(tasksSkillDir)) {
    mkdirSync(tasksSkillDir, { recursive: true });
    writeFileSync(
      join(tasksSkillDir, 'SKILL.md'),
      [
        '---',
        'name: uap-tasks',
        'description: Manage tasks with UAP task tracking system. Use to create, list, and check readiness of tasks.',
        '---',
        '',
        '# UAP Task Management Skill',
        '',
        '## Commands',
        '',
        '### Create Task',
        '```bash',
        'uap task create "<description>"',
        '```',
        '',
        '### List Tasks',
        '```bash',
        'uap task list',
        '```',
        '',
        '### Check Readiness',
        '```bash',
        'uap task ready',
        '```',
        'Checks if all prerequisites are met for the current task.',
        '',
      ].join('\n')
    );
    console.log(chalk.green('  + .agents/skills/uap-tasks/SKILL.md'));
  }

  // Skill: uap-coordination
  const coordSkillDir = join(skillsDir, 'uap-coordination');
  if (!existsSync(coordSkillDir)) {
    mkdirSync(coordSkillDir, { recursive: true });
    writeFileSync(
      join(coordSkillDir, 'SKILL.md'),
      [
        '---',
        'name: uap-coordination',
        'description: Multi-agent coordination and status monitoring. Use to check agent status, view the dashboard, and coordinate with other agents.',
        '---',
        '',
        '# UAP Agent Coordination Skill',
        '',
        '## Commands',
        '',
        '### Agent Status',
        '```bash',
        'uap agent status',
        '```',
        'Shows all registered agents and their current status.',
        '',
        '### Dashboard',
        '```bash',
        'uap dashboard',
        '```',
        'Shows the UAP session dashboard with live telemetry.',
        '',
        '### Dashboard Views',
        '```bash',
        'uap dashboard --view summary',
        'uap dashboard --view snapshot',
        '```',
        '',
      ].join('\n')
    );
    console.log(chalk.green('  + .agents/skills/uap-coordination/SKILL.md'));
  }

  updateGitignore(cwd, ['.codex/config.toml']);

  console.log(chalk.bold.green('\n  Codex CLI hooks installed successfully!'));
  console.log(chalk.dim('  Integration includes:'));
  console.log(chalk.dim('    - AGENTS.md with UAP instructions'));
  console.log(chalk.dim('    - .codex/config.toml with UAP MCP server'));
  console.log(chalk.dim('    - .codex/hooks/ with session lifecycle scripts'));
  console.log(chalk.dim('    - .agents/skills/ with 5 UAP skills'));
  console.log(chalk.dim('  Restart Codex CLI to activate.\n'));
}

// --- ForgeCode (ZSH-native agent) ---

async function installForgeCodeHooks(cwd: string): Promise<void> {
  console.log(chalk.bold('\n  Installing UAP Hooks for ForgeCode\n'));
  if (!ensureTemplateHooksExist()) return;

  const forgeDir = join(cwd, '.forge');
  const forgeHooksDir = join(forgeDir, 'hooks');
  copyHookScripts(forgeHooksDir);

  // Copy ZSH plugin script to .opencode/plugins for easy access
  const opencodePluginDir = join(cwd, '.opencode', 'plugin');
  if (!existsSync(opencodePluginDir)) {
    mkdirSync(opencodePluginDir, { recursive: true });
    console.log(chalk.dim(`  Created ${chalk.gray(opencodePluginDir)}`));
  }

  const pluginTemplate = join(getTemplateHooksDir(), 'forgecode.plugin.sh');

  // Define output path first so it's available in both branches
  const pluginOutputPath = join(cwd, '.forge', 'forgecode.plugin.sh');

  // Copy the pre-generated ZSH plugin template to project .forge directory
  if (existsSync(pluginTemplate)) {
    copyFileSync(pluginTemplate, pluginOutputPath);
    chmodSync(pluginOutputPath, 0o755);
    console.log(chalk.green('  + .forge/forgecode.plugin.sh'));
  } else {
    // Fallback: generate inline if template not found (shouldn't happen)
    const dbPath = './agents/data/memory/short_term.db';
    writeFileSync(
      pluginOutputPath,
      '# UAP ForgeCode Integration Plugin\n' +
        '// Auto-generated by: uap hooks install forgecode  \n' +
        '_uap_forgecode_session_start() {\n' +
        '  local PROJECT_DIR="${FORGE_UAP_PROJECT:-.}"\n' +
        '  if [ ! -f "\$PROJECT_DIR/' +
        dbPath.replace(/\//g, '\/') +
        '" ]; then exit 0; fi\n' +
        '  echo "[UAP-ForgCode] Session started with UAP context injection" >&2\n' +
        '}\n' +
        '_uap_forgecode_pre_compact() {\n' +
        '  local PROJECT_DIR="${FORGE_UAP_PROJECT:-.}"\n' +
        '  if [ ! -f "\$PROJECT_DIR/' +
        dbPath.replace(/\//g, '\/') +
        '" ]; then exit 0; fi\n' +
        '  echo "[UAP-ForgCode] Pre-compact marker saved" >&2\n' +
        '}\n' +
        'export -f _uap_forgecode_session_start _uap_forgecode_pre_compact;'
    );
  }

  console.log(chalk.green('  + .forge/forgecode.plugin.sh'));

  updateGitignore(cwd, ['.forge/settings.local.json']);

  console.log(chalk.bold.green('\n  ForgeCode hooks installed successfully!'));
  console.log(
    chalk.dim('\nTo activate in your terminal:') +
      '\n' +
      chalk.cyan('    source ~/.zshrc') +
      chalk.gray(' (or restart terminal)')
  );
}

// --- Oh-My-Pi (omp) ---

async function installOmpHooks(cwd: string): Promise<void> {
  console.log(chalk.bold('\n  Installing UAP Hooks for Oh-My-Pi (omp)\n'));

  const uapOmpDir = join(cwd, '.uap', 'omp');
  if (!existsSync(uapOmpDir)) {
    mkdirSync(uapOmpDir, { recursive: true });
    console.log(chalk.dim(`  Created ${uapOmpDir}`));
  }

  const hooksPre = join(uapOmpDir, 'hooks', 'pre');
  const hooksPost = join(uapOmpDir, 'hooks', 'post');
  mkdirSync(hooksPre, { recursive: true });
  mkdirSync(hooksPost, { recursive: true });

  // Copy hook scripts to pre/ directory
  const preHookFiles = [
    'session-start.sh',
    'pre-compact.sh',
    'pre-tool-use-edit-write.sh',
    'pre-tool-use-bash.sh',
  ];
  for (const file of preHookFiles) {
    const src = join(getTemplateHooksDir(), file);
    const dest = join(hooksPre, file);
    if (existsSync(src)) {
      copyFileSync(src, dest);
      chmodSync(dest, 0o755);
      console.log(chalk.green(`  + .uap/omp/hooks/pre/${file}`));
    } else {
      console.log(chalk.yellow(`  - .uap/omp/hooks/pre/${file} (template not found)`));
    }
  }

  // Copy hook scripts to post/ directory
  const postHookFiles = [
    'post-tool-use-edit-write.sh',
    'post-compact.sh',
    'stop.sh',
    'session-end.sh',
  ];
  for (const file of postHookFiles) {
    const src = join(getTemplateHooksDir(), file);
    const dest = join(hooksPost, file);
    if (existsSync(src)) {
      copyFileSync(src, dest);
      chmodSync(dest, 0o755);
      console.log(chalk.green(`  + .uap/omp/hooks/post/${file}`));
    } else {
      console.log(chalk.yellow(`  - .uap/omp/hooks/post/${file} (template not found)`));
    }
  }

  // Create settings.json for omp integration
  const settingsPath = join(uapOmpDir, 'settings.json');
  const settings = {
    uapIntegration: {
      enabled: true,
      memoryInjection: true,
      patternRAG: true,
      worktreeIsolation: true,
      taskTracking: true,
      agentCoordination: true,
      policyEnforcement: true,
      hooks: {
        preSession: '.uap/omp/hooks/pre/session-start.sh',
        preToolUseEditWrite: '.uap/omp/hooks/pre/pre-tool-use-edit-write.sh',
        preToolUseBash: '.uap/omp/hooks/pre/pre-tool-use-bash.sh',
        preCompact: '.uap/omp/hooks/pre/pre-compact.sh',
        postToolUseEditWrite: '.uap/omp/hooks/post/post-tool-use-edit-write.sh',
        postCompact: '.uap/omp/hooks/post/post-compact.sh',
        stop: '.uap/omp/hooks/post/stop.sh',
        postSession: '.uap/omp/hooks/post/session-end.sh',
      },
      modelRouting: {
        planner: 'opus-4.6',
        executor: 'qwen35',
        fallback: 'qwen35',
        strategy: 'balanced',
      },
    },
  };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(chalk.green('  + .uap/omp/settings.json'));

  updateGitignore(cwd, ['.uap/']);

  console.log(chalk.bold.green('\n  Oh-My-Pi hooks installed successfully!'));
  console.log(
    chalk.dim('\nTo activate in oh-my-pi:') +
      '\n' +
      chalk.cyan('    Run: uap-omp install') +
      chalk.gray(' (links hooks and dashboard to omp)')
  );
}

// --- Dispatcher ---

async function installHooksForTarget(cwd: string, target: HooksTarget): Promise<void> {
  switch (target) {
    case 'claude':
      return installClaudeHooks(cwd);
    case 'factory':
      return installFactoryHooks(cwd);
    case 'cursor':
      return installCursorHooks(cwd);
    case 'vscode':
      return installVscodeHooks(cwd);
    case 'opencode':
      return installOpencodeHooks(cwd);
    case 'codex':
      return installCodexHooks(cwd);
    case 'forgecode':
      return installForgeCodeHooks(cwd);
    case 'omp':
      return installOmpHooks(cwd);
  }
}

// --- Status ---

interface HookFileInfo {
  name: string;
  event: string;
  desc: string;
}

const HOOK_FILES: HookFileInfo[] = [
  { name: 'session-start.sh', event: 'SessionStart', desc: 'Injects recent memory context' },
  { name: 'pre-compact.sh', event: 'PreCompact', desc: 'Flushes compaction marker to memory' },
  { name: 'pre-tool-use-edit-write.sh', event: 'PreToolUse', desc: 'Worktree file guard (BLOCKS non-worktree edits)' },
  { name: 'pre-tool-use-bash.sh', event: 'PreToolUse', desc: 'Dangerous command guard (BLOCKS terraform apply, force push, etc)' },
  { name: 'post-tool-use-edit-write.sh', event: 'PostToolUse', desc: 'Build gate + backup reminder after edits' },
  { name: 'post-compact.sh', event: 'PostCompact', desc: 'Re-injects policy awareness after compaction' },
  { name: 'stop.sh', event: 'Stop', desc: 'Completion gate checklist + session cleanup' },
  { name: 'session-end.sh', event: 'SessionEnd', desc: 'Agent deregistration + backup retention' },
];

function showScriptStatus(hooksDir: string): void {
  for (const hook of HOOK_FILES) {
    const path = join(hooksDir, hook.name);
    const exists = existsSync(path);
    const status = exists ? chalk.green('installed') : chalk.red('missing');
    console.log(`  ${status}  ${hook.name} (${hook.event})`);
    console.log(chalk.dim(`          ${hook.desc}`));
  }
}

function showSettingsStatus(settingsPath: string): void {
  console.log('');
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const hooks = settings.hooks || {};
      const configured = Object.keys(hooks).length;
      console.log(
        `  ${chalk.green('configured')}  ${settingsPath.split('/').pop()} (${configured} hook events)`
      );
    } catch {
      console.log(`  ${chalk.yellow('invalid')}  ${settingsPath.split('/').pop()} (parse error)`);
    }
  } else {
    console.log(`  ${chalk.red('missing')}  ${settingsPath.split('/').pop()}`);
  }
}

async function showClaudeStatus(cwd: string): Promise<void> {
  console.log(chalk.bold('\n  Claude Code Hooks Status\n'));
  showScriptStatus(join(cwd, '.claude', 'hooks'));
  showSettingsStatus(join(cwd, '.claude', 'settings.local.json'));
  console.log('');
}

async function showFactoryStatus(cwd: string): Promise<void> {
  console.log(chalk.bold('\n  Factory.AI Droid Hooks Status\n'));
  showScriptStatus(join(cwd, '.factory', 'hooks'));
  showSettingsStatus(join(cwd, '.factory', 'settings.local.json'));
  console.log('');
}

async function showCursorStatus(cwd: string): Promise<void> {
  console.log(chalk.bold('\n  Cursor Hooks Status\n'));
  showScriptStatus(join(cwd, '.cursor', 'hooks'));
  const hooksJsonPath = join(cwd, '.cursor', 'hooks.json');
  console.log('');
  if (existsSync(hooksJsonPath)) {
    try {
      const config = JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
      const hooks = config.hooks || {};
      const configured = Object.keys(hooks).length;
      console.log(`  ${chalk.green('configured')}  hooks.json (${configured} hook events)`);
    } catch {
      console.log(`  ${chalk.yellow('invalid')}  hooks.json (parse error)`);
    }
  } else {
    console.log(`  ${chalk.red('missing')}  hooks.json`);
  }
  console.log('');
}

async function showVscodeStatus(cwd: string): Promise<void> {
  console.log(chalk.bold('\n  VSCode Hooks Status (Claude Code format)\n'));
  showScriptStatus(join(cwd, '.claude', 'hooks'));
  showSettingsStatus(join(cwd, '.claude', 'settings.local.json'));
  console.log('');
}

async function showOpencodeStatus(cwd: string): Promise<void> {
  console.log(chalk.bold('\n  OpenCode Hooks Status\n'));
  const pluginPath = join(cwd, '.opencode', 'plugin', 'uap-session-hooks.ts');
  const exists = existsSync(pluginPath);
  const status = exists ? chalk.green('installed') : chalk.red('missing');
  console.log(`  ${status}  .opencode/plugin/uap-session-hooks.ts`);
  console.log(chalk.dim('          Session start + compaction hooks via plugin'));

  const pkgPath = join(cwd, '.opencode', 'package.json');
  const pkgExists = existsSync(pkgPath);
  const pkgStatus = pkgExists ? chalk.green('installed') : chalk.red('missing');
  console.log(`  ${pkgStatus}  .opencode/package.json`);
  console.log('');
}

async function showCodexStatus(cwd: string): Promise<void> {
  console.log(chalk.bold('\n  Codex CLI Hooks Status\n'));

  // Check hook scripts
  const hooksDir = join(cwd, '.codex', 'hooks');
  showScriptStatus(hooksDir);

  // Check AGENTS.md
  const agentsMdPath = join(cwd, 'AGENTS.md');
  const agentsMdExists = existsSync(agentsMdPath);
  if (agentsMdExists) {
    const content = readFileSync(agentsMdPath, 'utf-8');
    const hasUap = content.includes('Universal Agent Protocol');
    const status = hasUap ? chalk.green('configured') : chalk.yellow('present (no UAP section)');
    console.log(`  ${status}  AGENTS.md`);
  } else {
    console.log(`  ${chalk.red('missing')}  AGENTS.md`);
  }

  // Check config.toml
  const configTomlPath = join(cwd, '.codex', 'config.toml');
  if (existsSync(configTomlPath)) {
    const content = readFileSync(configTomlPath, 'utf-8');
    const hasMcp = content.includes('[mcp_servers.uap]');
    const status = hasMcp ? chalk.green('configured') : chalk.yellow('present (no UAP MCP)');
    console.log(`  ${status}  .codex/config.toml`);
  } else {
    console.log(`  ${chalk.red('missing')}  .codex/config.toml`);
  }

  // Check skills
  const skillsDir = join(cwd, '.agents', 'skills');
  const skillNames = ['uap-memory', 'uap-worktree', 'uap-patterns', 'uap-tasks', 'uap-coordination'];
  let skillCount = 0;
  for (const skill of skillNames) {
    if (existsSync(join(skillsDir, skill, 'SKILL.md'))) {
      skillCount++;
    }
  }
  const skillStatus = skillCount === skillNames.length
    ? chalk.green('installed')
    : skillCount > 0
      ? chalk.yellow(`partial (${skillCount}/${skillNames.length})`)
      : chalk.red('missing');
  console.log(`  ${skillStatus}  .agents/skills/ (${skillCount} UAP skills)`);
  console.log('');
}

async function showForgecodeStatus(cwd: string): Promise<void> {
  console.log(chalk.bold('\n  ForgeCode Hooks Status\n'));
  const hooksDir = join(cwd, '.forge', 'hooks');
  showScriptStatus(hooksDir);
  const pluginPath = join(cwd, '.forge', 'forgecode.plugin.sh');
  const pluginExists = existsSync(pluginPath);
  const pluginStatus = pluginExists ? chalk.green('installed') : chalk.red('missing');
  console.log(`  ${pluginStatus}  .forge/forgecode.plugin.sh`);
  console.log(chalk.dim('          ForgeCode integration plugin'));
  console.log('');
}

async function showOmpStatus(cwd: string): Promise<void> {
  console.log(chalk.bold('\n  Oh-My-Pi Hooks Status\n'));
  const uapOmpDir = join(cwd, '.uap', 'omp');
  const hooksPre = join(uapOmpDir, 'hooks', 'pre');
  const hooksPost = join(uapOmpDir, 'hooks', 'post');
  const settingsPath = join(uapOmpDir, 'settings.json');

  showScriptStatus(hooksPre);
  const postHook = join(hooksPost, 'session-end.sh');
  const postExists = existsSync(postHook);
  const postStatus = postExists ? chalk.green('installed') : chalk.red('missing');
  console.log(`  ${postStatus}  session-end.sh (post-session)`);

  const settingsExists = existsSync(settingsPath);
  const settingsStatus = settingsExists ? chalk.green('configured') : chalk.red('missing');
  console.log(`  ${settingsStatus}  settings.json`);
  console.log('');
}

async function showHooksStatusForTarget(cwd: string, target: HooksTarget): Promise<void> {
  switch (target) {
    case 'claude':
      return showClaudeStatus(cwd);
    case 'factory':
      return showFactoryStatus(cwd);
    case 'cursor':
      return showCursorStatus(cwd);
    case 'vscode':
      return showVscodeStatus(cwd);
    case 'opencode':
      return showOpencodeStatus(cwd);
    case 'codex':
      return showCodexStatus(cwd);
    case 'forgecode':
      return showForgecodeStatus(cwd);
    case 'omp':
      return showOmpStatus(cwd);
  }
}

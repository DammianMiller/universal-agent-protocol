import chalk from 'chalk';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type HooksTarget = 'claude' | 'factory' | 'cursor' | 'vscode' | 'opencode';
type HooksAction = 'install' | 'status';

interface HooksOptions {
  projectDir?: string;
  target?: HooksTarget;
}

const ALL_TARGETS: HooksTarget[] = ['claude', 'factory', 'cursor', 'vscode', 'opencode'];

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

  const hookFiles = ['session-start.sh', 'pre-compact.sh'];
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
  console.log(chalk.bold('\n  Installing UAM Hooks for Claude Code\n'));
  if (!ensureTemplateHooksExist()) return;

  const claudeDir = join(cwd, '.claude');
  const claudeHooksDir = join(claudeDir, 'hooks');
  copyHookScripts(claudeHooksDir);

  const settingsPath = join(claudeDir, 'settings.local.json');
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')); } catch { /* start fresh */ }
  }

  const hooksConfig = {
    SessionStart: {
      hooks: [{ type: 'command', command: 'bash .claude/hooks/session-start.sh' }],
    },
    PreCompact: {
      hooks: [{ type: 'command', command: 'bash .claude/hooks/pre-compact.sh' }],
    },
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
  console.log(chalk.bold('\n  Installing UAM Hooks for Factory.AI Droid\n'));
  if (!ensureTemplateHooksExist()) return;

  const factoryDir = join(cwd, '.factory');
  const factoryHooksDir = join(factoryDir, 'hooks');
  copyHookScripts(factoryHooksDir);

  const settingsPath = join(factoryDir, 'settings.local.json');
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')); } catch { /* start fresh */ }
  }

  const hooksConfig = {
    SessionStart: {
      hooks: [{ type: 'command', command: '"$FACTORY_PROJECT_DIR"/.factory/hooks/session-start.sh' }],
    },
    PreCompact: {
      hooks: [{ type: 'command', command: '"$FACTORY_PROJECT_DIR"/.factory/hooks/pre-compact.sh' }],
    },
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
  console.log(chalk.bold('\n  Installing UAM Hooks for Cursor\n'));
  if (!ensureTemplateHooksExist()) return;

  const cursorDir = join(cwd, '.cursor');
  const cursorHooksDir = join(cursorDir, 'hooks');
  copyHookScripts(cursorHooksDir);

  const hooksJsonPath = join(cursorDir, 'hooks.json');
  let config: Record<string, unknown> = { version: 1, hooks: {} };
  if (existsSync(hooksJsonPath)) {
    try { config = JSON.parse(readFileSync(hooksJsonPath, 'utf-8')); } catch { /* start fresh */ }
  }

  const existingHooks = (config.hooks || {}) as Record<string, unknown>;
  config.hooks = {
    ...existingHooks,
    sessionStart: [
      { command: '.cursor/hooks/session-start.sh' },
    ],
    preCompact: [
      { command: '.cursor/hooks/pre-compact.sh' },
    ],
  };
  config.version = 1;

  writeFileSync(hooksJsonPath, JSON.stringify(config, null, 2) + '\n');
  console.log(chalk.green('  + hooks.json (hooks configured)'));

  console.log(chalk.bold.green('\n  Cursor hooks installed successfully!'));
  console.log(chalk.dim('  Restart Cursor to activate.\n'));
}

// --- VSCode (uses Claude Code hooks via third-party skills) ---

async function installVscodeHooks(cwd: string): Promise<void> {
  console.log(chalk.bold('\n  Installing UAM Hooks for VSCode (via Claude Code format)\n'));
  if (!ensureTemplateHooksExist()) return;

  const claudeDir = join(cwd, '.claude');
  const claudeHooksDir = join(claudeDir, 'hooks');
  copyHookScripts(claudeHooksDir);

  const settingsPath = join(claudeDir, 'settings.local.json');
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')); } catch { /* start fresh */ }
  }

  const hooksConfig = {
    SessionStart: {
      hooks: [{ type: 'command', command: 'bash .claude/hooks/session-start.sh' }],
    },
    PreCompact: {
      hooks: [{ type: 'command', command: 'bash .claude/hooks/pre-compact.sh' }],
    },
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
  console.log(chalk.bold('\n  Installing UAM Hooks for OpenCode\n'));

  const pluginDir = join(cwd, '.opencode', 'plugin');
  if (!existsSync(pluginDir)) {
    mkdirSync(pluginDir, { recursive: true });
    console.log(chalk.dim(`  Created ${pluginDir}`));
  }

  const dbPath = './agents/data/memory/short_term.db';
  const coordDbPath = './agents/data/coordination/coordination.db';

  const pluginContent = `import type { Plugin } from "@opencode-ai/plugin"

export const UAMSessionHooks: Plugin = async ({ client, $ }) => {
  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        try {
          const result = await $\`bash -c '
            DB_PATH="${dbPath}"
            COORD_DB="${coordDbPath}"

            if [ ! -f "$DB_PATH" ]; then exit 0; fi

            if [ -f "$COORD_DB" ]; then
              sqlite3 "$COORD_DB" "
                DELETE FROM work_claims WHERE agent_id IN (
                  SELECT id FROM agent_registry
                  WHERE status IN (\\'active\\',\\'idle\\') AND last_heartbeat < datetime(\\'now\\',\\'-24 hours\\')
                );
                UPDATE agent_registry SET status=\\'failed\\'
                  WHERE status IN (\\'active\\',\\'idle\\') AND last_heartbeat < datetime(\\'now\\',\\'-24 hours\\');
              " 2>/dev/null || true
            fi

            sqlite3 "$DB_PATH" "
              SELECT type, content FROM memories
              WHERE timestamp >= datetime(\\'now\\', \\'-1 day\\')
              ORDER BY id DESC LIMIT 10;
            " 2>/dev/null || true
          '\`.quiet()
          if (result.stdout.toString().trim()) {
            console.log("[UAM] Session context loaded")
          }
        } catch { /* fail safely */ }
      }
    },

    "experimental.session.compacting": async (_input, output) => {
      try {
        const timestamp = new Date().toISOString()
        await $\`sqlite3 ${dbPath} "INSERT OR IGNORE INTO memories (timestamp, type, content) VALUES ('$\{timestamp}', 'action', '[pre-compact] Context compaction at $\{timestamp}');"\`.quiet()
        output.context.push("<uam-context>Pre-compact marker saved to UAM memory.</uam-context>")
      } catch { /* fail safely */ }
    },
  }
}
`;

  const pluginPath = join(pluginDir, 'uam-session-hooks.ts');
  writeFileSync(pluginPath, pluginContent);
  console.log(chalk.green('  + .opencode/plugin/uam-session-hooks.ts'));

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

// --- Dispatcher ---

async function installHooksForTarget(cwd: string, target: HooksTarget): Promise<void> {
  switch (target) {
    case 'claude': return installClaudeHooks(cwd);
    case 'factory': return installFactoryHooks(cwd);
    case 'cursor': return installCursorHooks(cwd);
    case 'vscode': return installVscodeHooks(cwd);
    case 'opencode': return installOpencodeHooks(cwd);
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
      console.log(`  ${chalk.green('configured')}  ${settingsPath.split('/').pop()} (${configured} hook events)`);
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
  const pluginPath = join(cwd, '.opencode', 'plugin', 'uam-session-hooks.ts');
  const exists = existsSync(pluginPath);
  const status = exists ? chalk.green('installed') : chalk.red('missing');
  console.log(`  ${status}  .opencode/plugin/uam-session-hooks.ts`);
  console.log(chalk.dim('          Session start + compaction hooks via plugin'));

  const pkgPath = join(cwd, '.opencode', 'package.json');
  const pkgExists = existsSync(pkgPath);
  const pkgStatus = pkgExists ? chalk.green('installed') : chalk.red('missing');
  console.log(`  ${pkgStatus}  .opencode/package.json`);
  console.log('');
}

async function showHooksStatusForTarget(cwd: string, target: HooksTarget): Promise<void> {
  switch (target) {
    case 'claude': return showClaudeStatus(cwd);
    case 'factory': return showFactoryStatus(cwd);
    case 'cursor': return showCursorStatus(cwd);
    case 'vscode': return showVscodeStatus(cwd);
    case 'opencode': return showOpencodeStatus(cwd);
  }
}

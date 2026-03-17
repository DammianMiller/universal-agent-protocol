#!/usr/bin/env node

/**
 * UAP Tool Call Setup - Model-Agnostic Tool Call Management
 *
 * Manages chat templates, wrapper scripts, proxy configuration, and testing
 * for reliable tool calling across any OpenAI-compatible model.
 *
 * Supports model profiles (e.g. qwen35, llama, generic) for model-specific
 * tuning while keeping the core infrastructure generic.
 */

import { execSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  copyFileSync,
  readdirSync,
} from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import inquirer from 'inquirer';

// Get script directory for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Calculate paths relative to this CLI script location
// When built: dist/cli/tool-calls.js -> dist/cli -> dist -> project root
const CLIDir = join(__dirname, '..');
const UAP_ROOT = join(CLIDir, '..');
const AGENTS_DIR = join(UAP_ROOT, 'tools', 'agents');
const CONFIG_DIR = join(AGENTS_DIR, 'config');
const SCRIPTS_DIR = join(AGENTS_DIR, 'scripts');
const PROFILES_DIR = join(UAP_ROOT, 'config', 'model-profiles');

// Template source is the canonical copy at project root
const ROOT_TEMPLATE = join(UAP_ROOT, 'chat_template.jinja');
const CONFIG_TEMPLATE = join(CONFIG_DIR, 'chat_template.jinja');

/**
 * Detect the active model profile from config or environment.
 * Falls back to 'generic' if no profile is specified.
 */
function detectModelProfile(): string {
  // 1. Explicit env var
  if (process.env.UAP_MODEL_PROFILE) {
    return process.env.UAP_MODEL_PROFILE;
  }

  // 2. Check .uap.json for model profile
  const uapConfigPath = join(UAP_ROOT, '.uap.json');
  if (existsSync(uapConfigPath)) {
    try {
      const config = JSON.parse(readFileSync(uapConfigPath, 'utf-8'));
      if (config?.toolCalls?.modelProfile) {
        return config.toolCalls.modelProfile;
      }
    } catch {
      // ignore parse errors
    }
  }

  // 3. Check if a model-specific settings file exists
  const settingsPath = join(UAP_ROOT, 'config', 'qwen35-settings.json');
  if (existsSync(settingsPath)) {
    return 'qwen35';
  }

  return 'generic';
}

/**
 * Load model profile settings from config/model-profiles/<profile>.json
 * or fall back to legacy config/<profile>-settings.json.
 */
function loadModelProfile(profile: string): Record<string, unknown> | null {
  // Try new location first
  const profilePath = join(PROFILES_DIR, `${profile}.json`);
  if (existsSync(profilePath)) {
    return JSON.parse(readFileSync(profilePath, 'utf-8'));
  }

  // Fall back to legacy location
  const legacyPath = join(UAP_ROOT, 'config', `${profile}-settings.json`);
  if (existsSync(legacyPath)) {
    return JSON.parse(readFileSync(legacyPath, 'utf-8'));
  }

  return null;
}

/**
 * Profile metadata for the interactive selection menu.
 * Each profile includes a short description and key highlights.
 */
interface ProfileInfo {
  name: string;
  description: string;
  highlights: string[];
}

/**
 * Discover all available model profiles from config/model-profiles/.
 * Returns structured info including descriptions parsed from the JSON files.
 */
function discoverProfiles(): ProfileInfo[] {
  const profiles: ProfileInfo[] = [];

  if (existsSync(PROFILES_DIR)) {
    for (const f of readdirSync(PROFILES_DIR).sort()) {
      if (!f.endsWith('.json')) continue;
      const name = f.replace('.json', '');
      try {
        const data = JSON.parse(readFileSync(join(PROFILES_DIR, f), 'utf-8'));
        const desc = (data._description as string) || '';
        const highlights: string[] = [];
        if (data.context_window)
          highlights.push(`ctx: ${Number(data.context_window).toLocaleString()}`);
        if (data.temperature) highlights.push(`temp: ${data.temperature}`);
        if (data.server_optimization?.flash_attention) highlights.push('flash-attn');
        if (data.server_optimization?.speculative_decoding?.enabled) highlights.push('spec-decode');
        profiles.push({ name, description: desc, highlights });
      } catch {
        profiles.push({ name, description: '', highlights: [] });
      }
    }
  }

  return profiles;
}

/**
 * Save the selected model profile to .uap.json so it persists across sessions.
 */
function saveProfileToConfig(profileName: string): void {
  const uapConfigPath = join(UAP_ROOT, '.uap.json');
  let config: Record<string, unknown> = {};

  if (existsSync(uapConfigPath)) {
    try {
      config = JSON.parse(readFileSync(uapConfigPath, 'utf-8'));
    } catch {
      // start fresh if corrupt
    }
  }

  // Merge toolCalls.modelProfile into existing config
  const toolCalls = (config.toolCalls as Record<string, unknown>) || {};
  toolCalls.modelProfile = profileName;
  config.toolCalls = toolCalls;

  writeFileSync(uapConfigPath, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Interactive profile selection menu using inquirer.
 * Shows all available profiles with descriptions and lets the user pick one.
 */
async function promptProfileSelection(currentProfile: string): Promise<string> {
  const profiles = discoverProfiles();

  if (profiles.length === 0) {
    console.log(chalk.yellow('No model profiles found in config/model-profiles/'));
    return currentProfile;
  }

  console.log(chalk.bold('\n  Available Model Profiles:\n'));

  // Build choices with descriptions
  const choices = profiles.map((p) => {
    const active = p.name === currentProfile ? chalk.green(' (active)') : '';
    const hints = p.highlights.length > 0 ? chalk.dim(` [${p.highlights.join(', ')}]`) : '';
    return {
      name: `${chalk.bold(p.name)}${active}${hints}\n    ${chalk.dim(p.description.slice(0, 120))}`,
      value: p.name,
      short: p.name,
    };
  });

  const { selectedProfile } = await inquirer.prompt<{ selectedProfile: string }>([
    {
      type: 'list',
      name: 'selectedProfile',
      message: 'Select a model profile',
      choices,
      default: currentProfile,
      pageSize: 15,
    },
  ]);

  return selectedProfile;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    console.log(chalk.green(`Created directory: ${dir}`));
  }
}

function detectPython(): string | null {
  for (const cmd of ['python3', 'python']) {
    try {
      execSync(`${cmd} --version`, { stdio: 'pipe' });
      return cmd;
    } catch {
      // try next
    }
  }
  return null;
}

async function setup(): Promise<void> {
  let profile = detectModelProfile();

  // Interactive profile selection
  const isInteractive = process.stdout.isTTY;
  if (isInteractive) {
    console.log(chalk.cyan('\n  UAP Tool Call Setup\n'));
    profile = await promptProfileSelection(profile);

    // Persist the selection
    saveProfileToConfig(profile);
    console.log(chalk.green(`\n  Profile "${profile}" saved to .uap.json\n`));

    // Show profile details
    const profileData = loadModelProfile(profile);
    if (profileData) {
      console.log(chalk.bold('  Profile Details:'));
      if (profileData.model) console.log(`    Model:          ${profileData.model}`);
      if (profileData.temperature) console.log(`    Temperature:    ${profileData.temperature}`);
      if (profileData.context_window)
        console.log(`    Context window: ${Number(profileData.context_window).toLocaleString()}`);
      if (profileData.max_tokens)
        console.log(`    Max tokens:     ${Number(profileData.max_tokens).toLocaleString()}`);
      const serverOpt = profileData.server_optimization as Record<string, unknown> | undefined;
      if (serverOpt?.flash_attention) console.log(`    Flash attn:     enabled`);
      const specDecode = serverOpt?.speculative_decoding as Record<string, unknown> | undefined;
      if (specDecode?.enabled) console.log(`    Spec decode:    enabled`);
      console.log('');
    }
  } else {
    console.log(chalk.cyan(`\nSetting up Tool Call infrastructure (profile: ${profile})...\n`));
  }

  // Ensure directories exist
  ensureDir(CONFIG_DIR);
  ensureDir(SCRIPTS_DIR);

  // Sync templates: root template is the canonical source
  // Copy root -> config dir if root exists and config is missing or older
  if (existsSync(ROOT_TEMPLATE)) {
    const rootStat = statSync(ROOT_TEMPLATE);
    const shouldCopy =
      !existsSync(CONFIG_TEMPLATE) || statSync(CONFIG_TEMPLATE).mtimeMs < rootStat.mtimeMs;

    if (shouldCopy) {
      copyFileSync(ROOT_TEMPLATE, CONFIG_TEMPLATE);
      console.log(chalk.green(`Synced chat template: root -> ${CONFIG_TEMPLATE}`));
    } else {
      console.log(chalk.green(`Chat template up to date: ${CONFIG_TEMPLATE}`));
    }
  } else if (!existsSync(CONFIG_TEMPLATE)) {
    console.log(chalk.yellow('Warning: No chat template found at project root or config dir'));
  }

  // Verify Python scripts exist (they live in source, not copied)
  const pythonScripts = ['chat_template_verifier.py', 'tool_call_wrapper.py', 'tool_call_test.py'];

  // Also check for legacy names
  const legacyScripts = [
    'fix_qwen_chat_template.py',
    'qwen_tool_call_wrapper.py',
    'qwen_tool_call_test.py',
  ];

  let missingScripts = false;
  for (let i = 0; i < pythonScripts.length; i++) {
    const scriptPath = join(SCRIPTS_DIR, pythonScripts[i]);
    const legacyPath = join(SCRIPTS_DIR, legacyScripts[i]);
    if (existsSync(scriptPath)) {
      console.log(chalk.green(`Found script: ${pythonScripts[i]}`));
    } else if (existsSync(legacyPath)) {
      console.log(chalk.green(`Found script: ${legacyScripts[i]} (legacy name)`));
    } else {
      console.log(chalk.yellow(`Missing script: ${pythonScripts[i]}`));
      missingScripts = true;
    }
  }

  if (missingScripts) {
    console.log(chalk.yellow('\nSome Python scripts are missing from tools/agents/scripts/'));
  }

  // Make scripts executable
  try {
    execSync(`chmod +x ${SCRIPTS_DIR}/*.py`, { stdio: 'ignore' });
    console.log(chalk.green('Made Python scripts executable'));
  } catch {
    // Non-critical on Windows
  }

  // Check Python availability
  const python = detectPython();
  if (python) {
    console.log(chalk.green(`Python available: ${python}`));
  } else {
    console.log(chalk.yellow('Warning: Python 3 not found - test/fix commands require Python'));
  }

  // Validate template with Jinja2 if Python available
  if (python && existsSync(CONFIG_TEMPLATE)) {
    try {
      const validateCmd = `${python} -c "
from jinja2 import Environment
env = Environment()
with open('${CONFIG_TEMPLATE}') as f:
    env.parse(f.read())
print('OK')
"`;
      const result = execSync(validateCmd, { stdio: 'pipe', encoding: 'utf-8' });
      if (result.trim() === 'OK') {
        console.log(chalk.green('Template Jinja2 syntax: valid'));
      }
    } catch {
      console.log(
        chalk.yellow('Template Jinja2 validation: could not verify (jinja2 may not be installed)')
      );
    }
  }

  // Print summary
  console.log('\n' + chalk.cyan('=').repeat(70));
  console.log(chalk.bold(`Tool Call Setup Complete (profile: ${profile})`));
  console.log(chalk.cyan('=').repeat(70) + '\n');

  console.log(chalk.bold('Next Steps:'));
  console.log('  1. Test the setup: uap-tool-calls test');
  console.log('  2. Check status:   uap-tool-calls status');
  console.log('  3. Apply fixes:    uap-tool-calls fix');
  console.log('  4. Start proxy:    uap-tool-calls proxy\n');

  console.log(chalk.bold('Environment Variables:'));
  console.log('  UAP_MODEL_PROFILE   Model profile name (default: auto-detect)');
  console.log('  TARGET_URL          Inference server URL (default: http://127.0.0.1:8080)');
  console.log('  PROXY_PORT          Proxy listen port (default: 11435)');
  console.log('  FORCE_TOOL_CHOICE   tool_choice value (default: required)\n');
}

function findTestScript(): { script: string; python: string } {
  let testScript = join(SCRIPTS_DIR, 'tool_call_test.py');
  if (!existsSync(testScript)) {
    testScript = join(SCRIPTS_DIR, 'qwen_tool_call_test.py');
  }

  if (!existsSync(testScript)) {
    console.error(chalk.red(`Test script not found: ${testScript}`));
    console.log(chalk.yellow('Run: uap-tool-calls setup\n'));
    process.exit(1);
  }

  const python = detectPython();
  if (!python) {
    console.error(chalk.red('Python 3 not found in PATH'));
    process.exit(1);
  }

  return { script: testScript, python };
}

async function test(): Promise<void> {
  const profile = detectModelProfile();
  console.log(chalk.cyan(`\nRunning Tool Call Tests (profile: ${profile})...\n`));

  const { script: testScript, python } = findTestScript();

  console.log(chalk.dim(`  Script: ${testScript}`));
  console.log(chalk.dim(`  Python: ${python}`));
  console.log(chalk.dim(`  CWD:    ${SCRIPTS_DIR}\n`));

  try {
    execSync(`${python} "${testScript}" --verbose`, {
      cwd: SCRIPTS_DIR,
      stdio: 'inherit',
      env: { ...process.env, UAP_MODEL_PROFILE: profile, PYTHONPATH: SCRIPTS_DIR },
    });
  } catch {
    console.log(chalk.yellow('\nTest completed with some failures'));
    console.log('Review the output above for details.\n');
  }
}

async function check(): Promise<void> {
  const profile = detectModelProfile();
  console.log(chalk.cyan(`\nValidating Tool Call Setup (profile: ${profile})...\n`));

  const { script: testScript, python } = findTestScript();

  try {
    execSync(`${python} "${testScript}" --check`, {
      cwd: SCRIPTS_DIR,
      stdio: 'inherit',
      env: { ...process.env, UAP_MODEL_PROFILE: profile, PYTHONPATH: SCRIPTS_DIR },
    });
  } catch {
    console.log(chalk.yellow('\nSetup check completed with issues.\n'));
  }
}

async function status(): Promise<void> {
  const profile = detectModelProfile();
  console.log(chalk.cyan('\n' + '='.repeat(70)));
  console.log(chalk.bold(`Tool Call Configuration Status (profile: ${profile})`));
  console.log(chalk.cyan('='.repeat(70) + '\n'));

  // Check templates
  for (const [label, path] of [
    ['Config template', CONFIG_TEMPLATE],
    ['Root template', ROOT_TEMPLATE],
  ] as const) {
    if (existsSync(path)) {
      const stat = statSync(path);
      console.log(chalk.green(`[OK] ${label}: ${path}`));
      console.log(`     Modified: ${stat.mtime.toISOString()}`);
      console.log(`     Size: ${stat.size} bytes`);
    } else {
      console.log(chalk.yellow(`[MISSING] ${label}: ${path}`));
    }
  }

  // Check Python scripts (new names + legacy names)
  const scriptPairs = [
    ['chat_template_verifier.py', 'fix_qwen_chat_template.py'],
    ['tool_call_wrapper.py', 'qwen_tool_call_wrapper.py'],
    ['tool_call_test.py', 'qwen_tool_call_test.py'],
  ];

  console.log(chalk.bold('\nPython Scripts:'));
  for (const [newName, legacyName] of scriptPairs) {
    const newPath = join(SCRIPTS_DIR, newName);
    const legacyPath = join(SCRIPTS_DIR, legacyName);
    if (existsSync(newPath)) {
      const stat = statSync(newPath);
      console.log(chalk.green(`  [OK] ${newName} (${stat.size} bytes)`));
    } else if (existsSync(legacyPath)) {
      const stat = statSync(legacyPath);
      console.log(chalk.green(`  [OK] ${legacyName} (${stat.size} bytes, legacy name)`));
    } else {
      console.log(chalk.yellow(`  [MISSING] ${newName}`));
    }
  }

  // Check proxy script (.cjs for CommonJS compatibility)
  const proxyScript = join(SCRIPTS_DIR, 'tool-choice-proxy.cjs');
  const legacyProxy = join(SCRIPTS_DIR, 'tool-choice-proxy.js');
  if (existsSync(proxyScript)) {
    const stat = statSync(proxyScript);
    console.log(chalk.green(`  [OK] tool-choice-proxy.cjs (${stat.size} bytes)`));
  } else if (existsSync(legacyProxy)) {
    const stat = statSync(legacyProxy);
    console.log(chalk.green(`  [OK] tool-choice-proxy.js (${stat.size} bytes, legacy name)`));
  } else {
    console.log(chalk.yellow(`  [MISSING] tool-choice-proxy.cjs`));
  }

  // Check for Python
  const python = detectPython();
  if (python) {
    const version = execSync(`${python} --version`, { stdio: 'pipe', encoding: 'utf-8' }).trim();
    console.log(chalk.green(`\n[OK] ${version}`));
  } else {
    console.log(chalk.yellow('\n[MISSING] Python 3 not found in PATH'));
  }

  // Check model profile settings
  const settings = loadModelProfile(profile);
  if (settings) {
    console.log(chalk.green(`\n[OK] Model profile: ${profile}`));
    if (settings.model) console.log(`     Model: ${settings.model}`);
    if (settings.max_tokens) console.log(`     Max tokens: ${settings.max_tokens}`);
    if (settings.temperature) console.log(`     Temperature: ${settings.temperature}`);
    if (settings.context_window) console.log(`     Context window: ${settings.context_window}`);
  } else {
    console.log(chalk.yellow(`\n[INFO] No model profile found for: ${profile}`));
    console.log(
      `     Using generic defaults. Create config/model-profiles/${profile}.json to customize.`
    );
  }

  // List available profiles
  console.log(chalk.bold('\nAvailable Model Profiles:'));
  const profileSources: string[] = [];

  // Check new location
  if (existsSync(PROFILES_DIR)) {
    for (const f of readdirSync(PROFILES_DIR)) {
      if (f.endsWith('.json')) {
        profileSources.push(f.replace('.json', ''));
      }
    }
  }

  // Check legacy location
  const configDir = join(UAP_ROOT, 'config');
  if (existsSync(configDir)) {
    for (const f of readdirSync(configDir)) {
      const match = f.match(/^(.+)-settings\.json$/);
      if (match && !profileSources.includes(match[1])) {
        profileSources.push(`${match[1]} (legacy)`);
      }
    }
  }

  if (profileSources.length > 0) {
    for (const p of profileSources) {
      const marker = p.replace(' (legacy)', '') === profile ? ' <-- active' : '';
      console.log(`  - ${p}${marker}`);
    }
  } else {
    console.log('  (none found)');
  }

  console.log('\n' + '='.repeat(70));
}

async function fix(): Promise<void> {
  console.log(chalk.cyan('\nApplying Template Fixes...\n'));

  // Try new name first, fall back to legacy
  let fixScript = join(SCRIPTS_DIR, 'chat_template_verifier.py');
  if (!existsSync(fixScript)) {
    fixScript = join(SCRIPTS_DIR, 'fix_qwen_chat_template.py');
  }

  if (!existsSync(fixScript)) {
    console.error(chalk.red(`Template verifier script not found: ${fixScript}`));
    console.log(chalk.yellow('Run: uap-tool-calls setup\n'));
    process.exit(1);
  }

  const python = detectPython();
  if (!python) {
    console.error(chalk.red('Python 3 not found in PATH'));
    process.exit(1);
  }

  try {
    execSync(`${python} "${fixScript}"`, {
      cwd: SCRIPTS_DIR,
      stdio: 'inherit',
    });
  } catch {
    console.log(chalk.yellow('\nFix script completed\n'));
  }
}

async function proxy(): Promise<void> {
  console.log(chalk.cyan('\nStarting tool_choice proxy...\n'));

  // Try .cjs first (correct for "type": "module" packages), fall back to .js
  let proxyScript = join(SCRIPTS_DIR, 'tool-choice-proxy.cjs');
  if (!existsSync(proxyScript)) {
    proxyScript = join(SCRIPTS_DIR, 'tool-choice-proxy.js');
  }
  if (!existsSync(proxyScript)) {
    console.error(chalk.red(`Proxy script not found: ${proxyScript}`));
    process.exit(1);
  }

  try {
    execSync(`node "${proxyScript}"`, {
      stdio: 'inherit',
      env: process.env,
    });
  } catch {
    // proxy was killed or errored
  }
}

// Dispatch command from argv
function dispatch(args: string[]): void {
  const command = args[0];

  switch (command) {
    case 'setup':
      setup();
      break;
    case 'test':
      test();
      break;
    case 'check':
      check();
      break;
    case 'status':
      status();
      break;
    case 'fix':
      fix();
      break;
    case 'proxy':
      proxy();
      break;
    case undefined:
    case 'help':
    default:
      printHelp();
  }
}

function printHelp(): void {
  console.log(`
${chalk.cyan('UAP Tool Call Setup - Model-Agnostic Tool Call Management')}

Usage:
  ${chalk.bold('uap-tool-calls <command>')}

Commands:
  ${chalk.bold('setup')}    Install chat templates and validate Python scripts
  ${chalk.bold('test')}     Run tool call reliability test suite (requires running server)
  ${chalk.bold('check')}    Validate setup without running tests (no server needed)
  ${chalk.bold('status')}   Check current configuration and model profile
  ${chalk.bold('fix')}      Apply template fixes to existing templates
  ${chalk.bold('proxy')}    Start the tool_choice HTTP proxy
  ${chalk.bold('help')}     Show this help message

Model Profiles:
  Set UAP_MODEL_PROFILE env var or configure in .uap.json:
    { "toolCalls": { "modelProfile": "qwen35" } }

  Available profiles are stored in config/model-profiles/<name>.json

Environment Variables:
  UAP_MODEL_PROFILE     Model profile (default: auto-detect)
  TARGET_URL            Inference server URL (default: http://127.0.0.1:8080)
  PROXY_PORT            Proxy listen port (default: 11435)
  FORCE_TOOL_CHOICE     tool_choice value (default: required)
  MAX_TOOL_TEMPERATURE  Temperature cap when tools present (default: 0.4)

Examples:
  ${chalk.gray('uap-tool-calls setup')}
  ${chalk.gray('uap-tool-calls test')}
  ${chalk.gray('uap-tool-calls status')}
  ${chalk.gray('UAP_MODEL_PROFILE=qwen35 uap-tool-calls test')}
  ${chalk.gray('TARGET_URL=http://localhost:11434 uap-tool-calls proxy')}
`);
}

/**
 * Entry point for tool-calls commands.
 *
 * When called with a command string (from cli.ts Commander actions),
 * dispatches that command directly.
 * When called without arguments (from bin/tool-calls.ts),
 * parses process.argv for the command.
 */
export async function toolCallsCommand(command?: string): Promise<void> {
  if (command) {
    dispatch([command]);
  } else {
    // argv[0] = node, argv[1] = script path, argv[2+] = commands
    const args = process.argv.slice(2);
    dispatch(args);
  }
}

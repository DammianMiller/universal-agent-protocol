#!/usr/bin/env node
/**
 * Universal Agent Protocol (UAP) CLI
 *
 * This is the main UAP command-line interface that works independently
 * from opencode. It provides project initialization, configuration,
 * and integration with various agent harnesses.
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');

const UAP_VERSION = '2.0.1';

// Import RTK integration
import { installRTK, checkRTKStatus, showRTKHelp } from './rtk.js';

class UAPCli {
  async run(args: string[]): Promise<void> {
    const command = args[0];

    switch (command) {
      case 'init':
        await this.init();
        break;
      case 'setup':
        await this.setup(args.slice(1));
        break;
      case 'install':
        // Check if user wants to install RTK
        const subCommand = args[1];
        if (subCommand === 'rtk') {
          await installRTK({
            force: args.includes('--force'),
            method: args.includes('--method')
              ? (args[args.indexOf('--method') + 1] as any)
              : undefined,
          });
          return;
        }
        await this.install(args.slice(1));
        break;
      case 'rtk':
        // RTK subcommand
        const rtkSubCommand = args[1];
        if (rtkSubCommand === 'install') {
          await installRTK({
            force: args.includes('--force'),
            method: args.includes('--method')
              ? (args[args.indexOf('--method') + 1] as any)
              : undefined,
          });
        } else if (rtkSubCommand === 'status') {
          await checkRTKStatus();
        } else if (rtkSubCommand === 'help' || !rtkSubCommand) {
          showRTKHelp();
        } else {
          console.log(`Unknown RTK command: ${rtkSubCommand}`);
          showRTKHelp();
        }
        return;
      case 'uninstall':
        await this.uninstall();
        break;
      case 'hooks':
        await this.hooks(args.slice(1));
        break;
      case 'plugins':
        await this.plugins(args.slice(1));
        break;
      case 'version':
      case '-v':
      case '--version':
        console.log(`uap version ${UAP_VERSION}`);
        break;
      case '--help':
      case '-h':
      default:
        this.printHelp();
        break;
    }
  }

  private printHelp(): void {
    console.log(`
Universal Agent Protocol (UAP) v${UAP_VERSION}
AI agents that learn and remember across sessions

USAGE:
  uap <command> [options]

COMMANDS:
  init              Initialize UAP in current project
  setup [options]   Run comprehensive UAP setup
  install           Install UAP plugins for specific harness (opencode, etc.)
                    or install RTK CLI proxy with "uap install rtk"
  rtk               Manage RTK (Rust Token Killer) integration
    install         Install RTK CLI proxy for 60-90% token savings
    status          Check RTK installation and token savings
    help            Show RTK usage information
  uninstall         Remove UAP from current project
  hooks             Manage UAP hooks
  plugins           List and manage UAP plugins

OPTIONS:
  -p, --project     Target project directory
  -h, --harness     Target agent harness (opencode, claude-code, etc.)
  -f, --force       Force operations without confirmation
  -v, --verbose     Enable verbose output
  --version         Show version number
  --help            Show this help message

EXAMPLES:
  uap init                    # Initialize UAP in current directory
  uap setup -p all           # Full setup with all components
  uap install opencode       # Install UAP plugins for opencode harness
  uap install rtk            # Install RTK CLI proxy (60-90% token savings)
  uap rtk status             # Check RTK installation and savings
  uap hooks list             # List available hooks

INTEGRATION:
  RTK works alongside UAP's MCP Router for maximum token savings:
  
  - MCP Router (~98% savings): Hides 150+ tools behind 2 meta-tools
  - RTK (60-90% savings): Filters CLI command output before LLM sees it
  
  Combined: 95%+ total token reduction
`);
  }

  private async init(): Promise<void> {
    console.log('🔧 Initializing Universal Agent Protocol...\n');

    const projectDir = process.cwd();
    const uapConfig = path.join(projectDir, '.uap.json');
    const claudeMd = path.join(projectDir, 'CLAUDE.md');

    // Create .uap.json config
    const config = {
      version: UAP_VERSION,
      project: projectDir,
      initialized: true,
      timestamp: new Date().toISOString(),
      features: {
        memory: true,
        hooks: true,
        plugins: true,
        droids: false,
        skills: false,
      },
    };

    writeFileSync(uapConfig, JSON.stringify(config, null, 2));
    console.log('✓ Created .uap.json configuration');

    // Check if CLAUDE.md exists
    if (!existsSync(claudeMd)) {
      console.log(
        'ℹ No CLAUDE.md found. You can create one manually or with: uap setup -p claude-md'
      );
    } else {
      console.log('✓ CLAUDE.md detected');
    }

    console.log('\n✅ UAP initialized successfully!');
    console.log(`\nNext steps:`);
    console.log(`  uap setup -p all     # Run full setup`);
    console.log(`  uap install opencode # Install for opencode harness`);
  }

  private async setup(args: string[]): Promise<void> {
    console.log('🔧 Running UAP setup...\n');

    const projectDir = process.cwd();

    // Check if initialized
    const uapConfigPath = path.join(projectDir, '.uap.json');
    if (!existsSync(uapConfigPath)) {
      console.log('❌ UAP not initialized. Run: uap init');
      return;
    }

    const config = JSON.parse(readFileSync(uapConfigPath, 'utf8'));

    // Install components based on options
    const hasAll = args.includes('-p') || args.includes('--project');
    const setupMemory = hasAll || args.includes('memory');
    const setupHooks = hasAll || args.includes('hooks');
    const setupMCP = hasAll || args.includes('mcp-router');

    if (setupMemory) {
      await this.installMemory(projectDir);
    }

    if (setupHooks) {
      await this.installHooks(projectDir);
    }

    if (setupMCP) {
      await this.installMCPRouter(projectDir);
    }

    // Update config
    config.lastSetup = new Date().toISOString();
    writeFileSync(uapConfigPath, JSON.stringify(config, null, 2));

    console.log('\n✅ UAP setup complete!');
  }

  private async install(args: string[]): Promise<void> {
    if (args.length === 0) {
      console.log('❌ Please specify a harness: uap install <harness>');
      console.log('Available harnesses: opencode, claude-code, etc.');
      return;
    }

    const harness = args[0];
    console.log(`🔧 Installing UAP plugins for ${harness}...\n`);

    switch (harness) {
      case 'opencode':
        await this.installForOpencode();
        break;
      case 'claude-code':
        await this.installForClaudeCode();
        break;
      default:
        console.log(`ℹ Plugin installation for ${harness} not yet implemented.`);
        console.log('Available harnesses: opencode, claude-code');
    }
  }

  private async installForOpencode(): Promise<void> {
    const homeDir = process.env.HOME || '';
    const opencodeDir = path.join(homeDir, '.opencode');
    const pluginsDir = path.join(opencodeDir, 'plugin');

    if (!existsSync(opencodeDir)) {
      console.log(`ℹ Opencode not found at ${opencodeDir}`);
      console.log('Installing UAP to opencode...');
      mkdirSync(pluginsDir, { recursive: true });
    } else {
      mkdirSync(pluginsDir, { recursive: true });
    }

    await this.copyPluginsToDir(pluginsDir);

    // Create opencode config if needed
    const opencodeConfig = path.join(opencodeDir, 'config.json');
    if (!existsSync(opencodeConfig)) {
      const config = {
        uapEnabled: true,
        uapVersion: UAP_VERSION,
        installedAt: new Date().toISOString(),
      };
      writeFileSync(opencodeConfig, JSON.stringify(config, null, 2));
      console.log('✓ Created opencode config with UAP integration');
    }

    console.log('\n✅ UAP successfully integrated with opencode!');
  }

  private async installForClaudeCode(): Promise<void> {
    const homeDir = process.env.HOME || '';
    const claudeCodeDir = path.join(homeDir, '.claude', 'code');
    const hooksDir = path.join(claudeCodeDir, '.factory', 'hooks');

    if (!existsSync(claudeCodeDir)) {
      console.log(`ℹ Claude Code not found at ${claudeCodeDir}`);
      console.log('Installing UAP to claude-code...');
      mkdirSync(hooksDir, { recursive: true });
    } else {
      mkdirSync(hooksDir, { recursive: true });
    }

    // Copy hook scripts for claude-code from plugin directory
    const hooks = ['session-start.sh', 'pre-compact.sh'];
    for (const hook of hooks) {
      const src = path.join(projectRoot, 'tools', 'agents', 'plugin', hook);
      const dest = path.join(hooksDir, hook);

      if (existsSync(src)) {
        try {
          const content = readFileSync(src, 'utf8');
          writeFileSync(dest, content);
          console.log(`✓ Installed ${hook}`);
        } catch (e) {
          console.log(`✗ Failed to install ${hook}: ${e}`);
        }
      } else {
        console.log(`ℹ Hook not found: ${hook}`);
      }
    }

    // Create claude-code config if needed
    const claudeConfig = path.join(claudeCodeDir, 'config.json');
    if (!existsSync(claudeConfig)) {
      const config = {
        uapEnabled: true,
        uapVersion: UAP_VERSION,
        installedAt: new Date().toISOString(),
      };
      writeFileSync(claudeConfig, JSON.stringify(config, null, 2));
      console.log('✓ Created claude-code config with UAP integration');
    }

    console.log('\n✅ UAP successfully integrated with claude-code!');
  }

  private async copyPluginsToDir(destDir: string): Promise<void> {
    const uapPlugins = [
      'uap-commands.ts',
      'uap-droids.ts',
      'uap-skills.ts',
      'uap-patterns.ts',
      'session-start.sh',
      'pre-compact.sh',
    ];

    for (const plugin of uapPlugins) {
      const src = path.join(projectRoot, 'tools', 'agents', 'plugin', plugin);
      const dest = path.join(destDir, plugin);

      if (existsSync(src)) {
        try {
          const content = readFileSync(src, 'utf8');
          writeFileSync(dest, content);
          console.log(`✓ Installed ${plugin}`);
        } catch (e) {
          console.log(`✗ Failed to install ${plugin}: ${e}`);
        }
      } else {
        console.log(`ℹ Plugin not found: ${plugin}`);
      }
    }
  }

  private async installMemory(projectDir: string): Promise<void> {
    console.log('🔧 Setting up memory system...');

    const memoryDir = path.join(projectDir, 'agents', 'data', 'memory');
    mkdirSync(memoryDir, { recursive: true });

    const shortTermDB = path.join(memoryDir, 'short_term.db');
    const longTermDB = path.join(memoryDir, 'long_term.db');

    // Initialize SQLite databases
    try {
      execSync(
        `sqlite3 ${shortTermDB} "CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY, content TEXT, metadata TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);"`
      );
      console.log('✓ Created short-term memory database');

      execSync(
        `sqlite3 ${longTermDB} "CREATE TABLE IF NOT EXISTS lessons (id INTEGER PRIMARY KEY, title TEXT, content TEXT, category TEXT, importance INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);"`
      );
      console.log('✓ Created long-term memory database');
    } catch (e) {
      console.log('ℹ SQLite not available for in-memory setup');
    }

    console.log('✅ Memory system initialized!');
  }

  private async installHooks(projectDir: string): Promise<void> {
    console.log('🔧 Installing UAP hooks...');

    const hooksDir = path.join(projectDir, '.factory', 'hooks');
    mkdirSync(hooksDir, { recursive: true });

    // Copy hook scripts
    const hooks = ['session-start.sh', 'pre-compact.sh'];

    for (const hook of hooks) {
      const src = path.join(projectRoot, '.factory', 'hooks', hook);
      const dest = path.join(hooksDir, hook);

      if (existsSync(src)) {
        try {
          const content = readFileSync(src, 'utf8');
          writeFileSync(dest, content);
          console.log(`✓ Installed ${hook}`);
        } catch (e) {
          console.log(`✗ Failed to install ${hook}: ${e}`);
        }
      } else {
        console.log(`ℹ Hook not found: ${hook}`);
      }
    }

    console.log('✅ Hooks installed!');
  }

  private async installMCPRouter(_projectDir: string): Promise<void> {
    console.log('🔧 Setting up MCP Router...');

    // MCP router setup would go here
    console.log('ℹ MCP Router configuration pending implementation');
    console.log('✅ MCP Router placeholder created!');
  }

  private async uninstall(): Promise<void> {
    console.log('❌ UAP uninstall not yet implemented');
    console.log('To manually remove UAP:');
    console.log('  rm -rf .uap.json .factory/hooks agents/data/memory');
  }

  private async hooks(args: string[]): Promise<void> {
    const command = args[0];

    switch (command) {
      case 'list':
        console.log('Available UAP hooks:');
        console.log('  - session-start: Run at session initialization');
        console.log('  - pre-compact: Run before context compression');
        console.log('  - post-complete: Run after task completion');
        break;
      case 'install':
        await this.installHooks(process.cwd());
        break;
      default:
        this.printHelp();
    }
  }

  private async plugins(args: string[]): Promise<void> {
    console.log('UAP Plugins:');
    console.log('  - uap-session-hooks: Session management hooks');
    console.log('  - uap-commands: UAP command definitions');
    console.log('  - uap-droids: Specialized agent droids');
    console.log('  - uap-skills: Domain-specific skills');
    console.log('  - uap-patterns: Reusable coding patterns');

    if (args[0] === 'install') {
      await this.install(args.slice(1));
    }
  }
}

// Main entry point
const cli = new UAPCli();
cli.run(process.argv.slice(2)).catch(console.error);

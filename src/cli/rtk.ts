#!/usr/bin/env node
/**
 * RTK (Rust Token Killer) Integration for UAP
 *
 * Provides commands to install and manage RTK CLI proxy
 * for 60-90% token savings on command outputs.
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';

export interface RTKInstallOptions {
  force?: boolean;
  method?: 'homebrew' | 'cargo' | 'curl';
}

/**
 * Detect the operating system
 */
function detectOS(): string {
  const platform = process.platform;
  if (platform === 'darwin') return 'macOS';
  if (platform === 'linux') return 'Linux';
  if (platform === 'win32') return 'Windows';
  return 'Unknown';
}

/**
 * Detect system architecture
 */
function detectArch(): string {
  const arch = process.arch;
  if (arch === 'x64') return 'x86_64';
  if (arch === 'arm64') return 'arm64';
  return arch;
}

/**
 * Check if RTK is already installed
 */
function checkRTKInstalled(): boolean {
  try {
    execSync('which rtk', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get RTK version if installed
 */
function getRTKVersion(): string {
  try {
    const output = execSync('rtk --version', { encoding: 'utf8' });
    return output.trim().split('\n')[0];
  } catch {
    return 'unknown';
  }
}

/**
 * Check if a command is available
 */
function commandExists(command: string): boolean {
  try {
    execSync(`which ${command}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Install RTK using Homebrew (macOS/Linux)
 */
function installWithHomebrew(): void {
  console.log('   Installing via Homebrew...');

  try {
    execSync('brew install rtk', { stdio: 'inherit' });
    console.log('✅ Installed via Homebrew');
  } catch (error) {
    console.error('❌ Homebrew installation failed:', error);
    throw error;
  }
}

/**
 * Install RTK using Cargo (Rust package manager)
 */
function installWithCargo(): void {
  console.log('   Installing via Cargo...');

  try {
    execSync('cargo install --git https://github.com/rtk-ai/rtk', { stdio: 'inherit' });
    console.log('✅ Installed via Cargo');
  } catch (error) {
    console.error('❌ Cargo installation failed:', error);
    throw error;
  }
}

/**
 * Install RTK using curl (download pre-built binary)
 */
async function installWithCurl(): Promise<void> {
  console.log('   Installing via curl...');

  const os = detectOS();
  const arch = detectArch();

  let binaryName: string;

  if (os === 'macOS') {
    binaryName =
      arch === 'arm64' ? 'rtk-aarch64-apple-darwin.tar.gz' : 'rtk-x86_64-apple-darwin.tar.gz';
  } else if (os === 'Linux') {
    binaryName =
      arch === 'arm64'
        ? 'rtk-aarch64-unknown-linux-gnu.tar.gz'
        : 'rtk-x86_64-unknown-linux-musl.tar.gz';
  } else {
    throw new Error('Unsupported OS for curl installation');
  }

  console.log(`   Downloading: ${binaryName}`);

  const tempDir = process.env.TMPDIR || '/tmp';
  const downloadPath = path.join(tempDir, 'rtk-install');

  try {
    mkdirSync(downloadPath, { recursive: true });

    // Download binary
    execSync(
      `curl -fsSL "https://github.com/rtk-ai/rtk/releases/latest/download/${binaryName}" -o "${downloadPath}/rtk.tar.gz"`,
      { stdio: 'inherit' }
    );

    // Extract
    execSync(`tar -xzf "${downloadPath}/rtk.tar.gz" -C "${downloadPath}"`, { stdio: 'inherit' });

    // Move to local bin
    const localBin = path.join(process.env.HOME || '/tmp', '.local', 'bin');
    mkdirSync(localBin, { recursive: true });

    execSync(`mv "${downloadPath}/rtk" "${localBin}/rtk"`, { stdio: 'inherit' });
    execSync(`chmod +x "${localBin}/rtk"`, { stdio: 'inherit' });

    console.log(`✅ Installed to ${localBin}/rtk`);
  } catch (error) {
    console.error('❌ Curl installation failed:', error);
    throw error;
  }
}

/**
 * Install RTK with auto-detection of best method
 */
export async function installRTK(options: RTKInstallOptions = {}): Promise<void> {
  const os = detectOS();
  const arch = detectArch();

  console.log('🔧 Installing RTK (Rust Token Killer)...');
  console.log('   Reduces LLM token consumption by 60-90% on CLI commands');
  console.log('');
  console.log(`Detected: ${os} (${arch})`);
  console.log('');

  // Check if already installed
  if (checkRTKInstalled() && !options.force) {
    const version = getRTKVersion();
    console.log(`ℹ RTK is already installed: ${version}`);
    console.log('');

    if (!process.env.FORCE_INSTALL) {
      console.log('To force upgrade, set FORCE_INSTALL=1 and re-run the install command.');
      console.log('Skipping installation.');
      return;
    }
  }

  // Try installation methods in order of preference
  const methods = [
    { name: 'homebrew', check: () => os === 'macOS' || commandExists('brew') },
    { name: 'cargo', check: () => commandExists('cargo') },
    { name: 'curl', check: () => true }, // Fallback for all platforms
  ];

  let installed = false;

  for (const method of methods) {
    if (!options.method || options.method === method.name) {
      console.log(`📦 Trying installation method: ${method.name}`);

      try {
        switch (method.name) {
          case 'homebrew':
            installWithHomebrew();
            installed = true;
            break;
          case 'cargo':
            installWithCargo();
            installed = true;
            break;
          case 'curl':
            installWithCurl();
            installed = true;
            break;
        }

        if (installed) {
          console.log('');
          break;
        }
      } catch (error) {
        console.error(`   ✗ Failed: ${method.name}`);
      }
    }
  }

  // Verify installation
  if (!checkRTKInstalled()) {
    console.log('');
    console.error('❌ All installation methods failed');
    console.log('');
    console.log('Manual installation options:');
    console.log('  1. Homebrew (macOS/Linux): brew install rtk');
    console.log('  2. Cargo: cargo install --git https://github.com/rtk-ai/rtk');
    console.log('  3. Pre-built binaries: https://github.com/rtk-ai/rtk/releases');
    process.exit(1);
  }

  // Success!
  const version = getRTKVersion();
  console.log('');
  console.log('✅ RTK installed successfully!');
  console.log(`   Version: ${version}`);
  console.log('');
  console.log('📚 Next steps:');
  console.log('   1. Initialize hook for Claude Code:');
  console.log('      rtk init --global');
  console.log('');
  console.log('   2. Verify installation:');
  console.log('      rtk gain');
  console.log('');
  console.log('   3. View token savings:');
  console.log('      rtk gain --graph');
}

/**
 * Check RTK status
 */
export async function checkRTKStatus(): Promise<void> {
  console.log('🔍 Checking RTK status...');
  console.log('');

  if (!checkRTKInstalled()) {
    console.log('❌ RTK is not installed');
    console.log('');
    console.log('Install with: uap install rtk');
    return;
  }

  const version = getRTKVersion();
  console.log(`✅ RTK is installed`);
  console.log(`   Version: ${version}`);
  console.log('');

  // Check hook installation
  const homeDir = process.env.HOME || '/tmp';
  const claudeHooksDir = path.join(homeDir, '.claude', 'hooks');
  const rtkHookPath = path.join(claudeHooksDir, 'rtk-rewrite.sh');

  if (existsSync(rtkHookPath)) {
    console.log('✅ RTK hook is installed');
    console.log(`   Path: ${rtkHookPath}`);
    console.log('');
  } else {
    console.log('⚠️  RTK hook is not installed');
    console.log('');
    console.log('Install hook with: rtk init --global');
    console.log('');
  }

  // Show recent token savings if available
  try {
    const gainOutput = execSync('rtk gain', { encoding: 'utf8' });
    console.log('📊 Recent Token Savings:');
    console.log('─────────────────────────────────');

    // Show first 20 lines of gain output
    const lines = gainOutput.split('\n').slice(0, 20);
    console.log(lines.join('\n'));
  } catch {
    console.log('ℹ️  No token savings data available yet');
  }
}

/**
 * Run an arbitrary RTK command by passing through all args to the rtk binary.
 * If RTK is not installed, prints install instructions.
 */
export function runRTKCommand(args: string[]): void {
  if (!checkRTKInstalled()) {
    console.log('RTK is not installed.');
    console.log('');
    console.log('Install RTK using one of these methods:');
    console.log('  uap install rtk            # Auto-detect best method');
    console.log('  brew install rtk            # Homebrew (macOS/Linux)');
    console.log('  cargo install --git https://github.com/rtk-ai/rtk  # Cargo');
    console.log('  Download from: https://github.com/rtk-ai/rtk/releases');
    return;
  }

  const command = ['rtk', ...args].join(' ');
  try {
    execSync(command, { stdio: 'inherit' });
  } catch (error) {
    // execSync throws on non-zero exit; the output is already shown via stdio: 'inherit'
  }
}

/**
 * Show unified analytics combining MCP Router stats and RTK stats.
 * Reads MCP Router config from .uap-mcp-router.json and RTK stats from `rtk gain`.
 */
export function showUnifiedAnalytics(): void {
  console.log('');
  console.log('Unified Token Analytics');
  console.log('═══════════════════════════════════════════════════════');
  console.log('');

  // MCP Router stats
  console.log('MCP Router');
  console.log('───────────────────────────────────────────────────────');
  const mcpConfigPath = path.join(process.cwd(), '.uap-mcp-router.json');
  if (existsSync(mcpConfigPath)) {
    try {
      const raw = readFileSync(mcpConfigPath, 'utf-8');
      const mcpConfig = JSON.parse(raw) as Record<string, unknown>;
      const rows: Array<[string, string]> = [
        ['Enabled', String(mcpConfig.enabled ?? 'unknown')],
        ['Compression', String(mcpConfig.compressionLevel ?? 'unknown')],
        ['Max Tools', String(mcpConfig.maxTools ?? 'unknown')],
        ['Version', String(mcpConfig.version ?? 'unknown')],
      ];
      for (const [label, value] of rows) {
        console.log(`  ${label.padEnd(20)} ${value}`);
      }
      console.log('  Savings              ~98% (150+ tools behind 2 meta-tools)');
    } catch {
      console.log('  Could not parse .uap-mcp-router.json');
    }
  } else {
    console.log('  Not configured. Run: uap setup mcp-router');
  }

  console.log('');

  // RTK stats
  console.log('RTK (Rust Token Killer)');
  console.log('───────────────────────────────────────────────────────');
  if (checkRTKInstalled()) {
    const version = getRTKVersion();
    console.log(`  Installed            ${version}`);
    try {
      const gainOutput = execSync('rtk gain', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const lines = gainOutput.trim().split('\n');
      for (const line of lines.slice(0, 15)) {
        console.log(`  ${line}`);
      }
      if (lines.length > 15) {
        console.log(`  ... (${lines.length - 15} more lines)`);
      }
    } catch {
      console.log('  No token savings data available yet');
    }
  } else {
    console.log('  Not installed. Run: uap install rtk');
  }

  console.log('');
  console.log('Combined Savings');
  console.log('───────────────────────────────────────────────────────');
  console.log('  MCP Router + RTK = 95%+ total token reduction');
  console.log('');
}

/**
 * Show RTK help
 */
export function showRTKHelp(): void {
  console.log(`
RTK (Rust Token Killer) Integration

USAGE:
  uap rtk <command>

COMMANDS:
  install [options]    Install RTK CLI proxy
    --force            Force reinstallation
    --method <m>       Installation method (homebrew|cargo|curl)

  status               Check RTK installation status

  help                 Show this help message

EXAMPLES:
  uap rtk install          # Install RTK
  uap rtk install --force  # Force reinstall
  uap rtk status           # Check installation status

INTEGRATION WITH UAP:
  RTK works alongside UAP's MCP Router for maximum token savings:
  
  - MCP Router: Reduces tool definition overhead (~98% savings)
    • Hides 150+ tools behind 2 meta-tools
  
  - RTK: Compresses CLI command output (60-90% savings)
    • Filters git status, test output, file reads, etc.
  
  Combined: 95%+ total token reduction

LEARN MORE:
  • RTK Documentation: https://www.rtk-ai.app
  • GitHub: https://github.com/rtk-ai/rtk
  • Architecture: docs/rtk-integration-analysis.md
`);
}

/**
 * Policy Management Commands
 *
 * Commands for managing UAP policies:
 * - uap policy list - List all policies
 * - uap policy install <name> - Install a built-in policy
 * - uap policy enable <id> - Enable a policy
 * - uap policy disable <id> - Disable a policy
 * - uap policy status - Show enabled/disabled policies
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { getPolicyGate } from '../policies/policy-gate.js';
import { getPolicyMemoryManager } from '../policies/policy-memory.js';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const POLICY_DIR = join(process.cwd(), 'src', 'policies', 'schemas', 'policies');

/**
 * List command - show all policies
 */
async function listCommand(): Promise<void> {
  console.log(chalk.bold('\n=== UAP Policy Status ===\n'));

  const policyManager = getPolicyMemoryManager();
  const policies = await policyManager.getAllPolicies();

  if (policies.length === 0) {
    console.log(
      chalk.yellow('No policies found. Run `uap policy install <name>` to install policies.')
    );
    return;
  }

  console.log(`Total Policies: ${policies.length}\n`);

  for (const policy of policies) {
    const statusIcon = policy.isActive ? chalk.green('✓') : chalk.red('✗');
    const levelBadge =
      policy.level === 'REQUIRED'
        ? chalk.red('REQUIRED')
        : policy.level === 'RECOMMENDED'
          ? chalk.yellow('RECOMMENDED')
          : chalk.gray('OPTIONAL');

    console.log(`${statusIcon} ${chalk.cyan(policy.name)}`);
    console.log(`    Status: ${policy.isActive ? chalk.green('Enabled') : chalk.red('Disabled')}`);
    console.log(`    Level: ${levelBadge}`);
    console.log(`    Category: ${chalk.yellow(policy.category)}`);
    console.log(`    Stage: ${chalk.blue(policy.enforcementStage || 'pre-exec')}`);
    console.log(`    Version: ${policy.version}`);
    console.log();
  }
}

/**
 * Install command - install a built-in policy
 */
async function installCommand(name: string): Promise<void> {
  const policyManager = getPolicyMemoryManager();
  const policyGate = getPolicyGate();

  // Check if policy file exists in the policies directory
  const policyPath = join(POLICY_DIR, `${name}.md`);

  if (!existsSync(policyPath)) {
    console.log(chalk.red(`\n❌ Policy '${name}' not found.`));
    console.log(chalk.yellow('\nAvailable built-in policies:'));

    // List available policy files
    if (existsSync(POLICY_DIR)) {
      const files = readdirSync(POLICY_DIR).filter((f) => f.endsWith('.md'));
      for (const file of files) {
        const policyName = file.replace('.md', '');
        console.log(`  - ${policyName}`);
      }
    } else {
      console.log('  - mandatory-testing-deployment');
    }

    return;
  }

  // Read policy content
  const content = readFileSync(policyPath, 'utf-8');

  try {
    await policyManager.storeRawPolicy(content);
    console.log(chalk.green(`\n✅ Policy '${name}' installed successfully!`));
    console.log(chalk.dim('The policy is now active and will be enforced.'));

    // Invalidate cache to pick up new policy
    policyGate.invalidateCache();
  } catch (error) {
    console.error(
      chalk.red(
        `\n❌ Failed to install policy: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }
}

/**
 * Enable command - enable a policy
 */
async function enableCommand(id: string): Promise<void> {
  const policyManager = getPolicyMemoryManager();
  const policyGate = getPolicyGate();

  try {
    await policyManager.togglePolicy(id, true);
    console.log(chalk.green(`\n✅ Policy '${id}' enabled successfully!`));
    policyGate.invalidateCache();
  } catch (error) {
    console.error(
      chalk.red(
        `\n❌ Failed to enable policy: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }
}

/**
 * Disable command - disable a policy
 */
async function disableCommand(id: string): Promise<void> {
  const policyManager = getPolicyMemoryManager();
  const policyGate = getPolicyGate();

  try {
    await policyManager.togglePolicy(id, false);
    console.log(chalk.yellow(`\n⚠️  Policy '${id}' disabled. It will no longer be enforced.`));
    policyGate.invalidateCache();
  } catch (error) {
    console.error(
      chalk.red(
        `\n❌ Failed to disable policy: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }
}

/**
 * Status command - show detailed policy status
 */
async function statusCommand(): Promise<void> {
  console.log(chalk.bold('\n=== Policy Enforcement Status ===\n'));

  const policyManager = getPolicyMemoryManager();
  const policies = await policyManager.getAllPolicies();

  const enabled = policies.filter((p) => p.isActive);
  const disabled = policies.filter((p) => !p.isActive);

  console.log(`Enabled:  ${chalk.green(enabled.length.toString())}`);
  console.log(`Disabled: ${chalk.red(disabled.length.toString())}`);
  console.log();

  if (enabled.length > 0) {
    console.log(chalk.bold('Active Policies:'));
    for (const policy of enabled) {
      console.log(`  ${chalk.green('✓')} ${policy.name} (${policy.level}) - ${policy.category}`);
    }
    console.log();
  }

  if (disabled.length > 0) {
    console.log(chalk.bold('Inactive Policies:'));
    for (const policy of disabled) {
      console.log(`  ${chalk.red('✗')} ${policy.name} - ${policy.category}`);
    }
    console.log();
  }

  // Show enforcement stages
  console.log(chalk.bold('\nEnforcement Stages:'));
  console.log('  pre-exec  - Before operation execution');
  console.log('  post-exec - After operation execution');
  console.log('  review    - During code review/task completion');
  console.log('  always    - Always enforced (all stages)');
}

/**
 * Register policy commands
 */
export function registerPolicyCommands(program: Command): void {
  const policy = program.command('policy').description('UAP policy management');

  policy.command('list').description('List all policies and their status').action(listCommand);

  policy.command('install <name>').description('Install a built-in policy').action(installCommand);

  policy.command('enable <id>').description('Enable a policy by ID').action(enableCommand);

  policy.command('disable <id>').description('Disable a policy by ID').action(disableCommand);

  policy
    .command('status')
    .description('Show detailed policy enforcement status')
    .action(statusCommand);
}

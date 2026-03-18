#!/usr/bin/env node
/**
 * Policy Installer Script
 *
 * Install mandatory policies that enforce testing and deployment verification.
 * Run this script to ensure all tasks require proper testing before completion.
 *
 * Usage:
 *   node scripts/install-policy.js [policy-name]
 *
 * Examples:
 *   node scripts/install-policy.js                          # Install all mandatory policies
 *   node scripts/install-policy.js mandatory-testing-deployment  # Install specific policy
 */

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { getPolicyMemoryManager } from '../src/policies/policy-memory.js';
import { getPolicyGate } from '../src/policies/policy-gate.js';

const POLICY_DIR = join(process.cwd(), 'src', 'policies', 'schemas', 'policies');

// List of mandatory policies that should always be enforced
const MANDATORY_POLICIES = [
  'mandatory-testing-deployment',
  'policy-code-quality',
  'policy-security-gate',
  'policy-deployment-safety',
];

async function installPolicy(policyName: string): Promise<void> {
  const policyPath = join(POLICY_DIR, `${policyName}.md`);

  if (!existsSync(policyPath)) {
    console.log(chalk.red(`❌ Policy '${policyName}' not found at ${policyPath}`));
    return;
  }

  try {
    const content = await import('fs').then((m) => m.readFileSync(policyPath, 'utf-8'));
    const policyManager = getPolicyMemoryManager();

    // Store the policy
    await policyManager.storeRawPolicy(content);

    console.log(chalk.green(`✅ Policy '${policyName}' installed successfully!`));
  } catch (error) {
    console.error(
      chalk.red(
        `❌ Failed to install policy: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }
}

async function main(): Promise<void> {
  console.log(chalk.bold('\n=== UAP Policy Installer ===\n'));

  const args = process.argv.slice(2);

  if (args.length === 0) {
    // Install all mandatory policies
    console.log('Installing all mandatory policies...\n');

    for (const policyName of MANDATORY_POLICIES) {
      await installPolicy(policyName);
      console.log();
    }

    // Invalidate cache
    getPolicyGate().invalidateCache();

    console.log(chalk.green('\n✅ All mandatory policies installed!\n'));
    console.log(chalk.dim('Run `uap policy list` to view installed policies.'));
  } else {
    // Install specific policy
    for (const policyName of args) {
      await installPolicy(policyName);
      console.log();
    }
  }
}

main().catch((error) => {
  console.error(
    chalk.red(`\n❌ Fatal error: ${error instanceof Error ? error.message : String(error)}`)
  );
  process.exit(1);
});

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

import { existsSync, readdirSync, readFileSync, copyFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { getPolicyMemoryManager } from '../src/policies/policy-memory.js';
import { getPolicyGate } from '../src/policies/policy-gate.js';
import { getPolicyToolRegistry } from '../src/policies/policy-tools.js';

const POLICY_DIR = join(process.cwd(), 'src', 'policies', 'schemas', 'policies');
const ENFORCER_DIR = join(process.cwd(), 'src', 'policies', 'enforcers');
const TOOL_DIR = join(process.cwd(), '.policy-tools');

/**
 * Map policy name (kebab-case) to enforcer file basename (snake_case).
 * e.g. 'cluster-routing' -> 'cluster_routing.py'
 */
function enforcerPathFor(policyName: string): string {
  const snake = policyName.replace(/-/g, '_');
  return join(ENFORCER_DIR, `${snake}.py`);
}

/**
 * Attach the Python enforcer for a given policy by name.
 * Copies the enforcer into .policy-tools/<policyId>_<tool>.py and registers
 * it in the executable_tools table + policies.executableTools column.
 * Returns true if attached, false if no enforcer exists (silent skip).
 */
async function attachEnforcer(policyName: string): Promise<boolean> {
  const enforcer = enforcerPathFor(policyName);
  if (!existsSync(enforcer)) {
    return false;
  }

  const memory = getPolicyMemoryManager();
  const policies = await memory.getAllPolicies();
  const policy = policies.find((p) => p.name === policyName);
  if (!policy) {
    console.log(chalk.yellow(`  ⚠ could not locate installed policy '${policyName}' to attach enforcer`));
    return false;
  }

  const toolName = policyName.replace(/-/g, '_');
  const code = readFileSync(enforcer, 'utf-8');

  // storeToolCode handles DB write + .policy-tools/ file write in one shot
  const registry = getPolicyToolRegistry();
  await registry.storeToolCode(policy.id, toolName, code);

  // Also copy the shared helper alongside enforcers so relative imports resolve
  mkdirSync(TOOL_DIR, { recursive: true });
  const commonSrc = join(ENFORCER_DIR, '_common.py');
  if (existsSync(commonSrc)) {
    copyFileSync(commonSrc, join(TOOL_DIR, '_common.py'));
  }

  // Make the tool file executable
  const toolFile = join(TOOL_DIR, `${policy.id}_${toolName}.py`);
  if (existsSync(toolFile)) {
    try {
      chmodSync(toolFile, 0o755);
    } catch {
      /* non-fatal */
    }
  }

  console.log(chalk.dim(`    → attached enforcer ${toolName} (.policy-tools/${policy.id}_${toolName}.py)`));
  return true;
}

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
    const content = readFileSync(policyPath, 'utf-8');
    const policyManager = getPolicyMemoryManager();

    // Store the policy
    await policyManager.storeRawPolicy(content);

    console.log(chalk.green(`✅ Policy '${policyName}' installed successfully!`));

    // Auto-attach Python enforcer if one exists alongside the markdown
    const attached = await attachEnforcer(policyName);
    if (!attached) {
      console.log(chalk.dim(`    (no executable enforcer at ${enforcerPathFor(policyName)})`));
    }
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

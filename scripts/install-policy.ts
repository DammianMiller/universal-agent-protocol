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
 * Comparable form of a policy identifier.
 *
 * The name a policy is STORED under comes from its markdown H1, while callers
 * address it by FILE SLUG. Those coincide only by accident: `# delivery-
 * enforcement` matches its slug, `# Enforcement Self-Protect` does not — and
 * comparing the two raw meant the enforcer silently failed to attach for every
 * policy whose title is written for humans.
 */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Why an attach did not happen — the caller reports each differently. */
type AttachResult =
  | { attached: true }
  | { attached: false; reason: 'no-enforcer' }
  | { attached: false; reason: 'policy-not-found' };

/**
 * Attach the Python enforcer for a given policy by name.
 * Copies the enforcer into .policy-tools/<policyId>_<tool>.py and registers
 * it in the executable_tools table + policies.executableTools column.
 *
 * The two failure modes are kept DISTINCT because they mean opposite things: no
 * enforcer file is normal (most policies are prose), while an enforcer that
 * exists and could not be attached leaves the previously-materialised copy in
 * force — stale enforcement that still looks installed.
 */
async function attachEnforcer(policyName: string): Promise<AttachResult> {
  const enforcer = enforcerPathFor(policyName);
  if (!existsSync(enforcer)) {
    return { attached: false, reason: 'no-enforcer' };
  }

  const memory = getPolicyMemoryManager();
  const policies = await memory.getAllPolicies();
  const wanted = slugify(policyName);
  const policy =
    policies.find((p) => p.name === policyName) ?? policies.find((p) => slugify(p.name) === wanted);
  if (!policy) {
    return { attached: false, reason: 'policy-not-found' };
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
  return { attached: true };
}

// List of mandatory policies that should always be enforced
const MANDATORY_POLICIES = [
  'mandatory-testing-deployment',
  'merge-deploy-monitor-verify',
  'policy-code-quality',
  'policy-security-gate',
  'policy-deployment-safety',
  'task-required',
  'workdir-scope',
  // Inactive (fails open) until a project has a DESIGN.md token allow-list;
  // installed eagerly so `uap design interrogate` activates it with no re-setup.
  'design-token-gate',
  // Inactive (fails open) unless fidelity is `max`; installed eagerly so
  // `uap fidelity max` / `uap setup --profile maximum` activates the commit-time
  // visual-verification gate with no re-setup.
  'visual-verification',
  // Always active: block the model from killing/displacing the inference stack
  // it runs on (llama :8080 / proxy :4000 / embeddings :8081).
  'enforcement-infra-protect',
  // Always validate a plan after creating/modifying it: a plan-file write is
  // blocked until `validate the plan` + `uap plan validate` have run recently.
  'validate-plan-on-change',
  // All-in moves (destructive git ops, stub overwrites of real source) are
  // blocked until a reserve (stash/backup) exists -- "never go full".
  'commitment-reserve',
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
    const attach = await attachEnforcer(policyName);
    if (!attach.attached && attach.reason === 'no-enforcer') {
      // Normal: most policies are prose only.
      console.log(chalk.dim(`    (no executable enforcer at ${enforcerPathFor(policyName)})`));
    } else if (!attach.attached) {
      // NOT normal, and not cosmetic: an enforcer exists on disk but the stored
      // policy could not be found, so the previously-materialised copy stays in
      // force. That is stale enforcement wearing an "installed successfully"
      // label — how a fix to enforcement-self-protect sat unapplied for over a
      // week while every install reported success and exited 0.
      installFailures += 1;
      console.log(
        chalk.red(
          `  ❌ enforcer NOT attached: '${policyName}' has an enforcer at ${enforcerPathFor(policyName)} ` +
            `but no stored policy matches it.\n` +
            `     The previously-installed enforcer REMAINS ACTIVE — enforcement is stale, not updated.\n` +
            `     Install the policy first (its markdown H1 is stored as the name), then re-run.`
        )
      );
    }
  } catch (error) {
    console.error(
      chalk.red(
        `❌ Failed to install policy: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }
}

/** Non-zero exit if any enforcer could not be attached — see the caller above. */
let installFailures = 0;

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

main()
  .then(() => {
    // Exit non-zero when an enforcer could not be attached. Reporting success
    // while leaving the previous enforcer in force is the failure mode that let
    // stale enforcement run unnoticed; a caller that automates this has to be
    // able to see it.
    if (installFailures > 0) {
      console.error(
        chalk.red(
          `\n❌ ${installFailures} enforcer(s) could NOT be attached — enforcement is STALE for those policies.\n`
        )
      );
      process.exit(1);
    }
  })
  .catch((error) => {
    console.error(
      chalk.red(`\n❌ Fatal error: ${error instanceof Error ? error.message : String(error)}`)
    );
    process.exit(1);
  });

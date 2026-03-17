#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync, writeFileSync } from 'node:fs';
import { getPolicyMemoryManager } from '../policies/policy-memory.js';
import { getPolicyToolRegistry } from '../policies/policy-tools.js';
import { getPolicyGate } from '../policies/policy-gate.js';
import { convertPolicyToClaude } from '../policies/convert-policy-to-claude.js';

const program = new Command();

program.name('policy').description('Policy management commands');

program
  .command('add')
  .description('Add a new policy from markdown file')
  .requiredOption('-f, --file <path>', 'Path to policy markdown file')
  .option('-c, --category <name>', 'Policy category', 'custom')
  .option('-l, --level <level>', 'Enforcement level', 'RECOMMENDED')
  .option('-t, --tags <tags>', 'Comma-separated tags', '')
  .action(async (options) => {
    const memory = getPolicyMemoryManager();
    const rawMarkdown = readFileSync(options.file, 'utf-8');
    const tags = options.tags ? options.tags.split(',').map((t: string) => t.trim()) : [];
    const policyId = await memory.storeRawPolicy(rawMarkdown, {
      category: options.category,
      level: options.level as any,
      tags,
    });
    console.log(`Policy stored with ID: ${policyId}`);
  });

program
  .command('convert')
  .description('Convert raw policy to CLAUDE.md format')
  .requiredOption('-i, --input <id>', 'Policy ID or path to markdown file')
  .option('-o, --output <path>', 'Output file path')
  .action(async (options) => {
    let rawMarkdown: string;

    if (options.input.endsWith('.md')) {
      rawMarkdown = readFileSync(options.input, 'utf-8');
    } else {
      const memory = getPolicyMemoryManager();
      const policy = await memory.getPolicy(options.input);
      if (!policy) throw new Error(`Policy ${options.input} not found`);
      rawMarkdown = policy.rawMarkdown;
    }

    const converted = convertPolicyToClaude(rawMarkdown);
    const outputPath = options.output || `converted-${Date.now()}.md`;
    writeFileSync(outputPath, converted);
    console.log(`Converted to: ${outputPath}`);
  });

program
  .command('list')
  .description('List all active policies')
  .option('-c, --category <name>', 'Filter by category')
  .option('--all', 'Show inactive policies too')
  .action(async (options) => {
    const memory = getPolicyMemoryManager();
    let policies;
    if (options.category) {
      policies = await memory.getCategoriesPolicies(options.category);
    } else {
      policies = await memory.getAllPolicies();
    }

    if (policies.length === 0) {
      console.log('No policies found.');
      return;
    }

    console.log('Policies:\n');
    console.log(
      `  ${'Name'.padEnd(30)} ${'Level'.padEnd(14)} ${'Stage'.padEnd(12)} ${'Category'.padEnd(12)} Status`
    );
    console.log(
      `  ${'─'.repeat(30)} ${'─'.repeat(14)} ${'─'.repeat(12)} ${'─'.repeat(12)} ${'─'.repeat(8)}`
    );
    for (const policy of policies) {
      const status = policy.isActive ? 'ON' : 'OFF';
      const stage = (policy as any).enforcementStage || 'pre-exec';
      console.log(
        `  ${policy.name.slice(0, 30).padEnd(30)} ${policy.level.padEnd(14)} ${stage.padEnd(12)} ${policy.category.padEnd(12)} ${status}`
      );
      console.log(`  ${('  ID: ' + policy.id).padEnd(30)}`);
    }
    console.log('');
  });

program
  .command('get-relevant')
  .description('Get policies relevant to current task context')
  .requiredOption('-t, --task <text>', 'Task description or context')
  .option('--top <n>', 'Number of policies to retrieve', '3')
  .action(async (options) => {
    const memory = getPolicyMemoryManager();
    const policies = await memory.getRelevantPolicies(options.task, parseInt(options.top));

    console.log('Relevant Policies:\n');
    for (const policy of policies) {
      const preview = policy.rawMarkdown.split('\n').slice(0, 2).join('\n     ');
      console.log(`  [${policy.level}] ${policy.name}`);
      console.log(`     ${preview}`);
      console.log('');
    }
  });

program
  .command('add-tool')
  .description('Add Python tool code to a policy')
  .requiredOption('-p, --policy <id>', 'Policy ID')
  .requiredOption('-t, --tool <name>', 'Tool name')
  .requiredOption('-c, --code <file>', 'Path to Python code file')
  .action(async (options) => {
    const registry = getPolicyToolRegistry();
    const pythonCode = readFileSync(options.code, 'utf-8');
    await registry.storeToolCode(options.policy, options.tool, pythonCode);
    console.log(`Tool "${options.tool}" added to policy ${options.policy}`);
  });

program
  .command('check')
  .description('Check if an operation would be allowed by policies')
  .requiredOption('-o, --operation <name>', 'Operation name')
  .option('-a, --args <json>', 'JSON arguments', '{}')
  .action(async (options) => {
    const gate = getPolicyGate();
    const args = JSON.parse(options.args);
    const result = await gate.checkPolicies(options.operation, args);

    if (result.allowed) {
      console.log(`ALLOWED: Operation "${options.operation}" passes all policy checks`);
    } else {
      console.log(`BLOCKED: Operation "${options.operation}" blocked by:`);
      for (const block of result.blockedBy) {
        console.log(`  [${block.policyName}] ${block.reason}`);
      }
    }
  });

program
  .command('audit')
  .description('Show policy enforcement audit trail')
  .option('-p, --policy <id>', 'Filter by policy ID')
  .option('-n, --limit <n>', 'Number of entries', '20')
  .action(async (options) => {
    const gate = getPolicyGate();
    const entries = await gate.getAuditTrail(options.policy, parseInt(options.limit));

    console.log('Audit Trail:\n');
    for (const entry of entries) {
      const icon = entry.allowed ? 'PASS' : 'BLOCK';
      console.log(`  [${icon}] ${entry.operation} at ${entry.executedAt}`);
      console.log(`     Policy: ${entry.policyId}`);
      if (entry.reason) console.log(`     Reason: ${entry.reason}`);
      console.log('');
    }
  });

program
  .command('toggle <id>')
  .description('Toggle a policy on or off')
  .option('--on', 'Enable the policy')
  .option('--off', 'Disable the policy')
  .action(async (id: string, options: { on?: boolean; off?: boolean }) => {
    const memory = getPolicyMemoryManager();
    const policy = await memory.getPolicy(id);
    if (!policy) {
      console.error(`Policy ${id} not found`);
      process.exit(1);
    }
    const newState = options.off ? false : options.on ? true : !policy.isActive;
    await memory.togglePolicy(id, newState);
    console.log(`Policy "${policy.name}" is now ${newState ? 'ACTIVE' : 'INACTIVE'}`);
  });

program
  .command('stage <id>')
  .description('Change the enforcement stage of a policy')
  .requiredOption('-s, --stage <stage>', 'Enforcement stage: pre-exec, post-exec, review, always')
  .action(async (id: string, options: { stage: string }) => {
    const validStages = ['pre-exec', 'post-exec', 'review', 'always'];
    if (!validStages.includes(options.stage)) {
      console.error(`Invalid stage "${options.stage}". Must be one of: ${validStages.join(', ')}`);
      process.exit(1);
    }
    const memory = getPolicyMemoryManager();
    const policy = await memory.getPolicy(id);
    if (!policy) {
      console.error(`Policy ${id} not found`);
      process.exit(1);
    }
    await memory.setEnforcementStage(id, options.stage as any);
    console.log(`Policy "${policy.name}" enforcement stage set to: ${options.stage}`);
  });

program
  .command('level <id>')
  .description('Change the enforcement level of a policy')
  .requiredOption('-l, --level <level>', 'Enforcement level: REQUIRED, RECOMMENDED, OPTIONAL')
  .action(async (id: string, options: { level: string }) => {
    const validLevels = ['REQUIRED', 'RECOMMENDED', 'OPTIONAL'];
    if (!validLevels.includes(options.level)) {
      console.error(`Invalid level "${options.level}". Must be one of: ${validLevels.join(', ')}`);
      process.exit(1);
    }
    const memory = getPolicyMemoryManager();
    const policy = await memory.getPolicy(id);
    if (!policy) {
      console.error(`Policy ${id} not found`);
      process.exit(1);
    }
    await memory.setLevel(id, options.level as any);
    console.log(`Policy "${policy.name}" enforcement level set to: ${options.level}`);
  });

program.parse();

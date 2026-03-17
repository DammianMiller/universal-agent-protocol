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
  .action(async (options) => {
    const memory = getPolicyMemoryManager();
    let policies;
    if (options.category) {
      policies = await memory.getCategoriesPolicies(options.category);
    } else {
      policies = await memory.getAllPolicies();
    }

    console.log('Active Policies:\n');
    for (const policy of policies) {
      const icon =
        policy.level === 'REQUIRED'
          ? '[REQUIRED]'
          : policy.level === 'RECOMMENDED'
            ? '[RECOMMENDED]'
            : '[OPTIONAL]';
      console.log(`  ${icon} ${policy.name} (${policy.category})`);
      console.log(`     ID: ${policy.id}`);
      console.log(`     Tags: ${policy.tags.join(', ') || 'None'}`);
      console.log(`     Tools: ${(policy.executableTools || []).join(', ') || 'None'}`);
      console.log('');
    }
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

program.parse();

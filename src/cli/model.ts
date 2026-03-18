/**
 * Model CLI Commands
 *
 * Commands for managing and using the multi-model architecture:
 * - uap model status - Show configured models and roles
 * - uap model route <task> - Analyze how a task would be routed
 * - uap model plan <task> - Create an execution plan for a task
 * - uap model compare - Compare cost/performance of different configurations
 */

import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import {
  createRouter,
  createPlanner,
  createExecutor,
  MockModelClient,
  ModelPresets,
  type MultiModelConfig,
} from '../models/index.js';
import { AgentContextConfig, MultiModelSchema } from '../types/config.js';

/**
 * Load UAP config from project root
 */
function loadConfig(): AgentContextConfig | null {
  const configPath = join(process.cwd(), '.uap.json');
  if (!existsSync(configPath)) {
    return null;
  }
  try {
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Get multi-model config with defaults
 */
function getMultiModelConfig(config: AgentContextConfig | null): MultiModelConfig {
  if (config?.multiModel) {
    return MultiModelSchema.parse(config.multiModel);
  }
  // Return default config
  return MultiModelSchema.parse({
    enabled: true,
    models: ['opus-4.6', 'qwen35'],
    roles: {
      planner: 'opus-4.6',
      executor: 'qwen35',
      fallback: 'qwen35',
    },
    routingStrategy: 'balanced',
  });
}

/**
 * Status command - show model configuration
 */
async function statusCommand(): Promise<void> {
  const config = loadConfig();
  const mmConfig = getMultiModelConfig(config);

  console.log(chalk.bold('\n=== Multi-Model Architecture Status ===\n'));

  console.log(`Enabled: ${mmConfig.enabled ? chalk.green('Yes') : chalk.yellow('No')}`);
  console.log(`Strategy: ${chalk.cyan(mmConfig.routingStrategy)}`);
  console.log();

  console.log(chalk.bold('Configured Models:'));
  const router = createRouter(mmConfig);
  for (const model of router.getAllModels()) {
    const costInfo =
      model.costPer1MInput && model.costPer1MOutput
        ? ` ($${model.costPer1MInput}/$${model.costPer1MOutput} per 1M tokens)`
        : '';
    console.log(`  - ${chalk.cyan(model.id)}: ${model.name}${costInfo}`);
    console.log(
      `    Provider: ${model.provider}, Context: ${model.maxContextTokens.toLocaleString()} tokens`
    );
    if (model.capabilities.length > 0) {
      console.log(`    Capabilities: ${model.capabilities.join(', ')}`);
    }
  }
  console.log();

  console.log(chalk.bold('Role Assignments:'));
  const roles = mmConfig.roles || {
    planner: 'opus-4.6',
    executor: 'qwen35',
    fallback: 'qwen35',
  };
  console.log(`  Planner:  ${chalk.green(roles.planner || 'opus-4.6')}`);
  console.log(`  Executor: ${chalk.blue(roles.executor || 'qwen35')}`);
  console.log(`  Reviewer: ${chalk.yellow(roles.reviewer || roles.planner || 'opus-4.6')}`);
  console.log(`  Fallback: ${chalk.red(roles.fallback || 'qwen35')}`);
  console.log();

  if (mmConfig.costOptimization?.enabled) {
    console.log(chalk.bold('Cost Optimization:'));
    console.log(`  Target Reduction: ${mmConfig.costOptimization.targetReduction}%`);
    console.log(
      `  Max Performance Degradation: ${mmConfig.costOptimization.maxPerformanceDegradation}%`
    );
    console.log(`  Fallback Threshold: ${mmConfig.costOptimization.fallbackThreshold} failures`);
    console.log();
  }

  console.log(chalk.bold('Available Presets:'));
  for (const [id, preset] of Object.entries(ModelPresets)) {
    console.log(`  ${chalk.cyan(id)}: ${preset.name} (${preset.provider})`);
  }
}

/**
 * Route command - analyze task routing
 */
async function routeCommand(task: string, options: { verbose?: boolean }): Promise<void> {
  const config = loadConfig();
  const mmConfig = getMultiModelConfig(config);
  const router = createRouter(mmConfig);

  console.log(chalk.bold('\n=== Task Routing Analysis ===\n'));
  console.log(`Task: "${chalk.cyan(task)}"\n`);

  const analysis = router.analyzeRouting(task);
  const classification = analysis.classification;

  console.log(chalk.bold('Classification:'));
  console.log(
    `  Complexity: ${getComplexityColor(classification.complexity)(classification.complexity.toUpperCase())}`
  );
  console.log(`  Task Type: ${chalk.blue(classification.taskType)}`);
  console.log(`  Keywords: ${classification.keywords.slice(0, 5).join(', ')}`);
  console.log(
    `  Requires Planning: ${classification.requiresPlanning ? chalk.green('Yes') : chalk.yellow('No')}`
  );
  console.log();

  console.log(chalk.bold('Model Selection:'));
  console.log(`  Selected: ${chalk.green(classification.suggestedModel)}`);
  console.log(`  Fallback: ${chalk.yellow(classification.fallbackModel || 'none')}`);
  console.log(`  Reasoning: ${classification.reasoning || 'No reasoning provided'}`);
  console.log();

  if (options.verbose) {
    console.log(chalk.bold('Matched Rules:'));
    for (const { rule, matched, reason } of analysis.matchedRules) {
      if (matched) {
        console.log(
          `  ${chalk.green('✓')} Priority ${rule.priority}: ${rule.targetRole} - ${reason}`
        );
      }
    }
    console.log();

    console.log(chalk.bold('Cost Comparison (est. 10K in / 5K out):'));
    for (const { model, cost } of analysis.costComparison) {
      console.log(`  ${model}: $${cost.toFixed(4)}`);
    }
  }
}

/**
 * Plan command - create execution plan
 */
async function planCommand(
  task: string,
  options: { verbose?: boolean; execute?: boolean }
): Promise<void> {
  const config = loadConfig();
  const mmConfig = getMultiModelConfig(config);
  const router = createRouter(mmConfig);
  const planner = createPlanner(router, mmConfig);

  console.log(chalk.bold('\n=== Execution Plan ===\n'));

  const plan = await planner.createPlan(task);
  console.log(planner.visualizePlan(plan));
  console.log();

  if (options.verbose) {
    console.log(chalk.bold('Subtask Details:'));
    for (const subtask of plan.subtasks) {
      console.log(`\n  ${chalk.cyan(subtask.title)}`);
      console.log(`    Type: ${subtask.type}, Complexity: ${subtask.complexity}`);
      console.log(`    Model: ${plan.modelAssignments.get(subtask.id) || 'unassigned'}`);
      console.log(`    Inputs: ${subtask.inputs?.join(', ') || 'none'}`);
      console.log(`    Outputs: ${subtask.outputs?.join(', ') || 'none'}`);
      if (subtask.constraints.length > 0) {
        console.log(`    Constraints:`);
        for (const c of subtask.constraints) {
          console.log(`      - ${c}`);
        }
      }
    }
  }

  if (options.execute) {
    console.log(chalk.bold('\n--- Executing Plan (mock mode) ---\n'));
    console.log(
      chalk.dim(
        'Note: Using MockModelClient. For real execution, configure API keys and use the programmatic API.\n'
      )
    );

    const client = new MockModelClient();
    const executor = createExecutor(router, mmConfig, client);

    const results = await executor.executePlan(plan, planner, (result) => {
      const icon = result.success ? chalk.green('✓') : chalk.red('✗');
      console.log(
        `  ${icon} ${result.subtaskId} [${result.modelUsed || 'unknown'}] ${result.success ? '' : `- ${result.error || 'unknown error'}`}`
      );
    });

    console.log();
    console.log(executor.generateSummary(plan.id));

    const failed = results.filter((r) => !r.success);
    if (failed.length > 0) {
      process.exitCode = 1;
    }
  }
}

/**
 * Compare command - compare configurations
 */
async function compareCommand(): Promise<void> {
  console.log(chalk.bold('\n=== Configuration Comparison ===\n'));

  // Sample task for comparison
  const sampleTask = 'Implement a new authentication system with OAuth2 support and JWT tokens';

  const configs: Array<{ name: string; config: MultiModelConfig }> = [
    {
      name: 'Performance First',
      config: {
        enabled: true,
        models: ['opus-4.5'],
        roles: { planner: 'opus-4.5', executor: 'opus-4.5', fallback: 'opus-4.5' },
        routingStrategy: 'performance-first',
      },
    },
    {
      name: 'Cost Optimized',
      config: {
        enabled: true,
        models: ['deepseek-v3.2', 'glm-4.7', 'opus-4.5'],
        roles: { planner: 'deepseek-v3.2', executor: 'glm-4.7', fallback: 'opus-4.5' },
        routingStrategy: 'cost-optimized',
        costOptimization: {
          enabled: true,
          targetReduction: 90,
          maxPerformanceDegradation: 20,
          fallbackThreshold: 3,
        },
      },
    },
    {
      name: 'Balanced',
      config: {
        enabled: true,
        models: ['opus-4.5', 'glm-4.7'],
        roles: { planner: 'opus-4.5', executor: 'glm-4.7', fallback: 'opus-4.5' },
        routingStrategy: 'balanced',
      },
    },
  ];

  console.log(`Sample Task: "${chalk.cyan(sampleTask)}"\n`);
  console.log('─'.repeat(80));
  console.log(
    `${'Configuration'.padEnd(20)} | ${'Planner'.padEnd(15)} | ${'Executor'.padEnd(15)} | ${'Est. Cost'.padEnd(12)} | Strategy`
  );
  console.log('─'.repeat(80));

  for (const { name, config } of configs) {
    const router = createRouter(config);
    const planner = createPlanner(router, config);
    const plan = await planner.createPlan(sampleTask);

    const plannerModel = config.roles?.planner || 'opus-4.5';
    const executorModel = config.roles?.executor || 'glm-4.7';

    console.log(
      `${name.padEnd(20)} | ` +
        `${plannerModel.padEnd(15)} | ` +
        `${executorModel.padEnd(15)} | ` +
        `$${plan.estimatedCost.toFixed(4).padEnd(10)} | ` +
        `${config.routingStrategy}`
    );
  }
  console.log('─'.repeat(80));
  console.log();

  // Show potential savings
  const perfRouter = createRouter(configs[0].config);
  const costRouter = createRouter(configs[1].config);
  const perfPlanner = createPlanner(perfRouter, configs[0].config);
  const costPlanner = createPlanner(costRouter, configs[1].config);

  const perfPlan = await perfPlanner.createPlan(sampleTask);
  const costPlan = await costPlanner.createPlan(sampleTask);

  const savings =
    ((perfPlan.estimatedCost - costPlan.estimatedCost) / perfPlan.estimatedCost) * 100;
  console.log(chalk.bold('Potential Savings:'));
  console.log(`  Cost Optimized vs Performance First: ${chalk.green(savings.toFixed(1) + '%')}`);
  console.log();
  console.log(chalk.dim('Note: Actual costs depend on real API usage. These are estimates.'));
}

/**
 * Helper to get color based on complexity
 */
function getComplexityColor(complexity: string): typeof chalk.red {
  switch (complexity) {
    case 'critical':
      return chalk.red;
    case 'high':
      return chalk.yellow;
    case 'medium':
      return chalk.blue;
    default:
      return chalk.green;
  }
}

/**
 * Presets command - list all available model presets
 */
async function presetsCommand(): Promise<void> {
  console.log(chalk.bold('\n=== Available Model Presets ===\n'));

  const presets = Object.entries(ModelPresets);
  for (const [id, _preset] of presets) {
    const preset = _preset;
    const costInfo =
      preset.costPer1MInput && preset.costPer1MOutput
        ? `($${preset.costPer1MInput}/$${preset.costPer1MOutput} per 1M)`
        : '(free/local)';

    console.log(chalk.cyan(`  ${id}:`));
    console.log(`    Name: ${chalk.white(preset.name)}`);
    console.log(`    Provider: ${chalk.yellow(preset.provider)}`);
    console.log(`    Context: ${preset.maxContextTokens.toLocaleString()} tokens`);
    console.log(`    Cost: ${costInfo}`);
    if (preset.capabilities.length > 0) {
      console.log(`    Capabilities: ${preset.capabilities.map((c) => chalk.green(c)).join(', ')}`);
    }
    console.log();
  }
}

/**
 * Select command - interactively select models for each role
 */
async function selectCommand(options: { save?: boolean }): Promise<void> {
  const config = loadConfig();
  const mmConfig = getMultiModelConfig(config);

  console.log(chalk.bold('\n=== Interactive Model Selection ===\n'));

  // Show current configuration
  console.log('Current Configuration:');
  const roles = mmConfig.roles || {
    planner: 'opus-4.6',
    executor: 'qwen35',
    fallback: 'qwen35',
  };
  console.log(`  Planner:  ${chalk.green(roles.planner)}`);
  console.log(`  Executor: ${chalk.blue(roles.executor)}`);
  console.log(`  Reviewer: ${chalk.yellow(roles.reviewer || roles.planner || 'opus-4.6')}`);
  console.log(`  Fallback: ${chalk.red(roles.fallback || 'qwen35')}`);
  console.log();

  // Show available presets
  console.log(chalk.bold('Available Presets:'));
  const presetIds = Object.keys(ModelPresets);
  for (let i = 0; i < presetIds.length; i++) {
    const id = presetIds[i];
    const name = ModelPresets[id].name;
    console.log(`  ${chalk.cyan(String(i + 1).padStart(2))} ${id.padEnd(20)} ${name}`);
  }
  console.log();

  const inquirerModule = await import('inquirer');
  const inquirer = inquirerModule as any;

  const answers: Record<string, string> = {};

  for (const role of ['planner', 'executor', 'reviewer', 'fallback'] as const) {
    const currentRole = roles[role] || 'opus-4.6';
    const answer = await inquirer.prompt([
      {
        type: 'list',
        name: role,
        message: `Select model for ${chalk.cyan(role)} role (current: ${currentRole}):`,
        choices: [
          ...presetIds.map((id, _idx) => ({
            name: `${id} (${ModelPresets[id].name})`,
            value: id,
            short: id,
          })),
          {
            name: `Keep current: ${currentRole}`,
            value: currentRole,
            short: currentRole,
          },
        ],
      },
    ]);

    answers[role] = answer[role];
  }

  // Ask for routing strategy
  const strategyAnswer = await inquirer.default.prompt([
    {
      type: 'list',
      name: 'strategy',
      message: 'Select routing strategy:',
      choices: [
        { name: 'balanced (default)', value: 'balanced' },
        { name: 'cost-optimized (cheapest capable)', value: 'cost-optimized' },
        { name: 'performance-first (best model)', value: 'performance-first' },
        { name: 'adaptive (learn from results)', value: 'adaptive' },
      ],
    },
  ]);

  answers.strategy = strategyAnswer.strategy;

  // Show preview of new configuration
  console.log();
  console.log(chalk.bold('\nNew Configuration Preview:'));
  console.log(`  Planner:  ${chalk.green(answers.planner)}`);
  console.log(`  Executor: ${chalk.blue(answers.executor)}`);
  console.log(`  Reviewer: ${chalk.yellow(answers.reviewer || answers.planner)}`);
  console.log(`  Fallback: ${chalk.red(answers.fallback)}`);
  console.log(`  Strategy: ${chalk.cyan(answers.strategy)}`);
  console.log();

  // Ask for confirmation
  const confirm = await inquirer.default.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Save this configuration?',
      default: false,
    },
  ]);

  if (confirm.confirm) {
    // Update config
    const updatedConfig: MultiModelConfig = {
      ...mmConfig,
      roles: {
        planner: answers.planner,
        executor: answers.executor,
        reviewer: answers.reviewer || answers.planner,
        fallback: answers.fallback,
      },
      routingStrategy: answers.strategy as any,
    };

    // Save to .uap.json if requested
    if (options.save) {
      try {
        const uapConfigPath = join(process.cwd(), '.uap.json');
        if (existsSync(uapConfigPath)) {
          const uapConfig = JSON.parse(readFileSync(uapConfigPath, 'utf-8'));
          uapConfig.multiModel = updatedConfig;
          writeFileSync(uapConfigPath, JSON.stringify(uapConfig, null, 2));
          console.log(chalk.green('\n✓ Configuration saved to .uap.json'));
        } else {
          console.warn('No .uap.json found. Use --save flag after init.');
        }
      } catch (err) {
        console.error(chalk.red(`Error saving config: ${err}`));
      }
    } else {
      console.log(chalk.yellow('\nConfiguration preview only. Use --save to persist.'));
    }
  } else {
    console.log(chalk.yellow('Configuration not saved.'));
  }
}

/**
 * Export command - export current configuration
 */
async function exportCommand(options: { format?: 'json' | 'yaml' }): Promise<void> {
  const config = loadConfig();
  const mmConfig = getMultiModelConfig(config);

  let output: string;

  if (options.format === 'yaml') {
    const yaml = await import('js-yaml');
    output = yaml.default.dump(mmConfig, { indent: 2 });
  } else {
    output = JSON.stringify(mmConfig, null, 2);
  }

  console.log(output);
}

/**
 * Health check command
 */
async function healthCommand(): Promise<void> {
  const config = loadConfig();
  const mmConfig = getMultiModelConfig(config);
  const router = createRouter(mmConfig);

  console.log(chalk.bold('\n=== Model Health Check ===\n'));

  let hasErrors = false;

  // Check assigned models exist
  const roles = mmConfig.roles || {};
  for (const [role, modelId] of Object.entries(roles) as Array<[string, string]>) {
    if (!router.getModel(modelId)) {
      console.error(`❌ ${chalk.red(role)}: Model '${modelId}' not found in configured models`);
      hasErrors = true;
    } else {
      const model = router.getModel(modelId)!;
      console.log(`✓ ${chalk.green(role)}: ${modelId} (${model.name}) - OK`);
    }
  }

  // Check models are configured
  console.log();
  console.log(chalk.bold('Configured Models:'));
  const allModels = router.getAllModels();
  if (allModels.length === 0) {
    console.error(`❌ No models configured!`);
    hasErrors = true;
  } else {
    for (const model of allModels) {
      console.log(`  ✓ ${model.id}: ${model.name}`);
    }
  }

  console.log();
  if (hasErrors) {
    console.log(chalk.red('\n⚠️ Health check failed. Fix configuration issues.'));
    process.exitCode = 1;
  } else {
    console.log(chalk.green('\n✓ All models configured correctly!'));
  }
}

/**
 * Register model commands
 */
export function registerModelCommands(program: Command): void {
  const model = program.command('model').description('Multi-model architecture management');

  model
    .command('status')
    .description('Show configured models and role assignments')
    .action(statusCommand);

  model
    .command('route <task>')
    .description('Analyze how a task would be routed')
    .option('-v, --verbose', 'Show detailed routing analysis')
    .action(routeCommand);

  model
    .command('plan <task>')
    .description('Create an execution plan for a task')
    .option('-v, --verbose', 'Show detailed subtask information')
    .option('-e, --execute', 'Execute the plan (requires API keys)')
    .action(planCommand);

  model
    .command('compare')
    .description('Compare cost/performance of different configurations')
    .action(compareCommand);

  model.command('presets').description('List all available model presets').action(presetsCommand);

  model
    .command('select')
    .description('Interactively select models for each role')
    .option('--save', 'Save configuration to .uap.json')
    .action(selectCommand);

  model
    .command('export')
    .description('Export current configuration')
    .option('-f, --format <format>', 'Output format (json, yaml)', 'json')
    .action(exportCommand);

  model
    .command('health')
    .description('Check model health and configuration validity')
    .action(healthCommand);
}

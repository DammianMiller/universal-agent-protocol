import chalk from 'chalk';
import ora from 'ora';
import { DeployBatcher } from '../coordination/deploy-batcher.js';
import { CoordinationService } from '../coordination/service.js';
import type { DeployActionType } from '../types/coordination.js';

type DeployAction = 'queue' | 'batch' | 'execute' | 'status' | 'flush';

interface DeployOptions {
  agentId?: string;
  actionType?: string;
  target?: string;
  message?: string;
  files?: string;
  remote?: string;
  force?: boolean;
  ref?: string;
  inputs?: string;
  priority?: string;
  batchId?: string;
  dryRun?: boolean;
  verbose?: boolean;
}

export async function deployCommand(action: DeployAction, options: DeployOptions = {}): Promise<void> {
  const batcher = new DeployBatcher({ dryRun: options.dryRun });

  switch (action) {
    case 'queue':
      await queueDeploy(batcher, options);
      break;
    case 'batch':
      await createBatch(batcher, options);
      break;
    case 'execute':
      await executeBatch(batcher, options);
      break;
    case 'status':
      await showDeployStatus(options);
      break;
    case 'flush':
      await flushAll(batcher, options);
      break;
  }
}

async function queueDeploy(batcher: DeployBatcher, options: DeployOptions): Promise<void> {
  const agentId = options.agentId;
  const actionType = options.actionType as DeployActionType;
  const target = options.target;

  if (!agentId || !actionType || !target) {
    console.error(chalk.red('Error: --agent-id, --action-type, and --target are required'));
    console.log(chalk.dim('Example: uap deploy queue --agent-id <id> --action-type commit --target main'));
    process.exit(1);
  }

  const spinner = ora(`Queueing ${actionType} action...`).start();

  try {
    // Build payload based on action type
    const payload = buildPayload(actionType, options);
    const priority = options.priority ? parseInt(options.priority, 10) : 5;

    const id = await batcher.queue(agentId, actionType, target, payload, { priority });
    
    spinner.succeed(`Queued ${actionType} action (ID: ${id})`);
    console.log(chalk.dim(`  Target: ${target}`));
    if (Object.keys(payload).length > 0) {
      console.log(chalk.dim(`  Payload: ${JSON.stringify(payload)}`));
    }
    console.log(chalk.dim('  Will be batched with other pending deploys'));
  } catch (error) {
    spinner.fail('Failed to queue deploy');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

function buildPayload(actionType: DeployActionType, options: DeployOptions): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  switch (actionType) {
    case 'commit':
      if (options.message) payload.message = options.message;
      if (options.files) payload.files = options.files.split(',').map((f) => f.trim());
      break;
    case 'push':
      if (options.remote) payload.remote = options.remote;
      if (options.force) payload.force = true;
      break;
    case 'merge':
      if (options.target) payload.source = options.target;
      break;
    case 'workflow':
      if (options.ref) payload.ref = options.ref;
      if (options.inputs) {
        try {
          payload.inputs = JSON.parse(options.inputs);
        } catch {
          console.error(chalk.red('Invalid JSON for --inputs'));
          process.exit(1);
        }
      }
      break;
    case 'deploy':
      // Custom deploy command
      break;
  }

  return payload;
}

async function createBatch(batcher: DeployBatcher, options: DeployOptions): Promise<void> {
  const spinner = ora('Creating batch from pending deploys...').start();

  try {
    const batch = await batcher.createBatch();

    if (!batch) {
      spinner.info('No pending deploys ready for batching');
      return;
    }

    spinner.succeed(`Batch created: ${batch.id.slice(0, 8)}...`);
    console.log(chalk.dim(`  Created: ${batch.createdAt}`));
    console.log(chalk.dim(`  Actions: ${batch.actions.length}`));

    if (options.verbose) {
      console.log(chalk.bold('\n  Actions:'));
      for (const action of batch.actions) {
        console.log(`    - ${action.actionType} → ${action.target}`);
        if (action.payload) {
          console.log(chalk.dim(`      ${JSON.stringify(action.payload)}`));
        }
      }
    }

    console.log(chalk.cyan(`\n  Execute with: uap deploy execute --batch-id ${batch.id}`));
  } catch (error) {
    spinner.fail('Failed to create batch');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

async function executeBatch(batcher: DeployBatcher, options: DeployOptions): Promise<void> {
  const batchId = options.batchId;

  if (!batchId) {
    console.error(chalk.red('Error: --batch-id is required'));
    process.exit(1);
  }

  // Check batch exists
  const batch = batcher.getBatch(batchId);
  if (!batch) {
    console.error(chalk.red(`Batch not found: ${batchId}`));
    process.exit(1);
  }

  const spinner = ora(`Executing batch ${batchId.slice(0, 8)}... (${batch.actions.length} actions)`).start();

  try {
    const result = await batcher.executeBatch(batchId);

    if (result.success) {
      spinner.succeed(`Batch executed successfully`);
    } else {
      spinner.warn(`Batch completed with errors`);
    }

    console.log(`  Executed: ${chalk.green(result.executedActions)}`);
    console.log(`  Failed: ${result.failedActions > 0 ? chalk.red(result.failedActions) : chalk.dim('0')}`);
    console.log(`  Duration: ${chalk.dim(result.duration + 'ms')}`);

    if (result.errors && result.errors.length > 0) {
      console.log(chalk.red('\n  Errors:'));
      for (const error of result.errors) {
        console.log(chalk.red(`    - ${error}`));
      }
    }
  } catch (error) {
    spinner.fail('Failed to execute batch');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

async function showDeployStatus(options: DeployOptions): Promise<void> {
  const spinner = ora('Loading deploy status...').start();

  try {
    const service = new CoordinationService();
    const status = service.getStatus();
    const batcher = new DeployBatcher();
    const pendingBatches = batcher.getPendingBatches();

    spinner.stop();

    console.log(chalk.bold('\n🚀 Deploy Status\n'));

    // Pending (not yet batched)
    console.log(chalk.bold.cyan('Pending Actions:'));
    if (status.pendingDeploys.length === 0) {
      console.log(chalk.dim('  No pending actions'));
    } else {
      const grouped = groupByType(status.pendingDeploys);
      for (const [type, actions] of grouped) {
        console.log(`  ${chalk.yellow(type)}: ${actions.length} action(s)`);
        if (options.verbose) {
          for (const action of actions) {
            console.log(chalk.dim(`    - ${action.target} (queued: ${action.queuedAt})`));
          }
        }
      }
    }
    console.log('');

    // Pending batches
    console.log(chalk.bold.cyan('Pending Batches:'));
    if (pendingBatches.length === 0) {
      console.log(chalk.dim('  No pending batches'));
    } else {
      for (const batch of pendingBatches) {
        console.log(`  ${chalk.blue(batch.id.slice(0, 8))}...`);
        console.log(chalk.dim(`    Created: ${batch.createdAt}`));
        console.log(chalk.dim(`    Actions: ${batch.actions.length}`));
      }
    }
    console.log('');

    // Summary
    const totalPending = status.pendingDeploys.length;
    const totalBatched = pendingBatches.reduce((sum, b) => sum + b.actions.length, 0);
    
    console.log(chalk.bold.cyan('Summary:'));
    console.log(`  Queued (unbatched): ${chalk.yellow(totalPending)}`);
    console.log(`  Batched (ready): ${chalk.blue(totalBatched)}`);
    console.log(`  Total pending: ${chalk.bold(totalPending + totalBatched)}`);
    console.log('');

    if (totalPending > 0) {
      console.log(chalk.dim('Run "uap deploy batch" to create a batch from pending actions'));
    }
    if (pendingBatches.length > 0) {
      console.log(chalk.dim(`Run "uap deploy execute --batch-id <id>" to execute a batch`));
    }
    if (totalPending > 0 || totalBatched > 0) {
      console.log(chalk.dim('Run "uap deploy flush" to execute all pending deploys'));
    }
  } catch (error) {
    spinner.fail('Failed to load status');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

async function flushAll(batcher: DeployBatcher, options: DeployOptions): Promise<void> {
  const spinner = ora('Flushing all pending deploys...').start();

  try {
    const results = await batcher.flushAll();

    if (results.length === 0) {
      spinner.info('No pending deploys to flush');
      return;
    }

    const totalExecuted = results.reduce((sum, r) => sum + r.executedActions, 0);
    const totalFailed = results.reduce((sum, r) => sum + r.failedActions, 0);
    const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

    if (totalFailed === 0) {
      spinner.succeed(`Flushed ${results.length} batch(es), ${totalExecuted} action(s)`);
    } else {
      spinner.warn(`Flushed with errors: ${totalExecuted} succeeded, ${totalFailed} failed`);
    }

    console.log(`  Total Duration: ${chalk.dim(totalDuration + 'ms')}`);

    if (options.verbose || totalFailed > 0) {
      for (const result of results) {
        console.log('');
        console.log(chalk.bold(`  Batch ${result.batchId.slice(0, 8)}...`));
        console.log(`    Executed: ${chalk.green(result.executedActions)}`);
        console.log(`    Failed: ${result.failedActions > 0 ? chalk.red(result.failedActions) : chalk.dim('0')}`);

        if (result.errors && result.errors.length > 0) {
          console.log(chalk.red('    Errors:'));
          for (const error of result.errors) {
            console.log(chalk.red(`      - ${error}`));
          }
        }
      }
    }
  } catch (error) {
    spinner.fail('Failed to flush deploys');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

function groupByType(deploys: Array<{ actionType: string; target?: string; queuedAt?: string }>): Map<string, typeof deploys> {
  const groups = new Map<string, typeof deploys>();
  for (const deploy of deploys) {
    const existing = groups.get(deploy.actionType) || [];
    existing.push(deploy);
    groups.set(deploy.actionType, existing);
  }
  return groups;
}

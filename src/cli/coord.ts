import chalk from 'chalk';
import ora from 'ora';
import { CoordinationService } from '../coordination/service.js';
import { DeployBatcher } from '../coordination/deploy-batcher.js';
import { statusBadge, divider, keyValue, horizontalBarChart, bulletList } from './visualize.js';

type CoordAction = 'status' | 'flush' | 'cleanup';

interface CoordOptions {
  verbose?: boolean;
}

export async function coordCommand(action: CoordAction, options: CoordOptions = {}): Promise<void> {
  switch (action) {
    case 'status':
      await showStatus(options);
      break;
    case 'flush':
      await flushDeploys(options);
      break;
    case 'cleanup':
      await cleanupCoordination(options);
      break;
  }
}

async function showStatus(options: CoordOptions): Promise<void> {
  const spinner = ora('Loading coordination status...').start();

  try {
    const service = new CoordinationService();
    const status = service.getStatus();
    spinner.stop();

    console.log('');
    console.log(chalk.bold.cyan('  Coordination Status'));
    console.log(divider(50));
    console.log('');

    // Active agents
    console.log(chalk.bold('  Agents'));
    if (status.activeAgents.length === 0) {
      console.log(chalk.dim('  No active agents'));
    } else {
      for (const line of bulletList(
        status.activeAgents.map(a => ({
          text: `${chalk.cyan(chalk.bold(a.name))} ${statusBadge(a.status)}${a.currentTask ? chalk.dim(` ${a.currentTask}`) : ''}`,
          status: a.status === 'active' ? 'ok' as const : 'warn' as const,
        }))
      )) console.log(line);

      if (options.verbose) {
        for (const agent of status.activeAgents) {
          console.log(chalk.dim(`    ${agent.name}: started ${agent.startedAt}, beat ${agent.lastHeartbeat}`));
        }
      }
    }
    console.log('');

    // Resource claims
    console.log(chalk.bold('  Resource Claims'));
    if (status.activeClaims.length === 0) {
      console.log(chalk.dim('  No active claims'));
    } else {
      for (const claim of status.activeClaims) {
        const lockBadge = claim.claimType === 'exclusive' ? chalk.red('EXCL') : chalk.green('SHARED');
        console.log(`  ${lockBadge} ${chalk.yellow(claim.resource)} ${chalk.dim(`by ${claim.agentId.slice(0, 8)}...`)}`);
      }
    }
    console.log('');

    // Pending deploys
    console.log(chalk.bold('  Deploy Queue'));
    if (status.pendingDeploys.length === 0) {
      console.log(chalk.dim('  No pending deploys'));
    } else {
      const grouped = new Map<string, number>();
      for (const d of status.pendingDeploys) {
        grouped.set(d.actionType, (grouped.get(d.actionType) || 0) + 1);
      }
      for (const line of horizontalBarChart(
        [...grouped.entries()].map(([type, count]) => ({
          label: type,
          value: count,
          color: chalk.yellow,
        })),
        { maxWidth: 20, maxLabelWidth: 12 }
      )) console.log(line);
    }
    console.log('');

    // Summary
    for (const line of keyValue([
      ['Agents', status.activeAgents.length],
      ['Claims', status.activeClaims.length],
      ['Pending Deploys', status.pendingDeploys.length],
      ['Unread Messages', status.pendingMessages],
    ])) console.log(line);
    console.log('');
  } catch (error) {
    spinner.fail('Failed to load status');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  }
}

async function flushDeploys(_options: CoordOptions): Promise<void> {
  const spinner = ora('Flushing all pending deploys...').start();

  try {
    const batcher = new DeployBatcher();
    const results = await batcher.flushAll();

    if (results.length === 0) {
      spinner.info('No pending deploys to flush');
      return;
    }

    spinner.succeed(`Flushed ${results.length} batch(es)`);

    for (const result of results) {
      console.log('');
      console.log(chalk.bold(`Batch ${result.batchId.slice(0, 8)}...`));
      console.log(`  Executed: ${chalk.green(result.executedActions)}`);
      console.log(`  Failed: ${result.failedActions > 0 ? chalk.red(result.failedActions) : chalk.dim('0')}`);
      console.log(`  Duration: ${chalk.dim(result.duration + 'ms')}`);

      if (result.errors && result.errors.length > 0) {
        console.log(chalk.red('  Errors:'));
        for (const error of result.errors) {
          console.log(chalk.red(`    - ${error}`));
        }
      }
    }
  } catch (error) {
    spinner.fail('Failed to flush deploys');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  }
}

async function cleanupCoordination(_options: CoordOptions): Promise<void> {
  const spinner = ora('Cleaning up stale coordination data...').start();

  try {
    const service = new CoordinationService();
    
    // Cleanup stale agents
    const staleCount = service.cleanupStaleAgents();
    
    // General cleanup
    service.cleanup();

    spinner.succeed(`Cleanup complete`);
    console.log(chalk.dim(`  Marked ${staleCount} stale agent(s) as failed`));
    console.log(chalk.dim('  Removed expired claims, old messages, and completed entries'));
  } catch (error) {
    spinner.fail('Cleanup failed');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  }
}



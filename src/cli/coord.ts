import chalk from 'chalk';
import ora from 'ora';
import { CoordinationService } from '../coordination/service.js';
import { DeployBatcher } from '../coordination/deploy-batcher.js';
import type { WorkOverlap } from '../types/coordination.js';
import { statusBadge, divider, keyValue, horizontalBarChart, bulletList } from './visualize.js';

type CoordAction = 'status' | 'flush' | 'cleanup' | 'check' | 'resolve';

interface CoordOptions {
  verbose?: boolean;
  agents?: string;
  resource?: string;
  json?: boolean;
  overlapId?: string;
  action?: string;
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
    case 'check':
      await checkCoordination(options);
      break;
    case 'resolve':
      await resolveOverlap(options);
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

async function checkCoordination(options: CoordOptions): Promise<void> {
  const service = new CoordinationService();
  const activeWork = service.getActiveWork();
  const agentFilter = options.agents
    ? options.agents.split(',').map((agent) => agent.trim().toLowerCase())
    : [];

  const scopedWork = activeWork.filter((work) => {
    if (agentFilter.length === 0) return true;
    const name = work.agentName?.toLowerCase() || '';
    const id = work.agentId.toLowerCase();
    return agentFilter.includes(id) || agentFilter.includes(name);
  });

  const resourceFilter = options.resource;
  const resources = new Set(
    scopedWork
      .filter((work) => (resourceFilter ? work.resource.includes(resourceFilter) : true))
      .map((work) => work.resource)
  );

  const overlaps: WorkOverlap[] = [];
  for (const resource of resources) {
    overlaps.push(...service.detectOverlaps(resource));
  }

  if (options.json) {
    console.log(JSON.stringify({ overlaps }, null, 2));
    return;
  }

  if (overlaps.length === 0) {
    console.log(chalk.green('No overlaps detected'));
    return;
  }

  console.log(chalk.bold('\nCoordination Overlaps\n'));
  overlaps.forEach((overlap, index) => {
    const risk = overlap.conflictRisk.toUpperCase();
    console.log(`${chalk.cyan(`[${index + 1}]`)} ${overlap.resource} (${risk})`);
    overlap.agents.forEach((agent) => {
      console.log(`  - ${agent.name || agent.id} (${agent.intentType})`);
    });
    if (overlap.suggestion) {
      console.log(chalk.dim(`  Suggestion: ${overlap.suggestion}`));
    }
    console.log('');
  });
}

async function resolveOverlap(options: CoordOptions): Promise<void> {
  const overlapId = options.overlapId;
  if (!overlapId) {
    console.error(chalk.red('Error: overlapId is required'));
    process.exit(1);
  }

  const service = new CoordinationService();
  const overlaps = service.detectOverlaps(overlapId);
  if (overlaps.length === 0) {
    console.log(chalk.yellow(`No overlaps found for resource: ${overlapId}`));
    return;
  }

  const action = options.action || 'merge';
  const payload = {
    action,
    resource: overlapId,
    overlaps,
    suggestion: overlaps.map((o) => o.suggestion).filter(Boolean),
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  service.broadcast('coordination-cli', 'coordination', payload, 6);
  console.log(chalk.green(`Resolution '${action}' broadcast for ${overlapId}`));
}



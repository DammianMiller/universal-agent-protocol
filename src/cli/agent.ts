import chalk from 'chalk';
import ora from 'ora';
import { CoordinationService } from '../coordination/service.js';
import type { MessageChannel, MessagePayload, WorkIntentType } from '../types/coordination.js';
import { statusBadge, divider, keyValue, bulletList } from './visualize.js';

type AgentAction = 'register' | 'heartbeat' | 'status' | 'announce' | 'complete' | 'overlaps' | 'broadcast' | 'send' | 'receive' | 'deregister';

interface AgentOptions {
  id?: string;
  name?: string;
  capabilities?: string;
  worktree?: string;
  resource?: string;
  intent?: string;
  description?: string;
  files?: string;
  minutes?: string;
  channel?: string;
  message?: string;
  to?: string;
  priority?: string;
  markRead?: boolean;
}

export async function agentCommand(action: AgentAction, options: AgentOptions = {}): Promise<void> {
  const service = new CoordinationService();

  switch (action) {
    case 'register':
      await registerAgent(service, options);
      break;
    case 'heartbeat':
      await heartbeatAgent(service, options);
      break;
    case 'status':
      await showAgentStatus(service, options);
      break;
    case 'announce':
      await announceWork(service, options);
      break;
    case 'complete':
      await completeWork(service, options);
      break;
    case 'overlaps':
      await showOverlaps(service, options);
      break;
    case 'broadcast':
      await broadcastMessage(service, options);
      break;
    case 'send':
      await sendMessage(service, options);
      break;
    case 'receive':
      await receiveMessages(service, options);
      break;
    case 'deregister':
      await deregisterAgent(service, options);
      break;
  }
}

async function registerAgent(service: CoordinationService, options: AgentOptions): Promise<void> {
  const name = options.name;
  if (!name) {
    console.error(chalk.red('Error: --name is required for register'));
    process.exit(1);
  }

  const capabilities = options.capabilities?.split(',').map((c) => c.trim());
  const worktree = options.worktree;
  const spinner = ora(`Registering agent: ${name}...`).start();

  try {
    const id = service.register(name, capabilities, worktree);
    spinner.succeed(`Agent registered: ${name}`);
    console.log(chalk.bold.green(`AGENT_ID=${id}`));
    if (worktree) {
      console.log(chalk.dim(`Worktree branch: ${worktree}`));
    }
    console.log(chalk.dim('Use this ID for subsequent agent commands'));
    console.log('');
    console.log(chalk.cyan('Next steps:'));
    console.log(chalk.dim('  1. Announce your work: uap agent announce --id <id> --resource <file> --intent editing'));
    console.log(chalk.dim('  2. Check for overlaps: uap agent overlaps --resource <file>'));
    console.log(chalk.dim('  3. When done: uap agent complete --id <id> --resource <file>'));
  } catch (error) {
    spinner.fail('Failed to register agent');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

async function heartbeatAgent(service: CoordinationService, options: AgentOptions): Promise<void> {
  const id = options.id;
  if (!id) {
    console.error(chalk.red('Error: --id is required for heartbeat'));
    process.exit(1);
  }

  try {
    service.heartbeat(id);
    console.log(chalk.green('Heartbeat sent'));
  } catch (error) {
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

async function showAgentStatus(service: CoordinationService, options: AgentOptions): Promise<void> {
  const id = options.id;
  
  if (id) {
    const agent = service.getAgent(id);
    if (!agent) {
      console.error(chalk.red(`Agent not found: ${id}`));
      process.exit(1);
    }

    console.log('');
    console.log(chalk.bold.cyan('  Agent Status'));
    console.log(divider(50));
    console.log('');

    for (const line of keyValue([
      ['ID', agent.id],
      ['Name', agent.name],
      ['Status', ''],
    ])) console.log(line);
    console.log(`  ${'Status'.padEnd(18)} ${statusBadge(agent.status)}`);

    if (agent.currentTask) {
      for (const line of keyValue([['Task', agent.currentTask]])) console.log(line);
    }
    for (const line of keyValue([
      ['Started', agent.startedAt],
      ['Last Heartbeat', agent.lastHeartbeat],
    ])) console.log(line);
    if (agent.capabilities && agent.capabilities.length > 0) {
      for (const line of keyValue([['Capabilities', agent.capabilities.join(', ')]])) console.log(line);
    }

    const claims = service.getAgentClaims(id);
    if (claims.length > 0) {
      console.log('');
      console.log(chalk.bold('  Resource Claims:'));
      for (const line of bulletList(
        claims.map(c => ({
          text: `${chalk.yellow(c.resource)} ${chalk.dim(`(${c.claimType})`)}`,
          status: c.claimType === 'exclusive' ? 'warn' as const : 'ok' as const,
        }))
      )) console.log(line);
    }

    const pending = service.getPendingMessages(id);
    console.log('');
    for (const line of keyValue([['Pending Messages', pending]])) console.log(line);
  } else {
    const agents = service.getActiveAgents();
    const activeWork = service.getActiveWork();

    console.log('');
    console.log(chalk.bold.cyan('  Active Agents'));
    console.log(divider(50));
    console.log('');
    
    if (agents.length === 0) {
      console.log(chalk.dim('  No active agents'));
    } else {
      for (const agent of agents) {
        console.log(`  ${statusBadge(agent.status)} ${chalk.cyan(chalk.bold(agent.name))} ${chalk.dim(`(${agent.id.slice(0, 8)}...)`)}`);
        if (agent.currentTask) {
          console.log(chalk.dim(`     Task: ${agent.currentTask}`));
        }
      }
    }

    if (activeWork.length > 0) {
      console.log('');
      console.log(chalk.bold('  Active Work:'));
      const grouped = new Map<string, typeof activeWork>();
      for (const work of activeWork) {
        const existing = grouped.get(work.resource) || [];
        existing.push(work);
        grouped.set(work.resource, existing);
      }
      for (const [resource, works] of grouped) {
        const conflict = works.length > 1;
        const icon = conflict ? chalk.red('!!') : chalk.green('OK');
        console.log(`  ${icon} ${chalk.bold(resource)}`);
        for (const w of works) {
          console.log(`     ${chalk.cyan(w.agentName || w.agentId.slice(0, 8))} ${chalk.dim(w.intentType)}`);
        }
      }
    }

    console.log('');
    for (const line of keyValue([
      ['Total Agents', agents.length],
      ['Active Work', activeWork.length],
    ])) console.log(line);
  }
  console.log('');
}

async function announceWork(service: CoordinationService, options: AgentOptions): Promise<void> {
  const id = options.id;
  const resource = options.resource;
  const intent = options.intent as WorkIntentType;

  if (!id || !resource || !intent) {
    console.error(chalk.red('Error: --id, --resource, and --intent are required'));
    console.log(chalk.dim('Intent types: editing, reviewing, refactoring, testing, documenting'));
    process.exit(1);
  }

  const validIntents: WorkIntentType[] = ['editing', 'reviewing', 'refactoring', 'testing', 'documenting'];
  if (!validIntents.includes(intent)) {
    console.error(chalk.red(`Invalid intent: ${intent}`));
    console.log(chalk.dim('Valid intents: ' + validIntents.join(', ')));
    process.exit(1);
  }

  const spinner = ora(`Announcing work on: ${resource}...`).start();

  try {
    const filesAffected = options.files?.split(',').map((f) => f.trim());
    const estimatedMinutes = options.minutes ? parseInt(options.minutes, 10) : undefined;

    const { announcement, overlaps, suggestions } = service.announceWork(id, resource, intent, {
      description: options.description,
      filesAffected,
      estimatedMinutes,
    });

    spinner.succeed(`Work announced: ${intent} on ${resource}`);
    console.log(chalk.dim(`  Announcement ID: ${announcement.id}`));
    
    if (overlaps.length === 0) {
      console.log(`\n  ${chalk.bgGreen.black(' CLEAR ')} No overlapping work detected`);
    } else {
      console.log(chalk.yellow(`\n  ⚠️  Overlapping work detected (${overlaps.length}):`));
      
      for (const overlap of overlaps) {
        console.log(`\n  ${getRiskBadge(overlap.conflictRisk)} ${overlap.resource}`);
        
        for (const agent of overlap.agents) {
          console.log(chalk.dim(`    - ${agent.name || agent.id.slice(0, 8)} (${agent.intentType})`));
          if (agent.worktreeBranch) {
            console.log(chalk.dim(`      Branch: ${agent.worktreeBranch}`));
          }
          if (agent.description) {
            console.log(chalk.dim(`      "${agent.description}"`));
          }
        }
        
        console.log(chalk.cyan(`    Suggestion: ${overlap.suggestion}`));
      }

      if (suggestions.length > 0) {
        console.log(chalk.bold('\n  Collaboration Suggestions:'));
        for (const suggestion of suggestions) {
          console.log(`    ${chalk.cyan(suggestion.type)}: ${suggestion.reason}`);
          if (suggestion.suggestedOrder) {
            console.log(chalk.dim(`      Suggested merge order: ${suggestion.suggestedOrder.join(' → ')}`));
          }
        }
      }
    }
  } catch (error) {
    spinner.fail('Failed to announce work');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

async function completeWork(service: CoordinationService, options: AgentOptions): Promise<void> {
  const id = options.id;
  const resource = options.resource;

  if (!id || !resource) {
    console.error(chalk.red('Error: --id and --resource are required'));
    process.exit(1);
  }

  try {
    service.completeWork(id, resource);
    console.log(chalk.green(`Work completed: ${resource}`));
    console.log(chalk.dim('Other agents have been notified. They can now safely merge.'));
  } catch (error) {
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

async function showOverlaps(service: CoordinationService, options: AgentOptions): Promise<void> {
  const resource = options.resource;

  if (!resource) {
    const activeWork = service.getActiveWork();
    
    console.log('');
    console.log(chalk.bold.cyan('  Active Work'));
    console.log(divider(50));
    console.log('');
    
    if (activeWork.length === 0) {
      console.log(chalk.dim('  No active work announcements'));
      console.log('');
      return;
    }

    const grouped = new Map<string, typeof activeWork>();
    for (const work of activeWork) {
      const existing = grouped.get(work.resource) || [];
      existing.push(work);
      grouped.set(work.resource, existing);
    }

    let conflicts = 0;
    for (const [res, works] of grouped) {
      const hasMultiple = works.length > 1;
      if (hasMultiple) conflicts++;
      const riskBadge = hasMultiple
        ? chalk.bgRed.white(' CONFLICT ')
        : chalk.bgGreen.black(' CLEAR ');
      console.log(`  ${riskBadge} ${chalk.bold(res)}`);
      
      for (const work of works) {
        console.log(`    ${chalk.cyan(work.agentName || work.agentId.slice(0, 8))} ${chalk.dim(work.intentType)}`);
        if (work.worktreeBranch) {
          console.log(chalk.dim(`      Branch: ${work.worktreeBranch}`));
        }
        if (work.description) {
          console.log(chalk.dim(`      "${work.description}"`));
        }
      }
      console.log('');
    }

    for (const line of keyValue([
      ['Resources', grouped.size],
      ['Workers', activeWork.length],
      ['Conflicts', conflicts > 0 ? chalk.red(String(conflicts)) as unknown as number : 0],
    ])) console.log(line);
    console.log('');
  } else {
    const overlaps = service.detectOverlaps(resource);
    
    console.log('');
    console.log(chalk.bold.cyan(`  Overlap Check: ${resource}`));
    console.log(divider(50));
    console.log('');

    if (overlaps.length === 0) {
      console.log(`  ${chalk.bgGreen.black(' CLEAR ')} No overlapping work detected`);
      console.log(chalk.dim('  Safe to proceed with your changes'));
      console.log('');
      return;
    }

    for (const overlap of overlaps) {
      const riskBadge = getRiskBadge(overlap.conflictRisk);
      console.log(`  ${riskBadge} ${chalk.bold(overlap.resource)}`);
      
      for (const agent of overlap.agents) {
        console.log(`    ${chalk.cyan(agent.name || agent.id.slice(0, 8))} ${chalk.dim(`(${agent.intentType})`)}`);
        if (agent.worktreeBranch) {
          console.log(chalk.dim(`      Branch: ${agent.worktreeBranch}`));
        }
      }
      
      console.log(chalk.yellow(`    ${overlap.suggestion}`));
      console.log('');
    }
  }
}

function getRiskBadge(risk: string): string {
  switch (risk) {
    case 'critical':
      return chalk.bgRed.white(' CRITICAL ');
    case 'high':
      return chalk.bgRed.white(' HIGH ');
    case 'medium':
      return chalk.bgYellow.black(' MEDIUM ');
    case 'low':
      return chalk.bgGreen.black(' LOW ');
    default:
      return chalk.dim(`[${risk}]`);
  }
}

async function broadcastMessage(service: CoordinationService, options: AgentOptions): Promise<void> {
  const id = options.id;
  const channel = options.channel as MessageChannel;
  const message = options.message;

  if (!id || !channel || !message) {
    console.error(chalk.red('Error: --id, --channel, and --message are required for broadcast'));
    process.exit(1);
  }

  try {
    let payload: MessagePayload;
    try {
      payload = JSON.parse(message);
    } catch {
      payload = { action: 'notification', data: message };
    }

    const priority = options.priority ? parseInt(options.priority, 10) : 5;
    service.broadcast(id, channel, payload, priority);
    console.log(chalk.green(`Broadcast sent to channel: ${channel}`));
  } catch (error) {
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

async function sendMessage(service: CoordinationService, options: AgentOptions): Promise<void> {
  const id = options.id;
  const to = options.to;
  const message = options.message;

  if (!id || !to || !message) {
    console.error(chalk.red('Error: --id, --to, and --message are required for send'));
    process.exit(1);
  }

  try {
    let payload: MessagePayload;
    try {
      payload = JSON.parse(message);
    } catch {
      payload = { action: 'message', data: message };
    }

    const priority = options.priority ? parseInt(options.priority, 10) : 5;
    service.send(id, to, payload, priority);
    console.log(chalk.green(`Message sent to: ${to.slice(0, 8)}...`));
  } catch (error) {
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

async function receiveMessages(service: CoordinationService, options: AgentOptions): Promise<void> {
  const id = options.id;

  if (!id) {
    console.error(chalk.red('Error: --id is required for receive'));
    process.exit(1);
  }

  try {
    const channel = options.channel as MessageChannel | undefined;
    const markRead = options.markRead !== false;
    const messages = service.receive(id, channel, markRead);

    if (messages.length === 0) {
      console.log(chalk.dim('No pending messages'));
      return;
    }

    console.log(chalk.bold(`\n📬 Messages (${messages.length})\n`));
    
    for (const msg of messages) {
      const fromLabel = msg.fromAgent ? msg.fromAgent.slice(0, 8) + '...' : 'system';
      console.log(`  [${chalk.cyan(msg.channel)}] ${chalk.dim(fromLabel)} → ${msg.type}`);
      console.log(`    ${chalk.yellow(JSON.stringify(msg.payload))}`);
      console.log(`    ${chalk.dim(msg.createdAt)}`);
      console.log('');
    }
  } catch (error) {
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

async function deregisterAgent(service: CoordinationService, options: AgentOptions): Promise<void> {
  const id = options.id;

  if (!id) {
    console.error(chalk.red('Error: --id is required for deregister'));
    process.exit(1);
  }

  try {
    service.deregister(id);
    console.log(chalk.green('Agent deregistered'));
  } catch (error) {
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}



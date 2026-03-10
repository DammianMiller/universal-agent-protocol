import chalk from 'chalk';
import ora from 'ora';
import { TaskService } from '../tasks/service.js';
import { TaskCoordinator } from '../tasks/coordination.js';
import { CoordinationService } from '../coordination/service.js';
import type {
  TaskType,
  TaskStatus,
  TaskPriority,
  DependencyType,
  TaskFilter,
  CreateTaskInput,
  UpdateTaskInput,
} from '../tasks/types.js';
import { STATUS_ICONS, TYPE_ICONS, PRIORITY_LABELS } from '../tasks/types.js';
import {
  progressBar,
  stackedBar,
  stackedBarLegend,
  horizontalBarChart,
  sectionHeader,
  miniGauge,
  divider,
  inlineProgressSummary,
  type BarSegment,
} from './visualize.js';

type TaskAction =
  | 'create'
  | 'list'
  | 'show'
  | 'update'
  | 'close'
  | 'delete'
  | 'ready'
  | 'blocked'
  | 'dep'
  | 'undep'
  | 'claim'
  | 'release'
  | 'stats'
  | 'sync'
  | 'compact';

interface TaskOptions {
  // Create options
  title?: string;
  description?: string;
  type?: string;
  priority?: string;
  labels?: string;
  parent?: string;
  notes?: string;

  // Update options
  status?: string;
  assignee?: string;
  worktree?: string;

  // List/filter options
  filterStatus?: string;
  filterType?: string;
  filterPriority?: string;
  filterAssignee?: string;
  filterLabels?: string;
  search?: string;
  showBlocked?: boolean;
  showReady?: boolean;

  // Dependency options
  from?: string;
  to?: string;
  depType?: string;

  // Close options
  reason?: string;

  // Claim options
  branch?: string;

  // Compact options
  days?: string;

  // General
  id?: string;
  verbose?: boolean;
  json?: boolean;
}

export async function taskCommand(action: TaskAction, options: TaskOptions = {}): Promise<void> {
  const service = new TaskService();

  switch (action) {
    case 'create':
      await createTask(service, options);
      break;
    case 'list':
      await listTasks(service, options);
      break;
    case 'show':
      await showTask(service, options);
      break;
    case 'update':
      await updateTask(service, options);
      break;
    case 'close':
      await closeTask(service, options);
      break;
    case 'delete':
      await deleteTask(service, options);
      break;
    case 'ready':
      await showReady(service, options);
      break;
    case 'blocked':
      await showBlocked(service, options);
      break;
    case 'dep':
      await addDependency(service, options);
      break;
    case 'undep':
      await removeDependency(service, options);
      break;
    case 'claim':
      await claimTask(service, options);
      break;
    case 'release':
      await releaseTask(service, options);
      break;
    case 'stats':
      await showStats(service, options);
      break;
    case 'sync':
      await syncTasks(service, options);
      break;
    case 'compact':
      await compactTasks(service, options);
      break;
  }
}

async function createTask(service: TaskService, options: TaskOptions): Promise<void> {
  if (!options.title) {
    console.error(chalk.red('Error: --title is required'));
    process.exit(1);
  }

  const spinner = ora('Creating task...').start();

  try {
    const input: CreateTaskInput = {
      title: options.title,
      description: options.description,
      type: (options.type as TaskType) || 'task',
      priority: options.priority ? parseInt(options.priority, 10) as TaskPriority : 2,
      labels: options.labels ? options.labels.split(',').map(l => l.trim()) : [],
      parentId: options.parent,
      notes: options.notes,
    };

    const task = service.create(input);
    spinner.succeed(`Task created: ${task.id}`);

    console.log('');
    console.log(`  ${TYPE_ICONS[task.type]} ${chalk.bold(task.title)}`);
    console.log(`  ID: ${chalk.cyan(task.id)}`);
    console.log(`  Type: ${task.type}`);
    console.log(`  Priority: ${PRIORITY_LABELS[task.priority]}`);
    if (task.labels.length > 0) {
      console.log(`  Labels: ${task.labels.join(', ')}`);
    }
    if (task.parentId) {
      console.log(`  Parent: ${task.parentId}`);
    }

    if (options.json) {
      console.log(JSON.stringify(task, null, 2));
    }

    for (const line of inlineProgressSummary(service.getStats())) console.log(line);
  } catch (error) {
    spinner.fail('Failed to create task');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

async function listTasks(service: TaskService, options: TaskOptions): Promise<void> {
  const filter: TaskFilter = {};

  if (options.filterStatus) {
    filter.status = options.filterStatus.split(',') as TaskStatus[];
  }
  if (options.filterType) {
    filter.type = options.filterType.split(',') as TaskType[];
  }
  if (options.filterPriority) {
    filter.priority = options.filterPriority.split(',').map(p => parseInt(p, 10)) as TaskPriority[];
  }
  if (options.filterAssignee) {
    filter.assignee = options.filterAssignee;
  }
  if (options.filterLabels) {
    filter.labels = options.filterLabels.split(',').map(l => l.trim());
  }
  if (options.search) {
    filter.search = options.search;
  }
  if (options.showBlocked) {
    filter.isBlocked = true;
  }
  if (options.showReady) {
    filter.isReady = true;
  }

  const tasks = service.list(filter);

  if (options.json) {
    console.log(JSON.stringify(tasks, null, 2));
    return;
  }

  if (tasks.length === 0) {
    console.log(chalk.dim('No tasks found'));
    return;
  }

  console.log(chalk.bold(`\nTasks (${tasks.length})\n`));

  for (const task of tasks) {
    const statusIcon = STATUS_ICONS[task.status];
    const typeIcon = TYPE_ICONS[task.type];
    const priorityColor = getPriorityColor(task.priority);

    console.log(
      `  ${statusIcon} ${priorityColor(`P${task.priority}`)} ${typeIcon} ` +
      `${chalk.cyan(task.id)} ${task.title}`
    );

    if (options.verbose) {
      if (task.assignee) {
        console.log(chalk.dim(`    Assignee: ${task.assignee}`));
      }
      if (task.labels.length > 0) {
        console.log(chalk.dim(`    Labels: ${task.labels.join(', ')}`));
      }
    }
  }
  console.log('');
}

async function showTask(service: TaskService, options: TaskOptions): Promise<void> {
  if (!options.id) {
    console.error(chalk.red('Error: --id is required'));
    process.exit(1);
  }

  const task = service.getWithRelations(options.id);
  if (!task) {
    console.error(chalk.red(`Task not found: ${options.id}`));
    process.exit(1);
  }

  if (options.json) {
    console.log(JSON.stringify(task, null, 2));
    return;
  }

  const statusIcon = STATUS_ICONS[task.status];
  const typeIcon = TYPE_ICONS[task.type];
  const priorityColor = getPriorityColor(task.priority);

  console.log('');
  console.log(`${statusIcon} ${priorityColor(`P${task.priority}`)} ${typeIcon} ${chalk.bold(task.title)}`);
  console.log(chalk.dim('─'.repeat(60)));
  console.log(`ID: ${chalk.cyan(task.id)}`);
  console.log(`Status: ${task.status}${task.isBlocked ? chalk.red(' (BLOCKED)') : ''}${task.isReady ? chalk.green(' (READY)') : ''}`);
  console.log(`Type: ${task.type}`);
  console.log(`Priority: ${PRIORITY_LABELS[task.priority]}`);

  if (task.assignee) {
    console.log(`Assignee: ${task.assignee}`);
  }
  if (task.worktreeBranch) {
    console.log(`Worktree: ${task.worktreeBranch}`);
  }
  if (task.labels.length > 0) {
    console.log(`Labels: ${task.labels.join(', ')}`);
  }
  if (task.parentId) {
    console.log(`Parent: ${task.parentId}`);
  }

  if (task.description) {
    console.log('');
    console.log(chalk.bold('Description:'));
    console.log(task.description);
  }

  if (task.notes) {
    console.log('');
    console.log(chalk.bold('Notes:'));
    console.log(task.notes);
  }

  // Dependencies
  if (task.blockedBy.length > 0) {
    console.log('');
    console.log(chalk.bold('Blocked by:'));
    for (const blockerId of task.blockedBy) {
      const blocker = service.get(blockerId);
      if (blocker) {
        const blockerStatus = STATUS_ICONS[blocker.status];
        const done = blocker.status === 'done' || blocker.status === 'wont_do';
        console.log(`  ${blockerStatus} ${done ? chalk.dim(blockerId) : chalk.red(blockerId)}: ${blocker.title}`);
      }
    }
  }

  if (task.blocks.length > 0) {
    console.log('');
    console.log(chalk.bold('Blocks:'));
    for (const blocksId of task.blocks) {
      const blocked = service.get(blocksId);
      if (blocked) {
        console.log(`  ${chalk.yellow(blocksId)}: ${blocked.title}`);
      }
    }
  }

  if (task.children.length > 0) {
    console.log('');
    console.log(chalk.bold('Children:'));
    for (const childId of task.children) {
      const child = service.get(childId);
      if (child) {
        const childStatus = STATUS_ICONS[child.status];
        console.log(`  ${childStatus} ${chalk.cyan(childId)}: ${child.title}`);
      }
    }
  }

  // Timestamps
  console.log('');
  console.log(chalk.dim(`Created: ${task.createdAt}`));
  console.log(chalk.dim(`Updated: ${task.updatedAt}`));
  if (task.closedAt) {
    console.log(chalk.dim(`Closed: ${task.closedAt}`));
    if (task.closedReason) {
      console.log(chalk.dim(`Reason: ${task.closedReason}`));
    }
  }

  // History
  if (options.verbose) {
    const history = service.getHistory(task.id);
    if (history.length > 0) {
      console.log('');
      console.log(chalk.bold('History:'));
      for (const entry of history.slice(0, 10)) {
        console.log(chalk.dim(`  ${entry.changedAt}: ${entry.field} changed`));
      }
    }
  }

  console.log('');
}

async function updateTask(service: TaskService, options: TaskOptions): Promise<void> {
  if (!options.id) {
    console.error(chalk.red('Error: --id is required'));
    process.exit(1);
  }

  const input: UpdateTaskInput = {};

  if (options.title) input.title = options.title;
  if (options.description) input.description = options.description;
  if (options.type) input.type = options.type as TaskType;
  if (options.status) input.status = options.status as TaskStatus;
  if (options.priority) input.priority = parseInt(options.priority, 10) as TaskPriority;
  if (options.assignee) input.assignee = options.assignee === 'none' ? undefined : options.assignee;
  if (options.worktree) input.worktreeBranch = options.worktree === 'none' ? undefined : options.worktree;
  if (options.labels) input.labels = options.labels.split(',').map(l => l.trim());
  if (options.notes) input.notes = options.notes;

  if (Object.keys(input).length === 0) {
    console.error(chalk.red('Error: No updates specified'));
    process.exit(1);
  }

  const spinner = ora('Updating task...').start();

  try {
    const task = service.update(options.id, input);
    if (!task) {
      spinner.fail(`Task not found: ${options.id}`);
      process.exit(1);
    }

    spinner.succeed(`Task updated: ${task.id}`);
    console.log(`  ${STATUS_ICONS[task.status]} ${task.title}`);
  } catch (error) {
    spinner.fail('Failed to update task');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

async function closeTask(service: TaskService, options: TaskOptions): Promise<void> {
  if (!options.id) {
    console.error(chalk.red('Error: --id is required'));
    process.exit(1);
  }

  const spinner = ora('Closing task...').start();

  try {
    const task = service.close(options.id, options.reason);
    if (!task) {
      spinner.fail(`Task not found: ${options.id}`);
      process.exit(1);
    }

    spinner.succeed(`Task closed: ${task.id}`);
    console.log(`  ${STATUS_ICONS.done} ${task.title}`);
    if (options.reason) {
      console.log(chalk.dim(`  Reason: ${options.reason}`));
    }

    for (const line of inlineProgressSummary(service.getStats())) console.log(line);
  } catch (error) {
    spinner.fail('Failed to close task');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

async function deleteTask(service: TaskService, options: TaskOptions): Promise<void> {
  if (!options.id) {
    console.error(chalk.red('Error: --id is required'));
    process.exit(1);
  }

  const spinner = ora('Deleting task...').start();

  try {
    const success = service.delete(options.id);
    if (!success) {
      spinner.fail(`Task not found: ${options.id}`);
      process.exit(1);
    }

    spinner.succeed(`Task deleted: ${options.id}`);
  } catch (error) {
    spinner.fail('Failed to delete task');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

async function showReady(service: TaskService, options: TaskOptions): Promise<void> {
  const tasks = service.ready();

  if (options.json) {
    console.log(JSON.stringify(tasks, null, 2));
    return;
  }

  const stats = service.getStats();
  for (const line of inlineProgressSummary(stats)) console.log(line);
  console.log('');

  if (tasks.length === 0) {
    console.log(chalk.dim('No ready tasks'));
    return;
  }

  console.log(chalk.bold.green(`✓ Ready Tasks (${tasks.length})\n`));

  for (const task of tasks) {
    const priorityColor = getPriorityColor(task.priority);
    const typeIcon = TYPE_ICONS[task.type];

    console.log(
      `  ${priorityColor(`P${task.priority}`)} ${typeIcon} ` +
      `${chalk.cyan(task.id)} ${task.title}`
    );

    if (task.blocks.length > 0) {
      console.log(chalk.dim(`    Unblocks: ${task.blocks.length} task(s)`));
    }
  }
  console.log('');
}

async function showBlocked(service: TaskService, options: TaskOptions): Promise<void> {
  const tasks = service.blocked();

  if (options.json) {
    console.log(JSON.stringify(tasks, null, 2));
    return;
  }

  const stats = service.getStats();
  for (const line of inlineProgressSummary(stats)) console.log(line);
  console.log('');

  if (tasks.length === 0) {
    console.log(chalk.dim('No blocked tasks'));
    return;
  }

  console.log(chalk.bold.red(`❄ Blocked Tasks (${tasks.length})\n`));

  for (const task of tasks) {
    const priorityColor = getPriorityColor(task.priority);
    const typeIcon = TYPE_ICONS[task.type];

    console.log(
      `  ${priorityColor(`P${task.priority}`)} ${typeIcon} ` +
      `${chalk.cyan(task.id)} ${task.title}`
    );

    console.log(chalk.red(`    Blocked by: ${task.blockedBy.join(', ')}`));
  }
  console.log('');
}

async function addDependency(service: TaskService, options: TaskOptions): Promise<void> {
  if (!options.from || !options.to) {
    console.error(chalk.red('Error: --from and --to are required'));
    process.exit(1);
  }

  const depType = (options.depType || 'blocks') as DependencyType;
  const spinner = ora(`Adding ${depType} dependency...`).start();

  try {
    const dep = service.addDependency(options.from, options.to, depType);
    if (!dep) {
      spinner.fail('Failed to add dependency (invalid tasks or would create cycle)');
      process.exit(1);
    }

    spinner.succeed(`Dependency added: ${options.from} ${depType} ${options.to}`);
  } catch (error) {
    spinner.fail('Failed to add dependency');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

async function removeDependency(service: TaskService, options: TaskOptions): Promise<void> {
  if (!options.from || !options.to) {
    console.error(chalk.red('Error: --from and --to are required'));
    process.exit(1);
  }

  const success = service.removeDependency(options.from, options.to);
  if (success) {
    console.log(chalk.green(`Dependency removed: ${options.from} → ${options.to}`));
  } else {
    console.log(chalk.yellow('Dependency not found'));
  }
}

async function claimTask(service: TaskService, options: TaskOptions): Promise<void> {
  if (!options.id) {
    console.error(chalk.red('Error: --id is required'));
    process.exit(1);
  }

  const spinner = ora('Claiming task...').start();

  try {
    // Get or create agent ID
    const coordService = new CoordinationService();
    const agentId = coordService.register('task-claimer', ['tasks']);

    const coordinator = new TaskCoordinator({
      taskService: service,
      coordinationService: coordService,
      agentId,
      agentName: 'task-claimer',
      worktreeBranch: options.branch,
    });

    const result = await coordinator.claim(options.id, options.branch);
    if (!result) {
      spinner.fail(`Task not found: ${options.id}`);
      process.exit(1);
    }

    spinner.succeed(`Task claimed: ${options.id}`);
    console.log(`  ${STATUS_ICONS.in_progress} ${result.task.title}`);
    console.log(`  Worktree: ${result.worktreeBranch}`);

    if (result.overlaps.length > 0) {
      console.log(chalk.yellow('\n  ⚠️  Overlapping work detected:'));
      for (const overlap of result.overlaps) {
        console.log(chalk.yellow(`    ${overlap.conflictRisk}: ${overlap.suggestion}`));
      }
    }

    for (const line of inlineProgressSummary(service.getStats())) console.log(line);
  } catch (error) {
    spinner.fail('Failed to claim task');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

async function releaseTask(service: TaskService, options: TaskOptions): Promise<void> {
  if (!options.id) {
    console.error(chalk.red('Error: --id is required'));
    process.exit(1);
  }

  const spinner = ora('Releasing task...').start();

  try {
    const coordService = new CoordinationService();
    const agentId = coordService.register('task-releaser', ['tasks']);

    const coordinator = new TaskCoordinator({
      taskService: service,
      coordinationService: coordService,
      agentId,
      agentName: 'task-releaser',
    });

    const result = await coordinator.release(options.id, options.reason);
    if (!result) {
      spinner.fail(`Task not found: ${options.id}`);
      process.exit(1);
    }

    spinner.succeed(`Task released: ${options.id}`);
    console.log(`  ${STATUS_ICONS.done} ${result.task.title}`);

    for (const line of inlineProgressSummary(service.getStats())) console.log(line);
  } catch (error) {
    spinner.fail('Failed to release task');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

async function showStats(service: TaskService, options: TaskOptions): Promise<void> {
  const stats = service.getStats();

  if (options.json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  console.log('');
  console.log(chalk.bold.cyan('  Task Statistics'));
  console.log(divider(60));
  console.log('');

  // Completion progress bar
  const completed = stats.byStatus.done + stats.byStatus.wont_do;
  console.log(`  ${progressBar(completed, stats.total, 40, {
    label: 'Completion',
    filled: chalk.green,
  })}`);
  console.log('');

  // Status stacked bar
  const segments: BarSegment[] = [
    { value: stats.byStatus.done, color: chalk.green, label: `Done ${STATUS_ICONS.done}` },
    { value: stats.byStatus.in_progress, color: chalk.cyan, label: `In Progress ${STATUS_ICONS.in_progress}` },
    { value: stats.byStatus.open, color: chalk.white, label: `Open ${STATUS_ICONS.open}` },
    { value: stats.byStatus.blocked, color: chalk.red, label: `Blocked ${STATUS_ICONS.blocked}` },
    { value: stats.byStatus.wont_do, color: chalk.dim, label: `Won't Do ${STATUS_ICONS.wont_do}` },
  ];
  console.log(`  ${stackedBar(segments, stats.total, 50)}`);
  console.log(`  ${stackedBarLegend(segments)}`);
  console.log('');

  // Gauges
  console.log(`  ${chalk.bold('Total    ')} ${chalk.bold(String(stats.total))}`);
  console.log(`  ${chalk.bold('Ready    ')} ${miniGauge(stats.ready, stats.total, 15)} ${chalk.green(String(stats.ready))}`);
  console.log(`  ${chalk.bold('Blocked  ')} ${miniGauge(stats.blocked, stats.total, 15)} ${chalk.red(String(stats.blocked))}`);
  console.log('');

  // Priority chart
  console.log(sectionHeader('By Priority'));
  console.log('');
  for (const line of horizontalBarChart([
    { label: 'P0 Critical', value: stats.byPriority[0], color: chalk.red },
    { label: 'P1 High', value: stats.byPriority[1], color: chalk.yellow },
    { label: 'P2 Medium', value: stats.byPriority[2], color: chalk.blue },
    { label: 'P3 Low', value: stats.byPriority[3], color: chalk.dim },
    { label: 'P4 Backlog', value: stats.byPriority[4], color: chalk.dim },
  ], { maxWidth: 30, maxLabelWidth: 14 })) {
    console.log(line);
  }
  console.log('');

  // Type chart
  const typeData = (Object.entries(stats.byType) as [TaskType, number][])
    .filter(([, count]) => count > 0);
  if (typeData.length > 0) {
    console.log(sectionHeader('By Type'));
    console.log('');
    for (const line of horizontalBarChart(
      typeData.map(([type, count]) => ({
        label: `${TYPE_ICONS[type]} ${type}`,
        value: count,
        color: chalk.magenta,
      })),
      { maxWidth: 30, maxLabelWidth: 14 }
    )) {
      console.log(line);
    }
    console.log('');
  }
}

async function syncTasks(service: TaskService, _options: TaskOptions): Promise<void> {
  const spinner = ora('Syncing tasks...').start();

  try {
    // Import from JSONL first
    const imported = service.importFromJSONL();
    
    // Then export current state
    service.saveToJSONL();

    spinner.succeed('Tasks synced');
    if (imported > 0) {
      console.log(chalk.dim(`  Imported ${imported} task(s) from JSONL`));
    }
    console.log(chalk.dim('  Exported current state to JSONL'));
  } catch (error) {
    spinner.fail('Failed to sync tasks');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

async function compactTasks(service: TaskService, options: TaskOptions): Promise<void> {
  const days = options.days ? parseInt(options.days, 10) : 90;
  const spinner = ora(`Compacting tasks older than ${days} days...`).start();

  try {
    const summary = service.compact(days);
    if (!summary) {
      spinner.info('No tasks to compact');
      return;
    }

    spinner.succeed(`Compacted ${summary.originalIds.length} task(s)`);
    console.log(chalk.dim(`  Period: ${summary.closedPeriod}`));
    console.log(chalk.dim(`  Summary: ${summary.summary}`));
  } catch (error) {
    spinner.fail('Failed to compact tasks');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

function getPriorityColor(priority: TaskPriority): (text: string) => string {
  switch (priority) {
    case 0:
      return chalk.red;
    case 1:
      return chalk.yellow;
    case 2:
      return chalk.blue;
    case 3:
      return chalk.dim;
    case 4:
      return chalk.dim;
    default:
      return chalk.white;
  }
}

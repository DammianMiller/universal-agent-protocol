import chalk from 'chalk';
import ora from 'ora';
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { TaskService } from '../tasks/service.js';
import { CoordinationService } from '../coordination/service.js';
import { SQLiteShortTermMemory } from '../memory/short-term/sqlite.js';
import {
  progressBar,
  stackedBar,
  stackedBarLegend,
  horizontalBarChart,
  table,
  tree,
  box,
  sectionHeader,
  keyValue,
  miniGauge,
  statusBadge,
  divider,
  bulletList,
  columns,
  type BarSegment,
  type TreeNode,
} from './visualize.js';
import { STATUS_ICONS, TYPE_ICONS, PRIORITY_LABELS } from '../tasks/types.js';
import type { TaskType, TaskPriority } from '../tasks/types.js';
import { globalSessionStats } from '../mcp-router/session-stats.js';

type DashboardAction = 'overview' | 'tasks' | 'agents' | 'memory' | 'progress' | 'stats';

interface DashboardOptions {
  verbose?: boolean;
  compact?: boolean;
}

export async function dashboardCommand(
  action: DashboardAction,
  options: DashboardOptions = {}
): Promise<void> {
  switch (action) {
    case 'overview':
      await showOverview(options);
      break;
    case 'tasks':
      await showTaskDashboard(options);
      break;
    case 'agents':
      await showAgentDashboard(options);
      break;
    case 'memory':
      await showMemoryDashboard(options);
      break;
    case 'progress':
      await showProgressDashboard(options);
      break;
    case 'stats':
      await showStatsDashboard(options);
      break;
  }
}

async function showOverview(_options: DashboardOptions): Promise<void> {
  const spinner = ora('Loading dashboard...').start();

  try {
    const taskService = new TaskService();
    const coordService = new CoordinationService();
    const stats = taskService.getStats();
    const coordStatus = coordService.getStatus();

    spinner.stop();

    console.log('');
    console.log(chalk.bold.cyan('  UAP Dashboard'));
    console.log(divider(60));
    console.log('');

    // Task completion progress
    const completedTasks = stats.byStatus.done + stats.byStatus.wont_do;
    const activeTasks = stats.total - completedTasks;
    console.log(sectionHeader('Task Progress'));
    console.log('');
    console.log(`  ${progressBar(completedTasks, stats.total, 40, {
      label: 'Completion',
      filled: chalk.green,
    })}`);
    console.log('');

    // Status breakdown bar
    const statusSegments: BarSegment[] = [
      { value: stats.byStatus.done, color: chalk.green, label: `Done ${STATUS_ICONS.done}` },
      { value: stats.byStatus.in_progress, color: chalk.cyan, label: `In Progress ${STATUS_ICONS.in_progress}` },
      { value: stats.byStatus.open, color: chalk.white, label: `Open ${STATUS_ICONS.open}` },
      { value: stats.byStatus.blocked, color: chalk.red, label: `Blocked ${STATUS_ICONS.blocked}` },
      { value: stats.byStatus.wont_do, color: chalk.dim, label: `Won't Do ${STATUS_ICONS.wont_do}` },
    ];
    console.log(`  ${stackedBar(statusSegments, stats.total, 50)}`);
    console.log(`  ${stackedBarLegend(statusSegments)}`);
    console.log('');

    // Two-column layout: Priority vs Type
    const priorityLines = [
      chalk.bold('  By Priority'),
      ...horizontalBarChart(
        [
          { label: 'P0 Critical', value: stats.byPriority[0], color: chalk.red },
          { label: 'P1 High', value: stats.byPriority[1], color: chalk.yellow },
          { label: 'P2 Medium', value: stats.byPriority[2], color: chalk.blue },
          { label: 'P3 Low', value: stats.byPriority[3], color: chalk.dim },
          { label: 'P4 Backlog', value: stats.byPriority[4], color: chalk.dim },
        ],
        { maxWidth: 20, maxLabelWidth: 14 }
      ),
    ];

    const typeData = (Object.entries(stats.byType) as [TaskType, number][])
      .filter(([, count]) => count > 0);
    const typeLines = [
      chalk.bold('  By Type'),
      ...horizontalBarChart(
        typeData.map(([type, count]) => ({
          label: `${TYPE_ICONS[type]} ${type}`,
          value: count,
          color: chalk.magenta,
        })),
        { maxWidth: 20, maxLabelWidth: 14 }
      ),
    ];

    const combined = columns(priorityLines, typeLines, { gap: 6, leftWidth: 42 });
    for (const line of combined) console.log(line);
    console.log('');

    // Agent Status
    console.log(sectionHeader('Agents & Coordination'));
    console.log('');

    const agentItems = coordStatus.activeAgents.map(a => ({
      text: `${chalk.cyan(a.name)} ${statusBadge(a.status)}${a.currentTask ? chalk.dim(` working on ${a.currentTask}`) : ''}`,
      status: a.status === 'active' ? 'ok' as const : 'warn' as const,
    }));

    if (agentItems.length > 0) {
      for (const line of bulletList(agentItems)) console.log(line);
    } else {
      console.log(chalk.dim('  No active agents'));
    }

    console.log('');
    for (const line of keyValue([
      ['Active Agents', coordStatus.activeAgents.length],
      ['Resource Claims', coordStatus.activeClaims.length],
      ['Pending Deploys', coordStatus.pendingDeploys.length],
      ['Unread Messages', coordStatus.pendingMessages],
    ])) console.log(line);

    // Memory summary
    console.log('');
    console.log(sectionHeader('Memory'));
    console.log('');

    const cwd = process.cwd();
    const dbPath = join(cwd, 'agents/data/memory/short_term.db');
    const memoryItems: Array<{ text: string; status: 'ok' | 'warn' | 'error' | 'info' }> = [];

    if (existsSync(dbPath)) {
      const dbStats = statSync(dbPath);
      const sizeKB = Math.round(dbStats.size / 1024);
      memoryItems.push({
        text: `Short-term: ${chalk.bold(sizeKB + ' KB')} ${chalk.dim(`(modified ${dbStats.mtime.toLocaleDateString()})`)}`,
        status: 'ok',
      });
    } else {
      memoryItems.push({ text: 'Short-term: Not initialized', status: 'warn' });
    }

    let qdrantRunning = false;
    try {
      const dockerStatus = execSync(
        'docker ps --filter name=qdrant --format "{{.Status}}"',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      if (dockerStatus) {
        memoryItems.push({ text: `Qdrant: ${chalk.bold('Running')} ${chalk.dim(dockerStatus)}`, status: 'ok' });
        qdrantRunning = true;
      } else {
        memoryItems.push({ text: 'Qdrant: Stopped', status: 'warn' });
      }
    } catch {
      memoryItems.push({ text: 'Qdrant: Not available', status: 'warn' });
    }

    for (const line of bulletList(memoryItems)) console.log(line);

    // Summary box
    console.log('');
    const summaryContent = [
      `Tasks: ${chalk.bold(stats.total)} total, ${chalk.green(completedTasks + ' done')}, ${chalk.yellow(activeTasks + ' active')}`,
      `Agents: ${chalk.bold(coordStatus.activeAgents.length)} active`,
      `Memory: ${existsSync(dbPath) ? chalk.green('SQLite') : chalk.dim('None')} / ${qdrantRunning ? chalk.green('Qdrant') : chalk.dim('No Qdrant')}`,
    ];
    for (const line of box('Summary', summaryContent, { borderColor: chalk.cyan })) {
      console.log(`  ${line}`);
    }
    console.log('');

  } catch (error) {
    spinner.fail('Failed to load dashboard');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  }
}

async function showTaskDashboard(options: DashboardOptions): Promise<void> {
  const spinner = ora('Loading task dashboard...').start();

  try {
    const service = new TaskService();
    const stats = service.getStats();
    const allTasks = service.list({});
    const readyTasks = service.ready();
    const blockedTasks = service.blocked();

    spinner.stop();

    console.log('');
    console.log(chalk.bold.cyan('  Task Dashboard'));
    console.log(divider(60));
    console.log('');

    // Completion gauge
    const done = stats.byStatus.done + stats.byStatus.wont_do;
    console.log(`  ${chalk.bold('Completion')}  ${miniGauge(done, stats.total, 20)} ${chalk.bold(Math.round(done / Math.max(stats.total, 1) * 100) + '%')} ${chalk.dim(`(${done}/${stats.total})`)}`);
    console.log(`  ${chalk.bold('In Flight ')}  ${miniGauge(stats.byStatus.in_progress, stats.total, 20)} ${chalk.dim(`${stats.byStatus.in_progress} tasks`)}`);
    console.log(`  ${chalk.bold('Blocked   ')}  ${miniGauge(stats.byStatus.blocked, stats.total, 20)} ${chalk.dim(`${stats.byStatus.blocked} tasks`)}`);
    console.log('');

    // Status stacked bar
    console.log(sectionHeader('Status Distribution'));
    console.log('');
    const segments: BarSegment[] = [
      { value: stats.byStatus.done, color: chalk.green, label: 'Done' },
      { value: stats.byStatus.in_progress, color: chalk.cyan, label: 'In Progress' },
      { value: stats.byStatus.open, color: chalk.white, label: 'Open' },
      { value: stats.byStatus.blocked, color: chalk.red, label: 'Blocked' },
      { value: stats.byStatus.wont_do, color: chalk.dim, label: "Won't Do" },
    ];
    console.log(`  ${stackedBar(segments, stats.total, 50)}`);
    console.log(`  ${stackedBarLegend(segments)}`);
    console.log('');

    // Priority chart
    console.log(sectionHeader('Priority Breakdown'));
    console.log('');
    for (const line of horizontalBarChart([
      { label: 'P0 Critical', value: stats.byPriority[0], color: chalk.red },
      { label: 'P1 High', value: stats.byPriority[1], color: chalk.yellow },
      { label: 'P2 Medium', value: stats.byPriority[2], color: chalk.blue },
      { label: 'P3 Low', value: stats.byPriority[3], color: chalk.dim },
      { label: 'P4 Backlog', value: stats.byPriority[4], color: chalk.dim },
    ], { maxWidth: 35, maxLabelWidth: 14 })) {
      console.log(line);
    }
    console.log('');

    // Type chart
    const typeData = (Object.entries(stats.byType) as [TaskType, number][])
      .filter(([, count]) => count > 0);
    if (typeData.length > 0) {
      console.log(sectionHeader('Type Breakdown'));
      console.log('');
      for (const line of horizontalBarChart(
        typeData.map(([type, count]) => ({
          label: `${TYPE_ICONS[type]} ${type}`,
          value: count,
          color: chalk.magenta,
        })),
        { maxWidth: 35, maxLabelWidth: 14 }
      )) {
        console.log(line);
      }
      console.log('');
    }

    // Ready tasks table
    if (readyTasks.length > 0) {
      console.log(sectionHeader('Ready to Work'));
      console.log('');
      const readyRows = readyTasks.slice(0, 10).map(t => ({
        id: t.id,
        priority: `P${t.priority}`,
        type: TYPE_ICONS[t.type],
        title: t.title.slice(0, 40) + (t.title.length > 40 ? '...' : ''),
      }));
      for (const line of table(readyRows, [
        { key: 'id', header: 'ID', width: 10, color: chalk.cyan },
        { key: 'priority', header: 'Pri', width: 5 },
        { key: 'type', header: 'T', width: 3 },
        { key: 'title', header: 'Title', width: 42 },
      ])) {
        console.log(line);
      }
      if (readyTasks.length > 10) {
        console.log(chalk.dim(`  ... and ${readyTasks.length - 10} more`));
      }
      console.log('');
    }

    // Blocked tasks
    if (blockedTasks.length > 0) {
      console.log(sectionHeader('Blocked Tasks'));
      console.log('');
      for (const t of blockedTasks.slice(0, 5)) {
        console.log(`  ${chalk.red(STATUS_ICONS.blocked)} ${chalk.cyan(t.id)} ${t.title}`);
        if (t.blockedBy.length > 0) {
          console.log(chalk.red(`    Blocked by: ${t.blockedBy.join(', ')}`));
        }
      }
      console.log('');
    }

    // In-progress tasks
    const inProgress = allTasks.filter(t => t.status === 'in_progress');
    if (inProgress.length > 0) {
      console.log(sectionHeader('In Progress'));
      console.log('');
      for (const t of inProgress) {
        console.log(`  ${chalk.cyan(STATUS_ICONS.in_progress)} ${chalk.cyan(t.id)} ${t.title}`);
        if (t.assignee) console.log(chalk.dim(`    Assigned: ${t.assignee}`));
      }
      console.log('');
    }

    // Task hierarchy tree (epics with children)
    const epics = allTasks.filter(t => t.type === 'epic' && t.status !== 'done' && t.status !== 'wont_do');
    if (epics.length > 0 && !options.compact) {
      console.log(sectionHeader('Task Hierarchy'));
      console.log('');
      for (const epic of epics.slice(0, 3)) {
        const children = allTasks.filter(t => t.parentId === epic.id);
        const epicNode: TreeNode = {
          label: `${chalk.bold(epic.title)} ${chalk.dim(epic.id)}`,
          status: STATUS_ICONS[epic.status],
          children: children.map(c => ({
            label: `${c.title} ${chalk.dim(c.id)}`,
            status: STATUS_ICONS[c.status],
            meta: `P${c.priority} ${c.type}`,
          })),
        };
        for (const line of tree(epicNode)) console.log(line);
      }
      console.log('');
    }

  } catch (error) {
    spinner.fail('Failed to load task dashboard');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  }
}

async function showAgentDashboard(_options: DashboardOptions): Promise<void> {
  const spinner = ora('Loading agent dashboard...').start();

  try {
    const coordService = new CoordinationService();
    const status = coordService.getStatus();
    const activeWork = coordService.getActiveWork();

    spinner.stop();

    console.log('');
    console.log(chalk.bold.cyan('  Agent Dashboard'));
    console.log(divider(60));
    console.log('');

    // Agent count and status
    console.log(sectionHeader('Active Agents'));
    console.log('');

    if (status.activeAgents.length === 0) {
      console.log(chalk.dim('  No active agents registered'));
    } else {
      const agentRows = status.activeAgents.map(a => ({
        name: a.name,
        status: statusBadge(a.status),
        task: a.currentTask || chalk.dim('idle'),
        heartbeat: chalk.dim(a.lastHeartbeat.slice(11, 19)),
      }));
      for (const line of table(agentRows, [
        { key: 'name', header: 'Agent', width: 18, color: chalk.cyan },
        { key: 'status', header: 'Status', width: 16 },
        { key: 'task', header: 'Current Task', width: 20 },
        { key: 'heartbeat', header: 'Last Beat', width: 10 },
      ])) {
        console.log(line);
      }
    }
    console.log('');

    // Resource claims
    console.log(sectionHeader('Resource Claims'));
    console.log('');

    if (status.activeClaims.length === 0) {
      console.log(chalk.dim('  No active resource claims'));
    } else {
      for (const claim of status.activeClaims) {
        const lockIcon = claim.claimType === 'exclusive' ? chalk.red('EXCL') : chalk.green('SHARED');
        console.log(`  ${lockIcon} ${chalk.yellow(claim.resource)}`);
        console.log(chalk.dim(`    Agent: ${claim.agentId.slice(0, 8)}...`));
      }
    }
    console.log('');

    // Active work visualization
    if (activeWork.length > 0) {
      console.log(sectionHeader('Active Work'));
      console.log('');

      const grouped = new Map<string, typeof activeWork>();
      for (const work of activeWork) {
        const existing = grouped.get(work.resource) || [];
        existing.push(work);
        grouped.set(work.resource, existing);
      }

      for (const [resource, works] of grouped) {
        const hasConflict = works.length > 1;
        const icon = hasConflict ? chalk.red('!!') : chalk.green('OK');
        console.log(`  ${icon} ${chalk.bold(resource)}`);
        for (const w of works) {
          console.log(`     ${chalk.cyan(w.agentName || w.agentId.slice(0, 8))} ${chalk.dim(w.intentType)}`);
        }
      }
      console.log('');
    }

    // Deploy queue
    console.log(sectionHeader('Deploy Queue'));
    console.log('');
    if (status.pendingDeploys.length === 0) {
      console.log(chalk.dim('  No pending deploys'));
    } else {
      console.log(`  ${chalk.bold(String(status.pendingDeploys.length))} pending deploy action(s)`);
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
      )) {
        console.log(line);
      }
    }
    console.log('');

    // Summary
    for (const line of keyValue([
      ['Total Agents', status.activeAgents.length],
      ['Resource Claims', status.activeClaims.length],
      ['Active Work Items', activeWork.length],
      ['Pending Deploys', status.pendingDeploys.length],
      ['Unread Messages', status.pendingMessages],
    ])) console.log(line);
    console.log('');

  } catch (error) {
    spinner.fail('Failed to load agent dashboard');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  }
}

async function showMemoryDashboard(_options: DashboardOptions): Promise<void> {
  const spinner = ora('Loading memory dashboard...').start();

  try {
    const cwd = process.cwd();
    const dbPath = join(cwd, 'agents/data/memory/short_term.db');

    spinner.stop();

    console.log('');
    console.log(chalk.bold.cyan('  Memory Dashboard'));
    console.log(divider(60));
    console.log('');

    // Short-term memory
    console.log(sectionHeader('Short-Term Memory (SQLite)'));
    console.log('');

    if (existsSync(dbPath)) {
      const dbStats = statSync(dbPath);
      const sizeKB = Math.round(dbStats.size / 1024);

      try {
        const shortTermDb = new SQLiteShortTermMemory({
          dbPath,
          projectId: 'dashboard',
          maxEntries: 9999,
        });
        const count = await shortTermDb.count();
        await shortTermDb.close();

        for (const line of keyValue([
          ['Status', 'Active'],
          ['Entries', count],
          ['Size', `${sizeKB} KB`],
          ['Last Modified', dbStats.mtime.toLocaleDateString()],
          ['Path', dbPath],
        ])) console.log(line);

        console.log('');
        console.log(`  ${chalk.bold('Capacity')}  ${miniGauge(count, 50, 20)} ${chalk.dim(`${count}/50 entries`)}`);
      } catch {
        console.log(`  ${statusBadge('active')} ${chalk.dim(`${sizeKB} KB`)}`);
      }
    } else {
      console.log(`  ${statusBadge('not_available')} Not initialized`);
    }
    console.log('');

    // Qdrant status
    console.log(sectionHeader('Long-Term Memory (Qdrant)'));
    console.log('');

    try {
      const dockerStatus = execSync(
        'docker ps --filter name=qdrant --format "{{.Status}}"',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();

      if (dockerStatus) {
        console.log(`  ${statusBadge('running')} ${chalk.dim(dockerStatus)}`);

        try {
          const dockerInspect = execSync(
            'docker inspect --format "{{.Config.Image}}" uap-qdrant 2>/dev/null || docker inspect --format "{{.Config.Image}}" qdrant 2>/dev/null',
            { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
          ).trim();
          if (dockerInspect) {
            console.log(chalk.dim(`  Image: ${dockerInspect}`));
          }
        } catch { /* ignore */ }

        console.log(chalk.dim('  Endpoint: http://localhost:6333'));
      } else {
        console.log(`  ${statusBadge('stopped')} Container not running`);
        console.log(chalk.dim('  Start with: uap memory start'));
      }
    } catch {
      console.log(`  ${statusBadge('not_available')} Docker not available`);
    }
    console.log('');

    // Embeddings
    console.log(sectionHeader('Embeddings (Ollama)'));
    console.log('');

    try {
      const ollamaResponse = await fetch('http://localhost:11434/api/tags', {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      });

      if (ollamaResponse.ok) {
        const ollamaData = await ollamaResponse.json() as { models: Array<{ name: string; size: number }> };
        const embedModels = ollamaData.models?.filter(m =>
          m.name.includes('embed') || m.name.includes('nomic')
        ) || [];

        if (embedModels.length > 0) {
          console.log(`  ${statusBadge('active')}`);
          for (const model of embedModels) {
            const sizeMB = Math.round((model.size || 0) / 1024 / 1024);
            console.log(`  ${chalk.cyan(model.name)} ${chalk.dim(`${sizeMB} MB`)}`);
          }
        } else {
          console.log(`  ${statusBadge('not_available')} No embedding models found`);
          console.log(chalk.dim('  Install: ollama pull nomic-embed-text'));
        }
      } else {
        console.log(`  ${statusBadge('stopped')} Not responding`);
      }
    } catch {
      console.log(`  ${statusBadge('not_available')} Ollama not running`);
      console.log(chalk.dim('  Install from https://ollama.ai'));
    }

    // Memory layers summary
    console.log('');
    console.log(sectionHeader('Memory Layer Architecture'));
    console.log('');

    const layers: TreeNode = {
      label: chalk.bold('UAP Memory System'),
      children: [
        {
          label: 'L1 Working Memory',
          status: existsSync(dbPath) ? chalk.green('ON') : chalk.red('OFF'),
          meta: 'SQLite, <1ms',
        },
        {
          label: 'L2 Session Memory',
          status: existsSync(dbPath) ? chalk.green('ON') : chalk.red('OFF'),
          meta: 'SQLite, <5ms',
        },
        {
          label: 'L3 Semantic Memory',
          status: chalk.yellow('?'),
          meta: 'Qdrant, ~50ms',
        },
        {
          label: 'L4 Knowledge Graph',
          status: existsSync(dbPath) ? chalk.green('ON') : chalk.red('OFF'),
          meta: 'SQLite entities/rels',
        },
      ],
    };
    for (const line of tree(layers)) console.log(line);
    console.log('');

  } catch (error) {
    spinner.fail('Failed to load memory dashboard');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  }
}

async function showProgressDashboard(_options: DashboardOptions): Promise<void> {
  const spinner = ora('Loading progress dashboard...').start();

  try {
    const service = new TaskService();
    const stats = service.getStats();
    const allTasks = service.list({});

    spinner.stop();

    console.log('');
    console.log(chalk.bold.cyan('  Progress Dashboard'));
    console.log(divider(60));
    console.log('');

    const total = stats.total;
    const done = stats.byStatus.done;
    const wontDo = stats.byStatus.wont_do;
    const inProgress = stats.byStatus.in_progress;
    const blocked = stats.byStatus.blocked;
    const open = stats.byStatus.open;
    const completed = done + wontDo;

    // Big completion percentage
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    const bigNum = pct >= 80 ? chalk.green : pct >= 50 ? chalk.yellow : chalk.red;
    console.log(`  ${bigNum(chalk.bold(`${pct}%`))} ${chalk.dim('complete')}`);
    console.log('');
    console.log(`  ${progressBar(completed, total, 50, {
      showPercent: false,
      showCount: false,
      filled: pct >= 80 ? chalk.green : pct >= 50 ? chalk.yellow : chalk.red,
    })}`);
    console.log('');

    // Flow breakdown
    console.log(sectionHeader('Task Flow'));
    console.log('');
    console.log(`  ${chalk.white('Open')}         ${progressBar(open, total, 30, { filled: chalk.white, showPercent: true, showCount: true })}`);
    console.log(`  ${chalk.cyan('In Progress')}  ${progressBar(inProgress, total, 30, { filled: chalk.cyan, showPercent: true, showCount: true })}`);
    console.log(`  ${chalk.red('Blocked')}      ${progressBar(blocked, total, 30, { filled: chalk.red, showPercent: true, showCount: true })}`);
    console.log(`  ${chalk.green('Done')}         ${progressBar(done, total, 30, { filled: chalk.green, showPercent: true, showCount: true })}`);
    if (wontDo > 0) {
      console.log(`  ${chalk.dim("Won't Do")}     ${progressBar(wontDo, total, 30, { filled: chalk.dim, showPercent: true, showCount: true })}`);
    }
    console.log('');

    // Per-priority progress
    console.log(sectionHeader('Progress by Priority'));
    console.log('');

    for (let p = 0; p <= 4; p++) {
      const priority = p as TaskPriority;
      const priorityTasks = allTasks.filter(t => t.priority === priority);
      const priorityDone = priorityTasks.filter(t => t.status === 'done' || t.status === 'wont_do').length;
      const priorityTotal = priorityTasks.length;

      if (priorityTotal > 0) {
        const color = p === 0 ? chalk.red : p === 1 ? chalk.yellow : p === 2 ? chalk.blue : chalk.dim;
        const label = PRIORITY_LABELS[priority].padEnd(14);
        console.log(`  ${color(label)} ${progressBar(priorityDone, priorityTotal, 25, {
          filled: color,
          showPercent: true,
          showCount: true,
        })}`);
      }
    }
    console.log('');

    // Per-type progress
    const typeData = (Object.entries(stats.byType) as [TaskType, number][])
      .filter(([, count]) => count > 0);

    if (typeData.length > 0) {
      console.log(sectionHeader('Progress by Type'));
      console.log('');

      for (const [type, typeTotal] of typeData) {
        const typeDone = allTasks.filter(t => t.type === type && (t.status === 'done' || t.status === 'wont_do')).length;
        const label = `${TYPE_ICONS[type]} ${type}`.padEnd(14);
        console.log(`  ${label} ${progressBar(typeDone, typeTotal, 25, {
          filled: chalk.magenta,
          showPercent: true,
          showCount: true,
        })}`);
      }
      console.log('');
    }

    // Velocity indicator (recent completions)
    const now = new Date();
    const recentDone = allTasks.filter(t => {
      if (t.status !== 'done' || !t.closedAt) return false;
      const closedDate = new Date(t.closedAt);
      const daysDiff = (now.getTime() - closedDate.getTime()) / (1000 * 60 * 60 * 24);
      return daysDiff <= 7;
    });

    const recentCreated = allTasks.filter(t => {
      const createdDate = new Date(t.createdAt);
      const daysDiff = (now.getTime() - createdDate.getTime()) / (1000 * 60 * 60 * 24);
      return daysDiff <= 7;
    });

    console.log(sectionHeader('Velocity (Last 7 Days)'));
    console.log('');
    for (const line of keyValue([
      ['Completed', `${recentDone.length} tasks`],
      ['Created', `${recentCreated.length} tasks`],
      ['Net Progress', `${recentDone.length - recentCreated.length > 0 ? '+' : ''}${recentDone.length - recentCreated.length}`],
    ])) console.log(line);
    console.log('');

    // Summary box
    const summaryLines = [
      `${chalk.bold(String(total))} total tasks`,
      `${chalk.green(String(completed))} completed ${chalk.dim(`(${pct}%)`)}`,
      `${chalk.cyan(String(inProgress))} in progress`,
      `${blocked > 0 ? chalk.red(String(blocked) + ' blocked') : chalk.dim('0 blocked')}`,
      `${chalk.dim(String(open))} open / awaiting`,
    ];
    for (const line of box('Summary', summaryLines, { borderColor: chalk.cyan })) {
      console.log(`  ${line}`);
    }
    console.log('');

  } catch (error) {
    spinner.fail('Failed to load progress dashboard');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} sec`;
  return `${(ms / 60000).toFixed(1)} min`;
}

async function showStatsDashboard(_options: DashboardOptions): Promise<void> {
  const summary = globalSessionStats.getSummary();

  console.log('');
  console.log(chalk.bold.cyan('  Session Stats'));
  console.log(divider(60));
  console.log('');

  const estimatedTokens = Math.round(summary.totalContextBytes / 4);

  for (const line of keyValue([
    ['Uptime', formatDuration(summary.uptimeMs)],
    ['Tool calls', String(summary.totalCalls)],
    ['Context used', `${formatBytes(summary.totalContextBytes)} (~${estimatedTokens.toLocaleString()} tokens)`],
    ['Raw data processed', formatBytes(summary.totalRawBytes)],
    ['Savings ratio', `${summary.savingsRatio}x (${summary.savingsPercent} reduction)`],
  ])) console.log(line);

  if (summary.byTool.length > 0) {
    console.log('');
    console.log(sectionHeader('Per-Tool Breakdown'));
    console.log('');

    const rows = summary.byTool.map(t => [
      chalk.white(t.tool),
      `${t.calls} call${t.calls !== 1 ? 's' : ''}`,
      formatBytes(t.contextBytes),
    ]);

    for (const row of rows) {
      console.log(`  ${row[0].padEnd(35)} ${row[1].padEnd(12)} ${row[2]}`);
    }
  }

  if (summary.totalCalls === 0) {
    console.log('');
    console.log(chalk.dim('  No tool calls recorded yet. Stats populate when MCP Router processes requests.'));
  }

  console.log('');
}

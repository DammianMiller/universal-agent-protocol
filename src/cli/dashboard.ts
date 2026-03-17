import chalk from 'chalk';
import ora from 'ora';
import { existsSync, statSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
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

type DashboardAction =
  | 'overview'
  | 'tasks'
  | 'agents'
  | 'memory'
  | 'progress'
  | 'stats'
  | 'session'
  | 'benchmark';

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
    case 'session':
      await showSessionDashboard(options);
      break;
    case 'benchmark':
      showDashboard();
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
    console.log(
      `  ${progressBar(completedTasks, stats.total, 40, {
        label: 'Completion',
        filled: chalk.green,
      })}`
    );
    console.log('');

    // Status breakdown bar
    const statusSegments: BarSegment[] = [
      { value: stats.byStatus.done, color: chalk.green, label: `Done ${STATUS_ICONS.done}` },
      {
        value: stats.byStatus.in_progress,
        color: chalk.cyan,
        label: `In Progress ${STATUS_ICONS.in_progress}`,
      },
      { value: stats.byStatus.open, color: chalk.white, label: `Open ${STATUS_ICONS.open}` },
      { value: stats.byStatus.blocked, color: chalk.red, label: `Blocked ${STATUS_ICONS.blocked}` },
      {
        value: stats.byStatus.wont_do,
        color: chalk.dim,
        label: `Won't Do ${STATUS_ICONS.wont_do}`,
      },
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

    const typeData = (Object.entries(stats.byType) as [TaskType, number][]).filter(
      ([, count]) => count > 0
    );
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

    const agentItems = coordStatus.activeAgents.map((a) => ({
      text: `${chalk.cyan(a.name)} ${statusBadge(a.status)}${a.currentTask ? chalk.dim(` working on ${a.currentTask}`) : ''}`,
      status: a.status === 'active' ? ('ok' as const) : ('warn' as const),
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
    ]))
      console.log(line);

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
      const dockerStatus = execSync('docker ps --filter name=qdrant --format "{{.Status}}"', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (dockerStatus) {
        memoryItems.push({
          text: `Qdrant: ${chalk.bold('Running')} ${chalk.dim(dockerStatus)}`,
          status: 'ok',
        });
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
    console.log(
      `  ${chalk.bold('Completion')}  ${miniGauge(done, stats.total, 20)} ${chalk.bold(Math.round((done / Math.max(stats.total, 1)) * 100) + '%')} ${chalk.dim(`(${done}/${stats.total})`)}`
    );
    console.log(
      `  ${chalk.bold('In Flight ')}  ${miniGauge(stats.byStatus.in_progress, stats.total, 20)} ${chalk.dim(`${stats.byStatus.in_progress} tasks`)}`
    );
    console.log(
      `  ${chalk.bold('Blocked   ')}  ${miniGauge(stats.byStatus.blocked, stats.total, 20)} ${chalk.dim(`${stats.byStatus.blocked} tasks`)}`
    );
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
    for (const line of horizontalBarChart(
      [
        { label: 'P0 Critical', value: stats.byPriority[0], color: chalk.red },
        { label: 'P1 High', value: stats.byPriority[1], color: chalk.yellow },
        { label: 'P2 Medium', value: stats.byPriority[2], color: chalk.blue },
        { label: 'P3 Low', value: stats.byPriority[3], color: chalk.dim },
        { label: 'P4 Backlog', value: stats.byPriority[4], color: chalk.dim },
      ],
      { maxWidth: 35, maxLabelWidth: 14 }
    )) {
      console.log(line);
    }
    console.log('');

    // Type chart
    const typeData = (Object.entries(stats.byType) as [TaskType, number][]).filter(
      ([, count]) => count > 0
    );
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
      const readyRows = readyTasks.slice(0, 10).map((t) => ({
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
    const inProgress = allTasks.filter((t) => t.status === 'in_progress');
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
    const epics = allTasks.filter(
      (t) => t.type === 'epic' && t.status !== 'done' && t.status !== 'wont_do'
    );
    if (epics.length > 0 && !options.compact) {
      console.log(sectionHeader('Task Hierarchy'));
      console.log('');
      for (const epic of epics.slice(0, 3)) {
        const children = allTasks.filter((t) => t.parentId === epic.id);
        const epicNode: TreeNode = {
          label: `${chalk.bold(epic.title)} ${chalk.dim(epic.id)}`,
          status: STATUS_ICONS[epic.status],
          children: children.map((c) => ({
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
      const agentRows = status.activeAgents.map((a) => ({
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
        const lockIcon =
          claim.claimType === 'exclusive' ? chalk.red('EXCL') : chalk.green('SHARED');
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
          console.log(
            `     ${chalk.cyan(w.agentName || w.agentId.slice(0, 8))} ${chalk.dim(w.intentType)}`
          );
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
    ]))
      console.log(line);
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
        ]))
          console.log(line);

        console.log('');
        console.log(
          `  ${chalk.bold('Capacity')}  ${miniGauge(count, 50, 20)} ${chalk.dim(`${count}/50 entries`)}`
        );
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
      const dockerStatus = execSync('docker ps --filter name=qdrant --format "{{.Status}}"', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

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
        } catch {
          /* ignore */
        }

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
        const ollamaData = (await ollamaResponse.json()) as {
          models: Array<{ name: string; size: number }>;
        };
        const embedModels =
          ollamaData.models?.filter((m) => m.name.includes('embed') || m.name.includes('nomic')) ||
          [];

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
    console.log(
      `  ${progressBar(completed, total, 50, {
        showPercent: false,
        showCount: false,
        filled: pct >= 80 ? chalk.green : pct >= 50 ? chalk.yellow : chalk.red,
      })}`
    );
    console.log('');

    // Flow breakdown
    console.log(sectionHeader('Task Flow'));
    console.log('');
    console.log(
      `  ${chalk.white('Open')}         ${progressBar(open, total, 30, { filled: chalk.white, showPercent: true, showCount: true })}`
    );
    console.log(
      `  ${chalk.cyan('In Progress')}  ${progressBar(inProgress, total, 30, { filled: chalk.cyan, showPercent: true, showCount: true })}`
    );
    console.log(
      `  ${chalk.red('Blocked')}      ${progressBar(blocked, total, 30, { filled: chalk.red, showPercent: true, showCount: true })}`
    );
    console.log(
      `  ${chalk.green('Done')}         ${progressBar(done, total, 30, { filled: chalk.green, showPercent: true, showCount: true })}`
    );
    if (wontDo > 0) {
      console.log(
        `  ${chalk.dim("Won't Do")}     ${progressBar(wontDo, total, 30, { filled: chalk.dim, showPercent: true, showCount: true })}`
      );
    }
    console.log('');

    // Per-priority progress
    console.log(sectionHeader('Progress by Priority'));
    console.log('');

    for (let p = 0; p <= 4; p++) {
      const priority = p as TaskPriority;
      const priorityTasks = allTasks.filter((t) => t.priority === priority);
      const priorityDone = priorityTasks.filter(
        (t) => t.status === 'done' || t.status === 'wont_do'
      ).length;
      const priorityTotal = priorityTasks.length;

      if (priorityTotal > 0) {
        const color =
          p === 0 ? chalk.red : p === 1 ? chalk.yellow : p === 2 ? chalk.blue : chalk.dim;
        const label = PRIORITY_LABELS[priority].padEnd(14);
        console.log(
          `  ${color(label)} ${progressBar(priorityDone, priorityTotal, 25, {
            filled: color,
            showPercent: true,
            showCount: true,
          })}`
        );
      }
    }
    console.log('');

    // Per-type progress
    const typeData = (Object.entries(stats.byType) as [TaskType, number][]).filter(
      ([, count]) => count > 0
    );

    if (typeData.length > 0) {
      console.log(sectionHeader('Progress by Type'));
      console.log('');

      for (const [type, typeTotal] of typeData) {
        const typeDone = allTasks.filter(
          (t) => t.type === type && (t.status === 'done' || t.status === 'wont_do')
        ).length;
        const label = `${TYPE_ICONS[type]} ${type}`.padEnd(14);
        console.log(
          `  ${label} ${progressBar(typeDone, typeTotal, 25, {
            filled: chalk.magenta,
            showPercent: true,
            showCount: true,
          })}`
        );
      }
      console.log('');
    }

    // Velocity indicator (recent completions)
    const now = new Date();
    const recentDone = allTasks.filter((t) => {
      if (t.status !== 'done' || !t.closedAt) return false;
      const closedDate = new Date(t.closedAt);
      const daysDiff = (now.getTime() - closedDate.getTime()) / (1000 * 60 * 60 * 24);
      return daysDiff <= 7;
    });

    const recentCreated = allTasks.filter((t) => {
      const createdDate = new Date(t.createdAt);
      const daysDiff = (now.getTime() - createdDate.getTime()) / (1000 * 60 * 60 * 24);
      return daysDiff <= 7;
    });

    console.log(sectionHeader('Velocity (Last 7 Days)'));
    console.log('');
    for (const line of keyValue([
      ['Completed', `${recentDone.length} tasks`],
      ['Created', `${recentCreated.length} tasks`],
      [
        'Net Progress',
        `${recentDone.length - recentCreated.length > 0 ? '+' : ''}${recentDone.length - recentCreated.length}`,
      ],
    ]))
      console.log(line);
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
    [
      'Context used',
      `${formatBytes(summary.totalContextBytes)} (~${estimatedTokens.toLocaleString()} tokens)`,
    ],
    ['Raw data processed', formatBytes(summary.totalRawBytes)],
    ['Savings ratio', `${summary.savingsRatio}x (${summary.savingsPercent} reduction)`],
  ]))
    console.log(line);

  if (summary.byTool.length > 0) {
    console.log('');
    console.log(sectionHeader('Per-Tool Breakdown'));
    console.log('');

    const rows = summary.byTool.map((t) => [
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
    console.log(
      chalk.dim('  No tool calls recorded yet. Stats populate when MCP Router processes requests.')
    );
  }

  console.log('');
}

// ==================== Session Dashboard ====================

async function showSessionDashboard(options: DashboardOptions): Promise<void> {
  if (options.compact) {
    compactSessionSummary();
    return;
  }
  const spinner = ora('Loading session dashboard...').start();

  try {
    const cwd = process.cwd();

    // ── Gather data from all sources ──
    const memDbPath = join(cwd, 'agents/data/memory/short_term.db');
    const coordDbPath = join(cwd, 'agents/data/coordination/coordination.db');
    const taskDbPath = join(cwd, '.uap/tasks/tasks.db');

    // Package version
    let version = '?';
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'));
      version = pkg.version || '?';
    } catch {
      /* ignore */
    }

    // Git info
    let gitBranch = '?';
    let gitDirty = 0;
    let gitAhead = 0;
    let lastCommit = '';
    try {
      gitBranch = execSync('git branch --show-current', {
        encoding: 'utf-8',
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      gitDirty = execSync('git status --porcelain', {
        encoding: 'utf-8',
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
        .trim()
        .split('\n')
        .filter(Boolean).length;
      gitAhead =
        parseInt(
          execSync('git rev-list --count @{u}..HEAD 2>/dev/null || echo 0', {
            encoding: 'utf-8',
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
          }).trim(),
          10
        ) || 0;
      lastCommit = execSync('git log -1 --format="%h %s" 2>/dev/null', {
        encoding: 'utf-8',
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      /* ignore */
    }

    // Memory stats
    let memEntries = 0;
    let memSizeKB = 0;
    let recentMemories: Array<{ type: string; content: string }> = [];
    if (existsSync(memDbPath)) {
      try {
        const memDb = new Database(memDbPath, { readonly: true });
        memEntries = (memDb.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;
        memSizeKB = Math.round(statSync(memDbPath).size / 1024);
        recentMemories = memDb
          .prepare(
            "SELECT type, substr(content, 1, 80) as content FROM memories WHERE timestamp >= datetime('now', '-1 day') ORDER BY id DESC LIMIT 5"
          )
          .all() as Array<{ type: string; content: string }>;
        memDb.close();
      } catch {
        /* ignore */
      }
    }

    // Session memories (open loops)
    let sessionMemCount = 0;
    let openLoops: Array<{ content: string }> = [];
    if (existsSync(memDbPath)) {
      try {
        const memDb = new Database(memDbPath, { readonly: true });
        const tables = memDb
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_memories'")
          .all();
        if (tables.length > 0) {
          sessionMemCount = (
            memDb.prepare('SELECT COUNT(*) as c FROM session_memories').get() as { c: number }
          ).c;
          openLoops = memDb
            .prepare(
              "SELECT content FROM session_memories WHERE type IN ('action','goal','decision') AND importance >= 7 ORDER BY id DESC LIMIT 5"
            )
            .all() as Array<{ content: string }>;
        }
        memDb.close();
      } catch {
        /* ignore */
      }
    }

    // Coordination stats
    let activeAgents = 0;
    let activeClaims = 0;
    let pendingDeploys = 0;
    if (existsSync(coordDbPath)) {
      try {
        const coordDb = new Database(coordDbPath, { readonly: true });
        activeAgents = (
          coordDb
            .prepare("SELECT COUNT(*) as c FROM agent_registry WHERE status='active'")
            .get() as { c: number }
        ).c;
        activeClaims = (
          coordDb.prepare('SELECT COUNT(*) as c FROM work_claims').get() as { c: number }
        ).c;
        pendingDeploys = (
          coordDb
            .prepare("SELECT COUNT(*) as c FROM deploy_queue WHERE status='pending'")
            .get() as { c: number }
        ).c;
        coordDb.close();
      } catch {
        /* ignore */
      }
    }

    // Task stats
    let taskTotal = 0;
    let taskOpen = 0;
    let taskProgress = 0;
    let taskBlocked = 0;
    let taskDone = 0;
    let activeTasks: Array<{ id: string; title: string; priority: number }> = [];
    if (existsSync(taskDbPath)) {
      try {
        const taskDb = new Database(taskDbPath, { readonly: true });
        taskTotal = (taskDb.prepare('SELECT COUNT(*) as c FROM tasks').get() as { c: number }).c;
        taskOpen = (
          taskDb.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='open'").get() as {
            c: number;
          }
        ).c;
        taskProgress = (
          taskDb.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='in_progress'").get() as {
            c: number;
          }
        ).c;
        taskBlocked = (
          taskDb.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='blocked'").get() as {
            c: number;
          }
        ).c;
        taskDone = (
          taskDb
            .prepare("SELECT COUNT(*) as c FROM tasks WHERE status='done' OR status='wont_do'")
            .get() as { c: number }
        ).c;
        activeTasks = taskDb
          .prepare(
            "SELECT id, title, priority FROM tasks WHERE status='in_progress' ORDER BY priority ASC LIMIT 5"
          )
          .all() as Array<{ id: string; title: string; priority: number }>;
        taskDb.close();
      } catch {
        /* ignore */
      }
    }

    // Qdrant status
    let qdrantStatus = 'Stopped';
    let qdrantUptime = '';
    try {
      const dockerOut = execSync('docker ps --filter name=qdrant --format "{{.Status}}"', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (dockerOut) {
        qdrantStatus = 'Running';
        qdrantUptime = dockerOut;
      }
    } catch {
      /* ignore */
    }

    // Patterns
    let patternCount = 0;
    let patternNames: string[] = [];
    const patternIndexPath = join(cwd, '.factory/patterns/index.json');
    if (existsSync(patternIndexPath)) {
      try {
        const patternData = JSON.parse(readFileSync(patternIndexPath, 'utf-8'));
        const patterns = patternData.patterns || [];
        patternCount = patterns.length;
        patternNames = patterns
          .slice(0, 5)
          .map(
            (p: { title?: string; name?: string; abbreviation?: string; id?: number | string }) =>
              p.title || p.name || p.abbreviation || `P${p.id}` || '?'
          );
      } catch {
        /* ignore */
      }
    }

    // Skills
    let skillNames: string[] = [];
    const skillDirs = [join(cwd, '.claude/skills'), join(cwd, '.factory/skills')];
    for (const dir of skillDirs) {
      if (existsSync(dir)) {
        try {
          const entries = readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() && existsSync(join(dir, entry.name, 'SKILL.md'))) {
              skillNames.push(entry.name);
            }
          }
        } catch {
          /* ignore */
        }
      }
    }

    // Droids
    let droidNames: string[] = [];
    const droidDir = join(cwd, '.factory/droids');
    if (existsSync(droidDir)) {
      try {
        const entries = readdirSync(droidDir).filter(
          (f) => f.endsWith('.md') && !f.startsWith('test-droid-')
        );
        droidNames = entries.map((f) => f.replace('.md', ''));
      } catch {
        /* ignore */
      }
    }

    // Worktrees
    let worktreeCount = 0;
    const worktreeDir = join(cwd, '.worktrees');
    if (existsSync(worktreeDir)) {
      try {
        worktreeCount = readdirSync(worktreeDir, { withFileTypes: true }).filter((e) =>
          e.isDirectory()
        ).length;
      } catch {
        /* ignore */
      }
    }

    spinner.stop();

    // ── Render ──
    console.log('');
    console.log(chalk.bold.cyan('  UAP Session Dashboard'));
    console.log(divider(62));
    console.log('');

    // System info
    console.log(sectionHeader('System'));
    console.log('');
    for (const line of keyValue([
      ['Version', `v${version}`],
      [
        'Branch',
        `${gitBranch}${gitDirty > 0 ? chalk.yellow(` (${gitDirty} uncommitted)`) : chalk.green(' (clean)')}`,
      ],
      ['Ahead', gitAhead > 0 ? chalk.yellow(`${gitAhead} commits`) : chalk.dim('up to date')],
      ['Last Commit', lastCommit.length > 55 ? lastCommit.slice(0, 55) + '...' : lastCommit],
    ]))
      console.log(line);
    console.log('');

    // Task progress
    console.log(sectionHeader('Tasks'));
    console.log('');
    if (taskTotal > 0) {
      const pct = Math.round((taskDone / taskTotal) * 100);
      console.log(
        `  ${progressBar(taskDone, taskTotal, 30, {
          label: 'Progress',
          filled: pct >= 80 ? chalk.green : pct >= 50 ? chalk.yellow : chalk.white,
        })}`
      );
      console.log('');

      const segments: BarSegment[] = [
        { value: taskDone, color: chalk.green, label: 'Done' },
        { value: taskProgress, color: chalk.cyan, label: 'Active' },
        { value: taskOpen, color: chalk.white, label: 'Open' },
        { value: taskBlocked, color: chalk.red, label: 'Blocked' },
      ];
      console.log(`  ${stackedBar(segments, taskTotal, 40)}`);
      console.log(`  ${stackedBarLegend(segments)}`);
      console.log('');

      if (activeTasks.length > 0) {
        console.log(chalk.dim('  Active:'));
        for (const t of activeTasks) {
          console.log(
            `    ${chalk.cyan(t.id)} P${t.priority} ${t.title.slice(0, 45)}${t.title.length > 45 ? '...' : ''}`
          );
        }
        console.log('');
      }
    } else {
      console.log(chalk.dim('  No tasks tracked. Create with: uap task create --title "..."'));
      console.log('');
    }

    // Memory layers
    console.log(sectionHeader('Memory System'));
    console.log('');

    const memItems: Array<{ text: string; status: 'ok' | 'warn' | 'error' | 'info' }> = [
      {
        text: `L1 Working Memory: ${chalk.bold(memEntries + ' entries')} ${chalk.dim(`(${memSizeKB} KB)`)}`,
        status: existsSync(memDbPath) ? 'ok' : 'warn',
      },
      {
        text: `L2 Session Memory: ${chalk.bold(sessionMemCount + ' entries')} ${openLoops.length > 0 ? chalk.yellow(`(${openLoops.length} open loops)`) : ''}`,
        status: sessionMemCount > 0 ? 'ok' : 'info',
      },
      {
        text: `L3 Semantic Memory: ${qdrantStatus === 'Running' ? chalk.green('Qdrant ' + qdrantUptime) : chalk.dim('Qdrant stopped')}`,
        status: qdrantStatus === 'Running' ? 'ok' : 'warn',
      },
      {
        text: `L4 Knowledge Graph: ${existsSync(memDbPath) ? chalk.green('Active') : chalk.dim('Not initialized')}`,
        status: existsSync(memDbPath) ? 'ok' : 'warn',
      },
    ];
    for (const line of bulletList(memItems)) console.log(line);

    if (recentMemories.length > 0) {
      console.log('');
      console.log(chalk.dim('  Recent memories (24h):'));
      for (const mem of recentMemories.slice(0, 3)) {
        console.log(`    ${chalk.dim(mem.type + ':')} ${mem.content}`);
      }
    }
    console.log('');

    // Coordination
    console.log(sectionHeader('Coordination'));
    console.log('');
    for (const line of keyValue([
      ['Active Agents', activeAgents > 0 ? chalk.green(String(activeAgents)) : chalk.dim('0')],
      ['Resource Claims', activeClaims > 0 ? chalk.yellow(String(activeClaims)) : chalk.dim('0')],
      [
        'Pending Deploys',
        pendingDeploys > 0 ? chalk.yellow(String(pendingDeploys)) : chalk.dim('0'),
      ],
      ['Worktrees', worktreeCount > 0 ? chalk.yellow(String(worktreeCount)) : chalk.dim('0')],
    ]))
      console.log(line);
    console.log('');

    // Patterns & Skills
    console.log(sectionHeader('Intelligence'));
    console.log('');

    if (patternCount > 0) {
      console.log(`  ${chalk.blue('Patterns')} ${chalk.bold(String(patternCount))} loaded`);
      if (patternNames.length > 0) {
        for (const name of patternNames) {
          console.log(`    ${chalk.dim('-')} ${name}`);
        }
        if (patternCount > 5) console.log(chalk.dim(`    ... and ${patternCount - 5} more`));
      }
    } else {
      console.log(chalk.dim('  Patterns: None loaded'));
    }
    console.log('');

    if (skillNames.length > 0) {
      console.log(`  ${chalk.green('Skills')} ${chalk.bold(String(skillNames.length))} available`);
      for (const name of skillNames) {
        console.log(`    ${chalk.dim('-')} ${name}`);
      }
    } else {
      console.log(chalk.dim('  Skills: None configured'));
    }
    console.log('');

    if (droidNames.length > 0) {
      console.log(
        `  ${chalk.magenta('Droids')} ${chalk.bold(String(droidNames.length))} registered`
      );
      for (const name of droidNames.slice(0, 5)) {
        console.log(`    ${chalk.dim('-')} ${name}`);
      }
      if (droidNames.length > 5)
        console.log(chalk.dim(`    ... and ${droidNames.length - 5} more`));
    } else {
      console.log(chalk.dim('  Droids: None registered'));
    }
    console.log('');

    // Policies
    console.log(sectionHeader('Policies'));
    console.log('');
    const policyItems: Array<{ text: string; status: 'ok' | 'warn' | 'error' | 'info' }> = [
      { text: 'IaC State Parity', status: 'ok' },
      { text: 'Mandatory File Backup', status: 'ok' },
    ];
    const imgPolicyPath = join(cwd, 'policies/image-asset-verification.md');
    if (existsSync(imgPolicyPath)) {
      policyItems.push({ text: 'Image & Asset Verification', status: 'info' });
    }
    for (const line of bulletList(policyItems)) console.log(line);
    console.log('');

    // Open loops
    if (openLoops.length > 0) {
      console.log(sectionHeader('Open Loops'));
      console.log('');
      for (const loop of openLoops) {
        console.log(
          `  ${chalk.yellow('>')} ${loop.content.slice(0, 70)}${loop.content.length > 70 ? '...' : ''}`
        );
      }
      console.log('');
    }

    // Summary box
    const summaryLines = [
      `v${version} on ${chalk.cyan(gitBranch)}${gitDirty > 0 ? chalk.yellow(' *') : ''}`,
      `${chalk.bold(String(taskTotal))} tasks (${taskDone} done, ${taskProgress} active, ${taskBlocked} blocked)`,
      `${chalk.bold(String(memEntries))} memories | Qdrant: ${qdrantStatus === 'Running' ? chalk.green('ON') : chalk.dim('OFF')}`,
      `${patternCount} patterns | ${skillNames.length} skills | ${droidNames.length} droids`,
    ];
    for (const line of box('UAP Session', summaryLines, { borderColor: chalk.cyan })) {
      console.log(`  ${line}`);
    }
    console.log('');
  } catch (error) {
    spinner.fail('Failed to load session dashboard');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  }
}

// ==================== Compact Session Summary (for post-task / pre-compact) ====================

/**
 * Renders a compact session summary panel.
 * Used after task completion and before context compaction to give
 * the agent (and user) a quick snapshot of UAP operational state.
 */
export function compactSessionSummary(): void {
  const cwd = process.cwd();
  const memDbPath = join(cwd, 'agents/data/memory/short_term.db');
  const coordDbPath = join(cwd, 'agents/data/coordination/coordination.db');
  const taskDbPath = join(cwd, '.uap/tasks/tasks.db');

  // Version
  let version = '?';
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'));
    version = pkg.version || '?';
  } catch {
    /* ignore */
  }

  // Git
  let gitBranch = '?';
  let gitDirty = 0;
  try {
    gitBranch = execSync('git branch --show-current', {
      encoding: 'utf-8',
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    gitDirty = execSync('git status --porcelain', {
      encoding: 'utf-8',
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
      .trim()
      .split('\n')
      .filter(Boolean).length;
  } catch {
    /* ignore */
  }

  // Tasks
  let taskTotal = 0;
  let taskDone = 0;
  let taskProgress = 0;
  let taskBlocked = 0;
  let taskOpen = 0;
  if (existsSync(taskDbPath)) {
    try {
      const db = new Database(taskDbPath, { readonly: true });
      taskTotal = (db.prepare('SELECT COUNT(*) as c FROM tasks').get() as { c: number }).c;
      taskDone = (
        db
          .prepare("SELECT COUNT(*) as c FROM tasks WHERE status='done' OR status='wont_do'")
          .get() as { c: number }
      ).c;
      taskProgress = (
        db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='in_progress'").get() as {
          c: number;
        }
      ).c;
      taskBlocked = (
        db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='blocked'").get() as { c: number }
      ).c;
      taskOpen = (
        db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='open'").get() as { c: number }
      ).c;
      db.close();
    } catch {
      /* ignore */
    }
  }

  // Memory
  let memEntries = 0;
  if (existsSync(memDbPath)) {
    try {
      const db = new Database(memDbPath, { readonly: true });
      memEntries = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;
      db.close();
    } catch {
      /* ignore */
    }
  }

  // Agents
  let activeAgents = 0;
  if (existsSync(coordDbPath)) {
    try {
      const db = new Database(coordDbPath, { readonly: true });
      activeAgents = (
        db.prepare("SELECT COUNT(*) as c FROM agent_registry WHERE status='active'").get() as {
          c: number;
        }
      ).c;
      db.close();
    } catch {
      /* ignore */
    }
  }

  // Qdrant
  let qdrantOn = false;
  try {
    const out = execSync('docker ps --filter name=qdrant --format "{{.Status}}"', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    qdrantOn = !!out;
  } catch {
    /* ignore */
  }

  // Patterns, Skills, Droids counts
  let patternCount = 0;
  let skillCount = 0;
  let droidCount = 0;
  try {
    const pi = join(cwd, '.factory/patterns/index.json');
    if (existsSync(pi)) {
      patternCount = JSON.parse(readFileSync(pi, 'utf-8')).patterns?.length || 0;
    }
  } catch {
    /* ignore */
  }
  for (const dir of [join(cwd, '.claude/skills'), join(cwd, '.factory/skills')]) {
    if (existsSync(dir)) {
      try {
        skillCount += readdirSync(dir, { withFileTypes: true }).filter(
          (e) => e.isDirectory() && existsSync(join(dir, e.name, 'SKILL.md'))
        ).length;
      } catch {
        /* ignore */
      }
    }
  }
  const dd = join(cwd, '.factory/droids');
  if (existsSync(dd)) {
    try {
      droidCount = readdirSync(dd).filter(
        (f) => f.endsWith('.md') && !f.startsWith('test-droid-')
      ).length;
    } catch {
      /* ignore */
    }
  }

  // Build task progress bar
  const barW = 20;
  const pct = taskTotal > 0 ? Math.round((taskDone / taskTotal) * 100) : 0;
  const filledW = taskTotal > 0 ? Math.round((taskDone / taskTotal) * barW) : 0;
  const pctColor = pct >= 80 ? chalk.green : pct >= 50 ? chalk.yellow : chalk.white;
  const taskBar =
    chalk.green('\u2588'.repeat(filledW)) + chalk.dim('\u2591'.repeat(barW - filledW));

  // Render compact box
  const W = 58;
  // W used for box width below

  console.log('');
  console.log(chalk.cyan(`  \u256D${'─'.repeat(W)}\u256E`));
  console.log(
    chalk.cyan(`  │`) +
      chalk.bold.white(` UAP v${version}`) +
      chalk.dim(` on ${gitBranch}${gitDirty > 0 ? ' *' : ''}`) +
      ' '.repeat(Math.max(0, W - 12 - version.length - gitBranch.length - (gitDirty > 0 ? 2 : 0))) +
      chalk.cyan(`│`)
  );
  console.log(chalk.cyan(`  ├${'─'.repeat(W)}┤`));

  // Task line
  if (taskTotal > 0) {
    const taskLine = ` ${taskBar} ${pctColor(pct + '%')} ${chalk.dim(`${taskDone}/${taskTotal}`)}  ${chalk.green(taskDone + '\u2713')} ${chalk.cyan(taskProgress + '\u25D0')} ${taskBlocked > 0 ? chalk.red(taskBlocked + '\u2744') + ' ' : ''}${chalk.dim(taskOpen + '\u25CB')}`;
    // Use raw length estimation for padding
    const rawLen = ` ${'█'.repeat(barW)} ${pct}% ${taskDone}/${taskTotal}  ${taskDone}✓ ${taskProgress}◐ ${taskBlocked > 0 ? taskBlocked + '❄ ' : ''}${taskOpen}○`;
    console.log(
      chalk.cyan(`  │`) + taskLine + ' '.repeat(Math.max(0, W - rawLen.length)) + chalk.cyan(`│`)
    );
  } else {
    console.log(
      chalk.cyan(`  │`) + chalk.dim(' No tasks tracked') + ' '.repeat(W - 18) + chalk.cyan(`│`)
    );
  }

  // Memory + Qdrant line
  const memLine = ` Mem: ${memEntries} entries  Qdrant: ${qdrantOn ? 'ON' : 'OFF'}  Agents: ${activeAgents}`;
  console.log(
    chalk.cyan(`  │`) +
      (qdrantOn ? chalk.white(memLine) : chalk.dim(memLine)) +
      ' '.repeat(Math.max(0, W - memLine.length)) +
      chalk.cyan(`│`)
  );

  // Intelligence line
  const intLine = ` ${patternCount}P ${skillCount}S ${droidCount}D  L1:ON L2:ON L3:${qdrantOn ? 'ON' : '?'} L4:ON`;
  console.log(
    chalk.cyan(`  │`) +
      chalk.dim(intLine) +
      ' '.repeat(Math.max(0, W - intLine.length)) +
      chalk.cyan(`│`)
  );

  console.log(chalk.cyan(`  \u2570${'─'.repeat(W)}\u256F`));
  console.log('');
}

// ==================== Real-Time Benchmark Dashboard ====================

/**
 * Show a real-time benchmark dashboard with memory, model routing,
 * deploy batch, and pattern success stats from local databases.
 *
 * Uses simple ASCII formatting with no external dependencies beyond chalk.
 */
export function showDashboard(): void {
  const cwd = process.cwd();

  // Database paths
  const shortTermDbPath = join(cwd, 'agents/data/memory/short_term.db');
  const coordDbPath = join(cwd, 'agents/data/coordination/coordination.db');
  const modelDbPath = join(cwd, 'agents/data/memory/model_fingerprints.db');
  const patternIndexPath = join(cwd, '.factory/patterns/index.json');

  const W = 60;
  const sep = '─'.repeat(W);

  console.log('');
  console.log(chalk.bold.cyan('  Real-Time Benchmark Dashboard'));
  console.log(`  ${sep}`);
  console.log('');

  // ── Memory Stats ──
  console.log(chalk.bold('  Memory Stats'));
  console.log(`  ${chalk.dim('─'.repeat(W - 2))}`);

  let shortTermCount = 0;
  let sessionCount = 0;
  let entityCount = 0;
  let relationCount = 0;
  let shortTermSizeKB = 0;

  if (existsSync(shortTermDbPath)) {
    try {
      const db = new Database(shortTermDbPath, { readonly: true });
      shortTermSizeKB = Math.round(statSync(shortTermDbPath).size / 1024);
      shortTermCount = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;

      // Session memories
      const hasSessions = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_memories'")
        .all();
      if (hasSessions.length > 0) {
        sessionCount = (
          db.prepare('SELECT COUNT(*) as c FROM session_memories').get() as { c: number }
        ).c;
      }

      // Knowledge graph entities
      const hasEntities = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entities'")
        .all();
      if (hasEntities.length > 0) {
        entityCount = (db.prepare('SELECT COUNT(*) as c FROM entities').get() as { c: number }).c;
      }

      const hasRelations = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='relationships'")
        .all();
      if (hasRelations.length > 0) {
        relationCount = (
          db.prepare('SELECT COUNT(*) as c FROM relationships').get() as { c: number }
        ).c;
      }

      db.close();
    } catch {
      /* ignore db errors */
    }
  }

  const memRows: Array<[string, string]> = [
    ['Short-term memories', String(shortTermCount)],
    ['Session memories', String(sessionCount)],
    ['KG entities', String(entityCount)],
    ['KG relationships', String(relationCount)],
    ['DB size', `${shortTermSizeKB} KB`],
  ];
  for (const [label, value] of memRows) {
    console.log(`  ${chalk.white(label.padEnd(25))} ${chalk.bold(value)}`);
  }
  console.log('');

  // ── Model Routing Stats ──
  console.log(chalk.bold('  Model Routing Stats'));
  console.log(`  ${chalk.dim('─'.repeat(W - 2))}`);

  if (existsSync(modelDbPath)) {
    try {
      const db = new Database(modelDbPath, { readonly: true });

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>;
      const tableNames = tables.map((t) => t.name);

      if (tableNames.includes('model_fingerprints')) {
        const fpCount = (
          db.prepare('SELECT COUNT(*) as c FROM model_fingerprints').get() as { c: number }
        ).c;
        console.log(`  ${chalk.white('Fingerprints'.padEnd(25))} ${chalk.bold(String(fpCount))}`);

        // Try to get distinct models
        try {
          const models = db
            .prepare('SELECT DISTINCT model_id FROM model_fingerprints ORDER BY model_id LIMIT 10')
            .all() as Array<{ model_id: string }>;
          if (models.length > 0) {
            console.log(
              `  ${chalk.white('Tracked models'.padEnd(25))} ${chalk.bold(String(models.length))}`
            );
            for (const m of models.slice(0, 5)) {
              console.log(`    ${chalk.dim('-')} ${m.model_id}`);
            }
            if (models.length > 5) console.log(chalk.dim(`    ... and ${models.length - 5} more`));
          }
        } catch {
          /* schema variation */
        }
      }

      if (tableNames.includes('routing_decisions')) {
        const routeCount = (
          db.prepare('SELECT COUNT(*) as c FROM routing_decisions').get() as { c: number }
        ).c;
        console.log(
          `  ${chalk.white('Routing decisions'.padEnd(25))} ${chalk.bold(String(routeCount))}`
        );
      }

      db.close();
    } catch {
      console.log(chalk.dim('  Could not read model fingerprints DB'));
    }
  } else {
    console.log(chalk.dim('  No model fingerprints DB found'));
  }
  console.log('');

  // ── Deploy Batch Stats ──
  console.log(chalk.bold('  Deploy Batch Stats'));
  console.log(`  ${chalk.dim('─'.repeat(W - 2))}`);

  let deployPending = 0;
  let deployCompleted = 0;
  let deployFailed = 0;
  let batchCount = 0;

  if (existsSync(coordDbPath)) {
    try {
      const db = new Database(coordDbPath, { readonly: true });

      const hasDQ = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='deploy_queue'")
        .all();
      if (hasDQ.length > 0) {
        deployPending = (
          db.prepare("SELECT COUNT(*) as c FROM deploy_queue WHERE status='pending'").get() as {
            c: number;
          }
        ).c;
        deployCompleted = (
          db
            .prepare(
              "SELECT COUNT(*) as c FROM deploy_queue WHERE status='completed' OR status='batched'"
            )
            .get() as { c: number }
        ).c;
        deployFailed = (
          db.prepare("SELECT COUNT(*) as c FROM deploy_queue WHERE status='failed'").get() as {
            c: number;
          }
        ).c;
      }

      const hasDB = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='deploy_batches'")
        .all();
      if (hasDB.length > 0) {
        batchCount = (db.prepare('SELECT COUNT(*) as c FROM deploy_batches').get() as { c: number })
          .c;
      }

      db.close();
    } catch {
      /* ignore */
    }
  }

  const deployTotal = deployPending + deployCompleted + deployFailed;
  const deployRows: Array<[string, string]> = [
    ['Pending', String(deployPending)],
    ['Completed', String(deployCompleted)],
    ['Failed', String(deployFailed)],
    ['Total actions', String(deployTotal)],
    ['Batches', String(batchCount)],
  ];
  for (const [label, value] of deployRows) {
    const color =
      label === 'Failed' && deployFailed > 0
        ? chalk.red
        : label === 'Pending' && deployPending > 0
          ? chalk.yellow
          : chalk.white;
    console.log(`  ${color(label.padEnd(25))} ${chalk.bold(value)}`);
  }
  console.log('');

  // ── Pattern Success Rates ──
  console.log(chalk.bold('  Pattern Success Rates'));
  console.log(`  ${chalk.dim('─'.repeat(W - 2))}`);

  if (existsSync(patternIndexPath)) {
    try {
      const raw = readFileSync(patternIndexPath, 'utf-8');
      const data = JSON.parse(raw) as {
        patterns?: Array<{
          id?: number | string;
          title?: string;
          name?: string;
          abbreviation?: string;
          successRate?: number;
          uses?: number;
          active?: boolean;
        }>;
      };
      const patterns = data.patterns || [];
      const active = patterns.filter((p) => p.active !== false);
      const withRates = active.filter((p) => typeof p.successRate === 'number');

      console.log(
        `  ${chalk.white('Total patterns'.padEnd(25))} ${chalk.bold(String(patterns.length))}`
      );
      console.log(`  ${chalk.white('Active'.padEnd(25))} ${chalk.bold(String(active.length))}`);

      if (withRates.length > 0) {
        const avgRate =
          withRates.reduce((sum, p) => sum + (p.successRate || 0), 0) / withRates.length;
        console.log(
          `  ${chalk.white('Avg success rate'.padEnd(25))} ${chalk.bold(avgRate.toFixed(1) + '%')}`
        );
        console.log('');

        // Show top patterns by success rate
        const sorted = [...withRates].sort((a, b) => (b.successRate || 0) - (a.successRate || 0));
        for (const p of sorted.slice(0, 8)) {
          const name = p.title || p.name || p.abbreviation || `P${p.id}` || '?';
          const rate = p.successRate || 0;
          const barLen = Math.round(rate / 5);
          const bar =
            chalk.green('\u2588'.repeat(barLen)) + chalk.dim('\u2591'.repeat(20 - barLen));
          console.log(`  ${name.slice(0, 22).padEnd(22)} ${bar} ${rate.toFixed(0)}%`);
        }
        if (sorted.length > 8) {
          console.log(chalk.dim(`  ... and ${sorted.length - 8} more`));
        }
      } else {
        console.log(chalk.dim('  No success rate data tracked'));
      }
    } catch {
      console.log(chalk.dim('  Could not parse patterns index'));
    }
  } else {
    console.log(chalk.dim('  No patterns index found'));
  }

  console.log('');
  console.log(`  ${sep}`);
  console.log(chalk.dim('  Run: uap dashboard overview   for full project dashboard'));
  console.log(chalk.dim('  Run: uap dashboard session    for session context'));
  console.log('');
}

import chalk from 'chalk';
import ora from 'ora';
import { existsSync, statSync } from 'fs';
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
import { getPolicyMemoryManager } from '../policies/policy-memory.js';
import { getPolicyGate } from '../policies/policy-gate.js';
import { ModelRouter } from '../models/router.js';
import { ModelPresets, type MultiModelConfig } from '../models/types.js';
import { getModelAnalytics } from '../models/analytics.js';
import { detectExecutionProfile } from '../models/execution-profiles.js';
import { computeMeasuredPace } from './dashboard-pace.js';
import { showDashboard, showSessionDashboard } from './dashboard-session.js';
import type { DashboardOptions } from './dashboard-types.js';

type DashboardAction =
  | 'overview'
  | 'tasks'
  | 'agents'
  | 'memory'
  | 'progress'
  | 'stats'
  | 'session'
  | 'benchmark'
  | 'policies'
  | 'models'
  | 'serve'
  | 'export'
  | 'history';

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
    case 'policies':
      await showPoliciesDashboard(options);
      break;
    case 'models':
      await showModelsDashboard(options);
      break;
    case 'serve':
      await serveDashboard(options);
      break;
    case 'export':
      await exportDashboard(options);
      break;
    case 'history':
      await showHistory(options);
      break;
  }
}

async function serveDashboard(options: DashboardOptions): Promise<void> {
  const { startDashboardServer } = await import('../dashboard/server.js');
  // --refresh takes seconds (human-friendly); the UAP_DASH_REFRESH_MS env
  // override (consumed in the server) takes milliseconds.
  const refreshSeconds = Number((options as { refresh?: string }).refresh);
  const updateIntervalMs = refreshSeconds > 0 ? Math.round(refreshSeconds * 1000) : undefined;
  const server = startDashboardServer({
    port: (options as { port?: number }).port || 3847,
    host: (options as { host?: string }).host,
    updateIntervalMs,
  });

  // Keep alive until Ctrl+C
  process.on('SIGINT', () => {
    console.log('\nShutting down dashboard server...');
    server.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    server.close();
    process.exit(0);
  });
}

async function exportDashboard(options: DashboardOptions): Promise<void> {
  const { getDashboardData } = await import('../dashboard/data-service.js');
  const data = await getDashboardData();

  if (options.verbose) {
    // CSV-like output for key tables
    console.log('# Policies');
    console.log('name,level,stage,category,active');
    for (const p of data.policies) {
      console.log(`${p.name},${p.level},${p.enforcementStage},${p.category},${p.isActive}`);
    }
    console.log('');
    console.log('# Model Usage');
    console.log('model,tasks,tokens_in,tokens_out,cost,success_rate');
    for (const m of data.models.sessionUsage) {
      console.log(
        `${m.modelId},${m.taskCount},${m.totalTokensIn},${m.totalTokensOut},${m.totalCost},${m.successRate}`
      );
    }
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

async function showHistory(_options: DashboardOptions): Promise<void> {
  const cwd = process.cwd();
  // History lives in telemetry.db's session_history table (written by the
  // dashboard on each refresh). The old path read session_snapshots.db — a
  // table nothing writes, so the command always reported "no history" (dash
  // audit).
  const telemetryDbPath = join(cwd, 'agents', 'data', 'memory', 'telemetry.db');

  if (!existsSync(telemetryDbPath)) {
    console.log(chalk.dim('No session history found. Start the dashboard to record sessions.'));
    return;
  }

  try {
    const db = new Database(telemetryDbPath, { readonly: true });
    const rows = db
      .prepare(
        `SELECT session_id, status, started_at, duration_ms, total_cost, task_count, model
         FROM session_history ORDER BY started_at DESC LIMIT 20`
      )
      .all() as Array<Record<string, unknown>>;
    db.close();

    if (rows.length === 0) {
      console.log(chalk.dim('No session history recorded yet.'));
      return;
    }

    console.log('');
    console.log(chalk.bold.cyan('  Session History'));
    console.log(divider(70));
    console.log('');
    console.log(
      `  ${'Started'.padEnd(22)} ${'Duration'.padEnd(12)} ${'Cost'.padEnd(10)} ${'Tasks'.padEnd(8)} ${'Status'.padEnd(8)} Model`
    );
    console.log(
      `  ${'─'.repeat(22)} ${'─'.repeat(12)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(16)}`
    );

    for (const row of rows) {
      const ts = ((row.started_at as string) || '').slice(0, 19);
      const dur = row.duration_ms ? `${Math.round((row.duration_ms as number) / 1000)}s` : '?';
      const cost = row.total_cost ? `$${(row.total_cost as number).toFixed(4)}` : '$0';
      const tasks = String(row.task_count || 0);
      const status = String(row.status || '-');
      const model = String(row.model || 'unknown');
      console.log(
        `  ${ts.padEnd(22)} ${dur.padEnd(12)} ${cost.padEnd(10)} ${tasks.padEnd(8)} ${status.padEnd(8)} ${model}`
      );
    }
    console.log('');
  } catch (error) {
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
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

    // Embeddings (llama.cpp server)
    const embeddingEndpoint = process.env.UAP_EMBEDDING_ENDPOINT || 'http://192.168.1.165:8081';
    console.log(sectionHeader('Embeddings (llama.cpp)'));
    console.log('');

    try {
      const embedResponse = await fetch(`${embeddingEndpoint}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      });

      if (embedResponse.ok) {
        console.log(`  ${statusBadge('active')}`);
        console.log(`  ${chalk.cyan('nomic-embed-text-v2-moe')} ${chalk.dim(`(${embeddingEndpoint})`)}`);
      } else {
        console.log(`  ${statusBadge('stopped')} Not responding`);
        console.log(chalk.dim(`  Endpoint: ${embeddingEndpoint}`));
      }
    } catch {
      console.log(`  ${statusBadge('not_available')} Embedding server not running`);
      console.log(chalk.dim(`  Expected at: ${embeddingEndpoint}`));
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

    // Compression stats from session
    console.log(sectionHeader('Context Compression'));
    console.log('');
    const sessionStats = globalSessionStats.getSummary();
    if (sessionStats.totalCalls > 0) {
      const rawKB = Math.round(sessionStats.totalRawBytes / 1024);
      const ctxKB = Math.round(sessionStats.totalContextBytes / 1024);
      console.log(`  ${chalk.white('Raw bytes'.padEnd(25))} ${chalk.bold(rawKB + ' KB')}`);
      console.log(`  ${chalk.white('Context bytes'.padEnd(25))} ${chalk.bold(ctxKB + ' KB')}`);
      console.log(
        `  ${chalk.white('Savings'.padEnd(25))} ${chalk.green(sessionStats.savingsPercent)}`
      );
      console.log(
        `  ${chalk.white('Tool calls'.padEnd(25))} ${chalk.bold(String(sessionStats.totalCalls))}`
      );
    } else {
      console.log(chalk.dim('  No compression data this session'));
    }
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

async function showPoliciesDashboard(options: DashboardOptions): Promise<void> {
  const spinner = ora('Loading policies dashboard...').start();

  try {
    const policyMgr = getPolicyMemoryManager();
    const gate = getPolicyGate();
    const allPolicies = await policyMgr.getAllPolicies();

    spinner.stop();

    console.log('');
    console.log(chalk.bold.cyan('  UAP Policies Dashboard'));
    console.log(divider(62));
    console.log('');

    // Active policies table
    console.log(sectionHeader(`Active Policies (${allPolicies.length})`));
    console.log('');

    if (allPolicies.length === 0) {
      console.log(chalk.dim('  No policies configured. Add with: uap policy add -f <file>'));
    } else {
      console.log(
        `  ${'Name'.padEnd(28)} ${'Level'.padEnd(14)} ${'Stage'.padEnd(12)} ${'Category'.padEnd(10)} Status`
      );
      console.log(
        `  ${'─'.repeat(28)} ${'─'.repeat(14)} ${'─'.repeat(12)} ${'─'.repeat(10)} ${'─'.repeat(6)}`
      );
      for (const policy of allPolicies) {
        const stage = policy.enforcementStage || 'pre-exec';
        const status = policy.isActive ? chalk.green('ON') : chalk.red('OFF');
        const levelColor =
          policy.level === 'REQUIRED'
            ? chalk.red
            : policy.level === 'RECOMMENDED'
              ? chalk.yellow
              : chalk.dim;
        console.log(
          `  ${policy.name.slice(0, 28).padEnd(28)} ${levelColor(policy.level.padEnd(14))} ${stage.padEnd(12)} ${policy.category.padEnd(10)} ${status}`
        );
      }
    }
    console.log('');

    // Enforcement stages breakdown
    const stageGroups: Record<string, number> = {
      'pre-exec': 0,
      'post-exec': 0,
      review: 0,
      always: 0,
    };
    for (const p of allPolicies) {
      const stage = p.enforcementStage || 'pre-exec';
      stageGroups[stage] = (stageGroups[stage] || 0) + 1;
    }

    console.log(sectionHeader('Enforcement Stages'));
    console.log('');
    for (const [stage, count] of Object.entries(stageGroups)) {
      const barLen = Math.min(count * 5, 30);
      const bar = chalk.cyan('\u2588'.repeat(barLen)) + chalk.dim('\u2591'.repeat(30 - barLen));
      console.log(`  ${stage.padEnd(12)} ${bar} ${count} policies`);
    }
    console.log('');

    // Level breakdown
    const levelGroups: Record<string, number> = { REQUIRED: 0, RECOMMENDED: 0, OPTIONAL: 0 };
    for (const p of allPolicies) {
      levelGroups[p.level] = (levelGroups[p.level] || 0) + 1;
    }

    console.log(sectionHeader('Enforcement Levels'));
    console.log('');
    for (const [level, count] of Object.entries(levelGroups)) {
      const color =
        level === 'REQUIRED' ? chalk.red : level === 'RECOMMENDED' ? chalk.yellow : chalk.dim;
      console.log(`  ${color(level.padEnd(14))} ${chalk.bold(String(count))}`);
    }
    console.log('');

    // Audit trail
    const auditEntries = await gate.getAuditTrail(undefined, 10);
    if (auditEntries.length > 0) {
      console.log(sectionHeader('Recent Audit Trail'));
      console.log('');
      for (const entry of auditEntries) {
        const icon = entry.allowed ? chalk.green('PASS') : chalk.red('BLOCK');
        const time = typeof entry.executedAt === 'string' ? entry.executedAt.slice(0, 19) : '';
        const op = typeof entry.operation === 'string' ? entry.operation : '';
        const reason = typeof entry.reason === 'string' ? entry.reason.slice(0, 40) : '';
        console.log(`  ${chalk.dim(time)}  ${icon}  ${op.padEnd(20)} ${chalk.dim(reason)}`);
      }
    } else {
      console.log(chalk.dim('  No audit trail entries yet'));
    }
    console.log('');

    // Per-task filtering
    if (options.taskId) {
      console.log(sectionHeader(`Policy Checks for Task: ${options.taskId}`));
      console.log('');
      const taskAudit = await gate.getAuditTrail(undefined, 50);
      const taskEntries = taskAudit.filter((e) => e.taskId === options.taskId);
      if (taskEntries.length > 0) {
        for (const entry of taskEntries) {
          const icon = entry.allowed ? chalk.green('PASS') : chalk.red('BLOCK');
          console.log(`  ${icon} ${entry.operation || 'unknown'} - ${entry.reason || 'OK'}`);
        }
      } else {
        console.log(chalk.dim('  No policy checks recorded for this task'));
      }
      console.log('');
    }

    // Help
    console.log(chalk.dim('  Toggle: uap policy toggle <id> --off'));
    console.log(chalk.dim('  Stage:  uap policy stage <id> -s post-exec'));
    console.log(chalk.dim('  Level:  uap policy level <id> -l OPTIONAL'));
    console.log('');
  } catch (error) {
    spinner.fail('Failed to load policies dashboard');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  }
}

async function showModelsDashboard(options: DashboardOptions): Promise<void> {
  const spinner = ora('Loading models dashboard...').start();

  try {
    // Load UAP config
    const { loadUapConfig: loadCfg } = await import('../utils/config-loader.js');
    let mmConfig: MultiModelConfig = {
      enabled: true,
      models: ['opus-4.6', 'qwen35-a3b'],
      roles: { planner: 'opus-4.6', executor: 'qwen35-a3b', fallback: 'qwen35-a3b' },
      routingStrategy: 'balanced',
    };
    try {
      const cfg = loadCfg();
      if (cfg?.multiModel) mmConfig = cfg.multiModel as typeof mmConfig;
    } catch {
      /* use defaults */
    }

    const router = new ModelRouter(mmConfig);
    const analytics = getModelAnalytics();

    spinner.stop();

    console.log('');
    console.log(chalk.bold.cyan('  UAP Model Dashboard'));
    console.log(divider(62));
    console.log('');

    // Active configuration
    console.log(sectionHeader('Active Configuration'));
    console.log('');
    const roles = mmConfig.roles || { planner: 'opus-4.6', executor: 'qwen35-a3b', fallback: 'qwen35-a3b' };
    const plannerPreset = ModelPresets[roles.planner || 'opus-4.6'];
    const executorPreset = ModelPresets[roles.executor || 'qwen35-a3b'];
    const fallbackPreset = ModelPresets[roles.fallback || 'qwen35-a3b'];

    const roleRows: Array<[string, string, string, string]> = [
      [
        'Planner',
        roles.planner || 'opus-4.6',
        plannerPreset?.name || '?',
        `$${(plannerPreset?.costPer1MInput || 0).toFixed(2)}/$${(plannerPreset?.costPer1MOutput || 0).toFixed(2)}`,
      ],
      [
        'Executor',
        roles.executor || 'qwen35-a3b',
        executorPreset?.name || '?',
        `$${(executorPreset?.costPer1MInput || 0).toFixed(2)}/$${(executorPreset?.costPer1MOutput || 0).toFixed(2)}`,
      ],
      ['Reviewer', roles.reviewer || roles.planner || 'opus-4.6', plannerPreset?.name || '?', ''],
      ['Fallback', roles.fallback || 'qwen35-a3b', fallbackPreset?.name || '?', ''],
    ];
    for (const [role, id, name, cost] of roleRows) {
      const roleColor =
        role === 'Planner' ? chalk.green : role === 'Executor' ? chalk.blue : chalk.dim;
      console.log(
        `  ${roleColor(role.padEnd(10))} ${chalk.cyan(id.padEnd(14))} ${name.padEnd(22)} ${chalk.dim(cost)}`
      );
    }
    console.log(`  ${'Strategy'.padEnd(10)} ${chalk.cyan(mmConfig.routingStrategy)}`);
    console.log('');

    // Routing matrix
    console.log(sectionHeader('Routing Matrix'));
    console.log('');
    console.log(`  ${'Complexity'.padEnd(12)} ${'Model'.padEnd(16)} ${'Est. Cost'}`);
    console.log(`  ${'─'.repeat(12)} ${'─'.repeat(16)} ${'─'.repeat(10)}`);
    for (const complexity of ['low', 'medium', 'high', 'critical'] as const) {
      const result = router.classifyTask(`A ${complexity} complexity task`);
      const model = result.suggestedModel;
      const preset = ModelPresets[model];
      const cost = preset ? router.estimateCost(preset, 10000, 5000) : 0;
      const complexityColor =
        complexity === 'critical'
          ? chalk.red
          : complexity === 'high'
            ? chalk.yellow
            : complexity === 'medium'
              ? chalk.blue
              : chalk.green;
      console.log(
        `  ${complexityColor(complexity.padEnd(12))} ${chalk.cyan(model.padEnd(16))} $${cost.toFixed(4)}`
      );
    }
    console.log('');

    // Session usage from analytics
    const sessionUsage = analytics.getSessionUsage();
    if (sessionUsage.length > 0) {
      console.log(sectionHeader('Session Usage'));
      console.log('');
      console.log(
        `  ${'Model'.padEnd(14)} ${'Tasks'.padEnd(7)} ${'Tokens In'.padEnd(12)} ${'Tokens Out'.padEnd(12)} ${'Cost'.padEnd(10)} ${'Success'}`
      );
      console.log(
        `  ${'─'.repeat(14)} ${'─'.repeat(7)} ${'─'.repeat(12)} ${'─'.repeat(12)} ${'─'.repeat(10)} ${'─'.repeat(7)}`
      );
      for (const usage of sessionUsage) {
        const rate = (usage.successRate * 100).toFixed(1) + '%';
        console.log(
          `  ${chalk.cyan(usage.modelId.padEnd(14))} ${String(usage.taskCount).padEnd(7)} ${String(usage.totalTokensIn).padEnd(12)} ${String(usage.totalTokensOut).padEnd(12)} $${usage.totalCost.toFixed(4).padEnd(9)} ${rate}`
        );
      }
      console.log('');

      const totalCost = analytics.getTotalCost();
      console.log(`  ${chalk.bold('Total session cost:')} $${totalCost.toFixed(4)}`);
      console.log('');
    } else {
      console.log(chalk.dim('  No model usage recorded this session'));
      console.log('');
    }

    // Measured pace: the agent's own EWMA estimates per
    // (model, taskType, complexity) key — the operator's legibility surface
    // for "how long does this model actually take here". Only keys with a
    // real estimate get a row; the honest caveat (spread, n, failure rate)
    // travels with the number.
    const pace = await computeMeasuredPace(analytics);
    if (pace.rows.length > 0) {
      console.log(sectionHeader('Measured Pace (ETA — from this project\'s own history)'));
      console.log('');
      console.log(
        `  ${'Model'.padEnd(14)} ${'Key'.padEnd(22)} ${'Per task'.padEnd(10)} ${'Spread'.padEnd(16)} ${'N'.padEnd(8)} Success`
      );
      console.log(
        `  ${'─'.repeat(14)} ${'─'.repeat(22)} ${'─'.repeat(10)} ${'─'.repeat(16)} ${'─'.repeat(8)} ${'─'.repeat(7)}`
      );
      for (const r of pace.rows) {
        console.log(
          `  ${chalk.cyan(r.modelId.padEnd(14))} ${r.key.padEnd(22)}` +
            ` ${r.perTask.padEnd(10)} ${r.spread.padEnd(16)} ${r.n.padEnd(8)} ${r.successPct}`
        );
      }
      if (pace.more > 0) {
        console.log(chalk.dim(`  (… and ${pace.more} more key(s) with history beyond the top 8 by attempts)`));
      }
      if (pace.thin > 0) {
        console.log(chalk.dim(`  (+${pace.thin} more key(s) with history too thin to estimate — needs ≥3 successes)`));
      }
      console.log('');
    }

    // Execution profile for executor
    const executorModel = roles.executor || 'qwen35-a3b';
    const executorApiModel = ModelPresets[executorModel]?.apiModel || executorModel;
    const profile = detectExecutionProfile(executorApiModel);
    console.log(sectionHeader(`Execution Profile: ${profile.name}`));
    console.log('');
    const profileConfig = profile.config;
    const flagPairs: Array<[string, unknown]> = [
      ['domainHints', profileConfig.domainHints],
      ['webSearch', profileConfig.webSearch],
      ['reflectionCheckpoints', profileConfig.reflectionCheckpoints],
      ['temperature', profileConfig.temperature],
      ['loopEscapeThreshold', profileConfig.loopEscapeThreshold],
      ['toolChoiceForce', profileConfig.toolChoiceForce],
      ['softBudget', profileConfig.softBudget],
      ['hardBudget', profileConfig.hardBudget],
    ];
    const flagLines: string[] = [];
    for (const [key, val] of flagPairs) {
      const display =
        typeof val === 'boolean'
          ? val
            ? chalk.green('ON')
            : chalk.red('OFF')
          : chalk.cyan(val != null ? String(val) : chalk.dim('(not set)'));
      flagLines.push(`${key}: ${display}`);
    }
    // Print 3 per line
    for (let i = 0; i < flagLines.length; i += 3) {
      const chunk = flagLines.slice(i, i + 3);
      console.log(`  ${chunk.map((f) => f.padEnd(28)).join('')}`);
    }
    console.log('');

    // Per-task view
    if (options.taskId) {
      console.log(sectionHeader(`Model Usage for Task: ${options.taskId}`));
      console.log('');
      const taskOutcomes = analytics.getTaskOutcomes(options.taskId);
      if (taskOutcomes.length > 0) {
        for (const outcome of taskOutcomes) {
          const icon = outcome.success ? chalk.green('OK') : chalk.red('FAIL');
          console.log(
            `  ${icon} ${chalk.cyan(outcome.modelId)} ${outcome.taskType} ${outcome.complexity} ${outcome.durationMs}ms $${outcome.cost.toFixed(4)}`
          );
        }
      } else {
        console.log(chalk.dim('  No outcomes recorded for this task'));
      }
      console.log('');
    }

    // Optimal routing suggestions
    const optimal = analytics.getOptimalRouting();
    if (Object.keys(optimal).length > 0) {
      console.log(sectionHeader('Optimal Routing (from history)'));
      console.log('');
      for (const [taskType, modelId] of Object.entries(optimal)) {
        console.log(`  ${taskType.padEnd(16)} -> ${chalk.cyan(modelId)}`);
      }
      console.log('');
    }
  } catch (error) {
    spinner.fail('Failed to load models dashboard');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  }
}

// ==================== Compact Session Summary (for post-task / pre-compact) ====================

/**
 * Renders a compact session summary panel.
 * Used after task completion and before context compaction to give
 * the agent (and user) a quick snapshot of UAP operational state.
 */

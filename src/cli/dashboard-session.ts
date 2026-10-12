/**
 * The dashboard's SESSION operator surface, split from src/cli/dashboard.ts
 * (that module was the repo's worst LOC offender and every new surface was
 * growing it; the grants + pace sections moved out first, these follow the
 * same pattern). Three views live here because they are one family:
 *
 * - showSessionDashboard — `uap dashboard session`: the operator's live
 *   one-glance state (version, git, tasks, memory, patterns, skills, droids,
 *   the Sandbox Grants section with its anchor verdict, the summary box).
 * - showDashboard — the legacy one-shot "Real-Time Benchmark Dashboard"
 *   (direct read-only DB reads; kept for `uap dashboard benchmark`).
 * - compactSessionSummary — the one-line terminal-title/brief summary other
 *   CLI surfaces print after their own work (task flows).
 */

import chalk from 'chalk';
import ora from 'ora';
import { existsSync, statSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import {
  progressBar,
  stackedBar,
  stackedBarLegend,
  box,
  sectionHeader,
  keyValue,
  divider,
  bulletList,
  type BarSegment,
} from './visualize.js';
import { getPolicyMemoryManager } from '../policies/policy-memory.js';
import { sandboxGrantsLines } from './dashboard-grants.js';
import type { DashboardOptions } from './dashboard-types.js';

export async function showSessionDashboard(options: DashboardOptions): Promise<void> {
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
              p.title || p.name || p.abbreviation || (p.id != null ? `P${p.id}` : '?')
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
        console.log(`    ${chalk.dim((mem.type || 'unknown') + ':')} ${mem.content || ''}`);
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

    // Policies (DB-driven)
    console.log(sectionHeader('Policies'));
    console.log('');
    try {
      const policyMgr = getPolicyMemoryManager();
      const allPolicies = await policyMgr.getAllPolicies();
      if (allPolicies.length > 0) {
        for (const policy of allPolicies) {
          const stageLabel = policy.enforcementStage || 'pre-exec';
          const levelColor =
            policy.level === 'REQUIRED'
              ? chalk.red
              : policy.level === 'RECOMMENDED'
                ? chalk.yellow
                : chalk.dim;
          console.log(
            `  ${levelColor(policy.level.padEnd(14))} ${policy.name.slice(0, 30).padEnd(30)} ${chalk.dim(stageLabel)}`
          );
        }
      } else {
        console.log(chalk.dim('  No policies configured. Add with: uap policy add -f <file>'));
      }
    } catch {
      console.log(chalk.dim('  Policy DB not initialized'));
    }
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

    // Sandbox grants (the ADR 0011-named surface): what extra
    // writable holes are open, for which sessions, and whether the consent
    // ledger verifies against its out-of-checkout trust anchor. Grants are
    // SESSION authority, so this renders in the session view (the review
    // caught an accidental placement in the models view). ⚠ lines are
    // warnings — color them red.
    const grantsSection = sandboxGrantsLines(process.cwd());
    for (const l of grantsSection.lines) console.log(l.trimStart().startsWith('⚠') ? chalk.red(l) : l);
    console.log('');
  } catch (error) {
    spinner.fail('Failed to load session dashboard');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  }
}


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

  // Calculate header content width accurately (without ANSI codes)
  const headerText = ` UAP v${version} on ${gitBranch}${gitDirty > 0 ? ' *' : ''}`;
  const headerPad = Math.max(0, W - headerText.length);

  console.log('');
  console.log(chalk.cyan(`  \u256D${'─'.repeat(W)}\u256E`));
  console.log(
    chalk.cyan(`  │`) +
      chalk.bold.white(` UAP v${version}`) +
      chalk.dim(` on ${gitBranch}${gitDirty > 0 ? ' *' : ''}`) +
      ' '.repeat(headerPad) +
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
          const name = p.title || p.name || p.abbreviation || (p.id != null ? `P${p.id}` : '?');
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

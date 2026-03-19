import { existsSync, mkdirSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ─── ANSI Colors ───
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const ITALIC = '\x1b[3m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const MAGENTA = '\x1b[35m';
const BLUE = '\x1b[34m';
const RED = '\x1b[31m';
const WHITE = '\x1b[37m';
const BG_BLUE = '\x1b[44m';
const BG_GREEN = '\x1b[42m';
const BG_CYAN = '\x1b[46m';
// BG_YELLOW reserved for deploy warnings

// ─── Box Drawing ───
const BOX = {
  tl: '╭',
  tr: '╮',
  bl: '╰',
  br: '╯',
  h: '─',
  v: '│',
  t: '┬',
  b: '┴',
  cross: '┼',
  lj: '├',
  rj: '┤',
};
const TREE = { pipe: '│', branch: '├', last: '└', dash: '──' };

// ─── Droid/Agent Types ───

type AgentStatus = 'idle' | 'working' | 'done' | 'error' | 'blocked';

interface AgentInfo {
  id: string;
  name: string;
  type: 'droid' | 'subagent' | 'main';
  status: AgentStatus;
  task: string;
  parentId: string | null;
  startTime: number;
  endTime: number | null;
  tokensUsed: number;
}

interface TaskNode {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'done' | 'failed';
  assignedTo: string | null; // agent id
  children: string[]; // child task ids
  parentId: string | null;
  startTime: number | null;
  endTime: number | null;
  depth: number;
}

interface SkillMatch {
  name: string;
  source: string; // '.claude/skills/', '.factory/skills/', 'skills/'
  active: boolean;
  matchedAt: number;
  reason: string;
}

interface PatternMatch {
  id: string;
  name: string;
  weight: number;
  active: boolean;
  matchedAt: number;
  category: string;
}

interface DeployAction {
  id: string;
  type: 'commit' | 'push' | 'merge' | 'deploy' | 'workflow';
  target: string;
  status: 'queued' | 'batched' | 'executing' | 'done' | 'failed';
  queuedAt: number;
  executedAt: number | null;
  batchId: string | null;
  message: string;
}

interface CostEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  timestamp: number;
  operation: string;
}

interface SessionStats {
  sessionId: string;
  startTime: number;
  tokensUsed: number;
  tokensSaved: number;
  memoryHits: number;
  memoryMisses: number;
  toolCalls: number;
  policyChecks: number;
  policyBlocks: number;
  filesBackedUp: number;
  stepsCompleted: number;
  stepsTotal: number;
  currentStep: string;
  errors: number;
  agents: Map<string, AgentInfo>;
  tasks: Map<string, TaskNode>;
  skills: Map<string, SkillMatch>;
  patterns: Map<string, PatternMatch>;
  rootTaskIds: string[];
  deploys: Map<string, DeployAction>;
  costs: CostEntry[];
  totalCostUsd: number;
  estimatedCostWithoutUap: number;
  maxEntries: number; // LRU eviction limit
  lastCleanup: number;
}

let _stats: SessionStats | null = null;

function getStats(): SessionStats {
  if (!_stats) {
    _stats = {
      sessionId: Math.random().toString(36).substring(2, 8),
      startTime: Date.now(),
      tokensUsed: 0,
      tokensSaved: 0,
      memoryHits: 0,
      memoryMisses: 0,
      toolCalls: 0,
      policyChecks: 0,
      policyBlocks: 0,
      filesBackedUp: 0,
      stepsCompleted: 0,
      stepsTotal: 0,
      currentStep: '',
      errors: 0,
      agents: new Map(),
      tasks: new Map(),
      skills: new Map(),
      patterns: new Map(),
      rootTaskIds: [],
      deploys: new Map(),
      costs: [],
      totalCostUsd: 0,
      estimatedCostWithoutUap: 0,
      maxEntries: 100, // LRU eviction limit
      lastCleanup: Date.now(),
    };
  }
  return _stats;
}

// ─── Formatting Helpers ───

function elapsed(): string {
  const ms = Date.now() - getStats().startTime;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

function elapsedSince(ts: number): string {
  const ms = Date.now() - ts;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

function eta(): string {
  const s = getStats();
  if (s.stepsCompleted === 0 || s.stepsTotal === 0) return '?';
  const msPerStep = (Date.now() - s.startTime) / s.stepsCompleted;
  const remaining = (s.stepsTotal - s.stepsCompleted) * msPerStep;
  if (remaining < 1000) return '<1s';
  if (remaining < 60000) return `~${Math.ceil(remaining / 1000)}s`;
  return `~${Math.ceil(remaining / 60000)}m`;
}

function progressBar(current: number, total: number, width: number = 20): string {
  if (total === 0) return `[${'░'.repeat(width)}]`;
  const filled = Math.round((current / total) * width);
  const empty = width - filled;
  const pct = Math.round((current / total) * 100);
  return `[${GREEN}${'█'.repeat(filled)}${DIM}${'░'.repeat(empty)}${RESET}] ${pct}%`;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1000000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1000000).toFixed(2)}M`;
}

function boxLine(content: string, width: number = 60): string {
  const stripped = content.replace(/\x1b\[[0-9;]*m/g, '');
  const pad = Math.max(0, width - stripped.length - 2);
  return `${BOX.v} ${content}${' '.repeat(pad)}${BOX.v}`;
}

function statusIcon(status: AgentStatus | string): string {
  switch (status) {
    case 'idle':
      return `${DIM}○${RESET}`;
    case 'working':
    case 'in_progress':
      return `${YELLOW}◉${RESET}`;
    case 'done':
      return `${GREEN}●${RESET}`;
    case 'error':
    case 'failed':
      return `${RED}✗${RESET}`;
    case 'blocked':
      return `${RED}◎${RESET}`;
    case 'pending':
      return `${DIM}○${RESET}`;
    default:
      return `${DIM}?${RESET}`;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max - 1) + '…' : s;
}

// ─── Public API: Session Lifecycle ───

export function banner(): void {
  const w = 60;
  const line = BOX.h.repeat(w);
  console.log(`\n${CYAN}${BOX.tl}${line}${BOX.tr}${RESET}`);
  console.log(
    boxLine(
      `${BOLD}${CYAN} UAP Session ${getStats().sessionId}${RESET}  ${DIM}${elapsed()}${RESET}`,
      w
    )
  );
  console.log(`${CYAN}${BOX.bl}${line}${BOX.br}${RESET}\n`);
}

export function sessionStart(totalSteps: number = 0): void {
  const s = getStats();
  s.stepsTotal = totalSteps;
  const w = 60;
  const line = BOX.h.repeat(w);
  console.log(`\n${CYAN}${BOX.tl}${line}${BOX.tr}${RESET}`);
  console.log(
    boxLine(
      `${BOLD}${WHITE}${BG_BLUE} UAP ${RESET} ${BOLD}Universal Agent Protocol${RESET}  ${DIM}v1.0.0${RESET}`,
      w
    )
  );
  console.log(
    boxLine(`${DIM}Session: ${s.sessionId}  Started: ${new Date().toLocaleTimeString()}${RESET}`, w)
  );
  console.log(`${CYAN}${BOX.bl}${line}${BOX.br}${RESET}`);
}

// ─── Public API: Agents / Droids ───

export function agentRegister(
  id: string,
  name: string,
  type: 'droid' | 'subagent' | 'main',
  parentId?: string
): void {
  const s = getStats();
  const agent: AgentInfo = {
    id,
    name,
    type,
    status: 'idle',
    task: '',
    parentId: parentId || null,
    startTime: Date.now(),
    endTime: null,
    tokensUsed: 0,
  };
  s.agents.set(id, agent);

  const typeLabel =
    type === 'droid'
      ? `${MAGENTA}DROID${RESET}`
      : type === 'subagent'
        ? `${BLUE}AGENT${RESET}`
        : `${CYAN}MAIN${RESET}`;
  const parentStr = parentId ? ` ${DIM}(parent: ${parentId})${RESET}` : '';
  console.log(`${typeLabel} ${BOLD}${name}${RESET} registered ${DIM}[${id}]${RESET}${parentStr}`);
}

export function agentStart(id: string, task: string): void {
  const s = getStats();
  const agent = s.agents.get(id);
  if (!agent) return;
  agent.status = 'working';
  agent.task = task;
  agent.startTime = Date.now();

  const typeLabel = agent.type === 'droid' ? `${MAGENTA}[DROID]${RESET}` : `${BLUE}[AGENT]${RESET}`;
  console.log(
    `${typeLabel} ${BOLD}${agent.name}${RESET} ${YELLOW}working${RESET} on: ${truncate(task, 50)}`
  );
}

export function agentProgress(id: string, message: string, tokensUsed?: number): void {
  const s = getStats();
  const agent = s.agents.get(id);
  if (!agent) return;
  if (tokensUsed) {
    agent.tokensUsed += tokensUsed;
    s.tokensUsed += tokensUsed;
  }
  const dur = elapsedSince(agent.startTime);
  const typeLabel = agent.type === 'droid' ? `${MAGENTA}[DROID]${RESET}` : `${BLUE}[AGENT]${RESET}`;
  const tokenStr = tokensUsed
    ? ` ${DIM}(+${formatTokens(tokensUsed)} tokens, ${dur})${RESET}`
    : ` ${DIM}(${dur})${RESET}`;
  console.log(`${typeLabel} ${agent.name}: ${message}${tokenStr}`);
}

export function agentComplete(id: string, result?: string): void {
  const s = getStats();
  const agent = s.agents.get(id);
  if (!agent) return;
  agent.status = 'done';
  agent.endTime = Date.now();
  const dur = elapsedSince(agent.startTime);
  const typeLabel = agent.type === 'droid' ? `${MAGENTA}[DROID]${RESET}` : `${BLUE}[AGENT]${RESET}`;
  const resStr = result ? `: ${truncate(result, 50)}` : '';
  console.log(
    `${typeLabel} ${agent.name} ${GREEN}done${RESET} ${DIM}(${dur}, ${formatTokens(agent.tokensUsed)} tokens)${RESET}${resStr}`
  );
}

export function agentError(id: string, error: string): void {
  const s = getStats();
  const agent = s.agents.get(id);
  if (!agent) return;
  agent.status = 'error';
  agent.endTime = Date.now();
  s.errors++;
  const typeLabel = agent.type === 'droid' ? `${MAGENTA}[DROID]${RESET}` : `${BLUE}[AGENT]${RESET}`;
  console.log(`${typeLabel} ${agent.name} ${RED}error${RESET}: ${error}`);
}

// ─── Public API: Work Graph (Tasks) ───

export function taskCreate(id: string, title: string, parentId?: string): void {
  const s = getStats();
  const depth = parentId ? (s.tasks.get(parentId)?.depth ?? 0) + 1 : 0;
  const task: TaskNode = {
    id,
    title,
    status: 'pending',
    assignedTo: null,
    children: [],
    parentId: parentId || null,
    startTime: null,
    endTime: null,
    depth,
  };
  s.tasks.set(id, task);

  if (parentId) {
    const parent = s.tasks.get(parentId);
    if (parent) parent.children.push(id);
  } else {
    s.rootTaskIds.push(id);
  }

  const indent = '  '.repeat(depth);
  const connector = parentId ? `${DIM}${TREE.branch}${TREE.dash}${RESET} ` : '';
  console.log(
    `${CYAN}[TASK+]${RESET} ${indent}${connector}${statusIcon('pending')} ${title} ${DIM}[${id}]${RESET}`
  );
}

export function taskAssign(taskId: string, agentId: string): void {
  const s = getStats();
  const task = s.tasks.get(taskId);
  const agent = s.agents.get(agentId);
  if (!task || !agent) return;
  task.assignedTo = agentId;
  const typeLabel = agent.type === 'droid' ? 'droid' : 'agent';
  console.log(
    `${CYAN}[TASK]${RESET}  ${'  '.repeat(task.depth)}${statusIcon('pending')} ${truncate(task.title, 40)} ${DIM}-> ${typeLabel}:${agent.name}${RESET}`
  );
}

export function taskStart(taskId: string): void {
  const s = getStats();
  const task = s.tasks.get(taskId);
  if (!task) return;
  task.status = 'in_progress';
  task.startTime = Date.now();
  console.log(
    `${YELLOW}[TASK]${RESET}  ${'  '.repeat(task.depth)}${statusIcon('in_progress')} ${BOLD}${truncate(task.title, 45)}${RESET} ${DIM}started${RESET}`
  );
}

export function taskComplete(taskId: string): void {
  const s = getStats();
  const task = s.tasks.get(taskId);
  if (!task) return;
  task.status = 'done';
  task.endTime = Date.now();
  const dur = task.startTime ? elapsedSince(task.startTime) : '?';
  console.log(
    `${GREEN}[TASK]${RESET}  ${'  '.repeat(task.depth)}${statusIcon('done')} ${truncate(task.title, 45)} ${GREEN}done${RESET} ${DIM}(${dur})${RESET}`
  );
}

export function taskFail(taskId: string, reason?: string): void {
  const s = getStats();
  const task = s.tasks.get(taskId);
  if (!task) return;
  task.status = 'failed';
  task.endTime = Date.now();
  s.errors++;
  console.log(
    `${RED}[TASK]${RESET}  ${'  '.repeat(task.depth)}${statusIcon('failed')} ${truncate(task.title, 40)} ${RED}failed${RESET}${reason ? `: ${reason}` : ''}`
  );
}

export function workGraph(): void {
  const s = getStats();
  if (s.tasks.size === 0) return;

  const totalTasks = s.tasks.size;
  const doneTasks = [...s.tasks.values()].filter((t) => t.status === 'done').length;
  const activeTasks = [...s.tasks.values()].filter((t) => t.status === 'in_progress').length;
  const failedTasks = [...s.tasks.values()].filter((t) => t.status === 'failed').length;

  console.log(
    `\n${BOLD}${CYAN}Work Graph${RESET} ${DIM}(${doneTasks}/${totalTasks} done, ${activeTasks} active${failedTasks > 0 ? `, ${RED}${failedTasks} failed${RESET}` : ''})${RESET}`
  );

  const printTask = (taskId: string, prefix: string, isLast: boolean): void => {
    const task = s.tasks.get(taskId);
    if (!task) return;

    const connector = isLast ? TREE.last : TREE.branch;
    const agent = task.assignedTo ? s.agents.get(task.assignedTo) : null;
    const agentStr = agent
      ? ` ${DIM}[${agent.type === 'droid' ? MAGENTA : BLUE}${agent.name}${RESET}${DIM}]${RESET}`
      : '';
    const durStr =
      task.startTime && task.status === 'in_progress'
        ? ` ${DIM}${elapsedSince(task.startTime)}${RESET}`
        : '';

    console.log(
      `${prefix}${DIM}${connector}${TREE.dash}${RESET} ${statusIcon(task.status)} ${task.status === 'in_progress' ? BOLD : ''}${truncate(task.title, 42)}${RESET}${agentStr}${durStr}`
    );

    const childPrefix = prefix + (isLast ? '   ' : `${DIM}${TREE.pipe}${RESET}  `);
    for (let i = 0; i < task.children.length; i++) {
      printTask(task.children[i], childPrefix, i === task.children.length - 1);
    }
  };

  for (let i = 0; i < s.rootTaskIds.length; i++) {
    printTask(s.rootTaskIds[i], '  ', i === s.rootTaskIds.length - 1);
  }
  console.log('');
}

// ─── Public API: Skills ───

export function skillMatch(name: string, source: string, reason: string): void {
  const s = getStats();
  const skill: SkillMatch = { name, source, active: false, matchedAt: Date.now(), reason };
  s.skills.set(name, skill);
  console.log(
    `${GREEN}[SKILL]${RESET} ${BOLD}${name}${RESET} matched ${DIM}(${source})${RESET} -- ${ITALIC}${reason}${RESET}`
  );
}

export function skillActivate(name: string): void {
  const s = getStats();
  const skill = s.skills.get(name);
  if (skill) skill.active = true;
  console.log(`${GREEN}[SKILL]${RESET} ${WHITE}${BG_GREEN} ACTIVE ${RESET} ${BOLD}${name}${RESET}`);
}

export function skillDeactivate(name: string): void {
  const s = getStats();
  const skill = s.skills.get(name);
  if (skill) skill.active = false;
  console.log(`${DIM}[SKILL] ${name} deactivated${RESET}`);
}

export function showSkills(): void {
  const s = getStats();
  if (s.skills.size === 0) {
    console.log(`${DIM}[SKILL] No skills matched this session${RESET}`);
    return;
  }
  console.log(
    `\n${BOLD}${GREEN}Skills${RESET} ${DIM}(${s.skills.size} matched, ${[...s.skills.values()].filter((sk) => sk.active).length} active)${RESET}`
  );
  for (const [, skill] of s.skills) {
    const icon = skill.active ? `${WHITE}${BG_GREEN} ON ${RESET}` : `${DIM}OFF${RESET}`;
    console.log(
      `  ${icon} ${BOLD}${skill.name}${RESET} ${DIM}(${skill.source}) ${skill.reason}${RESET}`
    );
  }
  console.log('');
}

// ─── Public API: Patterns ───

export function patternMatch(id: string, name: string, weight: number, category: string): void {
  const s = getStats();
  const pattern: PatternMatch = {
    id,
    name,
    weight,
    active: false,
    matchedAt: Date.now(),
    category,
  };
  s.patterns.set(id, pattern);
  const weightBar = '▓'.repeat(Math.round(weight * 10)) + '░'.repeat(10 - Math.round(weight * 10));
  console.log(
    `${BLUE}[PATTERN]${RESET} ${BOLD}${name}${RESET} ${DIM}(${category})${RESET} weight: ${CYAN}${weightBar}${RESET} ${(weight * 100).toFixed(0)}%`
  );
}

export function patternActivate(id: string): void {
  const s = getStats();
  const pattern = s.patterns.get(id);
  if (pattern) pattern.active = true;
  const name = pattern?.name || id;
  console.log(`${BLUE}[PATTERN]${RESET} ${WHITE}${BG_CYAN} ACTIVE ${RESET} ${BOLD}${name}${RESET}`);
}

export function showPatterns(): void {
  const s = getStats();
  if (s.patterns.size === 0) {
    console.log(`${DIM}[PATTERN] No patterns matched this session${RESET}`);
    return;
  }
  const active = [...s.patterns.values()].filter((p) => p.active);
  const inactive = [...s.patterns.values()].filter((p) => !p.active);

  console.log(
    `\n${BOLD}${BLUE}Patterns${RESET} ${DIM}(${s.patterns.size} matched, ${active.length} active)${RESET}`
  );
  for (const p of active) {
    const weightBar =
      '▓'.repeat(Math.round(p.weight * 10)) + '░'.repeat(10 - Math.round(p.weight * 10));
    console.log(
      `  ${WHITE}${BG_CYAN} ON ${RESET} ${BOLD}${p.name}${RESET} ${DIM}(${p.category})${RESET} ${CYAN}${weightBar}${RESET}`
    );
  }
  for (const p of inactive) {
    const weightBar =
      '▓'.repeat(Math.round(p.weight * 10)) + '░'.repeat(10 - Math.round(p.weight * 10));
    console.log(`  ${DIM}OFF ${p.name} (${p.category}) ${weightBar}${RESET}`);
  }
  console.log('');
}

// ─── Public API: Deploy Windows ───

export function deployQueue(
  id: string,
  type: DeployAction['type'],
  target: string,
  message: string
): void {
  const s = getStats();
  const action: DeployAction = {
    id,
    type,
    target,
    message,
    status: 'queued',
    queuedAt: Date.now(),
    executedAt: null,
    batchId: null,
  };
  s.deploys.set(id, action);
  console.log(
    `${YELLOW}[DEPLOY]${RESET} ${DIM}queued${RESET} ${type} -> ${target} ${DIM}"${truncate(message, 40)}"${RESET}`
  );
}

export function deployBatch(actionIds: string[], batchId: string): void {
  const s = getStats();
  const batched: string[] = [];
  for (const id of actionIds) {
    const action = s.deploys.get(id);
    if (action) {
      action.status = 'batched';
      action.batchId = batchId;
      batched.push(action.type);
    }
  }
  console.log(
    `${YELLOW}[DEPLOY]${RESET} ${BOLD}batch ${batchId}${RESET}: ${batched.length} actions (${batched.join(', ')}) ${DIM}squashed${RESET}`
  );
}

export function deployExecute(batchId: string): void {
  const s = getStats();
  const actions = [...s.deploys.values()].filter((a) => a.batchId === batchId);
  for (const action of actions) {
    action.status = 'executing';
  }
  console.log(
    `${YELLOW}[DEPLOY]${RESET} ${BOLD}executing${RESET} batch ${batchId} (${actions.length} actions)`
  );
}

export function deployComplete(id: string, success: boolean): void {
  const s = getStats();
  const action = s.deploys.get(id);
  if (!action) return;
  action.status = success ? 'done' : 'failed';
  action.executedAt = Date.now();
  const dur = elapsedSince(action.queuedAt);
  const icon = success ? `${GREEN}done${RESET}` : `${RED}failed${RESET}`;
  console.log(
    `${YELLOW}[DEPLOY]${RESET} ${action.type} -> ${action.target} ${icon} ${DIM}(${dur} from queue)${RESET}`
  );
}

export function showDeployWindow(): void {
  const s = getStats();
  if (s.deploys.size === 0) {
    console.log(`${DIM}[DEPLOY] No deploy actions this session${RESET}`);
    return;
  }

  const queued = [...s.deploys.values()].filter((a) => a.status === 'queued');
  const batched = [...s.deploys.values()].filter((a) => a.status === 'batched');
  const executing = [...s.deploys.values()].filter((a) => a.status === 'executing');
  const done = [...s.deploys.values()].filter((a) => a.status === 'done');
  const failed = [...s.deploys.values()].filter((a) => a.status === 'failed');

  console.log(`\n${BOLD}${YELLOW}Deploy Window${RESET} ${DIM}(${s.deploys.size} total)${RESET}`);
  if (queued.length > 0) console.log(`  ${DIM}○${RESET} ${queued.length} queued`);
  if (batched.length > 0) console.log(`  ${YELLOW}◉${RESET} ${batched.length} batched`);
  if (executing.length > 0) console.log(`  ${CYAN}▶${RESET} ${executing.length} executing`);
  if (done.length > 0) console.log(`  ${GREEN}●${RESET} ${done.length} done`);
  if (failed.length > 0) console.log(`  ${RED}✗${RESET} ${failed.length} failed`);

  // Show savings from batching
  const batchIds = new Set([...s.deploys.values()].map((a) => a.batchId).filter(Boolean));
  if (batchIds.size > 0) {
    const totalActions = s.deploys.size;
    const batchCount = batchIds.size;
    const savedOps = totalActions - batchCount;
    if (savedOps > 0) {
      console.log(
        `  ${GREEN}Batching saved ${savedOps} redundant operations${RESET} (${totalActions} -> ${batchCount} batches)`
      );
    }
  }
  console.log('');
}

// ─── Public API: Cost Tracking & Savings ───

const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  // Cost per 1M tokens (USD)
  'claude-opus-4': { input: 15.0, output: 75.0 },
  'claude-sonnet-4': { input: 3.0, output: 15.0 },
  'claude-haiku': { input: 0.25, output: 1.25 },
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'qwen3.5': { input: 0.0, output: 0.0 }, // local model, no API cost
  local: { input: 0.0, output: 0.0 },
};

export function costTrack(
  model: string,
  inputTokens: number,
  outputTokens: number,
  operation: string
): void {
  const s = getStats();
  const rates = MODEL_COSTS[model] || MODEL_COSTS['claude-sonnet-4']; // default assumption
  const costUsd = (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;

  const entry: CostEntry = {
    model,
    inputTokens,
    outputTokens,
    costUsd,
    timestamp: Date.now(),
    operation,
  };
  s.costs.push(entry);
  s.totalCostUsd += costUsd;

  // Estimate what it would have cost without UAP optimizations (no caching, no token savings, no batching)
  const overhead = 1.4; // typical 40% overhead without memory/pattern caching
  s.estimatedCostWithoutUap += costUsd * overhead;

  if (costUsd > 0.001) {
    console.log(
      `${BLUE}[COST]${RESET} $${costUsd.toFixed(4)} ${DIM}(${model}: ${formatTokens(inputTokens)}in/${formatTokens(outputTokens)}out) ${operation}${RESET}`
    );
  }
}

export function costFromSavedTokens(savedTokens: number, model?: string): void {
  const s = getStats();
  const rates = MODEL_COSTS[model || 'claude-sonnet-4'];
  // Assume saved tokens are roughly 70% input, 30% output
  const savedCost =
    (savedTokens * 0.7 * rates.input + savedTokens * 0.3 * rates.output) / 1_000_000;
  s.estimatedCostWithoutUap += savedCost;
}

export function showCostSummary(): void {
  const s = getStats();
  const savedUsd = s.estimatedCostWithoutUap - s.totalCostUsd;
  const savingsPct =
    s.estimatedCostWithoutUap > 0 ? Math.round((savedUsd / s.estimatedCostWithoutUap) * 100) : 0;

  console.log(`\n${BOLD}${BLUE}Cost Summary${RESET}`);
  console.log(`  Session cost:     ${BOLD}$${s.totalCostUsd.toFixed(4)}${RESET}`);
  if (s.estimatedCostWithoutUap > s.totalCostUsd) {
    console.log(`  Without UAP:      ${DIM}$${s.estimatedCostWithoutUap.toFixed(4)}${RESET}`);
    console.log(`  ${GREEN}Saved:            $${savedUsd.toFixed(4)} (${savingsPct}%)${RESET}`);
  }
  if (s.costs.length > 0) {
    // Per-model breakdown
    const byModel = new Map<string, { cost: number; tokens: number }>();
    for (const c of s.costs) {
      const existing = byModel.get(c.model) || { cost: 0, tokens: 0 };
      existing.cost += c.costUsd;
      existing.tokens += c.inputTokens + c.outputTokens;
      byModel.set(c.model, existing);
    }
    console.log(`  ${DIM}By model:${RESET}`);
    for (const [model, data] of byModel) {
      console.log(`    ${model}: $${data.cost.toFixed(4)} (${formatTokens(data.tokens)} tokens)`);
    }
  }
  console.log('');
}

// ─── Public API: Memory, Tokens, Tools, Policy (existing) ───

export function memoryLookup(
  query: string,
  hits: number,
  topMatch?: string,
  similarity?: number
): void {
  const s = getStats();
  if (hits > 0) {
    s.memoryHits += hits;
    console.log(
      `${MAGENTA}[MEMORY]${RESET} ${GREEN}${hits} match${hits > 1 ? 'es' : ''}${RESET} for "${truncate(query, 40)}"`
    );
    if (topMatch) {
      const simStr = similarity ? ` ${DIM}(${(similarity * 100).toFixed(0)}% match)${RESET}` : '';
      console.log(`  ${DIM}${BOX.bl}${BOX.h}${RESET} ${truncate(topMatch, 70)}${simStr}`);
    }
  } else {
    s.memoryMisses++;
    console.log(`${MAGENTA}[MEMORY]${RESET} ${DIM}No matches for "${truncate(query, 40)}"${RESET}`);
  }
}

export function tokenUsage(used: number, saved: number, source?: string): void {
  const s = getStats();
  s.tokensUsed += used;
  s.tokensSaved += saved;
  const srcStr = source ? ` ${DIM}via ${source}${RESET}` : '';
  if (saved > 0) {
    console.log(
      `${BLUE}[TOKENS]${RESET} Used: ${formatTokens(used)}  ${GREEN}Saved: ${formatTokens(saved)}${RESET}${srcStr}`
    );
  } else {
    console.log(`${BLUE}[TOKENS]${RESET} Used: ${formatTokens(used)}${srcStr}`);
  }
}

export function toolCall(name: string, duration?: number, result?: string): void {
  const s = getStats();
  s.toolCalls++;
  const durStr = duration ? ` ${DIM}(${duration}ms)${RESET}` : '';
  const resStr = result ? ` ${DIM}-> ${truncate(result, 50)}${RESET}` : '';
  console.log(`${YELLOW}[TOOL]${RESET} ${name}${durStr}${resStr}`);
}

export function policyCheck(policyName: string, allowed: boolean, reason?: string): void {
  const s = getStats();
  s.policyChecks++;
  if (!allowed) {
    s.policyBlocks++;
    console.log(
      `${RED}[POLICY BLOCK]${RESET} ${BOLD}${policyName}${RESET}: ${reason || 'Violation detected'}`
    );
  } else {
    console.log(
      `${GREEN}[POLICY OK]${RESET} ${policyName}${reason ? ` ${DIM}(${reason})${RESET}` : ''}`
    );
  }
}

export function fileBackup(originalPath: string, backupPath: string): void {
  const s = getStats();
  s.filesBackedUp++;
  console.log(`${CYAN}[BACKUP]${RESET} ${originalPath} ${DIM}->${RESET} ${backupPath}`);
}

// ─── Public API: Steps ───

export function stepStart(stepName: string, stepNum?: number): void {
  const s = getStats();
  s.currentStep = stepName;
  if (stepNum !== undefined) {
    const progress = progressBar(stepNum - 1, s.stepsTotal);
    const etaStr = s.stepsCompleted > 0 ? ` ${DIM}ETA: ${eta()}${RESET}` : '';
    console.log(`\n${BOLD}[${stepNum}/${s.stepsTotal}]${RESET} ${stepName} ${progress}${etaStr}`);
  } else {
    console.log(`\n${BOLD}[STEP]${RESET} ${stepName}`);
  }
}

export function stepComplete(_stepName: string): void {
  const s = getStats();
  s.stepsCompleted++;
  console.log(`  ${GREEN}Done${RESET} ${DIM}(${elapsed()})${RESET}`);
}

export function error(message: string, context?: string): void {
  const s = getStats();
  s.errors++;
  console.log(`${RED}[ERROR]${RESET} ${message}${context ? ` ${DIM}(${context})${RESET}` : ''}`);
}

export function warn(message: string): void {
  console.log(`${YELLOW}[WARN]${RESET} ${message}`);
}

export function info(message: string): void {
  console.log(`${CYAN}[INFO]${RESET} ${message}`);
}

// ─── Public API: Session Summary ───

export function sessionSummary(): void {
  const s = getStats();
  const w = 62;
  const line = BOX.h.repeat(w);
  const totalTokens = s.tokensUsed + s.tokensSaved;
  const savingsPct = totalTokens > 0 ? Math.round((s.tokensSaved / totalTokens) * 100) : 0;

  const activeAgents = [...s.agents.values()].filter((a) => a.status === 'working').length;
  const doneAgents = [...s.agents.values()].filter((a) => a.status === 'done').length;
  const totalAgents = s.agents.size;

  const activeSkills = [...s.skills.values()].filter((sk) => sk.active).length;
  const activePatterns = [...s.patterns.values()].filter((p) => p.active).length;

  const doneTasks = [...s.tasks.values()].filter((t) => t.status === 'done').length;
  const totalTasks = s.tasks.size;

  console.log(`\n${CYAN}${BOX.tl}${line}${BOX.tr}${RESET}`);
  console.log(
    boxLine(
      `${BOLD}${WHITE}${BG_GREEN} UAP SESSION SUMMARY ${RESET}  ${DIM}Session ${s.sessionId}${RESET}`,
      w
    )
  );
  console.log(boxLine(`${DIM}${BOX.h.repeat(w - 2)}${RESET}`, w));

  // Time & Tokens
  console.log(boxLine(`${BOLD}Duration:${RESET}       ${elapsed()}`, w));
  console.log(boxLine(`${BOLD}Tokens Used:${RESET}    ${formatTokens(s.tokensUsed)}`, w));
  console.log(
    boxLine(
      `${BOLD}Tokens Saved:${RESET}   ${GREEN}${formatTokens(s.tokensSaved)} (${savingsPct}%)${RESET}`,
      w
    )
  );

  // Agents
  if (totalAgents > 0) {
    console.log(boxLine(`${DIM}${BOX.h.repeat(w - 2)}${RESET}`, w));
    console.log(
      boxLine(
        `${BOLD}Agents:${RESET}         ${totalAgents} total (${doneAgents} done, ${activeAgents} active)`,
        w
      )
    );
    for (const [, agent] of s.agents) {
      const icon = statusIcon(agent.status);
      const typeTag =
        agent.type === 'droid'
          ? `${MAGENTA}D${RESET}`
          : agent.type === 'subagent'
            ? `${BLUE}S${RESET}`
            : `${CYAN}M${RESET}`;
      const tokStr =
        agent.tokensUsed > 0 ? ` ${DIM}${formatTokens(agent.tokensUsed)}t${RESET}` : '';
      console.log(boxLine(`  ${icon} ${typeTag} ${agent.name}${tokStr}`, w));
    }
  }

  // Tasks
  if (totalTasks > 0) {
    console.log(boxLine(`${DIM}${BOX.h.repeat(w - 2)}${RESET}`, w));
    console.log(
      boxLine(
        `${BOLD}Tasks:${RESET}          ${doneTasks}/${totalTasks} ${progressBar(doneTasks, totalTasks, 12)}`,
        w
      )
    );
  }

  // Skills & Patterns
  if (s.skills.size > 0 || s.patterns.size > 0) {
    console.log(boxLine(`${DIM}${BOX.h.repeat(w - 2)}${RESET}`, w));
    if (s.skills.size > 0) {
      console.log(
        boxLine(`${BOLD}Skills:${RESET}         ${activeSkills}/${s.skills.size} active`, w)
      );
    }
    if (s.patterns.size > 0) {
      console.log(
        boxLine(`${BOLD}Patterns:${RESET}       ${activePatterns}/${s.patterns.size} active`, w)
      );
    }
  }

  // Deploy
  if (s.deploys.size > 0) {
    const deployDone = [...s.deploys.values()].filter((a) => a.status === 'done').length;
    const deployFailed = [...s.deploys.values()].filter((a) => a.status === 'failed').length;
    const batchIds = new Set([...s.deploys.values()].map((a) => a.batchId).filter(Boolean));
    const savedOps = s.deploys.size - batchIds.size;
    console.log(boxLine(`${DIM}${BOX.h.repeat(w - 2)}${RESET}`, w));
    console.log(
      boxLine(
        `${BOLD}Deploys:${RESET}        ${deployDone}/${s.deploys.size} done${deployFailed > 0 ? ` ${RED}(${deployFailed} failed)${RESET}` : ''}`,
        w
      )
    );
    if (savedOps > 0) {
      console.log(
        boxLine(
          `${BOLD}Batch Savings:${RESET}  ${GREEN}${savedOps} ops saved${RESET} (${s.deploys.size} -> ${batchIds.size} batches)`,
          w
        )
      );
    }
  }

  // Memory, Tools, Policy
  console.log(boxLine(`${DIM}${BOX.h.repeat(w - 2)}${RESET}`, w));
  console.log(
    boxLine(`${BOLD}Memory:${RESET}         ${s.memoryHits} hits / ${s.memoryMisses} misses`, w)
  );
  console.log(boxLine(`${BOLD}Tool Calls:${RESET}     ${s.toolCalls}`, w));
  console.log(
    boxLine(
      `${BOLD}Policy:${RESET}         ${s.policyChecks} checks, ${s.policyBlocks > 0 ? RED : GREEN}${s.policyBlocks} blocks${RESET}`,
      w
    )
  );
  console.log(boxLine(`${BOLD}Backups:${RESET}        ${s.filesBackedUp} files`, w));

  // Cost
  if (s.totalCostUsd > 0 || s.estimatedCostWithoutUap > 0) {
    const savedUsd = s.estimatedCostWithoutUap - s.totalCostUsd;
    const costSavingsPct =
      s.estimatedCostWithoutUap > 0 ? Math.round((savedUsd / s.estimatedCostWithoutUap) * 100) : 0;
    console.log(boxLine(`${DIM}${BOX.h.repeat(w - 2)}${RESET}`, w));
    console.log(boxLine(`${BOLD}Session Cost:${RESET}   $${s.totalCostUsd.toFixed(4)}`, w));
    if (savedUsd > 0) {
      console.log(
        boxLine(
          `${BOLD}Cost Saved:${RESET}     ${GREEN}$${savedUsd.toFixed(4)} (${costSavingsPct}%)${RESET}`,
          w
        )
      );
    }
  }

  if (s.errors > 0) {
    console.log(boxLine(`${DIM}${BOX.h.repeat(w - 2)}${RESET}`, w));
    console.log(boxLine(`${BOLD}Errors:${RESET}         ${RED}${s.errors}${RESET}`, w));
  }

  console.log(`${CYAN}${BOX.bl}${line}${BOX.br}${RESET}\n`);
}

// ─── Public API: Live Dashboard (compact) ───

export function liveStatus(): void {
  const s = getStats();
  const activeAgents = [...s.agents.values()].filter((a) => a.status === 'working');
  const activeTasks = [...s.tasks.values()].filter((t) => t.status === 'in_progress');
  const activeSkillNames = [...s.skills.values()].filter((sk) => sk.active).map((sk) => sk.name);
  const activePatternNames = [...s.patterns.values()].filter((p) => p.active).map((p) => p.name);

  const queuedDeploys = [...s.deploys.values()].filter(
    (a) => a.status === 'queued' || a.status === 'batched'
  );

  const parts: string[] = [];
  parts.push(`${DIM}${elapsed()}${RESET}`);
  parts.push(`${BLUE}${formatTokens(s.tokensUsed)}t${RESET}`);
  if (s.tokensSaved > 0) parts.push(`${GREEN}-${formatTokens(s.tokensSaved)}${RESET}`);
  if (s.totalCostUsd > 0) parts.push(`${DIM}$${s.totalCostUsd.toFixed(3)}${RESET}`);
  if (activeAgents.length > 0) parts.push(`${YELLOW}${activeAgents.length} agents${RESET}`);
  if (activeTasks.length > 0) parts.push(`${CYAN}${activeTasks.length} tasks${RESET}`);
  if (queuedDeploys.length > 0)
    parts.push(`${YELLOW}${queuedDeploys.length} deploys queued${RESET}`);
  if (activeSkillNames.length > 0)
    parts.push(`${GREEN}skills:${activeSkillNames.join(',')}${RESET}`);
  if (activePatternNames.length > 0)
    parts.push(
      `${BLUE}patterns:${activePatternNames.slice(0, 2).join(',')}${activePatternNames.length > 2 ? '+' + (activePatternNames.length - 2) : ''}${RESET}`
    );

  console.log(`${DIM}[UAP]${RESET} ${parts.join(' | ')}`);
}

// ─── File Backup Implementation ───

export function backupFile(filePath: string, projectRoot?: string): string | null {
  const root = projectRoot || process.cwd();
  const absPath = filePath.startsWith('/') ? filePath : join(root, filePath);

  if (!existsSync(absPath)) return null;

  const today = new Date().toISOString().split('T')[0];
  const relativePath = absPath.startsWith(root) ? absPath.substring(root.length + 1) : filePath;
  const backupDir = join(root, '.uap-backups', today, dirname(relativePath));
  const backupPath = join(root, '.uap-backups', today, relativePath);

  if (existsSync(backupPath)) return backupPath;

  mkdirSync(backupDir, { recursive: true });
  cpSync(absPath, backupPath);

  fileBackup(relativePath, `.uap-backups/${today}/${relativePath}`);
  return backupPath;
}

export async function backupDirectory(dirPath: string, projectRoot?: string): Promise<number> {
  const root = projectRoot || process.cwd();
  const absPath = dirPath.startsWith('/') ? dirPath : join(root, dirPath);

  if (!existsSync(absPath)) return 0;

  const today = new Date().toISOString().split('T')[0];
  const relativePath = absPath.startsWith(root) ? absPath.substring(root.length + 1) : dirPath;
  const backupDir = join(root, '.uap-backups', today, relativePath);

  if (existsSync(backupDir)) return 0;

  mkdirSync(backupDir, { recursive: true });
  cpSync(absPath, backupDir, { recursive: true });

  const fs = await import('node:fs');
  let count = 0;
  try {
    const countFiles = (dir: string): number => {
      let c = 0;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile()) c++;
        else if (entry.isDirectory()) c += countFiles(join(dir, entry.name));
      }
      return c;
    };
    count = countFiles(backupDir);
  } catch {
    count = 1;
  }

  info(`Backed up directory: ${relativePath} (${count} files)`);
  return count;
}

// ─── Inline Policy Management ───

export function showActivePolicies(): void {
  console.log(`\n${BOLD}${MAGENTA}Active Policies:${RESET}`);
  console.log(`  ${GREEN}[ON]${RESET}  IaC State Parity ${DIM}(REQUIRED)${RESET}`);
  console.log(`  ${GREEN}[ON]${RESET}  IaC Pipeline Enforcement ${DIM}(REQUIRED)${RESET}`);
  console.log(`  ${GREEN}[ON]${RESET}  kubectl Verify & Backport ${DIM}(REQUIRED)${RESET}`);
  console.log(`  ${GREEN}[ON]${RESET}  Definition of Done (IaC) ${DIM}(REQUIRED)${RESET}`);
  console.log(`  ${GREEN}[ON]${RESET}  Mandatory File Backup ${DIM}(REQUIRED)${RESET}`);
  console.log(`  ${DIM}[OFF]${RESET} Image & Asset Verification ${DIM}(RECOMMENDED)${RESET}`);
  console.log(`  ${DIM}Use: uap-policy list | uap-policy check -o <operation>${RESET}\n`);
}

export function resetStats(): void {
  _stats = null;
}

// ─── Memory Management & LRU Eviction ───

function trimMapLRU<K, V>(map: Map<K, V>, maxSize: number): void {
  if (map.size <= maxSize) return;

  const entries = [...map.entries()];
  // Sort by last access time (add lastAccessed property to your types)
  entries.sort((a, b) => {
    const aLastAccessed = (a[1] as { lastAccessed?: number }).lastAccessed || 0;
    const bLastAccessed = (b[1] as { lastAccessed?: number }).lastAccessed || 0;
    return aLastAccessed - bLastAccessed;
  });

  // Remove oldest half
  const toRemove = Math.floor(entries.length / 2);
  for (let i = 0; i < toRemove; i++) {
    map.delete(entries[i][0]);
  }
}

function cleanupCompletedItems(): void {
  const s = getStats();
  const oneHourAgo = Date.now() - 3600000;

  // Remove completed agents older than 1 hour
  for (const [id, agent] of s.agents) {
    if (agent.status === 'done' && agent.endTime && agent.endTime < oneHourAgo) {
      s.agents.delete(id);
    }
  }

  // Remove completed tasks older than 1 hour
  for (const [id, task] of s.tasks) {
    if (
      (task.status === 'done' || task.status === 'failed') &&
      task.endTime &&
      task.endTime < oneHourAgo
    ) {
      s.tasks.delete(id);
    }
  }

  // Trim Maps to max size using LRU
  trimMapLRU(s.agents, Math.floor(s.maxEntries * 0.5));
  trimMapLRU(s.tasks, Math.floor(s.maxEntries * 0.3));
  trimMapLRU(s.skills, Math.floor(s.maxEntries * 0.1));
  trimMapLRU(s.patterns, Math.floor(s.maxEntries * 0.1));

  s.lastCleanup = Date.now();
}

function scheduleCleanup(): void {
  const s = getStats();
  // Run cleanup every 5 minutes or when memory pressure detected
  if (Date.now() - s.lastCleanup > 300000) {
    cleanupCompletedItems();
  }
}

// ─── Persistent Dashboard with Adaptive Polling ───

interface DashboardState {
  lastDataHash: string | null;
  consecutiveEmptyUpdates: number;
  idleTimeout: NodeJS.Timeout | null;
  showWorkGraph: boolean;
}

let dashboardState: DashboardState | null = null;
let dashboardInterval: NodeJS.Timeout | null = null;

const DASHBOARD_CONFIG = {
  BASE_INTERVAL: 2000,
  IDLE_THRESHOLD: 3,
  MAX_IDLE_INTERVAL: 30000,
  ACTIVITY_THRESHOLD: 2, // Consider active if >2 agents/tasks working
} as const;

function generateDashboardHash(s: SessionStats): string {
  const activeAgents = [...s.agents.values()].filter((a) => a.status === 'working').length;
  const activeTasks = [...s.tasks.values()].filter((t) => t.status === 'in_progress').length;
  return `${s.sessionId}-${activeAgents}-${activeTasks}-${Date.now() % 1000}`;
}

function shouldUpdateDashboard(s: SessionStats): boolean {
  const activeAgents = [...s.agents.values()].filter((a) => a.status === 'working').length;
  const activeTasks = [...s.tasks.values()].filter((t) => t.status === 'in_progress').length;
  return activeAgents > 0 || activeTasks > 0 || s.errors > 0;
}

export function startDashboard(intervalMs: number = 2000, showWorkGraph: boolean = false): void {
  if (dashboardInterval) {
    console.log(`${DIM}[DASHBOARD]${RESET} Already running`);
    return;
  }

  const s = getStats();
  const initialHash = generateDashboardHash(s);

  dashboardState = {
    lastDataHash: initialHash,
    consecutiveEmptyUpdates: 0,
    idleTimeout: null,
    showWorkGraph,
  };

  console.log(
    `${GREEN}[DASHBOARD]${RESET} ${DIM}Starting adaptive dashboard (base: ${intervalMs}ms)${RESET}${showWorkGraph ? ` ${DIM}(with work graph)${RESET}` : ''}`
  );

  const updateDashboard = (): void => {
    if (!dashboardState) return;

    const currentHash = generateDashboardHash(s);
    const shouldUpdate = currentHash !== dashboardState.lastDataHash || shouldUpdateDashboard(s);

    if (shouldUpdate) {
      renderDashboard(s, intervalMs);
      dashboardState.lastDataHash = currentHash;
      dashboardState.consecutiveEmptyUpdates = 0;

      // Reset idle timeout on activity
      if (dashboardState.idleTimeout) {
        clearTimeout(dashboardState.idleTimeout);
        dashboardState.idleTimeout = null;
      }
    } else {
      dashboardState.consecutiveEmptyUpdates++;

      // Extend interval on idle: 2s → 4s → 8s → max 30s
      if (dashboardState.consecutiveEmptyUpdates >= DASHBOARD_CONFIG.IDLE_THRESHOLD) {
        const newInterval = Math.min(
          intervalMs *
            Math.pow(2, dashboardState.consecutiveEmptyUpdates - DASHBOARD_CONFIG.IDLE_THRESHOLD),
          DASHBOARD_CONFIG.MAX_IDLE_INTERVAL
        );

        console.log(
          `${DIM}[DASHBOARD]${RESET} ${DIM}Idle detected, extending interval to ${newInterval}ms${RESET}`
        );

        // Schedule next check with extended interval
        const idleTimer = setTimeout(() => {
          if (dashboardState?.idleTimeout) {
            clearTimeout(dashboardState.idleTimeout);
            dashboardState.idleTimeout = null;
          }
          updateDashboard();
        }, newInterval) as unknown as NodeJS.Timeout;
        if (idleTimer.unref) idleTimer.unref();
        dashboardState.idleTimeout = idleTimer;
      }
    }
  };

  renderDashboard(s, intervalMs);
  dashboardInterval = setInterval(() => {
    scheduleCleanup();
    updateDashboard();
  }, intervalMs);
  if (dashboardInterval && (dashboardInterval as NodeJS.Timeout).unref) {
    (dashboardInterval as NodeJS.Timeout).unref();
  }
}

function renderDashboard(s: SessionStats, currentInterval: number): void {
  const w = 80;
  const line = BOX.h.repeat(w);
  console.log(`\n${CYAN}${BOX.tl}${line}${BOX.tr}${RESET}`);
  console.log(
    boxLine(
      `${BOLD}${WHITE}${BG_CYAN} UAP LIVE DASHBOARD ${RESET}  ${DIM}Session ${s.sessionId}${RESET}  ${DIM}${new Date().toLocaleTimeString()}${RESET}${currentInterval > DASHBOARD_CONFIG.BASE_INTERVAL ? ` (${currentInterval}ms)` : ''}`,
      w
    )
  );
  console.log(`${CYAN}${BOX.bl}${line}${BOX.br}${RESET}`);

  const activeAgents = [...s.agents.values()].filter((a) => a.status === 'working');
  const activeTasks = [...s.tasks.values()].filter((t) => t.status === 'in_progress');
  const activeSkillNames = [...s.skills.values()].filter((sk) => sk.active).map((sk) => sk.name);
  const activePatternNames = [...s.patterns.values()].filter((p) => p.active).map((p) => p.name);

  const queuedDeploys = [...s.deploys.values()].filter(
    (a) => a.status === 'queued' || a.status === 'batched'
  );

  console.log(
    `  ${DIM}Duration:${RESET} ${elapsed()}  ${DIM}Tokens:${RESET} ${BLUE}${formatTokens(s.tokensUsed)}${RESET}${s.tokensSaved > 0 ? ` ${GREEN}(-${formatTokens(s.tokensSaved)})${RESET}` : ''}${s.totalCostUsd > 0 ? ` ${DIM}($${s.totalCostUsd.toFixed(3)})${RESET}` : ''}`
  );
  console.log(
    `  ${DIM}Agents:${RESET} ${activeAgents.length} working${activeAgents.length > 0 ? ` (${activeAgents.map((a) => a.name).join(', ')})` : ''}`
  );
  console.log(
    `  ${DIM}Tasks:${RESET} ${activeTasks.length} in progress${activeTasks.length > 0 ? ` (${activeTasks.map((t) => truncate(t.title, 25)).join(', ')})` : ''}`
  );

  if (queuedDeploys.length > 0) {
    console.log(
      `  ${YELLOW}[DEPLOY]${RESET} ${queuedDeploys.length} queued${queuedDeploys.length > 1 ? '+' : ''}`
    );
  }

  if (activeSkillNames.length > 0) {
    console.log(
      `  ${GREEN}[SKILLS]${RESET} ${activeSkillNames.slice(0, 3).join(', ')}${activeSkillNames.length > 3 ? ` +${activeSkillNames.length - 3}` : ''}`
    );
  }

  if (activePatternNames.length > 0) {
    console.log(
      `  ${BLUE}[PATTERNS]${RESET} ${activePatternNames.slice(0, 3).join(', ')}${activePatternNames.length > 3 ? ` +${activePatternNames.length - 3}` : ''}`
    );
  }

  if (s.errors > 0) {
    console.log(`  ${RED}[ERRORS]${RESET} ${s.errors} total`);
  }

  if (dashboardState?.showWorkGraph && s.tasks.size > 0) {
    workGraph();
  }
}

export function stopDashboard(): void {
  if (!dashboardInterval) {
    console.log(`${DIM}[DASHBOARD]${RESET} Not running`);
    return;
  }

  clearInterval(dashboardInterval);
  dashboardInterval = null;
  console.log(`${GREEN}[DASHBOARD]${RESET} ${DIM}Stopped${RESET}`);
}

export function dashboardPause(): void {
  if (!dashboardInterval) {
    console.log(`${DIM}[DASHBOARD]${RESET} Not running`);
    return;
  }

  clearInterval(dashboardInterval);
  dashboardInterval = null;
  console.log(`${YELLOW}[DASHBOARD]${RESET} ${DIM}Paused${RESET}`);
}

export function dashboardResume(): void {
  if (dashboardInterval) {
    console.log(`${DIM}[DASHBOARD]${RESET} Already running`);
    return;
  }

  const s = getStats();
  console.log(`${GREEN}[DASHBOARD]${RESET} ${DIM}Resumed${RESET}`);
  // Reuse renderDashboard instead of duplicating rendering logic
  renderDashboard(s, 2000);
  dashboardInterval = setInterval(() => {
    renderDashboard(getStats(), 2000);
  }, 2000);
  if (dashboardInterval && (dashboardInterval as NodeJS.Timeout).unref) {
    (dashboardInterval as NodeJS.Timeout).unref();
  }
}

export function showDashboardSnapshot(showWorkGraph: boolean = false): void {
  const s = getStats();
  const w = 80;
  const line = BOX.h.repeat(w);
  console.log(`\n${CYAN}${BOX.tl}${line}${BOX.tr}${RESET}`);
  console.log(
    boxLine(
      `${BOLD}${WHITE}${BG_CYAN} UAP DASHBOARD ${RESET}  ${DIM}Session ${s.sessionId}${RESET}  ${DIM}${new Date().toLocaleTimeString()}${RESET}`,
      w
    )
  );
  console.log(`${CYAN}${BOX.bl}${line}${BOX.br}${RESET}`);

  const activeAgents = [...s.agents.values()].filter((a) => a.status === 'working');
  const activeTasks = [...s.tasks.values()].filter((t) => t.status === 'in_progress');
  const doneTasks = [...s.tasks.values()].filter((t) => t.status === 'done');
  const activeSkillNames = [...s.skills.values()].filter((sk) => sk.active).map((sk) => sk.name);
  const activePatternNames = [...s.patterns.values()].filter((p) => p.active).map((p) => p.name);

  const queuedDeploys = [...s.deploys.values()].filter(
    (a) => a.status === 'queued' || a.status === 'batched'
  );
  const executingDeploys = [...s.deploys.values()].filter((a) => a.status === 'executing');

  console.log(
    `  ${DIM}Duration:${RESET} ${elapsed()}  ${DIM}Tokens:${RESET} ${BLUE}${formatTokens(s.tokensUsed)}${RESET}${s.tokensSaved > 0 ? ` ${GREEN}(-${formatTokens(s.tokensSaved)})${RESET}` : ''}${s.totalCostUsd > 0 ? ` ${DIM}($${s.totalCostUsd.toFixed(3)})${RESET}` : ''}`
  );
  console.log(
    `  ${DIM}Agents:${RESET} ${s.agents.size} total (${activeAgents.length} working, ${[...s.agents.values()].filter((a) => a.status === 'done').length} done)`
  );
  console.log(
    `  ${DIM}Tasks:${RESET} ${doneTasks.length}/${s.tasks.size} done${activeTasks.length > 0 ? ` (${activeTasks.length} in progress)` : ''}`
  );

  if (queuedDeploys.length > 0) {
    console.log(
      `  ${YELLOW}[DEPLOY]${RESET} ${queuedDeploys.length} queued${queuedDeploys.length > 1 ? '+' : ''}${executingDeploys.length > 0 ? ` ${CYAN}${executingDeploys.length} executing${RESET}` : ''}`
    );
  }

  if (activeSkillNames.length > 0) {
    console.log(
      `  ${GREEN}[SKILLS]${RESET} ${activeSkillNames.slice(0, 5).join(', ')}${activeSkillNames.length > 5 ? ` +${activeSkillNames.length - 5}` : ''}`
    );
  }

  if (activePatternNames.length > 0) {
    console.log(
      `  ${BLUE}[PATTERNS]${RESET} ${activePatternNames.slice(0, 5).join(', ')}${activePatternNames.length > 5 ? ` +${activePatternNames.length - 5}` : ''}`
    );
  }

  if (s.memoryHits > 0 || s.memoryMisses > 0) {
    console.log(`  ${MAGENTA}[MEMORY]${RESET} ${s.memoryHits} hits / ${s.memoryMisses} misses`);
  }

  if (s.policyChecks > 0) {
    console.log(
      `  ${s.policyBlocks > 0 ? RED : GREEN}[POLICY]${RESET} ${s.policyChecks} checks${s.policyBlocks > 0 ? ` (${s.policyBlocks} blocked)` : ''}`
    );
  }

  if (s.errors > 0) {
    console.log(`  ${RED}[ERRORS]${RESET} ${s.errors} total`);
  }

  if (showWorkGraph && s.tasks.size > 0) {
    workGraph();
  }
}

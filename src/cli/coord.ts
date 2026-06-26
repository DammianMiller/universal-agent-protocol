import chalk from 'chalk';
import ora from 'ora';
import { CoordinationService } from '../coordination/service.js';
import { DeployBatcher } from '../coordination/deploy-batcher.js';
import type { WorkOverlap, BoardKind, FindingStatus, StagedStatus } from '../types/coordination.js';
import { statusBadge, divider, keyValue, horizontalBarChart, bulletList } from './visualize.js';

type CoordAction =
  | 'status' | 'flush' | 'cleanup' | 'check' | 'resolve'
  | 'post' | 'board' | 'dead-end' | 'finding' | 'flag'
  | 'stage' | 'claim' | 'complete' | 'collaboration' | 'slots';

interface CoordOptions {
  verbose?: boolean;
  agents?: string;
  resource?: string;
  json?: boolean;
  overlapId?: string;
  action?: string;
  text?: string;
  kind?: string;
  limit?: string;
  since?: string;
  agent?: string;
  sub?: string;
  id?: string;
  status?: string;
  evidence?: string;
  supersedes?: string;
  resolution?: string;
  reason?: string;
  artifact?: string;
  acceptance?: string;
  needs?: string;
  result?: string;
}

/** Resolve the posting agent identity: --agent, then env, then a stable fallback. */
function resolveAgentId(options: CoordOptions): string {
  return options.agent || process.env.UAP_AGENT_ID || process.env.UAP_AGENT || 'cli';
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
    case 'post':
      await postBoard(options, (options.kind as BoardKind) || 'note');
      break;
    case 'dead-end':
      await postBoard(options, 'dead-end');
      break;
    case 'board':
      await readBoard(options);
      break;
    case 'finding':
      await findingCmd(options);
      break;
    case 'flag':
      await flagCmd(options);
      break;
    case 'stage':
      await stageCmd(options);
      break;
    case 'claim':
      await claimCmd(options);
      break;
    case 'complete':
      await completeCmd(options);
      break;
    case 'collaboration':
      await collaborationCmd(options);
      break;
    case 'slots':
      await slotsCmd(options);
      break;
  }
}

const VALID_KINDS: BoardKind[] = ['note', 'finding', 'dead-end', 'flag', 'handoff', 'norm'];

async function postBoard(options: CoordOptions, kind: BoardKind): Promise<void> {
  const text = (options.text || '').trim();
  if (!text) {
    console.log(chalk.yellow('  Nothing to post. Usage: uap coord post "<message>" [--kind finding|dead-end|flag|handoff|norm]'));
    process.exitCode = 1;
    return;
  }
  if (!VALID_KINDS.includes(kind)) {
    console.log(chalk.yellow(`  Unknown --kind '${kind}'. Valid: ${VALID_KINDS.join(', ')}`));
    process.exitCode = 1;
    return;
  }
  const service = new CoordinationService();
  const id = service.postBoard(resolveAgentId(options), text, kind);
  console.log(chalk.green(`  ✓ posted to collaboration board (#${id}, ${kind})`));
}

async function readBoard(options: CoordOptions): Promise<void> {
  const service = new CoordinationService();
  const limit = options.limit ? parseInt(options.limit, 10) : 15;
  const sinceMinutes = options.since ? parseInt(options.since, 10) : undefined;
  const posts = service.readBoard({
    limit,
    sinceMinutes,
    kind: options.kind ? (options.kind as BoardKind) : undefined,
  });
  if (options.json) {
    console.log(JSON.stringify(posts, null, 2));
    return;
  }
  if (posts.length === 0) {
    console.log(chalk.dim('  Collaboration board is empty. Post with: uap coord post "<message>"'));
    return;
  }
  const icon: Record<BoardKind, string> = {
    note: '•', finding: '✅', 'dead-end': '⛔', flag: '🚩', handoff: '🤝', norm: '📏',
  };
  console.log(chalk.bold('\n  Collaboration board (most recent first)\n'));
  for (const p of posts) {
    const who = p.fromAgent ? chalk.dim(p.fromAgent.slice(0, 16)) : chalk.dim('—');
    console.log(`  ${icon[p.kind]} ${chalk.cyan('[' + p.kind + ']')} ${who}  ${chalk.dim(p.createdAt.slice(5, 16))}`);
    console.log(`      ${p.text}`);
  }
  console.log('');
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

async function findingCmd(options: CoordOptions): Promise<void> {
  const service = new CoordinationService();
  const sub = options.sub || 'list';
  if (sub === 'propose') {
    const claim = (options.text || '').trim();
    if (!claim) { console.log(chalk.yellow('  Usage: uap coord finding propose "<claim>"')); process.exitCode = 1; return; }
    const id = service.proposeFinding(
      resolveAgentId(options), claim, options.evidence,
      options.supersedes ? parseInt(options.supersedes, 10) : undefined
    );
    console.log(chalk.green(`  ✓ finding #${id} proposed (and posted to the board)`));
    return;
  }
  if (sub === 'confirm' || sub === 'reverse') {
    const id = parseInt(options.id || options.text || '', 10);
    if (!Number.isFinite(id)) { console.log(chalk.yellow(`  Usage: uap coord finding ${sub} <id>`)); process.exitCode = 1; return; }
    const ok = service.updateFinding(id, sub === 'confirm' ? 'confirmed' : 'reversed', {
      byAgent: resolveAgentId(options),
      resolution: options.resolution,
      supersedes: options.supersedes ? parseInt(options.supersedes, 10) : undefined,
    });
    console.log(ok ? chalk.green(`  ✓ finding #${id} ${sub === 'confirm' ? 'confirmed' : 'reversed'}`) : chalk.yellow(`  finding #${id} not found`));
    if (!ok) process.exitCode = 1;
    return;
  }
  const findings = service.listFindings({
    status: options.status as FindingStatus | undefined,
    limit: options.limit ? parseInt(options.limit, 10) : 25,
  });
  if (options.json) { console.log(JSON.stringify(findings, null, 2)); return; }
  if (findings.length === 0) { console.log(chalk.dim('  No findings yet. Propose one: uap coord finding propose "<claim>"')); return; }
  const badge: Record<FindingStatus, string> = {
    proposed: chalk.cyan('proposed'), confirmed: chalk.green('confirmed'),
    reversed: chalk.gray('reversed'), disputed: chalk.red('disputed'),
  };
  console.log(chalk.bold('\n  Findings ledger\n'));
  for (const f of findings) {
    const lin = f.supersedes ? chalk.dim(` (supersedes #${f.supersedes})`) : '';
    console.log(`  #${f.id} ${badge[f.status]}${lin}  ${chalk.dim((f.agentId || '—').slice(0, 14))}`);
    console.log(`      ${f.claim}`);
    if (f.resolution) console.log(chalk.dim(`      ruling: ${f.resolution}`));
  }
  console.log('');
}

async function flagCmd(options: CoordOptions): Promise<void> {
  const id = parseInt(options.id || options.text || '', 10);
  const reason = (options.reason || '').trim();
  if (!Number.isFinite(id) || !reason) {
    console.log(chalk.yellow('  Usage: uap coord flag <finding-id> --reason "<why this is suspect>"'));
    process.exitCode = 1; return;
  }
  const service = new CoordinationService();
  const ok = service.flagFinding(resolveAgentId(options), id, reason);
  console.log(ok ? chalk.red(`  🚩 flagged finding #${id} for ruling (posted to board)`) : chalk.yellow(`  finding #${id} not found`));
  if (!ok) process.exitCode = 1;
}

async function stageCmd(options: CoordOptions): Promise<void> {
  const service = new CoordinationService();
  const v = (options.text || '').trim();
  if (v === 'list' || options.sub === 'list') {
    const items = service.listStaged({
      status: options.status as StagedStatus | undefined,
      needs: options.needs,
      limit: options.limit ? parseInt(options.limit, 10) : 25,
    });
    if (options.json) { console.log(JSON.stringify(items, null, 2)); return; }
    if (items.length === 0) { console.log(chalk.dim('  Nothing staged. Stage with: uap coord stage "<title>" --needs gpu')); return; }
    console.log(chalk.bold('\n  Staged work (relay pool)\n'));
    for (const w of items) {
      const st = w.status === 'staged' ? chalk.cyan('staged') : w.status === 'claimed' ? chalk.yellow('claimed') : w.status === 'completed' ? chalk.green('completed') : chalk.gray('abandoned');
      const needs = w.needs ? chalk.magenta(` needs:${w.needs}`) : '';
      const who = w.claimant ? chalk.dim(` ← ${w.claimant.slice(0, 12)}`) : '';
      console.log(`  #${w.id} ${st}${needs}${who}  ${chalk.dim(w.originator.slice(0, 12))}`);
      console.log(`      ${w.title}`);
      if (w.acceptance) console.log(chalk.dim(`      accept: ${w.acceptance}`));
    }
    console.log('');
    return;
  }
  if (!v) { console.log(chalk.yellow('  Usage: uap coord stage "<title>" [--artifact path] [--acceptance "<spec>"] [--needs gpu]')); process.exitCode = 1; return; }
  const id = service.stageWork(resolveAgentId(options), {
    title: v, artifact: options.artifact, acceptance: options.acceptance, needs: options.needs,
  });
  console.log(chalk.green(`  ✓ staged #${id} for pickup (posted to the board as a handoff)`));
}

async function claimCmd(options: CoordOptions): Promise<void> {
  const id = parseInt(options.id || options.text || '', 10);
  if (!Number.isFinite(id)) { console.log(chalk.yellow('  Usage: uap coord claim <staged-id>')); process.exitCode = 1; return; }
  const service = new CoordinationService();
  const ok = service.claimStaged(resolveAgentId(options), id);
  console.log(ok ? chalk.green(`  ✓ claimed staged #${id} — run it, then: uap coord complete ${id} --result "<outcome>"`) : chalk.yellow(`  staged #${id} not available (already claimed or missing)`));
  if (!ok) process.exitCode = 1;
}

async function completeCmd(options: CoordOptions): Promise<void> {
  const id = parseInt(options.id || options.text || '', 10);
  if (!Number.isFinite(id)) { console.log(chalk.yellow('  Usage: uap coord complete <staged-id> --result "<outcome>"')); process.exitCode = 1; return; }
  const service = new CoordinationService();
  const ok = service.completeStaged(resolveAgentId(options), id, options.result);
  console.log(ok ? chalk.green(`  ✓ completed staged #${id} (credited the originator on the board)`) : chalk.yellow(`  staged #${id} not completable`));
  if (!ok) process.exitCode = 1;
}


async function collaborationCmd(options: CoordOptions): Promise<void> {
  const { modifyUapConfig } = await import('../utils/config-loader.js');
  const { collaborationMode } = await import('../coordination/collaboration-inject.js');
  const cwd = process.cwd();
  const mode = (options.sub || options.text || 'status').toLowerCase();
  if (mode === 'status') {
    const cur = collaborationMode(cwd);
    console.log(`  collaboration auto-activation: ${chalk.cyan(cur)}`);
    console.log(chalk.dim('    auto = activate on multi-agent/collaboration context · always = always · off = manual only'));
    console.log(chalk.dim('    set with: uap coord collaboration <auto|always|off>'));
    return;
  }
  if (mode !== 'auto' && mode !== 'always' && mode !== 'off') {
    console.log(chalk.yellow('  Usage: uap coord collaboration <auto|always|off|status>'));
    process.exitCode = 1; return;
  }
  modifyUapConfig(cwd, (cfg) => {
    const c = (cfg.collaboration as Record<string, unknown>) || {};
    c.mode = mode;
    cfg.collaboration = c;
    return cfg;
  });
  console.log(chalk.green(`  ✓ collaboration auto-activation set to ${mode}`));
}


async function slotsCmd(options: CoordOptions): Promise<void> {
  const { getModelSlotBudget, inferenceBase, headroom } = await import('../utils/model-slots.js');
  const cwd = process.cwd();
  const { budget, slots, source } = await getModelSlotBudget(cwd, { probe: true, force: true });
  if (options.json) {
    console.log(JSON.stringify({ budget, slots, source, endpoint: inferenceBase(cwd), headroom: headroom(cwd) }, null, 2));
    return;
  }
  console.log(chalk.bold('\n  Model-slot concurrency budget\n'));
  console.log(`  ${chalk.cyan('budget')}    ${budget}  ${chalk.dim('(max concurrent model calls)')}`);
  console.log(`  ${chalk.dim('slots')}     ${slots}  ${chalk.dim('source: ' + source)}`);
  console.log(`  ${chalk.dim('headroom')}  ${headroom(cwd)}`);
  console.log(`  ${chalk.dim('endpoint')}  ${inferenceBase(cwd)}`);
  console.log(chalk.dim('\n  Override: UAP_MODEL_SLOTS / .uap.json modelConcurrency.slots; reserve: UAP_MODEL_SLOT_HEADROOM\n'));
}

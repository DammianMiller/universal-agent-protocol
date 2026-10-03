/**
 * `uap mission` — the operator surface for the mission ledger.
 *
 *   uap mission create "<goal>" --acceptance "<criteria>" [--launch] [--preset <id>]
 *   uap mission list [--status active|paused|delivered|failed]
 *   uap mission show <id>
 *   uap mission pause <id> | resume <id>
 *   uap mission replan <id> --acceptance "<new>" --reason "<why>"
 *   uap mission salvage [list|approve <id>|reject <id>]
 *   uap mission poll [--loop] [--interval N]   — the orchestrator loop clock
 *
 * Missions are durable goals with FROZEN acceptance criteria; the poll loop
 * drives them to completion. `--launch` starts the first deliver run
 * immediately instead of waiting for the next poll.
 */

import chalk from 'chalk';
import {
  createMission,
  decideSalvage,
  getMission,
  listAcceptanceRevisions,
  listAttempts,
  listMissions,
  listSalvage,
  openMissionDb,
  replanAcceptance,
  setMissionStatus,
} from '../mission/ledger.js';
import { runPollCycle } from '../mission/poll-executor.js';
import { orchPollCommand, type OrchOptions } from './orch.js';
import type { MissionStatus, SalvageStatus } from '../types/mission.js';

export interface MissionOptions extends OrchOptions {
  acceptance?: string;
  reason?: string;
  preset?: string;
  launch?: boolean;
  status?: string;
}

const VALID_STATUSES: MissionStatus[] = ['active', 'paused', 'delivered', 'failed'];

function dbFor(options: MissionOptions) {
  return openMissionDb(options.projectRoot ?? process.cwd());
}

function parseId(text: string): number | null {
  const n = parseInt(text, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function friendlyMission(db: ReturnType<typeof openMissionDb>, id: number): ReturnType<typeof getMission> | null {
  try {
    return getMission(db, id);
  } catch {
    return null;
  }
}

const statusColor: Record<MissionStatus, (s: string) => string> = {
  active: chalk.green,
  paused: chalk.yellow,
  delivered: chalk.cyan,
  failed: chalk.red,
};

async function createCmd(goal: string, options: MissionOptions): Promise<void> {
  const acceptance = (options.acceptance ?? '').trim();
  if (!goal.trim() || !acceptance) {
    console.log(chalk.yellow(
      '  Usage: uap mission create "<goal>" --acceptance "<criteria>" [--preset <id>] [--launch]'
    ));
    process.exitCode = 1;
    return;
  }
  const projectRoot = options.projectRoot ?? process.cwd();
  const db = dbFor(options);
  const mission = createMission(db, {
    goal: goal.trim(),
    acceptance,
    ...(options.preset ? { presetId: options.preset } : {}),
  });
  console.log(
    chalk.green(`  ✓ mission #${mission.id} created (acceptance frozen ${mission.acceptanceHash.slice(0, 12)}…)`
    )
  );
  if (options.launch) {
    const reports = await runPollCycle(projectRoot, undefined, undefined, { missionIds: [mission.id] });
    const mine = reports.find((r) => r.missionId === mission.id);
    for (const note of mine?.notes ?? []) console.log(chalk.dim(`    ${note}`));
    if (!mine) {
      console.log(chalk.yellow('  (the daemon will launch it on the next poll cycle)'));
    }
  } else {
    console.log(chalk.dim('  the orchestrator daemon launches it on the next poll (uap mission poll)'));
  }
}

function listCmd(options: MissionOptions): void {
  const db = dbFor(options);
  const status =
    options.status && VALID_STATUSES.includes(options.status as MissionStatus)
      ? (options.status as MissionStatus)
      : undefined;
  const missions = listMissions(db, { status });
  if (options.json) {
    console.log(JSON.stringify(missions, null, 2));
    return;
  }
  if (missions.length === 0) {
    console.log(chalk.dim('  No missions. Create one: uap mission create "<goal>" --acceptance "<criteria>"'));
    return;
  }
  console.log(chalk.bold('\n  Missions\n'));
  for (const m of missions) {
    console.log(
      `  #${m.id} ${statusColor[m.status](m.status)} ${chalk.dim(`run ${m.latestRunId ?? '—'} · launches ${m.launchCount} (${m.relaunchCount} resumes)`)}`
    );
    console.log(`      ${m.goal.slice(0, 110)}`);
  }
  console.log('');
}

function showCmd(idText: string, options: MissionOptions): void {
  const id = parseId(idText);
  const db = dbFor(options);
  if (id === null) {
    console.log(chalk.yellow('  Usage: uap mission show <id>'));
    process.exitCode = 1;
    return;
  }
  const mission = friendlyMission(db, id);
  if (!mission) {
    console.log(chalk.yellow(`  mission #${id} not found`));
    process.exitCode = 1;
    return;
  }
  const attempts = listAttempts(db, id);
  const salvage = listSalvage(db, { missionId: id });
  const revisions = listAcceptanceRevisions(db, id);
  if (options.json) {
    console.log(JSON.stringify({ mission, attempts, salvage, revisions }, null, 2));
    return;
  }
  console.log(chalk.bold(`\n  Mission #${mission.id} — ${statusColor[mission.status](mission.status)}\n`));
  console.log(`  ${chalk.bold('Goal')}       ${mission.goal}`);
  console.log(`  ${chalk.bold('Acceptance')} ${mission.acceptance}`);
  console.log(chalk.dim(`  frozen ${mission.acceptanceHash.slice(0, 16)}… · created ${mission.createdAt.slice(0, 16)}`));
  console.log(`  ${chalk.bold('Run')}        ${mission.latestRunId ?? '—'}`);
  console.log(`  ${chalk.bold('Launches')}  ${mission.launchCount} (${mission.relaunchCount} resumes)`);
  if (revisions.length > 0) {
    console.log(`  ${chalk.bold('Replans')}    ${revisions.length} (prior hashes recorded)`);
  }
  if (attempts.length > 0) {
    console.log(`\n  ${chalk.bold('Attempts')}`);
    for (const a of attempts) {
      console.log(`    ${a.outcome.padEnd(11)} ${chalk.dim(a.createdAt.slice(5, 16))} ${a.runId ?? ''} ${a.summary ?? ''}`.trimEnd());
    }
  }
  if (salvage.length > 0) {
    console.log(`\n  ${chalk.bold('Salvage')}`);
    for (const s of salvage) {
      console.log(`    #${s.id} ${s.status} ${chalk.dim(s.createdAt.slice(5, 16))}`);
      console.log(chalk.dim(`        ${s.proposal.slice(0, 120)}`));
    }
  }
  console.log('');
}

function pauseResumeCmd(idText: string, status: 'paused' | 'active', options: MissionOptions): void {
  const id = parseId(idText);
  if (id === null) {
    console.log(chalk.yellow('  Usage: uap mission pause <id> | uap mission resume <id>'));
    process.exitCode = 1;
    return;
  }
  const db = dbFor(options);
  const ok = setMissionStatus(db, id, status);
  console.log(
    ok
      ? chalk.green(`  ✓ mission #${id} ${status === 'paused' ? 'paused (the daemon will not touch it)' : 'resumed'}`)
      : chalk.yellow(`  mission #${id} not found`)
  );
  if (!ok) process.exitCode = 1;
}

function replanCmd(idText: string, options: MissionOptions): void {
  const id = parseId(idText);
  const acceptance = (options.acceptance ?? '').trim();
  const reason = (options.reason ?? '').trim();
  if (id === null || !acceptance || !reason) {
    console.log(chalk.yellow('  Usage: uap mission replan <id> --acceptance "<new>" --reason "<why>"'));
    process.exitCode = 1;
    return;
  }
  const db = dbFor(options);
  const mission = replanAcceptance(db, id, acceptance, reason);
  console.log(
    chalk.green(`  ✓ mission #${id} replanned (acceptance frozen ${mission.acceptanceHash.slice(0, 12)}…; prior recorded, run link reset)`
    )
  );
}

function salvageCmd(text: string, options: MissionOptions): void {
  const db = dbFor(options);
  const sub = text.trim();
  if (sub === '' || sub === 'list') {
    const items = listSalvage(db, {
      ...(options.status ? { status: options.status as SalvageStatus } : {}),
    });
    if (items.length === 0) {
      console.log(chalk.dim('  No salvage proposals.'));
      return;
    }
    console.log(chalk.bold('\n  Salvage proposals (approval-gated)\n'));
    for (const s of items) {
      const st =
        s.status === 'proposed' ? chalk.cyan('proposed') : s.status === 'approved' ? chalk.green('approved') : chalk.gray('rejected');
      console.log(`  #${s.id} ${st} ${chalk.dim(`mission #${s.missionId} · ${s.createdAt.slice(5, 16)}`)}`);
      console.log(`      ${s.proposal.slice(0, 130)}`);
    }
    console.log('');
    return;
  }
  const verb = sub.split(/\s+/)[0];
  const id = parseId(sub.split(/\s+/)[1] ?? '');
  if ((verb !== 'approve' && verb !== 'reject') || id === null) {
    console.log(chalk.yellow('  Usage: uap mission salvage list | approve <id> | reject <id>'));
    process.exitCode = 1;
    return;
  }
  const decided = decideSalvage(db, id, verb === 'approve' ? 'approved' : 'rejected');
  console.log(chalk.green(`  ✓ salvage #${id} ${decided.status}`));
}

export async function missionCommand(
  sub: string,
  text: string,
  options: MissionOptions = {}
): Promise<void> {
  switch (sub) {
    case 'create':
      await createCmd(text, options);
      break;
    case 'list':
      listCmd(options);
      break;
    case 'show':
      showCmd(text, options);
      break;
    case 'pause':
      pauseResumeCmd(text, 'paused', options);
      break;
    case 'resume':
      pauseResumeCmd(text, 'active', options);
      break;
    case 'replan':
      replanCmd(text, options);
      break;
    case 'salvage':
      salvageCmd(text, options);
      break;
    case 'poll':
      await orchPollCommand(options);
      break;
    default:
      console.log(
        chalk.yellow('  Usage: uap mission create|list|show|pause|resume|replan|salvage|poll …')
      );
      process.exitCode = 1;
  }
}


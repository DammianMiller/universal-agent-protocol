/**
 * `uap mission poll` — the orchestrator's loop clock (Choir's `orch poll`).
 * (Also registered as the hidden alias `uap orch poll` — NOT the same as
 * `uap orchestrator on|off`, which toggles the in-deliver blackboard
 * orchestrator.)
 *
 *   uap mission poll               one poll cycle over active missions, then exit
 *   uap mission poll --loop        keep polling (daemon mode; systemd runs this)
 *   uap mission poll --interval N  seconds between cycles (default 300)
 *   uap mission poll --json        machine-readable per-mission reports
 *
 * One cycle: discover runs → sync attempt ledger → decide (poll-cycle.ts) →
 * act (supervise / launch / relaunch with backoff / close / salvage-propose).
 * The cycle NEVER throws: a mission in a bad state produces a report note,
 * not a dead daemon.
 */

import chalk from 'chalk';
import { runPollCycle } from '../mission/poll-executor.js';
import type { PollMissionReport } from '../mission/poll-executor.js';

export interface OrchOptions {
  loop?: boolean;
  interval?: string;
  json?: boolean;
  projectRoot?: string;
}

export const DEFAULT_POLL_INTERVAL_SECS = 300;

/** Clamp the --interval flag: finite and ≥ 10 s, else the default. PURE. */
export function clampPollIntervalSecs(raw: string | undefined): number {
  const parsed = raw ? parseInt(raw, 10) : DEFAULT_POLL_INTERVAL_SECS;
  return Number.isFinite(parsed) && parsed >= 10 ? parsed : DEFAULT_POLL_INTERVAL_SECS;
}

function printReport(report: PollMissionReport): void {
  console.log(
    `  ${chalk.cyan(`mission #${report.missionId}`)}  ${report.actions.length > 0 ? report.actions.join(', ') : 'no action'}`
  );
  for (const note of report.notes) console.log(chalk.dim(`      ${note}`));
}

export async function orchPollCommand(options: OrchOptions = {}): Promise<void> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const intervalSecs = clampPollIntervalSecs(options.interval);

  const cycle = async (): Promise<boolean> => {
    let reports: PollMissionReport[];
    try {
      reports = await runPollCycle(projectRoot);
    } catch (e) {
      // The cycle must never take the daemon down — a broken ledger or an
      // unwritable project dir is a cycle error, not a process error.
      console.error(chalk.red(`orch poll cycle failed: ${e instanceof Error ? e.message : String(e)}`));
      return true;
    }
    if (options.json) {
      console.log(
        JSON.stringify({ ts: new Date().toISOString(), missions: reports }, null, 2)
      );
    } else if (reports.length > 0) {
      console.log(chalk.bold(`\n  orch poll — ${new Date().toISOString().slice(11, 19)}\n`));
      for (const r of reports) printReport(r);
      console.log('');
    } else {
      console.log(chalk.dim(`orch poll ${new Date().toISOString().slice(11, 19)} — no active missions`));
    }
    return true;
  };

  if (!options.loop) {
    await cycle();
    return;
  }

  // Daemon mode: sleep between cycles, forever. Each cycle is independent;
  // a crash inside one is caught above, and systemd Restart=always covers
  // anything that still escapes.
  for (;;) {
    await cycle();
    await new Promise((r) => setTimeout(r, intervalSecs * 1000));
  }
}

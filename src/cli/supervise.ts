/**
 * `uap supervise` — semantic supervisor for deliver missions.
 *
 *   uap supervise latest            watch the newest active run (Ctrl-C to detach)
 *   uap supervise <runId> --once    one observe→assess→decide→persist cycle
 *   uap supervise <runId> --json    machine-readable decision
 *
 * Exit codes: 0 = mission left running normally (CONTINUE/RETRY/VERIFY/FINISH),
 * 2 = supervisor acted against the mission (STOP/ESCALATE) or refused to run
 * (invalid policy, unknown run), 1 = unexpected error.
 */
import chalk from 'chalk';
import { runSupervisor } from '../supervise/loop.js';
import { SupervisorError } from '../supervise/config.js';
import type { Decision } from '../supervise/types.js';

export interface SuperviseOptions {
  once?: boolean;
  json?: boolean;
  intervalMs?: string;
  projectDir?: string;
}

function colorAction(action: Decision['action']): string {
  switch (action) {
    case 'STOP':
      return chalk.red.bold(action);
    case 'ESCALATE':
      return chalk.red(action);
    case 'RETRY':
      return chalk.yellow(action);
    case 'VERIFY':
      return chalk.blue(action);
    case 'FINISH':
      return chalk.green(action);
    default:
      return chalk.dim(action);
  }
}

function printDecision(runId: string, d: Decision): void {
  console.log(`  ${colorAction(d.action)}  ${chalk.dim(runId)}  ${d.reason}`);
}

export async function superviseCommand(runId: string | undefined, options: SuperviseOptions): Promise<void> {
  const projectRoot = options.projectDir || process.cwd();
  const target = runId || 'latest';
  const intervalOverrideMs = options.intervalMs !== undefined ? Number(options.intervalMs) : undefined;
  try {
    const result = await runSupervisor({
      projectRoot,
      runId: target,
      once: options.once,
      intervalOverrideMs,
      onDecision: options.json ? undefined : (d, obs) => printDecision(obs.runId, d),
    });
    const { decision } = result;
    if (options.json) {
      console.log(
        JSON.stringify({
          runId: result.runId,
          action: decision.action,
          reason: decision.reason,
          evidence: decision.evidence,
          cycles: result.cycles,
          statePath: result.statePath,
          eventsPath: result.eventsPath,
        })
      );
    } else {
      console.log(
        chalk.dim(
          `  supervised ${result.runId} · ${result.cycles} cycle(s) · state ${result.statePath}`
        )
      );
    }
    if (decision.action === 'STOP' || decision.action === 'ESCALATE') {
      process.exitCode = 2;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) {
      console.log(JSON.stringify({ runId: target, error: message }));
    } else {
      console.error(chalk.red(`  ✗ supervise: ${message}`));
    }
    process.exitCode = err instanceof SupervisorError ? 2 : 1;
  }
}

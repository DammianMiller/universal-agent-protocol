/**
 * Record HOW a deliver run's process ended.
 *
 * A run that dies leaves `status: 'running'` behind — deliberately, because that
 * is what `--resume` looks for. But nothing recorded *how* it died, so a mission
 * killed by its parent was indistinguishable from one still working: monitoring
 * could not tell a live run from a corpse, and there was no way to find out who
 * killed it or with what signal.
 *
 * That gap is not academic. Client-spawned deliver runs were dying within
 * seconds while the identical binary run from a shell worked fine — and with no
 * exit record anywhere, the cause could only be guessed at. This makes the
 * process state its own witness:
 *
 *  - SIGHUP  → the parent (client) tore down our process group
 *  - SIGTERM → something deliberately killed us (a timeout, a supervisor)
 *  - SIGINT  → an interactive interrupt
 *  - clean   → we exited on our own, with a code
 *  - NO record at all, but a dead pid → SIGKILL (no handler can run for it)
 *
 * The recorder is best-effort and must never itself break a run: every write is
 * wrapped, and the process is not prevented from exiting.
 */

import { appendFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { loadRunState, saveRunState } from './run-state.js';

/** How a deliver process ended. */
export interface RunExit {
  at: string;
  /** Signal name when killed (SIGHUP/SIGTERM/…), absent on a normal exit. */
  signal?: string;
  /** Exit code on a normal exit. */
  code?: number;
  /** pid of whoever spawned us — names the killer when the parent tears us down. */
  ppid?: number;
  reason: string;
}

const SIGNALS: NodeJS.Signals[] = ['SIGHUP', 'SIGTERM', 'SIGINT', 'SIGQUIT'];

/**
 * Why this process is about to exit, when something already knows.
 *
 * `process.on('exit')` is handed a number and nothing else, so a run stopped
 * deliberately by one of our own watchdogs recorded the same anonymous "exited
 * with code 130" as an operator pressing Ctrl-C. The difference is the whole
 * answer: one is a failure to investigate, the other is a policy that fired and
 * has a named remedy.
 *
 * That cost a real session on 2026-08-09. The orphan guard stopped two long
 * missions in `cognition-engine/src/rust-pg-ext`; the agent following them was
 * told only "it was interrupted", so it never learned that its own session
 * ending was the cause — it relaunched into the same guard, killed a run by
 * hand, and tried to disable the delivery gate. The cause was printed, but only
 * to a log file nobody had a reason to open.
 */
let pendingReason: string | null = null;

/**
 * Declare why this process is stopping, for the exit recorder to pick up.
 *
 * Call it immediately before exiting. A signal still wins if one arrives: the
 * signal handler names a cause it observed directly, which beats one we predicted.
 */
export function noteExitReason(reason: string): void {
  pendingReason = reason;
}

/** Forget any noted reason (tests, and long-lived hosts between runs). */
export function clearExitReason(): void {
  pendingReason = null;
}

/** Human-readable exit line for `.uap/deliver-exits.log`. */
export function formatExitLine(runId: string, exit: RunExit): string {
  const how = exit.signal ? `signal=${exit.signal}` : `code=${exit.code ?? '?'}`;
  return `${exit.at} run=${runId} ${how} ppid=${exit.ppid ?? '?'} reason=${exit.reason}\n`;
}

/** Append an exit record to the project's deliver-exits log (best-effort). */
export function appendExitLog(projectRoot: string, runId: string, exit: RunExit): void {
  try {
    const p = join(projectRoot, '.uap', 'deliver-exits.log');
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, formatExitLine(runId, exit), 'utf-8');
  } catch {
    /* never let logging break a run */
  }
}

/**
 * Persist the exit onto the run's state (keeping `status` untouched, so a killed
 * run stays resumable) and append it to the log.
 */
export function recordExit(projectRoot: string, runId: string, exit: RunExit): void {
  try {
    const state = loadRunState(projectRoot, runId);
    if (state) saveRunState({ ...state, exit } as typeof state & { exit: RunExit });
  } catch {
    /* best-effort */
  }
  appendExitLog(projectRoot, runId, exit);
}

/**
 * Install handlers so this process records its own death. Returns a disposer
 * that removes them (so a long-lived parent process — tests, the MCP server —
 * does not accumulate listeners).
 */
export function installRunExitRecorder(projectRoot: string, runId: string): () => void {
  let recorded = false;
  const once = (exit: RunExit): void => {
    if (recorded) return;
    recorded = true;
    recordExit(projectRoot, runId, exit);
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    once({
      at: new Date().toISOString(),
      signal,
      ppid: process.ppid,
      reason:
        signal === 'SIGHUP'
          ? 'parent closed our process group (client tore down the spawn)'
          : `killed by ${signal}`,
    });
    // Preserve normal semantics: die from the signal we were sent.
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };

  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const s of SIGNALS) {
    const h = (): void => onSignal(s);
    handlers.set(s, h);
    process.on(s, h);
  }

  const onExit = (code: number): void => {
    once({
      at: new Date().toISOString(),
      code,
      ppid: process.ppid,
      reason: pendingReason ?? (code === 0 ? 'exited normally' : `exited with code ${code}`),
    });
  };
  process.on('exit', onExit);

  return () => {
    for (const [s, h] of handlers) process.off(s, h);
    process.off('exit', onExit);
  };
}

/**
 * `uap loops` — the operator surface for the proxy's LOCKSTEP ESCALATION
 * guardrail (tools/agents/scripts/anthropic_proxy.py). When an agent session
 * re-issues the identical tool call and it fails with the identical error,
 * the proxy escalates pivot -> final warning -> hard stop and appends one
 * JSONL record per tier to the loop-incident ledger. This command lists those
 * incidents and turns one into an actionable handoff (`uap ideate` /
 * `uap deliver`), so a broken loop becomes a resolution task instead of a
 * silently wedged session.
 *
 * The ledger is deliberately lossy — tool arguments are hashed, never stored
 * — so this command only ever sees the loop's shape, not its payload.
 */
import chalk from 'chalk';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface LoopIncident {
  v?: number;
  ts: string;
  guard: string;
  outcome: string;
  session: string;
  tool: string;
  fingerprint: string;
  error_signature: string;
  streak: number;
  doubling_streak: number;
  error_signature_streak: number;
  fires: number;
  blocks: number;
  detail: string;
}

/** Ledger fields are tool-result-derived text: a remote shell banner or
 * fetched page can carry ESC/C0 control bytes that would replay into the
 * operator's terminal (CWE-150). Strip them at render time. The `--json`
 * output is a machine contract and keeps the raw record. */
export function stripControlChars(text: string): string {
  /* eslint-disable no-control-regex */
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC: hyperlinks, window title
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI: colors, cursor movement
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ''); // any remaining C0/C1 bytes
  /* eslint-enable no-control-regex */
}

/** POSIX single-quote escaping for the ready-to-run handoff commands —
 * JSON.stringify quoting does not neutralize $(…) / backticks inside
 * double quotes. */
export function shQuote(text: string): string {
  return `'${stripControlChars(text).replace(/'/g, `'\\''`)}'`;
}

export interface LoopsOptions {
  limit?: string;
  json?: boolean;
  file?: string;
}

/** Ledger path: env override, then the XDG layout the proxy writes. */
export function loopIncidentsPath(): string {
  const env = process.env.UAP_LOOP_INCIDENTS;
  if (env) return env;
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configHome, 'uap', 'loop-incidents.jsonl');
}

function isLoopIncident(value: unknown): value is LoopIncident {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.ts === 'string' &&
    typeof rec.outcome === 'string' &&
    typeof rec.tool === 'string' &&
    typeof rec.error_signature === 'string'
  );
}

/** Parse the JSONL ledger, skipping malformed lines (a torn final write must
 * not blank the whole history). */
export function readLoopIncidents(path: string = loopIncidentsPath()): LoopIncident[] {
  if (!existsSync(path)) return [];
  const out: LoopIncident[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isLoopIncident(parsed)) out.push(parsed);
    } catch {
      // torn/partial line — skip
    }
  }
  return out;
}

const OUTCOME_COLOR: Record<string, (s: string) => string> = {
  pivot: chalk.yellow,
  final_warning: chalk.hex('#d29922'),
  hard_blocked: chalk.red,
};

function colorOutcome(outcome: string): string {
  const fn = OUTCOME_COLOR[outcome] ?? chalk.dim;
  return fn(outcome);
}

/** The deliver/ideate handoff for one incident — ready-to-run commands. */
export function escalationHints(incident: LoopIncident): string[] {
  const sig = stripControlChars(incident.error_signature)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  const tool = stripControlChars(incident.tool);
  const instruction =
    `A previous agent session looped on the '${tool}' tool: the identical call ` +
    `failed ${incident.streak} times with the identical error: "${sig}". ` +
    `Do NOT retry that same call. Diagnose the root cause from the error, pick a ` +
    `genuinely different approach, and verify the fix end-to-end.`;
  const hints = [`uap deliver ${shQuote(instruction)}`];
  if (incident.fingerprint) {
    hints.push(
      `uap ideate setup loop-${incident.fingerprint}   # then: uap ideate run loop-${incident.fingerprint}`,
    );
  }
  return hints;
}

export async function loopsCommand(id: string | undefined, options: LoopsOptions): Promise<void> {
  const path = options.file || loopIncidentsPath();
  const incidents = readLoopIncidents(path);

  if (incidents.length === 0) {
    if (options.json) {
      console.log(JSON.stringify({ path, incidents: [] }));
    } else {
      console.log(chalk.dim(`No loop incidents recorded (${path}).`));
      console.log(
        chalk.dim(
          'The proxy lockstep guardrail appends here when an agent repeats an identical failing call.',
        ),
      );
    }
    return;
  }

  if (id !== undefined) {
    // Numeric ids address the list view ([0] = newest). Fingerprint prefixes
    // resolve to the NEWEST matching record — a loop's pivot/final/hard tiers
    // share one fingerprint, and the hard stop is the one worth reading.
    const byIndex = /^\d+$/.test(id) ? incidents[incidents.length - 1 - Number(id)] : undefined;
    const incident =
      byIndex ?? [...incidents].reverse().find((rec) => rec.fingerprint.startsWith(id));
    if (!incident) {
      console.error(chalk.red(`No incident matching '${id}'. Run 'uap loops' to list.`));
      process.exit(2);
    }
    if (options.json) {
      console.log(JSON.stringify({ ...incident, escalation: escalationHints(incident) }, null, 2));
      return;
    }
    console.log(chalk.bold(`Loop incident — ${incident.ts}`));
    console.log(`  outcome:    ${colorOutcome(incident.outcome)}`);
    console.log(`  tool:       ${stripControlChars(incident.tool)}`);
    console.log(`  streak:     ${incident.streak} (call x${incident.doubling_streak}, error x${incident.error_signature_streak})`);
    console.log(`  session:    ${stripControlChars(incident.session) || '(unknown)'}`);
    console.log(`  fingerprint:${incident.fingerprint ? ` ${incident.fingerprint}` : ' (none)'}`);
    console.log(`  error:      ${stripControlChars(incident.error_signature)}`);
    console.log('');
    console.log(chalk.bold('Escalate the broken loop:'));
    for (const hint of escalationHints(incident)) {
      console.log(`  ${chalk.cyan(hint)}`);
    }
    return;
  }

  const limit = Math.max(1, Number.parseInt(options.limit ?? '10', 10) || 10);
  const recent = incidents.slice(-limit).reverse();
  if (options.json) {
    console.log(JSON.stringify({ path, total: incidents.length, incidents: recent }, null, 2));
    return;
  }
  console.log(chalk.bold(`Loop incidents (${incidents.length} total, showing ${recent.length}) — ${path}`));
  recent.forEach((rec, i) => {
    console.log(
      `  ${chalk.dim(`[${i}]`)} ${rec.ts}  ${colorOutcome(rec.outcome.padEnd(13))} ` +
        `${stripControlChars(rec.tool) || '?'} x${rec.streak}  ${chalk.dim(stripControlChars(rec.error_signature).slice(0, 72))}`,
    );
  });
  console.log(chalk.dim(`\n'uap loops <n|fingerprint>' shows one incident with its ideate/deliver handoff.`));
}

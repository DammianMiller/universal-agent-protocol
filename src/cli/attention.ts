/**
 * `uap attention` — the operator attention queue surface .
 *
 *   uap attention list [--status <s>] [--json]   newest first; OPEN items by
 *                                                default (pending + acknowledged
 *                                                + escalated — an escalated ask
 *                                                is exactly what must not drop
 *                                                out of the casual view)
 *   uap attention ack <id>                       seen (grace clock keeps running)
 *   uap attention decide <id> <decision>         answer the ask
 *   uap attention sweep [--json]                  AFK decider: adopt safe defaults
 *
 * The queue is how an agent asks instead of stopping: items record the
 * decision needed, its context, and the SAFE DEFAULT the AFK decider may
 * adopt once the grace window lapses. `list` (default filter) is also the
 * session-start surface (fail-open, bounded).
 */
import {
  listAttention,
  ackAttention,
  decideAttention,
  sweepExpired,
  attentionQueuePath,
  type AttentionItem,
  type AttentionStatus,
} from '../delivery/attention.js';
import { relative, resolve } from 'path';

export interface AttentionCommandOptions {
  json?: boolean;
  status?: string;
}

const KNOWN_STATUSES = new Set<AttentionStatus>(['pending', 'acknowledged', 'auto-decided', 'decided', 'escalated']);
/** The default view: every item that still wants an answer. An escalated
 *  ask (no safe default) is the loudly-unresolved class — hiding it from
 *  the default view is how "never silently expire" silently dies. */
const OPEN_STATUSES: ReadonlySet<AttentionStatus> = new Set<AttentionStatus>(['pending', 'acknowledged', 'escalated']);

function displayPath(cwd: string, path: string): string {
  const rel = relative(resolve(cwd), resolve(path));
  return rel && !rel.startsWith('..') ? rel : path;
}

function printItem(item: AttentionItem): void {
  console.log(`  [${item.id}] ${item.status} — ${item.title}`);
  if (item.detail) console.log(`      ${item.detail}`);
  if (item.safeDefault) console.log(`      safe default (AFK): ${item.safeDefault.decision} — ${item.safeDefault.rationale}`);
  if (item.resolution) console.log(`      resolution: ${item.resolution}`);
}

export async function attentionCommand(
  action: string | undefined,
  id: string | undefined,
  decision: string | undefined,
  options: AttentionCommandOptions = {},
  cwd: string = process.cwd()
): Promise<void> {
  // AFK decider: adopt recorded safe defaults for anything past grace.
  if (action === 'sweep') {
    const result = sweepExpired(cwd);
    if (options.json) {
      console.log(JSON.stringify({ ok: true, ...result }));
      return;
    }
    if (result.adopted + result.escalated === 0) {
      console.log('No grace-elapsed items.');
    } else {
      console.log(`Swept: ${result.adopted} auto-decided, ${result.escalated} escalated (no safe default).`);
    }
    return;
  }

  if (action === 'ack') {
    if (!id) {
      console.error('uap attention ack: an id is required');
      process.exitCode = 1;
      return;
    }
    const item = ackAttention(cwd, id);
    if (!item) {
      console.error(`uap attention ack: no pending item '${id}'`);
      process.exitCode = 1;
      return;
    }
    console.log(`acked [${item.id}] ${item.title} — the grace clock keeps running`);
    return;
  }

  if (action === 'decide') {
    if (!id || !decision || !decision.trim()) {
      console.error('uap attention decide: an id and a decision are required');
      process.exitCode = 1;
      return;
    }
    const item = decideAttention(cwd, id, decision);
    if (!item) {
      console.error(`uap attention decide: no open item '${id}'`);
      process.exitCode = 1;
      return;
    }
    console.log(`decided [${item.id}] ${item.title} — ${item.resolution}`);
    return;
  }

  // default: list
  if (action && action !== 'list') {
    console.error(`uap attention: unknown action '${action}' (list | ack | decide | sweep)`);
    process.exitCode = 1;
    return;
  }
  // An unknown --status is a typo, not a silent filter change: erroring
  // beats showing pending items as if the filter applied.
  if (options.status !== undefined && !KNOWN_STATUSES.has(options.status as AttentionStatus)) {
    console.error(`uap attention list: unknown status '${options.status}' (pending | acknowledged | auto-decided | decided | escalated)`);
    process.exitCode = 1;
    return;
  }
  const status = options.status as AttentionStatus | undefined;
  const items = status
    ? listAttention(cwd, status)
    : listAttention(cwd).filter((i) => OPEN_STATUSES.has(i.status));
  const label = status ?? 'open';
  if (options.json) {
    console.log(JSON.stringify({ ok: true, status: label, count: items.length, items }));
    return;
  }
  if (items.length === 0) {
    console.log(`No ${label} attention items.`);
    return;
  }
  console.log(`## Attention (${items.length} ${label} item(s)) — ${displayPath(cwd, attentionQueuePath(cwd))}`);
  for (const item of items) printItem(item);
  console.log(`  Answer with: uap attention decide <id> "<decision>" · Sweep AFK items: uap attention sweep`);
}

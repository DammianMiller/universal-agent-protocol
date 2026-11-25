/**
 * Droid session-transcript bridge (wave 6, item 2) — the corpus finally sees
 * the client fleet's real traffic.
 *
 * The tool_calls corpus only ever saw UAP-orchestrated sessions. The Droid
 * inkling-2 client sessions — the exact class this fleet's uplift mandate is
 * about — record NOTHING there: a 9.5-hour round-5 session (155 tool calls,
 * measured 2026-11-25) exists only in Droid's own transcript
 * (~/.factory/sessions/<cwd-slug>/<uuid>.jsonl), invisible to every corpus
 * query, failure-class ranking, and era table. This module parses those
 * transcripts and emits their tool calls as corpus rows through the same
 * recordToolCall classification path, so `uap telemetry report` and the
 * evolve stage see the fleet, not just the harness's own missions.
 *
 * Transcript shape (measured on the round-5 session file):
 *   {type:'session_start', cwd, title, ...}
 *   {type:'message', timestamp, seq, message:{role, content:[...]}} where
 *     assistant content parts carry {type:'tool_use', id, name, input}
 *     and user parts carry {type:'tool_result', tool_use_id, content,
 *     is_error?}. Result content is a string or an array of
 *     {type:'text', text} parts.
 *
 * Ingest is idempotent per session: the session's rows are cleared by run_id
 * first, so re-ingesting a transcript replaces rather than duplicates.
 */

import { readFileSync } from 'fs';
import { basename } from 'path';
import { clearToolCallRun, recordToolCall, toolCorpusRoot } from './tool-calls.js';

/** Droid tool name → the corpus tool-name space (components + failure
 * classes resolve against it). Names outside the map are snake_cased. */
const TOOL_NAME_MAP: Record<string, string> = {
  Execute: 'run_bash',
  Bash: 'run_bash',
  Read: 'read_file',
  LS: 'list_dir',
  Edit: 'edit_file',
  Create: 'write_file',
  Write: 'write_file',
  Grep: 'grep',
  Glob: 'glob',
  Task: 'task',
  TodoWrite: 'todo_write',
  Skill: 'skill',
  AskUser: 'ask_user',
  ToolSearch: 'tool_search',
  WebFetch: 'web_fetch',
  WebSearch: 'web_search',
};

function mapToolName(name: string): string {
  return TOOL_NAME_MAP[name] ?? name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** Where a file-targeted tool's path lives in its input (measured shapes). */
function inputPathOf(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const rec = input as Record<string, unknown>;
  for (const key of ['file_path', 'path', 'directory_path', 'notebook_path']) {
    const v = rec[key];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string'
          ? (p as { text: string }).text
          : '',
      )
      .join('\n');
  }
  return '';
}

export interface DroidToolEvent {
  /** The tool_use id — pairs the call with its result inside the transcript. */
  callId: string;
  /** Mapped corpus tool name. */
  tool: string;
  inputPath?: string;
  resultText: string;
  isError: boolean;
  /** The assistant message's seq — the turn number. */
  turn: number;
  latencyMs?: number;
}

export interface DroidSessionSummary {
  sessionFile: string;
  /** Transcript stem (uuid) — the corpus run_id. */
  sessionId: string;
  cwd?: string;
  title?: string;
  toolCalls: DroidToolEvent[];
  /** tool_use parts whose result never appeared (session cut off mid-call). */
  unpaired: number;
}

interface PendingCall {
  callId: string;
  tool: string;
  inputPath?: string;
  turn: number;
  calledAt: number;
}

function tsMs(ts: unknown): number | null {
  if (typeof ts !== 'string') return null;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

/** Parse one Droid session transcript. Pure: no corpus writes. */
export function parseDroidSession(text: string, sessionFile = ''): DroidSessionSummary {
  const sessionId = sessionFile ? basename(sessionFile).replace(/\.jsonl$/, '') : '';
  const summary: DroidSessionSummary = {
    sessionFile,
    sessionId,
    toolCalls: [],
    unpaired: 0,
  };
  const pending = new Map<string, PendingCall>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // a corrupt line never breaks the parse
    }
    if (evt.type === 'session_start') {
      summary.cwd = typeof evt.cwd === 'string' ? evt.cwd : undefined;
      summary.title = typeof evt.title === 'string' ? evt.title : undefined;
      continue;
    }
    if (evt.type !== 'message') continue;
    const msg = evt.message as { role?: unknown; content?: unknown } | undefined;
    if (!msg) continue;
    const seq = typeof evt.seq === 'number' ? evt.seq : 0;
    const calledAt = tsMs(evt.timestamp);
    if (msg.role !== 'assistant' && msg.role !== 'user') continue;
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (!part || typeof part !== 'object') continue;
      const p = part as Record<string, unknown>;
      if (p.type === 'tool_use' && msg.role === 'assistant') {
        const callId = typeof p.id === 'string' ? p.id : '';
        if (!callId) continue;
        pending.set(callId, {
          callId,
          tool: mapToolName(typeof p.name === 'string' ? p.name : String(p.name ?? '')),
          inputPath: inputPathOf(p.input),
          turn: seq,
          calledAt: calledAt ?? 0,
        });
      } else if (p.type === 'tool_result' && msg.role === 'user') {
        const callId = typeof p.tool_use_id === 'string' ? p.tool_use_id : '';
        const call = pending.get(callId);
        if (!call) continue;
        pending.delete(callId);
        const resultText = textOfContent(p.content);
        const resultAt = tsMs(evt.timestamp);
        summary.toolCalls.push({
          callId,
          tool: call.tool,
          inputPath: call.inputPath,
          resultText,
          isError: p.is_error === true,
          turn: call.turn,
          latencyMs:
            resultAt !== null && call.calledAt > 0 && resultAt >= call.calledAt
              ? resultAt - call.calledAt
              : undefined,
        });
      }
    }
  }
  summary.unpaired = pending.size;
  return summary;
}

export interface DroidIngestResult extends DroidSessionSummary {
  /** Rows replaced by the idempotent clear (re-ingest of a known session). */
  replacedRows: number;
  /** Outcome classes the corpus filed the rows under, with counts. */
  outcomes: Record<string, number>;
}

/**
 * Ingest one Droid session transcript into the tool_calls corpus. Idempotent
 * per session: existing rows for the session's run_id are cleared first, so
 * re-ingesting replaces. Returns the parsed summary plus what the corpus did.
 */
export function ingestDroidSession(
  sessionPath: string,
  root = toolCorpusRoot(),
): DroidIngestResult {
  const text = readFileSync(sessionPath, 'utf-8');
  const parsed = parseDroidSession(text, sessionPath);
  const replacedRows = clearToolCallRun(parsed.sessionId, root);
  const outcomes: Record<string, number> = {};
  for (const call of parsed.toolCalls) {
    // Droid's is_error flag is the authoritative failure signal; routing the
    // text through the 'error:' prefix lets the existing failure-class
    // branches (path-not-found, edit-miss, ...) still file the SPECIFIC class
    // from the body text. Non-error text passes through untouched.
    const result = call.isError ? `error: ${call.resultText}` : call.resultText;
    const outcome = recordToolCall(
      {
        runId: parsed.sessionId,
        taskId: parsed.cwd,
        tool: call.tool,
        result,
        turn: call.turn,
        path: call.inputPath,
        latencyMs: call.latencyMs,
        bytes: call.resultText.length,
        runKind: 'live',
      },
      root,
    );
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  }
  return { ...parsed, replacedRows, outcomes };
}

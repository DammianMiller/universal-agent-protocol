/**
 * Memory bridge — "hijack" each coding agent's NATIVE memory/instruction file so
 * it points at the UAP unified memory system instead of a siloed per-agent store.
 *
 * Every coding agent keeps its own memory/instructions:
 *   - Claude Code:  ~/.claude/projects/<escaped-cwd>/memory/MEMORY.md  (auto-memory index)
 *                   + CLAUDE.md (project instructions)
 *   - opencode / Codex / Factory:  AGENTS.md
 *   - Gemini CLI:   GEMINI.md
 *   - Cursor:       .cursor/rules/*.mdc
 *   - Copilot:      .github/copilot-instructions.md
 *
 * The bridge writes a single MARKED, idempotent block into each detected file that
 * (a) declares UAP the canonical cross-agent memory, (b) gives the recall/store
 * commands, and (c) mirrors the most-important recent memories inline — so an agent
 * reading its native memory is transparently reading UAP's. Non-destructive: the
 * block is prepended (or updated in place) and the rest of the file is preserved.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import Database from 'better-sqlite3';

export const BRIDGE_START = '<!-- UAP-MEMORY-BRIDGE:START (managed by `uap memory bridge`) -->';
export const BRIDGE_END = '<!-- UAP-MEMORY-BRIDGE:END -->';

export interface NativeMemoryTarget {
  /** Coding agent this file belongs to. */
  platform: string;
  /** Human label for CLI output. */
  label: string;
  /** Absolute path to the native memory/instruction file. */
  file: string;
  /** True when this agent's footprint is present in/around the project. */
  detected: boolean;
}

export interface BridgeResult {
  platform: string;
  label: string;
  file: string;
  action: 'created' | 'updated' | 'unchanged' | string;
}

/**
 * Claude Code stores its auto-memory index at
 * `~/.claude/projects/<escaped-cwd>/memory/MEMORY.md`, where the project segment
 * is the absolute cwd with every path separator replaced by a dash.
 */
export function claudeMemoryIndexPath(cwd: string): string {
  const slug = cwd.replace(/[/\\]/g, '-');
  return join(homedir(), '.claude', 'projects', slug, 'memory', 'MEMORY.md');
}

/** The native memory/instruction files, with per-agent detection. */
export function nativeMemoryTargets(cwd: string): NativeMemoryTarget[] {
  const has = (p: string): boolean => existsSync(join(cwd, p));
  const claudeIdx = claudeMemoryIndexPath(cwd);
  return [
    {
      platform: 'claude-code',
      label: 'Claude Code memory index (MEMORY.md)',
      file: claudeIdx,
      detected: existsSync(dirname(claudeIdx)) || has('.claude') || has('CLAUDE.md'),
    },
    { platform: 'claude-code', label: 'CLAUDE.md', file: join(cwd, 'CLAUDE.md'), detected: has('CLAUDE.md') || has('.claude') },
    {
      platform: 'opencode/codex/factory',
      label: 'AGENTS.md',
      file: join(cwd, 'AGENTS.md'),
      detected: has('AGENTS.md') || has('.opencode') || has('.codex') || has('.factory'),
    },
    { platform: 'gemini', label: 'GEMINI.md', file: join(cwd, 'GEMINI.md'), detected: has('GEMINI.md') || has('.gemini') },
    {
      platform: 'cursor',
      label: 'Cursor rule (.cursor/rules/uap-memory.mdc)',
      file: join(cwd, '.cursor', 'rules', 'uap-memory.mdc'),
      detected: has('.cursor') || has('.cursorrules'),
    },
    {
      platform: 'copilot',
      label: 'Copilot instructions',
      file: join(cwd, '.github', 'copilot-instructions.md'),
      detected: has('.github/copilot-instructions.md'),
    },
  ];
}

/** Most-important recent memories, mirrored into the bridge block. Fail-soft. */
export function recentMemoryLines(cwd: string, limit = 8): string[] {
  try {
    const db = new Database(join(cwd, 'agents', 'data', 'memory', 'short_term.db'), { readonly: true });
    const rows = db
      .prepare(
        'SELECT content, type, importance FROM memories ORDER BY importance DESC, id DESC LIMIT ?'
      )
      .all(limit) as Array<{ content: string; type: string; importance: number }>;
    db.close();
    return rows.map(
      (r) => `  - (${r.type}, i${r.importance}) ${String(r.content).replace(/\s+/g, ' ').slice(0, 140)}`
    );
  } catch {
    return [];
  }
}

/** Compose the marked bridge block (idempotent content for a given project). */
export function buildBridgeBlock(cwd: string): string {
  const recent = recentMemoryLines(cwd);
  const mirror = recent.length
    ? recent.join('\n')
    : '  - (none yet — memories appear here as you `uap memory store` them)';
  return [
    BRIDGE_START,
    '## Memory — managed by UAP (unified, cross-agent)',
    '',
    'Your persistent memory is the **UAP memory system** — ONE store shared by every',
    'coding agent on this project, NOT a per-agent memory file. Use it, not a local one:',
    '',
    '- **Recall FIRST** on non-trivial work: `uap memory query "<topic>"` (semantic long-term search).',
    '- **Store** durable facts/decisions/lessons: `uap memory store "<fact>"`.',
    '- **Status**: `uap memory status`.',
    '',
    'Recent UAP memories (auto-mirrored — do not hand-edit; refresh with `uap memory bridge`):',
    mirror,
    '',
    'Read and write here so every agent compounds the same knowledge instead of siloed recall.',
    BRIDGE_END,
  ].join('\n');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Inject or refresh the bridge block in a single file. Idempotent + non-destructive:
 * an existing block is replaced in place; otherwise the block is prepended so it is
 * the first thing the agent reads. Returns what changed.
 */
export function bridgeFile(file: string, block: string): BridgeResult['action'] {
  const existed = existsSync(file);
  const content = existed ? readFileSync(file, 'utf-8') : '';
  const re = new RegExp(escapeRegExp(BRIDGE_START) + '[\\s\\S]*?' + escapeRegExp(BRIDGE_END));
  const next = re.test(content) ? content.replace(re, block) : `${block}\n\n${content}`;
  if (existed && next === content) return 'unchanged';
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next.endsWith('\n') ? next : `${next}\n`, 'utf-8');
  return existed ? 'updated' : 'created';
}

/**
 * Hijack every detected coding-agent native memory file to point at UAP memory.
 * With `all`, also writes the files for agents not currently detected (so a later
 * agent inherits the bridge). Fail-soft per target.
 */
export function bridgeMemory(cwd: string = process.cwd(), opts: { all?: boolean } = {}): BridgeResult[] {
  const block = buildBridgeBlock(cwd);
  const targets = nativeMemoryTargets(cwd).filter((t) => opts.all || t.detected);
  const results: BridgeResult[] = [];
  for (const t of targets) {
    try {
      results.push({ platform: t.platform, label: t.label, file: t.file, action: bridgeFile(t.file, block) });
    } catch (e) {
      results.push({
        platform: t.platform,
        label: t.label,
        file: t.file,
        action: `error: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return results;
}

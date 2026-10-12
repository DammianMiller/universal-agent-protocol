/**
 * `uap diff` — the local diff view .
 *
 * The operator's one-command answer to "what has the agent changed around
 * here?": uncommitted AND unpushed work, summarized legibly — per-file line
 * deltas with status codes (modified / added / deleted / renamed / untracked),
 * against both HEAD and the base branch, with the exact commands to inspect
 * deeper. A worktree-scoped agent's output lives in `.worktrees/NNN-<slug>/`
 * where a plain `git status` scrolls past; this is the at-a-glance view.
 *
 * Safe-git contract (inherited from supervise/observe): git runs via
 * execFileSync ARG ARRAYS (no shell, no interpolation), 5s timeout, and every
 * failure degrades to `unknown` — the view renders with what it could read,
 * it never throws. Output is capped per section (`--max`, default 40 files)
 * because a monorepo can list thousands.
 */

import { execFileSync } from 'child_process';
import chalk from 'chalk';
import { termSafe } from '../utils/terminal-safe.js';

export interface DiffOptions {
  /** Base ref for the unpushed view (default: master). */
  base?: string;
  /** Per-section file cap (default 40). */
  max?: string;
  /** Test/odd-layout seam: pin the working dir (default: process.cwd()). */
  cwd?: string;
  json?: boolean;
}

const GIT_TIMEOUT_MS = 5000;
/** Cap a monorepo's file list — the view is a summary, not a log dump. */
const DEFAULT_MAX_FILES = 40;

/** What happened to one file. `!` = a delta row whose status could not be read. */
export type FileStatus = 'M' | 'A' | 'D' | 'R' | '?' | '!';

/** One file's line delta as `git diff --numstat` reports it. */
export interface FileDelta {
  path: string;
  /** Lines added; null for binary files. */
  added: number | null;
  /** Lines removed; null for binary files. */
  removed: number | null;
  status: FileStatus;
}

export interface DiffFacts {
  /** Current branch name, or null when detached. */
  branch: string | null;
  /** Worktree dir name (NNN-slug) when running inside a UAP worktree. */
  worktree: string | null;
  /** Uncommitted files (vs HEAD): staged + unstaged, one row per path. */
  uncommitted: FileDelta[];
  /** Untracked paths (never added to the index). */
  untracked: string[];
  /** Unpushed commits vs base: oneline subjects, newest first, capped. */
  unpushedCommits: string[];
  /** Ahead/behind counts vs the merge-base, when computable. */
  ahead: number | null;
  behind: number | null;
  /** Aggregate unpushed file deltas (base...HEAD). */
  unpushedFiles: FileDelta[];
  /** The base ref this view compares against. */
  base: string;
  /** The numstat read (uncommitted deltas) succeeded. False ⇒ the empty
   * uncommitted list is UNKNOWN, not clean — the view must not claim
   * cleanliness from absent data. */
  numstatOk: boolean;
  /** The porcelain status read (untracked + status codes) succeeded. */
  statusOk: boolean;
  /** Populated when git itself was unusable — the view says so. */
  gitError: string | null;
}

/** Run git, return stdout or null (never throw). `core.quotepath=false`
 *  everywhere: git's default quotes non-ASCII paths as octal escapes
 *  (`"\303\251clat"`), which would mangle every unicode filename in the
 *  view AND break the porcelain↔numstat exact-match fold (numstat's path
 *  would carry escapes porcelain stripped). Raw bytes on both sides. */
function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.quotepath=false', ...args], {
      cwd,
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

/** Parse `git diff --numstat` output into delta rows (status unknown). */
export function parseNumstat(out: string): FileDelta[] {
  const files: FileDelta[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    files.push({
      added: m[1] === '-' ? null : parseInt(m[1], 10),
      removed: m[2] === '-' ? null : parseInt(m[2], 10),
      // Renames arrive as `{old => new}` path shapes; keep the tail verbatim.
      // Outer quotes (git quotes paths with spaces/specials) are stripped so
      // the porcelain fold's exact match sees the same spelling on both sides.
      path: m[3].replace(/^"|"$/g, ''),
      status: '!',
    });
  }
  return files;
}

/** Fold `git status --porcelain` codes onto delta rows by path. */
export function applyPorcelain(deltas: FileDelta[], porcelain: string): { untracked: string[] } {
  const untracked: string[] = [];
  for (const line of porcelain.split('\n')) {
    if (!line) continue;
    const code = line.slice(0, 2);
    const raw = line.slice(3).trim().replace(/^"|"$/g, '');
    if (code === '??') {
      untracked.push(raw);
      continue;
    }
    // XY: prefer the worktree code (Y) — the file's state on disk is what the
    // operator sees — else the index code (X).
    const y = code[1]?.trim();
    const x = code[0]?.trim();
    const c = y || x || '';
    const status: FileStatus = c === 'D' ? 'D' : c === 'A' ? 'A' : c === 'R' ? 'R' : c === 'M' ? 'M' : '?';
    // Renames: porcelain prints `old -> new` (and sometimes just `new`);
    // numstat prints `{old => new}`. Normalize both spellings before matching
    // so the status lands on the right row. Exact matches win over fuzzy
    // suffix matches (an `endsWith` hit on an earlier row must not steal the
    // status from an exact row). Rows porcelain does not cover keep their
    // `!` — status codes are cosmetic, the deltas are the substance.
    const renameArrow = raw.indexOf(' -> ');
    const effective = (renameArrow >= 0 ? raw.slice(renameArrow + 4) : raw).replace(/^"|"$/g, '');
    const exact = deltas.find((d) => d.path === raw || d.path.replace(/\{[^}]* => ([^}]*)\}/g, '$1') === effective);
    const match = exact ?? deltas.find((d) => d.path.endsWith(raw));
    if (match) match.status = status;
  }
  return { untracked };
}

/** Gather the raw facts from git. Degrades to empty on any failure — and
 * records WHICH reads failed, so the view can say "unknown" instead of
 * claiming "clean" from absent data. */
export function gatherDiffFacts(cwd: string, options: DiffOptions = {}): DiffFacts {
  const base = options.base || 'master';
  const facts: DiffFacts = {
    branch: null,
    worktree: null,
    uncommitted: [],
    untracked: [],
    unpushedCommits: [],
    ahead: null,
    behind: null,
    unpushedFiles: [],
    base,
    numstatOk: false,
    statusOk: false,
    gitError: null,
  };

  // "Is this a repo" must not be probed with rev-parse HEAD — an unborn
  // branch (fresh init, no commits) has no HEAD and would be misreported as
  // "not a repository". is-inside-work-tree answers the question directly.
  const inside = git(['rev-parse', '--is-inside-work-tree'], cwd);
  if (inside === null || inside.trim() !== 'true') {
    facts.gitError = 'git unavailable or not a repository';
    return facts;
  }
  // symbolic-ref reads the branch even when HEAD is unborn; it fails only
  // when HEAD is detached (no symbolic ref) → null → "(detached)".
  const branch = git(['symbolic-ref', '--short', 'HEAD'], cwd);
  facts.branch = branch === null ? null : branch.trim() || null;
  facts.worktree = /(^|\/)\.worktrees\/([0-9]+-[^/]+)\/?$/.exec(cwd)?.[2] ?? null;

  // Uncommitted: staged + unstaged in ONE numstat pass (vs HEAD), then fold
  // porcelain status codes and untracked paths onto it. --no-ext-diff keeps
  // a repo-configured external diff driver out of the read (numstat bypasses
  // drivers today; the flag is defense-in-depth for future flag changes).
  const numstat = git(['diff', '--no-ext-diff', '--numstat', 'HEAD', '--'], cwd);
  facts.numstatOk = numstat !== null;
  if (numstat !== null) {
    const seen = new Set<string>();
    for (const f of parseNumstat(numstat)) {
      if (seen.has(f.path)) continue; // same path staged+unstaged: one row
      seen.add(f.path);
      facts.uncommitted.push(f);
    }
  }
  const status = git(['status', '--porcelain', '--untracked-files=all'], cwd);
  facts.statusOk = status !== null;
  if (status !== null) {
    facts.untracked = applyPorcelain(facts.uncommitted, status).untracked;
  }

  // Unpushed: ahead/behind and aggregate deltas vs the merge-base with base.
  const counts = git(['rev-list', '--left-right', '--count', `${base}...HEAD`], cwd);
  if (counts !== null) {
    const m = counts.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) {
      facts.behind = parseInt(m[1], 10);
      facts.ahead = parseInt(m[2], 10);
    }
  }
  if (facts.ahead === null || facts.ahead > 0) {
    const log = git(['log', '--no-ext-diff', '--oneline', '--no-decorate', `${base}..HEAD`, '--'], cwd);
    if (log !== null) {
      facts.unpushedCommits = log
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, DEFAULT_MAX_FILES);
    }
    const diffBase = git(['diff', '--no-ext-diff', '--numstat', `${base}...HEAD`, '--'], cwd);
    if (diffBase !== null) facts.unpushedFiles = parseNumstat(diffBase);
  }

  return facts;
}

const fmtDelta = (n: number | null): string => (n === null ? '±' : String(n));

function totalDeltas(files: FileDelta[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const f of files) {
    added += f.added ?? 0;
    removed += f.removed ?? 0;
  }
  return { added, removed };
}

const STATUS_GLYPH: Record<FileStatus, string> = {
  M: 'M',
  A: 'A',
  D: 'D',
  R: 'R',
  '?': '~',
  '!': '~',
};

/**
 * Pure renderer: facts → the operator-facing view. Exported so the tests pin
 * the wording without running git.
 */
export function renderDiffView(facts: DiffFacts, maxFiles = DEFAULT_MAX_FILES): string {
  const lines: string[] = [];
  const where = facts.worktree
    ? `${facts.branch ?? '(detached)'} in worktree ${facts.worktree}`
    : facts.branch ?? '(detached)';
  lines.push(chalk.bold(`Local changes — ${where}`));
  if (facts.gitError) {
    lines.push(chalk.red(`  git: ${facts.gitError}`));
    return lines.join('\n');
  }

  // --- uncommitted ---
  if (!facts.numstatOk || !facts.statusOk) {
    // A git read failed or timed out: the empty lists are UNKNOWN, not clean.
    // An absence of data must never be rendered as a positive claim.
    lines.push(
      chalk.yellow('  working tree: UNKNOWN — a git read failed or timed out; run `git status` before trusting this view')
    );
  } else if (facts.uncommitted.length === 0 && facts.untracked.length === 0) {
    lines.push(chalk.green('  working tree: clean (nothing uncommitted)'));
  } else {
    lines.push('  uncommitted:');
    const sorted = [...facts.uncommitted].sort((a, b) => (b.added ?? 0) - (a.added ?? 0));
    for (const f of sorted.slice(0, maxFiles)) {
      const glyph = STATUS_GLYPH[f.status];
      const tag = f.status === 'D' ? chalk.red(glyph) : f.status === 'A' ? chalk.cyan(glyph) : chalk.yellow(glyph);
      // Column integrity (P5 polish): a path LONGER than the column used to
      // push the +N/-N columns right per row. Cap to the column width (keep
      // the TAIL — the informative half of a path) then pad, so every row
      // lines up exactly.
      const shown = f.path.length > 64 ? `…${f.path.slice(-63)}` : f.path.padEnd(64);
      lines.push(
        `    ${tag} ${shown} ${chalk.green(`+${fmtDelta(f.added)}`)} ${chalk.red(`-${fmtDelta(f.removed)}`)}`
      );
    }
    if (sorted.length > maxFiles) {
      lines.push(chalk.dim(`    … and ${sorted.length - maxFiles} more modified file(s)`));
    }
    for (const u of facts.untracked.slice(0, maxFiles)) {
      lines.push(`    ${chalk.cyan('?')} ${u}`);
    }
    if (facts.untracked.length > maxFiles) {
      lines.push(chalk.dim(`    … and ${facts.untracked.length - maxFiles} more untracked path(s)`));
    }
    const t = totalDeltas(facts.uncommitted);
    lines.push(
      chalk.dim(
        `    tracked totals: +${t.added} -${t.removed} across ${facts.uncommitted.length} tracked, ${facts.untracked.length} untracked`
      )
    );
  }

  // --- unpushed ---
  if (facts.ahead === null && facts.behind === null) {
    lines.push(chalk.dim(`  unpushed: unknown (no merge-base with ${facts.base}?)`));
  } else if ((facts.ahead ?? 0) === 0) {
    lines.push(chalk.green(`  unpushed: none (in sync with ${facts.base})`));
  } else {
    const ab = facts.behind && facts.behind > 0 ? `, ${facts.behind} behind` : '';
    lines.push(`  unpushed: ${chalk.bold(String(facts.ahead))} commit(s) vs ${facts.base}${ab}:`);
    for (const c of facts.unpushedCommits.slice(0, maxFiles)) lines.push(chalk.dim(`    ${termSafe(c)}`));
    if (facts.unpushedCommits.length > maxFiles) {
      lines.push(chalk.dim(`    … and ${facts.unpushedCommits.length - maxFiles} more commit(s)`));
    }
    const t = totalDeltas(facts.unpushedFiles);
    lines.push(
      chalk.dim(`    diff vs ${facts.base}: +${t.added} -${t.removed} across ${facts.unpushedFiles.length} file(s)`)
    );
  }

  lines.push('');
  lines.push(chalk.dim('  inspect: git diff -- <file> · git log -p <commit> · git status'));
  return lines.join('\n');
}

/** Parse a positive-integer CLI flag. Returns undefined when the flag is
 * absent (caller applies its default) and null when it is garbage — a LOUD
 * refusal, never NaN math: a truncated view wearing the full totals is a
 * lie. */
export function parsePositiveInt(raw: string | undefined): number | undefined | null {
  if (raw === undefined) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

export async function diffCommand(options: DiffOptions = {}): Promise<void> {
  const cwd = options.cwd || process.cwd();
  if (options.base?.startsWith('-')) {
    // Git parses argv: a ref starting with '-' would be consumed as a git
    // OPTION (e.g. --output=<file>), not a rev. Refnames cannot legitimately
    // start with '-', so refuse loudly instead of letting git act on it.
    console.error(chalk.red(`--base must be a ref, not an option (got '${options.base}')`));
    process.exitCode = 1;
    return;
  }
  const maxRaw = parsePositiveInt(options.max);
  if (options.max !== undefined && maxRaw === null) {
    console.error(chalk.red(`--max must be a positive integer (got '${options.max}')`));
    process.exitCode = 1;
    return;
  }
  const maxFiles = maxRaw ?? DEFAULT_MAX_FILES;
  const facts = gatherDiffFacts(cwd, options);
  if (options.json) {
    console.log(JSON.stringify(facts, null, 2));
    return;
  }
  console.log(renderDiffView(facts, maxFiles));
}

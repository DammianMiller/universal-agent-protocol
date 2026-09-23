/**
 * Before/after visual captures bound to a review (uplift 0.3).
 *
 * A diff that touches UI files is not reviewable from code alone — the change
 * is to what the user SEES. This module records capture pairs (produced by
 * the agent via agent-browser for web surfaces, tuistory/pty-capture for
 * terminal surfaces) into a sibling artifact and validates that a UI diff is
 * covered by fresh, complete pairs before the ship gate opens.
 *
 * Artifact: .uap/reviews/<branch-slug>.captures.json — a SIBLING of the
 * review artifact, for the same reason the pre-pass is one (see
 * src/review/prepass.ts): the expert-review enforcer treats the existence of
 * <slug>.json as "a review happened", so nothing advisory may create it.
 * Consolidation embeds the capture paths into the real review artifact.
 *
 * The gate is deterministic pairing/freshness, not judgment: the model (or
 * human) looks at the captures; the policy only proves they exist, form
 * before/after pairs, and postdate the newest UI change on disk.
 */
import { execFileSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'fs';
import { join, relative, resolve } from 'path';
import { branchSlug } from './prepass.js';

/** UI surface definition — mirrored (with matching case handling) by
 * UI_EXT/UI_DIR_PREFIXES in src/policies/enforcers/expert_review_required.py
 * and visual_verification.py. Keep all three in sync; the parity test in
 * test/visual-captures.test.ts pins the intended surface. */
export const UI_EXT = new Set([
  '.css', '.scss', '.sass', '.less',
  '.tsx', '.jsx', '.vue', '.svelte', '.html', '.astro',
]);
export const UI_DIR_PREFIXES = ['web/', 'src/dashboard/', 'public/'];

export interface CaptureEntry {
  /** Capture tool: agent-browser | tuistory | pty-capture | playwright | ... */
  tool: string;
  /** Pre-change capture path (stored project-relative). */
  before: string;
  /** Post-change capture path (stored project-relative). */
  after: string;
  note?: string;
  /** ISO timestamp when the pair was registered. */
  at: string;
}

export interface CapturesArtifact {
  branch: string;
  head: string | null;
  ui_files: string[];
  captures: CaptureEntry[];
  at: string;
}

export interface CapturesValidation {
  /** True when the diff vs base touches UI files and captures are mandatory. */
  required: boolean;
  ok: boolean;
  reasons: string[];
  uiFiles: string[];
  artifactPath: string;
  captures: CaptureEntry[];
}

function git(projectDir: string, args: string[]): string | null {
  try {
    const out = execFileSync('git', args, {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.trim();
  } catch {
    return null; // fail-soft: non-git/detached/no-base states disable the gate
  }
}

export function isUiFile(file: string): boolean {
  const lower = file.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot >= 0 && UI_EXT.has(lower.slice(dot))) return true;
  return UI_DIR_PREFIXES.some((p) => lower.startsWith(p));
}

/** Files changed vs the upstream base (origin/master, origin/main, master,
 * main — first that resolves), or null when no base exists (fail-open). */
export function changedFilesVsBase(projectDir: string): string[] | null {
  for (const base of ['origin/master', 'origin/main', 'master', 'main']) {
    const out = git(projectDir, ['diff', '--name-only', `${base}...HEAD`]);
    if (out !== null) return out.split('\n').map((l) => l.trim()).filter(Boolean);
  }
  return null;
}

export function capturesArtifactPath(projectDir: string, branch: string): string {
  return join(projectDir, '.uap', 'reviews', `${branchSlug(branch)}.captures.json`);
}

function readArtifact(path: string): CapturesArtifact | null {
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    if (typeof data !== 'object' || data === null) return null;
    // Normalize: a hand-edited artifact with a non-array `captures` must not
    // crash validation or corrupt the file on the next `add` (spreading a
    // string yields its chars). Unknown entries are dropped, not trusted.
    const raw: unknown = (data as { captures?: unknown }).captures;
    return {
      ...(data as CapturesArtifact),
      captures: Array.isArray(raw)
        ? raw.filter((c): c is CaptureEntry => typeof c === 'object' && c !== null)
        : [],
    };
  } catch {
    return null; // missing or malformed — treated as absent by callers
  }
}

/** Project-relative normalization: absolute paths under the project are
 * relativized; anything escaping the project is refused by the caller-visible
 * existence check below (we never write paths we cannot verify). */
function toProjectRelative(projectDir: string, p: string): string {
  const abs = resolve(projectDir, p);
  return relative(projectDir, abs);
}

/**
 * Register one before/after capture pair for the current branch.
 * Returns the artifact path, or an error string when the pair is unusable.
 */
export function recordCapture(
  projectDir: string,
  entry: { tool: string; before: string; after: string; note?: string },
): { path: string; artifact: CapturesArtifact } | { error: string } {
  const tool = entry.tool.trim();
  if (!tool) return { error: 'capture tool is required (agent-browser, tuistory, pty-capture, ...)' };
  const before = toProjectRelative(projectDir, entry.before);
  const after = toProjectRelative(projectDir, entry.after);
  for (const [label, rel] of [['before', before], ['after', after]] as const) {
    // `..` alone or as a leading segment escapes the project; a leading `..`
    // inside a filename (`..assets/x.png`) is legitimate and stays allowed.
    if (rel === '..' || rel.startsWith('../')) {
      return { error: `${label} capture escapes the project: ${label === 'before' ? entry.before : entry.after}` };
    }
    if (!existsSync(join(projectDir, rel))) {
      return { error: `${label} capture not found: ${rel}` };
    }
  }

  const branch = git(projectDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch || branch === 'HEAD') return { error: 'not on a branch (detached/non-git)' };
  const head = git(projectDir, ['rev-parse', 'HEAD']);
  const changed = changedFilesVsBase(projectDir) ?? [];
  const uiFiles = changed.filter(isUiFile);

  const path = capturesArtifactPath(projectDir, branch);
  const existing = readArtifact(path);
  const now = new Date().toISOString();
  const artifact: CapturesArtifact = {
    branch,
    head,
    ui_files: uiFiles,
    captures: [
      ...(existing?.captures ?? []),
      { tool, before, after, ...(entry.note ? { note: entry.note } : {}), at: now },
    ],
    at: now,
  };
  mkdirSync(join(projectDir, '.uap', 'reviews'), { recursive: true });
  // Atomic write: a crash mid-write must not leave a torn artifact that a
  // later validation half-reads.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(artifact, null, 2));
  renameSync(tmp, path);
  return { path, artifact };
}

const STALENESS_GRACE_S = 1; // same 1s grace the commit-time visual enforcer uses

/**
 * Validate that a UI diff is covered by complete, fresh capture pairs.
 * Fail-open only when no base is resolvable (non-git/detached), matching the
 * expert-review enforcer's posture.
 */
export function validateCaptures(projectDir: string): CapturesValidation {
  const branch = git(projectDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const artifactPath = capturesArtifactPath(projectDir, branch ?? 'HEAD');
  const base: CapturesValidation = {
    required: false,
    ok: true,
    reasons: [],
    uiFiles: [],
    artifactPath,
    captures: [],
  };
  // Detached HEAD: the enforcer fails open there (no branch → no slug), and
  // the advisory CLI must not claim otherwise.
  if (!branch || branch === 'HEAD') {
    base.reasons.push('detached HEAD — gate inactive (fail-open)');
    return base;
  }

  const changed = changedFilesVsBase(projectDir);
  if (changed === null) {
    base.reasons.push('no upstream base resolvable — gate inactive (fail-open)');
    return base;
  }
  const uiFiles = changed.filter(isUiFile);
  if (uiFiles.length === 0) {
    base.reasons.push('no UI files in the diff');
    return base;
  }
  base.required = true;
  base.uiFiles = uiFiles;

  const artifact = readArtifact(artifactPath);
  if (!artifact) {
    base.ok = false;
    base.reasons.push(
      `no captures artifact at ${relative(projectDir, artifactPath)} — capture before/after ` +
        'evidence (agent-browser / tuistory / pty-capture) and register each pair with ' +
        '`uap review captures add --before <img> --after <img> --tool <name>`',
    );
    return base;
  }
  base.captures = artifact.captures ?? [];

  const pairs = base.captures.filter((c) => c.before && c.after);
  if (pairs.length === 0) {
    base.ok = false;
    base.reasons.push('captures artifact has no complete before/after pair');
    return base;
  }
  const missing = pairs.flatMap((c) =>
    [c.before, c.after].filter((p) => !existsSync(join(projectDir, p))),
  );
  if (missing.length > 0) {
    base.ok = false;
    base.reasons.push(`capture file(s) missing on disk: ${missing.join(', ')}`);
    return base;
  }

  // Freshness: captures recorded before the newest UI edit prove nothing
  // about the CURRENT look. Fail CLOSED when `at` is missing/unparseable —
  // the ship enforcer coerces the same failure to epoch 0 (everything stale),
  // so the advisory CLI must not say OK where the gate will refuse.
  const capturedAt = Date.parse(artifact.at) / 1000;
  if (!Number.isFinite(capturedAt)) {
    base.ok = false;
    base.reasons.push('captures artifact has no parseable `at` timestamp — re-register a pair');
    return base;
  }
  const stale = uiFiles.filter((f) => {
    try {
      return statSync(join(projectDir, f)).mtimeMs / 1000 > capturedAt + STALENESS_GRACE_S;
    } catch {
      return false; // deleted files cannot be stale
    }
  });
  if (stale.length > 0) {
    base.ok = false;
    base.reasons.push(
      `UI file(s) changed after the captures were taken: ${stale.join(', ')} — re-capture`,
    );
    return base;
  }

  base.reasons.push(`${pairs.length} before/after pair(s) cover ${uiFiles.length} UI file(s)`);
  return base;
}

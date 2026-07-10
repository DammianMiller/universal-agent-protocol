/**
 * File-block Applier
 *
 * Materializes model output into the project tree. Models emit complete
 * files as fenced blocks:
 *
 *   ```file:relative/path/from/root.ts
 *   <entire file content>
 *   ```
 *
 * Whole-file emission is deliberate: small models are far more reliable
 * emitting complete files than unified diffs. Fences of 3+ backticks are
 * supported so file contents containing ``` can be wrapped in ````.
 *
 * Small/local models (e.g. qwen) frequently ignore the `file:` contract and
 * emit language-tagged or bare fences with the path stated as a header, an
 * info-string label, or a leading comment. When the strict parse finds nothing
 * the decoder falls back to a lenient recovery pass (parseFileBlocksLenient)
 * that handles those conventions. The fallback only runs on an otherwise-empty
 * parse, so compliant output is never reinterpreted, and every recovered path
 * still passes validatePath — the lenient layer widens decode coverage, not the
 * security boundary.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';

export interface FileBlock {
  path: string;
  content: string;
}

export interface ApplyResult {
  /** Relative paths written to disk */
  filesWritten: string[];
  /** Blocks rejected with the reason (unsafe path, etc.) */
  rejected: Array<{ path: string; reason: string }>;
  /** Set when no file blocks were found at all */
  error?: string;
}

export interface ApplyOptions {
  /**
   * Pre-existing test/spec files (relative, '/'-separated, lower-cased
   * paths) the model must not modify. Gate integrity: a model that rewrites
   * the task's spec to make gates pass has converged on the wrong target.
   * New test files are still allowed — only paths in this set are blocked.
   * Custom Applier implementations MUST honor this set themselves; the
   * loop's prompt tells the model these files are read-only.
   */
  protectedFiles?: ReadonlySet<string>;
  /**
   * Reject writes to test-runner/compiler config files (vitest/jest/mocha
   * configs, tsconfig, pytest.ini…). Without this, protecting the spec is
   * moot — the model can repoint test discovery or relax the compiler
   * instead of modifying the tests the gates run.
   */
  protectGateConfigs?: boolean;
}

export type Applier = (
  output: string,
  projectRoot: string,
  options?: ApplyOptions
) => ApplyResult | Promise<ApplyResult>;

export interface RevertibleApply {
  result: ApplyResult;
  /** Restore every written file to its pre-apply state (idempotent). */
  restore: () => void;
}

/** Max bytes a single emitted file may have (guards runaway generations). */
const MAX_FILE_BYTES = 1_000_000;

const FILE_BLOCK_RE = /^(`{3,})file:([^\n]+)\n([\s\S]*?)^\1\s*$/gm;

/**
 * Paths the model is never allowed to write. The harness executes project
 * scripts during gate verification, so a model-supplied build/test/lint
 * command in package.json, a git/husky hook, or a CI workflow would be
 * arbitrary code execution against the host. These are blocked outright;
 * delivering a change that legitimately needs them is out of scope for an
 * autonomous loop and must go through a human.
 */
const PROTECTED_SEGMENTS = new Set([
  '.git',
  // Harness-owned state (run checkpoints, traces, practices): a model that can
  // seed .uap/deliver-runs/* could plant a resumable mission / traversal runId.
  '.uap',
  // The self-authored acceptance gate lives here (self-gate.ts writes
  // .uap-deliver/verify.sh, the sole required gate for no-native-gate
  // projects). Protecting it stops the model rewriting its own gate to `exit
  // 0` to pass vacuously — the one gate config the applier left unguarded
  // (security audit X1). NOTE: run_bash bypasses the applier, so the integrity
  // guard also snapshots this script (see convergence-loop integrity capture).
  '.uap-deliver',
  '.husky',
  '.github',
  '.gitlab',
  '.circleci',
  'node_modules',
]);
const PROTECTED_BASENAMES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
]);

/**
 * Config files that control what the gates run or how strictly they check.
 * Writing these is gate-rigging by indirection: repointing vitest/jest
 * include globs or relaxing tsconfig defeats spec protection without
 * touching a single test file. The deploy/IaC entries extend the same logic
 * to the deploy-dev and CI tiers: editing what "deploy" means (compose,
 * Dockerfile, terraform, serverless) rigs the deploy gate the same way.
 */
const GATE_CONFIG_RES = [
  /^tsconfig[^/]*\.json$/,
  /^vitest\.(config|workspace)\.[^/]+$/,
  /^jest\.config\.[^/]+$/,
  /^\.mocharc(\.[^/]+)?$/,
  /^karma\.conf\.[^/]+$/,
  /^playwright\.config\.[^/]+$/,
  /^cypress\.config\.[^/]+$/,
  /^ava\.config\.[^/]+$/,
  /^babel\.config\.[^/]+$/,
  /^\.babelrc(\.[^/]+)?$/,
  /^pytest\.ini$/,
  /^setup\.cfg$/,
  /^pyproject\.toml$/,
  /^tox\.ini$/,
  // Lint gate configs: observed live 2026-07-10 — an executor gutted
  // eslint.config.js (139/157 lines) to dodge a red lint rung.
  /^eslint\.config\.[^/]+$/,
  /^\.eslintrc(\.[^/]+)?$/,
  // Deploy / IaC gate inputs (deploy-dev + CI tiers).
  /^docker-compose(\.[^/]+)?\.ya?ml$/,
  /^compose(\.[^/]+)?\.ya?ml$/,
  /^dockerfile$/,
  /^dockerfile\.[^/]+$/,
  /^.+\.tf$/,
  /^.+\.tfvars$/,
  /^pulumi\.ya?ml$/,
  /^serverless\.ya?ml$/,
];

/** True when a basename is a test-runner/compiler config (gate input). */
export function isGateConfigBasename(base: string): boolean {
  const lower = base.toLowerCase();
  return GATE_CONFIG_RES.some((re) => re.test(lower));
}

/** True when a basename is package.json / a lockfile / an npm rc (gate input). */
export function isProtectedBasename(base: string): boolean {
  return PROTECTED_BASENAMES.has(base.toLowerCase());
}

/**
 * List EXISTING gate-config + package/lockfile paths under `projectRoot`
 * (project-relative, POSIX), for the runtime integrity snapshot. The applier
 * blocks the model WRITING these, but `run_bash` bypasses the applier — so the
 * convergence loop snapshots the existing ones and restores any a gate run
 * mutates, discarding that turn (security audit X5: e.g.
 * `run_bash("npm pkg set scripts.test='exit 0'")` rigging the gate).
 *
 * Bounded shallow walk (depth ≤ maxDepth, skips SKIP dirs) — these files live at
 * or near the root; a full-tree scan isn't worth the cost. Fail-soft: an
 * unreadable dir contributes nothing.
 */
export function listGateConfigFiles(projectRoot: string, maxDepth = 2): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: import('fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (WALK_SKIP_SEGMENTS.has(e.name) || e.name.startsWith('.')) continue;
        walk(join(dir, e.name), depth + 1);
      } else if (e.isFile() && (isGateConfigBasename(e.name) || isProtectedBasename(e.name))) {
        out.push(relative(projectRoot, join(dir, e.name)).split(sep).join('/'));
      }
    }
  };
  walk(projectRoot, 0);
  return out;
}

/**
 * Reason a relative path must not be written by an autonomous executor, or null
 * when the write is allowed. Single source of truth for the segment / basename /
 * gate-config blocklist so the agentic executor (which bypasses the file-block
 * applier) enforces the SAME protections. `protectGateConfigs` mirrors the
 * applier option — when on, compose/IaC/runner-config writes are gate-rigging.
 */
export function protectedWritePathReason(
  relPath: string,
  protectGateConfigs = true
): string | null {
  const segments = relPath.split(/[\\/]/);
  for (const seg of segments) {
    if (PROTECTED_SEGMENTS.has(seg.toLowerCase())) {
      return `writes into ${seg} are not allowed`;
    }
  }
  const base = segments[segments.length - 1].toLowerCase();
  if (PROTECTED_BASENAMES.has(base)) {
    return `writes to ${base} are not allowed (would alter executed scripts)`;
  }
  if (protectGateConfigs && isGateConfigBasename(base)) {
    return `writes to ${base} are not allowed (gate-config / IaC — rigging the gate by indirection)`;
  }
  // A REPO-ROOT conftest.py is collection policy, not a fixture: one
  // `collect_ignore_glob` line silently blinds every pytest gate (observed
  // live 2026-07-10 — an executor wrote `collect_ignore_glob = ["sidecars/*"]`
  // to dodge failing sidecar suites). Nested conftest.py files (tests/**)
  // remain writable — those are legitimate fixture modules.
  if (protectGateConfigs && segments.length === 1 && base === 'conftest.py') {
    return 'writes to the repo-root conftest.py are not allowed (it controls pytest collection — gate-rigging by indirection); put fixtures in a nested tests/conftest.py';
  }
  return null;
}

/** Directory names test discovery treats as test containers. */
const TEST_DIR_SEGMENTS = new Set(['test', 'tests', '__tests__', 'spec', 'specs']);

/** Directories the protected-test walk never descends into. */
const WALK_SKIP_SEGMENTS = new Set([
  ...PROTECTED_SEGMENTS,
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  '.worktrees',
  '.uap',
  'agents',
]);

// Discovery horizon must be at least as deep as the test runners' (vitest /
// node --test recurse without limit); the visited-entries budget bounds cost.
const WALK_MAX_DEPTH = 16;
const WALK_MAX_FILES = 5_000;
const WALK_MAX_ENTRIES = 50_000;

/**
 * True when a relative '/'-separated path looks like a test/spec file:
 * lives under a test directory, or has a test-style basename
 * (*.test.*, *.spec.*, *_test.*, test_*.py).
 */
export function isTestFilePath(relPath: string): boolean {
  const segments = relPath.split('/');
  const base = segments[segments.length - 1].toLowerCase();
  if (segments.slice(0, -1).some((s) => TEST_DIR_SEGMENTS.has(s.toLowerCase()))) {
    return true;
  }
  return (
    /\.(test|spec)[-.][^/]+$/.test(base) || /_test\.[^.]+$/.test(base) || /^test_.+\.py$/.test(base)
  );
}

/**
 * Snapshot the project's pre-existing test/spec files as relative
 * '/'-separated paths. Called once at loop start so files the model creates
 * later are not retroactively protected. Bounded walk; failures return what
 * was found so far — protection degrades, delivery never blocks.
 */
export function findProtectedTestFiles(projectRoot: string): Set<string> {
  // Keys are lower-cased so the membership check cannot be bypassed by case
  // tricks on case-insensitive filesystems (APFS, NTFS).
  return new Set(listTestFiles(projectRoot).map((f) => f.toLowerCase()));
}

/**
 * The same bounded walk as findProtectedTestFiles but returning the
 * original-case relative paths — needed by callers that must read the files
 * (e.g. spec transitive-import analysis).
 */
export function listTestFiles(projectRoot: string): string[] {
  const found = new Set<string>();
  const root = resolve(projectRoot);
  let visited = 0;

  const walk = (dir: string, relPrefix: string, depth: number): void => {
    if (depth > WALK_MAX_DEPTH || found.size >= WALK_MAX_FILES) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.size >= WALK_MAX_FILES || ++visited > WALK_MAX_ENTRIES) return;
      if (entry.startsWith('.')) {
        // Hidden dirs/files: default runner globs don't match them, and the
        // dotfile configs a model could abuse are blocked by the gate-config
        // check instead.
        continue;
      }
      const abs = join(dir, entry);
      const rel = relPrefix ? `${relPrefix}/${entry}` : entry;
      let stat;
      try {
        stat = lstatSync(abs);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        // 'agents' is a UAP-coordination dir; generic projects keeping tests
        // there lose protection — accepted to avoid walking huge agent state.
        if (WALK_SKIP_SEGMENTS.has(entry.toLowerCase())) continue;
        walk(abs, rel, depth + 1);
      } else if (stat.isFile() && isTestFilePath(rel)) {
        found.add(rel);
      }
    }
  };

  walk(root, '', 0);
  return [...found];
}

/** Extract strict `file:`-fenced blocks (the contract format). */
function parseStrictFileBlocks(output: string): FileBlock[] {
  const blocks: FileBlock[] = [];
  for (const match of output.matchAll(FILE_BLOCK_RE)) {
    const path = match[2].trim();
    if (!path) continue;
    blocks.push({ path, content: match[3] });
  }
  return blocks;
}

/** Any fenced code block: fence, info string, body, and char offset. `\r?`
 *  on the close line keeps recovery working on CRLF (Windows-origin) output. */
const ANY_FENCE_RE = /^([ \t]*)(`{3,})([^\n]*)\n([\s\S]*?)^\1\2[ \t]*\r?$/gm;

/**
 * Fence languages that denote shell commands or tool output, not a source
 * file. For these we require an EXPLICIT path (a `file:` label on the fence or
 * a path comment in the body) before recovering — a bare ```bash block sitting
 * under a sentence that happens to mention a filename must NOT be written to
 * that file. The strict `file:` contract is unaffected; this only constrains
 * the lenient preamble heuristic.
 */
const NON_FILE_LANGS = new Set([
  'bash',
  'sh',
  'shell',
  'zsh',
  'console',
  'terminal',
  'text',
  'txt',
  'output',
  'plaintext',
  'log',
  'diff',
]);

/**
 * A label that, on a fence info string or a line just above a fence, names the
 * file the block belongs to: `file:`, `file=`, `filepath:`, `path:`, `filename:`.
 */
const PATH_LABEL_RE =
  /(?:^|[^A-Za-z0-9])(?:file|filepath|filename|path)\s*[:=]\s*[`'"]?([^\s`'"*<>]+)/i;

/** Strip surrounding markdown/comment decoration from a candidate path token. */
function cleanPathToken(raw: string): string {
  return raw
    .trim()
    .replace(/^[#>\-*\s]+/, '') // markdown heading / list / bold-dash prefixes
    .replace(/^(?:\/\/|#|<!--|\/\*)\s*/, '') // leading comment openers
    .replace(/\s*(?:-->|\*\/)\s*$/, '') // trailing comment closers
    .replace(/[`'"*]+/g, '') // stray backticks / quotes / bold markers
    .replace(/[:：]\s*$/, '') // a trailing label colon ("path:")
    .replace(/^\.\//, '') // normalize leading ./
    .trim();
}

/**
 * True when `p` plausibly names a relative source file rather than prose. Used
 * only by the lenient fallback to keep narration / language tags / pathless
 * fences from being written to disk. validatePath remains the security gate;
 * this is a false-positive filter, not a trust boundary.
 */
export function looksLikeFilePath(p: string): boolean {
  const t = p.trim();
  if (!t || t.length > 200) return false;
  if (/\s/.test(t)) return false; // real paths emitted here have no spaces
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false; // URLs (http://, file://)
  if (!/^[A-Za-z0-9._/@+-]+$/.test(t)) return false; // conservative path charset
  // Must look like a file: contain a directory separator OR a real extension.
  const base = t.slice(t.lastIndexOf('/') + 1);
  const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(base) && !/^\.+$/.test(base);
  return t.includes('/') || hasExt;
}

/** Extract the first plausible file path from a fence info string, or null. */
function pathFromInfoString(info: string): string | null {
  const labelled = info.match(PATH_LABEL_RE);
  if (labelled) {
    const p = cleanPathToken(labelled[1]);
    if (looksLikeFilePath(p)) return p;
  }
  // Bare info string that is itself a path (e.g. ```src/game.js). Language tags
  // like `js`/`typescript` fail looksLikeFilePath (no slash/extension).
  for (const tok of info.trim().split(/\s+/)) {
    const p = cleanPathToken(tok);
    if (looksLikeFilePath(p)) return p;
  }
  return null;
}

/** First plausible path among the up-to-2 non-empty lines preceding a fence. */
function pathFromPreamble(before: string): string | null {
  const lines = before.split('\n');
  let seen = 0;
  for (let i = lines.length - 1; i >= 0 && seen < 2; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    seen++;
    const labelled = line.match(PATH_LABEL_RE);
    if (labelled) {
      const p = cleanPathToken(labelled[1]);
      if (looksLikeFilePath(p)) return p;
    }
    const cleaned = cleanPathToken(line);
    if (looksLikeFilePath(cleaned)) return cleaned;
  }
  return null;
}

/** A path-only comment as the body's first line: returns [path, restOfBody]. */
function pathFromBodyComment(body: string): [string, string] | null {
  const nl = body.indexOf('\n');
  const first = (nl === -1 ? body : body.slice(0, nl)).trim();
  if (!/^(?:\/\/|#|<!--|\/\*)/.test(first)) return null;
  const labelled = first.match(PATH_LABEL_RE);
  const candidate = cleanPathToken(labelled ? labelled[1] : first);
  if (!looksLikeFilePath(candidate)) return null;
  return [candidate, nl === -1 ? '' : body.slice(nl + 1)];
}

/**
 * Lenient recovery for models that ignore the strict `file:` contract (common
 * with small/local models like qwen, which emit language-tagged or bare fences
 * with the path stated as a header, label, or leading comment). Runs ONLY when
 * the strict parse finds nothing. Every recovered path is still subject to
 * validatePath; looksLikeFilePath keeps prose and pathless fences out.
 */
export function parseFileBlocksLenient(output: string): FileBlock[] {
  const blocks: FileBlock[] = [];
  for (const m of output.matchAll(ANY_FENCE_RE)) {
    const info = m[3] ?? '';
    let body = m[4] ?? '';
    const lang = info.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    const isShellOrOutput = NON_FILE_LANGS.has(lang);

    // 1) explicit label/path on the fence info string
    let path = pathFromInfoString(info);

    // 2) a header/label line immediately above the fence — skipped for
    //    shell/output fences, where a nearby filename mention is not a target.
    if (!path && !isShellOrOutput) {
      path = pathFromPreamble(output.slice(0, m.index ?? 0));
    }

    // 3) a path-only comment as the first line inside the block
    if (!path) {
      const fromBody = pathFromBodyComment(body);
      if (fromBody) {
        path = fromBody[0];
        body = fromBody[1];
      }
    }

    if (path) blocks.push({ path, content: body });
  }
  return blocks;
}

/**
 * Extract file blocks from model output without writing anything. Prefers the
 * strict `file:` contract; falls back to lenient recovery only when the strict
 * parse is empty, so compliant output is never reinterpreted.
 */
export function parseFileBlocks(output: string): FileBlock[] {
  const strict = parseStrictFileBlocks(output);
  if (strict.length > 0) return strict;
  return parseFileBlocksLenient(output);
}

/**
 * Resolve `target`'s parent to its real (symlink-followed) location and
 * confirm it stays inside the project root. Lexical checks alone let a
 * pre-existing symlink inside the repo redirect a write outside it.
 */
function realParentEscapes(target: string, realRoot: string): boolean {
  let dir = dirname(target);
  // Walk up to the nearest existing ancestor (target/intermediate dirs may
  // not exist yet) and realpath that.
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  let realDir: string;
  try {
    realDir = realpathSync(dir);
  } catch {
    return true;
  }
  const rel = relative(realRoot, realDir);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

const PROTECTED_TEST_REASON =
  'pre-existing test/oracle file is protected — implement the source so the existing tests pass instead of modifying them';
const GATE_CONFIG_REASON =
  'test-runner/compiler config files are protected — they control the gates and cannot be changed by the model';

/**
 * Is `rel` (sep-separated, relative to root) a protected test file? Checks
 * the lexical path case-folded, and — when the target already exists — its
 * realpath, so an intra-repo directory symlink (tests_alias -> test) cannot
 * alias a protected file under an unprotected name.
 */
function isProtectedTestTarget(
  rel: string,
  target: string,
  realRoot: string,
  protectedFiles: ReadonlySet<string>
): boolean {
  if (protectedFiles.has(rel.split(sep).join('/').toLowerCase())) return true;
  if (existsSync(target)) {
    try {
      const realRel = relative(realRoot, realpathSync(target));
      if (protectedFiles.has(realRel.split(sep).join('/').toLowerCase())) return true;
    } catch {
      // unreadable target — fall through to other validators
    }
  }
  return false;
}

function validatePath(
  blockPath: string,
  projectRoot: string,
  realRoot: string,
  options?: ApplyOptions
): string | null {
  if (isAbsolute(blockPath)) return 'absolute paths are not allowed';

  // A leading '-' would be parsed as an option by git/CLI tools that later
  // receive these paths as arguments (e.g. the deploy batcher's `git add`).
  if (blockPath.startsWith('-')) return 'paths starting with "-" are not allowed';

  const target = resolve(projectRoot, blockPath);
  const rel = relative(resolve(projectRoot), target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return 'path escapes the project root';
  }

  // Block protected segments anywhere in the path (case-insensitive), and
  // protected basenames. Closes config/hook/CI-driven code execution.
  const segments = rel.split(sep);
  for (const seg of segments) {
    if (PROTECTED_SEGMENTS.has(seg.toLowerCase())) {
      return `writes into ${seg} are not allowed`;
    }
  }
  const base = segments[segments.length - 1].toLowerCase();
  if (PROTECTED_BASENAMES.has(base)) {
    return `writes to ${base} are not allowed (would alter executed scripts)`;
  }

  // Gate integrity: block runner/compiler config writes (gate rigging by
  // indirection) and modification of pre-existing test/spec files.
  if (options?.protectGateConfigs && isGateConfigBasename(base)) {
    return GATE_CONFIG_REASON;
  }
  if (
    options?.protectedFiles &&
    isProtectedTestTarget(rel, target, realRoot, options.protectedFiles)
  ) {
    return PROTECTED_TEST_REASON;
  }

  // Reject writing through an existing symlink, and any symlinked ancestor.
  try {
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
      return 'target is a symlink';
    }
  } catch {
    return 'could not stat target';
  }
  if (realParentEscapes(target, realRoot)) {
    return 'path resolves outside the project root via a symlink';
  }

  return null;
}

function realRootOf(projectRoot: string): string {
  try {
    return realpathSync(resolve(projectRoot));
  } catch {
    return resolve(projectRoot);
  }
}

/**
 * Default applier: parse file blocks and write them under projectRoot.
 * Paths are validated against traversal and .git writes; oversized files
 * are rejected rather than truncated.
 */
export function applyFileBlocks(
  output: string,
  projectRoot: string,
  options?: ApplyOptions
): ApplyResult {
  const blocks = parseFileBlocks(output);
  if (blocks.length === 0) {
    return {
      filesWritten: [],
      rejected: [],
      error:
        'No file blocks found in the output. Emit every created/modified file as a fenced block: ```file:relative/path … ```',
    };
  }

  const realRoot = realRootOf(projectRoot);
  const filesWritten: string[] = [];
  const rejected: ApplyResult['rejected'] = [];

  for (const block of blocks) {
    const invalid = validatePath(block.path, projectRoot, realRoot, options);
    if (invalid) {
      rejected.push({ path: block.path, reason: invalid });
      continue;
    }
    if (Buffer.byteLength(block.content, 'utf-8') > MAX_FILE_BYTES) {
      rejected.push({ path: block.path, reason: `file exceeds ${MAX_FILE_BYTES} bytes` });
      continue;
    }

    const target = join(projectRoot, block.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, block.content, 'utf-8');
    filesWritten.push(block.path);
  }

  return { filesWritten, rejected };
}

/** Topmost directory segments that did not exist before applying `paths`. */
function newDirsFor(paths: string[], projectRoot: string): string[] {
  const created = new Set<string>();
  for (const path of paths) {
    const segments = path.split(sep);
    let current = projectRoot;
    for (let i = 0; i < segments.length - 1; i++) {
      current = join(current, segments[i]);
      if (!existsSync(current)) created.add(current);
    }
  }
  // Deepest first so rmdir succeeds bottom-up
  return [...created].sort((a, b) => b.length - a.length);
}

/**
 * Apply file blocks with a snapshot of the prior state of every target, so
 * the application can be undone. Used by the explorer to evaluate competing
 * candidates against the same baseline tree without git machinery.
 */
export function applyFileBlocksWithRollback(
  output: string,
  projectRoot: string,
  options?: ApplyOptions
): RevertibleApply {
  const blocks = parseFileBlocks(output);
  const realRoot = realRootOf(projectRoot);

  // Snapshot prior content (or absence) of every valid target, and the set
  // of directories that do not yet exist, BEFORE writing anything.
  const snapshots = new Map<string, string | null>();
  const validPaths: string[] = [];
  for (const block of blocks) {
    if (validatePath(block.path, projectRoot, realRoot, options)) continue;
    const target = join(projectRoot, block.path);
    if (!snapshots.has(block.path)) {
      snapshots.set(block.path, existsSync(target) ? readFileSync(target, 'utf-8') : null);
      validPaths.push(block.path);
    }
  }
  const newDirs = newDirsFor(validPaths, projectRoot);

  // Track what actually hit disk so an exception mid-apply still rolls back.
  const written: string[] = [];
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    for (const path of written) {
      const target = join(projectRoot, path);
      const prior = snapshots.get(path);
      if (prior === null || prior === undefined) {
        rmSync(target, { force: true });
      } else {
        writeFileSync(target, prior, 'utf-8');
      }
    }
    for (const dir of newDirs) {
      try {
        rmdirSync(dir); // empty-only — throws (caught) if a surviving file remains
      } catch {
        // Non-empty (a surviving file lives here) or already gone — leave it.
      }
    }
  };

  let result: ApplyResult;
  try {
    // Re-implement the write loop here so `written` reflects partial progress.
    if (blocks.length === 0) {
      result = {
        filesWritten: [],
        rejected: [],
        error:
          'No file blocks found in the output. Emit every created/modified file as a fenced block: ```file:relative/path … ```',
      };
    } else {
      const rejected: ApplyResult['rejected'] = [];
      for (const block of blocks) {
        const invalid = validatePath(block.path, projectRoot, realRoot, options);
        if (invalid) {
          rejected.push({ path: block.path, reason: invalid });
          continue;
        }
        if (Buffer.byteLength(block.content, 'utf-8') > MAX_FILE_BYTES) {
          rejected.push({ path: block.path, reason: `file exceeds ${MAX_FILE_BYTES} bytes` });
          continue;
        }
        const target = join(projectRoot, block.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, block.content, 'utf-8');
        if (!written.includes(block.path)) written.push(block.path);
      }
      result = { filesWritten: [...written], rejected };
    }
  } catch (err) {
    restore();
    throw err;
  }

  return { result, restore };
}

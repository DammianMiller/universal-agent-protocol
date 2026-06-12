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
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
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

export type Applier = (output: string, projectRoot: string) => ApplyResult | Promise<ApplyResult>;

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

/** Extract file blocks from model output without writing anything. */
export function parseFileBlocks(output: string): FileBlock[] {
  const blocks: FileBlock[] = [];
  for (const match of output.matchAll(FILE_BLOCK_RE)) {
    const path = match[2].trim();
    if (!path) continue;
    blocks.push({ path, content: match[3] });
  }
  return blocks;
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

function validatePath(blockPath: string, projectRoot: string, realRoot: string): string | null {
  if (isAbsolute(blockPath)) return 'absolute paths are not allowed';

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
export function applyFileBlocks(output: string, projectRoot: string): ApplyResult {
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
    const invalid = validatePath(block.path, projectRoot, realRoot);
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
export function applyFileBlocksWithRollback(output: string, projectRoot: string): RevertibleApply {
  const blocks = parseFileBlocks(output);
  const realRoot = realRootOf(projectRoot);

  // Snapshot prior content (or absence) of every valid target, and the set
  // of directories that do not yet exist, BEFORE writing anything.
  const snapshots = new Map<string, string | null>();
  const validPaths: string[] = [];
  for (const block of blocks) {
    if (validatePath(block.path, projectRoot, realRoot)) continue;
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
        const invalid = validatePath(block.path, projectRoot, realRoot);
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

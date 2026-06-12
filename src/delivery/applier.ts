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

import { mkdirSync, writeFileSync } from 'fs';
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

/** Max bytes a single emitted file may have (guards runaway generations). */
const MAX_FILE_BYTES = 1_000_000;

const FILE_BLOCK_RE = /^(`{3,})file:([^\n]+)\n([\s\S]*?)^\1\s*$/gm;

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

function validatePath(blockPath: string, projectRoot: string): string | null {
  if (isAbsolute(blockPath)) return 'absolute paths are not allowed';
  const target = resolve(projectRoot, blockPath);
  const rel = relative(resolve(projectRoot), target);
  if (rel.startsWith('..') || isAbsolute(rel)) return 'path escapes the project root';
  if (rel === '.git' || rel.startsWith(`.git${sep}`)) return 'writes into .git are not allowed';
  return null;
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

  const filesWritten: string[] = [];
  const rejected: ApplyResult['rejected'] = [];

  for (const block of blocks) {
    const invalid = validatePath(block.path, projectRoot);
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

/**
 * Gate Integrity Guard — runtime tamper detection for protected files
 *
 * The applier's protectedFiles filter only constrains what the MODEL writes
 * through file blocks. Gate execution runs project code — including test
 * files the model just created — and that code can `writeFileSync` over a
 * protected spec or helper at runtime, defeating the static filter.
 *
 * This guard snapshots the bytes of every protected file after the baseline
 * run, then re-verifies after each gate run: any mutated protected file is
 * restored from the snapshot and the run's gate result is discarded as a
 * GATE INTEGRITY VIOLATION, with feedback telling the model exactly why.
 * Protected paths that did not exist at snapshot time ("reserved" oracle
 * paths) are restored to absence — a runtime-fabricated golden is removed.
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { isTestFilePath } from './applier.js';
import { additiveTestEditRefusal } from './test-oracle-additive.js';

/** Per-file restoration budget; larger files are hash-verified only. */
const MAX_RESTORE_BYTES = 1_000_000;
/** Total bytes of restoration content kept in memory. */
const MAX_TOTAL_RESTORE_BYTES = 32_000_000;

interface IntegrityRecord {
  /** sha256 of the file's bytes; null when the path was absent at capture */
  hash: string | null;
  /** Raw bytes for restoration; null when over budget (hash-verify only) */
  content: Buffer | null;
}

export type IntegritySnapshot = Map<string, IntegrityRecord>;

export interface IntegrityCheck {
  /** Protected files whose on-disk state changed during the gate run */
  tampered: string[];
  /** Subset of tampered that was restored to its snapshot state */
  restored: string[];
  /** Subset of tampered that could not be restored (over budget / IO error) */
  unrecoverable: string[];
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Capture the on-disk state of every protected file (original-case relative
 * paths). Absent paths are recorded as reserved. Fail-soft per file.
 */
export function captureIntegrity(projectRoot: string, files: string[]): IntegritySnapshot {
  const root = resolve(projectRoot);
  const snapshot: IntegritySnapshot = new Map();
  let totalBytes = 0;

  for (const rel of files) {
    const abs = resolve(root, rel);
    try {
      if (!existsSync(abs)) {
        snapshot.set(rel, { hash: null, content: null });
        continue;
      }
      const bytes = readFileSync(abs);
      const keep = bytes.length <= MAX_RESTORE_BYTES && totalBytes + bytes.length <= MAX_TOTAL_RESTORE_BYTES;
      if (keep) totalBytes += bytes.length;
      snapshot.set(rel, { hash: sha256(bytes), content: keep ? bytes : null });
    } catch {
      // Unreadable — skip; the applier-level protection still applies.
    }
  }
  return snapshot;
}

/**
 * Verify every captured file against its snapshot; restore what changed.
 * Returns what was tampered with so the caller can discard gate results.
 */
export function verifyAndRestore(projectRoot: string, snapshot: IntegritySnapshot): IntegrityCheck {
  const root = resolve(projectRoot);
  const check: IntegrityCheck = { tampered: [], restored: [], unrecoverable: [] };

  for (const [rel, record] of snapshot) {
    const abs = resolve(root, rel);
    try {
      const existsNow = existsSync(abs);

      if (record.hash === null) {
        // Reserved path: must stay absent. A runtime-fabricated oracle is removed.
        if (existsNow) {
          check.tampered.push(rel);
          rmSync(abs, { force: true });
          check.restored.push(rel);
        }
        continue;
      }

      if (!existsNow) {
        check.tampered.push(rel);
        if (record.content) {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, record.content);
          check.restored.push(rel);
        } else {
          check.unrecoverable.push(rel);
        }
        continue;
      }

      const bytes = readFileSync(abs);
      if (sha256(bytes) !== record.hash) {
        // Additive test-edit carve-out (same rule as the executor and the
        // applier — see test-oracle-additive.ts): a sanctioned write through
        // those layers lands here looking exactly like tampering, and
        // restoring it would silently revert what the tool call reported as
        // written. Deliberately STATELESS: the baseline is never mutated, so
        // one candidate workspace's added tests cannot leak into another via
        // a shared snapshot — a still-additive tree just re-verifies against
        // the original capture on every pass. Only verifiable text (content
        // kept, test path) qualifies; everything else restores as before.
        if (
          record.content !== null &&
          isTestFilePath(rel.split(/[\\/]/).join('/')) &&
          additiveTestEditRefusal(record.content.toString('utf-8'), bytes.toString('utf-8')) === null
        ) {
          continue;
        }
        check.tampered.push(rel);
        if (record.content) {
          writeFileSync(abs, record.content);
          check.restored.push(rel);
        } else {
          check.unrecoverable.push(rel);
        }
      }
    } catch {
      check.unrecoverable.push(rel);
      if (!check.tampered.includes(rel)) check.tampered.push(rel);
    }
  }
  return check;
}

/** Render the violation feedback prepended to discarded gate results. */
export function integrityViolationFeedback(check: IntegrityCheck): string {
  const lines = [
    `GATE INTEGRITY VIOLATION: test execution modified protected file(s): ${check.tampered.join(', ')}.`,
    'Gate results for this turn are DISCARDED. Protected test/oracle files must not be rewritten —',
    'the only sanctioned change is APPENDING new test cases to a pre-existing test file, with the',
    'existing content byte-identical. Implement the source instead.',
  ];
  if (check.unrecoverable.length > 0) {
    lines.push(`Could not restore: ${check.unrecoverable.join(', ')} — manual attention needed.`);
  } else {
    lines.push('All modified files were restored to their original state.');
  }
  return lines.join('\n');
}

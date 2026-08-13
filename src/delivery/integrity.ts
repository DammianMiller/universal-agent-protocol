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
import { dirname, relative, resolve } from 'path';
import { isTestFilePath } from './applier.js';
import { additiveTestEditRefusal } from './test-oracle-additive.js';
import { runRung, type GateRung } from './verifier-ladder.js';

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
  /**
   * Protected TEST files whose change was accepted under the additive
   * carve-out (append-only, delta denylisted). Not tampering — but callers
   * should run the oracle-consistency check over them, which is the
   * behavioral control for what the textual rule cannot see.
   */
  sanctionedAdditive: string[];
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
  const check: IntegrityCheck = { tampered: [], restored: [], unrecoverable: [], sanctionedAdditive: [] };

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
          check.sanctionedAdditive.push(rel);
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

export interface OracleConsistencyResult {
  /** True when the ORIGINAL oracle still passes (or the check could not run). */
  consistent: boolean;
  /** Rung that failed under the original oracle, when inconsistent. */
  failedRungId?: string;
  /** Files whose baseline bytes were restored for the re-run. */
  checkedFiles: string[];
  /**
   * Files whose CANDIDATE bytes could not be put back after the re-run. The
   * tree then holds baseline bytes — safe content, but the sanctioned append
   * (possibly the mission's deliverable) is gone. Callers must not report a
   * clean pass over a tree that silently lost it.
   */
  restoreFailed?: string[];
}

/**
 * Oracle-consistency check — the BEHAVIORAL control behind the additive
 * test-edit carve-out.
 *
 * The textual rule (append-only + delta denylist) cannot see appended
 * module-scope code that neutralizes the frozen tests at runtime. This check
 * measures instead of reading: restore the BASELINE bytes of every
 * sanctioned-changed test file, re-run the test rungs, and require the
 * ORIGINAL oracle to still pass. If the tree only passes WITH the appended
 * changes present, the append is masking failures — the exact outcome the
 * carve-out must never allow.
 *
 * Scope, stated honestly (security review 2026-08-13): the guarantee covers
 * neutralizers living IN the sanctioned files — the swap replaces only those
 * bytes, so masking machinery relocated to a NEW test/setup file is invisible
 * here. Runner per-file isolation blocks the cross-file runtime-patch shape,
 * and runner CONFIGS are in the integrity capture (a config edit is
 * tampering); a neutralizer in a pre-existing, unprotected setup file remains
 * a residual.
 *
 * Cost-bounded by construction: runs only when a sanctioned additive change
 * exists AND the gates passed, and re-runs only the test rungs. Fail-soft on
 * its own machinery (unreadable files, over-budget snapshots) — a checker
 * that cannot run must not block a legitimate delivery; the textual rule and
 * the tamper guard still stand.
 */
export function oracleConsistencyCheck(
  projectRoot: string,
  snapshot: IntegritySnapshot,
  sanctioned: string[],
  rungs: GateRung[]
): OracleConsistencyResult {
  const root = resolve(projectRoot);
  // Match id AND name: detectRungs names real test oracles whose ids carry no
  // "test" — a Makefile suite is id 'make' (name 'Make (make test)'), a
  // run_tests.sh suite is id 'script' (name 'Script (bash test.sh)'). An
  // id-only filter silently skipped the check for those whole project classes
  // (review 2026-08-13 finding 1).
  const testRungs = rungs.filter((r) => r.required !== false && /test/i.test(`${r.id} ${r.name}`));
  if (sanctioned.length === 0 || testRungs.length === 0) {
    return { consistent: true, checkedFiles: [] };
  }
  const saved = new Map<string, Buffer>();
  const checkedFiles: string[] = [];
  let outcome: OracleConsistencyResult | null = null;
  const restoreFailed: string[] = [];
  try {
    for (const rel of sanctioned) {
      const record = snapshot.get(rel);
      if (!record?.content) continue; // over-budget capture — cannot compare
      const abs = resolve(root, rel);
      try {
        saved.set(abs, readFileSync(abs));
        writeFileSync(abs, record.content);
        checkedFiles.push(rel);
      } catch {
        // A failed baseline write may have TRUNCATED the file — keep the
        // saved candidate bytes so the finally can restore them (review
        // finding 3); only the re-run skips this file.
      }
    }
    if (checkedFiles.length === 0) return { consistent: true, checkedFiles };
    for (const rung of testRungs) {
      const r = runRung(rung, root);
      if (!r.passed) {
        outcome = { consistent: false, failedRungId: rung.id, checkedFiles };
        return outcome;
      }
    }
    // TOCTOU guard (security review F2): code the re-run itself executes —
    // a setup file, a pretest script — can rewrite the restored file back to
    // the masked bytes BEFORE the runner reads it, making the "original
    // oracle" re-run execute the appended tests after all. If any checked
    // file no longer hash-matches its baseline after the re-run, the recheck
    // was tampered with and cannot vouch for anything.
    for (const rel of checkedFiles) {
      const record = snapshot.get(rel);
      if (!record?.hash) continue;
      try {
        if (sha256(readFileSync(resolve(root, rel))) !== record.hash) {
          outcome = { consistent: false, failedRungId: 'oracle-recheck-tampered', checkedFiles };
          return outcome;
        }
      } catch {
        outcome = { consistent: false, failedRungId: 'oracle-recheck-tampered', checkedFiles };
        return outcome;
      }
    }
    outcome = { consistent: true, checkedFiles };
    return outcome;
  } finally {
    for (const [abs, bytes] of saved) {
      try {
        writeFileSync(abs, bytes);
      } catch {
        // Baseline bytes remain — safe CONTENT (hash-matches the snapshot,
        // so later verifies stay quiet), but the sanctioned append is gone.
        // Surface it so the caller discards the turn instead of reporting a
        // clean pass over a tree that silently lost its appended tests
        // (review finding 4).
        restoreFailed.push(relative(root, abs));
      }
    }
    if (outcome && restoreFailed.length > 0) outcome.restoreFailed = restoreFailed;
  }
}

/** Feedback when the original oracle fails while the appended tree passes. */
export function oracleConsistencyFeedback(result: OracleConsistencyResult): string {
  return [
    `ORACLE-CONSISTENCY VIOLATION: with the ORIGINAL content of ${result.checkedFiles.join(', ')} restored,`,
    `required gate '${result.failedRungId}' FAILS — the appended test-file changes are masking failures of the`,
    'pre-existing tests. Gate results for this turn are DISCARDED. Fix the implementation so the original',
    'tests genuinely pass; appended code must never be what makes them pass.',
  ].join('\n');
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

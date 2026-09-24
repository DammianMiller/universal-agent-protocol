/**
 * Adversarial attack SANCTIONING — the containment boundary every
 * model-authored red-team test crosses before it touches disk. Split from
 * adversarial-attack.ts to keep each module of the adversarial stage under
 * the 500-LOC quality-gate threshold; the round orchestration that calls
 * these functions lives in adversarial-attack.ts, and the stage driver
 * (adversarial-gate.ts) re-exports the public surface.
 *
 * The rule set (composition over invention — nothing here is new machinery,
 * it is the existing additive oracle channel applied to attack writes):
 *
 *  - The red team may only ADD tests: NEW test files pass the delta rule
 *    (no suppressors, no process.exit, no assert reassignment); appends to
 *    existing test files pass the full additive rule (existing content
 *    survives verbatim as a prefix).
 *  - Paths are contained to the project root lexically AND through
 *    symlinks (realParentEscapes — the same check the applier enforces on
 *    every other write), capped in count and in BYTES (not UTF-16 units).
 *  - Every refusal and every dropped surplus block is recorded in the
 *    notes — the audit trail must distinguish "the model tried X and was
 *    refused" from "the model never tried".
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, resolve, sep } from 'path';
import { isTestFilePath, realParentEscapes, type FileBlock } from './applier.js';
import {
  additiveTestDeltaRefusal,
  additiveTestEditRefusal,
  extractTestTitles,
} from './test-oracle-additive.js';

/** At most this many model-authored test files per round. Exported: the
 * attack prompt states the cap to the authoring model. */
export const MAX_ATTACK_FILES = 3;
/** Per-file content cap for authored tests (guards runaway generations). */
const MAX_ATTACK_BYTES = 100_000;

export interface SanctionedWrite {
  /** Repo-relative, '/'-separated. */
  rel: string;
  abs: string;
  /** Pre-existing content (append case); null for a new file. */
  prior: string | null;
  /** Test-case titles this write adds. */
  titles: string[];
}

/**
 * Sanction model-authored blocks through the additive oracle channel. The red
 * team may only ADD tests: new test files (suppressor/exit/assert-patch
 * checks), or verbatim-prefix appends to existing ones (full additive rule).
 */
export function sanctionAttackBlocks(
  blocks: FileBlock[],
  projectRoot: string
): { writes: SanctionedWrite[]; notes: string[] } {
  const writes: SanctionedWrite[] = [];
  const notes: string[] = [];
  const rootAbs = resolve(projectRoot);
  // Symlink-followed root for the containment check — the lexical resolve
  // alone lets a pre-existing symlink inside the repo redirect an attack-file
  // write outside it (same rule the applier enforces on every other write).
  let realRoot = rootAbs;
  try {
    realRoot = realpathSync(rootAbs);
  } catch {
    /* root unreadable — fall back to the lexical root */
  }
  if (blocks.length > MAX_ATTACK_FILES) {
    const dropped = blocks.slice(MAX_ATTACK_FILES).map((b) => b.path);
    // Surplus blocks are REFUSED, not silently lost — the audit trail records
    // exactly what the model tried to add beyond the cap.
    notes.push(
      `dropped ${dropped.length} surplus attack block(s) beyond the ${MAX_ATTACK_FILES}-file cap: ${dropped.join(', ')}`
    );
  }
  for (const block of blocks.slice(0, MAX_ATTACK_FILES)) {
    const rel = block.path.replace(/\\/g, '/').replace(/^\/+/, '');
    const abs = resolve(rootAbs, rel);
    if (isAbsolute(block.path) || (abs !== rootAbs && !abs.startsWith(rootAbs + sep))) {
      notes.push(`refused ${block.path}: path escapes the project root`);
      continue;
    }
    if (realParentEscapes(abs, realRoot)) {
      notes.push(`refused ${rel}: a symlink in its parent path escapes the project root`);
      continue;
    }
    if (!isTestFilePath(rel)) {
      notes.push(`refused ${rel}: not a test file — the red team may only add tests`);
      continue;
    }
    // Byte-accurate cap: a runaway generation of multibyte text must count
    // the BYTES it would write, not UTF-16 code units.
    if (Buffer.byteLength(block.content, 'utf-8') > MAX_ATTACK_BYTES) {
      notes.push(`refused ${rel}: content exceeds ${MAX_ATTACK_BYTES} bytes`);
      continue;
    }
    if (existsSync(abs)) {
      const prior = readFileSync(abs, 'utf-8');
      const refusal = additiveTestEditRefusal(prior, block.content);
      if (refusal) {
        notes.push(`refused ${rel}: append to an existing test file is not additive — ${refusal}`);
        continue;
      }
      const priorTitles = new Set(extractTestTitles(prior));
      const titles = extractTestTitles(block.content).filter((t) => !priorTitles.has(t));
      if (titles.length === 0) {
        notes.push(`refused ${rel}: the append adds no recognizable test cases`);
        continue;
      }
      writes.push({ rel, abs, prior, titles });
    } else {
      const refusal = additiveTestDeltaRefusal(block.content);
      if (refusal) {
        notes.push(`refused ${rel}: ${refusal}`);
        continue;
      }
      const titles = extractTestTitles(block.content);
      if (titles.length === 0) {
        notes.push(`refused ${rel}: no recognizable test cases — nothing runnable to add`);
        continue;
      }
      writes.push({ rel, abs, prior: null, titles });
    }
  }
  return { writes, notes };
}

/** Materialize sanctioned writes; returns nothing (rollback via the writes). */
export function applyWrites(writes: SanctionedWrite[], blocks: FileBlock[]): void {
  const contentByRel = new Map(blocks.map((b) => [b.path.replace(/\\/g, '/').replace(/^\/+/, ''), b.content]));
  for (const w of writes) {
    mkdirSync(dirname(w.abs), { recursive: true });
    writeFileSync(w.abs, contentByRel.get(w.rel) ?? '', 'utf-8');
  }
}

/**
 * Undo this round's writes: remove files the round CREATED, restore files it
 * appended to. Only ever touches paths sanctionAttackBlocks sanctioned.
 */
export function rollbackWrites(writes: SanctionedWrite[]): void {
  for (const w of writes) {
    try {
      if (w.prior === null) rmSync(w.abs, { force: true });
      else writeFileSync(w.abs, w.prior, 'utf-8');
    } catch {
      /* rollback is best-effort; the notes carry the residue */
    }
  }
}

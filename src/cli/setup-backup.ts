/**
 * Backup of agent instruction files before `uap init`/`uap setup` modifies them.
 *
 * init merges/regenerates CLAUDE.md (and platform AGENTS.md) and rewrites
 * `.uap.json`; this captures the pre-change state under `.uap-backups/<date>/`
 * (via the shared, idempotent {@link backupFile}) so a setup run is always
 * reversible. Fail-soft per file — a backup failure never blocks setup.
 */

import { backupFile } from '../telemetry/session-telemetry.js';

/** Agent instruction files (and config) a setup run may rewrite or merge. */
export const INSTRUCTION_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  'AGENT.md',
  'GEMINI.md',
  '.cursorrules',
  '.clinerules',
  '.windsurfrules',
  '.uap.json',
] as const;

export interface BackupResult {
  /** Files that existed and were backed up (or already had a backup today). */
  backedUp: string[];
  /** Files absent or that failed to back up (non-fatal). */
  skipped: string[];
  /** Backup date folder (YYYY-MM-DD). */
  date: string;
}

/**
 * Back up every present instruction file under `.uap-backups/<date>/`.
 * Idempotent (relies on backupFile returning the existing backup path) and
 * fail-soft. Returns a report for the setup summary.
 */
export function backupInstructionFiles(cwd: string): BackupResult {
  const date = new Date().toISOString().split('T')[0];
  const backedUp: string[] = [];
  const skipped: string[] = [];

  for (const file of INSTRUCTION_FILES) {
    try {
      const backup = backupFile(file, cwd);
      if (backup) backedUp.push(file);
      else skipped.push(file);
    } catch {
      skipped.push(file);
    }
  }

  return { backedUp, skipped, date };
}
